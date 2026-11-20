import { describe, expect, it } from 'vitest'
import { isChatSessionId, isTaskSession } from '../src/client/session-visibility.ts'

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

  /**
   * 回归断言（2026-11-23 撤回）：三期 merge `551d76d` 曾把 `origin === 'subagent'`
   * 纳入侧栏过滤（子会话行 + 点击进分栏），导致侧栏突然多出大量子 Agent 会话
   * （用户报障）。裁定：子 Agent 会话**不进侧栏列表**，查看入口在编排卡 /
   * 子卡 / 会话条。此断言钉住「侧栏过滤口径 = isTaskSession || isChatSessionId」，
   * 任何重新纳入 subagent 的改动都会在这里变红。
   */
  it('回归：子 Agent 路由会话不进侧栏列表（过滤口径 = isTaskSession || isChatSessionId）', () => {
    const subagent = row({ id: 'session-sub-2', parentId: 'corum-task-a1b2c3d4', origin: 'subagent' })
    // 侧栏可见判据（SessionsPane allRows 的 filter 原文）。
    const visible = (r: ReturnType<typeof row>) => isTaskSession(r) || isChatSessionId(r.id)
    expect(visible(subagent)).toBe(false)
    // 对照：同一判据下任务会话 / 分叉子会话 / 咨询会话仍然可见（本回归不误伤它们）。
    expect(visible(row({ id: 'corum-task-a1b2c3d4' }))).toBe(true)
    expect(visible(row({ id: 'session-9f1e-uuid', parentId: 'corum-task-a1b2c3d4' }))).toBe(true)
    expect(visible(row({ id: 'corum-chat-abc12345' }))).toBe(true)
  })

  it('既无泳道前缀也无 parentId 的会话不可见（无归属的官方 session-*）', () => {
    expect(isTaskSession(row({ id: 'session-plain' }))).toBe(false)
  })
})
