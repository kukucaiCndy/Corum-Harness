/**
 * @corum/corum-project-core — corum 项目管理核心（Agent 运行时层）。
 *
 * 在官方 Agent Loop 之外叠加的一层：
 *   - 角色运行时（每角色一个 root Agent）
 *   - 任务队列 + 串行调度 + followup 派活
 *   - complete_task 上报 → taskDone 闭环
 *
 * 纯 host 侧插件，无浏览器半。设计依据见
 * `docs/agent-foundation/AGENT-RUNTIME-CONTEXT-DESIGN.md`。
 * @module @corum/corum-project-core
 */

import type { Context } from '@deepseek-ai/cordis'
import { AgentRuntime } from './runtime.ts'

export type * from './roles.ts'
export type * from './task.ts'
export { ROLE_DEFINITIONS } from './roles.ts'
export { createTask } from './task.ts'
export { AgentRuntime } from './runtime.ts'

/** Cordis 插件名。 */
export const name = 'project-core'

/** 运行时依赖的服务（boot 后即就绪）。 */
export const inject = ['agents', 'agentDefaultModel', 'sessions']

/** 挂载 AgentRuntime 单例服务。 */
export function apply(ctx: Context): void {
  new AgentRuntime(ctx)
}
