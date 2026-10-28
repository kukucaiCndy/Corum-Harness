/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 *
 * 官方三方法（toggleSidebar/openDetails/closeDetails）保持原有语义，官方
 * ui-conversation / app-shell 照常解析。GridView 接管列/行几何后，终端
 * （corum.panel）与其他区域同构——都是网格普通叶子，显隐/调宽/组合由分割树
 * 持有；区域显隐/关闭/重置/新建任务表单一律经本服务直连 AppFrame attach
 * 进来的网格 actions（attachGrid，与 attachPanels 同一「采纳 bound actions」
 * 模式），不再走 window CustomEvent 桥。
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** 侧栏模式（design mode-switch：任务=默认 / 项目）。 */
export type SidebarMode = 'task' | 'project'

/**
 * 「打开设置中心某 section」触发事件名（壳 openSettingsSection 广播，SettingsShell
 * 监听并 openSection）。插件中心入口改版后：点插件中心 → 打开设置「扩展面板」。
 * 一次性触发信号（detail 带 section id），同 bundle 经 window CustomEvent 传递。
 */
export const OPEN_SETTINGS_SECTION_EVENT = 'corum:open-settings-section'

/**
 * uSES 兼容的可观测快照源（组件侧经 InjectFace 绑定为选择器 Hook）。
 * getSnapshot 返回的引用在模式不变时保持稳定。
 */
export interface SidebarModeSource {
  getSnapshot(): SidebarMode
  subscribe(listener: () => void): () => void
}

/**
 * 窗口 chrome 状态（跨 bundle 单例）：侧栏折叠 + 集成中心开关。
 *
 * 2026-09-30 从 AppFrame 的局部 useState 收敛进本服务——标题栏改成独立插件
 * （`@corum/corum-ui-titlebar`）后，壳与插件都要读这两个值（红线 1：跨 bundle
 * 共享状态必须是 cordis 服务，禁止 window 全局/模块级单例）。
 */
export interface ChromeState {
  /** 侧栏是否折叠（折叠 = GridView 把 corum.sidebar 格宽收成 0，整列隐藏）。 */
  sidebarCollapsed: boolean
  /** 集成中心是否打开（全屏独占工作面；标题栏整行隐藏，拖窗由 railDragBand 补）。 */
  integrationsOpen: boolean
}

/** uSES 兼容的 chrome 快照源（getSnapshot 引用只在字段变化时更新）。 */
export interface ChromeSource {
  getSnapshot(): ChromeState
  subscribe(listener: () => void): () => void
}

/**
 * details 抽屉的真实开合状态（corum 壳自己的右表面）。
 *
 * 与官方 `PanelInfo` 的分工（2026-10-29 复核官方 0.2.1-rc.3 源码后定稿）：
 *   - 官方 `panelInfo.activePanelId` 是**中央主面板的选择**（`MainPanelId | null`
 *     — null = 显示 Conversation）。`ui-sidebar-right` 用它决定「会话级右栏内容
 *     是否显示」（`activePanelId === null ? selected?.sessionId : undefined`），
 *     **与 details 抽屉无关**。corum 壳没有注册任何 main panel ⇒ 该值恒 null，
 *     绝不能塞 `'details'`（那会让官方右栏以为有主面板占用而隐藏自己的会话内容）。
 *   - 所以 details 抽屉的真实状态由本服务的独立镜像面 `detailsSnapshot()` 承担，
 *     写点唯一 = AppFrame 把 store 的 `details > 0` 回送（见 `reportDetailsOpen`）。
 */
export interface DetailsState {
  /** 抽屉是否打开（= root layout store 的 `details > 0`）。 */
  readonly open: boolean
}

/** uSES 兼容的 details 快照源（getSnapshot 引用只在开合变化时更新）。 */
export interface DetailsSource {
  getSnapshot(): DetailsState
  subscribe(listener: () => void): () => void
}

/**
 * 官方 `openRightbar(track, fullscreen)` 的能力声明：corum 的 details 抽屉
 * **只有一种呈现**——docked 列（占一格宽、固定 DETAILS_DEFAULT），没有覆盖整帧
 * 的 fullscreen 形态。见 `ILayout.openRightbar` 的语义说明。
 */
export interface RightbarCapability {
  /** 是否支持「占一格宽」的 docked 呈现。 */
  readonly track: boolean
  /** 是否支持「覆盖整帧、隐藏外框 resize」的 fullscreen 呈现。 */
  readonly fullscreen: boolean
}

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * 网格区域操作面：AppFrame（网格树所有者）经 attachGrid 挂入。
 * 实现全部幂等：slot 不在树里时 close/setHidden 静默 no-op（AppFrame 侧告警），
 * 调用方无需先探测。
 */
export interface GridActions {
  /** 区域显隐（hidden，树保留、持久化）。 */
  setRegionHidden(slot: string, hidden: boolean): void
  /** 关闭区域（= setRegionHidden(slot, true)，可在插件中心视图管理恢复）。 */
  closeRegion(slot: string): void
  /**
   * 点亮区域（AppFrame showRegion 的单槽包装）：同时清两层隐藏——
   * ① userShown 运行时隐藏集（DEFAULT_HIDDEN 场景，setRegionHidden 管不到）；
   * ② 树 leaf.hidden 持久化标记（与 setRegionHidden(slot, false) 同效）。
   * 「corum:open-in-editor 点亮编辑器」等可编程入口用本方法，不再模拟点按钮。
   */
  showRegion(slot: string): void
  /**
   * 切换区域的显隐（等价于各快捷按钮的 toggleRegionVisibility 单槽包装）：
   * 显示 → 隐藏（移出 userShown + 树 hidden=true 持久化）；隐藏 → 显示（showRegion）。
   *
   * 2026-09-10「顶栏归会话」新增：轨迹按钮从壳的窗口标题栏迁进**会话级槽**
   * （session-bar.tsx），槽 occupant 拿不到 AppFrame 内部的 `userShown` 状态，
   * 故经本服务面回调。与 showRegion 的差别是「可关」——轨迹区域是 fixed 槽、
   * 不进插件中心视图管理，该按钮是唯一开关（用户 2026-09-09 定调）。
   */
  toggleRegion(slot: string): void
  /** 重置布局（按当前 frame 尺寸重算默认布局并持久化）。 */
  resetLayout(): void
  /** 切换侧栏 leaf 的 hidden（折叠 ⟷ 展开）。 */
  toggleSidebar(): void
  /**
   * 打开「新建任务表单」：通知当前已挂载的空态监听者；空态未挂载（在会话
   * 视图）时置 pending 标记，EmptyStateHero 下次挂载时认领。
   */
  openNewTaskForm(): void
  /** 订阅「新建任务表单」打开信号（EmptyStateHero 挂载时）。返回退订函数。 */
  onOpenNewTaskForm(listener: () => void): () => void
  /** 认领 pending 的「新建任务表单」标记（EmptyStateHero 挂载时调一次）。 */
  consumePendingNewTaskForm(): boolean
  /**
   * 打开插件中心：通知已挂载的插件中心监听者；插件未挂载时置 pending 标记，
   * 插件（corum-ide-plugin-manager-ui）apply 订阅时认领（与 openNewTaskForm
   * 同一 pending 模式——统一事件中心三-2，原 corum:open-plugin-manager 跨
   * bundle CustomEvent + 双份字面量镜像已退役）。
   */
  openPluginManager(): void
  /** 订阅「打开插件中心」信号（插件 apply 时；挂载即认领 pending）。返回退订函数。 */
  onOpenPluginManager(listener: () => void): () => void
  /** 判定某槽位当前是否在网格树里（视图管理的区域过滤）。 */
  isInGrid(slot: string): boolean
  /** 当前 hidden 槽位集合（稳定引用，变更后换引用；uSES getSnapshot 契约）。 */
  hiddenSlotsSnapshot(): readonly string[]
  /** 订阅网格树变更（hidden 集随之变；uSES subscribe 契约）。返回退订函数。 */
  onGridChange(listener: () => void): () => void
}

/** The outward layout face (`ctx.layout`): the official ILayout exact semantics + corum 网格区域操作。 */
export interface ILayout {
  /**
   * Official 0.2.1 `PanelInfo` face — `sidebar-right` and its dependents
   * (`skill`/`subagent`/`reference`/`schedule`/`plan`) inject `layout` and call
   * `layout.panelInfo.getSnapshot()` / `.subscribe()`.
   *
   * 官方语义（0.2.1-rc.3 `dsh-client-ui-layout` 源码）：`activePanelId` 是
   * **中央主面板的选择**，null = 显示 Conversation；`ui-sidebar-right` 用它判断
   * 「会话级右栏内容是否显示」。corum 壳不注册任何 main panel，Conversation 恒为
   * 中央面 ⇒ 本值**恒 null**（不是 no-op 假值，而是事实）。
   *
   * 该值在本壳里永不变化 ⇒ `subscribe` 只登记/退订、从不广播，`getSnapshot`
   * 返回同一个 frozen 引用（uSES 契约：不变时引用稳定）。
   *
   * details 抽屉的真实开合**不在这里**（它不属于 main panel 选择），见
   * `detailsSnapshot()`。
   */
  readonly panelInfo: {
    getSnapshot(): { activePanelId: string | null }
    subscribe(listener: () => void): () => void
  }
  /**
   * details 抽屉的真实开合镜像（uSES 契约：引用只在开合变化时换）。
   *
   * 为什么需要镜像：抽屉的**唯一事实源**是 root layout store 的 `details` 宽
   * （`stores.ts`），写它有两条路——本服务的 `openDetails`/`closeDetails`，
   * 以及壳内直接写 store actions 的地方（AppFrame 的 backdrop 点击、
   * 会话切换复位）。后者绕过本服务，所以任何「本地布尔 + 只在两个方法里更新」
   * 的实现都会陈旧。现方案：AppFrame 订阅 store 真值并回送 `reportDetailsOpen`
   * （单一写点），本镜像只是真值的只读投影，外部开关同样会广播。
   */
  detailsSnapshot(): DetailsSource
  /**
   * 壳内部报告面（不进官方 ILayout 语义）：AppFrame 把 store 里 `details > 0`
   * 的真实值回送进来。AppFrame 是纯组件拿不到本服务，靠根注册 inject 面反向
   * 下发（与 `attachGridActions` 同一模式）。
   */
  reportDetailsOpen(open: boolean): void
  /**
   * 右栏能力声明。官方 `openRightbar(track, fullscreen)` 是**右表面在报告自己的
   * 呈现**（不是命令）：track = 正常宽度占一格网格轨道（含 fullscreen 之下），
   * fullscreen = 覆盖整帧并隐藏外框 resize 手柄。
   *
   * corum 的 details 抽屉只有 docked 呈现（固定 DETAILS_DEFAULT 宽的一列），
   * 没有 fullscreen/无轨道形态 ⇒ 本能力为 `{ track: true, fullscreen: false }`。
   * `openRightbar` 对不支持的呈现**不伪映射**（见其注释）。
   */
  readonly rightbarCapability: RightbarCapability
  /**
   * 桥到 details 抽屉：把官方「右表面已显示」的报告落到 corum 唯一的右表面。
   *
   * 只接受本壳能力内的呈现（`track === true && fullscreen === false`）→
   * `openDetails()`；请求 fullscreen / 无轨道时**不打开**并记一次告警（不做
   * 「假装 fullscreen」「忽略参数照开」这类伪映射——那会让官方侧以为自己的
   * 呈现被满足）。
   */
  openRightbar(track: boolean, fullscreen: boolean): void
  /** 桥到 closeDetails（官方「右表面已隐藏」的报告）。 */
  closeRightbar(): void
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /** 区域显隐（hidden，树保留、持久化；插件中心视图管理等调用）。 */
  setRegionHidden(slot: string, hidden: boolean): void
  /** 关闭区域（各区域工具组「×」按钮；= setRegionHidden(slot, true)）。 */
  closeRegion(slot: string): void
  /**
   * 点亮区域：同时清 userShown 运行时隐藏（DEFAULT_HIDDEN 场景）与树
   * leaf.hidden 持久化标记。「corum:open-in-editor 点亮编辑器」等可编程入口
   * 经本方法显示区域（取代「读 localStorage 字符串匹配 + 模拟点按钮」hack）。
   */
  showRegion(slot: string): void
  /**
   * 切换区域显隐（会话顶栏的轨迹按钮经 session-bar 槽调用；浮窗内为 no-op）。
   * 语义同 GridActions.toggleRegion。
   */
  toggleRegion(slot: string): void
  /** 重置布局（视图菜单「重置布局」；回退默认布局的几何）。 */
  resetLayout(): void
  /**
   * 打开空态「新建任务表单」（侧栏顶部「新会话」按钮）。跨会话域：
   * 调用方负责先回空态（sessions.clear 取消选中 → 对话区回落到
   * 空态），本方法只把「打开表单」信号送达 EmptyStateHero（已挂载直推 /
   * 未挂载置 pending 由挂载时认领）。
   */
  openNewTaskForm(): void
  /**
   * 打开插件中心：信号经 grid actions 的订阅面送达 corum-ide-plugin-manager-ui
   * 插件（该插件打开自己的 modal 面板；未挂载时 pending 由订阅认领——
   * 统一事件中心三-2 服务化，原 CustomEvent 广播已退役）。
   */
  openPluginManager(): void
  /**
   * 订阅「打开插件中心」信号（corum-ide-plugin-manager-ui 经能力接口收窄 +
   * 可选链消费，dev-conventions §2.4 红线 2/3）。返回退订函数。
   */
  onOpenPluginManager(listener: () => void): () => void
  /**
   * 打开设置中心某 section：广播 OPEN_SETTINGS_SECTION_EVENT，SettingsShell 监听后
   * openSection(id)（打开面板并选中该 section）。
   */
  openSettingsSection(id: string): void
  /**
   * 网格 hidden 槽位集合（uSES getSnapshot 契约，稳定引用）。
   * 插件中心视图管理的读面（壳内 AppFrame attach 的 grid actions 提供）。
   */
  hiddenSlotsSnapshot(): readonly string[]
  /** 订阅网格树变更（uSES subscribe 契约）。返回退订函数。 */
  onGridChange(listener: () => void): () => void
  /** 判定某槽位当前是否在网格树里（视图管理的区域过滤）。 */
  isInGrid(slot: string): boolean
  /**
   * 写侧栏模式（task/project）。幂等：同值不重复广播。写方 = 侧栏骨架
   * （模式切换）+ 会话域空态操作（openProject/newProject→project、
   * openTask/newTask→task，原 window 全局 __corumSidebarMode 的越权写收敛
   * 进本服务面）。
   */
  setSidebarMode(mode: SidebarMode): void
  /** 读当前侧栏模式（快照，引用稳定）。 */
  getSidebarMode(): SidebarMode
  /** 订阅侧栏模式变化。返回退订函数。 */
  onSidebarModeChange(listener: () => void): () => void
  /** uSES 兼容源：组件侧经 InjectFace 绑定为选择器 Hook 用。 */
  sidebarModeSnapshot(): SidebarModeSource
  /**
   * 折叠/展开侧栏（幂等）。折叠 = GridView 把 corum.sidebar 格宽收成 0（整列
   * 隐藏，见 ide-layout.ts 的 collapsedWidth: 0）。写方 = 标题栏插件 + 壳的
   * 活动栏便利入口（点当前激活的工作面图标 ⇄ 折叠/展开）。
   */
  setSidebarCollapsed(collapsed: boolean): void
  /** 折叠 ⟷ 展开（= setSidebarCollapsed 取反）。 */
  toggleSidebarCollapsed(): void
  /** 打开/关闭集成中心（幂等；全屏独占工作面）。 */
  setIntegrationsOpen(open: boolean): void
  /** 集成中心开关注取反。 */
  toggleIntegrations(): void
  /** 读 chrome 状态（快照：引用只在字段变化时更新）。 */
  getChrome(): ChromeState
  /** uSES 兼容源：组件侧经 InjectFace 绑定为选择器 Hook 用。 */
  chromeSnapshot(): ChromeSource
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #grid: GridActions | undefined
  /** 侧栏模式（服务单例状态：本服务经 ctx.layout 跨 bundle 单例，故模式天然全局一致）。 */
  #sidebarMode: SidebarMode = 'task'
  /** 侧栏模式监听者集（setSidebarMode 写值变化时广播）。 */
  #sidebarModeListeners = new Set<() => void>()
  /**
   * 窗口 chrome 状态（侧栏折叠 / 集成中心）。与 #sidebarMode 同为**本服务的
   * 单例状态**（经 ctx.layout 跨 bundle 一致）。⚠️ 引用**只在字段变化时换**
   * ——uSES getSnapshot 契约要求不变时引用稳定，否则 React 选择器 Hook 会
   * 无限重渲染（与 AppFrame 里 hiddenSlotsSnapshot 同款约束）。
   */
  #chrome: ChromeState = { sidebarCollapsed: false, integrationsOpen: false }
  /** chrome 监听者集（字段变化时广播）。 */
  #chromeListeners = new Set<() => void>()
  /** AppFrame 接线前到达的插件中心订阅（attachGrid 时补进 grid actions）。 */
  #pendingPluginManagerListeners = new Set<() => void>()
  /**
   * details 抽屉开合镜像（**只读投影**，唯一写点 = `reportDetailsOpen`）。
   * 引用只在开合变化时换（uSES getSnapshot 契约），初始 false 与 store 的
   * `init: { details: 0 }` 一致；AppFrame 首次报告会立刻校正为真值。
   */
  #details: DetailsState = { open: false }
  /** details 镜像订阅者集（真实开合变化时广播）。 */
  #detailsListeners = new Set<() => void>()
  /**
   * 已告警过的「不支持的右栏呈现」签名集：`openRightbar` 对 fullscreen /
   * 无轨道报告只告警一次（每次进程、每个签名一次），避免官方侧每次挂载刷日志。
   */
  #reportedUnsupportedRightbar = new Set<string>()

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /**
   * 采纳 AppFrame（网格树所有者）的区域操作面。AppFrame 是纯组件拿不到
   * 本服务实例，反向经根注册 inject 返回的 hooks.gridActions 桥接面把
   * actions 交回（见 index.tsx 的 inject 工厂与 AppFrame 的 useEffect）。
   */
  attachGrid(actions: GridActions): void {
    this.#grid = actions
    // 补订阅：接线前到达的插件中心 listener 全部挂进 grid actions（pending
    // 认领逻辑在 grid actions 的 onOpenPluginManager 内部，补订阅即继承）。
    if (this.#pendingPluginManagerListeners.size > 0) {
      for (const listener of this.#pendingPluginManagerListeners) actions.onOpenPluginManager(listener)
      this.#pendingPluginManagerListeners.clear()
    }
  }

  toggleSidebar(): void {
    // 侧栏显隐由网格持有：直连 AppFrame attach 的 grid actions 切换
    // corum.sidebar leaf 的 hidden（原 TOGGLE_SIDEBAR_EVENT 事件桥已退役）。
    this.#requireGrid().toggleSidebar()
  }

  // 官方 PanelInfo 面：中央主面板选择恒 null（见 ILayout.panelInfo 注释）。
  // 引用恒定（frozen 单例）⇒ subscribe 无需广播任何变化。
  readonly panelInfo = {
    getSnapshot: (): { activePanelId: string | null } => PANEL_INFO_CONVERSATION,
    subscribe: (_listener: () => void): (() => void) => () => {},
  }

  // 官方 openRightbar 报告面 → corum details 抽屉（能力受限，见 ILayout 注释）。
  readonly rightbarCapability: RightbarCapability = { track: true, fullscreen: false }

  openRightbar(track: boolean, fullscreen: boolean): void {
    // 只接受本壳能力内的呈现：docked（占轨道、非 fullscreen）。
    if (!track || fullscreen) {
      this.#warnUnsupportedRightbar(track, fullscreen)
      return
    }
    this.openDetails()
  }

  closeRightbar(): void {
    this.closeDetails()
  }

  detailsSnapshot(): DetailsSource {
    return {
      getSnapshot: () => this.#details,
      subscribe: (listener) => {
        this.#detailsListeners.add(listener)
        return () => { this.#detailsListeners.delete(listener) }
      },
    }
  }

  reportDetailsOpen(open: boolean): void {
    if (this.#details.open === open) return
    this.#details = { open }
    for (const listener of [...this.#detailsListeners]) listener()
  }

  openDetails(): void {
    // 写 store 的声明式 action（幂等：details 已是非 0 时 store 侧不动）。
    // 不在本地抢先改镜像：镜像只跟真实 store 值走（AppFrame 报告），否则
    // 「本地以为开着 / store 已被外部关掉」的窗口期会吞掉真实的 open 写。
    this.#panels?.openDetails()
  }

  closeDetails(): void {
    this.#panels?.closeDetails()
  }

  setRegionHidden(slot: string, hidden: boolean): void {
    this.#requireGrid().setRegionHidden(slot, hidden)
  }

  closeRegion(slot: string): void {
    this.#requireGrid().closeRegion(slot)
  }

  showRegion(slot: string): void {
    this.#requireGrid().showRegion(slot)
  }

  toggleRegion(slot: string): void {
    this.#requireGrid().toggleRegion(slot)
  }

  resetLayout(): void {
    this.#requireGrid().resetLayout()
  }

  openNewTaskForm(): void {
    this.#requireGrid().openNewTaskForm()
  }

  /**
   * 插件中心触发：经 grid actions 订阅面通知 corum-ide-plugin-manager-ui 插件
   * 打开插件市场浮层（搜索/精选/卡片网格）。插件未挂载时由 grid actions 置
   * pending，插件 apply 订阅时认领（三-2 服务化，原 CustomEvent 广播 + 双份
   * 字面量镜像已退役——编译期联动恢复：本面改名则消费端类型报错）。
   */
  openPluginManager(): void {
    this.#requireGrid().openPluginManager()
  }

  onOpenPluginManager(listener: () => void): () => void {
    // AppFrame 未挂载（grid actions 未接线）时队列缓冲：插件 apply 早于
    // AppFrame 挂载是合法时序（cordis 激活序不定），接线后补订阅并照常
    // 认领 pending——不能让 #requireGrid 把插件 activate 打崩。
    if (this.#grid === undefined) {
      this.#pendingPluginManagerListeners.add(listener)
      return () => { this.#pendingPluginManagerListeners.delete(listener) }
    }
    return this.#grid.onOpenPluginManager(listener)
  }

  /**
   * 打开设置中心某 section：广播 OPEN_SETTINGS_SECTION_EVENT（detail=section id），
   * SettingsShell 监听后 openSection(id)（打开面板并选中该 section）。
   */
  openSettingsSection(id: string): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: id }))
    }
  }

  hiddenSlotsSnapshot(): readonly string[] {
    return this.#requireGrid().hiddenSlotsSnapshot()
  }

  onGridChange(listener: () => void): () => void {
    return this.#requireGrid().onGridChange(listener)
  }

  isInGrid(slot: string): boolean {
    return this.#requireGrid().isInGrid(slot)
  }

  setSidebarMode(mode: SidebarMode): void {
    if (this.#sidebarMode === mode) return
    this.#sidebarMode = mode
    for (const listener of [...this.#sidebarModeListeners]) listener()
  }

  getSidebarMode(): SidebarMode {
    return this.#sidebarMode
  }

  onSidebarModeChange(listener: () => void): () => void {
    this.#sidebarModeListeners.add(listener)
    return () => { this.#sidebarModeListeners.delete(listener) }
  }

  sidebarModeSnapshot(): SidebarModeSource {
    return {
      getSnapshot: () => this.getSidebarMode(),
      subscribe: (listener) => this.onSidebarModeChange(listener),
    }
  }

  setSidebarCollapsed(collapsed: boolean): void {
    if (this.#chrome.sidebarCollapsed === collapsed) return
    this.#chrome = { ...this.#chrome, sidebarCollapsed: collapsed }
    this.#broadcastChrome()
  }

  toggleSidebarCollapsed(): void {
    this.setSidebarCollapsed(!this.#chrome.sidebarCollapsed)
  }

  setIntegrationsOpen(open: boolean): void {
    if (this.#chrome.integrationsOpen === open) return
    this.#chrome = { ...this.#chrome, integrationsOpen: open }
    this.#broadcastChrome()
  }

  toggleIntegrations(): void {
    this.setIntegrationsOpen(!this.#chrome.integrationsOpen)
  }

  getChrome(): ChromeState {
    return this.#chrome
  }

  chromeSnapshot(): ChromeSource {
    return {
      getSnapshot: () => this.getChrome(),
      subscribe: (listener) => {
        this.#chromeListeners.add(listener)
        return () => { this.#chromeListeners.delete(listener) }
      },
    }
  }

  /** chrome 字段变化后广播（写入方已保证值真的变了）。 */
  #broadcastChrome(): void {
    for (const listener of [...this.#chromeListeners]) listener()
  }

  /**
   * 壳内部面（不进 ILayout）：EmptyStateHero 经 conversation inject 面拿到
   * 的订阅/认领入口直接代理到 grid actions。供 index.tsx 的 inject 工厂用。
   */
  gridActions(): GridActions | undefined {
    return this.#grid
  }

  #requireGrid(): GridActions {
    if (this.#grid === undefined) throw new Error('layout: grid actions not wired (AppFrame not mounted)')
    return this.#grid
  }

  /**
   * 记录并告警一次「不支持的右栏呈现报告」（fullscreen / 无轨道）。
   * 不抛错：官方侧只是报告呈现，壳无力满足时保持抽屉真值不动并留痕。
   * @param track - 报告里的「占网格轨道」位。
   * @param fullscreen - 报告里的「覆盖整帧」位。
   */
  #warnUnsupportedRightbar(track: boolean, fullscreen: boolean): void {
    const signature = `track=${track},fullscreen=${fullscreen}`
    if (this.#reportedUnsupportedRightbar.has(signature)) return
    this.#reportedUnsupportedRightbar.add(signature)
    console.warn(
      `corum-ide-ui: openRightbar(${signature}) 不在 details 抽屉能力内`
      + '（只支持 docked 列：track=true, fullscreen=false）——已忽略该呈现报告，抽屉真值不变。',
    )
  }
}

/**
 * 官方 `PanelInfo` 的恒定值：Conversation 永远是中央面，没有 main panel 被选中。
 * frozen 单例 ⇒ `getSnapshot()` 引用永不变化（uSES 契约）。
 */
const PANEL_INFO_CONVERSATION: { readonly activePanelId: string | null } = Object.freeze({ activePanelId: null })
