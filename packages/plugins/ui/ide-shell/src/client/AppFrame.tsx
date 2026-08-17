/**
 * IdeAppFrame — the IDE shell, registered into the built-in 'root' slot.
 *
 * The frame lays out the design.pen L1 主界面 IDE shape:
 *
 *   ┌ session-list │ conversation(flex) │ editor │ explorer ┐   ← Main Row (gap 14, padding 16)
 *   └ bottom panel (终端/待办/队列) ──────────────────────────┘
 *   └ status bar (连接 · 项目 · 模型) ─────────────────────────┘
 *   └ details (official ui-conversation drawer, opens on demand) ┘
 *
 * Geometry is the single source of truth: design.pen ① 会话列表 280, ③ 编辑器
 * 430, ④ 资源管理器 210, ⑥ 底部面板 150, ⑦ 状态栏 34. The details panel is the
 * official ui-conversation DetailsPanel (opened by ctx.layout.openDetails), so
 * it renders as an on-demand right drawer, not a persistent column.
 *
 * The left column is a toggle corridor between two states — the rail (56px)
 * and the wide card (280px) — decided by the sidebar fold state machine
 * (narrow viewport auto-collapse + ctx.layout.toggleSidebar). The rail renders
 * ONLY the expand toggle + the settings seat; the wide card renders the
 * `corum.sidebar` slot content (S1: @corum/ide-sidebar session list) above the
 * settings seat. The shell re-declares `sidebar.settings` (disabling
 * ui-sidebar strands it) and renders it in this foot so ui-settings-general
 * mounts unchanged.
 *
 * Pure component: everything arrives through the framework shares (runtime /
 * render-slot / store), no cordis or framework imports.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  computeColumns, frameTrackSpace, resizeSash,
  type TrackSpec,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX,
  EDITOR_MIN, EDITOR_MAX, EXPLORER_MIN, EXPLORER_MAX, CENTER_MIN,
} from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/**
 * The floating-window target: the slot key this window should mount alone,
 * read once from `?floating=<slotKey>` (the Electron open-floating bridge
 * loads `corumapp://app/index.html?floating=<slotKey>`). Null in the main
 * window, where the full four-column shell renders.
 */
function floatingSlotKey(): string | null {
  if (typeof window === 'undefined') return null
  const key = new URLSearchParams(window.location.search).get('floating')
  return key === null || key === '' ? null : key
}

/** The slots a floating window may mount (the shell's own region slots). */
const FLOATABLE_SLOTS = new Set(['corum.sidebar', 'corum.editor', 'corum.explorer', 'corum.panel', 'corum.statusBar', 'conversation', 'details'])

/** The desktop preload bridge face this frame uses for floating windows. */
interface FloatingBridge {
  onFloatingChange?: (cb: (slotKey: string, detached: boolean) => void) => () => void
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'conversation' | 'details' | 'shell.overlay' | 'sidebar.settings' | 'corum.sidebar' | 'corum.editor' | 'corum.explorer' | 'corum.tabStrip' | 'corum.panel' | 'corum.statusBar'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/** A grid cell wrapper (keeps a stable class on each column). */
function Column(props: { className: string; children?: ReactNode }) {
  return <div className={props.className}>{props.children}</div>
}

/**
 * One drag handle, a faithful copy of VSCode's Sash (src/vs/base/browser/ui/
 * sash/sash.ts). The mechanism, line for line:
 *   - `mousedown` on the handle (NOT pointerdown), so the gesture is a plain
 *     mouse drag; no setPointerCapture anywhere.
 *   - `mousemove` / `mouseup` attach to WINDOW for the gesture's length, so
 *     the drag survives crossing any column/card (VSCode's MouseEventFactory
 *     uses `new DomEmitter(getWindow(el), 'mousemove'/'mouseup')`).
 *   - On drag start, inject a global `* { cursor: col-resize !important; }`
 *     stylesheet (VSCode fixes microsoft/vscode#21675 exactly this way): it
 *     forces the resize cursor over the whole app AND suppresses the native
 *     text-selection gesture for the drag's length. Removed on mouseup.
 *   - No rAF throttle: each mousemove applies immediately (VSCode fires
 *     onDidSashChange synchronously and SplitView resizes in lockstep).
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'editor' | 'explorer' | 'details' | 'bottom' | 'centerTop' | 'editorTop' | 'explorerTop'; axis?: 'x' | 'y'; left?: number; top?: number; width?: number; onStart: () => void; onDrag: (delta: number) => void; onEnd: () => void }) {
  const axis = props.axis ?? 'x'
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    origin.current = axis === 'x' ? e.clientX : e.clientY
    callbacks.current.onStart()
    setDragging(true)

    // VSCode: force the cursor + suppress text selection app-wide via a
    // temporary global stylesheet for the drag's length.
    const cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    const style = document.createElement('style')
    style.textContent = `* { cursor: ${cursor} !important; user-select: none !important; -webkit-user-select: none !important; }`
    document.head.appendChild(style)

    const onMouseMove = (ev: MouseEvent) => {
      ev.preventDefault()
      callbacks.current.onDrag((axis === 'x' ? ev.clientX : ev.clientY) - origin.current)
    }
    const onMouseUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMouseMove, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      style.remove()
      callbacks.current.onDrag((axis === 'x' ? ev.clientX : ev.clientY) - origin.current)
      setDragging(false)
      callbacks.current.onEnd()
    }
    // Capture phase so nothing beneath swallows the move/up before window.
    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', onMouseUp, true)
  }, [axis])

  const style: React.CSSProperties = axis === 'x'
    ? { left: props.left }
    : props.width !== undefined
      ? { top: props.top, left: props.left, width: props.width, right: 'auto' }
      : { top: props.top }
  return (
    <div
      className={axis === 'x' ? css.handle : css.handleV}
      style={style}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onMouseDown={onMouseDown}
    />
  )
}

/** The IDE frame (see module doc). */
export function IdeAppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box: rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const rect = el.getBoundingClientRect()
        if (rect.width > 0) setViewport(rect.width)
        if (rect.height > 0) setViewportHeight(rect.height)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Detached slots: while a slot is popped out into a floating window, the
  // main window collapses that column (the user asked for the column to
  // disappear, not to show a duplicate). Restores when the window closes.
  const [detached, setDetached] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const bridge = (window as unknown as { corumDesktop?: FloatingBridge }).corumDesktop
    if (bridge?.onFloatingChange === undefined) return
    return bridge.onFloatingChange((slotKey, isDetached) => {
      setDetached((prev) => {
        const next = new Set(prev)
        if (isDetached) next.add(slotKey)
        else next.delete(slotKey)
        return next
      })
    })
  }, [])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  // The solver sees the frame's border-box width; the grid tracks run inside
  // the padding and gaps, so the concession chain solves against that budget.
  const trackSpace = frameTrackSpace(viewport)
  const cols = computeColumns(trackSpace, sidebarPreference, panels.editor, panels.explorer)
  const colsRef = useRef(cols)
  colsRef.current = cols
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  // A detached slot's column collapses in the main window (width 0): the
  // content lives in the floating window until that window closes.
  const editorDetached = detached.has('corum.editor')
  const explorerDetached = detached.has('corum.explorer')
  const sidebarDetached = detached.has('corum.sidebar')
  const panelDetached = detached.has('corum.panel')

  // SplitView drag model: each drag snapshots the three fixed tracks at start
  // and, per move, runs a VSCode-style adjacent push (columns.ts pushTrack) so
  // the moving column hands its delta to its neighbours nearest-first. Columns
  // compress to their floors and stay — they never auto-close under a drag.
  const dragStart = useRef({ sidebar: 0, editor: 0, explorer: 0 })
  const [dragging, setDragging] = useState(false)
  const snapshot = useCallback(() => {
    dragStart.current = {
      sidebar: colsRef.current.sidebar,
      editor: colsRef.current.editor,
      explorer: colsRef.current.explorer,
    }
    setDragging(true)
  }, [])
  const onDragEnd = useCallback(() => { setDragging(false) }, [])

  // SplitView sash resize (VSCode splitview.ts). The four columns are the
  // tracks [sidebar, center, editor, explorer]; the center is the flex
  // remainder modelled with the CENTER_MIN floor. Each seam's sashIndex is
  // the column LEFT of it: sidebar seam = 0, editor seam = 1, explorer = 2.
  // resizeSash distributes the delta to BOTH sides nearest-first, so a drag
  // compresses whichever columns have headroom and never closes a column.
  const startTracks = useCallback((): TrackSpec[] => {
    const start = dragStart.current
    const budget = frameTrackSpace(viewportRef.current)
    const centerStart = Math.max(0, budget - start.sidebar - start.editor - start.explorer)
    return [
      { min: SIDEBAR_MIN, max: SIDEBAR_MAX, size: start.sidebar },
      { min: CENTER_MIN, max: Number.MAX_SAFE_INTEGER, size: centerStart },
      { min: EDITOR_MIN, max: EDITOR_MAX, size: start.editor },
      { min: EXPLORER_MIN, max: EXPLORER_MAX, size: start.explorer },
    ]
  }, [])
  const applyTracks = useCallback((sizes: number[]) => {
    actions.setTracks(sizes[0], sizes[2], sizes[3])
  }, [actions])

  // sashIndex = the column LEFT of the seam: sidebar seam = 0 (sidebar),
  // editor seam = 2 (editor), explorer seam = 3 (explorer). Dragging right
  // (dx>0) grows the left column; left (dx<0) grows the right column.
  const onSidebarDrag = useCallback((dx: number) => {
    applyTracks(resizeSash(startTracks(), 0, dx))
  }, [applyTracks, startTracks])
  const onEditorDrag = useCallback((dx: number) => {
    applyTracks(resizeSash(startTracks(), 2, dx))
  }, [applyTracks, startTracks])
  const onExplorerDrag = useCallback((dx: number) => {
    applyTracks(resizeSash(startTracks(), 3, dx))
  }, [applyTracks, startTracks])

  // Bottom panel height seam (vertical sash): dragging up grows the panel.
  const bottomBase = useRef(0)
  const onBottomStart = useCallback(() => { bottomBase.current = panelsRef.current.bottom; setDragging(true) }, [])
  const onBottomDrag = useCallback((dy: number) => {
    actions.setBottom(bottomBase.current - dy)
  }, [actions])

  // Vertical-split top-row seams (one per column that supports it): dragging
  // DOWN grows an empty row above the column's content (borrowing height from
  // it), dragging back up collapses the row. Each column owns its own top row.
  const centerTopBase = useRef(0)
  const editorTopBase = useRef(0)
  const explorerTopBase = useRef(0)
  const onCenterTopStart = useCallback(() => { centerTopBase.current = panelsRef.current.centerTop; setDragging(true) }, [])
  const onEditorTopStart = useCallback(() => { editorTopBase.current = panelsRef.current.editorTop; setDragging(true) }, [])
  const onExplorerTopStart = useCallback(() => { explorerTopBase.current = panelsRef.current.explorerTop; setDragging(true) }, [])
  const onCenterTopDrag = useCallback((dy: number) => { actions.setCenterTop(centerTopBase.current + dy) }, [actions])
  const onEditorTopDrag = useCallback((dy: number) => { actions.setEditorTop(editorTopBase.current + dy) }, [actions])
  const onExplorerTopDrag = useCallback((dy: number) => { actions.setExplorerTop(explorerTopBase.current + dy) }, [actions])

  const expandSidebar = useCallback(() => { actions.toggleSidebar() }, [actions])
  const bottomOpen = panels.bottom > 0

  // ── Floating-window mode ──
  // This window loaded with ?floating=<slotKey>: mount ONLY that slot's
  // content, wrapped in the design.pen Window Chrome (traffic dots + slot
  // title + a dock-back hint), NOT the four-column shell. The slot renders
  // through the same renderSlot, so a plugin's content is identical detached
  // and docked — the slot system is what makes the window swap possible.
  const floatKey = floatingSlotKey()
  if (floatKey !== null) {
    const mountable = FLOATABLE_SLOTS.has(floatKey)
    return (
      <div className={css.floatingRoot} data-floating={floatKey}>
        <div className={css.windowChrome}>
          <span className={css.chromeDots} aria-hidden="true">
            <i /><i /><i />
          </span>
          <span className={css.chromeTitle}>{floatKey}</span>
          <span className={css.chromeHint}>浮动窗 · 关闭即回到主窗口</span>
        </div>
        <div className={css.floatingBody}>
          {mountable
            // renderSlot is keyed by the union of declared slot names; a
            // runtime ?floating=<key> string needs a cast. The key is already
            // validated against FLOATABLE_SLOTS above.
            ? (renderSlot as (key: string, owner: Record<string, never>) => ReactNode)(floatKey, {})
            : <div className={css.floatingEmpty}>未知槽位：<code>{floatKey}</code>（可在 {[...FLOATABLE_SLOTS].join(' / ')} 中选择）</div>}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={frameRef}
      className={css.frame}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-editor-collapsed={cols.editor === 0 || undefined}
      data-explorer-collapsed={cols.explorer === 0 || undefined}
      data-dragging={dragging || undefined}
    >
      {/* Main Row: ① 会话列表 │ ② 对话区 │ ③ 编辑器区 │ ④ 资源管理器 */}
      <div
        className={css.mainRow}
        style={{
          gridTemplateColumns: `${sidebarDetached ? 0 : cols.sidebar}px minmax(0, 1fr) ${editorDetached ? 0 : cols.editor}px ${explorerDetached ? 0 : cols.explorer}px`,
        }}
      >
        {/* ① 会话列表 —— toggle corridor: rail (toggle + settings) ⟷ wide card
            (corum.sidebar content + settings foot). Detached → column collapses. */}
        <div className={css.sidebarCol} data-rail={sidebarCollapsed || undefined} hidden={sidebarDetached}>
          {sidebarCollapsed
            ? (
              <div className={css.sidebarRail}>
                <button
                  type="button"
                  className={css.railButton}
                  aria-label="Expand sidebar"
                  onClick={expandSidebar}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M9 3v18" />
                    <path d="m14 9 3 3-3 3" />
                  </svg>
                </button>
                <div className={css.sidebarFoot}>
                  {renderSlot('sidebar.settings', { wide: false })}
                </div>
              </div>
            )
            : (
              <>
                <div className={css.sidebarBody}>
                  {renderSlot('corum.sidebar', {
                    wide: true,
                    width: cols.sidebar,
                    expandSidebar,
                  })}
                </div>
                <div className={css.sidebarFoot}>
                  {renderSlot('sidebar.settings', { wide: true })}
                </div>
              </>
            )}
        </div>

        {/* ② 对话区: optional empty top row (the vertical split) + tab strip +
            conversation body. The top seam opens the empty row (drag down). */}
        <Column className={css.centerCol}>
          {panels.centerTop > 0 && (
            <div className={css.colTopRow} style={{ height: panels.centerTop }} data-testid="corum-center-top-row" />
          )}
          <div className={css.tabStrip}>
            {renderSlot('corum.tabStrip', {})}
          </div>
          <div className={css.centerBody}>
            {renderSlot('conversation', {})}
          </div>
        </Column>

        {/* ③ 编辑器区: optional empty top row + content (corum.editor slot). Detached → collapses. */}
        {cols.editor > 0 && !editorDetached
          ? (
            <div className={css.editorCol}>
              {panels.editorTop > 0 && (
                <div className={css.colTopRow} style={{ height: panels.editorTop }} data-testid="corum-editor-top-row" />
              )}
              <div className={css.colBody}>
                {renderSlot('corum.editor', {})}
              </div>
            </div>
          )
          : null}

        {/* ④ 资源管理器: optional empty top row + content (corum.explorer slot). Detached → collapses. */}
        {cols.explorer > 0 && !explorerDetached
          ? (
            <div className={css.explorerCol}>
              {panels.explorerTop > 0 && (
                <div className={css.colTopRow} style={{ height: panels.explorerTop }} data-testid="corum-explorer-top-row" />
              )}
              <div className={css.colBody}>
                {renderSlot('corum.explorer', {})}
              </div>
            </div>
          )
          : null}
      </div>

      {/* ⑥ 底部面板: 终端/待办/队列 (corum.panel slot). Detached → collapses. */}
      {bottomOpen && !panelDetached
        ? (
          <div className={css.bottomPanel} style={{ height: panels.bottom }}>
            {renderSlot('corum.panel', {})}
          </div>
        )
        : null}

      {/* ⑦ 状态栏: 连接 · 项目 · 模型 (corum.statusBar slot). */}
      <div className={css.statusBar}>
        {renderSlot('corum.statusBar', {})}
      </div>

      {/* 次侧栏: official ui-conversation DetailsPanel (on-demand drawer). */}
      {panels.details > 0
        ? (
          <div className={css.detailsCol} style={{ width: panels.details }} data-details>
            {renderSlot('details', {})}
          </div>
        )
        : null}

      {/* Frame-wide floating layer. */}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>

      {/*
        Drag handles sit on the column seams, inside the frame's 16px padding
        (their `left` is the seam position in the frame's padding-box). The
        column tracks run in the solver's trackSpace (= viewport − 2·16
        padding − gaps), so the seam offsets add the padding + the preceding
        gaps back. Each handle is a VSCode-style sash: a thin invisible hit
        strip centred on the seam (pointer events land on IT, not the cards).
      */}
      {!sidebarCollapsed && (
        <DragHandle side="sidebar" left={16 + cols.sidebar + 7} onStart={snapshot} onDrag={onSidebarDrag} onEnd={onDragEnd} />
      )}
      {cols.editor > 0 && (
        <DragHandle side="editor" left={16 + cols.sidebar + 14 + cols.center + 21} onStart={snapshot} onDrag={onEditorDrag} onEnd={onDragEnd} />
      )}
      {cols.explorer > 0 && (
        <DragHandle side="explorer" left={16 + cols.sidebar + 14 + cols.center + 14 + cols.editor + 21} onStart={snapshot} onDrag={onExplorerDrag} onEnd={onDragEnd} />
      )}
      {/* Vertical-split top seams (one per column): drag DOWN to open an empty
          row above that column's content; drag back up to collapse it. Each
          spans its own column's width, positioned above the content body. */}
      <DragHandle
        side="centerTop"
        axis="y"
        top={16 + panels.centerTop + 7}
        left={16 + (sidebarDetached ? 0 : cols.sidebar) + 14}
        width={cols.center}
        onStart={onCenterTopStart}
        onDrag={onCenterTopDrag}
        onEnd={onDragEnd}
      />
      {cols.editor > 0 && !editorDetached && (
        <DragHandle
          side="editorTop"
          axis="y"
          top={16 + panels.editorTop + 7}
          left={16 + (sidebarDetached ? 0 : cols.sidebar) + 14 + cols.center + 14}
          width={cols.editor}
          onStart={onEditorTopStart}
          onDrag={onEditorTopDrag}
          onEnd={onDragEnd}
        />
      )}
      {cols.explorer > 0 && !explorerDetached && (
        <DragHandle
          side="explorerTop"
          axis="y"
          top={16 + panels.explorerTop + 7}
          left={16 + (sidebarDetached ? 0 : cols.sidebar) + 14 + cols.center + 14 + cols.editor + 14}
          width={cols.explorer}
          onStart={onExplorerTopStart}
          onDrag={onExplorerTopDrag}
          onEnd={onDragEnd}
        />
      )}
      {/* Bottom panel height seam (vertical sash), sits on the panel's top edge. */}
      {bottomOpen && (
        <DragHandle side="bottom" axis="y" top={viewportHeight - 34 - 14 - panels.bottom - 7} onStart={onBottomStart} onDrag={onBottomDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
