/**
 * @corum/corum-ide-ui client half — the IDE shell plugin (the one always-on IDE
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
 *     `corum.explorer`, `corum.tabStrip`, `corum.panel`,
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
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { GridActions, PanelActions } from './service.ts'
import { IdeAppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from '@corum/corum-ui-base/client'
import { GLASS_TOKENS } from './theme-layer.ts'
import { TestModule } from './TestModule.tsx'
import { registerSlot, getSlotMeta, drainPendingSlots } from '@corum/corum-ui-base/client'
import type { SlotMeta, SlotRegistryFace } from '@corum/corum-ui-base/client'
import { SettingsShell } from './SettingsShell.tsx'
import type {
  SettingsOnboardingStep, SettingsRootInjected, SettingsSectionRow,
} from './shell-contract.ts'
import { CloseLabel, HeaderContent, TriggerContent } from './settings-chrome.tsx'
import { GeneralSection } from './SettingsGeneralSection.tsx'
import { en as settingsEn, zh as settingsZh, type SettingsKey } from './settings-locales.ts'
import type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import './ide-layout.ts' // 副作用：注册 IDE 业务槽位（corum.*）
import './theme.css'

export { LayoutController } from './service.ts'
export type { ILayout, SidebarMode, SidebarModeSource } from './service.ts'
export { registerSlot, getSlotMeta, getAllRegisteredSlots } from '@corum/corum-ui-base/client'
export type { SlotMeta } from '@corum/corum-ui-base/client'
// B2：IDE 壳的静态网格槽域（registerSlot 写点/ideDefaultGrid/浮动窗渲染的
// 编译期保障锚点；feature 插件不需要它——经 registerSlot() 动态注册进网格）。
export { IDE_GRID_SLOTS } from './ide-layout.ts'
export type { IdeGridSlot } from './ide-layout.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Settings shell chrome + shell-owned General section copy. */
    settings: SettingsKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
    /**
     * 槽位注册表服务（C1）：壳 provide，插件在自己 apply 里经
     * `ctx.slotRegistry.register(...)` 自声明槽位（跨 bundle 单例——实例唯一性
     * 由 root context reflect.store 保证，实证 .dbg/cordis-singleton-probe.md）。
     * 插件也可用 ui-base 的 registerSlot()（壳已 bindSlotRegistry 桥接到同一实例）。
     */
    slotRegistry: import('@corum/corum-ui-base/client').SlotRegistryFace
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // ── Inherited official slots, re-declared (same keys, same contracts) ──
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    'shell.overlay': { kind: 'list'; scope: 'root' }
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    // ── Settings child slots (declared by this shell's sidebar.settings occupant;
    //    same keys/contracts as official ui-settings-general so feature
    //    registrants — corum-ui-settings-models, official ui-settings-plugins —
    //    mount unchanged). ──
    /** Trigger-row content seat (icon + label). */
    'settings.trigger': { kind: 'single'; scope: 'root'; owner: SettingsTriggerOwnerProps }
    /** Panel title text seat (nav heading). */
    'settings.header': { kind: 'single'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /** Header action buttons (e.g. open-document), ordered by `order`. */
    'settings.action': { kind: 'list'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /** Close button accessible-name text seat. */
    'settings.close': { kind: 'single'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /** One settings page section; owner {close} arrives from the shell. */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
    /** Ordered onboarding steps (empty-Hero gate rides ctx sessions). */
    'settings.onboarding': { kind: 'list'; scope: 'root'; owner: SettingsOnboardingOwnerProps }
    /** Items inside the shell-owned General section. */
    'settings.general.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
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
    /** Floating-window mount point (`?floating=<slotKey>`, S3; declared now so plugins can target it). */
    'corum.floating': { kind: 'single'; scope: 'root' }
    // ── 侧栏子槽（corum-ide-sidebar-ui 骨架声明，填充插件按发行版组合）──
    /** 侧栏 · 任务模式内容（会话列表）。骨架在 corum.sidebar 注册时声明此洞。 */
    'corum.sidebar.sessions': { kind: 'single'; scope: 'root' }
    /** 侧栏 · 项目模式内容（项目空态/详情/创建向导）。付费版才有 occupant；空洞时骨架不显示「项目」tab。 */
    'corum.sidebar.project': { kind: 'single'; scope: 'root' }
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

/** Trigger-content owner share (mirrors the official settings.trigger contract). */
export interface SettingsTriggerOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Section owner share: the shell hands every section a close callback. */
export interface SettingsSectionOwnerProps {
  /** Close the settings panel (e.g. after an in-section navigation action). */
  close: () => void
}

/** Onboarding-step owner share (mirrors the official settings.onboarding contract). */
export interface SettingsOnboardingOwnerProps {
  /** The active step id. */
  stepId: string
  /** Mark the step completed (the coordinator advances to the next). */
  complete: () => void
  /** Open the panel directly on a section. */
  openSection: (id: string) => void
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

/** Required services (cordis fiber inject). `locale` feeds the settings shell's
 *  dictionaries + nav-label thunk resolution. */
export const inject = ['slots', 'theme', 'locale']

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
    // C1：槽位注册表服务化——provide 为 cordis 服务（跨 bundle 单例），并把
    // ui-base registerSlot() 的写路径桥接到同一实例。此后任何 bundle 的
    // registerSlot()/ctx.slotRegistry.register() 都落到这张共享表上。
    const registryTable = new Map<string, SlotMeta>()
    const slotRegistryImpl: SlotRegistryFace = {
      register: (key, meta) => { registryTable.set(key, meta) },
      getMeta: (key) => registryTable.get(key),
      getAll: () => [...registryTable.keys()],
    }
    const disposeRegistry = ctx.reflect.provide('slotRegistry', slotRegistryImpl)
    // 一次性桥（合法 window 挂载：written once, read-only，规范 §1 例外）：
    // ui-base 的 registerSlot()/getSlotMeta() 每次调用时经此桥解析到服务实例——
    // 模块顶层（壳 apply 前）的注册暂存 fallback，drainPendingSlots 在此合并。
    ;(window as unknown as { __corumSlotRegistry?: SlotRegistryFace }).__corumSlotRegistry = slotRegistryImpl
    drainPendingSlots(slotRegistryImpl)
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
        'corum.floating': { kind: 'single', scope: 'root' },
      },
      store: createLayoutStore,
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        // 主题面注入：AppFrame 是纯组件不碰 cordis，这里把 theme 服务投影成
        // inject 面经 props 下发。`hooks.theme` 是 theme/change 驱动的
        // HostObservable（uSES 契约），组件侧以 `useTheme()` 选择器取
        // preference；`setTheme` 直通服务。preference 翻转经 ThemePresenter
        // 重投影 body palette，本组件同时经 useTheme 重渲染高亮态。
        //
        // attachGridActions：grid actions 反向桥——AppFrame 挂载后调它把区域
        // 操作面（attachGrid）挂进 LayoutController，ctx.layout 服务方法即可
        // 直连网格（替代原 window CustomEvent 事件桥）。
        return {
          setTheme: (p: 'light' | 'dark' | 'system') => { ctx.theme.setTheme(p) },
          attachGridActions: (a: GridActions) => { layout.attachGrid(a) },
          hooks: {
            theme: {
              getSnapshot: () => ctx.theme.getTheme().preference,
              subscribe: (fn: () => void) => ctx.on('theme/change', fn),
            },
          },
          // 插件中心面板的 RPC 通道：0.1.2 起走官方 connection.rpc（loopback HTTP 到
          // /api，gateway SRC 认领 pluginManager/*；旧 corumDesktop.unary 桥已退役）。
          callPluginManager: async <T,>(method: string, args: Record<string, unknown>): Promise<T> => {
            const connection = ctx.get('connection') as import('@deepseek-ai/dsh-client-connection/client').ConnectionHandle
            const result = await connection.rpc.call('/api', `pluginManager/${method}`, { args })
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
            return result.value as T
          },
        }
      },
    }, IdeAppFrame)
    return () => {
      disposeRegistration()
      void disposeTokens()
      void disposeService()
      void disposeRegistry()
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

  // ── Settings shell (official ui-settings-general is disabled in IDE mode) ──
  // The shell itself occupies sidebar.settings with the portal-based
  // SettingsShell and declares the settings.* child slots; it also re-registers
  // the shell-owned content the official package carried: chrome
  // (trigger/header/close copy), the General section, and the `settings`
  // dictionaries. Feature sections (corum-ui-settings-models, official
  // ui-settings-plugins …) register into settings.section through slots.inject
  // and are unaffected by the occupant swap.
  ctx.effect(() => {
    const NS = 'settings'
    const disposeDicts = ctx.locale.register(NS, { zh: settingsZh, en: settingsEn })
    // Copy freshness is framework-owned: components read the standard `t`
    // seat, and the nav label is a thunk the owner resolves per render.
    const t = ctx.locale.bind(NS)

    // Ledger → nav-row projection as an observable source (uSES contract:
    // getSnapshot returns the cached rows until the ledger version moves).
    // Labels may be locale-following thunks, so the cache key includes the
    // locale revision and subscribers ride both sources.
    let rowsVersion = -1
    let rowsRevision = -1
    let rows: readonly SettingsSectionRow[] = []
    let onboardingVersion = -1
    let onboardingSteps: readonly SettingsOnboardingStep[] = []
    const shellInjected = (): SettingsRootInjected => ({
      hooks: {
        sections: {
          getSnapshot: () => {
            const version = ctx.slots.getVersion('settings.section')
            const revision = ctx.locale.getSnapshot().revision
            if (version !== rowsVersion || revision !== rowsRevision) {
              rowsVersion = version
              rowsRevision = revision
              rows = ctx.slots.entries('settings.section')
                .map(e => ({
                  id: e.options.id ?? '',
                  order: e.options.order ?? 0,
                  label: resolveSlotLabel(e.options.label) ?? '',
                }))
                .sort((a, b) => a.order - b.order)
            }
            return rows
          },
          subscribe: (listener) => {
            const offLedger = ctx.slots.subscribe('settings.section', listener)
            const offLocale = ctx.locale.subscribe(listener)
            return () => {
              offLedger()
              offLocale()
            }
          },
        },
        onboardingSteps: {
          getSnapshot: () => {
            const version = ctx.slots.getVersion('settings.onboarding')
            if (version !== onboardingVersion) {
              onboardingVersion = version
              onboardingSteps = ctx.slots.entries('settings.onboarding')
                .map(e => ({
                  id: e.options.id ?? '',
                  order: e.options.order ?? 0,
                }))
                .sort((a, b) => a.order - b.order)
            }
            return onboardingSteps
          },
          subscribe: listener => ctx.slots.subscribe('settings.onboarding', listener),
        },
      },
    })

    // The settings shell: this plugin occupies the sidebar-owned hole and
    // declares the settings child slots.
    const disposeOccupant = ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
      name: 'sidebar.settings',
      children: {
        'settings.trigger': { kind: 'single', scope: 'root' },
        'settings.header': { kind: 'single', scope: 'root' },
        'settings.action': { kind: 'list', scope: 'root' },
        'settings.close': { kind: 'single', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
      inject: shellInjected,
    }, SettingsShell))

    // Shell-owned content (chrome + General section).
    const disposeTrigger = ctx.slots.inject('settings.trigger', () =>
      ctx.slots.register({ name: 'settings.trigger', locale: NS }, TriggerContent))
    const disposeHeader = ctx.slots.inject('settings.header', () =>
      ctx.slots.register({ name: 'settings.header', locale: NS }, HeaderContent))
    const disposeClose = ctx.slots.inject('settings.close', () =>
      ctx.slots.register({ name: 'settings.close', locale: NS }, CloseLabel))
    const disposeGeneral = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'general',
      order: 0,
      label: () => t('general.nav'),
      locale: NS,
      children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
    }, GeneralSection))

    return () => {
      disposeGeneral()
      disposeClose()
      disposeHeader()
      disposeTrigger()
      disposeOccupant()
      disposeDicts()
    }
  }, 'ide-shell: settings shell (occupant + chrome + general + dictionaries)')

  // ── S0 test modules for the shell's own slots ──
  // details 槽的 S0 测试占位卡已移除：B 方案 fork 的 @corum/corum-ui-conversation 带
  // 官方 DetailsPanel 接管 details 槽（原注释「until the official DetailsPanel takes
  // it over」已兑现）。corum.sidebar / corum.panel / conversation 由专职 ide-* 插件
  // （或 fork）填充。

  // ── 插件 UI 扫描：自声明槽的「 hidden 兜底」层 ──
  // C1 后：插件应在自己 apply 里 registerSlot(id, { visibility }) 自声明槽位；
  // 本扫描只处理「未自声明」的 boot entry——它们默认 visibility:'hidden'
  // （无独立 UI 的纯服务/壳自身/测试占位插件不再注册进网格清单）。
  // 此前这里是一份 24 条硬编码 EXCLUDE 清单：插件加/改名就要改壳——C1 把它
  // 收敛为「未自声明 ⇒ hidden」一条规则，壳不再枚举业务插件。
  ctx.effect(() => {
    const boot = (window as unknown as { __DSH_BOOT__?: { entries?: { id: string }[] } }).__DSH_BOOT__
    if (boot?.entries === undefined) return () => {}
    for (const entry of boot.entries) {
      // 插件已自声明（任意 visibility）→ 尊重插件声明，不覆盖。
      if (getSlotMeta(entry.id) !== undefined) continue
      // 未自声明 ⇒ hidden：纯服务/加载器/壳自身等无独立 UI 的插件不进任何清单。
      registerSlot(entry.id, { label: entry.id, defaultWeight: 400, visibility: 'hidden' })
    }
    return () => {}
  }, 'ide-shell: mark undeclared plugin entries hidden')
}
