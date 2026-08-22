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
import { mkdirSync, writeFileSync } from 'node:fs'
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
import { loadProfile, listProfiles, saveProfile } from './profile-store.ts'

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

    // 1. 编译 + 落盘 preset 目录。
    this.writePreset(profile)

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

  /** 用指定 profile 的 Agent 跑一个 prompt，返回回复文本。 */
  @Remote('runPrompt')
  async runPromptRemote(profileId: string, prompt: string): Promise<{ reply: string }> {
    const reply = await this.runProfile(profileId, prompt)
    return { reply }
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
   * 编译 AgentProfile 并落盘到 user root（`~/.corum-shell/.agent-presets/<id>/`）。
   */
  private writePreset(profile: AgentProfile): void {
    const root = join(resolveDshHome(process.env.CORUM_HOME ?? '~/.corum-shell'), '.agent-presets', profile.id)
    mkdirSync(dirname(join(root, 'agent.cordis.yml')), { recursive: true })
    const compiled = compilePreset(profile)
    writeFileSync(join(root, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(root, 'preset.yml'), compiled.presetYml)
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

export default CorumAgentService
