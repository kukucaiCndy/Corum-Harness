/**
 * 集成中心槽位契约（PR6；PR4 收口）。
 *
 * 集成中心的内容页（MCP / 技能）由本包交付；**槽位声明权归集成中心骨架**
 * ——`@corum/corum-ide-ui` 在它自己的 `ctx.slots.register({ name: 'root',
 * children: {...} })` 里声明这两个洞（以及 `corum.integrations.plugins`），
 * 本包只作为 occupant 注册内容（`ctx.slots.inject` 保证「声明先于注册」的时序）。
 *
 * ## 类型为什么不再住在这里（PR4 收口）
 * 本文件原先把 `corum.integrations.mcp` / `.skills` 两键 declare 进 SlotMap，
 * 当时写的是「PR4 只需逐字相同即合法合并」。PR4 落地时按**声明权 = 契约真源**
 * 的纪律把这个权限收敛回骨架包：SlotMap 是合并接口，同名键在两处声明且
 * `owner` 类型不同即 TS2717 编译错，与其靠「两处逐字相同」维持，不如只留一个
 * 真源点。故此处改为一行 type-only 消费（拉入骨架的键 + owner 面），本文件只
 * 保留槽名常量——它才是本包真正需要的那一件东西。
 *
 * @module corum-ide-integrations-pages-ui/slots
 */
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入骨架包声明的 `corum.integrations.*` 键与 owner 面。
import type {} from '@corum/corum-ide-ui/client'

/**
 * 集成中心内容页的 owner 面：**空标记**（真源在骨架包，此处只转发便于本包内引用）。
 *
 * 页面所需的 RPC 面经 `IntegrationsRpcContext` 下发（本包 `client/face.tsx`），
 * 不从 owner props 走——owner 面留给骨架将来要下发的壳级状态（如当前工作面），
 * 现在不预设任何字段，避免先占位再删。
 */
export type { IntegrationsPageOwnerProps } from '@corum/corum-ide-ui/client'

/** 集成中心内容页的槽名（骨架声明、本包占用；单一事实源）。
 *  P5b 追加 extensions / market 两键（扩展包页 + 市场页占位）。 */
export const INTEGRATIONS_PAGE_SLOTS = {
  mcp: 'corum.integrations.mcp',
  skills: 'corum.integrations.skills',
  extensions: 'corum.integrations.extensions',
  market: 'corum.integrations.market',
} as const satisfies Record<string, keyof SlotMap>
