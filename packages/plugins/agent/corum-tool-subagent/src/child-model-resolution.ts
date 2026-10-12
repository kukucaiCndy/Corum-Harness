/**
 * 子 Agent 模型路由的**三档解析**（纯函数，可行为测试）。
 *
 * ## 语义（用户 2026-10-11 定调，**推翻** 2026-09-18 的「始终两档」）
 *
 * 用户原话：「全局未设置子 Agent 的 LLM 模型、只设置主 Agent 的 LLM 模型的情况下，
 * **即无论如何都未设置子 Agent 模型时才跟随主 Agent**」。
 *
 * 优先级（高 → 低）：
 *   ① **会话级覆盖**（`corumOrchestration` 的内存值，模型不可用问询后写入；含
 *      `'follow-main'` 哨兵 ⇒ 直接到 ③）；
 *   ② **预设里配的模型**（`config.model`，角色锁）；
 *   ③ **全局兜底**（`corum-subagent` 的 `defaultModel`/`defaultResearchModel`）；
 *   ④ **跟随主 Agent**（返回 `undefined`，调用方用父的真实路由）。
 *
 * ## 为什么抽成纯函数
 *
 * 这段判据原先内联在 `apply()` 的委派闭包里（上百行、深依赖 ctx），只能靠**源码扫描式**
 * 测试对账——而扫描式断言钉的是「代码长什么样」，不是「行为对不对」。本轮修的两个缺陷
 * （哨兵被全局档接管、预设没配时删键成空操作导致无限弹面板）都是**行为**错，扫描断言
 * 一个都拦不住。抽出来后用真实组合逐档断言。
 *
 * @module
 */

/** 一条可用路由（与 `CorumRoute` 同构；此处独立声明避免循环依赖）。 */
export interface ChildModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * 「显式跟随主 Agent」哨兵。权威定义在 `@corum/corum-agent` 的 `profile.ts`
 * （`FOLLOW_MAIN`）与 `model-ask-run.ts`（本地副本）；三处必须逐字一致。
 */
export const FOLLOW_MAIN = 'follow-main' as const

/** 全局兜底设置（`corum-subagent` ns 的两个模型键）。 */
export interface GlobalChildModels {
  readonly defaultModel?: ChildModelRoute | undefined
  readonly defaultResearchModel?: ChildModelRoute | undefined
}

/** {@link resolveChildModel} 的入参。 */
export interface ResolveChildModelInput {
  /** 角色（决定读全局哪一个键、以及 research 是否回落 worker）。 */
  readonly role: 'worker' | 'research'
  /**
   * 会话级覆盖（最高档）。`'follow-main'` = 显式跟随主 Agent（**跳过**全局档）；
   * `undefined` = 无覆盖。
   */
  readonly sessionOverride: ChildModelRoute | typeof FOLLOW_MAIN | undefined
  /** 预设锁面（`agent.cordis.yml` 的 `config.model`）；缺省 = 预设没配。 */
  readonly presetModel: ChildModelRoute | undefined
  /**
   * 预设是否**显式**选了跟随主 Agent（`config.modelFollowMain`）。
   * 与「预设没配」（`presetModel === undefined` 且本标志为假）是**不同**的状态：
   * 前者跳过全局档，后者走全局档。
   */
  readonly presetFollowsMain: boolean
  /** 全局兜底设置。 */
  readonly global: GlobalChildModels
}

/** {@link resolveChildModel} 的结论。 */
export interface ResolvedChildModel {
  /** 生效路由；`undefined` = 落到「跟随主 Agent」（由调用方用父的真实路由填充）。 */
  readonly route: ChildModelRoute | undefined
  /** 该结论来自哪一档（供日志/证据；测试也用它区分「恰好同值」）。 */
  readonly tier: 'session-override' | 'preset' | 'global' | 'follow-main'
}

/** 空值判据：provider/model 必须有实义（空串不算配置）。 */
function meaningful(route: ChildModelRoute | undefined): ChildModelRoute | undefined {
  if (route === undefined) return undefined
  if (route.provider === '' || route.model === '') return undefined
  return route
}

/**
 * 按三档解析生效的子 Agent 模型路由。
 *
 * @param input - 见 {@link ResolveChildModelInput}。
 * @returns 生效路由 + 它来自哪一档。
 */
export function resolveChildModel(input: ResolveChildModelInput): ResolvedChildModel {
  // ① 会话级覆盖：具体路由直接用；`'follow-main'` ⇒ 跳过 ②③ 直接到 ④。
  if (input.sessionOverride === FOLLOW_MAIN) return { route: undefined, tier: 'follow-main' }
  const session = meaningful(input.sessionOverride)
  if (session !== undefined) return { route: session, tier: 'session-override' }

  // ② 预设锁面：显式跟随 ⇒ 跳过全局；有具体路由 ⇒ 用它。
  if (input.presetFollowsMain) return { route: undefined, tier: 'follow-main' }
  const preset = meaningful(input.presetModel)
  if (preset !== undefined) return { route: preset, tier: 'preset' }

  // ③ 全局兜底：research 优先自己的键、缺省回落 worker 的（与预设侧
  // `researchModel ?? subagentModel` 对称；也符合用户「**无论如何**都没设子 Agent 模型
  // 时才跟随主 Agent」——只要全局配了任一子 Agent 模型就不落到 ④）。
  const candidates = input.role === 'research'
    ? [input.global.defaultResearchModel, input.global.defaultModel]
    : [input.global.defaultModel]
  for (const candidate of candidates) {
    const route = meaningful(candidate)
    if (route !== undefined) return { route, tier: 'global' }
  }

  // ④ 跟随主 Agent。
  return { route: undefined, tier: 'follow-main' }
}
