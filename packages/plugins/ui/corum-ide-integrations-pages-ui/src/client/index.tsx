/**
 * @corum/corum-ide-integrations-pages-ui client half —— 集成中心内容页（PR6）。
 *
 * 交付物：**三个页面组件**——`McpPage`（MCP 服务器列表/详情/添加三视图）、
 * `SkillsPage`（技能列表 + 详情 + 版本/绑定 + 导入）与 `ExtensionsPage`
 * （P5b：扩展包只读列表 + 详情 + 空态 + 开发者 gated 本地导入）。前两者原为
 * 设置中心的 `SettingsMcpSection` / `SettingsSkillsSection`，PR6 按信息架构调整
 * 「移出设置中心、成为集成中心的内容页」；ExtensionsPage 是 P5b 新增页。
 *
 * ## 挂载（PR4 已落地 ⇒ live 代码）
 *
 * 集成中心的**骨架（面板头 + 子导航 + 五个内容子槽的声明）由
 * `@corum/corum-ide-ui` 持**：槽位声明权归骨架，本包只作 occupant。
 * 下面 `apply` 里的三段 `ctx.slots.inject` 从模块头注释转正（`inject` 保证
 * 「声明先于注册」的时序；骨架被裁掉的发行版里槽不存在 ⇒ 本包什么都不做，
 * 不会误注册）。三段的形状相同，此处只摘录 MCP 那段：
 *
 * ```tsx
 * const connection = ctx.get('connection') as ConnectionHandle
 * const rpc = makeCorumRpcCall(connection)   // @corum/corum-rpc-client/client
 * ctx.effect(() => ctx.slots.inject('corum.integrations.mcp', () => ctx.slots.register(
 *   { name: 'corum.integrations.mcp', id: 'integrations-mcp' },
 *   () => <IntegrationsRpcContext.Provider value={rpc}><McpPage /></IntegrationsRpcContext.Provider>,
 * )), 'ide-integrations: MCP 页')
 * ```
 *
 * 槽名常量见 `./slots.ts` 的 `INTEGRATIONS_PAGE_SLOTS`（与骨架声明的键同域，
 * `satisfies keyof SlotMap` 锚定）。
 * 登记位置：`packages/desktop/cordis.ide.patch.yml` 的 insert 段 + `packages/desktop/package.json`
 * 与 `packages/desktop/desktop-host/package.json` 的 dependencies（打包闭包按后者补齐）。
 *
 * ## 与设置中心的关系（PR6 收口）
 *
 * 两个 section 已从 `@corum/corum-ide-ui` **移出**（不是复制）：`SettingsSections.tsx`
 * 的 `mcp` / `skills` 两条 SECTION_DEFS、两个 import、`settings-locales.ts` 的
 * `nav.mcp` / `nav.skills` 文案、以及 `SettingsSections.module.css` 里仅供两页使用的
 * 样式一并删除；设置页的「插件管理」「AI 润色」不受影响。
 *
 * @module corum-ide-integrations-pages-ui/client
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
import { McpPage } from './McpPage.tsx'
import { SkillsPage } from './SkillsPage.tsx'
import { ExtensionsPage } from './ExtensionsPage.tsx'
import { MarketPage } from './MarketPage.tsx'
import { IntegrationsRpcContext } from './face.tsx'
import { INTEGRATIONS_PAGE_SLOTS } from './slots.ts'

export { McpPage } from './McpPage.tsx'
export { SkillsPage } from './SkillsPage.tsx'
export { ExtensionsPage } from './ExtensionsPage.tsx'
export { MarketPage } from './MarketPage.tsx'
export { IntegrationsRpcContext, useIntegrationsRpc, GlassButton } from './face.tsx'
export { INTEGRATIONS_PAGE_SLOTS } from './slots.ts'
export type { IntegrationsPageOwnerProps } from './slots.ts'

/**
 * Required services：`slots` 给 `ctx.slots.inject/register`，`connection` 给
 * `makeCorumRpcCall(connection)` 构造两个页面用的 RPC 调用函数（声明即硬依赖）。
 */
export const inject = ['slots', 'connection']

/**
 * Client plugin body：把两个内容页挂进集成中心骨架声明的槽。
 *
 * 页面组件本身不接 cordis——RPC 面经 `IntegrationsRpcContext` 下发（与它们
 * 迁出前经设置壳 `CorumRpcContext` 取值的形态同构）。
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const rpc = makeCorumRpcCall(connection)
  // 两段各自包 ctx.effect ⇒ 插件卸载时 occupant 自动摘除。
  ctx.effect(() => ctx.slots.inject(INTEGRATIONS_PAGE_SLOTS.mcp, () => ctx.slots.register(
    { name: INTEGRATIONS_PAGE_SLOTS.mcp },
    () => (
      <IntegrationsRpcContext.Provider value={rpc}>
        <McpPage />
      </IntegrationsRpcContext.Provider>
    ),
  )), 'ide-integrations: 集成中心 MCP 页')
  ctx.effect(() => ctx.slots.inject(INTEGRATIONS_PAGE_SLOTS.skills, () => ctx.slots.register(
    { name: INTEGRATIONS_PAGE_SLOTS.skills },
    () => (
      <IntegrationsRpcContext.Provider value={rpc}>
        <SkillsPage />
      </IntegrationsRpcContext.Provider>
    ),
  )), 'ide-integrations: 集成中心技能页')
  // 扩展包页（P5b）：只读列表 + 详情 + 空态 + 开发者 gated 本地导入。
  // RPC 面经同一份 IntegrationsRpcContext 下发（extensionManager.list/detail/installLocal）。
  ctx.effect(() => ctx.slots.inject(INTEGRATIONS_PAGE_SLOTS.extensions, () => ctx.slots.register(
    { name: INTEGRATIONS_PAGE_SLOTS.extensions },
    () => (
      <IntegrationsRpcContext.Provider value={rpc}>
        <ExtensionsPage />
      </IntegrationsRpcContext.Provider>
    ),
  )), 'ide-integrations: 集成中心扩展包页')
  // 市场页（P5e 占位）：避免第 5 页签点开是空白面板；真实磁贴市场在 P5e 落地。
  ctx.effect(() => ctx.slots.inject(INTEGRATIONS_PAGE_SLOTS.market, () => ctx.slots.register(
    { name: INTEGRATIONS_PAGE_SLOTS.market },
    () => (
      <IntegrationsRpcContext.Provider value={rpc}>
        <MarketPage />
      </IntegrationsRpcContext.Provider>
    ),
  )), 'ide-integrations: 集成中心市场页（占位）')
}
