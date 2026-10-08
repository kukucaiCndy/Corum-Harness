/**
 * macOS 平台实现（P1）。能力事实：托盘 ✅ / Dock ✅ / 全局指针 ✅（CoreGraphics）。
 * @module corum-desktop/electron/platform/darwin
 */
import type { PlatformModule, RevealCommand, TerminalShell, WindowChromeOptions } from './contract.ts'

export const darwinPlatform: PlatformModule = {
  capabilities: {
    platform: 'darwin',
    tray: true,
    dock: true,
    globalPointer: true,
    secretStore: 'keychain',
    pathSep: '/',
  },
  terminalShell(): TerminalShell {
    return { shell: process.env.SHELL ?? '/bin/zsh', args: ['-l'] }
  },
  revealCommand(realPath: string): RevealCommand {
    // macOS `open -R` 直接揭示并选中目标。
    return { cmd: 'open', args: ['-R', realPath] }
  },
  windowChromeOptions(kind: 'main' | 'floating'): WindowChromeOptions {
    if (kind === 'floating') {
      // 浮窗红绿灯：与会话顶栏卡片中线对齐（卡片 min-height 44、上边距 12，
      // 中线 y = 12 + 22 = 34，灯高 13 → 定标 y ≈ 27）；x=16 与卡片左缘留视觉间距。
      return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 27 } }
    }
    // 主窗口红绿灯：与标题栏图标中线对齐（标题栏行高 40 → 图标中线 y=20，
    // 实测定标 y=13）；x=12 保持系统标准 inset。
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 13 } }
  },
  passwordStore(): string {
    return '' // macOS 自动选中 keychain，无需显式 password-store
  },
}
