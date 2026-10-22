/**
 * Settings sections — 聚合入口（重构 2：section 全拆独立文件后，本文件瘦身
 * 为共享面 re-export + SECTION_DEFS 聚合注册）。
 *
 * - 共享面（CorumRpcContext / CorumSettingsContext / useCorumSettings /
 *   SectionNavContext / useSectionNav / GlassButton / InfoCard）已抽到
 *   `./shared.tsx`，本文件 re-export 保持既有 import 路径（index.tsx /
 *   SettingsShell.tsx / SettingsGeneralSection.tsx 零破坏）。
 * - section 组件各自住在 `./sections/Settings*Section.tsx`（原 19 个，PR6 迁出
 *   mcp / skills 两个到 @corum/corum-ide-integrations-pages-ui 后为 17 个）。
 * - `SECTION_DEFS` 聚合 import 各 section + 按 SectionDef.navGroup 自声明分组
 *   （归属分组由 section 自己声明；缺省归 'extensions'）。
 */
import type { ReactNode } from 'react'
import type { SettingsKey } from '../settings-locales.ts'
import { EditorSection } from './sections/SettingsEditorSection.tsx'
import { NotificationsSection } from './sections/SettingsNotificationsSection.tsx'
import { ShortcutsSection } from './sections/SettingsShortcutsSection.tsx'
import { TerminalSection } from './sections/SettingsTerminalSection.tsx'
import { AgentSettingsSection } from './sections/SettingsAgentSettingsSection.tsx'
import { PermissionsSection } from './sections/SettingsPermissionsSection.tsx'
import { PrivacySection } from './sections/SettingsPrivacySection.tsx'
import { DataSection } from './sections/SettingsDataSection.tsx'
import { SessionManagementSection } from './sections/SettingsSessionManagementSection.tsx'
import { HooksSection } from './sections/SettingsHooksSection.tsx'
import { AgentPresetsSection } from './sections/SettingsAgentPresetsSection.tsx'
import { AccountSection } from './sections/SettingsAccountSection.tsx'
import { PolishSection } from './sections/SettingsPolishSection.tsx'
import { AdvancedSection } from './sections/SettingsAdvancedSection.tsx'

// 共享面 re-export（保持 SettingsShell.tsx / SettingsGeneralSection.tsx /
// index.tsx 的既有 import 路径零破坏）。
export {
  CorumRpcContext,
  CorumSettingsContext,
  FontPrefsContext,
  NotificationPrefsContext,
  SectionNavContext,
  useCorumRpc,
  useCorumSettings,
  useFontPrefs,
  useNotificationPrefs,
  useSectionNav,
  GlassButton,
  InfoCard,
} from './shared.tsx'
export type { CorumSettingsFace, FontPrefsFace, FontPrefsService, NotificationPrefsFace, NotificationPrefsService, SectionActions } from './shared.tsx'

/* ── 导出 section 组件映射 ──────────────────────────────────────────── */

/**
 * 设置中心导航分组。
 *
 * `memory` 是 2026-09-21 新增的第 6 组（用户裁定「将记忆单独列一个项，放在智能体下方，
 * 将全局设置、智能体记忆这些 section 放进去」）—— 记忆自成一组，与
 * 「智能体」并列，而不是挤在智能体组里当子项。（2026-09-22「移除项目记忆」后
 * 组内收敛为两个 section。）
 */
export type SettingsNavGroup = 'general' | 'agent' | 'memory' | 'data' | 'extensions' | 'advanced'

export interface SectionDef {
  id: string
  order: number
  /**
   * 导航标签的 **locale key**（不是显示文本本身）。
   *
   * 为什么存 key 而非字符串/预绑定 thunk：导航行由 `settings.section` 槽投影，
   * 而该槽的 `label` 支持 `SlotLabel = string | (() => string)`——**thunk 每次读取
   * 时求值**（`@deepseek-ai/dsh-client-ui-slots` 的 `resolveSlotLabel`），因此
   * 注册期给的 thunk 会跟随当前语言，**无需重新注册**。官方 `ui-settings-general`
   * 的 General 条目就是这么写的（`label: () => t('general.nav')`）。
   * 但 `SECTION_DEFS` 是**模块级常量**，拿不到注册期的 `t`（它在 `index.tsx` 的
   * effect 里经 `ctx.locale.bind(NS)` 得到）⇒ 此处只声明 key，由注册处绑成
   * `() => t(def.label)`。
   */
  label: SettingsKey
  /** 归属分组（自声明）；缺省归 'extensions'（扩展）。 */
  navGroup?: SettingsNavGroup
  /**
   * section 组件；多数无 props。
   *
   * 声明了**子槽**的 section 会额外收到渲染器：
   * - `data`（数据管理）收 `renderSlot`（`settings.data.item`）
   *
   * `extensions`（插件管理）的 `renderTabSlot` 已随该分区移除（2026-10-03）——
   * 组件仍留在可选 props 形里，`renderTabSlot` 一支暂无使用方。
   */
  Component: (props?: {
    renderTabSlot?: () => ReactNode
    renderSlot?: (key: string, owner: object, opts?: { only?: string }) => ReactNode
  }) => ReactNode}

/**
 * 所有 section 定义（用于 index.tsx 批量注册）。
 * 归属分组由 section 自声明 `navGroup`，缺省归 'extensions'。
 * 「子 Agent」迁归 AGENT；「插件管理」分区已整块移除（2026-10-03，
 * 插件管理由集成中心「插件」页接管，见 SECTION_DEFS 里的 ➖ 注释）。
 *
 * ⚠️ PR6 起本表**不再含 mcp / skills**：两条分区已迁出为集成中心的内容页
 * （见下方 SECTION_DEFS 里的 ➖ 注释）。
 */
export const SECTION_DEFS: SectionDef[] = [
  // ⚠️ appearance（外观）不在此表：它需声明 settings.general.item 子槽承接应用级
  //   通用项（2026-09-16 重组），renderSlot 是窄字面量类型（与本表 Component 的
  //   key:string 宽类型逆变不兼容）⇒ 由 index.tsx 单独注册（同原 general 模式）。
  // ➕ M3 新建：编辑器分区（用户裁定 #1「要单独有一个编辑器的设置页面」；设计稿与本文件均为新增）。
  { id: 'editor', order: 15, label: 'nav.editor', navGroup: 'general', Component: EditorSection },
  { id: 'notifications', order: 20, label: 'nav.notifications', navGroup: 'general', Component: NotificationsSection },
  { id: 'shortcuts', order: 30, label: 'nav.shortcuts', navGroup: 'general', Component: ShortcutsSection },
  { id: 'permissions', order: 65, label: 'nav.permissions', navGroup: 'agent', Component: PermissionsSection },
  // ➖ rules（规则与指令）分区已按用户裁定移除（2026-09-16）。
  //   依据：C1「自定义 Agent 预设已覆盖这个能力 …… 我的设计理念就是以 Agent 为单位
  //   进行管控」+ B4「移除系统提示词前缀」⇒ 全局提示词注入不提供用户可写出口，
  //   「全局自定义指令」与「人格 Personality」两个入口一并取消（PRD §4.1 / §6.4 / §11 C1）。
  //   ⚠️ 不要恢复：本分区在设计与正确性上都已被 Agent 预设取代。
  // ➖ memory（记忆）分区已移交插件自注册（2026-09-21，用户拍板三层信息架构；
  //   2026-09-22「移除项目记忆」收敛为两层）。
  //   依据：底座 `@corum/corum-memory` 已落地（事实级存储 + 存续期 + 衰减 + 检索），
  //   而壳里的 SettingsMemorySection 是「dsh 内核无 memory」时代的 **19 项全 disabled
  //   假清单** —— 两套语义并存会让用户看到 disabled 的假开关（旧文件已删除）。
  //   现由插件注册**两个** section：`memory`（记忆 · 全局设置，order 60，接管本行删掉的
  //   id）/ `memory-store`（记忆 · 记忆库，order 61）。归属分组见下方 NAV_GROUP_BY_ID。
  //   ⚠️ 不要恢复本行：壳不再持有记忆分区。
  { id: 'terminal', order: 18, label: 'nav.terminal', navGroup: 'general', Component: TerminalSection },
  { id: 'hooks', order: 90, label: 'nav.hooks', navGroup: 'agent', Component: HooksSection },
  // ✏️ M2 重构：原 `agent-loop`（「高级 Agent Loop」）改名并扩容为 `agent-settings`（「智能体设置」），
  //    同时**并入**原 `subagent`（「子 Agent」）分区 —— 用户 2026-09-16 第二批裁定
  //    「子 Agent 并入智能体设置」⇒ 导航由 24 项收敛为 23 项。
  //    ⚠️ 顺带移除了原分区里的「系统提示词前缀」（用户裁定 B4/C1：以 Agent 为单位管控，
  //    全局提示词入口会造成污染）与两个无真源的自造项（重试次数 / 重试间隔）。
  { id: 'agent-settings', order: 55, label: 'nav.agentSettings', navGroup: 'agent', Component: AgentSettingsSection },
  { id: 'agent-presets', order: 110, label: 'nav.agentPresets', navGroup: 'agent', Component: AgentPresetsSection },
  { id: 'account', order: 120, label: 'nav.account', navGroup: 'data', Component: AccountSection },
  { id: 'privacy', order: 130, label: 'nav.privacy', navGroup: 'data', Component: PrivacySection },
  { id: 'data', order: 140, label: 'nav.data', navGroup: 'data', Component: DataSection },
  // ➕「会话管理」独立 section 页（issue #121 修订版，设计稿 mdBB5）：归档会话的
  //    还原 / 导出 / 删除 / 导入全生命周期管理。原 ManageDialog（Modal）被用户
  //    2026-10-22 验收否掉（要求独立页面），入口按钮随之从「数据管理」页移除。
  //    导航位在「数据管理」之后（secC 分组），order 145 留空档给已移除的
  //    extensions（145）——本项取 142 紧邻 data 之后。
  { id: 'session-management', order: 142, label: 'nav.sessionManagement', navGroup: 'data', Component: SessionManagementSection },
  // ➖ mcp（MCP 与集成，order 150）/ skills（技能，order 160）两条分区已**迁出设置中心**
  //   （2026-09-27，PR6：信息架构调整——二者成为**集成中心的内容页**）。
  //   实现移入 @corum/corum-ide-integrations-pages-ui 的 McpPage / SkillsPage，
  //   占槽 corum.integrations.mcp / corum.integrations.skills（声明权归 PR4 的集成中心骨架）。
  //   ⚠️ 不要恢复本两行：设置中心不再持有这两个分区，恢复会造出第二份入口与第二份 RPC 面。
  //   （AI 润色 ai-polish 是设置域能力，留在本文件原位不动。）
  // fork（corum）：AI 润色配置（2026-09-09 重建；导航 id 沿用历史值 ai-polish）。
  { id: 'ai-polish', order: 165, label: 'nav.aiPolish', navGroup: 'extensions', Component: PolishSection },
  { id: 'advanced', order: 170, label: 'nav.advanced', navGroup: 'advanced', Component: AdvancedSection },
  // ➖ profiles（配置档案）分区已按用户裁定移除（2026-09-16）。
  //   依据：本地「设置快照/切换/导入导出」机制不做——未来走**账号登录 + 云端保存**，
  //   本地整文件覆盖 settings.yaml 的快照路径（PRD §15.5，与 settings-yaml-guard.ts
  //   记录的 2026-09-15 写坏故障同源风险）被否决。
  //   ⚠️ 不要恢复：本地 Profile 与云端账号是两套互斥方向，恢复会造成概念与实现双轨。
  //   （档案 ≠ Agent 预设：预设 = 单 Agent 配置集合，与本次移除无关，仍保留。）
  // 扩展组次序按设计稿：插件管理 → AI 润色 → Ollama(195) → 本地文生图(197)。
  // （「MCP 与集成 / 技能」原在本组，PR6 起归集成中心，见上方 ➖ 注释。）
  // ➖ extensions（插件管理，order 145）分区已按用户裁定整块移除（2026-10-03）：
  //   插件管理全部收编进集成中心「插件」页的「已装」tab（启停 / 卸载 / 搜索与市场同面）；
  //   系统插件按底座版本聚合展示在同一个 tab（只读详情）。⚠️ 不要恢复：恢复会造出
  //   第二份插件管理入口与第二份 pluginManager RPC 消费面（同 mcp/skills 迁出口径）。
  //   随本行消失的还有 settings.plugins.tab 子槽的唯一渲染者——corum fork 的
  //   「插件配置」tab（corum-ui-settings-plugins）与官方 plugin-inventory「插件列表」
  //   tab 都注册进该槽，而该槽只在原 ExtensionsSection 的 renderTabSlot 里被渲染；
  //   分区删除后两个 tab 自然不再出现（官方卡片列表不再渲染，无需 fork 官方包）。
]

/**
 * section id → 归属分组（SettingsShell 分组投影的数据源；重构 2 决策 4：
 * 归属由 section 自声明，缺省归 'extensions'）。
 *
 * - 壳自有 section：从 SECTION_DEFS 的 navGroup 自声明派生。
 * - `models`：跨 bundle section（@corum/corum-ui-settings-models 注册），
 *   按 PLAN 映射表固定归 'agent'（现状同）。
 * - 其余跨 bundle section（artgen / ollama 等）未在此表 → 缺省归 'extensions'。
 *
 * ⚠️ 原 `general` 分区已于 2026-09-16 拆散删除（通用页回归应用级：
 * 语言/忙碌时回车迁入外观页，Agent 语义组迁入智能体设置页）。
 */
export const NAV_GROUP_BY_ID: Record<string, SettingsNavGroup> = {
  ...Object.fromEntries(SECTION_DEFS.map(d => [d.id, d.navGroup ?? 'extensions'])),
  // appearance 不在 SECTION_DEFS（index.tsx 单独注册），但归属仍是 general 组——
  // 缺了这条它会落默认 extensions 组（实测导航跑到「数据管理」之后）。
  appearance: 'general',
  models: 'agent',
  // 记忆两个 section 由 @corum/corum-memory 插件自注册（不在 SECTION_DEFS 里），
  // 缺了这两条会落默认 extensions 组（导航跑到「扩展」区）。
  // ⚠️ id 必须与插件 slots.register 的 id 一致（memory-settings / memory-agent）。
  //    二者同归 `memory` 组 ⇒ 导航里「记忆」自成一组。
  //    （2026-09-22「移除项目记忆」：memory-project section 已删除。）
  'memory-settings': 'memory',
  'memory-agent': 'memory',
}
