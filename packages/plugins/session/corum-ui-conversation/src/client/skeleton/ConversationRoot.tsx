// Resident conversation skeleton. Hero chrome, composer positioning, the
// chain, AND the composer bar (session-maybe slot) stay mounted across
// no-session/session transitions — the bar renders inert via owner props.

import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationSlotProps, InputZone } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { HeroGlow, HeroShell, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
import { EmptyStateHero } from './EmptyStateHero.tsx'
import { DARK_ATTRIBUTE } from '@corum/corum-ui-base/client'
import css from './ConversationRoot.module.css'

/** Full props composed from the slot contract. */
export type ConversationRootProps = ConversationSlotProps

/** localStorage key for the dragged transcript width preference (px). */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** Floor for a dragged content width; matches the layout center-column minimum. */
const CONTENT_MIN = 640
/** Column budget the content must leave free: 88px per side keeps the width
 * handles fully placeable (24px inset + 40px strip + 24px safe zone) — a
 * larger dragged width would push its own handles off the column and leave no
 * way to drag back. */
const CONTENT_EDGE_BUDGET = 176

/** Reads the persisted width preference; durable-storage boundary, so a
 * missing or corrupt value resolves to "no preference".
 * @returns the stored width in px, or null when unset or invalid. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolves the content width the CSS axis would show for a column width.
 * @param columnWidth - the conversation column's rendered width in px.
 * @param preference - the dragged preference, or null for the adaptive clamp.
 * @returns the resolved content width in px (mirrors the CSS clamp). */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/** One transcript width handle: pointer capture + rAF-throttled symmetric
 * resize (both sides write the one centered width, so outward travel widens
 * by 2× the pointer distance). pointermove publishes the pointer's Y as a CSS
 * variable so the glow indicator rides it. Mirrors ui-layout AppFrame's
 * DragHandle capture model. */
function WidthHandle(props: {
  side: 'left' | 'right'
  onStart: () => number
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const outwardWidth = () => {
    const dx = latest.current - origin.current
    const outward = callbacks.current.side === 'right' ? dx : -dx
    return base.current + outward * 2
  }
  const cancelFrame = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
  }
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    base.current = callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--dsh-width-handle-pointer-y', `${e.clientY - box.top}px`)
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(outwardWidth())
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    cancelFrame()
    latest.current = e.clientX
    // Only a gesture with actual travel commits: a press-and-release on a
    // window-clamped width must not overwrite the wider stored preference
    // with the clamped display value.
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  // Releasing the button outside the window delivers pointercancel (or drops
  // the capture silently) instead of pointerup; without this the glow's
  // data-dragging state sticks on. The gesture is abandoned uncommitted —
  // onEnd republishes the stored preference. releasePointerCapture inside
  // onPointerUp also fires lostpointercapture, so this runs (idempotently)
  // after every normal drag end too; keep both paths.
  const onPointerCancel = useCallback(() => {
    cancelFrame()
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.widthHandle}
      data-side={props.side}
      data-width-handle={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

export function ConversationRoot({
  sessionId, useSession, useSessions, useSessionPendingInteraction,
  useWorkspaces, useConversation, useInput, useComposerBlock,
  renderSlot, renderSlotChain, selectWorkspace, emptyActions, t,
}: ConversationRootProps) {
  // 当前主题（深/浅）：空态大 logo 选图（big_brand_dark/light）。DARK_ATTRIBUTE
  // 是 corum-ui-base theme-presenter 写到 body 的标记。
  const dark = typeof document !== 'undefined' && document.body.hasAttribute(DARK_ATTRIBUTE)
  const session = useSession(s => s)
  const pendingInteraction = useSessionPendingInteraction(snapshot =>
    sessionId === undefined ? undefined : snapshot.get(sessionId))
  const conversation = useConversation(s => s)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  const openState = session?.openState
  const inputState = useInput(s => s)
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  // 最近任务泳道（2026-08-30 空态圆桌：最近项目+任务混排列表）：sessions.list
  // 的 corum-task-*（非 subagent），按 updatedAt 倒序取前 6。
  const recentTasks = useSessions((s) => {
    const out: { id: string; title: string; updatedAt: number }[] = []
    for (const [id, sess] of Object.entries(s.byId)) {
      if (!id.startsWith('corum-task-')) continue
      if (sess.origin === 'subagent') continue
      // blank（未发过消息）的泳道显示「新会话」——官方 displayTitle 此刻回落到
      // 工作区目录名（displayTitleOf 的 workspaceTitleOf(cwd) 兜底），不是空串，
      // 所以必须按 blank 判断，不能靠 displayTitle 是否为空。
      out.push({
        id,
        title: sess.blank === true ? '新会话' : (sess.displayTitle || '未命名会话'),
        updatedAt: typeof sess.updatedAt === 'number' ? sess.updatedAt : 0,
      })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return Object.freeze(out.slice(0, 6))
  })
  // fork（corum）：useWorkspaces 由官方 ui-workspace 提供，kkc IDE 已禁（undefined）。
  // 降级为空 stub（hero 工作区导航在 kkc 由侧栏自研，不经此），避免「not a function」。
  type WorkspaceSnapshotLike = { items: readonly { workspaceId: WorkspaceId; title: string; sessionIds: readonly SessionId[] }[]; phase: string }
  const workspaces: WorkspaceSnapshotLike = typeof useWorkspaces === 'function'
    ? (useWorkspaces as <T>(sel: (s: WorkspaceSnapshotLike) => T) => T)(s => s)
    : { items: [], phase: 'ready' }
  // A plugin this package cannot import (ui-model-selection) says this session cannot
  // send; its reason is already localized by whoever raised it.
  const composerBlock = useComposerBlock(block => block)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | undefined>()
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  // Publishes the two live measurements floating View chrome reads off the
  // scroll body: the seat's height as --dsh-composer-height, so controls clear
  // the composer as it grows, and the scrollport's own height as
  // --dsh-conversation-viewport-height, so a control can sit in the band the
  // seat leaves visible. Callback ref, not an effect; stable identity prevents
  // observer churn while the first blank session fills the resident body
  // outlet.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
      scroller.style.setProperty(
        '--dsh-conversation-viewport-height',
        `${scroller.clientHeight}px`,
      )
    })
    seatObserver.current.observe(seat)
    seatObserver.current.observe(scroller)
  }, [])

  // Publishes the column's live width as --dsh-conversation-column-width so
  // the shared width axis can adapt (see the .root CSS), and re-clamps a
  // dragged preference against the shrunken column WITHOUT rewriting the
  // stored preference — widening the window restores it (the AppFrame
  // sidebar-drag rule). Same callback-ref pattern as the seat observer.
  const rootEl = useRef<HTMLDivElement | null>(null)
  const rootObserver = useRef<ResizeObserver | null>(null)
  const publishWidths = useCallback((root: HTMLDivElement): void => {
    const column = root.offsetWidth
    root.style.setProperty('--dsh-conversation-column-width', `${column}px`)
    const preference = readWidthPreference()
    if (preference === null) {
      root.style.removeProperty('--dsh-chat-user-width')
    } else {
      root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
    }
  }, [])
  const rootResizeRef = useCallback((root: HTMLDivElement | null): void => {
    rootObserver.current?.disconnect()
    rootObserver.current = null
    rootEl.current = root
    if (root === null) return
    rootObserver.current = new ResizeObserver(() => { publishWidths(root) })
    rootObserver.current.observe(root)
    publishWidths(root)
  }, [publishWidths])

  // Drag plumbing for the two width handles: onStart snapshots the resolved
  // width (grabbing a clamped column must not jump back to the raw stored
  // preference), onDrag publishes only the live clamped style, onCommit
  // persists the width of a gesture that actually travelled, and onEnd
  // republishes from storage — an uncommitted press leaves the stored
  // preference untouched.
  const onHandleStart = useCallback((): number => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return 680
    return resolveContentWidth(root.offsetWidth, readWidthPreference())
  }, [])
  const onHandleDrag = useCallback((width: number): void => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return
    const clamped = resolveContentWidth(root.offsetWidth, width)
    root.style.setProperty('--dsh-chat-user-width', `${clamped}px`)
  }, [])
  const onHandleCommit = useCallback((width: number): void => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return
    localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(root.offsetWidth, width)}`)
  }, [])
  const onHandleEnd = useCallback((): void => {
    const root = rootEl.current
    if (root !== null) publishWidths(root)
  }, [publishWidths])

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )

  // Clear the pending pick once the session lands in it, or when the picked
  // workspace disappears from a ready list (deleted from the sidebar).
  useEffect(() => {
    if (pendingWorkspaceId === undefined) return
    if (sessionWorkspace?.workspaceId === pendingWorkspaceId
      || (workspaces.phase === 'ready' && pendingWorkspace === undefined)) {
      setPendingWorkspaceId(undefined)
    }
  }, [pendingWorkspaceId, sessionWorkspace?.workspaceId, workspaces.phase, pendingWorkspace])

  // While a session is still replaying (loading + blank) the hero/docked
  // choice is unknowable — render the composer hidden instead of flashing
  // the centered hero and snapping to the docked bar (or vice versa).
  // Exemption: a session the list summary already proves blank can only
  // land on the hero, so hiding would blank the column for the whole
  // history round-trip (the startup auto-selection flash) for nothing.
  // The exemption is deliberately open-state-wide, not loading-only: a
  // summary-blank session is the hero before its open starts (`cold`) and
  // after one fails (`error`) for the same reason — there is no history.
  // A restored continuable subagent also stays settled until its eagerly
  // loaded parent catalog establishes availability. This keeps the composer
  // hidden instead of briefly rendering the parent-offline takeover.
  const parentAvailabilityPending = session?.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = sessionId !== undefined && (
    (shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  )
  /**
   *「已选中一个会话」（哪怕它还是 blank——没发过消息）。
   *
   * 官方 hero 条件 = `sessionId === undefined || (blank 且已 open)`——把 **blank
   * 会话也算 hero**：因为 blank 没有历史可渲染，官方此时渲染 HeroShell（工作区
   * chip + **composer 输入框**），让用户直接发第一条消息。而 corus 空态
   * EmptyStateHero 只有「大 logo + 新建卡」、**没有输入框**，若沿用 hero 判断，
   * 用户建完任务后会卡在空页、无处发第一条指令（2026-08-30 用户实测反馈）。
   *
   * 故本 fork 按「有没有选中会话」分流：
   * - `sessionId === undefined`（真的没会话）→ 空态页，无输入框；
   * - `sessionId !== undefined`（已选中，含 blank）→ 渲染 composer 输入框 +
   *   工作区/Agent chip，用户可直接发第一条消息（发完 blank 翻转、会话留存）。
   */
  const hasSession = sessionId !== undefined
  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  // The chip is a selector; label resolution walks the flow top-down:
  //   1. a just-picked workspace (pending) → its title;
  //   2. cold start, no session yet → placeholder ("Choose workspace");
  //   3. the blank session's workspace is in the list → its title;
  //   4. list still loading → cwd folder name bridges so the title does not
  //      flash on refresh (empty cwd → placeholder);
  //   5. list ready but no owning workspace (deleted from the sidebar) →
  //      placeholder, never the deleted folder's name via cwd.
  const chipTitle = pendingWorkspace?.title
    ?? (sessionId === undefined
      ? undefined
      : sessionWorkspace?.title
        ?? (workspaces.phase === 'ready' || cwd === undefined || cwd === ''
          ? undefined
          : workspaceLabel(cwd)))

  const heroWorkspaceRow = (
    <div className={css.heroWorkspaceRow}>
      <WorkspaceChip
        buttonRef={pickerAnchor}
        label={chipTitle}
        menuOpen={pickerOpen}
        onClick={() => { setPickerOpen(open => !open) }}
        t={t}
      />
      {renderSlot('conversation.hero.workspace', {
        open: pickerOpen,
        anchorRef: pickerAnchor,
        selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,
        onPick: (workspaceId) => {
          setPickerOpen(false)
          setPendingWorkspaceId(workspaceId)
          void selectWorkspace(workspaceId).catch(() => {
            setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
          })
        },
        onClose: () => { setPickerOpen(false) },
      })}
      {renderSlot('conversation.hero.agentPreset', {})}
    </div>
  )

  // The placeholder chip ("Choose workspace") and the Workspace-trigger input travel
  // together: no workspace picked yet (cold start, no session at all), or a
  // blank session whose workspace vanished (deleted from the sidebar). The
  // bar is ONE session-maybe slot rendered unconditionally — inert is a prop,
  // not a different tree, so the textarea DOM survives the transition.
  // 只有「真没选中会话」才 inert。原判定 `(hero && chipTitle === undefined)` 会在
  // 工作区列表未加载完时把**已选中会话**的输入框也禁掉——用户刚建完任务就被卡住。
  const inert = !hasSession
  // A raised block is the same inert posture with the blocker's own reason:
  // one disabled textarea, never a second tree. The no-workspace state wins
  // when both hold — picking a workspace is the earlier prerequisite.
  const blocked = !inert && composerBlock !== undefined
  const inputBar = renderSlot('conversation.composer.bar', {
    variant: hasSession ? 'composer' : 'hero',
    ...(inert
      ? {
        disabled: true,
        placeholder: t('placeholder.workspace'),
        workspacePickerOpen: pickerOpen,
        onRequestWorkspace: () => { setPickerOpen(true) },
      }
      : blocked
        // `blocked`, not `disabled`: the bar refuses input either way, but a
        // block keeps the model seat live because choosing a model is how the
        // user clears it.
        ? { blocked: composerBlock, placeholder: composerBlock.reason }
        : hasSession ? {} : { placeholder: t('placeholder.hero') }),
    overlay: sessionId === undefined ? undefined : renderSlot('conversation.input.overlay', {}),
    leftItems: zone === undefined ? null : renderSlot('conversation.input.left', zone),
    rightItems: zone === undefined ? null : renderSlot('conversation.input.right', zone),
    // Ambient dock under the card shares the composer's width constraint.
    footer: hasSession && zone !== undefined ? renderSlot('conversation.composer.dock', zone) : null,
  })

  const composerBar = (
    <div className={clsx(css.composerStack, !hasSession && css.composerHero)}>
      {!hasSession && <HeroGlow className={css.heroGlow} />}
      {/* 空态（2026-08-30 设计稿 DjFev）：大 logo + 操作卡（新建项目 / 新建任务）
          替代 fork 官方 HeroShell（品牌标语 + 工作区选择）。设计稿空态只有
          logo + 卡 + 提示。
          **只在「真的没选中会话」时渲染**：已选中会话（含 blank——刚建好还没
          发消息的泳道）必须渲染 composer 输入框，否则用户无处发第一条指令。 */}
      {!hasSession && <EmptyStateHero emptyActions={emptyActions} recentTasks={recentTasks} dark={dark} />}
      {hasSession && heroWorkspaceRow}
      {zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {hasSession && inputBar}
    </div>
  )

  const phase = settling ? 'settling' : !hasSession ? 'hero' : 'active'
  const composer = renderSlotChain(
    'conversation.composer',
    { sessionId, session, pendingInteraction },
    { fallback: composerBar, fallbackOnly: sessionId === undefined, overlay: true },
  )

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave a business-owned takeover at the content
  // end off-screen when the user is not pinned to the floor.
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="">
      {composer}
    </div>
  )

  return (
    <div ref={rootResizeRef} className={css.root} data-phase={phase}>
      {sessionId === undefined ? null : renderSlot('conversation.session.header', {})}
      <div className={css.scrollBody} data-conversation-scroll="">
        {sessionId === undefined ? null : renderSlot('conversation.session', {})}
        {composerSeat}
      </div>
      {/* Width handles only while a transcript is on screen; the hero has no
          content column to size. */}
      {phase === 'active' && (['left', 'right'] as const).map(side => (
        <WidthHandle
          key={side}
          side={side}
          onStart={onHandleStart}
          onDrag={onHandleDrag}
          onCommit={onHandleCommit}
          onEnd={onHandleEnd}
        />
      ))}
    </div>
  )
}
