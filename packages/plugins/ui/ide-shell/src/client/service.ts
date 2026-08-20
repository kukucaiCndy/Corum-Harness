/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 *
 * 官方三方法（toggleSidebar/openDetails/closeDetails）保持原有语义，官方
 * ui-conversation / app-shell 照常解析。GridView 接管列/行几何后，终端
 * （corum.panel）与其他区域同构——都是网格普通叶子，显隐/调宽/组合由分割树
 * 与 corum:close-region 事件持有，不再有独立的面板开合动作。
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'
import { TOGGLE_SIDEBAR_EVENT } from '@corum/shell-base/client'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/** The outward layout face (`ctx.layout`): the official ILayout exact semantics. */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  toggleSidebar(): void {
    // 侧栏显隐由网格持有：经 TOGGLE_SIDEBAR_EVENT 桥到 AppFrame（网格树
    // 所有者）切换 corum.sidebar leaf 的 hidden。纯组件 AppFrame 拿不到本
    // 服务实例，故走窗口事件（与 CLOSE_REGION_EVENT 同一桥模式）。
    window.dispatchEvent(new CustomEvent(TOGGLE_SIDEBAR_EVENT))
  }

  openDetails(): void {
    this.#require().openDetails()
  }

  closeDetails(): void {
    this.#require().closeDetails()
  }

  #require(): PanelActions {
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
