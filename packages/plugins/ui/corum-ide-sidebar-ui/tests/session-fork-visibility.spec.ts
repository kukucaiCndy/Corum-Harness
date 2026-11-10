import { describe, expect, it } from 'vitest'
import { isTaskSession } from '../src/client/session-visibility.ts'

/**
 * 可见性口径（2026-10-29 同批修复的第二层；main 源 `f7e59f5c`）：分叉子会话的 id 是
 * 宿主 mint 的 `session-<uuid>`（rc.3 `session-controller/src/commands.ts:272`），
 * 不带 `corum-task-` 前缀 ⇒ 旧过滤会让分叉成功后新会话从侧栏消失。本组钉住
 * 「分叉子会话可见、子 Agent 会话不可见」这两条边界。
 */
describe('分叉子会话在任务列表的可见性', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'session-x',
    displayTitle: 'x',
    updatedAt: 0,
    running: false,
    blank: false,
    ...over,
  }) as unknown as Parameters<typeof isTaskSession>[0]

  it('泳道会话可见（原有语义不变）', () => {
    expect(isTaskSession(row({ id: 'corum-task-a1b2c3d4' }))).toBe(true)
  })

  it('分叉子会话可见——即使 id 不带 corum-task- 前缀', () => {
    expect(isTaskSession(row({ id: 'session-9f1e-uuid', parentId: 'corum-task-a1b2c3d4' }))).toBe(true)
  })

  it('corum 自有 fork 泳道的子会话可见（corum-fork-* 带 parentId）', () => {
    expect(isTaskSession(row({ id: 'corum-fork-abc123', parentId: 'corum-task-a1b2c3d4' }))).toBe(true)
  })

  it('子 Agent 路由会话不可见（即使带 parentId）', () => {
    expect(isTaskSession(row({ id: 'session-sub', parentId: 'corum-task-a1b2c3d4', origin: 'subagent' }))).toBe(false)
  })

  it('既无泳道前缀也无 parentId 的会话不可见（无归属的官方 session-*）', () => {
    expect(isTaskSession(row({ id: 'session-plain' }))).toBe(false)
  })
})
