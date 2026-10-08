/**
 * Windows 平台实现（P1）。能力事实：托盘 ❌（未做，关窗即退出）/ Dock ❌（N/A）/
 * 全局指针 ✅（user32 GetAsyncKeyState）。终端探测链 pwsh → powershell → cmd。
 * @module corum-desktop/electron/platform/win32
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PlatformModule, RevealCommand, TerminalShell, WindowChromeOptions } from './contract.ts'

/** 返回 PATH 上第一个可执行的名字（探测 shell 用；候选名已带 .exe）。 */
function firstOnPath(candidates: readonly string[]): string | undefined {
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(';')) {
    if (dir === '') continue
    for (const name of candidates) {
      try {
        // 同步存在性探测足够：shell 选择在终端开一次时做一次。
        if (existsSync(join(dir, name))) return name
      } catch { /* 目录不可读等，跳过 */ }
    }
  }
  return undefined
}

export const win32Platform: PlatformModule = {
  capabilities: {
    platform: 'win32',
    tray: false,
    dock: false,
    globalPointer: true,
    secretStore: 'dpapi',
    pathSep: '\\',
  },
  terminalShell(): TerminalShell {
    const shell = firstOnPath(['pwsh.exe', 'powershell.exe']) ?? 'cmd.exe'
    // cmd.exe 不认识 -NoLogo；pwsh/powershell 用它抑制版权头。
    return { shell, args: shell === 'cmd.exe' ? [] : ['-NoLogo'] }
  },
  revealCommand(realPath: string): RevealCommand {
    // Windows `explorer /select,` 揭示并选中目标。
    return { cmd: 'explorer', args: ['/select,', realPath] }
  },
  windowChromeOptions(_kind: 'main' | 'floating'): WindowChromeOptions {
    // Windows 用系统标题栏（自绘 chrome 尚未做；交通灯 inset 是 mac 专属）。
    return {}
  },
  passwordStore(): string {
    return '' // Windows 用 DPAPI，无需 password-store 开关
  },
}
