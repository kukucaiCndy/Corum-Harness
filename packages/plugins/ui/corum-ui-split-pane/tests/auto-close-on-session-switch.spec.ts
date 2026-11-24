/**
 * 分栏「切会话自动收起」的行为契约。
 *
 * 用户口径（2026-11）：**切换 session 时，如果 session 分栏已启动，就要自动关闭**
 * ——别的 session 对应的侧栏内容不确定，需要用户在新会话里再次触发。不收起会让
 * 上一会话的子 Agent / 对读内容留在那里冒充当前会话的侧栏。
 *
 * 钉住三条判据（都是实测会踩的分叉点）：
 *   ① 主选择**换成另一个会话** ⇒ 收起一次；
 *   ② 主选择**广播但值没变**（openSession 同值写入 / 无关重放）⇒ 不收（否则刚打开
 *      的分栏会被一次空广播立刻收掉）；
 *   ③ 主选择**被清空**（新建任务 / 关会话）⇒ 收起（此时没有会话上下文可言）。
 */
import { describe, expect, it, vi } from 'vitest'
import { autoCloseSplitPaneOnSessionSwitch, type MainSelectionFace } from '../src/client/face.ts'

/** 手搓一个可写的主选择源（模拟 corumNavigation.selection 的 snapshot store）。 */
function selectionStub(initial: string | undefined): MainSelectionFace & {
  set: (sessionId: string | undefined) => void
} {
  let snapshot: { sessionId?: string } = initial === undefined ? {} : { sessionId: initial }
  const listeners = new Set<() => void>()
  return {
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    getSnapshot: () => snapshot,
    set: (sessionId) => {
      snapshot = sessionId === undefined ? {} : { sessionId }
      for (const fn of listeners) fn()
    },
  }
}

describe('autoCloseSplitPaneOnSessionSwitch', () => {
  it('换成另一个会话时收起分栏', () => {
    const selection = selectionStub('corum-task-a')
    const close = vi.fn()
    const off = autoCloseSplitPaneOnSessionSwitch(selection, close)

    expect(close).not.toHaveBeenCalled()
    selection.set('corum-task-b')
    expect(close).toHaveBeenCalledTimes(1)
    off()
  })

  it('广播但值未变时不收起（同值写入不得误伤刚打开的分栏）', () => {
    const selection = selectionStub('corum-task-a')
    const close = vi.fn()
    const off = autoCloseSplitPaneOnSessionSwitch(selection, close)

    selection.set('corum-task-a')
    selection.set('corum-task-a')
    expect(close).not.toHaveBeenCalled()
    off()
  })

  it('选择被清空时同样收起（新模式无会话上下文）', () => {
    const selection = selectionStub('corum-task-a')
    const close = vi.fn()
    const off = autoCloseSplitPaneOnSessionSwitch(selection, close)

    selection.set(undefined)
    expect(close).toHaveBeenCalledTimes(1)
    off()
  })

  it('多个会话连续切换时每个真变化各收一次', () => {
    const selection = selectionStub('corum-task-a')
    const close = vi.fn()
    const off = autoCloseSplitPaneOnSessionSwitch(selection, close)

    selection.set('corum-task-b')
    selection.set('corum-task-b')
    selection.set('corum-task-c')
    expect(close).toHaveBeenCalledTimes(2)
    off()
  })

  it('退订后不再响应（fiber dispose 后的迟到广播不得再收栏）', () => {
    const selection = selectionStub('corum-task-a')
    const close = vi.fn()
    const off = autoCloseSplitPaneOnSessionSwitch(selection, close)

    off()
    selection.set('corum-task-b')
    expect(close).not.toHaveBeenCalled()
  })
})
