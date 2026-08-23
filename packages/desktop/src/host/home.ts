/**
 * Desktop harness-home resolution, shared by the boot path and every Host
 * service that anchors files under the desktop home (plugin-manager's
 * disabled list, …). Kept in its own module so services never import the
 * boot module (which pulls the whole composition stack).
 * @module corum-desktop/host/home
 */

import { existsSync, renameSync, cpSync, rmSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * The desktop app's own harness home, fully separate from the CLI's `~/.dsh`
 * so the two surfaces never share sessions, settings, presets, or profiles.
 * Resolves `CORUM_HOME` when set, otherwise `~/.corum`.
 */
const DEFAULT_DESKTOP_HOME = '~/.corum'

/** 旧版桌面 home（corum-desktop 时代）。启动时检测到即迁移到 ~/.corum。 */
const LEGACY_DESKTOP_HOME = '~/.corum-desktop'

/**
 * 把旧版 home（~/.corum-desktop）迁移到 ~/.corum。
 * rename 优先（原子、快）；跨设备（EXDEV）降级 copy + 删除。
 * 仅在未显式设置 CORUM_HOME、且旧目录存在而新目录不存在时触发。
 */
function migrateLegacyHomeIfNeeded(): void {
  if (process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== '') return
  const legacy = resolveDshHome(LEGACY_DESKTOP_HOME)
  const target = resolveDshHome(DEFAULT_DESKTOP_HOME)
  if (!existsSync(legacy) || existsSync(target)) return
  process.stderr.write(`[corum-desktop] migrating home: ${legacy} → ${target}\n`)
  try {
    renameSync(legacy, target)
  } catch (error) {
    // 跨设备（EXDEV）等情况降级为 copy + 删除；失败则保留旧目录继续用旧的。
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      try {
        cpSync(legacy, target, { recursive: true })
        rmSync(legacy, { recursive: true, force: true })
      } catch (fallbackError) {
        process.stderr.write(`[corum-desktop] home migration failed, keep legacy: ${String(fallbackError)}\n`)
        return
      }
    } else {
      process.stderr.write(`[corum-desktop] home migration failed, keep legacy: ${String(error)}\n`)
      return
    }
  }
  process.stderr.write('[corum-desktop] home migration complete\n')
}

/**
 * Point this process's `DSH_HOME` at the desktop home BEFORE any boot step.
 * Every harness-home resolver (`resolveDshHome`, `loadLayeredEnv`,
 * `healProfilesModuleFallback`, `loadProfile`) reads `process.env.DSH_HOME`,
 * so setting it once isolates the whole tree from the web surface — including
 * a launch (`open .app`) that inherits no environment at all.
 * @returns the resolved desktop home path.
 */
export function resolveDesktopHome(): string {
  migrateLegacyHomeIfNeeded()
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : DEFAULT_DESKTOP_HOME
  const home = resolveDshHome(configured)
  process.env.DSH_HOME = home
  return home
}
