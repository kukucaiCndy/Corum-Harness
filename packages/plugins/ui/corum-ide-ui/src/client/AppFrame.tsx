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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls `useSessions` into GlobalStandardProps (0.1.2 起由 ui-session 声明)。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { createLayoutStore } from './stores.ts'
import { Blocks, Columns2, FolderPlus, MessageCirclePlus, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, Terminal } from 'lucide-react'
import { GridView } from '@corum/corum-ui-base/client'
import {
  loadGrid, saveGrid, dropLeaf, resizeBranch, findLeafBySlot,
  rescaleGrid, setLeafHidden, addSlotAt, hiddenSlots, setSlotCollapsed,
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

/**
 * 标题栏让位（design.pen L1：主窗口边距=0、titlebar-row 与 col-nav 间距=0）：
 * root row 的 sidebar/conversation 格内容顶部下移让位标题栏浮层；right-col 格
 * offset=0 顶到窗口顶（编辑器/资源管理器/终端上方无标题栏、贴窗口顶）。
 * 取值 = 标题栏底(40) + 卡片间距(0) − frame padding-top(0) = 40px：卡片顶落在
 * 40（= frame padding 0 + clearance 40），标题栏底到卡片间距恰为 0（设计稿
 * left-col 无 gap、left-body 无 padding；2026-08-27 用户指出间距过大 + 主窗口边距改 0）。
 * 沿 root row 的格序（sidebar, conversation, right-col）。
 */
const TITLEBAR_CLEARANCE: readonly number[] = [40, 40, 0]

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
      {/* 红绿灯让位 76px（系统圆点由 titleBarStyle:hiddenInset 保留，不自绘）。
          折叠态（design J0PbdL）：窗口标题栏缩 66 只留红绿灯，actions 全隐藏
          （各功能移到 56px 折叠轨）。 */}
      <span className={css.navTitleBarInset} />
      {!sidebarCollapsed && (
      <div className={css.navTitleBarActions}>
        {/* design.pen titlebar-actions 顺序：侧栏 / 面板 / 终端 / 主题 / 设置 / 插件。
            图标 18×18（design 2026-08-28 统一放大）、按钮 padding 5（28×28）；插件中心是带文字按钮（最后）。 */}
        <NavIconButton
          icon={<PanelLeftClose size={18} />}
          label="折叠侧栏"
          onClick={onToggleSidebar}
        />
        <NavIconButton icon={<Columns2 size={18} />} label="显示/隐藏 编辑器+资源管理器" onClick={onTogglePanels} />
        <NavIconButton icon={<Terminal size={18} />} label="显示/隐藏 终端" onClick={onToggleTerminal} />
        <NavIconButton
          icon={isDark ? <Moon size={18} /> : <Sun size={18} />}
          label={isDark ? '切换到浅色主题' : '切换到深色主题'}
          onClick={onToggleTheme}
          active={isDark}
        />
        {/* 设置触发器（sidebar.settings 槽）：覆盖宽按钮样式为小图标按钮。 */}
        <span className={css.navSettingsSeat}>{settingsSlot}</span>
        {/* 插件中心（design.pen action-插件中心 jyVpw）：blocks 18 + 「插件」文字 14px。 */}
        <button type="button" className={css.navPluginBtn} onClick={onOpenPlugins} title="插件中心" aria-label="插件中心">
          <Blocks size={18} />
          <span className={css.navPluginLabel}>插件</span>
        </button>
      </div>
      )}
    </div>
  )
}

/**
 * Agent 标题栏（design.pen b4p03B，36px）：顶部贯通标题栏的右段——当前会话的
 * 标题 + 分隔线 + 状态胶囊（轮次/耗时/token/命中率 + chevron）+ spacer + 轨迹
 * 按钮（activity）。结构对齐设计稿，数据暂用假数据（同对话区 Convo Header），
 * 真实会话标题/统计待后续接。整段在 titlebar-row 的 .titlebarDrag 段内——
 * 根容器整段 app-region:drag（空白处拖窗口），内部文字/状态胶囊/轨迹按钮各自
 * no-drag（文字可选、按钮可点）；spacer 无声明、落入根 drag 命中区（可拖）。
 */
function AgentTitleBar({ sessionTitle }: { sessionTitle?: string | undefined }) {
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const title = sessionTitle || '新会话'

  // 标题溢出检测（字号/内容/宽度变化时重测）。用 useLayoutEffect 在 paint 前
  // 同步测量——避免「旧 overflowing=true + 新标题」先渲染一帧跑马灯双份文本。
  useLayoutEffect(() => {
    const el = titleRef.current
    if (el === null) return
    const measure = (): void => { setOverflowing(el.scrollWidth > el.clientWidth + 1) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [title])

  return (
    <div className={css.agentTitleBar}>
      <span
        ref={titleRef}
        className={`${css.agentTitle}${overflowing ? ` ${css.agentTitleMarquee}` : ''}`}
        title={title}
      >
        {overflowing ? (
          /* 跑马灯：滚动轨双份文本无缝循环（平移 -50% = 一份+间隔宽）。 */
          <span className={css.marqueeTrack}>
            <span className={css.marqueeChunk}>{title}</span>
            <span className={css.marqueeChunk} aria-hidden="true">{title}</span>
          </span>
        ) : (
          title
        )}
      </span>
      <span className={css.agentDivider} />
      <span className={css.agentStatusPill}>
        {/* design.pen status-pill：$state-success 状态点 6×6 + stats + chevron。 */}
        <span className={css.agentStatusDot} />
        <span className={css.agentStats}>7 轮 · 12m 34s · In 12.4k / Out 3.1k · 命中 61%</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={css.agentChev}><path d="m6 9 6 6 6-6" /></svg>
      </span>
      <span className={css.agentSpacer} />
      <button type="button" className={css.agentTrajBtn} title="轨迹">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
      </button>
    </div>
  )
}

/**
 * 侧栏折叠轨（design.pen L1 侧栏折叠态 J0PbdL 的 col-nav，56px 竖排图标栏）：
 * 侧栏被 GridView 收成 collapsedWidth=56 时 leaf 内渲染此轨，替代完整会话
 * 列表。按钮自上而下（design col-nav 9 钮）：
 *   展开侧栏 / 新会话 / 添加工作区 / 搜索 / 编辑器+资源管理器 / 终端 /
 *   插件 / 主题 / 设置。
 * 语义：前三个（新会话/添加工作区/搜索）是侧栏功能——折叠态点击 = 先展开
 * 侧栏（展开后对应功能在会话列表可用）；后五个直通 AppFrame 层动作。
 */
function SidebarRail({ onExpand, onTogglePanels, onToggleTerminal, onOpenPlugins, themePreference, onToggleTheme, settingsSlot }: {
  onExpand: () => void
  onTogglePanels: () => void
  onToggleTerminal: () => void
  onOpenPlugins: () => void
  themePreference: ThemePreference
  onToggleTheme: () => void
  settingsSlot: ReactNode
}) {
  const isDark = themePreference === 'dark'
  return (
    <div className={css.sidebarRail} role="toolbar" aria-label="侧栏（已折叠）" aria-orientation="vertical">
      {/* design y2rO2 btn-toggle：展开侧栏。 */}
      <button type="button" className={css.railBtn} title="展开侧栏" aria-label="展开侧栏" onClick={onExpand}>
        <PanelLeftOpen size={18} strokeWidth={2} />
      </button>
      {/* design YQ7Gd btn-new-session：新会话（折叠态 = 展开侧栏后新建）。 */}
      <button type="button" className={css.railBtn} title="新会话" aria-label="新会话" onClick={onExpand}>
        <MessageCirclePlus size={18} strokeWidth={2} />
      </button>
      {/* design DLZas btn-add-workspace：添加工作区（折叠态 = 展开侧栏）。 */}
      <button type="button" className={css.railBtn} title="添加工作区" aria-label="添加工作区" onClick={onExpand}>
        <FolderPlus size={18} strokeWidth={2} />
      </button>
      {/* design TMy4U btn-search：搜索（折叠态 = 展开侧栏）。 */}
      <button type="button" className={css.railBtn} title="搜索会话" aria-label="搜索会话" onClick={onExpand}>
        <Search size={18} strokeWidth={2} />
      </button>
      {/* design esTr5 btn-panels：显示/隐藏 编辑器+资源管理器。 */}
      <button type="button" className={css.railBtn} title="显示/隐藏 编辑器+资源管理器" aria-label="显示/隐藏 编辑器+资源管理器" onClick={onTogglePanels}>
        <Columns2 size={18} strokeWidth={2} />
      </button>
      {/* design iGETA btn-terminal：显示/隐藏 终端。 */}
      <button type="button" className={css.railBtn} title="显示/隐藏 终端" aria-label="显示/隐藏 终端" onClick={onToggleTerminal}>
        <Terminal size={18} strokeWidth={2} />
      </button>
      {/* design hNNOS btn-plugin：插件中心。 */}
      <button type="button" className={css.railBtn} title="插件中心" aria-label="插件中心" onClick={onOpenPlugins}>
        <Blocks size={18} strokeWidth={2} />
      </button>
      {/* design e4enT btn-theme：主题切换。 */}
      <button type="button" className={css.railBtn} title={isDark ? '切换到浅色主题' : '切换到深色主题'} aria-label="切换主题" aria-pressed={isDark} onClick={onToggleTheme}>
        {isDark ? <Moon size={18} strokeWidth={2} /> : <Sun size={18} strokeWidth={2} />}
      </button>
      {/* design ADqDw btn-settings：设置（sidebar.settings 槽触发器座位）。 */}
      <span className={css.railSettingsSeat}>{settingsSlot}</span>
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
    /** pluginManager 命名空间的 RPC caller（0.1.2 起走官方 connection.rpc；插件中心面板用）。 */
    callPluginManager: <T>(method: string, args: Record<string, unknown>) => Promise<T>
  }

/** The IDE frame (see module doc). */
export function IdeAppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  useTheme,
  setTheme,
  callPluginManager,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  // 获取当前会话标题（用于 Agent 标题栏）
  const currentSessionTitle = useSessions((s) => {
    const current = s.current
    if (current === undefined) return undefined
    const session = s.byId[current]
    return session?.displayTitle || (session?.blank === true ? '新会话' : undefined)
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
  // 侧栏折叠（2026-08-28 重实现，design L1 侧栏折叠态 J0PbdL）：GridView 把
  // sidebar leaf 收成 56px 图标轨（collapsedWidth），leaf 内容换成竖排图标栏
  // （含展开按钮）。grid.ts 的 setSlotCollapsed 同步运行时折叠态——leafMinSize
  // 取 56，窗口自适应/sash 传导不会把侧栏拉回 300。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const onToggleSidebar = useCallback(() => {
    setSidebarCollapsed(c => {
      const next = !c
      setSlotCollapsed('corum.sidebar', next)
      return next
    })
  }, [])
  // 传给 GridView 的折叠槽位集（useMemo 稳引用，折叠时才含 sidebar）。
  const COLLAPSED_SIDEBAR = useMemo<ReadonlySet<string>>(
    () => (sidebarCollapsed ? new Set(['corum.sidebar']) : new Set()),
    [sidebarCollapsed],
  )
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

  // 标题栏行只覆盖左列（design.pen：titlebar-row 是 left-col 的第一个子节点，
  // 压在 sidebar+conversation 上方；right-col 编辑器/资源管理器/终端顶到窗口顶，
  // 其上方无标题栏）。标题栏行 = absolute 浮层：窗口标题栏跟随侧栏右缘、Agent
  // 标题栏覆盖对话区正上方。侧栏/对话区列宽随 GridView 动态变化（sash 拖拽/
  // 折叠/窗口 resize），这里测量两者的实际几何驱动对齐。
  const [sidebarRight, setSidebarRight] = useState(296)
  const [convoBox, setConvoBox] = useState({ x: 310, width: 0 })
  useEffect(() => {
    let raf: number | null = null
    const measure = () => {
      raf = null
      // 量 GridView 的格（branchCell，宽度=列宽），不量 leaf（leaf 现已被
      // leafTopOffset 下移让位标题栏，其 getBoundingClientRect 的 top 不是列顶）。
      // branchCell 是 .leaf 的父格——用 leaf 上溯一层命中。
      const sidebarLeaf = document.querySelector('[data-slot="corum.sidebar"]')
      const convoLeaf = document.querySelector('[data-slot="conversation"]')
      const sidebar = sidebarLeaf?.parentElement ?? null
      const convo = convoLeaf?.parentElement ?? null
      if (sidebar !== null) setSidebarRight(Math.round(sidebar.getBoundingClientRect().right))
      if (convo !== null) {
        const b = convo.getBoundingClientRect()
        setConvoBox({ x: Math.round(b.x), width: Math.round(b.width) })
      }
    }
    const schedule = () => { raf ??= requestAnimationFrame(measure) }
    // leaf 可能尚未挂载/布局变化——监听窗口 resize + 定期兜底测量。
    window.addEventListener('resize', schedule)
    schedule()
    const interval = window.setInterval(schedule, 400)
    return () => {
      window.removeEventListener('resize', schedule)
      window.clearInterval(interval)
      if (raf !== null) cancelAnimationFrame(raf)
    }
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
          callRemote={callPluginManager}
        />
      ),
      modal: true,
    })
  }, [gridSubscribe, getHiddenSnapshot, callPluginManager])

  const renderGridSlot = useCallback((slot: GridSlot): ReactNode => {
    if (slot === 'corum.sidebar') {
      // 侧栏（design.pen col-nav）：left-body 内的圆角 18 玻璃卡片（项目/任务双
      // 模式）。顶部贯通标题栏行（窗口标题栏 + Agent 标题栏）在 AppFrame 主 JSX
      // 渲染，不在此 leaf 内。折叠态（design J0PbdL）：leaf 被 GridView 收成
      // 56px，渲染竖排图标轨（含展开按钮），替代完整会话列表。
      if (sidebarCollapsed) {
        return (
          <SidebarRail
            onExpand={onToggleSidebar}
            onTogglePanels={onTogglePanels}
            onToggleTerminal={onToggleTerminal}
            onOpenPlugins={openPluginManager}
            themePreference={themePreference}
            onToggleTheme={onToggleTheme}
            settingsSlot={renderSlot('sidebar.settings', { wide: false })}
          />
        )
      }
      return (
        <div className={css.sidebarPane}>
          <div className={css.sidebarPaneBody}>
            {renderSlot('corum.sidebar', { wide: true, width: 280, expandSidebar: () => { /* grid mode: rail fold N/A */ } })}
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
      {/* 顶部标题栏行（design.pen titlebar-row，40px，整行 app-region:drag
          解决窗口拖拽余量）：absolute 浮层只覆盖左列（侧栏+对话区）上方——
          左段「窗口标题栏」（红绿灯让位 + 图标按钮，宽度跟随侧栏右缘）+ 右段
          「Agent 标题栏」（会话标题 + 状态胶囊 + 轨迹，b4p03B，假数据占位，
          覆盖对话区正上方）。right-col（编辑器/资源管理器/终端）顶到窗口顶，
          其上方无标题栏（下方 mainRow 占满 frame 全高，由 GridView 的
          leafTopOffset 给 sidebar/conversation 格让位本行）。 */}
      <div
        className={css.titlebarRow}
        /* 浮层宽度精确 = 对话区右缘：命中/可见范围只覆盖左列（侧栏+对话区）
           上方，右侧（编辑器/资源管理器/终端上方）连浮层都没有——纯内容区。 */
        style={{ right: 'auto', width: Math.max(0, convoBox.x + convoBox.width) }}
      >
        {/* 窗口标题栏宽度跟随侧栏右缘（设计稿：覆盖侧栏正上方，侧栏拖拽时一起变）。
            该段整段 app-region:drag（窗口拖拽），内层按钮 no-drag。 */}
        <div className={css.titlebarDrag} style={{ width: sidebarRight, flex: 'none', display: 'flex' }}>
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
        </div>
        {/* Agent 标题栏覆盖对话区正上方：绝对定位 left=对话区左缘、width=对话区宽，
            左缘/右缘始终对齐对话区，侧栏/对话区拖拽时自动跟随调整。 */}
        <div
          className={`${css.agentTitleBarSeat} ${css.titlebarDrag}`}
          style={{ left: convoBox.x, width: Math.max(0, convoBox.width) }}
        >
          <AgentTitleBar sessionTitle={currentSessionTitle} />
        </div>
      </div>

      {/* Main Row —— 自由二维网格（GridView），顶到窗口顶（占满 frame 全高）。
          终端 corum.panel 已纳入网格（默认底部行），可调宽、可与其他区域自由
          组合。leafTopOffset 给 root row 的 sidebar/conversation 格内容下移
          54px（40 标题栏 + 14 间距）让位上方标题栏浮层；right-col 格 offset=0
          顶到容器顶（设计稿 left-col vs right-col 的顶部差异）。 */}
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
          leafTopOffset={TITLEBAR_CLEARANCE}
          collapsedSlots={COLLAPSED_SIDEBAR}
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
