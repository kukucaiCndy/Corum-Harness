/**
 * Desktop harness-home resolution, shared by the boot path and every Host
 * service that anchors files under the desktop home (plugin-manager's
 * disabled list, …). Kept in its own module so services never import the
 * boot module (which pulls the whole composition stack).
 * @module corum-desktop/host/home
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * 2026-11-03 ~ 11-11 期间内部构建的默认 home（`~/.corum-rc3`，见 `DEFAULT_DESKTOP_HOME`
 * 的注释）。发给用户的构建**曾经**写过它，所以升级到本构建（默认 `~/.corum`）时必须
 * 把它里面的用户数据接过来，否则那批会话/技能/项目会凭空消失。
 */
const LEGACY_RC3_HOME = '~/.corum-rc3'

/**
 * 待接管的旧 home，**按新到旧**排列：越靠前的数据越新，整目录搬迁时优先用它。
 */
const LEGACY_HOMES: ReadonlyArray<{ readonly id: string, readonly path: string }> = [
  { id: 'corum-rc3', path: LEGACY_RC3_HOME },
  { id: 'corum-desktop', path: LEGACY_DESKTOP_HOME },
]

/**
 * 「增量补齐」的顶层条目白名单：只搬**用户数据**，不搬任何一份 home 的运行时状态。
 *
 * 刻意**不搬** `profiles/`：它含 `dsh.profile.bundles` 的登记与 `node_modules` 链接，
 * 属于「哪个构建在这台机器上跑过」的痕迹；搬过去会与新构建自己的 overlay 叠出
 * `duplicate loader entry id`（2026-10-31 事故）。同理不搬 `run/`、`logs/`、`tmp/`。
 *
 * 导出给测试：`tests/home-migration.test.mjs` 钉住「`profiles` 永远不在白名单里」。
 */
export const ADOPTABLE_ENTRIES: readonly string[] = [
  'sessions',
  'sessions.json',
  'storages',
  'projects',
  'skills',
  'extension-packs',
  'review',
  'attachments',
  'startup-themes',
  'llm-deepseek',
  '.agent-presets',
  'mcp-servers.json',
  'plugins.disabled.json',
  'desktop-settings.json',
  'settings.yaml',
  '.anonymous-user-id',
]

/**
 * 凭据**成对**处理：`.master-key` 与 `.credentials.yaml` 必须同源。
 * 目标已有其中任意一个 ⇒ 两个都不搬 —— 搬过去也只会用错的密钥去解错的密文，
 * 用户看到的是「API Key 全都失效」（2026-10-23 那类事故的形态）。
 */
const CREDENTIAL_PAIR: readonly string[] = ['.master-key', '.credentials.yaml']

/** 已接管记录（放在目标 home 根，文件名不出现在白名单里）。 */
const ADOPTION_RECORD = '.home-adoption.json'

/** 接管记录的内容形态。 */
interface AdoptionRecord {
  readonly version: 1
  readonly adopted: ReadonlyArray<{ readonly from: string, readonly at: string, readonly mode: 'move' | 'merge' }>
}

/**
 * 读目标 home 的接管记录（坏文件按「没记录」处理，不阻断启动）。
 * @param target - 目标 home 绝对路径。
 * @returns 已接管过的旧 home id 集合。
 */
function adoptedIds(target: string): Set<string> {
  try {
    const raw = readFileSync(join(target, ADOPTION_RECORD), 'utf8')
    const parsed = JSON.parse(raw) as AdoptionRecord
    return new Set((parsed.adopted ?? []).map(item => item.from))
  } catch {
    return new Set()
  }
}

/**
 * 追加一条接管记录（失败只 warn：记录丢了最多下次再跑一遍幂等补齐）。
 * @param target - 目标 home 绝对路径。
 * @param from - 旧 home id。
 * @param mode - 搬迁模式。
 */
function recordAdoption(target: string, from: string, mode: 'move' | 'merge'): void {
  try {
    const current = (() => {
      try {
        return JSON.parse(readFileSync(join(target, ADOPTION_RECORD), 'utf8')) as AdoptionRecord
      } catch {
        return { version: 1 as const, adopted: [] as AdoptionRecord['adopted'] }
      }
    })()
    const next: AdoptionRecord = {
      version: 1,
      adopted: [...current.adopted.filter(item => item.from !== from), { from, at: new Date().toISOString(), mode }],
    }
    writeFileSync(join(target, ADOPTION_RECORD), `${JSON.stringify(next, null, 2)}\n`)
  } catch (error: unknown) {
    process.stderr.write(`[corum-desktop] 接管记录写入失败（不影响启动）：${String(error)}\n`)
  }
}

/**
 * 运行时垃圾目录：**只有**它们存在的 home 等于空 home（不值得接管、也不算「已有数据」）。
 * 判定故意的松（除这几项之外**任何**顶层条目都算用户数据）：宁可多接管一个只有
 * `settings.yaml.bak` 的老目录，也不能因为「条目不在白名单里」就漏掉整份 home ——
 * 「升级后数据不见了」正是本模块存在的理由。
 */
const RUNTIME_JUNK: readonly string[] = ['run', 'logs', 'tmp', 'node_modules']

/**
 * 这个 home 里有没有**用户数据**（除运行时垃圾之外的任何顶层条目）。
 * @param dir - home 绝对路径。
 * @returns 是否值得接管 / 是否已有数据。
 */
function hasUserData(dir: string): boolean {
  try {
    return readdirSync(dir).some(entry => !RUNTIME_JUNK.includes(entry) && entry !== '.DS_Store')
  } catch {
    return false
  }
}

/**
 * 是不是目录（只为把「可能要拷很久」写进日志；取不到就按非目录处理）。
 * @param path - 待判定的路径。
 * @returns 是否为目录。
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把一份旧 home 的用户数据接进目标 home —— **只补不覆盖**。
 *
 * @param legacy - 旧 home 绝对路径。
 * @param target - 目标 home 绝对路径。
 * @returns 实际拷贝的条目数（0 = 无事可做）。
 */
function mergeUserData(legacy: string, target: string): number {
  mkdirSync(target, { recursive: true })
  let copied = 0
  for (const entry of ADOPTABLE_ENTRIES) {
    const source = join(legacy, entry)
    const destination = join(target, entry)
    if (!existsSync(source) || existsSync(destination)) continue
    try {
      // 目录可能很大（sessions/storages 动辄数 GB）：先落一行日志，把「首次启动慢」
      // 变成可解释的现象，而不是让用户面对一个没有动静的启动页。
      process.stderr.write(`[corum-desktop] 补齐旧 home 条目：${entry}${isDirectory(source) ? '/（目录，可能较大）' : ''}\n`)
      cpSync(source, destination, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true })
      copied += 1
    } catch (error: unknown) {
      process.stderr.write(`[corum-desktop] 迁不动 ${entry}（跳过，其余继续）：${String(error)}\n`)
    }
  }
  // 凭据成对：目标两个都不存在时才搬；任何一边已在，就整对不动（见 CREDENTIAL_PAIR）。
  const credentialsMissing = CREDENTIAL_PAIR.every(entry => !existsSync(join(target, entry)))
  if (credentialsMissing) {
    for (const entry of CREDENTIAL_PAIR) {
      const source = join(legacy, entry)
      if (!existsSync(source)) continue
      try {
        cpSync(source, join(target, entry), { force: false, errorOnExist: false, preserveTimestamps: true })
        copied += 1
      } catch (error: unknown) {
        process.stderr.write(`[corum-desktop] 迁不动 ${entry}（跳过）：${String(error)}\n`)
      }
    }
  }
  return copied
}

/**
 * 接管旧 home 的用户数据（幂等、绝不覆盖既有数据、失败不阻断启动）。
 *
 * ## 覆盖的升级路径（这是「老 home → 新 home 必须成功」的机制本体）
 *
 * | 现场 | 处置 |
 * | --- | --- |
 * | 目标 home **不存在 / 没有用户数据** | 整体搬迁（`rename` 原子快；`EXDEV` 降级 `copy+delete`） |
 * | 目标 home **已有用户数据**（如 0.7.0 用户，`~/.corum` 是活的） | **只补缺失条目**，一个既有路径都不覆盖、不删除源 |
 * | 同一旧 home 已接管过（记录在 `.home-adoption.json`） | 直接跳过（幂等） |
 * | 显式 `CORUM_HOME` | 一律不动（调用方自管 home，迁移语义应由它决定） |
 *
 * ## 为什么必须写在**解析 home 之前**
 *
 * 一切后续步骤（`loadLayeredEnv`、`loadProfile`、`migrateToLinks`、`runMigrations`）
 * 都读 `DSH_HOME`，所以数据接管只能发生在这里。**不能**做成 `migrations.ts` 的条目
 * ——那个注册表在 home 定死之后才跑，届时已经读错了目录。
 *
 * ## 失败策略
 *
 * 任何异常只 warn、继续用目标 home 启动：**迁移失败不该变成启动失败**。宁可让用户
 * 看到「数据少了一部分」并可手工恢复（旧目录原样保留），也不能让应用起不来。
 */
function adoptLegacyHomesIfNeeded(): void {
  if (process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== '') return
  const target = resolveDshHome(DEFAULT_DESKTOP_HOME)
  const already = adoptedIds(target)
  for (const legacy of LEGACY_HOMES) {
    if (already.has(legacy.id)) continue
    const source = resolveDshHome(legacy.path)
    if (source === target) continue
    if (!existsSync(source) || !hasUserData(source)) continue
    if (!existsSync(target) || !hasUserData(target)) {
      process.stderr.write(`[corum-desktop] 接管旧 home（整目录搬迁）：${source} → ${target}\n`)
      try {
        renameSync(source, target)
        recordAdoption(target, legacy.id, 'move')
        continue
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EXDEV') {
          try {
            cpSync(source, target, { recursive: true, preserveTimestamps: true })
            rmSync(source, { recursive: true, force: true })
            recordAdoption(target, legacy.id, 'move')
            continue
          } catch (fallbackError: unknown) {
            process.stderr.write(`[corum-desktop] 跨设备搬迁失败，改用增量补齐：${String(fallbackError)}\n`)
          }
        } else if (code !== 'ENOTEMPTY' && code !== 'EEXIST') {
          process.stderr.write(`[corum-desktop] 整目录搬迁失败，改用增量补齐：${String(error)}\n`)
        }
      }
    }
    // 走到这里 = 目标已有数据或搬迁失败 ⇒ 只补缺失条目。
    try {
      const copied = mergeUserData(source, target)
      process.stderr.write(`[corum-desktop] 接管旧 home（增量补齐 ${copied} 项，不覆盖既有数据）：${source} → ${target}\n`)
      recordAdoption(target, legacy.id, 'merge')
    } catch (error: unknown) {
      process.stderr.write(`[corum-desktop] 增量补齐失败（保留旧 home，继续启动）：${String(error)}\n`)
    }
  }
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
  // 2026-11-11：接管**所有**已知旧 home（不只 corum-desktop 时代那个）——升级路径
  // 「老 home → 新 home」的机制本体，必须在任何东西读 DSH_HOME 之前跑。见函数注释。
  adoptLegacyHomesIfNeeded()
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
