/**
 * fork（corum）2026-10-19：**脚本模式子 Agent 的模型路由解析**。
 *
 * ## 由来（用户 2026-10-19 报障）
 *
 * 用户报告：「全局的模型设置并未生效，我在使用通用助手时发现其调用编排工作流的
 * 子 Agent 模型并不是全局设置的 glm-5.3-flash 而是 DeepSeek-v4-flash」。
 *
 * 根因：`orchestrate` 的 **SCRIPT 模式**（`script` + `meta`）把脚本交给官方 workflow
 * 引擎执行，引擎里的 `agent()` **不经过 corum 工具层**（`spawnOne`），而子 Agent
 * 模型的分档解析（会话级覆盖 → 预设锁 → 全局兜底 → 跟随主 Agent）只写在 `spawnOne`
 * 里（`corum-tool-subagent/src/index.ts`）。于是脚本派出的子 Agent 走
 * `corum-isolated` provider → `startInProcessRun` →
 * `resolveChildAgentOptions(parent, undefined, childDepth)` → **继承父路由**
 * （= 主 Agent 的模型 `deepseek-v4-flash`），而不是全局设置的子 Agent 模型
 * （`glm-5.3-flash`）。
 *
 * ## 修法（**四档**，2026-10-19 复审后与 `resolveChildModel` 完全对齐）
 *
 * 在 `corum-isolated` provider 的 `start()` 里、调 `startInProcessRun` 之前，
 * 解析机制拥有的子 Agent 模型路由并经 `mechanismRoute` 通道注入（见
 * {@link applyMechanismRoute}）。
 *
 * 优先级（高 → 低），与 `corum-tool-subagent/src/child-model-resolution.ts` 的
 * `resolveChildModel` **逐档一致**（脚本路径只跑 worker 角色，故没有 research 的回落）：
 *   ① **会话级覆盖**（`corumOrchestration.modelOverrideOf(sessionId, 'worker')`；
 *      含 `'follow-main'` 哨兵 ⇒ 直接到 ④）；
 *   ② **预设锁**（预设 `agent.json` 的 `subagentModel` 三态：
 *      具体路由 ⇒ 用它；`'follow-main'` ⇒ **跳过 ③** 直接到 ④；键不存在 ⇒ 走 ③）；
 *   ③ **全局兜底**（`corum-subagent` settings namespace 的 `defaultModel`）；
 *   ④ **跟随主 Agent**（返回 `undefined`，driver 用父路由）。
 *
 * ## 为什么必须补 ②（本轮修的核心缺陷）
 *
 * 初版只有三档（缺 ②），后果：**锁了 `subagentModel` 的预设**（如 conductor-lead）
 * 在脚本路径跑全局默认、在 `subagent` 工具路径跑预设锁——**同一会话两条委派路径
 * 模型不一致**。补 ② 后两条路径同口径。
 *
 * ## 为什么不直接 import `resolveChildModel`（`corum-tool-subagent`）
 *
 * 包依赖方向：`corum-subagent` → `corum-orchestration`（**不依赖** `corum-tool-subagent`，
 * 也不依赖 `corum-agent`）。`resolveChildModel` 是纯函数，但住在
 * `corum-tool-subagent/src/child-model-resolution.ts`；从本包 import 它会造循环依赖
 * （红线 3：跨包类型/能力一律用本地窄面接口收窄）。故本模块实现**最小等价**逻辑
 * （worker 单角色，四档齐全），`FOLLOW_MAIN` 字面量本地声明。
 *
 * @module @corum/corum-subagent/isolated/script-model-resolution
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ResolvedSubagentStartRequest } from '../index.ts'

/**
 * `corumOrchestration` 的**最小能力面**（只取模型覆盖读取）。
 * 与 `isolated/index.ts` 的 `CorumOrchestrationFace` 同源但更窄——本模块只用覆盖读取。
 */
export interface OrchestrationModelOverrideFace {
  modelOverrideOf: (
    sessionId: string,
    role: 'worker' | 'research',
  ) => { provider: string; model: string; reasoningEffort?: string } | 'follow-main' | undefined
}

/** 一条可用路由（与 `CorumRoute` 同构；此处独立声明避免循环依赖）。 */
export interface ScriptChildModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 「显式跟随主 Agent」哨兵（与 `child-model-resolution.ts` 的 `FOLLOW_MAIN` 逐字一致）。 */
export const FOLLOW_MAIN = 'follow-main' as const

/**
 * 预设的子 Agent 模型锁（**三态**，与 `@corum/corum-agent` 的 `ProfileChildModel` 同构）：
 *   · `undefined`（键不存在）= 不覆盖 ⇒ 走全局档；
 *   · {@link FOLLOW_MAIN} = 显式跟随主 Agent ⇒ **跳过**全局档；
 *   · 具体路由 = 机制锁，设什么跑什么。
 */
export type PresetChildModelFace = ScriptChildModelRoute | typeof FOLLOW_MAIN

/**
 * `agentPresets` 服务的**最小能力面**：只需把「父 Agent 当前组合出的 preset id」读出来。
 *
 * 与 `child-agent.ts` 的 `childSessionMeta` 同款用法（`parent.ctx.get('agentPresets')
 * ?.composedPreset(parent.ctx)`）——**必须传父 Agent 自己的 scope ctx**，因为 preset 是
 * 从父的**活** scope 链读的（blank 期换过 preset 的会话，creation header 已过时）。
 */
export interface AgentPresetsFace {
  composedPreset?: (agentCtx: unknown) => string | undefined
}

/**
 * `corumAgent` 服务的**最小能力面**：只需读出「某个预设的子 Agent 模型锁」。
 *
 * ⚠️ 与设计稿的两处偏差（均已实机核实并如实记录）：
 *   ① `CorumAgentService` **没有** `loadProfile` 方法——`loadProfile(id)` 是
 *      `@corum/corum-agent/profile-store.ts` 的**模块级函数**（`agent-service.ts` 里是
 *      `import { loadProfile }`，不是方法）。服务对外暴露的 profile 读面只有列表
 *      （`ProfileSummary` 含 `subagentModel`，与 `agent.json` 的三态同构）。
 *   ② 那个读面在服务实例上的**方法名是 `listProfilesRemote`**（`@Remote('listProfiles')`
 *      只决定**线上导出名**，不改方法名；见 `dsh-api-gateway` 的
 *      `candidate.exportName ?? candidate.method`）。2026-10-19 实机探针证据：
 *      `Object.getOwnPropertyNames(Object.getPrototypeOf(corumAgent))` 里只有
 *      `listProfilesRemote`，按 `listProfiles` 取会拿到 `undefined` ⇒ 预设锁档**静默**
 *      降级成「没配」（正是本刀要修的缺陷形态）。
 *      故两个名字都试：先 `listProfilesRemote`（真实方法名），再 `listProfiles`
 *      （能力面/测试替身可能用导出名）。
 * 本包**不能** import `corum-agent`（红线：循环依赖），故走这个既有读面；
 * 缺席 / 抛错一律降级为「无预设锁」。
 */
export interface CorumProfilesFace {
  /** 服务实例上的真实方法名（`@Remote('listProfiles')` 的实现体）。 */
  listProfilesRemote?: () => Promise<{ profiles: readonly { id: string; subagentModel?: PresetChildModelFace }[] } | undefined>
  /** 线上导出名（RPC 面叫这个名字；测试替身/能力面可能按它实现）。 */
  listProfiles?: () => Promise<{ profiles: readonly { id: string; subagentModel?: PresetChildModelFace }[] } | undefined>
}

/**
 * `settings` 服务的**最小能力面**：只需 `get(ns)`（读一个已注册 namespace 的
 * resolved 值）。`corum-subagent-settings` settings namespace 由 `corum-tool-subagent` 的 boot
 * registrar（`settings-registrar.ts`）注册，本包不持有它——运行时通过
 * `ctx.root.get('settings')` 读取已注册的 namespace（与 `acquireCorumSubagentSettingsScope`
 * 同款手法，但不持有模块级 scope 单例——避免跨 bundle 模块级状态被复制，红线 1）。
 *
 * 2026-10-19 复审：原实现用 `describe()` 再 `.find`，而 `describe()` 会**全量克隆所有
 * namespace**（含 `structuredClone`）——每次子 Agent start 都付一次全量克隆的代价。
 * `dsh-settings` 的 `get(ns)`（`lib/index.js` 的 `get(ns)`）直接返回
 * `registrations.get(ns)?.resolved`，即**该 ns 的 resolved 值本身**（不包 `{value}`、
 * 不克隆、不过滤），正是这里需要的形状。
 */
export interface SettingsGetFace {
  get?: (ns: string) => unknown
}

/**
 * `corum-subagent-settings` settings namespace 的名（与 `settings-namespace.ts` 的
 * `CORUM_SUBAGENT_SETTINGS_NAMESPACE` 逐字一致——两处各声明一份，因为本包不能
 * import `corum-tool-subagent`；判据同 `corum-subagent-settings` 这个字符串值在
 * 两侧都是字面量，改时两处一起改，fork-drift 守卫不覆盖跨包字面量）。
 *
 * ⚠️ D2 纠偏（2026-10-27）：旧值 `'corum-subagent'` 与 cordis patch 行 id
 * 不一致（行 id = `corum-subagent-settings`）⇒ describe 里找不到 ns。
 */
const CORUM_SUBAGENT_NS = 'corum-subagent-settings'

/** 全局兜底设置的最小形状（只取 worker 的 `defaultModel`）。 */
interface GlobalChildModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 空值判据：provider/model 必须有实义（空串不算配置）。 */
function meaningful<T extends { readonly provider: string; readonly model: string }>(route: T | undefined): T | undefined {
  if (route === undefined) return undefined
  if (route.provider === '' || route.model === '') return undefined
  return route
}

/** 把任意三态值归一成路由对象（去掉空 `reasoningEffort`）；`'follow-main'` 走哨兵分支。 */
function toRoute(value: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): ScriptChildModelRoute {
  return {
    provider: value.provider,
    model: value.model,
    ...value.reasoningEffort !== undefined && value.reasoningEffort !== ''
      ? { reasoningEffort: value.reasoningEffort }
      : {},
  }
}

/**
 * 读 `corum-subagent` settings namespace 的 resolved 值（只读，每次调用现读——
 * 与 `acquireCorumSubagentSettingsScope` 的「已注册 ⇒ 只读直读」分支同语义）。
 *
 * settings 服务缺席 / `get` 缺席 / namespace 未注册（`get` 返回 `undefined`）/
 * `get` 抛错 ⇒ 返回 `undefined`（= 无全局兜底 ⇒ 跟随主 Agent），不阻断委派。
 * @param settings - settings 服务面（`ctx.root.get('settings')`）。
 * @returns 全局 worker 子 Agent 模型，或 `undefined`。
 */
export function readGlobalChildModel(settings: SettingsGetFace | undefined): GlobalChildModel | undefined {
  if (settings === undefined || typeof settings.get !== 'function') return undefined
  try {
    const value = settings.get(CORUM_SUBAGENT_NS) as { defaultModel?: GlobalChildModel } | undefined
    return meaningful(value?.defaultModel)
  } catch {
    return undefined
  }
}

/**
 * 读「父会话当前预设」的子 Agent 模型锁（预设锁档的**取数**部分）。
 *
 * 三步，任一步缺席都降级为 `undefined`（= 无预设锁 ⇒ 走全局档），不阻断委派：
 *   ① `agentPresets.composedPreset(parentCtx)` ⇒ preset id（缺席/空串 ⇒ 无预设锁）；
 *   ② `corumAgent.listProfiles()` ⇒ 按 id 找 profile（查不到 ⇒ 无预设锁）；
 *   ③ 取 `profile.subagentModel` 三态原样返回（`'follow-main'` 与具体路由语义不同，
 *      不能在取数层折叠）。
 *
 * @param presets - `agentPresets` 服务面（`parentCtx.get('agentPresets')`）。
 * @param profiles - `corumAgent` 服务面（`ctx.root.get('corumAgent', false)`）。
 * @param parentCtx - 父 Agent 自己的 scope ctx（preset 从父的活 scope 链读）。
 * @returns 预设锁的三态值，或 `undefined`（无预设锁）。
 */
export async function readPresetChildModel(
  presets: AgentPresetsFace | undefined,
  profiles: CorumProfilesFace | undefined,
  parentCtx: unknown,
): Promise<PresetChildModelFace | undefined> {
  if (presets === undefined || typeof presets.composedPreset !== 'function') return undefined
  let presetId: string | undefined
  try {
    presetId = presets.composedPreset(parentCtx)
  } catch {
    return undefined
  }
  if (presetId === undefined || presetId === '') return undefined
  const readProfiles = profiles === undefined
    ? undefined
    : (typeof profiles.listProfilesRemote === 'function'
      ? profiles.listProfilesRemote.bind(profiles)
      : (typeof profiles.listProfiles === 'function' ? profiles.listProfiles.bind(profiles) : undefined))
  if (readProfiles === undefined) return undefined
  try {
    const listed = await readProfiles()
    const found = listed?.profiles?.find(profile => profile.id === presetId)
    const value = found?.subagentModel
    if (value === undefined) return undefined
    if (value === FOLLOW_MAIN) return FOLLOW_MAIN
    const route = meaningful(value)
    return route === undefined ? undefined : toRoute(route)
  } catch {
    return undefined
  }
}

/** {@link resolveScriptChildModel} 的结论。 */
export interface ResolvedScriptChildModel {
  /**
   * 生效路由；`undefined` = 落到「跟随主 Agent」（由 driver 用父真实路由填充）。
   */
  readonly route: ScriptChildModelRoute | undefined
  /** 该结论来自哪一档（供日志/证据；测试也用它区分「恰好同值」）。 */
  readonly tier: 'session-override' | 'preset' | 'global' | 'follow-main'
}

/**
 * 解析脚本模式子 Agent 的生效模型路由（**四档**，worker 单角色）。
 *
 * 优先级（高 → 低）：
 *   ① 会话级覆盖（含 `'follow-main'` 哨兵 ⇒ 直接到 ④）；
 *   ② 预设锁（`'follow-main'` ⇒ 跳过 ③ 直接到 ④；具体路由 ⇒ 用它）；
 *   ③ 全局兜底（`corum-subagent` 的 `defaultModel`）；
 *   ④ 跟随主 Agent（返回 `undefined`）。
 *
 * @param orchestration - `corumOrchestration` 服务的模型覆盖面。
 * @param settings - `settings` 服务的 get 面（`ctx.root.get('settings')`）。
 * @param sessionId - 父会话 id（用于查会话级覆盖）。
 * @param presetChildModel - 预设锁的三态值（{@link readPresetChildModel} 的结果；
 *   缺省 = 无预设锁 ⇒ 走全局档）。
 * @returns 生效路由 + 它来自哪一档。
 */
export function resolveScriptChildModel(
  orchestration: OrchestrationModelOverrideFace | undefined,
  settings: SettingsGetFace | undefined,
  sessionId: string,
  presetChildModel?: PresetChildModelFace | undefined,
): ResolvedScriptChildModel {
  // ① 会话级覆盖：具体路由直接用；`'follow-main'` ⇒ 跳过 ②③ 直接到 ④。
  if (orchestration !== undefined) {
    const override = orchestration.modelOverrideOf(sessionId, 'worker')
    if (override === FOLLOW_MAIN) return { route: undefined, tier: 'follow-main' }
    const session = meaningful(override as ScriptChildModelRoute | undefined)
    if (session !== undefined) return { route: toRoute(session), tier: 'session-override' }
  }

  // ② 预设锁：显式跟随 ⇒ 跳过全局档；有具体路由 ⇒ 用它。
  if (presetChildModel === FOLLOW_MAIN) return { route: undefined, tier: 'follow-main' }
  const preset = meaningful(presetChildModel as ScriptChildModelRoute | undefined)
  if (preset !== undefined) return { route: toRoute(preset), tier: 'preset' }

  // ③ 全局兜底。
  const global = readGlobalChildModel(settings)
  if (global !== undefined) return { route: toRoute(global), tier: 'global' }

  // ④ 跟随主 Agent。
  return { route: undefined, tier: 'follow-main' }
}

/**
 * 把解析出的机制路由挂到 start 请求的**独立通道** `mechanismRoute` 上。
 *
 * ## 为什么不用「整体替换 agentOptions + 打机制标记」（2026-10-19 复审改法）
 *
 * 旧实现在这里把 `agentOptions` **整体替换**成机制路由，并置上「归机制所有」标记。
 * 后果：driver 的 P1 剥离（`driver/index.ts` 的 `corumStripRoutingOptions`）看到标记
 * 就整段跳过 ⇒ 看不到脚本原传的 `provider`/`model` ⇒
 * `corumRoutingIgnoredNoticeText` 那条「脚本自选路由被忽略」的机制通知**静默丢失**
 * （脚本违规自选模型时，模型永远学不到口径）。
 *
 * 新做法（用户裁定的「剥离 + 告知」方案 A 的完整形态）：
 *   · `request.agentOptions` **保持脚本原样**（不标记、不改写）⇒ driver 正常剥离
 *     `provider`/`model` 并发出告知；
 *   · 机制路由走 {@link ResolvedSubagentStartRequest.mechanismRoute} 这个**不受剥离
 *     影响**的独立字段 ⇒ driver 在剥离之后再把它叠加进去。
 *
 * 两个诉求（机制路由生效 ∧ 脚本路由被剥离且告知）因此同时成立，不需要任何权衡。
 *
 * `route === undefined`（跟随主 Agent）时不注入——driver 会用父路由，这正是「跟随」语义。
 * @param request - 原始请求（字段 readonly，返回一个带注入的副本）。
 * @param route - 解析出的机制路由（`undefined` = 跟随主 Agent）。
 * @returns 带注入的请求（若 route 为 undefined 则原样返回）。
 */
export function applyMechanismRoute(
  request: ResolvedSubagentStartRequest,
  route: ScriptChildModelRoute | undefined,
): ResolvedSubagentStartRequest {
  if (route === undefined) return request
  const mechanismRoute: AgentOptions = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort !== undefined && route.reasoningEffort !== ''
      ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }
      : {}),
  }
  return {
    ...request,
    mechanismRoute,
  }
}
