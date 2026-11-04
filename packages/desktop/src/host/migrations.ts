/**
 * 启动期升级迁移框架。
 *
 * 每次版本升级都可能需要在 `loadProfile` 之前对 `$DSH_HOME` 做一次性的状态
 * 修正（清理残留目录、修 profile manifest、迁移文件格式……）。本模块把这些
 * 迁移注册成一条条**带唯一 id 的回调**，boot 时统一跑一遍，已执行的跳过。
 *
 * ## 设计要点
 *
 * - **幂等**：每条迁移跑完后把它的 id 写进 `$DSH_HOME/migrations.json`，下次
 *   启动读到已执行就跳过。迁移函数本身也应幂等（同一条件多次执行不产生副作用），
 *   这是双保险：即便记录丢了或被手动删掉，重跑也不会弄坏东西。
 * - **不阻塞启动**：每条迁移独立 try/catch，一条失败只打 stderr 告警，不抛给
 *   上层——迁移失败不该让本来就升级成功的应用起不来。
 * - **顺序执行**：迁移按注册顺序跑。新迁移追加到数组末尾即可；不要插队、不要
 *   删除已发布的迁移（已执行的用户会跳过，留着对没升级的用户仍是必需的）。
 * - **时机**：`runMigrations()` 在 `loadProfile` **之前**调用——大多数迁移需要
 *   在 profile 组装前修正 manifest / 残留 bundle，否则坏状态会直接让 loadProfile
 *   或 composeEntries 崩。
 *
 * ## 新增一条迁移
 *
 * 1. 写一个 `(ctx: MigrationContext) => void` 的函数（或 async）；
 * 2. 在 `MIGRATIONS` 数组末尾追加一个条目：`{ id, description, run }`；
 * 3. id 用 `migrate-<简述>` 格式，全局唯一、永不复用；
 * 4. 函数内做检测 + 修正，条件不满足时直接 return（幂等）。
 *
 * @module corum-desktop/host/migrations
 */

import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProfileManifest, resolveProfileDir, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** 迁移函数拿到的上下文：当前 home、profile 名、profile 目录。 */
export interface MigrationContext {
  /** `$DSH_HOME`（`resolveDesktopHome()` 已设好的绝对路径）。 */
  readonly home: string
  /** 本次启动的 profile 名（`CORUM_DESKTOP_PROFILE ?? 'web'`）。 */
  readonly profileName: string
  /** profile 目录绝对路径（`$DSH_HOME/profiles/<name>`）。 */
  readonly profileDir: string
}

/** 一条迁移步骤：唯一 id + 人类描述 + 执行函数。 */
export interface Migration {
  /** 全局唯一、永不复用的 id（`migrate-<简述>`）。 */
  readonly id: string
  /** 一句话描述（写进 stderr 日志，帮排查）。 */
  readonly description: string
  /** 执行迁移；条件不满足时直接 return。可抛错（会被框架 catch）。 */
  readonly run: (ctx: MigrationContext) => void | Promise<void>
}

/** 记录已执行迁移 id 的文件名（`$DSH_HOME/` 下）。 */
const MIGRATIONS_RECORD_FILENAME = 'migrations.json'

/** 读已执行的迁移 id 集合；文件不存在或损坏返回空集（= 全部重跑，幂等兜底）。 */
function readExecutedMigrationIds(home: string): Set<string> {
  const path = join(home, MIGRATIONS_RECORD_FILENAME)
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    // 文件不存在 / JSON 坏了 → 视为空集，全部重跑（迁移本身幂等，不弄坏东西）。
  }
  return new Set()
}

/** 追加一条已执行的迁移 id（保留既有记录，不去重）。 */
function appendExecutedMigrationId(home: string, id: string): void {
  const path = join(home, MIGRATIONS_RECORD_FILENAME)
  const existing = readExecutedMigrationIds(home)
  if (existing.has(id)) return
  existing.add(id)
  try {
    writeFileSync(path, `${JSON.stringify([...existing].sort(), null, 2)}\n`)
  } catch (error) {
    // 写不了记录不影响启动——下次会重跑这条迁移（幂等兜底）。
    process.stderr.write(`[corum-desktop] 迁移记录写盘失败（忽略，下次重跑）：${String(error)}\n`)
  }
}

// ─── 迁移注册表（按注册顺序执行；新迁移追加到末尾） ──────────────────────────

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 'migrate-remove-stale-runtime-bundle',
    description: '清理旧版「运行期 bundle」残留（29d3133c 引入、后续移除的机制）',
    run: migrateRemoveStaleRuntimeBundle,
  },
]


/**
 * 清理旧版「运行期 bundle」残留（2026-10-29 提交 29d3133c 引入、后续移除）。
 *
 * 该机制每次 boot 把 `cordis.patch.yml` 的 insert 块切出写成
 * `$DSH_HOME/desktop-runtime-bundle/` 并登记进 profile 的 `dsh.profile.bundles`。
 * 机制移除后残留的 bundle 目录与 manifest 条目无人清理，升级后与打包产物
 * overlay 都含 `storage-sqlite` ⇒ `duplicate loader entry id` ⇒ host exit 1。
 *
 * 幂等：manifest 里没该条目 / 目录不存在时直接 return。
 */
const STALE_RUNTIME_BUNDLE_NAME = 'corum-desktop-runtime'
const STALE_RUNTIME_BUNDLE_DIRNAME = 'desktop-runtime-bundle'

function migrateRemoveStaleRuntimeBundle(ctx: MigrationContext): void {
  repairStaleRuntimeBundle(ctx)
}

/**
 * 同一条清理，但**每次启动都跑**（幂等、纯本地检查），不靠迁移记录。
 *
 * 为什么迁移记录不够（2026-11-04 实测事故）：`migrate-remove-stale-runtime-bundle`
 * 在用户机上早已记进 `migrations.json`，可是 `$DSH_HOME/desktop-runtime-bundle/`
 * 与 profile manifest 里的 `corum-desktop-runtime` 条目**又出现了**（目录与
 * manifest 的 mtime 都是 00:38，晚于迁移记录）。一旦重现，一次性迁移再也不会跑，
 * 下一次启动就死在 `duplicate loader entry id: storage-sqlite` —— host exit 1、
 * renderer 卡在启动动画，报错文本还完全不指向真因（残留目录）。
 *
 * 一次性迁移只能覆盖「升级那一瞬间」，覆盖不了「状态自己回来」。同类问题既然会被
 * 别的进程/旧版本重新写出来，检查就必须落在启动路径上：这里是纯 `existsSync` +
 * 数组 contains，代价可忽略。
 *
 * @param ctx - home / profile 名 / profile 目录。
 */
export function repairStaleRuntimeBundle(ctx: MigrationContext): void {
  const { home, profileName: profileNameValue, profileDir } = ctx
  const manifestPath = join(profileDir, 'package.json')
  if (existsSync(manifestPath)) {
    let manifest: Record<string, unknown>
    try {
      manifest = readProfileManifest('corum-desktop', profileDir) as Record<string, unknown>
    } catch {
      // 读不了就跳过 manifest 修正——loadProfileWithSkip 的预检会兜底坏 manifest。
      manifest = {} as Record<string, unknown>
    }
    const dsh = manifest.dsh as { profile?: { bundles?: string[] } } | undefined
    const bundles = dsh?.profile?.bundles
    let changed = false
    if (Array.isArray(bundles) && bundles.includes(STALE_RUNTIME_BUNDLE_NAME)) {
      bundles.splice(bundles.indexOf(STALE_RUNTIME_BUNDLE_NAME), 1)
      changed = true
    }
    if (changed) {
      try {
        writeProfileManifest(profileDir, manifest as Parameters<typeof writeProfileManifest>[1])
        process.stderr.write(
          `[corum-desktop] 升级迁移：已从 profile "${profileNameValue}" 的 bundles 移除残留的 ${STALE_RUNTIME_BUNDLE_NAME}\n`,
        )
      } catch (error) {
        process.stderr.write(`[corum-desktop] 升级迁移：写 profile manifest 失败（忽略）：${String(error)}\n`)
      }
    }
  }
  // 残留目录改名归档——无论 manifest 是否改过都检查（目录可能在别的 profile 下遗留）。
  const staleDir = join(home, STALE_RUNTIME_BUNDLE_DIRNAME)
  if (existsSync(staleDir) && lstatSync(staleDir).isDirectory()) {
    const archive = join(home, `${STALE_RUNTIME_BUNDLE_DIRNAME}.stale-${Date.now()}`)
    try {
      renameSync(staleDir, archive)
      process.stderr.write(`[corum-desktop] 升级迁移：残留目录改名归档 ${staleDir} → ${archive}\n`)
    } catch (error) {
      // 改名失败不阻塞启动：manifest 已清理，loadProfile 不会 resolve 这个目录。
      process.stderr.write(`[corum-desktop] 升级迁移：残留目录改名失败（忽略）：${String(error)}\n`)
    }
  }
}

// ─── 执行器 ──────────────────────────────────────────────────────────────

/**
 * 跑所有未执行的迁移。在 `loadProfile` 之前调用。
 *
 * 每条迁移独立 try/catch：失败只打 stderr 告警，不抛给上层。已执行的（id 在
 * `migrations.json` 里）跳过。迁移本身也应幂等——记录丢了重跑不弄坏东西。
 * @param home - `$DSH_HOME`。
 * @param profileNameValue - 本次启动的 profile 名。
 */
export async function runMigrations(home: string, profileNameValue: string): Promise<void> {
  const profileDir = resolveProfileDir(profileNameValue, home)
  const ctx: MigrationContext = { home, profileName: profileNameValue, profileDir }
  const executed = readExecutedMigrationIds(home)
  for (const migration of MIGRATIONS) {
    if (executed.has(migration.id)) continue
    try {
      await migration.run(ctx)
      appendExecutedMigrationId(home, migration.id)
    } catch (error) {
      // 迁移失败不阻塞启动——应用升级的代码改动才是主要修复手段，迁移只是
      // 清理残留。失败时打 stderr，不记 id（下次会重试，幂等兜底）。
      process.stderr.write(
        `[corum-desktop] 升级迁移「${migration.id}」执行失败（忽略，不阻塞启动）：${String(error)}\n`,
      )
    }
  }
}

// `resolveDshHome` 导入是为了让本模块在 dev 态直接 import 时也能解析 home；
// 实际调用方（bootDesktop）已设好 DSH_HOME，传入的是 resolveDshHome() 的返回值。
void resolveDshHome
