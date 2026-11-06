import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createScope, scopeOf } from '../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/scope.js'
import { apply } from '../src/client/index.ts'

describe('Remote event statistics preserve approval ownership', () => {
  it('forwards the exact scoped carrier, request, continuation, and result for two sessions', async () => {
    const listeners = new Map<string, Function>()
    const remote = {
      $mount: async () => async () => {},
      $on(event: string, listener: Function) {
        listeners.set(event, listener)
        return () => { listeners.delete(event) }
      },
    }
    const ctx = new Context()
    ctx.reflect.provide('remote', remote)
    const dispose = await apply(ctx)
    const first = createScope(ctx, 'first-session' as never)
    const second = createScope(ctx, 'second-session' as never)
    const next = async () => 'unavailable'
    const requests = [{ toolName: 'bash', reason: 'first' }, { toolName: 'bash', reason: 'second' }]
    const received: unknown[] = []
    const remove = remote.$on('approval/request', function (this: Context, request: unknown, continuation: unknown) {
      received.push([scopeOf(this), this, request, continuation])
      return Promise.resolve('allowed-once')
    })
    try {
      const listener = listeners.get('approval/request')!
      expect(await listener.call(first.ctx, requests[0], next)).toBe('allowed-once')
      expect(await listener.call(second.ctx, requests[1], next)).toBe('allowed-once')
      expect(received).toEqual([
        ['first-session', first.ctx, requests[0], next],
        ['second-session', second.ctx, requests[1], next],
      ])
      remove()
      expect(listeners.has('approval/request')).toBe(false)
    } finally {
      await dispose()
      await first.fiber.dispose()
      await second.fiber.dispose()
    }
  })
})
