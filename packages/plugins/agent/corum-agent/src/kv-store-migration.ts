/**
 * 全局 KV 存储：JSON → SQLite 存量迁移（用户 2026-09-15 决定）。
 *
 * ## 背景与范围
 *
 * 用户裁定「KV 迁移即可」+「只迁全局 `storages/`，项目侧四张表保持 JSON」
 * （台账 `architecture.storage.sqlite-as-unified-backend`）。故本模块只处理
 * **`$CORUM_HOME/storages/` 下的全局 unit**：
 *
 * | unit | 布局 | 迁移 |
 * | --- | --- | --- |
 * | `workspace`（工作区 + 归档会话） | single | ✅ 迁 |
 * | `message_feedback` | single | ✅ 迁 |
 * | `corum_orchestration`（编排台账） | per-record | ✅ 迁 |
 * | `session_projcache`（会话投影缓存） | per-record | ❌ **不迁**——官方明写它是 disposable derived data（`session-projection-cache/spec.ts` 的 `invalidRecords: 'backup-and-skip'`），SQLite 侧从空开始、冷读重建 |
 *
 * **不涉及**项目侧 `corum_project_<id>`：它们走 `corum-agent/project-data-backend.ts`
 * 自注册的 `corum-project:<cwd>` JsonStorageBackend 实例（root = `<cwd>/.corum/project/`），
 * 与全局 domain 默认后端无关 ⇒ 保住 §2「项目数据跟随项目、可读可 diff 可 git」模型。
 *
 * ## 为什么需要迁移（而不是让 SQLite 侧从空开始）
 *
 * `workspace` 装的是**工作区与会话归组**（含 `archivedSessionIds`）——
 * 丢了等于用户侧栏的工作区分组与归档状态全部丢失；`corum_orchestration` 是
 * 编排台账。二者都是**用户事实**，不是派生缓存。`message_feedback` 同理。
 *
 * ## 幂等与安全
 *
 * - **幂等**：目标 unit 已存在记录时**跳过该 unit**（不覆盖 SQLite 侧已有数据——
 *   运行期新写入的更权威）；可重复跑。
 * - **只增不删**：**绝不删除或改写** JSON 侧文件（回滚安全网：把 `storage-domain`
 *   的 `backend` 改回 `json` 即可完全回退）。
 * - **逐 unit 隔离**：单个 unit 迁移失败只记日志并跳过，不阻断其余 unit 与启动。
 * - **非破坏性判定**：只在「JSON 侧有数据 **且** SQLite 侧该 unit 为空」时搬。
 *
 * @module @corum/corum-agent/kv-store-migration
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'

/** 迁移目标 unit 的声明（与官方 domain spec 对齐的静态投影）。 */
interface UnitPlan {
  /** unit 名（= 磁盘文件名 / SQL 标识符段）。 */
  name: string
  /** 单元格式版本（**必须**与官方 spec 一致，否则 SQLite 侧报 version-mismatch）。 */
  version: number
  /** 表名。 */
  tables: string[]
  /** 是否有 global 单例槽。 */
  hasGlobal: boolean
  /** 磁盘布局。 */
  layout: 'single' | 'per-record'
}

/**
 * 迁移计划表。
 *
 * ⚠️ **版本号必须与官方 spec 一致**（实测磁盘戳：`workspace` v2、
 * `message_feedback` v0、`corum_orchestration` v1）。写错会在 SQLite 侧
 * 首次 open 时报 `version-mismatch`。
 */
export const KV_MIGRATION_PLANS: readonly UnitPlan[] = [
  // packages/workspace/workspace/src/spec.ts:68-76 —— version 2 + global 槽。
  { name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true, layout: 'single' },
  // 官方 message-feedback spec（磁盘实测 version 0、无 global）。
  { name: 'message_feedback', version: 0, tables: ['sessions'], hasGlobal: false, layout: 'single' },
  // corum 自有的编排台账（per-record；磁盘实测记录 version 1）。
  { name: 'corum_orchestration', version: 1, tables: ['ledger'], hasGlobal: false, layout: 'per-record' },
  // 显式不迁：session_projcache。列在此处只为让「为何不迁」在被读到时可见。
  // { name: 'session_projcache', version: 7, ... } ← 见模块头「不迁」说明。
]

/** 单 unit 迁移结果。 */
export interface KvUnitMigrationOutcome {
  unit: string
  /** migrated = 搬了；already = SQLite 侧已有数据（跳过）；empty = JSON 侧无数据；failed = 出错。 */
  status: 'migrated' | 'already' | 'empty' | 'failed'
  /** 搬过去的记录数（仅 migrated 有意义）。 */
  records: number
  /** global 槽是否搬了。 */
  global: boolean
  /** 失败原因（仅 failed）。 */
  error?: string
}

export interface KvMigrationResult {
  /** storages/ 根（诊断用）。 */
  root: string
  /** sqlite db 路径。 */
  dbPath: string
  /** 各 unit 结果。 */
  outcomes: KvUnitMigrationOutcome[]
}

/** storages/ 根（`$CORUM_HOME/storages`）。 */
export function storagesRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'storages')
}

/** sqlite db 路径（与 patch 行的 `dshHomePath('storages','kv.sqlite')` 一致）。 */
export function kvDatabasePath(): string {
  return join(storagesRoot(), 'kv.sqlite')
}

/**
 * 执行全局 KV 的 JSON → SQLite 迁移（幂等、非破坏）。
 *
 * @param log - 可选日志回调。
 * @param root - storages/ 根（测试注入；缺省读环境）。
 */
export async function migrateKvStore(
  log?: (msg: string) => void,
  root: string = storagesRoot(),
): Promise<KvMigrationResult> {
  const say = log ?? ((_msg: string) => {})
  const dbPath = join(root, 'kv.sqlite')
  const result: KvMigrationResult = { root, dbPath, outcomes: [] }
  if (!existsSync(root)) return result

  const json = new JsonStorageBackend(root)
  const sqlite = new SqliteStorageBackend({ path: dbPath, journalMode: 'wal' })
  try {
    for (const plan of KV_MIGRATION_PLANS) {
      result.outcomes.push(await migrateOne(json, sqlite, plan, root, say))
    }
  } finally {
    // 两个后端都必须释放：sqlite 会持有 db 句柄，不关会让后续 patch 挂载的
    // sqlite 后端在同一个文件上二次 open（WAL 下可并发，但白留句柄）。
    await json.close().catch(() => {})
    await sqlite.close().catch(() => {})
  }
  return result
}

/**
 * 迁移单个 unit（抛错由调用方兜成 failed 结果）。
 * @param root - `storages/` 根；**必须**传给 {@link hasJsonTrace}（见该函数注释的假绿教训）。
 */
async function migrateOne(
  json: JsonStorageBackend,
  sqlite: SqliteStorageBackend,
  plan: UnitPlan,
  root: string,
  say: (msg: string) => void,
): Promise<KvUnitMigrationOutcome> {
  const base = { unit: plan.name, records: 0, global: false }
  try {
    // JSON 侧没有任何痕迹 ⇒ 无事可做（不 materialize，避免造空单元）。
    if (!hasJsonTrace(plan, root)) return { ...base, status: 'empty' }

    const descriptor = {
      name: plan.name,
      version: plan.version,
      tables: plan.tables,
      hasGlobal: plan.hasGlobal,
      layout: plan.layout,
    }
    const src = await json.kv.open(descriptor)
    const snapshot = await src.loadAll()
    await src.close()

    const recordsByTable = new Map<string, Array<[string, unknown]>>()
    let total = 0
    for (const table of plan.tables) {
      const rows = Object.entries(snapshot.tables[table] ?? {})
      recordsByTable.set(table, rows)
      total += rows.length
    }
    const hasGlobalValue = plan.hasGlobal && snapshot.global !== null && snapshot.global !== undefined

    // JSON 侧本来就空（例如只 materialize 过、没写过）⇒ 不算迁移。
    if (total === 0 && !hasGlobalValue) return { ...base, status: 'empty' }

    // 目标侧已有数据 ⇒ **跳过**（运行期写入比历史快照权威；也不覆盖用户新数据）。
    const dst = await sqlite.kv.open(descriptor)
    const existing = await dst.loadAll()
    const existingCount = plan.tables.reduce(
      (n, t) => n + Object.keys(existing.tables[t] ?? {}).length,
      0,
    )
    const existingGlobal = plan.hasGlobal && existing.global !== null && existing.global !== undefined
    if (existingCount > 0 || existingGlobal) {
      await dst.close()
      say(`kv-migration: [${plan.name}] SQLite 侧已有数据（${existingCount} 条），跳过不覆盖`)
      return { ...base, status: 'already' }
    }

    for (const [table, rows] of recordsByTable) {
      for (const [key, value] of rows) await dst.putRecord(table, key, value)
    }
    if (hasGlobalValue) await dst.setGlobal(snapshot.global)
    await dst.close()

    say(`kv-migration: [${plan.name}] 迁入 SQLite — ${total} 条${hasGlobalValue ? ' + global' : ''}`)
    return { unit: plan.name, status: 'migrated', records: total, global: hasGlobalValue }
  } catch (error) {
    // 单 unit 失败不阻断其余 unit / 不阻断启动（JSON 侧仍是权威，回退零成本）。
    const message = error instanceof Error ? error.message : String(error)
    say(`kv-migration: [${plan.name}] 迁移失败（JSON 侧保持权威，可回退）：${message}`)
    return { ...base, status: 'failed', error: message }
  }
}

/**
 * JSON 侧是否有该 unit 的痕迹。
 *
 * 判据（与官方两种布局对应）：
 *   - `single` ⇒ `<root>/<name>.json` 存在；
 *   - `per-record` ⇒ `<root>/<name>/` 目录非空。
 *
 * 只看「有没有」而不解析内容：解析留给 backend（它对坏文件有既定的降级语义，
 * 本函数不该重复实现一套）。
 *
 * ⚠️ `root` **必须由调用方传入**，不得内部改调 {@link storagesRoot()}（2026-10-12 修）：
 * 曾经的写法是内部自己 `storagesRoot()`（读 `CORUM_HOME` 环境变量 / 回落 `~/.corum`），
 * 于是**完全忽略 `migrateKvStore(root)` 传入的那个 root**。后果是「本地绿、CI 红」的
 * 假绿：干净环境（CI）里 `~/.corum/storages` 不存在 ⇒ 每个 unit 都判 `empty`
 * ⇒ 迁移一条不搬（`kv-store-migration.spec.ts` 5 条失败）；而开发者机器上只要恰好
 * 有同名真实残留文件（`~/.corum/storages/workspace.json` 之类）就会**误打误撞通过**
 * ⇒ 缺陷被掩盖。⇒ 纯函数必须只依赖**注入的**参数，不读环境。
 *
 * @param plan - 迁移计划项。
 * @param root - `storages/` 根（= `migrateKvStore` 的入参，调用方唯一事实源）。
 */
function hasJsonTrace(plan: UnitPlan, root: string): boolean {
  if (plan.layout === 'single') return existsSync(join(root, `${plan.name}.json`))
  const dir = join(root, plan.name)
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * 启动接线的便捷入口（**无 ctx**，供桌面壳在 `boot()` 之前调用）。
 *
 * ⚠️ **时机是关键**：必须早于 config-tree 挂载——`storage-domain` 一旦按 sqlite
 * 挂载，workspace 等服务首次 open 域就会把**空** SQLite 当权威状态，之后再补
 * 数据就晚了。此时 ctx 尚未建立，故日志走 stderr（与桌面壳既有的
 * `[corum-desktop] …` 前缀同风格）。
 *
 * **绝不抛错**：迁移失败只记日志（JSON 侧仍是权威，回退只需把 `storage-domain`
 * 的 `backend` 改回 `json`）。
 */
export async function migrateKvStoreAtBoot(): Promise<KvMigrationResult | undefined> {
  try {
    const r = await migrateKvStore(msg => process.stderr.write(`[corum-desktop] ${msg}\n`))
    const summary = r.outcomes
      .map(o => `${o.unit}=${o.status}${o.records > 0 ? `(${o.records})` : ''}`)
      .join(' ')
    process.stderr.write(`[corum-desktop] kv JSON→SQLite 迁移：${summary || '(无 unit)'}\n`)
    return r
  } catch (error) {
    process.stderr.write(`[corum-desktop] kv 迁移失败（非阻断，JSON 侧仍权威）：${String(error)}\n`)
    return undefined
  }
}

/**
 * 启动接线的便捷入口：迁移失败只记日志，**绝不阻断启动**。
 *
 * 放在 host boot 内、config-tree 挂载**之前**调用（`storage-domain` 一旦按
 * sqlite 挂载并 open 域，就该already看到数据）。
 */
export async function runKvMigrationAtBoot(ctx: Context): Promise<void> {
  try {
    const r = await migrateKvStore(msg => ctx.logger.info(msg))
    const summary = r.outcomes.map(o => `${o.unit}=${o.status}${o.records > 0 ? `(${o.records})` : ''}`).join(' ')
    ctx.logger.info(`corum-kv: JSON→SQLite 迁移完成 — ${summary || '(无 unit)'}`)
  } catch (error) {
    ctx.logger.error(`corum-kv: 迁移失败（非阻断，JSON 侧仍权威）：${String(error)}`)
  }
}

/** 测试专用：读一个 JSON unit 的原始文本（不做解析）。 */
export function readJsonUnitRaw(name: string, root: string = storagesRoot()): string | undefined {
  const p = join(root, `${name}.json`)
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined
}
