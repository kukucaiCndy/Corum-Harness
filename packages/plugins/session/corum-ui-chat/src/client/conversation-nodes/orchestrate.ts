/**
 * fork（corum）：orchestrate 编排卡的会话节点定义。
 *
 * 为什么需要它：`orchestrate` 是 corum 特有的 fan-out 工具（`corum-tool-subagent`
 * 的 worker 实例注册），但 chat 侧此前**没有对应节点定义**——`isSubagentDelegationTool`
 * 只认 `subagent*`，于是 orchestrate 调用落到通用工具行（一行 JSON 折叠），
 * 瀑布流里看不到任务清单、逐任务状态与集成阶段。本定义把一次 orchestrate 调用
 * 折成一张卡（设计稿 `orchestrate-flow-card`）。
 *
 * 生命周期（与 subagent.ts 同范式，但**一次调用一个节点**且自己吃 result）：
 *   match `tool/call` name='orchestrate'  → Context id = callId，role 'start'
 *   match 同 callId 的 `tool/result`      → role 'update'
 *   buildViewNode 用调用自己的 seq 当 anchorSeq，卡片落在它发生的那一步。
 *
 * 数据全部来自父会话事件窗口（arguments + 结果正文），无新宿主通路、无重启。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@corum/corum-ui-conversation/client'
import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-tools/types'
import {
  parseCallArguments, parseCloser, parseIntegration, parseOutcomes, parseTaskRefs, parseWorktreeSlugs,
  type OrchestrateChatData, type OrchestrateCloser, type OrchestrateIntegration, type OrchestrateTask,
} from '../contract/orchestrate.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** corum orchestrate fan-out 调用的编排卡。 */
    'orchestrate-call': OrchestrateChatData
  }
}

/** 本工具名（宿主 `corum-tool-subagent` 的 worker 实例注册；全局唯一）。 */
const ORCHESTRATE_TOOL = 'orchestrate'

/** One orchestrate call's own Context state（静态声明 + 已折叠的终态）。 */
interface OrchestrateCallState {
  readonly callId: string
  readonly anchorSeq: number
  readonly time: number
  readonly tasks: readonly OrchestrateTask[]
  /** @deprecated 2026-10 起恒 false（`merge` 字段已取消）；只为历史会话回放保留。 */
  readonly hasMerge: boolean
  readonly outcomes: ReadonlyMap<number, { kind: 'done' } | { kind: 'aborted' } | { kind: 'failed'; error: string }>
  readonly settled: boolean
  readonly errored: boolean
  /** 收尾节点（closer）的结果——2026-10 编排黑盒化的主交付。 */
  readonly closer?: OrchestrateCloser
  /** @deprecated 2026-10：新结果不再产生；只为历史会话回放解析。 */
  readonly integration?: OrchestrateIntegration
  /** 逐任务的隔离 worktree slug（`results[].worktreeSlug`；刷新后的耐久兜底）。 */
  readonly worktreeSlugs?: ReadonlyMap<number, string>
  /** 逐任务的隔离分支名（`results[].branch`）。 */
  readonly worktreeBranches?: ReadonlyMap<number, string>
  /** 逐任务的子会话 id（`results[].childSessionId`，durable）。 */
  readonly childSessionIds?: ReadonlyMap<number, string>
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

/** 从一次 `tool/call` 建初始状态。 */
function startCall(match: ConversationMatch): OrchestrateCallState {
  if (match.event.type !== 'tool/call') throw new Error('orchestrate start requires tool/call')
  const parsed = parseCallArguments(match.event.data.arguments)
  return {
    callId: String(match.event.data.callId),
    anchorSeq: match.event.seq,
    time: match.event.time,
    tasks: parsed.tasks,
    hasMerge: parsed.hasMerge,
    outcomes: new Map(),
    settled: false,
    errored: false,
  }
}

/** 读 `tool/result` 的正文（宿主 render 的拼接串）。 */
function resultText(match: ConversationMatch): string {
  if (match.event.type !== 'tool/result') return ''
  const parts: string[] = []
  for (const block of match.event.data.message.content) {
    for (const inner of block.content) {
      if (inner.type === 'text') parts.push(inner.text)
    }
  }
  return parts.join('\n')
}

/** 把一条 `tool/result` 折进状态。 */
function applyResult(state: OrchestrateCallState, match: ConversationMatch): OrchestrateCallState {
  const text = resultText(match)
  const closer = parseCloser(text)
  const integration = parseIntegration(text)
  const refs = parseTaskRefs(text)
  // worktree slug 优先新契约的可寻址字段（`results[].worktreeSlug`），旧正文解析兜底。
  const slugs = refs.worktreeSlugs.size > 0 ? refs.worktreeSlugs : parseWorktreeSlugs(text)
  return {
    ...state,
    outcomes: parseOutcomes(text),
    ...slugs.size > 0 ? { worktreeSlugs: slugs } : {},
    ...refs.branches.size > 0 ? { worktreeBranches: refs.branches } : {},
    ...refs.childSessionIds.size > 0 ? { childSessionIds: refs.childSessionIds } : {},
    settled: true,
    errored: match.event.type === 'tool/result' && match.event.data.message.content.some(
      block => block.isError === true,
    ),
    ...closer === undefined ? {} : { closer },
    ...integration === undefined ? {} : { integration },
  }
}

/**
 * 逐任务子会话的**历史兜底**关联（页面刷新后无 spawn 广播帧时）。
 *
 * 口径与 `subagent.ts` 的 correlateChild 一致：`origin='subagent'` 且
 * `updatedAt >= 调用时刻` 的会话，按时间升序取前 N 个（N = 任务数）。
 * 不加 label 匹配——session/list 的 summary 不带任务 label，只能按顺序对齐
 * （宿主按 `tasks[]` 顺序 spawn，故顺序可靠）。
 * @param summaries - 当前会话列表快照的 byId。
 * @param callTime - 父侧 tool/call 时间。
 * @param count - 任务数。
 * @returns 每个下标对应的子会话 id（不足处为 undefined）。
 */
function correlateChildren(
  summaries: Readonly<Record<string, SessionSummary>>,
  callTime: number,
  count: number,
): readonly (string | undefined)[] {
  const later = Object.values(summaries)
    .filter(summary => summary.origin === 'subagent' && summary.updatedAt >= callTime)
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .map(summary => summary.id)
  return Array.from({ length: count }, (_, index) => later[index])
}

/** Rebuild the state from the Context's own matches (cold feeds). */
function fallbackState(context: ConversationNodeContext<OrchestrateCallState>): OrchestrateCallState | undefined {
  const start = context.matches.find(entry => entry.event.type === 'tool/call')
  if (start === undefined) return undefined
  let state = startCall(start)
  for (const entry of context.matches) {
    if (entry.event.type === 'tool/result') state = applyResult(state, entry)
  }
  return state
}

/**
 * Build the orchestrate card Definition.
 * @param sessions - sessions service face（历史回放时按 session/list 关联子会话）。
 * @returns orchestrate-card Definition.
 */
export function orchestrateCallDefinition(
  sessions: ISessions,
): ConversationNodeDefinition<OrchestrateCallState> {
  return {
    kind: 'orchestrate-card',
    target: 'chat',
    match: (event: ConversationEvent) => {
      if (event.type === 'tool/call' && event.data.name === ORCHESTRATE_TOOL) {
        return { id: String(event.data.callId), role: 'start' }
      }
      // 结果事件本身不带工具名（data 只有 turn/step/message），靠 callId 归属：
      // Context id 已是 callId，引擎按 id 把 update 路由到同一 Context。
      if (event.type === 'tool/result') {
        return { id: String(event.data.message.source.callId), role: 'update' }
      }
      return null
    },
    start: (_context, match) => startCall(match),
    update: (context, match) => applyResult(context.state, match),
    buildViewNode: (context) => {
      const location = context.start?.location ?? context.matches.at(-1)?.location
      if (location?.kind !== 'turn' && location?.kind !== 'step') return null
      const state = context.state ?? fallbackState(context)
      if (state === undefined) return null
      // 逐任务子会话 id：**三层优先级**（2026-10 加第一层）。
      //   ① 结果里的 `results[].childSessionId`——durable，刷新后唯一还活着的精确来源；
      //   ② 卡内订阅的 spawn 广播（运行期，label 精确）；
      //   ③ 这里的 session/list 时间就近（历史回放兜底，顺序对齐、无 label）。
      // 故只把 ③ 当**缺省填充**：① 有值的下标不被覆盖。
      const summaries = sessions.list.getSnapshot().byId as unknown as Readonly<Record<string, SessionSummary>>
      const correlated = correlateChildren(summaries, state.time, state.tasks.length)
      const durable = state.childSessionIds
      const childSessionIds = durable === undefined
        ? correlated
        : correlated.map((fallback, index) => durable.get(index) ?? fallback)
      const data: OrchestrateChatData = {
        ...childSessionIds.some(id => id !== undefined) ? { childSessionIds } : {},
        ...state.worktreeSlugs === undefined ? {} : { worktreeSlugs: state.worktreeSlugs },
        ...state.worktreeBranches === undefined ? {} : { worktreeBranches: state.worktreeBranches },
        tasks: state.tasks,
        hasMerge: state.hasMerge,
        callId: state.callId,
        anchorSeq: state.anchorSeq,
        time: state.time,
        outcomes: state.outcomes,
        settled: state.settled,
        errored: state.errored,
        ...state.closer === undefined ? {} : { closer: state.closer },
        ...state.integration === undefined ? {} : { integration: state.integration },
      }
      return chatNode(context, 'orchestrate-call', state.anchorSeq, data)
    },
  }
}

/**
 * Register the orchestrate card Definition.
 * @param ctx - owning UI Conversation context.
 */
export function registerOrchestrateConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(orchestrateCallDefinition(ctx.sessions))
}
