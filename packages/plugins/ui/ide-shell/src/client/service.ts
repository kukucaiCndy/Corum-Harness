/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 *
 * 官方三方法（toggleSidebar/openDetails/closeDetails）保持原有语义，官方
 * ui-conversation / app-shell 照常解析；togglePanel 是 IDE 壳的底部面板开合。
 * GridView 接管列/行几何后，editor/explorer/activity 等动作已删除——网格
 * 窗格的显隐/拆分由拖放与脱出持有，不再有独立的 openEditor/toggleExplorer。
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other plugins
 * may trigger. 前三者是官方 ILayout 的精确语义；togglePanel 是壳的扩展。
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /** Toggle the bottom panel (collapsed header ⟷ default height). */
  togglePanel(): void
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
    // 侧栏显隐由网格持有（脱出/拖放），官方 toggleSidebar 的调用方只关心
    // 「切换侧栏」这一语义；GridView 模式下收窄为 no-op 的安全占位，待 S1
    // 接会话列表时再接回真实折叠。
  }

  openDetails(): void {
    this.#require().openDetails()
  }

  closeDetails(): void {
    this.#require().closeDetails()
  }

  togglePanel(): void {
    this.#require().togglePanel()
  }

  #require(): PanelActions {
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
