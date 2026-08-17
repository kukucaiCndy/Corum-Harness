/**
 * IdeAppFrame —— IDE 壳，注册进内建 'root' 槽。
 *
 * 布局 = 自由二维网格（GridView）+ 壳层的底部面板 / 状态栏 / details 抽屉：
 *
 *   ┌ ── GridView（默认四列：sidebar │ conversation │ editor │ explorer）── ┐
 *   │   模块标题拖到另一模块四边拆分 / 中心交换；窗格间 sash 拖拽；            │
 *   │   布局树持久化 localStorage。                                          │
 *   └ bottom panel（终端/待办/队列，corum.panel 槽）─────────────────────────┘
 *   └ status bar（连接 · 项目 · 模型，corum.statusBar 槽）────────────────────┘
 *   └ details（官方 ui-conversation 抽屉，按需右侧覆盖）─────────────────────┘
 *
 * 纯组件：一切经框架三份 share（runtime / render-slot / store）到达，不 import
 * cordis 或框架。几何求解已迁到 GridView 的分割树（grid.ts）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'
import { GridView } from './GridView.tsx'
import {
  loadGrid, saveGrid, dropLeaf, resizeBranch,
  type GridNode, type GridSlot, type DropZone,
} from './grid.ts'
import css from './AppFrame.module.css'

/**
 * The floating-window target: the slot key this window should mount alone,
 * read once from `?floating=<slotKey>`. Null in the main window.
 */
function floatingSlotKey(): string | null {
  if (typeof window === 'undefined') return null
  const key = new URLSearchParams(window.location.search).get('floating')
  return key === null || key === '' ? null : key
}

/** The slots a floating window may mount. */
const FLOATABLE_SLOTS = new Set(['corum.sidebar', 'corum.editor', 'corum.explorer', 'corum.panel', 'corum.statusBar', 'conversation', 'details'])

/** The desktop preload bridge face this frame uses for floating windows. */
interface FloatingBridge {
  openFloating?: (slotKey: string) => Promise<unknown>
  onFloatingChange?: (cb: (slotKey: string, detached: boolean) => void) => () => void
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'conversation' | 'details' | 'shell.overlay' | 'sidebar.settings' | 'corum.sidebar' | 'corum.editor' | 'corum.explorer' | 'corum.tabStrip' | 'corum.panel' | 'corum.statusBar'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/**
 * One drag handle (bottom panel height seam), a faithful copy of VSCode's
 * Sash: mousedown on the handle, mousemove/mouseup on window, a temporary
 * global cursor/user-select stylesheet for the drag's length.
 */
function DragHandle(props: { side: string; axis?: 'x' | 'y'; left?: number; top?: number; onStart: () => void; onDrag: (delta: number) => void; onEnd: () => void }) {
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
    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', onMouseUp, true)
  }, [axis])

  const style: React.CSSProperties = axis === 'x' ? { left: props.left } : { top: props.top }
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
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own height (for the bottom panel seam position).
  useEffect(() => {
    const el = frameRef.current
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const height = el.getBoundingClientRect().height
        if (height > 0) setViewportHeight(height)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // ── 自由二维网格（GridView）──
  const [grid, setGrid] = useState<GridNode>(() => loadGrid())
  const onGridResize = useCallback((branchId: string, sashIndex: number, deltaFraction: number) => {
    setGrid((g) => {
      const next = resizeBranch(g, branchId, sashIndex, deltaFraction)
      saveGrid(next)
      return next
    })
  }, [])
  const onGridDrop = useCallback((sourceId: string, targetId: string, zone: DropZone) => {
    setGrid((g) => {
      const next = dropLeaf(g, sourceId, targetId, zone)
      saveGrid(next)
      return next
    })
  }, [])
  const renderGridSlot = useCallback((slot: GridSlot): ReactNode => {
    if (slot === 'corum.sidebar') {
      return renderSlot('corum.sidebar', { wide: true, width: 280, expandSidebar: () => { /* grid mode: rail fold N/A */ } })
    }
    return (renderSlot as (key: string, owner: Record<string, never>) => ReactNode)(slot, {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderSlot])
  const popOutSlot = useCallback((slot: GridSlot) => {
    const bridge = (window as unknown as { corumDesktop?: FloatingBridge }).corumDesktop
    void bridge?.openFloating?.(slot)
  }, [])

  // Detached slots: while popped out, the main window collapses that pane.
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
  const panelDetached = detached.has('corum.panel')

  // Bottom panel height seam.
  const bottomBase = useRef(0)
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onBottomStart = useCallback(() => { bottomBase.current = panelsRef.current.bottom; setDragging(true) }, [])
  const onBottomDrag = useCallback((dy: number) => {
    actions.setBottom(bottomBase.current - dy)
  }, [actions])
  const panelsRef = useRef(panels)
  panelsRef.current = panels

  const bottomOpen = panels.bottom > 0

  // ── Floating-window mode ──
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
      data-dragging={dragging || undefined}
    >
      {/* Main Row —— 自由二维网格（GridView）。 */}
      <div className={css.mainRow} data-gridview>
        <GridView
          root={grid}
          renderSlot={renderGridSlot}
          onResize={onGridResize}
          onDrop={onGridDrop}
          onPopOut={popOutSlot}
        />
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

      {/* Bottom panel height seam (vertical sash). */}
      {bottomOpen && (
        <DragHandle side="bottom" axis="y" top={viewportHeight - 34 - 14 - panels.bottom - 7} onStart={onBottomStart} onDrag={onBottomDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
