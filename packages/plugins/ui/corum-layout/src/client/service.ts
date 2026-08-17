/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 *
 * This is the corum IDE superset of the official ui-layout face. The three
 * inherited methods keep their exact semantics so every official consumer
 * (ui-sidebar's toggleSidebar, ui-conversation's openDetails/closeDetails,
 * app-shell's inject) behaves identically. The two additions
 * (togglePanel/toggleActivity) are the IDE shell's own panel transitions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger. The inherited methods are exactly the official
 * ILayout; the additions are the IDE shell's own panel transitions.
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /** Open the editor column (no-op when already open). */
  openEditor(): void
  /** Close the editor column. */
  closeEditor(): void
  /** Toggle the editor column (closed ⟷ default width). */
  toggleEditor(): void
  /** Open the explorer (file tree) column (no-op when already open). */
  openExplorer(): void
  /** Close the explorer (file tree) column. */
  closeExplorer(): void
  /** Toggle the explorer (file tree) column (closed ⟷ default width). */
  toggleExplorer(): void
  /** Toggle the bottom panel (collapsed header ⟷ default height). */
  togglePanel(): void
  /** Toggle the activity bar (visible ⟷ hidden). */
  toggleActivity(): void
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
    this.#require().toggleSidebar()
  }

  openDetails(): void {
    this.#require().openDetails()
  }

  closeDetails(): void {
    this.#require().closeDetails()
  }

  openEditor(): void {
    this.#require().openEditor()
  }

  closeEditor(): void {
    this.#require().closeEditor()
  }

  toggleEditor(): void {
    this.#require().toggleEditor()
  }

  openExplorer(): void {
    this.#require().openExplorer()
  }

  closeExplorer(): void {
    this.#require().closeExplorer()
  }

  toggleExplorer(): void {
    this.#require().toggleExplorer()
  }

  togglePanel(): void {
    this.#require().togglePanel()
  }

  toggleActivity(): void {
    this.#require().toggleActivity()
  }

  #require(): PanelActions {
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
