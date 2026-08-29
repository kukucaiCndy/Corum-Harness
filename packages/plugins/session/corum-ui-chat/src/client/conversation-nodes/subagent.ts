import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@corum/corum-ui-conversation/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { isSubagentDelegationTool } from '../contract/turn-process.ts'
import {
  encodeSubagentTurn, subagentDelegationFields,
  type SubagentInvocation, type SubagentTurnSignature,
} from '../contract/subagent.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Delegated subagent invocations of one Turn, rendered as progress cards. */
    'subagent-call': import('../contract/subagent.ts').SubagentChatData
  }
}

declare module '@corum/corum-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Encoded subagent invocation list for this Turn. */
    'subagent-progress': SubagentTurnSignature
  }
}

interface SubagentTurnState {
  readonly turn: number
  readonly invocations: readonly SubagentInvocation[]
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

function eventTurn(event: ConversationEvent): number | undefined {
  const data = event.data as unknown as { turn?: unknown }
  return typeof data.turn === 'number' ? data.turn : undefined
}

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

function refreshCorrelation(
  invocations: readonly SubagentInvocation[],
  summaries: Readonly<Record<string, SessionSummary>>,
): readonly SubagentInvocation[] {
  const children = Object.values(summaries).filter(summary => summary.origin === 'subagent')
  return invocations.map((invocation) => {
    if (invocation.childSessionId !== undefined) return invocation
    const childSessionId = correlateChild(children, invocation.time)
    return childSessionId === undefined ? invocation : { ...invocation, childSessionId }
  })
}

function withInvocation(
  state: SubagentTurnState,
  invocation: SubagentInvocation,
): SubagentTurnState {
  const index = state.invocations.findIndex(candidate => candidate.callId === invocation.callId)
  return index < 0
    ? { ...state, invocations: [...state.invocations, invocation] }
    : { ...state, invocations: state.invocations.map((candidate, at) => at === index ? invocation : candidate) }
}

function startInvocation(match: ConversationMatch): SubagentInvocation {
  if (match.event.type !== 'tool/call') throw new Error('subagent start requires tool/call')
  const fields = subagentDelegationFields(match.event.data.arguments)
  return {
    callId: String(match.event.data.callId),
    turn: match.event.data.turn,
    anchorSeq: match.event.seq,
    time: match.event.time,
    ...fields.description === undefined ? {} : { description: fields.description },
    ...fields.prompt === undefined ? {} : { prompt: fields.prompt },
  }
}

function fallbackState(context: ConversationNodeContext<SubagentTurnState>): SubagentTurnState | undefined {
  const turn = context.matches.map(match => eventTurn(match.event)).find(candidate => candidate !== undefined)
  if (turn === undefined) return undefined
  let state: SubagentTurnState = { turn, invocations: [] }
  for (const match of context.matches) {
    if (match.event.type === 'tool/call' && isSubagentDelegationTool(match.event.data.name)) {
      state = withInvocation(state, startInvocation(match))
    }
  }
  return state
}

/** Latest invocation list of one turn, correlated against the live session list. */
function currentInvocations(
  context: ConversationNodeContext<SubagentTurnState>,
  summaries: Readonly<Record<string, SessionSummary>>,
): readonly SubagentInvocation[] {
  const state = context.state ?? fallbackState(context)
  if (state === undefined) return []
  return refreshCorrelation(state.invocations, summaries)
}

/** Decode rows of one encoded turn, re-attaching its turn coordinate. */
function decodeSubagentTurnRows(
  signature: SubagentTurnSignature,
  turn: number,
): readonly SubagentInvocation[] {
  if (signature === '') return []
  return signature.split('|').map((entry) => {
    const [callId, anchorSeq, time, description, prompt, childSessionId] = entry.split('~')
    return {
      callId,
      turn,
      anchorSeq: Number(anchorSeq),
      time: Number(time),
      ...description === '' ? {} : { description },
      ...prompt === '' ? {} : { prompt },
      ...childSessionId === '' ? {} : { childSessionId },
    }
  })
}

/**
 * Build the Turn-scoped subagent Definition bound to the sessions service for
 * summary-based child correlation at Location-data evaluation time.
 * @param sessions - sessions service face exposing the live summary list.
 * @returns subagent progress-card Definition.
 */
export function subagentTurnDefinition(
  sessions: ISessions,
): ConversationNodeDefinition<SubagentTurnState> {
  return {
    kind: 'subagent-progress',
    target: 'chat',
    match: (event) => {
      const turn = eventTurn(event)
      if (turn === undefined) return null
      if (event.type === 'tool/call' && isSubagentDelegationTool(event.data.name)) {
        return { id: String(turn), role: 'start' }
      }
      return { id: String(turn), role: 'update' }
    },
    start: (_context, match) => ({
      turn: eventTurn(match.event) ?? 0,
      invocations: [startInvocation(match)],
    }),
    update: (context, match) => {
      if (match.event.type === 'tool/call' && isSubagentDelegationTool(match.event.data.name)) {
        return withInvocation(context.state, startInvocation(match))
      }
      return context.state
    },
    buildLocationData: (context, scope) => {
      if (scope !== 'turn') return null
      const location = context.start?.location ?? context.matches.at(-1)?.location
      if (location?.kind !== 'turn' && location?.kind !== 'step') return null
      const invocations = currentInvocations(context, sessions.list.getSnapshot().byId)
      if (invocations.length === 0) return null
      return {
        kind: 'turn',
        turn: location.turn.turn,
        key: 'subagent-progress',
        value: encodeSubagentTurn(invocations),
      }
    },
    buildViewNode: (context) => {
      const location = context.start?.location ?? context.matches.at(-1)?.location
      if (location?.kind !== 'turn' && location?.kind !== 'step') return null
      const signature = location.turn.data.get('subagent-progress')
      if (signature === undefined) return null
      const invocations = decodeSubagentTurnRows(signature, location.turn.turn)
      if (invocations.length === 0) return null
      const anchor = Math.min(...invocations.map(invocation => invocation.anchorSeq))
      return chatNode(context, 'subagent-call', anchor, { invocations })
    },
  }
}
