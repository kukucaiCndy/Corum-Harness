/**
 * LayoutController — 「新建任务表单」信号的服务层 pending listener 缓冲测试。
 *
 * 钉死镜像 plugin-manager 的缓冲模式（service.ts #pendingNewTaskListeners）：
 *   ① attachGrid 前注册的 listener → 缓冲进 Set，不丢失；
 *   ② attachGrid 后缓冲的 listener 补订阅进 grid（grid.onOpenNewTaskForm 被调）；
 *   ③ consumePendingNewTaskForm 在 grid 未 attach 时返回 false（无 pending 可能）；
 *   ④ consumePendingNewTaskForm 在 grid attach 后委托 grid。
 *
 * 根因背景：cordis 装配竞态下 ctx.get('layout').gridActions() 取不到 → 监听器
 * 永不注册 + pending 永不认领（+号失效，CMD+R 刷新可恢复）。服务层缓冲兜底。
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '../src/client/service.ts'
import type { GridActions } from '../src/client/service.ts'

/**
 * 造一个 mock GridActions，只关心 onOpenNewTaskForm / consumePendingNewTaskForm。
 * 其余方法用 no-op 占位（LayoutController 只通过 attachGrid 采纳，不逐个调）。
 */
function mockGrid(onOpenNewTaskForm: (l: () => void) => () => void, consumePendingNewTaskForm: () => boolean): GridActions {
  return {
    setRegionHidden: () => {},
    closeRegion: () => {},
    showRegion: () => {},
    toggleRegion: () => {},
    resetLayout: () => {},
    toggleSidebar: () => {},
    openNewTaskForm: () => {},
    onOpenNewTaskForm,
    consumePendingNewTaskForm,
    openPluginManager: () => {},
    onOpenPluginManager: () => () => {},
    openSplitPane: () => {},
    onOpenSplitPane: () => () => {},
    consumePendingSplitPane: () => null,
    closeSplitPane: () => {},
    isInGrid: () => false,
    hiddenSlotsSnapshot: () => [],
    onGridChange: () => () => {},
  } as GridActions
}

describe('LayoutController — onOpenNewTaskForm 服务层 pending 缓冲', () => {
  it('★attachGrid 前注册 listener → 缓冲（不调 grid，不丢）', () => {
    const ctrl = new LayoutController()
    const gridOnOpen = vi.fn()
    const listener = vi.fn()

    // grid 未 attach 时调 onOpenNewTaskForm
    const off = ctrl.onOpenNewTaskForm(listener)

    // grid 还没有，所以 gridOnOpen 不应被调
    expect(gridOnOpen).not.toHaveBeenCalled()
    // listener 也不应被调（没有 pending 触发）
    expect(listener).not.toHaveBeenCalled()

    // 退订有效
    off()
  })

  it('★attachGrid 后缓冲的 listener 补订阅进 grid', () => {
    const ctrl = new LayoutController()
    const gridOnOpen = vi.fn().mockReturnValue(() => {})
    const listener = vi.fn()

    // ① attachGrid 前注册（缓冲）
    ctrl.onOpenNewTaskForm(listener)

    // ② attachGrid —— 缓冲的 listener 应被补订阅进 grid
    ctrl.attachGrid(mockGrid(gridOnOpen, () => false))

    expect(gridOnOpen).toHaveBeenCalledTimes(1)
    expect(gridOnOpen).toHaveBeenCalledWith(listener)
  })

  it('★attachGrid 后新注册的 listener 直连 grid（不再缓冲）', () => {
    const ctrl = new LayoutController()
    const gridOnOpen = vi.fn().mockReturnValue(() => {})
    const listener = vi.fn()

    ctrl.attachGrid(mockGrid(gridOnOpen, () => false))
    ctrl.onOpenNewTaskForm(listener)

    expect(gridOnOpen).toHaveBeenCalledTimes(1)
    expect(gridOnOpen).toHaveBeenCalledWith(listener)
  })

  it('★consumePendingNewTaskForm 在 grid 未 attach 时返回 false', () => {
    const ctrl = new LayoutController()
    expect(ctrl.consumePendingNewTaskForm()).toBe(false)
  })

  it('★consumePendingNewTaskForm 在 grid attach 后委托 grid', () => {
    const ctrl = new LayoutController()
    const consume = vi.fn().mockReturnValue(true)
    ctrl.attachGrid(mockGrid(() => () => {}, consume))

    expect(ctrl.consumePendingNewTaskForm()).toBe(true)
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('缓冲的 listener 在 attachGrid 前退订 → attachGrid 后不补订阅', () => {
    const ctrl = new LayoutController()
    const gridOnOpen = vi.fn().mockReturnValue(() => {})
    const listener = vi.fn()

    // ① 注册后立即退订（仍在缓冲阶段）
    const off = ctrl.onOpenNewTaskForm(listener)
    off()

    // ② attachGrid —— 退订的 listener 不应被补订阅
    ctrl.attachGrid(mockGrid(gridOnOpen, () => false))

    expect(gridOnOpen).not.toHaveBeenCalled()
  })

  it('多个 listener 在 attachGrid 前注册 → 全部缓冲 → attachGrid 后全部补订阅', () => {
    const ctrl = new LayoutController()
    const gridOnOpen = vi.fn().mockReturnValue(() => {})
    const l1 = vi.fn()
    const l2 = vi.fn()

    ctrl.onOpenNewTaskForm(l1)
    ctrl.onOpenNewTaskForm(l2)

    ctrl.attachGrid(mockGrid(gridOnOpen, () => false))

    expect(gridOnOpen).toHaveBeenCalledTimes(2)
    expect(gridOnOpen).toHaveBeenNthCalledWith(1, l1)
    expect(gridOnOpen).toHaveBeenNthCalledWith(2, l2)
  })

  it('attachGrid 后 #pendingNewTaskListeners Set 清空（再 attach 不重复补订阅）', () => {
    const ctrl = new LayoutController()
    const gridOnOpen = vi.fn().mockReturnValue(() => {})
    const listener = vi.fn()

    ctrl.onOpenNewTaskForm(listener)
    ctrl.attachGrid(mockGrid(gridOnOpen, () => false))
    expect(gridOnOpen).toHaveBeenCalledTimes(1)

    // 第二次 attachGrid（不应触发——Set 已清）
    ctrl.attachGrid(mockGrid(gridOnOpen, () => false))
    expect(gridOnOpen).toHaveBeenCalledTimes(1) // 不增加
  })
})
