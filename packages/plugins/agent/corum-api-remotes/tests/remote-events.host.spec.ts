/**
 * fork（corum）P2-4（.dbg/event-bus-audit-2026-09.md）：Remote 转发机制的运行时守护。
 *
 * 前 5 例**逐字移植官方** `@deepseek-ai/dsh-api-remotes/tests/remote-events.host.spec.ts`
 * （232 行；fork 的 index.ts/types.ts 与官方逐字节一致，故断言同样成立）——守住
 * 「allowlist 队列 / 非 JSON 拒收 / waterfall 三段式 / source 撤回」四条机制语义。
 *
 * 后 3 例是 corum 增量：**逐条 allowlist 的 corum 事件都要真能转发到 renderer**
 * （此前只有编译期声明、无运行时守护——漏加 allowlist 时 renderer 永远收不到，
 * 且没有任何测试会红）。
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
import {
  subagentDelegationRoleOf,
  subagentProgressStateOf,
  subagentStateChipTone,
  subagentTerminalTone,
} from '../src/corum-events.ts'
import { apply, inject } from '../src/index.ts'
import { API_REMOTE_FORWARDED_EVENTS } from '../src/remote-events.ts'

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

function emitRaw(ctx: Context, event: string, args: readonly unknown[]): void {
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, ...values: readonly unknown[]) => void
  emit(event, ...args)
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

describe('Remote event Host source', () => {
  it('registers the Host home used by Client connection generations', async () => {
    const { gateway, fiber } = await setup()
    expect(gateway.host?.home).toBeTypeOf('string')
    expect(gateway.host?.home.length).toBeGreaterThan(0)
    await fiber.dispose()
    expect(gateway.host).toBeUndefined()
  })

  it('gives each Client stream an independent allowlisted event queue', async () => {
    const { ctx, gateway, fiber } = await setup()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = sourceOf(gateway)(firstAbort.signal)[Symbol.asyncIterator]()
    const second = sourceOf(gateway)(secondAbort.signal)[Symbol.asyncIterator]()

    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })

    const firstDone = first.next()
    firstAbort.abort(new Error('first Client disconnected'))
    emitRaw(ctx, 'commands/change', [])
    await expect(firstDone).resolves.toEqual({ done: true, value: undefined })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'commands/change', args: [] },
    })

    const secondDone = second.next()
    secondAbort.abort(new Error('second Client disconnected'))
    await expect(secondDone).resolves.toEqual({ done: true, value: undefined })

    await fiber.dispose()
    expect(gateway.source).toBeUndefined()
    expect(gateway.removals).toBe(1)
    await ctx.fiber.dispose()
  })

  it('rejects a non-JSON argument without poisoning the stream', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()

    expect(() => {
      emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1n])
    }).toThrow('argument 1 is not lossless JSON data')
    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 2])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 2] },
    })

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(sourceOf(gateway)(alreadyAborted.signal)[Symbol.asyncIterator]().next())
      .resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('bridges scoped waterfall result, next delegation, and rejection', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx }
    const target = scopeTarget(ctx, agent)
    const request = { questions: [], agent }

    const claimed = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const claimedDispatch = invocationOf((await iterator.next()).value)
    expect(claimedDispatch).toMatchObject({
      event: 'user-questions/request',
      request,
      context: { value: agentCtx, subject: agent },
    })
    claimedDispatch.resolve({ kind: 'result', value: 'client answer' })
    await expect(claimed).resolves.toBe('client answer')

    const delegated = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const delegatedDispatch = invocationOf((await iterator.next()).value)
    delegatedDispatch.resolve({ kind: 'next' })
    await expect(delegated).resolves.toBe('host fallback')

    const rejection = Object.assign(new Error('the user cancelled ask_user_question'), {
      code: 'ASK_CANCELLED',
    })
    const rejected = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const rejectedAssertion = expect(rejected).rejects.toBe(rejection)
    const rejectedDispatch = invocationOf((await iterator.next()).value)
    rejectedDispatch.reject(rejection)
    await rejectedAssertion

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('rejects a queued scoped waterfall when its source is withdrawn', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const delivery = iterator.next()
    const agent = { ctx: ctx.extend() }
    const reason = new Error('forwarded event source removed')
    const pending = waterfallRaw(
      ctx,
      scopeTarget(ctx, agent),
      'user-questions/request',
      [{ questions: [], agent }],
      () => Promise.resolve('host fallback'),
    )
    const rejected = expect(pending).rejects.toBe(reason)

    abort.abort(reason)

    await rejected
    await expect(delivery).resolves.toEqual({ done: true, value: undefined })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})

describe('corum 事件转发（P2-4 运行时守护）', () => {
  /** allowlist 里的 corum 事件名（P2-9 脚本亦会核对声明↔转发双向一致）。 */
  /**
   * 从**源清单**里取全部 `corum/` 事件名（不写死数字；新增事件自动被本断言覆盖）。
   * @returns corum 事件名数组。
   */
  const corumEventNames = (): readonly string[] =>
    API_REMOTE_FORWARDED_EVENTS.map(entry => entry.event).filter(name => name.startsWith('corum/'))

  const CORUM_EVENTS = API_REMOTE_FORWARDED_EVENTS
    .map(entry => entry.event)
    .filter(event => event.startsWith('corum/'))

  it('allowlist 含全部 corum 事件且无重复（新增事件必须同步登记）', () => {
    // 2026-09-29：原断言写死 21，但 fork 陆续加了 `corum/escalation/ask`（三档提权）与
    // 另一条 corum 事件 ⇒ 实际 23，断言未同步（既有滞后，非升级引入）。
    // 改为**结构化断言**：数量与源清单一致、且无重复 —— 比写死数字更能守住"新增事件必须登记"。
    expect(CORUM_EVENTS.length).toBe(corumEventNames().length)
    expect(new Set(CORUM_EVENTS).size).toBe(CORUM_EVENTS.length)
  })

  it('逐条 corum 事件都能转发到 Client 队列', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx }
    const target = scopeTarget(ctx, agent)

    // 官方 0.1.5 收紧了转发契约：**waterfall 事件的载荷必须直接携带 `agent`**
    // （`carrierKeyOf(this)` 必须等于 `request.agent`，否则抛
    // `forwarded scoped event … must carry its Agent directly`）。
    // ⇒ `emit` 模式裸发；`waterfall` 模式必须经 `ctx.waterfall(target, …)` 且载荷带 agent。
    // 2026-10-11：原先这里**写死** waterfall 事件名（只列 model-ask/escalation），
    // 5dc6e40 新增 `corum/commit-card/request`（waterfall）时漏同步 ⇒ 该事件被当 emit 发，
    // 监听器第二参 `next` 不是函数 ⇒ `TypeError: next is not a function`（预存在红灯）。
    // 改为**从 allowlist 的 `mode` 派生**（与上面的结构化断言同源）——新增 waterfall 事件
    // 自动走 waterfallRaw，不再有第二份会过期的清单。
    const waterfallEvents = new Set(
      API_REMOTE_FORWARDED_EVENTS.filter(entry => entry.mode === 'waterfall').map(entry => entry.event),
    )
    for (const event of CORUM_EVENTS) {
      const pending = iterator.next()
      if (waterfallEvents.has(event)) {
        waterfallRaw(ctx, target, event, [{ probe: true, agent }], () => Promise.resolve()).catch(() => {})
      } else {
        // 载荷形状由 cordis Events 声明在编译期守护（emitRaw 走 unknown 断言）；
        // 本用例只守「allowlist 是否真的把该事件转发出去」。
        emitRaw(ctx, event, [{ probe: true }])
      }
      // 转发形态：`emit` 事件 → `{ event, args }`；`waterfall` 事件 → `{ event, request, context }`
      // （由 `forwardWaterfall` 构造，见 src/index.ts；后者还带 `resolve`/`reject` 两个函数
      // ⇒ 用 toMatchObject 只校关键字段，函数不参与深比较）。
      if (waterfallEvents.has(event)) {
        await expect(pending).resolves.toMatchObject({
          done: false,
          value: {
            event,
            request: { probe: true, agent },
            context: { value: agentCtx, subject: agent },
          },
        })
      } else {
        await expect(pending).resolves.toEqual({
          done: false,
          value: { event, args: [{ probe: true }] },
        })
      }
    }

    abort.abort()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('未登记的事件不转发（不污染队列）', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()

    emitRaw(ctx, 'corum/not-a-real-event', [{ probe: 'dropped' }])
    const pending = iterator.next()
    emitRaw(ctx, 'corum/task/assigned', [{ probe: 'forwarded' }])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'corum/task/assigned', args: [{ probe: 'forwarded' }] },
    })

    abort.abort()
    await ctx.fiber.dispose()
  })

  it('corum 事件的非 JSON 载荷被拒且不毒化流', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()

    expect(() => {
      emitRaw(ctx, 'corum/task/assigned', [{ probe: 1n }])
    }).toThrow('argument 0 is not lossless JSON data')
    const pending = iterator.next()
    emitRaw(ctx, 'corum/task/assigned', [{ probe: 'ok' }])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'corum/task/assigned', args: [{ probe: 'ok' }] },
    })

    abort.abort()
    await ctx.fiber.dispose()
  })
})

describe('subagentProgressStateOf — 子 Agent 展示态的单一判据家（2026-09-13）', () => {
  it('优先级：权威 stopReason > interrupted > done 兜底', () => {
    // 宿主只在拿不到 stopReason 时才置 interrupted，故两者同时出现时以权威原因记账。
    expect(subagentProgressStateOf({ interrupted: true, done: true, stopReason: 'aborted' })).toBe('aborted')
    expect(subagentProgressStateOf({ interrupted: true, done: true })).toBe('interrupted')
    // 兜底最弱：有原因/有 interrupted 都不会走到它。
    expect(subagentProgressStateOf({ interrupted: true, done: true })).not.toBe('completed')
  })

  it('stopReason → 三态', () => {
    expect(subagentProgressStateOf({ stopReason: 'completed', done: true })).toBe('completed')
    expect(subagentProgressStateOf({ stopReason: 'aborted', done: true })).toBe('aborted')
    for (const reason of ['error', 'max-tokens', 'refusal'] as const) {
      expect(subagentProgressStateOf({ stopReason: reason, done: true })).toBe('failed')
    }
  })

  it('拿不到原因的终局按「已完成」兜底，不永远算运行中（BUG-31 的判据同源）', () => {
    expect(subagentProgressStateOf({ done: true })).toBe('completed')
  })

  it('未结束 = running', () => {
    expect(subagentProgressStateOf({})).toBe('running')
    expect(subagentProgressStateOf({ done: false })).toBe('running')
  })

  it('色调：interrupted 与 aborted 同档 warn；只有 completed 是 success', () => {
    expect(subagentTerminalTone('completed')).toBe('success')
    expect(subagentTerminalTone('aborted')).toBe('warn')
    expect(subagentTerminalTone('interrupted')).toBe('warn')
    expect(subagentTerminalTone('failed')).toBe('error')
  })

  it('chip 色调：不扩词表——interrupted 复用 aborted 档', () => {
    expect(subagentStateChipTone('running')).toBe('running')
    expect(subagentStateChipTone('completed')).toBe('done')
    expect(subagentStateChipTone('aborted')).toBe('aborted')
    expect(subagentStateChipTone('interrupted')).toBe('aborted')
    expect(subagentStateChipTone('failed')).toBe('failed')
  })

  it('会话条花名册的镜像判据与这里逐条一致（红线 3：本包不 import，靠本用例钉住）', async () => {
    // 会话条（corum-ide-ui）刻意**不** import 本包（跨 bundle 用本地能力接口收窄），
    // 它自带一份 `subagentStateOf`。判据分叉过一次（「已中断」只落了卡片、花名册仍算
    // 「已完成」），所以这里把镜像的**规则原文**钉住：镜像改了这里就红，改哪边都得同步。
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      new URL('../../../ui/corum-ide-ui/src/client/session-bar.tsx', import.meta.url), 'utf8',
    )
    expect(src).toContain('function subagentStateOf(')
    // 规则顺序必须同序：outcome → interrupted → done 兜底（顺序错了就不是同语义）。
    const outcomeAt = src.indexOf('const outcome = subagentOutcomeOf(e.stopReason)')
    const interruptedAt = src.indexOf("if (e.interrupted === true) return 'interrupted'")
    const doneFallbackAt = src.indexOf("return e.done === true ? 'completed' : 'running'")
    expect(outcomeAt).toBeGreaterThan(-1)
    expect(interruptedAt).toBeGreaterThan(outcomeAt)
    expect(doneFallbackAt).toBeGreaterThan(interruptedAt)
    // 规则 3：镜像表必须覆盖同一组五态。
    expect(src).toContain("type SubagentState = 'running' | 'completed' | 'aborted' | 'failed' | 'interrupted'")
  })

  it('卡片（corum-ui-chat）也走同一个分类函数，不自己判 done 布尔', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      new URL('../../../session/corum-ui-chat/src/client/chat/SubagentCard.tsx', import.meta.url), 'utf8',
    )
    expect(src).toContain('subagentProgressStateOf')
    expect(src).toContain('subagentStateChipTone')
  })
})

describe('subagentDelegationRoleOf — 委派角色只认工具名（2026-09-12 用户定调，BUG-27）', () => {
  it('三个 corum 委派工具名各自的角色', () => {
    expect(subagentDelegationRoleOf('subagent')).toBe('worker')
    expect(subagentDelegationRoleOf('subagent_research')).toBe('research')
    expect(subagentDelegationRoleOf('subagent_fork')).toBe('fork')
  })

  it('未知/缺省工具名 → undefined（UI 退回通用图标，不冒充角色）', () => {
    expect(subagentDelegationRoleOf(undefined)).toBeUndefined()
    expect(subagentDelegationRoleOf('orchestrate')).toBeUndefined()
    expect(subagentDelegationRoleOf('bash')).toBeUndefined()
  })

  it('不按 label 文案猜：label 里出现「调研」也不影响角色判定（判定输入根本没有 label）', () => {
    // 角色函数的入参只有工具名——这条断言钉的是「签名不含 label」，防回归成文案匹配。
    expect(subagentDelegationRoleOf.length).toBe(1)
  })

  it('工具名表与 host 侧镜像表一致（corum-tool-subagent 自带一份，守卫 §事件段对账）', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      new URL('../../corum-tool-subagent/src/index.ts', import.meta.url), 'utf8',
    )
    expect(src).toContain('CORUM_DELEGATION_ROLE_BY_TOOL')
    for (const [tool, role] of [['subagent', 'worker'], ['subagent_research', 'research'], ['subagent_fork', 'fork']] as const) {
      expect(src).toContain(`${tool}: '${role}'`)
    }
  })
})
