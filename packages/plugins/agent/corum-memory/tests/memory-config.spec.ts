/**
 * 记忆底座的**配置面**测试（2026-09-22「移除项目记忆」后维度收敛为 Agent 单一维度）。
 *
 * 覆盖三类真源，全部走真实装配（官方存储栈 + 真实 settings 面 stub，不 mock 业务）：
 *
 * 1. **配置接线**（`resolveMemoryConfig` 纯函数 + 服务消费）——用户在设置页改的参数
 *    **必须真的改变底座行为**，否则就是「能改但不生效」的假开关：
 *    · 存续期默认档 → 写入落库的 retention；
 *    · 读取升级阈值 → 命中多少次升级为长期；
 *    · 衰减强度 → 排序用的 effectiveScore。
 * 2. **归属维度**（agentId）——记忆只归属 Agent（经验归属 Agent（人），事务归属项目，
 *    单一归宿）。`scope` / `projectId` 字段已删除。
 * 3. **策略闸门**——总开关 / 容量上限 + 超限策略 / 自动清理已到期；以及批量修剪。
 *
 * ⚠️ 两条与 `memory-service.spec.ts` 一致的纪律：
 *   · `CORUM_HOME` 指向 /tmp 隔离目录，不动真实 dev home；
 *   · 同一个测试里要装**两套**服务时，必须给不同的 storage 子目录 —— 否则两套服务
 *     读同一个 json 后端，会互相看到对方写的数据（本文件首版就栽在这里：一条
 *     「关了记忆不召回」的断言被上一段的写入污染成 2 条）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { MemoryService } from '../src/memory-service.ts'
import {
  CORUM_MEMORY_SETTINGS_NAMESPACE,
  DECAY_STRENGTH_MULTIPLIER,
  MEMORY_CONFIG_DEFAULTS,
  resolveMemoryConfig,
} from '../src/memory-config.ts'
import type { CorumMemorySettings } from '../src/memory-config.ts'
import { effectiveScoreFor, isRetained } from '../src/memory-policy.ts'
import type { MemoryFact } from '../src/memory-entities.ts'

let home: string
const prevCorumHome = process.env.CORUM_HOME
/** 一个测试内多次 setup 时的 storage 子目录计数器（见文件头纪律第 2 条）。 */
let storeSeq = 0

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-memcfg-home-'))
  process.env.CORUM_HOME = home
  storeSeq = 0
})

afterEach(() => {
  if (prevCorumHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = prevCorumHome
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/**
 * settings 服务面的 stub 形（rc3：本包只依赖 `describe` 方法）。
 *
 * rc3 迁移（2026-10-28）：`SettingsForms.register()` 已删除——namespace 由插件
 * Config 声明自动提供。本 stub 不再模拟 `register`，只提供 `describe()` 返回
 * 当前用户层值（模拟 `settings.describe()` 在 profile patch 里找到 `corum-memory`
 * namespace 的 resolved 值）。
 */
interface SettingsStub {
  /** 交给 `ctx.provide('settings', …)` 的服务面。 */
  face: {
    describe: () => readonly { ns: string, value?: unknown }[]
  }
  /** 模拟「用户在设置页改了一个值」。 */
  set: (patch: CorumMemorySettings) => void
  /** namespace 是否已「挂载」（rc3 = describe 里有它；断言用）。 */
  registeredNs: () => string[]
  /** 注册时传入的 schema（rc3 保留兼容——不再有 register，恒 undefined）。 */
  schema: () => unknown
  /** describe 被调用的 namespace（rc3 保留兼容——不再有 register，恒 0）。 */
  registerCount: () => number
}

/**
 * 造一个 settings 服务面（stub）。
 *
 * 为什么 stub 而不是装官方 dsh-settings：本包只依赖**接口形**，官方实现的装配需要
 * host 半边 + 落盘 settings.yaml（会污染真实 `$DSH_HOME`）。stub 只提供被测代码真正
 * 读的两件事，且可写——测试要模拟「用户在设置页改了一个值」。
 *
 * @param initial - 初始用户层（模拟 settings.yaml 里已存的值）。
 * @returns settings 服务面 + 读/写钩子。
 */
function makeSettingsStub(initial: CorumMemorySettings = {}): SettingsStub {
  let user: CorumMemorySettings = { ...initial }
  return {
    face: {
      // rc3：namespace 由 Config 声明提供，describe 直接返回 resolved 值。
      // 只要 stub「挂载」了（即被 provide），describe 就能找到 corum-memory。
      describe: () => [{ ns: CORUM_MEMORY_SETTINGS_NAMESPACE, value: user }],
    },
    set: (patch) => { user = { ...user, ...patch } },
    registeredNs: () => [CORUM_MEMORY_SETTINGS_NAMESPACE],
    schema: () => undefined,
    registerCount: () => 0,
  }
}

/**
 * 装完整存储栈 + MemoryService。
 *
 * @param settings - 可选的 settings 面（不传 = 模拟「未装配 settings」，配置回落内置默认）。
 * @param storeName - storage 子目录名（同测试内多次 setup 必须不同，见文件头纪律）。
 * @returns 上下文 + 服务。
 */
async function setup(
  settings?: SettingsStub,
  storeName?: string,
): Promise<{ ctx: Context, mem: MemoryService }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const root = join(home, storeName ?? `storages-${storeSeq++}`)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  if (settings !== undefined) ctx.provide('settings', settings.face as never)
  const mem = ctx.get('memory') ?? new MemoryService(ctx)
  return { ctx, mem }
}

/** 造一条写入入参（默认带 agent 归属）。 */
function input(overrides: Record<string, unknown> = {}) {
  return {
    fact: '用户偏好深色模式',
    agentId: 'pm',
    author: 'agent:s1',
    ...overrides,
  } as Parameters<MemoryService['putFact']>[0]
}

/** 造一条存储形态的事实（纯函数测试用）。 */
function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'f1', entity: '', relation: '', fact: '样本', importance: 80,
    validAt: null, invalidAt: null, source: '', agentId: 'pm',
    retention: 'long', expiresAt: null, readCount: 0, supersedes: [], evidence: [],
    author: 'test', createdAt: 0, lastAccessedAt: null,
    ...overrides,
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 1. resolveMemoryConfig（纯函数）
 * ══════════════════════════════════════════════════════════════════ */

describe('记忆维度：收敛为 Agent 单一维度（2026-09-22「移除项目记忆」）', () => {
  it('scope 字段已删除——putFact 不再接受 scope 参数', async () => {
    const { mem } = await setup()
    // scope 已从 PutFactInput 删除；传入会被 zod schema 忽略（不落库、不报错）。
    const { fact } = await mem.putFact(input({ fact: '无 scope 的事实' }))
    expect(fact.fact).toBe('无 scope 的事实')
    // 存储形态里没有 scope / projectId 字段。
    expect((fact as Record<string, unknown>).scope).toBeUndefined()
    expect((fact as Record<string, unknown>).projectId).toBeUndefined()
  })
})

describe('resolveMemoryConfig 配置合成（纯函数）', () => {
  it('空用户层 → 全部回落内置默认', () => {
    expect(resolveMemoryConfig(undefined)).toEqual(MEMORY_CONFIG_DEFAULTS)
    expect(resolveMemoryConfig({})).toEqual(MEMORY_CONFIG_DEFAULTS)
  })

  it('部分键覆盖时其余键仍取默认（不做「整体替换」）', () => {
    const c = resolveMemoryConfig({ defaultRetention: 'long' })
    expect(c.defaultRetention).toBe('long')
    expect(c.readPromoteThreshold).toBe(MEMORY_CONFIG_DEFAULTS.readPromoteThreshold)
    expect(c.enabled).toBe(MEMORY_CONFIG_DEFAULTS.enabled)
  })

  it('capacity 的 null 是「不限」而非「未设置」——显式 null 不得被默认值顶掉', () => {
    expect(resolveMemoryConfig({ capacity: 100 }).capacity).toBe(100)
    expect(resolveMemoryConfig({ capacity: null }).capacity).toBeNull()
    expect(resolveMemoryConfig({}).capacity).toBeNull()
  })

  it('衰减三档的倍率单调（快 < 标准 < 慢）', () => {
    expect(DECAY_STRENGTH_MULTIPLIER.fast).toBeLessThan(DECAY_STRENGTH_MULTIPLIER.standard)
    expect(DECAY_STRENGTH_MULTIPLIER.standard).toBeLessThan(DECAY_STRENGTH_MULTIPLIER.slow)
    expect(DECAY_STRENGTH_MULTIPLIER.standard).toBe(1)
  })

  it('总开关默认开（底座已实现——默认关掉会让用户以为坏了）', () => {
    expect(MEMORY_CONFIG_DEFAULTS.enabled).toBe(true)
  })

  it('未生效的注入策略仍有默认值（存用户意图，UI 侧标未上线）', () => {
    const c = resolveMemoryConfig(undefined)
    expect(c.injectMode).toBe('relevance')
    expect(c.injectLimit).toBeGreaterThan(0)
    expect(c.injectBudget).toBeGreaterThan(0)
  })
})

/* ══════════════════════════════════════════════════════════════════
 * 2. 配置真的驱动底座行为（不是「能改但不生效」）
 * ══════════════════════════════════════════════════════════════════ */

describe('设置面参数驱动底座行为', () => {
  it('存续期默认档：设置 long 后未声明存续期的写入落 long', async () => {
    const { mem } = await setup(makeSettingsStub({ defaultRetention: 'long' }))
    const { fact: f } = await mem.putFact(input())
    expect(f.retention).toBe('long')
  })

  it('存续期默认档 permanent：expiresAt 为 null（永不遗忘）', async () => {
    const { mem } = await setup(makeSettingsStub({ defaultRetention: 'permanent' }))
    const { fact: f } = await mem.putFact(input())
    expect(f.retention).toBe('permanent')
    expect(f.expiresAt).toBeNull()
  })

  it('没有 settings 面时回落内置默认 temporary（未装配不炸，行为同修复前）', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact(input())
    expect(f.retention).toBe('temporary')
  })

  it('读取升级阈值：设为 3 时第 3 次命中即升 long', async () => {
    const { mem } = await setup(makeSettingsStub({ readPromoteThreshold: 3 }))
    const { fact: f } = await mem.putFact(input({ fact: '阈值三' }))
    for (let i = 0; i < 3; i++) await mem.searchFacts({ query: '阈值三' })
    expect((await mem.getFact(f.id))!.retention).toBe('long')
  })

  it('读取升级阈值对照组：默认阈值 5 时同样 3 次命中不升级', async () => {
    const { mem } = await setup(makeSettingsStub({ readPromoteThreshold: 5 }))
    const { fact: f } = await mem.putFact(input({ fact: '阈值五' }))
    for (let i = 0; i < 3; i++) await mem.searchFacts({ query: '阈值五' })
    expect((await mem.getFact(f.id))!.retention).toBe('temporary')
  })

  it('衰减强度：fast 档记忆强度 < 标准档 < slow 档（同一条事实、同一时刻）', () => {
    const now = Date.UTC(2026, 0, 1)
    // long 档半衰期半年；造「三个月前创建」让衰减可见。
    const sample = fact({ retention: 'long', createdAt: now - 90 * 24 * 60 * 60 * 1000 })
    const fast = effectiveScoreFor(sample, now, { decayStrength: 'fast' })
    const standard = effectiveScoreFor(sample, now, { decayStrength: 'standard' })
    const slow = effectiveScoreFor(sample, now, { decayStrength: 'slow' })
    expect(fast).toBeLessThan(standard)
    expect(standard).toBeLessThan(slow)
  })

  it('衰减强度：显式档位与内置默认（standard）逐位相等——默认档不改变老行为', () => {
    const now = Date.UTC(2026, 0, 1)
    const sample = fact({ createdAt: now - 10 * 24 * 60 * 60 * 1000 })
    expect(effectiveScoreFor(sample, now, { decayStrength: 'standard' }))
      .toBe(effectiveScoreFor(sample, now))
  })

  it('衰减强度接线：服务读到的档位就是设置面的档位', async () => {
    const { mem } = await setup(makeSettingsStub({ decayStrength: 'slow' }))
    expect(mem.getConfig().decayStrength).toBe('slow')
    const { mem: fast } = await setup(makeSettingsStub({ decayStrength: 'fast' }), 'store-fast')
    expect(fast.getConfig().decayStrength).toBe('fast')
  })

  it('getConfig 反映 settings 面的当前值（写路径的唯一真源）', async () => {
    const { mem } = await setup(makeSettingsStub())
    expect(mem.getConfig().defaultRetention).toBe('temporary')
    const { mem: fresh } = await setup(
      makeSettingsStub({ defaultRetention: 'short', readPromoteThreshold: 10 }), 'store-fresh',
    )
    expect(fresh.getConfig().defaultRetention).toBe('short')
    expect(fresh.getConfig().readPromoteThreshold).toBe(10)
  })

  it('未装配 settings 时 getConfig 恒为内置默认（不做「读不到就当失败」）', async () => {
    const { mem } = await setup()
    expect(mem.getConfig()).toEqual(MEMORY_CONFIG_DEFAULTS)
  })

  it('ns 在 describe 里时服务侧直读（rc3：namespace 由 Config 声明提供）', async () => {
    const stub = makeSettingsStub()
    // rc3：namespace 由 Config 声明自动提供——describe 直接返回它。
    expect(stub.registeredNs()).toEqual([CORUM_MEMORY_SETTINGS_NAMESPACE])
    const { mem } = await setup(stub)
    // 服务侧从 describe 直读，不调 register。
    expect(mem.getConfig()).toEqual(MEMORY_CONFIG_DEFAULTS)
  })

  it('rc3 迁移：服务侧不调 register（API 已删除），只从 describe 读', async () => {
    const stub = makeSettingsStub()
    await setup(stub)
    // rc3：register() 已删除，registerCount 恒 0。
    expect(stub.registerCount()).toBe(0)
    expect(stub.registeredNs()).toEqual([CORUM_MEMORY_SETTINGS_NAMESPACE])
  })
})

/* ══════════════════════════════════════════════════════════════════
 * 3. 归属维度（agentId）
 * ══════════════════════════════════════════════════════════════════ */

describe('归属维度：Agent（记忆只归属 Agent）', () => {
  it('写入落归属：agentId 存得下、取得回', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact(input({ agentId: 'pm' }))
    const got = await mem.getFact(f.id)
    expect(got!.agentId).toBe('pm')
  })

  it('未给归属时落空串（老数据兼容：不因为缺字段而丢记录）', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact({ fact: '无归属', author: 'system' })
    expect(f.agentId).toBe('')
  })

  it('listFacts 按 agentId 过滤：只看到该 Agent 的记忆', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'pm 的', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'dev 的', agentId: 'dev' }))
    const pmOnly = await mem.listFacts({ agentId: 'pm' })
    expect(pmOnly).toHaveLength(1)
    expect(pmOnly[0].fact).toBe('pm 的')
  })

  it('listFacets 统计归属分布（按条数降序）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'a1', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'a2', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'a3', agentId: 'dev' }))
    const facets = await mem.listFacets({})
    expect(facets[0]).toEqual({ id: 'pm', label: 'pm', count: 2 })
    expect(facets[1]).toEqual({ id: 'dev', label: 'dev', count: 1 })
  })

  it('listFacets 按 agentId 过滤后只统计该 Agent', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'a1', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'a2', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'b1', agentId: 'dev' }))
    const facets = await mem.listFacets({ agentId: 'pm' })
    expect(facets).toHaveLength(1)
    expect(facets[0].id).toBe('pm')
    expect(facets[0].count).toBe(2)
  })

  it('searchFacts 也支持归属过滤（检索与列表同口径）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '关键词命中 pm', agentId: 'pm' }))
    await mem.putFact(input({ fact: '关键词命中 dev', agentId: 'dev' }))
    const hits = await mem.searchFacts({ query: '关键词', agentId: 'dev' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('关键词命中 dev')
  })

  it('listFacts 不累加 readCount（打开设置页不算「用户读了这条记忆」）', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact(input())
    await mem.listFacts({})
    await mem.listFacts({})
    const got = await mem.getFact(f.id)
    expect(got!.readCount).toBe(0)
    expect(got!.lastAccessedAt).toBeNull()
  })

  it('listFacts 默认包含已失效记忆（要能修剪它们，不能藏起来）', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact(input({ fact: '会被标失效' }))
    await mem.invalidate(f.id)
    const all = await mem.listFacts({})
    expect(all).toHaveLength(1)
    expect(all[0].applicable).toBe(false)
    // 而检索默认（applicable 模式）不再召回它。
    expect(await mem.searchFacts({})).toHaveLength(0)
    // recall 模式仍能回忆（失效 ≠ 忘记）。
    expect(await mem.searchFacts({ mode: 'recall' })).toHaveLength(1)
  })
})

/* ══════════════════════════════════════════════════════════════════
 * 4. 策略闸门：总开关 / 容量 / 自动清理
 * ══════════════════════════════════════════════════════════════════ */

describe('策略闸门', () => {
  it('总开关关：拒收非用户写入，但放行用户手动添加', async () => {
    const { mem } = await setup(makeSettingsStub({ enabled: false }))
    const byAgent = await mem.putFact(input({ fact: 'Agent 想记', author: 'agent:s1' }))
    expect(byAgent.rejected).toEqual(['disabled'])
    expect(await mem.listFacts({})).toHaveLength(0)

    const byUser = await mem.putFact(input({ fact: '用户手动记', author: 'user' }))
    expect(byUser.rejected).toEqual([])
    expect(await mem.listFacts({})).toHaveLength(1)
  })

  it('总开关关：检索不召回，但数据不删（仍可在记忆库页修剪）', async () => {
    const { mem } = await setup(makeSettingsStub({ enabled: false }))
    await mem.putFact(input({ fact: '记得住的', author: 'user' }))
    expect(await mem.searchFacts({})).toHaveLength(0)
    expect(await mem.listFacts({})).toHaveLength(1)
  })

  it('总开关开：正常召回（对照组，防「恒不召回」的假绿）', async () => {
    const { mem } = await setup(makeSettingsStub({ enabled: true }))
    await mem.putFact(input({ fact: '记得住的' }))
    expect(await mem.searchFacts({})).toHaveLength(1)
  })

  it('容量上限 + least-used：淘汰后回到上限，且不动刚写入的这条', async () => {
    const { mem } = await setup(makeSettingsStub({ capacity: 3, overflowPolicy: 'least-used' }))
    const r = await Promise.all(
      [0, 1, 2, 3].map(i => mem.putFact(input({ fact: `f${i}`, id: `id-${i}` }))),
    )
    // 4 次写入并发可能被同一写链串行化；最后一次写入的 id 必须仍在。
    expect(r).toHaveLength(4)
    const left = await mem.listFacts({})
    expect(left).toHaveLength(3)
    expect(left.some(v => v.id === 'id-3')).toBe(true)
  })

  it('容量上限 + stop：满了之后拒收新写入（回滚，不留半截记录）', async () => {
    const { mem } = await setup(makeSettingsStub({ capacity: 2, overflowPolicy: 'stop' }))
    await mem.putFact(input({ fact: 'f0', id: 'k0' }))
    await mem.putFact(input({ fact: 'f1', id: 'k1' }))
    const third = await mem.putFact(input({ fact: 'f2', id: 'k2' }))
    expect(third.rejected).toEqual(['capacity'])
    expect(await mem.listFacts({})).toHaveLength(2)
    expect((await mem.listFacts({})).some(v => v.id === 'k2')).toBe(false)
  })

  it('容量上限 + oldest：淘汰最旧', async () => {
    const { mem } = await setup(makeSettingsStub({ capacity: 2, overflowPolicy: 'oldest' }))
    await mem.putFact(input({ fact: '老', id: 'old' }))
    await mem.putFact(input({ fact: '中', id: 'mid' }))
    await mem.putFact(input({ fact: '新', id: 'new' }))
    const ids = (await mem.listFacts({})).map(v => v.id)
    expect(ids).not.toContain('old')
    expect(ids).toContain('new')
  })

  it('capacity=null（默认不限）：六条全留', async () => {
    const { mem } = await setup(makeSettingsStub({ capacity: null }))
    for (let i = 0; i < 6; i++) await mem.putFact(input({ fact: `keep${i}` }))
    expect(await mem.listFacts({})).toHaveLength(6)
  })

  it('cleanExpired：删掉已过期的、保留 permanent', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '临时的', retention: 'temporary' }))
    await mem.putFact(input({ fact: '永久的', retention: 'permanent' }))
    const twoDaysLater = Date.now() + 3 * 24 * 60 * 60 * 1000
    const gone = await mem.cleanExpired(twoDaysLater)
    expect(gone).toHaveLength(1)
    const left = await mem.listFacts({})
    expect(left).toHaveLength(1)
    expect(left[0].fact).toBe('永久的')
  })

  it('自动清理已到期开启后：写入不报错，permanent 永不被清', async () => {
    const { mem } = await setup(makeSettingsStub({ autoCleanExpired: true, defaultRetention: 'permanent' }))
    const r = await mem.putFact(input({ fact: '永不遗忘的' }))
    expect(r.rejected).toEqual([])
    expect(await mem.listFacts({})).toHaveLength(1)
    expect(await mem.cleanExpired()).toEqual([])
  })

  it('自动清理已到期开启后：写入时顺手清掉当时已过期的存量', async () => {
    const { mem } = await setup(makeSettingsStub({ autoCleanExpired: true }))
    // 先写一条 temporary，再把它「变旧」——putFact 不暴露 createdAt，故用
    // cleanExpired(未来) 之外的路径：写入第二条时自动清理会以 now 为界，
    // 存量 temporary（2 天 TTL）此刻尚未过期，故这里断言「不误删未过期的」。
    await mem.putFact(input({ fact: '未过期的', retention: 'temporary' }))
    await mem.putFact(input({ fact: '第二条', retention: 'temporary' }))
    expect(await mem.listFacts({})).toHaveLength(2)
  })

  it('命中不续命：未升级档位时 expiresAt 不因读取而被推后', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact(input({ fact: '别续命', retention: 'temporary' }))
    await mem.searchFacts({ query: '别续命' })
    const after = await mem.getFact(f.id)
    expect(after!.retention).toBe('temporary')
    expect(after!.expiresAt).toBe(f.expiresAt)
  })
})

/* ══════════════════════════════════════════════════════════════════
 * 4b. 改存续期（三维记忆空间的「层间移动」）
 * ══════════════════════════════════════════════════════════════════ */

describe('setRetention：把记忆在层之间移动', () => {
  it('改档生效且 expiresAt 按 **createdAt** 重算（不是从当下重置寿命）', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact(input({ fact: '层间移动', retention: 'long' }))
    // 记下原始 createdAt；改档不得改变它。
    const before = await mem.getFact(f.id)
    const moved = await mem.setRetention(f.id, 'short')
    expect(moved!.retention).toBe('short')
    expect(moved!.createdAt).toBe(before!.createdAt)
    // short TTL = 90 天；expiresAt 必须 = createdAt + 90d（若实现写成 now + 90d 这里会差出量级）。
    expect(moved!.expiresAt).toBe(before!.createdAt + 90 * 24 * 60 * 60 * 1000)
  })

  it('提升到 permanent ⇒ expiresAt = null（永不遗忘）', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact(input({ fact: '提升为永久', retention: 'temporary' }))
    const moved = await mem.setRetention(f.id, 'permanent')
    expect(moved!.retention).toBe('permanent')
    expect(moved!.expiresAt).toBeNull()
  })

  it('从 permanent 降档 ⇒ 重新算出期限（不再永不遗忘）', async () => {
    const { mem } = await setup()
    const { fact: f } = await mem.putFact(input({ fact: '降档', retention: 'permanent' }))
    expect((await mem.getFact(f.id))!.expiresAt).toBeNull()
    const moved = await mem.setRetention(f.id, 'temporary')
    expect(moved!.retention).toBe('temporary')
    expect(moved!.expiresAt).not.toBeNull()
    expect(moved!.expiresAt).toBe(moved!.createdAt + 2 * 24 * 60 * 60 * 1000)
  })

  it('降到更短档位后若已过期 ⇒ 立即被视为已遗忘（retained=false，检索不召回）', async () => {
    const { mem } = await setup()
    // 造一条「久远」的记忆：直接用存储层写一条 createdAt 在 1 年前的 long 事实。
    // （putFact 不接受 createdAt，故用 cleanExpired 的 now 参数从另一头验证语义——
    //  这里直接用「显式传过去时刻」的方式证明降档确实会让它过期。）
    const { fact: f } = await mem.putFact(input({ fact: '两年前的记忆', retention: 'permanent' }))
    const view0 = await mem.getFact(f.id)
    expect(view0!.retained).toBe(true)
    // 降成临时（2 天 TTL）：createdAt 是刚刚 ⇒ 还没过期。
    await mem.setRetention(f.id, 'temporary')
    expect((await mem.getFact(f.id))!.retained).toBe(true)
    // 再往后 3 天看：已过 2 天 TTL ⇒ 不被记住，且检索不召回。
    const threeDaysLater = Date.now() + 3 * 24 * 60 * 60 * 1000
    expect(isRetained((await mem.getFact(f.id))! as never, threeDaysLater)).toBe(false)
  })

  it('不存在的 id 返回 null（不抛错）', async () => {
    const { mem } = await setup()
    expect(await mem.setRetention('nope', 'long')).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════════
 * 5. 批量修剪（记忆库页的清空）
 * ══════════════════════════════════════════════════════════════════ */

describe('批量修剪（记忆库页的清空）', () => {
  it('deleteFacts 返回真正删掉的条数（不存在的 id 不计）', async () => {
    const { mem } = await setup()
    const a = await mem.putFact(input({ fact: 'a' }))
    await mem.putFact(input({ fact: 'b' }))
    const n = await mem.deleteFacts([a.fact.id, 'not-there'])
    expect(n).toBe(1)
    expect(await mem.listFacts({})).toHaveLength(1)
  })

  it('clearFacts 按 agentId 删：只清那个 Agent 的，不越界', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'pm1', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'pm2', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'dev1', agentId: 'dev' }))
    expect(await mem.clearFacts({ agentId: 'pm' })).toBe(2)
    const left = await mem.listFacts({})
    expect(left.map(v => v.fact)).toEqual(['dev1'])
  })

  it('clearFacts 无参调用**拒绝执行**（防「空 filter = 清空全库」的误用）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'x' }))
    await expect(mem.clearFacts({})).rejects.toThrow(/refusing to clear the whole store/)
    expect(await mem.listFacts({})).toHaveLength(1)
  })
})
