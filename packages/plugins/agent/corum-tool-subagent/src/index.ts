/**
 * fork（corum）：模型面召唤工具的 corum 版——execute 隔离层（写任务自动建
 * git worktree+分支、deny str_replace_editor、会话级台账、maxParallelChildren
 * 上限）、integrate 编排（集成者 persona + 固定 checks + settle 后清理，骨架
 * 阶段仅前台路径）、模型锁（config.model 作为终值注入、schema 剔除 LLM 自主
 * 选模型参数）、readonlyResearch 只读研究实例语义。其余与官方逐行一致。
 * 原始模块：@deepseek-ai/dsh-tool-subagent。
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Foreground calls always dispose the run after collection.
 * Background policy is selected by this plugin's configuration: one-shot
 * calls own a plain Task, while continuable calls use
 * `ctx.subagents.startContinuable()`.
 * @module @deepseek-ai/dsh-tool-subagent
 */

// fork（corum）：worktree 隔离层用 Node fs/path/crypto/child_process。
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { carrierKeyOf, scopeChainOf, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import {
  assertSubagentMaxDepth,
  parentAgentOptionsForDelegation,
  settleRun,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
// fork（corum）：orchestrate 任务级结构化输出（吸收 workflow 的 agent({schema}) 语义）。
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
import type { DelegationModelRequest, ModelSelectionPolicy } from './model-selection.ts'
import { registerListSubagentModels } from './list-models.ts'
import { resolveChildModel } from './child-model-resolution.ts'
import {
  corumAskAboutModelFailure,
  corumAskAboutModelUnlessStale,
  corumDelegationPolicyStateFrom,
  type CorumModelAskChannel,
  type CorumModelCatalog,
  type CorumProfileWriteFace,
  type CorumRoute,
} from './model-ask-run.ts'
import type {} from './model-selection-settings.ts'
import {
  recordSubagentModelSelection,
  subagentModelSelectionProjectionDefinition,
  subagentModelSelectionPolicy,
} from './model-selection-state.ts'
// fork（corum）：隔离编排纯函数从 orchestration.ts 引入（含 re-export 到下游）。
import {
  CorumOrchestration,
  corumCleanupWorktree,
  corumDetectIntegrateChecks,
  corumDirectWriteNotice,
  corumEffectiveToolFilter,
  corumGit,
  corumGitHead,
  corumGitStatusPorcelain,
  corumIntegrationFailure,
  corumIntegrationTruth,
  CorumIntegrateRejected,
  // fork（corum）2026-09-16：机制侧 verify 门禁——「集成成功」= git 实况 ∧ 声明式 verify
  // 退出码 0（根因：真值门禁只判 git，集成者用 `git merge` 时合并提交自己就进了 HEAD，
  // verify 失败被盖过，机制对外报「merged + committed」）。
  corumIntegrationVerdict,
  corumVerifyFailureNotice,
  corumResolveRejectedIntegration,
  CORUM_INTEGRATE_VERIFY_TIMEOUT_MS,
  corumPortPendingBranches,
  corumIntegratorPersona,
  // fork（corum）2026-10：编排收尾节点（closer）——黑盒化后整次编排统一结算的那一个角色。
  corumCloserPersona,
  corumOrchestrateReportPath,
  corumWriteOrchestrateReport,
  // fork（corum）2026-10 修复②：closer 成功后按台账实况作废「待集成」类内部说明。
  corumDropResolvedIntegrationNotes,
  // fork（corum）2026-10 修复③（B 方案）：单个 research 子 Agent 的报告落盘。
  corumResearchReportPath,
  corumWriteReportFile,
  corumIsGitRepo,
  corumIsolationBoundaryNotice,
  corumIsolationNotice,
  corumIsWriteTask,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumPartialIntegrationNotice,
  corumMutationToolsForPlatform,
  // fork（corum）2026-09-20：集成判定改「按条目」+ 分支 tip 快照——修「集成成功却判
  // 未落地」（集成者 merge 后合规 `branch -D`，按分支名判定假阴）。
  corumSnapshotBranchTips,
  corumBranchTip,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumBranchAddsCommits,
  corumReconcileIntegrated,
  corumMergedBranches,
  corumPendingIntegration,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumVisibleToolNames,
  corumWriteToolsForPlatform,
} from './orchestration.ts'
import type { CorumWorktreeEntry, CorumWorktreeLedgerFrame } from './orchestration.ts'

/**
 * fork（corum）：`CorumIntegrateRejected` 带集成者子会话 id 的形态。
 *
 * 官方 `SubagentSettledMessageSource.senderSessionId` = "Session id of the child that
 * settled"。集成失败时（verify 拒绝 / unmerged），集成者子会话已 settle、其 id 是该
 * notice 的 senderSessionId。`CorumIntegrateRejected` 类（在 corum-orchestration 包）
 * 不携带 runId，故在抛出点用交叉类型把 `String(run.id)` 挂上，catch 侧读出。
 */
type CorumIntegrateRejectedWithRun = CorumIntegrateRejected & { runId?: string }

export const name = 'corum-tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections']

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Sample the Host `subagent-model-selection` user setting for each new
   * top-level session and inherit that decision in its child sessions.
   */
  modelSelectionSettings?: boolean
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean
  /**
   * Background execution policy (default `one-shot`). `one-shot` defaults calls
   * to foreground; `continuable` defaults them to background, requires a provider
   * with the `prepareContinuable` capability, and returns the durable child id.
   * Follow-up adapters remain independently optional.
   */
  backgroundMode?: 'one-shot' | 'continuable'
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Per-child persona that shadows `deployment:persona`. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Maximum child depth: a non-negative safe integer (default `3`; `0` forbids
   * delegation entirely), or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment.
   */
  maxDepth?: number | 'provider-managed'
  // 2026-09-21 裁定：`isolation` / `integrateChecks` / `merger` 三键已从本接口与 schema
  // 剔除——隔离与合并机制恒定生效（调用点固化常量），不允许 preset 覆盖。存量 preset
  // yaml 里的旧键忽略不迁移（宽松处理：schema 不再声明，读到时丢弃）。
  /** fork（corum）：research 实例语义——本实例为只读研究实例（预 deny 写工具、不隔离）。 */
  readonlyResearch?: boolean
  /** fork（corum）：会话级并行子 Agent 上限（默认 4；超限拒绝新召唤）。 */
  maxParallelChildren?: number
  /** fork（corum）：子 Agent 固定模型路由（机制锁；缺省=跟随父）。 */
  model?: { provider: string; model: string; reasoningEffort?: string }
  /**
   * fork（corum）2026-10-11：预设**显式**选了「跟随主 Agent」（= profile 的
   * `subagentModel: 'follow-main'`）。与「不写 model 键」同形，必须靠本标志区分：
   *   · 未设 + 无 model 键 = 不覆盖 ⇒ 走全局 `corum-subagent` 默认档；
   *   · true + 无 model 键 = 显式跟随主 Agent ⇒ **跳过**全局档。
   */
  modelFollowMain?: boolean
}

// ── fork（corum）：`corum-subagent` 全局设置面（三级配置第一级）──────────────────
//
// 2026-09-18：声明（namespace + 形 + schema）与「取 scope」逻辑抽到
// `settings-namespace.ts`，供**两个装配时机**共用——`settings-registrar.ts`（boot 常驻行）
// 与下面的 `apply()`（按会话挂载的工具实例）。抽出的必要性见该文件头注释（避免把 100KB
// 工具实现内联进 registrar、避免模块级单例被复制成两份）。
import {
  acquireCorumSubagentSettingsScope,
  CORUM_SUBAGENT_SETTINGS_NAMESPACE,
  CORUM_SUBAGENT_SETTINGS_SCHEMA,
  type CorumSettingsProviderFace,
  type CorumSubagentGlobalSettings,
  type CorumSubagentGlobalSettingsScope,
} from './settings-namespace.ts'

// 保持对外导出面不变（此前这些名字直接定义在本文件，外部/测试可能引用）。
export {
  CORUM_SUBAGENT_SETTINGS_NAMESPACE,
  CORUM_SUBAGENT_SETTINGS_SCHEMA,
  type CorumSubagentGlobalSettings,
} from './settings-namespace.ts'

/** 双实例共享的全局设置 scope（先注册者持有；模块级单例防同 namespace 重复注册）。 */
let corumGlobalSettingsScope: CorumSubagentGlobalSettingsScope | undefined

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelectionSettings: z.boolean().default(false),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string
    model: string
    reasoningEffort: ReturnType<typeof ReasoningEffortId>
    maxTokens: number
  }),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
  // fork（corum）：研究/并行/模型锁字段保留 omission（不写默认物化）。
  // （2026-09-21：`isolation` / `integrateChecks` / `merger` 已随机制恒定生效剔除。）
  readonlyResearch: z.boolean().default(undefined as unknown as boolean),
  maxParallelChildren: z.natural().max(Number.MAX_SAFE_INTEGER).default(undefined as unknown as number),
  model: z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string().min(1).default(undefined as unknown as string),
  }).default(undefined as unknown as { provider: string; model: string; reasoningEffort: string }),
  // fork（corum）2026-10-11：预设显式选了「跟随主 Agent」（跳过全局兜底档）。
  // 与「不写 model 键」同形时**必须**靠本标志区分（见 profile.ts 的 FOLLOW_MAIN）：
  //   · modelFollowMain 未设 + 无 model 键 = 不覆盖 ⇒ 走全局档；
  //   · modelFollowMain: true + 无 model 键 = 显式跟随主 Agent ⇒ **跳过**全局档。
  modelFollowMain: z.boolean().default(undefined as unknown as boolean),
})

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    // Product providers aggregate startup and rollback failures. Cancellation
    // must not turn a failed cleanup into a cleanly killed Job.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append provider-authored failure detail and the child's preserved partial
 * answer to a stop-reason error, keeping diagnostic text separate from the
 * child's assistant output.
 * @param error - the stop-reason headline.
 * @param result - the child's terminal result.
 * @returns the headline, diagnostic, and partial text that are present.
 */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined
    ? ''
    : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const partial = text.length === 0
    ? ''
    : `\nPartial output before the run ended:\n${text}`
  return `${error}${diagnostic}${partial}`
}

/**
 * fork（corum）2026-09-18：机制提问/续跑的**超时上限**。
 *
 * 为什么必须自己设时限：官方 `userQuestions.ask()` **没有内建超时**——用户既不回答也不点
 * 取消时它会一直等。本机制跑在子 Agent 失败之后的收尾路径上，无限挂住会让父会话永远等不到
 * 「接下来该干什么」。超时后按 `ASK_ABORTED` 走「不改变现状」的保守降级
 * （见 `model-ask-run.ts`），并如实通知用户机制没能问到——绝不替用户做主。
 */
export const CORUM_ASK_TIMEOUT_MS = 5 * 60 * 1000

// ── fork（corum）：一次性子 Agent 失败后的「智能续跑」─────────────────────────
//
// 一次性子 Agent 失败后 session 写句柄已 close，无法 coldResume。但事件已持久化，
// 可以**读出它做了什么**，把关键上下文注入到新子 Agent 的 prompt 里——新子 Agent
// 「接着做」而非「从头做」，避免重复调用工具、丢失关键决策。

/** 从失败子 Agent 提取的可续跑上下文。 */
interface CorumFailedChildContext {
  /** 原始任务目标（第一条 user message 的文本）。 */
  readonly originalTask: string
  /** 最后一轮 assistant 的非空输出（已完成的工作摘要）。 */
  readonly lastOutput: string | undefined
  /** 最新的 todo 计划（未完成的步骤）。 */
  readonly todos: readonly { content: string; status: string }[] | undefined
  /** 失败原因（turn/end 的 stopReason）。 */
  readonly stopReason: string | undefined
}

/** `ctx.sessionQuery` 的窄能力面（红线 3）。 */
interface CorumSessionQueryFace {
  observeSession(
    id: SessionId,
    options: { signal?: AbortSignal },
  ): Promise<{ events: readonly SessionEvent[]; inheritedEventCount: number }>
}

/**
 * 从失败子 Agent 的持久化 session 提取可续跑上下文。
 *
 * 读子 Agent 自己的事件后缀（跳过 seed 前缀），用 `foldConsumedWork` 找最后
 * 一轮的 turn/end（拿 stopReason），用 `finalAssistantOutput` 拿最后的 assistant
 * 输出，从 `tool/call` 里提取 todo 状态。
 *
 * @param ctx - host context（取 sessionQuery）。
 * @param childSessionId - 失败子 Agent 的 session id。
 * @param signal - 取消信号。
 * @returns 提取的上下文；session 不存在/读失败时返回 undefined（退化为盲重跑）。
 */
async function corumExtractFailedChildContext(
  ctx: Context,
  childSessionId: string,
  signal: AbortSignal,
): Promise<CorumFailedChildContext | undefined> {
  const query = ctx.get('sessionQuery') as unknown as CorumSessionQueryFace | undefined
  if (query === undefined) return undefined
  try {
    const observation = await query.observeSession(childSessionId as SessionId, { signal })
    const events = observation.events
    const own = events.slice(observation.inheritedEventCount)

    // 原始任务 = 第一条 user/message 的文本内容
    let originalTask = ''
    for (const event of own) {
      if (event.type === 'user/message') {
        const content = (event.data as { content?: readonly ContentBlock[] }).content
        if (content !== undefined) {
          originalTask = content
            .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
            .map(b => b.text)
            .join('')
        }
        break
      }
    }

    // 最后一轮 assistant 输出
    const lastOutput = finalAssistantOutput(own)
    const lastOutputText = lastOutput === undefined
      ? undefined
      : lastOutput
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map(b => b.text)
          .join('')

    // 最新 todo 状态（从 tool/call name=todo_write 的 arguments 里取最后一次调用）
    let todos: CorumFailedChildContext['todos']
    for (const event of [...own].reverse()) {
      if (event.type === 'tool/call' && (event.data as { name?: string }).name === 'todo_write') {
        try {
          const args = JSON.parse((event.data as { arguments?: string }).arguments ?? '{}') as {
            todos?: readonly { content: string; status: string }[]
          }
          if (args.todos !== undefined) todos = args.todos
        } catch { /* 解析失败略过 */ }
        break
      }
    }

    // 失败原因
    const { end } = foldConsumedWork(own)
    const stopReason = end === undefined ? undefined : String((end.data as { reason?: { kind?: string } }).reason?.kind)

    return { originalTask, lastOutput: lastOutputText, todos, stopReason }
  } catch {
    // session 不存在/读失败 ⇒ 退化为盲重跑（不阻塞重跑路径）。
    return undefined
  }
}

/**
 * 构造「接着做」的增强 prompt。
 *
 * 把失败子 Agent 的上下文注入到新子 Agent 的原始 prompt 前面，让新子 Agent
 * 知道：目标是什么、已经做了什么、做到哪了、为什么失败了。
 *
 * @param originalPrompt - 原始委派的 prompt。
 * @param context - 从失败子 Agent 提取的上下文。
 * @returns 增强后的 prompt（前缀 + 原始 prompt）。
 */
/**
 * fork（corum）2026-09-20：主 Agent 经 `roleContext` 注入的叠加层人格**长度上限**。
 *
 * ⚠️ **本地常量，刻意不从 `@corum/corum-subagent` import**：本包 import 的是官方
 * `@deepseek-ai/dsh-subagent`（注册表实体），而 fork 是另一个模块实例——跨实例取值会踩
 * 「两份模块实例」红线（见本文件 1509 行附近对同源不同实例的说明）。该上限是**产品口径**
 * 而非实现细节，两处各持一份、由 `verify-fork-drift.sh` 的注释对账约束（改动需两处同步）。
 * 权威真源在 `corum-subagent/src/child-roles.ts` 的 `PERSONA_INJECTION_MAX_CHARS`。
 */
const PERSONA_INJECTION_MAX_CHARS = 2000

/**
 * fork（corum）2026-09-20：把主 Agent 注入的 `roleContext` 收成可用的叠加层人格。
 *
 * 用户定调「叠加，且不可覆盖机制层」+「2000 字符上限」：
 * - 空/纯空白 ⇒ `undefined`（不注入，子 Agent 只用机制角色契约）；
 * - 超限 ⇒ **截断并显式标注**，不静默丢弃——子 Agent 知道自己拿到的上下文不完整，
 *   主 Agent 也能从结果里看出自己的注入被截了（静默截断会让双方都误以为完整）。
 *
 * @param raw - 模型传入的 `roleContext`（可能缺失、非字符串或空白）。
 * @returns 归一化后的注入文本；无有效内容时 `undefined`。
 */
function corumPersonaHint(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (trimmed.length <= PERSONA_INJECTION_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, PERSONA_INJECTION_MAX_CHARS)}\n\n[truncated: this role context exceeded ${PERSONA_INJECTION_MAX_CHARS} characters]`
}

function corumBuildResumePrompt(
  originalPrompt: ContentBlock[],
  context: CorumFailedChildContext,
): ContentBlock[] {
  const sections: string[] = [
    'CONTEXT FROM A PREVIOUS ATTEMPT THAT FAILED DUE TO MODEL UNAVAILABILITY:',
    '',
    `Original task: ${context.originalTask || '(not available)'}`,
  ]
  if (context.lastOutput !== undefined && context.lastOutput.length > 0) {
    sections.push('', `Work completed before failure:\n${context.lastOutput}`)
  }
  if (context.todos !== undefined && context.todos.length > 0) {
    const remaining = context.todos.filter(t => t.status !== 'completed')
    if (remaining.length > 0) {
      sections.push('', 'Remaining steps from the plan:', ...remaining.map(t => `- [${t.status}] ${t.content}`))
    }
  }
  if (context.stopReason !== undefined) {
    sections.push('', `The previous attempt ended with: ${context.stopReason}`)
  }
  sections.push(
    '',
    'INSTRUCTION: Continue from where the previous attempt left off. Do NOT repeat work that was already completed. Use the context above to avoid redundant tool calls and build on the progress already made.',
    '',
    '---',
    '',
  )
  return [{ type: 'text', text: sections.join('\n') }, ...originalPrompt]
}

/**
 * fork（corum）2026-09-18：**可带路线覆盖的续跑**所需的最小能力面。
 *
 * 为什么需要（红线 3）：本包编译期解析的是**官方** `@deepseek-ai/dsh-subagent` 的
 * `SubagentSendMessageOptions`（该包被 tsdown external，类型面是官方基线），而运行期
 * `subagents` 服务实例来自 **fork #9** `@corum/corum-subagent`（`cordis.patch.yml` 的
 * `corum-subagent` 行取代了官方行，服务名同为 `subagents`）。fork 给该 options 增了
 * `agentOptions`（按次路线覆盖），官方类型里没有 ⇒ 直接用会 TS2353。
 * 按红线 3 的做法：**本地声明窄的能力接口**，不 import fork 实现包（那会把 fork 源码
 * 内联进本 bundle）。
 */
interface CorumRouteAwareDelivery {
  readonly signal: AbortSignal
  /** 本次投递的 LLM 路线覆盖（按次、不落盘；仅冷恢复路径 honoring）。 */
  readonly agentOptions?: { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
}

/** fork #9 的 `subagents.sendMessage`（带路线覆盖版）；运行期实例即 fork，安全。 */
type CorumRouteAwareSendMessage = (
  sender: Agent,
  targetId: never,
  content: ContentBlock[],
  options: CorumRouteAwareDelivery,
) => Promise<unknown>

/**
 * fork（corum）：委派工具名 → 角色（UI 图标/小标）。**与
 * `@corum/corum-api-remotes` 的 `subagentDelegationRoleOf` 同表**——本包的编译
 * 程序里看不到 api-remotes（fork 包各自声明，见下），故在此镜像一份；
 * `@corum/corum-api-remotes` 的 `remote-events.host.spec.ts` 有单测逐项对账两处
 * 的工具名表（改一处不同步就红），改一处必须两处一起改。
 * 角色只从**工具名**派生，绝不按 label 文案猜（2026-09-12 用户定调）。
 */
const CORUM_DELEGATION_ROLE_BY_TOOL: Readonly<Record<string, 'worker' | 'research' | 'fork'>> = {
  subagent: 'worker',
  subagent_research: 'research',
  subagent_fork: 'fork',
}

/**
 * fork（corum）：`corum/subagent/child` 载荷——spawn 成功那一刻的精确父子映射。
 *
 * 与 `@corum/corum-api-remotes` 的 `SubagentChildEvent` 同构（自包含声明：本包
 * 的编译程序里看不到 api-remotes 的 Events 合并，按 fork 包之间的既有口径各自
 * 声明一次，结构必须逐字段一致，改一处要两处一起改——verify-fork-drift.sh
 * §事件段会兜住声明/转发两侧）。
 */
interface CorumSubagentChildEvent {
  readonly parentSessionId: string
  readonly callId: string
  readonly childSessionId: string
  readonly label: string
  readonly isolated: boolean
  /** 委派角色（工具名派生；见 `CORUM_DELEGATION_ROLE_BY_TOOL`）。 */
  readonly role?: 'worker' | 'research' | 'fork'
  /** 前台一次性（父等结果）还是后台 agent（父继续干活、可续接）。 */
  readonly mode: 'foreground' | 'background'
  readonly worktree?: { readonly slug: string; readonly branch: string; readonly path: string }
  /**
   * 本次 spawn 的真实生效模型路由（与 `SubagentChildEvent.model` 同构）。
   * 取 `request.agentOptions`（锁定路径=fork compile 的角色锁模型；非锁定/fork
   * 路径=从 `parentAgentOptionsForDelegation` 合并来的父真实路由），缺失退回
   * `corumEffectiveModel`，两者都无则不写。fork 实例不写 config.model →
   * `request.agentOptions` 来自 `parentAgentOptionsForDelegation(parent)` →
   * 读父 `session.requestHeader().config` 的 provider/model → 即父真实路由。
   */
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly time: number
}

// fork（corum）：与 corum-orchestration 的 `corum/worktree-ledger` 同款——本包
// 自己声明一次，emit 点不必 `as never`。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'corum/subagent/child': (data: CorumSubagentChildEvent) => void
    /**
     * 机制级模型询问（host → client 的独立通路；**不是** userQuestions）。
     *
     * 与 `@corum/corum-api-remotes` 的白名单声明各自一次（fork 包之间看不到彼此的
     * Events 合并，见上方 `corum/subagent/child` 的同一说明）：结构必须逐字段一致，
     * 改一处要两处一起改。
     * @param request - 失败事实 + 档位清单 + 可用模型清单。
     * @param next - 无应答者时继续传递（落到调用方传的默认值）。
     * @mode waterfall
     */
    'corum/model-ask/request'(
      request: CorumModelAskRequest,
      next: () => Promise<CorumModelAskAnswer>,
    ): Promise<CorumModelAskAnswer>
  }
}

/** `corum/model-ask/request` 的载荷（与 api-remotes 的 CorumModelAskRequestEvent 同构）。 */
interface CorumModelAskRequest {
  readonly agent: Agent
  readonly label: string
  readonly configured: { provider: string; model: string }
  readonly fallback: { provider: string; model: string }
  readonly cause: string
  readonly role: 'worker' | 'research'
  readonly options: readonly { kind: string; label: string; description: string }[]
  readonly catalog: readonly {
    provider: string
    label: string
    models: readonly { model: string; label: string }[]
  }[]
}

/** `corum/model-ask/request` 的回传（与 api-remotes 的 CorumModelAskOutcomeEvent 同构）。 */
interface CorumModelAskAnswer {
  readonly kind: 'temporary' | 'permanent-follow' | 'permanent-route' | 'decline' | 'dismissed'
  readonly route?: { provider: string; model: string; reasoningEffort?: string }
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
  /**
   * fork（corum）：本次委派的**隔离落点**——由 `spawnOne` 附上，工具 render 渲染成一行
   * 事实说明给父 Agent（文本单一事实源 = `corumIsolationBoundaryNotice`）。
   *
   * ⚠️ 2026-09-18 反向修正：此前**只在「没隔离」时**才附（注释原话「worktree 是常规路径、
   * 无需提醒」）。那个假设是错的——隔离成功恰恰是**唯一需要模型采取行动**的情形：改动在
   * 分支上，**只有 `integrate: true` 能把它并进主树**；不提醒就等于把「分支已提交、模型
   * 以为完事」当默认结局，工作静默搁浅（作者本人 2026-09-18 就这么中招：两次隔离委派都
   * 没被提醒，手工 cherry-pick 收尾，机制台账从未翻成 integrated）。故现在**两档都报**。
   */
  readonly isolationBoundary?: 'worktree' | 'skipped-non-git' | 'main-requested'
  /**
   * fork（corum）2026-10 修复③（B 方案）：**research 报告的落盘路径**
   * （`<CORUM_HOME>/research-reports/<childSessionId>.md`）。
   *
   * 只在只读 research 委派的前台 settle 后出现（写委派没有报告可留）。大结果时
   * 正文只在盘上、`output` 里是摘要 + 这个路径——主 Agent 据此还能把全文读回来。
   */
  readonly reportPath?: string
}

/**
 * fork（corum）2026-10：**script 模式返回值（`script.value`）的体积上限**。
 *
 * 由来（#100 的另一半）：`compile.ts` 的 tool-result-pruner 阈值是 8192/4096/1024——超过
 * 8192 字符的**单条** tool/result 会被中间腰斩。tasks 形态的 N 份正文已经改成任务级引用，
 * 但 script 模式的 `value` 是**模型自己在脚本里聚合出来的**结果，体积不可控（一个
 * `return results` 就能把全部子 Agent 输出原样带回来）。
 *
 * 故这里给它一个硬上限：超限时降级成截断摘要（`script.value` 的 schema 是 `json`，
 * 字符串合法），完整内容由 closer 的收尾报告承载——「单条结果体积可控」是黑盒化的目标本身。
 */
const CORUM_ORCHESTRATE_SCRIPT_VALUE_LIMIT = 6000

/**
 * fork（corum）2026-10 修复③（B 方案）：**单个 research 报告的正文回传上限**。
 *
 * 用户需求：把「报告留存」语义扩展到单个 research 子 Agent（`subagent_research`，
 * 只读，自己写不了盘）。它的一次性前台 settle 之后会话就销毁（#75），结论若没被及时
 * 用上就丢了。B 方案（用户已拍板）：**小结果直接回全文，大结果落盘给路径**。
 *
 * 阈值取 **6000 字符**，与 `CORUM_ORCHESTRATE_SCRIPT_VALUE_LIMIT` 同量级，理由：
 *  - 单条 tool/result 的 pruner 阈值是 8192（超了会被**中间腰斩**，见 #100）；
 *  - 6000 给「机制附加的溯源行 + 路径引用 + 边界说明」留出约 2k 的余量，保证整条结果
 *    仍在 8192 以内，正文**永远不会**被 pruner 砍；
 *  - 与编排 script.value 用同一个量级，避免「同一个产品里两条不同的『大』标准」。
 */
const CORUM_RESEARCH_INLINE_LIMIT = 6000

/**
 * fork（corum）2026-10 修复③（B 方案）：**research 报告落盘 + 回传形态**。
 *
 * 落盘由机制在主进程侧做（research 子 Agent 是只读的，沙箱钉 read-only、write/edit
 * 被 deny，它自己写不了）。报告落在 `<CORUM_HOME>/research-reports/<childSessionId>.md`，
 * 阅后即焚的过程产物，不归档进项目。
 *
 * 回传按**阈值分流**（用户已拍板的 B 方案）：
 *  - 正文 ≤ {@link CORUM_RESEARCH_INLINE_LIMIT} ⇒ **照回全文** + 附带报告路径；
 *  - 正文 > 阈值 ⇒ 回「摘要（前 N 字符）+ 报告路径引用」，正文全文只在盘上
 *    （避免撞 #100 的 8192 pruner 截断）。
 *
 * 报告里带**溯源信息**：会话 id、父任务（委托标签）、时间——用户要求「必要时落盘
 * 关联引用」，一份脱离溯源的结论在事后无法复核。
 * @param options.childSessionId - research 子会话 id（报告文件名与溯源行都用它）。
 * @param options.label - 委托标签（父任务）。
 * @param options.report - 子 Agent 的最终正文（未 trim 也可，内部会 trim）。
 * @param options.now - 时间戳（单测注入用）。
 * @param options.env - 环境变量表（单测注入 CORUM_HOME）。
 * @param options.home - `os.homedir()`（单测注入用）。
 * @returns 回传正文（`text`）与落盘事实（`reportPath` / `written` / `truncated`）。
 */
export function corumResearchReportDelivery(
  options: {
    readonly childSessionId: string
    readonly label: string
    readonly report: string
    readonly now?: Date
    readonly env?: NodeJS.ProcessEnv
    readonly home?: string
  },
): { text: string; reportPath: string; written: boolean; truncated: boolean } {
  const body = options.report.trim()
  const reportPath = corumResearchReportPath(
    options.childSessionId,
    options.env ?? process.env,
    options.home,
  )
  const at = (options.now ?? new Date()).toISOString()
  // 落盘内容 = 溯源头 + 正文。溯源行刻意**不进**回传正文（主 Agent 已经有会话 id 与
  // 委托标签，重复一遍只是噪音），但盘上那份必须能独立自证。
  const persisted = [
    `# Research report · ${options.childSessionId}`,
    '',
    `- child session: ${options.childSessionId}`,
    `- delegated task: ${options.label}`,
    `- settled at: ${at}`,
    '',
    '---',
    '',
    body,
    '',
  ].join('\n')
  const written = body === '' ? false : corumWriteReportFile(reportPath, persisted)
  if (body === '') {
    return { text: 'It left no closing message.', reportPath, written, truncated: false }
  }
  if (body.length <= CORUM_RESEARCH_INLINE_LIMIT) {
    // 小结果：照回全文 + 附带路径（路径只是「还在哪儿能再读一遍」，不影响可读性）。
    return {
      text: written
        ? `${body}\n\n[corum research report] saved to ${reportPath}`
        : `${body}\n\n[corum research report] could NOT be saved to ${reportPath} — the text above is the only copy.`,
      reportPath,
      written,
      truncated: false,
    }
  }
  // 大结果：只回摘要 + 路径引用（避免撞 #100 的 8192 pruner 截断，那会腰斩正文）。
  return {
    text: `${body.slice(0, CORUM_RESEARCH_INLINE_LIMIT)}\n…(truncated: ${body.length} chars total)`
      + (written
        ? `\n\n[corum research report] the FULL report is saved to ${reportPath} — read that file for the rest.`
        : `\n\n[corum research report] the full report could NOT be saved (${reportPath}) — only the excerpt above survives.`),
    reportPath,
    written,
    truncated: true,
  }
}

/**
 * fork（corum）2026-09-20：把一次前台委派产出的 content blocks 折成纯文本。
 *
 * 用途：`integrate` 收尾时把集成者的报告正文带回 `orchestrate` 的工具结果（见 `runIntegrate`
 * 的注释）。此前集成者的 `output` 拿到了却被丢弃，主 Agent 只看到 `integrated: true`。
 *
 * 只取 text block 并拼接（与 `withDiagnosticAndPartialText` 同一口径）；非 text block
 * （图片等）不进报告——集成报告是给人读的结论，不是原始回执。
 * @param output - 子 Agent 产出（`ForegroundToolResult['output']`）。
 * @returns 拼接后的正文；无文本 block 时为空串。
 */
function corumOutputText(output: readonly ContentBlock[] | readonly JsonValue[]): string {
  return (output as readonly ContentBlock[])
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 */
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        // fork（corum）：把权威 stopReason 挂到 Error 上，让 orchestrate 的
        // catch 分支能按 stopReason（而非错误串匹配）区分「手动终止」与「失败」。
        const thrown = new Error(withDiagnosticAndPartialText(error, result))
        ;(thrown as { stopReason?: SubagentResult['stopReason'] }).stopReason = result.stopReason
        throw thrown
      }
      return {
        kind: 'foreground',
        runId: run.id,
        // Content blocks already cross durable JSON boundaries elsewhere;
        // the registry performs the authoritative lossless snapshot here.
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * fork（corum）：**部分集成**的通知——分支都落地了，但个别 worktree 还留着未提交
 * 改动（写了没提交）。这类条目保持 pending、保留现场，由主 Agent 决定补提交还是丢弃；
 * 其余条目已正常翻转。以 settlement notice 同款形态注入父会话，保证主 Agent 不会
 * 以为「全清干净了」。注入失败只告警（可见性是增强，不能反过来让委托失败）。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param childId - 集成者子会话 id（notice 的 senderSessionId；官方
 *   `SubagentSettledMessageSource.senderSessionId` = "Session id of the child that settled"）。
 * @param notice - `corumPartialIntegrationNotice()` 产出的说明文本。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifyPartialIntegration(
  parent: Agent,
  childId: string,
  notice: string,
  logger: { warn: (message: string) => void },
): void {
  try {
    parent.inject(createUserMessage({
      content: [{ type: 'text', text: notice }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary('integrate partially persisted — leftovers kept pending'),
        senderSessionId: childId,
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`partial-integration notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * fork（corum）：**待集成分支**的通知（2026-09-12 用户实测后补）。
 *
 * 数据：12 个用过 orchestrate 的会话里 `autoIntegrate` 声明 true 仅 5 次、false 10 次、
 * 未声明 6 次，而真正发生过集成的只有 3 个会话——旧默认「不声明/false 一律只报告」
 * 把合并交给模型记性，它大多不会回来做，于是隔离分支静默搁浅（唯一一份提交没人看得到）。
 * 现在：声明 `verify` 即默认自动集成；**显式 opt-out 时由本通知兜底**，把「还有 N 条分支
 * 没合并、怎么收尾」推到父会话的第一步，而不是埋在工具结果里。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param childId - 子会话 id（notice 的 senderSessionId；官方
 *   `SubagentSettledMessageSource.senderSessionId` = "Session id of the child that settled"。
 *   settle 钩子传触发本次 settle 的 `info.id`；orchestrate 路径传集成者子会话 id）。
 * @param branches - 仍未合并的分支名。
 * @param logger - 注入失败时的告警出口。
 */
/**
 * fork（corum）2026-10：待集成通知的**正文单一事实源**。
 *
 * 抽出来是因为同一条说明现在有两个去向：注入父会话（单发委派），或**收拢到机制内部**
 * （编排黑盒化——closer 在收尾报告里逐条列出）。两处必须逐字一致，否则「机制记下的」
 * 与「模型读到的」会漂移。
 * @param branches - 仍未合并的分支名。
 * @returns 通知正文。
 */
export function corumPendingIntegrationNoticeText(branches: readonly string[]): string {
  return `[corum] ${branches.length} isolated branch(es) are NOT merged into the main tree: ${branches.join(', ')}. `
    + 'Their commits are the only copy of that work — nobody sees them otherwise. '
    + 'Finish it yourself with `subagent { integrate: true }` (merge + verify + commit), or discard them explicitly.'
}

function corumNotifyPendingIntegration(
  parent: Agent,
  childId: string,
  branches: readonly string[],
  logger: { warn: (message: string) => void },
): void {
  if (branches.length === 0) return
  try {
    parent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: corumPendingIntegrationNoticeText(branches),
      }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary('pending integration: branches not merged'),
        senderSessionId: childId,
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`pending-integration notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * fork（corum）：**被拒集成后的现场解卡**（2026-09-16 实机补，两道门禁的失败路径共用）。
 *
 * 由来：门禁要求集成者「先 `git merge --no-commit` 合、验完再提交」（为了消掉「合并即提交」
 * 让 verify 失败被盖过那条路）。副作用是**被拒时主树停在未结清的合并现场**：`MERGE_HEAD`
 * 存在会让后续**每一次** merge/commit 都失败（`fatal: You have not concluded your merge`），
 * 包括下一轮 orchestrate 的集成者与 turn-end 收口——实测 `corum-task-78da6133` 那一轮的
 * `integration.error` 里因此同时出现「分支未进 HEAD」与「A u1.md」两条证据。
 *
 * 安全性见 `corumResolveRejectedIntegration`：被拒分支从未删除（提交仍在分支上），
 * `git merge --abort` 只回退本次合并引入的暂存/工作区改动，**不丢工作、不碰在制品**。
 * 解卡失败只记日志——不能让它掩盖原始失败原因。
 */
function corumUnblockRejectedMerge(cwd: string, logger: { warn: (message: string) => void }): void {
  const failure = corumResolveRejectedIntegration(cwd)
  if (failure !== undefined) {
    logger.warn(`integrate rejected: could not unblock the in-progress merge in the main tree (${failure})`)
  }
}

/**
 * fork（corum）2026-10：**`corumNotifyVerifyRejected` / `corumNoticeChildId` 已随
 * `merge` 字段一起退役**（用户定稿「机制自动判定收尾」）。
 *
 * 那两个函数的唯一用途是「orchestrate 的集成被 verify 拒绝 / 分支待集成时，给父会话发一条
 * 可辨识的 notice」。取消 `merge` 后，收尾由 closer 完成：
 *   · 失败形态由 closer 的 persona 明确要求逐条报告（未合并 / 验证失败 / 未结清合并），
 *     报告正文直接返回主 Agent，不再需要一条**另一条通路**的 notice 去解释「哪条是真的」；
 *   · 编排运行期间，本次编排派出的子 Agent 的 settle 通知本来就**收拢到机制**
 *     （`captureOrchestrationNote`），closer 在报告里逐条列出。
 *
 * 保留这段说明而不是静默删掉：`corumNotifyVerifyRejected` 的存在理由曾是「两种拒绝形态的
 * 现状与出路相反，不能复用 pending 通知」——那是用一次实机事故换来的认知。收尾改由 closer
 * 承担后，那条「各说各的真相」的纪律下沉进了 `corumCloserPersona` 的 merge 分支，不是消失。
 */

/**
 * fork（corum）：前台子 Agent 的最终汇报以「settlement notice」形态注入父会话。
 *
 * 2026-09-09 用户实机反馈「子 Agent 结束后反馈没有注入主 Agent」：汇报本来就在
 * `subagent` 的工具结果里（父 Agent 的模型上下文拿得到），但它在会话流里只是一张
 * 工具卡的内容，用户很难注意到；而子会话卡片只显示进度与任务提示词。这里复用
 * fork #9 后台子 Agent 的同款通知形态（`source.kind: 'subagent-settled'` +
 * `form: 'notice'`，chat 渲染成一条可见的注入行），把汇报变成会话里的一等消息。
 *
 * 注入走 `agent.inject()`（模型面上下文，不唤醒驱动器）：父 Agent 正在等工具结果，
 * 下一个 step 边界领取；若这一轮就此结束，消息留在收件箱、下一轮可见，绝不会
 * 因为它凭空开启新回合。注入失败只告警——可见性是增强，不能反过来让委托失败。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param childId - 子会话 id（notice 的 senderSessionId）。
 * @param label - 委托标签（给 summary 一句人话上下文）。
 * @param outcome - 前台 settle 结果（output = 子 Agent 最终 assistant 文本块）。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifyForegroundResult(
  parent: Agent,
  childId: string,
  label: string,
  outcome: ForegroundToolResult,
  toolName: string,
  logger: { warn: (message: string) => void },
): void {
  try {
    const { summary, blocks } = corumForegroundSettlementText(
      childId,
      label,
      outputValueText(outcome.output).trim(),
      toolName,
    )
    parent.inject(createUserMessage({
      content: blocks.map(text => ({ type: 'text' as const, text })),
      // fork #9 的 source 声明在 @corum/corum-subagent 的模块增补里，本包的程序
      // 里看不到那个 MessageSourceMap 合并——按 dev-conventions §4a 的跨包类型
      // 口径收窄（与同一文件里 `subagent/end` 监听同款）。
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary(summary),
        senderSessionId: childId,
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`subagent foreground result notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * fork（corum）2026-09-18：**子 Agent 模型路由回退**的可见通知（用户策略第 2 条）。
 *
 * 用户策略：「如果发生子 Agent 模型调用出错，则默认退回主 Agent 路由，确保任务完成，
 * 并**通知用户该情况的处理方式**」。⇒ 这条通知的职责不是「报告一个错误」，而是把
 * 机制**已经替你做了什么**说清楚，否则用户只看到子 Agent 跑在了别的模型上而无从得知为什么。
 *
 * 通知必须给全四样（缺一样用户就无法判断该不该干预）：
 *   ① 哪个子 Agent（label + childId）；② 原定的模型路由（用户配置的那个）；
 *   ③ 实际改用的路由（主 Agent 的）；④ 这是**自动回退**、以及用户可以怎么改
 *   （去 Agent 预设改子 Agent 模型，或换一个可用的 provider/model）。
 *
 * 投递形态与 {@link corumNotifyForegroundResult} 同款（`form: 'notice'`，会话里一条
 * 可见注入行）。注入失败只告警——可见性是增强，不能反过来让委派失败。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param label - 委托标签（给用户一句人话上下文）。
 * @param configured - 原定（用户配置的）模型路由。
 * @param fallback - 实际改用的主 Agent 路由。
 * @param cause - 触发回退的原因原文（子 Agent 的失败信息）。
 * @param logger - 注入失败时的告警出口。
 */
/**
 * fork（corum）2026-09-18：**模型不可用问用户的结果**投递给父会话（取代旧版「已自动回退」通知）。
 *
 * 为什么必须投递：用户策略的两条规则都以「**主 Agent 提醒用户**」为前提（原话
 * 「主 Agent 提醒用户子 Agent 配置的 LLM 当前无法使用」）。提问卡是**交互式**的一次性 UI，
 * 用户答完即消失；这条 notice 是**留在会话里**的记录，也是主 Agent 知道「现在该怎么继续」
 * （自己干 / 重新指派 / 换个模型）的唯一来源。
 *
 * 投递形态与其它通知同款（`form: 'notice'`，会话里一条可见注入行）；注入失败只告警。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param label - 委托标签（人话上下文）。
 * @param summary - 机制决定的结论（`model-ask-run.ts` 生成，已含「已发生什么 + 下一步」）。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifyModelDecision(
  parent: Agent,
  childId: string,
  label: string,
  summary: string,
  logger: { warn: (message: string) => void },
): void {
  try {
    parent.inject(createUserMessage({
      content: [{ type: 'text', text: `Subagent model unavailable (${label}) — ${summary}` }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary(`Subagent model decision (${label})`),
        senderSessionId: childId,
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`subagent model-decision notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * fork（corum）：可用模型路由清单（供「永久改为别的模型」二级选择）。
 *
 * 红线 3 的窄化用法：只依赖 `llm` 服务的两个方法，不 import 官方 llm 实现包的类型。
 * 目录列举失败返回空数组——调用方会据此如实报告「列不出来」，绝不替用户瞎选一个模型。
 */
function corumModelCatalog(runtimeCtx: Context): CorumModelCatalog {
  return {
    listRoutes: async () => {
      const llm = runtimeCtx.get('llm') as unknown as {
        listProviders?: () => readonly { id: string; name?: string }[]
        listModels?: (provider: string) => Promise<readonly { id: string; name?: string }[]>
      } | undefined
      if (llm?.listProviders === undefined || llm.listModels === undefined) return []
      const out: { provider: string; label: string; models: { model: string; label: string }[] }[] = []
      for (const provider of llm.listProviders()) {
        try {
          const models = await llm.listModels(provider.id)
          out.push({
            provider: provider.id,
            label: provider.name ?? provider.id,
            models: models.map(model => ({ model: model.id, label: model.name ?? model.id })),
          })
        } catch {
          // 单个 provider 列举失败不影响其它（已授权但离线的 provider 会拒绝列举）。
        }
      }
      return out
    },
  }
}

/**
 * fork（corum）2026-09-18：**机制级模型询问**的独立通路调用面。
 *
 * 走 host 侧自定义 waterfall `corum/model-ask/request`（`corum-api-remotes` 已把该事件
 * 加进转发白名单，`mode: 'waterfall'`），由 client 插件 `@corum/corum-ui-model-ask` 应答。
 * **刻意不复用 `userQuestions`**：那条通路的消费者是 LLM 的 `ask_user_question` 工具，
 * 与机制级提问共用会让两者在同一 waterfall 里互相截获、delegate 语义纠缠。
 *
 * ## 必须带 scope 载体（2026-09-19 实机：不带 ⇒ 静默降级成 dismissed）
 *
 * `corum-api-remotes` 的转发循环对 waterfall 事件先取 `carrierKeyOf(this)`，**取不到就
 * 直接 `next()`**（见其 `remoteEventSource`）——即不带载体的派发根本不会转发到 renderer，
 * 用户的界面永远不出现，机制拿到的是我们自己传的 dismissed。表现极具迷惑性：日志里
 * 「无 choice made」，看起来像用户没作答。
 *
 * 载体的正确取法与官方两条同类通路（`user-approval` / `user-questions`）逐字一致：
 * `ctx.waterfall(scopeTarget(agent, agent), event, request, fallback)` —— 第一个参数是
 * **作用域分派载体**，不是普通入参。
 *
 * 为什么在这里 `ctx.get` 而不是注入一个服务：该通路是**事件**（cordis 事件总线），
 * 事件不需要「服务存在」即可安全发起——没有应答者时 waterfall 会落到我们传的
 * `next`（返回 dismissed），这正是「该部署没有 UI 插件」时想要的保守降级。
 *
 * @param runtimeCtx - host context（发事件用）。
 * @returns 通路调用面（恒非 undefined——事件总线永远可用）。
 */
function corumModelAskChannel(runtimeCtx: Context): CorumModelAskChannel {
  return {
    call: (request, next) => Promise.resolve().then(() => runtimeCtx.waterfall(
      scopeTarget(request.agent, request.agent),
      'corum/model-ask/request',
      request,
      next,
    )),
  }
}

/**
 * fork（corum）2026-09-18：**子 Agent 模型不可用 ⇒ 退回主 Agent 路由**的可见通知。
 *
 * ⚠️ 已被 {@link corumNotifyModelDecision} 取代（用户 2026-09-18 改为「先问用户」，
 * 不再有「机制自动重试」这条路径）。保留本函数只因其文案在台账/规格里被引用过，
 * 若确认无引用可删除。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param childId - 触发本次 settle 的子会话 id（notice 的 senderSessionId；官方
 *   `SubagentSettledMessageSource.senderSessionId` = "Session id of the child that settled"。
 *   failures 可能跨多条 worktree，但都由本次 `subagent/end`（单个子会话 settle）触发取走投递）。
 * @param failures - 收口强制提交失败的 worktree 清单。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifySettleCommitFailures(
  parent: Agent,
  childId: string,
  failures: readonly CorumSettleCommitFailure[],
  logger: { warn: (message: string) => void },
): void {
  try {
    const summary = `Settle auto-commit FAILED for ${failures.length} isolated worktree(s) — you must finish the commit`
    const detail = failures
      .map(failure => `· ${failure.slug}  ${failure.path}\n  reason: ${failure.reason}`)
      .join('\n')
    parent.inject(createUserMessage({
      content: [
        { type: 'text', text: summary },
        {
          type: 'text',
          text: [
            'The mechanism auto-commits an isolated worktree when it settles so that no isolated work can be',
            'lost. That commit FAILED, so the work is still uncommitted inside the worktree(s) below — it is',
            'NOT lost, but nobody can see it until it is committed.',
            '',
            detail,
            '',
            'Do this next: fix the cause (a missing `git config user.email`/`user.name` is the common one),',
            'then commit inside each worktree listed above, and report the resulting commit hash(es).',
            'Do not discard the worktree and do not force-remove it.',
          ].join('\n'),
        },
      ],
      // 与 corumNotifyForegroundResult 同款跨包类型收窄（fork #9 的 source 声明在
      // @corum/corum-subagent 的模块增补里，本包程序看不到那个 MessageSourceMap 合并）。
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary(summary),
        senderSessionId: childId,
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`settle commit-failure notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}


/**
 * fork（corum）：工具描述里的调度句（单一事实源）。
 *
 * 模型可见文本内联在 `defineTool` 回调里时只有实机重启后读工具描述才能验证
 * 它是否与机制事实一致。抽成导出纯函数后单测能直接断言「research 实例读到
 * 恒前台」并钉住它与 `run_in_background` 拒绝路径（throw）一致。措辞纪律同
 * `@corum/corum-orchestration` 的 `corumEfficiencyDisciplineLines`。
 * @param options.backgroundEnabled - 是否启用后台调度。
 * @param options.continuable - 是否为 continuable 后台模式。
 * @param options.readonlyResearch - 是否为只读研究实例。
 * @returns 接在 `wording.description` 后面的调度描述句（开头保留一个空格）。
 */
export function corumSchedulingDescription(options: { readonly backgroundEnabled: boolean; readonly continuable: boolean; readonly readonlyResearch: boolean }): string {
  if (options.readonlyResearch) {
    return ' This read-only research tool ALWAYS runs in the FOREGROUND: its report returns in this tool result, so you read the findings inline. Do NOT pass `run_in_background: true` (it is rejected).'
  }
  if (!options.backgroundEnabled) {
    return ' This call waits for the subagent and returns its result.'
  }
  if (options.continuable) {
    return ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` steers the child\'s nearest step while it is running and starts a turn while it is idle. Set `run_in_background: false` only when your next action depends on receiving the result — a foreground run is one-shot and TERMINAL when it settles, so `send_message` cannot reach it afterwards.'
  }
  return ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
}

/**
 * fork（corum）：机制段 `tool:${toolName}` 的调度文本（单一事实源）。
 *
 * 与 {@link corumSchedulingDescription} 同源：research 实例读「恒前台」，其余实例
 * 读官方后台默认措辞。抽成纯函数的原因同上——模型可见文本内联在
 * `systemPrompt.section` 回调里时只有实机重启才能验证，抽出后单测直接断言。
 * @param options - 同 {@link corumSchedulingDescription}。
 * @param toolName - 段内点名的是本实例的工具名——同一段文本服务
 * `subagent` / `subagent_research` / `subagent_fork` 三个实例，写死任一个就会指错工具。
 * @param ptcPrefix - PTC 模式前缀（非 PTC 为空串）。
 * @returns 机制段文本（`ptcPrefix` + 调度句）。
 */
export function corumSchedulingSectionText(options: { readonly backgroundEnabled: boolean; readonly continuable: boolean; readonly readonlyResearch: boolean }, toolName: string, ptcPrefix: string): string {
  if (options.readonlyResearch) {
    return ptcPrefix + 'This read-only research tool ALWAYS runs in the FOREGROUND: its report returns in this tool result, so you read the findings inline. Do NOT pass `run_in_background: true` (it is rejected) — a backgrounded investigation leaves you guessing or repeating work. It has a shell for read-only commands (`git log`, `ls`, reading PID/log files, a verify script\'s `status`) but its sandbox is pinned to `read-only` and write/edit are denied, so it can never modify the repo. Fan out several research calls in ONE message when you need answers from different angles.'
  }
  return ptcPrefix + `Use ${toolName} in the background by default.`
    + `\n- Start independent delegations together in one assistant message and continue useful work while they run.`
    + `\n- Set \`run_in_background: false\` only when your next action depends on that subagent's result: a foreground run is one-shot and TERMINAL when it settles.`
    + `\n  - Consequence: \`send_message\` cannot reach it afterwards.`
    + `\n- When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.`
}

/**
 * fork（corum）2026-09-26：**前台一次性子 Agent 是终态**这条机制事实的单一事实源。
 *
 * ## 由来（实机报障，会话 `corum-task-ef3f751e`）
 *
 * 主 Agent 用 `subagent { run_in_background: false }` 派了一个前台子 Agent；子 Agent 汇报
 * 「被沙箱挡住、未执行」后，主 Agent**紧接着调 `send_message` 去授权它继续**（line 81）
 * ——被机制以 `NOT_RESUMABLE` 拒绝（line 82：
 * `subagent "bca632cd-…" has no supported continuation state and cannot be resumed`）。
 * 白烧一次往返，且「授权继续」这个意图完全没送达。
 *
 * ## 根因：模型可见文本只讲了「能续」的一半
 *
 * `subagent` 实例的 `backgroundMode` 是 `continuable`，于是工具描述与机制段都写着
 * 「`send_message` steers the child's nearest step while it is running and starts a turn
 * while it is idle」——**没有限定这句话只对后台（continuable）子 Agent 成立**。而
 * `run_in_background: false` 走的是 `ctx.subagents.start()`（官方 one-shot 契约：
 * 子会话不驻留、不落可续描述符）⇒ 它**天生不可续接**。模型读到的是无条件承诺。
 *
 * 措辞纪律（与 §「提示词不得承诺机制里不存在的通路」同源）：只补**已存在**的事实，
 * 不改机制能力；并给出**可执行的替代路径**（而不是只说「不行」）。
 *
 * @param toolName - 本实例的工具名（同一段文本服务 `subagent` / `subagent_fork` 等）。
 * @returns 机制段里的一行（无前导空行；调用方按需拼装）。
 */
export function corumOneShotTerminalLine(toolName: string): string {
  return `A FOREGROUND one-shot child (\`run_in_background: false\` via ${toolName}) is TERMINAL once it settles: its conversation is not kept, so \`send_message\` to it is rejected. When a foreground child reports a blocker and you need it to keep going WITH ITS CONTEXT, you cannot resume it — either delegate a fresh child and hand it the context you need carried, or delegate in the background next time when you expect to steer it again.`
}

/**
 * fork（corum）：前台一次性子 Agent settle 时的通知正文。
 *
 * 在既有的「汇报」之上追加一条**机制事实**：这次是一次性运行、不可续接（见
 * {@link corumOneShotTerminalLine} 的根因）。放在通知里而不是只放工具结果里，是因为
 * 结算通知是**子 Agent 刚结束时**模型最可能读到的那条消息——实测 id 也是从这里被拿去
 * 调 `send_message` 的（`corum-task-ef3f751e` line 68 → 81）。
 *
 * @param childId - 子会话 id。
 * @param label - 委托标签。
 * @param report - 子 Agent 的最终汇报正文（已 trim；空串表示没留收尾话）。
 * @param toolName - 本实例的工具名（用于给出正确的替代路径措辞）。
 * @returns 结算通知的文本块（summary 行 + 汇报 + 机制事实行）。
 */
export function corumForegroundSettlementText(
  childId: string,
  label: string,
  report: string,
  toolName: string,
): { summary: string; blocks: string[] } {
  const summary = `Subagent ${childId} finished (${label}) — final report:`
  return {
    summary,
    blocks: [
      summary,
      report === '' ? 'It left no closing message.' : report,
      `NOTE: ${corumOneShotTerminalLine(toolName)}`,
    ],
  }
}

/**
 * fork（corum）：`run_in_background` 参数 schema 的描述（单一事实源）。
 *
 * 与 {@link corumSchedulingDescription} / {@link corumSchedulingSectionText} 同源：
 * research 实例的 `run_in_background` 被拒绝（throw），描述必须说实话而非写
 * 「Defaults to true」。抽成纯函数的原因同上——模型可见 schema 描述同样需要
 * 可执行断言钉住它与拒绝路径一致。措辞纪律同 `@corum/corum-orchestration` 的 `corumEfficiencyDisciplineLines`。
 * @param options.continuable - 是否为 continuable 后台模式。
 * @param options.readonlyResearch - 是否为只读研究实例。
 * @returns 参数描述句。
 */
export function corumRunInBackgroundDescription(options: { readonly continuable: boolean; readonly readonlyResearch: boolean }): string {
  if (options.readonlyResearch) {
    return 'Not supported for this read-only research tool: it always runs in the foreground and `true` is rejected — omit it.'
  }
  return options.continuable
    ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it — but note a foreground run is one-shot and TERMINAL when it settles: you cannot `send_message` it afterwards.'
    : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.'
}

/**
 * fork（corum）2026-09-27（用户裁定 A）：`isolation` 参数的**词汇表**——两组取值共用一个键。
 *
 * - `'worktree'`（默认）/ `'main'`：**这次在哪工作**（`'main'` = 直接在主工作树，不建
 *   worktree、不需要 integrate）；
 * - `'always'` / `'write-tasks'`：**档位语义**（非写任务要不要也隔离）。写任务恒隔离，
 *   这组值改不了它（invariant ⑤）。
 *
 * 两组取值不重叠，故不必让模型记两个键。
 */
export type CorumIsolationValue = 'worktree' | 'main' | 'always' | 'write-tasks'

/**
 * fork（corum）2026-09-27（用户裁定 A）：把模型声明的隔离意图解析成**两个正交维度**，并在
 * 派发**之前**拦住结构性矛盾。
 *
 * ## 为什么需要它（实测病根，会话 corum-task-56b7d485）
 *
 * 主 Agent 想让子 Agent 去主树 / 跨仓落盘、甚至合并分支，但它能表达的只有「派一个
 * `subagent`」，于是机制照 invariant ⑤ 建了隔离 worktree：20 次派发里有 4 个零提交的撞墙
 * 子会话，3 次把搬运外包给用户。用户裁定：「有问题的是之前的主 Agent 指派子 Agent 时传入的
 * 参数不合适」⇒ 让意图**可表达**，并让矛盾在派发前就报错。
 *
 * ## 两个维度
 *
 * - `mode`（`'always' | 'write-tasks'`，可缺省）：档位语义，缺省 = 用调用方默认档。
 * - `placement`（`'worktree' | 'main'`）：这次在哪工作。
 *
 * ## 结构性矛盾 fail loud（而不是让子 Agent 去撞墙）
 *
 * `integrate: true` 走**集成者**路线（在主树合并 + verify + 提交），本身就不建 worktree。
 * 此时再声明 `isolation` 的任何取值都说明调用方混淆了两条路线 ⇒ 直接抛错，并把「你到底想
 * 要哪条」写进错误文本（这是本场最贵的那类浪费：白派一个子 Agent 去撞隔离墙）。
 *
 * @param request - 模型声明的 `integrate` / `isolation` 原文（未校验）。
 * @returns `{ mode, placement, integrator }`。
 * @throws 取值不在词汇表内，或与 `integrate: true` 结构性矛盾时。
 */
/**
 * fork（corum）2026-09-27（实机教训）：从 brief 里识别**只有主树/非隔离会话才能做**的意图。
 *
 * ## 由来（用户实机反馈）
 *
 * 用户「同意」推送两个仓之后，指挥者把 brief 交给**默认隔离**的 worker：`git push` 属仓库级
 * 写、被隔离守卫**硬拒**（连提权重试也拒，**不出审批卡**）⇒ 一个子会话只换来一句
 * 「this is a manual step or a non-isolated session」，推送根本没发生。参数面
 * （`isolation: "main"`）当时已存在，病根是**模型不会主动用它** ⇒ 除了改提示词，再在
 * 派发处加一道窄判据把这类组合拦下来。
 *
 * ## 判据刻意**窄**
 *
 * 只认「明确要执行某个只有在主树/非隔离会话里才合法的 git 动作」的写法，并**排除否定语境**
 * （`do NOT push` / `never push` / `without pushing`）——宁可漏判（交回提示词与模型判断），
 * 也不误伤正常委派：误伤会让主 Agent 白烧一轮去改参数。
 *
 * @param prompt - 子 Agent brief 原文。
 * @returns 命中的能力（进错误文本）；无需主树时 `undefined`。
 */
export function corumMainTreeIntentOf(prompt: string): string | undefined {
  // ⚠️ 必须吃掉 `git` 与动词之间的**全局选项**：用户真实 brief 写的是
  // `git -C /Users/kukucai/work/kkc-desktop push origin main`，首版只认裸 `git push`
  // ⇒ 漏判（被自己的用例逮到）。
  const git = '\\bgit\\s+(?:-C\\s+\\S+\\s+|-c\\s+\\S+\\s+|--git-dir(?:=\\S+|\\s+\\S+)\\s+|--work-tree(?:=\\S+|\\s+\\S+)\\s+)*'
  const triggers: readonly (readonly [RegExp, string])[] = [
    [new RegExp(`${git}push\\b`, 'g'), 'run `git push`'],
    [new RegExp(`${git}(?:pull|fetch)\\b`, 'g'), 'run `git pull` / `git fetch`'],
    [new RegExp(`${git}worktree\\s+(?:add|remove|move|prune|repair)\\b`, 'g'), 'change git worktrees'],
    [new RegExp(`${git}branch\\s+(?:-d|-D|-m|-M|-c|-C|--delete|--move|--copy)\\b`, 'g'), 'write a branch ref'],
  ]
  const negated = /(?:not|never|don't|do not|cannot|can't|without)\s+$/i
  for (const [pattern, label] of triggers) {
    for (const match of prompt.matchAll(pattern)) {
      const before = prompt.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0)
      if (negated.test(before)) continue
      return label
    }
  }
  return undefined
}

export function corumResolveIsolationRequest(request: {
  readonly integrate?: boolean
  readonly isolation?: unknown
}): {
  readonly mode?: 'always' | 'write-tasks'
  readonly placement: 'worktree' | 'main'
  readonly integrator: boolean
} {
  const raw = request.isolation
  if (raw !== undefined && raw !== 'always' && raw !== 'write-tasks' && raw !== 'worktree' && raw !== 'main') {
    throw new Error(
      `isolation must be one of "worktree" (default), "main", "always", "write-tasks" — got ${JSON.stringify(raw)}. `
      + 'Pass "main" when the child must write in your MAIN working tree or in another repository.',
    )
  }
  const integrator = request.integrate === true
  if (integrator && raw !== undefined) {
    throw new Error(
      'integrate: true already runs the child as the INTEGRATOR on your main working tree (it merges the isolated '
      + `branches, verifies and commits) — do not also pass isolation: ${JSON.stringify(raw)}. `
      + 'If you want the child to do main-tree/cross-repository WORK (not integration), drop `integrate` and pass '
      + 'isolation: "main"; if you want its isolated branch merged, drop `isolation` and keep integrate: true.',
    )
  }
  return {
    ...raw === 'always' || raw === 'write-tasks' ? { mode: raw } : {},
    placement: raw === 'main' ? 'main' : 'worktree',
    integrator,
  }
}

interface DelegationRunRequest {
  readonly run_in_background?: boolean
  // fork（corum）：integrate 参数（parameters 已声明；官方类型未含）。
  readonly integrate?: boolean
}

interface DelegationRunSpec {
  readonly runInBackground: boolean
}

/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationRun(
  request: DelegationRunRequest,
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
): DelegationRunSpec {
  if (!options.backgroundEnabled) {
    // The validator permits undeclared keys, so schema omission also needs
    // execution-time enforcement.
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return {
    // Continuable work is independently scheduled unless the caller explicitly
    // needs the result before its next action. One-shot policy keeps its existing
    // foreground default because its background result requires Task collection.
    runInBackground: request.run_in_background ?? options.continuable,
  }
}

// fork（corum）：隔离编排纯函数 + 台账类型已下沉到 orchestration.ts
// （docs/plan/PLAN-subagent-orchestration.md §5，红线 1：台账状态改 cordis service）。
// 上方 import 引入局部作用域（apply 内部使用），此处 re-export 保持对外 API
// 兼容（单测/下游 import 路径不变）。
export {
  corumBranchIntegrated,
  corumBranchMerged,
  corumShaInHead,
  corumEntryIntegrated,
  corumSnapshotBranchTips,
  corumCleanupLedgerEntries,
  corumCleanupWorktree,
  corumDetectIntegrateChecks,
  corumEffectiveToolFilter,
  corumEntryDead,
  corumGit,
  corumGitHead,
  corumGitStatusPorcelain,
  corumDirtyOwnershipLines,
  corumIntegrationFailure,
  corumPartialIntegrationNotice,
  corumPortBranchDiff,
  corumPortPendingBranches,
  corumMergeBase,
  corumIntegrationTruth,
  corumIntegrationVerdict,
  corumRunIntegrateVerify,
  corumVerifyFailureNotice,
  corumResolveRejectedIntegration,
  CORUM_INTEGRATE_VERIFY_TIMEOUT_MS,
  corumIntegratorPersona,
  // fork（corum）2026-10：编排收尾节点（closer）——黑盒化后整次编排统一结算的那一个角色。
  corumCloserPersona,
  corumOrchestrateReportPath,
  corumWriteOrchestrateReport,
  // fork（corum）2026-10 修复②：closer 成功后按台账实况作废「待集成」类内部说明。
  corumDropResolvedIntegrationNotes,
  // fork（corum）2026-10 修复③（B 方案）：单个 research 子 Agent 的报告落盘。
  corumResearchReportPath,
  corumWriteReportFile,
  corumIsGitRepo,
  corumIsolationBoundaryNotice,
  corumIsWriteTask,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumMutationToolsForPlatform,
  corumBranchTip,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumBranchAddsCommits,
  corumReconcileIntegrated,
  corumMergedBranches,
  corumPendingIntegration,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumWorktreeHasUncommitted,
  corumWriteToolsForPlatform,
} from './orchestration.ts'
// 2026-09-15 机制补漏：收口强制提交失败的**结构化形状**（投递给模型时逐条标注）。
import type { CorumChildSpawnFacts, CorumCloserScenario, CorumCloserTaskRef, CorumSettleCommitFailure } from './orchestration.ts'
export type { CorumCleanupOptions, CorumIntegrationTruth, CorumSettleCommitFailure, CorumWorktreeEntry, CorumWorktreeLedgerFrame } from './orchestration.ts'
export { CorumOrchestration } from './orchestration.ts'

export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  // Reject an empty explicit filter at load instead of failing every delegation.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent'
  // fork（corum）：orchestrate 是**全局唯一**工具名，只能由 worker 实例注册。2026-09-10
  // 恢复 subagent_fork 实例（toolName 'subagent_fork'）后，原判据 `!corumReadonlyResearch`
  // 会让 fork 实例也去注册 orchestrate → 挂载直接失败（"tool \"orchestrate\" is already
  // registered in this scope"，实机 preset mount 报错）。判据收敛为「worker 实例」=
  // toolName 是 'subagent'（compile 恒定产物；research/fork 实例各有自己的 toolName）。
  const isWorkerInstance = toolName === 'subagent'

  // fork（corum）：编排器 service 只读消费（红线 1：跨会话/跨 bundle 单例）。
  // 台账语义是会话级（key=父 session id），必须在根上下文共享。provide 职责已
  // 移交给独立包 @corum/corum-orchestration（其 cordis 行在 patch.yml 中位于
  // 本工具行之前 apply，保证先就绪）；本 apply 不再幂等自建兜底，缺则抛装配
  // 错误——顺序由 patch.yml 行序承担（docs/plan/PLAN-refactor-orchestration-
  // package-and-settings-center.md 重构 1）。
  const orchestration = ctx.root.get('corumOrchestration') as CorumOrchestration
  if (orchestration === undefined) {
    throw new Error(
      'tool-subagent: `corumOrchestration` service not provided — '
      + '@corum/corum-orchestration must be mounted before this tool (cordis.patch.yml row order)',
    )
  }

  // fork（corum）：host settings namespace `corum-subagent`（三级配置第一级：
  // 全局默认；「子 Agent」设置 section 读写此面，preset config 逐键覆盖）。
  //
  // 2026-09-18 修复「冷启动该 ns 不存在」：正常路径下**本包不再负责注册**——boot 常驻行
  // `settings-registrar.ts` 已在更早的行序注册它（该 ns 是全局配置，与有无 corum 会话无关；
  // 只在按会话 apply 时注册会导致冷启动进设置页读到空值、模板预填失效）。
  // 这里保留**兜底**：registrar 缺席时（其它组合/其它部署）仍能注册。两侧共用
  // `acquireCorumSubagentSettingsScope`，它容忍「已被注册」（官方 register 对重复注册抛错）。
  // worker/research 双实例共享模块级单例，避免第二次 apply 重复注册。
  if (corumGlobalSettingsScope === undefined) {
    ctx.inject(['settings'], (settingsCtx) => {
      if (corumGlobalSettingsScope !== undefined) return
      corumGlobalSettingsScope = acquireCorumSubagentSettingsScope(
        settingsCtx.settings as unknown as CorumSettingsProviderFace,
      )
    })
  }

  // fork（corum）：实例级配置终值。
  // 2026-09-21 裁定：隔离 / 合并相关键（isolation / integrateChecks / merger）已从 preset
  // 配置面（Config 接口 + schema）与全局 ns 移除，**机制恒定生效**，故这里不再有相关解析，
  // 调用点直接固化常量（隔离模式恒 write-tasks、denyDirectFs / autoCleanup 恒 true、
  // 合并者恒 parent、核查命令恒按父 cwd 探测）。
  // getSnapshot 每次执行时读（文档更新即时生效）。
  const corumGlobal = (): CorumSubagentGlobalSettings => corumGlobalSettingsScope?.get() ?? {}
  const corumReadonlyResearch = config.readonlyResearch === true
  const corumMaxParallelChildren = config.maxParallelChildren ?? corumGlobal().maxParallelChildren ?? 4

  /**
   * 机制状态面（`corumOrchestration` 已在本 apply 顶部强制就绪）。
   *
   * ★ 2026-10-16 真因修复：构造搬到 `model-ask-run.ts` 的 `corumDelegationPolicyStateFrom`。
   * 旧的行内箭头 `modelOverrideOf: sessionId => orchestration.modelOverrideOf(sessionId)`
   * **吃掉了 role 参数** ⇒ research 角色恒读 worker 键 ⇒ 陈旧判据误判 ⇒ 只读调研的
   * 「模型不可用」永不弹面板（详见该函数的头注释）。搬成纯函数后，回归测试可以直接
   * 驱动真正的转发逻辑，而不是只对源码文本做断言。
   */
  const corumPolicyState = corumDelegationPolicyStateFrom(orchestration)

  /**
   * fork（corum）2026-09-18：**子 Agent 模型不可用 ⇒ 问用户**，并按下文两规则处置。
   *
   * 本函数是三条失败路径（前台 one-shot / continuable / 后台）**共用**的收尾：
   * 机制全权完成（问用户 → 解析 → 改会话级临时路由或写预设 → 必要时停用委派 → 通知），
   * **不给 LLM 任何改模型的工具或参数**（用户明确要求）。
   *
   * @returns 机制决定（调用方据此决定是否就地重跑）；问不到/失败时返回 dismissed。
   */
  const corumAskAboutModel = async (
    parent: Agent,
    label: string,
    role: 'worker' | 'research',
    configuredModel: { provider: string; model: string },
    cause: string,
    signal: AbortSignal,
    notify: boolean,
    childId: string | undefined,
  ): Promise<{ route: CorumRoute | undefined; summary: string }> => {
    // 回退路由 = 父 Agent 的真实路由（用户要的「和主 Agent 一样」）。拿不到就只报告。
    // ⚠️ 这一步排在「陈旧闸门」之前（闸门在 corumAskAboutModelUnlessStale 里）：facts.fallback
    // 必须先拿到父路由才成形。两者的**副作用**与顺序无关（都不写状态），产物也同形
    // （route undefined + 空 summary = 不重跑、如实交回）。
    const parentOptions = parentAgentOptionsForDelegation(parent)
    if (parentOptions.provider === undefined || parentOptions.model === undefined) {
      ctx.logger.warn(
        `subagent (${label}): configured model ${configuredModel.provider}/${configuredModel.model} failed `
        + `(${cause}) and the parent route is unresolvable, so the user cannot be offered a fallback`,
      )
      return { route: undefined, summary: '' }
    }
    // 提问走 host 侧的**独立通路** `corum/model-ask/request`（waterfall）——不借
    // `ctx.userQuestions`：那是 LLM 主动提问的通路，与机制级询问的生命周期、取消语义、
    // 文案归属都不同，共用会让两者互相截获（见 model-ask.ts 头注释）。
    // 2026-09-18 实机修正：用 `ctx.get` 而**不是** `ctx.root.get`——corumAgent 由
    // `@corum/corum-agent` 在**根 composition** 的 apply 里 `new CorumAgentService(ctx)`
    // 注册（`Service` 构造即 provide 到传入的 ctx），而 cordis 的 reflect store 按
    // isolate key 跨 scope 查找、子 scope 沿祖先链继承 ⇒ 本 scope 直接 get 就够；
    // 写 `ctx.root.get` 在实测里取不到（首次实机「永久档」报 no writable profile 即此因）。
    // 按红线 3 用窄接口收窄，不 import @corum/corum-agent。
    const profile = ctx.get('corumAgent') as unknown as CorumProfileWriteFace | undefined
    // ★ 2026-09-21：走「至多问一次」入口 —— 同一父会话同一角色的并行失败**共享一个决定**。
    // 实机现场：主 Agent 在同一消息里发两个并行 subagent（会话 corum-task-1b927cf3 的
    // step 27 的 :187/:188），两个子 Agent 都用坏模型起跑 ⇒ 各自失败 ⇒ 用户被同一个根因
    // 连问两次（seq 190 已答、seq 191 又问）。共享后只问一次。
    // ★ 2026-10-16：入口换成 `corumAskAboutModelUnlessStale` = 「陈旧闸门（★2026-09-21 的
    // 规矩）+ 至多一次询问」的合一实现。合一的目的正是让「role 为 research、配置模型不可用
    // ⇒ 机制**确实派发了询问**」这条回归断言能驱动真链路（见
    // `tests/model-ask-role-key.spec.ts`；缺陷就在这条链的接缝上：闸门读错了角色的键）。
    const outcome = await corumAskAboutModelUnlessStale(
      {
        state: corumPolicyState,
        channel: corumModelAskChannel(ctx),
        profile,
        catalog: corumModelCatalog(ctx),
      },
      parent,
      {
        label,
        role,
        configured: configuredModel,
        fallback: { provider: parentOptions.provider, model: parentOptions.model },
        cause,
      },
      signal,
      ctx.logger,
    )
    ctx.logger.info(
      `subagent (${label}): model decision=${outcome.decision.kind} persisted=${outcome.persisted} `
      + `persisted=${outcome.persisted}`,
    )
    // ★ 2026-10-04 用户实测缺陷修复（裁决「机制回写子会话投影」）：
    // 决策落地后子 Agent 卡片仍显示旧模型——卡片读子会话 modelSelection.lastUsed，
    // 而换模型的路由走父会话侧 per-run agentOptions / coldResume 覆盖 / 预设写入，
    // 子会话投影从不翻。此处对该子会话 append model/selection，让投影 pending
    // 命中（官方 view: next = pending ?? lastUsed），卡片即显示新模型。
    // 安全性：installTaskModelSelection 的「用户选择粘住」语义只装主任务会话
    // （agent-service.ts 五个安装点全是 task 会话），子 Agent 会话不装（spawn
    // driver / continuation-activation 均无），不会误触发让位。
    if (childId !== undefined && outcome.override !== undefined) {
      try {
        const child = ctx.get('agents')?.get(childId as never)
        child?.session.append('model/selection', {
          provider: outcome.override.provider,
          model: outcome.override.model,
          ...(outcome.override.reasoningEffort !== undefined ? { reasoningEffort: outcome.override.reasoningEffort } : {}),
        })
      } catch (error: unknown) {
        ctx.logger.warn(`subagent (${label}): failed to record the model override on the child session: ${String(error)}`)
      }
    }
    if (notify && outcome.summary !== '') {
      // 子会话已 settle（attempt 0 失败 / 异步 end 失败）⇒ 有 childId，注入 subagent-settled
      // notice（senderSessionId = "the child that settled"）。
      // 子会话未起（后台预检 / spawn 期失败）⇒ childId undefined：此刻语义上没有 settled child，
      // `subagent-settled` source 必须有 senderSessionId（官方 v0.1.5 校验），不能占位。
      // 信息不丢——decision 仍已持久化、summary 写进工具结果/日志；只是不进会话流（可见性变化）。
      if (childId !== undefined) {
        corumNotifyModelDecision(parent, childId, label, outcome.summary, ctx.logger)
      } else {
        ctx.logger.warn(
          `subagent (${label}): model decision notice not injected — no child session id (subagent never spawned); decision=${outcome.decision.kind} summary=${outcome.summary}`,
        )
      }
    }
    return {
      route: outcome.override,
      summary: outcome.summary,
    }
  }

  /**
   * fork（corum）2026-09-18：**规则 1** 的异步处理器——前台/后台「能 continue」的委派，
   * 模型不可用时问用户，并按答案**带着新模型续跑同一个子会话**。
   *
   * 用户规则 1 原文：「前台或后台任务且能 continue 的，主 Agent 直接询问用户是否回退继续，
   * 选是则**临时更换为主 Agent 配置的大模型**完成任务。选否则直接报告子 Agent 配置模型
   * 不可用，后续主 Agent 不再派遣子 Agent，所有工作由主 Agent 继续」。
   *
   * 与「一次性任务」的关键差别：这类子会话**上下文还在**，所以「继续」= 往同一个子会话
   * 投递一条「用主 Agent 模型接着做完」的消息，而**不是**新开一个子会话（那样会丢掉它
   * 已经掌握的上下文，等于让用户为一次模型故障多付一遍钱）。
   *
   * fire-and-forget：调用方（`subagent/end` 监听器）必须同步返回，见那里的说明。
   */
  const corumHandleAsyncModelFailure = async (
    parent: Agent,
    facts: CorumChildSpawnFacts,
    info: SubagentRunEndInfo,
    appCtx: Context,
  ): Promise<void> => {
    try {
      const cause = info.stopReason === 'error'
        ? 'the child run ended with an error stop reason (model/transport failure)'
        : String(info.stopReason)
      const asked = await corumAskAboutModel(
        parent,
        facts.label,
        facts.role,
        facts.configured,
        cause,
        AbortSignal.timeout(CORUM_ASK_TIMEOUT_MS),
        true,
        String(info.id),
      )
      if (asked.route === undefined) return
      const childId = String(info.id)
      if (!facts.continuable) {
        // **一次性**后台任务：子会话已终结、无法"继续"（官方契约：one-shot 不驻留）。
        // 用户规则 2 的对应动作是「**重新指派**子 Agent，并使用与主 Agent 一致的模型」——
        // 这一步由主 Agent 在新的委派里完成（此时会话级临时覆盖已生效，新子 Agent 自然
        // 跑在主 Agent 的模型上）。机制这里只负责"把路铺好 + 通知"，不替主 Agent 编造派单。
        appCtx.logger.info(
          `subagent (${facts.label}): one-shot background run failed on the configured model; `
          + `the user approved the main-model fallback, so the parent may re-issue the delegation`,
        )
        return
      }
      // **能 continue**：子会话上下文还在 ⇒ 带着「用主 Agent 模型接着做完」的指令
      // **续跑同一个子会话**（而不是新开一个——那会丢掉它已掌握的上下文，等于让用户
      // 为一次模型故障多付一遍钱）。
      //
      // ★ 路线覆盖是**必需**的（2026-09-18）：失败的 continuable 子 Agent 以
      // `stopReason:'error'` 终结时已被 DISPOSED（dispose 在 `subagent/end` 之前），
      // 故这次投递会走 `coldResume`；而 coldResume 默认按**持久化 descriptor** 重建路由
      // —— 那正是刚刚失败的那个坏模型。不传 `agentOptions` 就等于「用同一个坏模型再跑
      // 一遍」，用户的「是」会被静默浪费掉。故这里显式带上主 Agent 路由
      // （per-delivery、不落盘；descriptor 保持权威，见 corum-subagent 的 seam 注释）。
      await (appCtx.subagents.sendMessage as unknown as CorumRouteAwareSendMessage)(
        parent,
        childId as never,
        [{
          type: 'text',
          text: "[corum] The model configured for this subagent was unavailable, and the user approved continuing on the main Agent's model. Resume and FINISH the task you were given, using the main Agent's model from now on. Do not restart from scratch — keep whatever work and context you already have.",
        }],
        {
          signal: AbortSignal.timeout(CORUM_ASK_TIMEOUT_MS),
          agentOptions: {
            provider: asked.route.provider,
            model: asked.route.model,
            ...asked.route.reasoningEffort !== undefined
              ? { reasoningEffort: asked.route.reasoningEffort as ReasoningEffortId }
              : {},
          },
        },
      )
      appCtx.logger.info(`subagent (${facts.label}): re-drove continuable child ${childId} after the user approved the fallback`)
    } catch (error: unknown) {
      // 提问/续跑的任何失败都只告警：此刻的立场是「尽量把任务救回来」，不是再抛一个错。
      appCtx.logger.warn(`subagent (${facts.label}): async model-failure handling failed: ${String(error)}`)
    }
  }

  // fork（corum）：subagent/end settle 联动——end 事件的第二回调参数是委派方
  // 父 Agent（见 corum-subagent lifecycle.ts 的 Events 声明），直接从
  // parent.session.id 取台账键；runId 精确匹配（登记自 spawn 的 SubagentRun.id），
  // 回退 childId 唯一匹配（continuable 登记的是 startContinuable 返回的
  // childId）。settled 不占 maxParallelChildren 额度（子 Agent 已完工，
  // worktree 等 integrate）。as never 窄化原因：cordis Events 合并声明来自
  // @corum/corum-subagent 包，与本包 import 的官方 @deepseek-ai/dsh-subagent
  // 类型面同源但模块实例不同，类型系统认不出。
  // fork（corum）：`subagent/end` 的父 Agent 是 dispatch 的 `this`（scope carrier），
  // **不是第二参数**——fork #9 声明为 `'subagent/end'(this: Scoped<SubagentRuntime>,
  // info)`，发射端只 `callback(info)`（lifecycle.ts）。此前写成 `(info, parentAgent)`
  // 恒收 undefined，`settleFromEnd` 里 `parentAgent.session.id` 抛错被 emitter 的
  // per-listener 容错吞掉 → 台账 settle 从未生效（docs/TODO.md，2026-09-09 修复）。
  // 用普通函数取 `this`，经 carrierKeyOf 解出父 Agent（dsh-scope 与 corum-subagent
  // 同实例：tsdown 已 external）。
  ctx.on('subagent/end' as never, (function (this: unknown, info: SubagentRunEndInfo) {
    // fork（corum）：settle 联动已下沉编排器 service（台账实例字段 + 帧发射）。
    const parent = carrierKeyOf(this) as Agent | undefined
    orchestration.settleFromEnd(info, parent)

    // fork（corum）2026-09-18：**规则 1** —— 前台/后台且**能 continue** 的委派，
    // 模型不可用时由机制问用户「是否回退继续」。
    //
    // 为什么在这里而不是工具调用里：后台一次性与 continuable 的失败**不在工具栈上**
    // （工具早已返回子会话 id / job id）。spawn 时记下的 `ChildSpawnFacts` 正是为了
    // 让这一刻还拿得到「用户配的是哪个模型 / label / 角色」。
    //
    // ⚠️ 本监听器**必须同步返回**、不可 await：emitter 的 per-listener 容错会吞掉抛错，
    // 且阻塞它会拖住 settle 链。故提问走 fire-and-forget 的异步任务，失败只告警。
    if (parent !== undefined && info.stopReason === 'error') {
      // ⚠️ 查找键用 `info.id`（= 子会话 id）**而不是** `info.runId`：实测（2026-09-18）
      // continuable 路径的 `runId` 是 `createActivationObserver` 每次激活**新生成的
      // randomUUID**（lifecycle.ts:182），与 spawn 时 `startContinuable` 返回的
      // childId 毫无关系 —— 用 runId 查恒 miss，于是规则 1 在默认路径上**静默不触发**
      // （第一次实机验证正是这样：子会话建了、失败了、提问卡没出现）。
      // 子会话 id 才是稳定键：spawn 时记的是它，end 时 `info.id` 还是它。
      const facts = orchestration.takeChildSpawn(String(info.id))
      if (facts !== undefined) {
        void corumHandleAsyncModelFailure(parent, facts, info, ctx)
      }
    }

    // 2026-09-15 机制补漏：**收口强制提交失败 ⇒ 交给模型完成提交**（用户裁定：
    // 「commit 失败后交由模型处理并完成提交」）。
    // ⚠️ 必须在这里投递，不能在 `settleFromEnd` 里 throw —— emitter 的 per-listener
    // 容错会**吞掉**抛错（本文件上方注释已记过 `parentAgent.session.id` 抛错被吞的先例）。
    // 有 parent 时按会话精确取走；拿不到 parent 时兜底取走全部，避免失败在实例里累积。
    // ⚠️ 这两件事**必须各自独立判定**：`failures`（收口提交失败）与 `pendingAfter`
    // （有分支待集成）互不蕴含。此处早先是 `if (failures.length === 0) return`，
    // 于是**只有收口提交也失败时**才会发出下面的「待集成」通知——正常情况下
    // （提交没失败）那条通知**永远发不出去**（2026-09-18 定位：作者同一场会话里
    // 两次前台隔离委派都没收到提示，只好手工 cherry-pick 集成；机制台账因此从未翻成
    // integrated、autoCleanup 也没跑，worktrees 堆到 2.4GB/13 个）。
    // 修法：把「收口失败」的处理收窄进它自己的分支，**别拦后面的通知**。
    const failures = orchestration.drainSettleCommitFailures(
      parent === undefined ? undefined : String(parent.session.id),
    )
    if (failures.length > 0) {
      if (parent === undefined) {
        ctx.logger.warn(
          `settle auto-commit failed for ${failures.length} worktree(s) but no parent Agent was reachable,`
            + ` so the model was not told: ${failures.map(failure => `${failure.slug}: ${failure.reason}`).join('; ')}`,
        )
      } else {
        // fork（corum）2026-10：编排黑盒化——本次编排派出的子 Agent 的收口失败**不发父会话**，
        // 收拢到机制内部交给 closer（报告里逐条列出）。归属按台账 slug 精确判定，
        // 未登记的子 Agent（单发委派）照旧即时通知。
        const sessionId = String(parent.session.id)
        const own = failures.filter(failure => orchestration.orchestrationChildIndexBySlug(sessionId, failure.slug) !== undefined)
        const foreign = failures.filter(failure => orchestration.orchestrationChildIndexBySlug(sessionId, failure.slug) === undefined)
        if (own.length > 0) {
          orchestration.captureOrchestrationNote(
            sessionId,
            `settle auto-commit failed for ${own.length} orchestrated worktree(s): `
              + own.map(failure => `${failure.slug}: ${failure.reason}`).join('; '),
          )
        }
        if (foreign.length > 0) {
          corumNotifySettleCommitFailures(parent, String(info.id), foreign, ctx.logger)
        }
      }
    }

    // 不变式④（invariant.merge-strategy，用户 2026-09-16）：**单发异步后台子 Agent 的分支
    // 由主 Agent 合并**——settle 后若有待集成隔离分支，同样注入 pending-integration 通知
    // （告知主 Agent「分支未合并 + 用 subagent {integrate:true} 收尾」）。原先 corumNotifyPendingIntegration
    // 只在编排（orchestrate）结果处触发，单发后台路径不报 ⇒ 主 Agent 可能永不合并（工作不丢但
    // 永不进主树，UI 只报 finished）。这里对所有产生隔离分支的 settle 统一补发，让单发后台与
    // 编排同样「不可静默」。编排路径仍会发自己的通知（两处通知幂等合并——同键去重）。
    if (parent !== undefined) {
      const sessionId = String(parent.session.id)
      const pendingAfter = corumPendingIntegration(orchestration.entriesOf(sessionId))
      // ⚠️ 认领式去重（2026-09-18）：本插件在 corum preset 里是**双实例**（worker + research，
      // 见 corum-agent/compile.ts），两个实例各注册一个 {global:true} 的 end 监听 ⇒ 同一个
      // settle 会被处理两次。上面两个「取走即删」的用量天然只生效一次，而本条是**纯读**，
      // 不去重就会发两条逐字相同的通知（实机确认：同一会话 seq 24/25 内容一致）。
      const fresh = pendingAfter.filter(entry => orchestration.claimPendingIntegrationNotice(sessionId, entry.branch))
      if (fresh.length > 0) {
        // fork（corum）2026-10：编排黑盒化（#100 的另一半）——**本次编排派出的**子 Agent
        // 的待集成通知**不再注入父会话**，而是收拢到机制内部：整次编排由 closer 统一收尾、
        // 统一结算一次，父 Agent 只看到「发起 → 最终结果」。这同时根治了「settle 抢跑」：
        // 通知不再抵达，父 Agent 就没有机会在收尾之前抢着自己去合并。
        //
        // ⚠️ 只压制**登记过的**子 Agent：父会话同一时刻可能有更早派出的后台子 Agent
        // 正在 settle，吞掉它的通知等于让那条工作静默搁浅（本仓为此栽过）。
        const own = fresh.filter(entry => orchestration.orchestrationChildIndexBySlug(sessionId, entry.slug) !== undefined)
        const foreign = fresh.filter(entry => orchestration.orchestrationChildIndexBySlug(sessionId, entry.slug) === undefined)
        if (own.length > 0) {
          orchestration.captureOrchestrationNote(
            sessionId,
            corumPendingIntegrationNoticeText(own.map(entry => entry.branch)),
          )
        }
        if (foreign.length > 0) {
          corumNotifyPendingIntegration(parent, String(info.id), foreign.map(entry => entry.branch), ctx.logger)
        }
      }
    }
  }) as never, { global: true })

  // fork（corum）：全局设置的 RPC 面（「子 Agent」设置 section 读写；
  // 经 corum-agent 的 TypertRemoteService 通道不可达（本包无 remote 面），
  // 以 cordis 服务直挂——UI 走 ctx.remote 的 settings-controller 官方通道，
  // 本行仅保证 namespace 已注册使官方 settings 文档面可用。
  // （见 packages/api/settings-controller：document-updated / section 读写
  // 按 namespace 分发，无需本包自建 RPC。）

  // fork（corum）：父 scope dispose 时清理未集成的 worktree（编排器 service 持有台账）。
  ctx.effect(() => () => {
    orchestration.cleanupOnDispose(['active', 'settled'])
  })

  const modelSelectionCapable = config.modelSelectionSettings === true
  ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

  const assertSubagentProviderConfiguration = (subagentProvider: SubagentProvider): void => {
    if (typeof config.maxDepth === 'number' && !subagentProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (config.agentOptions !== undefined && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`,
      )
    }
    if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child model selection`,
      )
    }
    if (continuable && subagentProvider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support \`backgroundMode: continuable\``,
      )
    }
  }

  // Validate provider-owned config outside the optional LLM binding so an
  // invalid provider always rejects its registration or this plugin's load.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider)
  })
  const initialProvider = ctx.subagents.getProvider(config.provider)
  if (initialProvider !== undefined) assertSubagentProviderConfiguration(initialProvider)

  const install = (runtimeCtx: Context, modelSelectionPolicy: ModelSelectionPolicy | undefined): void => {
    const modelSelectionEnabled = modelSelectionPolicy !== undefined
    if (modelSelectionPolicy !== undefined) registerListSubagentModels(runtimeCtx, modelSelectionPolicy)
    // Load order and HMR replacement can change provider availability while
    // this fiber remains active.
    let mounted: { subagentProvider: SubagentProvider; disposeTool: () => void; disposeOrchestrate: () => void } | undefined

    /**
     * fork（corum）：单任务隔离 spawn——subagent（单发）与 orchestrate（任务清单
     * fan-out）共用。闭包捕获 install 的配置终值（三级配置已解析）；入参只给
     * runtimeCtx/exec/task 级差异。返回前台 settle 结果或后台/continuable 句柄。
     */
    /**
     * fork（corum）：广播 spawn 精确父子映射（`corum/subagent/child`）。
     *
     * 2026-09-09 用户反馈「子 Agent 处理时无法进入子会话实时查看」：卡片过去靠
     * 会话列表时间就近猜 childSessionId，运行期猜不出来（父会话在等工具结果、
     * 不产生事件 → 卡片不重算），于是 goto 按钮恒 disabled、进度帧也过滤不了。
     * 这里在 start 返回的同一刻按父侧 tool/call id 广播真实 id——卡片第一帧就能
     * 跳转并订阅进度。广播失败只告警（可见性增强，绝不影响委托）。
     */
    const corumChildRole = CORUM_DELEGATION_ROLE_BY_TOOL[toolName]
    const corumEmitChildStarted = (
      parentSessionId: string,
      callId: string | undefined,
      childSessionId: string,
      label: string,
      isolated: boolean,
      mode: 'foreground' | 'background',
      worktree: { slug: string; branch: string; path: string } | undefined,
      // 真实生效路由：取 request.agentOptions（锁定路径=角色锁；非锁定=fork 继承父
      // 真实路由），缺失退回 corumEffectiveModel，两者都无则 undefined（不伪造）。
      model: { provider: string; model: string; reasoningEffort?: string } | undefined,
    ): void => {
      if (callId === undefined || callId === '') return
      try {
        runtimeCtx.emit('corum/subagent/child', {
          parentSessionId,
          callId,
          childSessionId,
          label,
          isolated,
          // 角色 = 本工具实例的名字（subagent_research → research / subagent_fork →
          // fork / subagent → worker）。UI 图标与小标只认它，绝不按 label 文案猜。
          ...corumChildRole === undefined ? {} : { role: corumChildRole },
          mode,
          ...worktree === undefined ? {} : { worktree: { ...worktree } },
          ...model === undefined ? {} : {
            model: {
              provider: model.provider,
              model: model.model,
              ...model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {},
            },
          },
          time: Date.now(),
        })
      } catch (error: unknown) {
        runtimeCtx.logger.warn(`corum/subagent/child emit failed: ${String(error)}`)
      }
    }

    const spawnOne = async (
      runtimeCtx: Context,
      exec: { agent: Agent; signal: AbortSignal; callId?: string },
      args: {
        label: string
        prompt: string
        run_in_background?: boolean
        integrate?: boolean
        verify?: string
        // fork（corum）2026-09-27：**逐次派发的隔离声明**（subagent 的 `isolation` 参数与
        // orchestrate 任务的同名键共用）。`'main'` = 直接在主工作树工作（不建 worktree）；
        // `'always'|'write-tasks'` = 档位语义。解析与矛盾拦截见 corumResolveIsolationRequest。
        isolation?: CorumIsolationValue
        taskResearch?: boolean
        // fork（corum）：本次调用内的 fan-out 任务数（并发感知隔离信号①；
        // subagent 工具不传 = 1）。
        fanoutCount?: number
        // fork（corum）：前台 settle 后是否向父会话注入 settlement notice
        // （subagent 工具注入；orchestrate 任务与 integrate 不注入——结果已由
        // 工具结果汇总，避免 N 条重复通知）。
        notifyParent?: boolean
        // fork（corum）：orchestrate 任务级结构化输出（对象根 JSON Schema）——子 Agent
        // 必须提交 schema 合法的结果，工作流式结构化子结果（2026-09-10 吸收 workflow 语义）。
        taskSchema?: ObjectJsonSchema
        /** fork（corum）：主 Agent 注入的叠加层人格（`roleContext`）——上层已截断。 */
        roleContext?: string
        // fork（corum）2026-09-18：`taskModel` **已按用户策略移除**——per-task 模型
        // 面不再存在（orchestrate 的 tasks[i].model 已从 schema 剔除且不再转达）。
        /**
         * fork（corum）2026-10：**子 Agent 一 spawn 就回调它的 id**——编排黑盒化的登记时机。
         *
         * 为什么必须在这里而不是调用方 `.then()` 之后：前台子 Agent 在 `settleForegroundRun`
         * 返回之前就已经 `subagent/end` 了。等调用方拿到结果再登记，settle 钩子早已跑完、
         * 通知早已注入父会话——压制就成了马后炮（实测正是这个顺序）。
         * 后台/continuable 路径同理（它们在 `subagent/end` 之前也不回工具栈）。
         */
        onChildStarted?: (childId: string) => void
      },
      subagentProvider: SubagentProvider,
    ): Promise<ForegroundToolResult | { kind: 'continuable'; subagentId: string } | { kind: 'background'; jobId: string }> => {
      const parent = exec.agent
      // fork（corum）：官方模型自选请求面（provider/model/reasoning_effort 直挂
      // args 顶层）——corum 的 subagent/orchestrate schema 已剔除这三个字段
      // （模型锁），modelRequest 恒为空对象，仅保形供官方函数签名消费。
      const modelRequest = args as DelegationModelRequest
      const parentOptions = parentAgentOptionsForDelegation(parent)
      const providerRouteDefaults = subagentProvider.agentRouteDefaults
      // fork（corum）：模型路由**三档**（2026-10-11 用户澄清口径，**推翻** 2026-09-18 的
      // 「始终两档」裁决）——
      //   ① **预设里配的模型**（`config.model`，角色锁，见 corum-agent/compile.ts：
      //      worker→profile.subagentModel，research→profile.researchModel ?? subagentModel）；
      //   ② **全局兜底**：预设没配该角色时，落 `corum-subagent` 的
      //      `defaultModel`（worker）/ `defaultResearchModel`（research）；
      //   ③ **跟随主 Agent**：预设没配**且全局也没配**时，落到父的真实路由。
      //
      // 用户 2026-10-11 澄清原话：「全局未设置子 Agent 的 LLM 模型、只设置主 Agent 的
      // LLM 模型的情况下，**即无论如何都未设置子 Agent 模型时才跟随主 Agent**」。
      // ⇒ 全局的 defaultModel/defaultResearchModel **既是「新建预设的模板」也是运行期兜底档**：
      //    · 新建预设时由设置页预填（见 SettingsAgentPresetsSection 的 emptyDraft）；
      //    · 预设没显式配该角色时，运行期在此处回落。
      //
      // ❗这**推翻了 2026-09-18 的旧裁决**。旧裁决原文：「跟随主 Agent 就是主 Agent 当前
      // 预设哪个，子 Agent 也预设哪个。全局页面的配置只是说你创建一个新预设的时候默认
      // 使用这套配置，如果新的预设自己覆盖了就按预设的配置，**始终是两档**」。旧裁决当时
      // 刻意删掉了全局兜底档，理由是「把模板当运行期配置会让全局页改动静默影响所有没配
      // 该键的预设」。用户 2026-10-11 重新裁定为**三档**：那个「静默影响」现在正是**要的
      // 行为**——全局页就是子 Agent 的默认档，只有全局也没设时才跟随主 Agent。
      //
      // ⚠️ 与「会话级临时覆盖」的优先级关系**不变**（2026-09-18 同日稍后引入）：
      // 它是机制在「用户被告知配置的模型不可用、并选择了临时改用主 Agent 模型」之后写进
      // `corumOrchestration` 的内存值（`setModelOverride`）——只对本会话生效、不落盘，
      // 且优先级**高于**上述三档（用户明确要求「临时生效，不覆盖用户的设置」）。
      // 它不构成"第四档配置"：用户从未配置它，是机制的一次会话内决定，
      // 新会话自然回到 预设 / 全局 / 跟随主 Agent。
      //
      // fork（corum）2026-09-19：覆盖按**角色**取（`corumOrchestration` 的
      // `modelOverrides` 已升级为「sessionId + 角色」双键）。corum preset 里本工具是
      // 双实例（worker + research，见 compile.ts `corumSubagentRows`），两个实例各有
      // 自己的 `config.model` 锁面——设置页改预设保存后的补偿也按角色分别补
      // （corum-agent 的 `compensateLiveSessionsForProfile`），取错角色会把另一实例
      // 的锁面覆盖掉。
      const corumChildRoleKey: 'research' | 'worker' = corumChildRole === 'research' ? 'research' : 'worker'
      // 三档解析见 `child-model-resolution.ts`（纯函数，行为可测）。此处只做接线：
      // 会话级覆盖（含 `'follow-main'` 哨兵）、预设锁面（含 `modelFollowMain`）、
      // 全局兜底（`corum-subagent` 的两个模型键）。判据与「为什么」都写在那个文件里。
      const corumResolution = resolveChildModel({
        role: corumChildRoleKey,
        sessionOverride: orchestration.modelOverrideOf(String(parent.session.id), corumChildRoleKey),
        presetModel: config.model,
        presetFollowsMain: config.modelFollowMain === true,
        global: corumGlobal(),
      })
      const corumEffectiveModel: CorumRoute | undefined = corumResolution.route
      const corumLockedOptions: AgentOptions | undefined = corumEffectiveModel === undefined
        ? undefined
        : {
            provider: corumEffectiveModel.provider,
            model: corumEffectiveModel.model,
            ...corumEffectiveModel.reasoningEffort !== undefined
              ? { reasoningEffort: corumEffectiveModel.reasoningEffort as ReasoningEffortId }
              : {},
          }
      const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
      /**
       * fork（corum）2026-09-26：**被删除的锁定模型要在委派前就被识别**（用户拍板口径 3）。
       *
       * ## 补的是什么缺口
       *
       * 刻意在此处（锁定路由解析完、`request` 构造之前）做一次真路由预检：
       * - **前台**路径原本就预检（`corumLockedOptions === undefined` 分支里的
       *   `preflightChildLlmRoute`）——但**只在非锁定路径**生效，锁定路径（本 preset 按角色
       *   配了模型）**跳过了它**；
       * - **后台 / continuable** 路径**完全不预检**（工具已返回 jobId/子会话 id，失败只能靠
       *   `subagent/end` 事后问）。
       *
       * 后果（用户 2026-09-26 报障的同一根因）：预设里锁着一个**已被用户删除**的模型时，
       * 委派会先起一个注定失败的子会话、跑一轮、再弹「模型不可用」问用户——白烧一轮，
       * 且用户面对的是「任务失败」而不是「这个模型已经没了」。
       *
       * ## 与用户 2026-09-18 裁定的关系（**语义不变**）
       *
       * 那次拍板的是「**运行过程中发生的**模型失败 ⇒ 机制问用户（临时换/永久换/停止）」。
       * 本预检不改变那条语义：它只是把**同一个判定提前**——预检失败仍然走
       * `corumAskAboutModel`（同一入口、同一三个选项），只是不再先启动一个死会话。
       * 用户在配置文件里删掉模型是**确定性的配置缺失**，与「调用时失败」是两个概念
       * （用户原话：「我 9 月 18 日的功能主要是在运行过程中发生的非用户删除因素，是两个
       * 不同的概念」）。
       *
       * 失败处理：只记录 `corumLockedRouteFailure`，由下方**现有**的两条失败通路消费
       * （前台 attempt 0 / `subagent/end` 的事后问询），因此不新增第二套提问逻辑。
       */
      let corumLockedRouteFailure: string | undefined
      if (corumLockedOptions !== undefined) {
        const llm = runtimeCtx.get('llm')
        if (llm !== undefined) {
          try {
            await preflightChildLlmRoute(llm, parentOptions, corumLockedOptions, exec.signal, false)
          } catch (error: unknown) {
            corumLockedRouteFailure = error instanceof Error ? error.message : String(error)
            runtimeCtx.logger.warn(
              `subagent (${args.label}): configured ${corumChildRole ?? 'worker'} model `
              + `${corumEffectiveModel?.provider}/${corumEffectiveModel?.model} is unavailable `
              + `(${corumLockedRouteFailure}) — the delegation is not started; the user is asked instead`,
            )
          }
        }
      }
      // fork（corum）：研究标志提前解析（任务级覆盖优先）——request 构造要用它把子会话
      // 沙箱钉成 read-only（2026-09-12 用户定调：research 开放 shell 以后，只读性由
      // 沙箱层保证，而不是靠 deny 掉 bash）。
      const effReadonlyResearch = args.taskResearch ?? corumReadonlyResearch
      /**
       * fork（corum）：子 Agent 的**种类**（2026-09-20 用户定调）——决定它在子 scope 里拿哪套
       * 角色契约（`@corum/corum-subagent` 的 `ChildComposition.kind`）：
       *   · `researcher`（本实例为只读研究实例）→ **全面调查员**，允许继续派子 Agent 深入调查；
       *   · `worker`（其余写型实例）→ **忠实执行者**，不许重规划/重调研/越界，且**禁止构建**。
       * 与 `readonlySandbox` 同源判定（同一个 `effReadonlyResearch`），但语义不同：前者管沙箱、
       * 后者管人格，故单独传递而不是让下游从沙箱反推。
       */
      const childKind: 'worker' | 'researcher' = effReadonlyResearch ? 'researcher' : 'worker'
      const request: {
        label: string
        prompt: ContentBlock[]
        parent: Agent
        agentOptions?: AgentOptions
        kind?: 'worker' | 'researcher'
        persona?: string
        personaHint?: string
        toolFilter?: { allow?: string[]; deny?: string[] }
        maxDepth?: number
        cwd?: string
        outputSchema?: ObjectJsonSchema
        readonlySandbox?: boolean
        confinedSandbox?: boolean
      } = {
        label: args.label,
        prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
        parent,
        // P1：锁定路由是**机制所有**的 ⇒ 打标记，免得被脚本路由的剥离误伤。
        ...corumLockedOptions !== undefined ? { agentOptions: corumLockedOptions, agentOptionsOwnedByMechanism: true } : {},
        kind: childKind,
        // fork（corum）2026-09-20：主 Agent 注入的叠加层人格——**截断到上限**（用户定调
        // 2000 字符）。超限不静默丢弃：截断后显式标注，让子 Agent 与主 Agent 都知道被截了。
        ...corumPersonaHint(args.roleContext) === undefined ? {} : { personaHint: corumPersonaHint(args.roleContext)! },
        ...config.persona !== undefined ? { persona: config.persona } : {},
        ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
        ...maxDepth !== undefined ? { maxDepth } : {},
        // fork（corum）：结构化子结果（orchestrate 任务级 schema，吸收 workflow 语义）。
        ...args.taskSchema !== undefined ? { outputSchema: args.taskSchema } : {},
        // fork（corum）：只读研究子 Agent 的沙箱钉成 read-only（工具面禁变异工具 + 沙箱层
        // 禁文件写入，两层分工保证「调研能跑命令，但改不了仓库」）。
        ...effReadonlyResearch ? { readonlySandbox: true } : {},
        // fork（corum）2026-09-22：**隔离子会话的沙箱钉成 workspace-write**（正交轴，修法 1）。
        // 见下方 `corumIsolate` 解析：隔离真的生效时（`corumIsolate && !effReadonlyResearch`）
        // 才钉——否则会把「非 git 工作区降级/集成者/track」这些**必须写主树**的路径一起钉死。
        // 值在下方隔离判定后覆盖（此处只声明键，保持对象字面量的条件展开风格）。
      }
      if (corumLockedOptions === undefined) {
        const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
          || hasConfiguredLlmSelection(config.agentOptions)
        const configuredChildAgentOptions = requiresRoutePreflight && providerRouteDefaults !== undefined
          ? { ...providerRouteDefaults, ...config.agentOptions }
          : config.agentOptions
        const requestedChildAgentOptions = requestedAgentOptions(
          parentOptions,
          configuredChildAgentOptions,
          modelRequest,
          modelSelectionEnabled,
        )
        assertAllowedModelSelection(
          modelSelectionPolicy,
          parentOptions,
          requestedChildAgentOptions,
          modelRequest,
        )
        if (requiresRoutePreflight) {
          const llm = runtimeCtx.get('llm')
          if (llm === undefined) {
            throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
          }
          await preflightChildLlmRoute(
            llm,
            parentOptions,
            requestedChildAgentOptions,
            exec.signal,
            providerRouteDefaults === undefined,
          )
          if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) {
            throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
          }
        }
        exec.signal.throwIfAborted()
        if (requestedChildAgentOptions !== undefined) request.agentOptions = requestedChildAgentOptions
      } // fork（corum）：end 模型锁缺省分支（官方原逻辑）

      // fork（corum）2026-09-18：任务级模型锁的校验块**已删除**（连同 `taskModel`
      // 入参）。per-task 模型面按用户策略剔除后，这里不再有「LLM 声明的路由」需要
      // 白名单校验——子 Agent 的路由只来自用户配置（`corumLockedOptions`）或跟随父
      // （`request.agentOptions` 由父路由合并而来），两者都已在各自分支做过
      // `preflightChildLlmRoute` 真路由预检。

      // fork（corum）：提取本次 spawn 的真实生效模型路由，用于广播帧。
      // 取 request.agentOptions 的 provider/model/reasoningEffort——它是 890 行
      // 之前两条路径的终值：锁定路径（corumLockedOptions）= compile.ts 按角色锁
      // 的 model；非锁定/fork 路径 = requestedAgentOptions，后者由
      // parentAgentOptionsForDelegation(parent) 合并而来，读父
      // session.requestHeader().config 的 provider/model——故 fork 实例（不写
      // config.model）的帧显示父的真实路由。request.agentOptions 缺失时退回
      // corumEffectiveModel（全局默认），两者都无则 undefined（不伪造空对象）。
      const corumSpawnModel = request.agentOptions !== undefined
        ? request.agentOptions.provider !== undefined && request.agentOptions.model !== undefined
          ? {
              provider: request.agentOptions.provider,
              model: request.agentOptions.model,
              ...request.agentOptions.reasoningEffort !== undefined
                ? { reasoningEffort: request.agentOptions.reasoningEffort as string }
                : {},
            }
          : corumEffectiveModel !== undefined
            ? {
                provider: corumEffectiveModel.provider,
                model: corumEffectiveModel.model,
                ...corumEffectiveModel.reasoningEffort !== undefined
                  ? { reasoningEffort: corumEffectiveModel.reasoningEffort }
                  : {},
              }
            : undefined
        : corumEffectiveModel !== undefined
          ? {
              provider: corumEffectiveModel.provider,
              model: corumEffectiveModel.model,
              ...corumEffectiveModel.reasoningEffort !== undefined
                ? { reasoningEffort: corumEffectiveModel.reasoningEffort }
                : {},
            }
          : undefined

      // fork（corum）：写工具判定与隔离触发（纯函数，单测覆盖）。
      // fork（corum）2026-09-27（用户裁定 A）：把逐次派发的隔离声明解析成两个正交维度，
      // 结构性矛盾（`integrate: true` + `isolation`）在**派发之前**就抛错。
      const corumIsolationRequest = corumResolveIsolationRequest({
        ...args.integrate !== undefined ? { integrate: args.integrate } : {},
        ...args.isolation !== undefined ? { isolation: args.isolation } : {},
      })
      // fork（corum）2026-09-27（实机教训）：**默认隔离 + 「只有主树能做」的意图** ⇒ 派发前拦下。
      // 这种组合以前会白跑一个子 Agent（被守卫硬拒、且拿不到审批卡），代价是用户点了「同意」
      // 却什么都没发生。这里 fail loud，并把该用的参数直接写进错误文本。
      if (corumIsolationRequest.placement === 'worktree' && corumIsolationRequest.integrator !== true) {
        const mainTreeOnly = corumMainTreeIntentOf(args.prompt)
        if (mainTreeOnly !== undefined) {
          throw new Error(
            `this brief asks the child to ${mainTreeOnly}, which a DEFAULT ISOLATED worker is hard-denied `
            + '(its worktree is write-denied to your tree, and no approval card will appear for it). '
            + 'Pass isolation: "main" to run the child directly in your main working tree, or do it yourself.',
          )
        }
      }
      // 任务级覆盖（orchestrate 的 tasks[i].isolation/research）优先于实例固定终值
      // （2026-09-21 裁定：隔离机制恒定生效，实例侧不再是可配置项，故字面固化常量）。
      // `effReadonlyResearch` 已在上方 request 构造处解析（供只读沙箱钉使用）。
      const effIsolationMode = corumIsolationRequest.mode ?? 'write-tasks'
      const corumIsWrite = corumIsWriteTask(config.toolFilter, effReadonlyResearch, true)
      // fork（corum）：并发感知（2026-09-09 用户实机反馈「只派遣一个 TASK 时还是走了
      // 隔离工作区」）——隔离的存在理由是并发写冲突，没有并发就没有隔离的必要。
      // 四个并发信号（任一成立即视为「可能并发」）：
      //   ① 本次 orchestrate 的 tasks.length ≥ 2（同一调用内的 fan-out）；
      //   ② 本次委托走后台/continuable（父 Agent 继续干活，随时可能再发一个）；
      //   ③ 该会话台账仍有 active 条目（已隔离的写子 Agent 还在跑）；
      //   ④ 该会话有在跑的非隔离开写子 Agent（同一条消息里的并发前台调用）。
      // fork（corum）：**只读研究恒前台**（2026-09-12 用户定调）——「前台等报告」对任何
      // 调研场景都适用；调研留在后台时，前台主 Agent 拿不到结论，容易做出错误判断或
      // 重复调研（实测：4 次 research 里 2 次被父 Agent 提前 abort，报告为空）。
      const corumRunSpec = effReadonlyResearch
        ? { runInBackground: false }
        : resolveDelegationRun(args, { backgroundEnabled, continuable })
      if (effReadonlyResearch && args.run_in_background === true) {
        throw new Error('run_in_background is not supported for read-only research: the report IS the deliverable, so a research child always runs in the foreground and its report returns in this tool result.')
      }
      const corumSessionId = parent.session.id
      const corumConcurrent = (args.fanoutCount ?? 1) > 1
        || corumRunSpec.runInBackground
        || orchestration.entriesOf(corumSessionId).some(entry => entry.status === 'active')
        || orchestration.runningWriteChildrenOf(corumSessionId) > 0
      let corumIsolate = corumShouldIsolate(effIsolationMode, corumIsWrite, effReadonlyResearch, corumConcurrent, corumIsolationRequest.placement)
      // fork（corum）：非 git 工作区自动降级（2026-09-09 用户需求）——隔离依赖 git
      // 仓库（worktree/branch/verify/integrate 全在 git 上），非 git 目录下强制不隔离，
      // 避免 `git worktree add` 报 `fatal: not a git repository`（实测 ai-lab）。即使用户
      // 在「新建工作区」时拒绝了 git 初始化，此降级保证 git 依赖能力自动关闭而非报错。
      //
      // 2026-09-10 核查：强制隔离（模式 always / 任务 isolation:'always'）在非 git 工作区
      // **同样降级**（不 fail loud——用户可能故意不初始化 git），但要让模型知道这次没隔离：
      // 子 Agent 的直连纪律通知会追加一句说明（见下方 corumIsolationSkipped）。
      let corumIsolationSkipped = false
      if (corumIsolate) {
        const parentCwdForRepo = parent.session.header.cwd ?? process.cwd()
        if (!corumIsGitRepo(parentCwdForRepo)) {
          corumIsolate = false
          corumIsolationSkipped = true
        }
      }
      /**
       * fork（corum）：**父 Agent 可见的隔离边界**（2026-09-13 用户定调「先做可见性」）。
       *
       * 只有**写委派**才有意义（只读调研不落盘，边界对父 Agent 无所谓）：它回答
       * 「这次改动落在哪」——隔离 worktree（要 integrate 才进主树）还是**已经在你的
       * 主工作区里了**。此前这件事只写在给子 Agent 的提示词里，父侧从结果读不出来，
       * 于是 2026-09-12 的探针把「没隔离」当成了「隔离了」。
       *
       * ⚠️ 2026-09-18 修正：**两档都要报**。此前只报「没隔离」那一档，理由是「worktree 是
       * 常规路径、无需提醒」——但隔离成功时模型**必须**做一件事（`integrate: true`）才能把
       * 改动并进主树，不报就等于让它以为交完活了（作者 2026-09-18 实测中招：两次隔离委派都
       * 没收到任何提示，工作卡在分支上）。「无需提醒」把最需要提醒的一档给省掉了。
       *
       * **2026-09-16 不变式⑤**：写委派恒隔离 ⇒ git 工作区下不再有「直落父树」这一档；
       * 唯一残留的「没隔离」是**非 git 工作区**的自动降级（worktree 建不出来）。
       */
      const corumIsolationBoundary: 'worktree' | 'skipped-non-git' | 'main-requested' | undefined =
        !corumIsWrite || effReadonlyResearch
          ? undefined
          : corumIsolate
            ? 'worktree'
            : corumIsolationRequest.placement === 'main'
              ? 'main-requested'
              : corumIsolationSkipped ? 'skipped-non-git' : undefined

      // fork（corum）：机制追加的 deny 必须收敛到「本 preset 真正注册的工具名」——
      // `tools.restrict()` 对未知名 fail-loud，而 corum 的写工具名单是平台硬编码
      // （str_replace_editor 只有挂 str-replace-editor 行的 preset 才有；官方
      // standard/ptc/cordis 挂的是 write/edit）。不收敛则子 Agent 创建直接抛错
      // （2026-09-10 实机：官方三模式全部派不出子 Agent）。口径与边界见
      // corumNarrowDenyFilter 的注释。
      const corumSetMechanismFilter = (
        filter: { allow?: string[]; deny?: string[] } | undefined,
      ): void => {
        const narrowed = filter === undefined
          ? undefined
          : corumNarrowDenyFilter(filter, corumVisibleToolNames(parent.ctx))
        if (narrowed === undefined) delete request.toolFilter
        else request.toolFilter = narrowed
      }

      // fork（corum）：任务级 research 的只读硬约束——orchestrate 的 tasks[i].research
      // 名实相符：research=true 的任务 deny **变异**工具（write/edit/str_replace_editor）
      // 且沙箱钉 read-only；shell 保留（调研要跑命令），只读性由沙箱层保证
      // （2026-09-12 用户定调：research 开放 shell，但改不了仓库）。
      const researchFilter = corumResearchToolFilter(config.toolFilter, effReadonlyResearch)
      if (researchFilter !== undefined) corumSetMechanismFilter(researchFilter)

      // fork（corum）：integrate 召唤（fan-in/Manager）——恒前台路径（机制强制）。
      // fan-in 汇合的本质是同步等待点：主 Agent 必须等到集成者 merge+verify 的结果
      // 才能做最终验收，后台路径（continuable/one-shot background）拿不到结果无意义。
      // 此前用「runSpec.runInBackground 时抛错」要求模型显式 run_in_background:false
      // 压过 continuable 默认后台——把机制成本转嫁给模型（编排者等 continuable 实例
      // 的 Agent 很难记住该约束，实机反复撞「integrate must run in foreground」）。
      // 修正：integrate 恒由机制强制前台（integrate 是 corum 自研，非官方语义；
      // 删 throw，不再读 run_in_background/continuable 默认值），既保 fan-in 语义
      // 又消掉一类报错。下游 settleForegroundRun 本就是前台 settle，无需其它改动。
      if (args.integrate === true) {
        const sessionId = parent.session.id
        const entries = orchestration.entriesOf(sessionId)
        const pending = corumPendingIntegration(entries)
        if (pending.length === 0) {
          throw new Error('no isolated worktrees to integrate')
        }
        const parentCwd = parent.session.header.cwd ?? process.cwd()
        // 拒绝时随错误带出的分支快照（抛出后 `entriesOf` 会按 git 实况对账翻转这些条目）。
        const corumPendingBranchNames = pending.map(entry => entry.branch)
        // 2026-09-21 裁定：核查命令恒按父 cwd 探测；合并者恒 'parent'。
        const effectiveChecks = corumDetectIntegrateChecks(parentCwd)
        const declaredVerify = typeof args.verify === 'string' && args.verify.trim() !== '' ? args.verify : undefined
        const corumIntegrateRequest = {
          ...request,
          cwd: parentCwd,
          persona: corumIntegratorPersona(pending, effectiveChecks, 'parent', declaredVerify),
          prompt: [{
            type: 'text',
            text: corumIntegratorPersona(pending, effectiveChecks, 'parent', declaredVerify) + '\n\n' + String(args.prompt),
          }] as ContentBlock[],
        }
        // fork（corum）：机制真值门禁的前置快照（主树 HEAD + 未提交基线）。
        const corumHeadBefore = corumGitHead(parentCwd)
        const corumDirtyBefore = corumGitStatusPorcelain(parentCwd)
        // fork（corum）2026-09-20（机制 bug 修复）：**在集成者启动之前**快照每条分支的 tip。
        //
        // 这是唯一可靠的快照时机：集成者是子 Agent，它 merge 完完全可能顺手
        // `branch -D`（机制自己的 persona/清理都在鼓励这个合规收尾）。分支一没，
        // 之后按**分支名**跑 `merge-base --is-ancestor` 与 `git cherry` 都非零退出 ⇒
        // 判定 false ⇒ 一次**真的落了地**的集成被报成
        // `Error: integrate did not persist into the main tree`。
        // sha 快照不会消失：它之后用来证明「这条工作已经在 HEAD 的祖先链上」。
        const corumSnapshotted = corumSnapshotBranchTips(parentCwd, pending)
        runtimeCtx.logger.info(
          `integrate: snapshotted tip for ${corumSnapshotted}/${pending.length} pending branch(es) before integrator start`,
        )
        const run: SubagentRun = await runtimeCtx.subagents.start(config.provider, {
          ...corumIntegrateRequest,
          signal: exec.signal,
        })
        // fork（corum）：**集成者也是子会话**——它这条路此前漏了 spawn 广播（前台/后台
        // 两条路径都有），于是编排卡在「集成中」那一整段拿不到子会话 id：用户实测
        // 「Agent 在集成但状态没有变，也没有按钮进入会话查看详情」。这里补上广播
        // （label 由调用方给 = 'integrate'），卡的「进入集成者会话」按钮即可点。
        // 集成者不建 worktree（`corumEntryInfo` 在这条路上不存在），故 worktree 传 undefined。
        corumEmitChildStarted(parent.session.id, exec.callId, String(run.id), args.label, corumIsolate, 'foreground', undefined, corumSpawnModel)
        const outcome = await settleForegroundRun(run)
        // fork（corum）：集成成功**不再由集成者自述决定**——`settleForegroundRun` 只
        // 保证子 Agent 正常结束，不代表它真的把分支合进了主树。2026-09-09 事故：
        // 集成者自称「已 merge + verify 通过」→ 机制无条件写 integrated 并
        // `worktree remove --force` + `branch -D` → 子任务 commit 变 unreachable、
        // 文件从主树消失（docs/TODO.md 高优先项）。此处按 git 实况判定：
        //   ① 每个待集成分支必须已并入 HEAD（祖先或 patch 等价）；未达标 → 抛错
        //      （附「集成者自述 vs git 实况」对照）+ **保留 worktree 与分支**
        //      + 台账保持 settled（PLAN 不变量「失败不 commit、保留现场」的机制化）；
        //   ②（2026-09-16）声明式 verify 的退出码见下方 `corumIntegrationVerdict`。
        // fork（corum）2026-09-20：判定前**再刷新一次** tip 快照。分支若仍在（集成者只是
        // merge、没删分支）这里刷新到最新；分支若已被合规删除，快照保留着启动前那份
        // 有效证据，判定即按 tip 的祖先关系证明并入。
        const corumSnapshottedAfter = corumSnapshotBranchTips(parentCwd, pending)
        if (corumSnapshottedAfter > 0) {
          runtimeCtx.logger.info(`integrate: refreshed branch tip(s) for ${corumSnapshottedAfter} pending entr(ies) before truth check`)
        }
        let corumTruth = corumIntegrationTruth(parentCwd, pending, corumDirtyBefore)
        // 排障日志（2026-09-16）：integrate 真值判定结果写主日志——verify 失败是否被拦住、
        // 分支并入与否，此前只能从 throw 反推（「merged+committed 但 verify 失败」无从定位）。
        runtimeCtx.logger.info(
          `integrate truth check: integrated=${corumTruth.integrated} unmerged=[${corumTruth.unmerged.join(',')}] uncommitted=[${corumTruth.uncommitted.join(',')}] head=${corumTruth.head}`,
        )
        if (!corumTruth.integrated) {
          // fork（corum）2026-09-14 用户同意 B：**脏主树/未提交场景的集成 diff 口**。
          // 集成者按纪律不许动主树里与本轮无关的在制品（persona 明禁
          // reset/checkout/clean/stash），于是脏树上的 merge 可能被拒得不明不白。
          // 这里对「没进 HEAD 的分支」逐条走 `git diff <base>..<branch>` +
          // `git apply --3way`：只落该分支自己的改动，主树既有改动参与三方合并、
          // 不被覆盖。**门禁不放宽**——补完仍按 git 实况复判，没落地照旧走失败分支。
          const unmergedEntries = pending.filter(entry => corumTruth.unmerged.includes(entry.branch))
          if (unmergedEntries.length > 0) {
            const ports = corumPortPendingBranches(parentCwd, unmergedEntries)
            const landed = ports.filter(port => port.applied)
            if (landed.length > 0) {
              runtimeCtx.logger.info(
                `integrate: applied ${landed.length}/${ports.length} unmerged branch diff(s) onto the dirty main tree (${landed.map(p => p.branch).join(', ')})`,
              )
            } else if (ports.length > 0) {
              // 排障日志（2026-09-16）：一条都没落盘时把逐条原因写主日志——此前只有
              // 「port failed」的汇总行，warn 分支在 `failed.length > 0` 之前还会漏掉
              // 「全部 applied=false 但都无 error」的形态。
              runtimeCtx.logger.warn(
                `integrate: branch diff port applied 0/${ports.length} (${ports.map(p => `${p.branch}: ${p.error ?? 'no reason reported'}`).join('; ')})`,
              )
            }
            const failed = ports.filter(port => !port.applied)
            if (failed.length > 0 && landed.length > 0) {
              runtimeCtx.logger.warn(
                `integrate: branch diff port failed for ${failed.map(p => `${p.branch} (${p.error ?? 'no reason reported'})`).join('; ')}`,
              )
            }
          }
          corumTruth = corumIntegrationTruth(parentCwd, pending, corumDirtyBefore)
          if (!corumTruth.integrated) {
            orchestration.emitFrame(sessionId)
            corumUnblockRejectedMerge(parentCwd, runtimeCtx.logger)
            const rejected = new CorumIntegrateRejected(
              'unmerged',
              corumIntegrationFailure(
                corumTruth,
                corumHeadBefore,
                pending,
                outputValueText(outcome.output),
              ),
              corumPendingBranchNames,
            ) as CorumIntegrateRejectedWithRun
            rejected.runId = String(run.id)
            throw rejected
          }
        }
        // fork（corum）：集成总判定——**两道闸门合取**（2026-09-16 根因修复）。
        //
        // 事故（用户实测，会话 corum-task-b7122dc0）：声明 `merge.verify = test -f u1.md &&
        // … && test -f zzz.md`（zzz.md 不存在），集成者如实跑了、拿到 exit 1、也按 persona
        // 没再提交——但 `git merge` 的**合并提交自己就是提交**，分支工作已进 HEAD，于是上面
        // 只判 git 实况的真值门禁报 integrated=true，机制对外宣告「merged + committed」，
        // **verify 的失败被完全忽略**。同一形态在 corum-task-d0a24b08 却被拦住，唯一差别是
        // 那次集成者用了 `git merge --no-commit`（分支 tip 没进 HEAD，真值兜住了）——
        // 成败取决于子 Agent 偶然选了哪条 git 命令。verify 是否执行、退出码是否被检查，
        // 此前**只写在 persona 提示词里**，违反「机制优先于提示词」红线。
        //
        // 现在：机制自己跑一遍声明并取退出码，非 0 ⇒ 抛错（保留现场、不翻转台账、不清理），
        // 与真值失败并列成第二种**可辨识**的失败形态（报告区分「分支没进 HEAD」与
        // 「进了 HEAD 但验收没过」，后者不替调用方回滚主树历史）。
        const corumVerdict = corumIntegrationVerdict(parentCwd, pending, corumDirtyBefore, declaredVerify)
        corumTruth = corumVerdict.truth
        if (corumVerdict.verify !== undefined) {
          const corumVerify = corumVerdict.verify
          // 排障日志（2026-09-16）：verify 门禁的退出码写主日志——此前的日志只有「verify 传了
          // 什么」，没有「跑出来是什么」，正是本次根因被漏掉的那一格。
          runtimeCtx.logger.info(
            `integrate verify gate: command=${JSON.stringify(corumVerify.command)} exit=${corumVerify.code} ok=${corumVerify.ok} timedOut=${corumVerify.timedOut} took=${corumVerify.durationMs}ms`,
          )
          if (!corumVerdict.integrated) {
            orchestration.emitFrame(sessionId)
            corumUnblockRejectedMerge(parentCwd, runtimeCtx.logger)
            const rejected = new CorumIntegrateRejected(
              'verify',
              corumVerifyFailureNotice(corumVerify, corumTruth, corumHeadBefore, pending),
              corumPendingBranchNames,
            ) as CorumIntegrateRejectedWithRun
            rejected.runId = String(run.id)
            throw rejected
          }
        }
        // fork（corum）2026-09-12：**部分集成**不再判死整次 fan-in。旧口径把
        // `uncommitted`（任何兄弟 worktree 的未提交残留）也算进 `integrated`，实测
        // 让一次已落地的集成被报成失败（corum-task-d51272e3：wt-5700d6 一个 scratch
        // 文件 → 主 Agent 的「验证/提交」三阶段整条没起来）。现在只把**已并入 HEAD**
        // 的条目翻转 + 清理；残留未提交的条目**保持 pending、保留现场**，并显式通知
        // 主 Agent（补提交后再次 integrate，或明确丢弃）。
        const leftover = new Set(corumTruth.uncommitted.map(text => text.split(' ')[0]))
        const landed = pending.filter(entry => !leftover.has(entry.slug))
        if (landed.length > 0) orchestration.markIntegrated(sessionId, landed, true)
        if (corumTruth.uncommitted.length > 0) {
          orchestration.emitFrame(sessionId)
          runtimeCtx.logger.warn(`integrate partially persisted: ${corumTruth.uncommitted.join(', ')} kept pending`)
          corumNotifyPartialIntegration(parent, String(run.id), corumPartialIntegrationNotice(corumTruth, corumHeadBefore), runtimeCtx.logger)
        }
        return outcome
      }

      // fork（corum）：worktree 创建（隔离触发时，父会话 header.cwd 下）。
      // 条目先登记（run id 尚不可知），start 返回后立刻经 corumBindRun 绑定 id——
      // 这是 settle 精确匹配（并行安全）的前置（docs/TODO.md 2026-09-09 修复）。
      let corumEntry: { sessionId: string; slug: string } | undefined
      // fork（corum）：广播用 worktree 三件套（无隔离时 undefined）。
      let corumEntryInfo: { slug: string; branch: string; path: string } | undefined
      if (corumIsolate) {
        // fork（corum）：worktree 创建下沉到编排服务（工具层与 isolated provider 共用同一
        // 实现，见 CorumOrchestration.createWorktreeChild）。通知文本同样是单一事实源。
        const parentCwd = parent.session.header.cwd ?? process.cwd()
        const sessionId = parent.session.id
        const child = orchestration.createWorktreeChild(sessionId, parentCwd, {
          maxParallelChildren: corumMaxParallelChildren,
        })
        corumEntry = { sessionId, slug: child.slug }
        corumEntryInfo = { slug: child.slug, branch: child.branch, path: child.path }
        request.cwd = child.path
        // fork（corum）2026-09-22：隔离**真的建成了** ⇒ 钉沙箱 + 装写边界门禁（修法 1+2）。
        // ⚠️ 必须在 `createWorktreeChild` 成功之后设置：放在这里而不是函数开头，正是为了让
        // 「非 git 工作区降级」「集成者（走 parentCwd，不建 worktree）」「track(ralph)」这些
        // **必须写主树**的路径自动落在 `corumIsolate === false`，不被误钉。
        //
        // 为什么需要（实测，会话 `corum-task-ef3f751e`）：隔离的第 2 层是 fs 写沙箱，而沙箱
        // 按**档位**开关；子会话此前整体继承父档位 ⇒ 用户切「完全权限」后隔离当场失效
        // （worker 删掉 19 个 worktree 并对主树 `git -C <主树> merge --no-ff`）。
        // `confinedSandbox` 把它钉在**不可被用户档位覆盖**的轴上（与 research 的
        // `readonlySandbox` 同一手法），边界 = 子会话 cwd = 这个 worktree。
        request.confinedSandbox = true
        corumSetMechanismFilter(corumEffectiveToolFilter(config.toolFilter, true))
        request.prompt = [{ type: 'text', text: corumIsolationNotice(child) + args.prompt }] as ContentBlock[]
      } else if (corumIsWrite && !effReadonlyResearch) {
        // fork（corum）：不隔离的写任务（单发前台，无并发）直接在主工作区改——必须明确
        // 告诉它「不要碰版本控制」（文本见 corumDirectWriteNotice 的单一事实源）。
        // 非 git 工作区导致隔离被跳过时追加一句，避免模型误以为自己在隔离环境里。
        // 2026-09-27 P2：按**原因**传参（三个原因的前提与权限不同，不能一刀切）。
        const corumMainTreeReason = corumIsolationBoundary === 'main-requested' ? 'caller-requested-main' : 'skipped-non-git'
        request.prompt = [{ type: 'text', text: corumDirectWriteNotice(corumMainTreeReason) + args.prompt }] as ContentBlock[]
      }
      /** fork（corum）：把 run/child id 绑定到本次 spawn 的台账条目（无隔离时 no-op）。 */
      const corumBindRun = (runId: string): void => {
        if (corumEntry !== undefined) orchestration.bindRunId(corumEntry.sessionId, corumEntry.slug, runId)
      }
      /**
       * fork（corum）：spawn 失败回滚（无隔离时 no-op）。
       *
       * 台账条目在 start **之前**登记，start 抛错会让它永远 active 且无 runId：占满
       * maxParallelChildren 额度，并让该会话后续派遣恒命中并发信号③而强制隔离。
       * 此时子 Agent 从未执行过任何工具，worktree/分支都是本次 spawn 的产物，强清理安全。
       * （2026-09-10 实机：官方 preset 的子 Agent 因 deny 未知名创建失败，三个会话各泄漏数条。）
       */
      const corumDiscardEntry = (): void => {
        if (corumEntry === undefined) return
        orchestration.discardEntry(corumEntry.sessionId, corumEntry.slug)
        corumEntry = undefined
      }
      /** fork（corum）：spawn 包装——start 抛错时先回滚台账条目（无隔离时 no-op）。 */
      const corumStart = async <T>(start: () => Promise<T>): Promise<T> => {
        try {
          return await start()
        } catch (error: unknown) {
          corumDiscardEntry()
          throw error
        }
      }
      // fork（corum）：非隔离的前台写子 Agent 登记进并发计数（同消息并发调用时，
      // 后一个 spawn 才能看到「已经有一个在写主工作区」而选择隔离）。后台/continuable
      // 的子 Agent 由 runSpec 信号②恒判并发，无需计数，避免跨调用泄漏。
      const corumTrackWrite = corumIsWrite && !effReadonlyResearch && !corumRunSpec.runInBackground

      // fork（corum）2026-09-18：**异步失败的提问前置**——把「用户为该角色配的模型 /
      // label / 角色」与即将产生的 run/child id 绑定，供 `subagent/end` 到达时问用户。
      //
      // 为什么必须在这里记：后台一次性与 continuable 的失败**不在本工具调用的栈上**
      // （工具早已带着 jobId/子会话 id 返回），到 `subagent/end` 时只剩 runId/childId
      // 与 stopReason——那时再想拿「配置的模型是哪个」已经无从取。只对**锁定路由**的
      // 委派登记：没配模型的委派本来就用主路由，失败与"配置模型不可用"无关。
      const corumSpawnFacts: CorumChildSpawnFacts | undefined = corumEffectiveModel !== undefined
        ? {
            parentSessionId: String(parent.session.id),
            label: args.label,
            role: (effReadonlyResearch ? 'research' : 'worker') as 'worker' | 'research',
            configured: { provider: corumEffectiveModel.provider, model: corumEffectiveModel.model },
            // 用户两规则的分界：能 continue 的续跑同一子会话，一次性的只能重新指派。
            continuable,
          }
        : undefined

      if (corumRunSpec.runInBackground) {
        /**
         * fork（corum）2026-09-26：**锁定模型已不可用 ⇒ 后台路径也要先问，不起死会话**。
         *
         * 后台/continuable 的子会话失败**不在工具调用栈上**（工具早已带 jobId/子会话 id
         * 返回），原本只能等 `subagent/end` 事后问用户——那意味着先白跑一轮。预检失败在
         * 委派前就已知，故这里**在前台式地问一次**：走同一个 `corumAskAboutModel`
         * （同一入口、同一三个选项、同一「至多问一次」去重），语义与用户 2026-09-18 的
         * 裁定一致，只是把时机提前。
         *
         * 用户选「临时/永久换模型」⇒ 用主 Agent 路由重跑（清掉角色锁，与前台 attempt 1 同款）；
         * 选「否」或问不到 ⇒ 如实把「模型不可用」抛回主 Agent（规则 2 的下半句）。
         */
        if (corumLockedRouteFailure !== undefined) {
          const configuredRoute = corumEffectiveModel !== undefined
            && parentOptions.provider !== undefined && parentOptions.model !== undefined
            ? { configured: { provider: corumEffectiveModel.provider, model: corumEffectiveModel.model } }
            : undefined
          if (configuredRoute === undefined) {
            throw new Error(
              `subagent (${args.label}): the configured child model `
              + `${corumEffectiveModel?.provider}/${corumEffectiveModel?.model} is unavailable `
              + `(${corumLockedRouteFailure}) and the parent route is unresolvable, so no fallback can be offered`,
            )
          }
          const asked = await corumAskAboutModel(
            parent,
            args.label,
            effReadonlyResearch ? 'research' : 'worker',
            configuredRoute.configured,
            corumLockedRouteFailure,
            exec.signal,
            args.notifyParent !== false,
            // 子会话尚未 spawn（后台预检在委派前已知模型不可用）⇒ 无 childId，
            // corumAskAboutModel 内部走 logger.warn（不注入 subagent-settled notice）。
            undefined,
          )
          if (asked.route === undefined) {
            throw new Error(
              `subagent (${args.label}): the configured child model `
              + `${corumEffectiveModel?.provider}/${corumEffectiveModel?.model} is unavailable `
              + `(${corumLockedRouteFailure}) and no fallback was authorized`,
            )
          }
          // 用户授权 → 改走主 Agent 路由（与前台重跑同款：清掉角色锁）。
          delete request.agentOptions
        }
        if (continuable) {
          const started = await corumStart(() => runtimeCtx.subagents.startContinuable({
            provider: config.provider,
            label: args.label,
            request,
            signal: exec.signal,
          }))
          // continuable 登记的是 childId（settle 事件按 childId 精确匹配）。
          corumBindRun(String(started.childId))
          if (corumSpawnFacts !== undefined) orchestration.rememberChildSpawn(String(started.childId), corumSpawnFacts)
          corumEmitChildStarted(parent.session.id, exec.callId, String(started.childId), args.label, corumIsolate, 'background', corumEntryInfo, corumSpawnModel)
          try {
            args.onChildStarted?.(String(started.childId))
          } catch (error: unknown) {
            runtimeCtx.logger.warn(`subagent (${args.label}): onChildStarted hook failed: ${String(error)}`)
          }
          return { kind: 'continuable' as const, subagentId: started.childId }
        }
        const jobs = runtimeCtx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        const id = jobs.start({
          kind: 'subagent',
          label: args.label,
          owner: parent,
          run: () => {
            const controller = new AbortController()
            const start = corumStart(() => runtimeCtx.subagents.start(config.provider, { ...request, signal: controller.signal }))
            // 后台路径的 run 在 job 启动后才创建——start 解析即绑定。
            void start.then((startedRun) => {
              corumBindRun(String(startedRun.id))
              if (corumSpawnFacts !== undefined) orchestration.rememberChildSpawn(String(startedRun.id), corumSpawnFacts)
              corumEmitChildStarted(parent.session.id, exec.callId, String(startedRun.id), args.label, corumIsolate, 'background', corumEntryInfo, corumSpawnModel)
              // fork（corum）2026-10：后台路径同样要**在 settle 之前**登记（编排黑盒化）。
              try {
                args.onChildStarted?.(String(startedRun.id))
              } catch (error: unknown) {
                runtimeCtx.logger.warn(`subagent (${args.label}): onChildStarted hook failed: ${String(error)}`)
              }
            }).catch(() => {})
            return {
              cancel: (reason?: string) => {
                controller.abort(reason ?? 'background subagent task killed')
              },
              done: settleStart(start, controller.signal),
            }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }

      if (corumTrackWrite) orchestration.beginWriteChild(corumSessionId)
      try {
        /**
         * fork（corum）2026-09-18：前台失败 ⇒ **问用户**（用户两规则里的第 2 条「一次性任务」）。
         *
         * ⚠️ 语义已从「机制自动退回主路由重试一次」改为「**先问用户，得到许可才动**」——
         * 用户 2026-09-18 定调：机制可以全权执行，但**不许替用户做主**。故这里不再有任何
         * 自动重跑：失败后先问，选「是」才用主 Agent 模型**重新指派**完成任务。
         *
         * 判定用官方契约（`SubagentRun.result` 文档明写）：**模型/传输失败以
         * `stopReason: 'error'` 返回**（不 reject），`settleForegroundRun` 把它转成带
         * stopReason 的 throw。其余终态（aborted / max-tokens / refusal）**不是模型不可用**，
         * 不触发本机制（重跑只会把同样结局再演一遍并重复收费）。
         *
         * 「预检」也算失败判据：锁定路径不走下面的 `preflightChildLlmRoute`，于是配错的模型
         * 有两种失败形态——spawn 期解析失败（provider/model 不存在，若不预检就直接抛出去，
         * 用户看到「任务失败」而非「模型不可用」）、运行期失败（stopReason==='error'）。
         */
        const configuredRoute = corumEffectiveModel !== undefined
          && parentOptions.provider !== undefined && parentOptions.model !== undefined
          ? {
              configured: { provider: corumEffectiveModel.provider, model: corumEffectiveModel.model },
            }
          : undefined
        /** 子 Agent 是否因**模型调用**失败（官方契约：stopReason === 'error'）。 */
        const modelFailureOf = (error: unknown): string | undefined => {
          const stopReason = (error as { stopReason?: string } | undefined)?.stopReason
          return stopReason === 'error' ? (error instanceof Error ? error.message : String(error)) : undefined
        }

        const startRun = (): Promise<SubagentRun> => corumStart(() => runtimeCtx.subagents.start(config.provider, {
          ...request,
          signal: exec.signal,
        }))
        const emitStarted = (started: SubagentRun): void => {
          corumBindRun(String(started.id))
          corumEmitChildStarted(parent.session.id, exec.callId, String(started.id), args.label, corumIsolate, 'foreground', corumEntryInfo, corumSpawnModel)
          // fork（corum）2026-10：编排登记必须**在 settle 之前**完成（见 `onChildStarted` 的说明）。
          try {
            args.onChildStarted?.(String(started.id))
          } catch (error: unknown) {
            runtimeCtx.logger.warn(`subagent (${args.label}): onChildStarted hook failed: ${String(error)}`)
          }
        }

        /**
         * 至多两轮：① 用户配置的路由；② **用户同意后**用主 Agent 路由重新指派。
         *
         * 第②轮只在用户明确选了「是」时才跑（`corumAskAboutModel` 返回 route）；
         * 选「否」或问不到 ⇒ 不重跑，如实把失败抛给主 Agent，由它自己接手（规则 2 的
         * 「主 Agent 全权承担开发直到任务完成」）。
         */
        let outcome: ForegroundToolResult | undefined
        let configuredFailure: string | undefined
        /** 最终 settle 的那次 run 的 id（通知标题用它；重跑轮会覆盖成新 run）。 */
        let settledRunId = ''
        /** fork（corum）：失败子 Agent 的上下文（attempt 0 失败后提取，attempt 1 注入）。 */
        let failedChildContext: CorumFailedChildContext | undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt === 0) {
            // fork（corum）2026-09-26：锁定路由的预检失败在委派前已知（见上方
            // `corumLockedRouteFailure` 的说明）——直接进「问用户」，不启死会话。
            if (corumLockedRouteFailure !== undefined) {
              configuredFailure = corumLockedRouteFailure
              break
            }
            const llm = runtimeCtx.get('llm')
            if (llm !== undefined) {
              try {
                await preflightChildLlmRoute(
                  llm,
                  parentOptions,
                  request.agentOptions,
                  exec.signal,
                  providerRouteDefaults === undefined,
                )
              } catch (error: unknown) {
                // 配置的路由解析不了 ⇒ 判「模型不可用」并直接进「问用户」分支（不启死会话）。
                configuredFailure = error instanceof Error ? error.message : String(error)
                break
              }
            }
          }
          const run = await startRun()
          emitStarted(run)
          settledRunId = String(run.id)
          try {
            outcome = await settleForegroundRun(run)
            break
          } catch (error: unknown) {
            const reason = modelFailureOf(error)
            // 非模型失败（aborted / max-tokens / refusal）⇒ 原样抛出，本机制不管。
            if (reason === undefined) throw error
            if (attempt === 0) {
              // 第一轮就模型失败：**先问用户**，得到许可才重跑。
              if (configuredRoute === undefined) throw error
              const asked = await corumAskAboutModel(
                parent,
                args.label,
                effReadonlyResearch ? 'research' : 'worker',
                configuredRoute.configured,
                reason,
                exec.signal,
                args.notifyParent !== false,
                settledRunId,
              )
              if (asked.route === undefined) throw error
              // fork（corum）：提取失败子 Agent 的上下文，注入到重跑的 prompt 里——
              // 新子 Agent「接着做」而非「从头做」，避免重复调用工具。
              failedChildContext = await corumExtractFailedChildContext(ctx, settledRunId, exec.signal)
              if (failedChildContext !== undefined) {
                request.prompt = corumBuildResumePrompt(request.prompt, failedChildContext)
              }
              // 用主 Agent 路由重跑：清掉角色锁的 agentOptions（缺失时官方 seam 用父路由）。
              delete request.agentOptions
              continue
            }
            // 第二轮（用户已许可的重跑）仍模型失败 ⇒ 不再追问，原样抛出。
            throw error
          }
        }
        if (outcome === undefined) {
          if (configuredFailure !== undefined && configuredRoute !== undefined) {
            // spawn 期就解析不了：同样走「问用户」——用户许可才重跑（此时不启动死会话）。
            const asked = await corumAskAboutModel(
              parent,
              args.label,
              effReadonlyResearch ? 'research' : 'worker',
              configuredRoute.configured,
              configuredFailure,
              exec.signal,
              args.notifyParent !== false,
              // spawn 期失败（configuredFailure）⇒ 子会话从未建立，settledRunId 为空。
              // 传 undefined ⇒ corumAskAboutModel 内部走 logger.warn（不注入 notice）。
              settledRunId !== '' ? settledRunId : undefined,
            )
            if (asked.route !== undefined) {
              delete request.agentOptions
              const run = await startRun()
              emitStarted(run)
              settledRunId = String(run.id)
              outcome = await settleForegroundRun(run)
            } else {
              // 用户没同意 ⇒ 如实报告「模型不可用」让主 Agent 接手（规则 2 的下半句）。
              throw new Error(
                `subagent (${args.label}): the configured child model `
                + `${configuredRoute.configured.provider}/${configuredRoute.configured.model} is unavailable `
                + `(${configuredFailure}) and no fallback was authorized`,
              )
            }
          }
        }
        if (outcome === undefined) {
          // 循环只有「成功 break」与「抛出」两种出口，故此处不可达；保留是为了让
          // `outcome` 在类型上收敛为非空（去掉它会退化成 `possibly undefined`）。
          throw new Error('subagent run produced no outcome')
        }
        // fork（corum）2026-09-18：这里**不再有**「已自动回退」的收尾——回退只在用户
        // 明确同意后发生，而「同意」这件事本身已在 `corumAskAboutModel` 里问过并通知过
        // （见该函数的 `corumNotifyModelDecision` 投递）。此处的成功路径只管汇报结果。
        // fork（corum）：前台子 Agent 的最终汇报注入父会话（2026-09-09 用户反馈
        // 「子 Agent 结束后反馈没有注入主 Agent」）。工具结果里本来就有汇报，但它埋在
        // 工具卡里、容易被忽略，且子会话卡片只显示进度与任务提示词——这里按后台子
        // Agent 的同款「settlement notice」形态再注入一条正式消息（form:'notice'，
        // 会话流里渲染成一条可见的注入行），汇报以一等消息出现。
        if (args.notifyParent !== false) {
          corumNotifyForegroundResult(parent, settledRunId, args.label, outcome, toolName, runtimeCtx.logger)
        }
        /**
         * fork（corum）2026-10 修复③（B 方案）：**单个 research 子 Agent 的报告落盘**。
         *
         * 用户需求：research 报告的留存语义要覆盖**单发** `subagent_research`（只读）。
         * 它的前台一次性 settle 之后会话即销毁（#75），结论若没被及时用上就丢了。
         *
         * 落点就是这里——前台 settle 之后、结果回传主 Agent 之前，**主进程侧**写盘
         * （research 子 Agent 自己只读，写不了）。
         *
         * 判据用 `args.notifyParent !== false`：这正是「主 Agent 是这份结果的读者」那一条
         * （orchestrate 的任务与 closer 都传 `notifyParent: false`——它们的正文另有去向：
         * 交给 closer，绝不能在这里被阈值截断）。
         */
        const researchDelivery = effReadonlyResearch && args.notifyParent !== false
          ? corumResearchReportDelivery({
              childSessionId: settledRunId,
              label: args.label,
              report: corumOutputText(outcome.output).trim(),
            })
          : undefined
        if (researchDelivery !== undefined && researchDelivery.written === false && researchDelivery.truncated) {
          // 落盘失败**不抛**（正文仍是交付物），但主日志要留痕：这种情况下大结果的正文
          // 只剩截断摘要，是真正需要人看一眼的形态。
          runtimeCtx.logger.warn(
            `research report could not be saved to ${researchDelivery.reportPath}; `
            + 'only the truncated excerpt will reach the delegating agent',
          )
        }
        // fork（corum）：把「这次改动落在哪」附在**工具结果**上（用户 2026-09-13 定调）。
        // 只在没隔离时附（worktree 是常规路径，报告由 integrate 负责）。
        const withBoundary = corumIsolationBoundary === undefined
          ? outcome
          : { ...outcome, isolationBoundary: corumIsolationBoundary }
        if (researchDelivery === undefined) return withBoundary
        // 回传形态按 B 方案分流：小结果全文 + 路径，大结果摘要 + 路径引用（正文在盘上）。
        // ⚠️ 只替换 **text** 块，非 text 块（图片等）原样保留——报告落盘不该顺手丢掉
        // 子 Agent 产出的其它内容形态。
        return {
          ...withBoundary,
          output: [
            { type: 'text', text: researchDelivery.text },
            ...(outcome.output as unknown as readonly ContentBlock[])
              .filter(block => block.type !== 'text'),
          ] as unknown as JsonValue[],
          reportPath: researchDelivery.reportPath,
        }
      } finally {
        if (corumTrackWrite) orchestration.endWriteChild(corumSessionId)
      }
    }

    const mount = (subagentProvider: SubagentProvider): void => {
      assertSubagentProviderConfiguration(subagentProvider)
      const wording = providerWording(subagentProvider.inheritsParentContext)
      const providerRouteDefaults = subagentProvider.agentRouteDefaults
      const disposeTool = runtimeCtx.tools.register(defineTool({
        name: toolName,
        // fork（corum）：描述头追加隔离语义（英文，接在官方 wording 前）。
        // 2026-09-16 不变式⑤：凡**写**委派恒隔离（前台/后台/可继续一视同仁，无逃生口）；
        // 只读研究委派不隔离（它不落盘）。
        // fork（corum）2026-09-27 审计修正：描述头按**能力面**分档。只读实例没有
        // `isolation`/`integrate`/`verify` 参数（见下方条件块），照搬写向文案等于
        // 「教模型用一个不存在的参数」——指令与能力矛盾，本仓明令禁止。
        // fork（corum）2026-10-04 裁决「提示词加成本维度」：能力维度之外再补
        // **成本维度**——隔离的存在理由是让并发写者互不碰撞；单委派、树干净、
        // 无并行时隔离买不到任何东西反而付隔离税（无 node_modules 不能 build/
        // 装依赖、改动须多一轮 integrate 才可见），此时优先 `isolation: "main"`；
        // 一旦出现第二个并发写者立即回默认隔离。
        description: (corumReadonlyResearch
          ? 'This tool delegates a READ-ONLY research task: the child can read files, search, and run read-only shell commands, but it cannot write — there is no worktree, no branch, and nothing to merge. **It also has no MCP tools**: never route MCP work through it (the call would fail in the child). It returns what it found, not where a change landed. '
          : 'A write-capable delegation is ISOLATED by default: it gets its own git worktree + branch, so its edits reach your tree only through integration (`subagent { integrate: true }`, or automatically for an `orchestrate` call). Pass `isolation: "main"` when the child must work in your REAL tree instead — builds/installs, `git push`, merging, another repository, or any path outside this one: a default (isolated) child is hard-denied those and no approval card will appear. Cost dimension: isolation exists to keep CONCURRENT writers apart and protect an in-progress parent tree. For a SINGLE delegation with a clean tree and no parallel work it buys nothing and costs you (the worktree has no node_modules — no build/install/typecheck — and the edits stay invisible until you integrate): prefer `isolation: "main"` there; the moment a second concurrent writer exists (parallel children, background subagents, uncommitted work in your tree) the default isolated route is what you want. A read-only research delegation is not isolated (it writes nothing). A FOREGROUND result tells you which route ran, so you never have to guess whether a branch carries the work; a backgrounded run reports through its settlement notice instead, so do not expect the boundary marker there. ')
          + wording.description + corumSchedulingDescription({ backgroundEnabled, continuable, readonlyResearch: corumReadonlyResearch })
          // fork（corum）：决策点分工（2026-09-14 委派正确性轮）——工具描述是模型
          // 选工具时唯一**贴着选择点**读到的文本，因此分工必须写在这里，而不是只
          // 写在机制段里。只读调研走 `subagent_research`（无修改 → 不召唤写能力
          // 子 Agent，隔离/分支/集成对只读工作没有意义）。只读实例自身不注入这段
          // （它没有别的委派工具可选）。
          + (corumReadonlyResearch
            ? ''
            // fork（corum）2026-09-14 修正（用户点名「主 Agent 派 research 去验收」）：
            //
            // 原文把 `verification by inspection`（验收）整类划给只读研究工具，模型照做 ⇒
            // **执行型验收被派给没有 write 工具的子会话**，派单里于是出现「不许改任何文件」
            // 与「必须造 fixture」并存的矛盾要求（实证：会话 `6364e3ea` 派单同时含这两句）。
            //
            // 改为按**是否需要执行**分流，并把两者的**工具面边界**写清 —— 决策点上模型唯一
            // 贴着选择点读到的文本就是这里：
            //   · `subagent_research`：有 shell 可跑只读命令，但 **write/edit 被拒、沙箱锁 read-only**；
            //   · 本工具（写能力）：bash + read + **write/edit**，可在仓库内落盘。
            // 需要跑断言、造 fixture、落盘证据的验收 ⇒ 必须用本工具。
            : ' Choose by whether the subtask must EXECUTE or only JUDGE. `subagent_research` is read-only: it has a shell for read-only commands, but **write/edit are denied and its sandbox is pinned to `read-only`**, so it can never create a file, a fixture, or an evidence artifact inside the repo. Use it for knowledge work and judgement-by-reading — research, search, fact-finding, summarization, comparing an implementation against a spec by reading code. Call THIS write-capable tool whenever the subtask must create or modify anything, including **executable verification**: running assertions, building a fixture or temp home, or writing evidence files. Running a verification is not the same as inspecting one. Never ask a read-only child to write: a "do not modify files" instruction and a "create this fixture" instruction cannot both hold — if you must both constrain writes and require a fixture, use this tool and scope the writes explicitly. A subtask that changes nothing must not be given a write-capable child: isolation, branches and merging all exist for changes.'),
        parameters: {
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: wording.promptDescription,
          },
          // fork（corum）2026-09-20：主 Agent 动态注入的**叠加层**人格（用户定调「叠加，且
          // 不可覆盖机制层」）。子 Agent 的角色契约由机制按种类写死（执行者/调查员），本参数
          // 只补充**本次任务**的领域上下文与约定，拼在机制人格之后，无法删除或覆盖它。
          roleContext: {
            type: 'string' as const,
            description: 'OPTIONAL extra context for the child\'s role — domain expertise and conventions for THIS subtask (e.g. "this repo is a pnpm monorepo; the change must stay Node 18 compatible"), not a replacement for its role. The child already has a fixed role contract (executor or investigator) that you cannot override; whatever you write here is appended after it. Keep it short (a few sentences); it is truncated past 2000 characters.',
          },
          // fork（corum）：模型锁——schema 剔除 provider/model/reasoning_effort
          // 三个参数（官方 modelSelectionEnabled 条件展开块恒不展开）；LLM 物理上
          // 无法表达模型偏好，固定路由由 config.model 注入。
          // fork（corum）2026-09-27（用户裁定 A）：**显式非隔离派发**。只读研究实例不声明它
          // （research 恒不隔离、沙箱 read-only，声明了也没有意义）。
          ...corumReadonlyResearch ? {} : {
            isolation: {
              type: 'string' as const,
              description: 'Where this child works. Omit for the normal route: it gets its OWN isolated git worktree + branch, so its commits need `integrate: true` before they reach your tree (an `orchestrate` call merges them for you automatically). Pass "main" ONLY when the child must write OUTSIDE this repository — materializing a new repository, touching a sibling checkout — or must land work straight into your tree: it then works directly in your main working tree with your own sandbox mode, so there is no branch and nothing to merge. Isolation is a WORKSPACE boundary (concurrent writers must not collide), not a permission wall; the trade-off is that another writer can collide with a "main" child. Do NOT combine with `integrate: true` — that is the integrator route and already runs on your tree.',
            },
            // 2026-09-27 审计修正：**整合者路由与仓库验收声明同属写能力面**，原先写在条件之外
            // ⇒ 只读实例的 schema 里也出现 `integrate`/`verify`，等于允许只读子 Agent 走
            // 「主树合并 + 验证 + 提交」。只读实例一律不声明它们。
            integrate: {
              type: 'boolean' as const,
              description: 'Set true to merge all isolated worktree branches of this session back into the main working tree, run the verification, and commit. Use after parallel development children have settled.',
            },
            // fork（corum）：主 Agent 声明的仓库验证方式（2026-09-08 用户定调：静态穷举不可能
            // 覆盖千奇百怪的项目——主 Agent 最懂这个仓库怎么编译/跑/验收）。
            verify: {
              type: 'string' as const,
              description: 'How to build, run, and verify this repository after merging (e.g. "cd studio && npm test", "cargo build --workspace && cargo test -p core", "make -j8 && make check"). Only used with integrate: true. Declare it: you know this repo — the mechanism injects your declaration verbatim and enforces it. Omit to fall back to detected checks (minimal format bar).',
            },
          },
          ...backgroundEnabled ? {
            run_in_background: {
              type: 'boolean' as const,
              description: corumRunInBackgroundDescription({ continuable, readonlyResearch: corumReadonlyResearch }),
            },
          } : {},
        },
        output: {
          schema: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'continuable' },
                  subagentId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'foreground' },
                  runId: { type: 'string', required: true },
                  output: { type: 'array', required: true, items: { type: 'json' } },
                  /**
                   * fork（corum）：本次委派的隔离落点（**两档都出现**，见
                   * `corumIsolationBoundaryNotice`）：`worktree` = 改动在隔离分支上、
                   * 必须 `integrate: true` 才进主树；`skipped-non-git` = 没隔离，改动已在
                   * 父树里。⚠️ 本 schema 声明了 `additionalProperties: false`，故新增字段
                   * **必须**同步在这里，否则整个结果会被 INVALID_TOOL_OUTPUT 吞掉
                   * （本仓已付过这个学费，见 HANDOFF-2026-09-16 §教训）。
                   */
                  isolationBoundary: { type: 'string', enum: ['worktree', 'skipped-non-git', 'main-requested'] },
                  /**
                   * fork（corum）2026-10 修复③（B 方案）：research 报告的落盘路径。
                   *
                   * ⚠️ 与 `isolationBoundary` 同一条纪律：本 schema 是
                   * `additionalProperties: false`，新增字段**必须**同步声明，否则整个结果会被
                   * INVALID_TOOL_OUTPUT 吞掉（本仓已付过这个学费）。
                   */
                  reportPath: { type: 'string' },
                },
              },
            ],
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.kind === 'background'
              ? `started background subagent job ${value.jobId}`
              : value.kind === 'continuable'
                ? `started subagent ${value.subagentId}`
                : `${outputValueText(value.output)}${value.isolationBoundary === undefined
                  ? ''
                  : `\n\n${corumIsolationBoundaryNotice(value.isolationBoundary)}`}`,
          }],
        },
        // Children never mutate the parent session; the one parent-owned write
        // (tasks.start) is a synchronous commutative insertion.
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) {
            throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
          }
          // fork（corum）：单任务隔离 spawn 已抽取为 spawnOne（install 作用域闭包），
          // subagent 工具 execute 是它的薄壳。
          return spawnOne(runtimeCtx, { agent: parent, signal: exec.signal, callId: String(exec.callId) }, {
            label: args.description,
            prompt: args.prompt,
            ...args.run_in_background !== undefined ? { run_in_background: args.run_in_background } : {},
            ...args.integrate !== undefined ? { integrate: args.integrate } : {},
            // schema 只能表达 `type: 'string'`；词汇表与「非法值 fail loud」由
            // `corumResolveIsolationRequest` 在派发前统一校验（spawnOne 内第一步就是它）。
            ...args.isolation !== undefined ? { isolation: args.isolation as CorumIsolationValue } : {},
            ...args.verify !== undefined ? { verify: args.verify } : {},
          }, subagentProvider)
        },
      }))
      // fork（corum）：orchestrate 工具（方案甲任务清单 fan-out）——仅在 worker 实例
      // 注册（research 只读实例不提供编排入口，toolName 为 subagent_research 时跳过）。
      const disposeOrchestrate = !isWorkerInstance
        ? (() => {}) as () => void
        : runtimeCtx.tools.register(defineTool({
            name: 'orchestrate',
            description: [
              // fork（corum）2026-10：**编排 = 一次黑盒调用**（用户定稿）。
              //
              // 重新定性：主 Agent 发起后，内部并行子 Agent 的 settle **不返回主 Agent、而是
              // settle 到工作流机制本身**；机制收拢结果交给收尾节点（closer）汇总；整次编排
              // **统一结算一次**给主 Agent。父 Agent 只看到「发起 → 拿到最终结果」。
              'Orchestrate several subagents in ONE call. It is ONE BLACK-BOX CALL: you start it, and you get ONE final result back. The parallel children settle INTO THE MECHANISM, not to you — you are not told about them individually, and you must not try to finish their work yourself while the call runs. A closer node (dispatched by the mechanism, no parameter for it) collects every task output, does the finishing step, and reports back to you.',
              // fork（corum）2026-10：**门槛**——至少 2 个任务才起效（用户定稿）。此前机制只拦 0 个，
              // 单任务也能进来，白白多一张流程卡 + 一个集成面却毫无并行收益。
              'MINIMUM 2 TASKS: this tool requires at least two independent tasks and REJECTS fewer. For a single task call `subagent` (or `subagent_research`) instead — a one-task fan-out adds a flow card and a finishing round-trip for zero parallelism gain.',
              // fork（corum）2026-10-22：**orchestrate 彻底独立**——移除 script 模式。
              // 此前 script 模式直接把官方 dsh-workflow-worker-thread 引擎的脚本接口暴露
              // 给 LLM，导致 orchestrate 不是完全独立的工具（依赖官方引擎 + 脚本分支
              // 的 settle 压制未覆盖 + UI 卡片无法渲染 script 模式的分支行）。现在只保留
              // 声明式 `tasks` 一种用法——orchestrate 就是纯并行 fan-out。
              'Pass a `tasks` array: a list of independent tasks you declare up front — each may carry `label`, `isolation`, `research`, `schema` (structured output) and `background`.',
              // fork（corum）2026-10-04 裁决「提示词加成本维度」：ISOLATION 段末追加
              // 成本维度一句——单个任务且父树干净时隔离只多付一轮 integrate、买不到安全，
              // 优先 `isolation: "main"`；有并发写者时回默认 worktree 路线。
              'ISOLATION: a write task is ISOLATED by default in its own git worktree + branch — declarative tasks and scripted children alike, foreground or background. Isolated children branch off HEAD, and the mechanism commits the parent tree right before creating the worktree, so an isolated child always sees the parent\'s latest committed work. A task that must work in your REAL tree instead (builds/installs, `git push`, merging, another repository, a path outside this one) declares `isolation: "main"` — it then runs directly in your main working tree with no branch and nothing to merge, and it is the only route that can do those things. Cost dimension for task isolation: declare `isolation: "main"` for a task that must land straight in your tree — and prefer the default worktree route whenever several tasks write concurrently; for a single task with a clean tree the isolated route only costs an integration round-trip without buying safety. Read-only research tasks are not isolated (they write nothing).',
              // fork（corum）2026-10：**取消 `merge` 字段**（用户定稿「机制自动判定收尾行为」）。
              // 旧口径让模型声明 merge/verify 才能触发收尾——那个字段是模型侧 footgun（全库数据：
              // 10 次提及 10 次设 false 且从不回来收尾，见 closer 的说明）。现在由机制
              // 按**隔离实况**判定：出现 worktree 隔离分支 ⇒ 必然合并；没有 ⇒ 只总结。
              'FINISHING IS AUTOMATIC — there is no `merge` parameter any more. The mechanism decides by what actually happened: if any task ran in an isolated worktree, the closer merges those branches back into the main tree, runs the verification and commits; if every task ran in your main tree or was read-only research, the closer only summarizes. You cannot opt out and you do not need to declare anything.',
              'CONFLICT PRE-FLIGHT IS YOURS: the mechanism cannot detect collisions before the edits exist. Before you issue the call, confirm yourself that the parallel WRITE tasks do not touch the same files (different files, different modules, different subsystems). Two tasks editing one file will collide at merge time, and only you can see that risk up front.',
              'WHAT YOU GET BACK: the closer\'s report plus one reference per task (index, label, ok/aborted, child session id, worktree/branch). The full per-task outputs are NOT inlined — they go to the closer, which is exactly why this result stays small. Enter a child session if you need its raw output.',
            ].join('\n'),
            parameters: {
              // fork（corum）2026-10-22：script/meta/args 三字段已移除（orchestrate 彻底独立）。
              tasks: {
                type: 'array',
                description: 'DECLARATIVE mode: the list of tasks to run (2 or more — fewer is rejected). Each task is an independent subagent delegation.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    prompt: { type: 'string', required: true, description: 'The complete, self-contained task for this subagent. It does not share this conversation, so include everything it needs.' },
                    label: { type: 'string', description: 'A short (3-5 word) label for display.' },
                    isolation: { type: 'string', enum: ['worktree', 'main', 'always', 'write-tasks'], description: 'Where/how this task is isolated. `worktree` (default) = its own isolated git worktree + branch (merged later). `main` = it works DIRECTLY in your main working tree, no worktree and nothing to merge — pass it when the task must write outside the repository (another repo, a fresh repo to materialize) or must land straight into your tree. `always`/`write-tasks` only tune the mode for a task whose tool face cannot write (every write task is isolated regardless).' },
                    research: { type: 'boolean', description: 'Set true for a read-only research task (write tools denied, no worktree).' },
                    // fork（corum）2026-09-18：per-task `model` **已从 schema 剔除**。
                    //
                    // 用户策略（第 1/4 条）：「子 Agent 使用模型必须唯一，不给 LLM 候选列表；
                    // 用户设置了子 Agent 要路由到哪个模型就路由到那个模型」，且
                    // 「orchestrate 也不能豁免」。此前 `tasks[i].model` 是 LLM 可见参数
                    // （描述还写着 "mechanism lock"），实测主 Agent 可以据此把子 Agent
                    // 换到任意模型——这正是策略要禁的「让 LLM 决定子 Agent 模型」。
                    //
                    // 现在与 `subagent` 工具同款：模型面**物理不可表达**，路由只由
                    // 用户配置决定（预设锁 → 跟随主 Agent）。`subagent` 工具早在
                    // 1765 行就做了同样的事（"LLM 物理上无法表达模型偏好"），
                    // orchestrate 是当时漏掉的那一处。
                    // 2026-09-27 修 P5（审查员 B 报）：后台任务不能进 fan-in，会被汇合判为失败（orchestrate currently requires
                    // foreground tasks），而子会话确实起了 ⇒ 描述不得再承诺它。
                    background: { type: 'boolean', description: 'NOT SUPPORTED in `orchestrate` yet: a backgrounded task cannot join the fan-in and is reported as a failed task even though its child does start. Leave it unset — every task runs in the foreground and the call returns when they all settle.' },
                    schema: {
                      type: 'object',
                      additionalProperties: true,
                      description: 'Optional object-rooted JSON Schema: when present the child must commit a schema-valid structured result, returned in `output` instead of free text (workflow-style structured children).',
                    },
                  },
                },
              },
              // fork（corum）2026-10：`merge` 字段**已删除**（用户定稿）。收尾行为由机制按隔离
              // 实况自动判定，模型不再声明；verify 改由机制探测（`corumDetectIntegrateChecks`）。
              // 保留这条注释是刻意的：下一个想「顺手把 merge 加回来」的人必须知道它是被裁决掉的。
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  // fork（corum）2026-10-22：`mode` 字段移除——orchestrate 只有声明式 tasks。
                  /**
                   * fork（corum）2026-10：**任务级引用**（黑盒化后的结果模型）。
                   *
                   * 旧形态把每个任务的**完整输出**塞进这一条结果（N 份正文拼一条 tool/result），
                   * 必然越过 tool-result-pruner 的 8192 字符阈值 ⇒ 中间被砍（#100）。现在每条只留
                   * 引用（子会话 id / worktree / 分支），正文交给 closer 写进收尾报告。
                   * ⚠️ `output` 字段**仍保留声明**：`tasks[].schema` 的结构化子结果（小、可寻址）
                   * 与历史会话回放需要它；它不再承载自由文本正文。
                   */
                  results: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        index: { type: 'integer', required: true },
                        label: { type: 'string' },
                        ok: { type: 'boolean', required: true },
                        aborted: { type: 'boolean' },
                        output: { type: 'string' },
                        error: { type: 'string' },
                        // 该任务子会话 id（主 Agent 按需进入的唯一入口）。
                        childSessionId: { type: 'string' },
                        // 该任务的隔离 worktree slug / 分支（无隔离时缺省）。
                        worktreeSlug: { type: 'string' },
                        branch: { type: 'string' },
                      },
                    },
                  },
                  /**
                   * fork（corum）2026-10：**收尾节点（closer）的结果**——整次编排唯一结算的那一份。
                   *
                   * ⚠️ 本对象必须**逐字段**在 schema 里声明：输出校验是 `additionalProperties:false`，
                   * 少声明一个字段会让 harness 用 `INVALID_TOOL_OUTPUT` **顶替整个 payload**
                   * （本仓已因此栽过两次：`rejected`、`integration.report`）。
                   */
                  closer: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      // 机制判定的场景：merge（有 worktree 分支）/ summarize（全 main）/ research（全只读）。
                      scenario: { type: 'string', required: true, enum: ['merge', 'summarize', 'research'] },
                      // closer 子会话 id（编排卡「进入会话」按钮用）。
                      childSessionId: { type: 'string' },
                      // 收尾报告正文（主 Agent 读的就是它；同一份也落盘在 reportPath）。
                      report: { type: 'string' },
                      // 报告落盘路径（CORUM_HOME 临时路径，阅后即焚的过程产物）。
                      reportPath: { type: 'string' },
                      // 报告是否真的写盘成功（失败不影响正文返回）。
                      reportWritten: { type: 'boolean' },
                      // 机制在编排期间收拢到的内部说明（原本会以 notice 注入父会话的那些）。
                      internalNotes: { type: 'array', items: { type: 'string' } },
                      // closer 自身失败的原因（失败时 report 可能缺省）。
                      error: { type: 'string' },
                    },
                  },
                  // fork（corum）2026-10-22：`script` 输出对象移除（orchestrate 不再有 script 模式）。
                  integration: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      pendingBranches: { type: 'array', items: { type: 'string' } },
                      integrated: { type: 'boolean' },
                      // 集成者子会话 id（编排卡「进入会话」按钮用；合并成功时才有）。
                      childSessionId: { type: 'string' },
                      // 集成失败的错误信息（Bug B：真值门禁失败时 runIntegrate 不再 throw 顶替
                      // 整个结果，而是把错误并入 integration.error——per-task results 不丢）。
                      error: { type: 'string' },
                      // fork（corum）2026-09-16：**拒绝形态**——`'unmerged'`（分支没进 HEAD）与
                      // `'verify'`（进了 HEAD 但声明的验证没过）的现状与出路相反，调用方要能分辨。
                      // ⚠️ 本字段必须同时声明在 schema 里：输出校验是 `additionalProperties: false`，
                      // 少声明一个字段会让 harness 用 `INVALID_TOOL_OUTPUT` **顶替整个 payload**
                      // ——那会把 results + integration 一起吞掉，正是 Bug B 的反向形态
                      // （2026-09-16 实机复现抓到：只加了返回值、漏了 schema）。
                      rejected: { type: 'string', enum: ['unmerged', 'verify'] },
                      // fork（corum）2026-09-20 加的**集成者报告正文**（用户要求「合并结果 +
                      // 前面所有子 Agent 需要注意的点都汇总回主 Agent」）。
                      // ⚠️ 2026-09-27 实机验收补声明：该字段加进返回值时**漏了 schema**，
                      // 于是每次集成者产出报告都被 harness 判
                      // `tool "orchestrate" returned invalid output: "value.integration.report"
                      // is not a declared property` ——**整个 orchestrate 结果被顶替**（results
                      // 全丢），子任务的隔离分支还留在那里没人合。正是上面 `rejected` 那条注释
                      // 警告过的形态（2026-09-16 已因同一原因在 `rejected` 上栽过一次）。
                      report: { type: 'string' },
                    },
                  },
                  /**
                   * fork（corum）：跑在**父主工作区**（没隔离）的任务序号 + 判据
                   * （2026-09-13 用户定调「先做可见性」，见 `corumIsolationBoundaryNotice`）。
                   * 只有存在这种任务时才出现。
                   */
                  parentTreeTasks: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      indexes: { type: 'array', items: { type: 'integer' } },
                      boundary: { type: 'string', enum: ['parent-tree', 'skipped-non-git', 'main-requested'] },
                    },
                  },
                },
              },
              render: (_args, value) => {
                const out = value as {
                  results?: Array<{ index: number; label?: string; ok: boolean; aborted?: boolean; output?: string; error?: string; childSessionId?: string; worktreeSlug?: string; branch?: string }>
                  /** fork（corum）2026-10：收尾节点（closer）的结果——整次编排唯一结算的那一份。 */
                  closer?: { scenario: CorumCloserScenario; childSessionId?: string; report?: string; reportPath?: string; reportWritten?: boolean; internalNotes?: string[]; error?: string }
                  /**
                   * @deprecated fork（corum）2026-10：`merge` 字段取消后，集成不再是「模型声明的收尾」，
                   * 而是 closer 的 `scenario: 'merge'`。本字段**只为历史会话回放保留**（旧工具结果里
                   * 还有它）；新结果不再产生。UI 侧请改读 `closer.scenario` / `closer.report`。
                   */
                  integration?: { pendingBranches: string[]; integrated: boolean; childSessionId?: string; error?: string; rejected?: 'unmerged' | 'verify'; report?: string }
                  /** 跑在父主工作区（没隔离）的任务序号与判据（见上）。 */
                  parentTreeTasks?: { indexes: number[]; boundary: 'parent-tree' | 'skipped-non-git' | 'main-requested' }
                }
                // 全结构化（用户 2026-09-16 选定 B）：orchestrate 结果**不再展平成文本投影**，
                // 直接返回 JSON 对象——`results[].ok`/`closer.scenario` 都是**可寻址字段**。
                // 注：ContentBlock 只有 text/image 两型，故结构化对象经 JSON.stringify 进 text。
                //
                // fork（corum）2026-10（#100 根因）：`results[]` **不再携带各任务的自由文本正文**——
                // N 份正文拼一条 tool/result 必然越过 tool-result-pruner 的 8192 字符阈值，中间被砍。
                // 正文交给 closer（它写进收尾报告），主 Agent 拿到的是**报告 + 任务级引用**。
                // 例外：`tasks[].schema` 的结构化子结果是小而可寻址的 JSON，仍然透传。
                // fork（corum）2026-10-22：`mode`/`script` 分支移除（orchestrate 彻底独立）。
                const structured: Record<string, unknown> = {}
                structured.results = (out.results ?? []).map(r => ({
                  index: r.index,
                  ...(r.label !== undefined ? { label: r.label } : {}),
                  ok: r.ok,
                  ...(r.aborted === true ? { aborted: true } : {}),
                  ...(r.output !== undefined ? { output: r.output } : {}),
                  ...(r.error !== undefined ? { error: r.error } : {}),
                  ...(r.childSessionId !== undefined ? { childSessionId: r.childSessionId } : {}),
                  ...(r.worktreeSlug !== undefined ? { worktreeSlug: r.worktreeSlug } : {}),
                  ...(r.branch !== undefined ? { branch: r.branch } : {}),
                }))
                if (out.closer !== undefined) {
                  structured.closer = {
                    scenario: out.closer.scenario,
                    ...(out.closer.childSessionId !== undefined ? { childSessionId: out.closer.childSessionId } : {}),
                    ...(out.closer.report !== undefined ? { report: out.closer.report } : {}),
                    ...(out.closer.reportPath !== undefined ? { reportPath: out.closer.reportPath } : {}),
                    ...(out.closer.reportWritten !== undefined ? { reportWritten: out.closer.reportWritten } : {}),
                    ...(out.closer.internalNotes !== undefined && out.closer.internalNotes.length > 0 ? { internalNotes: out.closer.internalNotes } : {}),
                    ...(out.closer.error !== undefined ? { error: out.closer.error } : {}),
                  }
                }
                if (out.integration !== undefined) {
                  structured.integration = {
                    pendingBranches: out.integration.pendingBranches,
                    integrated: out.integration.integrated,
                    ...(out.integration.childSessionId !== undefined ? { childSessionId: out.integration.childSessionId } : {}),
                    ...(out.integration.error !== undefined ? { error: out.integration.error } : {}),
                    ...(out.integration.rejected !== undefined ? { rejected: out.integration.rejected } : {}),
                    ...(out.integration.report !== undefined ? { report: out.integration.report } : {}),
                  }
                }
                if (out.parentTreeTasks !== undefined && out.parentTreeTasks.indexes.length > 0) {
                  structured.parentTreeTasks = out.parentTreeTasks
                }
                return [{ type: 'text', text: JSON.stringify(structured, null, 2) }]
              },
            },
            // fork（corum）：Phase 3 编排结果面板——presentCall 显示任务清单概要
            // （标题=任务数），presentResult 显示结果卡（成功/失败计数）。
            presentCall: (args) => {
              // fork（corum）2026-10-22：script 分支移除（orchestrate 彻底独立）。
              const call = args as { tasks?: Array<{ label?: string }> }
              const tasks = call.tasks ?? []
              return {
                card: 'generic' as const,
                title: `orchestrate · ${tasks.length} task(s)`,
                rawInput: tasks.map((t, i) => `[${i}] ${t.label ?? '(unnamed)'}`),
              }
            },
            presentResult: (_args, value) => {
              const out = value as unknown as {
                results?: Array<{ index: number; ok: boolean; aborted?: boolean; error?: string }>
                /** fork（corum）2026-10：收尾节点结果——卡片的第三态由它决定。 */
                closer?: { scenario: CorumCloserScenario; error?: string }
              }
              // fork（corum）2026-10：标题带上**收尾场景**（merge / summarize / research）——
              // 取消 `merge` 字段后，「这次到底有没有合并」只能由机制判定给出，卡片要如实反映。
              const scene = out.closer === undefined
                ? ''
                : out.closer.scenario === 'merge' ? ' · merge' : out.closer.scenario === 'research' ? ' · research' : ' · summarize'
              // fork（corum）2026-10-22：script 分支移除（orchestrate 彻底独立）。
              const results = out.results ?? []
              const done = results.filter(r => r.ok).length
              const aborted = results.filter(r => r.aborted === true).length
              const failed = results.length - done - aborted
              const summary = aborted > 0
                ? `${done} ok / ${failed} failed / ${aborted} aborted`
                : `${done} ok / ${failed} failed`
              return {
                card: 'generic' as const,
                title: `orchestrate · ${summary}${scene}`,
                content: [{ type: 'text', text: results.map(r => `[task ${r.index}] ${r.ok ? '✓ done' : r.aborted === true ? '⊘ aborted' : `✗ ${r.error ?? 'failed'}`}`).join('\n') }],
              }
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const parent = exec.agent
              if (!parent) {
                throw new Error('orchestrate tool requires a calling agent (exec.agent was undefined)')
              }
              /**
               * fork（corum）2026-10：**编排黑盒化的生命周期**（用户定稿「整次编排统一结算一次」）。
               *
               * 整个执行体包在 `beginOrchestration` / `endOrchestration` 之间：这段窗口内，**本次
               * 编排派出的**子 Agent（经 `spawnOne` 的 `onChildStarted` 登记）的 settle 通知
               * （待集成 / 收口提交失败）**不再注入父会话**，而是收拢到机制内部，由 closer 写进
               * 收尾报告。窗口外的委派（单发 subagent、更早派出的后台子 Agent）一律照旧通知。
               *
               * 用引用计数（begin/end）而不是布尔：父会话同一时刻可能有多个 orchestrate 在跑。
               */
              const orchestrationSessionId = String(parent.session.id)
              const runOrchestration = async () => {
              /**
               * fork（corum）2026-10：**收尾节点（closer）的派发**——整次编排唯一结算的那一个节点。
               *
               * ## 黑盒化的落点
               *
               * 用户定稿：orchestrate = **一次黑盒调用**。并行子 Agent 的 settle 不返回主 Agent，
               * 而是 settle 到机制（见 `subagent/end` 钩子里的 `orchestrationChildIndexBySlug`
               * 压制）；机制把各任务输出收拢在这里，交给本节点汇总，整次编排**统一结算一次**。
               *
               * ## 三态（机制自动判定，模型不再传 `merge`）
               *
               * - `merge`：台账里有待集成的隔离分支 ⇒ 合并回主 + 探测式 verify + 汇总；
               * - `research`：没有任何写任务（全 research）⇒ 只把各结论汇成核查报告；
               * - `summarize`：有写任务但全在 main（无分支）⇒ 只汇总，不合并。
               *
               * 判定依据是**隔离实况**（台账 + 任务的 isolationBoundary），不是模型的声明——
               * 这正是取消 `merge` 字段后机制要自己回答的问题。
               */
              const closerScenarioOf = (pendingCount: number, allResearch: boolean): CorumCloserScenario =>
                pendingCount > 0 ? 'merge' : allResearch ? 'research' : 'summarize'
              /**
               * 派发 closer 并把它的报告落盘。
               *
               * 复用 `spawnOne`（写能力子 Agent，`isolation: 'main'` 跑主树——它要 merge/落盘，
               * 隔离的 worktree 里做不到），persona 由 `corumCloserPersona` 拼装。
               * ⚠️ closer 的 settle 同样**不进父会话**：登记成 `-1` 号「编排子 Agent」，
               * 通知一律收拢到机制内部（它自己的报告才是交付物）。
               */
              const runCloser = async (
                scenario: CorumCloserScenario,
                refs: readonly CorumCloserTaskRef[],
                pending: readonly { branch: string }[],
              ): Promise<{ scenario: CorumCloserScenario; childSessionId?: string; report?: string; reportPath: string; reportWritten: boolean; internalNotes: string[]; error?: string }> => {
                const sessionId = parent.session.id
                const reportPath = corumOrchestrateReportPath(String(exec.callId))
                /**
                 * fork（corum）2026-10 修复②：**closer 成功后用台账实况对账内部说明**。
                 *
                 * 病根（实机验证 worker 实测，merge 场景）：`drainOrchestrationNotes()` 在
                 * closer 派发**之前**取值 ⇒ 它拿到的是**合并前**的快照。closer 已成功合并，
                 * 但那条「N isolated branch(es) are NOT merged …」说明没有被作废，原样进了
                 * 结果 + 卡片「机制内部说明」区 ⇒ 主 Agent 同时读到「已集成」与「没合并」
                 * 两条互斥结论。
                 *
                 * 剔除判据是**事实**而不是场景：这里重新读一遍台账（`entriesOf` 本身会先按
                 * git 实况对账），把已翻成 `integrated` 的分支名交给
                 * `corumDropResolvedIntegrationNotes` 过滤。于是：
                 *   · 真合并了 ⇒ 对应说明被剔除（状态已解决）；
                 *   · verify 失败 / 未合并 / closer 失败 ⇒ 台账没翻、分支不在集合里 ⇒ 说明**保留**
                 *     （那是真未解决，正是主 Agent 必须读到的）；
                 *   · 一条说明里只有部分分支落地 ⇒ 重写成剩余分支（不能整条丢掉）。
                 * 「merge 场景 + 无 error 就全剔」是更简单的写法，但它会把「closer 自称成功、
                 * 台账却没翻」这类漂移一起抹掉——正是本仓反复付学费的那类静默失真。
                 */
                const corumReconciledNotes = (): string[] => corumDropResolvedIntegrationNotes(
                  internalNotes,
                  new Set(
                    orchestration.entriesOf(sessionId)
                      .filter(entry => entry.status === 'integrated')
                      .map(entry => entry.branch),
                  ),
                  corumPendingIntegrationNoticeText,
                )
                // verify 的来源：原来由模型传 `merge.verify`；取消 merge 后改用**探测式默认**
                // （`corumDetectIntegrateChecks` 按父 cwd 的仓库形态生成），仅在真需要合并时才有意义。
                const checks = scenario === 'merge' ? corumDetectIntegrateChecks(parent.session.header.cwd ?? process.cwd()) : []
                const persona = corumCloserPersona(scenario, refs, {
                  reportPath,
                  ...checks.length > 0 ? { checks } : {},
                  ...pending.length > 0 ? { branches: pending.map(entry => entry.branch) } : {},
                })
                // 机制在编排期间收拢的内部说明（原本会以 notice 注入父会话的那些）——一并交给
                // closer，让它写进报告；父 Agent 因此仍然「看得见」，只是经过收尾这一道。
                //
                // ⚠️ 这是**合并前**的快照（closer 还没跑）。成功路径必须用
                // `corumReconciledNotes()` 对账后再返回，见上方修复②的说明。
                const internalNotes = [...orchestration.drainOrchestrationNotes(sessionId)]
                const prompt = internalNotes.length === 0
                  ? persona
                  : persona
                    + '\n\nMechanism notes captured during this run (they were NOT delivered to the delegating agent — fold them into your report):\n'
                    + internalNotes.map(note => `- ${note}`).join('\n')
                try {
                  const outcome = await spawnOne(runtimeCtx, { agent: parent, signal: exec.signal, callId: String(exec.callId) }, {
                    label: 'closer',
                    prompt,
                    // ⚠️ `merge` 场景**必须**走 `integrate: true`（用户定稿「复用现有集成者 persona/
                    // 派发逻辑」）——它带来的是**机制真值门禁**，不是便利：
                    //   ① 每个待集成分支必须真进了 HEAD（2026-09-09 事故：集成者自称已合并，
                    //      机制无条件写 integrated 并清理 ⇒ 子任务提交变 unreachable、文件消失）；
                    //   ② 台账翻转 + 现场回收（不翻转的话这些条目会永远占着待集成位）；
                    //   ③ 未结清合并的解卡。
                    // 这两条恰恰是「模型声明 merge」时代最贵的那次事故换来的，绝不能因为
                    // 取消 `merge` 字段而丢掉——取消的只是**声明权**，不是门禁。
                    //
                    // 非 merge 场景（summarize / research）没有待集成分支，`integrate: true` 会
                    // 以「no isolated worktrees to integrate」拒绝，故它们走普通主树 spawn。
                    ...scenario === 'merge' ? { integrate: true } : { isolation: 'main' as const },
                    run_in_background: false,
                    notifyParent: false,
                    // closer 也是本次编排派出的子 Agent（记 -1 号）——它的 settle 通知同样
                    // 收拢到机制，父会话只看到它最终那份报告。
                    onChildStarted: (childId) => {
                      orchestration.registerOrchestrationChild(sessionId, childId, -1)
                    },
                  }, subagentProvider)
                  if (outcome.kind !== 'foreground') {
                    return { scenario, reportPath, reportWritten: false, internalNotes, error: `closer ran in ${outcome.kind} mode; the closer must settle in the foreground` }
                  }
                  // ⚠️ 2026-10 修复①：**落盘是机制的活**——persona 已明确要求 closer 不要写
                  // 任何文件（它写 `~/.corum/…` 会撞 workspace-write 沙箱，每次编排弹一次
                  // 提权卡）。此处因此是**唯一**落盘点，正文以 closer 的最终答复为准。
                  const report = corumOutputText(outcome.output).trim()
                  // 报告**必然**落盘（阅后即焚的过程产物，写 CORUM_HOME 临时路径）。
                  const reportWritten = report === '' ? false : corumWriteOrchestrateReport(reportPath, report)
                  if (!reportWritten && report === '') {
                    return { scenario, childSessionId: String(outcome.runId), reportPath, reportWritten: false, internalNotes, error: 'the closer returned no report' }
                  }
                  return {
                    scenario,
                    childSessionId: String(outcome.runId),
                    report,
                    reportPath,
                    reportWritten,
                    // 修复②：合并成功的那部分 pending 说明在这里按台账实况作废
                    // （未解决的照旧保留——见 `corumReconciledNotes` 的说明）。
                    internalNotes: corumReconciledNotes(),
                  }
                } catch (error: unknown) {
                  // closer 失败**不吞**：编排的交付物就是它的报告，没有报告 = 本次编排没有结果。
                  // 但仍把各任务的成败如实交回（refs 在结果里），让主 Agent 能判断损失面。
                  runtimeCtx.logger.warn(`orchestrate closer failed: ${String(error)}`)
                  return {
                    scenario,
                    reportPath,
                    reportWritten: false,
                    internalNotes,
                    error: error instanceof Error ? error.message : String(error),
                  }
                }
              }

              // fork（corum）2026-10-22：**SCRIPTED 模式已移除**——orchestrate 彻底独立，
              // 不再依赖官方 dsh-workflow-worker-thread 引擎。脚本编排由官方 workflow 生态负责，
              // orchestrate 只做声明式 fan-out。下面的 `tasks` 声明式是唯一路径。

              // fork（corum）：方案甲 fan-out——tasks[] 并发 spawn（spawnOne 复用
              // 隔离/模型锁/integrate 逻辑），前台等待全部 settle，汇合结果。
              const tasks = args.tasks as unknown as Array<{
                prompt: string
                label?: string
                isolation?: CorumIsolationValue
                research?: boolean
                model?: { provider: string; model: string; reasoningEffort?: string }
                background?: boolean
                schema?: ObjectJsonSchema
              }>
              // fork（corum）2026-10：**门槛**（用户定稿「orchestrate 至少 2 个任务才起效」）。
              // 单任务编排没有任何并行收益，却多付一张流程卡 + 一个收尾轮次；机制在派发前就拒绝，
              // 并把出路写在错误里（错误会被模型读到，工具描述里也有同一条禁令）。
              if (tasks === undefined || tasks.length < 2) {
                throw new Error(
                  `orchestrate requires at least 2 tasks (got ${tasks === undefined ? 0 : tasks.length}); `
                  + 'for a SINGLE task use `subagent` (write) or `subagent_research` (read-only) instead — '
                  + 'a one-task fan-out adds a flow card and a closer round-trip for zero parallelism gain',
                )
              }
              /**
               * fork（corum）：**哪些任务跑在父主工作区里**（没隔离）——2026-09-13 用户
               * 定调「先做可见性」。收集成一张表，汇总时另起一行报给父 Agent；**不动**
               * 每任务行（`[task N · label] done|aborted|failed`）的格式——那个格式被
               * `corum-ui-chat` 的编排卡正则消费，改它会让卡片静默退化（见审查报告 F-02）。
               */
              const parentTreeTasks: Array<{ index: number; boundary: 'parent-tree' | 'skipped-non-git' | 'main-requested' }> = []
              /**
               * fork（corum）2026-10：每个任务的**结果回执**（机制内部持有）。
               *
               * `output` 是完整正文，**只喂给 closer**；返回给主 Agent 的 `results[]` 只带引用
               * （`childSessionId` / worktree / branch），正文不进单条 tool/result（#100 截断根因）。
               */
              type TaskReceipt = {
                index: number
                ok: boolean
                aborted?: boolean
                /** 完整正文（closer 专用，不回主 Agent）。 */
                output?: string
                error?: string
                label?: string
                /** 该任务子会话 id（主 Agent 事后按需进入的唯一入口）。 */
                childSessionId?: string
                worktreeSlug?: string
                branch?: string
                /** 该任务是否只读研究任务（closer 三态判定用）。 */
                research?: boolean
                /** 该任务的隔离落点（判定「有没有 worktree」用；`worktree` 才需要合并）。 */
                boundary?: 'worktree' | 'skipped-non-git' | 'main-requested'
                /**
                 * 该任务是否声明了 `schema`（结构化子结果）。只有这种**小而可寻址**的 JSON
                 * 才允许随 `results[]` 回主 Agent；自由文本正文一律只给 closer（#100）。
                 */
                structured?: boolean
              }
              const run = (index: number): Promise<TaskReceipt> => {
                const task = tasks[index]
                const base = { index, ...task.label !== undefined ? { label: task.label } : {}, ...task.research === true ? { research: true } : {}, ...task.schema !== undefined ? { structured: true } : {} }
                return spawnOne(runtimeCtx, { agent: parent, signal: exec.signal, callId: String(exec.callId) }, {
                  label: task.label ?? `task ${index}`,
                  prompt: task.prompt,
                  // fork（corum）：orchestrate 任务默认前台 one-shot（fan-in 汇合要求）；
                  // 只有显式 background:true 才走后台。不能沿用 subagent 的
                  // 「continuable 默认后台」——否则任务落入 continuable 路径，
                  // orchestrate 无法前台汇合（CDP 端到端验证暴露的 bug）。
                  run_in_background: task.background === true,
                  ...task.isolation !== undefined ? { isolation: task.isolation } : {},
                  ...task.research !== undefined ? { taskResearch: task.research } : {},
                  ...task.schema !== undefined ? { taskSchema: task.schema } : {},
                  // fork（corum）2026-09-18：**不再转达 task.model**——per-task 模型面
                  // 已按用户策略剔除（见 schema 处说明），子 Agent 路由只由用户配置决定。
                  // fork（corum）：并发感知隔离的两个入参——① 本次 fan-out 任务数
                  // （≥2 才需要 worktree）；② 不向父会话逐条注入 notice（结果由
                  // orchestrate 的汇总结果承载，避免 N 条重复通知）。
                  fanoutCount: tasks.length,
                  notifyParent: false,
                  // fork（corum）2026-10：**编排登记**（黑盒化的压制键）——子 Agent 一 spawn 就
                  // 把它的 id 记进机制，此后它的 settle 通知不再注入父会话（见 `subagent/end`
                  // 钩子的 `orchestrationChildIndexBySlug`）。必须走这个回调而不是 `.then()`：
                  // 前台子 Agent 在 settle 之前就 end 了，晚一步登记就晚一步压制。
                  onChildStarted: (childId) => {
                    orchestration.registerOrchestrationChild(parent.session.id, childId, index)
                  },
                }, subagentProvider).then((outcome) => {
                  if (outcome.kind === 'foreground') {
                    // ⚠️ orchestrate 的 `parentTreeTasks` 语义是「**没**隔离、改动直接落在父树
                    // 的那几个任务」（它是异常档，用于提示父 Agent「这些改动已在你的树里」）。
                    // 2026-09-18 起 `isolationBoundary` 变成两档都填（`'worktree'` 也要报，
                    // 因为隔离的才需要 integrate）——故这里必须**显式排除 `'worktree'`**，
                    // 否则每个正常任务都会被误记成「父树任务」，该档位失去意义。
                    if (outcome.isolationBoundary !== undefined && outcome.isolationBoundary !== 'worktree') {
                      parentTreeTasks.push({ index, boundary: outcome.isolationBoundary })
                    }
                    // worktree 三件套从台账取（spawnOne 已登记并绑定 runId）——结果里只回引用，
                    // 正文（`output`）留给 closer。
                    const ledgerEntry = orchestration.entriesOf(parent.session.id)
                      .find(entry => entry.runId === String(outcome.runId) || entry.childSessionId === String(outcome.runId))
                    return {
                      ...base,
                      ok: true,
                      output: outputValueText(outcome.output),
                      childSessionId: String(outcome.runId),
                      ...outcome.isolationBoundary === undefined ? {} : { boundary: outcome.isolationBoundary },
                      ...ledgerEntry === undefined ? {} : { worktreeSlug: ledgerEntry.slug, branch: ledgerEntry.branch },
                    }
                  }
                  // 后台/continuable：本阶段 orchestrate 汇合要求前台（fan-in 语义）。
                  return { ...base, ok: false, error: `task ${index} ran in ${outcome.kind} mode; orchestrate currently requires foreground tasks` }
                }).catch((error: unknown) => {
                  // fork（corum）：按权威 stopReason 区分「手动终止」与「失败」。
                  // settleForegroundRun 把 SubagentResult.stopReason 挂到 Error 上；
                  // 此处读它，不靠错误串匹配。
                  // 排障日志（2026-09-16）：orchestrate 任务失败写主日志——此前 catch 只把错误
                  // 写进结果行，主日志零痕迹，「任务 2 从未 spawn」这类失败只能靠现场反推。
                  runtimeCtx.logger.warn(`orchestrate task ${index} failed: ${String(error)}`)
                  if ((error as { stopReason?: SubagentResult['stopReason'] }).stopReason === 'aborted') {
                    return { ...base, ok: false, aborted: true, error: String(error) }
                  }
                  return { ...base, ok: false, error: String(error) }
                })
              }
              const results = await Promise.all(tasks.map((_, index) => run(index)))
              // fork（corum）2026-10：**fan-in → closer**（用户定稿「机制收拢结果交给收尾节点汇总」）。
              //
              // 这里不再有 `runIntegrate(merge)`：`merge` 字段已取消，收尾行为由机制按**隔离实况**
              // 自动判定（有 worktree 分支 ⇒ 合并 + verify；全 main ⇒ 只总结；全 research ⇒ 核查报告）。
              //
              // 旧口径的两个坑在这里同时被消掉：
              // ① `merge` 是模型侧 footgun（全库 10 次提及 10 次设 false 且从不回来收尾）；
              // ② 集成失败会 throw 并顶替整个结果（Bug B 形态）——现在 closer 的失败只写进
              //    `closer.error`，`results`（任务级引用）照旧返回，损失面可见。
              const pendingAfter = corumPendingIntegration(orchestration.entriesOf(parent.session.id))
              // 三态判定的「全 research」看**声明**而不是结果（失败的研究任务也是研究任务，
              // 不能因为失败就把它算成写任务）。
              const allResearch = tasks.every(task => task.research === true)
              const scenario = closerScenarioOf(pendingAfter.length, allResearch)
              // 只把**成功**任务的正文交给 closer；失败/终止任务的正文也照给（partial output 往往是
              // 判断损失面的关键一手），但明确标注状态。
              const refs: CorumCloserTaskRef[] = results.map(receipt => ({
                index: receipt.index,
                label: receipt.label ?? `task ${receipt.index}`,
                ok: receipt.ok,
                ...receipt.aborted === true ? { aborted: true } : {},
                ...receipt.error === undefined ? {} : { error: receipt.error },
                ...receipt.childSessionId === undefined ? {} : { childSessionId: receipt.childSessionId },
                ...receipt.worktreeSlug === undefined ? {} : { worktreeSlug: receipt.worktreeSlug },
                ...receipt.branch === undefined ? {} : { branch: receipt.branch },
                ...receipt.research === true ? { research: true } : {},
                ...receipt.output === undefined ? {} : { output: receipt.output },
              }))
              // closer 自己的 settle 也**不进父会话**（登记成 -1 号编排子 Agent，见 runCloser）。
              const closer = await runCloser(scenario, refs, pendingAfter)
              // 返回给主 Agent 的 `results[]`：**只留引用**，正文（output）不进单条 tool/result
              // ——那是 #100 的根因（pruner 8192/4096/1024 会腰斩超长单条结果）。例外：结构化子结果
              // （`tasks[].schema`）是小而可寻址的 JSON，仍然透传。
              return {
                // fork（corum）2026-10-22：`mode` 字段移除（orchestrate 只有声明式 tasks）。
                results: results.map(receipt => ({
                  index: receipt.index,
                  ...receipt.label === undefined ? {} : { label: receipt.label },
                  ok: receipt.ok,
                  ...receipt.aborted === true ? { aborted: true } : {},
                  ...receipt.error === undefined ? {} : { error: receipt.error },
                  ...receipt.childSessionId === undefined ? {} : { childSessionId: receipt.childSessionId },
                  ...receipt.worktreeSlug === undefined ? {} : { worktreeSlug: receipt.worktreeSlug },
                  ...receipt.branch === undefined ? {} : { branch: receipt.branch },
                  // ⚠️ 正文**只**在声明了 `schema` 时透传（结构化子结果是小 JSON，可寻址）；
                  // 自由文本正文一律留给 closer——把它拼回这里就是 #100 的截断根因。
                  ...receipt.structured !== true || receipt.output === undefined ? {} : { output: receipt.output },
                })),
                closer,
                ...parentTreeTasks.length === 0 ? {} : {
                  parentTreeTasks: {
                    indexes: parentTreeTasks.map(t => t.index),
                    boundary: parentTreeTasks.every(t => t.boundary === 'skipped-non-git') ? 'skipped-non-git' as const : 'parent-tree' as const,
                  },
                },
              }
              }
              orchestration.beginOrchestration(orchestrationSessionId)
              try {
                return await runOrchestration()
              } finally {
                orchestration.endOrchestration(orchestrationSessionId)
              }
            },
          }))
      /**
       * fork（corum）2026-09-19：**「停止委派」不再注册 guard**（用户实测纠正）。
       *
       * 前一版把「停止委派」实现成会话级硬禁用：注册 `tools.guard`，此后该会话**任何**
       * subagent/orchestrate 调用都被拒绝，且没有解除入口。用户实测发现这不对——
       * 主 Agent 因此连「换个模型重新派」「用 subagent_research 去调研」都做不到，
       * 而且它在通知里读到「delegation is DISABLED for this session」，就把整个会话
       * 的委派当成永久关停，剩余工作全部自己写（连本该委派的活也自己干了）。
       *
       * 正确语义：这一档只是**本次失败不自动重试**（机制本来会在用户同意后重跑一轮，
       * 选它就跳过那一步，并把失败如实交回主 Agent）。**会话的委派能力不受影响**——
       * 主 Agent 之后主动要派就派。
       *
       * 于是这里不再有 guard，`delegationDisabledFor` 也不再被任何执行路径查询。
       */
      const disposeToolWithGuard = (): void => {
        disposeTool()
      }
      mounted = { subagentProvider, disposeTool: disposeToolWithGuard, disposeOrchestrate }
    }

    // Register listeners before checking presence so no synchronous change is missed.
    // TODO(subagent-dup-toolname): two waiting one-shot fibers configured with the
    // same toolName collide when their provider appears, and the duplicate-name
    // throw rolls back the provider registration. Continuable instances reserve
    // their prompt-section name during apply() and fail earlier. Add an intent
    // registry if the late one-shot collision occurs in a shipped composition.
    runtimeCtx.on('subagent/provider-added', (subagentProvider) => {
      if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider)
    })
    runtimeCtx.on('subagent/provider-removed', (name) => {
      if (name !== config.provider || mounted === undefined) return
      mounted.disposeTool()
      mounted.disposeOrchestrate()
      mounted = undefined
    })
    const present = runtimeCtx.subagents.getProvider(config.provider)
    if (present !== undefined) {
      mount(present)
    } else {
      // A backend fiber may activate later; a misspelled provider remains visible in this log.
      runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
    }
    // fork（corum）：research 与 worker 各注册自己的 `tool:${toolName}` 段——段名
    // 不同（`tool:subagent_research` / `tool:subagent`）不冲突；text 按读者可见性
    // 自我抑制（工具不可见时返回空串，等价于不注册）。
    /**
     * fork（corum）：PTC 模式前缀——该模式下工具不直接暴露，全部经 `run_code` 的
     * 生成式 SDK 调用（官方 ptc preset 的 `tool-presentation mode: ptc`）。2026-09-09
     * 把 corum 编排工具换进官方 preset 后，提示词必须说明调用形态，否则模型会直接
     * 点名 `subagent` 而找不到工具。
     * @param scope - 当前渲染 scope。
     * @returns PTC 说明句（非 PTC 为空串）。
     */
    const corumPtcPrefix = (scope: Parameters<typeof runtimeCtx.tools.get>[1]): string =>
      runtimeCtx.tools.get('run_code', scope) === undefined
        ? ''
        : 'This agent runs in PTC mode: every tool below is called from inside `run_code` (e.g. `await tools.subagent({...})`), not as a direct tool call. '

    if (corumReadonlyResearch || (backgroundEnabled && continuable)) {
      // The section follows provider availability without its own manual
      // lifecycle: empty text is omitted from rendered prompts while the tool is
      // absent, and the registration itself stays owned by this plugin fiber.
      runtimeCtx.systemPrompt.section({
        name: `tool:${toolName}`,
        order: runtimeCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
        text: context => mounted === undefined || runtimeCtx.tools.get(toolName, context.scope) === undefined
          ? ''
          : corumSchedulingSectionText({ backgroundEnabled, continuable, readonlyResearch: corumReadonlyResearch }, toolName, corumPtcPrefix(context.scope)),
      })
    }

    // fork（corum）：子 Agent 机制运用指引——让 Agent 主动判断何时用哪种委托形式
    // （含只读搜索子 Agent），而非等用户显式点名。仅 worker 实例注入（research
    // 只读实例无这些工具，注入会误导）；worker 实例的 toolName 是 'subagent'。
    //
    // 2026-09-10 用户要求「每个 Agent 都配备了 search Agent，所有模式都应该提到
    // 这一点，让 LLM 灵活指派」：只读搜索子 Agent 的指引**不再依赖 orchestrate
    // 可见性**——只要 worker 实例可见就注入；orchestrate 段落按可见性条件拼接
    // （PTC 模式经 run_code SDK 呈现，同样可见）。
    if (isWorkerInstance) {
      runtimeCtx.systemPrompt.section({
        name: 'corum:subagent-orchestration',
        order: runtimeCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 1,
        text: context => {
          if (mounted === undefined || runtimeCtx.tools.get(toolName, context.scope) === undefined) return ''
          const hasOrchestrate = runtimeCtx.tools.get('orchestrate', context.scope) !== undefined
          const hasResearch = runtimeCtx.tools.get('subagent_research', context.scope) !== undefined
          // 2026-09-10：官方 workflow / ralph / subagent_fork 按 corum 机制恢复挂载，
          // 机制段按可见性补一段「怎么选」——官方能力与 corum 机制并存，模型要知道
          // 哪些路径有隔离/台账/notice，哪些没有。
          const hasFork = runtimeCtx.tools.get('subagent_fork', context.scope) !== undefined
          const hasWorkflow = runtimeCtx.tools.get('workflow', context.scope) !== undefined
          const hasRalph = runtimeCtx.tools.get('ralph', context.scope) !== undefined
          if (!hasOrchestrate && !hasResearch && !hasFork && !hasWorkflow && !hasRalph) return ''
          // fork（corum）2026-09-27 重排（用户要求「整段重新编排」）：把**跨工具的形式选择**
          // 归到本段，并**置顶最短路径原则**；只读/写/编排三类条目**各出现一次**（旧版
          // `READ-ONLY work` 与 `ONE focused` 各重复了一遍）。相邻的 `tool:subagent` 段（order 2800）
          // 只保留本工具的调度与生命周期事实，「多个并行写就用 orchestrate」这句已搬到这里。
          const lines = [
            `${corumPtcPrefix(context.scope)}You have subagents. Use them PROACTIVELY — do not wait for the user to name a tool.`,
            '',
            'SHORTEST PATH WINS — pick the fewest calls that solve the task. Choose the form by the shape of the work:',
          ]
          // 三条并列在最前（只读 → 写 → 执行型验收）。只读是**条件**条目（research 实例缺席时
          // 不能提它），故用 push 逐条拼装而不是静态数组字面量。
          if (hasResearch) {
            lines.push(
              '- READ-ONLY work (research, search, fact-finding, summarization, JUDGING BY READING — checking an implementation against a spec, comparing output against expected values, or running read-only commands like `git log` / `ls`) → `subagent_research`.',
              '  - It ALWAYS runs in the FOREGROUND: its report returns in this tool result, so you read the findings inline.',
              '  - It cannot be backgrounded: `run_in_background: true` is rejected.',
              '  - Its sandbox is pinned to `read-only` and write/edit are denied, so it can investigate freely and can never modify the repo.',
              '  - One or two questions: call it directly. Several angles: send them in ONE message.',
            )
          }
          lines.push('- Work that CHANGES files (ONE focused, self-contained implementation or scoped fix) → `subagent`: one call, one result.')
          // fork（corum）2026-09-14：**执行型验收**必须走写能力工具（用户点名「主 Agent 派
          // research 去验收」）。验收分两种，旧文案把两者都塞进只读清单，于是需要跑断言/造
          // fixture/落盘证据的验收被派给没有 write 的子会话 ⇒ 派单自相矛盾（实证会话
          // `6364e3ea`：「不许改任何文件」与「必须造 fixture」并存）。
          lines.push('- EXECUTABLE verification (running assertions or tests, building a fixture or temp home, writing evidence files, driving a UI to observe real behaviour) → `subagent`, NOT `subagent_research`: running a verification is not the same as inspecting one, and a read-only child has no write/edit to build what the run needs.')
          if (hasFork) {
            lines.push('- CONTINUING THIS CONVERSATION instead of briefing a stranger (the child is seeded with your completed turns, so it already knows the context) → `subagent_fork`. It gets the same isolation, ledger and settlement-notice treatment as `subagent`; prefer `subagent` when a self-contained brief is cleaner.')
          }
          if (hasOrchestrate) {
            lines.push(
              // fork（corum）2026-10：**门槛落进机制**（用户定稿「orchestrate 至少 2 个任务才起效」）。
              // 单任务现在会被工具直接拒绝（不是靠提示词劝阻），这里的文案与机制同口径。
              '- ONE piece of work → `subagent` (or `subagent_research` when read-only). A single-task `orchestrate` is REJECTED by the mechanism: it adds a flow card and a closer round-trip for zero parallelism gain.',
              '- TWO OR MORE independent pieces of work → **ONE** `orchestrate` call, not N `subagent` calls.',
              '  - Cost of N separate delegations: N tool calls; N settlement notices landing in your context; one session isolation slot each, and exceeding it FAILS the call; plus a manual `integrate` afterwards when they are writes.',
              // 2026-09-27 修 P3（审查员 B 报；我写的错）：原句声称 orchestrate 有「更宽的并发上限」——不成立。
              // 声明式任务同样受 maxParallelChildren（默认 4）约束；脚本模式引擎虽允许 min(16,cpus-2)，
              // 但隔离 provider 上限仍是 4，第 5 个并发抛 AGENT_START（fatal）⇒ 整次 orchestrate 失败、其余结果全丢。
              '  - Cost of ONE `orchestrate`: a single call; ONE final result comes back; the mechanism merges, verifies and commits for you when the work was isolated.',
              '  - Shortest path for: "split this into modules A/B/C"; "do these 4 migrations"; THREE OR MORE read-only angles at once (`research: true` tasks aggregate into a single result).',
              '- Keep N separate `subagent` calls ONLY when:',
              '  - the pieces are genuinely NOT independent (each needs the previous result);',
              '  - you must steer one mid-flight (`send_message` / `interrupt_agent`);',
              '  - partial results arriving as they settle is what you want.',
              '',
              'How the mechanism works (rely on it, do not re-implement):',
              '- **Isolation is a property of CHANGE, not of delegation.**',
              '  - A write-capable delegation is ISOLATED by default: it gets its OWN git worktree + branch (the parent working tree is write-denied to that child), whether it runs in the foreground or the background, and whether or not another write child is running.',
              '  - It exists so a child\'s edits land on their own branch and reach your tree through integrate. A delegation that only reads produces nothing to isolate, so route it to `subagent_research` — never call the write-capable `subagent` for a task that changes nothing.',
              '  - Its edits reach your tree ONLY through integration: `orchestrate` does it for you automatically (any isolated task makes the closer merge), or you do it explicitly with `subagent { integrate: true }` for a single delegation.',
              '  - Never assume a delegated write has landed — a FOREGROUND result states where the work is; for a background run read its settlement notice, and check the branch/worktree state yourself when the notice does not say.',
              '  - Read-only research delegations are not isolated (they write nothing).',
              '  - **`isolation: "main"` is the non-isolated route** (an `orchestrate` task takes the same value): the child works directly in your REAL tree with your sandbox mode, so it CAN build, install, `git push` or merge — and its edits are already yours (nothing to integrate). Use it only when the work really needs that; the default isolated route is what keeps concurrent writers apart.',
              '  - Isolation needs a git repository: in a non-repo workspace it is skipped automatically (children work in the parent tree and leave version control to you) and the child is told so.',
              '- **Child model routing is NOT yours to choose.**',
              '  - Neither `subagent` nor `orchestrate` exposes any model parameter (a per-task `model` used to exist on `orchestrate` tasks and was deliberately removed).',
              '  - In `orchestrate` SCRIPT mode the `agent()` options belong to the workflow engine — passing `provider`/`model` there is still routing a child, so do not: the mechanism owns the route.',
              '  - The child runs on the model the user configured for this Agent — or, when the user left it unset, on your own route.',
              '  - Never ask the user to pick a model; never try to route a child elsewhere.',
              '  - If a child fails because its configured model is unavailable, the MECHANISM — not you — asks the user what to do (temporarily switch this session to your model, permanently change the child model, or stop delegating) and then acts on that answer; you must not try to change any model or route yourself.',
              '  - Read the resulting notice: it tells you whether to re-issue the delegation or do the work yourself.',
              // fork（corum）2026-10：`merge` 字段取消（机制自动判定收尾），提示词同步改写——
              // 并补三条新纪律：黑盒语义、冲突预判、收尾节点 closer。
              '- **`orchestrate` is ONE BLACK-BOX CALL.** You start it; you get ONE final result.',
              '  - The parallel children settle INTO THE MECHANISM, not to you: you get no per-child settlement notice for them, and you must NOT try to merge, integrate or finish their work while the call runs. Wait for the call.',
              '  - A closer node — dispatched by the mechanism, no parameter for it — collects every task output, does the finishing step, and reports back to you.',
              '  - What comes back: the closer\'s report plus one REFERENCE per task (index, label, ok/aborted, child session id, worktree/branch). The full per-task outputs are NOT inlined — read the report, and enter a child session when you need its raw output.',
              '- **FINISHING IS AUTOMATIC — there is no `merge` parameter any more.**',
              '  - The mechanism decides by what actually happened: if any task ran in an isolated worktree, the closer merges those branches into your tree, runs the detected checks and commits; if every task ran in your main tree or was read-only research, the closer only summarizes (a research run becomes one consolidated research report).',
              '  - You cannot opt out, and you do not declare a verification command: the mechanism detects it from the repo.',
              '  - NEVER delegate a main-tree write to an ISOLATED child and expect it to land: that child works in its own worktree, so its writes cannot reach the parent tree.',
              '- **CONFLICT PRE-FLIGHT IS YOURS.** The mechanism cannot detect collisions before the edits exist: before issuing the call, confirm yourself that the parallel WRITE tasks do not touch the same files or modules. Two tasks editing one file will collide at merge time, and only you can see that risk up front.',
              '- **Task scheduling**: `orchestrate` tasks run in the foreground by default and the call returns when all settle; a per-task `background: true` is allowed but then that task cannot join the fan-in.',
            )
          } else {
            lines.push(
              '',
              'How the mechanism works (rely on it, do not re-implement):',
              '- Model routing is LOCKED by the mechanism. Never ask the user (or try) to pick a model for a child — there is no such parameter.',
            )
          }
          if (hasWorkflow || hasRalph) {
            lines.push('')
            if (hasWorkflow) {
              lines.push('- A model-authored orchestration SCRIPT — loops, conditionals, retries, aggregation in code — → call `workflow` (only when the user asks for a workflow or the fan-out genuinely needs program logic).')
            }
            if (hasRalph) {
              lines.push('- Fresh-agent iteration toward ONE immutable objective → call `ralph` (sequential, bounded rounds).')
            }
            const engineTools = [hasWorkflow ? '`workflow`' : '', hasRalph ? '`ralph`' : ''].filter(Boolean).join(' and ')
            lines.push(`IMPORTANT: ${engineTools} children are created by their own engine${hasWorkflow && hasRalph ? 's' : ''} — they do NOT get isolated worktrees, ledger entries or settlement notices, and nothing merges their work. Use them for read-only audits or work that does not need merging; for parallel WRITES that need isolation + merge, use \`orchestrate\` instead.`)
          }
          // 效率/沙箱两块纪律**不在这里**：它们已独立成 `corum:execution-discipline` 段，由
          // `corum-agent` 在 **root scope** 注册（所有 corum 会话 + 子会话继承）；minimal 因
          // `complete` 撤不掉段，改走 `compile.ts` 的人格段追加。以免被本段的可见性守卫连坐清空。
          lines.push(
            '',
            // 2026-09-27 跨块一致性：默认 `orchestrate` 是**前台**（调用返回时全部结算 ⇒ 没有通知、也没有「并行期间」），
            // 故这句必须限定在**后台委派**上，否则模型会等一个不会来的通知 / 或以为 orchestrate 期间还能并行推进。
            'After a BACKGROUND delegation, keep doing useful work while children run; when each settles you are notified with its outcome. A foreground delegation — including the default `orchestrate` call — returns everything in that call, so there is nothing to wait for in parallel.',
            'A BACKGROUND subagent is NOT a job: there is no job id to poll and no `job_output` to read. Track it with `list_agents` (list running/known children), steer or follow up with `send_message`, ask it to stop with `interrupt_agent` (a request that returns without waiting; its own children keep running), and wait for its settlement notice — or simply keep working and act when the notice arrives. `send_message` reaches BACKGROUND (continuable) children only: a foreground one-shot child (`run_in_background: false`) is terminal once it settles, and messaging it is rejected.',
          )
          return lines.join('\n')
        },
      })
    }
  }

  if (config.modelSelectionSettings !== true) {
    install(ctx, undefined)
    return
  }

  const settings = ctx.get('subagentModelSelection')
  if (settings === undefined) {
    throw new Error(
      'tool-subagent: `modelSelectionSettings` requires '
      + '@deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope',
    )
  }
  const compositionScope = scopeOf(ctx)
  if (compositionScope === undefined) {
    throw new Error('tool-subagent: `modelSelectionSettings` requires an Agent or preset scope')
  }

  const selectForAgent = (agent: Agent): ModelSelectionPolicy | undefined => {
    const freshSession = agent.session.firstLiveSeq === 0
      && agent.session.eventAt(SessionSeq(0))?.type !== 'session/end-seed'
    let allowedModels = subagentModelSelectionPolicy(ctx.sessionProjections, agent.session)
    if (allowedModels === undefined) {
      const parentId = agent.session.header.origin === 'subagent'
        ? agent.session.header.parentSession
        : undefined
      if (parentId !== undefined) {
        const parent = ctx.get('agents')?.get(parentId)
        allowedModels = parent === undefined
          ? undefined
          : subagentModelSelectionPolicy(ctx.sessionProjections, parent.session)
      } else if (freshSession) {
        const current = settings.current()
        allowedModels = current.enabled ? current.allowedModels : undefined
      }
    }
    if (allowedModels !== undefined) {
      recordSubagentModelSelection(ctx.sessionProjections, agent.session, allowedModels)
    }
    return allowedModels === undefined ? undefined : { routes: allowedModels }
  }

  // 0.1.5 起 `ctx.agent` accessor 已删除（官方改为 `apply(ctx, config, session?)` 的 Session 轴）。
  // corum 这块**恒不生效**（`compile.ts` 恒传 `modelSelectionSettings: false`，见该处注释与
  // tests/model-policy.spec.ts 的断言）⇒ 这里按**等价语义**保留 Agent 轴：用当前 ctx 的 scope
  // 在 Agent 注册表里找归属同一 scope 的存活 Agent（旧 accessor 的语义就是"本 ctx 绑定的 Agent"）。
  const ownScope = scopeOf(ctx)
  const registryForScope = ctx.get('agents')
  const boundAgent = ownScope === undefined || registryForScope === undefined
    ? undefined
    : registryForScope.list().find(candidate => scopeOf(candidate.ctx) === ownScope)
  if (boundAgent !== undefined) {
    install(ctx, selectForAgent(boundAgent))
    return
  }
  const agents = ctx.get('agents')
  /* v8 ignore next -- Agent and preset scopes are minted only by the Agent registry. */
  if (agents === undefined) throw new Error('tool-subagent: scoped model-selection settings require the Agent registry')
  const scopedInstalls = new WeakMap<Agent, ReturnType<Context['inject']>>()
  const installing = new WeakSet<Agent>()
  const belongsToComposition = (candidate: Agent): boolean =>
    scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope)
  const installScoped = (candidate: Agent): void => {
    if (scopedInstalls.has(candidate) || installing.has(candidate)) return
    // Reserve before the injected fiber runs: tool registration emits
    // `tools/change` synchronously, which re-enters the reconciliation below.
    installing.add(candidate)
    let fiber: ReturnType<Context['inject']>
    try {
      const policy = selectForAgent(candidate)
      fiber = candidate.ctx.inject(['tools', 'subagents', 'systemPrompt'], (runtimeCtx) => {
        install(runtimeCtx, policy)
      })
    } finally {
      installing.delete(candidate)
    }
    scopedInstalls.set(candidate, fiber)
  }
  const removeScoped = (candidate: Agent): void => {
    const fiber = scopedInstalls.get(candidate)
    if (fiber === undefined) return
    scopedInstalls.delete(candidate)
    /* v8 ignore next 3 -- Cordis Fiber disposal contains registration cleanup failures; this is the final diagnostic sink. */
    void fiber.dispose().catch((error: unknown) => {
      ctx.logger.warn(`tool-subagent: failed to remove recomposed Agent "${candidate.id}" definitions: ${String(error)}`)
    })
  }
  const reconcileComposedAgents = (): void => {
    // Every Agent and preset scope is minted by the Agent registry; the scope
    // check above makes this same-process typed relationship authoritative.
    for (const candidate of agents.list()) {
      if (belongsToComposition(candidate)) installScoped(candidate)
      else removeScoped(candidate)
    }
  }
  // A shipped preset is mounted once in a standing scope. Its listener admits
  // only descendant Agents and installs the sampled tool definition in each
  // Agent's own scope, so a later settings change cannot mutate a live session.
  ctx.on('agent/created', ({ agent: created }) => {
    installScoped(created)
  })
  ctx.on('agent/disposed', ({ agent: disposed }) => { removeScoped(disposed) })
  // Reparenting an Agent between standing presets changes its inherited tool
  // set and emits `tools/change`; reconcile the Agent-owned override with the
  // new ancestry. Other registry changes are idempotent no-ops here.
  ctx.on('tools/change', reconcileComposedAgents)
}
