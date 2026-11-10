/**
 * fork（corum）2026-09-26：**预设模型的可用性回落**——「配置里写着一个已被删除的模型」
 * 与「运行期调用失败」是两个不同的概念，必须在**事前**分开处理。
 *
 * ## 由来（用户 2026-09-26 报障与定调）
 *
 * 用户删除了 `kimi-k3-1` 这个模型（原话：「这个模型是我手动删除了」），但
 * conductor-lead 预设里存的仍是它 ⇒ 每个新指挥会话都直接以
 * `UNKNOWN_MODEL: pi-ai provider "localhost" has no configured model "kimi-k3-1"` 失败
 * （实测会话 `corum-task-b36de140`：turn 1 第一句就 error，整轮什么都没干成）。
 *
 * 用户的定调（原话）：
 *
 * > 「预设的 Agent 应该同步回落到全局设置。而不是继续用一个不存在的模型。」
 * > 「我 9 月 18 日的功能主要是**在运行过程中发生的非用户删除因素**，是两个不同的概念。」
 *
 * ## 两个概念的分界（本模块只负责第一个）
 *
 * | | 何时可知 | 判据 | 处置 |
 * |---|---|---|---|
 * | **A. 配置里引用的模型已不存在**（用户删除 / 改名） | **派发前**，确定性 | 适配器查不到该 `provider/model` | **静默修复不了就回落全局默认，并显式告知**（本模块） |
 * | **B. 运行期调用失败**（限流 / 超时 / 额度 / 服务端错） | 只能在跑的时候知道 | `stopReason === 'error'` 等 | **问用户**（用户 2026-09-18 拍板：临时换 / 永久换 / 停止委派）——**语义不变，不在本模块** |
 *
 * 子 Agent 的 B 类通路（`corumAskAboutModel`）保持原样；本模块只保证 **A 类在委派前就被
 * 识别**，不把它混进「跑一次失败了再问」。
 *
 * ## 为什么必须在校验点**回落**而不是只报错
 *
 * 预设是用户的配置意图；模型的**存在性**是部署事实。用户删模型是合法操作（换供应商、
 * 清理目录），此时「继续用」不可能成立，而「硬失败」把用户挡在门外且不给下一步
 * ——回落全局默认是部署已经表达过的、当前有效的意图（`agentDefaultModel`）。
 *
 * @module @corum/corum-agent/model-availability
 */

import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ProfileModel } from './profile.ts'

/**
 * fork（corum）：本包自己的消息来源种类（`MessageSourceMap` 是**可合并扩展**的和类型，
 * 官方明确「没有共享的 catch-all `plugin` 种类」——每个生产者在自己的模块里声明自己的
 * `kind`，消费方对未知种类回落）。
 *
 * 与 `@corum/corum-subagent` 的 `'subagent-settled'` 同款做法（它声明在
 * `continuation.ts` 的 `declare module '@deepseek-ai/dsh-llm'` 块里）。本类用于把
 * 「预设模型已不可用 ⇒ 本次改用全局默认」这件事**可见地**投给用户。
 */
export interface ModelFallbackMessageSource {
  readonly kind: 'corum-model-fallback'
  /** 一行摘要（不展开行也能读到的结论）。 */
  readonly form: 'notice'
  /** 一行说明，已按 `CONTEXT_SUMMARY_MAX_CHARS` 截断。 */
  readonly summary: string
  /** 触发本次回落的位置（如「新建任务（指挥模式）」），用于让用户知道是哪来的。 */
  readonly origin: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'corum-model-fallback': ModelFallbackMessageSource
  }
}

/**
 * `ctx.llm` 的**最小能力面**：只需「能不能解析出这个精确模型的元数据」。
 *
 * 按需取（`ctx.get('llm')`）而不是硬注入：本模块的消费点（含 task-lane 的纯函数路径）
 * 有的拿不到完整注入面，且 llm 缺席时的正确行为是「不校验、原样透传」（见
 * {@link resolveUsableModel}），不是抛错。
 */
export interface ModelResolverFace {
  /**
   * 解析一个精确模型路由的元数据；模型/provider 不存在时**抛错**。
   * @param provider - 供应商路由 id。
   * @param model - 精确 model id。
   * @param signal - 可选取消信号。
   */
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown>
}

/** 一次回落的事实（供调用方告知用户 / 记日志）。 */
export interface ModelFallback {
  /** 配置里写的、但当前不可用的路由。 */
  readonly configured: ProfileModel
  /** 实际生效的落地路由（= 全局默认）。 */
  readonly effective: ProfileModel
  /** 人可读的不可用原因（来自适配器的错误消息）。 */
  readonly reason: string
}

/** 解析结果：生效路由 + 可选的回落事实（无回落时 `fallback` 缺席）。 */
export interface UsableModelResolution {
  /** 实际应当使用的路由。 */
  readonly model: ProfileModel
  /** 发生了回落时给出事实；未回落时 `undefined`。 */
  readonly fallback?: ModelFallback
}

/** 把一个 `ModelSelection` 形状（provider/model/reasoningEffort 皆必填 provider/model）转成 `ProfileModel`。 */
function toProfileModel(selection: { provider: string; model: string; reasoningEffort?: string }): ProfileModel {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

/**
 * 取全局默认模型（回落目标）。**这是回落语义的单一事实源**：预设没配（或配的不可用）
 * 时用哪个模型，永远由这里回答，不在调用点各写一份。
 * @param ctx - 承载 `agentDefaultModel` 服务的上下文。
 * @returns 全局默认路由。
 * @throws 当服务缺席时（属装配错误：`corum-agent` 的 inject 表已声明它必在）。
 */
export function globalDefaultModel(ctx: Context): ProfileModel {
  return toProfileModel(ctx.agentDefaultModel.currentSelection())
}

/**
 * 取一个 profile 的**生效模型**：`profile.model` 存在就用它，缺失则回落全局默认。
 *
 * ## 为什么需要它（2026-11-03 实机事故）
 *
 * 扩展包装进来的预设（如 `corum-dev`）的 `agent.json` 可能**不带 `model` 字段**
 * ——设计意图是「靠运行期跟随全局默认」。`AgentProfile.model` 在类型上是必填，
 * 但 `loadProfile` 是 `JSON.parse` 直读盘、**不做 schema 校验**，于是缺 model 的
 * 预设会以 `profile.model === undefined` 进入运行期。
 *
 * `listProfilesRemote` 已对此做了回填防御，但**创建/切换/resume 路径**
 * 直接读 `profile.model` 不防御 ⇒ `resolveUsableModel(ctx, undefined)` 读
 * `configured.provider` → `Cannot read properties of undefined (reading 'provider')`
 * （实测报障：安装 corum-dev-preset 扩展包后选内置 Agent 预设即崩）。
 *
 * 本函数是**所有创建/切换/resume 路径的统一回填点**，与 `listProfilesRemote` 口径一致。
 *
 * @param ctx - 承载 `agentDefaultModel` 的上下文。
 * @param model - profile 的 model 字段（可能缺失）。
 * @returns 一定非 undefined 的 `ProfileModel`。
 */
export function effectiveProfileModel(ctx: Context, model: ProfileModel | undefined): ProfileModel {
  return model ?? globalDefaultModel(ctx)
}

/**
 * 校验一个配置路由当前是否可用；不可用则**回落到全局默认**。
 *
 * 语义（都是刻意的）：
 * - `llm` 服务缺席 ⇒ **不校验**、原样透传。理由：没有 llm 就无从判断，此时「猜着回落」
 *   会静默改掉用户配置且无法解释；宁可按配置走，让真实错误在它自己的层报出来。
 * - 配置路由可用 ⇒ 原样返回（**绝不**因为「全局默认更保险」而改掉用户的选择）。
 * - 配置路由不可用 ⇒ 返回全局默认 + {@link ModelFallback} 事实。**若全局默认本身也解析不了，
 *   仍然回落到它**（它是部署的最终意图；把两个错误叠起来只会更难懂），事实里的 `reason`
 *   只描述「配置的那个为什么不行」。
 *
 * @param ctx - 承载 `llm` / `agentDefaultModel` 的上下文。
 * @param configured - 配置里写的路由（预设的 `model`，或调用方显式传入的模型）。
 * @param signal - 可选取消信号。
 * @returns 生效路由与可选回落事实。
 */
export async function resolveUsableModel(
  ctx: Context,
  configured: ProfileModel,
  signal?: AbortSignal,
): Promise<UsableModelResolution> {
  const llm = ctx.get('llm') as ModelResolverFace | undefined
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    // 无从校验：按配置走（见上方语义）。
    return { model: configured }
  }
  try {
    await llm.resolveModelInfo(configured.provider, configured.model, signal)
    return { model: configured }
  } catch (error: unknown) {
    const effective = globalDefaultModel(ctx)
    // 配置的就是全局默认本身（用户把已删模型也设成了全局默认）⇒ 没有可回落的目标，
    // 原样返回让真实错误在请求层报出，并给出事实供调用方解释。
    const sameAsDefault = effective.provider === configured.provider && effective.model === configured.model
    return {
      model: sameAsDefault ? configured : effective,
      fallback: {
        configured,
        effective: sameAsDefault ? configured : effective,
        reason: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * 回落事实的**用户可见文案**（会话内通知 / 表单提示共用一份）。
 *
 * 措辞纪律（2026-09-16 `process.prompt.promise-vs-mechanism` 的教训）：只说**已发生**的事实，
 * 不承诺后续行为。故不写「已为你永久修改预设」之类——本机制**不改**用户配置。
 * @param fallback - 回落事实。
 * @param source - 触发回落的位置（用于让用户知道是哪个 Agent / 哪次创建）。
 * @returns 一行摘要 + 一段可展开说明。
 */
export function modelFallbackNotice(fallback: ModelFallback, source: string): { summary: string; text: string } {
  const configured = `${fallback.configured.provider}/${fallback.configured.model}`
  const effective = `${fallback.effective.provider}/${fallback.effective.model}`
  return {
    summary: `已换用全局默认模型：${configured} 已不可用`,
    text: [
      `${source} 配置的模型 **${configured}** 当前不可用（${fallback.reason}），本次改用全局默认模型 **${effective}**。`,
      '',
      '原因通常是该模型已被删除或改名。**你的预设配置没有被改动**——若希望这个 Agent 长期使用别的模型，请在「设置 → 智能体」里改它的模型，或改全局默认模型。',
    ].join('\n'),
  }
}

export { toProfileModel as profileModelOfSelection }

/**
 * 把回落事实投给用户（会话内可见）。
 *
 * ## 为什么用 `agent.inject` 而不是 `followup`
 *
 * `followup` 会**开一个新 turn**（跑一轮模型）；`inject` 的官方语义是
 * 「Queue model-facing context for the next pre-step **without waking the driver**」。
 * 本通知必须走 `inject`，因为调用点常在「会话刚建好、还没发过消息」的时刻，而
 * `findBlankTaskLane` 判 blank 的判据正是「**无 `turn/start`**」（lane-registry.ts）——
 * 用 `followup` 会把泳道变成非 blank，直接复活「连点新建堆一串空会话」那个已修的缺陷。
 *
 * 副作用（已知并接受）：通知停在 inbox 里，用户**第一句发出去时**它随 pre-step 一并
 * 进入模型上下文，UI 上也就在那一刻可见。这与「静默换掉用户的模型」相比是可接受的代价
 * ——用户 2026-09-26 明确选「回落 + 显式告知」。
 *
 * 投递失败只告警，绝不因此让建会话失败（可见性是增强，不是前置条件）。
 *
 * @param agent - 目标会话的 Agent（必须是活会话）。
 * @param fallback - 回落事实。
 * @param origin - 触发本次回落的位置描述。
 * @param logger - 告警出口。
 */
export function deliverModelFallbackNotice(
  agent: { inject: (message: ReturnType<typeof createUserMessage>) => void },
  fallback: ModelFallback,
  origin: string,
  logger: { warn: (message: string) => void },
): void {
  try {
    const notice = modelFallbackNotice(fallback, origin)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: notice.text }],
      source: {
        kind: 'corum-model-fallback',
        form: 'notice',
        summary: boundContextSummary(notice.summary),
        origin,
      },
    }))
  } catch (error: unknown) {
    logger.warn(`model fallback notice was not delivered: ${String(error)}`)
  }
}
