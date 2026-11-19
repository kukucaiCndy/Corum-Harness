/**
 * EmbeddedConversation: a second-instance conversation view for split panes.
 *
 * Renders the same conversation occupant component stack (conversation.session
 * + conversation.composer.bar slots) wrapped in SessionScopeOverride so the
 * specified sessionId flows into every scoped descendant — exactly how the
 * main conversation view gets its session from the scope binding.
 *
 * ## Export contract (fixed — consumers import by these names)
 *
 * ```tsx
 * export function EmbeddedConversation(props: { sessionId: string; readOnly?: boolean }): ReactNode
 * export function useMainSessionId(): string | undefined
 * ```
 *
 * ## readOnly
 *
 * `readOnly=true` does NOT render the composer input area (avoids draft
 * mirror / Lexical single-slot conflict — see input/facade.ts:668-673,
 * ComposerContentEditable.tsx:24-30). Instead a one-line hint is shown:
 * "与左栏同一会话，输入请在左栏". `readOnly=false` renders the full
 * interactive composer.
 *
 * ## SessionStatusPill
 *
 * The pill is registered as `conversation.session.header.actions` occupant by
 * @corum/corum-ide-ui (not importable — red line 3). It takes sessionId via
 * the slot runtime share, so it already works inside the session-scoped slot
 * tree. The mini header renders the session title only; the pill flows
 * through the existing header.actions slot if the header is rendered.
 *
 * @module corum-ui-conversation/client/embedded
 */
import type { ReactNode } from 'react'
import { SessionScopeOverride, SlotView, useScopeBinding } from '@corum/corum-ui-renderer/client'

/**
 * Read the main (currently active) session id from the scope binding.
 *
 * The session scope binding is published by the official uiSession.publishMain
 * projection and flows into ScopeProvider(scope='session-maybe'). This hook
 * reads the same binding that ConversationRoot receives as its `sessionId`
 * prop — the single-source read of "which session is the main view showing".
 *
 * uSES reference stability: the binding snapshot is only swapped when the
 * source changes (the scope adapter publishes a new StandardSourceBinding on
 * session switch). useScopeBinding reads from React context, which re-renders
 * only when the provider's value changes.
 *
 * @returns the main session id, or undefined when no session is selected.
 */
export function useMainSessionId(): string | undefined {
  const binding = useScopeBinding()
  return binding.key
}

/**
 * Embedded conversation view for a split pane right column.
 *
 * @param props.sessionId - the session to render (pinned via SessionScopeOverride).
 * @param props.readOnly - when true, suppresses the composer and shows a hint.
 * @returns the embedded conversation React tree.
 */
export function EmbeddedConversation(props: {
  sessionId: string
  readOnly?: boolean
}): ReactNode {
  const { sessionId, readOnly = false } = props
  return (
    <SessionScopeOverride sessionId={sessionId}>
      <div className="corum-embedded-conversation" data-embedded-session={sessionId}>
        {/* Mini header: session title (the conversation.session header slot
            renders breadcrumbs + status pill via its own slot tree, so we
            only need a lightweight label here). */}
        <EmbeddedMiniHeader sessionId={sessionId} />
        {/* Session body: conversation.session slot renders the active view
            (chat messages + approval stream). Same occupant as the main view. */}
        <div className="corum-embedded-body">
          <SlotView slotKey="conversation.session" />
        </div>
        {/* Composer: full interactive bar (readOnly=false) or read-only hint. */}
        {readOnly
          ? (
            <div className="corum-embedded-readonly-hint">
              与左栏同一会话，输入请在左栏
            </div>
          )
          : <SlotView slotKey="conversation.composer.bar" />}
      </div>
    </SessionScopeOverride>
  )
}

/**
 * Mini header for the embedded conversation: shows the session id as title.
 *
 * The full session title (displayTitle) is available via useSessions, but
 * extracting it from the scope binding's hooks and calling it conditionally
 * would violate React hooks rules (the hook must be called unconditionally).
 * The session id is the minimal viable title; the main conversation view's
 * header (corum.titlebar.session occupant) shows the full title with
 * breadcrumbs and status pill — that slot can be rendered separately if a
 * richer header is needed.
 */
function EmbeddedMiniHeader(props: { sessionId: string }): ReactNode {
  return (
    <header className="corum-embedded-header">
      <span className="corum-embedded-title">{props.sessionId}</span>
    </header>
  )
}
