/**
 * corumAgent 跨域 RPC 契约（/api/corumAgent/*）。
 *
 * 给 client 半消费方（conversation / ide-sidebar / agent-ui-dev / team-ui-dev）
 * type-only 引用：方法名常量替代裸字符串，args/result 类型与服务实现
 * （agent-service.ts 的 @Remote 端点）同源——服务端改方法名/参数，
 * 消费方编译期即报错，而非运行时发现。
 *
 * 本文件纯类型 + 字符串常量，无运行时副作用（不 import 服务实现/官方 host 依赖），
 * client 半可安全 type-only 消费。被 @Remote 方法签名改动时必须同步更新。
 * @module @corum/corum-agent/contract
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
  /** 分叉一个 task 泳道会话（corum 自有实现，绕开官方 preset 解析）。 */
  forkTaskAgent: 'forkTaskAgent',
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
  /** 读取润色配置。 */
  getPolishConfig: 'getPolishConfig',
  /** 保存润色配置。 */
  setPolishConfig: 'setPolishConfig',
  /** 润色一段提示词。 */
  polishPrompt: 'polishPrompt',
  /** 会话内提示词润色（结合对话上下文，意图自动判断）。 */
  polishConversation: 'polishConversation',
  /** 中英文互译。 */
  translatePrompt: 'translatePrompt',
  /** 冒烟测试。 */
  verify: 'verify',
  /** 启动手动经验沉淀（异步 jobId 模式）。 */
  distillStart: 'distillStart',
  /** 查询沉淀任务状态/进度。 */
  distillStatus: 'distillStatus',
  /** 取消沉淀任务。 */
  distillCancel: 'distillCancel',
  /** 确认写入候选经验（用户取舍后落记忆）。 */
  distillCommit: 'distillCommit',
  /** 丢弃候选经验（不写入记忆）。 */
  distillDiscard: 'distillDiscard',
  /** 回放会话消息（供用户在确认前查看原文）。 */
  distillReplay: 'distillReplay',
  /** 列出含待确认候选的沉淀任务（从磁盘恢复）。 */
  distillListPending: 'distillListPending',
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

/** listProfiles 返回：全部 AgentProfile 摘要 + 已配置的默认预设 id（缺省 undefined）。 */
export interface ListProfilesResult {
  profiles: ProfileSummary[]
  /** `agent-presets.default` settings 解析出的默认 task 预设 id（未配置时 undefined）。
   *  供空态新建任务表单初始化 Agent 下拉的默认选中值——host 侧读 settings 热更新生效。 */
  defaultProfileId?: string
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

// 项目模式剥离（2026-09-26）：project-lane 端点的 args/result
// （CreateAgentForTypeArgs / CreateAgentForTypeResult / RunPromptForTypeArgs /
// GetSessionEventsForTypeArgs / GetSessionEventsForTypeResult）已随
// createAgentForType / runPromptForType / getSessionEventsForType 三个 @Remote
// 迁到闭源仓 Corum-Harness-Project 的 `@corum/corum-project/contract`
// ——它们只被这三个已移动的 RPC 消费，本契约不再声明。

/** verify 返回：冒烟结果（失败不抛错，error 字段带回原因）。 */
export interface VerifyResult {
  ok: boolean
  reply?: string
  error?: string
}

// ── 经验沉淀的 wire 类型（照 artgen/ollama 的 start/status 拆分）──────────────

/** distill 任务状态。 */
export type DistillJobStatus = 'running' | 'done' | 'error' | 'cancelled'

/**
 * 候选事实：LLM 提炼产出但**未经用户确认**的经验条目。
 *
 * - `state='pending'`：等待用户取舍（commit 写记忆 / discard 丢弃）。
 * - `state='committed'`：已经 `distillCommit` 写入记忆底座（幂等：重复 commit 不重写）。
 * - `state='discarded'`：已经 `distillDiscard` 标记为丢弃。
 */
export interface DistillCandidate {
  id: string
  fact: string
  importance: number
  retention: 'temporary' | 'short' | 'long' | 'permanent'
  state: 'pending' | 'committed' | 'discarded'
}

/** distill 任务进度/结果（distillStatus 返回）。 */
export interface DistillJob {
  jobId: string
  status: DistillJobStatus
  /**
   * 产出的候选条数（完成时为最终值）。
   *
   * 注意：这是**候选数**，不是已写入记忆的条数——候选经 `distillCommit` 确认后才落记忆。
   * 通知侧判 `factCount === 0` 不提示（语义不变：0 条候选 = 无可沉淀内容）。
   */
  factCount: number
  /** 当前阶段描述（running 时给 UI 显示）。 */
  phase: string
  /** 失败原因（status='error' 时）。 */
  error?: string
  /** 关联的会话 id（通知跳转/记忆页用）。 */
  sessionId: string
  /** 候选事实列表（status='done' 时填充；含 pending/committed/discarded 全状态）。 */
  candidates?: DistillCandidate[]
  /** 来源：`'auto'` 自动沉淀 / `'manual'` 手动触发。 */
  origin?: 'auto' | 'manual'
}

/** distillStart 入参：对哪棵会话树做沉淀。 */
export type DistillStartArgs = {
  sessionId: string
}
/** distillStart 返回：jobId。 */
export interface DistillStartResult {
  jobId: string
}

/** distillStatus 入参。 */
export type DistillStatusArgs = {
  jobId: string
}

/** distillCancel 入参。 */
export type DistillCancelArgs = {
  jobId: string
}
/** distillCancel 返回。 */
export interface DistillCancelResult {
  cancelled: boolean
}

// ── 候选取舍（commit / discard / replay / listPending）──────────────────────

/** distillCommit 入参的单条编辑项（用户可在确认前编辑 fact/importance/retention）。 */
export interface DistillCommitItem {
  id: string
  fact: string
  importance: number
  retention: 'temporary' | 'short' | 'long' | 'permanent'
}
/** distillCommit 入参：确认写入哪些候选。 */
export type DistillCommitArgs = {
  jobId: string
  items: readonly DistillCommitItem[]
}
/** distillCommit 返回：成功写入条数 / 失败条数（单条失败不中断）。 */
export interface DistillCommitResult {
  written: number
  failed: number
}

/** distillDiscard 入参：丢弃哪些候选（不传 candidateIds = 全部 pending）。 */
export type DistillDiscardArgs = {
  jobId: string
  candidateIds?: readonly string[]
}
/** distillDiscard 返回：被标记为 discarded 的条数。 */
export interface DistillDiscardResult {
  discarded: number
}

/** distillReplay 入参：回放哪棵会话树。 */
export type DistillReplayArgs = {
  sessionId: string
}
/** distillReplay 返回的单条消息。 */
export interface DistillReplayMessage {
  role: 'user' | 'assistant'
  text: string
  seq: number
}
/** distillReplay 返回：最近 500 条 user/assistant 非空文本消息。 */
export interface DistillReplayResult {
  messages: readonly DistillReplayMessage[]
}

/** distillListPending 返回：含 pending 候选的 job（新→旧，上限 20）。 */
export interface DistillListPendingResult {
  jobs: readonly DistillJob[]
}

/* ── AI 润色的 wire 类型：单一定义在 agent-service.ts（宿主实现同源），
 * 这里 re-export——2026-09-09 重建宿主端时收敛，避免契约与实现两处漂移。 ── */
import type {
  GetPolishConfigResult,
  SetPolishConfigArgs,
  PolishPromptArgs,
  PolishPromptResult,
  PolishConversationArgs,
  PolishConversationResult,
  TranslatePromptArgs,
  TranslatePromptResult,
  ForkTaskAgentArgs,
  ForkTaskAgentResult,
} from '../agent-service.ts'

export type {
  GetPolishConfigResult,
  SetPolishConfigArgs,
  PolishPromptArgs,
  PolishPromptResult,
  PolishConversationArgs,
  PolishConversationResult,
  TranslatePromptArgs,
  TranslatePromptResult,
  ForkTaskAgentArgs,
  ForkTaskAgentResult,
}

/**
 * corumAgent 端点描述表：方法名 → 命名参数对象 / 返回体。
 * `{}` 表示该端点无参数。供消费方做 type-level 查表（typed caller 的数据源）。
 */
export interface CorumAgentEndpointTable {
  [CORUM_AGENT_METHODS.createTaskAgent]: { args: CreateTaskAgentArgs; result: CreateTaskAgentResult }
  [CORUM_AGENT_METHODS.forkTaskAgent]: { args: ForkTaskAgentArgs; result: ForkTaskAgentResult }
  [CORUM_AGENT_METHODS.listModels]: { args: {}; result: ListModelsResult }
  [CORUM_AGENT_METHODS.listPermissionPresets]: { args: {}; result: ListPermissionPresetsResult }
  [CORUM_AGENT_METHODS.listProfiles]: { args: {}; result: ListProfilesResult }
  [CORUM_AGENT_METHODS.listTaskAgents]: { args: ListTaskAgentsArgs; result: ListTaskAgentsResult }
  [CORUM_AGENT_METHODS.listAgents]: { args: {}; result: ListAgentsResult }
  [CORUM_AGENT_METHODS.saveProfile]: { args: SaveProfileArgs; result: SaveProfileResult }
  [CORUM_AGENT_METHODS.deleteProfile]: { args: DeleteProfileArgs; result: void }
  [CORUM_AGENT_METHODS.getPolishConfig]: { args: {}; result: GetPolishConfigResult }
  [CORUM_AGENT_METHODS.setPolishConfig]: { args: SetPolishConfigArgs; result: { ok: boolean } }
  [CORUM_AGENT_METHODS.polishPrompt]: { args: PolishPromptArgs; result: PolishPromptResult }
  [CORUM_AGENT_METHODS.polishConversation]: { args: PolishConversationArgs; result: PolishConversationResult }
  [CORUM_AGENT_METHODS.translatePrompt]: { args: TranslatePromptArgs; result: TranslatePromptResult }
  [CORUM_AGENT_METHODS.verify]: { args: {}; result: VerifyResult }
  [CORUM_AGENT_METHODS.distillStart]: { args: DistillStartArgs; result: DistillStartResult }
  [CORUM_AGENT_METHODS.distillStatus]: { args: DistillStatusArgs; result: DistillJob | null }
  [CORUM_AGENT_METHODS.distillCancel]: { args: DistillCancelArgs; result: DistillCancelResult }
  [CORUM_AGENT_METHODS.distillCommit]: { args: DistillCommitArgs; result: DistillCommitResult }
  [CORUM_AGENT_METHODS.distillDiscard]: { args: DistillDiscardArgs; result: DistillDiscardResult }
  [CORUM_AGENT_METHODS.distillReplay]: { args: DistillReplayArgs; result: DistillReplayResult }
  [CORUM_AGENT_METHODS.distillListPending]: { args: {}; result: DistillListPendingResult }
}
