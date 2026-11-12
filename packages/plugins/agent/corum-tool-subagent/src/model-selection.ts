/** Child LLM route selection for the subagent tool. */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /**
   * Free-form capability labels the user attached to this route, e.g.
   * `['长上下文', '多模态', '快速']`. Advisory only: the mechanism renders them
   * to the model and never interprets them.
   */
  readonly tags?: string[]
  /** Free-form note the user attached to this route; rendered next to the route. */
  readonly note?: string
  /**
   * Reasoning effort the user attached to this route (one of the live adapter's
   * advertised effort ids). Advisory like {@link tags}: the mechanism only
   * carries it to the child route it authorizes, and the LLM runtime still
   * validates it against the adapter catalog at preflight.
   */
  readonly reasoningEffort?: string
  /**
   * 这条候选对**哪类子 Agent** 可用（用户 2026-11-12：「勾选可给哪类子 Agent 候选」）。
   *
   * `'worker'` = 执行类（`subagent` / orchestrate 的写子 Agent）；`'research'` = 只读调研类
   * （`subagent_research`）。**缺省/空 = 两类都可用**（老配置与「不关心」的候选不必勾）。
   */
  readonly roles?: CorumCandidateRole[]
}

/**
 * 子 Agent 的两类角色（候选适用范围的最小闭集）。
 *
 * 只放两类而不是跟着 preset 名走：候选集是**运行期**面，而 preset 是编译产物；
 * 用一个小闭集让「勾选可给哪类子 Agent 候选」既有意义又不会随新预设无限膨胀。
 */
export type CorumCandidateRole = 'worker' | 'research'

/** Schema shared by the Host setting and its deployment base. */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  tags: z.array(z.string()),
  note: z.string(),
  reasoningEffort: z.string(),
  roles: z.array(z.union([z.const('worker' as const), z.const('research' as const)])),
})

/** Route-selection authority captured by one delegation definition. */
export interface ModelSelectionPolicy {
  /** Exact provider/model routes authorized for explicit selection. */
  readonly routes: readonly AllowedModelRoute[]
}

/**
 * Stable identity for one provider/model pair.
 * @param route - Exact provider/model route.
 * @returns Opaque key for equality checks.
 */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * 这条候选能不能给该类子 Agent 用。
 *
 * 缺省/空 `roles` = 两类都能用（老配置零迁移；「不关心」的候选不必勾）。
 *
 * @param route - 候选路由。
 * @param role - 本次实例的角色。
 * @returns 是否适用。
 */
export function routeAppliesToRole(route: AllowedModelRoute, role: CorumCandidateRole): boolean {
  const roles: readonly CorumCandidateRole[] = route.roles ?? []
  return roles.length === 0 || roles.includes(role)
}

/**
 * 把一份候选集按角色收敛成「这类子 Agent 实际可用的那几条」。
 *
 * 这是「勾选可给哪类子 Agent 候选」的唯一生效点：提示词段、`list_subagent_models`、
 * 以及白名单校验都用它过滤后的结果，避免「提示词列了 A、机制却拒 A」的自相矛盾。
 *
 * @param routes - 全量候选集。
 * @param role - 本次实例的角色。
 * @returns 过滤后的候选集。
 */
export function routesForRole(
  routes: readonly AllowedModelRoute[],
  role: CorumCandidateRole,
): readonly AllowedModelRoute[] {
  return routes.filter(route => routeAppliesToRole(route, role))
}

/**
 * Reject malformed capability annotations on one route. All fields are
 * optional: a stored route without them is a valid untagged candidate.
 * @param candidate - Object already narrowed to carry non-empty string ids.
 * @param route - `provider/model` label used in the diagnostic.
 */
function assertRouteAnnotations(candidate: object, route: string): void {
  // issue #165（用户 2026-11-12）：候选可标「给哪类子 Agent 用」；只认两个值且不许重复，
  // 其余一律拒 —— 拼错的角色名会静默让候选对任何实例都不可见，比报错更难查。
  if ('roles' in candidate) {
    const roles: unknown = (candidate as { roles?: unknown }).roles
    if (!Array.isArray(roles)
      || roles.some(role => role !== 'worker' && role !== 'research')) {
      throw new Error(`subagent model selection route "${route}" requires \`roles\` to list only "worker" / "research"`)
    }
    if (new Set(roles as readonly string[]).size !== roles.length) {
      throw new Error(`subagent model selection route "${route}" lists a duplicate \`role\``)
    }
  }
  if ('tags' in candidate) {
    const tags: unknown = candidate.tags
    if (!Array.isArray(tags)
      || tags.some(tag => typeof tag !== 'string' || tag.trim().length === 0)) {
      throw new Error(
        `subagent model selection route "${route}" requires \`tags\` to be an array of non-empty strings`,
      )
    }
  }
  if ('note' in candidate && typeof candidate.note !== 'string') {
    throw new Error(`subagent model selection route "${route}" requires \`note\` to be a string`)
  }
  if ('reasoningEffort' in candidate && typeof candidate.reasoningEffort !== 'string') {
    throw new Error(
      `subagent model selection route "${route}" requires \`reasoningEffort\` to be a string`,
    )
  }
}

/**
 * Reject malformed or duplicate route policy entries at a durable or configuration boundary.
 * @param routes - Candidate exact routes to validate.
 * @returns an assertion that the candidate is a validated exact-route array.
 */
export function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[] {
  if (!Array.isArray(routes)) {
    throw new Error('subagent model selection requires an array of routes')
  }
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    assertRouteAnnotations(candidate, `${route.provider}/${route.model}`)
    seen.add(key)
  }
}

/** Model-facing child LLM route fields. */
export interface DelegationModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
}

/**
 * Whether a call explicitly selects any child LLM value.
 * @param request - Model-facing route fields from the tool call.
 * @returns Whether at least one route or effort field is present.
 */
export function hasDelegationModelRequest(request: DelegationModelRequest): boolean {
  return request.provider !== undefined
    || request.model !== undefined
    || request.reasoning_effort !== undefined
}

/** Reject an empty model-facing route value at the tool JSON boundary. */
function assertNonEmpty(value: string | undefined, field: keyof DelegationModelRequest): void {
  if (value !== undefined && value.length === 0) {
    throw new Error(`child LLM \`${field}\` must be non-empty`)
  }
}

/**
 * Merge model-supplied selection fields over configured child defaults.
 * Provider and model form one route and must be supplied together. Changing
 * that route without an effort clears the configured route-owned effort.
 * @param parentOptions - Current parent values that supply missing child values.
 * @param configured - Tool-instance child defaults.
 * @param request - Model-facing route override.
 * @param enabled - Whether this tool instance permits model-facing selection.
 * @returns Child Agent options, preserving omission when no layer contributes one.
 */
export function requestedAgentOptions(
  parentOptions: AgentOptions,
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  enabled: boolean,
): AgentOptions | undefined {
  if (!hasDelegationModelRequest(request)) return configured
  if (!enabled) {
    throw new Error('child model selection is disabled for this tool instance')
  }
  assertNonEmpty(request.provider, 'provider')
  assertNonEmpty(request.model, 'model')
  assertNonEmpty(request.reasoning_effort, 'reasoning_effort')
  if ((request.provider === undefined) !== (request.model === undefined)) {
    throw new Error('child LLM `provider` and `model` must be supplied together')
  }

  const baselineProvider = configured?.provider ?? parentOptions.provider
  const baselineModel = configured?.model ?? parentOptions.model
  const routeChanged = request.provider !== undefined
    && (request.provider !== baselineProvider || request.model !== baselineModel)
  const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {}
  return {
    ...routeChanged && request.reasoning_effort === undefined ? configuredWithoutReasoning : configured,
    ...request.provider === undefined ? {} : { provider: request.provider, model: request.model },
    ...request.reasoning_effort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) },
  }
}

/**
 * Enforce a settings-owned route list at the operation that creates the child.
 * Pure inheritance remains outside this policy because no model-facing choice
 * occurred; any explicit route or effort field must resolve to an allowed route.
 * @param policy - Selection authority captured for this Session.
 * @param parentOptions - Current parent values that supply missing child values.
 * @param requested - Effective child options after request/config merging.
 * @param request - Model-facing selection fields from the tool call.
 */
export function assertAllowedModelSelection(
  policy: ModelSelectionPolicy | undefined,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  request: DelegationModelRequest,
): void {
  if (policy === undefined || !hasDelegationModelRequest(request)) return
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  if (policy.routes.some(route => route.provider === provider && route.model === model)) return
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`)
}

/**
 * Whether configured Agent options require route validation before delegation.
 * @param options - Tool-instance child defaults.
 * @returns Whether configured provider, model, or effort values must be resolved.
 */
export function hasConfiguredLlmSelection(options: AgentOptions | undefined): boolean {
  return options?.provider !== undefined
    || options?.model !== undefined
    || options?.reasoningEffort !== undefined
}

/**
 * Resolve an effective child route through its live adapter before the child is
 * created. The LLM runtime owns provider lookup, exact-model metadata, effort
 * validation, and adapter defaults.
 * @param llm - Live LLM runtime.
 * @param parentOptions - Current parent values whose compatible fields the child inherits.
 * @param requested - Per-child options after request/config merging.
 * @param signal - Tool-call cancellation signal.
 * @param inheritParentReasoningEffort - Whether an omitted effort may inherit from the parent route.
 */
export async function preflightChildLlmRoute(
  llm: LlmRuntime,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  signal: AbortSignal,
  inheritParentReasoningEffort = true,
): Promise<void> {
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model
  const reasoningEffort = requested?.reasoningEffort
    ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : undefined)
  await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }, signal)
}
