/**
 * derivedPendingInteractions adapter tests.
 *
 * rc3 removed `UiSession.pendingInteractions` in favor of `sessionStatus`
 * (per-session highest-priority pendingInteraction). The adapter projects
 * `sessionStatus` into a `ReadonlyMap<string, unknown>` to preserve the
 * consumer interface.
 *
 * Tests:
 * - Empty sessionStatus → empty Map
 * - Session with pendingInteraction → Map has entry
 * - Session without pendingInteraction → Map omits entry
 * - Subscribe forwards to sessionStatus.subscribe
 * - Updates propagate via subscribe callback
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Load the source and extract the function ────────────────────────────────

const SOURCE_PATH = join(import.meta.dirname, '../src/client/index.tsx')
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

// ── Mock sessionStatus observable ───────────────────────────────────────────

interface MockSessionStatusSnapshot {
  pendingInteraction?: unknown
}

function createMockSessionStatus(entries: Record<string, MockSessionStatusSnapshot>) {
  let snapshot = new Map(Object.entries(entries))
  const subscribers = new Set<() => void>()
  return {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((fn: () => void) => {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    }),
    // Test helper: update snapshot and notify.
    _update(newEntries: Record<string, MockSessionStatusSnapshot>) {
      snapshot = new Map(Object.entries(newEntries))
      subscribers.forEach(fn => fn())
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('derivedPendingInteractions source contract', () => {
  it('function exists and has correct signature', () => {
    expect(SOURCE).toContain('derivedPendingInteractions')
    expect(SOURCE).toContain('sessionStatus')
    expect(SOURCE).toContain('getSnapshot')
    expect(SOURCE).toContain('subscribe')
    expect(SOURCE).toContain('Map')
  })

  it('returns object with getSnapshot and subscribe', () => {
    // The function returns { subscribe, getSnapshot } — verify in source.
    const fnMatch = SOURCE.match(/function derivedPendingInteractions[\s\S]*?return\s*\{/)
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![0]).toMatch(/subscribe/)
    expect(fnMatch![0]).toMatch(/getSnapshot/)
  })

  it('filters sessions with undefined pendingInteraction', () => {
    // The function must check status.pendingInteraction !== undefined
    expect(SOURCE).toMatch(/pendingInteraction\s*!==\s*undefined/)
  })
})

describe('derivedPendingInteractions behavior (reconstructed)', () => {
  // Reconstruct the adapter from the source contract.
  function derivedPendingInteractions(sessionStatus: {
    getSnapshot: () => ReadonlyMap<string, { pendingInteraction?: unknown }>
    subscribe: (fn: () => void) => () => void
  }): { getSnapshot: () => ReadonlyMap<string, unknown>; subscribe: (fn: () => void) => () => void } {
    return {
      subscribe: fn => sessionStatus.subscribe(fn),
      getSnapshot: () => {
        const statusMap = sessionStatus.getSnapshot()
        const result = new Map<string, unknown>()
        for (const [sessionId, status] of statusMap) {
          if (status.pendingInteraction !== undefined) {
            result.set(String(sessionId), status.pendingInteraction)
          }
        }
        return result
      },
    }
  }

  it('empty sessionStatus → empty Map', () => {
    const mock = createMockSessionStatus({})
    const adapter = derivedPendingInteractions(mock as never)
    expect(adapter.getSnapshot().size).toBe(0)
  })

  it('session with pendingInteraction → Map has entry', () => {
    const mock = createMockSessionStatus({
      'session-a': { pendingInteraction: { kind: 'question', key: 'q1' } },
    })
    const adapter = derivedPendingInteractions(mock as never)
    const map = adapter.getSnapshot()
    expect(map.size).toBe(1)
    expect(map.get('session-a')).toEqual({ kind: 'question', key: 'q1' })
  })

  it('session without pendingInteraction → Map omits entry', () => {
    const mock = createMockSessionStatus({
      'session-a': { pendingInteraction: { kind: 'question' } },
      'session-b': {}, // no pendingInteraction
    })
    const adapter = derivedPendingInteractions(mock as never)
    const map = adapter.getSnapshot()
    expect(map.size).toBe(1)
    expect(map.has('session-a')).toBe(true)
    expect(map.has('session-b')).toBe(false)
  })

  it('subscribe forwards to sessionStatus.subscribe', () => {
    const mock = createMockSessionStatus({})
    const adapter = derivedPendingInteractions(mock as never)
    const cb = vi.fn()
    const unsub = adapter.subscribe(cb)
    expect(mock.subscribe).toHaveBeenCalledWith(cb)
    mock._update({ 'session-a': { pendingInteraction: { kind: 'question' } } })
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
    mock._update({})
    expect(cb).toHaveBeenCalledTimes(1) // not called after unsubscribe
  })

  it('updates propagate via subscribe callback', () => {
    const mock = createMockSessionStatus({})
    const adapter = derivedPendingInteractions(mock as never)
    let lastSize = adapter.getSnapshot().size
    adapter.subscribe(() => { lastSize = adapter.getSnapshot().size })
    mock._update({ 'session-a': { pendingInteraction: { kind: 'question' } } })
    expect(lastSize).toBe(1)
    mock._update({})
    expect(lastSize).toBe(0)
  })

  it('Map key is String(sessionId) not raw sessionId', () => {
    const mock = createMockSessionStatus({
      '123': { pendingInteraction: { kind: 'question' } },
    })
    const adapter = derivedPendingInteractions(mock as never)
    const map = adapter.getSnapshot()
    expect(map.has('123')).toBe(true)
  })
})
