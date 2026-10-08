/**
 * platform 选路（P1）：**以运行时平台为准**（`getPlatform()` / `process.platform`），
 * 编译期特化只做瘦身（消除这份产物肯定用不到的分支），不做行为决策
 * （docs/PLAN-2026-10-07 §7.1：行为事实源只有一个 = 实际运行平台）。
 *
 * 在同一份产物内，「选路跟随运行时平台」与「编译期特化」天然一致——错配的产物
 * 在 P0 的一致性断言处就拒绝启动，根本活不到这里。所以这里**不需要**也不应该
 * 读烘入常量：直接按 `process.platform` 选实现即可。
 * @module corum-desktop/electron/platform
 */
import type { CorumPlatform, PlatformModule } from './contract.ts'
import { darwinPlatform } from './darwin.ts'
import { linuxPlatform } from './linux.ts'
import { win32Platform } from './win32.ts'

export type { CorumPlatform, PlatformCapabilities, PlatformModule, RevealCommand, TerminalShell, WindowChromeOptions } from './contract.ts'

/** 当前运行平台的实现（单例；process.platform 在进程内不变）。 */
const current: PlatformModule =
  process.platform === 'darwin' ? darwinPlatform
  : process.platform === 'win32' ? win32Platform
  : linuxPlatform

/** 取当前平台的实现面（行为事实源 = 实际运行平台）。 */
export function getPlatformModule(): PlatformModule {
  return current
}

/** 取当前平台名（'darwin' | 'linux' | 'win32'）。 */
export function getPlatform(): CorumPlatform {
  return current.capabilities.platform
}
