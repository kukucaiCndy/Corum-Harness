/**
 * @corum/corum-ide-integrations-ui client half —— 集成中心 ·「插件」内容页
 * （design.pen yXkOK F1；PR5）。
 *
 * 交付物 = 一个**可注册的 React 页面组件** `PluginsPage`（GPT 式插件市场 +
 * 已装管理），本文件只负责把它挂到集成中心的父槽上。
 *
 * ## 边界（PR4 / PR5 分工）
 * 集成中心的**骨架**——活动栏「插件」图标点亮、全屏独占工作面、面板头（标题
 * 「集成中心」+ × 关闭）、左侧子导航（插件 / MCP 服务器 / 技能）、以及**父槽
 * 的声明**——全部属 PR4，不在本包范围内。本包只交付内容页 + 包骨架。
 *
 * ## 挂载（PR4 已落地 ⇒ 本包 apply 是 live 代码）
 * 父槽名 `corum.integrations.plugins` 现由**集成中心骨架包**
 * `@corum/corum-ide-ui` 声明（它的 `src/client/index.tsx` 在 SlotMap 与 root
 * 条目的 children 表两处登记同键），本包是它的 occupant。apply 里那段注入
 * 从注释转正：`ctx.slots.inject(父槽, …)` 保证「声明先于注册」的时序。
 *
 * ## 不在此声明 SlotMap 的原因（有意为之）
 * 槽契约（`declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }`）
 * 由**声明方**（骨架包）登记：SlotMap 的同一个键在两处声明且 `owner` 类型
 * 不同是编译错（TS2717），本包抢先登记会与骨架撞键。PR4 落地后本包改为一行
 * type-only 消费（`import type {} from '@corum/corum-ide-ui/client'`）把键与
 * owner 面拉进本包的类型作用域——与 `corum-ide-panel-bottom-ui` 挂
 * `corum.panel` 同法。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: 拉入骨架包声明的三个 `corum.integrations.*` SlotMap 键 + owner 面。
import type {} from '@corum/corum-ide-ui/client'
import { makeCorumRpcCall, type CorumRpcCall } from '@corum/corum-rpc-client/client'
import { registerSlot } from '@corum/corum-ui-base/client'
import { PluginsPage } from './PluginsPage.tsx'

// 页面本体的对外出口：挂载点（PR4 的骨架，或后续直接渲染本页的组合）从
// `@corum/corum-ide-integrations-ui/client` 取组件与它的 props 类型。
export { PluginsPage }
export type { PluginsPageProps, InstalledEntry, SearchResult } from './PluginsPage.tsx'

/**
 * 集成中心「插件」内容页的槽 key（与骨架 `@corum/corum-ide-ui` 声明的父槽同键）。
 *
 * 命名空间 `corum.integrations.*` 是集成中心的内容页槽域：`plugins`（本页）/
 * `mcp` / `skills`。
 *
 * `satisfies` 把本常量锚到骨架登记的 SlotMap 键域（B2 同款纪律：拼错/骨架改键
 * 即编译错，而不是运行时静默不挂载）。
 */
export const INTEGRATIONS_PLUGINS_SLOT = 'corum.integrations.plugins' satisfies keyof SlotMap

/** 本页的注入面（父槽 occupant 注册时随 register 的 `inject` 面下发）。 */
export interface PluginsPageInjected {
  /** `pluginManager` 命名空间的 RPC caller（见 makePluginManagerCaller）。 */
  callRemote: <T>(method: string, args: Record<string, unknown>) => Promise<T>
  /**
   * 通用 corum RPC caller（P5d provenance + locked uninstall）。
   * 用于调 `extensionManager/ownership` + `extensionManager/list` 取归属台账；
   * RPC 不可用时页面 fail-soft 为空归属（行为与未接入 P5d 一致）。
   */
  rpc: CorumRpcCall
}

/** Required services: the slots registry + the official connection rpc face. */
export const inject = ['slots', 'connection']

/**
 * 构造 `pluginManager` 命名空间的 RPC caller。
 *
 * 走官方 `connection.rpc.call('/api', 'pluginManager/<method>', { args })`
 * （0.1.2 起取代旧 host-apiproxy 桥），与 host 侧实现
 * （packages/desktop/src/host/plugin-manager.ts 的 `@Remote('方法名')`）一一对应：
 * `list` / `detail` / `setEnabled` / `install` / `uninstall` / `update` / `search`。
 *
 * @param connection - 官方 connection 服务句柄（client index 的 apply 取）。
 */
export function makePluginManagerCaller(connection: ConnectionHandle) {
  return async function callRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const result = await connection.rpc.call('/api', `pluginManager/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

/**
 * Client plugin body：自声明页面槽（C1），并把 PluginsPage 挂进集成中心的父槽。
 *
 * 挂载走官方 `ctx.slots.inject`（同 @corum/corum-ide-panel-bottom-ui 挂
 * corum.panel）：父槽声明就绪 → 回调触发 → slots.register 把页面组件 + 注入面
 * （callRemote）塞进 occupant 位；骨架被裁掉的发行版里父槽不存在 ⇒ 本包什么都不
 * 做（不误注册、不白屏）。`ctx.effect` 的 disposer 在插件卸载时摘除 occupant。
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // ── C1 插件自声明槽 ────────────────────────────────────────────────────
  // 本页不是网格区域（集成中心是全屏独占工作面），故 visibility 'hidden'：
  // 注册表只记录，不进「添加区域」/视图管理清单。
  registerSlot(INTEGRATIONS_PLUGINS_SLOT, {
    label: '插件',
    defaultWeight: 400,
    visibility: 'hidden',
  })

  // ── 槽注入：挂进集成中心骨架声明的父槽 ─────────────────────────────────
  const connection = ctx.get('connection') as ConnectionHandle
  const callRemote = makePluginManagerCaller(connection)
  const rpc = makeCorumRpcCall(connection)
  ctx.effect(() => ctx.slots.inject(INTEGRATIONS_PLUGINS_SLOT, () => ctx.slots.register(
    {
      name: INTEGRATIONS_PLUGINS_SLOT,
      inject: (): PluginsPageInjected => ({ callRemote, rpc }),
    },
    PluginsPage,
  )), 'ide-integrations: 集成中心「插件」页')
}
