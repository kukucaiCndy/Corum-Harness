/**
 * CorumAgentService — corum Agent 实例创建服务。
 *
 * 把 AgentProfile 编译成 preset，落盘后经官方
 * `ctx.agentPresets.mount` 走完整组装链路，创建一个真正绑定
 * 模型 / persona / 工具 / skill / MCP / 终端的 root Agent。
 *
 * 继承 TypertRemoteService，通过 @Remote 装饰器把 listProfiles / createAgent /
 * runPrompt / verify 暴露为 /api/corumAgent/* 端点，供浏览器半（dev-agent-shell）
 * 经桌面 IPC 桥调用。
 *
 * 这是「路径 A：每角色（每 profile）一个 preset」的落地点，也是第一刀
 * 要补全的「真正的 Agent 实例」。
 * @module @corum/corum-agent/agent-service
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
// fork（corum）：官方 installModelSelection 会用安装时的选择覆盖用户显式换的模型，
// 见 task-model-selection.ts 文件头（2026-09-09 用户实测：换模型后仍打旧模型）。
import { installTaskModelSelection } from './task-model-selection.ts'
import { childRunInterruptOf, foldProgressAll } from './child-progress.ts'
// fork（corum）2026-09-21：task 泳道解析/冷恢复按关注点抽出（四条路径 + 指挥模式口径）。
import { resolveTaskSession, type ResolvedTaskSession } from './task-lane.ts'
// fork（corum）2026-09-21：Agent 存活登记册按关注点抽出（六张状态表 + 语义方法）。
import { AgentRegistry } from './agent-registry.ts'
// fork（corum）2026-09-27：在跑的 Agent 就地重挂 preset 组合（用户需求：会话中改 MCP 即生效）。
import { reloadAgentPreset } from './preset-reload.ts'
// fork（corum）2026-09-21：终态改动摘要按关注点抽出（两个 host 来源 + 降级路径）。
import { buildChangeSummary as buildChangeSummaryOf, emitChangeSummary as emitChangeSummaryOf } from './change-summary.ts'
// fork（corum）2026-09-21：子 Agent 进度按关注点抽出（四张状态表 + 事件接线归它持有）。
import { SubagentProgressTracker } from './subagent-progress.ts'
import { TOOL_POLICY_SECTION, TOOL_POLICY_TEXT } from './tool-policy.ts'
import { HOST_IDENTITY_SECTION, hostIdentityText } from './host-identity.ts'
import {
  LOCALE_SETTINGS_NAMESPACE,
  OUTPUT_LANGUAGE_SECTION,
  OUTPUT_LANGUAGE_VARIABLE,
  localeIdFromSection,
  outputLanguageSectionText,
  outputLanguageVariableValue,
} from './output-language.ts'
// 空类型 import：让 ctx.agentDefaultModel / ctx.agentPresets 的 Context 合并生效。
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId, createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
// 空类型 import：让 ctx.llm 的 Context 合并生效。
import type {} from '@deepseek-ai/dsh-llm'
// 空类型 import：让 ctx.localLlm（可选本地引擎面）的 Context 合并生效。
import type {} from './local-llm-face.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// 值导入 SessionLogOffset：投影缓存按官方 lifecycle identity 建索引，查询要传
// inheritedEventCount（未 seed 的会话恒为 0）。空类型 import dsh-session-projection-cache
// 让 ctx.sessionProjectionCache 的 Context 合并生效（列表标题的零 I/O 读取路径）。
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
// 模块增强：让 `SessionProjectionMap` 认识列表视图消费的两个 key。
// `title` 由官方 dsh-session-title 声明（写入时折好的标题），`sessionListMetadata`
// 由官方 dsh-api-session-controller 声明（blank + lastPromptAt）。这两处都是
// declaration merging，不 import 它们的类型面就查不到 key（同 corum-subagent 的
// projection-types.ts 自声明 subagent 的做法）。type-only，无运行时开销。
import type {} from '@deepseek-ai/dsh-session-title/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
// 空类型 import：让 ctx.sessionPersistence 的 Context 合并生效（resume 用）。
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// fork（corum）2026-09-20：指挥者 shell 只读 —— 需要 `sandbox/mode` 事件形状。
// **type-only**：只合并官方事件表，不引运行时实现（避免新增依赖 + 「两份模块实例」红线）。
import type {} from '@deepseek-ai/dsh-sandbox-policy'
// fork（corum）2026-09-20：权限合成（主体 × 用户档位 × 模式约束）——解决「只读被用户档位覆盖」。
import { ConductorRuntime } from './conductor-runtime.ts'
// fork（corum）2026-09-20：泳道登记/查找/挂载按关注点抽出。
import {
  attachTaskWorkspace as attachTaskWorkspaceOf,
  findBlankTaskLane as findBlankTaskLaneOf,
  readTaskSessionIndex as readTaskSessionIndexOf,
  registerTaskSession as registerTaskSessionOf,
} from './lane-registry.ts'
// fork（corum）2026-09-20：profile 编译与落盘按关注点抽出（用户定调「文件层面切分清晰」）。
// 2026-09-26 项目模式剥离后 `checkoutPinnedSkills` 仍有两处调用：`createAgentUncached`
// 与 `createAgentForTask`（task 模式首次创建同样要走 pinned skill checkout + 落盘 preset）；
// 项目泳道那一路的同款调用已随编排迁到闭源仓（走 `@corum/corum-agent/lane-support`）。
import { checkoutPinnedSkills as checkoutPinnedSkillsOf, writeAgentDir as writeAgentDirOf } from './profile-compiler.ts'
// fork（corum）2026-09-20：润色/翻译按关注点抽出的模块（含类型、引擎路由、system 提示词）。
import {
  parsePolishEnvelope,
  polishConversationSystem,
  polishPromptSystem,
  requirePolishConfig as requirePolishConfigOf,
  runPolishEngine,
  translatePromptSystem,
  type GetPolishConfigResult,
  type PolishConversationResult,
  type PolishPromptResult,
  type TranslatePromptResult,
} from './polish-service.ts'
import type { AgentProfile, ProfileModel, SkillBinding } from './profile.ts'
import { isValidProfileId, isValidAgentDimension, isValidPersonaPreset, assertBaseModeAllowedForPreset } from './profile.ts'
// fork（corum）2026-09-26：预设引用的模型可能已被用户删除（确定性配置缺失，与「运行期
// 调用失败」是两个概念）——事前校验 + 回落全局默认 + 显式告知。见该模块头注的分界表。
import { deliverModelFallbackNotice, resolveUsableModel, type ModelFallback } from './model-availability.ts'
// 项目模式剥离（2026-09-26）：原 `./project.ts` 的符号已分流——
// 工作区身份（canonicalWorkspaceKey / findWorkspaceEntryByCwd / workspaceEntryTypeOf）
// 落 L0 `workspace-identity.ts`，工程类型与工作类型（GENERAL_WORK_TYPE /
// DEFAULT_PROJECT_TYPE / ProjectType）落 L1 `workspace-type.ts`；
// 其余（CorumProject 实体、项目组、项目存储）已迁至闭源仓 Corum-Harness-Project。
// 顺带：`isValidProjectId` / `isGroupMember` / `loadProject` / `projectTypeOf` /
// `isValidWorkTypeSlug` 只被已迁出的 project-lane 用到（前者校验 projectId、
// 后者校验泳道 slug），本文件不再引入。
import { canonicalWorkspaceKey, findWorkspaceEntryByCwd, workspaceEntryTypeOf } from './workspace-identity.ts'
import { DEFAULT_PROJECT_TYPE, GENERAL_WORK_TYPE, type ProjectType } from './workspace-type.ts'
// 统一会话索引（两模式共用；键 = sessionId，按 cwd 分组）——
// 见 session-index.ts 的文件头（两套旧索引键空间不同构，不可机械合并）。
import { findSessionByLane, registerSession } from './session-index.ts'
import { loadProfile, listProfiles, saveProfile, deleteProfile, agentDirPath, loadPolishConfig, savePolishConfig } from './profile-store.ts'
import { agentRecreateWarning, lifecycleDiagPath, noteAgentRecreate } from './agent-lifecycle-guard.ts'
import type { PolishConfig } from './profile-store.ts'
import { SMOKE_PROMPT, ensureBuiltinRoleProfiles, ensurePmProfile, ensureSmokeProfile, ensureTaskProfile, TASK_PROFILE_ID } from './builtin-profiles.ts'
import { extractHeader, summarizeText, simplifyEventData } from './event-projection.ts'
// fork（corum）：指挥模式（基准模式 `conductor`）——主 Agent 运行时裁剪 + 人格段。
import {
  CONDUCTOR_PERSONA,
  CONDUCTOR_PRESET_ID,
  CONDUCTOR_SECTION,
  CONDUCTOR_STALE_SECTIONS,
  conductorExecutionDeny,
  conductorModeOf,
  effectiveExecutionTools,
} from './conductor.ts'
import type { ConductorMode } from './conductor.ts'
// fork（corum）：机制 deny 的收敛口径与 scope 可见工具名——与 fork #10 同源
// （docs/LESSONS.md §6.18：机制生成的名字必须按运行时注册面收敛）。
import {
  CORUM_EXECUTION_DISCIPLINE_SECTION,
  corumExecutionDisciplineText,
  corumNarrowDenyFilter,
  corumVisibleToolNames,
} from '@corum/corum-orchestration'

/**
 * fork（corum）：官方 0.1.3 session-persistence 改 handle seam —— 顶层
 * `readFrom(id, fromSeq)` 已删，读取须先 `open(id, 'read')` 拿 SessionHandle，
 * `handle.read(offset)` 读区间，用完 `close()` 释放。本 helper 收敛这一固定三步，
 * 替代旧 readFrom 的「读全历史/读 fromSeq 起」语义（length 缺省 = 读到日志尾）。
 */
async function readPersistedEvents(
  persistence: Context['sessionPersistence'],
  sessionId: SessionId,
  fromSeq: number,
): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(sessionId, 'read')
  try {
    // 官方 0.1.5：`SessionHandle.read` 的返回从 `readonly SessionEvent[]` 改为
    // `SessionHandleReadResult`（`{ eventState, events }`）⇒ 这里取 `events`，
    // 本函数对外的返回类型保持不变（4 个消费方无需改）。
    const result = await handle.read(fromSeq)
    return result.events
  } finally {
    await handle.close()
  }
}

/**
 * 列表行标题的**回退**（官方 `api/session-controller` 的 `displayTitleOf` 同口径）：
 * 投影缓存未命中时用「工作区目录末段 → 会话 id」而不是去读历史。
 *
 * 为什么这样回退是对的：标题只是**展示**字段，而算它需要读整个会话历史（旧实现
 * 的 N+1，见 `listTaskAgentsRemote` 的性能段）。官方在自己的冷列表里就是这么做的
 * ——宁可显示工作区名，也不为一行标题扫一遍事件日志。
 *
 * @param cwd - 会话绑定的工作区路径。
 * @param sessionId - 会话 id（cwd 缺失时的最后回退）。
 * @returns 非空标题。
 */
function taskListFallbackTitle(cwd: string, sessionId: string): string {
  const trimmed = (cwd ?? '').trim().replace(/[/\\]+$/, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1).slice(trimmed.lastIndexOf('\\') + 1)
  return base !== '' ? base : sessionId
}
import { scanSkills } from './skill-catalog.ts'
import { corumHome } from './home.ts'
import { stallAutoRecoverMsValue } from './runtime-state.ts'
import type { SkillEntry } from './skill-entry.ts'
// 统一事件中心三-3：'corum/subagent/progress' 的 cordis Events 声明 + 终态推导口径
// （自包含在 fork 包 corum-api-remotes；type-only import 只拉编译面，不进运行时依赖图）。
import type {} from '@corum/corum-api-remotes/corum-events'
// 值导入 stopReasonOfTurnEnd：turn/end.reason.kind → SubagentStopReason（同口径，同包依赖已存在）。
// fork（corum）2026-09-21：折叠本体移入 `child-progress.ts`（纯函数），此处只留类型面。
import type { SubagentStopReason, SubagentTodoItem, SubagentChangeSummary } from '@corum/corum-api-remotes/corum-events'
// 模块增强：加载 dsh-tool-todo 的 'todo/write' SessionEventMap 扩展声明
// （corum-agent 在 compile.ts 里把 dsh-tool-todo 编进工具表，但 TS 不会自动
// 拉取其类型增强——这里显式 import 只触发 declare module 合并，无运行时开销）。
import type {} from '@deepseek-ai/dsh-tool-todo'
// 模块增强：加载 @corum/corum-git-core 的 `gitCore` Context 合并声明
// （不变式①的创建前置门禁——本服务在 createAgentForTask/openProject 等入口调
// this.ctx.gitCore.assertGitWorkspace；显式 import 只触发 declare module 合并）。
import type {} from '@corum/corum-git-core'

// 再导出：保持既有消费方（index.ts / contract/agent.ts，以及闭源仓的
// `@corum/corum-project`）的 import 面不变——包内拆分对外的稳定锚。
// 2026-09-26 项目模式剥离：`project-service.ts` / `runtime.ts` 两个消费方已迁出闭源仓。
export { ensurePmProfile, ensureTaskProfile, PM_PROFILE_ID } from './builtin-profiles.ts'
export { simplifyEventData } from './event-projection.ts'
export type { SkillEntry } from './skill-entry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum Agent 实例服务（AgentProfile → preset → root Agent）。 */
    corumAgent: CorumAgentService
    /**
     * 指挥模式查询面（本服务 provide；`@corum/corum-subagent` 按**可选**服务消费）。
     * 见 {@link CorumConductorFace}。
     */
    corumConductor?: CorumConductorFace
  }
}

/**
 * `corumConductor` 服务的面：把「这个会话是不是指挥模式」交给子 Agent 组装方。
 *
 * 消费方（`@corum/corum-subagent` 的 `applyChildComposition`）按可选服务取用：
 * - `isConductor` 为真 → 子 Agent 换掉继承来的**角色人格**（只保留工作风格），
 *   并在子 scope deny 掉全部委派工具（指挥模式下不再召唤孙 Agent）；
 * - `childPersonaFor` 给出替代人格文本（中性工作型角色行 + 父的工作风格段）。
 *
 * 缺席（精简装配里没挂 corumAgent）时消费方退化为原有行为——不报错、不阻断。
 */
export interface CorumConductorFace {
  /** 该会话此刻是否处于指挥模式。 */
  isConductor: (sessionId: string) => boolean
}

/** 创建结果。 */
export interface CreateAgentResult {
  /** 创建的 root Agent。 */
  agent: Agent
  /** 编译落盘的 preset id（= profile id）。 */
  presetId: string
}

/** UI 投影的 profile 摘要（不含敏感字段）。 */
export interface ProfileSummary {
  id: string
  nickname?: string
  title?: string
  /** 岗位维度（名片筛选，可选）。 */
  dimension?: string
  /** 名片履历（可选）。 */
  experience?: string
  /** 人格设置（可选，不超过 500 字符；personaPreset==='custom' 时使用）。 */
  persona?: string
  /** 人格预设（工作场景人格原型；编辑回填用）。 */
  personaPreset?: string
  /** 头像（dataURL 或 URL，可选）。 */
  avatar?: string
  /** 基础模式（编辑回填用）。 */
  baseMode?: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  /** 子 Agent 模型配置（可选，缺省同主 Agent）。 */
  subagentModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 研究子 Agent 模型配置（可选，缺省同 subagentModel）。 */
  researchModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 并行开发策略（可选；fork #10 双实例行 config 的 profile 级覆盖）。 */
  parallelWork?: import('./profile.ts').ParallelWorkPolicy
  skills: SkillBinding[]
  mcpServers: string[]
  terminal: { mode: string }
  /** 记忆功能开关（UI 投影；sourceOfTruth 在 memoryPolicy.scope，'agent'=开启）。 */
  memoryEnabled?: boolean
  version: number
  trust: string
  /** 目录来源（2026-09-02 合并官方 preset 后区分）：'corum' = corum profile
   *  （.agent-presets）；'official' = 官方 preset（cordis/minimal/ptc/standard）。
   *  消费者按需过滤（团队段成员/Agent 测试面板只关心 corum；新建任务表单并列）。 */
  source: 'corum' | 'official'
}

/** Agent 运行状态。 */
export interface AgentStatus {
  profileId: string
  created: boolean
}

/** UI 投影的 LLM provider + 模型目录。 */
export interface ProviderCatalog {
  id: string
  name: string
  models: Array<{
    id: string
    name: string
    input?: string[]
  }>
}

/* ── AI 润色的 wire 类型 ──────────────────────────────────────────────────────
 * 2026-09-20：实现与类型按关注点抽到 `polish-service.ts`（用户定调「提示词润色这种其实
 * 就可以单独拆出来」）。此处**re-export** 保持 `contract/agent.ts` 与既有 import 不变
 * （RPC 面与 UI 零改动）。
 */
export type {
  GetPolishConfigResult,
  PolishConversationResult,
  PolishPromptResult,
  TranslatePromptResult,
} from './polish-service.ts'

/** setPolishConfig 入参（provider/model 必填；engine/localModel/reasoningEffort 可选）。 */
export interface SetPolishConfigArgs {
  engine?: 'auto' | 'local' | 'online'
  provider: string
  model: string
  localModel?: string
  reasoningEffort?: string
}

/** polishPrompt 入参（kind 给模型一点体裁提示，如 prompt / text）。 */
export interface PolishPromptArgs {
  text: string
  kind?: string
}

/** polishConversation 入参（text + 最近若干条 user/AI 最终输出）。 */
export interface PolishConversationArgs {
  text: string
  history: Array<{ role: 'user' | 'assistant'; text: string }>
}

/** translatePrompt 入参。 */
export interface TranslatePromptArgs {
  text: string
}

/** `sessionProjections` 的最小能力面（与 task-model-selection.ts 同款，避免耦合官方类型增强）。 */
interface ModelSelectionProjections {
  stateOf: (session: Session, key: 'modelSelection') => unknown
}

/** `agentPreset` 投影的最小能力面（官方 dsh-agent-presets 注册的会话级 preset 键）。 */
interface AgentPresetProjections {
  stateOf: (session: Session, key: 'agentPreset') => string | null | undefined
}

/** `modelSelection` 投影里的选择形状（只读 provider/model）。 */
interface ProjectedSelection {
  provider: string
  model: string
}

/**
 * fork（corum）2026-09-19：子 Agent 模型路由的**等值比较**（预设保存补偿的变化检测用）。
 *
 * 只比 provider/model/reasoningEffort 三键（compile.ts `corumSubagentConfig` 写进
 * `config.model` 的恰是这三键）；`reasoningEffort` 按「undefined 与空串等价」处理
 * （compile.ts 的展开条件 `reasoningEffort !== undefined && !== ''` 两态编译产物相同）。
 */
function corumRouteEquals(
  a: { provider: string; model: string; reasoningEffort?: string } | undefined,
  b: { provider: string; model: string; reasoningEffort?: string } | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b
  const effortA = a.reasoningEffort !== undefined && a.reasoningEffort !== '' ? a.reasoningEffort : undefined
  const effortB = b.reasoningEffort !== undefined && b.reasoningEffort !== '' ? b.reasoningEffort : undefined
  return a.provider === b.provider && a.model === b.model && effortA === effortB
}

/**
 * 会话历史里是否出现过图片内容块。
 *
 * 与官方 `session-controller/commands.ts` 的 `imageInEvent` 同判据（content /
 * message.content / assistant 流式块），但**不看 attachment 匹配、只看有无**：
 * 换模型预警只关心「历史里有没有图」，不关心是哪一张。
 * 形态不认就返回 false（宁可不提示，不可误报阻塞用户切换）。
 */
function eventHasImage(event: SessionEvent): boolean {  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
  }
  if (contentHasImage(data.content)) return true
  if (contentHasImage(data.message?.content)) return true
  return false
}

/** 内容块数组里是否存在 image 块（不做 attachment 字段校验，容忍历史形态差异）。 */
function contentHasImage(content: unknown): boolean {  if (!Array.isArray(content)) return false
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly content?: unknown }
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && contentHasImage(block.content)) return true
  }
  return false
}

/** 单条会话事件的 UI 投影（只取 UI 需要的简化结构）。 */
export interface SessionEventDto {
  seq: number
  type: string
  /** 简化数据（UI 按 type 自行解析）。 */
  data: unknown
  time: number
}

/** runPrompt 的返回：assistant 回复文本 + 过程事件快照 + 装配的 system prompt。 */
export interface RunPromptResult {
  reply: string
  events: SessionEventDto[]
  /** 最终装配的 system prompt（从 request/header 事件提取）。 */
  systemPrompt?: string
  /** 装配的工具 schema 列表（从 request/header 事件提取）。 */
  tools?: Array<{ name: string; description?: string }>
}

/** task 模式会话摘要（侧栏列表行）。 */
export interface TaskAgentSummary {
  sessionId: string
  cwd: string
  profileId: string
  /** 是否本进程存活（可立即对话；否则需 resume）。 */
  alive: boolean
  /** 标题（首条 user 消息摘要；无消息为空）。 */
  title: string
  /** 最后活动时间（Unix ms；无事件为 0）。 */
  lastActive: number
}

/** saveProfile 的 RPC 入参（AgentProfile 子集，UI 可编辑的字段）。 */
export interface SaveProfileInput {
  id: string
  nickname?: string
  title?: string
  /** 岗位维度（名片筛选）。 */
  dimension?: string
  /** 名片履历。 */
  experience?: string
  /** 人格设置（不超过 500 字符；personaPreset==='custom' 时使用）。 */
  persona?: string
  /** 人格预设（工作场景人格原型：内置预设 id 或 'custom'）。 */
  personaPreset?: string
  avatar?: string
  baseMode: AgentProfile['baseMode']
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  subagentModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 研究子 Agent 模型配置（可选，缺省同 subagentModel）。 */
  researchModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 并行开发策略（可选；fork #10 双实例行 config 的 profile 级覆盖）。 */
  parallelWork?: import('./profile.ts').ParallelWorkPolicy
  /** 绑定的 skill 列表（引用绑定 + 版本 pin）。 */
  skills: SkillBinding[]
  /** MCP 服务授权列表（引用全局注册表中的服务名）。 */
  mcpServers: string[]
  terminal: { mode: 'sandbox' | 'host' }
  memoryPolicy: { scope: 'agent' | 'none'; dir?: string }
  trust: 'system' | 'user'
}

/**
 * CorumAgentService — corum Agent 实例服务。
 *
 * 单例（注册在 host 根 ctx），负责：
 *   1. 把 AgentProfile 编译成 preset 目录并落盘到 user root；
 *   2. 用 `ctx.agents.create({ setup })` 创建 root Agent，setup 里 mount preset；
 *   3. 返回真正的、绑定完整能力的 Agent。
 *
 * 同时继承 TypertRemoteService，暴露 /api/corumAgent/* RPC 端点供 UI 调用。
 */
/**
 * 泳道描述：路由标签（key）+ 工作类型语义（type）+ 可选需求段。
 *
 * 2026-09-21：类型本体已随「Agent 存活登记册」搬到 `agent-registry.ts`（泳道表是它持有
 * 的六张表之一），此处**re-export** 保持既有 import 面不变（`index.ts` 与 contract 都
 * 从这里取它）。这也消掉了 registry → agent-service 的一处循环依赖。
 */
export type { AgentLaneDescriptor } from './agent-registry.ts'
// ⚠️ `export type { X } from './y'` 只**转发**、不把 X 带进本文件作用域 —— 本文件仍要在
// 签名里用这个类型，故必须再来一条 type-only 引入。
import type { AgentLaneDescriptor } from './agent-registry.ts'

export class CorumAgentService extends TypertRemoteService {
  static inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'sessionPersistence', 'systemPrompt', 'gitCore']

  /**
   * **Agent 存活登记册**（六张按 id 索引的表：root Agent / 泳道会话 / 泳道归属索引 /
   * task 会话 / task 模型选择 ref / 在飞创建与重建记账）。
   *
   * 2026-09-21 按关注点抽到 `agent-registry.ts`（用户定调「至少要在文件层面切分清晰」）。
   * 抽出的核心理由：**状态的所有者必须显式** —— 这六张表此前散在本类字段里、被 25 处
   * 方法体直接读写，「谁在写这张表」只能靠全文搜索回答；而那正是上场只读护栏漏洞的结构性成因。
   *
   * 服务层一律经**语义方法**访问（`registerTask` / `findLaneBySession` / …），不再碰 Map。
   * `scripts/verify-refactor-guard.sh` 的 ③ 组把这些表的直访预算钉为 0。
   */
  private readonly registry = new AgentRegistry()

  /**
   * 待定的访问权限档位（sessionId → preset 名），**只存内存、不落盘**。
   * 用户建任务时选的档位先记在这里，等发第一条消息时才写进会话事件
   * （见 {@link rememberPendingPermission}）——这样未发消息的会话不留磁盘记录。
   */
  private readonly pendingPermissions = new Map<string, string>()

  /**
   * fork（corum）2026-09-26：**模型回落告知的去重集**（`sessionId → 已告知的失效路由`）。
   *
   * 为什么需要：回落告知走 `agent.inject`（不开 turn，故泳道仍是 blank、可复用），而用户
   * 「连点新建任务」时会**复用同一个 blank 泳道**——实测（`corum-task-5d1fe37e`）两次创建
   * 各注入一条完全相同的告知，用户第一句话就会连着看到两条。同一会话、同一失效路由只说一次。
   *
   * 键取值用「失效路由」而不是布尔：用户换了另一个也不存在的模型时**应当**再告知一次
   * （那是新事实，不是重复）。
   *
   * 不落盘（与 `pendingPermissions` 同档）：进程重启后内存态清空，此时再告知一次是可接受的
   * ——宁可多一条也不静默。
   */
  private readonly notifiedModelFallbacks = new Set<string>()

  /**
   * 指挥模式运行时（两张按 sessionId 索引的内存表 + 生效/撤销）。
   *
   * 2026-09-20 按关注点抽到 `conductor-runtime.ts`（用户定调「至少要在文件层面切分清晰」）。
   * 抽出的直接动机：本类里「指挥模式」与「权限档位」曾是两个**无协调的沙箱写入者**，
   * 正是只读护栏被用户档位覆盖的结构性成因 —— 边界显式化后不再可能互相踩。
   */
  private readonly conductor = new ConductorRuntime()

  /**
   * 子 Agent 进度跟踪器（四张按 sessionId 索引的记账表 + 中断广播去重）。
   *
   * 2026-09-21 按关注点抽到 `subagent-progress.ts`（用户定调「至少要在文件层面切分
   * 清晰」）。抽出的理由与 `conductor` 同源：**状态的所有者必须显式** —— 这四张表此前
   * 与 RPC 方法体混在同一个类里，「谁在读、谁在写」只能靠全文搜索回答。
   *
   * 在构造器里赋值（emit 回调需要 `this.ctx` 已可用）。
   */
  private readonly progress: SubagentProgressTracker

  /** 该会话此刻是否处于指挥模式（供 `corumConductor` 服务消费）。 */
  private isConductorSession(sessionId: string): boolean {
    return this.conductor.isConductor(sessionId)
  }

  constructor(ctx: Context) {
    super(ctx, 'corumAgent')
    // 行业角色预置（25 个岗位）：幂等确保存在——system profile 的 prompt 随
    // 版本演进刷新，用户自建/已改的 user profile 不动。服务启动时一次性注册，
    // 让新建任务表单的 Agent 下拉与名片页立即可见全量预置角色。
    ensureBuiltinRoleProfiles()
    // fork（corum）2026-09-14：**task / pm 也要在启动时播种 spec 基线**。
    //
    // 这两个 profile 的 `ensure*` 是**懒加载**的（只在真正用到该 profile 时调用：
    // `:463/:1487/:1792/:1850` 的 `profileId === TASK_PROFILE_ID ? ensureTaskProfile() : …`），
    // 于是它们的 `specBaseline` 要等被用到才播种 ⇒ 在此之前「用户数据不被升级覆盖」的保护
    // **不生效**（2026-09-14 实测：`task` 的基线一直缺失）。这里把两者提前到启动时幂等执行。
    ensureTaskProfile()
    ensurePmProfile()
    /**
     * 工具使用策略段（root scope，所有 corum 会话继承）。
     *
     * 用户实测：模型改代码一律走 bash（heredoc / sed -i / python -）。官方
     * `tool:read`/`tool:write`/`tool:edit` 段只讲各自怎么用，没有任何一段讲
     * 「别用 bash 干这个」；`tool:bash` 段只有一句 exit-code 提示。本段补这一层
     * （Claude Code 同款做法），并说明代价：走 bash 的改动绕过改动审查捕获。
     * 指挥模式下由 applyConductorMode 用空文本覆盖（内层覆盖外层）。
     */
    ctx.systemPrompt.section({
      name: TOOL_POLICY_SECTION,
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') - 50,
      text: TOOL_POLICY_TEXT,
    })
    /**
     * 执行纪律段（**root scope**，所有 corum 会话与子会话继承；2026-09-27 从 corum-tool-subagent 上移）。
     *
     * 为什么必须 root scope：这两块（效率 / 沙箱升级）不只「能委派的 Agent」要读 —— 子会话正是沙箱
     * 升级纪律的读者（块里明写 "In a DELEGATED CHILD session …"）。原先它们挂在
     * `corum:subagent-orchestration` 段里，而那段有「委派工具可见才渲染」的守卫 ⇒ worker 子会话
     * （没有委派工具）读到空串。也不能只挂 preset scope：minimal 是 `complete`（只渲染 persona）
     * ⇒ 段完全进不去，那条路由 `compile.ts` 把它追加进人格段。
     */
    ctx.systemPrompt.section({
      name: CORUM_EXECUTION_DISCIPLINE_SECTION,
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
      // 2026-09-27：**不再读 ctx.tools**（未声明 inject 的上下文会抛 cannot get property "tools"
      // without inject，实机抓到过一次）；「无写工具的读者不该被要求用 write/edit」改由文本层条件句承担，
      // PTC 前缀由编排段（工具插件内、本来就持有 tools）负责。
      text: () => corumExecutionDisciplineText({ ptcPrefix: '' }),
    })
    /**
     * 宿主身份段（root scope，所有 corum 会话继承）：把「本会话跑在哪个实例 / home /
     * CDP 端口上」作为**事实**写进提示词。
     *
     * 2026-09-12 实测事故：子 Agent 需要判断「哪个实例在跑、我能不能重启它」，而会话从
     * 内部无法知道自己的宿主（它的 bash 里 `echo $CORUM_HOME` 是空的）→ 它用 ps/lsof
     * 拼凑，`cdp.mjs` 又因默认端口 9222 而驱动了**用户主实例**，读到用户真实会话后误判
     * 「:9333 的宿主就是我」，差一步重启用户正在用的应用。结论：补事实，不靠猜。
     * 配套：`home.ts` 把 CORUM_HOME 写进进程环境，让脚本也拿得到。
     * 顺序放在最前（order 5）——它是后续所有工具/验证判断的前提。
     */
    ctx.systemPrompt.section({
      name: HOST_IDENTITY_SECTION,
      order: 5,
      text: hostIdentityText(corumHome(), process.env.CORUM_DEBUG_PORT),
    })
    /**
     * 输出语言段（root scope，所有 corum 会话继承）：把「用户的母语是什么」作为**事实**
     * 注入提示词（2026-09-15 用户需求）。
     *
     * **只约束对外可见输出**（最终回复 + 思考摘要），**不约束内部推理**——用户明确
     * 「对于提示词/思考过程不做要求，某些模型确实英文语料训练的比较多。仅在关键结论、
     * 输出做要求」。措辞细节与理由见 `output-language.ts` 的文件头。
     *
     * 语言值走**占位符 `{{output_language}}`**（用户要求）：与 `{{model}}`/`{{cwd}}`
     * 同一套 `systemPrompt.variable` 机制（`dsh-agent-loop/src/index.ts:421-423` 注册那两个）。
     * provider **每次组装时求值** ⇒ 用户在设置里改语言后**下一次组装即生效**，
     * 不缓存、不重启会话。
     *
     * ⚠️ provider **绝不返回 `undefined`**：严格插值下 `undefined` 会让整个组装抛错
     * （`dsh-system-prompt/src/index.ts:334-339` 实测）。未设偏好时返回一句可读的
     * 「未指定」+ 回退指示，段文本依然自洽。
     */
    ctx.systemPrompt.variable(OUTPUT_LANGUAGE_VARIABLE, () => {
      // settings 服务在 boot 早期可能尚未挂载（与上面 registerSettings 同款情形）；
      // 读不到就当作「无偏好」——可选偏好绝不阻断会话组装。
      const settings = ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
      const localeId = localeIdFromSection(settings?.get?.(LOCALE_SETTINGS_NAMESPACE))
      return outputLanguageVariableValue(localeId)
    })
    // 段文本**静态**（含 `{{output_language}}` 占位符），由上面的变量在组装时插值。
    ctx.systemPrompt.section({
      name: OUTPUT_LANGUAGE_SECTION,
      order: 6,
      text: outputLanguageSectionText(),
    })
    /**
     * 子 Agent 进度跟踪器：持有四张记账表，并经两个窄回调与宿主交互。
     *
     * 事件名与载荷的收窄声明面留在本服务（`corum/subagent/*` 的声明在 fork 包
     * `@corum/corum-api-remotes`，本插件不 import 它的运行时声明面）。窄回调让 tracker
     * 不反向依赖 CorumAgentService（`verify-refactor-guard.sh` 的 ④ 组）。
     */
    this.progress = new SubagentProgressTracker(this.ctx, {
      emitProgress: (frame) => this.ctx.emit('corum/subagent/progress', frame),
      // 两个 emit 都走 `as never` 收窄：`corum/subagent/*` 的事件声明在 fork 包
      // `@corum/corum-api-remotes` 里，本插件不 import 它的运行时声明面（避免「两份模块
      // 实例」红线）。与本文件其它同类 emit（`corum/subagent/child` 等）同一手法。
      emitInterrupted: (info) => (this.ctx.emit as never as (t: string, d: unknown) => void)('corum/subagent/interrupted', info),
    })

    /**
     * `corumConductor` 服务：把「这个会话是不是指挥模式」暴露给子 Agent 组装方。
     *
     * 为什么必须经服务：子 Agent 的组装点在 `@corum/corum-subagent`（跨包），而指挥模式的
     * 权威判定在本服务（preset id + `executionTools: 'orchestrator'` 两个口径，见
     * `conductor.ts` 的 conductorModeOf）。消费方按**可选服务**取用（`ctx.get`），
     * 缺席时退化为「没有指挥模式语义」，不影响其它装配。
     */
    ctx.provide('corumConductor', {
      isConductor: (sessionId: string): boolean => this.isConductorSession(sessionId),
    } satisfies CorumConductorFace)
    /**
     * 用户发出第一条真实消息时，兑现待定的访问权限档位。
     *
     * 用官方 `session/event` 事件而不是自家 `runPromptForTask` RPC：UI 走的是官方
     * 客户端 `session.prompt()` → host session-controller 的 prompt，**不经过**本服务
     * 的 RPC。判定条件与官方 `api-session/activity` 同源（官方在
     * `dsh-api-session-controller/lib/index.js:2692-2694` 用的正是
     * `user/message` + `source.kind === 'user'`），覆盖所有发送通道。
     */
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const sid = String(session.id)
      const entry = this.registry.task(sid)
      if (entry === undefined) return
      this.flushPendingPermission(entry.agent.session, sid)
    })
    /**
     * 统一事件中心三-3：子 Agent 会话进度增量推送（SubagentCard 2s 全量重读
     * 轮询的迁移承载）。
     *
     * 机制：官方 `session/event` 每追加一条事件就是子会话一次状态推进。本
     * 监听器对 origin='subagent' 的会话维护每会话 O(1) 折叠状态（与
     * getChildSessionProgress 的全量折叠同口径，但随事件流增量更新，不再
     * 每 2s `readFrom(sessionId, 0)` 重读整段历史），折叠快照变化即
     * `ctx.emit('corum/subagent/progress', frame)`，经 fork 包
     * corum-api-remotes 的转发 allowlist 推给所有 renderer。
     *
     * 容量护栏：会话 dispose（`session/disposed`）时清表；再按上限淘汰最久
     * 未活动条目（防长进程多 delegation 累积）。
     */
    ctx.on('session/event', (session, event) => {
      // fork（corum）2026-10-08：旧的 turn-end auto-commit（settleCommitOnTurnEnd）
      // 已删除——改为 turn-stopping 阻塞式提交卡片（corum-git-core 的 agent/turn-stopping
      // 钩子出卡片 + steer LLM 自己分笔提交）。session/event 的 turn/end 返回值被 void
      // 丢弃、不能 await，故旧机制是「甩下就跑」；新机制在 turn-stopping（turn 仍 open、
      // 可阻塞）里处理。此处不再做 turn/end 提交。
      if (session.header.origin !== 'subagent') return
      const sid = String(session.id)
      const frame = this.progress.fold(sid, event)
      if (frame !== undefined) this.ctx.emit('corum/subagent/progress', frame)
      // 终态帧（turn/end → stopReason 写入）发出后 → 异步补发改动摘要。
      if (frame !== undefined && frame.stopReason !== undefined) this.emitChangeSummary(sid)
    })
    ctx.on('session/disposed', (session) => {
      this.progress.clear(String(session.id))
    })
    /**
     * 委派角色记账（`corum/subagent/child` 帧 → childSessionId → 角色）。
     *
     * 帧里带的是父侧工具名派生的角色（见 `SubagentChildEvent.role`）。这里留存一份，
     * 供会话条花名册经 `getChildSessionProgress` 冷启动补标——推送帧不重放，不记就
     * 只剩「本页加载之后新建的子 Agent」才显示角色（与 mode/isolated 的老缺口同源）。
     */
    ctx.on('corum/subagent/child' as never, ((info: {
      readonly childSessionId?: string
      readonly parentSessionId?: string
      readonly role?: 'worker' | 'research' | 'fork'
    }) => {
      // 记账归 tracker（父会话归属与角色分开记的理由见 `subagent-progress.ts`）。
      this.progress.noteChild(info)
    }) as never, { global: true })

    /**
     * subagent/end 终态兜底：子会话在首个 turn 打开前被取消时，
     * session/event 不产生 turn/start / turn/end，foldSubagentProgress
     * 一帧不发。此处用宿主权威终态事件补发进度帧，让 UI 卡片拿到终态。
     *
     * as never + { global: true } 收窄口径与 corum-tool-subagent/src/index.ts
     * 同款（cordis Events 合并声明在 @corum/corum-subagent，跨包类型面不共享）。
     */
    ctx.on('subagent/end' as never, ((info: { readonly id: unknown; readonly stopReason: string }) => {
      const sid = String(info.id)
      // 补发终态帧（已有终态帧则不覆盖）。两种情况都要补发改动摘要——`turn/end` 路径里
      // 也补发，此处兜底重复幂等。
      this.progress.markTerminal(sid, info.stopReason as SubagentStopReason)
      // 终态帧已发出 → 异步补发改动摘要（corumReview.snapshot + 台账状态）。
      this.emitChangeSummary(sid)
    }) as never, { global: true })
  }


  /**
   * 记录一次 agent 创建；窗口内反复重建同一 profile ⇒ warn + 调用栈（点名驱动者）。
   *
   * 为什么必须有：打包实例上实测「整套 MCP 每秒重启一次、持续 10+ 分钟」，而 MCP 的启动
   * 完全由 agent 创建驱动 —— 没有这条日志，风暴期间从外部只能看到 MCP 在刷，看不到是谁在重建。
   */
  private noteAgentCreated(profileId: string): void {
    const stack = new Error().stack
    const verdict = noteAgentRecreate(this.registry.creationTimesOf(profileId), Date.now())
    this.registry.setCreationTimes(profileId, verdict.recent)
    this.appendLifecycleDiag({ kind: 'created', profileId, count: verdict.recent.length, stack })
    if (verdict.warn) this.ctx.logger.warn(agentRecreateWarning(profileId, verdict.recent.length, stack))
  }

  /**
   * 把生命周期事件落到 `<home>/logs/agent-lifecycle.jsonl`（理由见 `lifecycleDiagPath`）。
   *
   * 只写**罕见但严重**的形态（重建风暴 + 每次销毁）——不是常规日志通道；写失败只吞掉
   * （诊断不能反过来影响会话）。
   */
  private appendLifecycleDiag(record: Record<string, unknown>): void {
    try {
      const file = lifecycleDiagPath(process.env.CORUM_HOME ?? process.env.DSH_HOME)
      if (file === undefined) return
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify({ at: Date.now(), ...record }) + '\n')
    } catch { /* 诊断落盘失败不影响会话 */ }
  }

  /**
   * fork（corum）2026-09-27：把**正在跑的**该 profile 会话就地重挂到最新组合。
   *
   * 为什么不能只靠 `forgetProfileAgent`：那只清 corum 自己缓存的 root Agent，**task 泳道的
   * agent 由会话持有**、不经过那张表；而官方 `agentPresets.select` 对「已开始」的会话抛
   * `agent-preset/locked`（实测：`session "…" has already started; its agent preset is fixed`）。
   * 于是用户在会话中给 profile 加 MCP 时，那个会话既拿不到新行、也切不动 preset ⇒ 只能重启软件。
   *
   * 重挂走官方**同款原语** `recompose`（能力接口 + 特性检测，见 `preset-reload.ts`）：它按组合
   * 文件指纹判断常驻挂载是否过期（过期即按新 yml 重挂 ⇒ 新 `mcp-*` 行生效），再
   * `emit('tools/change')` 通知工具面变化 ⇒ **下一轮请求**带上新工具。人格与写权限不变
   * （同一个 preset id），只有组合里新增/删除的行变化。
   *
   * 失败不抛（保存 profile 是用户操作）：进 warn，会话保持原工具面，下次重建仍会拿到新组合。
   * 能力不可用（老宿主）⇒ 静默保持既有行为，绝不假装成功。
   *
   * ⚠️ 代价：每次保存都会重挂这些会话的组合 ⇒ 其 MCP server 进程随之重启一次。与
   * {@link noteAgentTeardown} 记的「循环保存会放出进程风暴」同源，故仅在**确有活会话**时才动手。
   * @param profileId - 刚保存的 profile id。
   */
  private recomposeLiveSessionsOf(profileId: string): void {
    const live = this.registry.liveAgentsOfProfile(profileId)
    if (live.length === 0) return
    for (const agent of live) {
      void reloadAgentPreset(this.ctx, agent.ctx, profileId, message => this.ctx.logger.warn(message))
    }
  }

  /**
   * 记录一次 agent 销毁（三处销毁点都会调）。
   *
   * 销毁本身是合法的（保存/删除 profile、重启自检），但**每次销毁都会让下一次使用重建整套
   * MCP** —— 实测 `saveProfile` 就会 `agents.delete`，所以「有人在循环保存 profile」会直接
   * 放出一模一样的进程风暴。这里连同调用栈记一条 info，让「销毁 → 重建」的配对在日志里可见。
   *
   * @param profileId - 被销毁的 agent 所属 profile。
   * @param where - 销毁点标识（saveProfile / deleteProfile / verify）。
   */
  private noteAgentTeardown(profileId: string, where: string): void {
    const stack = new Error().stack ?? ''
    this.ctx.logger.info(`corum-agent: agent torn down (${where}) for profile "${profileId}" — 下次使用会重建并重启其 MCP`)
    this.appendLifecycleDiag({ kind: 'torn-down', profileId, where, stack })
  }


  /**
   * 终态改动摘要（子会话改了哪些文件 / 进没进隔离台账）。
   *
   * 2026-09-21 按关注点抽到 `change-summary.ts`（两个 host 来源 + 全套降级路径）。
   * 这里只留一跳：本类不再知道 `corumReview` / `corumOrchestration` 的形状。
   *
   * 保留为**方法**而非直接调模块函数：`emitChangeSummary` 的调用点有 3 处（turn/end、
   * subagent/end 两条兜底路径），方法名让调用点读起来仍是「本服务的一件事」。
   */
  private async buildChangeSummary(childSessionId: string): Promise<SubagentChangeSummary | undefined> {
    return buildChangeSummaryOf(this.ctx, childSessionId)
  }

  /**
   * 终态改动摘要的异步补发（fire-and-forget 追加一帧带 `changeSummary` 的进度帧）。
   *
   * 摘要本体与降级路径见 `change-summary.ts`；发帧归进度跟踪器（它持有折叠表）。
   */
  private emitChangeSummary(childSessionId: string): void {
    emitChangeSummaryOf(this.ctx, childSessionId, (sid, summary) => {
      this.progress.emitTerminalFrame(sid, summary)
    })
  }

  /**
   * 从 AgentProfile id 创建（或复用）一个 root Agent。
   * @param profileId - AgentProfile id。
   * @param extraSetup - 可选：在 mount preset 之后、模型选择之前注入的额外
   *   能力（如 AgentRuntime 的 complete_task 工具）。仅在首次创建时执行。
   * @returns 创建的 root Agent 及其 preset id。
   */
  async createAgent(
    profileId: string,
    extraSetup?: (agentCtx: Context) => void,
  ): Promise<CreateAgentResult> {
    const existing = this.registry.profileAgent(profileId)
    if (existing !== undefined) return { agent: existing, presetId: profileId }

    // ① 并发去重（2026-09-18 护栏）：同一 profile 的创建在飞时复用同一个 promise。
    // 风暴形态是「销毁 → 重建」的串行循环，但并发请求也会把同一个 profile 建出多份、
    // 各挂一套 MCP；去重让「一份 profile 一个 agent」这条不变式在并发下也成立。
    const inFlight = this.registry.inFlightOf<CreateAgentResult>(profileId)
    if (inFlight !== undefined) return inFlight
    const task = this.createAgentUncached(profileId, extraSetup)
    this.registry.setInFlight(profileId, task)
    try {
      return await task
    } finally {
      // 无论成败都清（`finally` 语义）——失败的创建把键永久占住会让该 profile 再也建不出来。
      this.registry.clearInFlight(profileId)
    }
  }

  /**
   * 创建（或复用）一个 root Agent 的**未去重实现**（`createAgent` 负责并发去重与风暴护栏）。
   *
   * ⚠️ 不要直接调用本方法：绕过 `createAgent` 就等于绕过去重与护栏。
   */
  private async createAgentUncached(
    profileId: string,
    extraSetup?: (agentCtx: Context) => void,
  ): Promise<CreateAgentResult> {
    const profile = loadProfile(profileId)
    if (profile === undefined) {
      throw new Error(`dev-agent: profile "${profileId}" not found`)
    }
    if (!isValidProfileId(profile.id)) {
      throw new Error(`dev-agent: invalid profile id "${profile.id}"`)
    }

    // 1. 把绑定的 skill checkout 到 pinned commit（版本 pinning）。
    checkoutPinnedSkillsOf(this.ctx.logger, profile)

    // 2. 编译 + 落盘 preset 目录（含 agent.cordis.yml + preset.yml）。
    const dir = agentDirPath(profile.id)
    writeAgentDirOf(profile, dir)

    // 2. 创建 root Agent，setup 里 mount preset（官方组装链路）。
    const sessionId = SessionId(`corum-dev-${profile.id}-${randomUUID()}`)

    // 模型选择走官方 ModelSelection 通道：`agentOptions` 只有 provider/model/
    // maxTokens，reasoningEffort 由 installModelSelection 在 setup 里安装（官方
    // headless / api-proxy 同款做法）。塞进 agentOptions 会被 buildRequest 忽略。
    //
    // fork（corum）2026-09-26：预设模型可能已被删除（确定性配置缺失）——事前校验并回落
    // 全局默认，见 `model-availability.ts` 的概念分界表。
    const profileModel = (await resolveUsableModel(this.ctx, profile.model)).model
    const selection: ModelSelectionRef = {
      current: {
        provider: profileModel.provider,
        model: profileModel.model,
        ...(profileModel.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(profileModel.reasoningEffort) }),
      },
      assembled: undefined,
    }

    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: profile.id },
      agentOptions: {
        provider: profileModel.provider,
        model: profileModel.model,
      },
      // 官方 0.1.5：`AgentSetup` 为 `(agentCtx, agent)`，`agentCtx.agent` accessor 已删除
      // ⇒ 这里用第二参拿 agent（不再读 accessor）。
      setup: async (agentCtx: Context, agent: Agent) => {
        // 官方组装链路：mount preset，把 persona / 工具 / skill / MCP 全挂上。
        await this.ctx.agentPresets.mount(agentCtx, profile.id)
        // 额外能力注入（如 complete_task 工具），在 mount preset 之后。
        extraSetup?.(agentCtx)
        // 官方���型选择安装：把 provider/model/reasoningEffort 绑定到该 Agent 作用域。
        installTaskModelSelection(agentCtx, agent, selection)
      },
    })

    this.registry.registerProfileAgent(profileId, handle.agent)
    this.ctx.logger.info(`corum-agent: root agent created for profile "${profileId}" — ${sessionId}`)
    this.noteAgentCreated(profileId)
    return { agent: handle.agent, presetId: profile.id }
  }

  // 项目模式剥离（2026-09-26）：`createAgentForType` / `createAgentForLane`、
  // `laneSetupHooks` / `registerLaneSetupHook`、以及三个 project-lane @Remote 端点
  // （createAgentForType / runPromptForType / getSessionEventsForType）**整体迁出**
  // 到闭源仓 Corum-Harness-Project 的 `@corum/corum-project`（它们只服务项目团队会话）。
  // 本类的 task 模式面（createAgentForTask 及以下）不自洽于泳道机制，保持不变。

  /**
   * 按 sessionId 反查泳道归属（权限网关的可信身份来源）。
   * 只识别本服务创建/恢复、且当前仍登记在存活表里的泳道会话。
   */
  resolveLaneBySessionId(sessionId: string): { projectId: string; profileId: string; type: string; laneKey: string; requirementId?: string } | undefined {
    return this.registry.laneOf(sessionId)
  }

  /** 获取一个已存活的 (project, profile, type) 会话 Agent。 */
  getAgentForType(projectId: string, profileId: string, type: string = GENERAL_WORK_TYPE): Agent | undefined {
    return this.registry.laneAgent(projectId, profileId, type)
  }

  /** 获取一个已存活的泳道会话 Agent（按路由标签）。 */
  getAgentForLane(projectId: string, profileId: string, laneKey: string): Agent | undefined {
    return this.registry.laneAgent(projectId, profileId, laneKey)
  }

  /**
   * 登记一条泳道会话（同时写「泳道表」与「泳道归属索引」）。
   *
   * **可见性（2026-09-26 项目模式剥离）**：泳道会话的**创建**编排已随项目模式
   * 迁到闭源仓 `@corum/corum-project`，但泳道表仍由本服务（`AgentRegistry`）持有
   * ——登记册必须唯一（`applySubagentModelForSession` 与权限网关都经它取可信身份）。
   * 故在这里开一个公共登记口，闭源侧装配完会话后回填；**只开可见性，不搬表**。
   *
   * @param projectId - 项目 id（团队属项目，会话隔离边界）。
   * @param profileId - 角色 profile id。
   * @param lane - 泳道描述（key=路由标签，type=工作类型语义）。
   * @param agent - 已创建的 root Agent。
   * @param sessionId - 该泳道会话 id。
   */
  registerLaneAgent(projectId: string, profileId: string, lane: AgentLaneDescriptor, agent: Agent, sessionId: SessionId): void {
    this.registry.registerLane(projectId, profileId, lane, agent, sessionId)
  }

  /**
   * 查统一会话索引：某 (工作区, profile, 泳道) 会话是否已持久化。
   * 返回其 sessionId（供 resume），未登记返回 undefined。
   *
   * **可见性（2026-09-26 项目模式剥离）**：原为 `private`，项目模式迁到闭源仓后
   * 由 `@corum/corum-project` 的泳道装配调用——闭源仓不得绕过本服务的公共面直读
   * 索引，故提为 public（**只改可见性，逻辑逐字未动**）。
   *
   * 「按工作区判」是修 `bug.task-lane-reuse-misses-project-sessions` 的关键：
   * 旧实现 `lookupPersistedSessionId(projectId, …)` 用 **projectId** 作账本边界，
   * 而 task 模式用的是伪 projectId——同一工作区在两种模式下各有一本账，互不可见。
   * 改为按 **cwd** 查统一索引后，两模式共享同一本账。
   *
   * @param cwd - 工作区目录（闭源仓由项目索引条目解析后传入）。
   */
  lookupPersistedSessionId(cwd: string | undefined, profileId: string, type: string): SessionId | undefined {
    if (cwd === undefined || cwd === '') return undefined
    const found = findSessionByLane(profileId, type, cwd)
    return found === undefined ? undefined : SessionId(found)
  }

  /**
   * 把一个 (工作区, profile, 泳道) → sessionId 登记进统一会话索引。
   *
   * **可见性（2026-09-26 项目模式剥离）**：同 {@link lookupPersistedSessionId}，
   * 提为 public 供闭源 `@corum/corum-project` 的泳道装配登记（只改可见性，逻辑未动）。
   *
   * @param sessionId - 泳道会话 id。
   * @param cwd - 工作区目录（缺省则无法按工作区建账——统一模型的身份由 cwd 决定）。
   * @param profileId - 角色 profile id。
   * @param type - 泳道路由标签（进索引的 `laneKey` 段）。
   * @param projectType - 工作区**工程类型**（`project` | `task`）；缺省 `project`
   *   （闭源仓的项目泳道恒为 project 模式）。
   */
  registerLaneSessionId(
    sessionId: SessionId,
    cwd: string | undefined,
    profileId: string,
    type: string,
    projectType: ProjectType = DEFAULT_PROJECT_TYPE,
  ): void {
    if (cwd === undefined || cwd === '') {
      // 无工作区的项目（cwd 缺省）无法按工作区建账——统一模型的身份由 cwd 决定。
      this.ctx.logger.warn(`corum-agent: 无 cwd 的泳道会话，跳过会话索引登记（${String(sessionId)}）`)
      return
    }
    registerSession(String(sessionId), {
      cwd,
      profileId,
      type: projectType,
      laneKey: type,
    })
  }



  /** 获取已创建的 Agent（未创建返回 undefined）。 */
  getAgent(profileId: string): Agent | undefined {
    return this.registry.profileAgent(profileId)
  }

  /**
   * 把一个提示词驱动给 profile 对应的 root Agent，等它跑到 quiescence 后
   * 汇总最终回复文本。
   * @param profileId - AgentProfile id。
   * @param prompt - 用户提示词文本。
   * @returns 最终 assistant 文本（多段 text 拼接）。
   */
  async runProfile(profileId: string, prompt: string): Promise<string> {
    const { agent } = await this.createAgent(profileId)
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    return summarizeText(agent.session.snapshotEvents(), firstSeq)
  }

  // ── TypertRemoteService @Remote 端点（/api/corumAgent/*） ──────────

  /**
   * 列出所有 AgentProfile 摘要（新建任务表单 Agent 下拉数据源）。
   * 合并两个目录（2026-09-02 用户定调「并列展示」）：
   * - **corum profile**（$CORUM_HOME/.agent-presets：研发/PM 助理/测试/Task 助理，
   *   继承 standard 全量 + 各自 persona/模型差异）；
   * - **官方 preset**（cordis/minimal/ptc/standard，agentPresets 服务目录）——
   *   架构调整后与 corum 同构可直接 mount；模型跟随部署默认
   *   （`agentDefaultModel.currentSelection()`），`trust` 保留。
   * 官方 preset 与 corum profile id 冲突时 corum 优先（corum 是官方拓展）。
   */
  @Remote('listProfiles')
  async listProfilesRemote(): Promise<{ profiles: ProfileSummary[] }> {
    const corumProfiles = listProfiles().map(p => ({
      id: p.id,
      ...(p.nickname !== undefined ? { nickname: p.nickname } : {}),
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.dimension !== undefined ? { dimension: p.dimension } : {}),
      ...(p.experience !== undefined ? { experience: p.experience } : {}),
      ...(p.persona !== undefined ? { persona: p.persona } : {}),
      ...(p.personaPreset !== undefined ? { personaPreset: p.personaPreset } : {}),
      ...(p.avatar !== undefined ? { avatar: p.avatar } : {}),
      baseMode: p.baseMode,
      prompt: p.prompt,
      model: p.model,
      ...(p.subagentModel !== undefined ? { subagentModel: p.subagentModel } : {}),
      ...(p.researchModel !== undefined ? { researchModel: p.researchModel } : {}),
      ...(p.parallelWork !== undefined ? { parallelWork: p.parallelWork } : {}),
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: { mode: p.terminal.mode },
      memoryEnabled: p.memoryPolicy.scope !== 'none',
      version: p.version,
      trust: p.trust,
      source: 'corum' as const,
    }))
    const corumIds = new Set(corumProfiles.map(p => p.id))
    // 官方 preset 目录——只保留用户点名的四种模式（cordis/minimal/ptc/standard）；
    // shipped-presets 的 `code`（PTC 的桌面发货变体）与 corum 重名项/broken 过滤。
    const OFFICIAL_MODE_IDS = new Set([CONDUCTOR_PRESET_ID, 'cordis', 'minimal', 'ptc', 'standard'])
    const officialPresets = (await this.ctx.agentPresets.list())
      .filter(p => OFFICIAL_MODE_IDS.has(p.id) && p.broken === undefined && !corumIds.has(p.id))
    const defaultModel = this.ctx.agentDefaultModel.currentSelection()
    const officialProfiles = officialPresets.map(p => ({
      id: p.id,
      // 官方 preset 的显示名（name 如「标准模式」），回落 id。
      ...(p.name !== undefined ? { nickname: p.name } : {}),
      // prompt 不回填（preset 的 persona 在组合里，不在 roster 元数据）——
      // 表单只显示 nickname + 模型，prompt 不进 UI 投影。
      prompt: p.description ?? '',
      model: {
        provider: defaultModel.provider,
        model: defaultModel.model,
        ...(defaultModel.reasoningEffort === undefined ? {} : { reasoningEffort: defaultModel.reasoningEffort }),
      },
      skills: [],
      mcpServers: [],
      terminal: { mode: 'sandbox' },
      version: 1,
      trust: p.trust,
      source: 'official' as const,
    }))
    const configuredDefault = this.readConfiguredDefaultPreset()
    return { profiles: [...corumProfiles, ...officialProfiles], ...(configuredDefault !== undefined ? { defaultProfileId: configuredDefault } : {}) }
  }

  /** 创建（或复用）一个 root Agent，返回状态。 */
  @Remote('createAgent')
  async createAgentRemote(profileId: string): Promise<{ status: AgentStatus }> {
    await this.createAgent(profileId)
    return { status: { profileId, created: true } }
  }

  /** 用指定 profile 的 Agent 跑一个 prompt，返回回复文本 + 过程事件。 */
  @Remote('runPrompt')
  async runPromptRemote(profileId: string, prompt: string): Promise<RunPromptResult> {
    const { agent } = await this.createAgent(profileId)
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    const reply = summarizeText(agent.session.snapshotEvents(), firstSeq)
    const events: SessionEventDto[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq < firstSeq) continue
      events.push({
        seq: event.seq,
        type: event.type,
        data: simplifyEventData(event),
        time: event.time,
      })
    }
    // 从 request/header 事件提取最终装配的 system prompt + 工具列表
    const { systemPrompt, tools } = extractHeader(agent.session.snapshotEvents(), firstSeq)
    return { reply, events, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(tools !== undefined ? { tools } : {}) }
  }

  /**
   * 保存（创建或更新）一个 AgentProfile，并编译落盘整个 Agent 目录。
   *
   * Skill 采用引用绑定 + 版本 pinning：
   *   agent.json 的 skills 字段记录 SkillBinding[] {name, commitHash}。
   *   Agent mount 前把 skill checkout 到 pinned commit。
   *   Skill 全局统一管理在 <CORUM_HOME>/skills/（由 dev-skill-manager 管理导入）。
   */
  @Remote('saveProfile')
  saveProfileRemote(input: SaveProfileInput): { profile: ProfileSummary } {
    if (!isValidProfileId(input.id)) {
      throw new Error(`corum-agent: invalid profile id "${input.id}"`)
    }
    // fork（corum）2026-09-29（用户裁决）：minimal 模式保持官方原汁原味，用户自建预设
    // 不再允许继承此模式。只内置「极简模式」(minimal-assistant) 可用 baseMode:'minimal'。
    // 详见 profile.ts 的 assertBaseModeAllowedForPreset。
    assertBaseModeAllowedForPreset({ id: input.id, baseMode: input.baseMode, trust: input.trust })
    const profile: AgentProfile = {
      id: input.id,
      ...(input.nickname !== undefined && input.nickname.trim() !== '' ? { nickname: input.nickname.trim() } : {}),
      ...(input.title !== undefined && input.title.trim() !== '' ? { title: input.title.trim() } : {}),
      ...(input.dimension !== undefined && isValidAgentDimension(input.dimension) ? { dimension: input.dimension } : {}),
      ...(input.experience !== undefined && input.experience.trim() !== '' ? { experience: input.experience.trim() } : {}),
      ...(input.persona !== undefined && input.persona.trim() !== '' ? { persona: input.persona.trim().slice(0, 500) } : {}),
      ...(input.personaPreset !== undefined && isValidPersonaPreset(input.personaPreset) ? { personaPreset: input.personaPreset } : {}),
      ...(input.avatar !== undefined && input.avatar.trim() !== '' ? { avatar: input.avatar.trim() } : {}),
      baseMode: input.baseMode,
      prompt: input.prompt,
      model: input.model,
      ...(input.subagentModel !== undefined ? { subagentModel: input.subagentModel } : {}),
      ...(input.researchModel !== undefined ? { researchModel: input.researchModel } : {}),
      ...(input.parallelWork !== undefined ? { parallelWork: input.parallelWork } : {}),
      skills: input.skills,
      mcpServers: input.mcpServers,
      terminal: input.terminal,
      memoryPolicy: input.memoryPolicy,
      version: 0,
      trust: input.trust,
    }
    // 补偿基准：第一次写盘**之前**取存量快照（补偿变化检测用；进 persistProfileAndRecompile
    // 时盘上已是新值，再取就失真了——见该方法的注释）。
    const previousSnapshot = loadProfile(input.id)

    // 机制自有字段必须**原样带过**：它们不在 `SaveProfileInput`（UI 可编辑子集）里，客户端
    // 也拿不到。`specBaseline` 记录「spec 上次写下的值」，保存时丢掉它 ⇒ `refreshFromSpec`
    // 会把**用户当前值**误当成 spec 值 ⇒ 用户自定义从此可被后续 spec 升级静默覆盖
    // （2026-09-27 实测 `conductor-lead` 的 agent.json 带此字段，而它会被任何一次保存丢掉）。
    //
    // 纪律：今后任何**不由 SaveProfileInput 承载**的 AgentProfile 字段，都要在这里显式带过；
    // 想加通用「保留所有未知字段」的合并要慎重——白名单里那些「留空即清除」的字段语义会被
    // 存量值反向复活（既有语义：入参留空 = 清掉该字段）。
    if (previousSnapshot?.specBaseline !== undefined) {
      profile.specBaseline = previousSnapshot.specBaseline
    }
    saveProfile(profile)

    // 编译并落盘 agent.cordis.yml + preset.yml
    this.persistProfileAndRecompile(profile, previousSnapshot)

    // 清掉旧 Agent 使下次重建
    this.noteAgentTeardown(input.id, 'saveProfile')
    this.registry.forgetProfileAgent(input.id)
    // fork（corum）2026-09-27（用户需求：「MCP 配置保存后实时生效，不要重启软件」）：
    // 上面那两行只让**下次**使用重建（root/profile 侧），**正在跑的 task 泳道会话**不在其中
    // —— 它们的 agent 被会话持有，官方 `agentPresets.select` 又对已开始的会话抛
    // `agent-preset/locked` ⇒ 用户在会话中加的 MCP 行**永远**到不了那个会话（实测复现：
    // 父无 MCP、子会话挂父的 live preset 也无）。这里补上「对在跑的会话就地重挂」。
    this.recomposeLiveSessionsOf(input.id)
    const saved = loadProfile(input.id)!
    return {
      profile: {
        id: saved.id,
        ...(saved.nickname !== undefined ? { nickname: saved.nickname } : {}),
        ...(saved.title !== undefined ? { title: saved.title } : {}),
        ...(saved.dimension !== undefined ? { dimension: saved.dimension } : {}),
        ...(saved.experience !== undefined ? { experience: saved.experience } : {}),
        ...(saved.persona !== undefined ? { persona: saved.persona } : {}),
        ...(saved.personaPreset !== undefined ? { personaPreset: saved.personaPreset } : {}),
        ...(saved.avatar !== undefined ? { avatar: saved.avatar } : {}),
        baseMode: saved.baseMode,
        prompt: saved.prompt,
        model: saved.model,
        ...(saved.subagentModel !== undefined ? { subagentModel: saved.subagentModel } : {}),
        ...(saved.researchModel !== undefined ? { researchModel: saved.researchModel } : {}),
        ...(saved.parallelWork !== undefined ? { parallelWork: saved.parallelWork } : {}),
        skills: saved.skills,
        mcpServers: saved.mcpServers,
        terminal: { mode: saved.terminal.mode },
        memoryEnabled: saved.memoryPolicy.scope !== 'none',
        version: saved.version,
        trust: saved.trust,
        source: 'corum' as const,
      },
    }
  }

  /**
   * 机制面（供委派机制调用，非 LLM 工具）：把某会话所用 Agent 预设的**子 Agent 模型**改成终值，
   * 永久生效（写入该预设的 agent.json 并重新编译其 cordis 预设）。
   *
   * role='worker' ⇒ profile.subagentModel；role='research' ⇒ profile.researchModel。
   * route 传 undefined ⇒ **清除该键**（语义 = 跟随主 Agent，见 compile.ts 的两档口径）。
   *
   * @param sessionId - 会话 id（用其 Agent 预设作为写入目标）。
   * @param role - 子 Agent 角色（worker / research）。
   * @param route - 目标模型路由；undefined 表示「跟随主 Agent」。
   * @returns 实际写入的预设 id，以及该角色写入后的值（undefined = 已清除/跟随主 Agent）。
   * @throws 当会话不是存活 Agent，或解析不到其预设时。
   */
  applySubagentModelForSession(
    sessionId: string,
    role: 'worker' | 'research',
    route: { provider: string; model: string; reasoningEffort?: string } | undefined,
  ): { presetId: string; applied: { provider: string; model: string; reasoningEffort?: string } | undefined } {
    // 预设 id 用 session projection（agentPreset）权威解析——与官方
    // session-controller 的 presetForSession 同口径：它反映会话**当前**运行的
    // preset（blank 期切换过 preset 的会话，creation header 已过时）。
    // 都查不到 ⇒ 会话不是本进程存活的 Agent ⇒ fail-loud，绝不静默
    // 回落默认预设（写错预设 = 用户以为改了 A 实际改了 B）。
    //
    // ⚠️ 第三个来源 `this.ctx.agents.get` 不是冗余（2026-09-19 实机：永久档在 IDE
    // 「新会话」路径上恒失败，报「不是本进程存活的 Agent 会话」）。两张 corum 自有的
    // 存活表（taskAgents / typeAgents）只登记 corum 自己创建的泳道会话；而 IDE 侧
    // 直接经官方 sessions/agents 建起的会话在本进程**确实存活**，却不在那两张表里。
    // 官方 registry 才是「本进程存活」的权威口径（同文件 2083 行恢复逻辑也用它）。
    const live = this.registry.task(sessionId)
      ?? this.findLaneAgent(sessionId)
      ?? (() => {
        const agent = this.ctx.agents.get(SessionId(sessionId))
        return agent === undefined ? undefined : { agent, sessionId: SessionId(sessionId) }
      })()
    if (live === undefined) {
      throw new Error(`corum-agent: applySubagentModelForSession — session "${sessionId}" 不是本进程存活的 Agent 会话`)
    }
    // ⚠️ 必须用 `ctx.get('sessionProjections')` 而**不是** `(this.ctx as …).sessionProjections`：
    // 本服务的 `static inject` 里**没有** sessionProjections，而 cordis 对**属性访问**在
    // 未 inject 时直接抛 `cannot get property "sessionProjections" without inject`
    // （vendor/cordis/src/reflect.ts:144）；`get(name)` 则无此门禁（同文件 233-243）。
    // 2026-09-18 实机：永久档第一次点「跟随主 Agent」就是死在这个抛错上——而它被
    // 上游 catch 成一句含糊的「保存失败」，靠改进错误文案才定位到真因。
    const projections = this.ctx.get('sessionProjections' as never) as AgentPresetProjections | undefined
    const presetId = projections?.stateOf(live.agent.session, 'agentPreset') ?? undefined
    if (presetId === undefined || presetId === null || presetId === '') {
      throw new Error(`corum-agent: applySubagentModelForSession — 解析不到会话 "${sessionId}" 的 Agent 预设（agentPreset 投影为空）`)
    }
    // saveProfile 只浅拷贝入参对象并整体覆盖落盘（{...profile, version, trust}），
    // **不与存量合并** —— 传部分对象会把没带的字段静默清掉（台账事故
    // lesson.profile.saveProfile-needs-full-input-and-summary-omits-memoryPolicy：
    // memoryPolicy 被丢后 listProfiles 全体加载失败）。所以必须先 loadProfile 拿
    // **完整**对象，只改目标键，再把整个对象传回去。
    const profile = loadProfile(presetId)
    if (profile === undefined) {
      throw new Error(`corum-agent: applySubagentModelForSession — 会话 "${sessionId}" 的预设 "${presetId}" 不存在 agent.json`)
    }
    if (route === undefined) {
      // 清除 = 删除键本身（不用 `key: undefined` 占位——虽然 JSON.stringify 会丢掉
      // undefined 值，但显式 delete 让内存对象与磁盘 JSON 形态一致，不靠隐式行为）。
      if (role === 'worker') delete profile.subagentModel
      else delete profile.researchModel
    } else {
      const value = {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
      }
      if (role === 'worker') profile.subagentModel = value
      else profile.researchModel = value
    }
    this.persistProfileAndRecompile(profile)
    const applied = role === 'worker' ? profile.subagentModel : profile.researchModel
    return { presetId, applied: applied === undefined ? undefined : { ...applied } }
  }

  /** 删除一个 AgentProfile。 */
  @Remote('deleteProfile')
  deleteProfileRemote(id: string): { ok: boolean } {
    if (!isValidProfileId(id)) throw new Error(`corum-agent: invalid profile id "${id}"`)
    // 系统级预置 Agent（trust:'system'，开发者模式编排固化）不可删除。
    const existing = loadProfile(id)
    if (existing?.trust === 'system') {
      throw new Error(`corum-agent: profile "${id}" 是系统级预置 Agent，不可删除`)
    }
    this.noteAgentTeardown(id, 'deleteProfile')
    this.registry.forgetProfileAgent(id)
    deleteProfile(id)
    return { ok: true }
  }

  /** 获取已创建 Agent 的会话事件快照（从指定 seq 开始）。 */
  @Remote('getEvents')
  getEventsRemote(profileId: string, fromSeq: number): { events: SessionEventDto[] } {
    const agent = this.registry.profileAgent(profileId)
    if (agent === undefined) return { events: [] }
    const events: SessionEventDto[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq < fromSeq) continue
      events.push({
        seq: event.seq,
        type: event.type,
        data: simplifyEventData(event),
        time: event.time,
      })
    }
    return { events }
  }

  // 项目模式剥离（2026-09-26）：project-lane 三个 @Remote 端点
  // （`createAgentForType` / `runPromptForType` / `getSessionEventsForType`）
  // 已随项目模式迁到闭源仓 `@corum/corum-project`。RPC **面**随之移动而非删除
  // ——闭源插件在 `/api/corumProject/*` 上重新暴露同名端点。

  // ── task 模式泳道（单任务会话，corum-task-* session id，与 project 泳道隔离） ──

  /**
   * 未显式指定时的 task 默认预设：读 `agent-presets` settings 命名空间的 `default` 字段。
   *
   * 通路选择说明（AGENTS.md 红线 4）：`ctx.get('settings')` 是只读获取未注入的 settings
   * 服务的安全路径——参照同文件 `outputLanguageVariable` 的先例（约 569 行，同样用
   * `ctx.get('settings')` 读 `locale` 命名空间）。settings 服务在 boot 早期可能尚未挂载
   * ⇒ `ctx.get` 返回 undefined，此处容忍并回落。**热更新生效**：settings 文档每次
   * `get()` 都重新读取（uSES 源），故改了默认预设后**下一次** `createAgentForTask` 即生效。
   *
   * 与官方 `AgentPresets.defaultId` 的差异：`defaultId` 在用户未配置时回落到
   * `config.default`（部署默认，可能是 `standard` 等官方模式）；而 task 泳道在
   * 用户未配置时应回落 `TASK_PROFILE_ID`（内置 task profile），语义不同——
   * 「未配置 = 用机制内置 task 默认」，不是「用部署默认 preset」。
   *
   * 配置的预设 id 只做**corum profile 存在性校验**（`loadProfile`）；官方 preset id
   * 不做同步校验（本服务不持有官方 preset 目录，mount 时会校验），失效的官方 id
   * 会在 mount 处抛 `agent-preset/not-found`，错误可诊断。corum profile 不存在时
   * 回落 `TASK_PROFILE_ID` + warn 日志——建任务链路不该被一条陈旧配置卡死。
   */
  private resolveDefaultTaskProfileId(): string {
    const settings = this.ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
    const view = settings?.get?.('agent-presets') as { value?: { default?: string }; user?: { default?: string } } | undefined
    const configured = view?.user?.default ?? view?.value?.default
    if (typeof configured === 'string' && configured.trim() !== '') {
      const id = configured.trim()
      // 配置的预设必须在册（corum profile），否则静默回落会让用户以为生效了。
      if (loadProfile(id) !== undefined) return id
      // 官方 preset：本服务不持有目录（在 ctx.agentPresets），mount/resolve 会在
      // 后面校验；此处无法同步确认其存在 ⇒ 放行（沿用 isOfficialPreset 分支判定）。
      // 失效的官方 id 会在 mount 处抛 agent-preset/not-found，错误可诊断。
      this.ctx.logger.warn(`corum-agent(task): configured default "${id}" not found in corum profiles — may be official preset (will validate on mount)`)
      return id
    }
    return TASK_PROFILE_ID
  }

  /**
   * 读 `agent-presets.default` 的**用户配置值**（不做 TASK_PROFILE_ID 回落）。
   *
   * 供 `listProfilesRemote` 把默认值透传给 UI（空态表单用它初始化下拉选中项）。
   * 与 {@link resolveDefaultTaskProfileId} 的差异：后者在建任务时回落
   * `TASK_PROFILE_ID`（机制内置默认），而 UI 侧「未配置」应回落列表第一项
   * （由调用方处理），故这里返回 `undefined`。
   */
  private readConfiguredDefaultPreset(): string | undefined {
    const settings = this.ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
    const view = settings?.get?.('agent-presets') as { value?: { default?: string }; user?: { default?: string } } | undefined
    const configured = view?.user?.default ?? view?.value?.default
    if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
    return undefined
  }

  /**
   * 创建（或按 cwd+profile 恢复）一个 task 模式单任务会话 Agent。
   *
   * task 模式与 project 模式的差异：task 会话是「用户在某工作区直接发起的单任务
   * 对话」，无项目/团队/需求概念——不强绑 projectId、不校验项目组成员、lane 无
   * requirementId。复用与 project 泳道同一套内核（preset 编译落盘 + mount 组装 +
   * resume 冷恢复 + simplifyEventData 投影），但 sessionId 用 corum-task-* 形态、
   * cwd 取用户工作区路径，与 project 泳道（corum-proj 系 / corum-dev 系）互相不可见。
   *
   * 创建（或复用）一个 task 模式单任务会话 Agent，并**归属到官方 workspace**。
   *
   * 2026-08-30 修正「新建任务落在未分组」：原实现直接 `ctx.agents.create`，
   * 绕过了官方 `session.create` 的 `workspace.attachSession()`——侧栏分组按
   * `WorkspaceView.sessionIds`（不是 cwd 匹配），没 attach 就落「未分组」桶。
   * attach 硬要求 `realpath(session.cwd) === workspace.path`，故入参目录必须先
   * realpath 归一（macOS /tmp→/private/tmp 一类 symlink 会直接拒接）。
   *
   * **复用语义（官方 connectWorkspace 同款）**：目标工作区里已有 **blank（未发
   * 过消息）** 的 task 泳道时直接复用它，不新建——用户连点「新建任务」不会堆
   * 出一串空会话（官方：「A created session is blank by definition」+ 侧栏
   * 「blank 仅当前选中时可见」）。
   *
   * @param cwd - 工作区目录（task 会话的工作现场，创建后不可改）。
   * @param profileId - Agent profile id（可选，缺省解析 `agent-presets.default` settings）。
   *   未传时走 {@link resolveDefaultTaskProfileId}：读 settings 命名空间
   *   `agent-presets` 的 `default` 字段；配置存在且在册用之，否则回落 `TASK_PROFILE_ID`。
   * @param permission - 访问权限档位（`read-only`/`workspace-write`/
   *   `danger-full-access`，缺省沿用全局默认）。经官方 `permissionPresets.set`
   *   写入：先落 `permission/preset` 事件，再由 `setSandboxMode`/`setApprovalPolicy`
   *   写两个旋钮——与官方「新建会话固定权限」语义一致，只是用调用方指定的档位
   *   覆盖全局默认值。
   * @returns 创建/恢复结果 + 该会话的 sessionId（corum-task-<rand>）。
   */
  async createAgentForTask(cwd: string, profileId?: string, permission?: string, model?: ProfileModel): Promise<CreateAgentResult & { sessionId: SessionId }> {
    const effectiveProfileId = profileId ?? this.resolveDefaultTaskProfileId()
    // 判定表门禁（不变式 C：互斥）——**本方法是「task 模式」入口**，故按 task 口径校验。
    // 用户 2026-09-14 裁定：「如果是 task 模式打开一个 project 项目，则提示用户是项目
    // 模式，是否按照项目模式开启。**拒绝按照 task 模式开启**。」
    // 缺此校验时本入口会绕开门禁直接在 project 工作区里建 task 会话，破坏不变式 C。
    // ⚠️ 用 realpath 归一查（同「一工作区一条目」身份口径）。
    // 项目模式剥离（2026-09-26）：原走 `findProjectByCwd`（闭源 project-store），
    // 现走 workspace-identity 的**最小只读索引读取器**——只读索引轻字段
    // （id/name/cwd/type），不依赖任何项目侧数据，两仓共用同一份磁盘契约
    // （`$CORUM_HOME/projects/<id>/project.json`）。
    const owner = findWorkspaceEntryByCwd(cwd)
    if (owner !== undefined) {
      const stored = workspaceEntryTypeOf(owner)
      if (stored === 'project') {
        throw new Error(
          `dev-agent: 工作区 "${cwd}" 已是项目模式（project ${owner.id}）——无法以任务模式开启。`
          + '请按项目模式打开该工作区（同一工作区只能有一个类型）。',
        )
      }
    }
    // effectiveProfileId 双源（2026-09-02 并列展示）：corum profile（研发/PM 助理/测试/Task
    // 助理，loadProfile 加载）或**官方 preset**（cordis/minimal/ptc/standard，
    // agentPresets 目录——直接 mount preset id，无 corum profile 实体）。
    const isOfficialPreset = effectiveProfileId !== TASK_PROFILE_ID && loadProfile(effectiveProfileId) === undefined
    let profile: AgentProfile
    if (isOfficialPreset) {
      // 官方 preset：persona 在组合里（profile.prompt 只用于 UI 显示/校验占位）；
      // 模型跟随部署默认（official preset 不绑定固定模型）。
      const dm = this.ctx.agentDefaultModel.currentSelection()
      profile = {
        id: effectiveProfileId,
        baseMode: 'standard',
        prompt: '',
        model: model ?? {
          provider: dm.provider,
          model: dm.model,
          ...(dm.reasoningEffort === undefined ? {} : { reasoningEffort: dm.reasoningEffort }),
        },
        skills: [],
        mcpServers: [],
        terminal: { mode: 'sandbox' },
        memoryPolicy: { scope: 'agent' },
        version: 1,
        trust: 'system',
      }
    } else {
      const loaded = effectiveProfileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(effectiveProfileId)
      if (loaded === undefined) throw new Error(`dev-agent: profile "${effectiveProfileId}" not found`)
      profile = loaded
    }
    if (!isValidProfileId(profile.id)) throw new Error(`dev-agent: invalid profile id "${profile.id}"`)
    // 设计稿「新建任务表单可选模型」：默认用 profile.model，调用方可覆盖
    // （「选好工作区和 Agent 后自动加载默认模型，用户仍可改」）。
    //
    // fork（corum）2026-09-26：**预设引用的模型可能已被删除**（用户手动删模型 / 换供应商 /
    // 清理目录）。那是**确定性的配置缺失**，与「运行期调用失败」是两个概念——后者才走
    // 「问用户」（2026-09-18 用户拍板），前者必须在**创建之前**就识别并回落全局默认，
    // 否则每个新会话都在第一句硬失败（实测 corum-task-b36de140：`UNKNOWN_MODEL`）。
    // 见 `model-availability.ts` 头的概念分界表。
    const resolvedModel = await resolveUsableModel(this.ctx, model ?? profile.model)
    const effectiveModel = resolvedModel.model
    if (resolvedModel.fallback !== undefined) {
      // 告知责任交给「会话建好之后」的那一步（见下方 notifyModelFallback）——此刻会话
      // 还不存在，且这里不能发消息（会把 blank 泳道变成非 blank，破坏泳道复用）。
      this.ctx.logger.warn(
        `corum-agent(task): configured model ${resolvedModel.fallback.configured.provider}/${resolvedModel.fallback.configured.model} `
        + `is unavailable (${resolvedModel.fallback.reason}); falling back to ${effectiveModel.provider}/${effectiveModel.model}`,
      )
    }

    // 目录 realpath 归一：workspace.attachSession 硬要求 realpath(cwd) === ws.path，
    // 否则抛错 → 会话落「未分组」（macOS /tmp→/private/tmp 一类 symlink 会踩）。
    const root = realpathSync(cwd)

    // 不变式①（invariant.workspace-git-required）的机制门禁：创建任务泳道**之前**
    // 强制「探测，没有就初始化」——不再依赖 UI 层自觉调 ensureRepo（旧缺口的根因：
    // 新目录建任务可经 RPC/直调绕过 UI 直命中本入口）。git-core 是 corum 核心插件
    // （不可卸载）；此处同进程直调 assertGitWorkspace，失败（目录不可写/git 缺失）
    // fail-loud 阻断创建，不静默降级。
    await this.ctx.gitCore.assertGitWorkspace(root)

    // 复用目标工作区里已有的 blank task 泳道（官方 connectWorkspace 语义）：
    // 连点「新建任务」不该堆一串空会话。
    const reuse = findBlankTaskLaneOf(this.ctx, root)
    if (reuse !== undefined) {
      this.ctx.logger.info(`corum-agent(task): reuse blank lane — ${reuse} (cwd=${root})`)
      const resolved = await this.resolveTaskAgent(reuse)
      if (resolved !== undefined) {
        // fork（corum）：复用的 blank 泳道必须兑现本次新建表单的 Agent/模型选择——
        // 此前实现静默沿用泳道创建时的 profile/model，用户在「新建任务」表单里
        // 改选 Agent 或模型后开始的对话仍是旧配置（2026-09-07 用户实测反馈）。
        // 泳道是 blank（未发消息），官方 agentPresets.select 的 blank 限定成立，
        // 可安全换绑：select 重组 scoped 工具链并记 agent-preset/selected，
        // installModelSelection 重装模型绑定；task 索引/存活表/落盘目录同步。
        if (resolved.profileId !== profile.id) {
          // 先编译落盘再 select（docs/fork-delta.md §8 note 3）：select/mount 要读
          // .agent-presets/<id>/agent.cordis.yml——从未编译的 corum profile（有
          // agent.json 但产物缺失）若先 select 会报 composition missing、writeAgentDir
          // 永远到不了。官方 preset 无 corum profile 实体——跳过编译落盘
          // （同 selectTaskAgentProfile）。
          if (!isOfficialPreset) writeAgentDirOf(profile, agentDirPath(profile.id))
          await this.ctx.agentPresets.select(resolved.agent, profile.id)
          registerTaskSessionOf(resolved.sessionId, resolved.cwd, profile.id)
          this.registry.registerTask({ ...resolved, profileId: profile.id })
          // fork（corum）：换绑后指挥模式口径必须跟随新 preset（旧限制先撤销）。
          this.conductor.apply(
            String(resolved.sessionId),
            resolved.agent.ctx,
            conductorModeOf(profile.id, isOfficialPreset, effectiveExecutionTools(profile)),
          )
          this.ctx.logger.info(`corum-agent(task): reused lane preset switched — ${reuse} → ${profile.id}`)
        }
        const reuseSelection: ModelSelectionRef = {
          current: {
            provider: effectiveModel.provider,
            model: effectiveModel.model,
            ...(effectiveModel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effectiveModel.reasoningEffort) }),
          },
          assembled: undefined,
        }
        installTaskModelSelection(resolved.agent.ctx, resolved.agent, reuseSelection)
        this.registry.setTaskSelection(String(resolved.sessionId), reuseSelection)
        // 复用的是 blank 泳道（还没发过消息），同样只记内存、不写盘。
        this.rememberPendingPermission(String(resolved.sessionId), permission)
        // fork（corum）2026-09-26：复用路径同样要告知模型回落（用户选的是「新建任务」，
        // 走哪条内部路径对用户不可见）。
        if (resolvedModel.fallback !== undefined) {
          this.notifyModelFallbackOnce(String(resolved.sessionId), resolved.agent, resolvedModel.fallback, `新建任务（${profile.id}）`)
        }
        return { agent: resolved.agent, presetId: profile.id, sessionId: resolved.sessionId }
      }
    }

    // 一个工作区多个会话：每次新建独立 sessionId（corum-task-<rand>），不按 cwd 复用。
    const sessionId = SessionId(`corum-task-${randomBytes(4).toString('hex')}`)

    const selection: ModelSelectionRef = {
      current: {
        provider: effectiveModel.provider,
        model: effectiveModel.model,
        ...(effectiveModel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effectiveModel.reasoningEffort) }),
      },
      assembled: undefined,
    }
    // 见 root-agent 路径的同款注释：0.1.3 单参 setup，升级后改 `(agentCtx, agent)`。
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, profile.id)
      // ⚠️ 0.1.5 升级后改为 `installTaskModelSelection(agentCtx, agent, selection)`。
      installTaskModelSelection(agentCtx, agent, selection)
      // fork（corum）：指挥模式 / orchestrator profile——主 Agent 只思考规划、子 Agent
      // 全权执行。实现与边界见 {@link applyConductorMode}。
      this.conductor.apply(
        String(sessionId),
        agentCtx,
        conductorModeOf(profile.id, isOfficialPreset, effectiveExecutionTools(profile)),
      )
    }
    // BUG-25（2026-09-11）：`agentOptions` 必须带上 reasoningEffort——此前只传
    // provider/model，Agent 自身的模型配置就丢了档位（表单填 High、会话里却是默认档）。
    // 与会话选择（installTaskModelSelection）口径一致：所选即所得。
    const agentOptions = {
      provider: effectiveModel.provider,
      model: effectiveModel.model,
      ...(effectiveModel.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(effectiveModel.reasoningEffort) }),
    }

    // 官方 preset 无 corum profile 实体——跳过编译落盘与 skill checkout（preset
    // 目录已在 agentPresets 服务管理的根里，mount 直接按 id 解析）。
    if (!isOfficialPreset) {
      checkoutPinnedSkillsOf(this.ctx.logger, profile)
      writeAgentDirOf(profile, agentDirPath(profile.id))
    }
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: root, agentPreset: profile.id },
      agentOptions,
      setup,
    })
    registerTaskSessionOf(sessionId, root, profile.id)
    await attachTaskWorkspaceOf(this.ctx, sessionId, root)
    // 权限档位只记内存、不写事件——写事件会 append 落盘，而用户还没发消息。
    this.rememberPendingPermission(String(sessionId), permission)
    this.ctx.logger.info(`corum-agent(task): created — ${sessionId} (cwd=${root})`)

    this.registry.registerTask({ agent: handle.agent, sessionId, cwd: root, profileId: profile.id })
    this.registry.setTaskSelection(String(sessionId), selection)
    // fork（corum）2026-09-26：把「预设模型不可用 ⇒ 已回落全局默认」**显式告知**用户。
    // 时机在会话建好之后（见 `deliverModelFallbackNotice` 的注释：必须用 inject 而非
    // followup，否则会把 blank 泳道变成非 blank、破坏泳道复用）。
    if (resolvedModel.fallback !== undefined) {
      this.notifyModelFallbackOnce(String(sessionId), handle.agent, resolvedModel.fallback, `新建任务（${profile.id}）`)
    }
    return { agent: handle.agent, presetId: profile.id, sessionId }
  }

  /**
   * fork（corum）2026-09-26：**按会话 + 失效路由去重**地投递模型回落告知。
   *
   * 见 {@link notifiedModelFallbacks} 的说明：blank 泳道会被复用，不去重则用户连点两次
   * 「新建任务」就会在第一句话前看到两条一模一样的告知。
   * @param sessionId - 目标会话 id（去重键的主体）。
   * @param agent - 目标会话的 Agent。
   * @param fallback - 回落事实。
   * @param origin - 触发位置描述。
   */
  private notifyModelFallbackOnce(
    sessionId: string,
    agent: { inject: (message: ReturnType<typeof createUserMessage>) => void },
    fallback: ModelFallback,
    origin: string,
  ): void {
    const key = `${sessionId}|${fallback.configured.provider}/${fallback.configured.model}`
    if (this.notifiedModelFallbacks.has(key)) return
    this.notifiedModelFallbacks.add(key)
    deliverModelFallbackNotice(agent, fallback, origin, this.ctx.logger)
  }

  /**
   * 给新建的 task 会话固定访问权限档位。
   *
   * 时机很关键：官方 `permissionPresets` 在 `session/created` 事件里给会话钉
   * **全局默认档位**（`pinInitialPermission`），此时会话已有 `permission/preset` +
   * `sandbox/mode` + `approval/policy` 三件套。要按用户选的档位覆盖，必须在
   * `agents.create` **之后**调用 `permissionPresets.set(session, name)`——它的
   * `apply()` 只在档位与当前值不同时追加事件，因此此处切换会追加
   * `permission/preset` + 变化的旋钮事件，后写的旋钮覆盖先写的（官方读取语义是
   * 「最后一个事件生效」）。
   *
   * 服务未挂载（无 ctx.permissionPresets）或档位名不在预设表里时**静默沿用默认**，
   * 不阻断会话创建——权限是增强项，不是创建的前置条件。
   */
  private applyTaskPermission(session: Session, permission?: string): void {
    if (permission === undefined || permission === '') return
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) {
      this.ctx.logger.warn(`corum-agent(task): permissionPresets unavailable — skip preset "${permission}"`)
      return
    }
    if (!presets.names.includes(permission)) {
      this.ctx.logger.warn(`corum-agent(task): unknown permission preset "${permission}" — skip`)
      return
    }
    /**
     * ⚠️ fork（corum）2026-09-20 **权限合成**（实测漏洞修复，见 `permission-policy.ts` 头注）。
     *
     * ## 这里**故意保持写入用户原档位**
     *
     * 我第一版写成「把合成结果写回预设」，那是**错的**：一份会话状态要同时表达两件事——
     *   (a) **用户选了什么**（worker 子 Agent 要用它：用户定调「完全权限只能生效给 work 子 Agent」）
     *   (b) **主 Agent 现在被约束成什么**（指挥模式恒只读）
     * 用同一个字段表达两者 ⇒ **必然互相踩**，这正是原漏洞的形态。若在此覆盖成 `read-only`，
     * worker 就再也读不到用户真正的选择了。
     *
     * ## 因此本方法只做一件事：如实记录用户的选择
     *
     * 主 Agent 的只读约束走**另一条正交的轴** —— agent-scoped 的 `tools.guard`
     * （官方语义：注册在 `agent.ctx` 的 guard **只对该 agent 生效**，不沿 scope 链泄漏给
     * 子 Agent ⇒ worker 天然不受影响）。于是：
     *   · 预设置维持用户原意（worker 由此取档位）；
     *   · 约束在门禁层表达（主 Agent 的写操作被拒）；
     *   · 两者**不争同一个字段** ⇒ 写入者仍只有一个，且不再有 last-write-wins 之争。
     *
     * @see applyConductorMode 注册该 guard 的地方。
     */
    try {
      presets.set(session as never, permission)
      this.ctx.logger.info(`corum-agent(task): permission preset pinned — ${permission}`)
    } catch (error) {
      this.ctx.logger.warn(`corum-agent(task): failed to pin preset "${permission}" — ${String(error)}`)
    }
  }

  /**
   * 记下用户在「新建任务」表单里选的访问权限档位，**暂不写入会话**。
   *
   * **为什么延迟（2026-08-30 用户要求：未发第一条消息就不落盘）**：
   * 官方 `SessionPersistence` 的 `create(meta)` 只登记元数据（`materialized:
   * false`，`dsh-session-persistence/lib/index.js:872`），**首次 `append` 才真正
   * 落盘**（同文件 :905）。而 `permissionPresets.set()` 会 append
   * `permission/preset` + `sandbox/mode` + `approval/policy` 三条事件——建会话时
   * 立刻调它，就等于立刻落盘，磁盘上留下一条从未对话的 session 记录。
   *
   * 故改为：建会话时只把档位记在内存表里，等用户真正发第一条消息
   * （`runPromptForTask` / 会话首次 engage）前再调 {@link applyTaskPermission}
   * 写盘。未发消息的会话 leave nothing behind。
   */
  private rememberPendingPermission(sessionId: string, permission?: string): void {
    if (permission === undefined || permission === '') return
    this.pendingPermissions.set(sessionId, permission)
  }

  /** 落盘前兑现待定的权限档位（有则写入并清除，无则跳过）。 */
  private flushPendingPermission(session: Session, sessionId: string): void {
    const pending = this.pendingPermissions.get(sessionId)
    if (pending === undefined) return
    this.pendingPermissions.delete(sessionId)
    this.applyTaskPermission(session, pending)
  }

  /**
   * 按 sessionId 解析（或冷恢复）一个 task 会话的 Agent。
   * 已存活直接返回；未存活但已持久化则 resume（官方 session-persistence 冷恢复历史）。
   */
  /**
   * 解析（或冷恢复）一条 task 泳道会话。
   *
   * 2026-09-21 按关注点抽到 `task-lane.ts`（四条路径 + 官方「live 会话不能再 resume」约束
   * + 指挥模式口径）。这里只把三样本类能力交给它：
   *   · `ctx` / `registry`（状态所有者）；
   *   · `applyConductor`（**显式**说明本模块会写指挥模式 —— 上场漏洞的根因就是
   *     「两个方法各自写同一份状态、互不知情」，把这条边写在接口上而不是藏起来）。
   *
   * 返回值多带一个 `conductor`（本次算出的指挥模式口径）：调用方需要它才能不再算第二遍
   * —— 两处口径来源正是「同一份状态多个写入者」的温床。
   */
  private async resolveTaskAgent(sessionId: string): Promise<ResolvedTaskSession | undefined> {
    return resolveTaskSession({
      ctx: this.ctx,
      registry: this.registry,
      applyConductor: (sid, agentCtx, mode) => this.conductor.apply(sid, agentCtx, mode),
    }, sessionId)
  }

  /** 创建/恢复一个 task 会话并返回其 sessionId。 */
  @Remote('createTaskAgent')
  async createTaskAgentRemote(cwd: string, profileId?: string, permission?: string, model?: ProfileModel): Promise<{ sessionId: string }> {
    const result = await this.createAgentForTask(cwd, profileId, permission, model)
    return { sessionId: String(result.sessionId) }
  }

  /**
   * 切换 task 泳道的 Agent（新会话界面 composer 的可选 Agent chip）。
   * 官方 `agentPresets.select` 是 blank 限定——泳道已开始（有 turn）即
   * `agent-preset/locked` 拒绝；blank 泳道切换时重组 scoped 工具链并记
   * `agent-preset/selected`。本端点只补充 task 索引/存活表同步与 profile 校验。
   */
  @Remote('selectTaskAgentProfile')
  async selectTaskAgentProfileRemote(sessionId: string, profileId: string): Promise<{ ok: true }> {
    const resolved = await this.resolveTaskAgent(sessionId)
    if (resolved === undefined) throw new Error(`dev-agent: task session "${sessionId}" not found`)
    // profileId 双源（同 createAgentForTask）：corum profile 或官方 preset id。
    const isOfficialPreset = profileId !== TASK_PROFILE_ID && loadProfile(profileId) === undefined
    const profile = profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(profileId)
    if (!isOfficialPreset && profile === undefined) throw new Error(`dev-agent: profile "${profileId}" not found`)
    // 先编译落盘再 select（docs/fork-delta.md §8 note 3）：agentPresets.select 要读
    // .agent-presets/<id>/agent.cordis.yml——从未编译的 corum profile（有 agent.json
    // 但产物缺失）若先 select 会抛 agent-preset/invalid（composition missing）、
    // writeAgentDir 永远到不了。官方 preset 无 corum profile 实体——跳过编译落盘。
    if (!isOfficialPreset && profile !== undefined) writeAgentDirOf(profile, agentDirPath(profile.id))
    // select 自己判 blank（turnBoundary 投影）——非 blank 泳道抛 locked，原样上抛给 UI。
    await this.ctx.agentPresets.select(resolved.agent, profileId)
    registerTaskSessionOf(resolved.sessionId, resolved.cwd, profileId)
    this.registry.registerTask({ ...resolved, profileId })
    // fork（corum）：指挥模式口径随切换重算（切出指挥模式即撤销裁剪与人格段）。
    this.conductor.apply(
      String(sessionId),
      resolved.agent.ctx,
      conductorModeOf(profileId, isOfficialPreset, profile === undefined ? undefined : effectiveExecutionTools(profile)),
    )
    // fork（corum）2026-09-19：**换绑 preset 后模型选择必须跟随新 profile**。
    // 用户实测（corum-task-5e63ac3a）：+号建 task 泳道（v4-flash）→ composer 切成
    // 指挥模式（kimi-k3-1）→ 之后所有 request/header 仍是 v4-flash。原因有两层：
    // ① select 只 recompose preset（工具/人格）、不动 createAgentForTask 装的模型绑定；
    // ② 不能靠**重装** installTaskModelSelection 覆盖——cordis waterfall 先注册的是外层，
    //    后装的监听会被创建时的外层监听盖回（见 task-model-selection.ts 头部注释）。
    // 正解 = 改**创建时那个 selection ref 的 current**（installTaskModelSelection 每次
    // 请求都实时读它），而不是再装一层。ref 在 createAgentForTask 里按 sessionId 存着。
    {
      const selection = this.registry.taskSelection(String(sessionId))
      const switchModel = profile === undefined
        ? this.ctx.agentDefaultModel.currentSelection()
        : profile.model
      // fork（corum）2026-09-26：切到的 preset 可能配着一个**已被删除的模型**
      // （用户实测：composer 切「指挥模式」→ kimi-k3-1 已删 → 之后每次请求都失败）。
      // 与创建路径同一条处置：事前校验、不可用则回落全局默认并显式告知。
      const switchResolved = await resolveUsableModel(this.ctx, {
        provider: switchModel.provider,
        model: switchModel.model,
        ...(switchModel.reasoningEffort === undefined ? {} : { reasoningEffort: switchModel.reasoningEffort }),
      })
      const switchEffective = switchResolved.model
      if (selection !== undefined) {
        selection.current = {
          provider: switchEffective.provider,
          model: switchEffective.model,
          ...(switchEffective.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(switchEffective.reasoningEffort) }),
        }
      } else {
        // 无登记（进程重启后内存态丢失、或泳道不是本进程所建）：退回重装一层。
        // 此时创建时的外层监听已随宿主进程消亡，新装的这一层就是唯一绑定。
        const fallbackSelection: ModelSelectionRef = {
          current: {
            provider: switchEffective.provider,
            model: switchEffective.model,
            ...(switchEffective.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(switchEffective.reasoningEffort) }),
          },
          assembled: undefined,
        }
        installTaskModelSelection(resolved.agent.ctx, resolved.agent, fallbackSelection)
        this.registry.setTaskSelection(String(sessionId), fallbackSelection)
      }
      if (switchResolved.fallback !== undefined) {
        this.ctx.logger.warn(
          `corum-agent(task): preset "${profileId}" model ${switchResolved.fallback.configured.provider}/${switchResolved.fallback.configured.model} `
          + `is unavailable (${switchResolved.fallback.reason}); falling back to ${switchEffective.provider}/${switchEffective.model}`,
        )
        this.notifyModelFallbackOnce(String(sessionId), resolved.agent, switchResolved.fallback, `切换 Agent（${profileId}）`)
      }
    }
    this.ctx.logger.info(`corum-agent(task): preset switched — ${sessionId} → ${profileId}`)
    return { ok: true }
  }

  /** 列出可选的访问权限档位（新建任务表单三档数据源）。 */
  @Remote('listPermissionPresets')
  listPermissionPresetsRemote(): { presets: { id: string; name: string; description?: string }[]; defaultPreset: string } {
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) return { presets: [], defaultPreset: '' }
    return {
      presets: presets.names.map((id) => {
        const option = presets.optionOf(id)
        return { id, name: option.name, ...(option.description === undefined ? {} : { description: option.description }) }
      }),
      defaultPreset: presets.defaultPreset,
    }
  }

  /** 在 task 会话里发一个 prompt，等回复（返回回复文本 + 过程事件投影）。 */
  @Remote('runPromptForTask')
  async runPromptForTaskRemote(sessionId: string, prompt: string): Promise<RunPromptResult> {
    const resolved = await this.resolveTaskAgent(sessionId)
    if (resolved === undefined) throw new Error(`dev-agent: task session "${sessionId}" not found`)
    const { agent } = resolved
    await agent.whenIdle()
    // 用户真的要发消息了——此刻才兑现「新建任务」时选的权限档位并落盘。
    // 此前会话一直在内存里（官方 lazy materialization），磁盘无记录。
    this.flushPendingPermission(agent.session, sessionId)
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    // BUG-5（2026-09-11）：task 模式 turn 级超时兜底——不能依赖 corumRuntime 的
    // stalled 扫描（它只扫 this.profiles 项目×角色，taskAgents 不其中）。
    // 当 bash 工具 300s 超时但 model turn 未收到 tool_result 时，agent.whenIdle()
    // 会永久 pending（实测 13min、18min 未恢复）。超时后主动 cancel + 注入
    // tool_result 让模型继续（与「停止生成」同款恢复路径，但自动化）。
    await this.whenIdleWithTimeout(agent, sessionId)
    await this.ctx.sessions.flush(agent.session)
    const reply = summarizeText(agent.session.snapshotEvents(), firstSeq)
    const events: SessionEventDto[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq < firstSeq) continue
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    const { systemPrompt, tools } = extractHeader(agent.session.snapshotEvents(), firstSeq)
    return { reply, events, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(tools !== undefined ? { tools } : {}) }
  }

  /**
   * BUG-5（2026-09-11）：task 模式 turn 级超时兜底——当 `agent.whenIdle()` 阻塞
   * 超时（bash 工具 300s 超时但 model turn 未收到 tool_result，实测 13min/18min
   * 未恢复），主动 cancel + 注入 tool_result 让模型继续，避免只能手动「停止生成」。
   *
   * 不能依赖 corumRuntime 的 stalled 扫描（它只扫 this.profiles 项目×角色，
   * taskAgents 不在其中——补丁对 task 模式完全无效）。此处是 task 泳道自己的
   * turn 级恢复机制，与项目制调度层的 stalled 自动恢复互补。
   *
   * 恢复路径与「停止生成」同款：cancel({kind:'hook', reason}) 中止当前 turn，
   * 模型 turn 以 aborted 结束；后续的 followup 会从 aborted 状态恢复。
   * @param agent - task 泳道的活 Agent。
   * @param sessionId - task 会话 id（日志用）。
   */
  private async whenIdleWithTimeout(agent: Agent, sessionId: string): Promise<void> {
    // 与项目制 stalled 恢复**共用同一个可配置阈值**（C4）：此前这里另写了一份
    // 硬编码 10min，两处容易漂移。现在统一读 runtime-state 的 holder。
    const TIMEOUT_MS = stallAutoRecoverMsValue()
    return new Promise<void>((resolve) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        this.ctx.logger.warn(
          `corumAgent(task): whenIdle 超 ${TIMEOUT_MS / 1000}s 未返回 — session "${sessionId}"，主动 cancel 恢复（tool 超时或状态不同步）`,
        )
        agent.cancel({ kind: 'hook', reason: `task 会话 turn 超 ${TIMEOUT_MS / 1000}s 无活动，自动恢复` })
        resolve()
      }, TIMEOUT_MS)
      void agent.whenIdle().then(() => {
        clearTimeout(timer)
        if (!timedOut) resolve()
        // timedOut 时 timer 已 resolve——cancel 后的 whenIdle 很快返回（aborted 收敛）。
      })
    })
  }

  /**
   * 读 task 会话的历史事件（从 fromSeq 开始，只读不发消息；切会话回填用）。
   *
   * 数据源：**持久化**（`ctx.sessionPersistence.readFrom`，全历史）而非
   * `agent.session.snapshotEvents()` 窗口——后者冷 resume 后只含会话种子事件（permission/
   * sandbox/approval/end-seed），历史消息不在窗口（2026-08-28 实测：冷泳道 resume
   * 仅 4 条种子、无 user/message）。持久化读全历史，冷/活泳道一致。
   */
  @Remote('getTaskSessionEvents')
  async getTaskSessionEventsRemote(sessionId: string, fromSeq: number): Promise<{ events: SessionEventDto[] }> {
    const index = readTaskSessionIndexOf()
    if (index[sessionId] === undefined) return { events: [] }
    const stored = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), fromSeq)
    const events: SessionEventDto[] = []
    for (const event of stored) {
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    return { events }
  }

  /**
   * 会话图片态 + 模型视觉能力（composer 换模型提示的数据源）。
   *
   * 官方只在 **prompt 准入**时校验图片-模型匹配（`session-controller/commands.ts`
   * 的 `hasImage` 分支抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`），`selectModel` 本身
   * 不读历史。corum 需要在**切换那一刻**就给出预警，故补此读端点：
   *
   * - `hasImage`：扫会话历史，任一条 user/assistant 消息含 image 内容块即为真
   *   （与官方 `imageInEvent` 同判据：content / message.content / assistant 流块）。
   * - `supportsImage`：`ctx.llm.resolveModelInfo` 的 `inputModalities`。**语义与
   *   官方一致——`undefined` 表示未知（不当作「不支持」）**，仅显式声明且不含
   *   `image` 才算不支持（否则本地模型未声明模态会被误判）。
   *
   * 读失败一律降级为「未知」（`hasImage:false` / `supportsImage:null`），绝不阻断切换。
   * @param sessionId - 泳道 id。
   * @param provider - 目标供应商（缺省用会话当前选择）。
   * @param model - 目标模型。
   */
  @Remote('getImageCompatibility')
  async getImageCompatibilityRemote(
    sessionId: string,
    provider?: string,
    model?: string,
  ): Promise<{ hasImage: boolean; supportsImage: boolean | null }> {
    let hasImage = false
    try {
      const stored = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), 0)
      hasImage = stored.some(event => eventHasImage(event))
    } catch {
      hasImage = false
    }

    let supportsImage: boolean | null = null
    try {
      // 目标模型：显式入参优先；否则读会话的 `modelSelection` 投影（next 优先于
      // lastUsed），再退到部署默认。不用 `agents.selectionFor`——那是官方
      // session-controller 内部注册表，不是本服务可依赖的公开面。
      const target = provider !== undefined && model !== undefined
        ? { provider, model }
        : (() => {
            const live = this.registry.task(sessionId)
            const projections = (this.ctx as unknown as { sessionProjections?: ModelSelectionProjections }).sessionProjections
            const state = live === undefined || projections === undefined
              ? undefined
              : projections.stateOf(live.agent.session, 'modelSelection')
            const projected = state !== undefined && state !== null && typeof state === 'object'
              ? (state as { next?: ProjectedSelection | null; lastUsed?: ProjectedSelection | null })
              : undefined
            const picked = projected?.next ?? projected?.lastUsed ?? this.ctx.agentDefaultModel.currentSelection()
            return { provider: picked.provider, model: picked.model }
          })()
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model)
      supportsImage = info.inputModalities === undefined
        ? null
        : info.inputModalities.includes('image')
    } catch {
      supportsImage = null
    }
    return { hasImage, supportsImage }
  }

  /**
   * 按子会话 id 折叠子 Agent 精确进度（子 Agent 进度卡数据源）。
   *
   * 与 getTaskSessionEvents 的差异：本端点不限 task 泳道索引——子 Agent 会话
   * （origin='subagent'，UUID id）不进 task 索引，但同样持久化在 sessionPersistence。
   * 从子会话事件窗算：turn（最新 turn/start）、step（当前 turn 已闭合 step 数）、
   * currentAction（最新工具调用名 / 生成中）、done（turn/end 闭合）。
   */
  /**
   * 读某会话的隔离 worktree 台账（「并行工作区」区的**冷启动基线**）。
   *
   * 为什么需要：台账推送（`corum/worktree-ledger`）只在**变更时** emit，
   * 页面刷新/应用重启后不重放——纯推送订阅的历史会话永远看到空台账，而
   * 「N 个隔离工作区 · 待集成」恰恰是刷新后最需要看的信息（未集成的分支可能
   * 被后续 cleanup 清掉，用户要能发现）。故补一个读端点：前端挂载时拉一次做基线，
   * 之后由推送帧增量更新（与 SubagentCard 的「推送为主 + RPC 冷启动基线」同范式）。
   */
  @Remote('getWorktreeLedger')
  async getWorktreeLedgerRemote(sessionId: string): Promise<{
    entries: Array<{ slug: string; branch: string; path: string; status: string; childSessionId?: string }>
    pending: number
  }> {
    const orchestration = this.ctx.get('corumOrchestration') as
      | { entriesOf(id: string): Array<{ slug: string; branch: string; path: string; status: string; childSessionId?: string }> }
      | undefined
    if (orchestration === undefined) return { entries: [], pending: 0 }
    try {
      const entries = orchestration.entriesOf(sessionId)
      return {
        entries: entries.map(entry => ({ ...entry })),
        pending: entries.filter(entry => entry.status === 'active' || entry.status === 'settled').length,
      }
    } catch {
      // 取不到按空台账处理（可见性增强，绝不影响会话本身）。
      return { entries: [], pending: 0 }
    }
  }

  /**
   * fork（corum）：该会话此刻**是否正在跑一个 turn**（用于识别「被杀掉/半途失去运行」）。
   *
   * 用途：判断「被进程退出杀掉的子会话」——它的 log 里只有 `turn/start`、没有
   * `turn/end`，事件投影永远推不出终态（卡片会一直 Running，2026-09-12 实测）。
   * 判据用官方 `agent.status`（running/idle）而非「在不在 registry 里」：常驻
   * （continuable）子会话跑完不 dispose，仍在 registry 里但 status=idle。
   * @param sessionId - 会话 id。
   * @returns 是否活着；取不到 agents 服务时 undefined（不猜）。
   */
  private agentRunning(sessionId: string): boolean | undefined {
    // `agent.status` 是官方终值：'running'（正在跑一个 turn）/ 'idle'（空闲，可续接）。
    // 关键差别（2026-09-12 实测）：**continuable/resident 子会话跑完不会被 dispose**，
    // 所以「在 registry 里」不等于「在跑」——研究子 Agent 就是常驻的，被杀掉之后
    // 仍留在 registry 里、status 为 idle。用它才能把「空闲的常驻子会话」与
    // 「真的在跑」分开。
    type AgentLike = { session: { id: string }; status?: string }
    try {
      const agents = this.ctx.get('agents') as
        | { list?: Iterable<AgentLike> | (() => Iterable<AgentLike>) }
        | undefined
      const raw = agents?.list
      if (raw === undefined) return undefined
      const list: Iterable<AgentLike> = typeof raw === 'function' ? raw() : raw
      for (const agent of list) {
        if (String(agent.session.id) !== sessionId) continue
        return agent.status === 'running'
      }
      // 不在 registry 里（一次性子会话跑完已 dispose）→ 没在跑。
      return false
    } catch {
      return undefined
    }
  }

  /**
   * fork（corum）：该子会话是否跑在隔离 worktree 里（durable 判据）。
   *
   * 为什么不用推送帧：`corum/subagent/child` 带 `isolated`，但**帧不重放**——刷新/重启
   * 后花名册的「隔离」徽标整体消失（2026-09-12 用户实测）。子会话自己的 `header.cwd`
   * 就是 durable 事实：隔离时它是 `<repo>/.corum-worktrees/<slug>`（台账/机制建的 worktree
   * 根名固定为 `.corum-worktrees`，见 CorumWorktreeChildOptions.worktreeRoot 默认值）。
   *
   * @param sessionId - 子会话 id。
   * @returns true/false；取不到会话时 undefined（不猜）。
   */
  private async childWorktreeIsolation(sessionId: string): Promise<boolean | undefined> {
    /** 隔离子会话的工作目录就是 worktree 根下的 `<repo>/.corum-worktrees/<slug>`。 */
    const ofCwd = (cwd: string | undefined): boolean | undefined =>
      cwd === undefined ? undefined : /(^|[\\/])\.corum-worktrees([\\/]|$)/.test(cwd)
    // ① 已加载的 agent（内存 header，最快）。
    //
    // ⚠️ `agents.list` 是**方法**（`list(): Agent[]`，dsh 的 agent registry），不是可迭代
    // 属性——按属性 `for...of` 会抛 `function is not iterable`。2026-09-12 实测教训：
    // 这个 throw 直接把 `getChildSessionProgress` 整个打挂，而 renderer 的
    // `useChildProgress` 正是靠它补冷启动进度 → **所有子 Agent 卡片永远停在 Running**。
    // 故这里 (a) 兼容「方法 / 可迭代属性」两种形态，(b) 整段 try/catch 兜住——
    // 可见性增强的辅助信息绝不能把主 RPC 打挂。
    try {
      type AgentLike = { session: { id: string; header?: { cwd?: string } } }
      const agents = this.ctx.get('agents') as
        | { list?: Iterable<AgentLike> | (() => Iterable<AgentLike>) }
        | undefined
      const raw = agents?.list
      const list: Iterable<AgentLike> = typeof raw === 'function' ? raw() : raw ?? []
      for (const agent of list) {
        if (String(agent.session.id) !== sessionId) continue
        const memory = ofCwd(agent.session.header?.cwd)
        if (memory !== undefined) return memory
        break
      }
    } catch {
      // 取不到就落到 ②（持久化 header）；两者都取不到 → undefined（不猜）。
    }
    // ② 持久化 header——**一次性子会话跑完就被 dispose，不在 agents.list 里**，这时只能读盘。
    //    `SessionHandle.header` 是不变元数据（含 cwd），读它不需要把会话载回来。
    try {
      const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'read')
      try {
        return ofCwd(handle.header.cwd)
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  @Remote('getChildSessionProgress')
  async getChildSessionProgressRemote(sessionId: string): Promise<{
    /**
     * 委派角色：**独立于 progress 返回**（progress 只从子会话事件窗口折出来，而角色
     * 来自父侧工具名）。花名册冷启动时用它补角色小标；本进程没记过该子会话则缺省。
     */
    role?: 'worker' | 'research' | 'fork'
    /**
     * 是否隔离到 worktree。**由子会话自己的 cwd 判定**（隔离子会话的工作目录就是
     * `<repo>/.corum-worktrees/<slug>`），而不是靠 `corum/subagent/child` 推送帧——
     * 推送帧不重放，刷新/重启后花名册的「隔离」徽标会整体消失（2026-09-12 用户实测：
     * 「下拉的悬浮窗中无法看到隔离任务的分类了」）。cwd 是会话自身的 durable 事实。
     */
    isolated?: boolean
    progress?: {
      turn: number
      step: number
      currentAction?: string
      done: boolean
      stopReason?: SubagentStopReason
      /** 运行中途失去运行（进程退出/被丢弃）——没有权威 stopReason 时的诚实补标。 */
      interrupted?: boolean
      lastActive: number
      todos?: readonly SubagentTodoItem[]
    }
  }> {
    // role/isolated 与「子会话事件窗口」无关（角色来自父侧工具名、隔离来自子会话 cwd），
    // 故先算好、所有返回路径都带上——否则事件读不到时（返回 {}）花名册的角色/隔离徽标会
    // 一起消失（2026-09-12 用户实测：「下拉的悬浮窗中无法看到隔离任务的分类了」）。
    const role = this.progress.roleOf(sessionId)
    const isolated = await this.childWorktreeIsolation(sessionId)
    const identity: { role?: 'worker' | 'research' | 'fork'; isolated?: boolean } = {
      ...role === undefined ? {} : { role },
      ...isolated === undefined ? {} : { isolated },
    }
    /**
     * 快路径（2026-09-27 性能修复）：折叠表里已有**可信**快照就直接用。
     *
     * 实测背景：本方法原先每次调用都重扫子会话的持久化日志再折叠，一个 4.8 万条事件的子会话要
     * **1.35 s**；而卡片/花名册会**成批**拉（47 轮会话 30+ 张卡）⇒ 几十秒卡顿（`docs/PENDING-ui-lag-multiround.md` §2.10）。
     * 信任口径见 `SubagentProgressService.snapshotOf`；未命中/不可信时才走下面的读盘路径。
     */
    const snapshot = this.progress.snapshotOf(sessionId)
    if (snapshot !== undefined) {
      const { turn, step, done, currentAction, stopReason, todos } = snapshot.state
      const interruptedBySnapshot = childRunInterruptOf({
        done,
        stopReason,
        agentRunning: () => this.agentRunning(sessionId),
        lastActive: snapshot.lastActive,
        bootAt: Date.now() - process.uptime() * 1000,
      })
      return {
        ...identity,
        progress: {
          turn,
          step,
          ...currentAction === undefined ? {} : { currentAction },
          done: done || interruptedBySnapshot !== undefined,
          ...stopReason === undefined ? {} : { stopReason },
          ...interruptedBySnapshot === undefined ? {} : { interrupted: true },
          lastActive: snapshot.lastActive,
          ...todos === undefined ? {} : { todos },
        },
      }
    }
    /**
     * 第二层快路径（A2）：**落盘条目**。
     *
     * 冷启动（刷新/重启）后内存表是空的，而重扫一个 4.8 万条事件的子会话要 1.35 s；
     * 落盘条目让我们直接拿到上次折出来的进度 ⇒ 首次也是 O(1)。拿到后顺便 `remember`
     * 进内存表，后续调用走第一层。
     */
    const durable = this.progress.durableOf(sessionId)
    if (durable !== undefined) {
      const { turn, step, done, currentAction, stopReason, todos, lastActive } = durable
      this.progress.remember(sessionId, {
        turn,
        step,
        done,
        ...currentAction === undefined ? {} : { currentAction },
        ...stopReason === undefined ? {} : { stopReason },
        ...todos === undefined ? {} : { todos },
      }, lastActive)
      const interruptedByDurable = childRunInterruptOf({
        done,
        stopReason,
        agentRunning: () => this.agentRunning(sessionId),
        lastActive,
        bootAt: Date.now() - process.uptime() * 1000,
      })
      return {
        ...identity,
        progress: {
          turn,
          step,
          ...currentAction === undefined ? {} : { currentAction },
          done: done || interruptedByDurable !== undefined,
          ...stopReason === undefined ? {} : { stopReason },
          ...interruptedByDurable === undefined ? {} : { interrupted: true },
          lastActive,
          ...todos === undefined ? {} : { todos },
        },
      }
    }
    let stored: readonly SessionEvent[]
    try {
      const events = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), 0)
      stored = events
    } catch {
      return identity
    }
    if (stored.length === 0) return identity
    /**
     * 折叠走 `child-progress.ts` 的**纯函数**——与增量路径（`session/event` 逐条折）
     * 共用同一份实现。
     *
     * ⚠️ 2026-09-21 之前这里是一份**独立复制**的 6-case switch，与
     * `foldSubagentProgress` 各写一遍、靠一句注释人肉维持一致（改一边不会红）。
     * 现在两条路径都调 `foldProgressAll` / `foldProgressEvent` ⇒ **漂移在结构上不可能**。
     * 等价性由 `tests/fold-equivalence.spec.ts` 对着 HEAD 原文逐字段+逐键钉住。
     */
    const folded = foldProgressAll(stored)
    const { turn, step, done, currentAction, stopReason, todos } = folded
    const lastActive = stored[stored.length - 1].time
    // 记进折叠表 ⇒ 同一批卡片/花名册的后续调用走快路径（不再重扫日志）。
    this.progress.remember(sessionId, folded, lastActive)
    /**
     * 被进程退出杀掉 / 中途失去运行的子会话：log 里有 `turn/start` 却没有 `turn/end`，
     * 事件投影推不出终态 → 卡片永远停在 Running（2026-09-12 用户实测「search agent
     * 结束后卡片仍是 running」的一类残余）。宿主能判「它已经不在跑」→ 补一个**诚实**
     * 的终态：`done: true` + `interrupted: true`。
     * 判据本体在 `child-progress.ts`（纯函数 + 单测）；这里只负责查 registry 与时钟。
     */
    const bootAt = Date.now() - process.uptime() * 1000
    const interruptReason = childRunInterruptOf({
      done,
      stopReason,
      agentRunning: () => this.agentRunning(sessionId),
      lastActive,
      bootAt,
    })
    const interrupted = interruptReason !== undefined
    // 「中断」不是事件（它是读取时的判定），而通知桥只消费推送帧 → 在**发现点**补一次
    // 广播（进程内按子会话去重）。用户 2026-09-13 定调：这种情况要有通知，不能静默。
    if (interruptReason !== undefined) {
      await this.progress.broadcastInterrupted(sessionId, { reason: interruptReason, turn, step, lastActive })
    }
    return {
      ...identity,
      progress: {
        turn,
        step,
        ...currentAction === undefined ? {} : { currentAction },
        done: done || interrupted,
        ...stopReason === undefined ? {} : { stopReason },
        ...interrupted ? { interrupted: true } : {},
        lastActive,
        ...todos === undefined ? {} : { todos },
      },
    }
  }

  /**
  }

  /**
   * 按子会话 id 提取父 Agent 注入的提示词（子 Agent 卡「任务详情」展开区数据源）。
   *
   * prompt = 子会话首条 user/message 全文（子 Agent 由父 Agent 发起，首条 user
   * 消息必是父注入的任务指令；后续 user 消息是子会话自己的 followup，不取）。
   * 模型（modelSelection）与父会话 id（parentSessionId）由 client 侧 `session/list`
   * 行投影直接提供，host 不重复读。
   */
  @Remote('getSubagentSessionMeta')
  async getSubagentSessionMetaRemote(sessionId: string): Promise<{
    meta?: { prompt?: string }
  }> {
    let stored: readonly SessionEvent[]
    try {
      const events = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), 0)
      stored = events
    } catch {
      return {}
    }
    for (const event of stored) {
      if (event.type !== 'user/message') continue
      const data = event.data as {
        content?: Array<{ type: string; text?: string }>
        message?: { content?: Array<{ type: string; text?: string }> }
      }
      const content = data.content ?? data.message?.content ?? []
      const text = content
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('')
        .trim()
      if (text !== '') return { meta: { prompt: text } }
    }
    return {}
  }

  /**
   * 列出 task 模式会话（侧栏 task 列表数据源；可按 cwd 过滤）。
   * 合并存活表与持久化索引：附标题（首条 user 消息摘要）、cwd、sessionId、
   * 最后活动时间、是否存活。一个工作区可多个会话。
   *
   * ## 性能：**列表路径绝不读会话历史**（2026-09-18，照官方 dsh 模式重写）
   *
   * 旧实现对**每个** task 会话 `readPersistedEvents(…, 0)` 读**完整历史**，只为算
   * 标题与末条时间。实测（:9333，86 个 task 会话）该 RPC 耗时 **997ms**，而同一
   * 时刻其它所有 RPC 都在 28–77ms；耗时与会话数**线性相关**（86 个→806ms、
   * 10 个→93ms ⇒ 每个会话约 9.4ms）。后果：侧栏分组加号进 blank 会话后，Agent
   * 名/模型/提示语要等 **~1.0s** 才填充（实测时间线：30ms 渲染出占位「选择 Agent」，
   * 1035ms 才改成真名），用户报障「延迟 1 秒多」。
   *
   * 官方 dsh 的列表（`api/session-controller/src/list.ts` 的 `ApiSessionList.list`
   * + `summarizeCold`）**从不扫历史**：标题/`lastPromptAt`/`blank` 全部取自
   * **写入时就折好**的投影缓存（`session_projcache` 的 `rows.title` /
   * `rows.sessionListMetadata`），读取是零 I/O 的「视图直读」；**缓存未命中也不
   * 回落读历史**，而是按 `displayTitleOf` 回退「工作区名 → id」。全量历史读取
   * （`SessionHandle.read`）只保留给「真的打开某一个会话」。
   *
   * corum 的投影缓存**本来就是官方那套**（`session_projcache` 由官方
   * dsh-session-projection-cache 维护，corum 已在运行），且 `corum-subagent` 早有
   * 同款复用先例（`list-children.ts` 的 `cachedSnapshot` + 「缓存损坏静默回落」）。
   * 故此处照官方实现：**先读缓存，未命中不读历史**。
   *
   * 命中率实测（:9333，88 个 task 会话）：63 行取到缓存标题 ⇒ 25 行未命中，而那些
   * 未命中的**都有真历史**（中位 34KB、最大 351KB）。若「未命中回落读历史」，这 25 个
   * 仍要全读（≈240ms），**只砍掉一半延迟**——所以官方那条「未命中也不读历史」的
   * 纪律是必需的，不是保守选择。
   *
   * ⚠️ 查缓存覆盖率时**认 sqlite 真源**（`storages/kv.sqlite` 的
   * `u_session_projcache_sessions`），不要读 `storages/session_projcache/sessions/*.json`
   * ——那是**过时副本**（2026-09-15 用户裁定 KV 层迁 sqlite 后遗留），据它算覆盖率会
   * 得出错误结论。
   */
  @Remote('listTaskAgents')
  async listTaskAgentsRemote(cwd?: string): Promise<{ tasks: TaskAgentSummary[] }> {
    const index = readTaskSessionIndexOf()
    const out: TaskAgentSummary[] = []
    // cwd 过滤走身份归一（realpath）而非字符串直比：存量实测 "/a/b/" 与 "/a/b"
    // 同指一个目录，直比会把同一工作区的会话漏掉一半（同 findBlankTaskLane）。
    const wantCwd = cwd === undefined ? undefined : canonicalWorkspaceKey(cwd)
    const rows = await this.taskListRows()
    for (const [sessionId, meta] of Object.entries(index)) {
      if (wantCwd !== undefined && canonicalWorkspaceKey(meta.cwd) !== wantCwd) continue
      const live = this.registry.task(sessionId)
      // 标题/最后活动**只读投影缓存**（零 I/O）；未命中按官方口径回退，不读历史。
      // 空串与缺失同义（title 行的 null 也是「尚无标题」）——都要走回退。
      const row = rows.get(sessionId)
      const title = row !== undefined && row.title !== '' ? row.title : taskListFallbackTitle(meta.cwd, sessionId)
      out.push({
        sessionId,
        cwd: meta.cwd,
        profileId: meta.profileId,
        alive: live !== undefined,
        title,
        lastActive: row?.lastActive ?? 0,
      })
    }
    return { tasks: out }
  }

  /**
   * 为全部 task 会话取**列表视图行**（标题 + 最后活动时间）——**零历史读取**。
   *
   * 口径严格照官方 `ApiSessionList.summarizeCold`：
   *   · 标题 = 投影缓存的 `title` 行（官方 session-title 单元在**写入时**折好）；
   *   · 时间 = 投影缓存的 `sessionListMetadata.lastPromptAt`；
   *   · **未命中/缓存不可用 ⇒ 不读历史**，调用方回退 `displayTitleOf` 口径
   *     （cwd 末段 → sessionId），时间为 0。
   *
   * 身份见证（缓存按 lifecycle identity 建索引，需 header 才能查）：先用
   * `sessionPersistence.list()` 拿真 header——它只 `stat` 文件元数据、**不读事件
   * 日志**（官方同款用法，`SessionPersistenceSnapshot` 的注释即写明
   * "without reading the full event log"）。**不用**会话索引里的字段凑 header：
   * 索引不存 `createdAt`/`isSeeded`，凑出来的身份永远匹配不上缓存（实测会 100%
   * 未命中，修复等于没做）。
   *
   * 为什么未命中不回落读历史：那正是被修掉的 N+1（见
   * {@link listTaskAgentsRemote} 的性能段）。实测（:9333，88 个 task 会话）63 行取到
   * 缓存标题、25 行未命中，而未命中那些**都有真历史**（中位 34KB、最大 351KB）——
   * 回落读历史只能砍掉一半延迟，是假修复。
   *
   * 缓存是**派生数据**（官方明言 "a fold shortcut, never an authority"）：读它抛错
   * 只意味着该行回退，绝不让整个列表失败——同 `corum-subagent` 的
   * `resolveColdIdentity` 纪律（缓存损坏静默回落，不产生裁决）。
   *
   * @returns sessionId → `{title, lastActive}`；缓存不可用/未命中时该 id 缺席。
   */
  private async taskListRows(): Promise<Map<string, { title: string; lastActive: number }>> {
    const rows = new Map<string, { title: string; lastActive: number }>()
    const cache = this.ctx.get('sessionProjectionCache')
    if (cache === undefined) return rows
    let snapshots: readonly SessionPersistenceSnapshot[]
    try {
      snapshots = await this.ctx.sessionPersistence.list()
    } catch {
      return rows // 列表读失败：全体回退，列表仍可用（不 throw）。
    }
    for (const { header } of snapshots) {
      try {
        const snapshot = cache.cachedSnapshot(header, SessionLogOffset(0), ['title', 'sessionListMetadata'])
        if (snapshot === undefined) continue
        // 标题与时间**各自独立**取值（官方 summarizeCold 同口径：标题缺失只让标题
        // 走 displayTitleOf 回退，不牵连 updatedAt）——一个还没起标题、但已有
        // lastPromptAt 的会话，不该连「最后活动时间」一起丢掉。
        const title = snapshot.values.title
        const metadata = snapshot.values.sessionListMetadata as { lastPromptAt?: number | null } | undefined
        const lastActive = typeof metadata?.lastPromptAt === 'number' ? metadata.lastPromptAt : 0
        if ((typeof title !== 'string' || title === '') && lastActive === 0) continue
        rows.set(String(header.id), {
          title: typeof title === 'string' ? title : '',
          lastActive,
        })
      } catch {
        // 派生缓存损坏 → 该行缺席（调用方回退），不影响其它行。
      }
    }
    return rows
  }

  /* ── AI 润色（prompt polish）────────────────────────────────────────────
   * fork（corum）：宿主端实现（2026-09-09 重建）。
   * 历史：契约（contract/agent.ts 的 5 个方法）+ 配置存储（profile-store 的
   * load/savePolishConfig）+ 客户端按钮一直都在，但宿主端方法在基座升级重置
   * **未提交工作树**时丢失（点 sparkle → /api/corumAgent/polishConversation 404；
   * 见 docs/ide-formal/PROGRESS.md 第 50 轮）。本轮按契约重建。
   * 引擎路由（PolishConfig.engine）：online → ctx.llm.stream；local →
   * ctx.localLlm.chat（窄能力接口，不耦合 @corum/corum-ollama）；auto →
   * 本地引擎可用（installed && running && meetsMinMem && 有模型）走本地，否则线上。
   * ────────────────────────────────────────────────────────────────────── */

  /** 读取润色配置（未配置返回 null）。 */
  @Remote('getPolishConfig')
  getPolishConfigRemote(): GetPolishConfigResult {
    const config = loadPolishConfig()
    if (config === undefined) return { config: null }
    return {
      config: {
        provider: config.provider,
        model: config.model,
        ...(config.engine === undefined ? {} : { engine: config.engine }),
        ...(config.localModel === undefined ? {} : { localModel: config.localModel }),
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      },
    }
  }

  /**
   * 保存润色配置（provider/model 必填——engine=local 时仍作为 auto 的线上回落）。
   * ⚠️ 形参名必须与 contract 的 args 字段同名：typert 网关按**方法形参名**做
   * 命名绑定（SRC 描述符），形参写成单个 `args` 会报
   * `gateway/arguments-invalid: unexpected "text"...`（2026-09-09 首次重建时踩到）。
   */
  @Remote('setPolishConfig')
  setPolishConfigRemote(
    engine: 'auto' | 'local' | 'online' | undefined,
    provider: string,
    model: string,
    localModel?: string,
    reasoningEffort?: string,
  ): { ok: boolean } {
    const providerText = typeof provider === 'string' ? provider.trim() : ''
    const modelText = typeof model === 'string' ? model.trim() : ''
    if (providerText === '' || modelText === '') return { ok: false }
    const engineValue = engine === 'local' || engine === 'online' || engine === 'auto' ? engine : undefined
    const localModelValue = typeof localModel === 'string' && localModel.trim() !== '' ? localModel.trim() : undefined
    const reasoningEffortValue = typeof reasoningEffort === 'string' && reasoningEffort.trim() !== ''
      ? reasoningEffort.trim()
      : undefined
    savePolishConfig({
      ...(engineValue === undefined ? {} : { engine: engineValue }),
      ...(localModelValue === undefined ? {} : { localModel: localModelValue }),
      provider: providerText,
      model: modelText,
      ...(reasoningEffortValue === undefined ? {} : { reasoningEffort: reasoningEffortValue }),
    })
    return { ok: true }
  }

  /** 润色一段提示词（无对话上下文；kind 用于给模型一点体裁提示）。 */
  @Remote('polishPrompt')
  async polishPromptRemote(text: string, kind?: string): Promise<PolishPromptResult> {
    const source = typeof text === 'string' ? text.trim() : ''
    if (source === '') return { polished: '' }
    const config = this.requirePolishConfig()
    const kindText = typeof kind === 'string' && kind.trim() !== '' ? kind.trim() : 'prompt'
    const system = polishPromptSystem(kindText)
    const polished = await runPolishEngine(this.ctx, config, system, source)
    return { polished: polished.trim() }
  }

  /**
   * 会话内提示词润色：结合最近若干条「user 提问 + AI 最终输出」，把草稿改写成
   * 意图明确、衔接顺畅的输入，并给出意图分类（continue/new-topic/bug-report/other）。
   * 模型按 JSON 返回；解析失败时回落「整段即润色结果 + intent=unknown」。
   */
  @Remote('polishConversation')
  async polishConversationRemote(
    text: string,
    history: Array<{ role: 'user' | 'assistant'; text: string }>,
  ): Promise<PolishConversationResult> {
    const source = typeof text === 'string' ? text.trim() : ''
    if (source === '') return { polished: '', intent: 'unknown' }
    const config = this.requirePolishConfig()
    const recent = Array.isArray(history) ? history.slice(-6) : []
    const context = recent.length === 0
      ? '(no conversation history)'
      : recent.map(h => `${h.role === 'user' ? 'User' : 'AI'}: ${h.text}`).join('\n')
    const system = polishConversationSystem()
    const prompt = `Conversation context:\n${context}\n\nDraft:\n${source}`
    const raw = await runPolishEngine(this.ctx, config, system, prompt)
    const parsed = parsePolishEnvelope(raw)
    return parsed ?? { polished: raw.trim(), intent: 'unknown' }
  }

  /** 中英文互译（中文→英文、英文→中文；其它语言→中文）。 */
  @Remote('translatePrompt')
  async translatePromptRemote(text: string): Promise<TranslatePromptResult> {
    const source = typeof text === 'string' ? text.trim() : ''
    if (source === '') return { translated: '' }
    const config = this.requirePolishConfig()
    const system = translatePromptSystem()
    const translated = await runPolishEngine(this.ctx, config, system, source)
    return { translated: translated.trim() }
  }

  /** 取润色配置；未配置时抛错。实现见 `polish-service.ts`（按关注点抽出的模块）。 */
  private requirePolishConfig(): PolishConfig {
    return requirePolishConfigOf()
  }

  @Remote('verify')
  async verifyRemote(): Promise<{ ok: boolean; reply?: string; error?: string }> {
    try {
      const profile = ensureSmokeProfile()
      const reply = await this.runProfile(profile.id, SMOKE_PROMPT)
      return { ok: true, reply }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 列出已创建的 Agent 的 profile id。 */
  @Remote('listAgents')
  listAgentsRemote(): { agents: AgentStatus[] } {
    return { agents: this.registry.profileIds().map(id => ({ profileId: id, created: true })) }
  }

  /**
   * 扫描全局 skill 目录（<CORUM_HOME>/skills/）发现可用 skills。
   *
   * Skill 全局统一管理在 <CORUM_HOME>/skills/，每个 skill 是一个含 SKILL.md
   * 的子目录。Agent 只引用 name 不复制文件——skill 更新即时生效。
   *
   * 返回的列表包含 git 版本信息（commit hash + 是否有未提交修改），
   * 用于 UI 展示版本和回溯。
   */
  @Remote('listSkills')
  listSkillsRemote(): { skills: SkillEntry[] } {
    return { skills: scanSkills() }
  }

  /**
   * 列出所有已注册的 LLM provider 及其模型。
   * 通过 ctx.llm.listProviders() + ctx.llm.listModels() 动态获取，
   * 包含 deepseek-official 和 pi-ai 等第三方适配器注册的 provider。
   */
  @Remote('listModels')
  async listModelsRemote(): Promise<{ providers: ProviderCatalog[] }> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return { providers: [] }
    const providers = llm.listProviders()
    const catalog: ProviderCatalog[] = []
    for (const p of providers) {
      try {
        const models = await llm.listModels(p.id)
        catalog.push({
          id: p.id,
          name: p.name ?? p.id,
          models: models.map(m => ({
            id: m.id,
            name: m.name ?? m.id,
            ...(m.inputModalities !== undefined ? { input: [...m.inputModalities] } : {}),
          })),
        })
      } catch {
        // 跳过 listModels 失败的 provider
      }
    }
    return { providers: catalog }
  }

  /**
   * 日志验证（冒烟测试）：用内置 smoke-test profile 跑一个固定提示词，把
   * 「创建 Agent → 驱动 → 汇总」的完整闭环打到 stderr 日志。
   */
  async verify(): Promise<void> {
    const log = (line: string): void => { process.stderr.write(`[corum-agent] ${line}\n`) }
    try {
      const profile = ensureSmokeProfile()
      log(`verify start — profile "${profile.id}" (${profile.model.provider}/${profile.model.model})`)
      const reply = await this.runProfile(profile.id, SMOKE_PROMPT)
      log(`verify done — agent replied ${JSON.stringify(reply)}`)
    } catch (error) {
      log(`verify failed — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  }


  /**
   * 「agent.json 落盘 → 重新编译 preset 产物 → 内存旧 Agent 失效」的共用收尾
   * （原 saveProfileRemote 的后三步原样抽出，saveProfileRemote 与
   * applySubagentModelForSession 共走这一条路——两条写路径一旦分叉，迟早出现
   * 「改了 agent.json 却没重编译」的半更新状态）。
   *
   * 注意 saveProfile 侧 version 自增：saveProfileRemote 传入的是 version:0 的新对象，
   * 本方法传入的是 loadProfile 出来的存量对象（version 已是现值）——两处语义各自正确，
   * saveProfile 内部统一按「存量 version + 1」落盘。
   *
   * fork（corum）2026-09-19：末尾追加**预设保存补偿**（见
   * {@link CorumAgentService#compensateLiveSessionsForProfile}）——重编译只对新会话
   * 生效，本进程内已挂载该预设的存活会话的 tool-subagent 插件实例不会重建，其
   * `config.model` 仍是旧静态快照；给这些会话补会话级覆盖，下一次委派立即用新模型。
   *
   * @param profile - 要保存的完整 profile。
   * @param previousSnapshot - 保存前的存量快照（补偿变化检测基准；缺省回落 loadProfile，
   *   适用「盘上还是存量」的调用方——applySubagentModelForSession）。
   */
  private persistProfileAndRecompile(profile: AgentProfile, previousSnapshot?: AgentProfile): void {
    // 补偿基准：本次保存**之前**的存量快照（saveProfileRemote 在进入本方法前已写过
    // 一遍盘，loadProfile 拿到的是新值——所以快照必须在第一次 saveProfile 前取，
    // 由调用方显式传入；applySubagentModelForSession 不传参，回落读盘 = 存量）。
    // 只对比子 Agent 模型键是否真的变化——无关保存（如改 prompt）不得动会话里
    // 已有的临时覆盖决定。
    const previous = previousSnapshot ?? loadProfile(profile.id)
    saveProfile(profile)
    // 编译并落盘 agent.cordis.yml + preset.yml
    writeAgentDirOf(loadProfile(profile.id)!, agentDirPath(profile.id))
    // 清掉旧 Agent 使下次重建
    this.noteAgentTeardown(profile.id, 'verify')
    this.registry.forgetProfileAgent(profile.id)
    this.compensateLiveSessionsForProfile(profile, previous)
  }

  /**
   * 预设保存补偿：给本进程内**挂载了该预设的存活会话**补会话级子 Agent 模型覆盖，
   * 使「设置里改 subagentModel/researchModel 并保存」对存量会话**立即生效**。
   *
   * ## 根因（为什么需要补偿）
   *
   * `compile.ts` 把 profile.subagentModel/researchModel 编译进 agent.cordis.yml 的
   * tool-subagent 双实例行 `config.model`；`corum-tool-subagent` 委派时取
   * `corumEffectiveModel = corumSessionOverride ?? config.model`，而 `config.model`
   * 是**插件实例创建（预设挂载）时的静态快照**——`persistProfileAndRecompile` 重编译
   * 落盘 + 清 corum-agent 自有缓存，都够不着官方 registry（`ctx.agents`）里存活的
   * 会话：它们的 tool-subagent 插件实例不会重建，下一次委派仍拿旧模型。
   * 与 `corum-tool-subagent/model-ask-run.ts` permanent 档「写预设**同时**补会话级
   * 覆盖」同一手法（同一缺口的两条入口，机制一致）。
   *
   * ## 主模型（profile.model）为什么不补偿
   *
   * 主模型**不走** tool-subagent 的静态 `config.model` 通路：它经
   * `installTaskModelSelection` 的 ModelSelectionRef / 会话模型选择链路在**每次请求
   * 装配时实时读取**（task-model-selection.ts 文件头：官方 installModelSelection 会被
   * 安装时的选择覆盖，故 corum 走实时 ref），且 compile.ts 明确「model → 不进 preset
   * （创建 Agent 时的 agentOptions）」。子 Agent 的「跟随主 Agent」档也是委派时实时读
   * 父的真实路由（`parentAgentOptionsForDelegation`）——主模型变了，跟随档自然跟着变，
   * 无需本补偿。补偿只覆盖走静态快照的 subagent/research 两个角色。
   *
   * ## 语义细则
   *
   * - **变化检测**：与保存前的存量（`previous`）按角色对比**生效值**
   *   （research 生效值 = `researchModel ?? subagentModel`，与 compile.ts 同口径）；
   *   没变的角色**不写**——无关保存（改 prompt 等）不得覆盖会话里 model-ask 临时档
   *   留下的用户决定。变了的角色：新值存在 ⇒ `setModelOverride`（用户的显式保存压过
   *   旧临时决定，正是本补偿的目的）；新值为 undefined（改回「跟随主 Agent」）⇒
   *   `clearModelOverride`（清掉旧值/旧临时决定，回落跟随语义）。
   * - **幂等**：重复保存同值 ⇒ 变化检测不过 ⇒ 零写入；即使写入，Map.set 同键同值
   *   覆盖后状态不变，无叠加副作用。
   * - **fail-soft**：本方法绝不让保存流程失败——corumOrchestration / sessionProjections
   *   缺席、registry 枚举异常、单会话补偿失败，一律跳过 + warn 日志
   *   （会话已结束/不在 registry = 无需补偿，本来就跳过）。
   * - 只补偿**根会话**（跳过带 `parentSession` 的子会话）：子会话的委派锁面随其父
   *   实例组装，生命周期短，补了也随即失效。
   */
  private compensateLiveSessionsForProfile(profile: AgentProfile, previous: AgentProfile | undefined): void {
    // 生效值按角色对比（research 回落 subagentModel，与 compile.ts corumSubagentConfig 同口径）。
    const workerBefore = previous?.subagentModel
    const workerAfter = profile.subagentModel
    const researchBefore = previous?.researchModel ?? previous?.subagentModel
    const researchAfter = profile.researchModel ?? profile.subagentModel
    const workerChanged = !corumRouteEquals(workerBefore, workerAfter)
    const researchChanged = !corumRouteEquals(researchBefore, researchAfter)
    if (!workerChanged && !researchChanged) return

    // 窄能力接口取 corumOrchestration（红线 3：不 import 实现包的类型面；
    // 缺席（headless/单测）= 无覆盖通路，跳过不报错）。
    type OverrideFace = {
      setModelOverride: (sessionId: string, role: 'worker' | 'research', route: { provider: string; model: string; reasoningEffort?: string }) => void
      clearModelOverride: (sessionId: string, role: 'worker' | 'research') => void
    }
    let orchestration: OverrideFace | undefined
    try {
      orchestration = this.ctx.get('corumOrchestration') as OverrideFace | undefined
    } catch {
      return
    }
    if (orchestration === undefined) return
    // 预设归属投影（与 applySubagentModelForSession 同口径：必须 ctx.get，属性访问
    // 在未 inject 时抛 cannot get property … without inject）。
    let projections: AgentPresetProjections | undefined
    try {
      projections = this.ctx.get('sessionProjections' as never) as AgentPresetProjections | undefined
    } catch {
      return
    }
    if (projections === undefined) return

    let compensated = 0
    try {
      // 官方 registry 是「本进程存活」的权威口径（见 applySubagentModelForSession 的
      // 2026-09-19 注释：IDE 侧会话只在 ctx.agents 里）。list() 注册序全量。
      for (const agent of this.ctx.agents.list()) {
        try {
          // 只补根会话：子会话（corum-spawn 的委派产物）带 parentSession 头。
          if (agent.session.header?.parentSession !== undefined) continue
          const presetId = projections.stateOf(agent.session, 'agentPreset')
          if (presetId !== profile.id) continue
          const sessionId = String(agent.session.id)
          if (workerChanged) {
            if (workerAfter !== undefined) orchestration.setModelOverride(sessionId, 'worker', { ...workerAfter })
            else orchestration.clearModelOverride(sessionId, 'worker')
          }
          if (researchChanged) {
            if (researchAfter !== undefined) orchestration.setModelOverride(sessionId, 'research', { ...researchAfter })
            else orchestration.clearModelOverride(sessionId, 'research')
          }
          compensated++
        } catch (error: unknown) {
          // 单会话失败（已结束/投影异常）⇒ 跳过该会话，不中断其余补偿。
          this.ctx.logger.warn(`corum-agent: 补偿会话 ${String((agent as { session?: { id?: unknown } }).session?.id ?? '?')} 失败（跳过）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error: unknown) {
      // registry 枚举本身异常 ⇒ 整体放弃补偿，保存流程不受影响。
      this.ctx.logger.warn(`corum-agent: 预设 "${profile.id}" 保存补偿枚举存活会话失败（跳过）: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (compensated > 0) {
      this.ctx.logger.info(`corum-agent: 预设 "${profile.id}" 保存补偿完成 — ${compensated} 个存活会话已按新 subagent/research 模型补会话级覆盖`)
    }
  }

  /**
   * 按 sessionId 反查泳道/项目模式的存活会话（taskAgents 之外的存活表）。
   *
   * **可见性（2026-09-26 项目模式剥离）**：原为 `private`，闭源仓
   * `@corum/corum-project` 的泳道创建要在「已存活」分支取回该会话的登记项
   * （拿权威 sessionId，而不是拿 `agent.session.id` 猜）——故提为 public。
   * 只改可见性，逻辑逐字未动。
   */
  findLaneAgent(sessionId: string): { agent: Agent; sessionId: SessionId } | undefined {
    return this.registry.findLaneBySession(sessionId)
  }

}

export default CorumAgentService
