/**
 * 全局「子 Agent 候选模型」配置面（issue #165；用户 2026-11-12 裁定搬进「智能体设置」）。
 *
 * ## 真源
 *
 * host 侧命名空间由 `@corum/corum-tool-subagent` 的 `model-selection-settings.ts` 声明
 * （`name = 'subagent-model-selection-settings'` ⇒ settings 命名空间 id **等于 cordis
 * entry id**，不是 `subagent-model-selection`；rc3 起 ns = entry id，旧值读出来是空的）。
 * 形状 `{ enabled: boolean, allowedModels: AllowedModelRoute[] }`，其中
 * `AllowedModelRoute = { provider, model, tags?, note?, reasoningEffort? }`。
 *
 * ⚠️ 这个常量与 host 侧那个 entry id 必须一致：本仓跨 client 插件包的值 import 不可行
 * （独立闭包 bundle，见 AGENTS 红线 2），所以它是**第二个声明点**，由
 * `corum-agent/tests/settings-ns-alignment.spec.ts` 钉住（改一处即红）。
 *
 * ## 为什么写盘按字段 set
 *
 * `enabled` 与 `allowedModels` 是两个独立顶层字段：关开关时**只**写 `enabled:false`
 * （已选候选必须原样保留 —— 「关闭后子 Agent 用配置的默认模型；已选候选会保留」），
 * 绝不能整节点覆盖（那会把候选一起清掉，也会把 host 的默认档位一起抹平）。
 */

import type { CandidateRole, ModelCandidateRow } from './child-model-candidates.ts'
import { candidateRowComplete, candidateRowToWire } from './child-model-candidates.ts'

/** Host settings namespace of the global candidate set (= cordis entry id). */
export const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection-settings'

/** 一条允许子 Agent 使用的路由（存盘形状，与 host `AllowedModelRoute` 同形）。 */
export interface GlobalCandidateRoute {
  provider: string
  model: string
  /** 思考程度（档位 id；缺省 = 跟随该模型默认档）。 */
  reasoningEffort?: string
  /** 这条候选给哪类子 Agent 用（缺省/空 = 两类都可用）。 */
  roles?: CandidateRole[]
  /** 能力标注（原样出现在给 Agent 的候选清单里）。 */
  tags?: string[]
  /** 给 Agent 看的备注。 */
  note?: string
}

/** 全局候选集的存盘值。 */
export interface GlobalSelectionValue {
  enabled: boolean
  allowedModels: GlobalCandidateRoute[]
}

/** settings.mutate 的一条操作（与 `CorumSettingsFace.mutate` 的入参同形）。 */
export interface SelectionOp {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

/**
 * 把 settings describe 镜像里的 `user` 层投影成全局候选集值（防御式：user 可能缺键）。
 * @param user - `entryOf(SUBAGENT_MODEL_SELECTION_NS)?.user`。
 * @returns 已归一的 enabled 与候选路由（不可用的行被丢弃，ID 为空的行也丢弃）。
 */
export function globalSelectionFromUser(user: unknown): GlobalSelectionValue {
  if (typeof user !== 'object' || user === null) return { enabled: false, allowedModels: [] }
  const view = user as { enabled?: unknown; allowedModels?: unknown }
  const allowedModels: GlobalCandidateRoute[] = []
  if (Array.isArray(view.allowedModels)) {
    for (const raw of view.allowedModels) {
      if (typeof raw !== 'object' || raw === null) continue
      const route = raw as {
        provider?: unknown; model?: unknown; reasoningEffort?: unknown
        roles?: unknown; tags?: unknown; note?: unknown
      }
      if (typeof route.provider !== 'string' || typeof route.model !== 'string') continue
      if (route.provider === '' || route.model === '') continue
      const tags = Array.isArray(route.tags)
        ? route.tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
        : []
      allowedModels.push({
        provider: route.provider,
        model: route.model,
        ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort !== ''
          ? { reasoningEffort: route.reasoningEffort }
          : {}),
        ...(Array.isArray(route.roles)
          ? { roles: (route.roles as unknown[]).filter((role): role is CandidateRole => role === 'worker' || role === 'research') }
          : {}),
        ...tags.length === 0 ? {} : { tags },
        ...(typeof route.note === 'string' && route.note !== '' ? { note: route.note } : {}),
      })
    }
  }
  return { enabled: view.enabled === true, allowedModels }
}

/**
 * 存盘值 → 编辑器行（读回回填）。
 * @param value - 已归一的全局候选集值。
 * @returns 候选行（标签/备注回到编辑器文本形态）。
 */
export function globalCandidateRows(value: GlobalSelectionValue): ModelCandidateRow[] {
  return value.allowedModels.map(route => ({
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort ?? '',
    // 缺省/空 roles = 两类都可用 ⇒ 界面两枚都勾。
    roles: route.roles === undefined || route.roles.length === 0 ? ['worker', 'research'] : [...route.roles],
    tagsText: (route.tags ?? []).join(', '),
    noteText: route.note ?? '',
  }))
}

/**
 * 编辑器行 → 存盘路由（**未选全的行不写入**）。
 * @param rows - 编辑器里的候选行。
 * @returns 只含「供应商 + 模型都选了」的路由。
 */
export function globalCandidateRoutes(rows: readonly ModelCandidateRow[]): GlobalCandidateRoute[] {
  const routes: GlobalCandidateRoute[] = []
  for (const row of rows) {
    if (!candidateRowComplete(row)) continue
    const wire = candidateRowToWire(row)
    if (wire !== undefined) routes.push(wire)
  }
  return routes
}

/**
 * 两份存盘路由是否等价（provider/model/思考程度/标签顺序/备注逐项比较）。
 * @param left - 一侧路由。
 * @param right - 另一侧路由。
 * @returns 是否完全一致（用于「没变就不写」与冲突判定）。
 */
export function sameCandidateRoutes(
  left: readonly GlobalCandidateRoute[],
  right: readonly GlobalCandidateRoute[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((route, index) => {
    const counterpart = right[index]
    if (counterpart === undefined) return false
    const leftTags = route.tags ?? []
    const rightTags = counterpart.tags ?? []
    return route.provider === counterpart.provider
      && route.model === counterpart.model
      && (route.reasoningEffort ?? '') === (counterpart.reasoningEffort ?? '')
      && (route.note ?? '') === (counterpart.note ?? '')
      && leftTags.length === rightTags.length
      && leftTags.every((tag, i) => tag === rightTags[i])
  })
}

/**
 * 组装一次写盘的操作列表（**按字段分别 set，未变的字段不写**）。
 *
 * - 关开关（`enabled === false` 且原本是开）⇒ 只剩 `allowedModels` 不变 ⇒ 只有一条
 *   `{ op:'set', path:['enabled'], value:false }`，已选候选原样保留；
 * - 新增候选 / 改标签 ⇒ `allowedModels` 一条（+ 开关变化时那条）。
 *
 * @param enabled - 期望的开关值。
 * @param rows - 编辑器里的候选行。
 * @param baseline - 当前已存的值（describe 镜像的 user 层投影）。
 * @returns 按字段分别 set 的操作列表；两者都没变时为空数组（调用方跳过写盘）。
 */
export function globalSelectionOps(
  enabled: boolean,
  rows: readonly ModelCandidateRow[],
  baseline: GlobalSelectionValue,
): SelectionOp[] {
  const routes = globalCandidateRoutes(rows)
  const ops: SelectionOp[] = []
  if (enabled !== baseline.enabled) {
    ops.push({ op: 'set', path: ['enabled'], value: enabled })
  }
  if (!sameCandidateRoutes(routes, baseline.allowedModels)) {
    ops.push({
      op: 'set',
      path: ['allowedModels'],
      value: routes.map(route => ({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        ...(route.tags === undefined ? {} : { tags: [...route.tags] }),
        ...(route.note === undefined ? {} : { note: route.note }),
      })),
    })
  }
  return ops
}