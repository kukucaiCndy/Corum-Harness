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
 * Resolves `CORUM_HOME` when set, otherwise this checkout's own default.
 *
 * ⚠️ 2026-10-31（**为什么这里不是 `~/.corum`**）：rc3 线在 boot 时会
 * `publishRuntimeBundle()` 把 `desktop-runtime-bundle` 写进 home，并登记进
 * `profiles/web/package.json` 的 `dsh.profile.bundles`。而 Corum-Harness 线
 * （`/Applications/Corum.app`）**没有** runtime-bundle 机制、却默认共用 `~/.corum`
 * ⇒ rc3 实例启动一次，那份登记就留在共享 home 里；新包 boot 时与本包 overlay
 * 叠出 `duplicate loader entry id: storage-sqlite`（31 行同 id）⇒ host exit 1 ⇒
 * 用户看到「启动失败：主界面加载超时」。删掉也没用：rc3 下次启动又写回。
 * 故本 checkout 默认改用 `~/.corum-rc3`，物理隔离两份 profile 与登记。
 * 显式 `CORUM_HOME` 仍然最优先（需要共用 home 时照旧可以指定）。
 */
const DEFAULT_DESKTOP_HOME = '~/.corum-rc3'

/** 旧版桌面 home（corum-desktop 时代）。启动时检测到即迁移到默认 home。 */
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
  // 2026-09-12：同时把 CORUM_HOME 写进进程环境——host 的子进程（bash 工具、技能脚本）
  // 都继承它，Agent 因此能**看到**自己的 home 而不是靠猜（实测事故：子 Agent 用
  // ps/lsof 拼凑宿主归属，误驱动了用户主实例）。语义上与本函数已设的 DSH_HOME 同值，
  // 对 `corumHome()`（CORUM_HOME > DSH_HOME > ~/.corum）是等价的，不改变解析结果。
  process.env.CORUM_HOME = home
  return home
}
