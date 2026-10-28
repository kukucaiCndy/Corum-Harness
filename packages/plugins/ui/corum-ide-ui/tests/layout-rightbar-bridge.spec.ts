/**
 * LayoutController ↔ 官方 rightbar 面 / corum details 抽屉的**真行为**测试（2026-10-29 重写）。
 *
 * ## 修的是什么（上一版 worker 的三个缺陷，全部由本文件锁住）
 *
 * ① **陈旧快照**：上一版在 `openDetails`/`closeDetails` 里改本地布尔。但 store 的
 *    `details` 还能被**绕过 LayoutController** 的路径改写（AppFrame 的 backdrop
 *    点击、会话切换复位、官方 DetailsPanel 关闭按钮都直接调 store action）。
 *    现方案：镜像的唯一写点是 `reportDetailsOpen`（AppFrame 把 store 真值回送），
 *    本文件用**真实 store 实例**验证「外部写 → 报告 → 镜像与订阅者同步」。
 * ② **假映射**：上一版 `openRightbar(track, fullscreen)` 注释写「映射到宽度」但参数
 *    全忽略。现方案：官方只支持 docked 呈现（track=true, fullscreen=false），
 *    其余**不打开**、只告警一次（`rightbarCapability` 声明能力）。
 * ③ **panelInfo 语义错**：上一版把 details 开合塞进 `activePanelId: 'details'`。
 *    官方 `activePanelId` 是**中央主面板选择**（null = Conversation），
 *    `ui-sidebar-right` 正用它决定会话级右栏内容是否显示 ⇒ 塞 'details' 会让官方
 *    右栏隐藏自己的内容。现方案：恒 null（frozen 引用、永不广播），details 开合
 *    走独立镜像面 `detailsSnapshot()`。
 *
 * ## 用什么测
 *
 * 真实 `createLayoutStore().create()`（官方 `@deepseek-ai/dsh-client-store` 引擎）
 * + 真实 `LayoutController`。没有任何手写 mock store——`attachPanels` 收到的就是
 * 引擎烘焙后的 bound actions，与 AppFrame 运行时拿到的同一形态。
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '../src/client/service.ts'
import { DETAILS_DEFAULT, createLayoutStore } from '../src/client/stores.ts'

/**
 * 造一台「真壳」：真实 store 实例 + 真 LayoutController + 一次初始报告。
 * @returns 控制器、store 真值读/写面、以及模拟 AppFrame 报告的函数。
 */
function harness() {
  const instance = createLayoutStore().create()
  const ctrl = new LayoutController()
  ctrl.attachPanels(instance.actions)
  // AppFrame 挂载后的首次报告（真实初值）。
  ctrl.reportDetailsOpen(instance.getSnapshot().details > 0)
  return {
    ctrl,
    instance,
    /** store 真值（测试断言用）。 */
    detailsWidth: () => instance.getSnapshot().details,
    /** 模拟 AppFrame 的 useLayoutEffect 报告（订阅真值 → 回送镜像）。 */
    reportFromStore: () => { ctrl.reportDetailsOpen(instance.getSnapshot().details > 0) },
  }
}

describe('LayoutController — panelInfo（官方语义：中央主面板选择）', () => {
  it('activePanelId 恒 null：Conversation 永远是中央面，不塞 details', () => {
    const { ctrl } = harness()
    expect(ctrl.panelInfo.getSnapshot()).toEqual({ activePanelId: null })
    // details 抽屉开着也必须仍是 null —— 两者是不同语义的轴。
    ctrl.openDetails()
    expect(ctrl.panelInfo.getSnapshot()).toEqual({ activePanelId: null })
  })

  it('getSnapshot 引用稳定（uSES：不变时不换引用）+ frozen', () => {
    const { ctrl } = harness()
    const a = ctrl.panelInfo.getSnapshot()
    const b = ctrl.panelInfo.getSnapshot()
    expect(b).toBe(a)
    expect(Object.isFrozen(a)).toBe(true)
  })

  it('subscribe 登记后永不广播（该值在本壳里不可能变化），退订幂等', () => {
    const { ctrl } = harness()
    const listener = vi.fn()
    const off = ctrl.panelInfo.subscribe(listener)
    ctrl.openDetails()
    ctrl.closeDetails()
    expect(listener).not.toHaveBeenCalled()
    off()
    off() // 退订两次不抛
  })
})

describe('LayoutController — detailsSnapshot（真 store 的开合镜像）', () => {
  it('初始打开状态：store 初值 details=0 ⇒ 镜像 open=false（AppFrame 首次报告后）', () => {
    const { ctrl, detailsWidth } = harness()
    expect(detailsWidth()).toBe(0)
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: false })
  })

  it('store 初值已是开（外部先写）时，首次报告即读出真实初值，而不是本地默认 false', () => {
    const ctrl = new LayoutController()
    const instance = createLayoutStore().create()
    instance.actions.openDetails() // 挂载前就开着（resume 场景）
    ctrl.attachPanels(instance.actions)
    ctrl.reportDetailsOpen(instance.getSnapshot().details > 0)
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: true })
  })

  it('openDetails 真的写 store（宽度 = DETAILS_DEFAULT），报告后镜像开 + 订阅者收到一次', () => {
    const { ctrl, detailsWidth, reportFromStore } = harness()
    const listener = vi.fn()
    ctrl.detailsSnapshot().subscribe(listener)

    ctrl.openDetails()
    expect(detailsWidth()).toBe(DETAILS_DEFAULT)

    reportFromStore()
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: true })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('★外部关闭（绕过 LayoutController 直接调 store action）也同步镜像并广播', () => {
    const { ctrl, instance, detailsWidth, reportFromStore } = harness()
    ctrl.openDetails()
    reportFromStore()
    expect(ctrl.detailsSnapshot().getSnapshot().open).toBe(true)

    const listener = vi.fn()
    ctrl.detailsSnapshot().subscribe(listener)

    // 这条就是 AppFrame backdrop 点击 / 会话切换复位的真实写法：
    // 改的是 store，LayoutController 完全不知情。
    instance.actions.closeDetails()
    expect(detailsWidth()).toBe(0)
    reportFromStore()

    expect(ctrl.detailsSnapshot().getSnapshot(), '外部关闭后镜像必须为关').toEqual({ open: false })
    expect(listener, '外部关闭也必须广播').toHaveBeenCalledTimes(1)
  })

  it('★外部打开（绕过 LayoutController）同样同步', () => {
    const { ctrl, instance, reportFromStore } = harness()
    const listener = vi.fn()
    ctrl.detailsSnapshot().subscribe(listener)
    instance.actions.openDetails()
    reportFromStore()
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: true })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('幂等：重复报告同值 → 不换引用、不广播', () => {
    const { ctrl, reportFromStore } = harness()
    ctrl.openDetails()
    reportFromStore()
    const snap = ctrl.detailsSnapshot().getSnapshot()
    const listener = vi.fn()
    ctrl.detailsSnapshot().subscribe(listener)

    reportFromStore()
    reportFromStore()

    expect(ctrl.detailsSnapshot().getSnapshot()).toBe(snap)
    expect(listener).not.toHaveBeenCalled()
  })

  it('重复 openDetails 幂等（store action 自身不重写宽度，镜像只广播一次）', () => {
    const { ctrl, detailsWidth, reportFromStore } = harness()
    const listener = vi.fn()
    ctrl.detailsSnapshot().subscribe(listener)
    ctrl.openDetails()
    ctrl.openDetails()
    reportFromStore()
    expect(detailsWidth()).toBe(DETAILS_DEFAULT)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('closeDetails 真的写 store（宽度归 0）', () => {
    const { ctrl, detailsWidth, reportFromStore } = harness()
    ctrl.openDetails()
    reportFromStore()
    ctrl.closeDetails()
    expect(detailsWidth()).toBe(0)
    reportFromStore()
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: false })
  })

  it('订阅者在自己回调里退订不会打乱广播（快照遍历）', () => {
    const { ctrl, reportFromStore } = harness()
    const second = vi.fn()
    const off = ctrl.detailsSnapshot().subscribe(() => { off() })
    ctrl.detailsSnapshot().subscribe(second)
    ctrl.openDetails()
    reportFromStore()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('LayoutController — openRightbar/closeRightbar（能力受限的真桥）', () => {
  it('能力声明：只支持 docked（track=true, fullscreen=false）', () => {
    const { ctrl } = harness()
    expect(ctrl.rightbarCapability).toEqual({ track: true, fullscreen: false })
  })

  it('docked 报告（track=true, fullscreen=false）→ 真的打开抽屉', () => {
    const { ctrl, detailsWidth, reportFromStore } = harness()
    ctrl.openRightbar(true, false)
    expect(detailsWidth()).toBe(DETAILS_DEFAULT)
    reportFromStore()
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: true })
  })

  it('★fullscreen 报告不伪映射：不打开抽屉，只告警一次（同签名）', () => {
    const { ctrl, detailsWidth } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      ctrl.openRightbar(true, true)
      ctrl.openRightbar(true, true) // 同签名第二次不再刷日志
      expect(detailsWidth(), 'fullscreen 不在能力内 ⇒ store 不得被写').toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('track=true,fullscreen=true')
    } finally { warn.mockRestore() }
  })

  it('★无轨道报告（track=false）同样不打开、不伪映射', () => {
    const { ctrl, detailsWidth } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      ctrl.openRightbar(false, false)
      ctrl.openRightbar(false, true) // 不同签名 ⇒ 再告警一次
      expect(detailsWidth()).toBe(0)
      expect(warn).toHaveBeenCalledTimes(2)
    } finally { warn.mockRestore() }
  })

  it('closeRightbar → 真的关闭抽屉（store 宽度归 0）', () => {
    const { ctrl, detailsWidth, reportFromStore } = harness()
    ctrl.openRightbar(true, false)
    reportFromStore()
    ctrl.closeRightbar()
    expect(detailsWidth()).toBe(0)
    reportFromStore()
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: false })
  })
})

describe('LayoutController — 未 attach（boot 前 / 纯单元）', () => {
  it('openDetails/closeDetails/openRightbar/closeRightbar 都不抛（无可写的 store）', () => {
    const ctrl = new LayoutController()
    expect(() => { ctrl.openDetails() }).not.toThrow()
    expect(() => { ctrl.closeDetails() }).not.toThrow()
    expect(() => { ctrl.openRightbar(true, false) }).not.toThrow()
    expect(() => { ctrl.closeRightbar() }).not.toThrow()
    // 镜像不因「写失败」而虚报：仍是关（store 初值）。
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: false })
    expect(ctrl.panelInfo.getSnapshot()).toEqual({ activePanelId: null })
  })

  it('reportDetailsOpen 在未 attach 时也生效（纯镜像面，不依赖 store）', () => {
    const ctrl = new LayoutController()
    ctrl.reportDetailsOpen(true)
    expect(ctrl.detailsSnapshot().getSnapshot()).toEqual({ open: true })
  })
})
