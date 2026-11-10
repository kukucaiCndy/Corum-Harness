/**
 * @corum/plugin-sdk —— 第三方插件的**客户端半**入口（`@corum/plugin-sdk/client`）。
 *
 * ## 这里为什么是「编译 ESM 库」而不是 `__ModuleLoader__` 闭包
 *
 * 本包**不是**被装载的插件，它是被插件在**构建期 import** 的库。闭包形态（CJS + banner）
 * 是 loader 的装载契约，只能用于最终产物；库形态必须是可被消费者打包器静态分析的 ESM。
 * 插件包自己的 `./client` 才走闭包（`@corum/plugin-build` 的 `clientConfig`）。
 *
 * ## 导出面的取舍
 *
 * 只导出**承诺稳定**的东西：槽注册与查询、布局渲染基件（GridView/RegionCard/MosaicWall）、
 * 路径 helper、RPC 调用。内部层的 35 个包**不**从这里透出 —— 它们随应用发布但不承诺
 * 跨版本兼容（方案 §A.2），透出等于给它们套上 semver 承诺。
 *
 * @module @corum/plugin-sdk/client
 */

import type { Context } from '@deepseek-ai/cordis'

export type { Context } from '@deepseek-ai/cordis'

// ── 槽与布局（来自 @corum/corum-ui-base 的客户端半） ─────────────────────────
export {
  registerSlot,
  getSlotMeta,
  getAllRegisteredSlots,
  drainPendingSlots,
  GridView,
  RegionCard,
  FloatingLayer,
  useFloatingLayer,
  MosaicWall,
  MosaicTileBody,
  useMosaicColumns,
  buildMosaic,
  ThemePresenter,
  joinPath,
  basenameOf,
  shortenPath,
} from '@corum/corum-ui-base/client'
export type {
  SlotMeta,
  SlotRegistryFace,
  GridNode,
  GridViewProps,
  RegionCardProps,
  FloatingLayerApi,
  MosaicSize,
  MosaicItemHint,
  MosaicTint,
  MosaicWallProps,
} from '@corum/corum-ui-base/client'

// ── 会话资源（第三方读「当前会话发生了什么」）─────────────────────────────────
export { readSessionFacts } from './session-facts.ts'
export type {
  ReadSessionFactsArgs,
  SessionFactsContext,
  SessionFactsSnapshot,
  SessionFactsStats,
  SessionFactsSubagent,
  SessionFactsTokens,
} from './session-facts.ts'

// ── RPC（来自 @corum/corum-rpc-client 的客户端半） ───────────────────────────
export { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
export type { CorumRpcCall } from '@corum/corum-rpc-client/client'

// ── 活动栏入口注册（注册驱动 UI） ─────────────────────────────────────────────
// 第三方插件通过 ctx.get('layout') 拿到壳层的 LayoutController 服务，
// 调 registerActivityItem 注册自己的活动栏入口。卸载时 effect cleanup
// 反注册 → 图标自然消失（不再硬编码在壳层）。
import type React from 'react'

/**
 * 一个活动栏入口：图标 + 标题 + 点击行为。
 *
 * 注册方通过 `ctx.get('layout').registerActivityItem(item)` 注册，
 * 返回反注册函数（在 effect cleanup 里调）。
 *
 * - `group: 'nav'` = 主导航组（任务/项目/搜索所在组）；
 * - `group: 'tools'` = 底部工具组（集成中心/测试中心所在组）。
 * - `exclusive: true` = 全屏独占工作面（同一时刻只有一个 exclusive 入口激活）。
 * - `active` 是函数（非布尔值）：每次渲染时调用取最新值（依赖运行时状态）。
 *
 * @example
 * ```ts
 * import { defineClientPlugin, type ActivityItem } from '@corum/plugin-sdk/client'
 * import { FlaskConical } from 'lucide-react'
 *
 * export const inject = ['layout']
 * export function apply(ctx) {
 *   ctx.effect(() => ctx.get('layout').registerActivityItem({
 *     id: 'my-plugin',
 *     order: 110,
 *     group: 'tools',
 *     title: '我的插件',
 *     ariaLabel: '我的插件工作面',
 *     icon: FlaskConical,
 *     onClick: () => { /* 打开工作面 *\/ },
 *     active: () => { /* 返回当前是否激活 *\/ },
 *     exclusive: true,
 *   }))
 * }
 * ```
 */
export interface ActivityItem {
  /** 全局唯一 id（注册方保证；用于反注册与互斥管理）。 */
  readonly id: string
  /** 排序权重（升序；壳内置入口 0-99，扩展包入口 100+）。 */
  readonly order: number
  /** 分组：`'nav'` = 主导航组，`'tools'` = 底部工具组。 */
  readonly group: 'nav' | 'tools'
  /** 鼠标悬浮文案（激活态由壳层追加「点此收起」后缀）。 */
  readonly title: string
  /** aria-label（无障碍）。 */
  readonly ariaLabel: string
  /** 图标组件（lucide 图标或其他 React 组件，以 `<Icon size={20} />` 渲染）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly icon: React.ComponentType<any>
  /** 点击行为（注册方自行实现打开/关闭逻辑）。 */
  readonly onClick: () => void
  /**
   * 是否当前激活（壳层据此渲染 active 态）。
   * **函数**（非布尔值）：每次渲染时调用取最新值。
   */
  readonly active: () => boolean
  /**
   * 是否全屏独占工作面。`true` 时壳层保证同一时刻只有一个 exclusive 入口激活。
   * `false`（默认）= 侧栏类入口（不参与互斥）。
   */
  readonly exclusive?: boolean
  /** 社区版锁角标（付费入口用）。 */
  readonly locked?: boolean
}

/**
 * Layout 服务的活动栏能力面（局部能力接口，红线 3）。
 * 第三方插件经 `ctx.get('layout')` 取到完整 LayoutController，
 * 用这个窄面只声明自己需要的方法。
 */
export interface LayoutActivityFace {
  /** 注册一个活动栏入口，返回反注册函数。 */
  registerActivityItem(item: ActivityItem): () => void
}

/**
 * 客户端插件的入口契约。
 *
 * 与 host 半的区别只有一处、但很重要：**没有 config**。客户端半的配置随 `dsh.client`
 * 清单走（`platform` / `inject` / `immediately` / `external`），不进 `apply` 的参数。
 */
export interface ClientPlugin {
  /** 依赖的服务名（客户端服务，如 `slots` / `layout`）。 */
  inject: string[]
  /** 装配函数。作用域是浏览器上下文。 */
  apply(ctx: Context): void
}

/**
 * 定义一个客户端插件。
 *
 * ```ts
 * import { defineClientPlugin, registerSlot, RegionCard } from '@corum/plugin-sdk/client'
 *
 * export const inject = ['slots']          // 清单里也要写同样的 inject
 * export function apply(ctx: Context) { … }
 * ```
 *
 * 注意：客户端半的 `dsh.client` 清单字段**不在**这个 helper 里，它属于 `package.json`
 * （`packages/plugin-build` 与规范 §1 管这一段），运行期拿不到也不该拿。
 */
export function defineClientPlugin(plugin: ClientPlugin): ClientPlugin {
  return plugin
}
