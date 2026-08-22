/**
 * @corum/dev-agent-shell — corum Agent 开发验证 UI 壳。
 *
 * 基于 shell-base 的最小 UI 壳，为 dev-agent combo 提供测试交互界面。
 * 注册一个 root 槽 + 一个 dev.agent.test 槽，填充 AgentTestPanel 组件
 * 让用户验证 CorumAgentService 的 listProfiles / createAgent / runPrompt / verify。
 *
 * 纯浏览器侧插件（host 半 no-op）。
 * @module @corum/dev-agent-shell
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis 插件名。 */
export const name = 'dev-agent-shell'

/** 运行时依赖的服务（空：纯 UI 插件，所有能力经 RPC 桥调用）。 */
export const inject: string[] = []

/** Host 半 no-op（所有逻辑在 client 半）。 */
export function apply(_ctx: Context): void {
  // The dev-agent-shell contributions are browser-only.
}
