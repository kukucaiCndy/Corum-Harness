/**
 * MemoryService 接口 + 业务集成测试（真装官方存储栈）。
 *
 * wiring 参照 corum-agent project-data.spec.ts：dsh-storage hub + dsh-storage-json
 * 后端 + dsh-storage-domain 设施，CORUM_HOME 指向 /tmp 隔离目录——不动真实 dev home。
 *
 * 覆盖面（按「接口」与「业务」两类组织）：
 *   接口层 —— putFact / searchFacts / listFacts / getFact / invalidate / setImportance
 *             / deleteFact 七个公开方法（含 @Remote 端点的同名语义，端点即转发）。
 *   业务层 —— 写入幂等、recency-wins 合并（标失效不删 + supersedes 溯源）、
 *             applicable/recall 双模式检索（失效 ≠ 忘记）、agentId 过滤、关键词、
 *             访问强化、人工修剪三动作、硬删除不可逆。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { READ_PROMOTE_THRESHOLD } from '../src/memory-policy.ts'
import type { MemoryFact } from '../src/memory-entities.ts'

let home: string
const prevCorumHome = process.env.CORUM_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-mem-home-'))
  process.env.CORUM_HOME = home
})

afterEach(() => {
  if (prevCorumHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = prevCorumHome
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setup(): Promise<{ ctx: Context; mem: MemoryService }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root: join(home, 'storages') })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  // Service 基类构造即 provide（cordis Service 语义），无需手动 ctx.provide。
  const mem = ctx.get('memory') ?? new MemoryService(ctx)
  return { ctx, mem }
}

/** 造一条写入入参（默认归属 Agent 'test'，使不带 agentId 的 searchFacts 仍能召回——#6 后 undefined 排除未归属）。 */
function input(overrides: Partial<Parameters<MemoryService['putFact']>[0]> = {}) {
  return {
    fact: '用户偏好深色模式',
    author: 'test',
    agentId: 'test',
    ...overrides,
  }
}

describe('MemoryService 接口层', () => {
  it('putFact 写入后 getFact 能取回，字段完整且默认值正确', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '用户偏好深色模式' }))
    expect(fact.id).toBeTruthy()
    expect(fact.importance).toBe(50) // 默认
    expect(fact.entity).toBe('')
    expect(fact.relation).toBe('')
    expect(fact.validAt).toBeNull()
    expect(fact.invalidAt).toBeNull()
    expect(fact.supersedes).toEqual([])
    expect(fact.evidence).toEqual([])

    const got = await mem.getFact(fact.id)
    expect(got).not.toBeNull()
    expect(got!.fact).toBe('用户偏好深色模式')
    expect(got!.applicable).toBe(true)
    expect(got!.retained).toBe(true)
  })

  it('putFact 带自定义 id 时幂等（重复写入覆盖同一条）', async () => {
    const { mem } = await setup()
    const id = 'fixed-id'
    const r1 = await mem.putFact(input({ id, fact: 'v1' }))
    const r2 = await mem.putFact(input({ id, fact: 'v2' }))
    expect(r1.fact.id).toBe(id)
    expect(r2.fact.id).toBe(id)
    // 同 id 覆盖后只有一条，内容为 v2。
    const all = await mem.listFacts()
    expect(all).toHaveLength(1)
    expect(all[0].fact).toBe('v2')
  })

  it('listFacts 返回全部并按记忆强度降序', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'low', importance: 10 }))
    await mem.putFact(input({ fact: 'high', importance: 90 }))
    const all = await mem.listFacts()
    expect(all).toHaveLength(2)
    expect(all[0].fact).toBe('high')
    expect(all[1].fact).toBe('low')
  })

  it('getFact 不存在的 id 返回 null', async () => {
    const { mem } = await setup()
    expect(await mem.getFact('nonexistent')).toBeNull()
  })

  it('setImportance 越界值被 clamp 到 [0,100]', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input())
    const up = await mem.setImportance(fact.id, 999)
    expect(up!.importance).toBe(100)
    const down = await mem.setImportance(fact.id, -5)
    expect(down!.importance).toBe(0)
  })

  it('setImportance / invalidate / deleteFact 对不存在 id 安全（null / false）', async () => {
    const { mem } = await setup()
    expect(await mem.setImportance('nope', 50)).toBeNull()
    expect(await mem.invalidate('nope')).toBeNull()
    expect(await mem.deleteFact('nope')).toBe(false)
  })
})

describe('MemoryService 业务层 — 写入与合并', () => {
  it('recency-wins：同 agentId + 同 entity+relation + 同 fact 文本的新事实标旧事实失效，且 supersedes 溯源，不物理删除', async () => {
    const { mem } = await setup()
    const old = await mem.putFact(input({ agentId: 'a1', entity: 'stack', relation: 'uses', fact: 'stack uses MySQL' }))
    const neu = await mem.putFact(input({ agentId: 'a1', entity: 'stack', relation: 'uses', fact: 'stack uses MySQL' }))

    // 新事实 supersedes 指向旧事实。
    expect(neu.invalidated).toEqual([old.fact.id])
    expect(neu.fact.supersedes).toEqual([old.fact.id])

    // 旧事实仍在（未删除），只是标了 invalidAt → 不 applicable，但 retained。
    const oldView = await mem.getFact(old.fact.id)
    expect(oldView).not.toBeNull()
    expect(oldView!.applicable).toBe(false)
    expect(oldView!.retained).toBe(true)
    expect(oldView!.invalidAt).not.toBeNull()
  })

  it('同 agentId + 同 entity+relation 但不同 fact 文本 → 共存，不触发合并', async () => {
    const { mem } = await setup()
    const a = await mem.putFact(input({ agentId: 'a1', entity: 'stack', relation: 'uses', fact: 'stack uses Postgres' }))
    const b = await mem.putFact(input({ agentId: 'a1', entity: 'stack', relation: 'uses', fact: 'stack uses MySQL' }))
    expect(b.invalidated).toEqual([])
    expect((await mem.getFact(a.fact.id))!.applicable).toBe(true) // a 未被失效
    expect(await mem.listFacts()).toHaveLength(2)
  })

  it('跨 Agent 隔离：同 entity+relation+fact 但不同 agentId → 不互相失效', async () => {
    const { mem } = await setup()
    const a = await mem.putFact(input({ agentId: 'agent-a', entity: 'stack', relation: 'uses', fact: 'stack uses MySQL' }))
    const b = await mem.putFact(input({ agentId: 'agent-b', entity: 'stack', relation: 'uses', fact: 'stack uses MySQL' }))
    expect(b.invalidated).toEqual([])
    expect((await mem.getFact(a.fact.id))!.applicable).toBe(true) // a 未被失效
  })

  it('同 id 幂等重写：不失效自身（supersedes 为空）', async () => {
    const { mem } = await setup()
    const id = 'fixed-id'
    const r1 = await mem.putFact(input({ id, agentId: 'a1', entity: 'stack', relation: 'uses', fact: 'stack uses MySQL' }))
    const r2 = await mem.putFact(input({ id, agentId: 'a1', entity: 'stack', relation: 'uses', fact: 'stack uses MySQL' }))
    expect(r2.invalidated).toEqual([])
    expect(r2.fact.supersedes).toEqual([])
    // 同 id 覆盖后只有一条。
    expect(await mem.listFacts()).toHaveLength(1)
  })

  it('不同 entity 或不同 relation 不触发合并', async () => {
    const { mem } = await setup()
    const a = await mem.putFact(input({ entity: 'A', relation: 'uses', fact: 'A uses X' }))
    const b = await mem.putFact(input({ entity: 'B', relation: 'uses', fact: 'B uses X' }))
    expect(b.invalidated).toEqual([])
    expect((await mem.getFact(a.fact.id))!.applicable).toBe(true) // A 未被失效
  })

  it('entity 和 relation 都为空时（自成实体）永不合并', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '独立事实 1' }))
    const r2 = await mem.putFact(input({ fact: '独立事实 2' }))
    expect(r2.invalidated).toEqual([])
    expect(await mem.listFacts()).toHaveLength(2)
  })
})

describe('MemoryService 业务层 — 持久化判定（4 规则）', () => {
  it('规则1/2：显式 permanent（纪律/永久事实源）→ permanent 且 expiresAt=null', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '用户纪律：所有代码必须走测试', retention: 'permanent' }))
    expect(fact.retention).toBe('permanent')
    expect(fact.expiresAt).toBeNull()
    expect((await mem.getFact(fact.id))!.retained).toBe(true)
  })

  it('规则3：author=user（手动添加）→ long', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '手动添加的事实', author: 'user' }))
    expect(fact.retention).toBe('long')
    expect(fact.expiresAt).not.toBeNull() // long 有 1 年 TTL
  })

  it('默认（agent 写入、未声明）→ temporary 且 2 天 TTL', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '普通 agent 记忆', author: 'agent:s1' }))
    expect(fact.retention).toBe('temporary')
    expect(fact.expiresAt).toBe(fact.createdAt + 2 * 24 * 60 * 60 * 1000)
  })

  it('规则4：readCount 达阈值 → 升级为 long', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '高频读取的事实', author: 'agent:s1' }))
    expect(fact.retention).toBe('temporary')

    // 连续检索 5 次（readCount 达阈值）。
    for (let i = 0; i < READ_PROMOTE_THRESHOLD; i++) {
      await mem.searchFacts({ query: '高频读取', mode: 'recall' })
    }
    const after = await mem.getFact(fact.id)
    expect(after!.retention).toBe('long')
    expect(after!.readCount).toBe(READ_PROMOTE_THRESHOLD)
  })
})

describe('MemoryService 业务层 — 存续期遗忘（非持久化按 TTL 衰减）', () => {
  it('temporary 写入时 expiresAt = createdAt + 2天（非持久化 TTL 落定）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '临时记忆', retention: 'temporary', author: 'agent:s1' }))
    expect(fact.expiresAt).toBe(fact.createdAt + 2 * 24 * 60 * 60 * 1000)
    expect((await mem.getFact(fact.id))!.retained).toBe(true) // 刚写入，未过期
  })

  it('permanent 永不过期（expiresAt=null → retained 恒 true）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '永久纪律', retention: 'permanent' }))
    expect(fact.expiresAt).toBeNull()
    expect((await mem.getFact(fact.id))!.retained).toBe(true)
  })
})

describe('MemoryService 业务层 — 检索（applicable / recall 双模式，失效 ≠ 忘记）', () => {
  it('applicable 模式（默认）只返回当前适用的事实', async () => {
    const { mem } = await setup()
    const { fact: alive } = await mem.putFact(input({ fact: '当前适用的事实' }))
    // 写入时给定过去 invalidAt → 到期，不 applicable。
    await mem.putFact(input({ id: 'expired-2', fact: '到期事实 B', invalidAt: 1 }))

    const applicable = await mem.searchFacts({ mode: 'applicable' })
    const ids = applicable.map(f => f.id)
    expect(ids).toContain(alive.id)
    expect(ids).not.toContain('expired-2')
  })

  it('recall 模式返回全部（含到期），回忆「发生过什么」', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '仍在适用的日程' }))
    await mem.putFact(input({ id: 'expired', fact: '10月31日前的日程提醒', invalidAt: 1 }))

    const applicable = await mem.searchFacts({ mode: 'applicable' })
    expect(applicable.map(f => f.id)).not.toContain('expired')

    const recall = await mem.searchFacts({ mode: 'recall' })
    expect(recall.map(f => f.id)).toContain('expired')
  })

  it('日程场景端到端：到期后 applicable 不再召回，但 recall 仍可召回', async () => {
    const { mem } = await setup()
    const now = Date.now()
    // 「10月31日前每天提醒日程」：validAt=now，invalidAt=now+1天 内适用；构造到期版。
    const { fact } = await mem.putFact(input({
      entity: 'schedule',
      relation: 'reminds',
      fact: '每天提醒用户日程',
      validAt: now - 2 * 86400_000,
      invalidAt: now - 86400_000, // 已到期
    }))

    // 到期 → 不 applicable，但 retained。
    const view = await mem.getFact(fact.id)
    expect(view!.applicable).toBe(false)
    expect(view!.retained).toBe(true)

    // applicable 检索不召回（不再提醒）；recall 检索召回（记忆仍在）。
    expect((await mem.searchFacts({ mode: 'applicable' })).map(f => f.id)).not.toContain(fact.id)
    expect((await mem.searchFacts({ mode: 'recall' })).map(f => f.id)).toContain(fact.id)
  })

  it('agentId 过滤只返回对应 Agent 的记忆', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'pm 的事实', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'dev 的事实', agentId: 'dev' }))

    const pmOnly = await mem.searchFacts({ agentId: 'pm', mode: 'recall' })
    expect(pmOnly).toHaveLength(1)
    expect(pmOnly[0].fact).toBe('pm 的事实')

    const devOnly = await mem.searchFacts({ agentId: 'dev', mode: 'recall' })
    expect(devOnly).toHaveLength(1)
    expect(devOnly[0].fact).toBe('dev 的事实')
  })

  it('query 关键词子串匹配（大小写不敏感）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'DeepSeek Harness fork' }))
    await mem.putFact(input({ fact: '另一个事实' }))
    const hit = await mem.searchFacts({ query: 'deepseek', mode: 'recall' })
    expect(hit).toHaveLength(1)
    expect(hit[0].fact).toBe('DeepSeek Harness fork')
  })

  it('多策略检索：按 entity 命中召回（即使 fact 文本不含关键词）', async () => {
    const { mem } = await setup()
    // fact 文本是「使用 PostgreSQL」，但 entity 是 'stack'——问「stack」应能按实体召回。
    await mem.putFact(input({ entity: 'stack', relation: 'uses', fact: '使用 PostgreSQL 作为数据库' }))
    await mem.putFact(input({ fact: '另一个无关事实' }))

    const hit = await mem.searchFacts({ query: 'stack', mode: 'recall' })
    expect(hit).toHaveLength(1)
    expect(hit[0].entity).toBe('stack')
  })

  it('多策略检索：按 relation 命中召回', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ entity: 'A', relation: 'owns', fact: 'A 拥有某个仓库' }))
    await mem.putFact(input({ fact: '另一个无关事实' }))

    const hit = await mem.searchFacts({ query: 'owns', mode: 'recall' })
    expect(hit).toHaveLength(1)
    expect(hit[0].relation).toBe('owns')
  })

  it('多策略检索：匹配分高者排前（fact 命中 > entity 命中）', async () => {
    const { mem } = await setup()
    // fact 直接命中「stack」的，应排在仅 entity 命中「stack」的前面。
    await mem.putFact(input({ id: 'entity-only', entity: 'stack', relation: 'uses', fact: '使用 PostgreSQL' }))
    await mem.putFact(input({ id: 'fact-hit', fact: 'stack 是核心组件' }))

    const hit = await mem.searchFacts({ query: 'stack', mode: 'recall' })
    expect(hit[0].id).toBe('fact-hit') // fact 命中(4) > entity 命中(3)
  })

  it('无关键词时退化为纯记忆强度排序', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'low', importance: 10 }))
    await mem.putFact(input({ fact: 'high', importance: 90 }))
    const all = await mem.searchFacts({ mode: 'recall' })
    expect(all[0].fact).toBe('high')
    expect(all[1].fact).toBe('low')
  })

  it('limit 限制返回条数', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'a', importance: 90 }))
    await mem.putFact(input({ fact: 'b', importance: 80 }))
    await mem.putFact(input({ fact: 'c', importance: 70 }))
    const top2 = await mem.searchFacts({ mode: 'recall', limit: 2 })
    expect(top2).toHaveLength(2)
    expect(top2.map(f => f.fact)).toEqual(['a', 'b']) // 降序前 2
  })
})

describe('MemoryService 业务层 — 人工修剪三动作', () => {
  it('invalidate 标失效：applicable→false，但 retained 保持、可 recall 召回', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '待失效事实' }))
    const before = await mem.getFact(fact.id)
    expect(before!.applicable).toBe(true)

    const after = await mem.invalidate(fact.id)
    expect(after!.applicable).toBe(false)
    expect(after!.retained).toBe(true)
    expect(after!.invalidAt).not.toBeNull()

    expect((await mem.searchFacts({ mode: 'applicable' })).map(f => f.id)).not.toContain(fact.id)
    expect((await mem.searchFacts({ mode: 'recall' })).map(f => f.id)).toContain(fact.id)
  })

  it('setImportance 上调改变记忆强度（importance 是衰减基数）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '待提升', importance: 10 }))
    const raised = await mem.setImportance(fact.id, 90)
    expect(raised!.importance).toBe(90)
    expect(raised!.effectiveScore).toBeGreaterThan(0)
  })

  it('deleteFact 硬删除后 recall 也召回不到（真正忘记，不可逆）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '待删除事实' }))
    const ok = await mem.deleteFact(fact.id)
    expect(ok).toBe(true)
    expect(await mem.getFact(fact.id)).toBeNull()
    expect((await mem.searchFacts({ mode: 'recall' })).map(f => f.id)).not.toContain(fact.id)
  })
})

describe('MemoryService 业务层 — 访问强化（lastAccessedAt）', () => {
  it('searchFacts 命中后刷新 lastAccessedAt', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '待访问事实' }))
    const before = await mem.getFact(fact.id)
    expect(before!.lastAccessedAt).toBeNull()

    await mem.searchFacts({ query: '待访问', mode: 'recall' })
    const after = await mem.getFact(fact.id)
    expect(after!.lastAccessedAt).not.toBeNull()
  })
})

describe('MemoryService 串行队列 — 并发写安全', () => {
  it('并发写入不同 fact 文本全部存活（无 lost update）', async () => {
    const { mem } = await setup()
    // 10 条不同文本，同 agentId + 同 entity+relation——新语义下不同文本共存。
    const texts = Array.from({ length: 10 }, (_, i) => `并发事实 #${i}`)
    const results = await Promise.all(
      texts.map(t => mem.putFact(input({ agentId: 'a', entity: 'e', relation: 'r', fact: t }))),
    )
    // 每条都应落库存活（invalidated 为空——不同文本不互相失效）。
    for (const r of results) {
      expect(r.invalidated).toEqual([])
    }
    const all = await mem.listFacts()
    expect(all).toHaveLength(10)
    // 每条文本都在库里。
    const facts = new Set(all.map(f => f.fact))
    for (const t of texts) {
      expect(facts.has(t)).toBe(true)
    }
  })

  it('并发写入相同 agentId+entity+relation+fact 文本 → 仅一条 applicable', async () => {
    const { mem } = await setup()
    const sameFact = 'stack uses MySQL'
    // 10 条完全相同（同 agentId+entity+relation+fact），用不同 id。
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mem.putFact(input({ id: `dup-${i}`, agentId: 'a', entity: 'stack', relation: 'uses', fact: sameFact })),
      ),
    )
    // 串行执行后：第一条无 invalidated，后续每条都把之前的活跃事实标失效。
    // 最终只有最后一条 applicable。
    const all = await mem.listFacts()
    const applicable = all.filter(f => f.applicable)
    expect(applicable).toHaveLength(1)
    expect(applicable[0].fact).toBe(sameFact)
    // 所有 10 条都在库里（标失效不物理删除）。
    expect(all).toHaveLength(10)
  })

  it('并发 searchFacts 命中同一事实 → readCount 无 lost update（最终 = 并发次数）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '唯一可命中事实', agentId: 'a' }))
    const N = 20
    // 并发检索 20 次，每次都命中这条。
    await Promise.all(
      Array.from({ length: N }, () => mem.searchFacts({ agentId: 'a', query: '唯一', mode: 'recall' })),
    )
    const after = await mem.getFact(fact.id)
    // 串行队列保证每次命中都 +1，无 lost update。
    expect(after!.readCount).toBe(N)
  })

  it('队列在 reject 后恢复：失败的写之后后续写仍可执行', async () => {
    const { mem } = await setup()
    // clearFacts 不给 agentId → throw（同步 reject）。
    // 用 .catch 捕获避免 unhandled rejection。
    const failed = mem.clearFacts({} as never).catch(() => 'rejected')
    expect(await failed).toBe('rejected')
    // 队列应已恢复——后续 putFact 正常执行。
    const { fact } = await mem.putFact(input({ fact: '失败后的正常写入' }))
    expect(fact.id).toBeTruthy()
    expect((await mem.getFact(fact.id))!.fact).toBe('失败后的正常写入')
  })

  it('并发写 + 并发检索交错 → 无数据损坏（所有写入存活、readCount 一致）', async () => {
    const { mem } = await setup()
    // 先写入 5 条不同事实。
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5']
    for (const id of ids) {
      await mem.putFact(input({ id, fact: `事实 ${id}`, agentId: 'a' }))
    }
    // 然后并发：5 次检索（每次命中全部 5 条）+ 5 次写入新事实。
    const searches = Array.from({ length: 5 }, () =>
      mem.searchFacts({ agentId: 'a', mode: 'recall' }),
    )
    const writes = Array.from({ length: 5 }, (_, i) =>
      mem.putFact(input({ id: `w${6 + i}`, fact: `事实 w${6 + i}`, agentId: 'a' })),
    )
    await Promise.all([...searches, ...writes])
    // 最终应有 10 条事实。每条原始 5 条被检索命中 5 次 → readCount=5。
    const all = await mem.listFacts()
    expect(all).toHaveLength(10)
    for (const id of ids) {
      const f = await mem.getFact(id)
      expect(f!.readCount).toBe(5)
    }
  })
})

/* ══════════════════════════════════════════════════════════════════
 * #4 PutFactResult 结构：evictedByCapacity / cleanedExpired 分字段 +
 *    rejected 稳定码（invalid:<field> / unavailable）
 * ══════════════════════════════════════════════════════════════════ */

describe('#4 PutFactResult：evicted 拆为 evictedByCapacity + cleanedExpired', () => {
  it('容量淘汰的 id 进 evictedByCapacity，不进 cleanedExpired', async () => {
    // capacity=1 + least-used：先写旧条目，再写新条目。
    // 第二次写入后超限 → enforceCapacity 淘汰旧条目（protectId 保护新条）。
    const ctx = new Context()
    await ctx.plugin(Storage)
    const root = join(home, 'storages-capacity')
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    const settingsFace = {
      describe: () => [{ ns: 'corum-memory-settings', value: { capacity: 1, overflowPolicy: 'least-used' } }],
    }
    ctx.provide('settings', settingsFace as never)
    const mem = ctx.get('memory') ?? new MemoryService(ctx)

    const old = await mem.putFact(input({ fact: '旧条目', id: 'old-id' }))
    expect(old.evictedByCapacity).toEqual([])
    expect(old.cleanedExpired).toEqual([])

    const neu = await mem.putFact(input({ fact: '新条目', id: 'new-id' }))
    // 旧条目被容量淘汰 → evictedByCapacity 精确含旧 id。
    expect(neu.evictedByCapacity).toEqual(['old-id'])
    // 不进 cleanedExpired（那是过期清理的通道）。
    expect(neu.cleanedExpired).toEqual([])
    // listFacts 只剩新 id（protectId 保护刚写入的条目不被淘汰）。
    const all = await mem.listFacts()
    expect(all.map(f => f.id)).toEqual(['new-id'])
  })

  it('autoCleanExpired 开启后：写入时清理的过期 id 进 cleanedExpired，不进 evictedByCapacity', async () => {
    // settings autoCleanExpired=true。用 vi fake time 让 createdAt/expiresAt 自然过期：
    // 写第一条 temporary（2 天 TTL），推进时间超过 2 天使其过期，
    // 再写第二条 → autoCleanExpired 清理掉第一条，cleanedExpired 精确含旧 id。
    // 不得先手动 cleanExpired。
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(Storage)
      const root = join(home, 'storages-autoclean')
      await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
      await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
      const settingsFace = {
        describe: () => [{ ns: 'corum-memory-settings', value: { autoCleanExpired: true } }],
      }
      ctx.provide('settings', settingsFace as never)
      const mem = ctx.get('memory') ?? new MemoryService(ctx)

      // T0：写第一条 temporary（expiresAt = createdAt + 2天）。
      const r1 = await mem.putFact(input({ fact: '会过期的临时记忆', retention: 'temporary', id: 'old-expired' }))
      expect(r1.cleanedExpired).toEqual([]) // 刚写入，库无过期条目
      expect(r1.fact.expiresAt).not.toBeNull()

      // 推进时间超过 2 天 → 第一条 expiresAt 已过（isRetained=false）。
      vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000)

      // 写第二条：autoCleanExpired 在写入序列里先清理过期条目 → cleanedExpired 含旧 id。
      const r2 = await mem.putFact(input({ fact: '触发清理的新记忆', id: 'new-survivor' }))
      expect(r2.cleanedExpired).toEqual(['old-expired'])
      expect(r2.evictedByCapacity).toEqual([]) // capacity=null（默认不限），不淘汰
      // 旧记录消失，新记录留存。
      const all = await mem.listFacts()
      const ids = all.map(f => f.id)
      expect(ids).not.toContain('old-expired')
      expect(ids).toContain('new-survivor')
      expect(ids).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('#4 PutFactResult：rejected 稳定码', () => {
  it('非法 fact（空串）→ rejected invalid:fact，不抛错、不落库', async () => {
    const { mem } = await setup()
    const r = await mem.putFact(input({ fact: '' }))
    expect(r.rejected).toEqual(['invalid:fact'])
    expect(r.fact.id).toBeTruthy() // 仍有 fact 形态
    // 未落库
    expect(await mem.getFact(r.fact.id)).toBeNull()
    expect(await mem.listFacts()).toHaveLength(0)
  })

  it('非法 importance（超出范围）→ rejected invalid:importance', async () => {
    const { mem } = await setup()
    const r = await mem.putFact(input({ fact: '合法文本', importance: 999 }))
    expect(r.rejected).toEqual(['invalid:importance'])
    expect(await mem.listFacts()).toHaveLength(0)
  })

  it('非法 evidence（非数组）→ rejected invalid:evidence，placeholder 构造不二次抛错', async () => {
    // 非法 evidence（数字而非 string[]）会被 zod 拒绝；placeholder 构造不应因
    // 原非法字段再次抛错——它用 input.evidence ?? [] 兜底（非数组真值穿透为原值，
    // 但不调 schema.parse，故不抛）。验证：不抛、rejected 含 invalid:evidence、id 可用、未落库。
    const { mem } = await setup()
    const r = await mem.putFact(input({ fact: '合法文本', evidence: 123 as unknown as string[] }))
    expect(r.rejected).toEqual(['invalid:evidence'])
    expect(r.fact.id).toBeTruthy()
    expect(await mem.listFacts()).toHaveLength(0)
  })

  it('非法 input 后队列仍可写（reject 恢复）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '' })) // rejected invalid:fact
    const r = await mem.putFact(input({ fact: '合法写入' }))
    expect(r.rejected).toEqual([])
    expect(await mem.getFact(r.fact.id)).not.toBeNull()
  })

  it('缺存储时 → rejected unavailable（不假成功）', async () => {
    // 不装 storage 栈：MemoryService 构造但 domain() 返回 undefined。
    const ctx = new Context()
    const mem = new MemoryService(ctx)
    const r = await mem.putFact(input({ fact: '无存储' }))
    expect(r.rejected).toEqual(['unavailable'])
    // 不假成功：rejected 非空
    expect(r.rejected.length).toBeGreaterThan(0)
  })

  it('总开关关闭 + 非用户写入 → rejected disabled（优先于 unavailable 不触发——先校验再查 table）', async () => {
    // 装了存储但关了开关：校验通过后才查 table，table 可用，闸门1 拒收。
    // 这里验证：有存储 + 关开关 → disabled（不是 unavailable）。
    const ctx = new Context()
    await ctx.plugin(Storage)
    const root = join(home, 'storages-disabled')
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    const settingsFace = {
      describe: () => [{ ns: 'corum-memory-settings', value: { enabled: false } }],
    }
    ctx.provide('settings', settingsFace as never)
    const mem = ctx.get('memory') ?? new MemoryService(ctx)
    const r = await mem.putFact(input({ fact: '开关关了', author: 'agent:s1' }))
    expect(r.rejected).toEqual(['disabled'])
  })

  it('容量满 + stop → rejected capacity（分字段后 evictedByCapacity 为空，未淘汰）', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const root = join(home, 'storages-cap')
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    const settingsFace = {
      describe: () => [{ ns: 'corum-memory-settings', value: { capacity: 2, overflowPolicy: 'stop' } }],
    }
    ctx.provide('settings', settingsFace as never)
    const mem = ctx.get('memory') ?? new MemoryService(ctx)
    await mem.putFact(input({ fact: 'f0', id: 'k0' }))
    await mem.putFact(input({ fact: 'f1', id: 'k1' }))
    const third = await mem.putFact(input({ fact: 'f2', id: 'k2' }))
    expect(third.rejected).toEqual(['capacity'])
    expect(third.evictedByCapacity).toEqual([])
    expect(third.cleanedExpired).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════
 * #5 source 等值过滤 + deleteBySource + putFacts
 * ══════════════════════════════════════════════════════════════════ */

describe('#5 searchFacts source 等值过滤', () => {
  it('source 精确等值：只返回匹配 source 的事实', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '来自会话1', source: 'session-1' }))
    await mem.putFact(input({ fact: '来自会话2', source: 'session-2' }))
    const hits = await mem.searchFacts({ source: 'session-1', mode: 'recall' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('来自会话1')
  })

  it('source 空串只匹配 source 为空串的事实', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '无来源', source: '' }))
    await mem.putFact(input({ fact: '有来源', source: 'session-1' }))
    const hits = await mem.searchFacts({ source: '', mode: 'recall' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('无来源')
  })

  it('source undefined 不过滤（返回全部）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '无来源', source: '' }))
    await mem.putFact(input({ fact: '有来源', source: 'session-1' }))
    const hits = await mem.searchFacts({ mode: 'recall' })
    expect(hits).toHaveLength(2)
  })

  it('source 大小写敏感（精确等值，不像 query 做大小写不敏感）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '大写', source: 'Session-1' }))
    const hits = await mem.searchFacts({ source: 'session-1', mode: 'recall' })
    expect(hits).toHaveLength(0)
    const hits2 = await mem.searchFacts({ source: 'Session-1', mode: 'recall' })
    expect(hits2).toHaveLength(1)
  })

  it('source 与 query 可同时使用（交集）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '关键词命中', source: 's1' }))
    await mem.putFact(input({ fact: '别的文本', source: 's1' }))
    await mem.putFact(input({ fact: '关键词命中', source: 's2' }))
    const hits = await mem.searchFacts({ source: 's1', query: '关键词', mode: 'recall' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('关键词命中')
  })
})

describe('#5 listFacts source 等值过滤', () => {
  it('listFacts 按 source 过滤', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'a', source: 's1' }))
    await mem.putFact(input({ fact: 'b', source: 's2' }))
    const hits = await mem.listFacts({ source: 's1' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('a')
  })

  it('listFacts source 空串只匹配空串', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '无来源', source: '' }))
    await mem.putFact(input({ fact: '有来源', source: 's1' }))
    const hits = await mem.listFacts({ source: '' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('无来源')
  })
})

describe('#5 deleteBySource', () => {
  it('全局删除：按 source 删除全部匹配，返回删除数', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'a', source: 's1' }))
    await mem.putFact(input({ fact: 'b', source: 's1' }))
    await mem.putFact(input({ fact: 'c', source: 's2' }))
    const n = await mem.deleteBySource('s1')
    expect(n).toBe(2)
    const left = await mem.listFacts()
    expect(left).toHaveLength(1)
    expect(left[0].fact).toBe('c')
  })

  it('Agent 限定：只删该 Agent + 该 source 的事实', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'a', source: 's1', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'b', source: 's1', agentId: 'dev' }))
    const n = await mem.deleteBySource('s1', 'pm')
    expect(n).toBe(1)
    const left = await mem.listFacts()
    expect(left).toHaveLength(1)
    expect(left[0].agentId).toBe('dev')
  })

  it('Agent 限定显式空串：只删未归属 + 该 source', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '无归属', source: 's1', agentId: '' }))
    await mem.putFact(input({ fact: '有归属', source: 's1', agentId: 'pm' }))
    const n = await mem.deleteBySource('s1', '')
    expect(n).toBe(1)
    const left = await mem.listFacts()
    expect(left).toHaveLength(1)
    expect(left[0].agentId).toBe('pm')
  })

  it('空 source 拒绝执行（防误删）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'x', source: '' }))
    await expect(mem.deleteBySource('')).rejects.toThrow(/source must be non-empty/)
    expect(await mem.listFacts()).toHaveLength(1)
  })

  it('缺存储时返回 0（语义明确，不抛错）', async () => {
    const ctx = new Context()
    const mem = new MemoryService(ctx)
    const n = await mem.deleteBySource('s1')
    expect(n).toBe(0)
  })

  it('不存在的 source 返回 0', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'x', source: 's1' }))
    const n = await mem.deleteBySource('nonexistent')
    expect(n).toBe(0)
  })
})

describe('#5 putFacts', () => {
  it('保序：返回数组长度/顺序对应输入', async () => {
    const { mem } = await setup()
    const results = await mem.putFacts([
      input({ fact: '第一条', id: 'a' }),
      input({ fact: '第二条', id: 'b' }),
      input({ fact: '第三条', id: 'c' }),
    ])
    expect(results).toHaveLength(3)
    expect(results[0].fact.id).toBe('a')
    expect(results[1].fact.id).toBe('b')
    expect(results[2].fact.id).toBe('c')
    expect(results.every(r => r.rejected.length === 0)).toBe(true)
  })

  it('空数组安全返回 []', async () => {
    const { mem } = await setup()
    const results = await mem.putFacts([])
    expect(results).toEqual([])
  })

  it('部分拒收不中断后续项', async () => {
    const { mem } = await setup()
    const results = await mem.putFacts([
      input({ fact: '合法', id: 'ok1' }),
      input({ fact: '', id: 'bad' }), // rejected invalid:fact
      input({ fact: '合法2', id: 'ok2' }),
    ])
    expect(results).toHaveLength(3)
    expect(results[0].rejected).toEqual([])
    expect(results[1].rejected).toEqual(['invalid:fact'])
    expect(results[2].rejected).toEqual([])
    // 合法的两条落库，非法的没落库
    expect(await mem.getFact('ok1')).not.toBeNull()
    expect(await mem.getFact('ok2')).not.toBeNull()
    expect(await mem.getFact('bad')).toBeNull()
  })

  it('冲突语义正确：同 agentId+entity+relation+fact 的两项 → 第二项标第一项失效', async () => {
    const { mem } = await setup()
    const results = await mem.putFacts([
      input({ fact: 'stack uses MySQL', agentId: 'a', entity: 'stack', relation: 'uses', id: 'first' }),
      input({ fact: 'stack uses MySQL', agentId: 'a', entity: 'stack', relation: 'uses', id: 'second' }),
    ])
    expect(results[0].invalidated).toEqual([])
    expect(results[1].invalidated).toEqual(['first'])
    // 第一条标失效，第二条 applicable
    expect((await mem.getFact('first'))!.applicable).toBe(false)
    expect((await mem.getFact('second'))!.applicable).toBe(true)
  })

  it('并发安全：两个 putFacts 并发不丢数据', async () => {
    const { mem } = await setup()
    const [r1, r2] = await Promise.all([
      mem.putFacts([input({ fact: 'batch1-a', id: 'b1a' }), input({ fact: 'batch1-b', id: 'b1b' })]),
      mem.putFacts([input({ fact: 'batch2-a', id: 'b2a' }), input({ fact: 'batch2-b', id: 'b2b' })]),
    ])
    expect(r1).toHaveLength(2)
    expect(r2).toHaveLength(2)
    const all = await mem.listFacts()
    expect(all).toHaveLength(4)
  })
})

/* ══════════════════════════════════════════════════════════════════
 * #6 agentId 空值检索可见性收紧
 * ══════════════════════════════════════════════════════════════════ */

describe('#6 agentId 空值检索可见性', () => {
  it('searchFacts 不给 agentId 时排除未归属事实（agentId===""）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '未归属的事实', agentId: '' }))
    await mem.putFact(input({ fact: '有归属的事实', agentId: 'pm' }))
    // 不给 agentId → 只看有归属的，排除未归属
    const hits = await mem.searchFacts({ mode: 'recall' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('有归属的事实')
  })

  it('searchFacts 指定真实 agentId 只查该 Agent', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'pm 的事实', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'dev 的事实', agentId: 'dev' }))
    await mem.putFact(input({ fact: '未归属', agentId: '' }))
    const hits = await mem.searchFacts({ agentId: 'pm', mode: 'recall' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('pm 的事实')
  })

  it('searchFacts 显式 agentId="" 可查未归属（管理/审计）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '未归属的事实', agentId: '' }))
    await mem.putFact(input({ fact: '有归属的事实', agentId: 'pm' }))
    const hits = await mem.searchFacts({ agentId: '', mode: 'recall' })
    expect(hits).toHaveLength(1)
    expect(hits[0].fact).toBe('未归属的事实')
  })

  it('listFacts 不受影响：不给 agentId 仍可见全部（含未归属）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '未归属', agentId: '' }))
    await mem.putFact(input({ fact: '有归属', agentId: 'pm' }))
    const all = await mem.listFacts()
    expect(all).toHaveLength(2)
  })

  it('listFacets 不受影响：统计仍含未归属', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '未归属', agentId: '' }))
    await mem.putFact(input({ fact: 'pm1', agentId: 'pm' }))
    await mem.putFact(input({ fact: 'pm2', agentId: 'pm' }))
    const facets = await mem.listFacets({})
    // 未归属 + pm 两个 facet
    expect(facets).toHaveLength(2)
    const pmFacet = facets.find(f => f.id === 'pm')
    expect(pmFacet!.count).toBe(2)
    const unownedFacet = facets.find(f => f.id === '')
    expect(unownedFacet!.count).toBe(1)
  })

  it('PutFactInput 空串 agentId 仍持久化（不新增第三档）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '未归属持久化', agentId: '' }))
    expect(fact.agentId).toBe('')
    const got = await mem.getFact(fact.id)
    expect(got!.agentId).toBe('')
  })
})
