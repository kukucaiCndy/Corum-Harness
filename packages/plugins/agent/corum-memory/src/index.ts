/**
 * @corum/corum-memory — corum 通用记忆底座插件（host 半）。
 *
 * 提供 cordis 服务 `memory`（MemoryService，TypertRemoteService），承载事实级
 * 记忆的「组织形式」：写入（重要性门槛 + recency-wins 合并 + 容量治理 + 自动清理）、
 * 读时降权检索（source 等值过滤 + agentId 可见性收紧）、人工修剪（失效标记/重要性
 * 调整/硬删除/批量清空/按来源删除）、批量写入（putFacts）。存储复用官方
 * dsh-storage-domain。
 *
 * 本插件**不绑定任何记忆来源**——「记忆从哪儿来、如何用」由后续使用者决定，
 * 底座只提供能力面（ctx.memory + /api/memory/* RPC）。
 *
 * **设置面**：`corum-memory` settings namespace（见 memory-config.ts）。boot 常驻
 * 注册行在 `settings-registrar.ts`（子路径导出 `./settings-registrar`）。
 *
 * @module @corum/corum-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { MemoryService } from './memory-service.ts'

export { MemoryService } from './memory-service.ts'
export type {
  PutFactInput,
  PutFactResult,
  PutFactRejectedCode,
  SearchFactsInput,
  ListFactsInput,
  MemoryFacet,
} from './memory-service.ts'
export { memoryDomainSpec, memoryFactSchema } from './memory-entities.ts'
export type { MemoryFact, MemoryFactView, MemoryRetention } from './memory-entities.ts'
export {
  expiresAtFor,
  resolveRetentionOnWrite,
  promoteRetentionOnRead,
  isApplicable,
  isRetained,
  effectiveScoreFor,
  scoreMatch,
  toView,
  conflictsToInvalidate,
  READ_PROMOTE_THRESHOLD,
} from './memory-policy.ts'
export type { PolicyOverrides } from './memory-policy.ts'
export {
  CORUM_MEMORY_SETTINGS_NAMESPACE,
  CORUM_MEMORY_SETTINGS_SCHEMA,
  MEMORY_CONFIG_DEFAULTS,
  DECAY_STRENGTH_MULTIPLIER,
  acquireMemorySettingsScope,
  resolveMemoryConfig,
} from './memory-config.ts'
export type {
  CorumMemorySettings,
  ResolvedMemoryConfig,
  DecayStrength,
  OverflowPolicy,
  InjectMode,
} from './memory-config.ts'

/** Cordis 插件名。 */
export const name = 'corum-memory'

/** 运行时依赖：storageDomain（事实持久化）。settings 为可选（拿不到即用内置默认）。 */
export const inject: string[] = ['storageDomain']

/** 挂载 MemoryService 单例服务（幂等：重复 apply 不再注册）。 */
export function apply(ctx: Context): void {
  // 幂等：与 corum-ollama 同款守卫，避免重复 loader 行触发 cordis
  // 「service has been registered」硬错。
  if (ctx.get('memory') === undefined) {
    new MemoryService(ctx)
  }
}
