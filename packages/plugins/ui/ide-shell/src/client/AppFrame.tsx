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
import { computeColumns, frameTrackSpace, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

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
function DragHandle(props: { side: 'sidebar' | 'editor' | 'explorer' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    origin.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)

    // VSCode: force the cursor + suppress text selection app-wide via a
    // temporary global stylesheet for the drag's length.
    const style = document.createElement('style')
    style.textContent = '* { cursor: col-resize !important; user-select: none !important; -webkit-user-select: none !important; }'
    document.head.appendChild(style)

    const onMouseMove = (ev: MouseEvent) => {
      ev.preventDefault()
      callbacks.current.onDrag(ev.clientX - origin.current)
    }
    const onMouseUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMouseMove, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      style.remove()
      callbacks.current.onDrag(ev.clientX - origin.current)
      setDragging(false)
      callbacks.current.onEnd()
    }
    // Capture phase so nothing beneath swallows the move/up before window.
    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', onMouseUp, true)
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
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

  const expandSidebar = useCallback(() => { actions.toggleSidebar() }, [actions])
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
        {/* ① 会话列表 —— toggle corridor: rail (toggle + settings) ⟷ wide card
            (corum.sidebar content + settings foot). */}
        <div className={css.sidebarCol} data-rail={sidebarCollapsed || undefined}>
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

        {/* ④ 资源管理器: the file tree (corum.explorer slot — S1 fills it). */}
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

      {/*
        Drag handles sit on the column seams, inside the frame's 16px padding
        (their `left` is the seam position in the frame's padding-box). The
        column tracks run in the solver's trackSpace (= viewport − 2·16
        padding − gaps), so the seam offsets add the padding + the preceding
        gaps back. Each handle is a VSCode-style sash: a thin invisible hit
        strip centred on the seam (pointer events land on IT, not the cards).
      */}
      {!sidebarCollapsed && (
        <DragHandle side="sidebar" left={16 + cols.sidebar + 7} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />
      )}
      {cols.editor > 0 && (
        <DragHandle side="editor" left={16 + cols.sidebar + 14 + cols.center + 21} onStart={onEditorStart} onDrag={onEditorDrag} onEnd={onDragEnd} />
      )}
      {cols.explorer > 0 && (
        <DragHandle side="explorer" left={16 + cols.sidebar + 14 + cols.center + 14 + cols.editor + 21} onStart={onExplorerStart} onDrag={onExplorerDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
