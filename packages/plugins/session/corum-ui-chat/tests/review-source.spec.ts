/**
 * 回归测试：P0-1「全部保留」不生效。
 *
 * 根因：`review-source.ts` 的 `refresh()` 投影时丢弃 host 的 `file.hash`，
 * 导致 `keepAll`/`keepFile` 的 `seen.set` 守卫恒不命中，文件每次 refresh 重现。
 *
 * 测试策略：mock 掉 ConnectionHandle（只实现 `rpc.call`）和 SessionEventSource
 * （只实现 `subscribe`），直接驱动 `createReviewSource` 的内部 `refresh` 逻辑。
 */
import { describe, it, expect, vi } from 'vitest'
import { createReviewSource } from '../src/client/chat/review-source.ts'

// ── mock 工具 ──────────────────────────────────────────────────────

/** 一次 host 快照（`corumReview/snapshot` 响应）。 */
interface SnapshotValue {
  workspace: string | null
  roundIndex: number
  files: { path: string; added: number; removed: number; hash: string }[]
}

/** 构造一个可编程的 ConnectionHandle mock：每次 rpc.call 返回预设快照。 */
function makeMockConnection(snapshots: SnapshotValue[]) {
  let idx = 0
  const rpc = {
    call: vi.fn(async (_scope: string, method: string) => {
      if (method === 'corumReview/recoveries') return { ok: true, value: [] }
      const snap = snapshots[idx] ?? snapshots[snapshots.length - 1]!
      idx++
      return { ok: true, value: snap }
    }),
  }
  // createReviewSource 只用到 connection.rpc.call —— 其余字段不给也行（TS 类型上
  // 是必填的，但运行时不会访问；测试里做一层 as 断言即可）。
  return { rpc } as unknown as Parameters<typeof createReviewSource>[1]
}

/** 构造一个 SessionEventSource mock：subscribe 返回空 unsubscribe，不自动触发 refresh。 */
function makeMockEventSource() {
  const listeners = new Set<() => void>()
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  const getSnapshot = vi.fn(() => ({ entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }))
  return { subscribe, getSnapshot, listeners } as unknown as Parameters<typeof createReviewSource>[2]
}

/** 等一个微任务，让 createReviewSource 内部的 `void refresh()` 跑完。 */
function flush() {
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

// ── 测试用例 ────────────────────────────────────────────────────────

describe('review-source — keepAll / keepFile 内容哈希判定', () => {

  // ── a. 回归用例：keepAll 后相同快照 → 文件不再出现 ──────────────
  it('keepAll() 后相同快照 refresh → 文件不再出现（回归）', async () => {
    const file = { path: 'src/a.ts', added: 3, removed: 1, hash: 'abc123' }
    const snapshots: SnapshotValue[] = [
      { workspace: '/ws', roundIndex: 1, files: [file] },
    ]
    const conn = makeMockConnection(snapshots)
    const eventSrc = makeMockEventSource()
    const source = createReviewSource('session-1', conn, eventSrc)

    // 等初始 refresh 跑完。
    await flush()

    // 初始：文件出现。
    expect(source.getSnapshot().files).toHaveLength(1)
    expect(source.getSnapshot().files[0]!.path).toBe('src/a.ts')
    // 断言 hash 被带出来了（这是 bug 的核心：投影时丢弃了 hash）。
    expect(source.getSnapshot().files[0]!.hash).toBe('abc123')

    // 「全部保留」。
    source.keepAll()
    expect(source.getSnapshot().files).toHaveLength(0)

    // 再触发一次 refresh（通过 eventSource 的 subscribe 回调，模拟写入推进 seq）。
    for (const listener of eventSrc.listeners) listener()
    await flush()

    // 关键断言：相同 hash → seen 命中 → 文件不再出现。
    expect(source.getSnapshot().files).toHaveLength(0)
  })

  // ── b. 变更重现：keepAll 后同一 path 换 hash → 文件重新出现 ─────
  it('keepAll() 后同一 path 换 hash → 文件重新出现', async () => {
    const file = { path: 'src/a.ts', added: 3, removed: 1, hash: 'abc123' }
    const fileChanged = { path: 'src/a.ts', added: 5, removed: 2, hash: 'def456' }
    const snapshots: SnapshotValue[] = [
      { workspace: '/ws', roundIndex: 1, files: [file] },
      { workspace: '/ws', roundIndex: 1, files: [fileChanged] }, // 第二次 refresh，hash 变了
    ]
    const conn = makeMockConnection(snapshots)
    const eventSrc = makeMockEventSource()
    const source = createReviewSource('session-1', conn, eventSrc)

    await flush()

    expect(source.getSnapshot().files).toHaveLength(1)
    expect(source.getSnapshot().files[0]!.hash).toBe('abc123')

    source.keepAll()
    expect(source.getSnapshot().files).toHaveLength(0)

    // 再触发 refresh（hash 变了）。
    for (const listener of eventSrc.listeners) listener()
    await flush()

    // 关键断言：hash 变了 → seen 不命中 → 文件重新出现。
    expect(source.getSnapshot().files).toHaveLength(1)
    expect(source.getSnapshot().files[0]!.hash).toBe('def456')
  })

  // ── c. keepFile 单文件版本 — 相同 hash ──────────────────────────
  it('keepFile(path) 后相同 hash refresh → 该文件不再出现', async () => {
    const fileA = { path: 'src/a.ts', added: 3, removed: 1, hash: 'aaa' }
    const fileB = { path: 'src/b.ts', added: 2, removed: 0, hash: 'bbb' }
    const snapshots: SnapshotValue[] = [
      { workspace: '/ws', roundIndex: 1, files: [fileA, fileB] },
    ]
    const conn = makeMockConnection(snapshots)
    const eventSrc = makeMockEventSource()
    const source = createReviewSource('session-1', conn, eventSrc)

    await flush()

    expect(source.getSnapshot().files).toHaveLength(2)

    // 保留 a.ts。
    source.keepFile('src/a.ts')
    expect(source.getSnapshot().files).toHaveLength(1)
    expect(source.getSnapshot().files[0]!.path).toBe('src/b.ts')

    // 再触发 refresh（hash 不变）。
    for (const listener of eventSrc.listeners) listener()
    await flush()

    // a.ts 仍被 seen 拦截；b.ts 仍在。
    expect(source.getSnapshot().files).toHaveLength(1)
    expect(source.getSnapshot().files[0]!.path).toBe('src/b.ts')
  })

  // ── c. keepFile 单文件版本 — 换 hash ────────────────────────────
  it('keepFile(path) 后同一 path 换 hash → 该文件重新出现', async () => {
    const fileA = { path: 'src/a.ts', added: 3, removed: 1, hash: 'aaa' }
    const fileB = { path: 'src/b.ts', added: 2, removed: 0, hash: 'bbb' }
    const fileAChanged = { path: 'src/a.ts', added: 5, removed: 2, hash: 'aaa-new' }
    const snapshots: SnapshotValue[] = [
      { workspace: '/ws', roundIndex: 1, files: [fileA, fileB] },
      { workspace: '/ws', roundIndex: 1, files: [fileAChanged, fileB] },
    ]
    const conn = makeMockConnection(snapshots)
    const eventSrc = makeMockEventSource()
    const source = createReviewSource('session-1', conn, eventSrc)

    await flush()

    expect(source.getSnapshot().files).toHaveLength(2)

    source.keepFile('src/a.ts')
    expect(source.getSnapshot().files).toHaveLength(1)
    expect(source.getSnapshot().files[0]!.path).toBe('src/b.ts')

    // 再触发 refresh（a.ts 的 hash 变了）。
    for (const listener of eventSrc.listeners) listener()
    await flush()

    // a.ts 重新出现；b.ts 仍在。
    expect(source.getSnapshot().files).toHaveLength(2)
    const paths = source.getSnapshot().files.map(f => f.path).sort()
    expect(paths).toEqual(['src/a.ts', 'src/b.ts'])
    const aAgain = source.getSnapshot().files.find(f => f.path === 'src/a.ts')!
    expect(aAgain.hash).toBe('aaa-new')
  })
})

describe('review-source — 事件节流（2026-09-28 卡顿修复）', () => {
  it('★ 连续 50 次事件 ⇒ 最多「立即 1 次 + 尾沿 1 次」，而不是 50 次 RPC', async () => {
    vi.useFakeTimers()
    try {
      const file = { path: 'src/a.ts', added: 1, removed: 0, hash: 'h1' }
      const conn = makeMockConnection([{ workspace: '/ws', roundIndex: 1, files: [file] }])
      const eventSrc = makeMockEventSource()
      createReviewSource('session-1', conn, eventSrc)
      await vi.advanceTimersByTimeAsync(0)
      const baseline = conn.rpc.call.mock.calls.length

      // 一个忙回合里事件会成百上千次到达（未节流时每次都刷新 ⇒ 实测 599 次 snapshot）。
      for (let i = 0; i < 50; i += 1) for (const listener of eventSrc.listeners) listener()
      await vi.advanceTimersByTimeAsync(0)
      expect(conn.rpc.call.mock.calls.length - baseline).toBeLessThanOrEqual(1)

      // 尾沿：窗口结束后仍会拉到最后一次变更（不丢尾）。
      await vi.advanceTimersByTimeAsync(700)
      expect(conn.rpc.call.mock.calls.length - baseline).toBeLessThanOrEqual(2)
      expect(conn.rpc.call.mock.calls.length).toBeGreaterThan(baseline)
    } finally {
      vi.useRealTimers()
    }
  })
})
