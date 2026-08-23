/**
 * Input HAL —— 跨平台全局输入状态抽象层（Hardware Abstraction Layer）。
 *
 * 主进程需要「全局鼠标按键状态」来做可靠的拖拽松手判定（macOS 系统拖拽
 * app-region:drag 期间渲染层收不到 mouseup，主进程也没有现成的全局鼠标
 * API）。本层向上暴露平台无关的查询接口，向下按平台走系统级适配：
 *
 *   - macOS：koffi 调 CoreGraphics 的 CGEventSourceButtonState（Quartz 事件
 *     源状态，全局、无需辅助功能权限即可读左键）。
 *   - Windows：GetAsyncKeyState(VK_LBUTTON)（user32，同为全局键状态）。
 *   - Linux：X11 XQueryPointer 的 button mask（Xlib；Wayland 下无全局 API，
 *     降级为「总是按住」即禁用自动吸附，由后续 Wayland 适配补齐）。
 *
 * 任何平台加载失败（库缺失 / 符号变化 / 非桌面环境）都安全降级为
 * 「查询不可用」，调用方据此选择保守行为（不做自动吸附），绝不抛错。
 *
 * @module corum-desktop/electron/input-hal
 */

import { platform } from 'node:os'
import { createRequire } from 'node:module'

// koffi is CJS; load it through createRequire so the ESM main bundle keeps a
// real require (its native .node binding resolves relative to the package).
const requireKoffi = createRequire(import.meta.url)

/** 全局输入状态查询面。 */
export interface InputHal {
  /** 左键当前是否按住；查询不可用（见 available）时返回 null。 */
  isPrimaryButtonDown(): boolean | null
  /** HAL 是否成功初始化（原生库加载 + 符号解析成功）。 */
  readonly available: boolean
  /** 释放原生句柄（koffi unload）。幂等。 */
  dispose(): void
}

/** 不可用的空 HAL：所有查询返回 null。 */
const nullHal = (reason: string): InputHal => {
  console.warn(`[input-hal] unavailable: ${reason}`)
  return {
    available: false,
    isPrimaryButtonDown: () => null,
    dispose: () => {},
  }
}

/**
 * macOS 实现：CoreGraphics CGEventSourceButtonState。
 * 原型：bool CGEventSourceButtonState(CGEventSourceStateID stateID, CGMouseButton button)
 * stateID = kCGEventSourceStateCombinedSessionState (1)；button = kCGMouseButtonLeft (0)。
 */
function createMacHal(): InputHal {
  try {
    const koffi = requireKoffi('koffi') as typeof import('koffi')
    const lib = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    const CGEventSourceButtonState = lib.func('bool CGEventSourceButtonState(int stateID, int button)')
    const COMBINED_SESSION = 1
    const LEFT_BUTTON = 0
    return {
      available: true,
      isPrimaryButtonDown: () => CGEventSourceButtonState(COMBINED_SESSION, LEFT_BUTTON) as boolean,
      dispose: () => { lib.unload() },
    }
  } catch (error) {
    return nullHal(`macOS CoreGraphics load failed: ${String(error)}`)
  }
}

/**
 * Windows 实现：user32 GetAsyncKeyState。高位（0x8000）= 键当前按住。
 * VK_LBUTTON = 0x01。
 */
function createWindowsHal(): InputHal {
  try {
    const koffi = requireKoffi('koffi') as typeof import('koffi')
    const lib = koffi.load('user32.dll')
    const GetAsyncKeyState = lib.func('short __stdcall GetAsyncKeyState(int vKey)')
    const VK_LBUTTON = 0x01
    return {
      available: true,
      isPrimaryButtonDown: () => ((GetAsyncKeyState(VK_LBUTTON) as number) & 0x8000) !== 0,
      dispose: () => { lib.unload() },
    }
  } catch (error) {
    return nullHal(`Windows user32 load failed: ${String(error)}`)
  }
}

/**
 * Linux 实现：X11 XQueryPointer 的 button 掩码。Wayland 无全局指针 API，
 * 降级为不可用（调用方退化为保守行为）。仅在有 DISPLAY 时尝试。
 */
function createLinuxHal(): InputHal {
  if (process.env.DISPLAY === undefined || process.env.DISPLAY === '') {
    return nullHal('no X11 DISPLAY (Wayland has no global pointer API)')
  }
  // XQueryPointer 需要打开 Display 连接并解析 root window，适配面较大。
  // 首版先不在 Linux 启用自动吸附，后续按发行版补 X11/Wayland 适配。
  return nullHal('linux adapter not yet implemented')
}

/** 创建当前平台的输入 HAL（失败安全降级）。 */
export function createInputHal(): InputHal {
  const os = platform()
  if (os === 'darwin') return createMacHal()
  if (os === 'win32') return createWindowsHal()
  return createLinuxHal()
}
