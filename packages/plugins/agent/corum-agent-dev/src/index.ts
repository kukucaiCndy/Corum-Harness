/**
 * @corum/corum-agent-dev — corum Agent 实例开发插件。
 *
 * 第一刀目标：补全「真正的 Agent 实例」——AgentProfile 数据模型 + preset 编译 +
 * 创建绑定模型/工具/skill/MCP/终端的 root Agent（路径 A：走官方 preset 组装）。
 *
 * 纯 host 侧插件。CorumAgentService 继承 TypertRemoteService，通过 @Remote
 * 装饰器暴露 /api/corumAgent/* 端点供浏览器半（dev-agent-shell）调用。
 * 设计依据见 docs/agent-foundation/ 与 PRD §4.0.2。
 * @module @corum/corum-agent-dev
 */

import type { Context } from '@deepseek-ai/cordis'
import { CorumAgentService } from './agent-service.ts'

export type * from './profile.ts'
export type { AgentProfile, ProfileModel, ProfileTerminal, ProfileMemoryPolicy, SkillBinding } from './profile.ts'
export { isValidProfileId } from './profile.ts'
export { compilePreset } from './compile.ts'
export type { CompiledPreset } from './compile.ts'
export { CorumAgentService } from './agent-service.ts'
export type { CreateAgentResult, ProfileSummary, AgentStatus, SkillEntry, ProviderCatalog, SessionEventDto, RunPromptResult, SaveProfileInput } from './agent-service.ts'
export { loadProfile, listProfiles, saveProfile, deleteProfile, agentDirPath } from './profile-store.ts'

/** Cordis 插件名。 */
export const name = 'dev-agent'

/** 运行时依赖的服务（boot 后即就绪）。 */
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions']

/** 挂载 CorumAgentService 单例服务。 */
export function apply(ctx: Context): void {
  const service = new CorumAgentService(ctx)
  // 日志验证开关：`CORUM_DEV_AGENT_VERIFY` 任意非空值 → 启动即用内置 smoke-test
  // profile 跑一遍「创建 Agent → followup → 汇总回复」闭环，把结果打到日志。
  // 这是不依赖官方 UI 的最小验证入口（dev-agent combo 启动后即触发）。
  const verifyFlag = process.env.CORUM_DEV_AGENT_VERIFY
  if (verifyFlag !== undefined && verifyFlag !== '') {
    // 等 loader 兄弟挂载完成后再跑，确保 scoped tools/adapters 完整组合。
    void (async () => {
      try {
        await ctx.get('loader')?.await()
      } catch {
        // loader 不存在时直接跑（纯 host 组合无 loader 兄弟）。
      }
      await service.verify()
    })()
  }
}
