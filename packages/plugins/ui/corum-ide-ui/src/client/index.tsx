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
 *     `corum.tabStrip`, `corum.panel`,
 *     `corum.floating`. The official `sidebar` slot is deliberately NOT
 *     re-declared — the shell's left column content lives in `corum.sidebar`
 *     (official ui-sidebar is disabled in IDE mode).
 *
 * Plus: the layout store + the `ctx.layout` panel-action face (the official
 * ILayout exact semantics — toggleSidebar/openDetails/closeDetails — so
 * ui-conversation / app-shell resolve it unchanged), the
 * ThemePresenter (forked from ui-layout: body palette projection **+ the content
 * font-size axis `--dsh-content-font-size`** — official ui-layout is disabled in
 * IDE mode, so the shell owns this duty; the font-size axis was missing until
 * 2026-09-16, which made the「会话正文字号」setting write-only, see
 * `corum-ui-base/src/client/theme-presenter.ts`), the
 * `corum-glass` token override layer, and the glass CSS / ambient glow /
 * font stack / reduced-motion degradation (theme.css, inlined at build).
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ReactElement, ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { GridActions, PanelActions, SidebarMode } from './service.ts'
import { IdeAppFrame } from './AppFrame.tsx'
// 集成中心（PR4）：面板本体 + 三个内容子槽的 owner 面类型（真源在组件文件，
// 本文件只消费——SlotMap 登记与 root children 两处都引用同一个类型，不各写一份）。
import type { IntegrationsPageOwnerProps } from './IntegrationsFrame.tsx'
import {
  SessionStatusPill, SessionTrajectoryButton, FloatingCloseButton, SESSION_BAR_IDS, SESSION_BAR_SLOTS, TRAJECTORY_REGION,
  type RevealOutcome,
} from './session-bar.tsx'
import type { RemoteEventFace } from './session-bar.tsx'
import type { ReadChildProgress } from './session-bar.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from '@corum/corum-ui-base/client'
import { GLASS_TOKENS } from './theme-layer.ts'
import { accentTokens, subscribeAccent } from './appearance-accent.ts'
import { applyUiFontScale, subscribeUiFontBase } from './ui-font-scale.ts'
import { applyUiDensity, subscribeUiDensity } from './ui-density.ts'
import { applyUiFontFamily, subscribeUiFontFamily } from './ui-font-family.ts'
import { TestModule } from './TestModule.tsx'
import { registerSlot, getSlotMeta, drainPendingSlots } from '@corum/corum-ui-base/client'
import type { SlotMeta, SlotRegistryFace } from '@corum/corum-ui-base/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SettingsShell } from './SettingsShell.tsx'
import type { UpdateApi, UpdateState } from './update/update-api.ts'
import type {
  SettingsOnboardingStep, SettingsRootInjected, SettingsSectionRow,
} from './shell-contract.ts'
import { CloseLabel, HeaderContent, TriggerContent } from './settings-chrome.tsx'
import { SECTION_DEFS } from './settings/SettingsSections.tsx'
import { DataSection } from './settings/sections/SettingsDataSection.tsx'
import {
  SessionArchiveContext,
  type SessionArchiveCapable,
  type SessionArchiveResolver,
} from './settings/sections/useSessionArchiveCapability.tsx'
import { AppearanceSection } from './settings/sections/SettingsAppearanceSection.tsx'
import { CorumRpcContext, CorumSettingsContext, EditorDisplayPrefsContext, FontPrefsContext, NotificationPrefsContext, type CorumSettingsFace, type EditorDisplayPrefsService } from './settings/shared.tsx'
import { SettingsSectionHost } from './settings/SettingsSectionHost.tsx'
import { en as settingsEn, zh as settingsZh, type SettingsKey } from './settings-locales.ts'
import type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import './ide-layout.ts' // 副作用：注册 IDE 业务槽位（corum.*）
import './theme.css'

export { LayoutController } from './service.ts'
export type { ChromeSource, ChromeState, ILayout, SidebarMode, SidebarModeSource } from './service.ts'
export { registerSlot, getSlotMeta, getAllRegisteredSlots } from '@corum/corum-ui-base/client'
export type { SlotMeta } from '@corum/corum-ui-base/client'
// B2：IDE 壳的静态网格槽域（registerSlot 写点/ideDefaultGrid/浮动窗渲染的
// 编译期保障锚点；feature 插件不需要它——经 registerSlot() 动态注册进网格）。
export { IDE_GRID_SLOTS } from './ide-layout.ts'
export type { IdeGridSlot } from './ide-layout.ts'
// 集成中心（PR4）：三个内容子槽的键域 + owner 面。内容包用 type-only 消费
// （`import type {} from '@corum/corum-ide-ui/client'`）拉入 SlotMap 键；
// 需要按名解构 `INTEGRATIONS_SECTION_SLOTS` 的组合可直接 value-import 本出口。
export { INTEGRATIONS_SECTION_SLOTS } from './IntegrationsFrame.tsx'
export type {
  IntegrationsPageOwnerProps, IntegrationsSection, IntegrationsSectionSlot,
} from './IntegrationsFrame.tsx'

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
    /**
     * Items inside the shell-owned Data-management section（数据管理页自己的子槽）。
     *
     * ⚠️ **必须在此登记键名**，否则 `children` 与 `slots.inject` 会被类型系统直接拒绝
     * （实测 TS2769 / TS2345）。原因：槽键校验的是**全局 SlotMap 联合**，
     * 它由本增强块与官方契约（`ui-settings/src/client/contract/slots.ts`）**合并**而成 ——
     * 所以「新设置子槽不能只在注册处声明」。
     *
     * owner 复用 `SettingsGeneralItemOwnerProps`：两者都是**空标记**
     * （行内文案 / 控件 / 写路径全部由注册方自带），无字段可传。
     */
    'settings.data.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    // ── The shell's own region slots (corum.*) ──
    /** Left column: the session list (design.pen ① 会话列表, 280px). */
    'corum.sidebar': { kind: 'single'; scope: 'root'; owner: CorumSidebarOwnerProps }
    /** Right column: the resident Monaco editor + embedded file tree (design.pen ③
     *  编辑器区合并卡, 2026-09-03 改版：编辑器 main + 资源管理器 210 子面板同一张
     *  玻璃卡，资源管理器不再是独立槽位）。 */
    'corum.editor': { kind: 'single'; scope: 'root' }
    /** 右侧「轨迹」区域（fork #12 occupant；右上角轨迹按钮点亮）。session-maybe：
     *  无当前会话时 occupant 渲染空态。 */
    'corum.trajectory': { kind: 'single'; scope: 'session-maybe' }
    /** Top bar over the conversation column: editor tab strip (0-height when empty). */
    'corum.tabStrip': { kind: 'list'; scope: 'root' }
    /** Bottom bar: terminal / todos / queue (design.pen ⑥ 底部面板, 150px; 0 = collapsed). */
    'corum.panel': { kind: 'single'; scope: 'root' }
    /** Floating-window mount point (`?floating=<slotKey>`, S3; declared now so plugins can target it). */
    'corum.floating': { kind: 'single'; scope: 'root' }
    /**
     * 统一标题栏（2026-09-30；**声明权在本壳** —— 声明 = 排他渲染权）。
     * occupant = `@corum/corum-ui-titlebar`。
     *
     * 由来：这条 40px 带子此前被两个 owner 分别持有（壳的窗口按钮行 + 对话区
     * leaf 内的会话顶栏），折叠态下后者的空态拖拽带（`app-region: drag`）盖住
     * 前者的控件层，物理鼠标点击被当拖拽吞掉。现合并成唯一 owner。
     *
     * ⚠️ 三件事缺一不可（与 `corum.integrations.*` 同款纪律）：
     *   ① 此处登记 SlotMap 键名（否则 children 与注册方都会被类型系统拒掉）；
     *   ② root 条目 `children` 表里声明（见下方 ctx.slots.register）；
     *   ③ 注册方（corum-ui-titlebar 的 client apply）的 `name` 与之一致。
     */
    'corum.titlebar': { kind: 'single'; scope: 'root'; owner: TitlebarOwnerProps }
    // ── 侧栏子槽（corum-ide-sidebar-ui 骨架声明，填充插件按发行版组合）──
    /** 侧栏 · 任务模式内容（会话列表）。骨架在 corum.sidebar 注册时声明此洞。 */
    'corum.sidebar.sessions': { kind: 'single'; scope: 'root' }
    /** 侧栏 · 项目模式内容（项目空态/详情/创建向导）。付费版才有 occupant；空洞时骨架不显示「项目」tab。 */
    'corum.sidebar.project': { kind: 'single'; scope: 'root' }
    // ── 集成中心内容子槽（PR4；**声明权在本壳** —— 声明 = 排他渲染权）──
    /**
     * 集成中心 ·「插件」页（occupant = corum-ide-integrations-ui 的 PluginsPage）。
     *
     * 键名此前只以「占位」形式活在 PR5 包（`INTEGRATIONS_PLUGINS_SLOT`）与 PR6 包
     * （`INTEGRATIONS_PAGE_SLOTS`）里，**两个内容包刻意都不 declare SlotMap**——
     * 各自的注释写明了原因：SlotMap 是合并接口，同一键在两处声明而 `owner` 不同
     * 即编译错（TS2717），抢先登记会让骨架合入时撞键。故三个键由本壳一行登记。
     *
     * ⚠️ 三件事缺一不可（AGENTS.md / 壳注释的纪律）：
     *   ① **此处登记 SlotMap 键名**（否则 `children` 与注册方都会被类型系统拒掉）；
     *   ② root 条目 `children` 表里声明（见下方 ctx.slots.register —— 声明 = 排他渲染权）；
     *   ③ 注册方（两个内容包的 client apply）的 `name` 与之一致。
     */
    'corum.integrations.plugins': { kind: 'single'; scope: 'root'; owner: IntegrationsPageOwnerProps }
    /** 集成中心 · MCP 页（occupant = corum-ide-integrations-pages-ui 的 McpPage）。 */
    'corum.integrations.mcp': { kind: 'single'; scope: 'root'; owner: IntegrationsPageOwnerProps }
    /** 集成中心 · 技能页（occupant = corum-ide-integrations-pages-ui 的 SkillsPage）。 */
    'corum.integrations.skills': { kind: 'single'; scope: 'root'; owner: IntegrationsPageOwnerProps }
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

/**
 * 统一标题栏 owner share：壳下发的形态与几何（业务数据由 occupant 自己的
 * inject 提供——会话折叠态/集成中心走 ctx.layout 的 chrome 状态）。
 */
export interface TitlebarOwnerProps {
  /** `'main'` = 主窗（红绿灯让位 76）；`'floating'` = 浮窗自带顶栏（让位 66）。 */
  variant: 'main' | 'floating'
  /** 带子总宽（px）：右缘 = 活动栏 + 侧栏 + 对话区格右缘（见 AppFrame 的测量）。 */
  bandWidth: number
  /** 控件段右缘（px）：会话段自它起渲染（P2 起用）。 */
  controlsWidth: number
}

/** Required services (cordis fiber inject). `locale` feeds the settings shell's
 *  dictionaries + nav-label thunk resolution. */
export const inject = ['slots', 'theme', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope', 'sessions', 'notifications', 'fontPrefs', 'editorDisplayPrefs']

/**
 * Client plugin body: provide ctx.layout, stack the glass token layer, then
 * one register() call — the IDE shell into 'root' with every slot declaration,
 * the layout store seat, and the inject hook that hands the store's bound
 * actions to the service. A second effect seats the theme presenter.
 * @param ctx - client root context.
 */
/**
 * 构造 UpdateApi 能力面：把 CorumRpcCall 窄化成 AppFrame/UpdatePanel 只需的
 * getState / check / download 三方法。失败静默返回 null（服务未装配时不报错）。
 */
function makeUpdateApi(rpc: CorumRpcCall): UpdateApi {
  return {
    getState: async () => {
      try { return await rpc<UpdateState | null>('updateChecker', 'getUpdateState', {}) }
      catch { return null }
    },
    check: async () => rpc<UpdateState>('updateChecker', 'check', {}),
    download: async () => rpc<UpdateState>('updateChecker', 'download', {}),
  }
}

/**
 * 构造「会话管理」能力解析器（issue #121 修订版）。
 *
 * 存档能力在 `corum-session-archive`（可选插件）。与侧栏保存入口同一手法：
 * `ctx.reflect.get` 读 store 而**不带 inject 要求**（未装配返回 undefined）。
 * 返回的是**解析器**而不是常量 —— 槽的 inject 面按 entry 永久缓存，若在此
 * 固化成常量，插件晚于本壳装配时页面会永久冻结成降级态。
 * 类型面用局部能力接口收窄（红线 3），不 import session 组实现包。
 *
 * 2026-10-22：原 ManageDialog 形态被用户验收否掉 ⇒ 改为独立 section 页，
 * 这里下发的就是那一页需要的动作面（还原 / 单条导出 / 批量导出 / 删除 /
 * 导入 + 行数据发布 + 结果消解）。
 */
function resolveSessionArchive(ctx: ClientContext): SessionArchiveResolver {
  return () => {
    const archive = (ctx.reflect as unknown as {
      get: (name: string) => {
        readonly desktopAvailable: boolean
        readonly store: unknown
        archivedRows: () => readonly unknown[]
        setManageRows: (rows: readonly unknown[]) => void
        restoreArchived: (ids: readonly string[]) => Promise<void>
        save: (sessionId: string) => Promise<void>
        exportArchived: (ids: readonly string[]) => Promise<void>
        deleteArchived: (ids: readonly string[]) => Promise<void>
        import: () => Promise<void>
        dismissManageOutcome: () => void
      } | undefined
    }).get('sessionArchive')
    if (archive === undefined) return null
    // 绑定实例方法（类实例方法作裸引用会丢 this）。
    return {
      desktopAvailable: archive.desktopAvailable,
      store: archive.store as SessionArchiveCapable['store'],
      archivedRows: () => archive.archivedRows(),
      setManageRows: (rows: readonly unknown[]) => { archive.setManageRows(rows) },
      restoreArchived: (ids: readonly string[]) => archive.restoreArchived(ids),
      saveSession: (sessionId: string) => archive.save(sessionId as never),
      exportArchived: (ids: readonly string[]) => archive.exportArchived(ids),
      deleteArchived: (ids: readonly string[]) => archive.deleteArchived(ids),
      importSessionLog: () => archive.import(),
      dismissManageOutcome: () => { archive.dismissManageOutcome() },
    }
  }
}

export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()

  /**
   * 可被插件覆盖的右侧区域（与 `@corum/plugin-ui-contract` 的
   * `REGION_OVERRIDE_SLOTS` 保持一致；契约包是公开投影，这里是壳侧的唯一实现点）。
   */
  const PLUGIN_OVERRIDABLE_REGIONS = ['corum.editor', 'corum.trajectory', 'corum.panel'] as const

  /**
   * 是否被插件接管：该槽存在 `priority < 0` 的占用者（宿主自己占用在 0）。
   * 读的是官方槽注册表，不做任何缓存 —— 注册/卸载即时生效。
   */
  const pluginOverrides = (key: string): boolean => {
    try {
      const entries = ctx.slots.entries(key as never)
      return entries.some(entry => ((entry.options.priority as number | undefined) ?? 0) < 0)
    } catch {
      return false
    }
  }

  /** 点亮被插件接管的区域（AppFrame 未接线时静默跳过：接线后 attachGridActions 会再跑一次）。 */
  const revealPluginOverriddenRegions = (actions: GridActions): void => {
    for (const key of PLUGIN_OVERRIDABLE_REGIONS) {
      if (!pluginOverrides(key)) continue
      try {
        actions.showRegion(key)
      } catch {
        /* 壳尚未就绪：只影响可见性，不影响插件注册 */
      }
    }
  }
  ctx.effect(() => {
    // 插件可能晚于壳挂载才注册（cordis 激活序不定）⇒ 订阅这三个槽的注册变化，
    // 一出现 priority < 0 的占用者就点亮（策略逻辑与 attachGridActions 共用一份）。
    const unwatch = PLUGIN_OVERRIDABLE_REGIONS.map(key => ctx.slots.subscribe(key as never, () => {
      if (!pluginOverrides(key)) return
      try {
        layout.showRegion(key)
      } catch {
        /* AppFrame 未接线：等 attachGridActions 那一次补点 */
      }
    }))
    ctx.effect(() => () => { for (const dispose of unwatch) dispose() })
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
    // 强调色：**独立一层** token 覆盖（source='corum-accent'），
    // 与 corum-glass 分层叠加 —— 官方 overrideTokens 按 source 存多层，互不覆盖。
    // 用户改色时先撤旧层再注册新层（effect 清理函数负责撤最后一层）。
    let disposeAccent = ctx.theme.overrideTokens('corum-accent', accentTokens())
    const offAccent = subscribeAccent(() => {
      disposeAccent()
      disposeAccent = ctx.theme.overrideTokens('corum-accent', accentTokens())
    })
    // 界面字号：把乘数写到根元素。全仓 615 处 font-size 已改为
    // calc(<N>px * var(--corum-ui-font-scale, 1))（见 ui-font-scale.ts）。
    // 先立即应用一次（覆盖刷新后的已持久化值），再订阅变更。
    applyUiFontScale()
    const offFontBase = subscribeUiFontBase(() => { applyUiFontScale() })
    // 界面密度：同款通道，写 --corum-density-scale（全仓 1287 处间距已改为消费它）。
    applyUiDensity()
    const offDensity = subscribeUiDensity(() => { applyUiDensity() })
    // 界面字体：写 --corum-ui-font-family（194 处 UI 字族栈已改为消费它）。
    // ⚠️ 写入的是完整字族栈，保证本机缺字时能回退（详见 ui-font-family.ts）。
    applyUiFontFamily()
    const offFontFamily = subscribeUiFontFamily(() => { applyUiFontFamily() })
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
        'corum.trajectory': { kind: 'single', scope: 'session-maybe' },
        'corum.tabStrip': { kind: 'list', scope: 'root' },
        'corum.panel': { kind: 'single', scope: 'root' },
        'corum.floating': { kind: 'single', scope: 'root' },
        // 统一标题栏（2026-09-30）：窗口顶部 40px 带子的唯一 owner。声明在此 =
        // 本壳是它的排他渲染者（AppFrame 的惰性挂载位 renderSlot 它）；occupant
        // 由 @corum/corum-ui-titlebar 经 ctx.slots.inject 注册（保证「声明先于
        // 注册」的时序）。壳只提供定位/宽度/pointer-events，**不带任何 app-region**
        // （drag 命中区一律由该组件产生，见其 CSS 的拖拽不变式）。
        'corum.titlebar': { kind: 'single', scope: 'root' },
        // 集成中心三个内容子槽（PR4）：声明在此 = 本壳是它们的排他渲染者
        // （IntegrationsFrame 按子导航选中项 renderSlot 其中一个）。occupant 由
        // corum-ide-integrations-ui / corum-ide-integrations-pages-ui 经
        // ctx.slots.inject 注册（inject 保证「声明先于注册」的时序）。
        'corum.integrations.plugins': { kind: 'single', scope: 'root' },
        'corum.integrations.mcp': { kind: 'single', scope: 'root' },
        'corum.integrations.skills': { kind: 'single', scope: 'root' },
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
          attachGridActions: (a: GridActions) => {
            layout.attachGrid(a)
            // 壳策略（2026-10-21）：某区域一旦有**插件接管**（priority < 0 的占用者），
            // 壳自动点亮它。否则「插件注册了 occupant 却永远看不见」——而点亮区域
            // 属于**布局**，不该由插件做（docs/PLUGIN-SPEC.md §9b）。
            revealPluginOverriddenRegions(a)
          },
          // 活动栏工作面面（PR3）：setSidebarMode 直通 ctx.layout 的幂等写
          // （PR2 已建通路）——活动栏「任务/项目」点击写它，侧栏骨架按同一份
          // 跨 bundle 单例状态切换面板（不再需要侧栏内部的模式切换 UI）。
          setSidebarMode: (mode: SidebarMode) => { layout.setSidebarMode(mode) },
          // 窗口 chrome 面（2026-09-30）：侧栏折叠 / 集成中心开关从 AppFrame 的
          // 局部 useState 收敛进 ctx.layout 的**跨 bundle 单例状态**——标题栏
          // 改成独立插件（@corum/corum-ui-titlebar）后壳与插件读同一份（红线 1）。
          setSidebarCollapsed: (v: boolean) => { layout.setSidebarCollapsed(v) },
          toggleSidebarCollapsed: () => { layout.toggleSidebarCollapsed() },
          setIntegrationsOpen: (v: boolean) => { layout.setIntegrationsOpen(v) },
          toggleIntegrations: () => { layout.toggleIntegrations() },
          // 插件中心触发：壳不持面板（业务 chrome 已拆出），经 LayoutController
          // → grid actions 订阅面通知，corum-ide-plugin-manager-ui 插件认领并
          // 打开自己的 modal 面板（三-2 服务化，原 CustomEvent 广播已退役）。
          openPluginManager: () => { layout.openPluginManager() },
          // 设置中心触发（活动栏用户菜单）：直通 ctx.layout 的 openSettingsSection
          // 广播（OPEN_SETTINGS_SECTION_EVENT），SettingsShell 监听后打开指定页。
          openSettingsSection: (id: string) => { layout.openSettingsSection(id) },
          // 应用更新能力面（2026-10-15）：窄化 host 侧 updateChecker RPC 成本地
          // UpdateApi 接口（红线 3）。connection.rpc.call 通道，与 makeCorumRpcCall
          // 同契约。安装动作走 IPC（window.corumDesktop.installUpdate）。
          updateApi: makeUpdateApi(makeCorumRpcCall(ctx.get('connection') as ConnectionHandle)),
          // 更新面板品牌头图：corumapp:// 协议读 desktop assets。
          updateHeroImageSrc: 'corumapp://app/assets/brand-update-dark.png',
          hooks: {
            theme: {
              getSnapshot: () => ctx.theme.getTheme().preference,
              subscribe: (fn: () => void) => ctx.on('theme/change', fn),
            },
            // 活动栏的两个选择器源（PR3）：当前侧栏模式 + 项目工作面可用性。
            // 前者复用 PR2 的服务快照源；后者 = `corum.sidebar.project` 槽占用
            // 判定（与 corum-ide-sidebar-ui 的 projectOccupied 同一判据，社区版
            // 无 occupant ⇒ false ⇒ 活动栏项目图标置灰 + lock 角标）。
            sidebarMode: layout.sidebarModeSnapshot(),
            // 窗口 chrome 源（2026-09-30）：侧栏折叠 + 集成中心开关（同一份跨
            // bundle 单例状态，引用只在字段变化时换）。
            chrome: layout.chromeSnapshot(),
            projectOccupied: {
              getSnapshot: () => ctx.slots.entriesOfSlot('corum.sidebar.project').length > 0,
              subscribe: (fn: () => void) => ctx.slots.subscribe('corum.sidebar.project', fn),
            },
          },
        }
      },
    }, IdeAppFrame)
    return () => {
      disposeRegistration()
      void disposeTokens()
      offAccent()
      void disposeAccent()
      offFontBase()
      offDensity()
      offFontFamily()
      void disposeService()
      void disposeRegistry()
    }
  }, 'ide-shell: service + token layer + root registration')

  /**
   * 会话顶栏的 corum 段（2026-09-10「顶栏归会话」）：注册进**会话级**槽
   * `conversation.session.header.actions`（状态胶囊 + 常驻 Agent 胶囊）与
   * `.utilities`（轨迹按钮，右对齐），宿主是会话插件 ConversationSessionHeader
   * 的 titleRow——该行随会话视图渲染，会话拖出为独立窗口时自带顶栏。
   *
   * 为什么是这两个槽：二者由 `@corum/corum-ui-conversation` 在 apply.ts 声明为
   * **list** 子槽，此前无人 renderSlot（2026-08-29 删 titleRow 后成为死槽），
   * 故壳往这里注册不会与官方/会话插件自己的注册冲突（对比：直接在壳里注册
   * `conversation.session.header` 这个 **single** 槽会重复注册，实测让会话插件
   * apply 失败、对话区整体不渲染——本轮已避开该路径）。
   *
   * 用 `ctx.slots.inject(槽名, …)` 包裹注册：槽由别的插件声明，inject 面保证
   * 「声明先于注册」的时序（与会话插件自己的 queueDockEntry 同法）。
   */
  ctx.effect(() => {
    const remote = ctx.remote as unknown as RemoteEventFace
    /**
     * 状态胶囊注入面：子 Agent 花名册 + 子会话跳转 + 台账冷启动基线。
     *
     * `connection` 用于拉**隔离台账的冷启动基线**：台账推送只在变更时 emit，
     * 页面刷新后不重放，纯推送订阅的历史会话永远看不到「N 个隔离工作区 · 待集成」
     * （而未集成分支可能被后续 cleanup 清掉，是最需要可见的信息）。
     */
    /**
     * 从 cordis 取 `chatRuntime` 的「定位子卡」能力并窄化（红线 3/4）。
     *
     * 为什么不用 `ctx.chatRuntime`：本包不 import 那个 bundle 的类型面（会把它拖进本包
     * 运行时）；服务实例的唯一性由 root context `reflect.store` 保证，所以运行时按名字取
     * 一次 + 形状校验即可。取不到就当没有这个能力（调用方退化），绝不抛。
     */
    const chatRevealCapable = (): ((childSessionId: string) => Promise<RevealOutcome>) | undefined => {
      const service = (ctx as unknown as { get?: (name: string) => unknown }).get?.('chatRuntime') as
        | { revealSubagentCard?: unknown }
        | undefined
      const fn = service?.revealSubagentCard
      if (typeof fn !== 'function') return undefined
      return (childSessionId: string) => (fn as (id: string) => Promise<RevealOutcome>).call(service, childSessionId)
    }

    /**
     * 从 cordis 取 `chatRuntime` 的「子会话进度」能力并窄化（红线 3/4，与上同源）。
     *
     * 为什么要它（2026-09-28 实测）：本包 session-bar 的种子会为每个已结束子会话拉一次进度，
     * 而视图每次激活都重新挂载 ⇒ 一轮动作 ~30 次 `getChildSessionProgress`（~270 ms/次）。
     * 走 bundle B 的共享缓存（终态结果整页只拉一次）即可省掉这些重复劳动。
     * 服务未装配 / 未实现 ⇒ 返回 undefined，组件回落直连 RPC（行为不变）。
     */
    const chatChildProgressCapable = (): ReadChildProgress | undefined => {
      const service = (ctx as unknown as { get?: (name: string) => unknown }).get?.('chatRuntime') as
        | { childProgress?: unknown }
        | undefined
      const fn = service?.childProgress
      if (typeof fn !== 'function') return undefined
      return (sessionId: string) => (fn as (id: string) => Promise<never>).call(service, sessionId) as never
    }

    const statusInjected = () => ({
      remote,
      openSession: (sessionId: string) => { ctx.sessions.open(sessionId as never) },
      /**
       * 「在父会话瀑布里定位子 Agent 卡」的窄化能力（2026-09-18 用户需求）。
       *
       * 红线 1：跨 bundle 的共享能力必须是 cordis 服务 —— 子卡的 DOM 在
       * `@corum/corum-ui-chat` 的 ChatView 里，而入口在本包（另一个 bundle），
       * 所以经 `chatRuntime` 服务（bundle B `ctx.provide('chatRuntime', …)`）交付。
       * 红线 3：本包只声明用到的那个方法，不耦合服务实现（窄化 + 运行时形状校验）。
       * 服务未装配/未实现时返回 undefined 方法 ⇒ 组件的跳转按钮走退化路径（进子会话）。
       */
      revealCard: chatRevealCapable(),
      /** 子会话进度共享读取（见 `chatChildProgressCapable` 的说明）。 */
      readChildProgress: chatChildProgressCapable(),
      connection: ctx.get('connection') as ConnectionHandle | undefined,
      /**
       * 子 Agent 花名册的 durable 基线源（官方直接子会话目录）。
       * 胶囊必须显示**已经跑完的**与**编排模式下派出的**子 Agent，而 corum 推送帧只在
       * 变更时发、刷新后不重放，所以基线走官方目录（宿主 `subagent.list` 读子会话血缘）。
       * 这里只下发能力，拉取与订阅生命周期留在组件内（红线 4：经 inject 交付）。
       */
      catalog: {
        refresh: (parentSessionId: string) => { void ctx.sessions.refreshSubagents(parentSessionId as never) },
        setCatalogOpen: (parentSessionId: string, open: boolean) => {
          ctx.sessions.setSubagentCatalogOpen(parentSessionId as never, open)
        },
      },
    })
    /** 轨迹按钮注入面：切换壳的轨迹区域显隐（浮窗内 layout 无网格，静默 no-op）。 */
    const trajectoryInjected = () => ({
      toggleTrajectory: () => { layout.toggleRegion(TRAJECTORY_REGION) },
    })
    const disposeStatus = ctx.slots.inject(SESSION_BAR_SLOTS.status, () => ctx.slots.register({
      name: SESSION_BAR_SLOTS.status,
      id: SESSION_BAR_IDS.status,
      order: 10,
      inject: statusInjected,
    }, SessionStatusPill))
    const disposeTrajectory = ctx.slots.inject(SESSION_BAR_SLOTS.trajectory, () => ctx.slots.register({
      name: SESSION_BAR_SLOTS.trajectory,
      id: SESSION_BAR_IDS.trajectory,
      order: 10,
      inject: trajectoryInjected,
    }, SessionTrajectoryButton))
    // 浮窗里的「收回到主窗口」（order 20 = 排在轨迹按钮右侧；非浮窗自身返回 null）。
    const disposeFloatingClose = ctx.slots.inject(SESSION_BAR_SLOTS.trajectory, () => ctx.slots.register({
      name: SESSION_BAR_SLOTS.trajectory,
      id: SESSION_BAR_IDS.floatingClose,
      order: 20,
    }, FloatingCloseButton))
    return () => {
      disposeStatus()
      disposeTrajectory()
      disposeFloatingClose()
    }
  }, 'ide-shell: session bar slots (status pill + trajectory)')

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
      t: t as (key: string) => string,
      // 「发现更多插件」触发面：直通 LayoutController → grid actions 订阅面
      //（三-2 服务化；SettingsShell 经 SectionNavContext 下发到 section 组件）。
      openPluginManager: () => { layout.openPluginManager() },
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
          subscribe: (listener: () => void) => {
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
          subscribe: (listener: () => void) => ctx.slots.subscribe('settings.onboarding', listener),
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
        // settings.general.item 的子槽声明放在「外观」section 条目上（2026-09-16
        // 重组：自原 general 分区迁入，见下方 appearance 分支），不在 sidebar.settings
        // occupant 重复声明——slots 运行时禁止同一槽被声明两次（"already declared"）。
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
    // ── 批量注册设计稿 section（外观/通知/快捷键/权限/.../配置档案）──
    // 每个 section 用 SettingsSections.tsx 中的组件渲染。业务 section（技能等）
    // 需调 host RPC：这里构造全局 caller 并经 CorumRpcContext 下发（官方
    // connection.rpc.call 通道，与 makeCorumRpcCall 同契约；不用 ctx.remote——
    // 见 PROGRESS §4 「ctx.remote 命名空间代理」坑）。
    const corumRpc = makeCorumRpcCall(ctx.get('connection') as ConnectionHandle)
    // 「子 Agent」section 的 settings 面（describe 镜像读 + remote.settings.mutate 写；
    // 经 CorumSettingsContext 下发——service 消费走 inject 声明（红线 4），
    // 组件不直接持 ctx，保持与 CorumRpcContext 同构的下发模式）。
    const corumSettings: CorumSettingsFace = {
      describe: ctx.settingsScope.describe(),
      mutate: (ns, ops, revision) => ctx.remote.settings.mutate(
        ns,
        ops.map(op => op.op === 'set'
          ? { op: 'set' as const, path: [...op.path], value: op.value as never }
          : { op: 'unset' as const, path: [...op.path] }),
        revision,
      ),
    }
    // 通知偏好面（PRD v2 §4.4）：从 ctx.notifications cordis 服务裁剪出偏好子面
    // （本地能力接口收窄，红线 3——本 bundle 不 import desktop 实现包的类型）。
    // ctx.notifications 由 corum-desktop provide，cordis root reflect.store 保证
    // 跨 bundle 单例（红线 1 合规，非 window 全局）；经 inject 声明获取（红线 4，
    // 不可未 inject 直接读）。故设置页的写入与 toast 栈的读取命中同一实例，
    // 实时联动。服务缺席时置 null，通知 section 控件降级为禁用 + 未上线。
    interface NotificationPrefsFaceLocal {
      enabled: boolean
      sound: boolean
      dnd: boolean
    }
    const notificationsSvc = ctx.get('notifications') as {
      getPrefs(): NotificationPrefsFaceLocal
      setPrefs(patch: Partial<NotificationPrefsFaceLocal>): void
      subscribePrefs(listener: () => void): () => void
    } | undefined ?? null
    // 字面偏好面（PRD §4.23 E1/E2/E3、§4.2 乙类）：fontPrefs cordis 服务
    // （desktop provide，跨 bundle 单例；inject 声明获取，红线 4）。本地能力
    // 接口收窄（红线 3）；编辑器/终端 section 经 context 接真源、实时联动。
    const editorDisplayPrefsSvc = ctx.get('editorDisplayPrefs') as EditorDisplayPrefsService | undefined ?? null
    interface FontPrefsFaceLocal {
      editor: { fontSize: number; fontFamily: string; lineHeight: number }
      terminal: { fontSize: number; fontFamily: string }
    }
    const fontPrefsSvc = ctx.get('fontPrefs') as {
      getPrefs(): FontPrefsFaceLocal
      setPrefs(patch: { editor?: Partial<FontPrefsFaceLocal['editor']>; terminal?: Partial<FontPrefsFaceLocal['terminal']> }): void
      subscribe(listener: () => void): () => void
    } | undefined ?? null
    // fork（corum）：general section 也包 CorumSettingsContext.Provider——其「工作区」
    // 组（新工作区始终初始化 git 开关，2026-09-09 用户需求）是 GeneralSection 里第一个
    // 真实持久化项，需要 settings 面；此前 GeneralSection 单独注册未包 Provider（纯静态
    // 占位），导致 WorkspaceGitGroup 的 useContext(CorumSettingsContext) 拿 null 降级隐藏。
    // 2026-09-16 重组：「通用」页（general 分区）已拆散删除 ——
    //   应用级项（界面语言 language / 忙碌时回车 composer-enter）经 settings.general.item
    //   子槽迁入**外观页**（见下方 appearance 注册的 renderSlot 承接）；
    //   Agent 语义组（改动审查保留 / Agent 执行阈值）迁入**智能体设置页**（general-groups.tsx）。
    //   原 GeneralSection 的 settings.general.item 渲染点随之移到外观页——该槽的注册方
    //   （官方 locale / conversation fork 等）不动，仅渲染点迁移。
    //
    // ⚠️ 外观单独注册且**必须在 SECTION_DEFS 批量之前**：slot 列表的导航投影按
    //   「注册（装配）顺序」排序，order 字段不参与（实测：外观后注册时 order=5/200
    //   都落到数据管理之后）。外观是 general 组首项，故在原 general 的位置先注册。
    const disposeAppearance = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'appearance',
      order: 10,
      label: () => t('nav.appearance'),
      locale: NS,
      children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
    }, (props: SettingsSectionOwnerProps & { renderSlot: (key: 'settings.general.item', owner: object, opts?: { only?: string }) => ReactNode }) => (
      <CorumRpcContext.Provider value={corumRpc}>
        <CorumSettingsContext.Provider value={corumSettings}>
          <SettingsSectionHost {...props} render={() => <AppearanceSection renderSlot={props.renderSlot} />} />
        </CorumSettingsContext.Provider>
      </CorumRpcContext.Provider>
    )))
    const disposeSections = SECTION_DEFS.map(def => {
      // 「插件管理」section 已整块移除（2026-10-03）：插件管理由集成中心「插件」页
      // 接管，本壳不再注册 extensions 分区。随它消失的还有 settings.plugins.tab
      // 子槽的唯一渲染者——corum fork 的「插件配置」tab（corum-ui-settings-plugins）
      // 与官方 plugin-inventory「插件列表」tab 都注册进该共享槽，而该槽只在被删除的
      // ExtensionsSection 的 renderTabSlot 里被渲染 ⇒ 两个 tab 均不再出现。
      // 「数据管理」section 声明 settings.data.item 子槽 ——
      // 供 corum-session-archive 的「导入会话日志」行迁入（PRD §4.8 DA5）。
      // ⚠️ 两件事缺一不可：① SlotMap 登记键名（见上方增强块）；
      // ② 此处的 children 声明；③ 注册方改挂到该 key。
      // 「归档会话」整组（含该子槽的渲染点）已随 issue #121 修订版迁往
      // 「会话管理」独立 section 页（2026-10-22），此处保留声明仅为不破坏
      // 已注册方的挂载（渲染点已不在本页 ⇒ 子槽自然不出现）。
      if (def.id === 'data') {
        return ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: def.id,
          order: def.order,
          label: () => t(def.label),
          locale: NS,
          children: { 'settings.data.item': { kind: 'list', scope: 'root' } },
        }, (props: SettingsSectionOwnerProps & { renderSlot: (key: 'settings.data.item', owner: Record<string, never>, opts?: { only?: string }) => ReactNode }) => (
          <CorumRpcContext.Provider value={corumRpc}>
            <CorumSettingsContext.Provider value={corumSettings}>
              <SettingsSectionHost {...props} render={() => <DataSection renderSlot={props.renderSlot} />} />
            </CorumSettingsContext.Provider>
          </CorumRpcContext.Provider>
        )))
      }
      // 「会话管理」section（issue #121 修订版）：归档会话的还原/导出/删除/导入。
      // 能力解析器经 context 下发（存档插件可选，缺席时页面降级为事实陈述）。
      if (def.id === 'session-management') {
        return ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: def.id,
          order: def.order,
          label: () => t(def.label),
          locale: NS,
        }, (props: SettingsSectionOwnerProps) => (
          <CorumRpcContext.Provider value={corumRpc}>
            <CorumSettingsContext.Provider value={corumSettings}>
              <SessionArchiveContext.Provider value={resolveSessionArchive(ctx)}>
                <SettingsSectionHost {...props} render={def.Component} />
              </SessionArchiveContext.Provider>
            </CorumSettingsContext.Provider>
          </CorumRpcContext.Provider>
        )))
      }
      return ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: def.id,
        order: def.order,
        // label 传 thunk（SlotLabel 支持 `() => string`，每次读取时求值）⇒
          // 导航标签跟随当前语言，无需重新注册。SECTION_DEFS 只存 key，
          // 绑 t 的动作在注册处（此处 t 已由 ctx.locale.bind(NS) 得到）。
          label: () => t(def.label),
        locale: NS,
      }, (props: SettingsSectionOwnerProps) => (
        <CorumRpcContext.Provider value={corumRpc}>
          <CorumSettingsContext.Provider value={corumSettings}>
            <NotificationPrefsContext.Provider value={notificationsSvc}>
              <FontPrefsContext.Provider value={fontPrefsSvc}>
                <EditorDisplayPrefsContext.Provider value={editorDisplayPrefsSvc}>
                  <SettingsSectionHost {...props} render={def.Component} />
                </EditorDisplayPrefsContext.Provider>
              </FontPrefsContext.Provider>
            </NotificationPrefsContext.Provider>
          </CorumSettingsContext.Provider>
        </CorumRpcContext.Provider>
      )))
    })

    return () => {
      disposeAppearance()
      for (const dispose of disposeSections) dispose()
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
