// Resident conversation skeleton. Hero chrome, composer positioning, the
// chain, AND the composer bar (session-maybe slot) stay mounted across
// no-session/session transitions — the bar renders inert via owner props.

import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Bot } from 'lucide-react'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationSlotProps, InputZone, TaskAgentInfo } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { HeroGlow, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
import { EmptyStateHero } from './EmptyStateHero.tsx'
import { NewSessionHero } from './NewSessionHero.tsx'
import { AgentTwoLevelSelect } from './AgentTwoLevelSelect.tsx'
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
  useWorkspaces, useConversation, useInput, useComposerBlock, inputActions,
  renderSlot, renderSlotChain, selectWorkspace, emptyActions, newTaskForm, polishDraft, translateDraft, t,
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
  /** 是否 task 泳道会话（corum-task-*）——这类会话 Agent 创建时绑定，session 内锁定。 */
  const isTaskLane = sessionId !== undefined && String(sessionId).startsWith('corum-task-')
  /** 是否子 Agent 会话——由父 Agent 发起和管控，用户不可干涉：
   *  隐藏 composer 输入框与工作区选择，底部改「返回父会话」撑满条（设计稿 q0T81 稿②）。
   *
   * ⚠️ 判据必须与**官方 ui-subagent 抢 composer 所用的那个信号同源**（2026-09-19
   * 用户报障①：运行中点停止后输入框下方多出一条带边框的横条、输入框被顶上去）。
   *
   * 官方 `ui-subagent` 的 `selectReadOnlySubagent` 读的是**运行时 session 对象**的
   * `session.subagent`（`conversation.composer` 链的 owner 币），命中即**当选**——
   * 而本槽用 `overlay: true` 渲染，当选时 fallback 是 `display:none` 而非卸载。
   *
   * 此前本处只认 sessions 列表摘要的 `origin === 'subagent'`（`byId[id].origin`）。
   * 两个来源不同源：摘要里的 origin 可能还没到／已过期，而运行时对象已带 `subagent`
   * ⇒ 本处判「非子会话」照常渲染 corum 的 composer，官方那条只读条**同时当选**并渲染
   * 在输入卡**下方**（它的 CSS 是 `margin: 0 24px 20px; min-height: 54px` 的独立横条）
   * ⇒ 于是「输入框下方多出一个东西 + 输入框被顶上去」。
   *
   * 为什么「停止」恰好触发（官方 selector 第 44 行）：continuable 子会话在**运行中**
   * 时官方刻意**不**接管（要留住默认 composer 里那个 primary Stop 好让用户中断它）；
   * 一旦停下，`running` 转 false ⇒ 接管条件成立 ⇒ 那条只读条就冒出来了。
   *
   * 故这里同时认两个信号（任一为真即按子会话处理），与官方口径对齐。
   */
  const sessionOrigin = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.origin)
  /** 运行时 session 对象自带的 subagent 币（官方 selectReadOnlySubagent 用的同一信号）。 */
  const runtimeSubagent = session?.subagent
  const isSubagentSession = sessionOrigin === 'subagent' || (runtimeSubagent !== undefined && runtimeSubagent !== null)
  /** 子 Agent 会话的父会话 id（session/list 行 parentId），供「返回父会话」寻址。 */
  const parentSessionId = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.parentId)
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

  // 「选择工作区」chip 的渲染判据。
  //
  // 2026-08-31 用户走查：新会话界面顶部不该有「选择工作区」⇒ task 泳道会话不渲染
  // （工作区在建会话时已绑定、Agent 已锁定）。
  // 子 Agent 会话同样不渲染（① 用户定调：子 Agent 由父 Agent 管控，无工作区选择）。
  //
  // ⚠️ 2026-09-19 用户报障②：**「在新对话中分支」(MessageIconActions 的 fork) 建出的
  // 会话又冒出了这个 chip**。根因是当时用 `isTaskLane`（= sessionId 以 `corum-task-`
  // 开头）当唯一判据，而 fork 出来的会话 id 是随机 UUID，前缀不匹配 ⇒ 判成「非 task
  // 泳道」⇒ 渲染。**用 id 前缀当类型判据本身就脆**：任何新建会话路径（fork / 未来别的）
  // 只要不遵这个前缀就会漏判。
  //
  // 这里的分界不是「哪条路径建的会话」，而是「**用户还需不需要挑工作区**」——
  // 即「这个会话是不是还没开始（blank）」：
  //   · blank（含 fork 出来的、尚未发首条消息的）→ 工作区仍未定，chip 有意义；
  //   · 非 blank（已发过消息）→ 工作区已随首次发送落定，chip 无意义，隐藏。
  // 另外 kkc IDE 里官方 useWorkspaces 已禁（本文件上方注释：降级为空 stub），工作区
  // 导航由侧栏自研承载 ⇒ **非 blank 时这个 chip 连数据源都没有**，渲染出来只会是个
  // 点不动的死控件（与 2026-09-19 picker 那次是同一类「不可选中的下拉」问题）。
  const showWorkspaceRow = hasSession && !isTaskLane && !isSubagentSession && summaryBlank === true
  const heroWorkspaceRow = showWorkspaceRow
    ? (
      <div className={css.heroWorkspaceRow}>        <WorkspaceChip
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
    : null

  // task 泳道会话的 Agent 名片信息（副标语「由 X 执行」+ 对话起始页专业推荐命令）：
  // 所有 task 泳道（blank 与正式会话）都查，发消息切换会话时也保持。
  const [agentInfo, setAgentInfo] = useState<TaskAgentInfo | undefined>(undefined)
  useEffect(() => {
    if (!isTaskLane || sessionId === undefined) { setAgentInfo(undefined); return }
    let alive = true
    emptyActions.getTaskAgentInfo(String(sessionId))
      .then((info) => { if (alive) setAgentInfo(info) })
      .catch(() => { /* 查询失败则不显示 Agent 名，推荐命令回退通用集 */ })
    return () => { alive = false }
  }, [isTaskLane, sessionId, emptyActions])

  // 可选 Agent chip（2026-09-02 用户定调）：task 泳道 composer 的 Agent 从只读
  // 锁定 chip 改为可选下拉——blank 泳道可换 Agent（官方 agentPresets.select blank
  // 限定；已开始会话 host 拒绝、catch 呈现）。profileId 经 listTaskAgents 拿；
  // 下拉选项经 listAgents（listProfiles 投影）。
  const [agentProfileId, setAgentProfileId] = useState('')
  const [agentOptions, setAgentOptions] = useState<readonly { id: string; name: string; title?: string; dimension?: string; source?: 'corum' | 'official'; trust?: 'system' | 'user' }[]>([])
  const [agentSwitchError, setAgentSwitchError] = useState('')
  useEffect(() => {
    if (!isTaskLane || sessionId === undefined) { setAgentProfileId(''); return }
    let alive = true
    // listTaskAgents 拿当前 profileId + listAgents 拿下拉选项（同 getTaskAgentName 通路）。
    Promise.all([
      emptyActions.listAgents(),
      emptyActions.getTaskAgentProfileId(String(sessionId)),
    ])
      .then(([options, profileId]) => {
        if (!alive) return
        setAgentOptions(options.map((o) => ({
          id: o.id,
          name: o.name,
          ...(o.title === undefined ? {} : { title: o.title }),
          ...(o.dimension === undefined ? {} : { dimension: o.dimension }),
          ...(o.source === undefined ? {} : { source: o.source }),
          ...(o.trust === undefined ? {} : { trust: o.trust }),
        })))
        setAgentProfileId(profileId ?? options[0]?.id ?? '')
      })
      .catch(() => { /* 拉取失败：下拉留空，不可切换 */ })
    return () => { alive = false }
  }, [isTaskLane, sessionId, emptyActions])
  const switchAgent = useCallback((profileId: string) => {
    if (sessionId === undefined || profileId === agentProfileId) return
    setAgentSwitchError('')
    void emptyActions.selectTaskAgent(String(sessionId), profileId)
      .then(() => {
        setAgentProfileId(profileId)
        // 名片信息同步刷新（副标语 + 专业推荐命令随新 Agent 更新）。
        const option = agentOptions.find((o) => o.id === profileId)
        if (option !== undefined) {
          setAgentInfo({
            name: option.name,
            ...(option.title === undefined ? {} : { title: option.title }),
            ...(option.dimension === undefined ? {} : { dimension: option.dimension }),
          })
        }
      })
      .catch((e) => {
        // 失败绝不静默吞（PROGRESS §4）：呈现原因——**用户可见**（2026-09-09
        // 修正：此前只写 console.error + aria-label，屏幕零提示，用户看到的是
        // 「点了没反应」）。__corumNotify 是桌面壳安装的一次性只读桥（规范 §1
        // 例外，CorumNotification 面：tone/title/message），corum-ui-chat 同款。
        console.error('[conversation] switch task agent failed', e)
        const message = e instanceof Error ? e.message : String(e)
        setAgentSwitchError(message)
        const notify = (window as unknown as {
          __corumNotify?: (n: { tone: 'error'; title: string; message?: string | undefined }) => void
        }).__corumNotify
        notify?.({ tone: 'error', title: '切换 Agent 失败', message })
      })
  }, [sessionId, agentProfileId, agentOptions, emptyActions])

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
    // fork（corum）：polishDraft 随 props 下发给 InputBar——提示词润色的唯一入口是
    // 输入区右上角的 sparkle 按钮（此处不再另挂 Wand2 按钮，避免同屏两个）。
    polishDraft,
    // 翻译按钮与润色同位（sparkle 旁）：translateDraft 同型下发给 InputBar。
    translateDraft,
    // corum 工具栏扩展（Agent 选择）走 corum 增量字段 toolbarLeading
    //（官方 0.1.3 删除了 overlay/leftItems/rightItems/footer owner props，槽由
    // InputBar 自渲染；corum 工具栏内定制经 toolbarLeading 渲染在 accessSelect 后）。
    toolbarLeading: zone === undefined ? undefined : (
      <>
        {/* Agent 选择放进 composer 工具栏（2026-09-02 用户定调）：task 泳道 composer
            的 Agent 从只读锁定 chip 改为可选下拉——**只在 blank（未发首条消息）时
            渲染**；一旦开始第一次对话（非 blank）整个隐藏，不允许用户更改
            （官方 agentPresets.select blank 限定，非 blank host 必拒绝）。 */}
        {isTaskLane && summaryBlank === true && (
          <span className={css.agentLockChip} data-select>
            <Bot size={12} />
            <AgentTwoLevelSelect
              agents={agentOptions}
              value={agentProfileId}
              onChange={switchAgent}
              ariaLabel={agentSwitchError !== '' ? `选择执行 Agent（切换失败：${agentSwitchError}）` : '选择执行 Agent'}
              disabled={agentOptions.length === 0}
              css={{
                root: css.agentSelRoot,
                trigger: css.agentSelTrigger,
                triggerName: css.agentSelTriggerName,
                chevron: css.agentSelChevron,
                panel: css.agentSelPanel,
                searchRow: css.agentSelSearchRow,
                searchIcon: css.agentSelSearchIcon,
                searchInput: css.agentSelSearchInput,
                searchClear: css.agentSelSearchClear,
                groupHead: css.agentSelGroupHead,
                groupLabel: css.agentSelGroupLabel,
                groupCount: css.agentSelGroupCount,
                list: css.agentSelList,
                item: css.agentSelItem,
                itemCheck: css.agentSelItemCheck,
                itemHint: css.agentSelItemHint,
                empty: css.agentSelEmpty,
              }}
            />
          </span>
        )}
        {/* 会话内提示词润色按钮已移除（2026-09-09 用户报障「有两个」）：设计稿只有
            一个入口——输入区右上角的 sparkle 按钮（InputBar 的 .sparkleIcon）。此处
            曾另挂一个 Wand2 按钮（真实现），与 sparkle 同屏重复；现把真实现经下方
            composer.bar props 的 `polishDraft` 下发给 InputBar，由 sparkle 承载。 */}
      </>
    ),
  })

  // blank 会话（刚建好还没发消息）也按 hero 相位布局：让 scrollBody 垂直居中、
  // composerStack 走 .composerHero（align-self center + composer 宽度对齐），
  // 标语/快捷指令卡/输入框垂直水平居中对齐（设计稿 L4）。发第一条消息 blank 翻转
  // 后回到 active 底部停靠。
  const isNewSessionHero = hasSession && summaryBlank === true

  const composerBar = (
    <div className={clsx(css.composerStack, (!hasSession || isNewSessionHero) && css.composerHero)}>
      {!hasSession && <HeroGlow className={css.heroGlow} />}
      {/* ⚠️ 空态（EmptyStateHero / NewSessionHero）**已移出本容器**（2026-09-16 重构）：
          它们在 `.scrollBody` 下与会话视图平级渲染。这里曾是二者的宿主，而本容器是
          「给输入框用的宽度上下文」（.composerHero 的 width 由会话宽度轴算出）——
          空态留在里面就会被会话宽度连带拖窄。**不要再把空态塞回这里。** */}
      {hasSession && heroWorkspaceRow}
      {zone !== undefined && !isSubagentSession && renderSlot('conversation.input.dock', zone)}
      {/* ② 子 Agent 会话：隐藏输入框，底部改「返回父会话」撑满条（子 Agent 由父
          Agent 发起和管控，用户不可干涉；返回条宽度对齐原 composer 输入框宽度——
          走 .subagentReturnBar 与 inputBar 同 max-width 约束）。 */}
      {hasSession && !isSubagentSession && inputBar}
      {hasSession && isSubagentSession && (
        <div className={css.subagentReturnBar}>
          <button
            type="button"
            className={css.subagentReturnBtn}
            disabled={parentSessionId === undefined}
            onClick={() => {
              if (parentSessionId === undefined) return
              // openTask 内部即 sessions.open（task 泳道跳转通道）；父会话是 task
              // 泳道，可寻址。失败静默（返回条仍展示上下文）。
              void emptyActions.openTask(String(parentSessionId)).catch(() => {})
            }}
          >
            <ArrowLeft size={16} strokeWidth={2} className={css.subagentReturnIcon} />
            <span className={css.subagentReturnLabel}>{t('subagent.backToParent')}</span>
            <span className={css.subagentReturnHint}>{t('subagent.managedByParent')}</span>
          </button>
        </div>
      )}
    </div>
  )

  const phase = settling ? 'settling' : (!hasSession || isNewSessionHero) ? 'hero' : 'active'
  /**
   * fork（corum）：子 Agent 会话**绕过 composer 链**，直接渲染 corum 的
   * `subagentReturnBar`。
   *
   * 2026-09-09 回归修复：官方 `ui-subagent` 在 `conversation.composer` 注册了
   * 只读 composer 占位（priority -10），对一次性子会话 `select` 命中即**当选**；
   * 而本槽用 `overlay: true` 渲染——按 ui-slots 契约，当选时 fallback 不是被
   * 卸载而是 **`display:none` 隐藏**，于是设计稿 q0T81 稿②的底部「返回父会话」
   * 撑满条被官方「一次性子代理记录」提示盖掉，用户进得去出不来。
   * 子 Agent 会话的底部交互由 corum 独占（与后台/continuable 子会话一致：
   * 隐藏输入框、只留返回条），因此这里不做链式派发。
   */
  const composer = hasSession && isSubagentSession
    ? composerBar
    : renderSlotChain(
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

  /*
    ── 空态渲染位置（2026-09-16 重构，用户定调）────────────────────────────
    两个空态（`!hasSession` → EmptyStateHero、blank → NewSessionHero）**不再塞进
    `.composerStack`**，而是升到 `.scrollBody` 下、与 `conversation.session` 视图
    **并列为兄弟**。

    为什么必须这样：`.composerStack` 是「给输入框用的宽度上下文」
    （`.composerHero` 的 `width: min(calc(--dsh-composer-card-max-width + …), 100%)`），
    而那条宽度轴是为**会话正文列**设计的。空态没有正文列却被套上它 ⇒
    用户拖拽会话宽度会把空态一起拖窄（并连带引发「相位间宽度规则互相溢出」这类问题）。
    分离后：**会话宽度轴的消费者只剩正文列 + 输入框**，空态天然不受影响。

    两个空态互斥（同一次渲染至多一个非 null），故直接按相位择一。
  */
  const emptyState = !hasSession
    ? (
      /* 空态（2026-08-30 设计稿 DjFev）：大 logo + 操作卡（新建项目 / 新建任务） */
      <EmptyStateHero emptyActions={emptyActions} newTaskForm={newTaskForm} recentTasks={recentTasks} dark={dark} />
    )
    : summaryBlank === true
      ? (
        /* 新会话界面（设计稿 L4）：标语 + 快捷指令卡；点卡把指令填进 composer */
        <NewSessionHero
          workspaceTitle={chipTitle ?? (cwd !== undefined && cwd !== '' ? workspaceLabel(cwd) : undefined)}
          agentInfo={agentInfo}
          onPick={(prompt) => { inputActions?.setDraft(prompt) }}
        />
      )
      : null

  return (
    <div ref={rootResizeRef} className={css.root} data-phase={phase}>
      {sessionId === undefined ? null : renderSlot('conversation.session.header', {})}
      <div className={css.scrollBody} data-conversation-scroll="">
        {/* 空态与会话视图**平级**：同一时刻只会有一个非 null（相位互斥）。 */}
        {emptyState}
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
