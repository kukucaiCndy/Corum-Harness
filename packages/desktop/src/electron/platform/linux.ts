/**
 * Linux 平台实现（P1）。能力事实：托盘 ❌ / Dock ❌ / 全局指针 ❌（Wayland 无全局
 * 指针 API，X11 适配未做）。**「无托盘」是一个显式事实**（`capabilities.tray=false`），
 * 不是返回 null 让调用方去悟——它直接联动「关窗即退出」语义（功能缺口另计，
 * 需 AppIndicator 等实现）。safeStorage 必须**显式**选 gnome-libsecret：Chromium
 * 在 Linux 上不会自动选密钥环后端（2026-10-07 Ubuntu 实测三组对照）。
 * @module corum-desktop/electron/platform/linux
 */
import type { PlatformModule, RevealCommand, TerminalShell, WindowChromeOptions } from './contract.ts'

export const linuxPlatform: PlatformModule = {
  capabilities: {
    platform: 'linux',
    tray: false,
    dock: false,
    globalPointer: false,
    secretStore: 'gnome-libsecret',
    pathSep: '/',
  },
  terminalShell(): TerminalShell {
    return { shell: process.env.SHELL ?? '/bin/zsh', args: ['-l'] }
  },
  revealCommand(_realPath: string, dirname: string): RevealCommand {
    // Linux 无「揭示选中」的统一接口，xdg-open 所在目录。
    return { cmd: 'xdg-open', args: [dirname] }
  },
  windowChromeOptions(_kind: 'main' | 'floating'): WindowChromeOptions {
    // Linux 用系统标题栏（无 macOS 红绿灯；交通灯 inset 是 mac 专属概念）。
    return {}
  },
  passwordStore(): string {
    // 显式选 gnome-libsecret；`basic` 是 Chromium 明文兜底，不能用于主密钥。
    // 可被 CORUM_LINUX_PASSWORD_STORE 覆盖（无 GNOME 的桌面环境改 kwallet 等）。
    return process.env.CORUM_LINUX_PASSWORD_STORE ?? 'gnome-libsecret'
  },
}
