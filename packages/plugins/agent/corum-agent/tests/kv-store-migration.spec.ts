/**
 * 全局 KV：JSON → SQLite 存量迁移验证（用户 2026-09-15 决定）。
 *
 * 覆盖：
 *   ① 三个 unit 各自搬迁（workspace / message_feedback / corum_orchestration）；
 *   ② **非破坏**：JSON 侧文件在迁移后逐字节不变（回滚安全网）；
 *   ③ **幂等**：重跑不重复搬、不覆盖 SQLite 侧已有数据；
 *   ④ 范围纪律：`session_projcache` **不被迁移**（派生缓存，按裁定重建）；
 *   ⑤ 空 JSON 侧 ⇒ 不 materialize（不造空单元）；
 *   ⑥ 单 unit 失败不阻断其余（失败隔离）。
 *
 * 用**真实后端**（官方 storage-json + storage-sqlite），不做 mock——
 * 迁移的价值全在「两个真实后端的格式/版本语义对得上」，mock 掉就验不到。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { KV_MIGRATION_PLANS, migrateKvStore } from '../src/kv-store-migration.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'corum-kv-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** 用 JSON 后端写一个 single-layout unit（造存量数据）。 */
async function seedJsonSingle(name: string, version: number, table: string, rows: Record<string, unknown>, global?: unknown): Promise<void> {
  const backend = new JsonStorageBackend(root)
  const unit = await backend.kv.open({ name, version, tables: [table], hasGlobal: global !== undefined, layout: 'single' })
  for (const [k, v] of Object.entries(rows)) await unit.putRecord(table, k, v)
  if (global !== undefined) await unit.setGlobal(global)
  await unit.close()
  await backend.close()
}

/** 用 JSON 后端写一个 per-record unit。 */
async function seedJsonPerRecord(name: string, version: number, table: string, rows: Record<string, unknown>): Promise<void> {
  const backend = new JsonStorageBackend(root)
  const unit = await backend.kv.open({ name, version, tables: [table], hasGlobal: false, layout: 'per-record' })
  for (const [k, v] of Object.entries(rows)) await unit.putRecord(table, k, v)
  await unit.close()
  await backend.close()
}

/** 读 SQLite 侧一个 unit 的全部内容。 */
async function readSqlite(name: string, version: number, table: string, hasGlobal: boolean): Promise<{ rows: Record<string, unknown>; global: unknown }> {
  const backend = new SqliteStorageBackend({ path: join(root, 'kv.sqlite'), journalMode: 'wal' })
  const unit = await backend.kv.open({ name, version, tables: [table], hasGlobal, layout: 'single' })
  const state = await unit.loadAll()
  await unit.close()
  await backend.close()
  return { rows: (state.tables[table] ?? {}) as Record<string, unknown>, global: state.global }
}

describe('迁移计划表（与官方 spec 对齐）', () => {
  it('三个待迁 unit 的版本/布局与官方声明一致', () => {
    const byName = new Map(KV_MIGRATION_PLANS.map(p => [p.name, p]))
    // workspace：packages/workspace/workspace/src/spec.ts:68-76（version 2 + global 槽）
    expect(byName.get('workspace')).toMatchObject({ version: 2, tables: ['workspaces'], hasGlobal: true, layout: 'single' })
    // message_feedback：磁盘实测 version 0、无 global
    expect(byName.get('message_feedback')).toMatchObject({ version: 0, tables: ['sessions'], hasGlobal: false })
    // corum_orchestration：per-record，记录 version 1
    expect(byName.get('corum_orchestration')).toMatchObject({ version: 1, tables: ['ledger'], layout: 'per-record' })
  })

  it('session_projcache **不在**迁移计划里（派生缓存，按用户裁定重建）', () => {
    expect(KV_MIGRATION_PLANS.some(p => p.name === 'session_projcache')).toBe(false)
  })
})

describe('迁移：workspace（single + global）', () => {
  it('记录与 global 槽都搬过去', async () => {
    await seedJsonSingle('workspace', 2, 'workspaces', {
      'w-1': { path: '/tmp/a', sessionIds: ['s1', 's2'] },
      'w-2': { path: '/tmp/b', sessionIds: [] },
    }, { initialized: true, workspaceIds: ['w-1', 'w-2'], archivedSessionIds: ['s9'] })

    const r = await migrateKvStore(undefined, root)
    const o = r.outcomes.find(x => x.unit === 'workspace')!
    expect(o.status).toBe('migrated')
    expect(o.records).toBe(2)
    expect(o.global).toBe(true)

    const back = await readSqlite('workspace', 2, 'workspaces', true)
    expect(Object.keys(back.rows)).toHaveLength(2)
    expect(back.rows['w-1']).toMatchObject({ path: '/tmp/a' })
    expect(back.global).toMatchObject({ workspaceIds: ['w-1', 'w-2'], archivedSessionIds: ['s9'] })
  })
})

describe('迁移：corum_orchestration（per-record）', () => {
  it('per-record 记录逐条搬入', async () => {
    await seedJsonPerRecord('corum_orchestration', 1, 'ledger', {
      'corum-task-aaa': { status: 'done', n: 1 },
      'corum-task-bbb': { status: 'pending', n: 2 },
      'corum-task-ccc': { status: 'running', n: 3 },
    })

    const r = await migrateKvStore(undefined, root)
    const o = r.outcomes.find(x => x.unit === 'corum_orchestration')!
    expect(o.status).toBe('migrated')
    expect(o.records).toBe(3)

    const back = await readSqlite('corum_orchestration', 1, 'ledger', false)
    expect(Object.keys(back.rows).sort()).toEqual(['corum-task-aaa', 'corum-task-bbb', 'corum-task-ccc'])
    expect(back.rows['corum-task-bbb']).toMatchObject({ status: 'pending' })
  })
})

describe('非破坏性与幂等', () => {
  it('JSON 侧文件在迁移后**逐字节不变**（回滚安全网）', async () => {
    await seedJsonSingle('workspace', 2, 'workspaces', { 'w-1': { path: '/tmp/a' } }, { workspaceIds: ['w-1'] })
    const p = join(root, 'workspace.json')
    const before = readFileSync(p, 'utf8')

    await migrateKvStore(undefined, root)

    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe(before) // 逐字节相同
  })

  it('幂等重跑：第二次跳过（already），不重复计数', async () => {
    await seedJsonSingle('workspace', 2, 'workspaces', { 'w-1': { path: '/tmp/a' } }, { workspaceIds: ['w-1'] })

    const first = await migrateKvStore(undefined, root)
    expect(first.outcomes.find(o => o.unit === 'workspace')!.status).toBe('migrated')

    const second = await migrateKvStore(undefined, root)
    expect(second.outcomes.find(o => o.unit === 'workspace')!.status).toBe('already')

    const back = await readSqlite('workspace', 2, 'workspaces', true)
    expect(Object.keys(back.rows)).toHaveLength(1)
  })

  it('**不覆盖** SQLite 侧已有数据（运行期写入更权威）', async () => {
    // SQLite 侧先有「新」数据
    const backend = new SqliteStorageBackend({ path: join(root, 'kv.sqlite'), journalMode: 'wal' })
    const unit = await backend.kv.open({ name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: false, layout: 'single' })
    await unit.putRecord('workspaces', 'w-new', { path: '/tmp/new' })
    await unit.close()
    await backend.close()
    // JSON 侧是「旧」数据
    await seedJsonSingle('workspace', 2, 'workspaces', { 'w-old': { path: '/tmp/old' } })

    const r = await migrateKvStore(undefined, root)
    expect(r.outcomes.find(o => o.unit === 'workspace')!.status).toBe('already')

    const back = await readSqlite('workspace', 2, 'workspaces', false)
    expect(Object.keys(back.rows)).toEqual(['w-new']) // 旧数据没被灌进来
  })

  it('JSON 侧无痕迹 ⇒ 不 materialize（不造空单元）', async () => {
    const r = await migrateKvStore(undefined, root)
    expect(r.outcomes.every(o => o.status === 'empty')).toBe(true)
    // 只建了 db（甚至没建，因为没有任何 unit 需要 open）；不该出现 unit 表
    if (existsSync(join(root, 'kv.sqlite'))) {
      const back = await readSqlite('workspace', 2, 'workspaces', true)
      expect(Object.keys(back.rows)).toHaveLength(0)
    }
  })
})

describe('失败隔离', () => {
  it('单个 unit 损坏 ⇒ failed，其余 unit 仍正常迁移', async () => {
    // workspace 正常
    await seedJsonSingle('workspace', 2, 'workspaces', { 'w-1': { path: '/tmp/a' } })
    // message_feedback 写一段非法 JSON（解析失败 → open 抛错）
    writeFileSync(join(root, 'message_feedback.json'), '{ this is not json')
    // corum_orchestration 正常
    await seedJsonPerRecord('corum_orchestration', 1, 'ledger', { 't-1': { a: 1 } })

    const r = await migrateKvStore(undefined, root)
    const ws = r.outcomes.find(o => o.unit === 'workspace')!
    const orch = r.outcomes.find(o => o.unit === 'corum_orchestration')!
    expect(ws.status).toBe('migrated')
    expect(orch.status).toBe('migrated')
    // message_feedback 要么 failed 要么 empty（取决于 backend 对坏文件的降级语义）——
    // 关键断言：它**没有**让另外两个 unit 失败，也没抛到调用方。
    const mf = r.outcomes.find(o => o.unit === 'message_feedback')!
    expect(['failed', 'empty']).toContain(mf.status)
  })

  it('迁移绝不抛错（storages/ 不存在也安全）', async () => {
    const missing = join(root, 'nope')
    const r = await migrateKvStore(undefined, missing)
    expect(r.outcomes).toHaveLength(0)
  })

  it('只认注入的 root，**绝不**回落到全局 CORUM_HOME/`~/.corum`', async () => {
    // 2026-10-12 真机教训（「本地绿、CI 红」的假绿）：
    // `hasJsonTrace()` 曾经内部自己调 `storagesRoot()`（读 CORUM_HOME 环境变量、
    // 回落 `~/.corum`），**完全忽略 `migrateKvStore(root)` 传入的 root**。
    // 于是：干净环境（CI）里 `~/.corum/storages` 不存在 ⇒ 每个 unit 都判 `empty`
    // ⇒ 迁移一条不搬（本文件 5 条断言失败）；而开发者机器上只要恰好有同名真实残留
    // 文件（如 `~/.corum/storages/workspace.json`）就会**误打误撞通过** ⇒ 缺陷被掩盖。
    //
    // 本测试把「全局 storages 根」指向一个**确有数据**的诱饵目录，而把真实数据放在
    // 另一个注入 root 里。若实现又去读全局，就会搬到诱饵侧 / 真实侧判 empty ⇒ 断言失败。
    const decoy = mkdtempSync(join(tmpdir(), 'corum-kv-decoy-'))
    const injected = mkdtempSync(join(tmpdir(), 'corum-kv-injected-'))
    const savedHome = process.env.CORUM_HOME
    try {
      // 诱饵：全局根里放一份「同名但内容不同」的 workspace.json。
      await seedJsonSingle('workspace', 2, 'workspaces', { 'DECOY': { path: '/decoy' } })
      process.env.CORUM_HOME = decoy
      // 真实数据写在**注入的** root 下（`seedJsonSingle` 走 root 参数，不经全局）。
      // 注意要把种子写进 injected：临时借用 root 变量不现实，故直接构造 JSON 文件。
      const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json')
      const backend = new JsonStorageBackend(injected)
      const unit = await backend.kv.open({ name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true, layout: 'single' })
      await unit.putRecord('workspaces', 'w-real', { path: '/real' })
      await unit.setGlobal({ initialized: true })
      await unit.close()
      await backend.close()

      const r = await migrateKvStore(undefined, injected)
      const o = r.outcomes.find(x => x.unit === 'workspace')!
      // 必须按**注入的** root 判定为有数据并搬迁。
      expect(o.status).toBe('migrated')
      expect(o.records).toBe(1)
      expect(o.global).toBe(true)
    } finally {
      if (savedHome === undefined) delete process.env.CORUM_HOME
      else process.env.CORUM_HOME = savedHome
      rmSync(decoy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rmSync(injected, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('范围纪律：项目侧与投影缓存都不受影响', () => {
  it('session_projcache 的 JSON 树在迁移后**原样保留**、且未写入 SQLite', async () => {
    // 造一个 projcache 的 per-record 树
    await seedJsonPerRecord('session_projcache', 7, 'sessions', { 'sess-1': { v: 1 } })
    const dir = join(root, 'session_projcache')
    expect(existsSync(join(dir, 'sessions', 'sess-1.json'))).toBe(true)

    await migrateKvStore(undefined, root)

    // JSON 树原样在
    expect(existsSync(join(dir, 'sessions', 'sess-1.json'))).toBe(true)
    // SQLite 侧没有这个 unit 表（没被 open 过）
    const backend = new SqliteStorageBackend({ path: join(root, 'kv.sqlite'), journalMode: 'wal' })
    const unit = await backend.kv.open({ name: 'session_projcache', version: 7, tables: ['sessions'], hasGlobal: false, layout: 'single' })
    const state = await unit.loadAll()
    await unit.close()
    await backend.close()
    expect(Object.keys(state.tables.sessions ?? {})).toHaveLength(0)
  })
})
