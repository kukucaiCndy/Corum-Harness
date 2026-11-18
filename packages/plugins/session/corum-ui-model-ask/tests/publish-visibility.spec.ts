/**
 * ★ 2026-11-18 实机事故（会话 `corum-task-f5d3b522`）的客户端回归网：
 * model-ask 的「发布后自检」与「载荷 sessionId 回落」——与 approval #171/#181 同款防线。
 *
 * ## 事故形态
 *
 * 子 Agent 429 失败后机制派发「模型不可用」询问，面板从未出现，父会话前台委派
 * 永久挂起（45+ 分钟零事件）。client 应答器旧实现有两处缺口：
 * ① `scopeOf(owner)` 解析不到（task agent 载体从不 materialize）就直接 `next()`，
 *    没有载荷回落（approval #181 早已修过同款）；
 * ② 登记 pending 后直接 `await pending.result`，没有发布后自检——pending 落在
 *    「不在渲染的会话/分片」或被更高优先级 pending 遮蔽时永久空等（approval #171 同款）。
 *
 * ## 这里钉住什么
 *
 * ① 快照里就是它 ⇒ 可见（正常路径不拦截）；
 * ② 快照里是别的 pending / 没有该会话 ⇒ 不可见（正是要收口的那一格）；
 * ③ 读不到 `uiSession.sessionStatus` 或读时抛错 ⇒ 放行（诊断不许把正常询问弄坏）；
 * ④ 源码不变式：登记后立刻自检、不可见 `next()` 收口、scopeOf 失败按载荷回落、
 *    两条失败路都留 console.warn（下次现场只看控制台就知道卡在哪一环）。
 *
 * @module @corum/corum-ui-model-ask/tests/publish-visibility
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pendingVisibleInStatus } from '../src/client/index.tsx'
import { PendingModelAsk, type ModelAskRequest } from '../src/client/contract.ts'

/** 造一份最小提问载荷（字段与 host 词汇表同形）。 */
function request(): ModelAskRequest {
  return {
    label: '定位 runPrompt 路径错误',
    configured: { provider: 'localhost', model: 'glm-5.3-flashx' },
    fallback: { provider: 'p-main', model: 'm-main' },
    cause: '429 rate limited',
    role: 'research',
    options: [],
    catalog: [],
  }
}

/** 造一个真实待决项（会话 id 可控）。 */
function modelAsk(sessionId: string): PendingModelAsk {
  return new PendingModelAsk(sessionId as never, request())
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
  it('快照里就是这个 pending ⇒ 可见', async () => {
    const pending = modelAsk('session-1')
    const ctx = ctxWith(new Map([['session-1', { pendingInteraction: pending }]]))
    await expect(pendingVisibleInStatus(ctx as never, 'session-1', pending)).resolves.toBe(true)
  })

  it('★ 快照里是别的 pending（被更高优先级顶掉）⇒ 不可见', async () => {
    const mine = modelAsk('session-1')
    const other = modelAsk('session-1')
    const ctx = ctxWith(new Map([['session-1', { pendingInteraction: other }]]))
    await expect(pendingVisibleInStatus(ctx as never, 'session-1', mine)).resolves.toBe(false)
  })

  it('★ 快照里根本没有这个会话（发布落到了没人渲染的分片）⇒ 不可见', async () => {
    const mine = modelAsk('session-2')
    const ctx = ctxWith(new Map([['session-1', { pendingInteraction: modelAsk('session-1') }]]))
    await expect(pendingVisibleInStatus(ctx as never, 'session-2', mine)).resolves.toBe(false)
  })

  it('读不到 uiSession ⇒ 放行（不因诊断把正常询问拦下来）', async () => {
    const pending = modelAsk('session-1')
    await expect(pendingVisibleInStatus({} as never, 'session-1', pending)).resolves.toBe(true)
  })

  it('getSnapshot 抛错 ⇒ 放行，不抛给调用方', async () => {
    const pending = modelAsk('session-1')
    const ctx = ctxWith(() => { throw new Error('boom') })
    await expect(pendingVisibleInStatus(ctx as never, 'session-1', pending)).resolves.toBe(true)
  })
})

describe('源码不变式 — 应答器必须自检、回落、留诊断', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/index.tsx'), 'utf8')
  const body = source.slice(source.indexOf('async function answerModelAsk'), source.indexOf('function ModelAskDock'))

  it('★ 登记后立刻自检，不可见即交回下游（禁止回退成静默空等）', () => {
    expect(body).toContain('pendingVisibleInStatus(')
    expect(body).toMatch(/if \(!await pendingVisibleInStatus\(/)
    expect(body).toMatch(/remove\(\)\s*\n\s*return await next\(\)/)
  })

  it('★ scopeOf 解析不到 ⇒ 按载荷 sessionId 回落（#181 同款），仍拿不到才 next()', () => {
    expect(body).toContain('sessionIdHintOf(request)')
    // 回落成功要真的用上（sessionId = hint），而不是只打个日志。
    expect(body).toMatch(/sessionId = hint/)
  })

  it('★ 两条失败路都留 console.warn（面板不出现时控制台是唯一诊断入口）', () => {
    const warns = body.match(/console\.warn\(/g) ?? []
    expect(warns.length).toBeGreaterThanOrEqual(3)
  })

  it('★ 载荷读取器不假设字段存在（in 收窄 + 运行时类型校验）', () => {
    const hint = source.slice(source.indexOf('function sessionIdHintOf'), source.indexOf('export async function pendingVisibleInStatus'))
    expect(hint).toContain("'sessionId' in request")
    expect(hint).toContain("typeof hinted !== 'string'")
  })
})