import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { z } from 'zod'
import { makeHarness, makeProfile, type Harness } from './harness.ts'
import { resolveTaskSession } from '../src/task-lane.ts'
import { AgentRegistry } from '../src/agent-registry.ts'

// 官方只导出整个 Controller；执行其发布包中的原版纯投影，避免在测试复制 fold 规则。
const published = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller'), 'utf8')
const projectionSource = published.slice(published.indexOf('const modelSelectionSchema ='), published.indexOf('function installModelSelectionProjection('))
const officialProjection = new Function('z$1', `${projectionSource}; return modelSelectionProjection`)(z)
// agent-loop 是已有 Desktop 运行时的传递依赖；直接使用它导出的官方 blank 判据。
const { turnBoundaryProjectionDefinition } = await import(new URL('../../../../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', import.meta.url).href)
const globalModel = { provider: 'local', model: 'global-a', reasoningEffort: 'medium' }
const profileModel = { provider: 'local', model: 'profile-b', reasoningEffort: 'high' }
const explicitModel = { provider: 'other', model: 'explicit-c', reasoningEffort: 'max' }
let h: Harness
afterEach(() => h?.cleanup())

function fixture() {
  h = makeHarness()
  h.writeProfile(makeProfile({ id: 'routing-profile', model: profileModel }))
  h.provideGet('settings', { get: () => ({ user: { default: 'routing-profile' } }) })
  h.provide('agentDefaultModel', { currentSelection: () => ({ ...globalModel }) })
  h.provide('gitCore', { assertGitWorkspace: async () => {} })
  h.provide('agentPresets', { mount: async () => {}, select: async () => {} })
  const ctx = new Context()
  const projections = new SessionProjectionRegistry(ctx)
  projections.register(officialProjection)
  projections.register(turnBoundaryProjectionDefinition)
  h.provide('sessionProjections', projections)
  const live: Agent[] = []
  const options: unknown[] = []
  async function construct(args: any, restored?: Session) {
    const session = restored ?? Session.create(args.sessionId)
    const agentCtx = new Context()
    agentCtx.provide('sessionProjections', projections)
    const agent = { session, ctx: agentCtx } as Agent
    options.push(args.agentOptions)
    await args.setup(agentCtx, agent)
    // 官方 Controller 首次 prompt 后才安装内层绑定；保留旧 ref 验证不会盖回会话选择。
    installModelSelection(agentCtx, { current: { provider: 'stale', model: 'old' }, assembled: undefined })
    live.push(agent)
    return { agent }
  }
  h.provide('agents', { create: construct, get: () => undefined })
  h.provide('sessions', { list: () => live.map(a => a.session), get: (id: string) => live.find(a => String(a.session.id) === id)?.session })
  return { projections, options, construct }
}

async function request(agent: Agent) {
  const assembled = await agent.ctx.waterfall('system-prompt/assemble', {} as never, {} as never,
    async () => ({ sections: [], variables: {} }) as never)
  const config = await agent.ctx.waterfall('agent/request', {} as never,
    async () => ({ provider: 'stale', model: 'old', reasoningEffort: 'low' }))
  agent.session.append('request/header', { header: { config }, reason: 'initial', startsSeries: true } as never)
  return { config, assembled }
}

describe('task 模型来源与真实绑定', () => {
  it.each([
    ['default', undefined, undefined, globalModel],
    ['profile', 'routing-profile', undefined, profileModel],
    ['explicit', undefined, explicitModel, explicitModel],
    ['explicit over profile', 'routing-profile', explicitModel, explicitModel],
  ])('%s: fresh/reuse 投影与连续请求保持完整路由', async (_name, profileId, model, expected) => {
    const { projections, options } = fixture()
    const result = await h.service.createAgentForTask(h.home, profileId, undefined, model)
    expect(options[0]).toEqual(expected)
    expect(projections.snapshot(result.agent.session).values.modelSelection?.next).toEqual(expected)
    expect(projections.stateOf(result.agent.session, 'turnBoundary')).toMatchObject({ openTurnStartSeq: null, lastTurn: 0 })
    const reused = await h.service.createAgentForTask(h.home, profileId, undefined, model)
    expect(reused.sessionId).toBe(result.sessionId)
    expect(projections.stateOf(reused.agent.session, 'turnBoundary')).toMatchObject({ openTurnStartSeq: null, lastTurn: 0 })
    const firstRequest = await request(reused.agent)
    expect(firstRequest.config).toEqual(expected)
    expect(firstRequest.assembled.variables).toMatchObject({ provider: expected.provider, model: expected.model })
    expect((await request(reused.agent)).config).toEqual(expected)
    expect((h.ctx.agentDefaultModel as any).currentSelection()).toEqual(globalModel)
  })

  /**
   * 复用**同一 profile** 的 blank 泳道时，新建调用带来的模型必须覆盖旧 pending / 旧绑定。
   *
   * ⚠️ 两次调用必须用**同一个 profileId**（2026-11-23 订正）：`findBlankTaskLane` 现在按
   * profileId 分区（chat 与 task、以及不同 Agent 角色的 blank 泳道互不复用）。此前本用例
   * 第二次调用省略 profileId（解析成机制兜底 `general-assistant`），与第一次的
   * `routing-profile` 不同角色 ⇒ 本就**不该**复用，`expect(reused.sessionId).toBe(...)`
   * 恒红。原意是测「覆盖」，故改成同角色两次调用；跨角色不复用由下一条用例单独钉住。
   */
  it('blank reuse 覆盖旧 pending 和旧绑定；随后用户显式选择在所有轮次生效', async () => {
    const { projections } = fixture()
    const first = await h.service.createAgentForTask(h.home, 'routing-profile', undefined, explicitModel)
    first.agent.session.append('model/selection', explicitModel as never)
    // 同一 profileId ⇒ 命中复用；本次未显式给 model ⇒ 取 profile 绑定的 profileModel，
    // 该值必须盖掉上面那条旧 pending 的 explicitModel。
    const reused = await h.service.createAgentForTask(h.home, 'routing-profile')
    expect(reused.sessionId).toBe(first.sessionId)
    expect(projections.snapshot(reused.agent.session).values.modelSelection?.next).toEqual(profileModel)
    expect((await request(reused.agent)).config).toEqual(profileModel)
    reused.agent.session.append('model/selection', explicitModel as never)
    expect((await request(reused.agent)).config).toEqual(explicitModel)
    expect((await request(reused.agent)).config).toEqual(explicitModel)
  })

  /**
   * 不同 Agent 角色的 blank 泳道**互不复用**（2026-11 定的隔离语义，2026-11-23 用户拍板
   * 保留该语义并按它订正上一条用例）。
   *
   * 动机是 chat 会话与 task 会话不串台；实现上按 profileId 分区，因此「同为 task、但换了
   * Agent 角色」也不会复用对方——换角色时新建独立泳道，而不是接管旧角色的空壳。
   */
  it('不同 Agent 角色的 blank 泳道互不复用；换角色不接管旧角色的空壳', async () => {
    fixture()
    const asRouting = await h.service.createAgentForTask(h.home, 'routing-profile')
    expect(asRouting.sessionId).toMatch(/^corum-task-/)
    // 省略 profileId ⇒ 解析成机制兜底角色（general-assistant），与 routing-profile 不同角色。
    const asDefault = await h.service.createAgentForTask(h.home)
    expect(asDefault.sessionId).not.toBe(asRouting.sessionId)
    expect(asDefault.sessionId).toMatch(/^corum-task-/)
    // 反向控制：同角色再来一次仍然复用（隔离的是角色，不是「一律不复用」）。
    const againAsDefault = await h.service.createAgentForTask(h.home)
    expect(againAsDefault.sessionId).toBe(asDefault.sessionId)
  })

  it('明确切换 Agent 同步本会话投影，且不改全局', async () => {
    const { projections } = fixture()
    const first = await h.service.createAgentForTask(h.home)
    await h.service.selectTaskAgentProfileRemote(String(first.sessionId), 'routing-profile')
    expect(projections.snapshot(first.agent.session).values.modelSelection?.next).toEqual(profileModel)
    expect((await request(first.agent)).config).toEqual(profileModel)
    expect((h.ctx.agentDefaultModel as any).currentSelection()).toEqual(globalModel)
  })

  it.each(['pending', 'lastUsed', 'seeded'])('cold resume 从持久化 %s 恢复完整路由和 options', async phase => {
    const { projections, construct, options } = fixture()
    const created = await h.service.createAgentForTask(h.home, 'routing-profile')
    created.agent.session.append('model/selection', explicitModel as never)
    if (phase === 'lastUsed') await request(created.agent)
    const prefix = created.agent.session.snapshotEvents()
    const inheritedEventCount = phase === 'seeded' ? prefix.length : 0
    const storedSession = phase === 'seeded'
      ? Session.create(created.sessionId, prefix, { ...created.agent.session.header, isSeeded: true }, inheritedEventCount as never)
      : created.agent.session
    if (phase === 'seeded') storedSession.append('model/selection', explicitModel as never)
    const history = storedSession.snapshotEvents()
    const restored = Session.fromRestore(created.sessionId, structuredClone(history), storedSession.header, inheritedEventCount as never, 'detached')
    h.provide('sessions', { get: () => undefined, list: () => [] })
    const observeSession = vi.fn(async () => ({ header: { ...restored.header, cwd: h.home }, events: history,
      inheritedEventCount, [Symbol.dispose]: () => {} }))
    h.provide('sessionQuery', { observeSession })
    const inspect = vi.fn((sessionId: SessionId) => SessionController.prototype.inspect.call({ ctx: h.ctx } as never, sessionId))
    h.provideGet('sessionController', { inspect })
    h.provide('agents', { get: () => undefined, resume: async (args: any) => construct(args, restored) })
    const result = await resolveTaskSession({ ctx: h.ctx as never, registry: new AgentRegistry(), applyConductor: () => {}, applyMemory: () => {} }, String(created.sessionId))
    expect(inspect).toHaveBeenCalledWith(created.sessionId)
    expect(observeSession).toHaveBeenCalledWith(created.sessionId, { projectionMode: 'none' })
    expect(options.at(-1)).toEqual(explicitModel)
    expect((await request(result!.agent)).config).toEqual(explicitModel)
    expect((await request(result!.agent)).config).toEqual(explicitModel)
    expect(projections.snapshot(restored).values.modelSelection?.next).toEqual(explicitModel)
  })
})
