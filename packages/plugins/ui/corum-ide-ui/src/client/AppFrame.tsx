/**
 * IdeAppFrame —— IDE 壳，注册进内建 'root' 槽。
 *
 * 布局 = 自由二维网格（GridView）+ 壳层的 details 抽屉：
 *
 *   ┌ ── GridView（默认四列：sidebar │ conversation │ editor │ explorer）── ┐
 *   │   模块标题拖到另一模块四边拆分 / 中心交换；窗格间 sash 拖拽；            │
 *   │   布局树持久化 localStorage。                                          │
 *   └ bottom panel（终端/待办/队列，corum.panel 槽，已在网格内）─────────────┘
 *   └ details（官方 ui-conversation 抽屉，按需右侧覆盖）─────────────────────┘
 *
 * 纯组件：一切经框架三份 share（runtime / render-slot / store）到达，不 import
 * cordis 或框架。几何求解已迁到 GridView 的分割树（grid.ts）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'
import { Blocks, Columns2, Moon, PanelLeftClose, PanelLeftOpen, Sun, Terminal } from 'lucide-react'
import { GridView } from '@corum/corum-ui-base/client'
import {
  loadGrid, saveGrid, dropLeaf, resizeBranch, findLeafBySlot,
  rescaleGrid, setLeafHidden, addSlotAt, hiddenSlots,
  CLOSE_REGION_EVENT, TOGGLE_SIDEBAR_EVENT, SET_REGION_HIDDEN_EVENT,
  RESET_LAYOUT_EVENT,
  FloatingLayer, useFloatingLayer,
  type GridNode, type GridSlot, type DropZone,
} from '@corum/corum-ui-base/client'
import { IDE_GRID_STORAGE_KEY, IDE_TRANSPARENT_SLOTS, ideDefaultGrid } from './ide-layout.ts'
import { PluginManagerPanel } from './PluginManagerPanel.tsx'
import css from './AppFrame.module.css'

/** 插件中心 FloatingLayer 项 id（重复打开同 id = 替换并置顶）。 */
const PLUGIN_MANAGER_FLOATING_ID = 'corum.pluginManager'

// ── FloatingLayer 单例桥 ──
// AppFrame 组件树里 <FloatingLayer /> 是标题栏触发器的 sibling（Provider 在
// AppFrame 内部，标题栏拿不到 context）。但 openFloating/closeFloating 是
// FloatingLayer 内稳定的 useCallback（空依赖），提升为模块级单例供 AppFrame
// 使用；FloatingLayer 挂载时回填。应用只有一个 FloatingLayer，单例安全。
import type { FloatingLayerApi } from '@corum/corum-ui-base/client'
let floatingApiSingleton: FloatingLayerApi | null = null

/** 主题偏好（三态）。 */
type ThemePreference = 'light' | 'dark' | 'system'

/** 标题栏小图标按钮（design.pen titlebar-icon-btn CXMkA）：28×28 圆角 8，icon 13。 */
function NavIconButton({ icon, label, onClick, active }: {
  icon: ReactNode
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      className={css.navIconBtn}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-active={active || undefined}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

/**
 * 左列导航标题栏（design.pen「窗口标题栏」d8STsd，40px）：窗口不再有通栏
 * 标题栏，本栏放进左列 nav 顶部——左侧 84px 给 macOS 红绿灯让位（整行
 * app-region:drag），右侧一排图标按钮（no-drag）：折叠侧栏 / 切换编辑器+
 * 资源管理器 / 切换终端 / 插件中心 / 主题（浅↔深）/ 设置。设置触发器渲染
 * sidebar.settings 槽（SettingsShell 触发器+面板一体，面板 portal 到 body）。
 */
function NavTitleBar({ themePreference, onToggleTheme, onToggleSidebar, onTogglePanels, onToggleTerminal, onOpenPlugins, sidebarCollapsed, settingsSlot }: {
  themePreference: ThemePreference
  onToggleTheme: () => void
  onToggleSidebar: () => void
  onTogglePanels: () => void
  onToggleTerminal: () => void
  onOpenPlugins: () => void
  sidebarCollapsed: boolean
  settingsSlot: ReactNode
}) {
  const isDark = themePreference === 'dark'
  return (
    <div className={css.navTitleBar}>
      {/* 红绿灯让位 84px（系统圆点由 titleBarStyle:hiddenInset 保留，不自绘）。 */}
      <span className={css.navTitleBarInset} />
      <div className={css.navTitleBarActions}>
        <NavIconButton
          icon={sidebarCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
          label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
          onClick={onToggleSidebar}
        />
        <NavIconButton icon={<Columns2 size={13} />} label="显示/隐藏 编辑器+资源管理器" onClick={onTogglePanels} />
        <NavIconButton icon={<Terminal size={13} />} label="显示/隐藏 终端" onClick={onToggleTerminal} />
        <NavIconButton icon={<Blocks size={13} />} label="插件中心" onClick={onOpenPlugins} />
        <NavIconButton
          icon={isDark ? <Sun size={13} /> : <Moon size={13} />}
          label={isDark ? '切换到浅色主题' : '切换到深色主题'}
          onClick={onToggleTheme}
          active={isDark}
        />
        {/* 设置触发器（sidebar.settings 槽）：覆盖宽按钮样式为小图标按钮。 */}
        <span className={css.navSettingsSeat}>{settingsSlot}</span>
      </div>
    </div>
  )
}

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
const FLOATABLE_SLOTS = new Set(['corum.sidebar', 'corum.editor', 'corum.explorer', 'corum.panel', 'conversation', 'details'])

/** The desktop preload bridge face this frame uses for floating windows. */
interface FloatingBridge {
  openFloating?: (slotKey: string) => Promise<unknown>
  onFloatingChange?: (cb: (slotKey: string, detached: boolean) => void) => () => void
}

/** 浮动窗的 Window Chrome 顶栏（系统拖拽区，app-region:drag）。 */
function FloatingChrome({ slotKey }: { slotKey: string }) {
  return (
    <div className={css.windowChrome}>
      {/* 系统红黄绿圆点由 titleBarStyle:'hidden' 保留在左上角，这里给它让位，
          不自绘（否则重叠）。标题/提示右移避开。 */}
      <span className={css.chromeTitle}>{slotKey}</span>
      <span className={css.chromeHint}>浮动窗 · 关闭即回到主窗口</span>
    </div>
  )
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'conversation' | 'details' | 'shell.overlay' | 'sidebar.settings' | 'corum.sidebar' | 'corum.editor' | 'corum.explorer' | 'corum.tabStrip' | 'corum.panel'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & {
    /** 主题偏好选择器 hook（inject hooks.theme 绑定而来，selector 形式）。 */
    useTheme: <S>(sel: (p: ThemePreference) => S, eq?: (a: S, b: S) => boolean) => S
    /** 主题偏好写入（直通 theme 服务）。 */
    setTheme: (p: ThemePreference) => void
  }

/** The IDE frame (see module doc). */
export function IdeAppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  useTheme,
  setTheme,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const themePreference = useTheme((p) => p)
  const frameRef = useRef<HTMLDivElement | null>(null)
  // 网格变更订阅：插件中心面板的区域显隐列经 useSyncExternalStore 读
  // gridRef 投影；任何隐藏相关变更后调 notifyGridListeners() 刷新。
  const notifyGridListeners = useRef<() => void>(() => {})

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
    notifyGridListeners.current()
  }, [])
  // 关闭某区域（hidden，树保留，持久化）。
  const onCloseSlot = useCallback((slot: GridSlot) => {
    setGrid((g) => {
      const next = setLeafHidden(g, slot, true)
      saveIdeGrid(next)
      return next
    })
    notifyGridListeners.current()
  }, [])

  // 区域显隐桥：插件中心等有 UI 插件的「显示/隐藏区域」切换 dispatch
  // SET_REGION_HIDDEN_EVENT（detail = { slot, hidden }），这里统一走
  // setLeafHidden（树保留、持久化）。网格中尚无该 slot 的 leaf 时告警。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ slot?: string; hidden?: boolean }>).detail
      if (typeof detail?.slot !== 'string' || detail.slot === '') return
      const hidden = detail.hidden === true
      if (findLeafBySlot(gridRef.current, detail.slot) === null) {
        console.warn(`[ide-shell] set-region-hidden: no grid leaf for slot "${detail.slot}" (typo or already detached)`)
        return
      }
      setGrid((g) => {
        const next = setLeafHidden(g, detail.slot as string, hidden)
        saveIdeGrid(next)
        return next
      })
      notifyGridListeners.current()
    }
    window.addEventListener(SET_REGION_HIDDEN_EVENT, handler)
    return () => window.removeEventListener(SET_REGION_HIDDEN_EVENT, handler)
  }, [])

  // 区域关闭桥：各区域工具组的「关闭区域」按钮 dispatch CLOSE_REGION_EVENT
  // （detail.slot = slot key），这里统一走 onCloseSlot 隐藏对应 leaf（树保留、
  // 持久化）。找不到对应 leaf 时告警（key 写错或区域已脱出），避免「点了没
  // 反应」无线索。
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

  // 区域显隐切换（供左列标题栏图标按钮）：toggle 一组 slot 的 hidden。
  // 整组「任一可见 → 全隐藏；全隐藏 → 全显示」，保证编辑器+资源管理器成组、
  // 终端/侧栏单独切换的语义统一。
  const toggleSlotsHidden = useCallback((slots: readonly GridSlot[]) => {
    setGrid((g) => {
      const anyVisible = slots.some((s) => {
        const leaf = findLeafBySlot(g, s)
        return leaf !== null && leaf.hidden !== true
      })
      let next = g
      for (const s of slots) next = setLeafHidden(next, s, anyVisible)
      saveIdeGrid(next)
      return next
    })
    notifyGridListeners.current()
  }, [])
  // 侧栏折叠：leaf 不 hidden（hidden 会把左列导航标题栏一起藏掉，无法展开），
  // 而是 leaf 内部的「卡片内容」折叠——leaf 保留（宽度收窄为标题栏宽），
  // 标题栏常驻、卡片内容按 collapsed 渲染/隐藏。状态独立于网格 hidden。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const onToggleSidebar = useCallback(() => { setSidebarCollapsed(c => !c) }, [])
  const onTogglePanels = useCallback(() => { toggleSlotsHidden(['corum.editor', 'corum.explorer']) }, [toggleSlotsHidden])
  const onToggleTerminal = useCallback(() => { toggleSlotsHidden(['corum.panel']) }, [toggleSlotsHidden])
  // 主题两态切换（浅↔深；system 态下按深处理，点击回浅色）。
  const onToggleTheme = useCallback(() => {
    setTheme(themePreference === 'dark' ? 'light' : 'dark')
  }, [setTheme, themePreference])

  // 布局重置桥：视图菜单「重置布局」dispatch RESET_LAYOUT_EVENT，这里按当前
  // frame 尺寸重算默认布局并持久化（等价初次启动的几何）。
  useEffect(() => {
    const handler = () => {
      const { width, height } = frameBox.current
      const next = width > 0 && height > 0 ? rescaleGrid(ideDefaultGrid(), width, height) : ideDefaultGrid()
      setGrid(next)
      saveIdeGrid(next)
      notifyGridListeners.current()
    }
    window.addEventListener(RESET_LAYOUT_EVENT, handler)
    return () => window.removeEventListener(RESET_LAYOUT_EVENT, handler)
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
  // 直接测 mainRow（网格的真实容器）——它已扣掉 frame padding 与纵向
  // gap；测 frame 再手扣会把 frame padding 算进网格高度，上下 split
  // （column 分支）时下方窗格会被 frame 的 overflow 裁掉。
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

  // 插件中心面板的区域显隐投影：hidden 槽位集合（读最新 gridRef，供
  // PluginManagerPanel 的 useSyncExternalStore）。setGrid 后通知订阅者。
  const gridListeners = useRef(new Set<() => void>())
  const gridSubscribe = useCallback((listener: () => void) => {
    gridListeners.current.add(listener)
    return () => { gridListeners.current.delete(listener) }
  }, [])
  // uSES 快照缓存：hiddenSlots 每次新建数组会导致 getSnapshot 引用不稳
  // （React #185 无限重渲染）。按 gridRef 引用缓存，同一网格树复用同一快照。
  const hiddenCache = useRef<{ grid: GridNode | null; snap: readonly string[] }>({ grid: null, snap: Object.freeze([]) })
  const getHiddenSnapshot = useCallback((): readonly string[] => {
    const g = gridRef.current
    if (hiddenCache.current.grid !== g) {
      hiddenCache.current = { grid: g, snap: Object.freeze(hiddenSlots(g)) }
    }
    return hiddenCache.current.snap
  }, [])

  // 插件中心：FloatingLayer 注册式打开（modal）。面板的区域显隐投影接
  // 上面的 grid 订阅/快照源。
  // 注意：AppFrame 在 FloatingLayer Provider 之外，useFloatingLayer() 恒为
  // null；这里用模块级单例（FloatingLayer 挂载时回填，见组件末尾）。
  const openPluginManager = useCallback(() => {
    floatingApiSingleton?.openFloating({
      id: PLUGIN_MANAGER_FLOATING_ID,
      content: (
        <PluginManagerPanel
          subscribeGrid={gridSubscribe}
          getHiddenSnapshot={getHiddenSnapshot}
          isRegionSlot={(slot) => findLeafBySlot(gridRef.current, slot) !== null}
          onClose={() => floatingApiSingleton?.closeFloating(PLUGIN_MANAGER_FLOATING_ID)}
        />
      ),
      modal: true,
    })
  }, [gridSubscribe, getHiddenSnapshot])

  const renderGridSlot = useCallback((slot: GridSlot): ReactNode => {
    if (slot === 'corum.sidebar') {
      // 左列（design.pen col-nav）：顶部是左列导航标题栏（红绿灯让位 + 图标按钮，
      // 卡片外、贴左列顶），下接侧栏玻璃卡（项目/任务双模式）。折叠时标题栏常驻、
      // 卡片内容隐藏（leaf 保留，宽度由 GridView 的 minWidth 兜底，不整列 hidden）。
      return (
        <div className={css.navCol} data-collapsed={sidebarCollapsed || undefined}>
          <NavTitleBar
            themePreference={themePreference}
            onToggleTheme={onToggleTheme}
            onToggleSidebar={onToggleSidebar}
            onTogglePanels={onTogglePanels}
            onToggleTerminal={onToggleTerminal}
            onOpenPlugins={openPluginManager}
            sidebarCollapsed={sidebarCollapsed}
            settingsSlot={renderSlot('sidebar.settings', { wide: false })}
          />
          <div className={css.sidebarPane} data-collapsed={sidebarCollapsed || undefined}>
            <div className={css.sidebarPaneBody}>
              {renderSlot('corum.sidebar', { wide: true, width: 280, expandSidebar: () => { /* grid mode: rail fold N/A */ } })}
            </div>
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
  }, [renderSlot, themePreference, onToggleTheme, onToggleSidebar, onTogglePanels, onToggleTerminal, openPluginManager, sidebarCollapsed])
  const popOutSlot = useCallback((slot: GridSlot) => {
    const bridge = (window as unknown as { corumDesktop?: FloatingBridge }).corumDesktop
    void bridge?.openFloating?.(slot)
  }, [])

  // Detached slots（脱出到浮动窗）。**关键：脱出只是运行时状态，不动网格树、
  // 不写持久化**——树始终保持完整（所有槽位都在），下次启动布局原样恢复。
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
        notifyGridListeners.current()
      }
    })
  }, [])

  // ── Floating-window mode ──
  const floatKey = floatingSlotKey()
  if (floatKey !== null) {
    const mountable = FLOATABLE_SLOTS.has(floatKey)
    return (
      <div className={css.floatingRoot} data-floating={floatKey}>
        <FloatingChrome slotKey={floatKey} />
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
      {/* 窗口无通栏标题栏（design.pen 2026-08-26 布局调整）：标题栏收进左列
          nav 顶部（renderGridSlot 的 corum.sidebar 分支渲染 NavTitleBar），
          右侧主内容顶到窗口顶。原菜单组（文件/编辑/视图/插件/帮助）全部砍掉，
          功能迁移到左列标题栏图标按钮。 */}

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

      {/* Frame-wide floating layer (shell.overlay, 帧内浮层). */}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>

      {/* 全应用级悬浮层：未来的应用内通知 / 对话框（注册式）。portal 到
          document.body，脱离网格/卡片的 transform 与裁剪。设置面板已改由
          SettingsShell 自带 createPortal，不再经此层。 */}
      <FloatingLayer>
        {/* 回填模块级单例：AppFrame 在 Provider 外拿不到 useFloatingLayer，
            经桥接子组件（Provider 内）把稳定 API 写入单例供菜单用。 */}
        <FloatingApiBridge />
      </FloatingLayer>
    </div>
  )
}

/** Provider 内的桥接子组件：把 FloatingLayer API 回填到模块级单例。 */
function FloatingApiBridge() {
  const api = useFloatingLayer()
  useEffect(() => {
    floatingApiSingleton = api
    return () => { floatingApiSingleton = null }
  }, [api])
  return null
}
