/**
 * 审批流的两条用户诉求（issue #171 / #172）的回归网。
 *
 * ## 钉住什么
 *
 * ① **#171「本会话始终允许」真的记住，而且记得精确**：
 *    - 同一会话 + 同一工具 + 同一审批原因 ⇒ 后续同类请求**直接放行**（不再弹卡）；
 *    - 换会话 / 换工具 / 换原因 ⇒ 仍然弹卡（记忆面是 (session, tool, reason) 三元组）；
 *    - 断线重连（`connection.generation` 换代）⇒ 授权全部作废；
 *    - 会话被删（从 `sessions.list` 消失）⇒ 该会话授权作废；
 *    - 请求已被中止（`signal.aborted`）⇒ 返回 `cancelled`，不弹卡。
 *
 * ② **#172 审批卡进会话流**：注册面从 `conversation.composer` 换成
 *    `conversation.approval.stream`，且卡片数据来自官方 `uiSession.sessionStatus`
 *    的 `pendingInteraction`（与可见性自检同一份真相），判别走结构判别 `isPendingApproval`
 *    （跨 bundle 的 `instanceof` 恒 false —— 见 `pending-approval-guard.spec.ts`）。
 *
 * ## 为什么用 mock ctx
 *
 * 这里要验的是**决策与注册面**，不是渲染像素；真渲染放在 conversation 包的
 * `approval-flow.spec.tsx`（React SSR）。mock 只实现本插件用到的能力面，且刻意让
 * 「会话载体解析」可注入，以便覆盖 `unavailable` 分支。
 *
 * @module @corum/corum-ui-approval/tests/approval-stream-and-grants
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.ts'
import { PendingApproval } from '../src/client/contract/slots.ts'

type Listener = (this: unknown, request: unknown, next: () => Promise<string>) => Promise<string>

/** 一套最小可用的宿主假体（能力面与真服务一致，只是可注入）。 */
function setup(): {
  ask: (init?: { sessionId?: string; toolName?: string; reason?: string; signal?: AbortSignal }) => { result: Promise<string> },
  pending: Map<string, PendingApproval>,
  registrations: { name: string; children?: Record<string, unknown> }[],
  disconnect: () => void,
  removeSession: (id: string) => void,
  askWithOwner: (owner: unknown, request: unknown) => Promise<string>,
  dispose: () => void,
} {
  const listeners = new Map<string, Listener>()
  const registrations: { name: string; children?: Record<string, unknown> }[] = []
  const pending = new Map<string, PendingApproval>()
  const status = new Map<string, { pendingInteraction?: unknown }>()
  const statusObservers = new Set<() => void>()
  const sessionObservers = new Set<() => void>()
  const generationObservers = new Set<() => void>()
  const disposers: (() => void)[] = []
  let generation: object | undefined = {}
  let byId: Record<string, object> = { first: {}, second: {} }

  const connection = {
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener: () => void) => { generationObservers.add(listener); return () => { generationObservers.delete(listener) } },
    },
  }

  const ctx = {
    get: (name: string): unknown => (name === 'connection' ? connection : undefined),
    effect: (start: () => (() => void) | void): void => { const stop = start(); if (typeof stop === 'function') disposers.push(stop) },
    locale: { register: () => () => {} },
    sessions: {
      scopeOf: (owner: { id?: string }): string | undefined => owner.id,
      list: {
        getSnapshot: () => ({ byId }),
        subscribe: (listener: () => void) => { sessionObservers.add(listener); return () => { sessionObservers.delete(listener) } },
      },
    },
    uiSession: {
      // 官方 `sessionStatus`：Map<SessionId, SessionStatus>，每项带 `pendingInteraction`。
      sessionStatus: {
        getSnapshot: () => status,
        subscribe: (listener: () => void) => { statusObservers.add(listener); return () => { statusObservers.delete(listener) } },
      },
      registerPendingInteraction: () => (item: PendingApproval): (() => void) => {
        // 模拟官方发布链：登记 ⇒ 落进 sessionStatus 快照 ⇒ 通知订阅者。
        pending.set(item.key, item)
        status.set(String(item.sessionId), { pendingInteraction: item })
        statusObservers.forEach(listener => { listener() })
        return () => {
          pending.delete(item.key)
          status.delete(String(item.sessionId))
          statusObservers.forEach(listener => { listener() })
        }
      },
    },
    slots: {
      inject: (_name: string, register: () => void): void => { register() },
      register: (registration: { name: string; children?: Record<string, unknown> }) => {
        registrations.push(registration)
        return () => {}
      },
    },
    remote: {
      $on: (name: string, listener: Listener): void => { listeners.set(name, listener) },
    },
  }

  apply(ctx as never)

  const ask = (init?: { sessionId?: string; toolName?: string; reason?: string; signal?: AbortSignal }): { result: Promise<string> } => {
    const listener = listeners.get('approval/request')!
    const request = {
      toolName: init?.toolName ?? 'bash',
      reason: init?.reason ?? 'Escalate to danger-full-access',
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    }
    const result = listener.call({ id: init?.sessionId ?? 'first' }, request, async () => 'delegated') as Promise<string>
    return { result }
  }

  return {
    ask,
    pending,
    registrations,
    disconnect: (): void => { generation = undefined; generationObservers.forEach(listener => { listener() }) },
    removeSession: (id: string): void => { byId = Object.fromEntries(Object.entries(byId).filter(([key]) => key !== id)); sessionObservers.forEach(listener => { listener() }) },
    askWithOwner: (owner: unknown, request: unknown): Promise<string> =>
      listeners.get('approval/request')!.call(owner, request, async () => 'delegated'),
    dispose: (): void => { disposers.reverse().forEach(stop => { stop() }) },
  }
}

/** 取当前待决卡片（测试断言用）。 */
const card = (fixture: ReturnType<typeof setup>): PendingApproval => [...fixture.pending.values()].at(-1)!

describe('issue #171：本会话始终允许', () => {
  it('同一会话 + 同一工具 + 同一原因 ⇒ 记住后不再弹卡，后续直接 allowed-once', async () => {
    const fixture = setup()
    const first = fixture.ask()
    expect(card(fixture).allowsAlwaysAllow).toBe(true)
    expect(card(fixture).alwaysAllowScope).toBe('request')
    await card(fixture).answerAlwaysAllow()
    expect(await first.result).toBe('allowed-once')

    const second = fixture.ask()
    expect(fixture.pending.size, '已授权 ⇒ 不应再登记待决卡片').toBe(0)
    expect(await second.result).toBe('allowed-once')
  })

  it('换会话 / 换工具 / 换原因 ⇒ 仍然弹卡（记忆面是三元组）', async () => {
    const fixture = setup()
    const first = fixture.ask()
    await card(fixture).answerAlwaysAllow()
    await first.result

    for (const init of [{ sessionId: 'second' }, { toolName: 'edit' }, { reason: 'Another reason' }]) {
      const another = fixture.ask(init)
      expect(fixture.pending.size, `${JSON.stringify(init)} 不该命中原授权`).toBe(1)
      await card(fixture).answer('rejected')
      expect(await another.result).toBe('rejected')
    }
  })

  it('断线重连（generation 换代）⇒ 授权作废', async () => {
    const fixture = setup()
    const first = fixture.ask()
    await card(fixture).answerAlwaysAllow()
    await first.result
    fixture.disconnect()

    const again = fixture.ask()
    expect(fixture.pending.size).toBe(1)
    await card(fixture).answer('allowed-once')
    expect(await again.result).toBe('allowed-once')
  })

  it('会话被删 ⇒ 该会话授权作废', async () => {
    const fixture = setup()
    const first = fixture.ask()
    await card(fixture).answerAlwaysAllow()
    await first.result
    fixture.removeSession('first')

    fixture.ask()
    expect(fixture.pending.size).toBe(1)
  })

  it('请求已中止 ⇒ cancelled（不弹卡）', async () => {
    const fixture = setup()
    const controller = new AbortController()
    controller.abort()
    const aborted = fixture.ask({ signal: controller.signal })
    expect(fixture.pending.size).toBe(0)
    expect(await aborted.result).toBe('cancelled')
  })

  it('取不到会话载体且载荷没有会话 id ⇒ unavailable（绝不静默 next）', async () => {
    const fixture = setup()
    // owner 没有 id ⇒ scopeOf 返回 undefined；载荷里也没有 sessionId ⇒ 无从回落。
    const outcome = await fixture.askWithOwner({}, { toolName: 'bash', reason: '需要提权' })
    expect(outcome).toBe('unavailable')
    expect(fixture.pending.size).toBe(0)
  })

  it('取不到会话载体但载荷带 sessionId ⇒ 回落到它并照常弹卡', async () => {
    const fixture = setup()
    const pendingResult = fixture.askWithOwner({}, { toolName: 'bash', reason: '需要提权', sessionId: 'second' })
    expect(fixture.pending.size).toBe(1)
    expect(String(card(fixture).sessionId)).toBe('second')
    await card(fixture).answer('rejected')
    expect(await pendingResult).toBe('rejected')
  })
})

describe('issue #172：审批卡进会话流', () => {
  it('注册面是 conversation.approval.stream（不是 composer）', () => {
    const fixture = setup()
    const names = fixture.registrations.map(registration => registration.name)
    expect(names).toContain('conversation.approval.stream')
    expect(names).not.toContain('conversation.composer')
    const registration = fixture.registrations.find(item => item.name === 'conversation.approval.stream')!
    expect(registration.children).toBeDefined()
    expect(Object.keys(registration.children ?? {})).toContain('conversation.approval.detail')
  })
})