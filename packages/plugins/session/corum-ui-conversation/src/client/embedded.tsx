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
import { createElement, type ReactNode } from 'react'

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
      // Mini header: session title (the conversation.session header slot
      // renders breadcrumbs + status pill via its own slot tree, so we
      // only need a lightweight label here).
      createElement(EmbeddedMiniHeader, { sessionId }),
      // Session body: conversation.session slot renders the active view
      // (chat messages + approval stream). Same occupant as the main view.
      createElement('div', { className: 'corum-embedded-body' },
        createElement(SlotView, { slotKey: 'conversation.session' }),
      ),
      // Composer: full interactive bar (readOnly=false) or read-only hint.
      readOnly
        ? createElement('div', { className: 'corum-embedded-readonly-hint' },
            '与左栏同一会话，输入请在左栏',
          )
        : createElement(SlotView, { slotKey: 'conversation.composer.bar' }),
  )
  return createElement(SessionScopeOverride, { sessionId, children: subtree })
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
  return createElement('header', { className: 'corum-embedded-header' },
    createElement('span', { className: 'corum-embedded-title' }, props.sessionId),
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
  }) => ReactNode
  /** Hook: read the main session id from the scope binding. */
  readonly useMainSessionId: () => string | undefined
}
