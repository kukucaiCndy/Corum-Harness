/**
 * corum 记忆底座 —— 纯函数层：存续期 + 衰减（读时降权）+ 适用/留存判定 + 合并。
 *
 * 全部无状态纯函数，不落库、无后台任务、可单测。
 *
 * **两个正交的「时间」概念（避免「到期 = 忘记」的老错）**：
 *   - **断言窗口**（validAt → invalidAt）：事实**内容**何时为真 → 决定 `applicable`。
 *     断言过期只表示「不再适用/不再驱动行为」，**不影响留存**。
 *   - **存续期**（retention → expiresAt）：记忆**本身**存多久 → 决定 `retained`。
 *     到 expiresAt 记忆被遗忘；permanent 永不遗忘。
 *
 * 例：用户要求「10月31日前每天提醒日程」——11/1 后断言过期（applicable=false，
 * 不再提醒），但记忆本身仍在（retained=true，取决于 retention 档），可被 recall 召回。
 *
 * **存续期四档与 TTL / 衰减半衰期（用户 2026-09 拍板）**：
 *   | retention  | 语义           | TTL（expiresAt 起算） | 衰减半衰期 |
 *   | temporary  | 临时（1~3 天）  | 2 天                  | 半天        |
 *   | short      | 短期（3 个月）  | 3 个月               | 30 天       |
 *   | long       | 长期（半年以上）| 1 年                  | 半年        |
 *   | permanent  | 永久            | 永不（null）          | 1 年（微衰）|
 *
 * **持久化判定（4 规则）**：
 *   1. 用户明确要求的纪律 → permanent（写入方显式 retention='permanent'）；
 *   2. 可判定永久的事实来源 → permanent（同上）；
 *   3. 用户手动添加（author='user'）→ long；
 *   4. 多次读取到阈值（readCount ≥ READ_PROMOTE_THRESHOLD）→ long（读时升级）。
 *
 * @module @corum/corum-memory/memory-policy
 */

import type { MemoryFact, MemoryFactView, MemoryRetention } from './memory-entities.ts'
import { DECAY_STRENGTH_MULTIPLIER, MEMORY_CONFIG_DEFAULTS } from './memory-config.ts'
import type { DecayStrength } from './memory-config.ts'

/** 读取阈值：readCount 达到该值 → 持久化升级到 long（= 设置面默认档）。 */
export const READ_PROMOTE_THRESHOLD = MEMORY_CONFIG_DEFAULTS.readPromoteThreshold

/**
 * 策略覆盖面（设置中心三个参数的注入点）。
 *
 * 为什么是「可选参数」而不是「模块级可变单例」：红线 1 —— 跨 bundle 的模块级状态
 * 会被复制成多份。这里全部走**显式传参**：服务持有 resolved config，每次调用时
 * 传入。纯函数保持纯净，单测可任意组合；未传时回落到内置默认（老调用点零破坏）。
 */
export interface PolicyOverrides {
  /** 写入时未声明存续期的回落档（默认 temporary）。 */
  readonly defaultRetention?: MemoryRetention
  /** 读取升级阈值（默认 {@link READ_PROMOTE_THRESHOLD}）。 */
  readonly readPromoteThreshold?: number
  /** 衰减强度档（默认 standard，倍率 1）。 */
  readonly decayStrength?: DecayStrength
}

/** 各存续期的 TTL（毫秒；expiresAt = createdAt + TTL）。permanent 永不 expire。 */
export const RETENTION_TTL_MS: Record<MemoryRetention, number | null> = {
  temporary: 2 * 24 * 60 * 60 * 1000, // 2 天
  short: 3 * 30 * 24 * 60 * 60 * 1000, // 3 个月（约 90 天）
  long: 365 * 24 * 60 * 60 * 1000, // 1 年
  permanent: null, // 永不
}

/** 各存续期的衰减半衰期（毫秒）。permanent 微衰（1 年）。 */
export const RETENTION_HALF_LIFE_MS: Record<MemoryRetention, number> = {
  temporary: 0.5 * 24 * 60 * 60 * 1000, // 半天
  short: 30 * 24 * 60 * 60 * 1000, // 30 天
  long: 180 * 24 * 60 * 60 * 1000, // 半年
  permanent: 365 * 24 * 60 * 60 * 1000, // 1 年（微衰）
}

/** 访问强化窗口：lastAccessedAt 在此窗口内时，衰减放缓（半衰期 ×2）。 */
export const ACCESS_BOOST_WINDOW_MS = 24 * 60 * 60 * 1000 // 1 天

/**
 * 由存续期计算 expiresAt（记忆消亡时刻）。
 * permanent → null（永不）；其余 → createdAt + 该档 TTL。
 */
export function expiresAtFor(retention: MemoryRetention, createdAt: number): number | null {
  const ttl = RETENTION_TTL_MS[retention]
  return ttl === null ? null : createdAt + ttl
}

/**
 * 持久化判定（写入时）：由 author / retention 显式声明推导最终 retention。
 *
 * 规则（用户拍板）：
 *   1. 显式声明 permanent（纪律 / 永久事实源）→ permanent（写方已声明）；
 *   2. author='user'（手动添加）→ 至少 long；
 *   3. 其余 → 保持写方声明的 retention（缺省取 `overrides.defaultRetention`，
 *      再退到内置 `temporary`）。
 *
 * @param requested - 写方显式声明的存续期（undefined = 未声明）。
 * @param author - 写入者（`'user'` = 手动添加）。
 * @param overrides - 设置面覆盖（「存续期默认档」）。
 * @returns 最终存续期。
 */
export function resolveRetentionOnWrite(
  requested: MemoryRetention | undefined,
  author: string,
  overrides: PolicyOverrides = {},
): MemoryRetention {
  if (requested === 'permanent') return 'permanent'
  if (requested === 'long') return 'long'
  if (author === 'user') return 'long' // 手动添加 → long
  return requested ?? overrides.defaultRetention ?? 'temporary'
}

/**
 * 持久化升级（读时）：readCount 达到阈值 → 至少 long。
 * 永久（permanent）不降级；long/permanent 之外才升级。
 *
 * @param fact - 当前事实。
 * @param overrides - 设置面覆盖（「读取升级阈值」）。
 * @returns 升级后的存续期。
 */
export function promoteRetentionOnRead(fact: MemoryFact, overrides: PolicyOverrides = {}): MemoryRetention {
  if (fact.retention === 'permanent' || fact.retention === 'long') return fact.retention
  const threshold = overrides.readPromoteThreshold ?? READ_PROMOTE_THRESHOLD
  if (fact.readCount >= threshold) return 'long'
  return fact.retention
}

/**
 * 当前是否「适用/成立」（断言窗口 validAt→invalidAt）。
 * 与「是否还被记住」（retained）无关。
 */
export function isApplicable(fact: MemoryFact, now: number = Date.now()): boolean {
  const born = fact.validAt === null || fact.validAt <= now
  const alive = fact.invalidAt === null || now < fact.invalidAt
  return born && alive
}

/**
 * 是否还被记住：now < expiresAt。permanent（expiresAt=null）恒真。
 * 忘记 = 到 expiresAt（存续期耗尽）或显式删除。
 */
export function isRetained(fact: MemoryFact, now: number = Date.now()): boolean {
  if (fact.expiresAt === null) return true
  return now < fact.expiresAt
}

/**
 * 读时降权后的记忆强度（0-100），**不因断言到期归零**。
 *
 * 指数衰减：score = importance × 0.5^(age / halfLife)。
 *   - 半衰期由 retention 决定（临时快衰、永久微衰），再乘「衰减强度」档位倍率
 *     （快 0.5× ⇒ 衰得更快、更偏「近的优先」；慢 2× ⇒ 更偏「重要的优先」）。
 *   - age 由 validAt（缺省 createdAt）起算。
 *   - 访问强化：lastAccessedAt 在窗口内则半衰期翻倍。
 *   - 记忆被遗忘（expiresAt 已过）→ 0（真正不参与排序）。
 *
 * @param fact - 事实记录。
 * @param now - 参照时刻（默认 Date.now()）。
 * @param overrides - 设置面覆盖（「衰减强度」）。
 * @returns 记忆强度（两位小数）。
 */
export function effectiveScoreFor(
  fact: MemoryFact,
  now: number = Date.now(),
  overrides: PolicyOverrides = {},
): number {
  if (!isRetained(fact, now)) return 0
  const baseHalfLife = RETENTION_HALF_LIFE_MS[fact.retention]
  const halfLife = baseHalfLife * DECAY_STRENGTH_MULTIPLIER[overrides.decayStrength ?? 'standard']
  const born = fact.validAt ?? fact.createdAt
  const age = Math.max(0, now - born)

  let effectiveHalfLife = halfLife
  if (fact.lastAccessedAt !== null && now - fact.lastAccessedAt <= ACCESS_BOOST_WINDOW_MS) {
    effectiveHalfLife = halfLife * 2
  }

  const score = fact.importance * Math.pow(0.5, age / effectiveHalfLife)
  return Math.round(score * 100) / 100
}

/**
 * 合并成派生视图。
 *
 * @param fact - 事实记录。
 * @param now - 参照时刻（默认 Date.now()）。
 * @param overrides - 设置面覆盖（「衰减强度」）。
 * @returns 派生视图（含 effectiveScore / applicable / retained）。
 */
export function toView(
  fact: MemoryFact,
  now: number = Date.now(),
  overrides: PolicyOverrides = {},
): MemoryFactView {
  return {
    ...fact,
    effectiveScore: effectiveScoreFor(fact, now, overrides),
    applicable: isApplicable(fact, now),
    retained: isRetained(fact, now),
  }
}

/**
 * 合并裁决（recency-wins with explicit invalidation）：写入新事实时，若它与
 * 某条已存在的**同 Agent、同 entity + 同 relation、且 fact 文本相同**且当前适用
 * 的事实冲突，旧事实应被标 invalidAt（失效），并把新事实的 supersedes 指向旧事实
 * id——不物理删除。
 *
 * 冲突域（2026-11 评审定稿，候选 A）= **同 agentId + 同 entity + 同 relation +
 * fact 文本相同 + 当前 applicable**，且排除 incoming 自身（同 id 幂等重写不失效自己）。
 *   - **同 agentId**：记忆归属 Agent，跨 Agent 不互相失效（Agent-A 的「stack uses
 *     MySQL」不能覆盖 Agent-B 的「stack uses MySQL」——可能是两个 Agent 的不同经验）。
 *   - **fact 文本相同**：同 Agent 同 entity+relation 但**不同事实文本**视为两条并存
 *     记忆（「stack uses Postgres」与「stack uses MySQL」可能是先后认知或并存事实），
 *     不做 recency-wins 失效。
 *   - **排除 incoming 自身**：幂等重写（同 id）只更新内容，不对自己标 invalidAt。
 *   - **source 不参与冲突域**：来源是证据维度，不是事实本体。
 *
 * ⚠️ 2026-09-22「移除项目记忆」后记忆只归属 Agent，不再按 scope 区分冲突域；
 *    旧 fact 里残留的 `scope` 字段被 schema 忽略，不影响判定。
 */
export function conflictsToInvalidate(
  incoming: Pick<MemoryFact, 'id' | 'agentId' | 'entity' | 'relation' | 'fact'>,
  existing: readonly MemoryFact[],
  now: number = Date.now(),
): MemoryFact[] {
  if (incoming.entity === '' && incoming.relation === '') return []
  return existing.filter(f =>
    f.id !== incoming.id &&
    f.agentId === incoming.agentId &&
    f.entity === incoming.entity &&
    f.relation === incoming.relation &&
    f.fact === incoming.fact &&
    isApplicable(f, now),
  )
}

/**
 * 多策略匹配打分（无 embedding 的语义近似）。
 *
 * 把单一「fact 文本子串」升级为**多字段加权命中**——把 schema 里已有的结构化
 * 维度（entity / relation / source / evidence）用进检索，避免「只有关键词、连
 * 实体都匹配不上」的最原始形态。**不是向量检索**，但比纯 includes 更贴近
 * 「按实体/关系/来源召回」的语义（Graphiti 多策略检索的轻量版，去掉了 embedding）。
 *
 * 权重（命中任一字段即得分，多字段命中叠加）：
 *   - fact 文本子串命中     → 4（最强，直接命中事实本体）
 *   - entity 命中           → 3（问「这个实体」时召回其所有事实）
 *   - relation 命中         → 2（问「这段关系」时召回）
 *   - source 命中           → 1（按来源召回）
 *   - evidence 命中         → 1（按证据链召回）
 *
 * query 为空返回 0（调用方应退化为纯 effectiveScore 排序）。
 */
export function scoreMatch(fact: MemoryFact, query: string): number {
  const q = query.trim().toLowerCase()
  if (q === '') return 0
  let score = 0
  if (fact.fact.toLowerCase().includes(q)) score += 4
  if (fact.entity !== '' && fact.entity.toLowerCase().includes(q)) score += 3
  if (fact.relation !== '' && fact.relation.toLowerCase().includes(q)) score += 2
  if (fact.source !== '' && fact.source.toLowerCase().includes(q)) score += 1
  if (fact.evidence.some(e => e.toLowerCase().includes(q))) score += 1
  return score
}
