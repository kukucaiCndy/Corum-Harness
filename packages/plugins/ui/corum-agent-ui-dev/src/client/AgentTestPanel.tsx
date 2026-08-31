/**
 * AgentTestPanel —— dev-agent combo 的测试交互面板（v2）。
 *
 * 四个 tab：
 *   1. Profile 编辑器：创建/编辑 AgentProfile（prompt / model / skills / mcp / terminal）
 *   2. 对话：选择已保存的 Profile → 创建 Agent → 发消息 → 看回复 + 事件流
 *   3. 日志：操作日志
 *   4. Skill 管理：导入/删除/查看 skill
 *
 * 经官方 connection.rpc（0.1.2 起）调 /api/corumAgent/*、/api/corumProject/*、
 * /api/corumTeam/* 等 RPC 端点；caller 由宿主 apply 注入（旧 corumDesktop.unary
 * IPC 桥已退役）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity, Bot, ChevronsUpDown, FlaskConical, Folder, FolderOpen, MessageSquare,
  Package, Plus, RefreshCw, Save, ScrollText, Send, Settings, Trash2, Users, Wrench,
} from 'lucide-react'
import { type CorumRpcCall } from '@corum/corum-rpc-client/client'
// C3b：dev-agent 跨域 RPC 契约——方法名常量 + args/result 类型（type-only；
// 替代此前的本地镜像 interface，与 host @Remote 实现同源、编译期联动）。
import {
  CORUM_AGENT_METHODS, CORUM_PROJECT_METHODS,
  type ProfileSummary, type AgentStatus, type ProviderCatalog,
  type SessionEventDto, type RunPromptResult, type SaveProfileInput,
  type CorumProject, type WorkType, type ProjectGroupMember,
  type CreateProjectArgs, type CreateProjectResult,
  type OpenProjectArgs, type OpenProjectResult,
  type ListWorkTypesArgs, type ListWorkTypesResult,
  type AddWorkTypeArgs, type AddWorkTypeResult,
  type ListGroupMembersArgs, type ListGroupMembersResult,
  type AddTeamToGroupArgs, type AddMemberToGroupArgs, type RemoveGroupMemberArgs,
  type ListProfilesResult, type ListAgentsResult, type ListModelsResult, type ListProjectsResult,
  type SaveProfileArgs, type DeleteProfileArgs,
  type CreateAgentForTypeArgs, type CreateAgentForTypeResult,
  type RunPromptForTypeArgs, type GetSessionEventsForTypeArgs, type GetSessionEventsForTypeResult,
  type VerifyResult,
} from '@corum/corum-agent-dev/contract'
import { SkillManagerPanel, bindSkillManagerRpc } from '@corum/corum-skill-manager-ui-dev/client'
import { TeamManagerPanel } from '@corum/corum-team-ui-dev/client'
import { McpManagerPanel } from './McpManagerPanel.tsx'
import { RuntimeTestPanel } from './RuntimeTestPanel.tsx'
import { DomainEventsPanel } from './DomainEventsPanel.tsx'
import css from './AgentTestPanel.module.css'

// ── RPC 类型 ────────────────────────────────────────────────────────

// ProfileSummary / AgentStatus / ProviderCatalog / SessionEventDto /
// RunPromptResult / SaveProfileInput / CorumProject / WorkType / GroupMember
// 已收敛到 @corum/corum-agent-dev/contract（见上方 import，C3b）。

/** Skill 绑定（引用全局 skill + pin 版本；contract 未 re-export，本地保留）。 */
interface SkillBinding { name: string; versionId: string }

interface SkillInfo {
  name: string
  description: string
  path: string
  currentVersion?: string
  versionCount: number
  createdAt?: string
}

interface McpServerSummary {
  name: string
  description?: string
  transport: 'stdio' | 'streamable-http'
  endpoint: string
}

/** 项目组成员（= contract 的 ProjectGroupMember，保留原短名）。 */
type GroupMember = ProjectGroupMember

/** 全局团队摘要（项目组管理「拉团队」下拉用）。 */
interface TeamSummary {
  id: string
  name: string
  memberProfileIds: string[]
}

// ── 日志 ────────────────────────────────────────────────────────────

interface LogEntry {
  time: string
  level: 'info' | 'error' | 'success'
  message: string
}

// ── 聊天消息 ────────────────────────────────────────────────────────

interface ChatMessage {
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

interface ProfileDraft {
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

function profileToDraft(p: ProfileSummary): ProfileDraft {
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

function emptyDraft(): ProfileDraft {
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

// ── 主组件 ──────────────────────────────────────────────────────────

type Tab = 'editor' | 'chat' | 'logs' | 'skill-manager' | 'mcp-manager' | 'runtime' | 'events' | 'team'

/** 面板对外依赖：命名空间化的 corum RPC caller（corumAgent/corumProject/corumTeam/…）。 */
export interface AgentTestPanelProps {
  readonly callRemote: CorumRpcCall
}

export function AgentTestPanel({ callRemote }: AgentTestPanelProps): ReactNode {
  const [tab, setTab] = useState<Tab>('editor')
  const [profiles, setProfiles] = useState<readonly ProfileSummary[]>([])
  const [agents, setAgents] = useState<readonly AgentStatus[]>([])
  const [availableSkills, setAvailableSkills] = useState<readonly SkillInfo[]>([])
  const [providers, setProviders] = useState<readonly ProviderCatalog[]>([])
  const [mcpServers, setMcpServers] = useState<readonly McpServerSummary[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [busy, setBusy] = useState(false)

  // 项目状态（当前选中项目 + 项目列表 + 该项目的工作类型表）。
  const [projects, setProjects] = useState<readonly CorumProject[]>([])
  const [currentProject, setCurrentProject] = useState<CorumProject | null>(null)
  const [workTypes, setWorkTypes] = useState<readonly WorkType[]>([])
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  /** 新建项目对话框开关（独立对话框：填名字 + 选目录 + 提交）。 */
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [newWorkTypeLabel, setNewWorkTypeLabel] = useState('')
  /** 当前项目组成员（项目的运行时成员边界；对话/运行时的可选成员来源）。 */
  const [groupMembers, setGroupMembers] = useState<readonly GroupMember[]>([])
  /** 项目组管理面板开关。 */
  const [groupManageOpen, setGroupManageOpen] = useState(false)
  /** 全局团队列表（项目组管理面板「拉团队」用）。 */
  const [allTeams, setAllTeams] = useState<readonly TeamSummary[]>([])

  // Profile 编辑器状态
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft())
  const [editingExisting, setEditingExisting] = useState<string | null>(null)

  // Profile ID 实时校验（与 host isValidProfileId 一致：小写字母/数字/连字符，小写或数字开头）。
  // 仅新建时可编辑 id；编辑已有 profile 时 id 只读，无需校验。
  const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
  const idError: string | null = (() => {
    if (editingExisting !== null) return null
    const id = draft.id.trim()
    if (id === '') return null // 空 id 由保存时的「不能为空」提示
    if (!PROFILE_ID_PATTERN.test(id)) return '仅允许小写字母 / 数字 / 连字符，且以小写或数字开头（如 test-agent）'
    return null
  })()

  // 聊天状态
  const [chatProfile, setChatProfile] = useState<string | null>(null)
  const [chatWorkType, setChatWorkType] = useState<string>('general')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatRunning, setChatRunning] = useState(false)
  /** 已创建（存活）的泳道会话键：`${profileId}${type}`。 */
  const [createdLanes, setCreatedLanes] = useState<ReadonlySet<string>>(new Set())
  const chatScrollRef = useRef<HTMLDivElement | null>(null)

  const log = useCallback((level: LogEntry['level'], message: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs(prev => [...prev, { time, level, message }])
  }, [])

  const refresh = useCallback(async () => {
    try {
      const { profiles: p } = await callRemote<ListProfilesResult>('corumAgent', CORUM_AGENT_METHODS.listProfiles, {})
      setProfiles(p)
      log('info', `已加载 ${p.length} 个 Profile`)
    } catch (error) {
      log('error', `加载 Profile 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const { agents: a } = await callRemote<ListAgentsResult>('corumAgent', CORUM_AGENT_METHODS.listAgents, {})
      setAgents(a)
    } catch { /* 静默 */ }
    try {
      const { skills: sk } = await callRemote<{ skills: SkillInfo[] }>('skillManager', 'listAll', {})
      setAvailableSkills(sk)
      log('info', `已发现 ${sk.length} 个可用 Skill`)
    } catch { /* skillManager 服务可能尚未就绪 */ }
    try {
      const { providers: p } = await callRemote<ListModelsResult>('corumAgent', CORUM_AGENT_METHODS.listModels, {})
      setProviders(p)
      log('info', `已加载 ${p.length} 个模型 Provider`)
    } catch { /* llm 服务可能尚未就绪 */ }
    try {
      const { servers: s } = await callRemote<{ servers: McpServerSummary[] }>('mcpManager', 'listServers', {})
      setMcpServers(s)
      log('info', `已加载 ${s.length} 个 MCP 服务`)
    } catch { /* mcpManager 服务可能尚未就绪 */ }
    try {
      const { projects: pj } = await callRemote<ListProjectsResult>('corumProject', CORUM_PROJECT_METHODS.listProjects, {})
      setProjects(pj)
      log('info', `已加载 ${pj.length} 个项目`)
    } catch { /* corumProject 服务可能尚未就绪 */ }
  }, [log, callRemote])

  /** 加载一个项目的工作类型表（框架兜底 + 项目自定义）。 */
  const loadWorkTypes = useCallback(async (projectId: string) => {
    try {
      const args: ListWorkTypesArgs = { id: projectId }
      const { workTypes: wt } = await callRemote<ListWorkTypesResult>('corumProject', CORUM_PROJECT_METHODS.listWorkTypes, args)
      setWorkTypes(wt)
    } catch (error) {
      log('error', `加载工作类型失败：${error instanceof Error ? error.message : String(error)}`)
      setWorkTypes([])
    }
  }, [log, callRemote])

  /** 加载一个项目的项目组成员（对话/运行时的可选成员来源）。 */
  const loadGroupMembers = useCallback(async (projectId: string) => {
    try {
      const args: ListGroupMembersArgs = { id: projectId }
      const { members } = await callRemote<ListGroupMembersResult>('corumProject', CORUM_PROJECT_METHODS.listGroupMembers, args)
      setGroupMembers(members)
    } catch (error) {
      log('error', `加载项目组成员失败：${error instanceof Error ? error.message : String(error)}`)
      setGroupMembers([])
    }
  }, [log, callRemote])

  /** 加载全局团队列表（项目组管理「拉团队」用）。 */
  const loadAllTeams = useCallback(async () => {
    try {
      const { teams } = await callRemote<{ teams: TeamSummary[] }>('corumTeam', 'listTeams', {})
      setAllTeams(teams)
    } catch { /* corumTeam 服务可能尚未就绪 */ }
  }, [callRemote])

  /** 选中（打开）一个项目：刷新 lastOpenedAt、设为当前项目、加载其工作类型与项目组成员。 */
  const onOpenProject = useCallback(async (id: string) => {
    try {
      const args: OpenProjectArgs = { id }
      const { project } = await callRemote<OpenProjectResult>('corumProject', CORUM_PROJECT_METHODS.openProject, args)
      setCurrentProject(project)
      setProjectPickerOpen(false)
      log('success', `已打开项目 "${project.name}"（${project.id}）`)
      await loadWorkTypes(project.id)
      await loadGroupMembers(project.id)
      await loadAllTeams()
    } catch (error) {
      log('error', `打开项目失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [loadWorkTypes, loadGroupMembers, loadAllTeams, log, callRemote])

  /** 新建项目。 */
  /**
   * 提交新建项目（由新建对话框收集 name + cwd 后回调）。
   * 工作目录是用户指定的代码存放位置；corum 项目配置目录由 host 内部自建于
   * $CORUM_HOME/projects/<id>/，与工作目录分离。
   */
  const onCreateProject = useCallback(async (name: string, cwd: string) => {
    setBusy(true)
    try {
      const args: CreateProjectArgs = {
        name,
        ...(cwd !== '' ? { cwd } : {}),
      }
      const { project } = await callRemote<CreateProjectResult>('corumProject', CORUM_PROJECT_METHODS.createProject, args)
      log('success', `项目 "${project.name}" 已创建（projectId: ${project.id}）${project.cwd !== undefined ? `，工作目录：${project.cwd}` : ''}`)
      setNewProjectOpen(false)
      setCurrentProject(project)
      await loadWorkTypes(project.id)
      await loadGroupMembers(project.id)
      await loadAllTeams()
      await refresh()
    } catch (error) {
      log('error', `创建项目失败：${error instanceof Error ? error.message : String(error)}`)
      throw error // 让对话框保留输入并显示错误
    } finally {
      setBusy(false)
    }
  }, [loadWorkTypes, loadGroupMembers, loadAllTeams, log, refresh, callRemote])

  /** 给当前项目新增一个自定义工作类型（泳道）。 */
  const onAddWorkType = useCallback(async () => {
    if (currentProject === null) return
    const label = newWorkTypeLabel.trim()
    if (label === '') return
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    try {
      const args: AddWorkTypeArgs = { id: currentProject.id, slug, label }
      const { workTypes: wt } = await callRemote<AddWorkTypeResult>('corumProject', CORUM_PROJECT_METHODS.addWorkType, args)
      setWorkTypes(wt)
      setNewWorkTypeLabel('')
      log('success', `已添加工作类型 "${label}"（${slug}）`)
    } catch (error) {
      log('error', `添加工作类型失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [currentProject, newWorkTypeLabel, log, callRemote])

  // ── 项目组管理（拉团队 / 拉 Agent / 移除成员） ──

  /** 把一个团队整体拉进当前项目的项目组。 */
  const onAddTeamToGroup = useCallback(async (teamId: string) => {
    if (currentProject === null) return
    try {
      const args: AddTeamToGroupArgs = { id: currentProject.id, teamId }
      await callRemote('corumProject', CORUM_PROJECT_METHODS.addTeamToGroup, args)
      log('success', `已把团队 "${teamId}" 拉进项目组`)
      await loadGroupMembers(currentProject.id)
    } catch (error) {
      log('error', `拉团队失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [currentProject, loadGroupMembers, log, callRemote])

  /** 把单个 Agent 拉进当前项目的项目组（可来自团队或独立 Agent）。 */
  const onAddMemberToGroup = useCallback(async (profileId: string, fromTeam?: string) => {
    if (currentProject === null) return
    try {
      const args: AddMemberToGroupArgs = {
        id: currentProject.id, profileId, ...(fromTeam !== undefined ? { fromTeam } : {}),
      }
      await callRemote('corumProject', CORUM_PROJECT_METHODS.addMemberToGroup, args)
      log('success', `已把 ${profileId} 拉进项目组`)
      await loadGroupMembers(currentProject.id)
    } catch (error) {
      log('error', `添加成员失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [currentProject, loadGroupMembers, log, callRemote])

  /** 从当前项目的项目组移除一个成员。 */
  const onRemoveGroupMember = useCallback(async (profileId: string) => {
    if (currentProject === null) return
    try {
      const args: RemoveGroupMemberArgs = { id: currentProject.id, profileId }
      await callRemote('corumProject', CORUM_PROJECT_METHODS.removeGroupMember, args)
      log('success', `已把 ${profileId} 移出项目组`)
      await loadGroupMembers(currentProject.id)
    } catch (error) {
      log('error', `移除成员失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [currentProject, loadGroupMembers, log, callRemote])

  useEffect(() => { void refresh() }, [refresh])

  // ── Profile 编辑器操作 ──

  const onNewProfile = useCallback(() => {
    setDraft(emptyDraft())
    setEditingExisting(null)
  }, [])

  const onEditProfile = useCallback((p: ProfileSummary) => {
    setDraft(profileToDraft(p))
    setEditingExisting(p.id)
  }, [])

  const onSaveProfile = useCallback(async () => {
    if (draft.id.trim() === '') {
      log('error', 'Profile ID 不能为空')
      return
    }
    setBusy(true)
    log('info', `保存 Profile "${draft.id}"...`)
    try {
      const input: SaveProfileInput = {
        id: draft.id.trim(),
        ...(draft.nickname.trim() !== '' ? { nickname: draft.nickname.trim() } : {}),
        ...(draft.title.trim() !== '' ? { title: draft.title.trim() } : {}),
        prompt: draft.prompt,
        model: {
          provider: draft.provider,
          model: draft.model,
          ...(draft.reasoningEffort === '' ? {} : { reasoningEffort: draft.reasoningEffort }),
        },
        skills: draft.skills,
        mcpServers: draft.mcpServers,
        terminal: { mode: draft.terminalMode },
        memoryPolicy: { scope: 'agent' },
        trust: 'user',
      }
      const args: SaveProfileArgs = { input }
      await callRemote('corumAgent', CORUM_AGENT_METHODS.saveProfile, args)
      log('success', `Profile "${draft.id}" 已保存${draft.skills.length > 0 ? `（绑定 ${draft.skills.length} 个 skill）` : ''}${draft.mcpServers.length > 0 ? `（授权 ${draft.mcpServers.length} 个 MCP）` : ''}`)
      await refresh()
    } catch (error) {
      log('error', `保存失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [draft, log, refresh, callRemote])

  const onDeleteProfile = useCallback(async (id: string) => {
    setBusy(true)
    log('info', `删除 Profile "${id}"...`)
    try {
      const args: DeleteProfileArgs = { id }
      await callRemote('corumAgent', CORUM_AGENT_METHODS.deleteProfile, args)
      log('success', `Profile "${id}" 已删除`)
      if (editingExisting === id) {
        setDraft(emptyDraft())
        setEditingExisting(null)
      }
      await refresh()
    } catch (error) {
      log('error', `删除失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [editingExisting, log, refresh, callRemote])

  // ── 聊天操作 ──

  /** 当前泳道会话键（profile + type）。 */
  const laneKey = useCallback((profileId: string, type: string) => `${profileId}${type}`, [])

  /** 把泳道会话的历史事件投影成聊天消息（user/assistant 文本）。 */
  const projectLaneHistory = useCallback((events: SessionEventDto[]): ChatMessage[] => {
    const messages: ChatMessage[] = []
    for (const e of events) {
      const data = e.data as Record<string, unknown> | undefined
      if (e.type === 'user/message') {
        const message = data?.message as { content?: Array<{ type: string; text?: string }> } | undefined
        const text = (message?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
        if (text.trim() !== '') messages.push({ role: 'user', text })
      } else if (e.type === 'assistant/message') {
        const message = data?.message as { content?: Array<{ type: string; text?: string }> } | undefined
        const text = (message?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
        if (text.trim() !== '') messages.push({ role: 'assistant', text })
      }
    }
    return messages
  }, [])

  /** 读泳道会话历史并回填聊天区（切泳道/选 profile 后调用）。 */
  const loadLaneHistory = useCallback(async (profileId: string, type: string) => {
    if (currentProject === null) return
    try {
      const args: GetSessionEventsForTypeArgs = {
        projectId: currentProject.id, profileId, type, fromSeq: 0,
      }
      const { events } = await callRemote<GetSessionEventsForTypeResult>('corumAgent', CORUM_AGENT_METHODS.getSessionEventsForType, args)
      setChatMessages(projectLaneHistory(events))
    } catch { /* 会话未存活或无历史 → 空 */ setChatMessages([]) }
  }, [currentProject, projectLaneHistory, callRemote])

  const onChatStart = useCallback(async (profileId: string) => {
    if (currentProject === null) {
      log('error', '请先选择项目（项目条）再创建会话')
      return
    }
    setBusy(true)
    log('info', `创建泳道会话 (profile: ${profileId}, 类型: ${chatWorkType})...`)
    try {
      const args: CreateAgentForTypeArgs = {
        projectId: currentProject.id, profileId, type: chatWorkType,
      }
      const { sessionId } = await callRemote<CreateAgentForTypeResult>('corumAgent', CORUM_AGENT_METHODS.createAgentForType, args)
      log('success', `泳道会话已就绪 — ${sessionId}`)
      setChatProfile(profileId)
      setCreatedLanes(prev => new Set(prev).add(laneKey(profileId, chatWorkType)))
      setTab('chat')
      await loadLaneHistory(profileId, chatWorkType)
    } catch (error) {
      log('error', `创建会话失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [currentProject, chatWorkType, laneKey, loadLaneHistory, log, callRemote])

  const onChatSend = useCallback(async () => {
    if (currentProject === null || chatProfile === null || chatInput.trim() === '') return
    const userText = chatInput.trim()
    setChatInput('')
    setChatRunning(true)
    setChatMessages(prev => [...prev, { role: 'user', text: userText }])
    log('info', `发送消息 (${chatProfile} / ${chatWorkType})...`)
    try {
      const args: RunPromptForTypeArgs = {
        projectId: currentProject.id, profileId: chatProfile, type: chatWorkType, prompt: userText,
      }
      const result = await callRemote<RunPromptResult>('corumAgent', CORUM_AGENT_METHODS.runPromptForType, args)
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        text: result.reply,
        events: result.events,
        ...(result.systemPrompt !== undefined ? { systemPrompt: result.systemPrompt } : {}),
        ...(result.tools !== undefined ? { tools: result.tools } : {}),
      }])
      log('success', `Agent 回复: ${result.reply.slice(0, 200)}${result.reply.length > 200 ? '...' : ''}`)
    } catch (error) {
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        text: `[错误] ${error instanceof Error ? error.message : String(error)}`,
      }])
      log('error', `运行失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setChatRunning(false)
    }
  }, [currentProject, chatProfile, chatWorkType, chatInput, log, callRemote])

  // 自动滚动到底部
  useEffect(() => {
    if (chatScrollRef.current !== null) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [chatMessages])

  const isAgentCreated = chatProfile !== null && createdLanes.has(laneKey(chatProfile, chatWorkType))

  // ── 冒烟测试 ──
  const onVerify = useCallback(async () => {
    setBusy(true)
    log('info', '开始冒烟测试...')
    try {
      const result = await callRemote<VerifyResult>('corumAgent', CORUM_AGENT_METHODS.verify, {})
      if (result.ok) {
        log('success', `冒烟测试通过 — ${JSON.stringify(result.reply)}`)
      } else {
        log('error', `冒烟测试失败 — ${result.error}`)
      }
    } catch (error) {
      log('error', `冒烟测试异常 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [log, callRemote])

  const currentProvider = providers.find(p => p.id === draft.provider)
  const reasoningEfforts = ['off', 'low', 'high', 'max']

  // ── Skills 勾选辅助函数 ──
  const isSkillChecked = useCallback((skillName: string): boolean => {
    return draft.skills.some(s => s.name === skillName)
  }, [draft.skills])

  const toggleSkill = useCallback((skill: SkillInfo) => {
    setDraft(d => {
      const existing = d.skills.find(s => s.name === skill.name)
      if (existing) {
        return { ...d, skills: d.skills.filter(s => s.name !== skill.name) }
      }
      return { ...d, skills: [...d.skills, { name: skill.name, versionId: skill.currentVersion ?? '' }] }
    })
  }, [])

  return (
    <div className={css.root}>
      {/* 标题栏 */}
      <header className={css.header}>
        <div className={css.headerLeft}>
          <Bot size={20} />
          <span className={css.title}>Corum Agent 开发验证</span>
          <span className={css.badge}>dev-agent combo</span>
        </div>
        <div className={css.headerRight}>
          <button type="button" className={css.headerBtn} disabled={busy || chatRunning} onClick={() => { void refresh() }}>
            <RefreshCw size={14} /> 刷新
          </button>
          <button type="button" className={css.headerBtn} disabled={busy || chatRunning} onClick={() => { void onVerify() }}>
            <FlaskConical size={14} /> 冒烟测试
          </button>
        </div>
      </header>

      {/* 项目条：当前项目 + 切换/新建 + 工作类型泳道（团队属项目，影响对话/运行时路由）。 */}
      <div className={css.projectBar}>
        <div className={css.projectBarLeft}>
          <button
            type="button"
            className={css.projectPicker}
            aria-expanded={projectPickerOpen}
            onClick={() => { setProjectPickerOpen(v => !v) }}
            title="切换项目"
          >
            <FolderOpen size={14} />
            <span className={css.projectPickerName}>
              {currentProject !== null ? currentProject.name : '选择项目'}
            </span>
            {currentProject !== null && <span className={css.projectPickerId}>{currentProject.id}</span>}
            <ChevronsUpDown size={12} />
          </button>
          {currentProject !== null && (
            <span className={css.projectCwd} title={currentProject.cwd ?? '未设工作目录（退回进程目录）'}>
              {currentProject.cwd ?? '未设工作目录'}
            </span>
          )}
          {projectPickerOpen && (
            <div className={css.projectDropdown}>
              {projects.length === 0 && <div className={css.projectDropdownEmpty}>暂无项目</div>}
              {projects.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={css.projectItem}
                  data-active={currentProject?.id === p.id || undefined}
                  onClick={() => { void onOpenProject(p.id) }}
                >
                  <Folder size={13} />
                  <span className={css.projectItemName}>{p.name}</span>
                  <span className={css.projectItemId}>{p.id}</span>
                </button>
              ))}
              <div className={css.projectNewRow}>
                <button
                  type="button"
                  className={css.projectNewEntryBtn}
                  onClick={() => { setProjectPickerOpen(false); setNewProjectOpen(true) }}
                >
                  <Plus size={14} /> 新建项目…
                </button>
              </div>
            </div>
          )}
        </div>
        {/* 工作类型泳道（当前项目的类型表 + 自定义扩展）。 */}
        {currentProject !== null && (
          <div className={css.workTypeLane}>
            <span className={css.workTypeLaneLabel}>工作类型</span>
            {workTypes.map(t => (
              <span key={t.slug} className={css.workTypeChip} data-builtin={t.builtin || undefined} title={t.description ?? t.label}>
                {t.label}
              </span>
            ))}
            <input
              className={css.workTypeInput}
              placeholder="+ 自定义泳道"
              value={newWorkTypeLabel}
              onChange={e => { setNewWorkTypeLabel(e.target.value) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void onAddWorkType() } }}
            />
          </div>
        )}
      </div>

      {/* Tab 栏 */}
      <nav className={css.tabs}>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'editor' || undefined} onClick={() => { setTab('editor'); void refresh() }}>
          <Settings size={14} /> Profile 配置
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'chat' || undefined} onClick={() => { setTab('chat') }}>
          <MessageSquare size={14} /> 对话
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'skill-manager' || undefined} onClick={() => { setTab('skill-manager') }}>
          <Package size={14} /> Skill 管理
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'mcp-manager' || undefined} onClick={() => { setTab('mcp-manager') }}>
          <Wrench size={14} /> MCP 管理
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'runtime' || undefined} onClick={() => { setTab('runtime') }}>
          <Activity size={14} /> 任务运行时
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'events' || undefined} onClick={() => { setTab('events') }}>
          <ScrollText size={14} /> 事件
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'team' || undefined} onClick={() => { setTab('team') }}>
          <Users size={14} /> 团队
        </button>
        <button type="button" role="tab" className={css.tab} data-active={tab === 'logs' || undefined} onClick={() => { setTab('logs') }}>
          <Activity size={14} /> 日志
        </button>
      </nav>

      <div className={css.body}>
        {/* ── Tab 1: Profile 编辑器 ── */}
        {tab === 'editor' && (
          <div className={css.editorLayout}>
            {/* 左侧：Profile 列表 */}
            <aside className={css.profileListPanel}>
              <div className={css.profileListHeader}>
                <span className={css.sidebarTitle}>Profiles</span>
                <button type="button" className={css.iconBtn} title="新建" onClick={onNewProfile}>
                  <Plus size={14} />
                </button>
              </div>
              <div className={css.profileList}>
                {profiles.length === 0 && (
                  <div className={css.emptyText}>暂无 Profile，点击 + 创建</div>
                )}
                {profiles.map(p => (
                  <div
                    key={p.id}
                    className={css.profileCard}
                    data-selected={editingExisting === p.id || undefined}
                    onClick={() => { onEditProfile(p) }}
                  >
                    <div className={css.profileCardHead}>
                      <span className={css.profileId}>{p.nickname ?? p.id}</span>
                      {agents.some(a => a.profileId === p.id) && (
                        <span className={css.agentBadge}><Activity size={10} /> 已创建</span>
                      )}
                    </div>
                    {(p.title !== undefined || p.nickname !== undefined) && (
                      <div className={css.profileSub}>
                        {p.title !== undefined && <span className={css.profileTitle}>{p.title}</span>}
                        {p.nickname !== undefined && <span className={css.profileIdSub}>{p.id}</span>}
                      </div>
                    )}
                    <div className={css.profileModel}>{p.model.provider}/{p.model.model}</div>
                    <div className={css.profilePrompt}>{p.prompt.slice(0, 60)}{p.prompt.length > 60 ? '...' : ''}</div>
                    <div className={css.profileMeta}>
                      {p.skills.length > 0 && <span>skills: {p.skills.length}</span>}
                      {p.mcpServers.length > 0 && <span>mcp: {p.mcpServers.length}</span>}
                      <span>terminal: {p.terminal.mode}</span>
                      <span>v{p.version}</span>
                    </div>
                  </div>
                ))}
              </div>
            </aside>

            {/* 右侧：编辑表单 */}
            <main className={css.editorForm}>
              <div className={css.formSection}>
                <label className={css.formLabel}>Profile ID</label>
                <input
                  className={css.formInput}
                  {...(idError !== null ? { 'data-invalid': true } : {})}
                  value={draft.id}
                  onChange={e => { setDraft(d => ({ ...d, id: e.target.value })) }}
                  placeholder="my-agent（slug 格式）"
                  disabled={editingExisting !== null}
                />
                {idError !== null && <span className={css.formFieldError}>{idError}</span>}
              </div>

              <div className={css.formRow}>
                <div className={css.formSection}>
                  <label className={css.formLabel}>昵称</label>
                  <input
                    className={css.formInput}
                    value={draft.nickname}
                    onChange={e => { setDraft(d => ({ ...d, nickname: e.target.value })) }}
                    placeholder="显示昵称（可选）"
                  />
                </div>
                <div className={css.formSection}>
                  <label className={css.formLabel}>职位</label>
                  <input
                    className={css.formInput}
                    value={draft.title}
                    onChange={e => { setDraft(d => ({ ...d, title: e.target.value })) }}
                    placeholder="岗位 / 职位（可选）"
                  />
                </div>
              </div>

              <div className={css.formSection}>
                <label className={css.formLabel}>System Prompt</label>
                <textarea
                  className={css.formTextarea}
                  value={draft.prompt}
                  onChange={e => { setDraft(d => ({ ...d, prompt: e.target.value })) }}
                  rows={4}
                  placeholder="Agent 的系统提示词..."
                />
              </div>

              <div className={css.formRow}>
                <div className={css.formSection}>
                  <label className={css.formLabel}>Provider</label>
                  <select
                    className={css.formSelect}
                    value={draft.provider}
                    onChange={e => {
                      const prov = providers.find(p => p.id === e.target.value)
                      setDraft(d => ({ ...d, provider: e.target.value, model: prov?.models[0]?.id ?? '' }))
                    }}
                  >
                    {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className={css.formSection}>
                  <label className={css.formLabel}>Model</label>
                  <select
                    className={css.formSelect}
                    value={draft.model}
                    onChange={e => { setDraft(d => ({ ...d, model: e.target.value })) }}
                  >
                    {currentProvider?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div className={css.formSection}>
                  <label className={css.formLabel}>Reasoning Effort</label>
                  <select
                    className={css.formSelect}
                    value={draft.reasoningEffort}
                    onChange={e => { setDraft(d => ({ ...d, reasoningEffort: e.target.value })) }}
                  >
                    <option value="">默认</option>
                    {reasoningEfforts.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              </div>

              <div className={css.formSection}>
                <label className={css.formLabel}>
                  Skills
                  {availableSkills.length > 0 && <span className={css.formLabelCount}>{availableSkills.length} 个可用</span>}
                  {draft.skills.length > 0 && <span className={css.formLabelCount}>已选 {draft.skills.length}</span>}
                </label>
                {availableSkills.length === 0 ? (
                  <div className={css.skillsEmpty}>
                    暂无可用 Skill。请在 Skill 管理 tab 中导入 skill，
                    或在 skills 目录下创建含 SKILL.md 的子目录。
                  </div>
                ) : (
                  <div className={css.skillList}>
                    {availableSkills.map(sk => {
                      const checked = isSkillChecked(sk.name)
                      return (
                        <label key={sk.name} className={css.skillItem} data-checked={checked || undefined}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => { toggleSkill(sk) }}
                          />
                          <div className={css.skillItemBody}>
                            <div className={css.skillItemHead}>
                              <span className={css.skillName}>{sk.name}</span>
                              <span className={css.skillGit}>
                                {sk.currentVersion ?? '无版本'} · {sk.versionCount} 个版本
                              </span>
                              {checked && <span className={css.skillImportBadge}>已绑定</span>}
                            </div>
                            <span className={css.skillDesc}>{sk.description}</span>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className={css.formSection}>
                <label className={css.formLabel}>Terminal Mode</label>
                <select
                  className={css.formSelect}
                  value={draft.terminalMode}
                  onChange={e => { setDraft(d => ({ ...d, terminalMode: e.target.value as 'sandbox' | 'host' })) }}
                >
                  <option value="sandbox">sandbox</option>
                  <option value="host">host</option>
                </select>
              </div>

              {/* MCP 授权选择 */}
              <div className={css.formRow}>
                <label className={css.formLabel}>MCP 服务授权</label>
                {mcpServers.length === 0 ? (
                  <span className={css.formHint}>暂无已注册 MCP 服务，请在 MCP 管理 tab 添加。</span>
                ) : (
                  <div className={css.skillChips}>
                    {mcpServers.map(s => {
                      const selected = draft.mcpServers.includes(s.name)
                      return (
                        <button
                          key={s.name}
                          type="button"
                          className={css.skillChip}
                          data-selected={selected || undefined}
                          title={`${s.transport}: ${s.endpoint}`}
                          onClick={() => {
                            setDraft(d => ({
                              ...d,
                              mcpServers: selected
                                ? d.mcpServers.filter(n => n !== s.name)
                                : [...d.mcpServers, s.name],
                            }))
                          }}
                        >
                          {s.name}
                          {s.description !== undefined ? ` — ${s.description}` : ''}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className={css.formActions}>
                <button type="button" className={css.saveBtn} disabled={busy || idError !== null} onClick={() => { void onSaveProfile() }}>
                  <Save size={14} /> 保存 Profile
                </button>
                {editingExisting !== null && (
                  <button type="button" className={css.dangerBtn} disabled={busy} onClick={() => { void onDeleteProfile(editingExisting) }}>
                    <Trash2 size={14} /> 删除
                  </button>
                )}
                {editingExisting !== null && (
                  <button type="button" className={css.chatStartBtn} disabled={busy} onClick={() => { void onChatStart(editingExisting) }}>
                    <MessageSquare size={14} /> 创建 Agent 并对话
                  </button>
                )}
              </div>
            </main>
          </div>
        )}

        {/* ── Tab 2: 对话 ── */}
        {tab === 'chat' && (
          <div className={css.chatLayout}>
            {/* 左侧：选择 Profile + 泳道 */}
            <aside className={css.chatSidebar}>
              {currentProject === null ? (
                <div className={css.emptyText}>请先在顶部项目条选择一个项目，再开始对话</div>
              ) : (
                <>
                  <div className={css.profileListHeader}>
                    <span className={css.sidebarTitle}>项目组成员（{groupMembers.length}）</span>
                    <button type="button" className={css.groupManageBtn} title="管理项目组成员（拉团队/拉 Agent/移除）" onClick={() => { setGroupManageOpen(true) }}>
                      <Users size={12} /> 管理
                    </button>
                  </div>
                  {/* 泳道选择器：当前项目的工作类型表，决定对话进哪个会话。 */}
                  <div className={css.lanePicker}>
                    {workTypes.map(t => (
                      <button
                        key={t.slug}
                        type="button"
                        className={css.laneChip}
                        data-active={chatWorkType === t.slug || undefined}
                        title={t.description ?? t.label}
                        onClick={() => {
                          setChatWorkType(t.slug)
                          if (chatProfile !== null) void loadLaneHistory(chatProfile, t.slug)
                        }}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <div className={css.profileList}>
                    {groupMembers.length === 0 && (
                      <div className={css.emptyText}>项目组暂无成员。点上方「管理」把团队或 Agent 拉进项目组。</div>
                    )}
                    {groupMembers.map(m => {
                      const p = profiles.find(x => x.id === m.profileId)
                      return (
                        <div
                          key={m.profileId}
                          className={css.profileCard}
                          data-selected={chatProfile === m.profileId || undefined}
                          onClick={() => { setChatProfile(m.profileId); void loadLaneHistory(m.profileId, chatWorkType) }}
                        >
                          <div className={css.profileCardHead}>
                            <span className={css.profileId}>{p?.nickname ?? m.profileId}</span>
                            {m.role === 'pm' && <span className={css.pmBadge}>PM</span>}
                            {createdLanes.has(laneKey(m.profileId, chatWorkType)) && (
                              <span className={css.agentBadge}><Activity size={10} /> 已创建</span>
                            )}
                          </div>
                          <div className={css.profileSub}>
                            {p?.title !== undefined && <span className={css.profileTitle}>{p.title}</span>}
                            <span className={css.profileIdSub}>{m.profileId}{m.fromTeam !== undefined ? ` · 来自 ${m.fromTeam}` : ''}</span>
                          </div>
                          {p !== undefined && <div className={css.profileModel}>{p.model.provider}/{p.model.model}</div>}
                        </div>
                      )
                    })}
                  </div>
                  {chatProfile !== null && !isAgentCreated && (
                    <button type="button" className={css.chatStartBtn} disabled={busy} onClick={() => { void onChatStart(chatProfile) }}>
                      <Bot size={14} /> 创建泳道会话
                    </button>
                  )}
                </>
              )}
            </aside>

            {/* 右侧：聊天区 */}
            <main className={css.chatMain}>
              {currentProject === null ? (
                <div className={css.emptyText}>请先选择一个项目</div>
              ) : chatProfile === null ? (
                <div className={css.emptyText}>请从左侧选择一个 Profile 和工作类型</div>
              ) : !isAgentCreated ? (
                <div className={css.emptyText}>
                  「{workTypes.find(t => t.slug === chatWorkType)?.label ?? chatWorkType}」泳道会话尚未创建，点击左侧「创建泳道会话」按钮
                </div>
              ) : (
                <>
                  <div className={css.chatMessages} ref={chatScrollRef}>
                    {chatMessages.length === 0 && (
                      <div className={css.emptyText}>输入消息开始与 Agent 对话</div>
                    )}
                    {chatMessages.map((msg, i) => (
                      <ChatMessageView key={i} message={msg} />
                    ))}
                    {chatRunning && (
                      <div className={css.chatLoading}>
                        <RefreshCw size={14} className={css.spinning} /> Agent 思考中...
                      </div>
                    )}
                  </div>
                  <div className={css.chatInputBar}>
                    <textarea
                      className={css.chatInput}
                      value={chatInput}
                      onChange={e => { setChatInput(e.target.value) }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          if (!chatRunning) void onChatSend()
                        }
                      }}
                      rows={1}
                      placeholder="输入消息，Enter 发送，Shift+Enter 换行..."
                      disabled={chatRunning}
                    />
                    <button type="button" className={css.sendBtn} disabled={chatRunning || chatInput.trim() === ''} onClick={() => { void onChatSend() }}>
                      <Send size={14} />
                    </button>
                  </div>
                </>
              )}
            </main>
          </div>
        )}

        {/* ── Tab 3: Skill 管理（独立组件，可复用到 IDE） ── */}
        {tab === 'skill-manager' && (
          <SkillManagerPanel callRemote={bindSkillManagerRpc(callRemote)} />
        )}

        {/* ── Tab: MCP 管理（自包含组件，自理 RPC 数据流） ── */}
        {tab === 'mcp-manager' && (
          <McpManagerPanel callRemote={(method, args) => callRemote('mcpManager', method, args)} />
        )}

        {/* ── Tab: 任务运行时（AgentRuntime 验证） ── */}
        {tab === 'runtime' && (
          <RuntimeTestPanel project={currentProject} workTypes={workTypes} callRemote={callRemote} />
        )}

        {/* ── Tab: 领域事件（项目级持久调度日志回放） ── */}
        {tab === 'events' && (
          <DomainEventsPanel project={currentProject} callRemote={(method, args) => callRemote('corumRuntime', method, args)} />
        )}

        {/* ── Tab: 团队（全局团队管理，独立插件 corum-team-ui-dev） ── */}
        {tab === 'team' && (
          <TeamManagerPanel callRemote={callRemote} />
        )}

        {/* ── Tab 4: 日志 ── */}
        {tab === 'logs' && (
          <div className={css.logFullList}>
            <div className={css.logHeader}>
              <span className={css.logTitle}>操作日志</span>
              <button type="button" className={css.logClear} onClick={() => { setLogs([]) }}>清空</button>
            </div>
            <div className={css.logList}>
              {logs.length === 0 && <div className={css.logEmpty}>暂无日志</div>}
              {logs.map((entry, i) => (
                <div key={i} className={css.logEntry} data-level={entry.level}>
                  <span className={css.logTime}>{entry.time}</span>
                  <span className={css.logMessage}>{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 新建项目对话框（独立模态：填名字 + 选目录 + 提交；未来扩展为创建向导）。 */}
      {newProjectOpen && (
        <NewProjectDialog
          busy={busy}
          onCancel={() => { setNewProjectOpen(false) }}
          onSubmit={onCreateProject}
        />
      )}

      {/* 项目组管理面板（拉团队 / 拉 Agent / 移除成员）。 */}
      {groupManageOpen && currentProject !== null && (
        <GroupManageDialog
          members={groupMembers}
          profiles={profiles}
          teams={allTeams}
          busy={busy}
          onClose={() => { setGroupManageOpen(false) }}
          onAddTeam={onAddTeamToGroup}
          onAddMember={onAddMemberToGroup}
          onRemoveMember={onRemoveGroupMember}
        />
      )}
    </div>
  )
}

// ── 新建项目对话框 ──────────────────────────────────────────────────

/**
 * 新建项目对话框（独立模态）。当前是最基本形态：填项目名 + 选工作目录 + 提交。
 * 结构设计为未来可扩展成「新建项目向导」——后续可加步骤（组建/添加团队、
 * 选取 Agent），逐步引导完成项目创建。
 *
 * 工作目录是用户指定的代码存放位置（Agent 的工作现场）；corum 项目配置目录
 * 由 host 内部自建于 $CORUM_HOME/projects/<id>/，与此分离，不在此处展示。
 */
function NewProjectDialog({ busy, onCancel, onSubmit }: {
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string, cwd: string) => Promise<void>
}): ReactNode {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /** 经原生目录选择对话框选工作目录（只选已存在目录，新建交给系统对话框）。 */
  const pickCwd = useCallback(async () => {
    const bridge = (window as unknown as {
      corumDesktop?: { pickDirectory?: (o?: { title?: string; defaultPath?: string }) => Promise<{ path: string | null; cancelled?: boolean; error?: string }> }
    }).corumDesktop
    if (bridge?.pickDirectory === undefined) {
      setError('目录选择不可用（desktop bridge 缺失）')
      return
    }
    const existing = cwd.trim()
    const picked = await bridge.pickDirectory({
      title: '选择项目工作目录',
      ...(existing !== '' ? { defaultPath: existing } : {}),
    })
    if (picked.cancelled === true || picked.path === null) return
    setCwd(picked.path)
    setError(null)
  }, [cwd])

  const submit = useCallback(async () => {
    const trimmed = name.trim()
    if (trimmed === '') {
      setError('项目名不能为空')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(trimmed, cwd.trim())
      // 成功由父组件关闭对话框
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }, [name, cwd, onSubmit])

  const disabled = busy || submitting

  return (
    <div className={css.dialogOverlay} onClick={() => { if (!disabled) onCancel() }}>
      <div className={css.dialog} role="dialog" aria-label="新建项目" onClick={e => { e.stopPropagation() }}>
        <div className={css.dialogTitle}>新建项目</div>

        <label className={css.dialogLabel}>项目名</label>
        <input
          className={css.dialogInput}
          placeholder="如：我的第一个项目"
          value={name}
          autoFocus
          onChange={e => { setName(e.target.value); setError(null) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
        />

        <label className={css.dialogLabel}>工作目录（代码存放位置）</label>
        <div className={css.dialogCwdRow}>
          <button type="button" className={css.dialogCwdBtn} disabled={disabled} onClick={() => { void pickCwd() }}>
            <FolderOpen size={13} /> 选择目录
          </button>
          <span className={css.dialogCwdEcho} title={cwd !== '' ? cwd : '未选择（将退回进程目录）'}>
            {cwd !== '' ? cwd : '未选择工作目录'}
          </span>
        </div>
        <div className={css.dialogHint}>
          工作目录是你的代码存放位置（Agent 在此工作）；corum 的项目配置存放在其内部目录，与此分离。
        </div>

        {error !== null && <div className={css.dialogError}>{error}</div>}

        <div className={css.dialogActions}>
          <button type="button" className={css.dialogBtnSecondary} disabled={disabled} onClick={onCancel}>
            取消
          </button>
          <button type="button" className={css.dialogBtnPrimary} disabled={disabled} onClick={() => { void submit() }}>
            {submitting ? '创建中…' : '创建项目'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 项目组管理对话框 ─────────────────────────────────────────────────

/**
 * 项目组管理面板。项目组是项目的运行时组织（虚拟组织），成员为引用式（指向全局
 * AgentProfile，只有一份配置）。成员来源三类：整个团队 / 团队指定 Agent / 独立 Agent。
 * PM 是唯一统筹入口（空项目组默认有预置 PM，且不可移除最后一名 PM）。
 */
function GroupManageDialog({ members, profiles, teams, busy, onClose, onAddTeam, onAddMember, onRemoveMember }: {
  members: readonly GroupMember[]
  profiles: readonly ProfileSummary[]
  teams: readonly TeamSummary[]
  busy: boolean
  onClose: () => void
  onAddTeam: (teamId: string) => Promise<void>
  onAddMember: (profileId: string, fromTeam?: string) => Promise<void>
  onRemoveMember: (profileId: string) => Promise<void>
}): ReactNode {
  const memberIds = new Set(members.map(m => m.profileId))
  /** 尚未进组的全局 Agent（「拉 Agent」下拉来源）。 */
  const availableProfiles = profiles.filter(p => !memberIds.has(p.id))
  /** 尚未被整体拉入的团队（「拉团队」下拉来源）。 */
  const availableTeams = teams.filter(t => t.memberProfileIds.some(id => !memberIds.has(id)))
  const pmCount = members.filter(m => m.role === 'pm').length

  return (
    <div className={css.dialogOverlay} onClick={() => { if (!busy) onClose() }}>
      <div className={css.dialog} role="dialog" aria-label="项目组管理" onClick={e => { e.stopPropagation() }}>
        <div className={css.dialogTitle}>项目组管理</div>

        {/* 拉人入口：整个团队 / 单个 Agent */}
        <div className={css.groupAddRow}>
          <select
            className={css.formSelect}
            value=""
            disabled={busy || availableTeams.length === 0}
            onChange={e => { const id = e.target.value; if (id !== '') { e.target.value = ''; void onAddTeam(id) } }}
          >
            <option value="">{availableTeams.length === 0 ? '无可拉团队' : '＋ 拉整个团队…'}</option>
            {availableTeams.map(t => (
              <option key={t.id} value={t.id}>{t.name}（{t.memberProfileIds.length} 人）</option>
            ))}
          </select>
          <select
            className={css.formSelect}
            value=""
            disabled={busy || availableProfiles.length === 0}
            onChange={e => { const id = e.target.value; if (id !== '') { e.target.value = ''; void onAddMember(id) } }}
          >
            <option value="">{availableProfiles.length === 0 ? '无可拉 Agent' : '＋ 拉 Agent…'}</option>
            {availableProfiles.map(p => (
              <option key={p.id} value={p.id}>{p.nickname ?? p.id}{p.nickname !== undefined ? `（${p.id}）` : ''}</option>
            ))}
          </select>
        </div>

        {/* 当前成员列表 */}
        <div className={css.groupMemberList}>
          {members.length === 0 && <div className={css.emptyText}>项目组暂无成员</div>}
          {members.map(m => {
            const p = profiles.find(x => x.id === m.profileId)
            const isLastPm = m.role === 'pm' && pmCount <= 1
            return (
              <div key={m.profileId} className={css.groupMemberRow}>
                <div className={css.groupMemberInfo}>
                  <span className={css.profileId}>{p?.nickname ?? m.profileId}</span>
                  {m.role === 'pm' && <span className={css.pmBadge}>PM</span>}
                  <span className={css.profileIdSub}>
                    {m.profileId}{m.fromTeam !== undefined ? ` · 来自 ${m.fromTeam}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className={css.iconBtn}
                  title={isLastPm ? '项目组必须保留至少一名 PM' : '移出项目组'}
                  disabled={busy || isLastPm}
                  onClick={() => { void onRemoveMember(m.profileId) }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>

        <div className={css.dialogActions}>
          <button type="button" className={css.dialogBtnPrimary} onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  )
}

// ── 聊天消息渲染 ────────────────────────────────────────────────────

function ChatMessageView({ message }: { message: ChatMessage }): ReactNode {
  const [showEvents, setShowEvents] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  if (message.role === 'user') {
    return (
      <div className={css.msgUser}>
        <div className={css.msgBubbleUser}>{message.text}</div>
      </div>
    )
  }
  return (
    <div className={css.msgAssistant}>
      {message.systemPrompt !== undefined && (
        <div className={css.msgPromptSection}>
          <button type="button" className={css.msgEventsToggle} onClick={() => { setShowPrompt(s => !s) }}>
            {showPrompt ? '隐藏' : '显示'}装配的 System Prompt（{message.systemPrompt.length} 字符）
          </button>
          {showPrompt && (
            <pre className={css.msgSystemPrompt}>{message.systemPrompt}</pre>
          )}
          {message.tools !== undefined && message.tools.length > 0 && (
            <div className={css.msgTools}>
              <span className={css.msgToolsLabel}>已装配工具（{message.tools.length}）:</span>
              {message.tools.map((t, i) => (
                <span key={i} className={css.msgToolChip}>{t.name}</span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className={css.msgBubbleAssistant}>
        {message.text === '' ? (
          <span className={css.msgEmptyReply}>(空回复)</span>
        ) : (
          <pre className={css.msgText}>{message.text}</pre>
        )}
      </div>
      {message.events !== undefined && message.events.length > 0 && (
        <button type="button" className={css.msgEventsToggle} onClick={() => { setShowEvents(s => !s) }}>
          {showEvents ? '隐藏' : '显示'}事件流（{message.events.length}）
        </button>
      )}
      {showEvents && message.events !== undefined && (
        <div className={css.msgEvents}>
          {message.events.map((ev, i) => {
            const data = ev.data as Record<string, unknown> | null
            const isReasoning = ev.type === 'assistant/message' && Array.isArray(data?.content)
            const reasoningText = isReasoning
              ? (data!.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === 'reasoning' && b.text)
                  .map(b => b.text)
                  .join('\n')
              : ''
            const textContent = isReasoning
              ? (data!.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === 'text' && b.text)
                  .map(b => b.text)
                  .join('')
              : ''
            return (
              <div key={i} className={css.eventRow}>
                <span className={css.eventType}>{ev.type}</span>
                {reasoningText !== '' && (
                  <span className={css.eventReasoning}>{reasoningText}</span>
                )}
                {textContent !== '' && (
                  <span className={css.eventData}>{textContent}</span>
                )}
                {reasoningText === '' && textContent === '' && (
                  <span className={css.eventData}>{JSON.stringify(data)}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
