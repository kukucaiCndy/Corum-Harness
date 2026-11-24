/**
 * EmbeddedConversation: a second-instance conversation view for split panes.
 *
 * ## 外壳对齐（2026-11-19「外壳对齐轮」——本文件的核心契约）
 *
 * 嵌入视图**必须渲染完整的 `conversation` 槽 occupant**（= ConversationRoot），
 * **不得**自己去拼 `conversation.session` + `conversation.composer.bar` 这两个裸
 * 子槽。原因（上一轮的实机报障，全部同源）：
 *
 * 1. **内容列左右边距 / 宽度轴**由 ConversationRoot 的 `.root` 建立——
 *    `--dsh-chat-content-width`、`--dsh-composer-card-max-width`、
 *    `--dsh-composer-side-clearance`（ConversationRoot.module.css:33-40）都声明在
 *    `.root` 上，并靠 ResizeObserver 把列宽发布成 `--dsh-conversation-column-width`。
 *    绕过 Root ⇒ 这些变量一个都不存在 ⇒ ChatView 的 `.scroll`
 *    （`padding: … calc(var(--dsh-composer-side-clearance) + 16px)`）与 `.column`
 *    （`max-width: var(--dsh-chat-content-width)`）双双失效 ⇒ **左右边距消失**、
 *    正文贴边拉满。
 * 2. **TurnNavigator 左侧圆点**（corum-ui-chat 的 `TurnNavigator.module.css`
 *    `.frame{ left: calc(12px - (var(--dsh-composer-side-clearance) + 16px)) }`）
 *    贴的就是这条 gutter：变量缺失 + gutter 不存在 + 包裹层 `overflow:hidden`
 *    ⇒ 圆点被裁到不可见。
 * 3. Root 还承载 `conversation.input.dock`（沉淀卡片：todo / goal / queue）与
 *    composer 链的选举，以及滚动体上的两个测量变量（`--dsh-composer-height`、
 *    `--dsh-conversation-viewport-height`）——TurnNavigator 的 rail band 直接读它们。
 *
 * 换句话说：**Root 不是「一层包装」，而是会话外壳的唯一 owner**。嵌入视图要复
 * 刻的是整张外壳，故这里只做「钉住会话 scope + 提供确定高度父链」两件事，其余交给
 * `SlotView('conversation')`。（这条契约已补记进 HANDOFF §10。）
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
 * `readOnly` 是**传给 Root 的 owner prop**（Root 不渲染输入区，改一行提示），
 * 本文件不再自己拼「无输入区的迷你壳」。这样同一份 Root 代码路径承担所有外壳
 * 几何，两栏的边距/宽度轴/composer 定位完全同构。
 *
 * - 同会话双开 → `readOnly=true` + 默认文案（Root 的默认：「与左栏同一会话，输入请在左栏」）。
 * - mode='view'（另一个会话，通常是子 Agent）→ `readOnly=true` + 自己的文案
 *   「子 Agent 会话 · 只读查看」（经 `hintText` 传入，默认文案在此语义下是错的）。
 * - 异会话常规分栏（mode='session'/'chat'）→ `readOnly=false/不传`，两栏都可交互。
 *
 * ## Layout contract (见 embedded.css)
 *
 * Root 要求父链高度确定（`.root{height:100%}` + `.scrollBody{flex:1;min-height:0}`
 * + sticky composer）。本文件的包裹层提供它：列 flex + `height:100%`，身份行
 * `flex:none`，body `flex:1;min-height:0`。
 *
 * ## 身份行（mini header）
 *
 * ⚠️ **本 fork 的 Root 已不渲染会话顶栏**：`conversation.session.header` 于
 * P2（2026-09-30）随宿主搬进统一标题栏（见 apply.ts:363-367 与
 * ConversationRoot.tsx:673-683 的说明），Root 内部只剩 session body + composer。
 * 所以嵌入视图**必须自带给这条会话一个身份行**——否则分栏左栏连标题都没有
 * （分栏 frameHeader 只标右栏）。标题取 `displayTitle`，读不到回落 sessionId 短码。
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
 * The `sessions` service, narrowed to the single read the identity line needs
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
 * Resolve the identity-line title: the session's `displayTitle` from the
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
 * Renders the **full `conversation` slot occupant** (ConversationRoot) with the
 * target session pinned by {@link ScopedSlotComponents.SessionScopeOverride};
 * readOnly/hintText ride through as owner props to Root (they are not
 * session-scope data, so they must not go through the binding).
 *
 * @param props.sessionId - the session to render (pinned via SessionScopeOverride).
 * @param props.readOnly - passed to Root: suppresses the composer input area and
 *   shows a one-line hint instead.
 * @param props.hintText - optional override for Root's read-only hint line. The
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
  // Owner props for the Root occupant: readOnly/hintText are the only two the
  // shell-level Root accepts beyond its kit (see ConversationRootProps).
  const ownerProps: { readOnly: boolean; hintText?: string } = { readOnly }
  if (hintText !== undefined) ownerProps.hintText = hintText
  const subtree = createElement('div', {
      className: 'corum-embedded-conversation',
      'data-embedded-session': sessionId,
    },
      // 身份行：本 fork 的 Root 不再渲染会话顶栏（P2 搬进统一标题栏），嵌入
      // 视图必须自己给这条会话一个标题，否则左栏无任何标识（见文件头）。
      createElement(EmbeddedMiniHeader, { sessionId }),
      // 整张会话外壳（Root：宽度轴 + 边距 gutter + 滚动体 + composer 链 +
      // 沉淀 dock + 两个测量变量）。**不要再退回裸 `conversation.session`。**
      createElement('div', { className: 'corum-embedded-body' },
        createElement(SlotView, { slotKey: 'conversation', ownerProps }),
      ),
  )
  return createElement(SessionScopeOverride, { sessionId, children: subtree })
}

/**
 * Identity line for the embedded conversation: shows the session's displayTitle.
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
