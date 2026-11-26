/**
 * GitHub issue #233 回归网：**模型失败后点「重试」= 继续，而不是重新委派**
 *（2026-11-22 用户报障原话：「点模型不可用里的重试，我的要求是继续，而不是重新委派」）。
 *
 * ## 缺陷本体
 *
 * 首轮模型失败后，旧实现只有一条路：把失败子 Agent 的上下文提取出来塞进 prompt，
 * 再 `startActivation()` **新建**一个子会话。新会话 = 新 sessionId、新的计费起点；
 * 即便 prompt 里写着「你之前做过什么」，子 Agent 的工具上下文、已读文件、已确认的
 * 事实全都不在。一次瞬时模型故障要把整轮重做，钱付两遍。
 *
 * 而此刻子会话**已经存在过**（首轮真的 spawn 并跑过），模型失败只是让它以
 * `stopReason:'error'` 终结并被 dispose —— 正是 `sendMessageAndAwait` → `coldResume`
 * 能重建的情形：按持久化 descriptor 复活**同一个 childId**，事件流接着写。
 *
 * ## 断言什么
 *
 * ① 有 `sendMessageAndAwait` ⇒ 走续跑，且 **childId 原样传回**（同一个会话）；
 * ② 续跑必须带 `agentOptions` 路由覆盖 —— 不传就等于「用同一个坏模型再跑一遍」；
 * ③ 续跑的消息措辞必须要求「接着做」而不是「从头做」；
 * ④ 服务面缺该方法（旧宿主）/ childId 为空 / 投递被拒 ⇒ 返回 undefined，
 *    让调用方退回新建路径（**不静默假装已续跑**）。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { corumResumeAfterModelFailure } from '../src/index.ts'

const ROUTE = { provider: 'p', model: 'm', reasoningEffort: 'high' }
const SIGNAL = AbortSignal.timeout(5_000)

/** 造一个「根上挂着 subagents 假服务」的上下文。 */
function ctxWith(subagents: unknown): Context {
  const ctx = new Context()
  vi.spyOn(ctx.root, 'get').mockImplementation(((name: string) =>
    name === 'subagents' ? subagents : undefined) as never)
  return ctx
}

/** 假父 Agent（只用于授权透传，本函数不读它的字段）。 */
const parent = { id: 'parent-1', session: { id: 'parent-1' } } as unknown as Agent

describe('corumResumeAfterModelFailure — 续跑原会话（issue #233）', () => {
  it('★ 有 sendMessageAndAwait ⇒ 以**同一个 childId** 续跑，不新建会话', async () => {
    const calls: unknown[][] = []
    const ctx = ctxWith({
      sendMessageAndAwait: vi.fn(async (...args: unknown[]) => {
        calls.push(args)
        return { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }
      }),
    })
    const result = await corumResumeAfterModelFailure(ctx, parent, 'child-42', ROUTE, SIGNAL)
    expect(calls).toHaveLength(1)
    // 第 2 个实参就是目标会话 id —— 必须是被续跑的那个，不是新 id。
    expect(calls[0]?.[1]).toBe('child-42')
    expect(result?.stopReason).toBe('completed')
  })

  it('★ 必须带 agentOptions 路由覆盖（否则 coldResume 会用同一个坏模型再跑）', async () => {
    let captured: { agentOptions?: Record<string, unknown> } | undefined
    const ctx = ctxWith({
      sendMessageAndAwait: vi.fn(async (...args: unknown[]) => {
        captured = args[3] as { agentOptions?: Record<string, unknown> }
        return { output: [], stopReason: 'completed' }
      }),
    })
    await corumResumeAfterModelFailure(ctx, parent, 'child-42', ROUTE, SIGNAL)
    expect(captured?.agentOptions).toEqual({
      provider: 'p', model: 'm', reasoningEffort: 'high',
    })
  })

  it('续跑消息要求「接着做、别重来」（措辞与实际生效路由同源）', async () => {
    let text = ''
    const ctx = ctxWith({
      sendMessageAndAwait: vi.fn(async (...args: unknown[]) => {
        const content = args[2] as readonly { type: string; text?: string }[]
        text = content.map(c => c.text ?? '').join('')
        return { output: [], stopReason: 'completed' }
      }),
    })
    await corumResumeAfterModelFailure(ctx, parent, 'child-42', ROUTE, SIGNAL)
    expect(text).toContain('SAME task on the SAME session')
    expect(text).toContain('Do not restart from scratch')
    // 路由取自授权结果，不得写死「主 Agent 的模型」。
    expect(text).toContain('p/m')
    expect(text).not.toContain("main Agent's model")
  })

  it('服务面缺 sendMessageAndAwait（旧宿主）⇒ undefined，由调用方退回新建', async () => {
    const ctx = ctxWith({ send: vi.fn() })
    expect(await corumResumeAfterModelFailure(ctx, parent, 'child-42', ROUTE, SIGNAL)).toBeUndefined()
  })

  it('childId 为空（子会话从未建立）⇒ undefined，不去续一个不存在的会话', async () => {
    const sendMessageAndAwait = vi.fn()
    const ctx = ctxWith({ sendMessageAndAwait })
    expect(await corumResumeAfterModelFailure(ctx, parent, '', ROUTE, SIGNAL)).toBeUndefined()
    expect(sendMessageAndAwait).not.toHaveBeenCalled()
  })

  it('续跑被拒（不可续接 / 已关闭）⇒ undefined，不抛出打断主链路', async () => {
    const ctx = ctxWith({
      sendMessageAndAwait: vi.fn(async () => { throw new Error('subagent has no supported continuation state') }),
    })
    expect(await corumResumeAfterModelFailure(ctx, parent, 'child-42', ROUTE, SIGNAL)).toBeUndefined()
  })
})

describe('★ 控制流契约（本轮自审抓到的致命缺陷）', () => {
  it('调用点必须「填 outcome 再 break」，不能裸 break', async () => {
    /**
     * 裸 `break` 的后果（本轮实测踩到）：`outcome` 停在 undefined ⇒ 循环外那段
     * `if (outcome === undefined) { ... }` 会走进「spawn 期就解析不了」分支，
     * 内层不命中后又落到 `throw new Error('subagent run produced no outcome')`
     * ——**一次成功的续跑反而报「没有结果」**，且续跑拿到的终态被丢弃。
     *
     * 这是控制流缺陷，行为测试很难覆盖（要造真实的前台模型失败），所以直断源码：
     * `corumResumeAfterModelFailure` 的调用点之后必须出现对 `outcome` 的赋值。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const call = src.indexOf('const resumed = await corumResumeAfterModelFailure(')
    expect(call).toBeGreaterThan(-1)
    // 截到「填 outcome 的语句结束」为止，而不是硬编一个字符数：字符数窗口会随
    // 注释长度失效（本轮实测：加了注释后 1_400 截在 `kind:` 之前，假红一次）。
    const fromCall = src.slice(call)
    const window = fromCall.slice(0, fromCall.indexOf('break\n') + 'break\n'.length)
    const assigned = window.indexOf('outcome = {')
    expect(assigned).toBeGreaterThan(-1)
    expect(window).toContain("kind: 'foreground'")
    // 赋值必须发生在**真实代码里**的 break 之前。不能用 indexOf('break')：
    // 那段注释本身含 "break" 字样，会误命中注释（本轮实测过一次假红）。
    const realBreak = window.search(/\n\s+break\n/)
    expect(realBreak).toBeGreaterThan(-1)
    expect(assigned).toBeLessThan(realBreak)
  })

  it('★ 续跑也失败时必须校验 stopReason，不能把空 output 当成功（本轮回归）', async () => {
    /**
     * 缺陷本体：用户点「再试一次 · 不换模型」时，`asked.route` 就是刚失败的那条
     * 路由 ⇒ 同一个模型很可能**再失败一次**。而 `corumResumeAfterModelFailure`
     * 只在**投递**抛错时返回 undefined（=「续不上」）；「投递成功、但又跑失败」
     * 它照常返回一个 `stopReason:'error'` 的结果。
     *
     * 旧代码不看 `stopReason` 就直接填 `outcome` ⇒ 父 Agent 收到一个**成功的空结果**，
     * 用户以为跑完了，实际什么都没跑成。这比原来「重新委派」更坏。
     *
     * 行为测试造不出真实的前台模型失败（要真 spawn 子 Agent），故直断源码：
     * `resumed` 的使用必须**先校验终态**，且校验语句出现在填 `outcome` 之前。
     */
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const call = src.indexOf('const resumed = await corumResumeAfterModelFailure(')
    expect(call).toBeGreaterThan(-1)
    const guard = src.indexOf("resumed.stopReason !== 'completed'")
    expect(guard).toBeGreaterThan(-1)
    // 与上一条测试同源的取窗方式：截到「填 outcome 的语句 + break」为止。
    const fromCall = src.slice(call)
    const window = fromCall.slice(0, fromCall.indexOf('break\n') + 'break\n'.length)
    const assignedInWindow = window.indexOf('outcome = {')
    expect(assignedInWindow).toBeGreaterThan(-1)
    // 校验必须在「填 outcome」之前 —— 否则等于没校验。
    expect(guard).toBeLessThan(call + assignedInWindow)
    // 且失败分支必须**抛出**（挂 stopReason），不是静默吞掉。
    expect(src).toContain("if (resumed.stopReason !== 'completed') throw stopReasonFailure(resumed)")
  })
})
