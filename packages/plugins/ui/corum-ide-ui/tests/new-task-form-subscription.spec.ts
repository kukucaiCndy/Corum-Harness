import { describe, expect, it } from 'vitest'
import { LayoutController, type GridActions } from '../src/client/service.ts'

function grid() {
  const listeners = new Set<() => void>()
  let pending = false
  const actions = {
    openNewTaskForm: () => { if (!listeners.size) pending = true; else listeners.forEach(listener => listener()) },
    onOpenNewTaskForm: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    consumePendingNewTaskForm: () => { const value = pending; pending = false; return value },
  } as GridActions
  return { actions, listeners }
}
function subscribe(layout: LayoutController, listener: () => void): () => void {
  // 与 consumer 的能力收窄同形：旧实现没有该入口，会静默丢失冷启动订阅。
  return (layout as LayoutController & { onOpenNewTaskForm?: (listener: () => void) => () => void }).onOpenNewTaskForm?.(listener) ?? (() => {})
}

describe('新建表单冷启动订阅', () => {
  it('Hero先挂载、父AppFrame后attach，顶部打开信号无需Hero重挂载即可送达', () => {
    const layout = new LayoutController(), frame = grid()
    let opened = 0
    const off = subscribe(layout, () => { opened++ })
    layout.attachGrid(frame.actions)
    layout.openNewTaskForm()
    expect(opened).toBe(1)
    off(); layout.openNewTaskForm()
    expect(opened).toBe(1); expect(frame.listeners.size).toBe(0)
  })
  it('attach前取消订阅不会留下ghost listener，attach后取消也正常解除', () => {
    const layout = new LayoutController(), frame = grid()
    let opened = 0
    const off = subscribe(layout, () => { opened++ }); off()
    layout.attachGrid(frame.actions); layout.openNewTaskForm()
    expect(opened).toBe(0); expect(frame.listeners.size).toBe(0)
  })
  it('已attach时先打开再挂载仍由现有pending认领，取消后再次打开仍保留pending', () => {
    const layout = new LayoutController(), frame = grid()
    layout.attachGrid(frame.actions); layout.openNewTaskForm()
    expect(layout.gridActions()!.consumePendingNewTaskForm()).toBe(true)
    expect(layout.gridActions()!.consumePendingNewTaskForm()).toBe(false)
    let opened = 0
    const off = subscribe(layout, () => { opened++ })
    layout.openNewTaskForm(); expect(opened).toBe(1)
    off(); layout.openNewTaskForm()
    expect(opened).toBe(1); expect(layout.gridActions()!.consumePendingNewTaskForm()).toBe(true)
  })
})
