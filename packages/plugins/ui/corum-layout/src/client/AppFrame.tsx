/**
 * CorumAppFrame — the IDE shell, registered into the built-in 'root' slot.
 * It is the corum fork of ui-layout's AppFrame: the same four child slots
 * (sidebar / conversation / details / shell.overlay) are re-declared here so
 * official ui-sidebar / ui-conversation mount unchanged, and the layout is
 * extended to the design.pen L1 主界面 IDE shape:
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
 * The explorer column hosts the `corum.explorer` slot (the file tree — P2/P3
 * fills it via @corum/corum-workspace); unoccupied it collapses to nothing so
 * the shell stays valid before that package lands.
 *
 * Pure component: everything arrives through the three framework shares
 * (runtime / render-slot / store), no cordis or framework imports.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns, frameTrackSpace, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay' | 'corum.editor' | 'corum.explorer' | 'corum.tabStrip' | 'corum.panel' | 'corum.statusBar'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/** A grid cell wrapper (keeps a stable class on each column). */
function Column(props: { className: string; children?: ReactNode }) {
  return <div className={props.className}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the
 * drag-start origin. `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'editor' | 'explorer' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The IDE frame (see module doc). */
export function CorumAppFrame({
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
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
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

  const sidebarBase = useRef(0)
  const editorBase = useRef(0)
  const explorerBase = useRef(0)
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onEditorStart = useCallback(() => { editorBase.current = colsRef.current.editor; setDragging(true) }, [])
  const onExplorerStart = useCallback(() => { explorerBase.current = colsRef.current.explorer; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onEditorDrag = useCallback((dx: number) => {
    actions.setEditor(editorBase.current - dx)
  }, [actions])
  const onExplorerDrag = useCallback((dx: number) => {
    actions.setExplorer(explorerBase.current - dx)
  }, [actions])

  const bottomOpen = panels.bottom > 0

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
      <div className={css.mainRow} style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.editor}px ${cols.explorer}px` }}>
        {/* ① 会话列表: official ui-sidebar mounts unchanged (glass card column). */}
        <div className={css.sidebarCol}>
          {renderSlot('sidebar', {
            collapsed: sidebarCollapsed,
            width: cols.sidebar,
          })}
        </div>

        {/* ② 对话区: tab strip (optional) + conversation body. */}
        <Column className={css.centerCol}>
          <div className={css.tabStrip}>
            {renderSlot('corum.tabStrip', {})}
          </div>
          <div className={css.centerBody}>
            {renderSlot('conversation', {})}
          </div>
        </Column>

        {/* ③ 编辑器区: the resident Monaco surface (corum.editor slot). */}
        {cols.editor > 0
          ? (
            <div className={css.editorCol}>
              {renderSlot('corum.editor', {})}
            </div>
          )
          : null}

        {/* ④ 资源管理器: the file tree (corum.explorer slot — P2/P3 fills it). */}
        {cols.explorer > 0
          ? (
            <div className={css.explorerCol}>
              {renderSlot('corum.explorer', {})}
            </div>
          )
          : null}
      </div>

      {/* ⑥ 底部面板: 终端/待办/队列 (corum.panel slot). */}
      {bottomOpen
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

      {!sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {cols.editor > 0 && <DragHandle side="editor" left={viewport - cols.editor - cols.explorer} onStart={onEditorStart} onDrag={onEditorDrag} onEnd={onDragEnd} />}
      {cols.explorer > 0 && <DragHandle side="explorer" left={viewport - cols.explorer} onStart={onExplorerStart} onDrag={onExplorerDrag} onEnd={onDragEnd} />}
    </div>
  )
}
