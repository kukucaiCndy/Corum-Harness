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
 * @module @corum/corum-agent-dev/agent-service
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
// 空类型 import：让 ctx.agentDefaultModel / ctx.agentPresets 的 Context 合并生效。
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
// 空类型 import：让 ctx.llm 的 Context 合并生效。
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 空类型 import：让 ctx.sessionPersistence 的 Context 合并生效（resume 用）。
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { compilePreset } from './compile.ts'
import type { AgentProfile, ProfileModel, SkillBinding } from './profile.ts'
import { isValidProfileId } from './profile.ts'
import { GENERAL_WORK_TYPE, isValidProjectId, isValidWorkTypeSlug, isGroupMember } from './project.ts'
import { loadProject } from './project-store.ts'
import { loadProfile, listProfiles, saveProfile, deleteProfile, agentDirPath } from './profile-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum Agent 实例服务（AgentProfile → preset → root Agent）。 */
    corumAgent: CorumAgentService
  }
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
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  skills: SkillBinding[]
  mcpServers: string[]
  terminal: { mode: string }
  version: number
  trust: string
}

/** Agent 运行状态。 */
export interface AgentStatus {
  profileId: string
  created: boolean
}

/**
 * UI 投影的可用 skill 摘要。
 * Skill 全局统一管理在 ~/.dsh/skills/，Agent 只引用 name 不复制文件。
 */
export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** skill 目录的绝对路径。 */
  path: string
  /** 当前版本 ID。 */
  currentVersion?: string
  /** 版本数量。 */
  versionCount: number
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

/** 从事件流提取 task 会话标题（首条 user 消息的首行，截断 40 字）。 */
function taskTitleOf(events: readonly SessionEvent[]): string {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    // user/message content 在 data.content（顶层）或 data.message.content（兼容两种形态）。
    const data = event.data as {
      content?: Array<{ type: string; text?: string }>
      message?: { content?: Array<{ type: string; text?: string }> }
    } | undefined
    const content = data?.content ?? data?.message?.content ?? []
    const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join(' ').trim()
    if (text !== '') {
      const firstLine = text.split('\n')[0]
      return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
    }
  }
  return ''
}

/** saveProfile 的 RPC 入参（AgentProfile 子集，UI 可编辑的字段）。 */
export interface SaveProfileInput {
  id: string
  nickname?: string
  title?: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  /** 绑定的 skill 列表（引用绑定 + 版本 pin）。 */
  skills: SkillBinding[]
  /** MCP 服务授权列表（引用全局注册表中的服务名）。 */
  mcpServers: string[]
  terminal: { mode: 'sandbox' | 'host' }
  memoryPolicy: { scope: 'agent'; dir?: string }
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
/** 泳道描述：路由标签（key）+ 工作类型语义（type）+ 可选需求段。 */
export interface AgentLaneDescriptor {
  /** 泳道路由键：关联需求为 `<requirementId>:<type>`，兼容任务为 `<type>`。 */
  readonly key: string
  /** 工作类型 slug（泳道语义；路由键是 key）。 */
  readonly type: string
  /** 关联需求 id（标签泳道的需求段）。 */
  readonly requirementId?: string
}

export class CorumAgentService extends TypertRemoteService {
  static inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'sessionPersistence']

  /** 已创建的角色 root Agent（按 profile id）。 */
  private readonly agents = new Map<string, Agent>()

  /**
   * 已存活的「项目 × 角色 × 工作类型」会话 Agent（instanceKey =
   * `${projectId}${profileId}${type}`）。调度层模拟单实例多会话的活跃实例表。
   */
  private readonly typeAgents = new Map<string, { agent: Agent; sessionId: SessionId; lane: AgentLaneDescriptor }>()

  /** sessionId → 「项目 × 角色 × 泳道标签」反查索引（权限网关用；仅本进程存活会话）。 */
  private readonly sessionLaneIndex = new Map<string, { projectId: string; profileId: string; type: string; laneKey: string; requirementId?: string }>()

  /** 已存活的 task 模式会话（keyed by sessionId；一个工作区可多个）。 */
  private readonly taskAgents = new Map<string, { agent: Agent; sessionId: SessionId; cwd: string; profileId: string }>()

  /**
   * 待定的访问权限档位（sessionId → preset 名），**只存内存、不落盘**。
   * 用户建任务时选的档位先记在这里，等发第一条消息时才写进会话事件
   * （见 {@link rememberPendingPermission}）——这样未发消息的会话不留磁盘记录。
   */
  private readonly pendingPermissions = new Map<string, string>()

  /**
   * 泳道会话能力钩子：所有「项目×角色×类型」会话（含用户直聊的 PM 会话、
   * 调度派活的执行会话）在 create/resume 的 setup 里统一经过这些钩子装配。
   * AgentRuntime 借此给每个会话装调度工具（assign_task/list_team_tasks/
   * complete_task）——PM 统筹会话与被调度会话能力一致是「PM 派活」闭环的前提。
   */
  private readonly laneSetupHooks: Array<(agentCtx: Context, projectId: string, profileId: string) => void> = []

  /** 注册泳道会话能力钩子（在 create/resume 的 setup 阶段同步调用；插件 apply 期注册）。 */
  registerLaneSetupHook(hook: (agentCtx: Context, projectId: string, profileId: string) => void): void {
    this.laneSetupHooks.push(hook)
  }

  constructor(ctx: Context) {
    super(ctx, 'corumAgent')
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
      const entry = this.taskAgents.get(sid)
      if (entry === undefined) return
      this.flushPendingPermission(entry.agent.session, sid)
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
    const existing = this.agents.get(profileId)
    if (existing !== undefined) return { agent: existing, presetId: profileId }

    const profile = loadProfile(profileId)
    if (profile === undefined) {
      throw new Error(`dev-agent: profile "${profileId}" not found`)
    }
    if (!isValidProfileId(profile.id)) {
      throw new Error(`dev-agent: invalid profile id "${profile.id}"`)
    }

    // 1. 把绑定的 skill checkout 到 pinned commit（版本 pinning）。
    this.checkoutPinnedSkills(profile)

    // 2. 编译 + 落盘 preset 目录（含 agent.cordis.yml + preset.yml）。
    const dir = agentDirPath(profile.id)
    this.writeAgentDir(profile, dir)

    // 2. 创建 root Agent，setup 里 mount preset（官方组装链路）。
    const sessionId = SessionId(`corum-dev-${profile.id}-${randomUUID()}`)

    // 模型选择走官方 ModelSelection 通道：`agentOptions` 只有 provider/model/
    // maxTokens，reasoningEffort 由 installModelSelection 在 setup 里安装（官方
    // headless / api-proxy 同款做法）。塞进 agentOptions 会被 buildRequest 忽略。
    const selection: ModelSelectionRef = {
      current: {
        provider: profile.model.provider,
        model: profile.model.model,
        ...(profile.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(profile.model.reasoningEffort) }),
      },
      assembled: undefined,
    }

    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: profile.id },
      agentOptions: {
        provider: profile.model.provider,
        model: profile.model.model,
      },
      setup: async (agentCtx) => {
        // 官方组装链路：mount preset，把 persona / 工具 / skill / MCP 全挂上。
        await this.ctx.agentPresets.mount(agentCtx, profile.id)
        // 额外能力注入（如 complete_task 工具），在 mount preset 之后。
        extraSetup?.(agentCtx)
        // 官方模型选择安装：把 provider/model/reasoningEffort 绑定到该 Agent 作用域。
        installModelSelection(agentCtx, selection)
      },
    })

    this.agents.set(profileId, handle.agent)
    this.ctx.logger.info(`corum-agent: root agent created for profile "${profileId}" — ${sessionId}`)
    // 装配诊断（一次性，确认模型覆盖与 home 隔离是否生效）：
    // 打印 profile 指定模型 vs 进程实际 DSH_HOME（应指向 .corum-dev-home）。
    // 若 model 与预期不符、或 home 不是 dev home，说明配置串了。
    process.stderr.write(
      `[corum-agent] createAgent — profile=${profileId} model=${profile.model.provider}/${profile.model.model} DSH_HOME=${process.env.DSH_HOME ?? '(unset)'}\n`,
    )
    return { agent: handle.agent, presetId: profile.id }
  }

  /** 兼容入口：按工作类型建/恢复泳道（label 退化为 type）。 */
  async createAgentForType(
    projectId: string,
    profileId: string,
    type: string = GENERAL_WORK_TYPE,
    extraSetup?: (agentCtx: Context) => void,
  ): Promise<CreateAgentResult & { sessionId: SessionId }> {
    return this.createAgentForLane(projectId, profileId, { key: type, type }, extraSetup)
  }

  /**
   * 按「项目 × 角色 × 泳道标签」创建或恢复一个 root Agent（= 一个泳道会话）。
   *
   * 这是团队成员多会话模型的落地（见 project.md「单 Agent 多会话」已知待解
   * 问题 + docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md §6.1）：
   * 同一 profile 按 (projectId, laneKey) 各持一个独立 root Agent（官方 Agent:Session
   * =1:1 硬绑定，N 个 type 会话即 N 个实例，各挂同一份 preset、会话各自独立）。
   *
   * sessionId 稳定可路由：corum-proj<p>-agent<a>-lane<label>-<rand>。进程内已存活
   * 直接复用；否则查 sessionPersistence——已持久化则 resume（冷恢复历史），
   * 未持久化则 create（并登记 sessionId 进项目目录，供下次 resume 找回）。
   *
   * @param projectId - 项目 id（团队属项目，会话隔离边界）。
   * @param profileId - 角色 profile id。
   * @param lane - 泳道描述（key=路由标签，type=工作类型语义，requirementId 可选）。
   * @param extraSetup - 可选额外能力注入（如 complete_task 工具）。
   * @returns 创建/恢复结果 + 该会话的 sessionId。
   */
  async createAgentForLane(
    projectId: string,
    profileId: string,
    lane: AgentLaneDescriptor,
    extraSetup?: (agentCtx: Context) => void,
  ): Promise<CreateAgentResult & { sessionId: SessionId }> {
    if (!isValidProjectId(projectId)) throw new Error(`dev-agent: invalid project id "${projectId}"`)
    if (!isValidWorkTypeSlug(lane.type)) throw new Error(`dev-agent: invalid work type slug "${lane.type}"`)
    const instanceKey = `${projectId}${profileId}${lane.key}`
    const existing = this.typeAgents.get(instanceKey)
    if (existing !== undefined) return { agent: existing.agent, presetId: profileId, sessionId: existing.sessionId }

    const profile = loadProfile(profileId)
    if (profile === undefined) throw new Error(`dev-agent: profile "${profileId}" not found`)
    if (!isValidProfileId(profile.id)) throw new Error(`dev-agent: invalid profile id "${profile.id}"`)

    // 项目工作目录：Agent 的工作现场（session cwd 创建后不可改）。
    // 必须用项目自己的 cwd（干净目录），而非 process.cwd()——否则 Agent 会在
    // corum 源码仓里跑，测试时污染源码。项目未设 cwd 时退回 process.cwd()。
    const project = loadProject(projectId)
    if (project === undefined) throw new Error(`dev-agent: project "${projectId}" not found`)

    // 成员边界：只有项目组成员才能在该项目里建会话/被调度（非成员不参与工作）。
    if (!isGroupMember(project, profileId)) {
      throw new Error(`dev-agent: profile "${profileId}" 不是项目 "${projectId}" 的项目组成员，不参与该项目工作`)
    }
    const workCwd = project.cwd !== undefined && project.cwd !== '' ? project.cwd : process.cwd()

    // 查本项目该 type 会话是否已持久化（登记在项目目录的 session 索引里）。
    const persisted = this.lookupPersistedSessionId(projectId, profileId, lane.key)
    const sessionId = persisted ?? SessionId(`corum-proj${projectId}-agent${profileId}-lane${slugLaneKey(lane.key)}-${randomBytes(4).toString('hex')}`)

    // resume 与 create 共用同一份 setup（preset 挂载 + 能力注入 + 模型选择）。
    // resume 时 session 历史由 persistence 加载，能力仍经 setup 重新组装。
    const selection: ModelSelectionRef = {
      current: {
        provider: profile.model.provider,
        model: profile.model.model,
        ...(profile.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(profile.model.reasoningEffort) }),
      },
      assembled: undefined,
    }
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, profile.id)
      for (const hook of this.laneSetupHooks) hook(agentCtx, projectId, profileId)
      extraSetup?.(agentCtx)
      installModelSelection(agentCtx, selection)
    }
    const agentOptions = { provider: profile.model.provider, model: profile.model.model }

    let handle: { agent: Agent }
    if (persisted !== undefined) {
      // 已持久化：冷恢复（preset 在 create 时已落盘，无需重复 checkout/write）。
      handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      this.ctx.logger.info(`corum-agent: resumed agent — ${sessionId}`)
    } else {
      // 首次：checkout skill + 编译落盘 preset，再 create。
      this.checkoutPinnedSkills(profile)
      this.writeAgentDir(profile, agentDirPath(profile.id))
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: workCwd, agentPreset: profile.id },
        agentOptions,
        setup,
      })
      this.registerSessionId(projectId, profileId, lane.key, sessionId)
      this.ctx.logger.info(`corum-agent: created agent — ${sessionId}`)
    }

    this.typeAgents.set(instanceKey, { agent: handle.agent, sessionId, lane })
    this.sessionLaneIndex.set(String(sessionId), {
      projectId,
      profileId,
      type: lane.type,
      laneKey: lane.key,
      ...(lane.requirementId !== undefined ? { requirementId: lane.requirementId } : {}),
    })
    return { agent: handle.agent, presetId: profileId, sessionId }
  }

  /**
   * 按 sessionId 反查泳道归属（权限网关的可信身份来源）。
   * 只识别本服务创建/恢复、且当前仍登记在存活表里的泳道会话。
   */
  resolveLaneBySessionId(sessionId: string): { projectId: string; profileId: string; type: string; laneKey: string; requirementId?: string } | undefined {
    return this.sessionLaneIndex.get(sessionId)
  }

  /** 获取一个已存活的 (project, profile, type) 会话 Agent。 */
  getAgentForType(projectId: string, profileId: string, type: string = GENERAL_WORK_TYPE): Agent | undefined {
    return this.typeAgents.get(`${projectId}${profileId}${type}`)?.agent
  }

  /** 获取一个已存活的泳道会话 Agent（按路由标签）。 */
  getAgentForLane(projectId: string, profileId: string, laneKey: string): Agent | undefined {
    return this.typeAgents.get(`${projectId}${profileId}${laneKey}`)?.agent
  }

  /**
   * 查项目目录的 session 索引：某 (profile, type) 会话是否已持久化。
   * 返回其 sessionId（供 resume），未登记返回 undefined。
   */
  private lookupPersistedSessionId(projectId: string, profileId: string, type: string): SessionId | undefined {
    const index = this.readSessionIndex(projectId)
    const key = `${profileId}${type}`
    const id = index[key]
    return id === undefined ? undefined : SessionId(id)
  }

  /** 把一个 (profile, type) → sessionId 登记进项目目录的 session 索引。 */
  private registerSessionId(projectId: string, profileId: string, type: string, sessionId: SessionId): void {
    const index = this.readSessionIndex(projectId)
    index[`${profileId}${type}`] = String(sessionId)
    const path = join(this.projectSessionsDir(projectId), 'sessions.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(index, null, 2))
  }

  /** 读取项目的 session 索引（<projectDir>/corum/sessions.json）。 */
  private readSessionIndex(projectId: string): Record<string, string> {
    const path = join(this.projectSessionsDir(projectId), 'sessions.json')
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  /** 项目的 corum 元数据目录（session 索引所在）。 */
  private projectSessionsDir(projectId: string): string {
    const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
      ? process.env.CORUM_HOME
      : '~/.corum'
    return join(resolveDshHome(configured), 'projects', projectId, 'corum')
  }

  // ── task 会话持久化索引（sessionId → {cwd, profileId}，一个工作区多会话） ──

  /** 读 task 会话索引（<taskDir>/corum/task-sessions.json）。 */
  private readTaskSessionIndex(): Record<string, { cwd: string; profileId: string }> {
    const path = join(this.projectSessionsDir(TASK_PROJECT_ID), 'task-sessions.json')
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, { cwd: string; profileId: string }>
    } catch {
      return {}
    }
  }

  /** 登记一条 task 会话（sessionId → cwd/profileId）进 task 索引。 */
  private registerTaskSession(sessionId: SessionId, cwd: string, profileId: string): void {
    const index = this.readTaskSessionIndex()
    index[String(sessionId)] = { cwd, profileId }
    const path = join(this.projectSessionsDir(TASK_PROJECT_ID), 'task-sessions.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(index, null, 2))
  }

  /** 获取已创建的 Agent（未创建返回 undefined）。 */
  getAgent(profileId: string): Agent | undefined {
    return this.agents.get(profileId)
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
    return summarizeText(agent.session.events, firstSeq)
  }

  // ── TypertRemoteService @Remote 端点（/api/corumAgent/*） ──────────

  /** 列出所有 AgentProfile 摘要。 */
  @Remote('listProfiles')
  listProfilesRemote(): { profiles: ProfileSummary[] } {
    const profiles = listProfiles().map(p => ({
      id: p.id,
      ...(p.nickname !== undefined ? { nickname: p.nickname } : {}),
      ...(p.title !== undefined ? { title: p.title } : {}),
      prompt: p.prompt,
      model: p.model,
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: { mode: p.terminal.mode },
      version: p.version,
      trust: p.trust,
    }))
    return { profiles }
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
    const reply = summarizeText(agent.session.events, firstSeq)
    const events: SessionEventDto[] = []
    for (const event of agent.session.events) {
      if (event.seq < firstSeq) continue
      events.push({
        seq: event.seq,
        type: event.type,
        data: simplifyEventData(event),
        time: event.time,
      })
    }
    // 从 request/header 事件提取最终装配的 system prompt + 工具列表
    const { systemPrompt, tools } = extractHeader(agent.session.events, firstSeq)
    return { reply, events, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(tools !== undefined ? { tools } : {}) }
  }

  /**
   * 保存（创建或更新）一个 AgentProfile，并编译落盘整个 Agent 目录。
   *
   * Skill 采用引用绑定 + 版本 pinning：
   *   agent.json 的 skills 字段记录 SkillBinding[] {name, commitHash}。
   *   Agent mount 前把 skill checkout 到 pinned commit。
   *   Skill 全局统一管理在 ~/.dsh/skills/（由 dev-skill-manager 管理导入）。
   */
  @Remote('saveProfile')
  saveProfileRemote(input: SaveProfileInput): { profile: ProfileSummary } {
    if (!isValidProfileId(input.id)) {
      throw new Error(`corum-agent: invalid profile id "${input.id}"`)
    }
    const profile: AgentProfile = {
      id: input.id,
      ...(input.nickname !== undefined && input.nickname.trim() !== '' ? { nickname: input.nickname.trim() } : {}),
      ...(input.title !== undefined && input.title.trim() !== '' ? { title: input.title.trim() } : {}),
      prompt: input.prompt,
      model: input.model,
      skills: input.skills,
      mcpServers: input.mcpServers,
      terminal: input.terminal,
      memoryPolicy: input.memoryPolicy,
      version: 0,
      trust: input.trust,
    }
    saveProfile(profile)

    // 编译并落盘 agent.cordis.yml + preset.yml
    const dir = agentDirPath(input.id)
    this.writeAgentDir(loadProfile(input.id)!, dir)

    // 清掉旧 Agent 使下次重建
    this.agents.delete(input.id)
    const saved = loadProfile(input.id)!
    return {
      profile: {
        id: saved.id,
        ...(saved.nickname !== undefined ? { nickname: saved.nickname } : {}),
        ...(saved.title !== undefined ? { title: saved.title } : {}),
        prompt: saved.prompt,
        model: saved.model,
        skills: saved.skills,
        mcpServers: saved.mcpServers,
        terminal: { mode: saved.terminal.mode },
        version: saved.version,
        trust: saved.trust,
      },
    }
  }

  /** 删除一个 AgentProfile。 */
  @Remote('deleteProfile')
  deleteProfileRemote(id: string): { ok: boolean } {
    if (!isValidProfileId(id)) throw new Error(`corum-agent: invalid profile id "${id}"`)
    this.agents.delete(id)
    deleteProfile(id)
    return { ok: true }
  }

  /** 获取已创建 Agent 的会话事件快照（从指定 seq 开始）。 */
  @Remote('getEvents')
  getEventsRemote(profileId: string, fromSeq: number): { events: SessionEventDto[] } {
    const agent = this.agents.get(profileId)
    if (agent === undefined) return { events: [] }
    const events: SessionEventDto[] = []
    for (const event of agent.session.events) {
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

  /** 按「项目×角色×类型」创建（或 resume）一个会话 Agent。 */
  @Remote('createAgentForType')
  async createAgentForTypeRemote(
    projectId: string,
    profileId: string,
    type?: string,
  ): Promise<{ sessionId: string; created: boolean }> {
    const result = await this.createAgentForType(projectId, profileId, type)
    return { sessionId: String(result.sessionId), created: true }
  }

  /** 在「项目×角色×类型」会话里发一个 prompt，等回复。 */
  @Remote('runPromptForType')
  async runPromptForTypeRemote(
    projectId: string,
    profileId: string,
    type: string,
    prompt: string,
  ): Promise<RunPromptResult> {
    const { agent } = await this.createAgentForType(projectId, profileId, type)
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    const reply = summarizeText(agent.session.events, firstSeq)
    const events: SessionEventDto[] = []
    for (const event of agent.session.events) {
      if (event.seq < firstSeq) continue
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    const { systemPrompt, tools } = extractHeader(agent.session.events, firstSeq)
    return { reply, events, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(tools !== undefined ? { tools } : {}) }
  }

  /**
   * 读「项目×角色×类型」会话的历史事件（从 fromSeq 开始，只读不发消息）。
   * 用于切换泳道时回填该会话的对话历史。会话未存活返回空。
   */
  @Remote('getSessionEventsForType')
  async getSessionEventsForTypeRemote(
    projectId: string,
    profileId: string,
    type: string,
    fromSeq: number,
  ): Promise<{ events: SessionEventDto[] }> {
    const agent = this.getAgentForType(projectId, profileId, type)
    if (agent === undefined) return { events: [] }
    const events: SessionEventDto[] = []
    for (const event of agent.session.events) {
      if (event.seq < fromSeq) continue
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    return { events }
  }

  // ── task 模式泳道（单任务会话，corum-task-* session id，与 project 泳道隔离） ──

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
   * @param profileId - Agent profile id（缺省用内置 task profile）。
   * @param permission - 访问权限档位（`read-only`/`workspace-write`/
   *   `danger-full-access`，缺省沿用全局默认）。经官方 `permissionPresets.set`
   *   写入：先落 `permission/preset` 事件，再由 `setSandboxMode`/`setApprovalPolicy`
   *   写两个旋钮——与官方「新建会话固定权限」语义一致，只是用调用方指定的档位
   *   覆盖全局默认值。
   * @returns 创建/恢复结果 + 该会话的 sessionId（corum-task-<rand>）。
   */
  async createAgentForTask(cwd: string, profileId: string = TASK_PROFILE_ID, permission?: string, model?: ProfileModel): Promise<CreateAgentResult & { sessionId: SessionId }> {
    const profile = profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(profileId)
    if (profile === undefined) throw new Error(`dev-agent: profile "${profileId}" not found`)
    if (!isValidProfileId(profile.id)) throw new Error(`dev-agent: invalid profile id "${profile.id}"`)
    // 设计稿「新建任务表单可选模型」：默认用 profile.model，调用方可覆盖
    // （「选好工作区和 Agent 后自动加载默认模型，用户仍可改」）。
    const effectiveModel = model ?? profile.model

    // 目录 realpath 归一：workspace.attachSession 硬要求 realpath(cwd) === ws.path，
    // 否则抛错 → 会话落「未分组」（macOS /tmp→/private/tmp 一类 symlink 会踩）。
    const root = realpathSync(cwd)

    // 复用目标工作区里已有的 blank task 泳道（官方 connectWorkspace 语义）：
    // 连点「新建任务」不该堆一串空会话。
    const reuse = this.findBlankTaskLane(root)
    if (reuse !== undefined) {
      this.ctx.logger.info(`corum-agent(task): reuse blank lane — ${reuse} (cwd=${root})`)
      const resolved = await this.resolveTaskAgent(reuse)
      if (resolved !== undefined) {
        // 复用的是 blank 泳道（还没发过消息），同样只记内存、不写盘。
        this.rememberPendingPermission(String(resolved.sessionId), permission)
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
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, profile.id)
      installModelSelection(agentCtx, selection)
    }
    const agentOptions = { provider: effectiveModel.provider, model: effectiveModel.model }

    this.checkoutPinnedSkills(profile)
    this.writeAgentDir(profile, agentDirPath(profile.id))
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: root, agentPreset: profile.id },
      agentOptions,
      setup,
    })
    this.registerTaskSession(sessionId, root, profile.id)
    await this.attachTaskWorkspace(sessionId, root)
    // 权限档位只记内存、不写事件——写事件会 append 落盘，而用户还没发消息。
    this.rememberPendingPermission(String(sessionId), permission)
    this.ctx.logger.info(`corum-agent(task): created — ${sessionId} (cwd=${root})`)

    this.taskAgents.set(String(sessionId), { agent: handle.agent, sessionId, cwd: root, profileId: profile.id })
    return { agent: handle.agent, presetId: profile.id, sessionId }
  }

  /**
   * 找出目标工作区里**尚未发过消息**的 task 泳道（复用候选）。
   *
   * 判定（对齐官方 blank 语义）：官方 `applySessionListMetadata` 里
   * `blank = state.blank && event.type !== 'turn/start'`——**日志里出现第一个
   * `turn/start` 就不再是 blank**。host 侧 `ctx.sessions.list()` 返回的是
   * `Session`（无 blank 字段，blank 在客户端摘要层），故此处直接按官方同源
   * 规则判定：cwd 相同 + 事件流里没有 `turn/start`。
   */
  private findBlankTaskLane(cwd: string): string | undefined {
    const index = this.readTaskSessionIndex()
    for (const [sid, meta] of Object.entries(index)) {
      if (meta.cwd !== cwd) continue
      const session = this.ctx.sessions.list().find((s) => String(s.id) === sid)
      // 会话不在对象层时保守不复用（宁可新建一个，也不要复用一个可能有历史的会话）。
      if (session === undefined) continue
      if (!session.events.some((e) => e.type === 'turn/start')) return sid
    }
    return undefined
  }

  /**
   * 把泳道会话挂到官方 workspace（侧栏按 `WorkspaceView.sessionIds` 分组，
   * 不 attach 就落「未分组」桶）。
   *
   * 官方 `session.create({workspaceId})` 会自动 attach，但泳道是自己起的
   * `agents.create`，必须补这一步。attach 失败**不阻断**会话创建（会话可用，
   * 只是归到未分组），但要打日志——静默失败会让「未分组」问题无法定位。
   */
  private async attachTaskWorkspace(sessionId: SessionId, cwd: string): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      this.ctx.logger.warn('corum-agent(task): workspaceRegistry unavailable — lane stays ungrouped')
      return
    }
    try {
      // create 幂等：已注册的目录直接返回既有实体（不重复建节点）；未注册则新建
      // 并 prepend 到侧栏列表（用户要的「工作区先出现这个目录名的父节点」）。
      const target = await registry.create(cwd)
      await target.attachSession(sessionId)
      this.ctx.logger.info(`corum-agent(task): attached — ${String(sessionId)} → workspace ${String(target.id)}`)
    } catch (error) {
      // 不阻断：会话已可用，只是归到未分组。打日志避免「未分组」问题无法定位。
      this.ctx.logger.warn(`corum-agent(task): attach failed — ${String(error)}`)
    }
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
  private applyTaskPermission(session: { events: readonly SessionEvent[] }, permission?: string): void {
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
  private flushPendingPermission(session: { events: readonly SessionEvent[] }, sessionId: string): void {
    const pending = this.pendingPermissions.get(sessionId)
    if (pending === undefined) return
    this.pendingPermissions.delete(sessionId)
    this.applyTaskPermission(session, pending)
  }

  /**
   * 按 sessionId 解析（或冷恢复）一个 task 会话的 Agent。
   * 已存活直接返回；未存活但已持久化则 resume（官方 session-persistence 冷恢复历史）。
   */
  private async resolveTaskAgent(sessionId: string): Promise<{ agent: Agent; sessionId: SessionId; cwd: string; profileId: string } | undefined> {
    const live = this.taskAgents.get(sessionId)
    if (live !== undefined) return live
    const index = this.readTaskSessionIndex()
    const meta = index[sessionId]
    if (meta === undefined) return undefined
    // 泳道经官方对象层可能已被激活（侧栏选中/官方 sessions 收录）——此时 ctx.agents
    // 已有活 agent，直接复用，**不能再 resume**（官方 agents.resume 拒绝 live 会话：
    // 「cannot prepare session while it is live」）。
    const sid0 = SessionId(sessionId)
    const activated = this.ctx.agents.get(sid0)
    if (activated !== undefined) {
      const entry = { agent: activated, sessionId: sid0, cwd: meta.cwd, profileId: meta.profileId }
      this.taskAgents.set(sessionId, entry)
      return entry
    }
    const profile = meta.profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(meta.profileId)
    if (profile === undefined) return undefined
    const selection: ModelSelectionRef = {
      current: {
        provider: profile.model.provider,
        model: profile.model.model,
        ...(profile.model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(profile.model.reasoningEffort) }),
      },
      assembled: undefined,
    }
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, profile.id)
      installModelSelection(agentCtx, selection)
    }
    const agentOptions = { provider: profile.model.provider, model: profile.model.model }
    const sid = SessionId(sessionId)
    const handle = await this.ctx.agents.resume({ resumeSessionId: sid, agentOptions, setup })
    this.ctx.logger.info(`corum-agent(task): resumed — ${sessionId}`)
    const entry = { agent: handle.agent, sessionId: sid, cwd: meta.cwd, profileId: profile.id }
    this.taskAgents.set(sessionId, entry)
    return entry
  }

  /** 创建/恢复一个 task 会话并返回其 sessionId。 */
  @Remote('createTaskAgent')
  async createTaskAgentRemote(cwd: string, profileId?: string, permission?: string, model?: ProfileModel): Promise<{ sessionId: string }> {
    const result = await this.createAgentForTask(cwd, profileId, permission, model)
    return { sessionId: String(result.sessionId) }
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
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    const reply = summarizeText(agent.session.events, firstSeq)
    const events: SessionEventDto[] = []
    for (const event of agent.session.events) {
      if (event.seq < firstSeq) continue
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    const { systemPrompt, tools } = extractHeader(agent.session.events, firstSeq)
    return { reply, events, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(tools !== undefined ? { tools } : {}) }
  }

  /**
   * 读 task 会话的历史事件（从 fromSeq 开始，只读不发消息；切会话回填用）。
   *
   * 数据源：**持久化**（`ctx.sessionPersistence.readFrom`，全历史）而非
   * `agent.session.events` 窗口——后者冷 resume 后只含会话种子事件（permission/
   * sandbox/approval/end-seed），历史消息不在窗口（2026-08-28 实测：冷泳道 resume
   * 仅 4 条种子、无 user/message）。持久化读全历史，冷/活泳道一致。
   */
  @Remote('getTaskSessionEvents')
  async getTaskSessionEventsRemote(sessionId: string, fromSeq: number): Promise<{ events: SessionEventDto[] }> {
    const index = this.readTaskSessionIndex()
    if (index[sessionId] === undefined) return { events: [] }
    const { events: stored } = await this.ctx.sessionPersistence.readFrom(SessionId(sessionId), fromSeq)
    const events: SessionEventDto[] = []
    for (const event of stored) {
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    return { events }
  }

  /**
   * 列出 task 模式会话（侧栏 task 列表数据源；可按 cwd 过滤）。
   * 合并存活表与持久化索引：附标题（首条 user 消息摘要）、cwd、sessionId、
   * 最后活动时间、是否存活。一个工作区可多个会话。
   */
  @Remote('listTaskAgents')
  async listTaskAgentsRemote(cwd?: string): Promise<{ tasks: TaskAgentSummary[] }> {
    const index = this.readTaskSessionIndex()
    const out: TaskAgentSummary[] = []
    for (const [sessionId, meta] of Object.entries(index)) {
      if (cwd !== undefined && meta.cwd !== cwd) continue
      const live = this.taskAgents.get(sessionId)
      // 标题/最后活动从持久化读（冷泳道也有；存活表仅标 alive）。读全历史取首条
      // user 消息 + 末条时间，失败回退空（会话损坏不阻塞列表）。
      let title = ''
      let lastActive = 0
      try {
        const { events } = await this.ctx.sessionPersistence.readFrom(SessionId(sessionId), 0)
        title = taskTitleOf(events)
        if (events.length > 0) lastActive = events[events.length - 1].time
      } catch { /* 单个会话读取失败不阻塞列表 */ }
      out.push({
        sessionId,
        cwd: meta.cwd,
        profileId: meta.profileId,
        alive: live !== undefined,
        title,
        lastActive,
      })
    }
    return { tasks: out }
  }

  /** 冒烟测试。 */
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
    return { agents: [...this.agents.keys()].map(id => ({ profileId: id, created: true })) }
  }

  /**
   * 扫描全局 skill 目录（~/.dsh/skills/）发现可用 skills。
   *
   * Skill 全局统一管理在 ~/.dsh/skills/，每个 skill 是一个含 SKILL.md
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
   * 编译 AgentProfile 并落盘到 Agent 目录。
   * 写入 agent.cordis.yml + preset.yml。
   */
  private writeAgentDir(profile: AgentProfile, dir: string): void {
    mkdirSync(dir, { recursive: true })
    const compiled = compilePreset(profile)
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
  }

  /**
   * 把绑定的 skill 切换到 pinned 版本。
   * 把 .versions/<versionId>/SKILL.md 复制为当前 SKILL.md。
   * versionId 为空 = 用当前 SKILL.md（未锁定）。
   */
  private checkoutPinnedSkills(profile: AgentProfile): void {
    const skillsRoot = join(corumHome(), 'skills')
    for (const binding of profile.skills) {
      const skillDir = join(skillsRoot, binding.name)
      if (!existsSync(skillDir)) {
        this.ctx.logger.warn(`corum-agent: skill "${binding.name}" not found in ${skillsRoot}`)
        continue
      }
      // 未锁定版本（versionId 空）→ 直接用当前 SKILL.md，跳过切换。
      if (binding.versionId === undefined || binding.versionId === '') continue
      // 从版本目录复制 SKILL.md
      const versionSkillMd = join(skillDir, '.versions', binding.versionId, 'SKILL.md')
      const currentSkillMd = join(skillDir, 'SKILL.md')
      if (!existsSync(versionSkillMd)) {
        // 没有版本目录，说明 skill 是手动放进去的，直接用当前 SKILL.md
        continue
      }
      try {
        const content = readFileSync(versionSkillMd, 'utf8')
        writeFileSync(currentSkillMd, content, 'utf8')
      } catch (error) {
        this.ctx.logger.warn(`corum-agent: failed to switch skill "${binding.name}" to version ${binding.versionId}`, error)
      }
    }
  }
}

/** 冒烟测试固定提示词。 */
const SMOKE_PROMPT = 'Reply with exactly the single word "ok".'

/**
 * corum 运行目录（统一 home 解析，废弃 ~/.dsh）。
 * 桌面进程已把 DSH_HOME 指向 CORUM_HOME（见 corum-desktop/host/home.ts），
 * 所以 skill 根 = CORUM_HOME/skills。纯 host bridge 测试时回退 CORUM_HOME。
 */
function corumHome(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : '~/.corum'
  return resolveDshHome(configured)
}

/** 内置 smoke-test profile id。 */
const SMOKE_PROFILE_ID = 'smoke-test'

/** 框架预置的 PM profile id（所有项目默认带入的项目组 PM 助理）。 */
export const PM_PROFILE_ID = 'pm'

/** PM 兜底 profile 的 prompt（system profile 幂等刷新的事实源）。 */
const PM_PROMPT = [
  '你是项目组的 PM（项目经理 / 统筹 Agent），是「项目」与「用户」之间的交互入口，协助用户统筹管理项目。',
  '你的职责：',
  '1. 汇总信息：用 list_team_tasks 感知团队各成员的任务队列、当前任务与忙闲（含执行时长/最后活动/疑似卡住标注），向用户报告项目进展。',
  '2. 分配任务：理解用户指令后，用 assign_task 把任务精确派给合适的团队成员，并指定正确的工作类型泳道（general/ui/debug 或项目自定义泳道）。',
  '3. 回收结果：成员完成任务后（complete_task 闭环），汇总执行结果，清晰回报给用户。',
  '4. 卡住干预（你专属的协调工具）：发现成员疑似卡住（list_team_tasks 有 ⚠ 标注）或用户说某成员卡住时，按轻到重处置——steer_task 插入引导收敛（不打断）→ cancel_task 中止重派 → reassign_task 改派他人。处置后向用户说明。',
  '5. 决策与上报：基于项目状态，等待用户决策，或在职责范围内自主决策下一步要派给团队的任务；识别风险并上报用户。',
  '工作方式：先感知（list_team_tasks）再决策，派活要精确到成员和泳道；与用户对话简洁专业。',
].join('\n')

/**
 * 确保框架预置的 PM profile 存在（幂等）。
 * PM 是项目组的会话统筹 + 人机交互入口：回收任务执行结果给用户、等待或
 * 自主决策下一指令/任务给到团队。预置一份，所有项目共用引用（项目可后续
 * 换成自定义 PM profile）。
 */
export function ensurePmProfile(): AgentProfile {
  const existing = loadProfile(PM_PROFILE_ID)
  // system profile：prompt 随版本演进幂等刷新（保留用户的模型/能力配置）。
  if (existing !== undefined) {
    if (existing.trust === 'system' && existing.prompt !== PM_PROMPT) {
      const refreshed = { ...existing, prompt: PM_PROMPT }
      saveProfile(refreshed)
      return refreshed
    }
    return existing
  }
  const profile: AgentProfile = {
    id: PM_PROFILE_ID,
    nickname: 'PM 助理',
    title: '项目统筹',
    prompt: PM_PROMPT,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/** task 模式的内置 profile id（单任务会话默认角色）。 */
const TASK_PROFILE_ID = 'task'
/** task 会话持久化索引落的专用伪项目目录（与 project 泳道的项目目录隔离）。 */
const TASK_PROJECT_ID = 'task'

const TASK_PROMPT = '你是矩道 task 模式的单任务开发 Agent。用户在某工作区直接发起一个开发任务，你独立完成它。\n工作方式：理解任务 → 用工具（读写文件/跑命令）推进 → 完成后简洁汇报结果。\n你是单任务会话：不涉及项目团队/派活/需求管理，专注把当前这一个任务做好。'

/**
 * 确保 task 模式的内置 profile 存在（幂等）。
 * task profile 是单任务会话的默认角色：无项目团队语义，独立完成任务。
 */
export function ensureTaskProfile(): AgentProfile {
  const existing = loadProfile(TASK_PROFILE_ID)
  if (existing !== undefined) {
    if (existing.trust === 'system' && existing.prompt !== TASK_PROMPT) {
      const refreshed = { ...existing, prompt: TASK_PROMPT }
      saveProfile(refreshed)
      return refreshed
    }
    return existing
  }
  const profile: AgentProfile = {
    id: TASK_PROFILE_ID,
    nickname: 'Task 助理',
    title: '单任务',
    prompt: TASK_PROMPT,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/** 确保内置 smoke-test profile 存在（幂等）。 */
function ensureSmokeProfile(): AgentProfile {
  const existing = loadProfile(SMOKE_PROFILE_ID)
  if (existing !== undefined) return existing
  const profile: AgentProfile = {
    id: SMOKE_PROFILE_ID,
    prompt: 'You are a smoke-test agent. Follow the user instruction exactly and briefly.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/** 从 request/header 事件提取最终装配的 system prompt + 工具列表。 */
function extractHeader(events: readonly SessionEvent[], firstSeq: number): {
  systemPrompt?: string
  tools?: Array<{ name: string; description?: string }>
} {
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type !== 'request/header') continue
    const header = (event.data as { header?: { system?: string; tools?: Array<{ name?: string; description?: string }> } }).header
    if (header === undefined) return {}
    const result: { systemPrompt?: string; tools?: Array<{ name: string; description?: string }> } = {}
    if (header.system !== undefined) result.systemPrompt = header.system
    if (Array.isArray(header.tools)) {
      result.tools = header.tools.map(t => ({
        name: t.name ?? '',
        ...(t.description !== undefined ? { description: t.description } : {}),
      }))
    }
    return result
  }
  return {}
}

/** 汇总一段区间内最终的 assistant 文本（text 块拼接）。 */
function summarizeText(events: readonly SessionEvent[], firstSeq: number): string {
  let started = false
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
  }
  return text
}

/**
 * 简化 SessionEvent 的 data 字段，只保留 UI 渲染需要的子集。
 */
export function simplifyEventData(event: SessionEvent): unknown {
  let raw: Record<string, unknown>
  switch (event.type) {
    case 'user/message': {
      // 官方 user/message 事件 content 在 data.content（顶层）；少数路径在
      // data.message.content（与 assistant/message 同形）。两种都兼容。
      const data = event.data as {
        content?: Array<{ type: string; text?: string }>
        message?: { content?: Array<{ type: string; text?: string }> }
      }
      const content = data.content ?? data.message?.content ?? []
      raw = {
        content: content.map(b => b.type === 'text' ? { type: 'text', text: b.text ?? '' } : { type: b.type }),
      }
      break
    }
    case 'assistant/message': {
      const data = event.data as {
        message: { content: Array<{ type: string; text?: string; reasoning?: string }> }
        turn?: number
        step?: number
        usage?: unknown
        interrupted?: boolean
      }
      raw = {
        content: data.message.content.map(b => {
          if (b.type === 'text') return { type: 'text', text: b.text ?? '' }
          if (b.type === 'reasoning') return { type: 'reasoning', text: b.reasoning ?? '' }
          if (b.type === 'tool-call') {
            // 内联 tool-call 块：保留 name + arguments（供工具行展示命令/路径）。
            const tb = b as { name?: string; arguments?: unknown }
            const out: Record<string, unknown> = { type: 'tool-call', name: tb.name ?? '' }
            if (tb.arguments !== undefined) out.arguments = tb.arguments
            return out
          }
          return { type: b.type }
        }),
      }
      // turn/step 投影（UI 据此关联 turn/start→turn/end 算耗时、判本 turn 是否落地）。
      if (data.turn !== undefined) raw.turn = data.turn
      if (data.step !== undefined) raw.step = data.step
      if (data.usage !== undefined) raw.usage = data.usage
      if (data.interrupted !== undefined) raw.interrupted = data.interrupted
      break
    }
    case 'tool/call': {
      const data = event.data as { callId?: string; name?: string; arguments?: unknown }
      raw = { callId: data.callId ?? '', name: data.name ?? '' }
      if (data.arguments !== undefined) raw.arguments = data.arguments
      break
    }
    case 'tool/result': {
      const data = event.data as {
        callId?: string
        error?: unknown
        message?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      }
      raw = {
        callId: data.callId ?? '',
        isError: data.message?.isError ?? false,
        content: data.message?.content?.map(b => b.type === 'text' ? { type: 'text', text: b.text ?? '' } : { type: b.type }) ?? [],
      }
      if (data.error !== undefined) raw.error = String(data.error)
      break
    }
    case 'turn/start': {
      raw = { turn: (event.data as { turn?: number }).turn ?? 0 }
      break
    }
    case 'turn/end': {
      const data = event.data as { turn?: number; reason?: unknown }
      // reason 可能是对象（FinishReason 结构）——取可读字符串而非 [object Object]。
      const reason = data.reason
      raw = {
        turn: data.turn ?? 0,
        reason: typeof reason === 'string' ? reason : reason !== undefined ? JSON.stringify(reason) : '',
      }
      break
    }
    case 'step/start':
    case 'step/end': {
      raw = { turn: (event.data as { turn?: number }).turn ?? 0, step: (event.data as { step?: number }).step ?? 0 }
      break
    }
    case 'assistant/chunk': {
      // 流式增量（官方 StreamChunk）：投影 chunk 判别字段 + 增量内容，
      // 供 UI 聚合同 turn+step 的连续 chunk 为「流式增量」块。
      const data = event.data as {
        turn?: number
        step?: number
        chunk?: {
          type?: string
          text?: string
          name?: string
          argumentsDelta?: string
          reason?: unknown
          usage?: unknown
        }
      }
      const chunk = data.chunk ?? {}
      raw = {
        turn: data.turn ?? 0,
        step: data.step ?? 0,
        chunkType: chunk.type ?? '',
      }
      if (chunk.text !== undefined) raw.text = chunk.text
      if (chunk.name !== undefined) raw.name = chunk.name
      if (chunk.argumentsDelta !== undefined) raw.argumentsDelta = chunk.argumentsDelta
      if (chunk.reason !== undefined) raw.reason = String(chunk.reason)
      if (chunk.usage !== undefined) raw.usage = chunk.usage
      break
    }
    default:
      raw = {}
  }
  // 清洗为完全 JSON-safe 的 plain object（Gateway assertJsonValue 要求）
  return JSON.parse(JSON.stringify(raw))
}

// ── 文件系统 skill 扫描（~/.dsh/skills/ 全局目录） ──────────────────

/**
 * 解析 SKILL.md 的 YAML frontmatter，提取 name / description / whenToUse /
 * invocation policy。只做最小解析（不引 yaml 库，手动提取必需字段）。
 */
function parseSkillFrontmatter(content: string): {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
} | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch === null) return undefined
  const fm = fmMatch[1]
  const fields = new Map<string, string>()
  for (const line of fm.split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/)
    if (m !== null) fields.set(m[1], m[2].trim())
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (name === undefined || description === undefined) return undefined
  const whenToUse = fields.get('whenToUse')
  const disableModelInvocation = fields.get('disable-model-invocation') === 'true'
  const userInvocable = fields.get('user-invocable') !== 'false'
  return {
    name,
    description,
    ...(whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {}),
    modelInvocable: !disableModelInvocation,
    userInvocable,
  }
}

/**
 * 读取 skill 目录的版本配置（skill-versions.json）。
 */
function readSkillVersions(dir: string): { versions: Array<{ id: string; date: string; label: string }> } {
  const configPath = join(dir, 'skill-versions.json')
  if (!existsSync(configPath)) return { versions: [] }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return { versions: [] }
  }
}

/**
 * 扫描全局 skill 目录（CORUM_HOME/skills/），返回可用 skill 列表。
 */
function scanSkills(): SkillEntry[] {
  const skillsRoot = join(corumHome(), 'skills')
  if (!existsSync(skillsRoot)) return []

  let entries
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: SkillEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    const parsed = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf8'))
    if (parsed === undefined) continue
    const { versions } = readSkillVersions(skillDir)
    const latest = versions.length > 0 ? versions[versions.length - 1] : undefined
    skills.push({
      ...parsed,
      path: skillDir,
      versionCount: versions.length,
      ...(latest !== undefined ? { currentVersion: latest.id } : {}),
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** 泳道标签转 sessionId 安全段（标签可含 `:`，sessionId/路径只用 lower-kebab）。 */
function slugLaneKey(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? GENERAL_WORK_TYPE : slug
}

export default CorumAgentService
