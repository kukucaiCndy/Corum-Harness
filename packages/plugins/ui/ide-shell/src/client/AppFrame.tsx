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
  loadGrid, saveGrid, dropLeaf, resizeBranch, defaultGrid, findLeafBySlot, removeLeaf,
  pathOfLeaf, insertLeafAtPath, rescaleGrid, setLeafHidden, hiddenSlots, type LeafPath,
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

/** 槽位 → 中文名（与 GridView 的 SLOT_TITLES ��齐）。 */
const SLOT_LABELS: Record<GridSlot, string> = {
  'corum.sidebar': '会话列表',
  'conversation': '对话区',
  'corum.editor': '编辑器',
  'corum.explorer': '资源管理器',
  'corum.panel': '底部面板',
  'corum.statusBar': '状态栏',
}

/** 状态栏「已关闭区域」恢复入口：有关闭区域时显示一个下拉，点击恢复。 */
function ClosedAreasMenu({ slots, onReopen }: { slots: GridSlot[]; onReopen: (slot: GridSlot) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  // 「点击外部关闭」：菜单打开时挂 document click 监听。按钮 onClick 已
  // stopPropagation，所以打开菜单的那次 click 不会触发这里；点菜单外才关。
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [open])
  if (slots.length === 0) return null
  return (
    <div className={css.closedAreas} ref={ref}>
      <button
        type="button"
        className={css.closedAreasButton}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        title="已关闭的区域（点击恢复显示）"
      >
        已关闭 {slots.length} 个区域 ▴
      </button>
      {open && (
        <div className={css.closedAreasMenu} role="menu">
          {slots.map((slot) => (
            <button
              key={slot}
              type="button"
              className={css.closedAreasItem}
              onClick={(e) => { e.stopPropagation(); onReopen(slot); setOpen(false) }}
            >
              恢复 {SLOT_LABELS[slot] ?? slot}
            </button>
          ))}
        </div>
      )}
    </div>
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

  // Track the frame's own box (for the bottom panel seam + grid rescale).
  useEffect(() => {
    const el = frameRef.current
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const rect = el.getBoundingClientRect()
        if (rect.height > 0) setViewportHeight(rect.height)
        frameBox.current = { width: Math.round(rect.width), height: Math.round(rect.height) }
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])
  const frameBox = useRef({ width: 0, height: 0 })

  // ── 自由二维网格（GridView）──
  const [grid, setGrid] = useState<GridNode>(() => loadGrid())
  // saveGrid（JSON.stringify + setItem 同步阻塞主线程）在 sash 拖动/窗口
  // resize 的高频回调里会每帧跑——用 trailing debounce 落盘，UI 仍实时更新。
  const saveTimer = useRef<number | null>(null)
  const saveGridDebounced = useCallback((next: GridNode) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      saveGrid(next)
    }, 300)
  }, [])
  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
  }, [])
  const onGridResize = useCallback((branchId: string, sashIndex: number, deltaFraction: number) => {
    setGrid((g) => {
      const next = resizeBranch(g, branchId, sashIndex, deltaFraction)
      saveGridDebounced(next)
      return next
    })
  }, [saveGridDebounced])
  const onGridDrop = useCallback((sourceId: string, targetId: string, zone: DropZone) => {
    setGrid((g) => {
      // drop 可能包壳新分支（weights 暂为占位值）——drop 后立即按当前 frame
      // 尺寸重标定，让所有 weights 归一到合法像素，避免新格塌陷成 1px。
      const dropped = dropLeaf(g, sourceId, targetId, zone)
      const { width, height } = frameBox.current
      const next = width > 0 && height > 0 ? rescaleGrid(dropped, width, height) : dropped
      saveGrid(next)
      return next
    })
  }, [])
  const updateGridTo = useCallback((next: GridNode) => {
    setGrid(next)
    saveGrid(next)
  }, [])
  // 关闭某区域（hidden，树保留，持久化）；恢复 = setLeafHidden(false)。
  const onCloseSlot = useCallback((slot: GridSlot) => {
    setGrid((g) => {
      const next = setLeafHidden(g, slot, true)
      saveGrid(next)
      return next
    })
  }, [])
  const onReopenSlot = useCallback((slot: GridSlot) => {
    setGrid((g) => {
      const next = setLeafHidden(g, slot, false)
      saveGrid(next)
      return next
    })
  }, [])

  // 窗口尺寸变化时按比例重标定网格（自适应，不截断）。等比缩放各列。
  // 直接测 mainRow（网格的真实容器）——它已扣掉 frame padding、底部面板、
  // 状态栏与纵向 gap；测 frame 再手扣会把底部面板/状态栏算进网格高度，
  // 上下 split（column 分支）时下方窗格会被 frame 的 overflow 裁掉。
  const mainRowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = mainRowRef.current
    if (el === null) return
    let raf: number | null = null
    let lastW = 0
    let lastH = 0
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const rect = el.getBoundingClientRect()
        const w = Math.round(rect.width)
        const h = Math.round(rect.height)
        if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
          lastW = w
          lastH = h
          frameBox.current = { width: w, height: h }
          setGrid((g) => {
            const next = rescaleGrid(g, w, h)
            saveGridDebounced(next)
            return next
          })
        }
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [saveGridDebounced])
  const renderGridSlot = useCallback((slot: GridSlot): ReactNode => {
    if (slot === 'corum.sidebar') {
      // 会话列表窗格：内容 + 底部设置座（ui-settings-general，原 sidebar 列底）。
      return (
        <div className={css.sidebarPane}>
          <div className={css.sidebarPaneBody}>
            {renderSlot('corum.sidebar', { wide: true, width: 280, expandSidebar: () => { /* grid mode: rail fold N/A */ } })}
          </div>
          <div className={css.sidebarPaneFoot}>
            {renderSlot('sidebar.settings', { wide: true })}
          </div>
        </div>
      )
    }
    return (renderSlot as (key: string, owner: Record<string, never>) => ReactNode)(slot, {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderSlot])
  const popOutSlot = useCallback((slot: GridSlot) => {
    const bridge = (window as unknown as { corumDesktop?: FloatingBridge }).corumDesktop
    void bridge?.openFloating?.(slot)
  }, [])

  // Detached slots（脱出到浮动窗）。**关键：脱出只是运行时状态，不动网格树、
  // 不写持久化**——树始终保持完整（所有槽位都在），下次启动布局原样恢复。
  // 脱出的 leaf 运行时在 GridView 里隐藏（列收起、相邻填满）；dock back / 关闭
  // 浮动窗时取消隐藏。这样重启后任何区域都不会「丢」。
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
          {/* 系统红黄绿圆点由 titleBarStyle:'hidden' 保留在左上角，这里给它让位，
              不自绘（否则重叠）。标题/提示右移避开。 */}
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
      <div className={css.mainRow} data-gridview ref={mainRowRef}>
        <GridView
          root={grid}
          renderSlot={renderGridSlot}
          onResize={onGridResize}
          onDrop={onGridDrop}
          onPopOut={popOutSlot}
          onClose={onCloseSlot}
          detachedSlots={detached}
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

      {/* ⑦ 状态栏: 连接 · 项目 · 模型 (corum.statusBar slot) + 已关闭区域恢复 + 布局重置。 */}
      <div className={css.statusBar}>
        {renderSlot('corum.statusBar', {})}
        <ClosedAreasMenu slots={hiddenSlots(grid)} onReopen={onReopenSlot} />
        <button
          type="button"
          className={css.resetLayout}
          title="恢复默认四列布局"
          onClick={() => { updateGridTo(defaultGrid()) }}
        >
          重置布局
        </button>
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
