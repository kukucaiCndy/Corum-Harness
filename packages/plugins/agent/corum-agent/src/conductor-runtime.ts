/**
 * fork（corum）：**指挥模式运行时**——从 `agent-service.ts` 按关注点抽出（2026-09-20）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在
 * 文件层面切分清晰**，方便维护。」
 *
 * 指挥模式是**一整个关注点**：它持有两张按 sessionId 索引的内存表、在 5 处被调用
 * （创建 / 恢复 / 切 preset / 复用泳道），并且是**权限约束的声明方**。把它与
 * 「权限档位」放在同一个类里，正是 2026-09-20 那个漏洞的结构性成因：
 *
 * > `applyTaskPermission`（写用户档位）与 `applyConductorMode`（写模式只读）
 * > 相隔 74 行、各自写同一份会话沙箱、**互不知情**，而沙箱是 last-write-wins
 * > ⇒ 谁最后写谁赢 ⇒ 用户切「完全权限」5 秒内即覆盖只读。
 *
 * 抽出后两者的边界变成**显式接口**：本模块只声明「指挥模式要求什么」，
 * 不碰权限状态；权限由 `permission-policy.ts` 的合成规则裁决。
 *
 * ## 状态归属
 *
 * 两张表随本模块一起搬走（原先挂在 `CorumAgentService` 上）：
 * - `modes`：sessionId → 生效形态（`off` / `profile` / `preset`）
 * - `effects`：sessionId → 撤销器（切出指挥模式 / 切 preset 时先撤销上一次注册）
 *
 * ⚠️ **纯内存，不落盘**。因此**不得**用于决定任何需要跨重启稳定的事实——
 * 实测教训：子 Agent 人格曾因本表在宿主重启后为空而整段漏替换（见
 * `docs/PENDING-conductor-readonly-bash-and-progressive-research.md`）。
 *
 * @module @corum/corum-agent/conductor-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
// 空类型 import：让 `ctx.tools` 的 Context 合并生效（`ToolRuntime` 由
// @deepseek-ai/dsh-tools 声明为 cordis 的 ambient augmentation）。
// ⚠️ 这条 import **不是装饰性的**：本文件用了 `agentCtx.tools.restrict` / `.guard`，
// 但「谁把 dsh-tools 拉进 program」原本是**邻居文件**在承担 —— 剥离前同包的
// runtime.ts / project-data-service.ts 各有一行 `import { defineTool } from
// '@deepseek-ai/dsh-tools'`（值导入），靠 tsconfig 的 `include: ["src"]` 把增强带进来。
// 这两个文件被删后，program 里再无任何文件引用 dsh-tools ⇒ 增强不生效 ⇒
// `TS2339: Property 'tools' does not exist on type 'Context'`（实测两处：
// `restrict` / `guard`）。故改为**本文件自证**依赖，不再依赖邻居的偶然引用。
import type {} from '@deepseek-ai/dsh-tools'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { corumNarrowDenyFilter, corumVisibleToolNames } from '@corum/corum-orchestration'
import {
  CONDUCTOR_PERSONA,
  CONDUCTOR_RESEARCH_MISSING_SECTION,
  CONDUCTOR_RESEARCH_MISSING_TEXT,
  CONDUCTOR_SECTION,
  CONDUCTOR_STALE_SECTIONS,
  conductorExecutionDeny,
  type ConductorMode,
} from './conductor.ts'
import { conductorMainReadonlyGuard } from './permission-policy.ts'
import { TOOL_POLICY_SECTION } from './tool-policy.ts'

/**
 * fork（corum）2026-11-16：指挥模式机制故障的消息来源种类（与 `ModelFallbackMessageSource`
 * 同款做法——`MessageSourceMap` 是可合并扩展的和类型，每个生产者在自己的模块里声明自己的
 * `kind`，消费方对未知种类回落）。
 *
 * 用于把「内置调研子 Agent `subagent_research` 未能注册」这件事**可见地**投给用户。
 */
export interface ConductorFaultMessageSource {
  readonly kind: 'corum-conductor-fault'
  readonly form: 'notice'
  readonly summary: string
  readonly origin: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'corum-conductor-fault': ConductorFaultMessageSource
  }
}

/**
 * `agent.inject` 的最小能力面（与 `deliverModelFallbackNotice` 同款收窄）。
 *
 * `ConductorRuntime.apply` 只拿到 `agentCtx`（Context），但用户可见通知走
 * `agent.inject(createUserMessage(...))`（与模型回落告知同通道：不开 turn、
 * 随 pre-step 进入模型上下文）。调用方在拥有 `agent` 对象时传入本面；
 * `agent/created` 钩子路径尚拿不到 agent ⇒ 传 `undefined` ⇒ 只走 logger + 段注册。
 */
interface AgentInjectFace {
  readonly inject: (message: ReturnType<typeof createUserMessage>) => void
}

/** 调研内置 Agent 缺席时的用户可见通知文案（会话内可见，与模型回落同通道）。 */
const RESEARCH_MISSING_NOTICE_SUMMARY = '内置调研子 Agent subagent_research 未能注册——指挥模式调研能力受损'
const RESEARCH_MISSING_NOTICE_TEXT = [
  '⚠️ **机制故障**：内置调研子 Agent `subagent_research` 未能注册到本会话。',
  '',
  '指挥模式的调研能力受损——这不是降级模式，而是机制故障。',
  '请重启应用或重新打包/反馈，使该内置 Agent 恢复注册。',
].join('\n')

/**
 * 把调研内置 Agent 缺席的故障告知用户（会话内可见）。
 *
 * 复用 `deliverModelFallbackNotice` 的同一通道：`agent.inject(createUserMessage(...))`。
 * 与模型回落告知同理：不开 turn（泳道仍 blank 可复用），随 pre-step 进入模型上下文。
 * 投递失败只告警，不中断 apply（可见性是增强，不是前置条件）。
 *
 * @param agent - 目标会话的 Agent（inject 能力面）。
 * @param logger - 告警出口。
 */
function deliverResearchMissingNotice(agent: AgentInjectFace, logger: { warn: (m: string) => void }): void {
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: RESEARCH_MISSING_NOTICE_TEXT }],
      source: {
        kind: 'corum-conductor-fault',
        form: 'notice',
        summary: boundContextSummary(RESEARCH_MISSING_NOTICE_SUMMARY),
        origin: '指挥模式（research 缺席）',
      },
    }))
  } catch (error: unknown) {
    logger.warn(`conductor research-missing notice was not delivered: ${String(error)}`)
  }
}

/**
 * 指挥模式的运行时状态机（每个 `CorumAgentService` 持有一个实例）。
 *
 * 只负责「主 Agent 自己的 scope 上注册什么」与「何时撤销」。它**不写权限状态**：
 * 主 Agent 的只读约束由 `tools.guard` 表达（单调、不可被用户操作覆盖），
 * 而用户选的档位仍由权限层如实记录（worker 子 Agent 要读它）。
 */
export class ConductorRuntime {
  /** sessionId → 撤销器（切出指挥模式或切 preset 时先撤销上一次注册）。 */
  private readonly effects = new Map<string, () => void>()

  /** sessionId → 当前生效形态。 */
  private readonly modes = new Map<string, ConductorMode>()

  /** 该会话此刻是否处于指挥模式（供 `corumConductor` 服务消费）。 */
  isConductor(sessionId: string): boolean {
    return (this.modes.get(sessionId) ?? 'off') !== 'off'
  }

  /**
   * 生效/撤销指挥模式（幂等：同一 sessionId 再次调用先撤销上一次注册）。
   *
   * 在原 `agent-service.ts` 的注释里保留的三条理由仍然成立（此处重述要点）：
   *   ① 为什么在**运行时**裁而不是 preset 里裁——preset 的 standing mount 是所有 join
   *      它的 Agent（含子 Agent）的父 scope，scope 链上的 restriction 会把子 Agent 一起
   *      裁掉（实机证实，见 PLAN-deepseek-orchestrator-agent §3.2 路线 B）。故只在**主
   *      Agent 自己的 scope** 注册，子 Agent 不受影响；
   *   ② deny 名单必须按该 scope **真实可见**的工具名收敛（`corumNarrowDenyFilter` +
   *      `corumVisibleToolNames`）——`tools.restrict()` 对未知名 fail-loud，而
   *      `str_replace_editor` 只在挂 str-replace-editor 行的 preset 里存在
   *      （2026-09-10 官方三模式全崩的根因，见 docs/LESSONS.md §6.18）；
   *   ③ 撤销器按 sessionId 存内存表，**不落盘**（blank 泳道切换 Agent 时口径必须跟随
   *      新 preset，不能残留旧限制）。
   *
   * @param sessionId - 泳道 id（撤销键）。
   * @param agentCtx - 主 Agent 的 scoped 创建/存活上下文。
   * @param mode - 生效形态（`off` / `profile` / `preset`）。
   * @param agent - 主 Agent 的 inject 能力面（可选；用于用户可见通知）。
   *   `agent/created` 钩子路径尚拿不到 agent ⇒ 传 `undefined` ⇒ 只走 logger + 段注册。
   */
  apply(sessionId: string, agentCtx: Context, mode: ConductorMode, agent?: AgentInjectFace): void {
    const previous = this.effects.get(sessionId)
    if (previous !== undefined) {
      this.effects.delete(sessionId)
      previous()
    }
    this.modes.set(sessionId, mode)
    if (mode === 'off') return
    const disposers: Array<() => void> = []
    // 指挥者没有 write/edit/bash 之外的写通路：工具策略段（「用专用工具而不是 bash」）
    // 对它只会误导，用空文本覆盖（与 CONDUCTOR_STALE_SECTIONS 清 tool:write/tool:edit 同一手法）。
    disposers.push(agentCtx.systemPrompt.section({
      name: TOOL_POLICY_SECTION,
      order: agentCtx.systemPrompt.getSectionOrder('TOOL_BASH') - 50,
      text: '',
    }))
    // ⚠️ 只算一次 visible names（复用于 deny 收敛 + research 在场保证，不重复调用）。
    const visibleNames = corumVisibleToolNames(agentCtx)
    const deny = corumNarrowDenyFilter(
      { deny: conductorExecutionDeny() },
      visibleNames,
    )
    if (deny?.deny !== undefined && deny.deny.length > 0) disposers.push(agentCtx.tools.restrict({ deny: deny.deny }))
    for (const staleToolSection of CONDUCTOR_STALE_SECTIONS) {
      disposers.push(agentCtx.systemPrompt.section({
        name: staleToolSection,
        order: agentCtx.systemPrompt.getSectionOrder('TOOL_WRITE'),
        text: '',
      }))
    }
    // ── fork（corum）2026-11-16：内置调研 Agent 在场保证 ──────────────────────────
    // 用户决策：「机制必须保证 hasResearch，如果没有应该是报错提醒，而不是兜底。
    // researchAgent 作为内置 Agent 必须起效。」
    //
    // 在场判据：`subagent_research` ∈ visibleNames（与机制段 `hasResearch` 同一口径）。
    // 缺席时三件事（均非中断、非兜底）：
    //   a. host 侧 ERROR log（sessionId + 可见工具名 + 明确消息）；
    //   b. 用户可见 ERROR 通知（agent.inject，与模型回落同通道——调用方传了 agent 才发）；
    //   c. ERROR 系统提示词段（告诉模型机制故障、向用户报告、不要静默兜底）。
    // 段撤销器进 disposers（切出模式 / 切 preset 时随撤销）。
    const hasResearch = visibleNames.has('subagent_research')
    if (!hasResearch) {
      const visibleList = [...visibleNames].join(', ')
      agentCtx.logger.error(
        `conductor-runtime: built-in research Agent "subagent_research" failed to register`
        + ` (sessionId=${sessionId}, mode=${mode}, visibleTools=[${visibleList}]).`
        + ` This is a mechanism fault — research capability is broken for this session.`,
      )
      if (agent !== undefined) {
        deliverResearchMissingNotice(agent, agentCtx.logger)
      }
      disposers.push(agentCtx.systemPrompt.section({
        name: CONDUCTOR_RESEARCH_MISSING_SECTION,
        order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 2,
        text: CONDUCTOR_RESEARCH_MISSING_TEXT,
      }))
    }
    // 基准模式（preset）追加指挥者角色段——部署人格（persona 行）保留；
    // orchestrator profile 的人格来自它自己的 preset（persona 行），不再追加（否则重复）。
    //
    // **顺序语义（用户裁决 2026-09-29）**：指挥模式是**与 standard 平级的 5 个基本模式之一**
    // ⇒「你是指挥者」是**该模式的身份**，不是附加说明 ⇒ 必须紧跟在基础身份之后（`PREFIX + 1`），
    // 让模型先看到「你是编码 agent」再看到「你是指挥者」，两者连成一段身份。
    // ⚠️ 不要用 `DEPLOYMENT_PERSONA_SUFFIX`（=10200）：那是官方留给「部署/本机附加信息」的位置，
    // 在全部工具说明之后；指挥者身份放那里会把身份甩到提示词最末尾（已实测确认过该差异）。
    // 0.1.5 里 `dsh-persona` 已把 persona 拆成 prefix(0) + suffix(10200) 两段，旧 `DEPLOYMENT_PERSONA` 已删。
    if (mode === 'preset') {
      disposers.push(agentCtx.systemPrompt.section({
        name: CONDUCTOR_SECTION,
        order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
        text: CONDUCTOR_PERSONA,
      }))
    }
    /**
     * ⚠️ **只读约束走 agent-scoped 门禁，不再碰沙箱**（2026-09-20 实测漏洞修复）。
     *
     * 早先实现是在这里 append 一条 `sandbox/mode: read-only`。**那是错的** —— 它让本方法与
     * `applyTaskPermission` 成为**同一份会话沙箱的两个无协调写入者**，而沙箱投影是
     * last-write-wins（`sandbox-policy/src/index.ts:137`）⇒ 谁后写谁赢。实测用户切
     * 「完全权限」5 秒内即覆盖只读（会话 `corum-task-e72b1a8f`），全会话普查 conductor
     * 会话 read-only **存活 0 次** —— 护栏实际上从未生效。
     *
     * 现在：约束放在 guard 上（单调、不可覆盖），且因注册在 `agentCtx` 上而**不泄漏给
     * 子 Agent** ⇒ 用户选的完全权限对 worker 依然生效（用户定调的分档）。
     */
    disposers.push(agentCtx.tools.guard(conductorMainReadonlyGuard()))
    this.effects.set(sessionId, () => { for (const dispose of disposers) dispose() })
  }

  /** 撤销某会话的指挥模式效果（用于服务销毁 / 测试清理）。 */
  dispose(sessionId: string): void {
    const previous = this.effects.get(sessionId)
    if (previous === undefined) return
    this.effects.delete(sessionId)
    previous()
  }
}
