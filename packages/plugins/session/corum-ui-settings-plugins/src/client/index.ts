/**
 * fork（corum）：Plugins settings surface 的 corum 版——与官方逐行一致，两处实质 diff：
 *   ① 移除 SubagentModelSelectionCard 的注册（官方「允许 LLM 自主选子 Agent 模型」
 *      开关与 fork #10 模型锁语义互斥）。controller 实例保留（settings namespace
 *      `subagent-model-selection` 的 host 面仍可读写，避免存量设置文档出现未注册段），
 *      仅 UI 卡不再渲染。
 *   ② **移除 web-search 卡的注册**（2026-10-17）：该槽 `settings.plugin.item` 当前
 *      **没有任何渲染者**（渲染它的 ExtensionsSection 已随「插件管理」设置分区于
 *      2026-10-03 整块移除），所以那张卡在 UI 上完全不可达；它的全部字段（endpoint /
 *      maxUses / Key 状态）已搬到 @corum/corum-web-search 的「设置 → 扩展 → 联网搜索」
 *      section，随附那条 `credentials/reference-updated` 订阅一并搬走。
 * 原始模块：@deepseek-ai/dsh-client-ui-settings-plugins。
 *
 * Plugins settings surface, browser half — one section whose feature-owned
 * tabs include configurable Host plugin cards and read-only inventory.
 *
 * The section declares `settings.plugins.tab`; its own `configurable` tab then
 * declares `settings.plugin.item` and renders whatever cards were registered
 * into it. The cards this package ships are the host-plane sections the
 * deployment already exposes; each binds its namespace through the client
 * settings scope, which keeps them unaware of one another and of other tabs.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry)
// and the ctx.settingsScope Context merge. Cross-plugin collaboration goes
// through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AgentLoopCard } from './AgentLoopCard.tsx'
import { BashCard } from './BashCard.tsx'
import { ConfigurablePluginsTab } from './ConfigurablePluginsTab.tsx'
import { SubagentModelSelectionCard } from './SubagentModelSelectionCard.tsx'
import { AGENT_LOOP_NS, AgentLoopCardController } from './agent-loop-card-controller.ts'
import { SHELL_NS, BashCardController } from './bash-card-controller.ts'
import { ConfigurablePluginsTabController } from './tab-store.ts'
import {
  SUBAGENT_MODEL_SELECTION_NS, SubagentModelSelectionCardController,
} from './subagent-model-selection-card-controller.ts'
import { en, zh } from './locales.ts'

export type { ConfigurablePluginsTabProps } from './ConfigurablePluginsTab.tsx'
export type { ConfigurablePluginsTabFace, ConfigurablePluginsTabState } from './tab-store.ts'
export type { PluginCardProps } from './PluginCard.tsx'
export type { SettingsPluginItemOwnerProps } from './slot-contract.ts'
export type { FieldProps } from './fields.tsx'
export type {
  CardActions, CardFieldSpec, CardFieldState, CardSecretSpec, CardShell,
} from './card-form.ts'
export type { AgentLoopCardFace, AgentLoopCardState } from './agent-loop-card-controller.ts'
export type { BashCardFace, BashCardState } from './bash-card-controller.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.plugins'

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.session', 'configForms',
]

/**
 * Mount the plugin configuration section and the cards this package ships.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugins: section dictionaries')

  const bash = new BashCardController(ctx.configForms.get(SHELL_NS))
  const agentLoop = new AgentLoopCardController(ctx.configForms.get(AGENT_LOOP_NS))
  const subagentModelSelection = new SubagentModelSelectionCardController(
    ctx.configForms.get(SUBAGENT_MODEL_SELECTION_NS),
    ctx,
  )

  // credential 面的订阅（`credentials/reference-updated`）随 web-search 卡一并
  // **搬去** @corum/corum-web-search 的 client 半（订阅者与被通知者是同一个 UI 面；
  // 卡删除后留在这里就是对已不渲染的 controller 做死写）。下面两条
  // `llm/adapters-updated` / `settings/document-updated` 服务的是
  // SubagentModelSelectionCard，与本变更无关，留在原处。
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { subagentModelSelection.refreshCatalog() }),
    'ui-settings-plugins: subagent adapter invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { subagentModelSelection.refreshCatalog() }),
    'ui-settings-plugins: subagent settings invalidations',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { subagentModelSelection.resetConnection() }),
    'ui-settings-plugins: subagent connection generation',
  )
  ctx.effect(() => () => { subagentModelSelection.dispose() }, 'ui-settings-plugins: subagent preference')

  // The shared configForms describe mirror updates after document commits and reconnects.
  const configurable = new ConfigurablePluginsTabController(
    ctx.configForms.describe(), () => ctx.slots.entries('settings.plugin.item'))
  ctx.effect(() => () => { configurable.dispose() }, 'ui-settings-plugins: tab directory')
  // A card registered after the first read joins the list without a wire call.
  ctx.effect(
    () => ctx.slots.subscribe('settings.plugin.item', () => { configurable.refresh() }),
    'ui-settings-plugins: card ledger',
  )

  // fork（corum，重构 2 决策 2）：不再注册独立的「插件」settings.section 导航入口
  // ——该入口的 tab chrome（PluginsSettingsSection）由 @corum/corum-ide-ui 的
  // 「插件管理」扩展 section 承接（它声明并渲染共享槽 settings.plugins.tab）。
  // 本包保留：配置 tab（settings.plugins.tab 的 configurable entry）+ 两张卡
  // （settings.plugin.item 的 shell/agent-loop 注册；web-search 卡已移除，见文件头）。
  // 官方 plugin-inventory 的「插件列表」tab 仍注册进 settings.plugins.tab，一并归入
  // 「插件管理」。

  // The existing configuration page is one ordinary tab. It keeps ownership
  // of the card slot and the shipped card contributions below.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'configurable',
    order: 0,
    label: () => t('configurableTab'),
    locale: NS,
    inject: () => configurable.inject(),
    children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
  }, ConfigurablePluginsTab))

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SHELL_NS,
      locale: NS,
      inject: () => bash.inject(),
    }, BashCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: AGENT_LOOP_NS,
      locale: NS,
      inject: () => agentLoop.inject(),
    }, AgentLoopCard)
    // fork（corum）：官方 SubagentModelSelectionCard 注册移除（见文件头 fork 注释）。
    // 官方卡语义（LLM 自主选模型）与 fork #10 模型锁互斥；固定路由配置由
    // corum「子 Agent」设置 section 承载（corum-subagent namespace）。
    void SUBAGENT_MODEL_SELECTION_NS
    void SubagentModelSelectionCard
    // fork（corum，2026-10-17）：官方 web-search 卡（key `web-search-deepseek`）
    // 的注册**已移除**——本槽没有渲染者（见文件头），且该卡的全部字段已搬到
    // @corum/corum-web-search 的「设置 → 扩展 → 联网搜索」section（那是它第一次
    // 真正可用）。⚠️ 不要在这里恢复：恢复会造出第二份 web-search 配置面。
  })
}
