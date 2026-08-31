/**
 * panel-types —— AgentTestPanel 的 RPC 投影类型与 Profile 编辑器状态
 * （从 AgentTestPanel.tsx 拆出，包内文件拆分）。
 *
 * contract 已覆盖的类型（ProfileSummary/CorumProject/…）仍从
 * @corum/corum-agent-dev/contract 取；本模块只持有 contract 未 re-export
 * 的本地镜像（SkillBinding/SkillInfo/McpServerSummary/TeamSummary）+
 * 面板内部状态类型（LogEntry/ChatMessage/ProfileDraft）+ draft 构造。
 * @module @corum/corum-agent-ui-dev/panel-types
 */

import type { ProfileSummary, ProjectGroupMember, SessionEventDto } from '@corum/corum-agent-dev/contract'

/** Skill 绑定（引用全局 skill + pin 版本；contract 未 re-export，本地保留）。 */
export interface SkillBinding { name: string; versionId: string }

export interface SkillInfo {
  name: string
  description: string
  path: string
  currentVersion?: string
  versionCount: number
  createdAt?: string
}

export interface McpServerSummary {
  name: string
  description?: string
  transport: 'stdio' | 'streamable-http'
  endpoint: string
}

/** 项目组成员（= contract 的 ProjectGroupMember，保留原短名）。 */
export type GroupMember = ProjectGroupMember

/** 全局团队摘要（项目组管理「拉团队」下拉用）。 */
export interface TeamSummary {
  id: string
  name: string
  memberProfileIds: string[]
}

// ── 日志 ────────────────────────────────────────────────────────────

export interface LogEntry {
  time: string
  level: 'info' | 'error' | 'success'
  message: string
}

// ── 聊天消息 ────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** 关联的 session events（assistant 消息携带工具调用等过程信息）。 */
  events?: SessionEventDto[]
  /** 最终装配的 system prompt（第一条 assistant 消息携带）。 */
  systemPrompt?: string
  /** 装配的工具列表。 */
  tools?: Array<{ name: string; description?: string }>
}

// ── Profile 编辑器状态 ─────────────────────────────────────────────

export interface ProfileDraft {
  id: string
  nickname: string
  title: string
  prompt: string
  provider: string
  model: string
  reasoningEffort: string
  skills: SkillBinding[]
  mcpServers: string[]
  terminalMode: 'sandbox' | 'host'
}

export function profileToDraft(p: ProfileSummary): ProfileDraft {
  return {
    id: p.id,
    nickname: p.nickname ?? '',
    title: p.title ?? '',
    prompt: p.prompt,
    provider: p.model.provider,
    model: p.model.model,
    reasoningEffort: p.model.reasoningEffort ?? '',
    skills: p.skills.map(s => ({ name: s.name, versionId: s.versionId })),
    mcpServers: p.mcpServers,
    terminalMode: p.terminal.mode as 'sandbox' | 'host',
  }
}

export function emptyDraft(): ProfileDraft {
  return {
    id: '',
    nickname: '',
    title: '',
    prompt: 'You are a helpful assistant.',
    provider: '',
    model: '',
    reasoningEffort: '',
    skills: [],
    mcpServers: [],
    terminalMode: 'sandbox',
  }
}
