/**
 * fork（corum）：**task 泳道会话的解析与冷恢复**——从 `agent-service.ts` 按关注点抽出（2026-09-21）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在
 * 文件层面切分清晰**，方便维护。」
 *
 * 本模块只回答一个问题：**给定一个 task sessionId，把它弄成「活着的 agent」**——
 * 四条路径，顺序固定：
 *
 * | 路径 | 触发条件 | 动作 |
 * |---|---|---|
 * | ① 内存命中 | 本进程已登记 | 直接返回（零 I/O） |
 * | ② 官方层已激活 | 侧栏选中/官方 sessions 收录 | 登记 + 复用，**不能再 resume** |
 * | ③ 冷恢复 | 已持久化但未激活 | `ctx.agents.resume`（preset 重挂 + 模型绑定） |
 * | ④ 不可恢复 | 非官方 preset 且 profile 缺失 | 返回 `undefined` |
 *
 * ⚠️ 路径 ② 的「不能再 resume」是**官方约束**：`agents.resume` 会拒绝 live 会话
 * （「cannot prepare session while it is live」）。
 *
 * ## ⚠️ 本模块与「指挥模式」的耦合是**显式参数**，不是隐藏调用
 *
 * 四条路径里有两条要按泳道 profile 重算**指挥模式口径**（conductor preset 或
 * `executionTools: 'orchestrator'`），在主 Agent scope 注册裁剪 + 人格。
 *
 * 这里刻意把它做成 {@link TaskLaneHost.applyConductor} 回调，而**不是**让本模块自己
 * `import ConductorRuntime`：
 *
 * - **为什么必须在 setup 里调**（不能像别处那样事后调）：`agents.resume` 的 `setup`
 *   在会话组装期执行，人格段/工具裁剪必须在**那一刻**就位 —— 事后补注册会漏掉本次组装。
 *   这是实机结论，不是风格选择。
 * - **为什么要显式**：2026-09-20 那个只读护栏漏洞的根因就是「权限档位」与「指挥模式」
 *   两个方法**各自写同一份状态、互不知情**。把「本模块会写指挥模式」写在**接口签名**上，
 *   读者一眼能看到这条边，而不是靠全文搜索发现第 3、4 个写入者。
 *
 * 另：`registry` 也是显式参数（见 {@link TaskLaneHost.registry}）——本模块不 new 登记册、
 * 不 assuming 谁持有它。
 *
 * @module @corum/corum-agent/task-lane
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentRegistry } from './agent-registry.ts'
import { TASK_PROFILE_ID, ensureTaskProfile } from './builtin-profiles.ts'
import { conductorModeOf, effectiveExecutionTools, type ConductorMode } from './conductor.ts'
import { loadProfile } from './profile-store.ts'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installTaskModelSelection, taskModelSelectionOf } from './task-model-selection.ts'
import { readTaskSessionIndex } from './lane-registry.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// fork（corum）2026-09-26：冷恢复同样要处理「预设模型已被删除」（确定性配置缺失）。
import { globalDefaultModel, resolveUsableModel } from './model-availability.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller'

/** 一条已解析的 task 泳道会话。 */
export interface ResolvedTaskSession {
  readonly agent: Agent
  readonly sessionId: SessionId
  readonly cwd: string
  readonly profileId: string
  /**
   * 本次解析算出的**指挥模式口径**（三条恢复路径都按它决定是否在主 Agent scope 注册）。
   *
   * 一并返回而不是只在本模块内部用掉：调用方（复用 blank 泳道、新建 task 等路径）需要
   * 知道当前口径才能做自己的登记，否则它得**再算一遍** —— 那就是第二处口径来源，
   * 正是「同一份状态多个写入者」的温床。
   */
  readonly conductor: ConductorMode
}

/** 本模块需要的宿主能力（窄接口：不 new 登记册、不自己 import 指挥模式运行时）。 */
export interface TaskLaneHost {
  readonly ctx: Context
  /** Agent 存活登记册（泳道表的唯一所有者）。 */
  readonly registry: AgentRegistry
  /**
   * 在**指定 scope** 上注册指挥模式效果。
   *
   * ⚠️ 会被调用两次（两条路径各一次），且其中一次发生在 `agents.resume` 的 `setup` 内
   * —— 见模块头注。调用方（服务层）负责把它交给 `ConductorRuntime.apply`。
   */
  applyConductor(sessionId: string, agentCtx: Context, mode: ConductorMode): void
}

/**
 * 解析（或冷恢复）一条 task 泳道会话。
 *
 * @param host - 宿主能力（见 {@link TaskLaneHost}）。
 * @param sessionId - task 会话 id。
 * @returns 解析结果；路径 ④（非官方 preset 且 profile 缺失）返回 `undefined`。
 */
export async function resolveTaskSession(
  host: TaskLaneHost,
  sessionId: string,
): Promise<ResolvedTaskSession | undefined> {
  const { ctx, registry } = host
  // ① 内存命中：本进程已登记（零 I/O）。
  const live = registry.task(sessionId)
  if (live !== undefined) {
    // 已是活会话 ⇒ 口径可即时算出（无需重挂 preset）。
    const mode = conductorModeForLane(live.profileId)
    return { ...live, conductor: mode }
  }
  const meta = readTaskSessionIndex()[sessionId]
  if (meta === undefined) return undefined
  // 泳道经官方对象层可能已被激活（侧栏选中/官方 sessions 收录）——此时 ctx.agents
  // 已有活 agent，直接复用，**不能再 resume**（官方 agents.resume 拒绝 live 会话：
  // 「cannot prepare session while it is live」）。
  // profileId 双源：corum profile 或官方 preset id（冷恢复官方模式泳道——
  // 官方 preset 不绑定固定模型，跟随部署默认）。
  const isOfficialPreset = meta.profileId !== TASK_PROFILE_ID && loadProfile(meta.profileId) === undefined
  const profile = meta.profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(meta.profileId)
  const conductor = conductorModeOf(
    meta.profileId,
    isOfficialPreset,
    profile === undefined ? undefined : effectiveExecutionTools(profile),
  )
  const sid0 = SessionId(sessionId)
  // ② 官方层已激活 —— 复用，不 resume。
  const activated = ctx.agents.get(sid0)
  if (activated !== undefined) {
    const entry = { agent: activated, sessionId: sid0, cwd: meta.cwd, profileId: meta.profileId }
    registry.registerTask(entry)
    host.applyConductor(sessionId, activated.ctx, conductor)
    return { ...entry, conductor }
  }
  // ④ 不可恢复：非官方 preset 且 corum profile 缺失。
  if (!isOfficialPreset && profile === undefined) return undefined
  // ③ 冷恢复：resume（历史由 persistence 加载，能力经 setup 重新组装）。
  // 在 Agent options 与绑定初始化前读真实持久化投影；没有记录才跟随全局默认。
  let session = ctx.sessions.get(sid0)
  const controller = ctx.get('sessionController')
  if (session === undefined && controller !== undefined) {
    const stored = await controller.inspect(sid0)
    session = Session.create(sid0, stored.events, stored.meta, stored.inheritedEventCount)
  }
  const resumeModel = (session === undefined ? undefined : taskModelSelectionOf(ctx, session)) ?? globalDefaultModel(ctx)
  // fork（corum）2026-09-26：冷恢复同样可能撞上「预设里的模型已被删除」——这是**确定性
  // 配置缺失**，必须在 resume 之前回落，否则恢复出来的会话每句请求都失败
  // （与创建路径同一条处置；见 model-availability.ts 的概念分界表）。
  const resumeResolved = await resolveUsableModel(ctx, {
    provider: resumeModel.provider,
    model: resumeModel.model,
    ...(resumeModel.reasoningEffort === undefined ? {} : { reasoningEffort: resumeModel.reasoningEffort }),
  })
  const resumeEffective = resumeResolved.model
  const selection: ModelSelectionRef = {
    current: {
      provider: resumeEffective.provider,
      model: resumeEffective.model,
      ...(resumeEffective.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(resumeEffective.reasoningEffort) }),
    },
    assembled: undefined,
  }
  // 官方 0.1.5：`AgentSetup` 为 `(agentCtx, agent)`，`agentCtx.agent` accessor 已删除。
  const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
    await ctx.agentPresets.mount(agentCtx, meta.profileId)
    if (resumeResolved.fallback !== undefined) agent.session.append('model/selection', resumeEffective)
    installTaskModelSelection(agentCtx, agent, selection)
    // ⚠️ 必须在 setup 内注册（组装期），不能事后补 —— 见模块头注「为什么必须在 setup 里调」。
    host.applyConductor(sessionId, agentCtx, conductor)
  }
  const agentOptions = {
    provider: resumeEffective.provider,
    model: resumeEffective.model,
    ...(resumeEffective.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(resumeEffective.reasoningEffort) }),
  }
  const sid = SessionId(sessionId)
  const handle = await ctx.agents.resume({ resumeSessionId: sid, agentOptions, setup })
  ctx.logger.info(`corum-agent(task): resumed — ${sessionId}`)
  const entry = { agent: handle.agent, sessionId: sid, cwd: meta.cwd, profileId: meta.profileId }
  registry.registerTask(entry)
  registry.setTaskSelection(sessionId, selection)
  if (resumeResolved.fallback !== undefined) {
    ctx.logger.warn(
      `corum-agent(task): resumed lane "${sessionId}" had unavailable model `
      + `${resumeResolved.fallback.configured.provider}/${resumeResolved.fallback.configured.model} `
      + `(${resumeResolved.fallback.reason}); fell back to ${resumeEffective.provider}/${resumeEffective.model}`,
    )
  }
  return { ...entry, conductor }
}

/**
 * 由 profileId 算指挥模式口径（`conductorModeOf` 的双源收敛：corum profile 或官方 preset）。
 *
 * 供**已活会话**的路径使用（无需重挂 preset，故不必走 resume 那套）。
 */
export function conductorModeForLane(profileId: string): ConductorMode {
  const isOfficialPreset = profileId !== TASK_PROFILE_ID && loadProfile(profileId) === undefined
  const profile = isOfficialPreset ? undefined : (profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(profileId))
  return conductorModeOf(profileId, isOfficialPreset, profile === undefined ? undefined : effectiveExecutionTools(profile))
}
