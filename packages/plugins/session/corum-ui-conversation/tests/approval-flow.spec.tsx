import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { apply } from '../../corum-ui-approval/src/client/index.ts'
import { PendingApproval } from '../../corum-ui-approval/src/client/contract/slots.ts'
import { createApprovalStream } from '../../corum-ui-approval/src/client/ApprovalStream.tsx'
import { zh } from '../../corum-ui-approval/src/client/locales.ts'
import { ConversationSession } from '../src/client/skeleton/ConversationSession.tsx'

function setup() {
  const listeners = new Map<string, Function>()
  const registrations: { name: string }[] = []
  const pending = new Map<string, PendingApproval>()
  const observers = new Set<() => void>()
  const sessionObservers = new Set<() => void>()
  const generationObservers = new Set<() => void>()
  const disposers: (() => void)[] = []
  let generation: object | undefined = {}
  let byId: Record<string, object> = { first: {}, second: {} }
  const source = {
    getSnapshot: () => pending,
    subscribe(listener: () => void) { observers.add(listener); return () => { observers.delete(listener) } },
  }
  const ctx = {
    get: (name: string): unknown => name === 'connection' ? ctx.connection : undefined,
    effect(start: () => (() => void) | void) { const stop = start(); if (stop) disposers.push(stop) },
    locale: { register: () => () => {} },
    sessions: {
      scopeOf: (owner: { id?: string }) => owner.id,
      list: {
        getSnapshot: () => ({ byId }),
        subscribe(listener: () => void) { sessionObservers.add(listener); return () => { sessionObservers.delete(listener) } },
      },
    },
    connection: { generation: {
      getSnapshot: () => generation,
      subscribe(listener: () => void) { generationObservers.add(listener); return () => { generationObservers.delete(listener) } },
    } },
    uiSession: {
      pendingInteractions: source,
      registerPendingInteraction: () => (item: PendingApproval) => {
        pending.set(item.key, item)
        return () => { pending.delete(item.key) }
      },
    },
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (registration: { name: string }) => { registrations.push(registration); return () => {} },
    },
    remote: { $on: (name: string, listener: Function) => { listeners.set(name, listener) } },
  }
  apply(ctx as never)
  const ask = (id = 'first', reason = 'Escalate to danger-full-access', toolName = 'bash', signal?: AbortSignal) => {
    const result = listeners.get('approval/request')!.call({ id }, { toolName, reason, signal }, async () => 'delegated') as Promise<string>
    return { result, item: [...pending.values()].at(-1)! }
  }
  return {
    ask, pending, registrations,
    askUnknown: () => listeners.get('approval/request')!.call({}, { toolName: 'bash' }, async () => 'delegated'),
    disconnect() { generation = undefined; generationObservers.forEach(listener => listener()) },
    deleteFirst() { byId = { second: {} }; sessionObservers.forEach(listener => listener()) },
    dispose() { disposers.reverse().forEach(stop => stop()) },
  }
}

describe('session approval choices', () => {
  it('remembers the exact approved tool and reason only in the owning session', async () => {
    const fixture = setup()
    const first = fixture.ask()
    expect(first.item.allowsAlwaysAllow).toBe(true)
    await first.item.answerAlwaysAllow()
    expect(await first.result).toBe('allowed-once')
    expect(await fixture.ask().result).toBe('allowed-once')
    expect(fixture.pending.size).toBe(0)
    for (const args of [['second'], ['first', 'Different reason'], ['first', 'Escalate to danger-full-access', 'edit']] as const) {
      const another = fixture.ask(...args)
      expect(fixture.pending.size).toBe(1)
      await another.item.answer('rejected')
      expect(await another.result).toBe('rejected')
    }
    fixture.dispose()
  })

  it.each(['disconnect', 'deleteFirst'] as const)('clears remembered grants on %s', async (action) => {
    const fixture = setup()
    const first = fixture.ask()
    await first.item.answerAlwaysAllow()
    await first.result
    fixture[action]()
    const again = fixture.ask()
    expect(fixture.pending.size).toBe(1)
    await again.item.answer('rejected')
    expect(await again.result).toBe('rejected')
    fixture.dispose()
  })

  it('still offers a card after a one-time answer', async () => {
    const fixture = setup()
    const first = fixture.ask()
    await first.item.answer('allowed-once')
    await first.result
    const again = fixture.ask()
    expect(fixture.pending.size).toBe(1)
    await again.item.answer('rejected')
    expect(await again.result).toBe('rejected')
    fixture.dispose()
  })

  it('does not restore a remembered grant when an old card is answered after disconnect', async () => {
    const fixture = setup()
    const first = fixture.ask()
    fixture.disconnect()
    await first.item.answerAlwaysAllow()
    expect(await first.result).toBe('allowed-once')
    const again = fixture.ask()
    expect(fixture.pending.size).toBe(1)
    await again.item.answer('rejected')
    await again.result
    fixture.dispose()
  })

  it('fails closed for an unknown owner instead of delegating to a different session', async () => {
    const fixture = setup()
    expect(await fixture.askUnknown()).toBe('unavailable')
    expect(fixture.pending.size).toBe(0)
    fixture.dispose()
  })
})

describe('approval cards belong to the conversation stream', () => {
  it('shows every pending approval for this session and no cards belonging to another session', () => {
    const first = new PendingApproval('first' as never, { toolName: 'bash', reason: 'First command' })
    const parallel = new PendingApproval('first' as never, { toolName: 'bash', reason: 'Parallel command' })
    const second = new PendingApproval('second' as never, { toolName: 'bash', reason: 'Private second-session command' })
    const snapshot = new Map([first, parallel, second].map(item => [item.key, item]))
    const Stream = createApprovalStream({ getSnapshot: () => snapshot, subscribe: () => () => {} })
    const html = renderToStaticMarkup(createElement(Stream, {
      sessionId: 'first', renderSlot: () => null, t: (key: keyof typeof zh) => zh[key],
    } as never))
    expect(html).toContain('First command')
    expect(html).toContain('Parallel command')
    expect(html).not.toContain('Private second-session command')
    void first.answer('rejected')
    void parallel.answer('rejected')
    void second.answer('rejected')
  })

  it('registers the interactive card in the stream instead of the composer', () => {
    const fixture = setup()
    expect(fixture.registrations.map(value => value.name)).toEqual(['conversation.approval.stream'])
    fixture.dispose()
  })

  it('renders the approval stream after the active conversation view', () => {
    const props = {
      useConversationViews: (select: Function) => select([{ id: 'chat' }]),
      useStore: (select: Function) => select({ view: 'chat', draft: '' }),
      useSession: (select: Function) => select({ blank: false }),
      useConversation: (select: Function) => select({}),
      useInput: (select: Function) => select({ draft: '' }),
      inputActions: {}, actions: {},
      renderSlot: (name: string) => createElement('span', { 'data-stream-slot': name }),
    }
    const html = renderToStaticMarkup(createElement(ConversationSession, props as never))
    expect(html).toContain('data-stream-slot="conversation.approval.stream"')
    expect(html.indexOf('conversation.approval.stream')).toBeGreaterThan(html.indexOf('conversation.view'))
    expect(html).not.toContain('conversation.composer')
  })
})
