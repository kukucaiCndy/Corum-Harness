/**
 * @corum/corum-agent — corum Agent 实例开发插件。
 *
 * 第一刀目标：补全「真正的 Agent 实例」——AgentProfile 数据模型 + preset 编译 +
 * 创建绑定模型/工具/skill/MCP/终端的 root Agent（路径 A：走官方 preset 组装）。
 *
 * 纯 host 侧插件。CorumAgentService 继承 TypertRemoteService，通过 @Remote
 * 装饰器暴露 /api/corumAgent/* 端点供浏览器半（IDE shell）调用。
 * 设计依据见 docs/agent-foundation/ 与 PRD §4.0.2。
 * @module @corum/corum-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { setStallAutoRecoverMinutes } from './runtime-state.ts'
import { CorumAgentService } from './agent-service.ts'
import { CorumTeamService } from './team-service.ts'
import { migrateSessionIndex } from './session-index-migration.ts'

export type * from './profile.ts'
export type { AgentProfile, ProfileModel, ProfileTerminal, ProfileMemoryPolicy, SkillBinding } from './profile.ts'
export { isValidProfileId } from './profile.ts'
export { compilePreset } from './compile.ts'
export type { CompiledPreset } from './compile.ts'
export { CorumAgentService } from './agent-service.ts'
export type { AgentLaneDescriptor, CreateAgentResult, ProfileSummary, AgentStatus, SkillEntry, ProviderCatalog, SessionEventDto, RunPromptResult, SaveProfileInput, TaskAgentSummary } from './agent-service.ts'
export { ensureTaskProfile, ensurePmProfile, PM_PROFILE_ID, simplifyEventData } from './agent-service.ts'
// 项目模式剥离（2026-09-26）：上面这一行补出的 `ensurePmProfile` / `PM_PROFILE_ID` /
// `simplifyEventData` 供闭源仓 `@corum/corum-project` 消费（项目组的默认 PM 播种 +
// 事件投影）。它们本来就是 agent-service 的再导出面（`export { … } from`），
// 这里只是把它接到包根——不再由 project-service / runtime 这两个已迁出的消费方间接转发。
export { loadProfile, listProfiles, saveProfile, deleteProfile, agentDirPath } from './profile-store.ts'
// 团队（CorumTeam 实体 + 团队服务）——项目模式用它组项目组，故必须暴露给闭源仓。
export type { CorumTeam } from './team.ts'
export { isValidTeamId, slugifyTeamId } from './team.ts'
export { loadTeam, listTeams, saveTeam, deleteTeam, teamsRoot, teamDir } from './team-store.ts'
export { CorumTeamService } from './team-service.ts'
// 工作区 AGENTS.md 的幂等创建（项目打开时用；项目模式剥离后由闭源仓消费，
// 故必须在包根导出面上）。
export { ensureWorkspaceAgentsMd } from './workspace-agents.ts'
export { migrateSessionIndex } from './session-index-migration.ts'
export type { SessionIndexMigrationResult } from './session-index-migration.ts'
// 全局 KV 的 JSON → SQLite 存量迁移（用户 2026-09-15 决定；桌面壳在 boot() 之前调用）。
export { migrateKvStore, migrateKvStoreAtBoot, kvDatabasePath, storagesRoot } from './kv-store-migration.ts'
export type { KvMigrationResult, KvUnitMigrationOutcome } from './kv-store-migration.ts'
// 统一会话索引（两模式共用账本）+ 工作区身份/类型助手——供监控脚本与
// 外部核验直接消费（不依赖 host 运行时装配）。
export {
  corumHome, findSession, findSessionByLane, listSessionsForWorkspace,
  readSessionIndex, registerSession, sessionIndexPath, unregisterSession, writeSessionIndex,
} from './session-index.ts'
export type { SessionIndexEntry } from './session-index.ts'
export { readLegacyIndexes, parseProjectSessionId } from './legacy-index.ts'
export type { LegacySession } from './legacy-index.ts'
// ── 工作区身份 / 类型（L0·L1 助手）────────────────────────────────────
// 2026-09-26 项目模式剥离：这两组符号原在 `project.ts`（已移出闭源仓），
// 但**任务模式也在用**（统一索引分区、task↔project 互斥门禁、泳道 slug），
// 故沉淀为开源侧助手模块；闭源仓在 `src/shared/` 持同名副本。
export {
  canonicalWorkspaceKey, isValidProjectId, slugifyProjectId, writeJsonAtomic,
  workspaceIndexRoot, findWorkspaceEntryByCwd, workspaceEntryTypeOf,
} from './workspace-identity.ts'
export type { WorkspaceIndexEntry } from './workspace-identity.ts'
export {
  PROJECT_TYPES, DEFAULT_PROJECT_TYPE, BUILTIN_WORK_TYPES, GENERAL_WORK_TYPE,
  isProjectType, projectTypeOf, classifyProjectTypeTransition, canTransitionProjectType,
  isValidWorkTypeSlug, resolveWorkTypes,
} from './workspace-type.ts'
export type { ProjectType, WorkType } from './workspace-type.ts'

/** Cordis 插件名。 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { describeSuspiciousYamlKeys, scanSuspiciousYamlKeys } from './settings-yaml-guard.ts'

export const name = 'agent'

/** 运行时依赖的服务（boot 后即就绪；gitCore = 不变式①创建前置门禁，git-core 核心插件）。 */
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'storageDomain', 'sessionPersistence', 'systemPrompt', 'gitCore']

/**
 * `corum-agent` settings namespace（C4：卡住自动恢复阈值可配置）。
 *
 * 默认 10 分钟（bash 工具 300s 超时 + 模型恢复余量），范围 1–120 分钟。
 * 项目制扫描与 task 泳道共用这一个值（见 runtime-state.ts 的 holder）。
 */
export const CORUM_AGENT_SETTINGS_NAMESPACE = 'corum-agent'

/** 设置形。 */
export interface CorumAgentSettings {
  /** 执行中任务无活动多久后主动恢复（分钟）。 */
  readonly stallRecoverMinutes?: number
}

/** 默认值（分钟），与 STALL_AUTO_RECOVER_MS_DEFAULT 同源。 */
export const STALL_RECOVER_MINUTES_DEFAULT = 10

const CORUM_AGENT_SETTINGS_SCHEMA = z.object({
  stallRecoverMinutes: z.number().default(STALL_RECOVER_MINUTES_DEFAULT),
})

/**
 * 挂载 CorumAgentService + CorumTeamService 单例服务。
 *
 * 项目模式剥离（2026-09-26）：`CorumProjectService` / `CorumProjectDataService` /
 * `AgentRuntime`（团队调度）已随项目模式迁到闭源仓 Corum-Harness-Project 的
 * `@corum/corum-project`，由那个插件在自己的 `apply()` 里挂载（mount 点在
 * `packages/desktop/cordis.ide.patch.yml` 的 project 段）。本插件只留任务模式面。
 */
export function apply(ctx: Context): void {
  runSettingsYamlGuard(ctx)
  // settings namespace 注册 + 订阅：settings 服务在 boot 早期可能尚未挂载（与
  // corum-review / corum-git 同款短轮询），拿到后注册并 watch，实时更新阈值。
  const registerSettings = (): boolean => {
    const settings = ctx.get('settings') as
      | { register: (ns: unknown, schema: unknown) => { get: () => unknown; watch: (cb: (next: unknown) => void) => () => void } }
      | undefined
    if (settings === undefined) return false
    const scope = settings.register(CORUM_AGENT_SETTINGS_NAMESPACE, CORUM_AGENT_SETTINGS_SCHEMA) as
      { get: () => CorumAgentSettings; watch: (cb: (next: CorumAgentSettings) => void) => () => void }
    const adopt = (value: CorumAgentSettings): void => {
      setStallAutoRecoverMinutes(value?.stallRecoverMinutes ?? STALL_RECOVER_MINUTES_DEFAULT)
    }
    adopt(scope.get())
    scope.watch(adopt)
    ctx.logger.info('corum-agent namespace registered')
    return true
  }
  if (!registerSettings()) {
    const poll = setInterval(() => {
      try { if (registerSettings()) clearInterval(poll) } catch (error) {
        ctx.logger.warn(`corum-agent settings register failed: ${String(error)}`)
      }
    }, 100)
    setTimeout(() => clearInterval(poll), 15000)
  }

  const service = new CorumAgentService(ctx)
  // 项目模式剥离（2026-09-26）：`migrateProjectStore`（「项目数据跟随项目走」）与
  // `migrateProjectData`（四表存量迁移）已随项目模式迁到闭源仓
  // Corum-Harness-Project 的 `@corum/corum-project`，在它的 `apply()` 里以同一
  // 非阻断 try/catch 形态执行。
  //
  // ⚠️ **顺序要求**（闭源仓 boot 契约）：那两个迁移会收敛项目条目的 cwd 形态，
  // 而下面的 `migrateSessionIndex` 依赖它读出的 cwd 判定工作区身份。故闭源插件
  // 必须在本插件**之前**装配（`cordis.ide.patch.yml` 的插入序即够），否则首跑
  // 那次迁移的会话索引可能读到未收敛的 cwd。
  // 统一会话索引迁移（2026-09-15）：两套异构旧索引 → $CORUM_HOME/sessions.json
  // （键 = sessionId）。幂等可重跑；死条目按用户裁定直接丢弃（计数进日志）。
  // 放在 project-store 迁移之后：后者会收敛项目条目的 cwd 形态，本迁移依赖它
  // 读出的 cwd 判定工作区身份。非阻断。
  try {
    const si = migrateSessionIndex(msg => ctx.logger.info(msg))
    ctx.logger.info(
      `corum-agent: session-index migration done — task=${si.fromTaskIndex} project=${si.fromProjectIndex} `
      + `dropped[cwd-gone=${si.droppedCwdGone} body-missing=${si.droppedBodyMissing} malformed=${si.droppedMalformed}] `
      + `total=${si.total} backup=${si.backupDir ?? 'none'}`,
    )
  } catch (error) {
    ctx.logger.error(`corum-agent: session-index migration failed (非阻断): ${String(error)}`)
  }
  new CorumTeamService(ctx)
  // 日志验证开关：`CORUM_DEV_AGENT_VERIFY` 任意非空值 → 启动即用内置 smoke-test
  // profile 跑一遍「创建 Agent → followup → 汇总回复」闭环，把结果打到日志。
  // 这是不依赖官方 UI 的最小验证入口（coding combo 启动后即触发）。
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

/**
 * fork（corum）：启动时预检 `settings.yaml` 的**布尔键**并**大声告警**（2026-09-15 真实故障的防线）。
 *
 * 为什么必须做在这里：段被自己的键写坏后，报错是「**settings namespace <ns> is not registered**」，
 * 完全不指向那个非法键 —— 实测让我先逐项排除了 7 个结构层假设（装配/版本/解析/竞态/overlay…）
 * 才回头怀疑用户数据。这一行日志把「半小时的排查」变成「一眼看到」。
 *
 * 纪律：**只读不写** —— 不擅自改用户数据；只把「哪个文件哪一行的哪个键、为什么炸、怎么改」说清。
 */
function runSettingsYamlGuard(ctx: Context): void {
  try {
    const home = resolveDshHome()
    if (home === undefined) return
    const file = join(home, 'settings.yaml')
    if (!existsSync(file)) return
    const hits = scanSuspiciousYamlKeys(readFileSync(file, 'utf8'))
    if (hits.length === 0) return
    // 用 error 级：这不是噪声，是「你的设置里有东西会让整段失效」。
    ctx.logger.error(describeSuspiciousYamlKeys(file, hits))
  } catch (error: unknown) {
    // 预检自身绝不阻断启动（它是增强观测，不是启动前提）。
    ctx.logger.warn(`settings-yaml-guard skipped: ${String(error)}`)
  }
}
