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
 * @module @corum/dev-agent/agent-service
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
// 空类型 import：让 ctx.agentDefaultModel / ctx.agentPresets 的 Context 合并生效。
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { compilePreset } from './compile.ts'
import type { AgentProfile } from './profile.ts'
import { isValidProfileId } from './profile.ts'
import { loadProfile, listProfiles, saveProfile, deleteProfile, agentDirPath, importSkill, listImportedSkills, removeImportedSkill } from './profile-store.ts'

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
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  skills: string[]
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

/** UI 投影的可用 skill 摘要（ctx.skills.list() 的结果子集）。 */
export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  source: string
  provider: string
  /** skill 文件的绝对路径（用于导入到 Agent 目录）。 */
  path?: string
}

/** 单条会话事件的 UI 投影（只取 UI 需要的简化结构）。 */
export interface SessionEventDto {
  seq: number
  type: string
  /** 简化数据（UI 按 type 自行解析）。 */
  data: unknown
  time: number
}

/** runPrompt 的返回：assistant 回复文本 + 过程事件快照。 */
export interface RunPromptResult {
  reply: string
  events: SessionEventDto[]
}

/** saveProfile 的 RPC 入参（AgentProfile 子集，UI 可编辑的字段）。 */
export interface SaveProfileInput {
  id: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  skills: string[]
  mcpServers: Array<{
    serverName: string
    transport: 'stdio' | 'streamable-http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
  }>
  terminal: { mode: 'sandbox' | 'host' }
  memoryPolicy: { scope: 'agent'; dir?: string }
  trust: 'system' | 'user'
  /**
   * 要导入到 Agent 目录 skills/ 下的 skill 源信息。
   * 每个 skill 从 sourcePath 复制到 `<agentDir>/skills/<name>/`。
   */
  skillsToImport: Array<{ name: string; sourcePath: string }>
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

  constructor(ctx: Context) {
    super(ctx, 'corumAgent')
  }

  /**
   * 从 AgentProfile id 创建（或复用）一个 root Agent。
   * @param profileId - AgentProfile id。
   * @returns 创建的 root Agent 及其 preset id。
   */
  async createAgent(profileId: string): Promise<CreateAgentResult> {
    const existing = this.agents.get(profileId)
    if (existing !== undefined) return { agent: existing, presetId: profileId }

    const profile = loadProfile(profileId)
    if (profile === undefined) {
      throw new Error(`dev-agent: profile "${profileId}" not found`)
    }
    if (!isValidProfileId(profile.id)) {
      throw new Error(`dev-agent: invalid profile id "${profile.id}"`)
    }

    // 1. 编译 + 落盘 preset 目录（含 agent.cordis.yml + preset.yml）。
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
        // 官方模型选择安装：把 provider/model/reasoningEffort 绑定到该 Agent 作用域。
        installModelSelection(agentCtx, selection)
      },
    })

    this.agents.set(profileId, handle.agent)
    this.ctx.logger.info(`corum-agent: root agent created for profile "${profileId}" — ${sessionId}`)
    return { agent: handle.agent, presetId: profile.id }
  }

  /** 获取已创建的 Agent（未创建返回 undefined）。 */
  getAgent(profileId: string): Agent | undefined {
    return this.agents.get(profileId)
  }

  /**
   * 把一个提示词驱动给 profile 对应的 root Agent，等它跑到 quiescence 后
   * 汇总最终回复文本。日志验证入口：不依赖任何官方 UI，直接验证「真正绑定
   * 能力的 root Agent」能干活。
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
      prompt: p.prompt,
      model: p.model,
      skills: p.skills,
      mcpServers: p.mcpServers.map(m => m.serverName),
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
    return { reply, events }
  }

  /**
   * 保存（创建或更新）一个 AgentProfile，并编译落盘整个 Agent 目录。
   *
   * 流程：
   *   1. 保存 agent.json（描述文件）
   *   2. 导入选中的 skills（从外部路径复制到 <agentDir>/skills/）
   *   3. 清理已不在 skills 列表中的旧 skill
   *   4. 编译 agent.cordis.yml + preset.yml（含 customSkillDirs）
   *   5. 清掉运行中旧 Agent（下次创建重建）
   */
  @Remote('saveProfile')
  saveProfileRemote(input: SaveProfileInput): { profile: ProfileSummary } {
    if (!isValidProfileId(input.id)) {
      throw new Error(`corum-agent: invalid profile id "${input.id}"`)
    }
    const profile: AgentProfile = {
      id: input.id,
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

    // 导入选中的 skills：从外部路径复制到 Agent 目录的 skills/ 下。
    const dir = agentDirPath(input.id)
    const existingImported = new Set(listImportedSkills(input.id))
    const wantedSkills = new Set(input.skillsToImport.map(s => s.name))
    // 导入/更新选中的 skill
    for (const sk of input.skillsToImport) {
      try {
        importSkill(input.id, sk.name, sk.sourcePath)
      } catch (error) {
        this.ctx.logger.warn(`corum-agent: failed to import skill "${sk.name}" from "${sk.sourcePath}"`, error)
      }
    }
    // 清理不再选中的旧 skill（已导入但不在 skillsToImport 中的）
    for (const old of existingImported) {
      if (!wantedSkills.has(old)) {
        removeImportedSkill(input.id, old)
      }
    }

    // 编译并落盘 agent.cordis.yml + preset.yml
    this.writeAgentDir(loadProfile(input.id)!, dir)

    // 清掉旧 Agent 使下次重建
    this.agents.delete(input.id)
    const saved = loadProfile(input.id)!
    return {
      profile: {
        id: saved.id,
        prompt: saved.prompt,
        model: saved.model,
        skills: saved.skills,
        mcpServers: saved.mcpServers.map(m => m.serverName),
        terminal: { mode: saved.terminal.mode },
        version: saved.version,
        trust: saved.trust,
      },
    }
  }

  /** 列出 Agent 目录中已导入的 skills。 */
  @Remote('listImportedSkills')
  listImportedSkillsRemote(profileId: string): { skills: string[] } {
    if (!isValidProfileId(profileId)) throw new Error(`corum-agent: invalid profile id "${profileId}"`)
    return { skills: listImportedSkills(profileId) }
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
   * 扫描文件系统发现可用 skills（不依赖 ctx.skills，直接用 node:fs）。
   *
   * 扫描路径（与 dsh-skill-filesystem 的默认根一致）：
   *   ~/.dsh/skills/       (source: user-dsh)
   *   ~/.agents/skills/     (source: user-agents)
   *   <cwd>/.dsh/skills/   (source: project-dsh)
   *   <cwd>/.agents/skills/ (source: project-agents)
   *
   * 每个 skill 是一个目录（含 SKILL.md）或 flat .md 文件。
   * SKILL.md 的 YAML frontmatter 必须有 name + description。
   *
   * UI 拿到列表后渲染为可勾选的 checklist，保存时选中的 skill 从
   * 其 path（目录或文件路径）复制到 Agent 专属 skills/ 目录。
   */
  @Remote('listSkills')
  listSkillsRemote(): { skills: SkillEntry[] } {
    return { skills: scanSkills() }
  }

  /**
   * 日志验证（冒烟测试）：用内置 smoke-test profile 跑一个固定提示词，把
   * 「创建 Agent → 驱动 → 汇总」的完整闭环打到 stderr 日志。无外部触发时
   * （dev-agent combo 启动即触发）用来证明 root Agent 真正可用。
   *
   * 注意：cordis LoggerService 默认只把日志 push 进内存 buffer，不落地到
   * 终端，这里直接用 process.stderr.write 保证验证输出可见。
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
   * 写入 agent.cordis.yml + preset.yml，customSkillDirs 指向 Agent 自身的 skills/ 目录。
   * @param profile - AgentProfile（已保存 agent.json 的版本）。
   * @param dir - Agent 目录的绝对路径。
   */
  private writeAgentDir(profile: AgentProfile, dir: string): void {
    mkdirSync(dir, { recursive: true })
    const compiled = compilePreset(profile, dir)
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
  }
}

/** 冒烟测试固定提示词：只验证 Agent 回路，不产生任何副作用。 */
const SMOKE_PROMPT = 'Reply with exactly the single word "ok".'

/** 内置 smoke-test profile id。 */
const SMOKE_PROFILE_ID = 'smoke-test'

/** 确保内置 smoke-test profile 存在（幂等），返回其当前定义。 */
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
 * 完整的 SessionEvent 数据结构太大且含循环引用风险，这里按 type 提取。
 */
function simplifyEventData(event: SessionEvent): unknown {
  switch (event.type) {
    case 'user/message': {
      const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } }
      return {
        content: data.message?.content?.map(b => b.type === 'text' ? { type: 'text', text: b.text } : b) ?? [],
      }
    }
    case 'assistant/message': {
      const data = event.data as {
        message: { content: Array<{ type: string; text?: string; reasoning?: unknown; toolCall?: unknown }> }
        usage?: unknown
        interrupted?: boolean
      }
      return {
        content: data.message.content.map(b => {
          if (b.type === 'text') return { type: 'text', text: b.text }
          if (b.type === 'reasoning') return { type: 'reasoning' }
          if (b.type === 'tool-call') return { type: 'tool-call', name: (b as { name?: string }).name }
          return { type: b.type }
        }),
        usage: data.usage,
        interrupted: data.interrupted,
      }
    }
    case 'tool/call': {
      const data = event.data as { callId?: string; name?: string; arguments?: unknown }
      return { callId: data.callId, name: data.name }
    }
    case 'tool/result': {
      const data = event.data as { callId?: string; error?: unknown }
      return { callId: data.callId, error: data.error }
    }
    case 'turn/start': {
      return { turn: (event.data as { turn?: number }).turn }
    }
    case 'turn/end': {
      const data = event.data as { turn?: number; reason?: unknown }
      return { turn: data.turn, reason: String(data.reason) }
    }
    case 'step/start':
    case 'step/end': {
      return { turn: (event.data as { turn?: number }).turn, step: (event.data as { step?: number }).step }
    }
    default:
      return {}
  }
}

// ── 文件系统 skill 扫描（独立于 ctx.skills，直接用 node:fs） ────────

/** 扫描根目录定义。 */
interface SkillScanRoot {
  path: string
  source: string
}

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
  // frontmatter 在 `---` ... `---` 之间
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch === null) return undefined
  const fm = fmMatch[1]
  // 逐行提取 key: value
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

/** 扫描一个根目录，返回发现的 skill 列表。 */
function scanRoot(root: SkillScanRoot): SkillEntry[] {
  const results: SkillEntry[] = []
  if (!existsSync(root.path)) return results
  let entries
  try {
    entries = readdirSync(root.path, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      // 目录型 skill：<dir>/SKILL.md
      const skillMdPath = join(root.path, entry.name, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue
      const parsed = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf8'))
      if (parsed === undefined) continue
      results.push({
        ...parsed,
        source: root.source,
        provider: 'filesystem',
        path: join(root.path, entry.name),
      })
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // flat .md skill 文件
      const filePath = join(root.path, entry.name)
      const parsed = parseSkillFrontmatter(readFileSync(filePath, 'utf8'))
      if (parsed === undefined) continue
      results.push({
        ...parsed,
        source: root.source,
        provider: 'filesystem',
        path: root.path,
      })
    }
  }
  return results
}

/**
 * 扫描所有 skill 根目录，返回去重后的 skill 列表。
 * 扫描路径与 dsh-skill-filesystem 的默认根一致。
 */
function scanSkills(): SkillEntry[] {
  const home = resolveDshHome(process.env.CORUM_HOME ?? '~/.corum-shell')
  // dsh home 和 agents home
  const dshHome = process.env.DSH_HOME ?? '~/.dsh'
  const agentsHome = process.env.DSH_AGENTS_HOME ?? '~/.agents'
  const roots: SkillScanRoot[] = [
    { path: join(resolveDshHome(dshHome), 'skills'), source: 'user-dsh' },
    { path: join(resolveDshHome(agentsHome), 'skills'), source: 'user-agents' },
  ]
  // 项目根（向上查找 .git）
  const cwd = process.cwd()
  const projectRoot = findProjectRoot(cwd)
  if (projectRoot !== undefined) {
    roots.push(
      { path: join(projectRoot, '.dsh', 'skills'), source: 'project-dsh' },
      { path: join(projectRoot, '.agents', 'skills'), source: 'project-agents' },
    )
  }
  // 扫描所有根，按 name 去重（先扫到的赢，与 dsh 的 rank 顺序一致）
  const seen = new Set<string>()
  const all: SkillEntry[] = []
  for (const root of roots) {
    for (const sk of scanRoot(root)) {
      if (!seen.has(sk.name)) {
        seen.add(sk.name)
        all.push(sk)
      }
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name))
}

/** 向上查找项目根（包含 .git 的目录）。 */
function findProjectRoot(start: string): string | undefined {
  let dir = start
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export default CorumAgentService
