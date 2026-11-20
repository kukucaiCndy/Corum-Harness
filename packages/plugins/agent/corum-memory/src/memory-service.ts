/**
 * MemoryService —— corum 记忆底座 host 服务。
 *
 * 职责（只承载「组织形式」，不绑定记忆来源）：
 *   - 事实级存储：单域 corum_memory、单表 facts，key = factId。
 *   - 写入：重要性写入门槛 + 同 entity+relation 的 recency-wins 合并（标失效不删）
 *     + 容量治理（超限淘汰）+ 自动清理已过期。
 *     非法输入 → rejected invalid:<field>（不抛到 gateway）；存储不可用 → rejected unavailable。
 *   - 批量写入（putFacts）：逐项独立走 putFact 语义，非原子事务，部分拒收不中断后续。
 *   - 检索：按 agentId/来源/source 等值过滤 + 关键词匹配，按读时降权 effectiveScore 排序；
 *     命中即更新 lastAccessedAt（访问强化）。
 *     agentId===undefined 时排除未归属事实（检索只看有归属的 Agent 记忆）。
 *   - 人工修剪：失效标记（invalidate，可逆）/ 重要性调整（pin）/ 硬删除
 *     （delete，仅合规/用户显式要求，绕过策略）/ 按来源删除（deleteBySource）。
 *   - 模型工具安全读取：getFactForAgent(id, agentId) —— 模型工具的安全边界，
 *     仅返回归属匹配且总开关开启时的记录。
 *
 * **可配置面**（settings namespace `corum-memory-settings`，见 memory-config.ts）：
 * 总开关、存续期默认档、读取升级阈值、衰减强度、容量与超限策略、自动清理、
 * 注入策略（注入**未生效**——底座尚无注入机制）。配置**不缓存**：每次策略调用
 * 从 settings 的 describe() 重新合成（单一真源，运行期改设置即刻生效），
 * 不用模块级可变单例（红线 1），也不用服务实例上的长期缓存。
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
import { ZodError } from 'zod'

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

/** 写入一条事实的入参（author 由调用方显式声明，不猜；agentId 可选，空串 = 未归属）。 */
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
  /**
   * 归属 Agent（profile id）。**可选**：不传 = 未归属持久化（空串）；传真实 agentId =
   * 该 Agent 的记忆。检索时 agentId===undefined 排除未归属事实，显式 '' 可查未归属。
   */
  agentId?: string
  /**
   * 显式声明的存续期。缺省按「持久化判定」推导：
   *   - 'permanent'：用户明确要求的纪律 / 可判定永久的事实来源；
   *   - 未声明且 author='user'：手动添加 → long；
   *   - 其余 → temporary。
   */
  retention?: MemoryRetention
  evidence?: string[]
  /**
   * 写入者。'user' = 手动添加（持久化判定规则 3 → long）；'system' / 'agent:<sessionId>'
   * = 自动沉淀。本字段是调用方显式声明的写入来源，不是归属——归属由 {@link agentId} 决定。
   */
  author: string
}

/** 检索过滤条件。 */
export interface SearchFactsInput {
  /**
   * 归属 Agent 过滤：
   *   - `undefined`：不按 Agent 过滤，但**排除未归属事实**（`agentId===''`）——检索应只看
   *     有归属的 Agent 记忆，未归属的「系统/顶层」事实不参与 Agent 驱动的检索。
   *   - 真实 agentId：只查该 Agent 的记忆。
   *   - 显式 `''`：供管理/审计查询未归属事实。
   */
  agentId?: string
  /** 关键词（在 fact/entity/relation/source/evidence 上做子串匹配，大小写不敏感）。 */
  query?: string
  /** 来源精确等值过滤（区分于 query 关键词：只匹配 source 字段全等）。`undefined` 不过滤，`''` 只匹配 source 为空串的事实。 */
  source?: string
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
  /** Agent 过滤（空/缺省 = 不按 Agent 过滤；显式 `''` = 查未归属）。 */
  agentId?: string
  /** 来源精确等值过滤（`undefined` 不过滤，`''` 只匹配 source 为空串）。 */
  source?: string
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

/** 拒收码：`disabled`（总开关关闭）/ `capacity`（满且策略为停止沉淀）/ `unavailable`（存储域不可用）/ `invalid:<field>`（字段校验失败，`<field>` = zod issue path 首段）。 */
export type PutFactRejectedCode = 'disabled' | 'capacity' | 'unavailable' | `invalid:${string}`

/** 写入结果。 */
export interface PutFactResult {
  /** 构造出的事实（合法、未经 trim 改写的调用输入形态；rejected 非空时表示未落库）。 */
  fact: MemoryFact
  /** 本次写入因 recency-wins 而被标记失效的旧事实 id。 */
  invalidated: string[]
  /** 被设置面/校验拒收的原因（空 = 已落库）。 */
  rejected: PutFactRejectedCode[]
  /** 本次写入因容量超限被淘汰的事实 id。 */
  evictedByCapacity: string[]
  /** 本次写入顺带清理掉的已过期事实 id（autoCleanExpired 触发）。 */
  cleanedExpired: string[]
}

export class MemoryService extends TypertRemoteService {
  /** 打开后的域（懒开 + 缓存）。storageDomain 缺失时（单测/未装配）为 undefined。 */
  private domainPromise: Promise<MemoryDomain> | undefined

  /**
   * 写操作串行队列（服务实例私有，非模块级 / 非窗口共享——红线 1）。
   *
   * 记忆底座有多步读-改-写序列（putFact 的全表快照→逐条失效→写新→容量淘汰；
   * searchFacts 命中 readCount/lastAccessedAt/retention 写回；cleanExpired 全表
   * 扫删）。在同一服务实例上，这些序列若交错执行会出现读-改-写竞争：A 读快照
   * → B 写新 → A 基于过期快照覆盖。本队列把所有写操作串成一条 Promise 链，保证
   * 同一时刻只有一个写序列在跑。
   *
   * 设计要点：
   *   - **只串写操作**：纯读（getFact / listFacts / listFacets / getConfig）不走
   *     队列，不受写阻塞。
   *   - **无嵌套同锁**：内部 unlocked helper（putFactUnlocked / cleanExpiredUnlocked
   *     / enforceCapacity）不重新排队，putFactUnlocked 直接调 cleanExpiredUnlocked
   *     而非公共 cleanExpired，避免同锁重入死锁。
   *   - **reject 后恢复**：链条用 `.then(fn, fn)` 链接而非 `.catch` 吞错——某个写
   *     reject 后链条立即恢复为 resolved，后续写仍可执行。错误正常向调用方传播。
   *   - **不宣称跨进程事务**：这是同服务实例内的 JS 异步串行化，不是 SQLite 跨
   *     进程事务。
   */
  private writeTail: Promise<void> = Promise.resolve()

  /**
   * 把一个写操作排入串行队列并返回其结果（或错误）。
   *
   * @param fn - 写操作（async，返回 T）。在队列内执行，保证与前一个写不交错。
   * @returns fn 的返回值（或 reject 的错误），原样传播给调用方。
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => fn()
    // 链条：前一个写 resolved/rejected 后都进入本次写。
    // 用本地变量捕获当前 tail，避免在 fn 执行期间 tail 已被下一个 enqueue 更新。
    const prev = this.writeTail
    const next: Promise<T> = prev.then(run, run)
    // 更新 tail 为「本次写完成」（不携带值，只关注 settled 状态）。
    this.writeTail = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * 当前生效配置（settings 面 resolved 值 + 内置默认合成）。
   *
   * ⚠️ **不缓存**（2026-11-16 修复）：原先 `configCache` 在构造期 adopt 一次后
   * 永不失效，导致运行期改设置不生效，且总开关对写入/读取双向 fail-open。
   * 现改为每次 `getConfig()` 都从 settings 的 describe() 重新合成 —— describe
   * 是内存态数组查找，成本极低，换来「设置面永远是单一真源」。
   * 不用模块级单例（红线 1）。
   */

  constructor(ctx: Context) {
    super(ctx, 'memory')
    // 域懒开：storageDomain 由官方插件提供，装配顺序上它先于本服务（见挂载注释）。
    // 首次真正读写时才 open，避免冷启动就开域（无记忆也零开销）。
    this.domainPromise = undefined
    // settings 面在 boot 早期可能尚未挂载：确认一次它可用（拿不到就轮询，超时放弃，
    // 不阻断启动——getConfig 每次仍会重读，未挂载时回落内置默认）。
    this.bindSettings()
    // 配置正确性由「getConfig 每次重读 describe()」保证，不依赖事件订阅：
    // 本包不带 `settings/document-updated` 的 Events 类型面（那是 corum-api-remotes
    // 的声明），为订阅它去耦合那个包不值当（红线 3）。若将来重新引入缓存，
    // 必须同时补上失效钩子——届时再按同仓 corum-review / corum-agent 的形态引入。
    this.ctx.effect(() => () => {
      if (this.domainPromise !== undefined) {
        void this.domainPromise.then(d => d.close(), () => {})
      }
    }, 'memory.domainClose')
  }

  /**
   * 确认 settings 面已挂载（短轮询同款，见 corum-agent / corum-subagent-settings）。
   *
   * 这里**不写配置缓存**：配置由 {@link getConfig} 每次从 describe() 重读。
   * 轮询只用于「boot 早期 settings 尚未 provide」时让首次读取不落到内置默认
   * （超时放弃不阻断启动，getConfig 仍可在 settings 出现后读到真值）。
   */
  private bindSettings(): void {
    const mounted = (): boolean => {
      const settings = this.ctx.get('settings') as
        | { describe?: (options?: unknown) => readonly { ns: string, value?: unknown }[] }
        | undefined
      if (settings === undefined) return false
      return acquireMemorySettingsScope(settings) !== undefined
    }
    if (mounted()) return
    const poll = setInterval(() => {
      try { if (mounted()) clearInterval(poll) } catch { /* 继续轮询 */ }
    }, 100)
    setTimeout(() => clearInterval(poll), 15000)
  }

  /**
   * 读当前配置（**每次重新合成，不缓存**）。
   *
   * settings 面未挂载 / describe 里没有本 ns 时回落内置默认。这样运行期任何一次
   * 设置写入都会在下一次 `putFact` / `searchFacts` 被读到，总开关的「拒绝非用户
   * 写入」与「检索不召回」两道闸门都跟随真值。
   *
   * @returns 已解析配置（每键有值）。
   */
  getConfig(): ResolvedMemoryConfig {
    const settings = this.ctx.get('settings') as
      | { describe?: (options?: unknown) => readonly { ns: string, value?: unknown }[] }
      | undefined
    if (settings !== undefined) {
      const scope = acquireMemorySettingsScope(settings)
      if (scope !== undefined) return resolveMemoryConfig(scope.get())
    }
    return resolveMemoryConfig(undefined)
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
   * 写入（或幂等覆盖）一条事实。若与既有同 agentId + 同 entity+relation + 同 fact
   * 文本的事实冲突，标旧事实失效（同 id 自身排除）。
   *
   * 三道「设置面」闸门（顺序即语义）：
   *   1. **总开关**：`enabled=false` 时拒收**非用户**写入（`author !== 'user'`）。
   *      用户手动添加仍放行——「关掉记忆」的语义是「不再自动沉淀」，不是「我不能
   *      手动记一条」。理由：把用户自己能做的动作也堵掉，会让开关变成死锁。
   *   2. **容量治理**（写入**后**跑）：超过 `capacity` 时按 `overflowPolicy` 淘汰
   *      （`stop` = 拒收这条新写入并回滚）。
   *   3. **自动清理**：`autoCleanExpired` 时顺手删掉已过期（expiresAt 已过）的记录。
   *
   * **校验顺序**：先构造 + zod 校验 fact（非法输入 → `rejected: ['invalid:<field>']`，
   * 不抛到 gateway），**再**查 storage table（不可用 → `rejected: ['unavailable']`）。
   * 这样非法 input 不会被误报为 unavailable。
   *
   * 整个写入序列（清理→冲突失效→写新→容量淘汰）在**写串行队列**内执行，保证
   * 多步读-改-写不与并发写交错。内部调用 `cleanExpiredUnlocked`（不重新排队），
   * 避免同锁重入死锁。
   *
   * @param input - 写入入参。
   * @returns 写入结果（`rejected` 非空表示被拒收，未落库）。
   */
  async putFact(input: PutFactInput): Promise<PutFactResult> {
    return this.enqueue(() => this.putFactUnlocked(input))
  }

  /**
   * putFact 的 unlocked 实现（队列内执行，不重新排队）。
   *
   * ⚠️ 只能从 {@link putFact}（经队列）或同锁内的其他 unlocked helper 调用，
   * 不可直接从外部调用——绕过队列会失去串行保证。
   */
  private async putFactUnlocked(input: PutFactInput): Promise<PutFactResult> {
    const now = Date.now()
    const config = this.getConfig()
    const id = input.id ?? randomUUID()
    // 持久化判定：显式声明 / 手动添加 / 默认（默认档来自设置面）。
    const retention = resolveRetentionOnWrite(input.retention, input.author, this.overrides())

    // 构造 + zod 校验 fact。非法输入 → rejected invalid:<field>（不抛到 gateway）。
    let fact: MemoryFact
    try {
      fact = memoryFactSchema.parse({
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
    } catch (e) {
      if (e instanceof ZodError) {
        // 取 issues path 首段，去重、稳定返回 rejected invalid:<field>；无 path 用 invalid:input。
        const fields = new Set<string>()
        for (const issue of e.issues) {
          const seg = issue.path[0]
          fields.add(typeof seg === 'string' ? seg : 'input')
        }
        const field = fields.size === 0 ? 'input' : [...fields].sort().join(',')
        // fact 字段仍需返回一个 MemoryFact 形态（接口要求），但 rejected 非空表示未落库。
        // 用尽力构造的值（非法字段用默认值兜底），不声称已落库。
        const placeholder: MemoryFact = {
          id,
          entity: input.entity ?? '',
          relation: input.relation ?? '',
          fact: typeof input.fact === 'string' && input.fact.length > 0 ? input.fact : '',
          importance: typeof input.importance === 'number' ? Math.max(0, Math.min(100, Math.round(input.importance))) : 50,
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
        }
        return { fact: placeholder, invalidated: [], rejected: [`invalid:${field}`], evictedByCapacity: [], cleanedExpired: [] }
      }
      throw e
    }

    // 不可用 → rejected unavailable（绝不空 rejected 假成功）。
    const table = await this.table()
    if (table === undefined) {
      return { fact, invalidated: [], rejected: ['unavailable'], evictedByCapacity: [], cleanedExpired: [] }
    }

    // 闸门 1：总开关（用户手动添加豁免）。
    if (!config.enabled && input.author !== 'user') {
      return { fact, invalidated: [], rejected: ['disabled'], evictedByCapacity: [], cleanedExpired: [] }
    }

    // 闸门 2 预备：容量已满且策略为 stop ⇒ 拒收（不落库）。
    if (config.capacity !== null && config.overflowPolicy === 'stop' && table.size >= config.capacity) {
      return { fact, invalidated: [], rejected: ['capacity'], evictedByCapacity: [], cleanedExpired: [] }
    }

    // 清理（先清后写，避免清掉刚写入的这条）。调 unlocked 版本——不重新排队。
    const cleanedExpired: string[] = []
    if (config.autoCleanExpired) {
      cleanedExpired.push(...await this.cleanExpiredUnlocked(now))
    }

    // recency-wins 合并：找出同 agentId + 同 entity+relation + 同 fact 文本的活跃
    // 旧事实，标失效（同 id 自身排除，幂等重写不失效自己）。
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
    return { fact: toPut, invalidated, rejected: [], evictedByCapacity, cleanedExpired }
  }

  /**
   * 自动清理：删除所有已过存续期（expiresAt 已过）的记录。
   *
   * 「忘记」= 存续期耗尽；这里把它从库里真正抹掉（此前只是检索不召回）。
   * permanent（expiresAt=null）恒不删。
   *
   * 写操作——走串行队列。`putFactUnlocked` 内部调 {@link cleanExpiredUnlocked}
   * 而非本方法，避免同锁重入。
   *
   * @param now - 参照时刻。
   * @returns 被删除的事实 id。
   */
  async cleanExpired(now: number = Date.now()): Promise<string[]> {
    return this.enqueue(() => this.cleanExpiredUnlocked(now))
  }

  /**
   * cleanExpired 的 unlocked 实现（队列内执行，不重新排队）。
   * ⚠️ 只能从 {@link cleanExpired}（经队列）或 {@link putFactUnlocked} 内部调用。
   */
  private async cleanExpiredUnlocked(now: number): Promise<string[]> {
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
   *
   * **命中写回与串行队列**：整个检索 + 命中写回（readCount/lastAccessedAt/retention）
   * 收进写串行队列执行——这样命中写回不会用过期快照覆盖并发写入后的新记录，也
   * 不会与其他写序列交错。返回语义不变：命中副作用在返回时已持久化。
   */
  async searchFacts(input: SearchFactsInput = {}): Promise<MemoryFactView[]> {
    return this.enqueue(() => this.searchFactsUnlocked(input))
  }

  /**
   * searchFacts 的 unlocked 实现（队列内执行，不重新排队）。
   * ⚠️ 只能从 {@link searchFacts}（经队列）调用。
   */
  private async searchFactsUnlocked(input: SearchFactsInput = {}): Promise<MemoryFactView[]> {
    const table = await this.table()
    if (table === undefined) return []

    const now = Date.now()
    const config = this.getConfig()
    // 闸门：总开关关闭 ⇒ 检索不召回（「不再记得」）。已存记忆保留，可手动修剪。
    if (!config.enabled) return []

    const ov = this.overrides()
    const agentId = input.agentId
    const source = input.source
    const q = input.query?.trim() ?? ''
    const mode = input.mode ?? 'applicable'
    const limit = input.limit ?? 100

    const rows: MemoryFact[] = []
    for (const [, f] of table.entries()) {
      // #6 agentId 可见性收紧：
      //   - undefined：排除未归属（agentId===''）——检索只看有归属的 Agent 记忆。
      //   - 真实 agentId：只查该 Agent。
      //   - 显式 ''：供管理/审计查询未归属事实。
      if (agentId === undefined) {
        if (f.agentId === '') continue
      } else if (f.agentId !== agentId) continue
      // source 精确等值过滤（undefined 不过滤，'' 只匹配空串）。
      if (source !== undefined && f.source !== source) continue
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
    // 在队列内执行：不会用过期快照覆盖并发写入后的新记录。
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
   * **模型工具安全读取**：按 id 取单条事实，但强制归属过滤——仅返回
   * `f.agentId === agentId`（非空）的记录，否则 null。
   *
   * 这是模型工具（`memory` 工具的 `get` action）的安全边界：模型只能读到
   * **自己的**记忆，不能通过 id 越权读取其他 Agent 的记忆或未归属事实。
   *
   * 总开关 `enabled=false` 时该面也返回 null（与 {@link searchFacts} 的
   * 读侧闸门一致——关了记忆 = 不再召回）。
   *
   * 与 {@link getFact}（管理面）的区别：
   *   - `getFact` 不做归属过滤、不按总开关短路——管理面要能看见并修剪所有记忆。
   *   - `getFactForAgent` 做归属过滤 + 总开关短路——模型工具的安全边界。
   *
   * @param id - 事实 id。
   * @param agentId - 归属 Agent（必须非空；空串 = 未归属，返回 null）。
   * @returns 归属匹配且开关开启时的事实视图；否则 null。
   */
  async getFactForAgent(id: string, agentId: string): Promise<MemoryFactView | null> {
    if (agentId === '') return null
    const config = this.getConfig()
    if (!config.enabled) return null
    const table = await this.table()
    if (table === undefined) return null
    const f = table.get(id)
    if (f === undefined) return null
    if (f.agentId !== agentId) return null
    return toView(f, Date.now(), this.overrides())
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
   * @param input - 过滤条件（Agent / 来源 / 是否含已到期）。
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
      if (input.source !== undefined && f.source !== input.source) continue
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
   * 写操作——走串行队列。
   *
   * @param ids - 要删除的事实 id。
   * @returns 真正被删掉的条数。
   */
  async deleteFacts(ids: readonly string[]): Promise<number> {
    return this.enqueue(async () => {
      const table = await this.table()
      if (table === undefined) return 0
      let n = 0
      for (const id of ids) {
        if (await table.delete(id)) n += 1
      }
      return n
    })
  }

  /**
   * 清空某个 Agent 的全部记忆。
   *
   * 与 {@link deleteFacts} 的区别：这里按**语义范围**删，不需要前端先把 id 全捞下来
   * （前端捞 id 会在「列表加载后有新写入」时漏删，是静默的少删）。
   *
   * 写操作——走串行队列。
   *
   * @param filter - 要清空的范围；必须给 agentId（防「无参调用 = 清空全库」的误用）。
   * @returns 被删除的条数。
   */
  async clearFacts(filter: ListFactsInput = {}): Promise<number> {
    if (filter.agentId === undefined) {
      throw new Error('memory.clearFacts: refusing to clear the whole store — pass agentId')
    }
    return this.enqueue(async () => {
      const table = await this.table()
      if (table === undefined) return 0
      let n = 0
      for (const [key, f] of [...table.entries()]) {
        if (f.agentId !== filter.agentId) continue
        if (await table.delete(key)) n += 1
      }
      return n
    })
  }

  // ── 人工修剪三动作 ────────────────────────────────────────────────

  /** 失效标记：把事实标为「不再成立」（可逆——撤销可清除 invalidAt）。写操作——走串行队列。 */
  async invalidate(id: string): Promise<MemoryFactView | null> {
    return this.enqueue(async () => {
      const table = await this.table()
      if (table === undefined) return null
      const f = table.get(id)
      if (f === undefined) return null
      const next: MemoryFact = { ...f, invalidAt: Date.now() }
      await table.put(id, next)
      return toView(next, Date.now(), this.overrides())
    })
  }

  /** 重要性调整（pin：上调钉住 / 下调压底）。返回新视图。写操作——走串行队列。 */
  async setImportance(id: string, importance: number): Promise<MemoryFactView | null> {
    return this.enqueue(async () => {
      const table = await this.table()
      if (table === undefined) return null
      const f = table.get(id)
      if (f === undefined) return null
      const next: MemoryFact = { ...f, importance: Math.max(0, Math.min(100, Math.round(importance))) }
      await table.put(id, next)
      return toView(next, Date.now(), this.overrides())
    })
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
    return this.enqueue(async () => {
      const table = await this.table()
      if (table === undefined) return null
      const f = table.get(id)
      if (f === undefined) return null
      const next: MemoryFact = { ...f, retention, expiresAt: expiresAtFor(retention, f.createdAt) }
      await table.put(id, next)
      return toView(next, Date.now(), this.overrides())
    })
  }

  /** 硬删除（仅合规/用户显式要求，绕过一切策略，不可逆）。写操作——走串行队列。 */
  async deleteFact(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const table = await this.table()
      if (table === undefined) return false
      return table.delete(id)
    })
  }

  // ── 按来源删除 / 批量写入 ─────────────────────────────────────────

  /**
   * 按 source 等值删除事实。**破坏性**——用于清理某个来源的全部记忆。
   *
   * 写操作——走串行队列（第一批 enqueue 串行队列，不可复用需要全表 id 拉取的 UI 路径）。
   *
   * @param source - 必须非空（防无来源清库的误用）。
   * @param agentId - 可选：限定只删该 Agent 的事实（包括显式 `''` = 未归属）。
   * @returns 被删除的条数。
   */
  async deleteBySource(source: string, agentId?: string): Promise<number> {
    if (source === '') {
      throw new Error('memory.deleteBySource: source must be non-empty')
    }
    return this.enqueue(async () => {
      const table = await this.table()
      if (table === undefined) return 0
      let n = 0
      for (const [key, f] of [...table.entries()]) {
        if (f.source !== source) continue
        if (agentId !== undefined && f.agentId !== agentId) continue
        if (await table.delete(key)) n += 1
      }
      return n
    })
  }

  /**
   * 批量写入事实。返回 `PutFactResult[]`，长度/顺序对应输入。
   *
   * 每项独立走 {@link putFactUnlocked} 语义（**非原子事务**）：逐项 reject 以结果表示、
   * 不中断后续项。可在**同一个 enqueue 内**依次调用 `putFactUnlocked`，避免重复排队。
   * 空数组安全返回 `[]`。
   *
   * @param inputs - 写入入参数组。
   * @returns 与输入等长、同序的写入结果数组。
   */
  async putFacts(inputs: readonly PutFactInput[]): Promise<PutFactResult[]> {
    if (inputs.length === 0) return []
    return this.enqueue(async () => {
      const results: PutFactResult[] = []
      for (const input of inputs) {
        results.push(await this.putFactUnlocked(input))
      }
      return results
    })
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

  @Remote('putFacts')
  async putFactsRemote(input: readonly PutFactInput[]): Promise<PutFactResult[]> {
    return this.putFacts(input)
  }

  @Remote('deleteBySource')
  async deleteBySourceRemote(source: string, agentId?: string): Promise<number> {
    return this.deleteBySource(source, agentId)
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
