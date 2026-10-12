/**
 * applySubagentModelForSession — 委派机制「子 Agent 模型永久切换」能力面的机器验证。
 *
 * 覆盖（对应任务规格的四条）：
 *   (a) role='worker' 写入 preset 的 `subagentModel`，且 **预设其他字段全部保留**
 *       ——saveProfile 只浅拷贝入参整体落盘、不与存量合并，直接传部分对象会静默丢
 *       memoryPolicy（台账 lesson.profile.saveProfile-needs-full-input-and-summary-
 *       omits-memoryPolicy：档案加载不能、listProfiles 全体失败）。本测试显式断言
 *       memoryPolicy / skills / mcpServers / terminal / prompt / model 这些
 *       「部分保存就会丢」的字段；
 *   (b) route=undefined 清除键本身（磁盘 JSON 无该键，非 undefined 占位）；
 *   (c) role='research' 写 `researchModel` 而不是 `subagentModel`；
 *   (d) 未知会话 / 解析不到预设 → fail-loud 抛错（绝不静默回落默认预设——写错预设
 *       = 用户以为改了 A 实际改了 B）。
 *
 * 真实落盘验证：CORUM_HOME 指向 tmpdir，agent.json / agent.cordis.yml /
 * preset.yml 走 profile-store + compilePreset 的真实路径（不做 mock——本能力的
 * 价值全在「完整入参 + 真实写盘」语义对得上）。Agent/会话按 CorumAgentService
 * 内部表的最小形状 stub，不拉官方 host 组装（那是 runtime-task 级联的重装置）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeHarness, projectionsOf, type Harness } from './harness.ts'
import type { AgentProfile } from '../src/profile.ts'
import { compilePreset } from '../src/compile.ts'

// ⚠️ 不再需要本文件自建 home：`makeHarness()` 每建一个测试台就建一个临时 home 并把
// `CORUM_HOME` / `DSH_HOME` 指过去（且每个测试台**独占**一个）。此前本文件与 harness
// 各建一个 home，profile 写在 A、断言读 B —— 迁移时实测踩到（ENOENT）。
// 纪律：临时 home 的所有权只属于 harness，spec 一律经 `h.home` 读。

/** 最小可用 AgentProfile（与 compile-subagent.spec 同口径，另补 trap 哨兵字段）。 */
function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'sam-test-agent',
    baseMode: 'standard',
    prompt: '测试 Agent',
    model: { provider: 'local', model: 'deepseek-v4-flash' },
    skills: [{ name: 'pen-dev', versionId: '2026-09-18-01' }],
    mcpServers: ['pencil-mcp'],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
    ...overrides,
  }
}

/**
 * 本套的测试台一律来自 `tests/harness.ts`（**唯一**知道怎么造服务的地方）。
 *
 * ⚠️ 2026-09-21（P3-a）迁移：本文件原先自带一个 `makeService()`，用
 * `Object.create(prototype)` + `Object.defineProperty(svc, 'taskAgents', …)` **按状态表
 * 名字**造表。状态搬进 `AgentRegistry` 之后那种写法会**静默失真**——`defineProperty`
 * 照样成功、被测代码却读自己的空表，测试随后以「不是本进程存活的 Agent 会话」这种
 * 假绿/假红呈现，指不到真因。改用 harness 后契约断裂会 **fail-loud**。
 */
function setup(): Harness {
  const h = makeHarness()
  h.provide('sessionProjections', { stateOf: (): undefined => undefined })
  h.provide('agents', { get: (): undefined => undefined })
  return h
}

/** 把一个存活会话登记进 task 表（含 `agentPreset` 投影，本能力的解析源）。 */
function registerSession(h: Harness, sessionId: string, presetId: string): void {
  h.registerTaskAgent(sessionId, { profileId: presetId })
  h.provide('sessionProjections', projectionsOf({ [sessionId]: presetId }))
}

describe('★ 服务取用纪律（2026-09-18 实机事故的回归门禁）', () => {
  it('sessionProjections 必须走 ctx.get()——属性访问在未 inject 时抛 cannot get … without inject', () => {
    // 实机事故：永久档第一次点「跟随主 Agent」死在
    // `cannot get property "sessionProjections" without inject`
    // （corum-agent 的 static inject 里没有它；vendor/cordis/src/reflect.ts:144）。
    // 修法 = 改用 `ctx.get('sessionProjections')`（get 无 inject 门禁，同文件 233-243）。
    const src = readFileSync(join(import.meta.dirname, '../src/agent-service.ts'), 'utf8')
    // 切到下一个顶层成员（`\n  private ` / `\n  @Remote` / `\n}`）为止——不能拿
    // `persistProfileAndRecompile(` 当终点（它在文件里定义在本方法**之前**，会切出空串）。
    const start = src.indexOf('applySubagentModelForSession(')
    expect(start).toBeGreaterThan(-1)
    const rest = src.slice(start)
    const endMatch = /\n  (?:private |public |@Remote|\})/.exec(rest.slice(1))
    const body = endMatch === null ? rest : rest.slice(0, endMatch.index + 1)
    expect(body).toContain("this.ctx.get('sessionProjections'")
    expect(body).not.toMatch(/\.sessionProjections\b\s*(\?\?)?\s*[;,\n]/)
  })
})

describe('applySubagentModelForSession — 委派机制模型永久切换', () => {
  it("(a) worker 写 subagentModel 且预设其他字段全部保留（saveProfile 部分保存陷阱防线）", () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-a', p.id)

    const result = h.service.applySubagentModelForSession('sess-a', 'worker', { provider: 'pi-ai', model: 'glm-5.3' })

    expect(result).toEqual({ presetId: p.id, applied: { provider: 'pi-ai', model: 'glm-5.3' } })
    const saved = JSON.parse(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    // 目标键写入
    expect(saved.subagentModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3' })
    // trap 哨兵：这些字段被部分保存丢掉过 / 会直接让档案加载不能
    expect(saved.memoryPolicy).toEqual({ scope: 'agent' })
    expect(saved.skills).toEqual([{ name: 'pen-dev', versionId: '2026-09-18-01' }])
    expect(saved.mcpServers).toEqual(['pencil-mcp'])
    expect(saved.terminal).toEqual({ mode: 'sandbox' })
    expect(saved.prompt).toBe('测试 Agent')
    expect(saved.model).toEqual({ provider: 'local', model: 'deepseek-v4-flash' })
    expect(saved.baseMode).toBe('standard')
    // version 自增（saveProfile 语义：存量 version + 1）
    expect(saved.version).toBe(2)
    // 编译产物同步刷新（写 agent.json 不重编译 = 半更新）
    const compiled = compilePreset(saved as AgentProfile)
    expect(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.cordis.yml'), 'utf8')).toBe(compiled.cordisYml)
    expect(readFileSync(join(h.home, '.agent-presets', p.id, 'preset.yml'), 'utf8')).toBe(compiled.presetYml)
    expect(existsSync(join(h.home, '.agent-presets', p.id, 'agent.json'))).toBe(true)
  })

  it('(a3) ★ 机制自有字段 specBaseline 不得在保存时丢失（2026-09-27 实测 conductor-lead）', () => {
    // 现象：`saveProfileRemote` 用**显式白名单**重建 profile ⇒ 不在 `SaveProfileInput` 里的
    // 字段被静默丢掉。丢 `specBaseline` 的后果不是"少个字段"，而是 `refreshFromSpec` 会把
    // **用户当前值**当成 spec 值 ⇒ 用户自定义从此可被后续 spec 升级覆盖。
    const baseline = { nickname: '指挥模式', baseMode: 'conductor', prompt: 'spec 写下的提示词' }
    const p = profile({ trust: 'system', specBaseline: baseline })
    const h = setup()
    h.writeProfile(p)

    const path = join(h.home, '.agent-presets', p.id, 'agent.json')
    const before = (JSON.parse(readFileSync(path, 'utf8')) as AgentProfile).version

    h.service.saveProfileRemote({
      id: p.id,
      baseMode: p.baseMode,
      prompt: p.prompt,
      model: p.model,
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: p.trust,
    })

    const saved = JSON.parse(readFileSync(path, 'utf8')) as AgentProfile
    expect(saved.specBaseline).toEqual(baseline)
    // 顺带确认这次保存真的走了真实落盘路径（system profile 会多写一次：内建刷新路径也落盘，
    // 故只断言"确实前进过"，不钉死步长）
    expect(saved.version).toBeGreaterThan(before ?? 0)
  })


  it('(a2) reasoningEffort 透传写入', () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-a2', p.id)

    const result = h.service.applySubagentModelForSession('sess-a2', 'worker', { provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
    expect(result.applied).toEqual({ provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
    const saved = JSON.parse(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    expect(saved.subagentModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
  })

  it("(b) route=undefined 清除键本身（磁盘 JSON 无该键，而非 undefined 占位）", () => {
    const p = profile({ subagentModel: { provider: 'pi-ai', model: 'glm-5.3' } })
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-b', p.id)

    const result = h.service.applySubagentModelForSession('sess-b', 'worker', undefined)
    expect(result.applied).toBeUndefined()

    const raw = readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')
    const saved = JSON.parse(raw) as AgentProfile
    expect(saved.subagentModel).toBeUndefined()
    // 键必须**不存在**（undefined 占位 ≠ 删除；磁盘上不能留 null/空占位）
    expect('subagentModel' in saved).toBe(false)
    expect(raw).not.toContain('subagentModel')
    // researchModel 不被误伤
    expect(saved.memoryPolicy).toEqual({ scope: 'agent' })
  })

  it("(c) role='research' 写 researchModel，不碰 subagentModel", () => {
    const p = profile({ subagentModel: { provider: 'local', model: 'keep-worker' } })
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-c', p.id)

    const result = h.service.applySubagentModelForSession('sess-c', 'research', { provider: 'pi-ai', model: 'glm-5.3' })
    expect(result).toEqual({ presetId: p.id, applied: { provider: 'pi-ai', model: 'glm-5.3' } })

    const saved = JSON.parse(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    expect(saved.researchModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3' })
    expect(saved.subagentModel).toEqual({ provider: 'local', model: 'keep-worker' })
  })

  /**
   * ★ 2026-10-11（三档语义）：「永久跟随主 Agent」必须写**哨兵**，不能只删键。
   *
   * 这一条是**回归测试**——修之前 `permanent-follow` 走的是 `route=undefined`（删键），
   * 在只加全局兜底档的版本里语义变成了「不覆盖」⇒ 运行期落到**全局**那个模型，
   * 用户选的「跟随主 Agent」失效；且预设本来就没配时删键是空操作 ⇒ 下一轮再次命中
   * 同一个坏模型 ⇒ **无限弹同一个面板**。
   *
   * 判据双向：① 哨兵**落盘**（不是删除键）；② `undefined` 仍然是删除键（两态不可混同）。
   * 若不写哨兵（即旧的删键实现），① 会失败 —— 这正是本测试要钉住的行为。
   */
  it("★ (b2) route='follow-main' 写哨兵（不是删键）——三档语义下的「永久跟随主 Agent」", () => {
    const p = profile({ subagentModel: { provider: 'pi-ai', model: 'glm-5.3' } })
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-b2', p.id)

    const result = h.service.applySubagentModelForSession('sess-b2', 'worker', 'follow-main')
    expect(result).toEqual({ presetId: p.id, applied: 'follow-main' })

    const raw = readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')
    const saved = JSON.parse(raw) as AgentProfile
    // ① 哨兵**在盘上**：删键会让它在运行期被全局档接管（本次修的缺陷）。
    expect(saved.subagentModel).toBe('follow-main')
    expect('subagentModel' in saved).toBe(true)
    expect(raw).toContain('follow-main')
    // ② 与「不覆盖」必须可区分：undefined 走的是删除键那条分支（上一条 (b) 已断言）。
    expect(saved.subagentModel).not.toBeUndefined()
  })

  it('★ (c2) research 也能写哨兵（不误伤 worker 项）', () => {
    const p = profile({ subagentModel: { provider: 'local', model: 'keep-worker' } })
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-c2', p.id)

    const result = h.service.applySubagentModelForSession('sess-c2', 'research', 'follow-main')
    expect(result).toEqual({ presetId: p.id, applied: 'follow-main' })

    const saved = JSON.parse(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    expect(saved.researchModel).toBe('follow-main')
    expect(saved.subagentModel).toEqual({ provider: 'local', model: 'keep-worker' })
  })

  it('(d1) 未知会话（不在任何存活表）→ fail-loud 抛错', () => {
    const h = setup()
    h.provide('agents', { get: (): undefined => undefined })
    expect(() => h.service.applySubagentModelForSession('no-such-session', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/no-such-session/)
  })

  it('(d2) agentPreset 投影为空（解析不到预设）→ 抛错且不写盘', () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-d2', p.id)
    // 把投影换掉：agentPreset 恒 undefined（投影缺席/为空形态）。
    // ⚠️ 必须走 `provideGet`（只提供 `ctx.get`）——生产代码走 `ctx.get('sessionProjections')`，
    // 而未 inject 的**属性访问**在真实 cordis 上会抛错；只换属性会让本用例测到 mock 的
    // 旧闭包而不是被测行为。
    h.provideGet('sessionProjections', { stateOf: (): undefined => undefined })

    expect(() => h.service.applySubagentModelForSession('sess-d2', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/sess-d2/)
    // 未写盘：agent.json 未被改写
    const raw = readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')
    expect(raw).not.toContain('glm-5.3')
  })

  it("(d3) 预设目录存在但 agent.json 缺失 → 抛错（不静默造预设）", () => {
    const h = setup()
    registerSession(h, 'sess-d3', 'ghost-preset')

    expect(() => h.service.applySubagentModelForSession('sess-d3', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/ghost-preset/)
  })
})

/**
 * compensateLiveSessionsForProfile — 预设保存补偿（2026-09-19 机制缺口修复）的机器验证。
 *
 * 缺口：设置里改预设的 subagentModel/researchModel 保存后，`persistProfileAndRecompile`
 * 重编译落盘 + 清 corum-agent 自有缓存，但官方 registry（ctx.agents）里存活的 IDE 会话
 * 的 tool-subagent 插件实例不重建，`config.model` 仍是挂载时的静态快照 ⇒ 存量会话
 * 下一轮委派仍用旧模型。补偿 = 给挂载了该预设的存活会话按角色补会话级覆盖。
 *
 * mock 面：官方 registry `ctx.agents.list()` + `sessionProjections.stateOf(…,'agentPreset')`
 * + `corumOrchestration` 的 set/clear 调用记录——断言「保存后存活会话收到正确的 override」。
 */
describe('compensateLiveSessionsForProfile — 预设保存后给存量会话补模型覆盖', () => {
  interface OverrideCall { sessionId: string; role: 'worker' | 'research'; route?: { provider: string; model: string; reasoningEffort?: string }; clear?: boolean }

  /**
   * 组装带补偿三件套 mock 的服务（registry + 投影 + orchestration 记录器）。
   *
   * ⚠️ 2026-09-21（P3-a）迁移：底座一律用 `makeHarness()`（`h.service` 已由 harness
   * 经 `Object.create` + `installState` 装好状态表），本函数只做**能力面挂载**——
   * 原先自己 `Object.create` 服务再整体替换 `ctx` 的写法，在状态搬进 AgentRegistry
   * 之后会静默失真（见 harness.ts 头注）。
   *
   * @param h - 测试台（同一测试独占的 home 与状态表；预设也写进它）。
   * @param liveSessions - 存活会话（官方 registry 口径：sessionId + 挂载的预设）。
   */
  function makeCompensableService(h: Harness, liveSessions: Array<{ sessionId: string; presetId: string; parentSession?: string }>): {
    svc: CorumAgentService
    calls: OverrideCall[]
  } {
    const svc = h.service
    const calls: OverrideCall[] = []
    const agents = liveSessions.map(({ sessionId, presetId, parentSession }) => ({
      // session 形状对齐官方 SessionHeader：parentSession 在 session.header 上。
      session: {
        id: sessionId,
        header: { ...(parentSession !== undefined ? { parentSession } : {}) },
      },
      __presetId: presetId,
    }))
    const agentsFace = { list: (): unknown[] => agents }
    // stateOf 需按 session 反查预设：借 agents 表找 id。
    const projectionsBySession = {
      stateOf: (session: { id: string }, key: string): string | undefined =>
        key === 'agentPreset' ? agents.find(a => a.session.id === String(session.id))?.__presetId : undefined,
    }
    const orchestration = {
      setModelOverride: (sessionId: string, role: 'worker' | 'research', route: { provider: string; model: string; reasoningEffort?: string }): void => {
        calls.push({ sessionId, role, route: { ...route } })
      },
      clearModelOverride: (sessionId: string, role: 'worker' | 'research'): void => {
        calls.push({ sessionId, role, clear: true })
      },
    }
    // ⚠️ 挂载一律经 harness（不再整体替换 `svc.ctx`）：`agents` 在 `static inject` 里
    // ⇒ provide（属性 + get 双向可读）；`sessionProjections` / `corumOrchestration` 是
    // 「ctx.get 取的可选服务」⇒ **provideGet**（挂成属性会让实现的「问不到」这一态
    // 消失，见 harness.ts L140 注释）。logger 由 harness 的 mock ctx 静音，无需另挂。
    h.provide('agents', agentsFace)
    h.provideGet('sessionProjections', projectionsBySession)
    h.provideGet('corumOrchestration', orchestration)
    return { svc, calls }
  }

  it('(c1) 改 subagentModel 保存后，挂载该预设的存活会话收到 worker 角色覆盖', () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    const { svc, calls } = makeCompensableService(h, [{ sessionId: 'live-1', presetId: p.id }])

    svc.saveProfileRemote({
      id: p.id,
      baseMode: 'standard',
      prompt: p.prompt,
      model: p.model,
      subagentModel: { provider: 'pi-ai', model: 'glm-5.3' },
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user',
    })

    // 预设原先两个角色都未配置 ⇒ worker 与 research 的生效值都是 undefined；
    // 保存后 research 生效值回落到新 subagentModel（compile.ts 同口径）⇒ 两键都变、都补。
    expect(calls).toEqual([
      { sessionId: 'live-1', role: 'worker', route: { provider: 'pi-ai', model: 'glm-5.3' } },
      { sessionId: 'live-1', role: 'research', route: { provider: 'pi-ai', model: 'glm-5.3' } },
    ])
  })

  it('(c2) research 角色独立补偿：改 researchModel 收到 research 键，worker 不动', () => {
    const p = profile({ subagentModel: { provider: 'local', model: 'keep-worker' } })
    const h = setup()
    h.writeProfile(p)
    const { svc, calls } = makeCompensableService(h, [{ sessionId: 'live-2', presetId: p.id }])

    svc.saveProfileRemote({
      id: p.id,
      baseMode: 'standard',
      prompt: p.prompt,
      model: p.model,
      subagentModel: { provider: 'local', model: 'keep-worker' },
      researchModel: { provider: 'pi-ai', model: 'glm-5.3' },
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user',
    })

    expect(calls).toEqual([
      { sessionId: 'live-2', role: 'research', route: { provider: 'pi-ai', model: 'glm-5.3' } },
    ])
  })

  it('(c3) 无关保存（模型没变）零补偿——不覆盖会话里已有的临时决定', () => {
    const p = profile({ subagentModel: { provider: 'pi-ai', model: 'glm-5.3' } })
    const h = setup()
    h.writeProfile(p)
    const { svc, calls } = makeCompensableService(h, [{ sessionId: 'live-3', presetId: p.id }])

    svc.saveProfileRemote({
      id: p.id,
      baseMode: 'standard',
      prompt: '只改了提示词',
      model: p.model,
      subagentModel: { provider: 'pi-ai', model: 'glm-5.3' },
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user',
    })

    expect(calls).toEqual([])
  })

  it('(c4) 改回「跟随主 Agent」（键删除）⇒ 补偿清掉该角色的覆盖', () => {
    const p = profile({ subagentModel: { provider: 'pi-ai', model: 'glm-5.3' } })
    const h = setup()
    h.writeProfile(p)
    const { svc, calls } = makeCompensableService(h, [{ sessionId: 'live-4', presetId: p.id }])

    svc.saveProfileRemote({
      id: p.id,
      baseMode: 'standard',
      prompt: p.prompt,
      model: p.model,
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user',
    })

    // 保存后两个角色的生效值都回到「跟随主 Agent」（research 生效值也回落 subagentModel）
    // ⇒ 两键都清。
    expect(calls).toEqual([
      { sessionId: 'live-4', role: 'worker', clear: true },
      { sessionId: 'live-4', role: 'research', clear: true },
    ])
  })

  it('(c5) research 生效值回退口径与编译一致：只改 subagentModel ⇒ research 跟着补', () => {
    // compile.ts：research 生效值 = researchModel ?? subagentModel。预设原先两者都配，
    // 保存时只改 subagentModel ⇒ research 生效值也变了 ⇒ research 键同样要补。
    const p = profile({ subagentModel: { provider: 'old', model: 'm1' }, researchModel: { provider: 'old', model: 'm1' } })
    const h = setup()
    h.writeProfile(p)
    const { svc, calls } = makeCompensableService(h, [{ sessionId: 'live-5', presetId: p.id }])

    svc.saveProfileRemote({
      id: p.id,
      baseMode: 'standard',
      prompt: p.prompt,
      model: p.model,
      subagentModel: { provider: 'new', model: 'm2' },
      researchModel: { provider: 'old', model: 'm1' },
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user',
    })

    expect(calls).toEqual([
      { sessionId: 'live-5', role: 'worker', route: { provider: 'new', model: 'm2' } },
    ])
  })

  it('(c6) 只补根会话（跳过带 parentSession 的子会话）+ 只补挂载该预设的会话', () => {
    const p = profile()
    const other = profile({ id: 'sam-other-agent' })
    const h = setup()
    h.writeProfile(p)
    h.writeProfile(other)
    const { svc, calls } = makeCompensableService(h, [
      { sessionId: 'child-of-someone', presetId: p.id, parentSession: 'parent-x' },
      { sessionId: 'other-preset', presetId: other.id },
      { sessionId: 'right-one', presetId: p.id },
    ])

    svc.saveProfileRemote({
      id: p.id,
      baseMode: 'standard',
      prompt: p.prompt,
      model: p.model,
      subagentModel: { provider: 'pi-ai', model: 'glm-5.3' },
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user',
    })

    expect(calls).toEqual([
      { sessionId: 'right-one', role: 'worker', route: { provider: 'pi-ai', model: 'glm-5.3' } },
      { sessionId: 'right-one', role: 'research', route: { provider: 'pi-ai', model: 'glm-5.3' } },
    ])
  })

  it('(c7) 幂等：重复保存同值 ⇒ 第二次零补偿（变化检测拦住）', () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    const input = {
      id: p.id,
      baseMode: 'standard' as const,
      prompt: p.prompt,
      model: p.model,
      subagentModel: { provider: 'pi-ai', model: 'glm-5.3' },
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user' as const,
    }
    const { svc, calls } = makeCompensableService(h, [{ sessionId: 'live-7', presetId: p.id }])

    svc.saveProfileRemote(input)
    expect(calls).toHaveLength(2)
    // 第二次保存同值：补偿不再触发（对会话状态零副作用）。
    svc.saveProfileRemote(input)
    expect(calls).toHaveLength(2)
  })

  it('(c8) corumOrchestration 缺席 ⇒ 保存流程不受影响（fail-soft）', () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    const svc = h.service
    // corumOrchestration 缺席（`ctx.get` 取不到）＝ headless/单测形态 ⇒ 无覆盖通路，
    // 保存流程不得因它失败。只需给出 agents 面：`static inject` 的服务用 provide。
    h.provide('agents', { list: (): unknown[] => [] })

    expect(() => svc.saveProfileRemote({
      id: p.id,
      baseMode: 'standard',
      prompt: p.prompt,
      model: p.model,
      subagentModel: { provider: 'pi-ai', model: 'glm-5.3' },
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user',
    })).not.toThrow()
    // 预设本身照常落盘。
    const saved = JSON.parse(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    expect(saved.subagentModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3' })
  })

  it('(c9) reasoningEffort undefined 与空串等价（编译产物同态 ⇒ 不触发补偿）', () => {
    // ⚠️ input 必须带上**同值**的 `researchModel`：实现按角色比生效值
    // （research 生效值 = researchModel ?? subagentModel，agent-service.ts L2645-46）。
    // 原先本 input 漏了它 ⇒ researchBefore（存量回落 subagentModel 的 '' 档）≠
    // researchAfter（undefined）⇒ 误触发 research 补偿。补上后测的才是本用例的语义：
    // worker 侧 'undefined' 与存量 `reasoningEffort: ''` 判定等价（corumRouteEquals）
    // ⇒ 零补偿。（存量预设不配 researchModel，正是为了走 `?? subagentModel` 回落口径。）
    const p = profile({ subagentModel: { provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: '' } })
    const h = setup()
    h.writeProfile(p)
    const { svc, calls } = makeCompensableService(h, [{ sessionId: 'live-9', presetId: p.id }])

    svc.saveProfileRemote({
      id: p.id,
      baseMode: 'standard',
      prompt: p.prompt,
      model: p.model,
      subagentModel: { provider: 'pi-ai', model: 'glm-5.3' },
      researchModel: { provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: '' },
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: p.terminal,
      memoryPolicy: p.memoryPolicy,
      trust: 'user',
    })

    expect(calls).toEqual([])
  })
})
