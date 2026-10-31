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
  /** 测试中心是否打开（全屏独占工作面；与 integrationsOpen 互斥）。 */
  testSuiteOpen: boolean
}

/** uSES 兼容的 chrome 快照源（getSnapshot 引用只在字段变化时更新）。 */
export interface ChromeSource {
  getSnapshot(): ChromeState
  subscribe(listener: () => void): () => void
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
  /** 订阅新建表单信号；AppFrame 尚未接线时保留订阅，返回可提前调用的退订函数。 */
  onOpenNewTaskForm(listener: () => void): () => void
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
  /**
   * 打开/关闭测试中心（幂等；全屏独占工作面）。打开时自动关闭集成中心
   * （同一时刻只有一个全屏工作面）。关闭时不动集成中心。
   */
  setTestSuiteOpen(open: boolean): void
  /** 测试中心开关注取反（打开时互斥关闭集成中心）。 */
  toggleTestSuite(): void
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
  #chrome: ChromeState = { sidebarCollapsed: false, integrationsOpen: false, testSuiteOpen: false }
  /** chrome 监听者集（字段变化时广播）。 */
  #chromeListeners = new Set<() => void>()
  /** AppFrame 接线前到达的插件中心订阅（attachGrid 时补进 grid actions）。 */
  #pendingPluginManagerListeners = new Set<() => void>()
  /** 子组件 effect 先于 AppFrame 接线时，保留新建表单订阅及之后的退订句柄。 */
  #pendingNewTaskFormListeners = new Set<{ listener: () => void; dispose?: () => void }>()

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
    for (const pending of this.#pendingNewTaskFormListeners) pending.dispose = actions.onOpenNewTaskForm(pending.listener)
    this.#pendingNewTaskFormListeners.clear()
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

  openDetails(): void {
    this.#require().openDetails()
  }

  closeDetails(): void {
    this.#require().closeDetails()
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

  onOpenNewTaskForm(listener: () => void): () => void {
    if (this.#grid) return this.#grid.onOpenNewTaskForm(listener)
    const pending: { listener: () => void; dispose?: () => void } = { listener }
    this.#pendingNewTaskFormListeners.add(pending)
    return () => {
      this.#pendingNewTaskFormListeners.delete(pending)
      pending.dispose?.()
    }
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
    if (this.#chrome.integrationsOpen === open) {
      // 幂等：值未变。但若打开集成中心时测试中心还开着，需互斥关闭它——
      // 集成中心此前已是 true（本分支命中）而测试中心也 true 是不该出现的
      // 状态组合，仍兜底收一次（保证不变式：同一时刻只有一个全屏工作面）。
      if (open && this.#chrome.testSuiteOpen) {
        this.#chrome = { ...this.#chrome, testSuiteOpen: false }
        this.#broadcastChrome()
      }
      return
    }
    // 打开集成中心时互斥关闭测试中心（反之亦然——见 setTestSuiteOpen）。
    if (open && this.#chrome.testSuiteOpen) {
      this.#chrome = { ...this.#chrome, integrationsOpen: true, testSuiteOpen: false }
    } else {
      this.#chrome = { ...this.#chrome, integrationsOpen: open }
    }
    this.#broadcastChrome()
  }

  toggleIntegrations(): void {
    this.setIntegrationsOpen(!this.#chrome.integrationsOpen)
  }

  setTestSuiteOpen(open: boolean): void {
    if (this.#chrome.testSuiteOpen === open) {
      // 幂等：值未变。兜底：打开测试中心时集成中心还开着则互斥关闭。
      if (open && this.#chrome.integrationsOpen) {
        this.#chrome = { ...this.#chrome, integrationsOpen: false }
        this.#broadcastChrome()
      }
      return
    }
    // 打开测试中心时互斥关闭集成中心（反之亦然——见 setIntegrationsOpen）。
    if (open && this.#chrome.integrationsOpen) {
      this.#chrome = { ...this.#chrome, testSuiteOpen: true, integrationsOpen: false }
    } else {
      this.#chrome = { ...this.#chrome, testSuiteOpen: open }
    }
    this.#broadcastChrome()
  }

  toggleTestSuite(): void {
    this.setTestSuiteOpen(!this.#chrome.testSuiteOpen)
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

  #require(): PanelActions {
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }

  #requireGrid(): GridActions {
    if (this.#grid === undefined) throw new Error('layout: grid actions not wired (AppFrame not mounted)')
    return this.#grid
  }
}
