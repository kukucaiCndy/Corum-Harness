/**
 * @corum/dev-agent — corum Agent 实例开发插件。
 *
 * 第一刀目标：补全「真正的 Agent 实例」——AgentProfile 数据模型 + preset 编译 +
 * 创建绑定模型/工具/skill/MCP/终端的 root Agent（路径 A：走官方 preset 组装）。
 *
 * 纯 host 侧插件（client 设置界面 + 对话框在后续增量接入）。
 * 设计依据见 docs/agent-foundation/ 与 PRD §4.0.2。
 * @module @corum/dev-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { DevAgentService } from './agent-service.ts'

export type * from './profile.ts'
export { isValidProfileId } from './profile.ts'
export { loadProfile, listProfiles, saveProfile, deleteProfile } from './profile-store.ts'
export { compilePreset } from './compile.ts'
export type { CompiledPreset } from './compile.ts'
export { DevAgentService } from './agent-service.ts'
export type { CreateAgentResult } from './agent-service.ts'

/** Cordis 插件名。 */
export const name = 'dev-agent'

/** 运行时依赖的服务（boot 后即就绪）。 */
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions']

/** 挂载 DevAgentService 单例服务。 */
export function apply(ctx: Context): void {
  new DevAgentService(ctx)
}
