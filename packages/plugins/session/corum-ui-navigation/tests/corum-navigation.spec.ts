/**
 * corum-navigation real-service spec — reference lifecycle and selection semantics.
 *
 * This is a **real service test**: it creates a genuine cordis `Context`,
 * provides a mock `ISessions` (real interface, fake retain/release tracking),
 * registers the real navigation plugin via its `apply(ctx)` entry, and drives
 * `ctx.corumNavigation.openSession/clearSelection/dispose` directly.
 *
 * What is tested (behaviorally, not by re-implementing the algorithm):
 * - open A → selection reflects A, 1 live reference
 * - open A → B → selection reflects B, A released, only 1 live reference
 * - rapid switching A→B→C→D → only D live, A/B/C released
 * - clearSelection → selection empty, reference released
 * - dispose (context destroy) → held reference released
 * - retain throw → existing selection not corrupted (previous reference stays live)
 *
 * The mock `ISessions` implements `retain` + `release` tracking with real
 * `SessionReference` objects (matching the official interface). No algorithm
 * is duplicated — we assert on the observable behavior of the real service.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  ISessions,
  SessionReference,
  SessionRetainOptions,
  SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

// ── Mock ISessions (real interface, fake retain/release tracking) ───────────

interface MockRefRecord {
  sessionId: SessionId
  released: boolean
  releaseCount: number
}

function createMockSessions() {
  const refs: MockRefRecord[] = []

  const retain = vi.fn((target: SessionTarget, _options: SessionRetainOptions): SessionReference => {
    const id = String(target) as SessionId
    const record: MockRefRecord = { sessionId: id, released: false, releaseCount: 0 }
    refs.push(record)
    return {
      sessionId: id,
      binding: {} as never,
      ready: Promise.resolve({} as never),
      release(): void {
        record.released = true
        record.releaseCount += 1
      },
    }
  })

  // Minimal ISessions surface — only what corumNavigation uses (retain).
  // The other members are stubbed to satisfy the interface.
  const mock = {
    retain,
    list: {} as ObservableSnapshot<never>,
    using: vi.fn(),
    retainInfo: vi.fn(),
    searchResultLimit: 10,
    create: vi.fn(),
  } as unknown as ISessions

  return Object.assign(mock, {
    retain,
    allRefs: () => refs,
    liveRefs: () => refs.filter(r => !r.released),
    releasedRefs: () => refs.filter(r => r.released),
  })
}

// ── Setup: real cordis Context + real navigation plugin ─────────────────────

async function setupNavigation() {
  const ctx = new Context()
  const mockSessions = createMockSessions()
  // Provide the mock sessions service so the navigation plugin's
  // `inject = ['sessions']` dependency is satisfied.
  ctx.provide('sessions', mockSessions)

  // Register the real navigation plugin. applyCorumSessionNavigation calls
  // `ctx.plugin(CorumSessionNavigationServiceImpl, ctx.sessions)` which is
  // async (returns a Fiber). We call it, then flush the microtask queue to
  // let the service register before we read ctx.corumNavigation.
  const { applyCorumSessionNavigation } = await import('../src/client/corum-navigation.ts')
  // We need the fiber returned by ctx.plugin to dispose it later.
  // applyCorumSessionNavigation doesn't return it, so we capture it by
  // intercepting ctx.plugin.
  let fiber: { dispose: () => Promise<void> } | undefined
  const origPlugin = ctx.plugin.bind(ctx)
  ctx.plugin = ((plugin: never, ...args: never[]) => {
    const f = origPlugin(plugin as unknown as Parameters<typeof origPlugin>[0], ...(args as unknown[]))
    fiber = f as { dispose: () => Promise<void> }
    return f
  }) as typeof ctx.plugin
  applyCorumSessionNavigation(ctx)
  // Flush microtasks: ctx.plugin's fiber resolves the service registration.
  await new Promise(r => setTimeout(r, 0))

  return { ctx, mockSessions, nav: ctx.corumNavigation, fiber: fiber! }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('corum-navigation real service', () => {
  it('openSession retains a reference and sets selection', async () => {
    const { nav, mockSessions } = await setupNavigation()

    nav.openSession('session-a' as SessionTarget)

    const snapshot = nav.selection.getSnapshot()
    expect(snapshot.sessionId).toBe('session-a')
    expect(mockSessions.allRefs()).toHaveLength(1)
    expect(mockSessions.liveRefs()).toHaveLength(1)
  })

  it('open A → B releases old reference, only 1 live', async () => {
    const { nav, mockSessions } = await setupNavigation()

    nav.openSession('session-a' as SessionTarget)
    nav.openSession('session-b' as SessionTarget)

    const snapshot = nav.selection.getSnapshot()
    expect(snapshot.sessionId).toBe('session-b')
    expect(mockSessions.allRefs()).toHaveLength(2)
    expect(mockSessions.liveRefs()).toHaveLength(1)
    expect(mockSessions.liveRefs()[0]!.sessionId).toBe('session-b')
    expect(mockSessions.releasedRefs()[0]!.sessionId).toBe('session-a')
  })

  it('rapid switching A→B→C→D releases all but last', async () => {
    const { nav, mockSessions } = await setupNavigation()

    for (const id of ['a', 'b', 'c', 'd']) {
      nav.openSession(id as SessionTarget)
    }

    const snapshot = nav.selection.getSnapshot()
    expect(snapshot.sessionId).toBe('d')
    expect(mockSessions.allRefs()).toHaveLength(4)
    expect(mockSessions.liveRefs()).toHaveLength(1)
    expect(mockSessions.liveRefs()[0]!.sessionId).toBe('d')
    expect(mockSessions.releasedRefs()).toHaveLength(3)
  })

  it('clearSelection releases reference and empties selection', async () => {
    const { nav, mockSessions } = await setupNavigation()

    nav.openSession('session-a' as SessionTarget)
    expect(mockSessions.liveRefs()).toHaveLength(1)

    nav.clearSelection()

    const snapshot = nav.selection.getSnapshot()
    expect(snapshot.sessionId).toBeUndefined()
    expect(mockSessions.liveRefs()).toHaveLength(0)
    expect(mockSessions.releasedRefs()).toHaveLength(1)
  })

  it('dispose (fiber teardown) releases held reference', async () => {
    const { nav, mockSessions, fiber } = await setupNavigation()

    nav.openSession('session-a' as SessionTarget)
    expect(mockSessions.liveRefs()).toHaveLength(1)

    // Dispose the plugin fiber — this triggers the service's effect teardown
    // which releases the held main reference.
    await fiber.dispose()

    expect(mockSessions.liveRefs()).toHaveLength(0)
    expect(mockSessions.releasedRefs()).toHaveLength(1)
  })

  it('retain throw does not corrupt existing selection', async () => {
    const { nav, mockSessions } = await setupNavigation()

    nav.openSession('session-a' as SessionTarget)

    // Make the next retain call throw.
    mockSessions.retain.mockImplementationOnce(() => {
      throw new Error('retain failed')
    })

    // openSession should propagate the throw (the service does not try/catch).
    expect(() => nav.openSession('session-b' as SessionTarget)).toThrow('retain failed')

    // The previous selection is unchanged — session-a is still selected and live.
    const snapshot = nav.selection.getSnapshot()
    expect(snapshot.sessionId).toBe('session-a')
    expect(mockSessions.liveRefs()).toHaveLength(1)
    expect(mockSessions.liveRefs()[0]!.sessionId).toBe('session-a')
  })

  it('selection observable notifies subscribers on change', async () => {
    const { nav } = await setupNavigation()
    const seen: (string | undefined)[] = []
    nav.selection.subscribe(() => {
      seen.push(nav.selection.getSnapshot().sessionId)
    })

    nav.openSession('session-a' as SessionTarget)
    nav.openSession('session-b' as SessionTarget)
    nav.clearSelection()

    // At least the transitions should have been observed.
    expect(seen).toContain('session-a')
    expect(seen).toContain('session-b')
    expect(seen).toContain(undefined)
  })
})
