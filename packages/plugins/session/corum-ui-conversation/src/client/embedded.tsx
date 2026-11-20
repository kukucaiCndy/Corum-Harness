/**
 * EmbeddedConversation: a second-instance conversation view for split panes.
 *
 * Renders the same conversation occupant component stack (conversation.session
 * + conversation.composer.bar slots) wrapped in SessionScopeOverride so the
 * specified sessionId flows into every scoped descendant — exactly how the
 * main conversation view gets its session from the scope binding.
 *
 * ## Cross-bundle discipline (red line 1)
 *
 * The renderer's SessionScopeOverride / SlotView / useScopeBinding carry the
 * renderer bundle's React context closures. Importing them at runtime from
 * `@corum/corum-ui-renderer/client` would inline a second copy of the renderer
 * source into this bundle → duplicate factory registration. Instead, apply()
 * reads them from the `uiRenderer` cordis service and injects them here via
 * {@link scopedSlotComponents} (set at activation time, read at render time —
 * render always happens after apply).
 *
 * ## Export contract (fixed — consumers import by these names)
 *
 * ```tsx
 * export function EmbeddedConversation(props: { sessionId: string; readOnly?: boolean }): ReactNode
 * export function useMainSessionId(): string | undefined
 * ```
 *
 * These are exposed to other bundles via the `conversationEmbed` cordis service
 * (provided in apply.ts), not via runtime `@corum/corum-ui-conversation/client`
 * import — same red-line-1 discipline this file follows toward the renderer.
 *
 * ## readOnly
 *
 * `readOnly=true` does NOT render the composer input area (avoids draft
 * mirror / Lexical single-slot conflict — see input/facade.ts:668-673,
 * ComposerContentEditable.tsx:24-30). Instead a one-line hint is shown:
 * "与左栏同一会话，输入请在左栏" (overridable via `hintText` — mode='view'
 * renders a DIFFERENT session, so the same-session wording would be wrong).
 * `readOnly=false` renders the full interactive composer.
 *
 * ## Layout contract (2026-11-23 fix round — see embedded.css)
 *
 * ConversationRoot requires a determinate-height parent chain
 * (`.root{height:100%}` + `.scrollBody{flex:1;min-height:0}` + sticky
 * composer). This wrapper supplies it: column flex + height:100%, header
 * `flex:none`, body `flex:1;min-height:0`, composer slot `flex:none`.
 * Without it the transcript cannot scroll in-pane and the composer sinks
 * below the viewport (the reported split-pane symptoms).
 *
 * ## Mini header title
 *
 * The title is the session's `displayTitle` read from the `sessions` service
 * snapshot (injected by apply.ts as {@link embeddedSessions}), falling back to
 * the short session id when the row is not loaded. Same read as
 * corum-ui-split-pane's readDisplayTitle.
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
import { createElement, useEffect, useState, type ReactNode } from 'react'

/**
 * Narrowed capability interface for the renderer's scoped-slot components
 * (red line 3: don't couple to the implementation package's type face).
 *
 * These are the same three symbols the renderer exposes on its `uiRenderer`
 * service; we declare only what we use.
 */
interface ScopedSlotComponents {
  readonly SessionScopeOverride: (props: { sessionId: string; children: ReactNode }) => ReactNode
  readonly SlotView: (props: {
    slotKey: string
    ownerProps?: object
    opts?: object | undefined
  }) => ReactNode
  readonly useScopeBinding: () => { key: string | undefined }
}

/**
 * Module-level ref holding the renderer's scoped-slot component references.
 *
 * Set by apply() at activation time (after `inject('uiRenderer')` resolves the
 * cordis service). Read by {@link useMainSessionId} and {@link EmbeddedConversation}
 * at render time — React rendering always happens after the plugin's apply() has
 * run, so `current` is non-null when these are called.
 *
 * Same-bundle module singleton is legal (red line 1 applies to cross-bundle
 * state; this ref is only read within this bundle's React tree).
 */
export const scopedSlotComponents: { current: ScopedSlotComponents | null } = { current: null }

/**
 * The `sessions` service, narrowed to the single read the mini header needs
 * (red line 3: declare only what we use, never import the implementation
 * package's type face).
 *
 * Set by apply() at activation time from `ctx.sessions` (declared in the
 * plugin's `inject` list — red line 4). Read at render time by
 * {@link readEmbeddedTitle}.
 */
interface EmbeddedSessionsCapability {
  readonly list: {
    getSnapshot(): { byId: Readonly<Record<string, { displayTitle?: string } | undefined>> }
    subscribe(cb: () => void): () => void
  }
}

/**
 * Module-level ref holding the `sessions` capability face (see
 * {@link EmbeddedSessionsCapability}). Same-bundle module singleton is legal
 * (red line 1 applies to cross-bundle state).
 */
export const embeddedSessions: { current: EmbeddedSessionsCapability | null } = { current: null }

/**
 * Resolve the mini-header title: the session's `displayTitle` from the
 * sessions snapshot, falling back to the short session id.
 *
 * Mirrors corum-ui-split-pane's readDisplayTitle (same read path: the
 * `sessions` service's `list.getSnapshot().byId[id]?.displayTitle`), so both
 * panes label a session identically. A bare session id in the header was the
 * reported symptom — long UUIDs are unreadable and identical-looking.
 *
 * @param sessionId - the embedded session.
 * @returns the display title, or the first 8 chars of the id when unavailable.
 */
function readEmbeddedTitle(sessionId: string): string {
  const sessions = embeddedSessions.current
  if (sessions !== null) {
    const title = sessions.list.getSnapshot().byId[sessionId]?.displayTitle
    if (title !== undefined && title !== '') return title
  }
  // Fallback: short id (a UUID prefix is enough to tell panes apart).
  return sessionId.slice(0, 8)
}

/**
 * Read the main (currently active) session id from the scope binding.
 *
 * The session scope binding is published by the official uiSession.publishMain
 * projection and flows into ScopeProvider(scope='session-maybe'). This hook
 * reads the same binding that ConversationRoot receives as its `sessionId`
 * prop — the single-source read of "which session is the main view showing".
 *
 * Uses the renderer's `useScopeBinding` (obtained via the `uiRenderer` cordis
 * service at activation time) so the React context closure is the renderer
 * bundle's — not a second inlined copy.
 *
 * @returns the main session id, or undefined when no session is selected.
 */
export function useMainSessionId(): string | undefined {
  const components = scopedSlotComponents.current
  // The hook contract: useScopeBinding must be called unconditionally (it calls
  // useContext internally). If the renderer service hasn't been wired yet (should
  // not happen at render time — apply runs before any render), we can't call the
  // hook at all, so return undefined without touching React context. This is safe
  // because `components` is set once at activation and never goes back to null —
  // the hook order is stable across all renders after activation.
  if (components === null) return undefined
  const binding = components.useScopeBinding()
  return binding.key
}

/**
 * Embedded conversation view for a split pane column.
 *
 * @param props.sessionId - the session to render (pinned via SessionScopeOverride).
 * @param props.readOnly - when true, suppresses the composer and shows a hint.
 * @param props.hintText - optional override for the read-only hint line. The
 *   default wording ("与左栏同一会话，输入请在左栏") only fits the
 *   same-session double-open case; mode='view' embeds a DIFFERENT session, so
 *   the consumer passes its own wording there.
 * @returns the embedded conversation React tree.
 */
export function EmbeddedConversation(props: {
  sessionId: string
  readOnly?: boolean
  hintText?: string
}): ReactNode {
  const { sessionId, readOnly = false, hintText } = props
  const components = scopedSlotComponents.current
  // Fail-soft: if the renderer service hasn't been wired yet (should not happen
  // at render time, but defensive), render a minimal placeholder instead of
  // crashing — the split pane still shows its frame.
  if (components === null) {
    return createElement('div', { className: 'corum-embedded-conversation' },
      createElement('p', null, '渲染器尚未就绪'),
    )
  }
  const { SessionScopeOverride, SlotView } = components
  // Build the subtree first, then pass it as `children` in the props object —
  // createElement's type-check requires `children` in props when the component
  // type declares it (passing children as createElement varargs doesn't satisfy
  // the props type for function components with a `children` field).
  const subtree = createElement('div', {
      className: 'corum-embedded-conversation',
      'data-embedded-session': sessionId,
    },
      // Mini header: displayTitle of the embedded session (readable, unlike a
      // bare session id — the reported symptom).
      createElement(EmbeddedMiniHeader, { sessionId }),
      // Session body: conversation.session slot renders the active view
      // (chat messages + approval stream). Same occupant as the main view.
      // `flex:1;min-height:0` + column flex (embedded.css) is what keeps the
      // in-pane scroller working: this path resolves to ChatView's `.scroll`,
      // not to ConversationRoot's `.scrollBody[data-conversation-scroll]`.
      // Both need a determinate parent chain — see the CSS file header.
      createElement('div', { className: 'corum-embedded-body' },
        createElement(SlotView, { slotKey: 'conversation.session' }),
      ),
      // Composer: full interactive bar (readOnly=false) or read-only hint.
      // Both are `flex:none` — the composer must never be squeezed out by the
      // transcript (see embedded.css).
      readOnly
        ? createElement('div', { className: 'corum-embedded-readonly-hint' },
            hintText ?? '与左栏同一会话，输入请在左栏',
          )
        : createElement('div', { className: 'corum-embedded-composer' },
            createElement(SlotView, { slotKey: 'conversation.composer.bar' }),
          ),
  )
  return createElement(SessionScopeOverride, { sessionId, children: subtree })
}

/**
 * Mini header for the embedded conversation: shows the session's displayTitle.
 *
 * Reads the title from the `sessions` service snapshot (injected by apply.ts
 * into {@link embeddedSessions}) and re-reads on list invalidation, so a title
 * that arrives after first paint (host list RPC still in flight) replaces the
 * short-id fallback without a remount. Hooks are called unconditionally at the
 * top of this component, so the rules of hooks hold.
 *
 * @param props.sessionId - the embedded session.
 * @returns the header element.
 */
function EmbeddedMiniHeader(props: { sessionId: string }): ReactNode {
  const { sessionId } = props
  const [title, setTitle] = useState(() => readEmbeddedTitle(sessionId))
  useEffect(() => {
    // Re-read on every list invalidation (displayTitle is host-projected and
    // may land after the first render). The snapshot read is cheap and the
    // selector-free shape keeps this hook independent of the store package.
    setTitle(readEmbeddedTitle(sessionId))
    const sessions = embeddedSessions.current
    if (sessions === null) return undefined
    const off = sessions.list.subscribe(() => { setTitle(readEmbeddedTitle(sessionId)) })
    return off
  }, [sessionId])
  return createElement('header', { className: 'corum-embedded-header' },
    createElement('span', { className: 'corum-embedded-title', title }, title),
  )
}

/**
 * `conversationEmbed` cordis service: exposes EmbeddedConversation +
 * useMainSessionId to other bundles (e.g. corum-ui-split-pane) without a
 * runtime `@corum/corum-ui-conversation/client` import (red line 1).
 *
 * The service is provided in apply() with the same component references this
 * module defines. Consumers inject 'conversationEmbed' and render the
 * components via `createElement` inside the renderer's React tree.
 *
 * These component references carry this bundle's closures (the module-level
 * `scopedSlotComponents` ref → the renderer's scoped-slot components). Since
 * the service is a cordis singleton (root context reflect.store), the
 * consumer bundle gets the same single instance — no second inlined copy.
 */
export interface ConversationEmbedService {
  /** Embedded conversation view for a split pane. */
  readonly EmbeddedConversation: (props: {
    sessionId: string
    readOnly?: boolean
    hintText?: string
  }) => ReactNode
  /** Hook: read the main session id from the scope binding. */
  readonly useMainSessionId: () => string | undefined
}
