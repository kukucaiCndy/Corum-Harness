/**
 * 指挥模式**内置调研 Agent 在场保证**（2026-11-16 用户决策）。
 *
 * 用户决策：「机制必须保证 hasResearch，如果没有应该是报错提醒，而不是兜底。
 * researchAgent 作为内置 Agent 必须起效。」
 *
 * 本测试钉住 `ConductorRuntime.apply` 的三件事（research 缺席时）：
 *   a. host 侧 ERROR 日志（sessionId + 可见工具名 + 明确消息）；
 *   b. 用户可见 ERROR 通知（agent.inject，与模型回落同通道）；
 *   c. ERROR 系统提示词段（`CONDUCTOR_RESEARCH_MISSING_SECTION`）。
 *
 * research 在场时三件事都不发生。
 *
 * @module @corum/corum-agent/tests/conductor-research-presence
 */
import { describe, expect, it } from 'vitest'
import { ConductorRuntime } from '../src/conductor-runtime.ts'
import { CONDUCTOR_RESEARCH_MISSING_SECTION, CONDUCTOR_RESEARCH_MISSING_TEXT } from '../src/conductor.ts'

/**
 * 造一个最小 `agentCtx`：只实现 `ConductorRuntime.apply()` 用到的能力面，并记录注册了什么。
 * @param visibleTools - 该 scope 真实可见的工具名（`corumVisibleToolNames` 的数据源）。
 */
function makeAgentCtx(visibleTools: string[]): {
  ctx: never
  sections: { name: string; text: string }[]
  loggerErrors: string[]
  disposeAll: () => void
} {
  const sections: { name: string; text: string }[] = []
  const loggerErrors: string[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    systemPrompt: {
      section: (input: { name: string; text: string }) => {
        sections.push({ name: input.name, text: input.text })
        const dispose = (): void => { /* noop */ }
        disposers.push(dispose)
        return dispose
      },
      getSectionOrder: (): number => 0,
    },
    tools: {
      restrict: () => {
        const dispose = (): void => { /* noop */ }
        disposers.push(dispose)
        return dispose
      },
      guard: () => {
        const dispose = (): void => { /* noop */ }
        disposers.push(dispose)
        return dispose
      },
      schemas: () => visibleTools.map(name => ({ name })),
    },
    logger: {
      error: (msg: string) => { loggerErrors.push(msg) },
      warn: () => { /* noop */ },
      info: () => { /* noop */ },
    },
  }
  return { ctx: ctx as never, sections, loggerErrors, disposeAll: (): void => { for (const d of disposers) d() } }
}

/** 造一个最小 agent inject 面，记录 inject 调用。 */
function makeAgent(): { agent: never; injected: string[] } {
  const injected: string[] = []
  const agent = {
    inject: (message: { content: Array<{ type: string; text?: string }> }) => {
      const text = message.content?.find((c: { type: string }) => c.type === 'text')?.text ?? ''
      injected.push(text)
    },
  }
  return { agent: agent as never, injected }
}

describe('★ 内置调研 Agent 在场保证（2026-11-16 用户决策）', () => {
  describe('research ABSENT from visible names', () => {
    it('注册 ERROR 系统提示词段（CONDUCTOR_RESEARCH_MISSING_SECTION）', () => {
      // subagent_research 不在 visibleTools 里
      const fake = makeAgentCtx(['bash', 'read', 'glob', 'grep', 'subagent', 'orchestrate'])
      const { agent } = makeAgent()
      new ConductorRuntime().apply('s1', fake.ctx, 'preset', agent)

      const errorSection = fake.sections.find(s => s.name === CONDUCTOR_RESEARCH_MISSING_SECTION)
      expect(errorSection, `section "${CONDUCTOR_RESEARCH_MISSING_SECTION}" must be registered`).toBeDefined()
      expect(errorSection!.text).toBe(CONDUCTOR_RESEARCH_MISSING_TEXT)
    })

    it('发出 host 侧 ERROR 日志（含 sessionId + 可见工具名）', () => {
      const fake = makeAgentCtx(['bash', 'read', 'subagent'])
      const { agent } = makeAgent()
      new ConductorRuntime().apply('s-missing', fake.ctx, 'preset', agent)

      expect(fake.loggerErrors).toHaveLength(1)
      const log = fake.loggerErrors[0]!
      expect(log).toContain('subagent_research')
      expect(log).toContain('s-missing')
      expect(log).toContain('mechanism fault')
      // 可见工具名必须在日志里（便于诊断）
      expect(log).toContain('bash')
      expect(log).toContain('subagent')
    })

    it('发出用户可见 ERROR 通知（agent.inject）', () => {
      const fake = makeAgentCtx(['bash', 'read', 'subagent'])
      const { agent, injected } = makeAgent()
      new ConductorRuntime().apply('s1', fake.ctx, 'preset', agent)

      expect(injected).toHaveLength(1)
      // 通知文本含机制故障陈述
      expect(injected[0]).toContain('机制故障')
      expect(injected[0]).toContain('subagent_research')
    })

    it('ERROR 段文本是 ERROR 陈述，不是兜底路由指引（不含 "use orchestrate research:true"）', () => {
      const fake = makeAgentCtx(['bash', 'read', 'subagent'])
      const { agent } = makeAgent()
      new ConductorRuntime().apply('s1', fake.ctx, 'preset', agent)

      const errorSection = fake.sections.find(s => s.name === CONDUCTOR_RESEARCH_MISSING_SECTION)
      expect(errorSection).toBeDefined()
      expect(errorSection!.text).toContain('MECHANISM FAULT')
      expect(errorSection!.text).toContain('Do not silently work around')
      // 不含兜底路由指引
      expect(errorSection!.text).not.toContain('orchestrate')
      expect(errorSection!.text).not.toContain('research: true')
    })

    it('session 仍能正常启动（非中断）——其他段（CONDUCTOR_SECTION 等）仍注册', () => {
      const fake = makeAgentCtx(['bash', 'read', 'subagent'])
      const { agent } = makeAgent()
      new ConductorRuntime().apply('s1', fake.ctx, 'preset', agent)

      // 角色段仍在（叠加错误段，不替代）
      expect(fake.sections.some(s => s.name === 'corum:conductor')).toBe(true)
      // ERROR 段也在
      expect(fake.sections.some(s => s.name === CONDUCTOR_RESEARCH_MISSING_SECTION)).toBe(true)
    })
  })

  describe('research PRESENT in visible names', () => {
    it('不注册 ERROR 段', () => {
      const fake = makeAgentCtx(['bash', 'read', 'glob', 'grep', 'subagent', 'subagent_research', 'orchestrate'])
      const { agent } = makeAgent()
      new ConductorRuntime().apply('s1', fake.ctx, 'preset', agent)

      expect(fake.sections.some(s => s.name === CONDUCTOR_RESEARCH_MISSING_SECTION)).toBe(false)
    })

    it('不发 ERROR 日志', () => {
      const fake = makeAgentCtx(['bash', 'read', 'subagent', 'subagent_research'])
      const { agent } = makeAgent()
      new ConductorRuntime().apply('s1', fake.ctx, 'preset', agent)

      expect(fake.loggerErrors).toHaveLength(0)
    })

    it('不发用户可见通知（agent.inject 未调）', () => {
      const fake = makeAgentCtx(['bash', 'read', 'subagent', 'subagent_research'])
      const { agent, injected } = makeAgent()
      new ConductorRuntime().apply('s1', fake.ctx, 'preset', agent)

      expect(injected).toHaveLength(0)
    })
  })

  describe('agent 参数可选（agent/created 钩子路径）', () => {
    it('不传 agent 时仍注册 ERROR 段 + 发 ERROR 日志（只跳过 inject）', () => {
      const fake = makeAgentCtx(['bash', 'read', 'subagent'])
      // 不传第四参 agent
      new ConductorRuntime().apply('s1', fake.ctx, 'preset')

      expect(fake.loggerErrors).toHaveLength(1)
      expect(fake.sections.some(s => s.name === CONDUCTOR_RESEARCH_MISSING_SECTION)).toBe(true)
    })
  })

  describe('切出指挥模式时 ERROR 段随撤销', () => {
    it('apply(..., "off") 把 ERROR 段的撤销器一起执行', () => {
      const fake = makeAgentCtx(['bash', 'read', 'subagent'])
      const runtime = new ConductorRuntime()
      const { agent } = makeAgent()
      runtime.apply('s1', fake.ctx, 'preset', agent)
      expect(fake.sections.some(s => s.name === CONDUCTOR_RESEARCH_MISSING_SECTION)).toBe(true)

      // 切出指挥模式
      runtime.apply('s1', fake.ctx, 'off')
      expect(runtime.isConductor('s1')).toBe(false)
    })
  })
})
