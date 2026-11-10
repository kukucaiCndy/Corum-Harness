import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { childPersonaOf, narrowChildToolFilter, resolveChildAgentOptions, resolveChildDepth } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('narrowChildToolFilter（2026-09-12 事故回归）', () => {
  /** 用可见工具名集合造一个最小 ctx 桩：只用到 ctx.tools.schemas(scopeOf(ctx))。 */
  const ctxStub = (names: readonly string[]): never => ({
    tools: { schemas: () => names.map(name => ({ name })) },
  }) as never

  it('丢弃未装载的名字（str_replace_editor 退场后不得再炸整次派遣）', () => {
    const out = narrowChildToolFilter(
      ctxStub(['read', 'write', 'edit', 'bash']),
      { deny: ['str_replace_editor', 'write', 'edit', 'bash'] },
    )
    expect(out).toEqual({ deny: ['write', 'edit', 'bash'] })
  })

  it('MCP 服务名展开成该服务实际可见的工具名（只读实例必须 deny 掉 pencil 的写能力）', () => {
    const out = narrowChildToolFilter(
      ctxStub(['read', 'mcp__pencil-mcp__execute', 'mcp__pencil-mcp__get_app_state']),
      { deny: ['pencil-mcp'] },
    )
    expect(out).toEqual({ deny: ['mcp__pencil-mcp__execute', 'mcp__pencil-mcp__get_app_state'] })
  })

  it('不可见的 MCP 服务名被丢弃（该 profile 没授权它）', () => {
    expect(narrowChildToolFilter(ctxStub(['read']), { deny: ['pencil-mcp'] })).toBeUndefined()
  })

  it('allow 同样按可见面收敛，全空时返回 undefined（不空 restrict）', () => {
    expect(narrowChildToolFilter(ctxStub(['read']), { allow: ['read', 'nope'] })).toEqual({ allow: ['read'] })
    expect(narrowChildToolFilter(ctxStub(['read']), { allow: ['nope'] })).toBeUndefined()
  })
})

/**
 * fork（corum）2026-09-20：**子 Agent 角色人格选取**（用户定调：所有子 Agent 都不继承
 * 主 Agent 人格；worker = 忠实执行者，researcher = 全面调查员）。
 *
 * 这是本轮修复的核心：旧实现以「父是不是指挥模式」为门，而该判定读**纯内存表**
 * `conductorModes`（宿主重启后为空）⇒ 影子段整段失效，子 Agent 带着继承来的父人格干活
 * （实测 8/8 worker 零执行者契约，其中 2 个还带着"编排者"人格 + "你没有写工具"的自述，
 * 与它手上的 write/edit/bash 直接矛盾）。新实现按**种类**无条件选取，不依赖任何运行时可失状态。
 */
describe('childPersonaOf — 子 Agent 角色人格选取', () => {
  const parent = parentAgent()
  // childPersonaOf 目前不使用 childCtx/parent（保留形参以备按 ctx 裁剪），传 undefined 即可。
  const ctx = undefined as never

  it('worker ⇒ 执行者契约（不继承父人格）', () => {
    const text = childPersonaOf(ctx, parent, 'worker', undefined)
    expect(text).toContain('executor, not a planner')
    expect(text).toContain('Do NOT build')
  })

  it('researcher ⇒ 调查员契约（与 worker 相反的那一份）', () => {
    const text = childPersonaOf(ctx, parent, 'researcher', undefined)
    expect(text).toContain('thorough investigator')
    expect(text).not.toContain('Do NOT build')
  })

  it('两类子 Agent 拿到的契约互不相同（防被写成同一段）', () => {
    const worker = childPersonaOf(ctx, parent, 'worker', undefined)
    const researcher = childPersonaOf(ctx, parent, 'researcher', undefined)
    expect(worker).not.toBe(researcher)
  })

  it('kind 未声明（undefined）⇒ undefined（不替换人格，维持既有继承行为）', () => {
    // fork（corum）2026-09-29：conductor 兜底已上移到 applyChildComposition，
    // 本函数只看传入的 kind；undefined ⇒ 不替换。conductor 兜底的一致性由
    // applyChildComposition 的 resolvedKind 保证（人格与 deny 共用同一个值）。
    expect(childPersonaOf(ctx, parent, undefined, undefined)).toBeUndefined()
  })

  it('工作风格固定为「高效务实」，不再继承父的设置（用户 2026-09-20 定调）', () => {
    // 旧行为是继承父 profile 的 personaPreset，实测把 `steady-coach`（「经验丰富的团队导师……
    // 来自下属的不成熟方案先肯定再指出问题」）传给了一个没有下属、被禁止重新设计的执行者，
    // 风格与角色相冲。用户定调：子 Agent 一律「高效务实」，父选什么风格都不再影响它。
    const text = childPersonaOf(ctx, parent, 'worker', undefined)
    expect(text).toContain('be efficient and pragmatic')
    // 固定风格对两类子 Agent 都生效。
    expect(childPersonaOf(ctx, parent, 'researcher', undefined)).toContain('be efficient and pragmatic')
    // 风格段必须在角色契约**之后**（顺序固定：角色 → 风格 → 注入）。
    expect(text!.indexOf('executor, not a planner')).toBeLessThan(text!.indexOf('be efficient and pragmatic'))
  })

  it('personaHint 追加在最后（叠加层不可覆盖机制层）', () => {
    const text = childPersonaOf(ctx, parent, 'worker', 'HINT-SENTINEL')
    expect(text).toContain('HINT-SENTINEL')
    expect(text!.indexOf('executor, not a planner')).toBeLessThan(text!.indexOf('HINT-SENTINEL'))
  })

  it('空白 personaHint 不注入（不产生空段）', () => {
    const text = childPersonaOf(ctx, parent, 'worker', '   ')
    expect(text).toBe(childPersonaOf(ctx, parent, 'worker', undefined))
  })
})

/**
 * fork（corum）2026-09-20：**只读沿委派链闭合**（实机漏洞回归门禁）。
 *
 * 实机验证（会话 `f1dab4d6` → `a192efcf`，depth 1 → 2）发现：只读调查员用了**写能力**的
 * `subagent` 工具派孙 Agent，孙 Agent 拿到 **worker 契约**（自认能写）而沙箱是 `read-only`
 * ⇒ 人格与工具面再次矛盾，第一步就撞拒绝。
 *
 * 修法：researcher 只保留 `subagent_research*`，写能力的委派工具（`subagent` / `orchestrate`）
 * 一律 deny。以下断言钉住这条闭合性——**它必须由工具面保证，不能靠模型自觉**。
 */
describe('只读委派闭合（2026-09-20 实机漏洞）', () => {
  it('researcher 的 deny 覆盖写能力委派工具，但保留只读研究实例', () => {
    // 复刻 writeCapableDelegationToolNames 的判据（该函数内部依赖 ctx，此处断言其口径）。
    const all = ['subagent', 'subagent_research', 'subagent_fork', 'orchestrate']
    const denied = all.filter(n => !n.startsWith('subagent_research'))
    expect(denied).toContain('subagent')
    expect(denied).toContain('orchestrate')
    expect(denied).not.toContain('subagent_research')
  })

  it('worker 的 deny 覆盖全部委派工具（维护 2026-09-11「worker 不分层」定调）', () => {
    const all = ['subagent', 'subagent_research', 'subagent_fork', 'orchestrate']
    const denied = all.filter(n => n === 'orchestrate' || n.startsWith('subagent'))
    expect(denied).toEqual(all)
  })
})

describe('delegation depth limits', () => {
  it.each([-1, -0, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid runtime depth %s', (depth) => {
    const parent = parentAgent()
    parent.options.subagentDepth = depth
    expect(() => resolveChildDepth(parent, undefined)).toThrow('agent subagentDepth must be a non-negative safe integer')
  })

  it('rejects a child depth beyond the exact integer range', () => {
    const parent = parentAgent()
    parent.options.subagentDepth = Number.MAX_SAFE_INTEGER
    expect(() => resolveChildDepth(parent, undefined)).toThrow('subagent child depth exceeds the safe-integer range')
  })
})
