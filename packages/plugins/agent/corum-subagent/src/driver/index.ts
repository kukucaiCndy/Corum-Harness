/**
 * Shared driver for in-process ONE-SHOT subagent providers. The agent factory's
 * creation transaction owns unpublished setup and rollback; after publication
 * the returned AgentHandle is the one quiescent lifecycle owner held by the
 * provider's caller.
 *
 * Continuable children never come through here: the continuation manager
 * composes and drives them directly, so this driver owns exactly one turn with
 * one result.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionLogOffset as SessionLogOffsetType, TurnEndReason } from '@deepseek-ai/dsh-session'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { corumRoutingIgnoredNoticeText, corumStripRoutingOptions } from '../routing-guard.ts'
import { parentAgentOptionsForDelegation } from '../child-agent.ts'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '../index.ts'
import { snapshotSubagentDescriptor } from '../descriptor.ts'
import type {
  ResolvedSubagentStartRequest,
  SubagentDescriptorData,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '../index.ts'
import {
  attachStructuredRuntime,
  type StructuredAttachment,
} from '../structured.ts'

export {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_INSTRUCTION,
} from '../structured.ts'

/** Map a session turn outcome to the subagent seam's terminal vocabulary. */
function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // A pre-step rejection discarded the claimed prompt: the task was
    // declined, and the caller must not read the run as done.
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    default:
      return 'error'
  }
}

/** Extra inputs the spawn and fork providers supply to the shared driver. */
export interface InProcessRunOptions {
  /** Completed-turn seed for fork, or undefined for a fresh spawn. */
  readonly seed?: readonly SessionEvent[]
}

/** Error used when cancellation wins before the child publication boundary. */
function prePublicationAbort(): Error {
  return new Error('subagent request was aborted before child publication')
}

/** Append one one-shot descriptor inside the child's initial turn before its first request. */
function attachDescriptorAppend(childCtx: Context, descriptor: SubagentDescriptorData): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/**
 * Establish and drive one in-process one-shot child. Fulfillment means the agent
 * is already published in the registry and transfers its turn, cancellation,
 * and disposal work through the returned run. Rejection means the agent
 * factory's unpublished creation transaction reached quiescence without
 * publishing a child. Every start appends its resolved descriptor inside the
 * child's initial turn.
 * @param request - the trusted typed start request, including its required signal.
 * @param options - the optional fork seed.
 * @returns a published holder-owned run.
 */
export async function startInProcessRun(
  request: ResolvedSubagentStartRequest,
  options: InProcessRunOptions,
  providerName = 'corum',
): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw prePublicationAbort()
  const parent = request.parent
  const childDepth = resolveChildDepth(parent, request.maxDepth)

  const childId = brandString<SessionId>(randomUUID())
  const seed = options.seed
  const activationBoundary = SessionLogOffset(seed?.length ?? 0)

  // Capture before the first await: a later parent switch belongs to the
  // parent's future.
  const inherited = captureDelegatedPolicyOverrides(parent, {
    pinReadOnly: request.readonlySandbox === true,
    confineToWorktree: request.confinedSandbox === true,
  })

  let structured: StructuredAttachment | undefined
  const setup = (childCtx: Context, childAgent: Agent): void => {
    appendDelegatedPolicyOverrides(childAgent.session, inherited)
    applyChildComposition(childCtx, childAgent, parent, {
      // fork（corum）2026-09-20：种类 + 注入层一起下传（人格按 kind 由子 scope 决定）。
      ...request.kind === undefined ? {} : { kind: request.kind },
      ...request.personaHint === undefined ? {} : { personaHint: request.personaHint },
      persona: request.persona,
      toolFilter: request.toolFilter,
      // fork（corum）2026-09-22：隔离子会话装写边界门禁（纵深防御，边界就地取子会话 cwd）。
      ...request.confinedSandbox === true ? { confined: true } : {},
    })
    if (request.outputSchema !== undefined) {
      // fork（corum）：one-shot driver 的 canComplete 恒为 true（子 Agent 提交时即完成）。
      structured = attachStructuredRuntime(childCtx, request.outputSchema, () => true)
    }
    attachDescriptorAppend(childCtx, snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: providerName,
      ...request.label !== undefined ? { label: request.label } : {},
    }))
  }

  // 2026-09-27 P1（用户裁定方案 A「剥离 + 告知」）：**脚本模式的路由选项在这里被剥离**。
  //
  // 机制拥有子 Agent 路由（用户 2026-09-18「orchestrate 也不能豁免」）。依据（运行时产物）：
  // 引擎的 `SUPPORTED_AGENT_OPTIONS` 含 `provider`/`model`
  // （`@deepseek-ai/dsh-base@0.1.3-alpha.1` 的 `dsh-workflow-worker-thread/lib/worker.cjs`），
  // 而 `resolveChildAgentOptions` 的 `...requested` 在最后 ⇒ 不剥离就会覆盖父路由。
  // 设计稿：docs/PLAN-2026-09-27-script-mode-model-routing.md。
  // P1：**只剥脚本传的路由偏好**。`agentOptionsOwnedByMechanism` 为真时（fork 角色锁 / 续接恢复），
  // 那是机制自己的路由，剥了就会让子会话跑错模型（2026-09-27 复查抓到的反例）。
  const routing = request.agentOptionsOwnedByMechanism === true
    ? { options: request.agentOptions, ignored: undefined }
    : corumStripRoutingOptions(request.agentOptions)
  // fork（corum）2026-10-19：**机制路由走独立通道**（`request.mechanismRoute`）。
  //
  // 背景：`corum-isolated`（脚本模式）曾把机制路由写进 `agentOptions` 并打
  // `agentOptionsOwnedByMechanism: true` ⇒ 上面的剥离整段跳过 ⇒ 脚本违规自选的
  // `provider`/`model` 既没被剥离、也没触发告知（方案 A 的「告知」那一半静默丢失）。
  // 现在 `agentOptions` 保持脚本原样（正常剥离 + 告知），机制路由从独立字段叠加在
  // **剥离之后** ⇒ 两件事同时成立：机制路由胜出 ∧ 脚本路由被剥离且被告知。
  const requestedOptions: AgentOptions | undefined = request.mechanismRoute === undefined
    ? routing.options
    : { ...routing.options, ...request.mechanismRoute }
  if (routing.ignored !== undefined) {
    // 告知（方案 A 的第二半）：一条机制通知，含**实际生效的路由**，让模型学到口径。
    // 有机制路由时，实际生效的就是它（不是父路由）——通知必须说真话。
    try {
      const text = corumRoutingIgnoredNoticeText(
        routing.ignored,
        request.mechanismRoute ?? parentAgentOptionsForDelegation(parent),
      )
      parent.inject(createUserMessage({
        content: [{ type: 'text' as const, text }],
        source: {
          kind: 'mechanism-notice',
          form: 'notice',
          summary: boundContextSummary(text),
          senderSessionId: childId,
        },
      }))
    } catch {
      // 通知失败不影响派发：剥离本身已经保证机制拥有路由。
    }
  }

  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    // fork（corum）2026-10-19：**运行期归属（owner）必须显式传**，否则子 Agent
    // 会被注册成 root —— 这是一处被官方语义变更打断后遗留的漏改，不是设计。
    //
    // 官方在 `0b8956aab9`（refactor(agent): move runtime parent into options，
    // 2026-09-02）把 owner 从「loop 隐式取 `ownerCtx.agent`」改为「读
    // `options.parentAgent`」，同一提交删掉了旧的第二位置参。本 fork 建于
    // dsh-v0.1.3-alpha.1（该提交**晚于**此 tag，`git merge-base --is-ancestor`
    // 为 NO），基线里本就没有这个字段——升级 0.1.5 时未跟改，而它是**可选字段**，
    // 编译器不报错，于是整条链路上无人发现。
    //
    // 后果：`entry.owner === undefined` ⇒ `agents.roots()` 把子 Agent 也当成顶层
    // Agent ⇒ `userQuestions.ask()` 的 `DELEGATED_CALLER` 门禁放行 ⇒ 子 Agent 的
    // 提问请求落到 scope 在子会话的 waterfall 上无人认领 ⇒ **前台委派下父 Agent
    // 一起永久挂起**（issue #75 实测：一次 ask 直至用户手动停止才被 abort，517s）。
    //
    // 官方对照：`@deepseek-ai/dsh-subagent` manager.ts 的
    // `this.ownerCtx.agents.create({ parentAgent: parent, ... })`。
    parentAgent: parent,
    meta: childSessionMeta(parent, childDepth, seed !== undefined, request.cwd),
    ...seed !== undefined ? { seed } : {},
    ...seed === undefined ? {} : { inheritedEventCount: activationBoundary },
    agentOptions: resolveChildAgentOptions(parent, requestedOptions, childDepth),
    signal: request.signal,
    setup,
  })
  return drivePublishedRun(
    handle,
    request.signal,
    request.prompt,
    childId,
    activationBoundary,
    structured,
  )
}

/**
 * Wrap a published child in the single run lifecycle that owns signal handoff,
 * one turn, result settlement, and quiescent disposal.
 */
function drivePublishedRun(
  handle: AgentHandle,
  signal: AbortSignal,
  prompt: ContentBlock[],
  childId: SessionId,
  boundary: SessionLogOffsetType,
  structured: StructuredAttachment | undefined,
): SubagentRun {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  // Agent creation detaches its creation-only listener before returning. The
  // post-registration check closes that handoff without treating an already
  // published child as a failed start.
  if (signal.aborted) onAbort()

  const result: Promise<SubagentResult> = (async () => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      return readResult(
        child,
        boundary,
        flags.cancelled,
        structured ? { captured: structured.captured() } : undefined,
      )
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose(): Promise<void> {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const settlements = await Promise.allSettled([handle.dispose(), result])
      const disposal = settlements[0]
      // The result channel owns run faults; disposal reports only failure to
      // release the published handle after both operations settle.
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

/** Read one settled child's result from events after its activation boundary. */
function readResult(
  child: Agent,
  boundary: SessionLogOffsetType,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
): SubagentResult {
  const own = child.session.snapshotEvents(boundary)
  // `droppedUnrun` is deliberately unread: a one-shot prompt is claimed by its
  // awaited first turn almost immediately, and the owner's own teardown is the
  // `cancelled` flag below. A cancellation with no accounting turn resolves
  // `error` through `toStopReason(undefined)`, which never overstates success.
  const lastEnd = foldConsumedWork(own).end
  // The seam's canonical selection rule; a partial answer survives cancel and truncation.
  const output: readonly ContentBlock[] = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  // Disposal can tear the owner down before the loop records its ordinary
  // `aborted` end, yielding `disposed` instead.
  const stopReason: SubagentStopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  if (structured !== undefined) {
    if (structured.captured !== undefined) {
      return { output, structured: structured.captured.value, stopReason }
    }
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return { output, stopReason }
}
