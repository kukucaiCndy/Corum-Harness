/**
 * fork（corum）2026-11-18：`corum/model-ask/request` 转发载荷补 sessionId 的单元守护。
 *
 * ## 根因链（实机事故会话 `corum-task-f5d3b522`）
 *
 * task agent（指挥模式会话）host 侧完整创建但 renderer 从不 materializeScope
 * ⇒ client 应答器 `answerModelAsk` 的 `scopeOf(owner)` 恒 undefined ⇒ 旧实现直接
 * `next()`，面板永不出现；而前台询问路径又没有超时兜底 ⇒ 父会话永久挂起。
 * 与 approval #181（2026-11-14 修复）同族——审批当时补了 sessionId 回落，
 * model-ask 漏了。本守护钉住补齐后的转发行为。
 *
 * ## 这里钉住什么
 *
 * ① model-ask 载荷缺 sessionId → 补上载体 Agent 的会话 id；
 * ② 载荷已有 sessionId → 不覆盖；
 * ③ 原始 request 对象不被修改（浅拷）。
 *
 * @module @corum/corum-api-remotes/tests/model-ask-sessionid
 */
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type {
  RemoteEventHostInfo,
  TypertRemoteEventInvocation,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index.ts'

interface GatewayProbe {
  source: TypertRemoteEventSource | undefined
  host: RemoteEventHostInfo | undefined
  removals: number
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>
}

async function setup(): Promise<{
  readonly ctx: Context
  readonly gateway: GatewayProbe
  readonly fiber: Fiber
}> {
  const ctx = new Context()
  const gateway: GatewayProbe = {
    source: undefined,
    host: undefined,
    removals: 0,
    registerRemoteEvents(source, host) {
      gateway.source = source
      gateway.host = host
      return async () => {
        if (gateway.source !== source) return
        gateway.source = undefined
        gateway.host = undefined
        gateway.removals += 1
      }
    },
  }
  ctx.reflect.provide('typertGateway', gateway)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { ctx, gateway, fiber }
}

function sourceOf(gateway: GatewayProbe): TypertRemoteEventSource {
  if (gateway.source === undefined) throw new Error('fixture Gateway has no Remote event source')
  return gateway.source
}

function waterfallRaw(
  ctx: Context,
  target: object,
  event: string,
  args: readonly unknown[],
  next: () => Promise<unknown>,
): Promise<unknown> {
  const waterfall = ctx.waterfall.bind(ctx) as unknown as (
    receiver: object,
    name: string,
    ...values: readonly unknown[]
  ) => Promise<unknown>
  return waterfall(target, event, ...args, next)
}

function invocationOf(value: unknown): TypertRemoteEventInvocation {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'context')) {
    throw new Error('fixture did not receive a scoped Remote Event invocation')
  }
  return value as TypertRemoteEventInvocation
}

/** model-ask 载荷的最小形状（发射端不写 sessionId——转发 loop 补）。 */
function askRequest(agent: object, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent,
    label: '定位 runPrompt 路径错误',
    configured: { provider: 'localhost', model: 'glm-5.3-flashx' },
    fallback: { provider: 'p-main', model: 'm-main' },
    cause: '429 rate limited',
    role: 'research',
    options: [],
    catalog: [],
    ...extra,
  }
}

describe('corum/model-ask/request 转发载荷补 sessionId', () => {
  it('★ 载荷缺 sessionId → 补上载体 Agent 的会话 id（task agent 面板回落的依据）', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx, id: 'corum-task-f5d3b522' }
    const target = scopeTarget(ctx, agent)
    const request = askRequest(agent)

    waterfallRaw(ctx, target, 'corum/model-ask/request', [request], () => Promise.resolve({ kind: 'dismissed' })).catch(() => {})
    const dispatch = invocationOf((await iterator.next()).value)
    expect(dispatch.event).toBe('corum/model-ask/request')
    expect((dispatch.request as Record<string, unknown>).sessionId).toBe('corum-task-f5d3b522')
    // 其它原始字段保留。
    expect((dispatch.request as Record<string, unknown>).label).toBe('定位 runPrompt 路径错误')
    expect((dispatch.request as Record<string, unknown>).agent).toBe(agent)

    abort.abort()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('★ 载荷已有 sessionId → 不覆盖（保持原值）', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx, id: 'agent-actual-id' }
    const target = scopeTarget(ctx, agent)
    const request = askRequest(agent, { sessionId: 'pre-existing-session' })

    waterfallRaw(ctx, target, 'corum/model-ask/request', [request], () => Promise.resolve({ kind: 'dismissed' })).catch(() => {})
    const dispatch = invocationOf((await iterator.next()).value)
    expect((dispatch.request as Record<string, unknown>).sessionId).toBe('pre-existing-session')

    abort.abort()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('★ 原始 request 对象不被修改（浅拷契约）', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx, id: 'immutability-check' }
    const target = scopeTarget(ctx, agent)
    const request = askRequest(agent)

    waterfallRaw(ctx, target, 'corum/model-ask/request', [request], () => Promise.resolve({ kind: 'dismissed' })).catch(() => {})
    const dispatch = invocationOf((await iterator.next()).value)
    expect((dispatch.request as Record<string, unknown>).sessionId).toBe('immutability-check')
    expect('sessionId' in request).toBe(false)
    expect(dispatch.request).not.toBe(request)

    abort.abort()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})