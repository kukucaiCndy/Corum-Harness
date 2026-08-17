/**
 * @corum/ide-shell client half — the IDE shell plugin (the one always-on IDE
 * plugin; it holds NO business content, only the region system).
 *
 * One register() call contributes IdeAppFrame into the runtime's built-in
 * 'root' slot and, in the same breath, declares every slot the IDE composes
 * (declaration = exclusive render authority):
 *
 *   - The INHERITED official slots, re-declared with the same keys and
 *     contracts so official plugins mount unchanged: `conversation`
 *     (ui-conversation), `details` (its DetailsPanel drawer), `shell.overlay`,
 *     and `sidebar.settings` (ui-settings-general — disabling ui-sidebar
 *     strands this seat, so the shell re-declares it and renders it in the
 *     left column's foot).
 *   - The shell's OWN `corum.*` region slots (columns / bars / drawer /
 *     overlay / floating mount): `corum.sidebar`, `corum.editor`,
 *     `corum.explorer`, `corum.tabStrip`, `corum.panel`, `corum.statusBar`,
 *     `corum.floating`. The official `sidebar` slot is deliberately NOT
 *     re-declared — the shell's left column content lives in `corum.sidebar`
 *     (official ui-sidebar is disabled in IDE mode).
 *
 * Plus: the layout store + the `ctx.layout` panel-action face (the IDE
 * superset of the official ILayout — the three inherited methods keep exact
 * semantics so ui-conversation / app-shell resolve it unchanged), the
 * ThemePresenter (forked from ui-layout: body palette projection — official
 * ui-layout is disabled in IDE mode, so the shell owns this duty), the
 * `corum-glass` token override layer, and the glass CSS / ambient glow /
 * font stack / reduced-motion degradation (theme.css, inlined at build).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PanelActions } from './service.ts'
import { IdeAppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'
import { GLASS_TOKENS } from './theme-layer.ts'
import './theme.css'

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
    // ── Inherited official slots, re-declared (same keys, same contracts) ──
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    'shell.overlay': { kind: 'list'; scope: 'root' }
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    // ── The shell's own region slots (corum.*) ──
    /** Left column: the session list (design.pen ① 会话列表, 280px). */
    'corum.sidebar': { kind: 'single'; scope: 'root'; owner: CorumSidebarOwnerProps }
    /** Right column: the resident Monaco editor (design.pen ③ 编辑器区, 430px). */
    'corum.editor': { kind: 'single'; scope: 'root' }
    /** Rightmost column: the file tree (design.pen ④ 资源管理器, 210px). */
    'corum.explorer': { kind: 'single'; scope: 'root' }
    /** Top bar over the conversation column: editor tab strip (0-height when empty). */
    'corum.tabStrip': { kind: 'list'; scope: 'root' }
    /** Bottom bar: terminal / todos / queue (design.pen ⑥ 底部面板, 150px; 0 = collapsed). */
    'corum.panel': { kind: 'single'; scope: 'root' }
    /** Bottom bar: connection · project · model (design.pen ⑦ 状态栏, 34px). */
    'corum.statusBar': { kind: 'list'; scope: 'root' }
    /** Floating-window mount point (`?floating=<slotKey>`, S3; declared now so plugins can target it). */
    'corum.floating': { kind: 'single'; scope: 'root' }
  }
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Settings-seat owner share (mirrors the official ui-sidebar contract: the column display state). */
export interface SidebarSettingsOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Left-column owner share: live column state from the frame's concession solve. */
export interface CorumSidebarOwnerProps {
  /** Whether the column renders wide content (false = 56px rail). */
  wide: boolean
  /** Rendered column width in px. */
  width: number
  /** Rail icons request expansion; flips the narrow-expanded / closed state. */
  expandSidebar: () => void
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'theme']

/**
 * Client plugin body: provide ctx.layout, stack the glass token layer, then
 * one register() call — the IDE shell into 'root' with every slot declaration,
 * the layout store seat, and the inject hook that hands the store's bound
 * actions to the service. A second effect seats the theme presenter.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeTokens = ctx.theme.overrideTokens('corum-glass', GLASS_TOKENS)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        // Inherited official slots (re-declared; see module doc).
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        // The shell's own region slots.
        'corum.sidebar': { kind: 'single', scope: 'root' },
        'corum.editor': { kind: 'single', scope: 'root' },
        'corum.explorer': { kind: 'single', scope: 'root' },
        'corum.tabStrip': { kind: 'list', scope: 'root' },
        'corum.panel': { kind: 'single', scope: 'root' },
        'corum.statusBar': { kind: 'list', scope: 'root' },
        'corum.floating': { kind: 'single', scope: 'root' },
      },
      store: createLayoutStore,
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        return {}
      },
    }, IdeAppFrame)
    return () => {
      disposeRegistration()
      void disposeTokens()
      void disposeService()
    }
  }, 'ide-shell: service + token layer + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ide-shell: theme presenter')
}
