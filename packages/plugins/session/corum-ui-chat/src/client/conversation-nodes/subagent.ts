import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@corum/corum-ui-conversation/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { subagentDelegationRoleOf } from '@corum/corum-api-remotes/corum-events'
import { isSubagentDelegationTool } from '../contract/turn-process.ts'
import { subagentChildOf } from '../chat-runtime.ts'
import {
  subagentDelegationFields,
  type SubagentInvocation,
} from '../contract/subagent.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Delegated subagent invocations of one Turn, rendered as progress cards. */
    'subagent-call': import('../contract/subagent.ts').SubagentChatData
  }
}

/** One delegation call's own Context state（2026-09-10：按次建节点）。 */
interface SubagentCallState {
  readonly invocation: SubagentInvocation
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]
/**
 * Best-effort correlation of one delegation call to its child Session:
 * durable `origin: 'subagent'` + direct parent lineage + nearest summary row
 * that arrived no earlier than the call (a reused continuable child row
 * predates its later calls; its identity resolves via its already-cached
 * `childSessionId` once matched). The parent id is recovered from each
 * candidate child row itself, so the Definition stays registration-global.
 * Unmatched calls degrade to summary-only cards driven by the delegation
 * lifecycle itself.
 */
function correlateChild(
  candidates: readonly SessionSummary[],
  callTime: number,
): string | undefined {
  const later = candidates
    .map((summary, index) => ({ summary, index, arrivedAt: summary.updatedAt }))
    .filter(entry => entry.arrivedAt >= callTime)
    .sort((left, right) => left.arrivedAt - right.arrivedAt || left.index - right.index)
  return later[0]?.summary.id
}

/** Re-correlate one invocation against the live session list. */
function refreshCorrelation(
  invocation: SubagentInvocation,
  summaries: Readonly<Record<string, SessionSummary>>,
): SubagentInvocation {
  // 精确优先：宿主 spawn 广播（'corum/subagent/child'）已在本进程缓存了真实 id
  // 与前台/后台模式（2026-09-09 修复「运行期进不去子会话」）；没有才退回
  // summary 时间就近匹配（时间匹配拿不到模式，卡片改用工具参数兜底）。
  const exact = subagentChildOf(invocation.callId)
  if (exact !== undefined) {
    return { ...invocation, childSessionId: exact.childSessionId, mode: exact.mode }
  }
  if (invocation.childSessionId !== undefined) return invocation
  const children = Object.values(summaries).filter(summary => summary.origin === 'subagent')
  const childSessionId = correlateChild(children, invocation.time)
  return childSessionId === undefined ? invocation : { ...invocation, childSessionId }
}

/** Fold one delegation `tool/call` into its invocation identity. */
function startInvocation(match: ConversationMatch): SubagentInvocation {
  if (match.event.type !== 'tool/call') throw new Error('subagent start requires tool/call')
  const fields = subagentDelegationFields(match.event.data.arguments)
  // 角色 = 这条 tool/call 的名字（权威面，就在本事件里）。
  const role = subagentDelegationRoleOf(String(match.event.data.name))
  return {
    callId: String(match.event.data.callId),
    turn: match.event.data.turn,
    anchorSeq: match.event.seq,
    time: match.event.time,
    ...role === undefined ? {} : { role },
    ...fields.description === undefined ? {} : { description: fields.description },
    ...fields.prompt === undefined ? {} : { prompt: fields.prompt },
    ...fields.mode === undefined ? {} : { mode: fields.mode },
  }
}

/** Rebuild the invocation from the Context's own start Match (cold feeds). */
function fallbackInvocation(context: ConversationNodeContext<SubagentCallState>): SubagentInvocation | undefined {
  const match = context.matches.find(entry => entry.event.type === 'tool/call')
  return match === undefined ? undefined : startInvocation(match)
}

/**
 * 从一条父侧 `tool/result` 取失败原文（成功/无结果返回 undefined）。
 *
 * 为什么卡片要读父侧工具结果：卡片的进度数据源完全绑定 `childSessionId`，而模型不可用
 * 在 **spawn 期预检失败**时子会话**从未创建** —— 没有子会话就没有进度帧也没有终态，
 * `progress` 恒 undefined，判据家 `subagentProgressStateOf({})` 恒返回 `'running'`，
 * 卡片于是永远转圈（2026-09-19 用户实测）。父会话日志里这条 `tool/result` 是唯一能
 * 证明「本次委派失败了」的信号。
 *
 * @param match - one matched Conversation event.
 * @returns 失败原文；该结果不是错误时为 undefined。
 */
function delegationFailure(match: ConversationMatch): string | undefined {
  if (match.event.type !== 'tool/result') return undefined
  // rc3: ToolResultMessage.isError is on the message, not on ContentBlock.
  const message = match.event.data.message
  if (message.isError !== true) return undefined
  // 只取文本块：失败原文由 corum-tool-subagent 的 throw 组装，含「为什么 + 下一步」。
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.trim() === '' ? 'delegation failed' : text.trim()
}

/** This Context's invocation, re-correlated against the live session list. */
function currentInvocation(
  context: ConversationNodeContext<SubagentCallState>,
  summaries: Readonly<Record<string, SessionSummary>>,
): SubagentInvocation | undefined {
  const invocation = context.state?.invocation ?? fallbackInvocation(context)
  if (invocation === undefined) return undefined
  const correlated = refreshCorrelation(invocation, summaries)
  // 失败原文以父侧日志为权威（每次重算时取最新匹配，冷喂也能从 matches 拿到）。
  const failure = context.matches
    .map(delegationFailure)
    .filter((value): value is string => value !== undefined)
    .at(-1)
  return failure === undefined ? correlated : { ...correlated, toolError: failure }
}

/**
 * Build the per-delegation subagent Definition bound to the sessions service for
 * summary-based child correlation at Location-data evaluation time.
 *
 * 2026-09-10（用户 P8 定调）：**每次委托一个节点**——`match` 以 `tool/call` 的
 * `callId` 为 Context id，`buildViewNode` 用该次委托自己的 `seq` 当 `anchorSeq`。
 * 此前是「每个 turn 一个节点 + 锚点取该 turn 最早一次委托」，同 turn 后续委托的
 * 卡片全部堆到最早位置（新的在上面，必须上翻才看到）。逐次成节点后，卡片落在
 * 它发生的那一步，与瀑布流顺序一致。
 * @param sessions - sessions service face exposing the live summary list.
 * @returns subagent progress-card Definition.
 */
export function subagentTurnDefinition(
  sessions: ISessions,
): ConversationNodeDefinition<SubagentCallState> {
  return {
    kind: 'subagent-progress',
    target: 'chat',
    // ⚠️ `tool/result` 必须收（2026-09-19）：它是「本次委派失败」在父日志里的唯一
    // 证据，卡片在子会话从未创建（spawn 期预检失败）时只能靠它翻成失败态。故 match 不
    // 再只认 `tool/call`——`role: 'update'` 让这些结果进 `context.matches`，由
    // buildViewNode 重算时折进 `invocation.toolError`。
    match: (event: ConversationEvent) => {
      if (event.type === 'tool/call' && isSubagentDelegationTool(event.data.name)) {
        return { id: String(event.data.callId), role: 'start' }
      }
      if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
        return { id: String(event.data.message.source.callId), role: 'update' }
      }
      return null
    },
    start: (_context, match) => ({ invocation: startInvocation(match) }),
    // 本 Context 的 state 只承载 start 的 invocation；进度与失败原文都在 buildViewNode
    // 重算时求（进度对 live sessions 列表求，失败原文对 matches 求），故这里是 no-op。
    update: context => context.state,
    buildViewNode: (context) => {
      const location = context.start?.location ?? context.matches.at(-1)?.location
      if (location?.kind !== 'turn' && location?.kind !== 'step') return null
      const invocation = currentInvocation(context, sessions.list.getSnapshot().byId)
      if (invocation === undefined) return null
      return chatNode(context, 'subagent-call', invocation.anchorSeq, { invocations: [invocation] })
    },
  }
}

/**
 * Register the subagent progress-card Definition against the live sessions service.
 * @param ctx - owning UI Conversation context.
 */
export function registerSubagentConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(subagentTurnDefinition(ctx.sessions))
}
