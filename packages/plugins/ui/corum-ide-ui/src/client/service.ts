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
 * uSES 兼容的可观测快照源（组件侧经 InjectFace 绑定为选择器 Hook）。
 * getSnapshot 返回的引用在模式不变时保持稳定。
 */
export interface SidebarModeSource {
  getSnapshot(): SidebarMode
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

  resetLayout(): void {
    this.#requireGrid().resetLayout()
  }

  openNewTaskForm(): void {
    this.#requireGrid().openNewTaskForm()
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
