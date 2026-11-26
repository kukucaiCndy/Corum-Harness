/**
 * Git 面板开关状态的回归网（2026-11-26）。
 *
 * ## 为什么这条最需要测
 *
 * 开关状态是**跨槽共享**的：按钮在 `conversation.input.left`、面板在
 * `conversation.input.dock`，两者由不同 bundle 组装。这条链路已经踩过两个坑，
 * 都是「编译过、测试绿、真机崩」：
 *
 *   ① 用工厂闭包捕获服务实例 ⇒ 两个 bundle 各拿到不同的东西；
 *   ② `useSyncExternalStore(openState.subscribe, …)` 把原型方法当裸回调传出 ⇒
 *      `this` 丢失 ⇒ 私有字段 `#listeners` 抛
 *      `Cannot read properties of undefined`。
 *
 * ②正是本文件钉住的东西：**必须能脱离实例调用**。React 就是这么调用它们的。
 */
import { describe, expect, it, vi } from 'vitest'
import { GitPanelOpenService } from '../src/client/panel-open.ts'

describe('GitPanelOpenService', () => {
  it('默认全部关闭', () => {
    const svc = new GitPanelOpenService()
    expect(svc.isOpen('a')).toBe(false)
    expect([...svc.getSnapshot()]).toEqual([])
  })

  it('按会话独立：打开 A 不影响 B', () => {
    const svc = new GitPanelOpenService()
    svc.setOpen('a', true)
    expect(svc.isOpen('a')).toBe(true)
    expect(svc.isOpen('b')).toBe(false)
  })

  it('toggle 幂等往返', () => {
    const svc = new GitPanelOpenService()
    svc.toggle('a')
    expect(svc.isOpen('a')).toBe(true)
    svc.toggle('a')
    expect(svc.isOpen('a')).toBe(false)
  })

  it('重复 setOpen 同一值不通知（避免无谓重渲染）', () => {
    const svc = new GitPanelOpenService()
    const listener = vi.fn()
    svc.subscribe(listener)
    svc.setOpen('a', true)
    svc.setOpen('a', true)
    expect(listener).toHaveBeenCalledTimes(1)
    svc.setOpen('a', false)
    svc.setOpen('a', false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('快照换新引用（useSyncExternalStore 的相等判据依赖它）', () => {
    const svc = new GitPanelOpenService()
    const before = svc.getSnapshot()
    svc.setOpen('a', true)
    expect(svc.getSnapshot()).not.toBe(before)
  })

  it('退订后不再收到通知', () => {
    const svc = new GitPanelOpenService()
    const listener = vi.fn()
    const off = svc.subscribe(listener)
    svc.setOpen('a', true)
    off()
    svc.setOpen('b', true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 脱离实例调用也不丢 this（React 会这样调）', () => {
    const svc = new GitPanelOpenService()
    const { subscribe, getSnapshot, isOpen } = svc
    // 这三个成员一旦是原型普通方法，这里就会抛
    // `Cannot read properties of undefined (reading '#listeners')`。
    expect(() => subscribe(() => {})).not.toThrow()
    expect(getSnapshot()).toEqual(new Set())
    expect(isOpen('a')).toBe(false)
    svc.setOpen('a', true)
    expect(getSnapshot()).toEqual(new Set(['a']))
  })
})
