/**
 * Layout plugin, browser half: one register() call contributes CorumAppFrame
 * into the runtime's built-in 'root' slot and, in the same breath, declares
 * the inherited four child slots plus the IDE shell's own extension slots
 * (declaration = exclusive render authority), seats the layout store, and
 * wires the panel-action service face. `ctx.layout` is the cross-plugin
 * panel-action contract — the corum IDE superset of the official ILayout, so
 * official ui-sidebar / ui-conversation / app-shell resolve it unchanged.
 * A second effect seats the theme presenter (forked: the official ui-layout
 * is disabled in IDE mode, so this shell owns the body-palette projection).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PanelActions } from './service.ts'
import { CorumAppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'

export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // The four INHERITED child slots, re-declared by this fork so official
    // ui-sidebar / ui-conversation mount unchanged (same keys, same contracts).
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    'shell.overlay': { kind: 'list'; scope: 'root' }
    // IDE shell's own extension slots (P3/P4 populate; unoccupied they render
    // nothing, so the shell stays valid before those packages land).
    'corum.editor': { kind: 'single'; scope: 'root' }
    'corum.explorer': { kind: 'single'; scope: 'root' }
    'corum.tabStrip': { kind: 'list'; scope: 'root' }
    'corum.panel': { kind: 'single'; scope: 'root' }
    'corum.statusBar': { kind: 'list'; scope: 'root' }
  }
}

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'theme']

/**
 * Client plugin body: provide ctx.layout, then one register() call — the IDE
 * shell into 'root' with the four inherited child-slot declarations plus the
 * IDE extension slots, the layout store seat, and the inject hook that hands
 * the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'corum.editor': { kind: 'single', scope: 'root' },
        'corum.explorer': { kind: 'single', scope: 'root' },
        'corum.tabStrip': { kind: 'list', scope: 'root' },
        'corum.panel': { kind: 'single', scope: 'root' },
        'corum.statusBar': { kind: 'list', scope: 'root' },
      },
      store: createLayoutStore,
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        return {}
      },
    }, CorumAppFrame)
    return () => {
      disposeRegistration()
      void disposeService()
    }
  }, 'corum-layout: service + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'corum-layout: theme presenter')
}
