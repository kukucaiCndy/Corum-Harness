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
 * Plus: the layout store + the `ctx.layout` panel-action face (the official
 * ILayout exact semantics — toggleSidebar/openDetails/closeDetails — so
 * ui-conversation / app-shell resolve it unchanged), the
 * ThemePresenter (forked from ui-layout: body palette projection — official
 * ui-layout is disabled in IDE mode, so the shell owns this duty), the
 * `corum-glass` token override layer, and the glass CSS / ambient glow /
 * font stack / reduced-motion degradation (theme.css, inlined at build).
 */
import type { ReactElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PanelActions } from './service.ts'
import { IdeAppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from '@corum/shell-base/client'
import { GLASS_TOKENS } from './theme-layer.ts'
import { TestModule } from './TestModule.tsx'
import { registerSlot, getSlotMeta } from '@corum/shell-base/client'
import './ide-layout.ts' // 副作用：注册 IDE 业务槽位（corum.*）
import './theme.css'

export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'
export { registerSlot, getSlotMeta, getAllRegisteredSlots } from '@corum/shell-base/client'
export type { SlotMeta } from '@corum/shell-base/client'
export { CLOSE_REGION_EVENT, TOGGLE_SIDEBAR_EVENT } from '@corum/shell-base/client'

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

  // ── S0 test modules for the shell's own slots ──
  // corum.editor is now owned by corum-shell's client (EditorColumn, which
  // carries the Monaco worker/protocol infrastructure); details stays as a
  // self-identifying test card until the official DetailsPanel takes it over.
  // corum.sidebar / corum.statusBar / corum.panel / conversation are filled by
  // the dedicated ide-* plugins (cross-plugin composition). Deferred via
  // ctx.slots.inject so the registration order vs. the root entry (which
  // declares the slots) is not a correctness dependency.
  ctx.effect(() => {
    const d3 = ctx.slots.inject('details', () => ctx.slots.register(
      { name: 'details' },
      ({ sessionId }: { sessionId?: string }) => (
        <TestModule
          slot="details"
          caption="详情抽屉（右侧覆盖 · 360px）。S1 由官方 DetailsPanel / S2 由 ide-conversation 接管。"
          facts={[`sessionId: ${sessionId ?? '(none)'}`, '由 ctx.layout.openDetails/closeDetails 驱动']}
          action={{ label: '关闭抽屉 (closeDetails)', onClick: () => { try { layout.closeDetails() } catch { /* panels not yet wired */ } } }}
        />
      ),
    ))
    return () => { d3() }
  }, 'ide-shell: S0 test modules (details)')

  // ── 插件 UI 扫描：自动发现有 dsh.client 声明的插件并注册为可添加区域 ──
  // 读取 window.__DSH_BOOT__ 的 graph entries，每个 entry 是一个有 client bundle
  // 的插件。排除固定位置槽位（corum.panel/corum.statusBar/shell.overlay）和
  // 壳自身（corum-shell），其余的自动 registerSlot 到网格注册表。
  ctx.effect(() => {
    const boot = (window as unknown as { __DSH_BOOT__?: { entries?: { id: string }[] } }).__DSH_BOOT__
    if (boot?.entries === undefined) return () => {}
    const EXCLUDE = new Set([
      'corum-shell',                          // 壳自身
      '@deepseek-ai/dsh-client-modules',     // 加载器（无独立 UI）
      '@deepseek-ai/dsh-client-runtime',     // runtime（无独立 UI）
      '@deepseek-ai/dsh-client-connection', // 连接服务（无独立 UI）
      '@deepseek-ai/dsh-api-gateway',        // API 网关（无独立 UI）
      '@deepseek-ai/dsh-api-remotes',        // remote 服务（无独立 UI）
      '@deepseek-ai/dsh-typert-registry',   // 类型注册表（无独立 UI）
      '@deepseek-ai/dsh-client-locale',      // 国际化（无独立 UI）
      '@deepseek-ai/dsh-client-ui-theme',    // 主题服务（无独立 UI）
      '@deepseek-ai/dsh-client-ui-settings', // 设置壳（无独立 UI）
      '@deepseek-ai/dsh-client-ui-settings-general', // 设置面板（固定位置）
      '@deepseek-ai/dsh-client-ui-settings-plugins', // 插件设置（固定位置）
      '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
      '@deepseek-ai/dsh-client-ui-permission-presets',
      '@corum/session-archive',              // 已有固定入口
      '@corum/ui-settings-models',          // 已有固定入口
      '@corum/ui-model-selection',           // 已有固定入口
      '@corum/ide-shell',                    // 壳自身
      '@corum/ide-test-sidebar',
      '@corum/ide-test-statusbar',
      '@corum/ide-test-conversation',
      '@corum/ide-sidebar',                  // 固定 corum.sidebar 槽
      '@corum/ide-explorer',                 // 固定 corum.explorer 槽
      '@corum/ide-conversation',             // 固定 conversation 槽
      '@corum/ide-panel-bottom',             // 固定 corum.panel 槽
      '@corum/ide-statusbar',                // 固定 corum.statusBar 槽
    ])
    for (const entry of boot.entries) {
      if (EXCLUDE.has(entry.id)) continue
      // 已注册的不再重复
      if (getSlotMeta(entry.id) !== undefined) continue
      // 从包名推导 label：取最后一段，首字母大写
      const parts = entry.id.split('/')
      const last = parts[parts.length - 1]
      const label = last.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      registerSlot(entry.id, { label, defaultWeight: 400 })
    }
    return () => {}
  }, 'ide-shell: scan plugin UI entries')
}
