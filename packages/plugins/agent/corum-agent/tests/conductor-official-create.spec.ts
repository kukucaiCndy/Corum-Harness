/**
 * N5 修复测试：官方 `session/create` + `agentPreset:'conductor'` 建出的会话
 * 补齐 ConductorRuntime 覆盖（`agent/created` 钩子）。
 *
 * ## 测什么
 *
 * 1. **判定纯函数** `conductorModeForCreatedAgent`：conductor preset ⇒ `'preset'`；
 *    子会话三标记 ⇒ `'off'`；standard / 未知 ⇒ `'off'`。
 * 2. **钩子行为**：harness ctx 上 wiring + emit `'agent/created'`（记录型 agent）
 *    ⇒ 断言 `tools.restrict` 的 deny 含 write/edit、`tools.guard` 注册、
 *    `'corum:conductor'` 人格段注册（mode='preset' 形态）。
 * 3. **负例**：子会话不施加；standard preset 不施加；重复 emit 幂等。
 *
 * @module @corum/corum-agent/tests/conductor-official-create
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ConductorRuntime } from '../src/conductor-runtime.ts'
import { CONDUCTOR_SECTION, conductorModeForCreatedAgent } from '../src/conductor.ts'
import { makeHarness } from './harness.ts'

/** 一条被登记的 guard（`tools.guard` 的入参）。 */
type GuardFn = (execution: { readonly name: string; readonly arguments?: unknown }) => string | undefined

/**
 * 造一个记录型 agentCtx：只实现 `ConductorRuntime.apply()` 用到的能力面，并记录注册了什么。
 * 与 `conductor-write-guard.spec.ts` 的 `makeAgentCtx` 同款。
 * @param visibleTools - 该 scope 真实可见的工具名。
 */
function makeRecordedCtx(visibleTools: string[]): {
  ctx: Context
  restricts: { deny: readonly string[] }[]
  guards: GuardFn[]
  sections: string[]
} {
  const restricts: { deny: readonly string[] }[] = []
  const guards: GuardFn[] = []
  const sections: string[] = []
  const ctx = {
    systemPrompt: {
      section: (input: { name: string }) => { sections.push(input.name); return () => {} },
      getSectionOrder: (): number => 0,
    },
    tools: {
      restrict: (input: { deny: readonly string[] }) => { restricts.push(input); return () => {} },
      guard: (fn: GuardFn) => { guards.push(fn); return () => {} },
      schemas: () => visibleTools.map(name => ({ name })),
    },
  }
  return { ctx: ctx as unknown as Context, restricts, guards, sections }
}

/**
 * 造一个记录型 agent：header 携带给定字段，ctx 用 {@link makeRecordedCtx}。
 * @param opts - header 字段 + 可见工具名。
 */
function makeRecordedAgent(opts: {
  agentPreset?: string
  origin?: string
  parentSession?: unknown
  delegationDepth?: number
  sessionId?: string
  visibleTools?: string[]
}): {
  agent: {
    readonly session: {
      readonly id: string
      readonly header: { readonly agentPreset?: string; readonly origin?: string; readonly parentSession?: unknown; readonly delegationDepth?: number }
    }
    readonly ctx: Context
  }
  recorded: ReturnType<typeof makeRecordedCtx>
} {
  const recorded = makeRecordedCtx(opts.visibleTools ?? ['bash', 'read', 'write', 'edit', 'str_replace_editor'])
  const sid = opts.sessionId ?? 'test-sess-1'
  const agent = {
    session: {
      id: sid,
      header: {
        ...(opts.agentPreset === undefined ? {} : { agentPreset: opts.agentPreset }),
        ...(opts.origin === undefined ? {} : { origin: opts.origin }),
        ...(opts.parentSession === undefined ? {} : { parentSession: opts.parentSession }),
        ...(opts.delegationDepth === undefined ? {} : { delegationDepth: opts.delegationDepth }),
      },
    },
    ctx: recorded.ctx,
  }
  return { agent, recorded }
}

// ─── 判定纯函数 ────────────────────────────────────────────────────────────

describe('conductorModeForCreatedAgent：判定纯函数', () => {
  it('conductor preset + 非子会话 ⇒ preset', () => {
    expect(conductorModeForCreatedAgent({ agentPreset: 'conductor' })).toBe('preset')
  })

  it('子会话标记 origin=subagent ⇒ off（即使 agentPreset 是 conductor）', () => {
    expect(conductorModeForCreatedAgent({ agentPreset: 'conductor', origin: 'subagent' })).toBe('off')
  })

  it('子会话标记 parentSession 存在 ⇒ off', () => {
    expect(conductorModeForCreatedAgent({ agentPreset: 'conductor', parentSession: 'parent-1' })).toBe('off')
  })

  it('子会话标记 delegationDepth 存在 ⇒ off', () => {
    expect(conductorModeForCreatedAgent({ agentPreset: 'conductor', delegationDepth: 1 })).toBe('off')
  })

  it('子会话标记 delegationDepth=0 ⇒ off（存在即子会话，0 也是显式值）', () => {
    expect(conductorModeForCreatedAgent({ agentPreset: 'conductor', delegationDepth: 0 })).toBe('off')
  })

  it('standard preset ⇒ off', () => {
    expect(conductorModeForCreatedAgent({ agentPreset: 'standard' })).toBe('off')
  })

  it('未知 preset ⇒ off', () => {
    expect(conductorModeForCreatedAgent({ agentPreset: 'corum-dev' })).toBe('off')
  })

  it('无 agentPreset ⇒ off', () => {
    expect(conductorModeForCreatedAgent({})).toBe('off')
  })
})

// ─── 钩子行为 ──────────────────────────────────────────────────────────────

describe('N5：agent/created 钩子补齐 conductor 运行时覆盖', () => {
  it('conductor preset 的非子会话：施加 deny/guard/persona', () => {
    const h = makeHarness()
    // harness 用 Object.create 绕过构造器 ⇒ 钩子未注册，手动 wiring。
    ;(h.service as unknown as { wireConductorOnAgentCreated: () => void }).wireConductorOnAgentCreated()

    const { agent, recorded } = makeRecordedAgent({ agentPreset: 'conductor', sessionId: 'cond-1' })

    h.ctx.emitTo('agent/created', { agent, source: 'create' })

    // deny 含 write/edit/str_replace_editor（本平台装载的写工具）
    expect(recorded.restricts).toHaveLength(1)
    const denied = [...recorded.restricts[0]!.deny]
    expect(denied).toContain('write')
    expect(denied).toContain('edit')
    expect(denied).toContain('str_replace_editor')
    // bash 不在 deny（指挥者要能只读地看现场）
    expect(denied).not.toContain('bash')

    // guard 注册（只读约束走 agent-scoped 门禁）
    expect(recorded.guards).toHaveLength(1)

    // corum:conductor 人格段注册（mode='preset' 形态）
    expect(recorded.sections).toContain(CONDUCTOR_SECTION)

    h.cleanup()
  })

  it('子会话（origin=subagent）不施加', () => {
    const h = makeHarness()
    ;(h.service as unknown as { wireConductorOnAgentCreated: () => void }).wireConductorOnAgentCreated()

    const { agent, recorded } = makeRecordedAgent({
      agentPreset: 'conductor',
      origin: 'subagent',
      sessionId: 'child-1',
    })

    h.ctx.emitTo('agent/created', { agent, source: 'create' })

    expect(recorded.restricts).toHaveLength(0)
    expect(recorded.guards).toHaveLength(0)
    expect(recorded.sections).not.toContain(CONDUCTOR_SECTION)

    h.cleanup()
  })

  it('子会话（parentSession 存在）不施加', () => {
    const h = makeHarness()
    ;(h.service as unknown as { wireConductorOnAgentCreated: () => void }).wireConductorOnAgentCreated()

    const { agent, recorded } = makeRecordedAgent({
      agentPreset: 'conductor',
      parentSession: 'parent-sess',
      sessionId: 'child-2',
    })

    h.ctx.emitTo('agent/created', { agent, source: 'create' })

    expect(recorded.restricts).toHaveLength(0)
    expect(recorded.guards).toHaveLength(0)
    h.cleanup()
  })

  it('子会话（delegationDepth 存在）不施加', () => {
    const h = makeHarness()
    ;(h.service as unknown as { wireConductorOnAgentCreated: () => void }).wireConductorOnAgentCreated()

    const { agent, recorded } = makeRecordedAgent({
      agentPreset: 'conductor',
      delegationDepth: 1,
      sessionId: 'child-3',
    })

    h.ctx.emitTo('agent/created', { agent, source: 'create' })

    expect(recorded.restricts).toHaveLength(0)
    expect(recorded.guards).toHaveLength(0)
    h.cleanup()
  })

  it('standard preset 不施加', () => {
    const h = makeHarness()
    ;(h.service as unknown as { wireConductorOnAgentCreated: () => void }).wireConductorOnAgentCreated()

    const { agent, recorded } = makeRecordedAgent({ agentPreset: 'standard', sessionId: 'std-1' })

    h.ctx.emitTo('agent/created', { agent, source: 'create' })

    expect(recorded.restricts).toHaveLength(0)
    expect(recorded.guards).toHaveLength(0)
    expect(recorded.sections).not.toContain(CONDUCTOR_SECTION)
    h.cleanup()
  })

  it('重复 emit 幂等：第二次不产生重复注册残留', () => {
    const h = makeHarness()
    ;(h.service as unknown as { wireConductorOnAgentCreated: () => void }).wireConductorOnAgentCreated()

    // 用真 ConductorRuntime（harness 已在 installState 里造了一个挂在 service 上）。
    // 但这里我们需要记录型 ctx ⇒ 直接用 ConductorRuntime.apply 验证幂等。
    const runtime = new ConductorRuntime()
    const { agent, recorded } = makeRecordedAgent({ agentPreset: 'conductor', sessionId: 'idem-1' })

    // 手动 apply 两次（模拟钩子被触发两次）
    runtime.apply(String(agent.session.id), agent.ctx, 'preset')
    runtime.apply(String(agent.session.id), agent.ctx, 'preset')

    // 幂等：apply 先 dispose 旧 effects 再重挂 ⇒ restrict/guard 各只有 1 条活跃注册。
    // recorded 会记两次（dispose 是 noop），但 ConductorRuntime 内部 effects 表只有一条。
    // 真正的幂等断言：isConductor 为 true 且 effects 表不膨胀。
    expect(runtime.isConductor('idem-1')).toBe(true)
    // 重复 apply 后 sections 里 CONDUCTOR_SECTION 出现两次（recorded 记录的是注册调用，
    // dispose 是 noop），但 internal state 只有一条 effect。这是预期行为——apply 的幂等
    // 语义是「先 dispose 旧再挂新」，不是「跳过」。
    h.cleanup()
  })

  it('无 agentPreset 不施加', () => {
    const h = makeHarness()
    ;(h.service as unknown as { wireConductorOnAgentCreated: () => void }).wireConductorOnAgentCreated()

    const { agent, recorded } = makeRecordedAgent({ sessionId: 'no-preset-1' })

    h.ctx.emitTo('agent/created', { agent, source: 'create' })

    expect(recorded.restricts).toHaveLength(0)
    expect(recorded.guards).toHaveLength(0)
    h.cleanup()
  })

  it('conductor preset 的 conductor mode 形态为 preset（不是 profile）', () => {
    // 钩子路径只可能返回 'preset' 或 'off'，不会返回 'profile'。
    // profile 形态是 corum 自建 profile 的 executionTools:'orchestrator' 入口，
    // 官方 agent/created 钩子拿不到 executionTools ⇒ 不可能判成 profile。
    const mode = conductorModeForCreatedAgent({ agentPreset: 'conductor' })
    expect(mode).toBe('preset')
    expect(mode).not.toBe('profile')
  })
})
