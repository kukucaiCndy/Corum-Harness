/**
 * 审批「发布后自检」——防**静默挂死**的守门测试。
 *
 * ## 事故（会话 `corum-task-452a5fe8`，:9222 打包实例，2026-11-11 00:05–00:22）
 *
 * | 事件 | 时间 | 间隔 |
 * | --- | --- | --- |
 * | `approval/asked` | 00:05:39 | — |
 * | `approval/decided` outcome=`cancelled` | 00:22:07 | **988 s** |
 *
 * 用户在此期间**从未看到任何卡片**，最后按了停止 ⇒ turn 中止 ⇒ 请求信号 aborted ⇒
 * 沙箱抛 `approval for escalating to "danger-full-access" was cancelled`。也就是说：
 * 机制层面「请求已发出」，用户层面「什么都没发生」，双方各说各话，且**没有任何报错**。
 *
 * 官方通路没有超时（`ApprovalService.decide()` 的 waterfall 一直等应答者），
 * 本插件的应答者登记 pending 后 `await pending.result` —— 于是「pending 发布了但
 * 不在渲染层那份快照里」= **整轮永久挂起**，唯一出路是用户手动中止。
 *
 * ## 这里钉住什么
 *
 * ① 快照里就是它 ⇒ 可见（正常路径不拦截）；
 * ② 快照里是**别的** pending / 没有该会话 ⇒ 不可见（正是要收口的那一格）；
 * ③ 读不到 `uiSession.sessionStatus` 或读时抛错 ⇒ 放行（诊断代码不许把审批弄坏）；
 * ④ 源码不变式：**两条通路**（官方 `approval/request`、corum 自有 `corum/escalation/ask`）
 *    都在登记后立刻自检、不可见就 `next()` 交回下游 —— 防回退成静默挂住。
 * @module @corum/corum-ui-approval/tests/approval-publish-visibility
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pendingVisibleInStatus } from '../src/client/index.ts'
import { PendingApproval } from '../src/client/contract/slots.ts'

type CtorArgs = ConstructorParameters<typeof PendingApproval>

/** 造一张真实审批卡（会话 id 可控）。 */
function approval(sessionId: string): PendingApproval {
  return new PendingApproval(sessionId as unknown as CtorArgs[0], { toolName: 'bash', reason: '需要写文件' })
}

/** 造一个只暴露 `uiSession.sessionStatus.getSnapshot` 的最小 ctx。 */
function ctxWith(snapshot: Map<string, { pendingInteraction?: unknown }> | (() => never) | undefined): unknown {
  if (snapshot === undefined) return {}
  return {
    uiSession: {
      sessionStatus: {
        getSnapshot: typeof snapshot === 'function'
          ? snapshot
          : () => snapshot,
      },
    },
  }
}

describe('pendingVisibleInStatus — 可见性判据', () => {
  it('快照里就是这张 pending ⇒ 可见', async () => {
    const pending = approval('session-1')
    const ctx = ctxWith(new Map([['session-1', { pendingInteraction: pending }]]))
    await expect(pendingVisibleInStatus(ctx as never, 'session-1', pending)).resolves.toBe(true)
  })

  it('★ 快照里是别的 pending（串会话/被更高优先级顶掉）⇒ 不可见', async () => {
    const mine = approval('session-1')
    const other = approval('session-1')
    const ctx = ctxWith(new Map([['session-1', { pendingInteraction: other }]]))
    await expect(pendingVisibleInStatus(ctx as never, 'session-1', mine)).resolves.toBe(false)
  })

  it('★ 快照里根本没有这个会话（发布落到了没人渲染的分片）⇒ 不可见', async () => {
    const mine = approval('session-2')
    const ctx = ctxWith(new Map([['session-1', { pendingInteraction: approval('session-1') }]]))
    await expect(pendingVisibleInStatus(ctx as never, 'session-2', mine)).resolves.toBe(false)
  })

  it('读不到 uiSession ⇒ 放行（不因诊断把正常审批拦下来）', async () => {
    const pending = approval('session-1')
    await expect(pendingVisibleInStatus({} as never, 'session-1', pending)).resolves.toBe(true)
  })

  it('getSnapshot 抛错 ⇒ 放行，不抛给调用方', async () => {
    const pending = approval('session-1')
    const ctx = ctxWith(() => { throw new Error('boom') })
    await expect(pendingVisibleInStatus(ctx as never, 'session-1', pending)).resolves.toBe(true)
  })
})

describe('源码不变式 — 两条通路都必须自检并以 next() 收口', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/index.ts'), 'utf8')

  it('官方 approval/request 通路：登记后自检', () => {
    const body = source.slice(source.indexOf('async function answerApproval'), source.indexOf('export function apply'))
    expect(body).toContain('pendingVisibleInStatus(')
    expect(body).toMatch(/if \(!await pendingVisibleInStatus\(/)
    // 不可见即交回下游（禁止改成 throw / 静默 return）
    expect(body).toMatch(/remove\(\)\s*\n\s*return await next\(\)/)
  })

  it('corum/escalation/ask 通路：登记后自检', () => {
    const body = source.slice(source.indexOf("ctx.remote.$on('corum/escalation/ask'"))
    expect(body).toContain('pendingVisibleInStatus(')
    expect(body).toMatch(/if \(!await pendingVisibleInStatus\(/)
    expect(body).toMatch(/remove\(\)\s*\n\s*return await next\(\)/)
  })
})
