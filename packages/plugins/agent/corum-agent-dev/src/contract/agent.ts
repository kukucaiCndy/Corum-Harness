/**
 * corumAgent 跨域 RPC 契约（/api/corumAgent/*）。
 *
 * 给 client 半消费方（conversation / ide-sidebar / agent-ui-dev / team-ui-dev /
 * ide-project-ui）type-only 引用：方法名常量替代裸字符串，args/result 类型
 * 与服务实现（agent-service.ts 的 @Remote 端点）同源——服务端改方法名/参数，
 * 消费方编译期即报错，而非运行时发现。
 *
 * 本文件纯类型 + 字符串常量，无运行时副作用（不 import 服务实现/官方 host 依赖），
 * client 半可安全 type-only 消费。被 @Remote 方法签名改动时必须同步更新。
 * @module @corum/corum-agent-dev/contract
 */

import type { ProfileModel } from '../profile.ts'
import type {
  ProfileSummary,
  AgentStatus,
  ProviderCatalog,
  SessionEventDto,
  RunPromptResult,
  SaveProfileInput,
  TaskAgentSummary,
} from '../agent-service.ts'

// ── 复用的 wire 投影类型（与 agent-service.ts 的 @Remote 返回同源 re-export） ──

export type {
  ProfileSummary,
  AgentStatus,
  ProviderCatalog,
  SessionEventDto,
  RunPromptResult,
  SaveProfileInput,
  TaskAgentSummary,
}

/**
 * corumAgent 被消费方实际调用的 @Remote 方法名常量（wire 值与装饰器字符串一致）。
 * 只覆盖实际被消费的端点，不是全部 @Remote 的完整表。
 */
export const CORUM_AGENT_METHODS = {
  /** 创建/恢复一个 task 会话并返回其 sessionId。 */
  createTaskAgent: 'createTaskAgent',
  /** 列出所有已注册 LLM provider 及其模型目录。 */
  listModels: 'listModels',
  /** 列出可选的访问权限档位（新建任务表单数据源）。 */
  listPermissionPresets: 'listPermissionPresets',
  /** 列出所有 AgentProfile 摘要。 */
  listProfiles: 'listProfiles',
  /** 列出 task 模式会话（侧栏 task 列表数据源）。 */
  listTaskAgents: 'listTaskAgents',
  /** 列出已创建的 Agent 的 profile id。 */
  listAgents: 'listAgents',
  /** 保存（创建或更新）一个 AgentProfile 并编译落盘。 */
  saveProfile: 'saveProfile',
  /** 删除一个 AgentProfile。 */
  deleteProfile: 'deleteProfile',
  /** 创建/恢复指定工作类型泳道的会话。 */
  createAgentForType: 'createAgentForType',
  /** 在泳道会话里发一个 prompt，等回复。 */
  runPromptForType: 'runPromptForType',
  /** 读泳道会话的历史事件。 */
  getSessionEventsForType: 'getSessionEventsForType',
  /** 冒烟测试。 */
  verify: 'verify',
} as const

/** corumAgent 已契约化的方法名（CORUM_AGENT_METHODS 的值联合）。 */
export type CorumAgentMethod = (typeof CORUM_AGENT_METHODS)[keyof typeof CORUM_AGENT_METHODS]

// ── 每端点的 args（命名参数对象）/ result 类型 ─────────────────────────────

/** createTaskAgent 入参：cwd 必填，其余可选（缺省走内置 task profile）。 */
export type CreateTaskAgentArgs = {
  cwd: string
  profileId?: string
  permission?: string
  model?: ProfileModel
}
/** createTaskAgent 返回：新会话 sessionId。 */
export interface CreateTaskAgentResult {
  sessionId: string
}

/** listModels 返回：provider 目录（listModels 失败的 provider 被跳过）。 */
export interface ListModelsResult {
  providers: ProviderCatalog[]
}

/** 一个权限档位选项。 */
export interface PermissionPresetOption {
  id: string
  name: string
  description?: string
}
/** listPermissionPresets 返回：档位表 + 默认档位 id（服务不可用时均为空）。 */
export interface ListPermissionPresetsResult {
  presets: PermissionPresetOption[]
  defaultPreset: string
}

/** listProfiles 返回：全部 AgentProfile 摘要。 */
export interface ListProfilesResult {
  profiles: ProfileSummary[]
}

/** listTaskAgents 入参：可按 cwd 过滤（缺省列出全部 task 会话）。 */
export type ListTaskAgentsArgs = {
  cwd?: string
}
/** listTaskAgents 返回：task 会话摘要表（含存活标记/标题/最后活动时间）。 */
export interface ListTaskAgentsResult {
  tasks: TaskAgentSummary[]
}

/** listAgents 返回：已创建 Agent 的状态表。 */
export interface ListAgentsResult {
  agents: AgentStatus[]
}

/** saveProfile 入参：完整可编辑 profile 表单。 */
export type SaveProfileArgs = {
  input: SaveProfileInput
}
/** saveProfile 返回：保存后的 profile 摘要。 */
export interface SaveProfileResult {
  profile: ProfileSummary
}

/** deleteProfile 入参。 */
export type DeleteProfileArgs = {
  id: string
}

/** createAgentForType 入参：按「项目×角色×类型」寻址（type 缺省默认泳道）。 */
export type CreateAgentForTypeArgs = {
  projectId: string
  profileId: string
  type?: string
}
/** createAgentForType 返回：泳道会话 sessionId + 创建标记。 */
export interface CreateAgentForTypeResult {
  sessionId: string
  created: boolean
}

/** runPromptForType 入参。 */
export type RunPromptForTypeArgs = {
  projectId: string
  profileId: string
  type: string
  prompt: string
}

/** getSessionEventsForType 入参：从 fromSeq 起读。 */
export type GetSessionEventsForTypeArgs = {
  projectId: string
  profileId: string
  type: string
  fromSeq: number
}
/** getSessionEventsForType 返回：事件投影表。 */
export interface GetSessionEventsForTypeResult {
  events: SessionEventDto[]
}

/** verify 返回：冒烟结果（失败不抛错，error 字段带回原因）。 */
export interface VerifyResult {
  ok: boolean
  reply?: string
  error?: string
}

/**
 * corumAgent 端点描述表：方法名 → 命名参数对象 / 返回体。
 * `{}` 表示该端点无参数。供消费方做 type-level 查表（typed caller 的数据源）。
 */
export interface CorumAgentEndpointTable {
  [CORUM_AGENT_METHODS.createTaskAgent]: { args: CreateTaskAgentArgs; result: CreateTaskAgentResult }
  [CORUM_AGENT_METHODS.listModels]: { args: {}; result: ListModelsResult }
  [CORUM_AGENT_METHODS.listPermissionPresets]: { args: {}; result: ListPermissionPresetsResult }
  [CORUM_AGENT_METHODS.listProfiles]: { args: {}; result: ListProfilesResult }
  [CORUM_AGENT_METHODS.listTaskAgents]: { args: ListTaskAgentsArgs; result: ListTaskAgentsResult }
  [CORUM_AGENT_METHODS.listAgents]: { args: {}; result: ListAgentsResult }
  [CORUM_AGENT_METHODS.saveProfile]: { args: SaveProfileArgs; result: SaveProfileResult }
  [CORUM_AGENT_METHODS.deleteProfile]: { args: DeleteProfileArgs; result: void }
  [CORUM_AGENT_METHODS.createAgentForType]: { args: CreateAgentForTypeArgs; result: CreateAgentForTypeResult }
  [CORUM_AGENT_METHODS.runPromptForType]: { args: RunPromptForTypeArgs; result: RunPromptResult }
  [CORUM_AGENT_METHODS.getSessionEventsForType]: { args: GetSessionEventsForTypeArgs; result: GetSessionEventsForTypeResult }
  [CORUM_AGENT_METHODS.verify]: { args: {}; result: VerifyResult }
}
