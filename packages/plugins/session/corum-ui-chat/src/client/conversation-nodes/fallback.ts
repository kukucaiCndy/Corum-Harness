import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, UnknownSurfaceNode,
} from '@corum/corum-ui-conversation/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Generic presentation of an unclaimed append-surface event. */
    unknown: UnknownSurfaceNode
  }
}

/**
 * True when an append-surface event is an internal protocol fact the Chat
 * transcript must not render as an unknown row.
 *
 * `developer/message` with a `tool-registry` source is the tool-registry
 * diff record (tool additions/removals the model consumes; dsh-session README
 * §surface). It is durable data, not conversation content: rendering it leaks
 * raw protocol JSON into the transcript.
 * @param event - candidate append-surface event.
 */
function isInternalProtocolEvent(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'developer/message') return false
  // MessageSourceMap is merge-extensible; `tool-registry` lives outside the
  // closed union the compiler sees here, so compare by raw kind string.
  const kind = (event.data.message.source as { kind?: string }).kind
  return kind === 'tool-registry'
}

/** Unclaimed append-surface fallback Definition. */
export const unknownFallbackDefinition: ConversationNodeDefinition<UnknownSurfaceNode> = {
  kind: 'unknown-surface',
  target: 'chat',
  match: event => event.type !== 'assistant/live-chunk'
    && isAppendSurfaceEvent(event)
    && !isInternalProtocolEvent(event)
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => ({
    kind: 'unknown',
    seq: match.event.seq,
    time: match.event.time,
    type: match.event.type,
    data: match.event.data,
  }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : chatNode(context, 'unknown', context.state.seq, context.state),
}

/**
 * Register the unmatched append-surface fallback contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerUnknownConversationFallback(ctx: Context): void {
  ctx.uiConversation.events.registerFallback(unknownFallbackDefinition)
}
