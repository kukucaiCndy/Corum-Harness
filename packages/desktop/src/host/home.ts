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
 * Resolves `CORUM_HOME` when set, otherwise `~/.corum`——**产品默认值**：整条产品线
 * 共用同一个 home，升级换了构建也照旧读得到自己的会话/设置/技能。
 *
 * ⚠️ 2026-11-10（**撤销** 2026-10-31/11-03 的 `~/.corum-rc3`）：
 * 11-03 曾把这里的默认值改成 `~/.corum-rc3`，用来规避「本线的 `publishRuntimeBundle()`
 * 把 `corum-desktop-runtime` 登记进共享 home 的 `dsh.profile.bundles` ⇒ 另一条没有
 * runtime-bundle 机制的线读到了，与本包 overlay 叠出 `duplicate loader entry id:
 * storage-sqlite`（31 行同 id）⇒ host exit 1」。**那个撞车是真的，但换默认 home 是错的
 * 兜底**，实测代价：
 *   1. 没有任何迁移（`migrations.ts` 的 `MIGRATIONS` 为空、`migrateLegacyHomeIfNeeded()`
 *      只认 `~/.corum-desktop`）⇒ 发版包一升级，用户看到的是**近乎空的主界面**。
 *      本机现场：`~/.corum` 有 174 个会话 / 11 GB，新包读的 `~/.corum-rc3` 只有 5.5 MB。
 *   2. 撞车只发生在「同一台机器同时跑两条不同构建」的开发机场景——已发布的 0.7.0
 *      （2026-10-23）**早于** runtime-bundle 机制，真实用户机器上不存在第二条线。
 *   3. `~/.corum-rc3` 这种内部线名会露进路径（托盘/诊断/终端），不是产品该有的默认值。
 *
 * 结论：**隔离是开发侧的事，不是产品默认值的事**。要在一台机器上并存两条构建，
 * 给每条构建**显式** `CORUM_HOME`（`scripts/corum-instance.sh` 的 dev/verify 角色
 * 已默认用 `~/.corum-rc3`，见该脚本的 home 归一说明）。共用 home 时旧构建会因 insert
 * 行重复起不来，`publishRuntimeBundle()` 会对「本 home 由另一个版本构建过」发告警。
 *
 * 导出给测试当**反回归判据**：产品默认 home 必须是 `~/.corum`，不许再变回某条线的
 * 专属目录（`packages/desktop/tests/home-default.test.mjs`）。
 */
export const DEFAULT_DESKTOP_HOME = '~/.corum'

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
