/**
 * @corum/corum-team-ui-dev — corum 全局团队管理 UI 插件。
 *
 * 团队是「预设 Agent 集合」（部门/模板，见 corum-agent-dev 的 TeamService）。
 * 本插件提供全局团队管理界面：建团队 / 给团队加 Agent / 移除成员 / 删团队。
 * 团队与项目无关——项目组（项目的运行时成员）在项目语境里单独管理。
 *
 * 纯浏览器侧插件（host 半 no-op，团队数据由 corum-agent-dev 的
 * CorumTeamService 提供，经 RPC 桥调用）。
 * @module @corum/corum-team-ui-dev
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis 插件名。 */
export const name = 'dev-team-ui'

/** 运行时依赖的服务（空：纯 UI 插件，所有能力经 RPC 桥调用）。 */
export const inject: string[] = []

/** Host 半 no-op（所有逻辑在 client 半）。 */
export function apply(_ctx: Context): void {
  // The dev-team-ui contributions are browser-only.
}
