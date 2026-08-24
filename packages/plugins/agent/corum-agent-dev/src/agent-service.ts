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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { compilePreset } from './compile.ts'
import type { AgentProfile, SkillBinding } from './profile.ts'
import { isValidProfileId } from './profile.ts'
import { GENERAL_WORK_TYPE, isValidProjectId, isValidWorkTypeSlug } from './project.ts'
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
export class CorumAgentService extends TypertRemoteService {
  static inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions']

  /** 已创建的角色 root Agent（按 profile id）。 */
  private readonly agents = new Map<string, Agent>()

  /**
   * 已存活的「项目 × 角色 × 工作类型」会话 Agent（instanceKey =
   * `${projectId}${profileId}${type}`）。调度层模拟单实例多会话的活跃实例表。
   */
  private readonly typeAgents = new Map<string, { agent: Agent; sessionId: SessionId }>()

  constructor(ctx: Context) {
    super(ctx, 'corumAgent')
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

  /**
   * 按「项目 × 角色 × 工作类型」创建或恢复一个 root Agent（= 一个 type 会话）。
   *
   * 这是团队成员多会话模型的落地（见 project.md「单 Agent 多会话」已知待解
   * 问题 + docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md §6.1）：
   * 同一 profile 按 (projectId, type) 各持一个独立 root Agent（官方 Agent:Session
   * =1:1 硬绑定，N 个 type 会话即 N 个实例，各挂同一份 preset、会话各自独立）。
   *
   * sessionId 稳定可路由：corum-proj<p>-agent<a>-type<t>-<rand>。进程内已存活
   * 直接复用；否则查 sessionPersistence——已持久化则 resume（冷恢复历史），
   * 未持久化则 create（并登记 sessionId 进项目目录，供下次 resume 找回）。
   *
   * @param projectId - 项目 id（团队属项目，会话隔离边界）。
   * @param profileId - 角色 profile id。
   * @param type - 工作类型 slug（缺省 general）。
   * @param extraSetup - 可选额外能力注入（如 complete_task 工具）。
   * @returns 创建/恢复结果 + 该会话的 sessionId。
   */
  async createAgentForType(
    projectId: string,
    profileId: string,
    type: string = GENERAL_WORK_TYPE,
    extraSetup?: (agentCtx: Context) => void,
  ): Promise<CreateAgentResult & { sessionId: SessionId }> {
    if (!isValidProjectId(projectId)) throw new Error(`dev-agent: invalid project id "${projectId}"`)
    if (!isValidWorkTypeSlug(type)) throw new Error(`dev-agent: invalid work type slug "${type}"`)
    const instanceKey = `${projectId}${profileId}${type}`
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
    const workCwd = project.cwd !== undefined && project.cwd !== '' ? project.cwd : process.cwd()

    // 查本项目该 type 会话是否已持久化（登记在项目目录的 session 索引里）。
    const persisted = this.lookupPersistedSessionId(projectId, profileId, type)
    const sessionId = persisted ?? SessionId(`corum-proj${projectId}-agent${profileId}-type${type}-${randomBytes(4).toString('hex')}`)

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
      this.registerSessionId(projectId, profileId, type, sessionId)
      this.ctx.logger.info(`corum-agent: created agent — ${sessionId}`)
    }

    this.typeAgents.set(instanceKey, { agent: handle.agent, sessionId })
    return { agent: handle.agent, presetId: profileId, sessionId }
  }

  /** 获取一个已存活的 (project, profile, type) 会话 Agent。 */
  getAgentForType(projectId: string, profileId: string, type: string = GENERAL_WORK_TYPE): Agent | undefined {
    return this.typeAgents.get(`${projectId}${profileId}${type}`)?.agent
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

/**
 * 确保框架预置的 PM profile 存在（幂等）。
 * PM 是项目组的会话统筹 + 人机交互入口：回收任务执行结果给用户、等待或
 * 自主决策下一指令/任务给到团队。预置一份，所有项目共用引用（项目可后续
 * 换成自定义 PM profile）。
 */
export function ensurePmProfile(): AgentProfile {
  const existing = loadProfile(PM_PROFILE_ID)
  if (existing !== undefined) return existing
  const profile: AgentProfile = {
    id: PM_PROFILE_ID,
    nickname: 'PM 助理',
    title: '项目统筹',
    prompt: [
      '你是项目组的 PM（项目经理 / 统筹 Agent），是「项目」与「用户」之间的交互入口，协助用户统筹管理项目。',
      '你的职责：',
      '1. 汇总信息：用 list_team_tasks 感知团队各成员的任务队列、当前任务与忙闲，向用户报告项目进展。',
      '2. 分配任务：理解用户指令后，用 assign_task 把任务精确派给合适的团队成员，并指定正确的工作类型泳道（general/ui/debug 或项目自定义泳道）。',
      '3. 回收结果：成员完成任务后（complete_task 闭环），汇总执行结果，清晰回报给用户。',
      '4. 决策与上报：基于项目状态，等待用户决策，或在职责范围内自主决策下一步要派给团队的任务；识别风险并上报用户。',
      '工作方式：先感知（list_team_tasks）再决策，派活要精确到成员和泳道；与用户对话简洁专业。',
    ].join('\n'),
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
      const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } }
      raw = {
        content: data.message?.content?.map(b => b.type === 'text' ? { type: 'text', text: b.text ?? '' } : { type: b.type }) ?? [],
      }
      break
    }
    case 'assistant/message': {
      const data = event.data as {
        message: { content: Array<{ type: string; text?: string; reasoning?: string }> }
        usage?: unknown
        interrupted?: boolean
      }
      raw = {
        content: data.message.content.map(b => {
          if (b.type === 'text') return { type: 'text', text: b.text ?? '' }
          if (b.type === 'reasoning') return { type: 'reasoning', text: b.reasoning ?? '' }
          if (b.type === 'tool-call') return { type: 'tool-call', name: (b as { name?: string }).name ?? '' }
          return { type: b.type }
        }),
      }
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
      raw = { turn: data.turn ?? 0, reason: String(data.reason ?? '') }
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

export default CorumAgentService
