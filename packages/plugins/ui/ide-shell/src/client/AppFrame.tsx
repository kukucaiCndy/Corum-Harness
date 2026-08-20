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
import { GridView } from '@corum/shell-base/client'
import {
  loadGrid, saveGrid, dropLeaf, resizeBranch, findLeafBySlot, removeLeaf,
  rescaleGrid, setLeafHidden, hiddenSlots,
  slotsNotInGrid, addSlot, addSlotAt, getSlotMeta,
  CLOSE_REGION_EVENT, TOGGLE_SIDEBAR_EVENT,
  type GridNode, type GridSlot, type DropZone,
} from '@corum/shell-base/client'
import { IDE_GRID_STORAGE_KEY, IDE_TRANSPARENT_SLOTS, ideDefaultGrid } from './ide-layout.ts'
import css from './AppFrame.module.css'

/** IDE 布局持久化：绑定 IDE 存储 key 与默认布局（base 的 loadGrid/saveGrid 包装）。 */
const loadIdeGrid = (): GridNode => loadGrid(ideDefaultGrid, IDE_GRID_STORAGE_KEY)
const saveIdeGrid = (node: GridNode): void => saveGrid(node, IDE_GRID_STORAGE_KEY)

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

/** 槽位显示名：优先查注册表，找不到回退为 key 本身。 */
function slotLabel(slot: GridSlot): string {
  return getSlotMeta(slot)?.label ?? slot
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
              恢复 {slotLabel(slot)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 状态栏「添加区域」入口：列出不在网格中的槽位，可拖拽到网格或点击直接添加。
 *  列表为空时按钮不显示（所有可进网格的区域都已在网格中）。 */
function AddAreasPanel({ slots, onAdd, onDragStart }: {
  slots: GridSlot[]
  onAdd: (slot: GridSlot) => void
  onDragStart: (slot: GridSlot) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
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
    <div className={css.addAreas} ref={ref}>
      <button
        type="button"
        className={css.addAreasButton}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        title="添加区域到工作区"
      >
        添加区域 ▾
      </button>
      {open && (
        <div className={css.addAreasMenu} role="menu">
          {slots.map((slot) => (
            <div
              key={slot}
              className={css.addAreasItem}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('corum/new-slot', slot)
                e.dataTransfer.effectAllowed = 'copy'
                onDragStart(slot)
                setOpen(false)
              }}
              onClick={(e) => { e.stopPropagation(); onAdd(slot); setOpen(false) }}
              title={`拖到网格中放置，或点击添加到末尾`}
            >
              <span className={css.addAreasItemName}>{slotLabel(slot)}</span>
              <span className={css.addAreasItemSlot}>{slot}</span>
            </div>
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

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (grid rescale source).
  useEffect(() => {
    const el = frameRef.current
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const rect = el.getBoundingClientRect()
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
  // 工作台布局由 localStorage 持久化管理（combo 的插件集 / 启动参数由壳层
  // 进程级管理，不进入工作台 UI；combo 选择页在壳层）。
  const [grid, setGrid] = useState<GridNode>(() => loadIdeGrid())
  // 最新 grid 的镜像（事件桥等需要读最新树的回调用，避免闭包捕获过期值）。
  const gridRef = useRef<GridNode>(grid)
  gridRef.current = grid
  // saveGrid（JSON.stringify + setItem 同步阻塞主线程）在 sash 拖动/窗口
  // resize 的高频回调里会每帧跑——用 trailing debounce 落盘，UI 仍实时更新。
  const saveTimer = useRef<number | null>(null)
  const saveGridDebounced = useCallback((next: GridNode) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      saveIdeGrid(next)
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
      saveIdeGrid(next)
      return next
    })
  }, [])
  const updateGridTo = useCallback((next: GridNode) => {
    setGrid(next)
    saveIdeGrid(next)
  }, [])
  // 关闭某区域（hidden，树保留，持久化）；恢复 = setLeafHidden(false)。
  const onCloseSlot = useCallback((slot: GridSlot) => {
    setGrid((g) => {
      const next = setLeafHidden(g, slot, true)
      saveIdeGrid(next)
      return next
    })
  }, [])
  const onReopenSlot = useCallback((slot: GridSlot) => {
    setGrid((g) => {
      const next = setLeafHidden(g, slot, false)
      saveIdeGrid(next)
      return next
    })
  }, [])

  // 区域关闭桥：各区域工具组的「关闭区域」按钮 dispatch CLOSE_REGION_EVENT
  // （detail.slot = slot key），这里统一走 onCloseSlot 隐藏对应 leaf（树保留、
  // 持久化，可在状态栏「已关闭区域」恢复）。找不到对应 leaf 时告警（key 写错
  // 或区域已脱出），避免「点了没反应」无线索。
  useEffect(() => {
    const handler = (e: Event) => {
      const slot = (e as CustomEvent<{ slot?: string }>).detail?.slot
      if (typeof slot !== 'string' || slot === '') return
      if (findLeafBySlot(gridRef.current, slot) === null) {
        console.warn(`[ide-shell] close-region: no grid leaf for slot "${slot}" (typo or already detached)`)
        return
      }
      onCloseSlot(slot)
    }
    window.addEventListener(CLOSE_REGION_EVENT, handler)
    return () => window.removeEventListener(CLOSE_REGION_EVENT, handler)
  }, [onCloseSlot])

  // 侧栏显隐桥：官方插件的 ctx.layout.toggleSidebar() 经 TOGGLE_SIDEBAR_EVENT
  // 到达，这里切换 corum.sidebar leaf 的 hidden（折叠 ⟷ 展开）。
  useEffect(() => {
    const handler = () => {
      setGrid((g) => {
        const leaf = findLeafBySlot(g, 'corum.sidebar')
        const next = setLeafHidden(g, 'corum.sidebar', !(leaf?.hidden === true))
        saveIdeGrid(next)
        return next
      })
    }
    window.addEventListener(TOGGLE_SIDEBAR_EVENT, handler)
    return () => window.removeEventListener(TOGGLE_SIDEBAR_EVENT, handler)
  }, [])

  // 添加新区域（点击直接添加到末尾）。
  const onAddSlot = useCallback((slot: GridSlot) => {
    setGrid((g) => {
      const next = addSlot(g, slot)
      saveIdeGrid(next)
      return next
    })
  }, [])
  // 从面板拖入新区域到网格中某 leaf 的某侧。
  const onDropNewSlot = useCallback((slot: GridSlot, targetId: string, zone: DropZone) => {
    setGrid((g) => {
      const dropped = addSlotAt(g, slot, targetId, zone)
      const { width, height } = frameBox.current
      const next = width > 0 && height > 0 ? rescaleGrid(dropped, width, height) : dropped
      saveIdeGrid(next)
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
    // 通用渲染：交给框架的 slot 系统。未注册的 slot 返回 null → 显示空态。
    const content = (renderSlot as (key: string, owner: Record<string, never>) => ReactNode)(slot, {})
    if (content === null || content === false) {
      return (
        <div className={css.emptySlot}>
          <span className={css.emptySlotText}>{slot}</span>
          <span className={css.emptySlotHint}>此区域暂无内容</span>
        </div>
      )
    }
    return content
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
      // dock back（关闭浮动窗）时若该 leaf 曾被 hidden（detached 期间点了 ×），
      // 一并恢复显示——避免「detached + hidden」双隐藏导致区域彻底消失。
      if (!isDetached) {
        setGrid((g) => {
          const next = setLeafHidden(g, slotKey, false)
          saveIdeGrid(next)
          return next
        })
      }
    })
  }, [])

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
    >
      {/* Main Row —— 自由二维网格（GridView）。终端 corum.panel 已纳入网格
          （默认底部行），可调宽、可与其他区域自由组合，不再有固定底部条。 */}
      <div className={css.mainRow} data-gridview ref={mainRowRef}>
        <GridView
          root={grid}
          renderSlot={renderGridSlot}
          onResize={onGridResize}
          onDrop={onGridDrop}
          onPopOut={popOutSlot}
          onDropNewSlot={onDropNewSlot}
          detachedSlots={detached}
          transparentSlots={IDE_TRANSPARENT_SLOTS}
        />
      </div>

      {/* ⑦ 状态栏: 连接 · 项目 · 模型 (corum.statusBar slot) + 已关闭区域恢复 + 布局重置。 */}
      <div className={css.statusBar}>
        {renderSlot('corum.statusBar', {})}
        <AddAreasPanel slots={slotsNotInGrid(grid)} onAdd={onAddSlot} onDragStart={() => {}} />
        <ClosedAreasMenu slots={hiddenSlots(grid)} onReopen={onReopenSlot} />
        <button
          type="button"
          className={css.resetLayout}
          title="恢复默认四列布局"
          onClick={() => { updateGridTo(ideDefaultGrid()) }}
        >
          重置布局
        </button>
      </div>

      {/* 次侧栏: official ui-conversation DetailsPanel (on-demand drawer). */}
      {panels.details > 0
        ? (
          <>
            <div className={css.detailsBackdrop} onClick={() => actions.closeDetails()} />
            <div className={css.detailsCol} style={{ width: panels.details }} data-details>
              {renderSlot('details', {})}
            </div>
          </>
        )
        : null}

      {/* Frame-wide floating layer. */}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
