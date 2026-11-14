/**
 * fork（corum）2026-11-14：审批转发载荷补 sessionId 的单元守护。
 *
 * ## 根因链
 *
 * task agent（createTaskAgent）host 侧完整创建但 renderer 从不 materializeScope
 * （无 UI engage）⇒ `scopeOf(owner)` 恒 undefined ⇒ UI 应答器 `answerApproval`
 * 回落 `sessionIdHintOf(request)` ⇒ 官方 `ApprovalRequestEvent` 不声明 `sessionId`
 * （dsh-user-approval/types/types.d.ts:55-67）⇒ hint undefined ⇒ 返回 'unavailable'
 * ⇒ 官方 `ApprovalService.decide` waterfall next 默认 'unavailable' ⇒ deny。
 *
 * ## 修法
 *
 * 转发器在 `approval/request` 转发路径上，载荷缺 `sessionId` 时从载体 Agent 的
 * `id`（即 SessionId）补上。
 *
 * ## 这里钉住什么
 *
 * ① approval/request 载荷缺 sessionId → 补上载体会话 id（转发后的 request 有 sessionId）；
 * ② approval/request 载荷已有 sessionId → 不覆盖（保持原值）；
 * ③ 其它 waterfall 事件（user-questions/request 等）不受影响（载荷形状不变）；
 * ④ 原始 request 对象不被修改（官方 `readonly` 契约）。
 *
 * @module @corum/corum-api-remotes/tests/approval-sessionid
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

describe('approval/request 转发载荷补 sessionId', () => {
  it('★ 载荷缺 sessionId → 补上载体 Agent 的会话 id', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx, id: 'task-agent-session-001' }
    const target = scopeTarget(ctx, agent)
    // 官方 ApprovalRequestEvent 形状：不含 sessionId。
    const request = { toolName: 'bash', reason: '需要写文件', agent }

    waterfallRaw(ctx, target, 'approval/request', [request], () => Promise.resolve('unavailable')).catch(() => {})
    const dispatch = invocationOf((await iterator.next()).value)
    expect(dispatch.event).toBe('approval/request')
    // 转发后的 request 必须带上 sessionId（= 载体 Agent 的 id）。
    expect((dispatch.request as Record<string, unknown>).sessionId).toBe('task-agent-session-001')
    // 其它原始字段保留。
    expect((dispatch.request as Record<string, unknown>).toolName).toBe('bash')
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
    // 模拟 corum 自有事件或已携带 sessionId 的载荷。
    const request = { toolName: 'bash', reason: '需要提权', agent, sessionId: 'pre-existing-session' }

    waterfallRaw(ctx, target, 'approval/request', [request], () => Promise.resolve('unavailable')).catch(() => {})
    const dispatch = invocationOf((await iterator.next()).value)
    // sessionId 保持原值，不被覆盖。
    expect((dispatch.request as Record<string, unknown>).sessionId).toBe('pre-existing-session')

    abort.abort()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('★ 其它 waterfall 事件不受影响（user-questions/request 载荷形状不变）', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx, id: 'qa-session' }
    const target = scopeTarget(ctx, agent)
    const request = { questions: [], agent }

    waterfallRaw(ctx, target, 'user-questions/request', [request], () => Promise.resolve('host fallback')).catch(() => {})
    const dispatch = invocationOf((await iterator.next()).value)
    expect(dispatch.event).toBe('user-questions/request')
    // user-questions/request 的载荷不应被注入 sessionId。
    expect('sessionId' in dispatch.request).toBe(false)
    expect((dispatch.request as Record<string, unknown>).questions).toEqual([])

    abort.abort()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('★ 原始 request 对象不被修改（官方 readonly 契约）', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx, id: 'immutability-check' }
    const target = scopeTarget(ctx, agent)
    const request = { toolName: 'bash', reason: 'test', agent }

    waterfallRaw(ctx, target, 'approval/request', [request], () => Promise.resolve('unavailable')).catch(() => {})
    const dispatch = invocationOf((await iterator.next()).value)
    // 转发后的 request 带上了 sessionId。
    expect((dispatch.request as Record<string, unknown>).sessionId).toBe('immutability-check')
    // 但原始 request 对象没有被修改（没有 sessionId 属性）。
    expect('sessionId' in request).toBe(false)
    // 转发后的 request 是一个不同的对象（浅拷）。
    expect(dispatch.request).not.toBe(request)

    abort.abort()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
