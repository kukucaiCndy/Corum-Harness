/**
 * `@corum/corum-todo-guard` 的不变量测试。
 *
 * 本机制最贵的三条约束都必须钉死：
 *   ① **幂等**——模型无视提醒时必须放过，否则每轮必催、turn 永远关不掉（死循环）；
 *   ② **作用域**——子 Agent 不参与（与提交卡片同一闸门）；
 *   ③ **fail-soft**——`todos` 投影未注册 / 形状异常时静默不介入，绝不因兜底打断收口。
 *
 * 用真 `cordis.Context` 分发 `agent/turn-stopping`（与生产同一事件通路），
 * 而不是直接调内部函数——监听器注册、事件载荷、serial 分发因此都在被验证范围内。
 *
 * ⚠️ 两条踩过的坑（写这类测试必须知道）：
 *   · `createUserMessage({ content: <string> })` 产出的 `content` 是**字符串**，不是
 *     parts 数组；桩若按数组解析会自己抛错，被机制的 try/catch 吞掉 ⇒ 测试表现为
 *     「没 steer」，实际是桩写错（本文件第一版就栽在这里）。
 *   · `ctx.logger` 是 cordis 内建，`ctx.provide('logger', …)` **覆盖不掉**（实测
 *     `typeof ctx.logger === 'function'`）⇒ 断言警告必须 `vi.spyOn(ctx.logger, 'warn')`。
 *
 * @module tests/todo-guard
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, buildTodoReconcileMessage, readTodos, type TodoItem } from '../src/index.ts'

/** 造一个真 Cordis 上下文，喂入指定的 `todos` 投影值。 */
function stubContext(todos: unknown): Context {
  const ctx = new Context()
  ctx.provide('sessionProjections', {
    stateOf: (_session: unknown, key: string) => (key === 'todos' ? todos : undefined),
  } as never)
  return ctx
}

/** 造一个只够本机制使用的最小 Agent 桩（session.header + steer 记录）。 */
function stubAgent(origin?: 'subagent') {
  const steered: string[] = []
  const sessionId = origin === 'subagent' ? 'child-session-0001' : 'main-session-0001'
  const agent = {
    session: {
      id: sessionId,
      header: origin === undefined ? {} : { origin },
    },
    steer: (message: { content: string | readonly { text?: string }[] }) => {
      const { content } = message
      steered.push(typeof content === 'string'
        ? content
        : content.map(part => part.text ?? '').join(''))
    },
  }
  return { agent: agent as never, steered }
}

/** 触发一次 `agent/turn-stopping`（串行 await 到监听器跑完）。 */
async function dispatch(ctx: Context, agent: unknown, turn: number): Promise<void> {
  await ctx.parallel('agent/turn-stopping' as never, {
    agent,
    turn,
    signal: new AbortController().signal,
  } as never)
}

const STALE: TodoItem[] = [
  { content: '分析项目架构', status: 'completed' },
  { content: '生成 C4 架构文档 HTML', status: 'in_progress' },
  { content: '生成 arc42 架构文档 HTML', status: 'pending' },
]

describe('todo 兜底：触发条件', () => {
  it('★ 清单仍有 in_progress ⇒ steer 一条对账提醒（含完整清单）', async () => {
    const ctx = stubContext(STALE)
    apply(ctx)
    const { agent, steered } = stubAgent()
    await dispatch(ctx, agent, 1)
    expect(steered).toHaveLength(1)
    expect(steered[0]).toContain('[in_progress] 生成 C4 架构文档 HTML')
    expect(steered[0]).toContain('todo_write')
  })

  it('清单已无 in_progress（全部 completed/pending）⇒ 不提醒', async () => {
    const ctx = stubContext([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ] satisfies TodoItem[])
    apply(ctx)
    const { agent, steered } = stubAgent()
    await dispatch(ctx, agent, 1)
    expect(steered).toHaveLength(0)
  })
})

describe('todo 兜底：幂等（防死循环）', () => {
  it('★ 同一 turn 内重复进钩子 ⇒ 只提醒一次（模型无视提醒时不得每轮必催）', async () => {
    const ctx = stubContext(STALE)
    apply(ctx)
    const { agent, steered } = stubAgent()
    await dispatch(ctx, agent, 1)
    await dispatch(ctx, agent, 1)
    await dispatch(ctx, agent, 1)
    expect(steered).toHaveLength(1)
  })

  it('★ 清单对账干净后登记被清除 ⇒ 下一个 turn 重新获得提醒机会', async () => {
    let todos: unknown = STALE
    const ctx = new Context()
    ctx.provide('sessionProjections', {
      stateOf: (_session: unknown, key: string) => (key === 'todos' ? todos : undefined),
    } as never)
    apply(ctx)
    const { agent, steered } = stubAgent()

    await dispatch(ctx, agent, 1)
    expect(steered, '第一个 turn 提醒一次').toHaveLength(1)

    // 模型对账：清单不再有 in_progress ⇒ 本 turn 收口时收敛、清登记。
    todos = [{ content: '分析项目架构', status: 'completed' }] satisfies TodoItem[]
    await dispatch(ctx, agent, 1)

    // 下一个 turn 又出现进行中项 ⇒ 应当再次提醒（证明登记确实被清掉）。
    todos = STALE
    await dispatch(ctx, agent, 2)
    expect(steered, '新 turn 重新获得提醒').toHaveLength(2)
  })
})

describe('todo 兜底：作用域与 fail-soft', () => {
  it('★ 子会话（origin=subagent）⇒ 完全不进机制', async () => {
    const ctx = stubContext(STALE)
    apply(ctx)
    const { agent, steered } = stubAgent('subagent')
    await dispatch(ctx, agent, 1)
    expect(steered).toHaveLength(0)
  })

  it('todos 投影未注册（stateOf 返回 undefined）⇒ 静默不介入，不抛错', async () => {
    const ctx = stubContext(undefined)
    apply(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const { agent, steered } = stubAgent()
    await dispatch(ctx, agent, 1)
    expect(steered).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('投影值形状异常（非数组）⇒ 当作无清单，不抛错', async () => {
    const ctx = stubContext({ oops: true })
    apply(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const { agent, steered } = stubAgent()
    await dispatch(ctx, agent, 1)
    expect(steered).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('steer 抛错 ⇒ 只 warn，不让异常穿透收口钩子', async () => {
    const ctx = stubContext(STALE)
    apply(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const agent = {
      session: { id: 'main-session-0001', header: {} },
      steer: () => { throw new Error('inbox closed') },
    }
    await expect(dispatch(ctx, agent as never, 1)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('inbox closed')
  })
})

describe('todo 兜底：纯函数面', () => {
  it('readTodos：非数组 / 未注册一律 null', () => {
    expect(readTodos({ stateOf: () => undefined }, {})).toBeNull()
    expect(readTodos({ stateOf: () => 42 }, {})).toBeNull()
    expect(readTodos({ stateOf: () => STALE }, {})).toHaveLength(3)
  })

  it('提醒文本是英文包装 + 清单正文原样（仓纪律：模型可见提示词一律英文）', () => {
    const text = buildTodoReconcileMessage(STALE).map(block => block.text).join('')
    // 逐条剥掉清单正文（正文是用户/模型写的，可能含中文，不算包装）。
    let wrapper = text
    for (const item of STALE) wrapper = wrapper.replace(item.content, '')
    expect(wrapper).not.toMatch(/[\u4e00-\u9fff]/)
    expect(text).toContain('This turn is ending')
    for (const item of STALE) expect(text).toContain(item.content)
  })
})
