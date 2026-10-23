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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls `useSessions` into GlobalStandardProps (0.1.2 起由 ui-session 声明)。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// SessionListState 的结构类型（与 dsh-api-session-controller/client 同名类型同构；
// 包未直接依赖该 controller——结构窄化避免新增运行时依赖，见 AGENTS.md 红线 3）。
interface SessionListState {
  current?: string | undefined
  byId: Record<string, { blank?: boolean; displayTitle?: string; projectionValues?: unknown } | undefined>
}
import type { createLayoutStore } from './stores.ts'
import type { ChromeState, GridActions, SidebarMode } from './service.ts'
import { ArrowDownToLine, Blocks, FolderKanban, Lock, MessageSquare, RefreshCw, Search, Settings, Star, User, X } from 'lucide-react'
import { GridView } from '@corum/corum-ui-base/client'
import {
  loadGrid, saveGrid, dropLeaf, resizeBranch, findLeafBySlot,
  rescaleGrid, setLeafHidden, addSlotAt, hiddenSlots,
  FloatingLayer, useFloatingLayer,
  type GridNode, type GridSlot, type DropZone,
} from '@corum/corum-ui-base/client'
import { IDE_GRID_SLOTS, IDE_GRID_STORAGE_KEY, IDE_TRANSPARENT_SLOTS, ideDefaultGrid } from './ide-layout.ts'
// fork（corum）：开发者模式开关（同 bundle 设置域，localStorage + 同 bundle 事件）。
import { useDeveloperMode } from './settings/developer-mode.ts'
// 应用更新（2026-10-15）：更新结果面板 + 活动栏更新提醒按钮 + 用户菜单检查更新。
import type { CorumEditorCapable, UpdateApi, UpdateState } from './update/update-api.ts'
import { UpdatePanel } from './update/UpdatePanel.tsx'
import {
  hasReadyUpdate, hasPendingUpdate, updateVersionLabel,
  readChangelog, openChangelogInEditor,
} from './update/update-api.ts'
// 集成中心（PR4）：全屏独占工作面的面板本体（壳内渲染，不走网格/槽座位）。
import { IntegrationsFrame, type IntegrationsSection, type IntegrationsSectionSlot } from './IntegrationsFrame.tsx'
import css from './AppFrame.module.css'

/**
 * 标题栏让位（design.pen L1：主窗口边距=0、titlebar-row 与 col-nav 间距=0）：
 * root row 各格内容顶部下移让位窗口标题栏浮层。
 *
 * 2026-09-30（P2 统一标题栏）后的取值 = `[40, 40, 0]`：
 *   - sidebar 格 offset=40——红绿灯让位 + 窗口控件按钮仍在顶部 40px 带子里，
 *     侧栏内容必须让位（标题栏底 40 + 卡片间距 0）。
 *   - conversation 格 offset=**40**——会话顶栏卡片已搬进带子（occupant =
 *     corum.titlebar.session），对话区 leaf 里只剩正文，必须整体下移 40 才不会
 *     钻到带子底下。（此前是 0：那时顶栏卡片在 leaf 内、自己占掉这 40px。）
 *   - right-col 格 offset=0——编辑器/资源管理器/终端上方本来就无标题栏（带子只覆
 *     盖活动栏 + 侧栏 + 对话区，右缘 = 对话区格右缘）。
 * 沿 root row 的格序（sidebar, conversation, right-col）。
 */
const TITLEBAR_CLEARANCE: readonly number[] = [40, 40, 0]

/**
 * 会话列表固定宽（px，用户 2026-10-03 定调）：锁死后两侧 sash 隐藏、不可拖拽。
 * 改这个值即可调整侧栏宽；它不是「最小宽」而是「唯一宽」。
 */
const SIDEBAR_LOCKED_WIDTH = 220

/**
 * 活动栏宽（px）：与标题栏红绿灯让位区严格同宽（2026-09-30 定案）。
 * macOS 红绿灯实占 x=12..64（13px 灯 ×3 + 8px 间距）+ 右侧 12px 留白 = 76
 * （见 .navTitleBarInset 与 main.ts 的 trafficLightPosition{12,13}）。原 56
 * 比灯带窄 ⇒ 灯会压到侧栏上；改 76 后活动栏列与红绿灯列上下对齐。
 * ⚠️ 与 AppFrame.module.css 的 `.activityBar{width}` 必须同步（CSS 不能 import
 * 本常量，改一处要一起改，无编译期守卫）。
 */
const ACTIVITY_BAR_WIDTH = 76

/**
 * 实际运行平台（启动期常量，与 titlebar 的 getPlatform 同源）。
 * 用于活动栏顶部 padding 的平台分叉：darwin 保留 40px 给红绿灯让位，
 * win32/linux 无红绿灯，活动栏内容顶到 y=0（占据 titlebar 让出的左 76px 列）。
 * 红线 3 局部窄化，不 declare global。
 */
const RUNTIME_PLATFORM: 'darwin' | 'linux' | 'win32' | undefined =
  typeof window !== 'undefined'
    ? (window as unknown as { corumDesktop?: { getPlatform?: () => 'darwin' | 'linux' | 'win32' } }).corumDesktop?.getPlatform?.()
    : undefined
/** 有系统红绿灯（darwin）；win/linux/undefined 顶上去。 */
const HAS_TRAFFIC_LIGHT = RUNTIME_PLATFORM === 'darwin'

/**
 * 折叠态标题栏行的宽度（px）= 红绿灯让位 76 + 间距 4 + 折叠/展开按钮 28 = 108。
 * 折叠后侧栏整列隐藏（collapsedWidth=0），侧栏右缘只剩活动栏的 76——窄于按钮排
 * 所需，故行宽取本值；「展开」按钮因此与展开态的「折叠」按钮落在同一 x=80
 * （design.pen 状态③ 定稿：两态按钮**零位移**）。
 * ⚠️ 间距（`.navTitleBar` 的 `gap: 4px`）必须计入：漏算会让按钮溢出容器 4px
 * （实测按钮 rect 80..108，而容器只有 104 ⇒ 按钮有一截落在行外）。
 */
const TITLEBAR_COLLAPSED_WIDTH = ACTIVITY_BAR_WIDTH + 4 + 28

// ── FloatingLayer 单例桥 ──
// AppFrame 组件树里 <FloatingLayer /> 是标题栏触发器的 sibling（Provider 在
// AppFrame 内部，标题栏拿不到 context）。但 openFloating/closeFloating 是
// FloatingLayer 内稳定的 useCallback（空依赖），提升为模块级单例供 AppFrame
// 使用；FloatingLayer 挂载时回填。应用只有一个 FloatingLayer，单例安全。
import type { FloatingLayerApi } from '@corum/corum-ui-base/client'
let floatingApiSingleton: FloatingLayerApi | null = null

/** 主题偏好（三态）。 */
type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 左列导航标题栏（NavTitleBar / NavIconButton）**已迁出壳**（2026-09-30）：
 * 窗口顶部 40px 带子的唯一 owner 现在是 `@corum/corum-ui-titlebar`（占壳声明的
 * `corum.titlebar` 槽）。迁移原因：这条带子此前被两个 owner 分别持有（壳的按钮行
 * + 对话区 leaf 内的会话顶栏），折叠态下后者的空态拖拽带（`app-region: drag`）
 * 盖住前者的控件层，而 drag 位图不遵守 z-index、显式 `no-drag` 也凿不掉 ⇒ 物理
 * 鼠标点「展开」被当拖拽吞掉。壳现在只留一个**惰性挂载位**（见下方 titlebarMount），
 * 自身不含任何 app-region。
 */

/**
 * 工作面标识（活动栏主导航组的两项 + 集成中心）。
 *
 * ⚠️ 与 `SidebarMode`（`'task' | 'project'`，`ctx.layout` 的**跨 bundle 单例**
 * 状态）**刻意不同域**：`'integrations'` 只活在 AppFrame 的本地 state 里，
 * 永远不会被写进 `setSidebarMode`（该服务只认 task/project，写进去是脏数据，
 * 且侧栏骨架没有任何面板能渲染它）。三者的关系：
 *   - `task` / `project` → 直接写 sidebarMode（侧栏骨架按它换面板）；
 *   - `integrations`     → 只切本组件渲染的行布局（会话区让位），sidebarMode
 *                          保持原值不动 ⇒ × 关闭回到会话布局时侧栏还停在
 *                          用户离开前的工作面（设计稿「回到会话布局」的语义）。
 */
type WorkbenchFace = 'task' | 'project' | 'integrations'

/**
 * 侧栏工作面（= 可写 sidebarMode 的那两项）。
 *
 * 取 `WorkbenchFace` 与 `SidebarMode` 的**交集**而不是 `Exclude<…>`：'integrations'
 * 不在 SidebarMode 里，自然被减掉；同时若将来 sidebarMode 域变了（如去掉
 * 'project'），这里**自动跟随**、`onSelectFace('project')` 的调用点即刻编译错。
 * 这样「能写服务的 face」永远等于两个域的交集，不需要第三处人工同步。
 *
 * 为什么 onSelectFace 收这个域而不是 `WorkbenchFace`：活动栏主导航组只可能传
 * task/project，收窄后**类型系统直接拦住** `setSidebarMode('integrations')` 这类
 * 误写（该服务只认 task/project；写进去是脏数据，且侧栏骨架没有面板能渲染它）。
 * 编译器是这条纪律的第一道闸，运行期无需再判。
 */
type SidebarFace = Extract<WorkbenchFace, SidebarMode>

/** 活动栏 logo 落点（corumapp:// 壳静态资源；与 brand_card / 环境背景同通路）。 */
const ACTIVITY_BAR_LOGO_SRC = 'corumapp://app/assets/icon.png'

/**
 * 默认用户头像（design.pen img-general = generated-6.png，通用助手立绘；
 * 代码侧对应 packages/desktop/assets/avatars/general-assistant.png）。
 * 未登录时活动栏头像与菜单头头像都用这张立绘（用户 2026-10：「默认弄一个
 * 好看点的头像」），替代此前的 lucide user 线条图标。
 */
const DEFAULT_AVATAR_SRC = 'corumapp://app/assets/avatars/general-assistant.png'

/**
 * 活动栏（design.pen IrWFV 画板 E 定稿：**活动栏 = 工作面切换器**）——
 * 76px **常驻**竖排图标列（结构见 design i1ECc；76 = 标题栏红绿灯让位宽，
 * 2026-09-30 定案，原 56 比灯带窄会压到侧栏）：
 *   鲸鱼 logo 28 圆形 / 主导航组（任务 · 项目 · 搜索）/ spacer /
 *   底部组（插件 · 设置）。图标钮 40×40 r10，激活态 $glass-2 底 + 左侧 2px
 *   $brand-primary 指示条。
 *
 * 与旧 SidebarRail 的区别（本 PR = PR3）：旧轨**只在 sidebarCollapsed 时**
 * 作为 leaf 内替身渲染，且是「侧栏功能快捷键堆」；本组件**常驻**渲染在网格
 * **外**（AppFrame 的 workbenchRow，GridView 左侧），语义改为工作面切换器。
 *
 * 工作面语义（画板 E 的四条 flow + 画板 F 的集成中心）：
 *   - 任务 → 侧栏任务面板 + 会话主区（= sidebarMode 'task'，开箱默认布局）；
 *   - 项目 → 侧栏项目面板 + 项目主区（= sidebarMode 'project'）；社区版
 *     `corum.sidebar.project` 无 occupant ⇒ 图标置灰 + lock 角标，点击只走
 *     升级引导占位（TODO(project-face)：引导弹层未接入，不假装已切换）；
 *   - 搜索 → 本 PR 占位（SessionsPane 的搜索框没有跨 bundle 触发通路）；
 *   - 插件 → **集成中心全屏独占工作面**（PR4）：侧边栏与会话区一起让位，
 *     面板占满活动栏右侧全部宽度（画板 F；集成中心是统一模型里「没有侧栏
 *     部分的工作面」，故全幅是自然结果而不是特例）。激活态由 AppFrame 本地
 *     state 决定（画板 F 的指示条 + $glass-2 底）；
 *   - 设置 → `sidebar.settings` 槽座位（复用 SettingsShell 触发器，行为不变）；
 *   - 点**当前激活**的工作面图标 ⇄ 折叠 / 展开侧边栏（便利入口；**主入口**是
 *     常驻标题栏最左的折叠/展开钮，两态同坐标 x=76，见 NavTitleBar）。
 *
 * 刻意**不**走网格内新槽（进入网格就会被算进 leafMinSize / collapsedWidth /
 * drop 目标，而它是壳级工作面切换、不是用户可拖拽/可隐藏的区域）。
 */
function ActivityBar({ face, projectAvailable, sidebarCollapsed, onSelectFace, onSearch, onPlugins, settingsSlot, openSettingsSection, updateApi, updateHeroImageSrc, editorApi }: {
  /**
   * 当前工作面的**导出值**（= 集成中心打开 ? 'integrations' : sidebarMode）。
   *
   * 由 AppFrame 导出、本组件只读：活动栏是工作面切换器，「谁在工作」是它唯一
   * 需要的状态。集成中心并没有自己的可写 state——它打开时 sidebarMode 保持
   * 原值（那是「收回后回到哪个侧栏工作面」的记忆）。
   */
  face: WorkbenchFace
  /** 项目工作面可用性（`corum.sidebar.project` 槽占用判定）；社区版恒 false。 */
  projectAvailable: boolean
  /** 侧栏是否收起（决定激活项 tooltip 的展开/收起文案）。 */
  sidebarCollapsed: boolean
  /** 点「任务 / 项目」：切工作面；已是当前工作面时 = 折叠 / 展开侧栏。 */
  onSelectFace: (face: SidebarFace) => void
  /** 搜索工作面（本 PR 占位）。 */
  onSearch: () => void
  /** 插件工作面：切集成中心全屏独占（PR4）。 */
  onPlugins: () => void
  /** 设置座位：`sidebar.settings` 槽的渲染结果（SettingsShell 触发器 + 面板）。 */
  settingsSlot: ReactNode
  /**
   * 应用更新能力面（2026-10-15）：活动栏更新按钮 + 用户菜单「检查更新」 +
   * 更新结果面板的数据源。null = 服务未装配。
   */
  updateApi: UpdateApi | null
  /** 更新结果面板的品牌头图 URL。 */
  updateHeroImageSrc: string
  /**
   * 编辑器打开能力（`ctx.corumEditor` 的窄化面）。用户 2026-10-23 要求「更新
   * 后自动打开编辑器显示更新日志」且「能在界面里查看历史日志」，两条都落在
   * 这个面上。null = 非桌面壳 / 服务未装配 ⇒ 面板省略「历史版本」入口。
   */
  editorApi: CorumEditorCapable | null
  /**
   * 打开设置中心某 section（用户菜单「账户与用量」= 'account'、「设置」=
   * 'general'）。直通 ctx.layout.openSettingsSection → 广播
   * OPEN_SETTINGS_SECTION_EVENT，SettingsShell 监听后打开面板并选中该页。
   * （原侧栏 footer 用户区删后，账户/设置菜单入口整体搬进活动栏底部。）
   */
  openSettingsSection: (id: string) => void
}) {
  const taskActive = face === 'task'
  const projectActive = face === 'project' && projectAvailable
  const integrationsActive = face === 'integrations'
  /** 档位（与原侧栏 footer 同源）：project 槽有 occupant = PRO，空 = 社区版。 */
  const edition: 'community' | 'pro' = projectAvailable ? 'pro' : 'community'
  const editionLabel = edition === 'pro' ? 'PRO' : '社区版'

  /* ── 用户菜单（原侧栏 footer 用户区迁入）──────────────────────────── */

  // 底部轻量 popover 开合（点头像钮 toggle）。关闭时把焦点还给触发按钮
  // （键盘用户不丢锚点）。
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userButtonRef = useRef<HTMLButtonElement>(null)

  /**
   * 关闭路径（参照原侧栏 footer popover / SettingsShell.tsx 的监听法）：
   * ① 点击菜单与触发按钮之外的任意处关闭；② Esc 关闭并归还焦点。
   */
  useEffect(() => {
    if (!userMenuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(`.${css.railUserMenu}`) !== null) return
      if (userButtonRef.current?.contains(target)) return
      setUserMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setUserMenuOpen(false)
      userButtonRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [userMenuOpen])

  /* ── 应用更新（2026-10-15）────────────────────────────────────────── */
  // 更新状态：轮询 host 侧 updateChecker.getState()。
  // - 活动栏更新按钮：仅 downloaded-ready 时显示（无更新/下载中隐藏）。
  // - 用户菜单「检查更新」项：红点 + 版本号（有更新未下载）或「重启安装 vX.X.X」
  //   （已下载待重启）；点击弹 UpdatePanel。
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [updatePanelOpen, setUpdatePanelOpen] = useState(false)
  const updatePollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 轮询：有更新未下载 / 下载中时高频，否则低频。面板打开时也高频。
  useEffect(() => {
    if (updateApi === null) return undefined
    const tick = (): void => { void updateApi.getState().then(setUpdateState) }
    void tick()
    const downloading = updateState?.phase === 'downloading'
    const interval = downloading || updatePanelOpen ? 1000 : 5000
    updatePollRef.current = setInterval(tick, interval)
    return () => {
      if (updatePollRef.current !== null) clearInterval(updatePollRef.current)
    }
  }, [updateApi, updateState?.phase, updatePanelOpen])

  const showUpdateButton = hasReadyUpdate(updateState)
  const showUpdateDot = hasPendingUpdate(updateState)
  const showReadyBadge = hasReadyUpdate(updateState)
  const updateVerLabel = updateVersionLabel(updateState)

  /**
   * 「更新完成后自动在编辑器打开更新日志」（用户 2026-10-23 要求）。
   *
   * 时机 = **升级重启后的首次启动**：拿当前运行版本与上次记录版本比，不同即
   * 说明刚升过，于是把随包日志打开一次。不是「下载完成时」——那时还是旧版本。
   *
   * 只触发一次：记录到 localStorage（按版本键），同一版本重启多少次都不再打扰，
   * 避免每次启动都抢走编辑器焦点。首次安装（没有基线记录）不触发——那时候
   * 「更新日志」对用户没意义，只是第一次打开应用。
   */
  useEffect(() => {
    if (editorApi === null || updateState === null) return
    const running = updateState.currentVersion
    if (running === '' || running === 'unknown') return
    const KEY = 'corum.update.lastSeenVersion'
    let seen: string | null = null
    try { seen = window.localStorage.getItem(KEY) } catch { /* 隐私模式：不持久化则不触发 */ }
    if (seen === null) {
      // 首次安装：记下版本，不打开日志。
      try { window.localStorage.setItem(KEY, running) } catch { /* noop */ }
      return
    }
    if (seen === running) return
    // 刚升级：先记版本再打开，防止失败后每次启动重试刷屏。
    try { window.localStorage.setItem(KEY, running) } catch { /* noop */ }
    void (async () => {
      const doc = await readChangelog()
      if (doc === null) return
      const result = await openChangelogInEditor(editorApi, doc.path)
      if (!result.ok) console.warn('[corum-update] 自动打开更新日志失败：', result.error)
    })()
  }, [editorApi, updateState?.currentVersion])


  /** 菜单项「账户与用量」：打开设置中心的账户页并关菜单。 */
  const openAccount = (): void => {
    setUserMenuOpen(false)
    openSettingsSection('account')
  }
  /** 菜单项「设置」：打开设置中心通用页并关菜单。 */
  const openGeneralSettings = (): void => {
    setUserMenuOpen(false)
    openSettingsSection('general')
  }
  /** 点「升级 PRO」：只记日志（购买链路未接入），不假装已升级。 */
  const requestUpgrade = (): void => {
    setUserMenuOpen(false)
    console.debug('[activitybar] 升级 PRO（占位：购买链路未接入）')
  }
  /**
   * 点「检查更新」：关菜单 + 弹 UpdatePanel。若 updateApi 未装配则记日志降级。
   * 若已下载待重启，面板直接展示卡③重启安装态。
   */
  const requestUpdate = (): void => {
    setUserMenuOpen(false)
    if (updateApi === null) {
      console.debug('[activitybar] 检查更新（更新服务未装配）')
      return
    }
    setUpdatePanelOpen(true)
  }
  /**
   * 活动栏更新按钮点击（下载完成时）：弹 UpdatePanel（展示卡③重启安装）。
   */
  const openUpdatePanelFromRail = (): void => {
    setUpdatePanelOpen(true)
  }


  /** 工作面 tooltip：激活项额外提示「点此收起/展开侧栏」（状态③ 的可发现性）。 */
  const faceTitle = (label: string, active: boolean): string =>
    (active ? `${label} · 点此${sidebarCollapsed ? '展开' : '收起'}侧栏` : label)
  /** 「集成中心」图标的 tooltip：激活时的动作是**收起面板**，不是收起侧栏。 */
  const pluginsTitle = integrationsActive ? '集成中心 · 点此收起（回到会话布局）' : '集成中心'
  return (
    <div className={`${css.activityBar} ${HAS_TRAFFIC_LIGHT ? '' : css.activityBarNoTrafficLight}`} role="toolbar" aria-label="活动栏（工作面切换器）" aria-orientation="vertical">
      {/* 集成中心打开时补回栏顶窗口拖拽（会话布局下由 titlebarRow 的拖拽段覆盖，
          该行此时整行隐藏——见 AppFrame.module.css 的 .railDragBand 注释）。 */}
      {integrationsActive && <div className={css.railDragBand} aria-hidden="true" />}
      {/* 鲸鱼小 logo（design a2DfYc：28 圆形 + glass-border 描边）。 */}
      <img className={css.railLogo} src={ACTIVITY_BAR_LOGO_SRC} alt="" draggable={false} />

      {/* 主导航组（design dTF8x）：任务 · 项目 · 搜索。 */}
      <div className={css.railGroup}>
        <button
          type="button"
          className={css.railItem}
          data-face="task"
          data-active={taskActive || undefined}
          aria-pressed={taskActive}
          title={faceTitle('任务', taskActive)}
          aria-label="任务工作面"
          onClick={() => { onSelectFace('task') }}
        >
          <MessageSquare size={20} strokeWidth={2} />
        </button>
        <button
          type="button"
          className={css.railItem}
          data-face="project"
          data-active={projectActive || undefined}
          data-locked={projectAvailable ? undefined : true}
          aria-pressed={projectActive}
          title={projectAvailable
            ? faceTitle('项目', projectActive)
            : '项目工作面（专业版功能，暂未开放）'}
          aria-label="项目工作面"
          onClick={() => { onSelectFace('project') }}
        >
          <FolderKanban size={20} strokeWidth={2} />
          {/* 社区版角标（design a7y2Pc：11px lock，落按钮右下角）。 */}
          {!projectAvailable && <Lock className={css.railLock} size={11} strokeWidth={2.5} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={css.railItem}
          data-face="search"
          title="搜索"
          aria-label="搜索工作面"
          onClick={onSearch}
        >
          <Search size={20} strokeWidth={2} />
        </button>
      </div>

      {/* spacer（design KBKWI）：把底部组推到栏底（margin-top auto）。 */}
      <div className={css.railSpacer} />
      <div className={css.railGroup}>
        {/* 「插件」= 集成中心工作面（画板 F：点亮即全屏独占；再点收回）。
            激活态 = $glass-2 底 + 左侧 2px $brand-primary 指示条（同 railItem 语言）。 */}
        <button
          type="button"
          className={css.railItem}
          data-face="plugins"
          data-active={integrationsActive || undefined}
          aria-pressed={integrationsActive}
          title={pluginsTitle}
          aria-label="集成中心工作面"
          onClick={onPlugins}
        >
          <Blocks size={20} strokeWidth={2} />
        </button>
        {/* 设置中心挂载位（2026-10-15：原可见齿轮图标移除，改由用户菜单「设置」项
            驱动；但 `sidebar.settings` 槽承载 SettingsShell 本体，必须保留挂载点，
            故以不可见容器承载——触发器齿轮不再显示，面板仍经 openSettingsSection 弹出）。 */}
        <span className={css.railSettingsSeatHidden}>{settingsSlot}</span>
        {/* 应用更新提醒按钮（2026-10-15）：原 settings 图标位。
            仅当「有更新且已下载完成」时显示（无更新/下载中隐藏，不占位）。
            品牌色底 + ↓ 图标，点击弹 UpdatePanel（卡③重启安装）。 */}
        {showUpdateButton && (
          <button
            type="button"
            className={css.railItem}
            data-update-btn="true"
            title={`更新就绪 v${updateVerLabel ?? ''} · 点击重启安装`}
            aria-label="更新就绪，点击重启安装"
            onClick={openUpdatePanelFromRail}
          >
            <ArrowDownToLine size={20} strokeWidth={2.5} style={{ color: 'var(--dsw-alias-brand-primary, #6c8cff)' }} />
          </button>
        )}
        {/* 用户入口（design.pen item「用户」：btn 40×40 r10 + 28 圆形头像 + user
            图标）——原侧栏 footer 用户区删后搬到这里，点击 toggle 向上弹出的
            用户菜单（菜单项照 mmJTb zmFw6 版，见 .railUserMenu 注释）。 */}
        <button
          ref={userButtonRef}
          type="button"
          className={css.railItem}
          title="用户"
          aria-label="用户菜单"
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          onClick={() => { setUserMenuOpen(!userMenuOpen) }}
        >
          <span className={css.railUserAvatar}>
            <img className={css.railUserAvatarImg} src={DEFAULT_AVATAR_SRC} alt="" draggable={false} />
          </span>
        </button>
      </div>

      {/* 用户菜单（design.pen mmJTb zmFw6）：绝对定位在活动栏内、锚右下向上弹出。
          关闭路径：① 点菜单与触发按钮之外的任意处；② Esc（关闭后焦点还给触发
          按钮）。菜单项动作沿用原侧栏 footer 的占位/通路：账户与用量/设置 =
          ctx.layout.openSettingsSection 广播，升级 PRO / 检查更新 = console.debug
          占位（购买与更新机制均未接入，TODO 同侧栏原状）。 */}
      {userMenuOpen && (
        <div className={css.railUserMenu} role="menu" aria-label="用户菜单">
          {/* 菜单头：28px 头像 + 「本机使用 / 未登录」两行 + 档位徽标（edition
              与侧栏品牌行同源：project 槽有 occupant = PRO，空 = 社区版）。 */}
          <div className={css.railUserMenuHead}>
            <span className={css.railUserAvatar}>
              <img className={css.railUserAvatarImg} src={DEFAULT_AVATAR_SRC} alt="" draggable={false} />
            </span>
            <span className={css.railUserMenuName}>
              <span className={css.railUserMenuTitle}>本机使用</span>
              <span className={css.railUserMenuSub}>未登录</span>
            </span>
            {/* 与侧栏品牌行同源、**结构也一致**（图标 + 文字，只换图标与配色）：
                社区版 = 品牌「C」图标，PRO = 星形。两处图标都 14px，两个档位共用同一
                基线，故在活动栏菜单里社区版与 PRO 的视觉重量相同。 */}
            <span className={css.railEditionBadge} data-edition={edition}>
              {edition === 'pro'
                ? <Star className={css.railEditionBadgeIcon} size={14} strokeWidth={2} aria-hidden="true" />
                : <img className={css.railEditionBadgeIcon} src="corumapp://app/assets/edition-community.png" alt="" aria-hidden="true" />}
              {editionLabel}
            </span>
          </div>
          <div className={css.railUserMenuDivider} />
          <button
            type="button"
            role="menuitem"
            className={css.railUserMenuItem}
            onClick={openAccount}
          >
            <User className={css.railUserMenuIcon} size={14} strokeWidth={2} aria-hidden="true" />
            <span className={css.railUserMenuLabel}>账户与用量</span>
          </button>
          {/* 「升级 PRO」仅社区版显示（PRO 版已是最高档位）。 */}
          {edition === 'community' && (
            <button
              type="button"
              role="menuitem"
              className={css.railUserMenuItem}
              data-brand="true"
              onClick={requestUpgrade}
            >
              <Star className={css.railUserMenuIcon} size={14} strokeWidth={2} aria-hidden="true" />
              <span className={css.railUserMenuLabel}>升级 PRO</span>
            </button>
          )}
          {/* 检查更新项（2026-10-15 接入真实状态机）：
              - 无更新：纯文字「检查更新」；
              - 有更新未下载：红点 + 「vX.X.X 可用」；
              - 已下载待重启：品牌色角标 + 文案「重启安装 vX.X.X」。
              点击弹 UpdatePanel。 */}
          <button
            type="button"
            role="menuitem"
            className={css.railUserMenuItem}
            onClick={requestUpdate}
          >
            <span className={css.railUserMenuIconWrap}>
              <RefreshCw className={css.railUserMenuIcon} size={14} strokeWidth={2} aria-hidden="true" />
              {showUpdateDot && <span className={css.railUserMenuDot} aria-hidden="true" />}
              {showReadyBadge && (
                <span
                  className={css.railUserMenuDot}
                  aria-hidden="true"
                  style={{ background: 'var(--dsw-alias-brand-primary, #6c8cff)', width: 7, height: 7 }}
                />
              )}
            </span>
            <span className={css.railUserMenuLabel}>
              {showReadyBadge ? '重启安装' : '检查更新'}
            </span>
            {showUpdateDot && updateVerLabel !== null && (
              <span className={css.railUserMenuVersion}>v{updateVerLabel} 可用</span>
            )}
            {showReadyBadge && updateVerLabel !== null && (
              <span className={css.railUserMenuVersion} style={{ color: 'var(--dsw-alias-brand-primary, #6c8cff)', fontWeight: 600 }}>
                v{updateVerLabel} 已就绪
              </span>
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.railUserMenuItem}
            onClick={openGeneralSettings}
          >
            <Settings className={css.railUserMenuIcon} size={14} strokeWidth={2} aria-hidden="true" />
            <span className={css.railUserMenuLabel}>设置</span>
          </button>
        </div>
      )}
      {/* 应用更新结果面板（2026-10-15）：从活动栏用户菜单「检查更新」或更新按钮
          触发，绝对定位在活动栏左下角。updateApi 未装配时不渲染。 */}
      {updatePanelOpen && updateApi !== null && (
        <UpdatePanel
          api={updateApi}
          heroImageSrc={updateHeroImageSrc}
          editor={editorApi}
          onClose={() => { setUpdatePanelOpen(false) }}
        />
      )}
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

/** The slots a floating window may mount（= IDE_GRID_SLOTS 单一事实源，B2）。 */
const FLOATABLE_SLOTS: ReadonlySet<string> = new Set<string>(IDE_GRID_SLOTS)

/**
 * 自带顶栏（= 会话顶栏卡片充当窗口顶栏）的浮动槽：这些槽挂载的是会话视图，
 * 其 header 已渲染 state 行，故不再叠加壳的 Window Chrome（design.pen i5ie6）。
 * 目前只有 `conversation`（会话拖出为独立窗口 = 设计稿画的那一帧）。
 *
 * ⚠️ 注意：判断依据是「该槽的内容会不会渲染 `conversation.session.header`」。
 * 未来若新增其他会话级槽（如 trajectory 也带 header），需评估是否一并加入。
 */
const SELF_CHROME_FLOATING_SLOTS: ReadonlySet<string> = new Set<string>(['conversation'])

/**
 * 运行时动态网格槽 → 官方 SlotMap renderSlot 的边界 helper（B2）。
 *
 * 网格 leaf 的 slot 是运行时宽 string（用户可拖入任意已注册槽、含本壳内建槽
 * 之外的动态插件槽），不在 renderSlot 的静态声明域（PropsRenderSlots 收窄的
 * SlotMap key 联合）内——官方签名不接 string，需在此边界做一次显式收窄。
 *
 * 这是全局唯一的 renderSlot 强转点（替代原散落 708/780 两处的内联强转）：强转
 * 收进 helper 内部，调用点零强转。收窄的安全性由两端兜底——① 内建槽名
 * （IDE_GRID_SLOTS）经 ide-layout.ts 的 `satisfies IdeGridSlot` 编译期校验，拼错/
 * 与 SlotMap 不对齐即编译错；② 动态插件槽未在 SlotMap 注册 occupant 时
 * renderSlot 返回 null，由调用方渲染「此区域暂无内容」空态（运行时兜底，不白屏）。
 *
 * @param renderSlot - AppFrame props 里 SlotMap 收窄版的 renderSlot（静态域）。
 * @param slot - 运行时宽 string 槽 key（网格 leaf / 浮动窗目标）。
 */
function renderDynamicSlot(
  renderSlot: AppFrameProps['renderSlot'],
  slot: string,
): ReactNode {
  // 边界收窄：宽 string → SlotMap key（唯一 as，理由见上注释）。
  const narrow = renderSlot as (key: string, owner: Record<string, never>) => ReactNode
  return narrow(slot, {})
}

/** The desktop preload bridge face this frame uses for floating windows. */
interface FloatingBridge {
  openFloating?: (slotKey: string) => Promise<unknown>
  /**
   * 关闭浮动窗（`slotKey` 缺省 = 全部关掉）。主进程 `win.close()` 后既有
   * `closed` 钩子会通知主窗「detached → restored」，故调用方不必自己改状态。
   */
  closeFloating?: (slotKey?: string) => Promise<unknown>
  onFloatingChange?: (cb: (slotKey: string, detached: boolean) => void) => () => void
}

/**
 * 浮动窗的 Window Chrome 顶栏（系统拖拽区，app-region:drag）。
 *
 * 右侧带一个「收回到主窗口」按钮：浮窗此前只能靠系统红黄绿圆点关（桥里也没有关闭
 * API，2026-09-12 实测只能请用户手动关）。按钮走 `corumDesktop.closeFloating(slotKey)`
 * → 主进程 `win.close()` → 既有 `closed` 钩子通知主窗恢复被折叠的列。
 */
function FloatingChrome({ slotKey }: { slotKey: string }) {
  const bridge = (window as unknown as { corumDesktop?: FloatingBridge }).corumDesktop
  return (
    <div className={css.windowChrome}>
      {/* 系统红黄绿圆点由 titleBarStyle:'hidden' 保留在左上角，这里给它让位，
          不自绘（否则重叠）。标题/提示右移避开。 */}
      <span className={css.chromeTitle}>{slotKey}</span>
      <span className={css.chromeHint}>浮动窗 · 关闭即回到主窗口</span>
      <button
        type="button"
        className={css.chromeClose}
        aria-label="收回到主窗口"
        title="收回到主窗口"
        onClick={() => { void bridge?.closeFloating?.(slotKey) }}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

/**
 * 自带顶栏的浮动窗（`SELF_CHROME_FLOATING_SLOTS`）的**标题栏带**（P3, 2026-09-30）。
 *
 * 与主窗口同源：由 `@corum/corum-ui-titlebar` 的 `corum.titlebar` occupant 产生
 * （`variant:'floating'` = `[红绿灯让位 66][会话段]`），壳只给定位与宽度、
 * **不带任何 app-region**。
 *
 * 为什么还要在这里量宽度：浮窗根没有网格、也没有主窗口那套格测量，故本组件用
 * ResizeObserver 量自己的行宽当 `bandWidth` 下发（会话段 = 行宽 − 66）。
 * 宽度为 0 的首帧不渲染（避免给带子一个 0 宽）；fallback = 一条红绿灯让位拖拽带
 * （插件未装载时窗口仍可拖，且它不是第二个 drag owner——此时带子里没有 occupant）。
 */
function FloatingTitlebarBand({ renderSlot }: { renderSlot: AppFrameProps['renderSlot'] }) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = rowRef.current
    if (el === null) return undefined
    const measure = (): void => { setWidth(Math.round(el.getBoundingClientRect().width)) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])
  return (
    <div className={css.floatingTitlebarRow} ref={rowRef}>
      {width > 0 && renderSlot(
        'corum.titlebar',
        { variant: 'floating', bandWidth: width, controlsWidth: 0 },
        { fallback: <div className={css.floatingTrafficInset} aria-hidden="true" /> },
      )}
    </div>
  )
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<
    | 'conversation' | 'details' | 'shell.overlay' | 'sidebar.settings'
    | 'corum.sidebar' | 'corum.editor' | 'corum.trajectory' | 'corum.tabStrip' | 'corum.panel'
    // 统一标题栏（2026-09-30）：壳只在**惰性挂载位**里 renderSlot 它（带子的内容
    // 全归 @corum/corum-ui-titlebar 的 occupant）。键名是 root 条目 children 表的
    // 声明键 ⇒ 在此登记后 renderSlot 才有该域。
    | 'corum.titlebar'
    // 集成中心三个内容子槽（PR4）：AppFrame 只**转交**渲染面给 IntegrationsFrame
    // （收窄到这三个键，见 IntegrationsFrameProps），自己不 renderSlot 它们。
    // 三者是 root 条目 children 表里的声明键 ⇒ 在此登记后 renderSlot 才有该域。
    | IntegrationsSectionSlot
  >
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & {
    /** 主题偏好选择器 hook（inject hooks.theme 绑定而来，selector 形式）。 */
    useTheme: <S>(sel: (p: ThemePreference) => S, eq?: (a: S, b: S) => boolean) => S
    /**
     * 侧栏模式选择器 hook（PR3 活动栏：inject hooks.sidebarMode 绑定而来，
     * 源 = ctx.layout.sidebarModeSnapshot()）。活动栏「任务/项目」的激活态跟它走。
     */
    useSidebarMode: <S>(sel: (m: SidebarMode) => S, eq?: (a: S, b: S) => boolean) => S
    /**
     * 项目工作面可用性选择器 hook（inject hooks.projectOccupied 绑定而来，
     * 源 = `corum.sidebar.project` 槽占用判定）。社区版无 occupant ⇒ 恒 false ⇒
     * 活动栏项目图标置灰 + lock 角标。
     */
    useProjectOccupied: <S>(sel: (occupied: boolean) => S, eq?: (a: S, b: S) => boolean) => S
    /**
     * 侧栏模式写入（PR2 已建的 `ctx.layout.setSidebarMode` 通路，幂等）——
     * 活动栏点「任务/项目」时直接写它。AppFrame 是纯组件拿不到 cordis 服务，
     * 与 setTheme / attachGridActions 同一「inject 面反向注入」模式。
     */
    setSidebarMode: (mode: SidebarMode) => void
    /**
     * 窗口 chrome 选择器 hook（inject hooks.chrome 绑定而来，源 =
     * `ctx.layout.chromeSnapshot()`）：侧栏折叠 + 集成中心开关。
     * 2026-09-30 从本组件的局部 useState 收敛进服务——标题栏改成独立插件后
     * 壳与插件读同一份跨 bundle 单例状态（红线 1）。
     */
    useChrome: <S>(sel: (c: ChromeState) => S, eq?: (a: S, b: S) => boolean) => S
    /** 折叠 ⟷ 展开侧栏（写 ctx.layout 的 chrome 状态，幂等）。 */
    toggleSidebarCollapsed: () => void
    /** 直接写侧栏折叠态（幂等；切工作面时用 setSidebarCollapsed(false) 确保展开）。 */
    setSidebarCollapsed: (collapsed: boolean) => void
    /** 打开/关闭集成中心（幂等）。 */
    setIntegrationsOpen: (open: boolean) => void
    /** 集成中心开关注取反（活动栏「插件」图标）。 */
    toggleIntegrations: () => void
    /**
     * 主题偏好写入（直通 theme 服务）。
     *
     * 注：`remote` / `openSession` 两个注入面**已不再由本组件消费**——它们随会话段
     * 迁往 session-bar.tsx（会话顶栏槽 occupant 的注入面），改由 index.tsx 的
     * `ctx.slots.register` inject 工厂提供。本组件保留的是纯壳层（网格/侧栏/
     * 窗口控制）所需的面。
     */
    setTheme: (p: ThemePreference) => void
    /**
     * 插件中心触发（壳不持面板——业务 chrome 已拆出为
     * corum-ide-plugin-manager-ui 插件）：经 LayoutController.openPluginManager
     * → grid actions 订阅面通知，该插件认领并打开自己的 modal 面板（三-2
     * 服务化，原 CustomEvent 广播已退役）。
     */
    openPluginManager: () => void
    /**
     * 壳内部桥：根注册 inject 面下发的 attach 函数，把 AppFrame 的区域操作面
     * 经 attachGrid 挂进 LayoutController（AppFrame 是纯组件拿不到 cordis
     * 服务，靠这个 props 面反向连接；与 setTheme 同一注入模式）。
     */
    attachGridActions: (actions: GridActions) => void
    /**
     * 打开设置中心某 section（直通 ctx.layout.openSettingsSection，广播
     * OPEN_SETTINGS_SECTION_EVENT、SettingsShell 监听 openSection）——活动栏
     * 用户菜单「账户与用量」/'account' 与「设置」/'general' 用（原侧栏 footer
     * 用户区迁入后的通路）。
     */
    openSettingsSection: (id: string) => void
    /**
     * 应用更新能力面（2026-10-15）：活动栏更新按钮 + 用户菜单「检查更新」 +
     * 更新结果面板的数据源。host 侧 @corum/corum-update-checker 经 RPC 暴露，
     * index.tsx 窄化成此本地能力接口（红线 3）下发。安装走 IPC
     * （window.corumDesktop.installUpdate）。null = 服务未装配。
     */
    updateApi: UpdateApi | null
    /** 更新结果面板的品牌头图 URL（corumapp://app/assets/...）。 */
    updateHeroImageSrc: string
    /**
     * 编辑器打开能力（`ctx.corumEditor` 窄化面）。面板「历史版本」入口与
     * 「更新后自动打开日志」都经它落地。null = 非桌面壳 / 服务未装配。
     */
    editorApi: CorumEditorCapable | null
  }

/** The IDE frame (see module doc). */
export function IdeAppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  useSidebarMode,
  useProjectOccupied,
  useChrome,
  setSidebarMode,
  toggleSidebarCollapsed,
  setSidebarCollapsed,
  setIntegrationsOpen,
  toggleIntegrations,
  attachGridActions,
  openSettingsSection,
  updateApi,
  updateHeroImageSrc,
  editorApi,
}: AppFrameProps) {
  const panels = useStore(s => s)
  // 当前会话 id（非 blank）——details 抽屉的会话切换复位用。
  const detailsSession = useSessions((s: SessionListState) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  // 活动栏工作面状态（PR3）：当前侧栏模式 + 项目工作面可用性。
  // 两者都来自 root inject 面的 hooks 室（源 = ctx.layout 的
  // sidebarModeSnapshot / corum.sidebar.project 槽占用判定），活动栏据此定激活态。
  const sidebarMode = useSidebarMode(m => m)
  const projectAvailable = useProjectOccupied(occupied => occupied)
  // ── 集成中心工作面（PR4）──
  // 两个都是**壳本地 state**（不入 ctx.layout）：
  //   - integrationsOpen：集成中心是否占屏。true ⇒ workbenchRow 右列渲染集成中心
  //     面板代替 GridView（GridView 保持挂载但 CSS 隐藏，见下方 workbenchRow 注释）；
  //   - integrationsSection：面板内子导航选中项（插件 / MCP 服务器 / 技能）。
  // 联动规则（单一写点，避免两处状态打架）：
  //   - 点活动栏「任务/项目」→ 收回集成中心（写 sidebarMode，会话布局复活）；
  //   - 点活动栏「插件」→ 翻开 / 收回（再点一次收回 = 画板 F「× 关闭」的等价入口）；
  //   - 点面板头的 × → 收回。
  // 「收回后回到哪个工作面」不发散成第三份状态：集成中心期间 sidebarMode
  // **保持不动**（本 PR 不写它），故收回即自然回到用户离开前的那个侧栏工作面。
  // 集成中心开关：2026-09-30 收敛进 ctx.layout 的 chrome 状态（服务单例，引用只在
  // 字段变化时换）。集成中心内部选中的子导航仍是本组件局部 state。
  const integrationsOpen = useChrome(c => c.integrationsOpen)
  const [integrationsSection, setIntegrationsSection] = useState<IntegrationsSection>('plugins')
  // 会话标题/空态判定（isHero）已随会话段迁往 session-bar.tsx：那里由槽 occupant
  // 直接读 `useSessions` 投影（槽是会话作用域，自带 sessionId），本组件不再需要。
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
  // 折叠槽位集的镜像（P2-2）：grid 数学（rescaleGrid/resizeBranch）与 GridView
  // 都要读折叠态，而折叠 state 声明在下方——用 ref 镜像让上方回调读到最新值。
  const collapsedRef = useRef<ReadonlySet<string>>(new Set())
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
      const next = resizeBranch(g, branchId, sashIndex, deltaFraction, undefined, collapsedRef.current)
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
      const next = width > 0 && height > 0 ? rescaleGrid(dropped, width, height, collapsedRef.current) : dropped
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

  // 区域显隐（插件中心「显示/隐藏区域」、ctx.layout.setRegionHidden 到达）：
  // 统一走 setLeafHidden（树保留、持久化）。网格中尚无该 slot 的 leaf 时告警。
  const setRegionHidden = useCallback((slot: string, hidden: boolean) => {
    if (findLeafBySlot(gridRef.current, slot) === null) {
      console.warn(`[ide-shell] set-region-hidden: no grid leaf for slot "${slot}" (typo or already detached)`)
      return
    }
    setGrid((g) => {
      const next = setLeafHidden(g, slot, hidden)
      saveIdeGrid(next)
      return next
    })
    notifyGridListeners.current()
  }, [])

  // 侧栏 leaf 显隐切换（ctx.layout.toggleSidebar 到达；折叠 ⟷ 展开）。
  const toggleSidebarLeaf = useCallback(() => {
    setGrid((g) => {
      const leaf = findLeafBySlot(g, 'corum.sidebar')
      const next = setLeafHidden(g, 'corum.sidebar', !(leaf?.hidden === true))
      saveIdeGrid(next)
      return next
    })
  }, [])

  // 布局重置（ctx.layout.resetLayout 到达）：按当前 frame 尺寸重算默认布局
  // 并持久化（等价初次启动的几何）。
  const resetLayout = useCallback(() => {
    const { width, height } = frameBox.current
    const next = width > 0 && height > 0 ? rescaleGrid(ideDefaultGrid(), width, height, collapsedRef.current) : ideDefaultGrid()
    setGrid(next)
    saveIdeGrid(next)
    notifyGridListeners.current()
  }, [])

  // 区域显隐切换（供左列标题栏图标按钮）：toggle 一组 slot 的 hidden。
  // 整组「任一可见 → 全隐藏；全隐藏 → 全显示」，保证编辑器+资源管理器成组、
  // 终端/侧栏单独切换的语义统一。
  // 侧栏折叠（2026-09-30 定案 = **整列隐藏**，design.pen 状态③）：GridView 把
  // sidebar leaf 收到 collapsedWidth=0（见 ide-layout.ts 的 registerSlot），整列
  // 不占位、主区吃满；展开入口 = 常驻标题栏最左的折叠/展开按钮（NavTitleBar）。
  // P2-2：折叠态只存本组件 state，经 COLLAPSED_SIDEBAR 显式传给 GridView 与 grid
  // 数学（rescaleGrid/resizeBranch）——grid.ts 不再持模块级折叠 Set（ui-base 被
  // 各 bundle 内联，模块状态会按 bundle 分裂）。
  // 折叠态：2026-09-30 收敛进 ctx.layout 的 chrome 状态（见 service.ts 的
  // ChromeState）。壳与标题栏插件读同一份，故活动栏便利入口与标题栏按钮
  // 不会各写一份。
  const sidebarCollapsed = useChrome(c => c.sidebarCollapsed)
  const onToggleSidebar = useCallback(() => {
    toggleSidebarCollapsed()
  }, [toggleSidebarCollapsed])
  // ── 活动栏工作面切换（PR3 + PR4）──
  // 点「任务/项目」= 写 ctx.layout 的 sidebarMode（工作面的跨 bundle 单例状态，
  // 侧栏骨架按它切换任务/项目面板）+ 关掉集成中心（切走即收起，否则新工作面
  // 会被集成中心面板挡住、用户以为点击没生效）；点**当前激活**的工作面图标 =
  // 折叠/展开侧栏（便利入口——**主入口**是常驻标题栏最左的折叠/展开钮，两态
  // 同坐标，见 NavTitleBar）。
  // 切工作面时一并确保侧栏是展开态——否则点了图标侧栏还收着，用户看不到工作面内容。
  const onSelectFace = useCallback((face: SidebarFace) => {
    if (face === 'project' && !projectAvailable) {
      // 社区版：corum.sidebar.project 槽无 occupant（项目工作面是闭源内容）。
      // TODO(project-face): 升级引导弹层未接入（PR 未定）——本 PR 只置灰 + 记日志，
      // 不写 sidebarMode（写了也没有面板可渲染，且会污染跨 bundle 的服务状态）。
      console.debug('[activity-bar] 项目工作面不可用（社区版 · 项目面板槽无 occupant）')
      return
    }
    // 集成中心开着时：这一击只负责收回（会话布局复活），不叠加「折叠侧栏」——
    // 否则一次点击同时关面板 + 收起侧栏，用户看到的是「点任务结果侧栏没了」。
    if (integrationsOpen) {
      setIntegrationsOpen(false)
      if (sidebarMode !== face) setSidebarMode(face)
      setSidebarCollapsed(false)
      return
    }
    if (sidebarMode === face) {
      onToggleSidebar()
      return
    }
    setSidebarMode(face)
    setSidebarCollapsed(false)
  }, [integrationsOpen, projectAvailable, sidebarMode, onToggleSidebar, setSidebarMode, setSidebarCollapsed, setIntegrationsOpen])
  // 搜索工作面：本 PR 仅占位。SessionsPane 的搜索框是面板内 state（searchOpen +
  // 局部 ref），没有跨 bundle 的聚焦通路（新开一条通路属侧栏插件的活，超出本 PR
  // 活动栏范围），故按定稿先占位。
  // TODO(search-face): 待侧栏插件暴露「展开并聚焦搜索框」的注入面后接上。
  const onSearchFace = useCallback(() => {
    console.debug('[activity-bar] 搜索工作面（占位：侧栏搜索框尚无跨 bundle 聚焦通路）')
  }, [])
  // 插件工作面（PR4 完成）：活动栏「插件」图标 ⇄ 集成中心全屏独占工作面
  // （design.pen 画板 F 定稿）。切换只动本组件 state——sidebarMode 保持原值，
  // 故 × 关闭后侧栏还停在用户离开前的那个工作面（画板 F「回到会话布局」）。
  const onPluginsFace = useCallback(() => {
    toggleIntegrations()
  }, [toggleIntegrations])
  // 集成中心面板头的 × 关闭：回会话布局（画板 F 的关闭语义——侧边栏与会话区恢复）。
  const onCloseIntegrations = useCallback(() => {
    setIntegrationsOpen(false)
  }, [setIntegrationsOpen])
  // 传给 GridView 的折叠槽位集（useMemo 稳引用，折叠时才含 sidebar）。
  const COLLAPSED_SIDEBAR = useMemo<ReadonlySet<string>>(
    () => (sidebarCollapsed ? new Set(['corum.sidebar']) : new Set()),
    [sidebarCollapsed],
  )
  // 同步给上方 grid 数学用的 ref 镜像（渲染期赋值，与 gridRef 同款）。
  collapsedRef.current = COLLAPSED_SIDEBAR
  // 右侧两区域默认隐藏（2026-08-30 用户定调：编辑器/终端默认
  // 不展示——不只空态，进入项目/会话后也不显示；**只有点左上角快捷按钮
  // （面板/终端切换）才显示**，后续显示规则再定义）。userShown 记录用户
  // 手动点亮的区域（显示态），默认空 = 两区域全隐藏。
  // 2026-09-03 设计改版：资源管理器并入编辑器卡（子面板），不再是独立区域。
  // 2026-09-04 用户确认：启动后编辑器+资源管理器区域默认**不显示**（回到
  // 2026-08-30 定调）——DEFAULT_HIDDEN 含 corum.editor + corum.panel；
  // 点左上角「面板切换」快捷按钮（onTogglePanels → toggleRegionVisibility）
  // 点亮编辑器，「终端」钮点亮终端。
  const DEFAULT_HIDDEN = ['corum.editor', 'corum.trajectory', 'corum.panel'] as const
  const [userShown, setUserShown] = useState<ReadonlySet<string>>(new Set())
  // 开发者模式（同 bundle 设置域；与 AgentTitleBar 各自订阅，互不影响）。
  const developerMode = useDeveloperMode()
  // 快捷按钮显示某区域：移出 userShown 隐藏集（显示）+ 保证树里 hidden=false。
  const showRegion = useCallback((slots: readonly GridSlot[]) => {
    setUserShown((prev) => {
      const next = new Set(prev)
      for (const s of slots) next.add(s)
      return next
    })
    setGrid((g) => {
      let next = g
      for (const s of slots) next = setLeafHidden(next, s, false)
      saveIdeGrid(next)
      return next
    })
    notifyGridListeners.current()
  }, [saveIdeGrid])
  // 面板/终端切换：userShown 的开关——隐藏 → 点亮（showRegion）；显示 → 隐藏
  // （移出 userShown + 树 hidden=true 持久化）。
  const toggleRegionVisibility = useCallback((slots: readonly GridSlot[]) => {
    const anyShown = slots.some((s) => userShown.has(s))
    if (anyShown) {
      // 显示 → 隐藏：移出 userShown（回默认隐藏）+ 树 hidden=true 持久化。
      setUserShown((prev) => {
        const next = new Set(prev)
        for (const s of slots) next.delete(s)
        return next
      })
      setGrid((g) => {
        let next = g
        for (const s of slots) next = setLeafHidden(next, s, true)
        saveIdeGrid(next)
        return next
      })
      notifyGridListeners.current()
    } else {
      // 隐藏 → 显示。
      showRegion(slots)
    }
  }, [userShown, showRegion, saveIdeGrid])
  // fork（corum）：开发者模式关闭时收起轨迹区域——按钮是唯一开关，按钮消失后
  // 区域必须一起收起（否则用户无法关闭它）。
  useEffect(() => {
    if (!developerMode) onCloseSlot('corum.trajectory' as GridSlot)
  }, [developerMode, onCloseSlot])
  // 注：面板/终端两个「快捷切换」回调（原 onTogglePanels / onToggleTerminal）已随
  // 标题栏迁出壳（2026-09-30）——统一标题栏 occupant 经 `ctx.layout.toggleRegion`
  // 直接切区域，壳不再需要这两个包装（下方 gridActions 的 toggleRegion 供其它
  // 调用方使用，保持不变）。轨迹按钮同理（原 onOpenTrajectory 已随会话段迁走）。

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


  // ── ctx.layout 区域操作面（attachGrid）──
  // 「新建任务表单」信号：已挂载的空态监听者直推；未挂载（在会话视图）时
  // pending 标记留给 EmptyStateHero 挂载时认领（替代原 CustomEvent +
  // sessionStorage 桥，纯内存、单窗口语义不变）。
  const newTaskListeners = useRef(new Set<() => void>())
  const pendingNewTaskForm = useRef(false)
  const openNewTaskForm = useCallback(() => {
    if (newTaskListeners.current.size === 0) {
      pendingNewTaskForm.current = true
      return
    }
    for (const fn of newTaskListeners.current) fn()
  }, [])
  // 「打开插件中心」信号（统一事件中心三-2：原 corum:open-plugin-manager 跨
  // bundle CustomEvent + 双份字面量镜像服务化）：与 openNewTaskForm 同一
  // pending 模式——corum-ide-plugin-manager-ui 插件 apply 订阅时挂载认领，
  // 未挂载（插件禁用/尚未激活）时置 pending 不丢信号。
  const pluginManagerListeners = useRef(new Set<() => void>())
  const pendingPluginManager = useRef(false)
  const openPluginManagerSignal = useCallback(() => {
    if (pluginManagerListeners.current.size === 0) {
      pendingPluginManager.current = true
      return
    }
    for (const fn of pluginManagerListeners.current) fn()
  }, [])
  const gridActions = useMemo<GridActions>(() => ({
    setRegionHidden,
    closeRegion: onCloseSlot,
    // 点亮区域的单槽包装（LayoutController.showRegion → 本面）：清 userShown
    // 运行时隐藏 + 树 hidden 持久化，供「corum:open-in-editor」等可编程入口。
    showRegion: (slot) => { showRegion([slot as GridSlot]) },
    // 切换区域显隐的单槽包装（会话顶栏的轨迹按钮经本面回调；见 service.ts 注释）。
    toggleRegion: (slot) => { toggleRegionVisibility([slot as GridSlot]) },
    resetLayout,
    toggleSidebar: toggleSidebarLeaf,
    openNewTaskForm,
    onOpenNewTaskForm: (listener) => {
      newTaskListeners.current.add(listener)
      return () => { newTaskListeners.current.delete(listener) }
    },
    consumePendingNewTaskForm: () => {
      const pending = pendingNewTaskForm.current
      pendingNewTaskForm.current = false
      return pending
    },
    openPluginManager: openPluginManagerSignal,
    onOpenPluginManager: (listener) => {
      pluginManagerListeners.current.add(listener)
      // 挂载认领（与 EmptyStateHero consumePendingNewTaskForm 同语义，认领点
      // 收敛进订阅本身——消费端一个调用点，不会忘认领）。
      if (pendingPluginManager.current) {
        pendingPluginManager.current = false
        queueMicrotask(listener)
      }
      return () => { pluginManagerListeners.current.delete(listener) }
    },
    isInGrid: (slot) => findLeafBySlot(gridRef.current, slot) !== null,
    hiddenSlotsSnapshot: getHiddenSnapshot,
    onGridChange: gridSubscribe,
  }), [setRegionHidden, onCloseSlot, showRegion, toggleRegionVisibility, resetLayout, toggleSidebarLeaf, openNewTaskForm, openPluginManagerSignal, getHiddenSnapshot, gridSubscribe])
  // AppFrame 是纯组件拿不到 ctx.layout 服务实例——经根注册 inject 面下发的
  // attachGridActions 反向把操作面挂进 LayoutController，服务方法即可直连
  // 本组件的 grid actions（原 CustomEvent 事件桥全部退役）。
  useEffect(() => {
    attachGridActions(gridActions)
  }, [attachGridActions, gridActions])

  // 统一标题栏几何（2026-09-30）：壳是唯一的测量者，两个值经 owner props 下发给
  // @corum/corum-ui-titlebar 的 corum.titlebar occupant：
  //   · controlsWidth = 控件段右缘（折叠态常量 108 / 展开态 max(侧栏格右缘, 108)）；
  //   · bandWidth     = 带子总宽 = **对话区格右缘**（= 活动栏 + 侧栏 + 对话区；
  //     编辑器/终端列上方仍无标题栏，故不含它）。
  // 量 GridView 的**格**（branchCell，宽度=列宽），不量 leaf（leaf 已被
  // leafTopOffset 下移让位带子，其 rect 的 top 不是列顶）——故用 leaf 上溯一层。
  const [sidebarRight, setSidebarRight] = useState(296)
  const [conversationRight, setConversationRight] = useState(0)
  // 依赖 integrationsOpen：集成中心打开期间两列都被隐藏（量到 0），关闭后要用
  // **立即**重量到的几何复位——否则会拿旧值/0 闪一帧（下一次 interval 才修）。
  useEffect(() => {
    let raf: number | null = null
    const cellRight = (slot: string): number => {
      const leaf = document.querySelector(`[data-slot="${slot}"]`)
      const cell = leaf?.parentElement ?? null
      if (cell === null) return 0
      // 隐藏态（集成中心打开 / 该 leaf 未布局）量到 0——0 是假几何，不是真实
      // 宽度，写进去会让带子塌成 0 宽并留下错值。调用方跳过本轮，保留上次真值。
      return Math.round(cell.getBoundingClientRect().right)
    }
    const measure = () => {
      raf = null
      const side = cellRight('corum.sidebar')
      if (side > 0) setSidebarRight(side)
      const convo = cellRight('conversation')
      if (convo > 0) setConversationRight(convo)
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
  }, [integrationsOpen])

  // 控件段右缘：折叠态取常量——**不能靠测量**（侧栏整列隐藏后 GridView 把该格
  // visibility:hidden 但保留折叠前的 inline width，量到的「侧栏右缘」仍是旧值，
  // 带子会虚胖）。展开态取测量值，下限常量兜住（消掉切换瞬间测量滞后一帧的裁切）。
  const controlsWidth = sidebarCollapsed
    ? TITLEBAR_COLLAPSED_WIDTH
    : Math.max(sidebarRight, TITLEBAR_COLLAPSED_WIDTH)
  // 带子总宽：对话区格右缘；取不到（对话区被拖走/隐藏/浮出）或比控件段还窄时
  // 退控件段宽（只画控件段，不画会话段）。
  const bandWidth = conversationRight > controlsWidth ? conversationRight : controlsWidth

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
            const next = rescaleGrid(g, w, h, collapsedRef.current)
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

  // 插件中心面板已拆出壳（corum-ide-plugin-manager-ui 插件）：触发原先在本组件
  // 渲染的「插件」标题栏按钮上（→ LayoutController → grid actions 订阅面 → 该
  // 插件开自己的 modal）。该按钮已按 2026-09-30 定案移除（插件管理入口改走
  // 活动栏「插件」→ 集成中心），故这里不再取用 onOpenPluginManager；注入面与
  // grid actions 的 openPluginManager 通路**保留未删**（改契约牵动该 UI 插件）。

  const renderGridSlot = useCallback((slot: GridSlot): ReactNode => {
    if (slot === 'corum.sidebar') {
      // 侧栏（design.pen col-nav）：left-body 内的圆角 18 玻璃卡片（项目/任务双
      // 模式）。顶部贯通标题栏行（窗口标题栏 + Agent 标题栏）在 AppFrame 主 JSX
      // 渲染，不在此 leaf 内。折叠态：leaf 被 GridView 收到 collapsedWidth=0
      // （整列隐藏，2026-09-30 定案），只隐藏内容——**不再渲染图标轨**（PR3：
      // 原 SidebarRail 折叠替身已退役；展开入口在常驻标题栏最左的折叠/展开钮，
      // 见 NavTitleBar）。
      if (sidebarCollapsed) return null
      return (
        <div className={css.sidebarPane}>
          <div className={css.sidebarPaneBody}>
            {renderSlot('corum.sidebar', { wide: true, width: 280, expandSidebar: () => { /* grid mode: rail fold N/A */ } })}
          </div>
        </div>
      )
    }
    // 通用渲染：交给框架的 slot 系统（B2：经 renderDynamicSlot 边界 helper
    // 收窄动态槽 → SlotMap，见该 helper 注释）。未注册的 slot 返回 null → 空态。
    const content = renderDynamicSlot(renderSlot, slot)
    if (content === null || content === false) {
      return (
        <div className={css.emptySlot}>
          <span className={css.emptySlotText}>{slot}</span>
          <span className={css.emptySlotHint}>此区域暂无内容</span>
        </div>
      )
    }
    return content
  }, [renderSlot, sidebarCollapsed])
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

  // 默认隐藏的三区域（detachedSlots 消费：运行时隐藏、不动树、不持久化）。
  // DEFAULT_HIDDEN/userShown 在上方 onTogglePanels 前声明；这里只算有效集合。
  const hiddenByDefault = useMemo<ReadonlySet<string>>(
    () => new Set(DEFAULT_HIDDEN.filter((s) => !userShown.has(s))),
    [userShown],
  )
  // 合并浮动窗 detached 与默认隐藏。
  const effectiveDetached = useMemo<ReadonlySet<string>>(
    () => new Set([...detached, ...hiddenByDefault]),
    [detached, hiddenByDefault],
  )
  // 会话列表**恒锁 220**（用户 2026-10-03：「把 session list 的最小宽度再调小，
  // 然后固定，不允许变更宽度」）。原先只在「右侧三栏全隐藏」时才锁 300；现在改为
  // **无条件锁**（折叠态除外）：
  //   - 走 lockedSlots 而非 SlotMeta.minWidth —— locked 格宽度锁定、不参与 weight
  //     分配、**两侧 sash 隐藏不可拖**，正是「不允许变更宽度」的现成机制；
  //   - 显式排除折叠态：GridView 里 lockedSlots 优先于 collapsedSlots，若折叠时仍
  //     锁着，collapsedWidth=0 会被压制、折叠失效（2026-08-31 已付过这笔学费）。
  const lockedSlots = useMemo<ReadonlyMap<string, number>>(
    () => (sidebarCollapsed ? new Map() : new Map([['corum.sidebar', SIDEBAR_LOCKED_WIDTH]])),
    [sidebarCollapsed],
  )

  // ── Floating-window mode ──
  const floatKey = floatingSlotKey()
  // 浮窗也必须接 grid actions——slot occupant（EditorColumn 等）挂载时经
  // ctx.layout 调 closeRegion/setRegionHidden，LayoutController.#requireGrid
  // 未接线会抛「grid actions not wired」把整个 slot entry 打崩（浮窗纯黑）。
  // 浮窗语义：closeRegion = 关浮窗回主窗（窗口自身关闭即 notifyFloating(false)
  // 恢复主窗列）；其余区域操作在浮窗无意义，no-op 兜底。
  //
  // **同步接线（渲染期，非 useEffect）**：slot occupant 的 effect（EditorColumn
  // 的 showEditor/restore tabs）与 AppFrame 的 effect 同批 flush，子组件 effect
  // 先于父组件跑——useEffect 接线太晚，occupant 的 #requireGrid 已在子 effect
  // 里抛错。渲染期同步 attach 保证 occupant 任何 effect 到达前已就位。
  // attachGridActions 是 LayoutController 的纯赋值（非 React setState），渲染期
  // 调用无副作用；useMemo 保证 floatingGridActions 引用稳定，幂等。
  const floatingGridActions = useMemo<GridActions>(() => ({
    setRegionHidden: (_slot: string, _hidden: boolean) => {},
    closeRegion: (_slot: string) => { window.close() },
    // 浮窗无 userShown/树 hidden 语义——点亮区域在浮窗无意义，no-op 兜底。
    // （会话顶栏的轨迹按钮在浮窗里也走这里：浮窗没有网格，点击静默无效。）
    showRegion: (_slot: string) => {},
    toggleRegion: (_slot: string) => {},
    resetLayout: () => {},
    toggleSidebar: () => {},
    openNewTaskForm: () => {},
    onOpenNewTaskForm: (_listener: () => void) => () => {},
    consumePendingNewTaskForm: () => false,
    // 浮窗无插件中心触发语义（主窗标题栏才有入口）——no-op 兜底（防 #requireGrid 抛错）。
    openPluginManager: () => {},
    onOpenPluginManager: (_listener: () => void) => () => {},
    isInGrid: (_slot: string) => false,
    hiddenSlotsSnapshot: () => [],
    onGridChange: (_listener: () => void) => () => {},
  }), [])
  if (floatKey !== null) {
    attachGridActions(floatingGridActions)
  }
  if (floatKey !== null) {
    const mountable = FLOATABLE_SLOTS.has(floatKey)
    // design.pen i5ie6（会话拖出为独立窗口）：承载会话的浮动窗**不画独立 chrome
    // 行**——统一标题栏带子本身就是窗口顶栏（variant:'floating' =
    // `[红绿灯让位 66][会话段]`，会话段即原会话顶栏卡片），左侧让出红绿灯、
    // 整条承担拖窗。
    // 其余槽位（编辑器/终端/轨迹…）没有会话顶栏，保留 FloatingChrome 提供拖拽区与标题。
    const selfChrome = SELF_CHROME_FLOATING_SLOTS.has(floatKey)
    return (
      <div className={css.floatingRoot} data-floating={floatKey} data-self-chrome={selfChrome || undefined}>
        {selfChrome
          /* 统一标题栏带（P3）：内容全归 corum.titlebar occupant；壳只给定位与宽度。 */
          ? <FloatingTitlebarBand renderSlot={renderSlot} />
          : <FloatingChrome slotKey={floatKey} />}
        <div className={css.floatingBody}>
          {mountable
            ? renderDynamicSlot(renderSlot, floatKey)
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
      {/* 统一标题栏**惰性挂载位**（2026-09-30，design.pen 统一标题栏）：壳只提供
          定位与宽度（absolute 浮层，覆盖 活动栏 + 侧栏 + 对话区 上方），**不带任何
          app-region** —— 带子的全部内容（拖拽命中区 + 窗口控制按钮 + 会话段）由
          `@corum/corum-ui-titlebar` 的 `corum.titlebar` occupant 产生。
          为什么要单一 owner：这条带子此前被两个 owner 分别持有（本壳 + 对话区 leaf
          内的会话顶栏），折叠态下后者的空态拖拽带（`app-region: drag`）盖住本壳
          的控件层，而 drag 位图**不遵守 z-index**、显式 `no-drag` 也凿不掉 ⇒ 物理
          鼠标点「展开」被当拖拽吞掉（双击还触发 macOS 标题栏缩放）。CDP 合成事件
          绕过 drag 命中判定，故这类 bug 脚本验不出。

          **集成中心打开时挂载位隐藏**（PR4，`display:none` ⇒ 零 drag 矩形，与
          `.railDragBand` 互斥）：集成中心是全屏独占工作面，带子留在画面上既无意义、
          又和它的面板头抢顶部 40px。窗口拖拽由面板头自己承担（IntegrationsFrame）。

          右侧（编辑器/资源管理器/终端上方）无浮层——纯内容区；GridView 的
          leafTopOffset 给 sidebar/conversation 格内容让位本带子。 */}
      <div
        className={css.titlebarMount}
        style={{ right: 'auto', width: bandWidth }}
        hidden={integrationsOpen}
      >
        {/* fallback：插件未装载/被停用时至少留一条红绿灯让位拖拽带，窗口仍可拖
            （不是第二条 drag owner——此时带子里没有 occupant）。 */}
        {renderSlot(
          'corum.titlebar',
          { variant: 'main', bandWidth, controlsWidth },
          { fallback: <div className={css.titlebarFallback} data-drag-band="main:left-inset" aria-hidden="true" /> },
        )}
      </div>

      {/* 工作面行（PR3 活动栏 + PR4 集成中心）：左 = 常驻活动栏（**网格外**的
          固定 76px 列 = 红绿灯让位宽，2026-09-30 定案），右 = 自由二维网格
          （GridView）**或**集成中心全屏面板。
          活动栏刻意不走网格内新槽——网格数学（leafMinSize / collapsedWidth /
          drop 目标）会把它算进布局，而它是壳级导航、不是用户可拖拽/可隐藏的区域。

          集成中心全幅（design.pen 画板 F）：右列由 GridView 换成 IntegrationsFrame
          （占满活动栏右侧全部宽度；侧边栏与会话区**一起**让位——集成中心是统一
          模型里「没有侧栏部分的工作面」，故全幅是自然结果）。

          **GridView 保活方案：保持挂载 + CSS 隐藏**（`hidden` 属性 + display:none），
          不是条件渲染。理由：条件渲染=卸载，会重置会话视图整棵子树的组件态
          （Monaco 编辑器内容与撤销栈、终端 xterm 缓冲、对话区滚动位、details 抽屉），
          「× 关闭回会话布局」之后用户看到的是被清空的工作面。这与 GridView 的
          detached 语义（脱出的 leaf 不挂载 occupant）刻意相反，是画板 F「平时隐藏、
          × 关闭回会话布局」这条语义要求的。
          代价（如实登记，不在本 PR 处理）：隐藏期间 GridView 的 ResizeObserver 测到
          0 尺寸 → layout() 早退（w<=0 即 return），格子样式不被改写；重新显示时
          ResizeObserver 立即回调，按**离开时的 weights** 重排。窗口在隐藏期间被
          缩放的话，frames 的 frameBox/weights 落后于新尺寸 ⇒ 重排后各列回到旧像素
          占比（偏离「等比重标定」），再拖一次 sash 即恢复。属可接受的回退，
          不在本 PR 动 grid/GridView 一行（心脏手术纪律）。 */}
      <div className={css.workbenchRow}>
        <ActivityBar
          face={integrationsOpen ? 'integrations' : sidebarMode}
          projectAvailable={projectAvailable}
          sidebarCollapsed={sidebarCollapsed}
          onSelectFace={onSelectFace}
          onSearch={onSearchFace}
          onPlugins={onPluginsFace}
          settingsSlot={renderSlot('sidebar.settings', { wide: false })}
          openSettingsSection={openSettingsSection}
          updateApi={updateApi}
          updateHeroImageSrc={updateHeroImageSrc}
          editorApi={editorApi}
        />

        {/* Main Row —— 自由二维网格（GridView），顶到窗口顶（占满 frame 全高）。
            终端 corum.panel 已纳入网格（默认底部行），可调宽、可与其他区域自由
            组合。leafTopOffset 给 root row 的 sidebar/conversation 格内容下移
            54px（40 标题栏 + 14 间距）让位上方标题栏浮层；right-col 格 offset=0
            顶到容器顶（设计稿 left-col vs right-col 的顶部差异）。

            集成中心打开时本行整列隐藏（不是卸载——见上方保活方案注释）。 */}
        <div
          className={css.mainRow}
          data-gridview
          ref={mainRowRef}
          hidden={integrationsOpen}
        >
          <GridView
            root={grid}
            renderSlot={renderGridSlot}
            onResize={onGridResize}
            onDrop={onGridDrop}
            onPopOut={popOutSlot}
            onDropNewSlot={onDropNewSlot}
            detachedSlots={effectiveDetached}
            transparentSlots={IDE_TRANSPARENT_SLOTS}
            leafTopOffset={TITLEBAR_CLEARANCE}
            collapsedSlots={COLLAPSED_SIDEBAR}
            lockedSlots={lockedSlots}
          />
        </div>

        {/* 集成中心（PR4，design.pen 画板 F）：全屏独占工作面面板。
            壳直接在网格外渲染它（不经槽座位）——它是**工作面**而非可拖拽区域，
            网格内会成为用户能拖走/隐藏的 leaf（同活动栏的理由）。
            内容页由两个内容包经 ctx.slots.inject 挂进三个子槽（声明权在本壳
            index.tsx 的 root children 表）。 */}
        {integrationsOpen && (
          <IntegrationsFrame
            section={integrationsSection}
            onSelectSection={setIntegrationsSection}
            onClose={onCloseIntegrations}
            renderSlot={renderSlot}
          />
        )}
      </div>

      {/* 次侧栏: official ui-conversation DetailsPanel (on-demand drawer).
          集成中心打开时不渲染：它是**会话区**的详情抽屉（absolute 覆盖右缘、
          z-index 10），留着会浮在集成中心面板上方（面板 z-index 更低）——
          与「侧边栏与会话区均隐藏」这条语义相悖。 */}
      {!integrationsOpen && panels.details > 0
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
