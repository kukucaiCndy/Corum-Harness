import { describe, it, expect, vi } from 'vitest'
import { createReviewSource } from '../src/client/chat/review-source.ts'

describe('撤销恢复数据源', () => {
  it('全部撤销如实报告轮次失效，并且只发送未保留文件', async () => {
    const rpc = { call: vi.fn(async (_scope: string, method: string, input: { args: Record<string, unknown> }) => {
      if (method === 'corumReview/recoveries') return { ok: true, value: [] }
      if (method === 'corumReview/rollback') {
        expect(input.args.paths).toEqual(['a.txt'])
        expect(input.args.operationId).toEqual(expect.any(String))
        return { ok: true, value: { ok: false, restored: 0, failed: 0, message: '轮次已失效' } }
      }
      return { ok: true, value: { workspace: '/ws', roundIndex: 1, files: ['a.txt', 'kept.txt'].map(path => ({ path, hash: path, added: 1, removed: 0 })) } }
    }) }
    const source = createReviewSource('parent', { rpc } as unknown as Parameters<typeof createReviewSource>[1], { subscribe: () => () => {} } as unknown as Parameters<typeof createReviewSource>[2])
    await new Promise(resolve => setTimeout(resolve, 0))
    source.keepFile('kept.txt')
    expect(await source.revertAll()).toMatchObject({ ok: false, reverted: 0, failed: 1, message: '轮次已失效' })
  })

  it('改动列表为空仍发布持久化恢复入口，按所属会话恢复并刷新列表', async () => {
    let restored = false
    const rpc = { call: vi.fn(async (_scope: string, method: string, input: { args: Record<string, unknown> }) => {
      if (method === 'corumReview/recoveries') return { ok: true, value: restored ? [] : [{ id: 'recovery-1', sessionId: 'child', workspace: '/ws', createdAt: 1, paths: ['a.txt'] }] }
      if (method === 'corumReview/restoreRollback') {
        expect(input.args).toEqual({ sessionId: 'child', recoveryId: 'recovery-1' })
        restored = true
        return { ok: true, value: { ok: true, restored: 1, failed: 0 } }
      }
      return { ok: true, value: { workspace: '/ws', roundIndex: 1, files: restored && input.args.sessionId === 'child' ? [{ path: 'a.txt', hash: 'new', added: 1, removed: 0 }] : [] } }
    }) }
    const source = createReviewSource('parent', { rpc } as unknown as Parameters<typeof createReviewSource>[1], { subscribe: () => () => {} } as unknown as Parameters<typeof createReviewSource>[2])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(source.getSnapshot().files).toHaveLength(0)
    expect(source.recoveries.getSnapshot()).toHaveLength(1)
    const listener = vi.fn(); source.recoveries.subscribe(listener)
    const result = await source.restoreRollback(source.recoveries.getSnapshot()[0]!)
    expect(result.ok).toBe(true)
    expect(source.recoveries.getSnapshot()).toEqual([])
    expect(source.getSnapshot().files.map(file => file.path)).toEqual(['a.txt'])
    expect(listener).toHaveBeenCalled()
  })
})
