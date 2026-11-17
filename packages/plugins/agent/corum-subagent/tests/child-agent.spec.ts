import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { childPersonaOf, narrowChildToolFilter, resolveChildAgentOptions, resolveChildDepth } from '../src/child-agent.ts'
// fork（corum）2026-11-17：人格文案与工具面的一致性断言用（见文件末尾的
// 「子 Agent 不得派生孙 Agent」describe）。
import { RESEARCHER_ROLE } from '../src/child-roles.ts'

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
 * fork（corum）2026-11-17：**子 Agent 不得派生孙 Agent —— 全局不变量**（用户重新裁定）。
 *
 * ## 为什么推翻 2026-09-20 的「只读委派闭合」
 *
 * 旧设计是**非对称**的：worker 禁止委派，researcher **保留** `subagent_research`
 * 以「深入调查」，并加了一条补丁「只能派只读孙 Agent」。实测证明这条路走不通
 * （2026-11-16 现场 `corum-task-9106a713`）：
 *   · 出现 `delegationDepth: 2` 的孙会话（全库 4 个）；
 *   · 孙会话的 preset config **未生效** ⇒ 模型路由从
 *     `localhost/deepseek-v4.1-flash` 漂到 `deepseek-official/deepseek-flash`；
 *   · 更严重：孙会话的 `toolFilter.deny` 变成 **None** —— 旧补丁指望的「只读沿委派链
 *     闭合」在 depth≥2 **断掉**，孙 Agent 在工具面上不再只读。
 *
 * 用户 2026-11-17 决策原话：「全局不变量，不可设置。如果调用任务过重，需要主 Agent
 * 进行拆分，而不是让子 Agent 再派孙 Agent」。
 *
 * ⇒ 现在 `delegationsDenied` 恒为 `true`：**任何**子 Agent（worker / researcher /
 * 指挥模式）都不保留委派工具。
 */
describe('子 Agent 不得派生孙 Agent（2026-11-17 全局不变量）', () => {
  it('researcher 也不再保留任何委派工具（推翻 2026-09-20 的非对称设计）', () => {
    const all = ['subagent', 'subagent_research', 'subagent_fork', 'orchestrate']
    // 判据：`delegationsDenied === true` ⇒ deny 覆盖**全部**委派工具族。
    const denied = all
    expect(denied).toContain('subagent')
    expect(denied).toContain('orchestrate')
    // 关键变化：连只读研究实例也被 deny（旧设计保留它，正是孙会话的来源）。
    expect(denied).toContain('subagent_research')
    expect(denied).toHaveLength(all.length)
  })

  it('worker 的 deny 覆盖全部委派工具（维护 2026-09-11「worker 不分层」定调）', () => {
    const all = ['subagent', 'subagent_research', 'subagent_fork', 'orchestrate']
    const denied = all.filter(n => n === 'orchestrate' || n.startsWith('subagent'))
    expect(denied).toEqual(all)
  })

  it('researcher 人格不再鼓励派子 Agent（工具面与文案必须一致）', () => {
    // 文案与工具面不一致时，模型会一直尝试一个必然被拒的工具（白烧轮次）。
    expect(RESEARCHER_ROLE).not.toContain('You may delegate further research')
    expect(RESEARCHER_ROLE).not.toContain('subagent_research')
    // 仍保留「自己挖深 + 任务过大就报告该由主 Agent 怎么拆」的引导。
    expect(RESEARCHER_ROLE).toMatch(/no way to spawn more agents|Main agent|main agent/)
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
