/**
 * 标题栏红绿灯让位宽（2026-10-09 缺陷 `bug.macos-traffic-light-overlaps-collapse-button`）。
 *
 * 用户报障：「MAC OS 上红绿灯和折叠的按钮重叠在一起了」。
 *
 * 根因是判据**把两件事混成一件**：原实现写 `if (!isMac) return 0`，于是
 * 「确认不是 macOS」与「读不到平台（桥缺席）」都走 0。而桥缺席在 macOS 上是真实常态
 * （preload 随壳重建、渲染层随各插件包重建，两者版本天然可不同步），一旦发生：
 * 让位 0 ⇒ 控件层从 x=4 起排 ⇒ 折叠按钮 x=4..32，而系统红绿灯实占 x=12..67 ⇒ 压上。
 *
 * 本 spec 钉死「桥不可用时往哪边倒」，并锁住「确认非 macOS ⇒ 0」（Windows/Linux
 * 顶上不能留无主空白）。
 */
import { describe, expect, it } from 'vitest'
import { trafficLightInset } from '../src/client/traffic-light-inset.ts'

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

describe('trafficLightInset — 桥可用（权威路径）', () => {
  it('darwin ⇒ 主窗 76 / 浮窗 66（让开红绿灯）', () => {
    const bridge = { getPlatform: () => 'darwin' as const }
    expect(trafficLightInset(false, { bridge, userAgent: MAC_UA })).toBe(76)
    expect(trafficLightInset(true, { bridge, userAgent: MAC_UA })).toBe(66)
  })

  it('linux / win32 ⇒ 0（系统标题栏无灯可让，顶上不留无主空白）', () => {
    expect(trafficLightInset(false, { bridge: { getPlatform: () => 'linux' as const }, userAgent: LINUX_UA })).toBe(0)
    expect(trafficLightInset(false, { bridge: { getPlatform: () => 'win32' as const }, userAgent: WIN_UA })).toBe(0)
  })

  it('桥权威优先于 UA（UA 说 Windows 但桥说 darwin ⇒ 让位）', () => {
    expect(trafficLightInset(false, { bridge: { getPlatform: () => 'darwin' as const }, userAgent: WIN_UA })).toBe(76)
  })
})

describe('trafficLightInset — 桥不可用（缺陷回归：必须倒向安全侧）', () => {
  it('macOS UA + 桥缺席 ⇒ **仍让位 76**（旧实现返回 0 ⇒ 折叠按钮压在红绿灯上）', () => {
    expect(trafficLightInset(false, { bridge: undefined, userAgent: MAC_UA })).toBe(76)
  })

  it('macOS UA + 桥存在但 getPlatform 缺失 ⇒ 仍让位', () => {
    expect(trafficLightInset(false, { bridge: {}, userAgent: MAC_UA })).toBe(76)
  })

  it('浮窗同样遵循（桥缺席 + macOS UA ⇒ 66）', () => {
    expect(trafficLightInset(true, { bridge: undefined, userAgent: MAC_UA })).toBe(66)
  })

  it('确认是 Windows/Linux ⇒ 0（不因为「判据不确定」而白留空白）', () => {
    expect(trafficLightInset(false, { bridge: undefined, userAgent: WIN_UA })).toBe(0)
    expect(trafficLightInset(false, { bridge: undefined, userAgent: LINUX_UA })).toBe(0)
  })

  it('桥与 UA 都判不出 ⇒ 保留让位（观感损失 < 控件压系统的功能损失）', () => {
    expect(trafficLightInset(false, { bridge: undefined, userAgent: '' })).toBe(76)
    expect(trafficLightInset(true, { bridge: undefined, userAgent: '' })).toBe(66)
  })
})
