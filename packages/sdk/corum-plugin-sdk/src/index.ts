/**
 * @corum/plugin-sdk —— 第三方插件的**宿主半**入口。
 *
 * ## 存在的理由：把「8 个包」收敛成 1 个
 *
 * 写一个 corum 插件原本要知道：cordis 的 `Context`、dsh 的 slot 类型、ui-base 的槽注册、
 * rpc-client 的 RPC 调用、plugin-build 的构建契约……其中一半是**类型**（编译后被擦除），
 * 另一半是**薄 helper**。把它们摊给第三方，等于让每个插件作者的依赖面都跟着 corum 内部
 * 重构漂移。这里只做一件事：**把稳定面聚合起来**。
 *
 * ## 零运行时逻辑（这是硬约束，不是口号）
 *
 * 本包不持有状态、不注册服务、不做 IO。它 re-export 的都是别处已经存在的东西 —— 唯一的
 * 「逻辑」是 `definePlugin` 的恒等返回（收窄类型 + 一处写清字段语义）。一旦这里长出
 * 运行期行为，它就会变成一个**新的宿主契约**，而那正是方案 §A.2 想避免的。
 *
 * ## 依赖位置（最容易踩的一脚）
 *
 * 第三方插件必须把本包写进 `dependencies`，**不能**写 `peerDependencies`：
 * 宿主只把 corum-desktop 的安装闭包链进 profile（`healProfilesModuleFallbackRegistry`），
 * profile 里没有 npmrc、不保证 auto-install-peers ⇒ peer 形态会在装载时
 * `ERR_MODULE_NOT_FOUND`（方案 §A.2 评审 C-2b 的结论）。
 *
 * @module @corum/plugin-sdk
 */

import type { Context } from '@deepseek-ai/cordis'

export type { Context } from '@deepseek-ai/cordis'

/**
 * 宿主插件的入口契约（cordis 三形态里的「object 形态」）。
 *
 * 与官方 `@deepseek-ai/dsh-*` 包一致：`name` / `inject` / `apply` / 可选 `Config`。
 * 之所以要有 `name`：cordis 用它给服务与日志打标；与包名不一致会让「哪个包装的」
 * 这条最基本的排障线索失效（红线：包名与服务名语义关联）。
 */
export interface HostPlugin<Config = void> {
  /** 插件名（kebab-case，与包名后缀一致）。 */
  name?: string
  /** 依赖的 cordis 服务名；空数组表示无依赖。 */
  inject: string[]
  /** 装配函数。**不要在模块作用域做副作用** —— cordis 会多次 reload。 */
  apply(ctx: Context, config: Config): void
  /** schemastery 配置 schema（可选）。 */
  Config?: unknown
}

/**
 * 定义一个宿主插件。恒等返回，只为**类型收窄 + 字段语义集中在一处**。
 *
 * ```ts
 * import { definePlugin } from '@corum/plugin-sdk'
 *
 * export default definePlugin({
 *   name: 'my-plugin',
 *   inject: ['tools'],
 *   apply(ctx) { /* … *\/ },
 * })
 * ```
 */
export function definePlugin<Config = void>(plugin: HostPlugin<Config>): HostPlugin<Config> {
  return plugin
}

// ── 会话资源契约（类型与读取 helper 的单一家；corum-platform 反向 import 这里） ──
export { readSessionFacts } from './session-facts.ts'
export type {
  ReadSessionFactsArgs,
  SessionFactsContext,
  SessionFactsSnapshot,
  SessionFactsStats,
  SessionFactsSubagent,
  SessionFactsTokens,
} from './session-facts.ts'

// ── CDP 目标配置（所有 CDP 类插件共有的领域知识，不许各自再复制一份）──────────
export {
  CDP_TARGETS_FILENAME,
  CDP_TARGETS_VERSION,
  CdpTargetsConfigError,
  MAIN_INSTANCE_PORT,
  TARGET_ID_PATTERN,
  disabledReason,
  isMainInstancePort,
  resolveCdpTargetsPath,
  sampleCdpTargetsConfig,
  validateCdpTargetsConfig,
} from './cdp-targets.ts'
export type { CdpTarget, CdpTargetsConfig } from './cdp-targets.ts'

// ── 工具注入（第三方插件让 Agent「真的能用它」）────────────────────────────────
export { defineAgentTool, registerAgentTool } from './tools.ts'
export type { ToolsFace } from './tools.ts'
export type { ToolDefinition } from './tools.ts'
