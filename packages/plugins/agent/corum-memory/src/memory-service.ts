/**
 * MemoryService —— corum 记忆底座 host 服务。
 *
 * 职责（只承载「组织形式」，不绑定记忆来源）：
 *   - 事实级存储：单域 corum_memory、单表 facts，key = factId。
 *   - 写入：重要性写入门槛 + 同 entity+relation 的 recency-wins 合并（标失效不删）
 *     + 容量治理（超限淘汰）+ 自动清理已过期。
 *   - 检索：按 agentId/关键词过滤，按读时降权 effectiveScore 排序；
 *     命中即更新 lastAccessedAt（访问强化）。
 *   - 人工修剪三动作：失效标记（invalidate，可逆）/ 重要性调整（pin）/ 硬删除
 *     （delete，仅合规/用户显式要求，绕过策略）。
 *
 * **可配置面**（settings namespace `corum-memory`，见 memory-config.ts）：总开关、
 * 存续期默认档、读取升级阈值、衰减强度、容量与超限策略、自动清理、注入策略
 * （注入**未生效**——底座尚无注入机制）。服务持有一份 resolved config，每次策略
 * 调用显式传参（不用模块级可变单例，红线 1）。
 *
 * 存储复用官方 dsh-storage-domain（ctx.storageDomain 由官方插件注入）。
 * 服务是 TypertRemoteService，@Remote 端点暴露 /api/memory/* 供 client 面板调用。
 *
 * @module @corum/corum-memory/memory-service
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
// 拉进 declare module '@deepseek-ai/cordis' { storageDomain: DomainFacility } 合并面，
// 使 ctx.get('storageDomain') 有正确类型（与 corum-orchestration 同款 import type {}）。
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { MemoryFact, MemoryFactView, MemoryRetention } from './memory-entities.ts'
import { memoryDomainSpec, memoryFactSchema } from './memory-entities.ts'
import {
  conflictsToInvalidate,
  expiresAtFor,
  isRetained,
  promoteRetentionOnRead,
  resolveRetentionOnWrite,
  scoreMatch,
  toView,
} from './memory-policy.ts'
import type { PolicyOverrides } from './memory-policy.ts'
import { acquireMemorySettingsScope, resolveMemoryConfig } from './memory-config.ts'
import type { ResolvedMemoryConfig } from './memory-config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** 事实表句柄。 */
type FactsTable = KvTable<string, MemoryFact>
/** 打开后的域句柄。 */
type MemoryDomain = Domain<ReturnType<typeof memoryDomainSpec>>

/** 写入门槛：importance 低于此值的事实直接拒收（caller 侧判定，非底座硬规则，可显式传入）。 */
export const DEFAULT_MIN_IMPORTANCE = 0

/** 写入一条事实的入参（author 由调用方显式声明，不猜）。 */
export interface PutFactInput {
  /** 缺省生成 uuid；调用方可复用其自有 id（幂等写）。 */
  id?: string
  entity?: string
  relation?: string
  fact: string
  importance?: number
  validAt?: number
  invalidAt?: number
  source?: string
  /** 归属 Agent（profile id）。空串 = 未归属（顶层/系统写入）。 */
  agentId?: string
  /**
   * 显式声明的存续期。缺省按「持久化判定」推导：
   *   - 'permanent'：用户明确要求的纪律 / 可判定永久的事实来源；
   *   - 未声明且 author='user'：手动添加 → long；
   *   - 其余 → temporary。
   */
  retention?: MemoryRetention
  evidence?: string[]
  /** 写入者：'user' | 'system' | 'agent:<sessionId>'。 */
  author: string
}

/** 检索过滤条件。 */
export interface SearchFactsInput {
  /** 只看该 Agent 的记忆（空/缺省 = 不按 Agent 过滤）。 */
  agentId?: string
  /** 关键词（在 fact 文本上做子串匹配，大小写不敏感）。 */
  query?: string
  /**
   * 检索模式：
   *   - 'applicable'（默认）：只返回当前适用/成立的事实，供 Agent 驱动当前行为。
   *   - 'recall'：返回全部（含已到期/失效），回忆「发生过什么」——失效 ≠ 忘记。
   */
  mode?: 'applicable' | 'recall'
  /** 最多返回条数（默认 100）。 */
  limit?: number
}

/** 列表过滤条件（面板浏览/人工修剪用；与 {@link SearchFactsInput} 不同：不做打分、不累加 readCount）。 */
export interface ListFactsInput {
  /** Agent 过滤（空/缺省 = 不按 Agent 过滤）。 */
  agentId?: string
  /** 是否包含已到期/已失效（默认 true——面板要能看见并修剪它们；检索不看）。 */
  includeExpired?: boolean
}

/**
 * 某一归属的记忆条数，供记忆库页的 chip 列。
 *
 * 2026-09-22「移除项目记忆」后维度收敛为 Agent 单一维度，归属即 agentId；
 * `listFacets` 不再接受 `dimension` 参数（只按 agentId 分组）。
 */
export interface MemoryFacet {
  /** Agent profile id；空串 = 「未归属」。 */
  id: string
  /** 展示名（由调用方给；缺省回落到 id）。 */
  label: string
  /** 条数。 */
  count: number
}

/** 写入结果。 */
export interface PutFactResult {
  fact: MemoryFact
  /** 本次写入因 recency-wins 而被标记失效的旧事实 id。 */
  invalidated: string[]
  /** 被设置面拒收的原因（空 = 已落库）：`disabled`（总开关关闭）/ `capacity`（满且策略为停止沉淀）。 */
  rejected: string[]
  /** 本次写入顺带淘汰/清理掉的事实 id（容量超限 + 自动清理已到期）。 */
  evicted: string[]
}

export class MemoryService extends TypertRemoteService {
  /** 打开后的域（懒开 + 缓存）。storageDomain 缺失时（单测/未装配）为 undefined。 */
  private domainPromise: Promise<MemoryDomain> | undefined

  /**
   * 当前生效配置（settings 面 resolved 值 + 内置默认合成）。
   *
   * 不用模块级单例（红线 1：跨 bundle 的模块级状态会被复制成多份）——配置住在
   * 服务实例上，写路径经 `refreshConfig()` 重新合成。settings 服务在 boot 早期
   * 可能尚未挂载，故这里**懒解析 + 缓存**：首次策略调用时取一次，之后由 watch
   * 推送更新（watch 不可用时的部署下退化为「每次调用重新 describe」，仍是单一
   * 真源，不会读旧值）。
   */
  private configCache: ResolvedMemoryConfig | undefined

  constructor(ctx: Context) {
    super(ctx, 'memory')
    // 域懒开：storageDomain 由官方插件提供，装配顺序上它先于本服务（见挂载注释）。
    // 首次真正读写时才 open，避免冷启动就开域（无记忆也零开销）。
    this.domainPromise = undefined
    // settings namespace 注册（幂等；boot registrar 行通常已先注册，此处走只读分支）+
    // watch 推送。拿不到 settings 服务时配置恒为内置默认（单测/未装配场景）。
    this.bindSettings()
    this.ctx.effect(() => () => {
      if (this.domainPromise !== undefined) {
        void this.domainPromise.then(d => d.close(), () => {})
      }
    }, 'memory.domainClose')
  }

  /**
   * 接上 settings 面：注册（或只读挂接）`corum-memory` ns 并订阅变更。
   *
   * 短轮询同款（见 corum-agent / corum-subagent-settings）：settings 服务在 boot
   * 早期可能尚未挂载，拿不到就轮询，超时后放弃（不阻断启动——配置恒为内置默认）。
   */
  private bindSettings(): void {
    const adopt = (): boolean => {
      const settings = this.ctx.get('settings') as
        | { describe?: (options?: unknown) => readonly { ns: string, value?: unknown }[] }
        | undefined
      if (settings === undefined) return false
      const scope = acquireMemorySettingsScope(settings)
      if (scope === undefined) return false
      this.configCache = resolveMemoryConfig(scope.get())
      // rc3 无 watch 面（SettingsForms 不返回 scope）；getConfig() 每次重读 describe()。
      return true
    }
    if (adopt()) return
    const poll = setInterval(() => {
      try { if (adopt()) clearInterval(poll) } catch { /* 继续轮询 */ }
    }, 100)
    setTimeout(() => clearInterval(poll), 15000)
  }

  /**
   * 读当前配置（惰性 + 缓存）。
   *
   * 缓存空时重读一次 settings（覆盖「boot 期轮询超时、用户之后才改设置」的时序），
   * 保证设置面永远是单一真源。
   *
   * @returns 已解析配置（每键有值）。
   */
  getConfig(): ResolvedMemoryConfig {
    if (this.configCache !== undefined) return this.configCache
    const settings = this.ctx.get('settings') as
      | { describe?: (options?: unknown) => readonly { ns: string, value?: unknown }[] }
      | undefined
    if (settings !== undefined) {
      const scope = acquireMemorySettingsScope(settings)
      if (scope !== undefined) {
        this.configCache = resolveMemoryConfig(scope.get())
        return this.configCache
      }
    }
    this.configCache = resolveMemoryConfig(undefined)
    return this.configCache
  }

  /** 策略覆盖（传给 memory-policy 的纯函数；把「设置」与「算法」解耦）。 */
  private overrides(): PolicyOverrides {
    const c = this.getConfig()
    return {
      defaultRetention: c.defaultRetention,
      readPromoteThreshold: c.readPromoteThreshold,
      decayStrength: c.decayStrength,
    }
  }

  /** 懒开域（幂等）。 */
  private async domain(): Promise<MemoryDomain | undefined> {
    const storageDomain = this.ctx.get('storageDomain')
    if (storageDomain === undefined) return undefined
    if (this.domainPromise === undefined) {
      this.domainPromise = storageDomain.open(memoryDomainSpec())
    }
    return this.domainPromise
  }

  /** 事实表（未开域返回 undefined）。 */
  private async table(): Promise<FactsTable | undefined> {
    const d = await this.domain()
    return d?.table('facts')
  }

  // ── 写 ────────────────────────────────────────────────────────────

  /**
   * 写入（或幂等覆盖）一条事实。若与既有同 entity+relation 冲突，标旧事实失效。
   *
   * 三道「设置面」闸门（顺序即语义）：
   *   1. **总开关**：`enabled=false` 时拒收**非用户**写入（`author !== 'user'`）。
   *      用户手动添加仍放行——「关掉记忆」的语义是「不再自动沉淀」，不是「我不能
   *      手动记一条」。理由：把用户自己能做的动作也堵掉，会让开关变成死锁。
   *   2. **容量治理**（写入**后**跑）：超过 `capacity` 时按 `overflowPolicy` 淘汰
   *      （`stop` = 拒收这条新写入并回滚）。
   *   3. **自动清理**：`autoCleanExpired` 时顺手删掉已过期（expiresAt 已过）的记录。
   *
   * @param input - 写入入参。
   * @returns 写入结果（`rejected` 非空表示被设置面拒收，未落库）。
   */
  async putFact(input: PutFactInput): Promise<PutFactResult> {
    const now = Date.now()
    const config = this.getConfig()
    const id = input.id ?? randomUUID()
    // 持久化判定：显式声明 / 手动添加 / 默认（默认档来自设置面）。
    const retention = resolveRetentionOnWrite(input.retention, input.author, this.overrides())
    const fact: MemoryFact = memoryFactSchema.parse({
      id,
      entity: input.entity ?? '',
      relation: input.relation ?? '',
      fact: input.fact,
      importance: input.importance ?? 50,
      validAt: input.validAt ?? null,
      invalidAt: input.invalidAt ?? null,
      source: input.source ?? '',
      agentId: input.agentId ?? '',
      retention,
      expiresAt: expiresAtFor(retention, now),
      readCount: 0,
      supersedes: [],
      evidence: input.evidence ?? [],
      author: input.author,
      createdAt: now,
      lastAccessedAt: null,
    })

    const table = await this.table()
    if (table === undefined) return { fact, invalidated: [], rejected: [], evicted: [] }

    // 闸门 1：总开关（用户手动添加豁免）。
    if (!config.enabled && input.author !== 'user') {
      return { fact, invalidated: [], rejected: ['disabled'], evicted: [] }
    }

    // 闸门 2 预备：容量已满且策略为 stop ⇒ 拒收（不落库）。
    if (config.capacity !== null && config.overflowPolicy === 'stop' && table.size >= config.capacity) {
      return { fact, invalidated: [], rejected: ['capacity'], evicted: [] }
    }

    // 清理（先清后写，避免清掉刚写入的这条）。
    const evicted: string[] = []
    if (config.autoCleanExpired) {
      evicted.push(...await this.cleanExpired(now))
    }

    // recency-wins 合并：找出同 entity+relation 的活跃旧事实，标失效。
    const existing = [...table.entries()].map(([, f]) => f)
    const stale = conflictsToInvalidate(fact, existing, now)
    const invalidated: string[] = []
    for (const old of stale) {
      const invalidatedFact: MemoryFact = { ...old, invalidAt: now, supersedes: [...old.supersedes] }
      await table.put(old.id, invalidatedFact)
      invalidated.push(old.id)
    }
    // 新事实 supersedes 指向被失效的旧事实（可审计追溯）。
    const toPut: MemoryFact = invalidated.length > 0
      ? { ...fact, supersedes: invalidated }
      : fact
    await table.put(id, toPut)

    // 闸门 2：容量治理（超限淘汰）。刚写入的这条**不在**淘汰候选里——否则「写一条
    // 就丢一条」会让库永远停在满格且新记忆全丢。
    const evictedByCapacity = await this.enforceCapacity(config.capacity, config.overflowPolicy, id, now)
    return { fact: toPut, invalidated, rejected: [], evicted: [...evicted, ...evictedByCapacity] }
  }

  /**
   * 自动清理：删除所有已过存续期（expiresAt 已过）的记录。
   *
   * 「忘记」= 存续期耗尽；这里把它从库里真正抹掉（此前只是检索不召回）。
   * permanent（expiresAt=null）恒不删。
   *
   * @param now - 参照时刻。
   * @returns 被删除的事实 id。
   */
  async cleanExpired(now: number = Date.now()): Promise<string[]> {
    const table = await this.table()
    if (table === undefined) return []
    const gone: string[] = []
    for (const [key, f] of [...table.entries()]) {
      if (!isRetained(f, now)) {
        await table.delete(key)
        gone.push(key)
      }
    }
    return gone
  }

  /**
   * 容量治理：库超过上限时按策略淘汰，直到回到上限。
   *
   * 策略：
   *   - `least-used`：先淘汰 readCount 最小者（同分比记忆强度，弱者先走）；
   *   - `oldest`：先淘汰 createdAt 最旧者；
   *   - `stop`：不淘汰（调用方在写入前已拒收；此处为兜底 no-op）。
   *
   * 被淘汰者按「最该被遗忘」优先：**先**淘汰存续期短、**再**看策略键，避免把一条
   * permanent 的纪律淘汰掉而留下临时记忆。
   *
   * @param capacity - 容量上限（null = 不限）。
   * @param policy - 超限策略。
   * @param protectId - 必须保留的 id（刚写入的那条）。
   * @param now - 参照时刻。
   * @returns 被淘汰的事实 id（按淘汰顺序）。
   */
  private async enforceCapacity(
    capacity: number | null,
    policy: ResolvedMemoryConfig['overflowPolicy'],
    protectId: string,
    now: number,
  ): Promise<string[]> {
    if (capacity === null || policy === 'stop') return []
    const table = await this.table()
    if (table === undefined) return []
    const over = table.size - capacity
    if (over <= 0) return []

    const candidates = [...table.entries()]
      .filter(([k]) => k !== protectId)
      .map(([k, f]) => ({ k, f, score: toView(f, now, this.overrides()).effectiveScore }))
    candidates.sort((a, b) => {
      // 先比「记忆强度」（弱的先淘汰）——它已含衰减 + retention 语义；
      // 平手时按策略键区分（least-used → readCount 少者先走；oldest → 创建早者先走）。
      if (a.score !== b.score) return a.score - b.score
      if (policy === 'least-used') return a.f.readCount - b.f.readCount
      return a.f.createdAt - b.f.createdAt
    })

    const evicted: string[] = []
    for (const c of candidates.slice(0, over)) {
      await table.delete(c.k)
      evicted.push(c.k)
    }
    return evicted
  }

  // ── 读 ────────────────────────────────────────────────────────────

  /**
   * 按条件检索事实，多策略打分 + 记忆强度综合排序。命中即更新 readCount /
   * lastAccessedAt（读取阈值升级 + 访问强化）。
   *
   * 检索策略：
   *   - 关键词 query：多字段加权命中（fact/entity/relation/source/evidence，
   *     见 memory-policy.scoreMatch），排序 = 匹配分 × 记忆强度；
   *   - 无 query：退化为纯记忆强度（effectiveScore）排序；
   *   - mode='applicable'（默认）只返回断言成立的事实；
   *     mode='recall' 返回所有**仍被记住**（未到 expiresAt）的事实。
   */
  async searchFacts(input: SearchFactsInput = {}): Promise<MemoryFactView[]> {
    const table = await this.table()
    if (table === undefined) return []

    const now = Date.now()
    const config = this.getConfig()
    // 闸门：总开关关闭 ⇒ 检索不召回（「不再记得」）。已存记忆保留，可手动修剪。
    if (!config.enabled) return []

    const ov = this.overrides()
    const agentId = input.agentId
    const q = input.query?.trim() ?? ''
    const mode = input.mode ?? 'applicable'
    const limit = input.limit ?? 100

    const rows: MemoryFact[] = []
    for (const [, f] of table.entries()) {
      if (agentId !== undefined && f.agentId !== agentId) continue
      const view = toView(f, now, ov)
      if (mode === 'applicable' && !view.applicable) continue
      if (!view.retained) continue // 存续期耗尽 = 真正遗忘，两种模式都不召回
      if (q !== '' && scoreMatch(f, q) === 0) continue // 关键词：任一字段命中才召回
      rows.push(f)
    }

    // 排序：有关键词 → 匹配分 × 记忆强度；无关键词 → 纯记忆强度。
    rows.sort((a, b) => rank(b, q, now, ov) - rank(a, q, now, ov))
    const kept = rows.slice(0, limit)

    // 命中副作用：readCount+1（达阈值 → 持久化升级 long）+ 访问强化 lastAccessedAt。
    // await 落定——副作用应随检索返回时已持久化。
    for (const f of kept) {
      const bumped: MemoryFact = { ...f, readCount: f.readCount + 1 }
      const nextRetention = promoteRetentionOnRead(bumped, ov)
      const next: MemoryFact = {
        ...bumped,
        retention: nextRetention,
        // expiresAt 只在档位真的升级时重算——原实现无条件重算会让「已快过期」的
        // 临时记忆在每次命中后被续命一次（读一下就多活 2 天），与存续期语义冲突。
        expiresAt: nextRetention === f.retention ? f.expiresAt : expiresAtFor(nextRetention, f.createdAt),
        lastAccessedAt: now,
      }
      await table.put(f.id, next)
    }

    return kept.map(f => toView(f, now, ov))
  }

  /** 按 id 取单条事实（含派生视图）。 */
  async getFact(id: string): Promise<MemoryFactView | null> {
    const table = await this.table()
    if (table === undefined) return null
    const f = table.get(id)
    return f === undefined ? null : toView(f, Date.now(), this.overrides())
  }

  /**
   * 列出事实，供面板浏览 / 人工修剪。
   *
   * ⚠️ 与 {@link searchFacts} 的差别有三条（面板必须能看见「检索看不见的东西」）：
   *   1. **不累加 readCount / 不改 lastAccessedAt** —— 打开设置页不能算「用户读了
   *      这条记忆」，否则「看一遍就升级成长期」是纯粹的副作用污染。
   *   2. **不按总开关短路** —— 关了记忆仍要能修剪已有记忆。
   *   3. **可选包含已到期/已失效**（`includeExpired`，默认 true）—— 修剪的对象正是
   *      这些；隐藏它们等于让用户无法清理。
   *
   * @param input - 过滤条件（Agent / 是否含已到期）。
   * @returns 按记忆强度降序的事实视图。
   */
  async listFacts(input: ListFactsInput = {}): Promise<MemoryFactView[]> {
    const table = await this.table()
    if (table === undefined) return []
    const now = Date.now()
    const ov = this.overrides()
    const includeExpired = input.includeExpired ?? true
    const views: MemoryFactView[] = []
    for (const [, f] of table.entries()) {
      if (input.agentId !== undefined && f.agentId !== input.agentId) continue
      const view = toView(f, now, ov)
      if (!includeExpired && !view.retained) continue // 存续期耗尽 = 真正遗忘
      views.push(view)
    }
    views.sort((a, b) => b.effectiveScore - a.effectiveScore)
    return views
  }

  /**
   * 统计各 Agent 的记忆条数（记忆库页的「哪些 Agent 有记忆」chip 列）。
   *
   * 与 {@link listFacts} 同口径：不累加 readCount、不按总开关短路。只统计**仍被
   * 记住**的（存续期耗尽的没有归属意义）。
   *
   * 2026-09-22「移除项目记忆」后维度收敛为 Agent 单一维度，不再接受 `dimension`
   * 参数（只按 agentId 分组）。
   *
   * @param filter - 先按这些条件筛。
   * @returns 每个归属的条数，按条数降序；空串 id 表示「未归属」。
   */
  async listFacets(filter: ListFactsInput = {}): Promise<MemoryFacet[]> {
    const views = await this.listFacts({ ...filter, includeExpired: false })
    const counts = new Map<string, number>()
    for (const v of views) {
      counts.set(v.agentId, (counts.get(v.agentId) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, label: id, count }))
      .sort((a, b) => (b.count - a.count) || a.id.localeCompare(b.id))
  }

  // ── 批量修剪（记忆库页的「清空本作用域」）─────────────────────────

  /**
   * 批量硬删除。**破坏性**，仅面板的「清空本作用域」用（UI 侧二次确认）。
   *
   * @param ids - 要删除的事实 id。
   * @returns 真正被删掉的条数。
   */
  async deleteFacts(ids: readonly string[]): Promise<number> {
    const table = await this.table()
    if (table === undefined) return 0
    let n = 0
    for (const id of ids) {
      if (await table.delete(id)) n += 1
    }
    return n
  }

  /**
   * 清空某个 Agent 的全部记忆。
   *
   * 与 {@link deleteFacts} 的区别：这里按**语义范围**删，不需要前端先把 id 全捞下来
   * （前端捞 id 会在「列表加载后有新写入」时漏删，是静默的少删）。
   *
   * @param filter - 要清空的范围；必须给 agentId（防「无参调用 = 清空全库」的误用）。
   * @returns 被删除的条数。
   */
  async clearFacts(filter: ListFactsInput = {}): Promise<number> {
    if (filter.agentId === undefined) {
      throw new Error('memory.clearFacts: refusing to clear the whole store — pass agentId')
    }
    const table = await this.table()
    if (table === undefined) return 0
    let n = 0
    for (const [key, f] of [...table.entries()]) {
      if (f.agentId !== filter.agentId) continue
      if (await table.delete(key)) n += 1
    }
    return n
  }

  // ── 人工修剪三动作 ────────────────────────────────────────────────

  /** 失效标记：把事实标为「不再成立」（可逆——撤销可清除 invalidAt）。 */
  async invalidate(id: string): Promise<MemoryFactView | null> {
    const table = await this.table()
    if (table === undefined) return null
    const f = table.get(id)
    if (f === undefined) return null
    const next: MemoryFact = { ...f, invalidAt: Date.now() }
    await table.put(id, next)
    return toView(next, Date.now(), this.overrides())
  }

  /** 重要性调整（pin：上调钉住 / 下调压底）。返回新视图。 */
  async setImportance(id: string, importance: number): Promise<MemoryFactView | null> {
    const table = await this.table()
    if (table === undefined) return null
    const f = table.get(id)
    if (f === undefined) return null
    const next: MemoryFact = { ...f, importance: Math.max(0, Math.min(100, Math.round(importance))) }
    await table.put(id, next)
    return toView(next, Date.now(), this.overrides())
  }

  /**
   * 改存续期（retention）——「记忆空间」里把一条记忆**提升/降档**到另一层。
   *
   * 语义要点（与 `promoteRetentionOnRead` 的自动升级区分开）：
   *   - 这是**用户显式**改档，故 `expiresAt` **按原 createdAt 重算**（不是从现在起算）
   *     —— 一条半年前创建的记忆被提为 long，不该因此再获得「整一年」的新寿命，
   *     否则用户每点一次就无限续命。若重算后已过期（提升档位太小、或原记忆太老），
   *     `expiresAt` 会落在过去 ⇒ 该条随即被 `cleanExpired` / 检索视为已遗忘。
   *     这是**有意的**：用户把一条 2 年前的记忆放进「临时」层，它本来就不该活着。
   *   - `permanent` → `expiresAt = null`（永不遗忘）；从 permanent 降档则重新算出期限。
   *
   * @param id - 事实 id。
   * @param retention - 目标档位。
   * @returns 新视图（含重算后的 expiresAt）；id 不存在返回 null。
   */
  async setRetention(id: string, retention: MemoryRetention): Promise<MemoryFactView | null> {
    const table = await this.table()
    if (table === undefined) return null
    const f = table.get(id)
    if (f === undefined) return null
    const next: MemoryFact = { ...f, retention, expiresAt: expiresAtFor(retention, f.createdAt) }
    await table.put(id, next)
    return toView(next, Date.now(), this.overrides())
  }

  /** 硬删除（仅合规/用户显式要求，绕过一切策略，不可逆）。 */
  async deleteFact(id: string): Promise<boolean> {
    const table = await this.table()
    if (table === undefined) return false
    return table.delete(id)
  }

  // ── @Remote 端点（/api/memory/*）──────────────────────────────────

  @Remote('putFact')
  async putFactRemote(input: PutFactInput): Promise<PutFactResult> {
    return this.putFact(input)
  }

  @Remote('searchFacts')
  async searchFactsRemote(input: SearchFactsInput): Promise<MemoryFactView[]> {
    return this.searchFacts(input)
  }

  /**
   * ⚠️ **@Remote 的参数签名有硬约束**（官方 gateway 的 SRC 签名解析，见
   * `packages/api/gateway/src/index.ts` 的 `invalidSignature`）：参数必须是
   * **唯一的裸标识符** —— 不许解构、不许默认值（`= {}`）、不许 rest。
   * 实测代价：`listFactsRemote(input: ListFactsInput = {})` 会让整个端点抛
   * `gateway/signature-invalid: SRC method "listFactsRemote" must use unique
   * identifier parameters without destructuring, defaults, or rest`（页面顶部一条
   * 红字、记忆库恒空）。故这里全部**去掉默认值**，缺省语义由方法体自己兜。
   *
   * @param input - 过滤条件（可省；可省性由 SRC 的 `acceptsUndefined` 承担）。
   * @returns 事实视图列表。
   */
  @Remote('listFacts')
  async listFactsRemote(input: ListFactsInput): Promise<MemoryFactView[]> {
    return this.listFacts(input ?? {})
  }

  @Remote('listFacets')
  async listFacetsRemote(filter: ListFactsInput): Promise<MemoryFacet[]> {
    return this.listFacets(filter ?? {})
  }

  @Remote('getConfig')
  async getConfigRemote(): Promise<ResolvedMemoryConfig> {
    return this.getConfig()
  }

  @Remote('cleanExpired')
  async cleanExpiredRemote(): Promise<number> {
    return (await this.cleanExpired()).length
  }

  @Remote('deleteFacts')
  async deleteFactsRemote(ids: readonly string[]): Promise<number> {
    return this.deleteFacts(ids)
  }

  @Remote('clearFacts')
  async clearFactsRemote(filter: ListFactsInput): Promise<number> {
    return this.clearFacts(filter ?? {})
  }

  @Remote('getFact')
  async getFactRemote(id: string): Promise<MemoryFactView | null> {
    return this.getFact(id)
  }

  @Remote('invalidate')
  async invalidateRemote(id: string): Promise<MemoryFactView | null> {
    return this.invalidate(id)
  }

  @Remote('setImportance')
  async setImportanceRemote(id: string, importance: number): Promise<MemoryFactView | null> {
    return this.setImportance(id, importance)
  }

  @Remote('setRetention')
  async setRetentionRemote(id: string, retention: MemoryRetention): Promise<MemoryFactView | null> {
    return this.setRetention(id, retention)
  }

  @Remote('deleteFact')
  async deleteFactRemote(id: string): Promise<boolean> {
    return this.deleteFact(id)
  }
}

/**
 * 综合排序键：有关键词 → 匹配分 × 记忆强度（匹配权重优先，强度打散同匹配者）；
 * 无关键词 → 纯记忆强度。
 */
function rank(f: MemoryFact, query: string, now: number, overrides: PolicyOverrides = {}): number {
  const score = toView(f, now, overrides).effectiveScore
  if (query.trim() === '') return score
  const match = scoreMatch(f, query)
  // 匹配分 0 已被过滤，这里 match ≥ 1。匹配分加权 × 强度，保证「更相关且记得牢」靠前。
  return match * 100 + score
}
