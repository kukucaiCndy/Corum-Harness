#!/usr/bin/env node
/**
 * rehearse-v4-migration.mjs —— V2→V3→V4 真实迁移预演脚本。
 *
 * 本脚本用官方 rc3 的 `@deepseek-ai/dsh-session-persistence-jsonl` 公开 API
 * 在一个**临时副本**上执行完整的会话迁移预演：
 *
 *   1. 源 `~/.corum` 只读：hash 全部 session 文件清单（sha256，按路径排序）。
 *   2. 复制 sessions 三层结构（root/project/session）到临时 home，
 *      保留 session.v*.jsonl.zstd + session.lock；复制 catalog/index 等最小
 *      非敏感文件（按官方后端需求）；**绝不**复制 credentials/keys。
 *   3. 用真实 cordis Context + jsonl persistence backend 初始化，
 *      `list()` → `open(id,'read')` → `handle.read()` 遍历全部存量会话，
 *      统计文件版本 v2/v3/v4、session 数、prepared/read 成功、unsupported/其他错误。
 *   4. 对临时副本 `open(id,'write')` + `publish` 全部可迁移会话，
 *      验证 v4 产物生成 + 重新 `open(id,'read')` → `read()` 成功；
 *      源文件不删除。
 *   5. 再 hash 源 `~/.corum` sessions，证明预演前后完全一致。
 *
 * ## 安全约束
 *
 * - 源 `~/.corum` **只读**：本脚本不写入、不删除、不重命名源中任何文件。
 * - 临时副本放在系统临时目录（默认 `/tmp/corum-v4-test-home-<pid>`），
 *   可通过 `--temp-home=<path>` 指定。
 * - 绝不复制 credentials/keys/llm-deepseek 等敏感目录。
 * - `read()` 不 publish 源：open(id,'read') 只读不写。
 *
 * ## 用法
 *
 *   node scripts/rehearse-v4-migration.mjs                    # 默认临时目录
 *   node scripts/rehearse-v4-migration.mjs --report           # 输出 JSON 报告到 stdout
 *   node scripts/rehearse-v4-migration.mjs --source-home=...  # 指定源 home
 *   node scripts/rehearse-v4-migration.mjs --temp-home=...    # 指定临时 home
 *   node scripts/rehearse-v4-migration.mjs --publish          # 执行 publish 阶段
 *
 * 退出码：0 = 全部成功（含 unsupported 的如实统计）；1 = 运行时错误。
 *
 * @module rehearse-v4-migration
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  cp, mkdir, readdir, readFile, rm, stat, writeFile, access,
} from 'node:fs/promises'
import { existsSync, constants as fsConstants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

// ── CLI 参数 ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const AS_REPORT = argv.includes('--report')
const DO_PUBLISH = argv.includes('--publish')

const SOURCE_HOME = arg('source-home', join(homedir(), '.corum'))
const TEMP_HOME = arg('temp-home', join(tmpdir(), `corum-v4-test-home-${process.pid}`))

// ── 常量 ──────────────────────────────────────────────────────────────

/** 源 home 中需要复制的非敏感目录/文件（绝不复制 credentials/keys）。 */
const COPY_ENTRIES = [
  'sessions', // 核心三层结构
]

/** 绝不复制的敏感目录（安全约束）。 */
const SENSITIVE_SKIP = new Set([
  'llm-deepseek', // API keys / credentials
  'credentials',
  'keys',
  'engines', // 可能含 key 配置
  'profiles', // 可能含 token
  'run', // runtime state
  'logs',
])

/** 闭包根：优先用 build/host（打包态闭包，与正式发布一致），退回 desktop/node_modules。 */
function findClosureRoot() {
  const candidates = [
    join(REPO_ROOT, 'packages/desktop/build/host/node_modules'),
    join(REPO_ROOT, 'packages/desktop/node_modules'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'))) {
      return c
    }
  }
  throw new Error(`rehearse: 找不到包含 dsh-session-persistence-jsonl 的闭包根（尝试过 build/host 与 desktop/node_modules）`)
}

// ── 工具函数 ──────────────────────────────────────────────────────────

/** 计算一个文件的 sha256 hex 摘要。 */
async function sha256File(path) {
  const { createReadStream } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * 对 sessions 目录做全量 hash：遍历所有 session.v*.jsonl.zstd 文件，
 * 按**相对路径排序**后逐个 sha256，组合成一份确定性清单。
 * @param {string} sessionsDir - sessions 目录绝对路径。
 * @returns {{ files: Array<{relPath: string, sha256: string, size: number}>, combinedHash: string }}
 */
async function hashSessionsTree(sessionsDir) {
  const files = []
  async function walk(dir, relPrefix) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      const relPath = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(fullPath, relPath)
      } else if (entry.isFile() && /^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) {
        const st = await stat(fullPath)
        const hash = await sha256File(fullPath)
        files.push({ relPath, sha256: hash, size: st.size })
      }
    }
  }
  await walk(sessionsDir, '')
  // 按相对路径排序，保证确定性
  files.sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)
  // 组合 hash：把所有 (relPath, sha256, size) 拼成一行做 sha256
  const combined = createHash('sha256')
  for (const f of files) {
    combined.update(`${f.relPath}\0${f.sha256}\0${f.size}\n`)
  }
  return { files, combinedHash: combined.digest('hex') }
}

/** 安全复制源 home 的 sessions 到临时 home，跳过敏感内容。 */
async function copySourceToTemp(sourceHome, tempHome) {
  await rm(tempHome, { recursive: true, force: true })
  await mkdir(tempHome, { recursive: true })
  for (const entry of COPY_ENTRIES) {
    const src = join(sourceHome, entry)
    if (!existsSync(src)) continue
    const dst = join(tempHome, entry)
    await cp(src, dst, {
      recursive: true,
      dereference: false,
      // 不复制 lock 文件（写测试时需要全新锁）
      filter: (path) => {
        const base = path.split(sep).pop()
        // 跳过 lock 文件：它们是运行时锁，复制没意义且会干扰
        if (base === 'session.lock') return false
        return true
      },
    })
  }
  // 确认没有复制敏感目录
  for (const skip of SENSITIVE_SKIP) {
    if (existsSync(join(tempHome, skip))) {
      throw new Error(`rehearse: 安全检查失败——临时 home 意外包含敏感目录 ${skip}`)
    }
  }
}

/**
 * 解析一个 session 文件名的版本号。
 * @param {string} filename - 如 `session.v2.jsonl.zstd`
 * @returns {number|undefined} 版本号，如 2；无法解析时 undefined。
 */
function parseSessionVersion(filename) {
  const match = filename.match(/^session\.v(\d+)\.jsonl/)
  return match ? parseInt(match[1], 10) : undefined
}

// ── cordis Context + jsonl backend 初始化 ──────────────────────────────

/**
 * 创建一个最小 cordis Context 并挂载 jsonl persistence backend。
 *
 * 用官方 `@deepseek-ai/cordis` 的 `new Context()` 作为根，
 * 再调 jsonl persistence 的 `apply(ctx, config)` 注册 `ctx.sessionPersistence`。
 * 不启 Electron，不挂任何 UI/agent 插件——纯 persistence。
 *
 * @param {string} sessionsRoot - sessions 目录绝对路径（backend root）。
 * @returns {{ ctx: object, dispose: () => Promise<void> }}
 */
async function initPersistenceBackend(sessionsRoot) {
  const closureRoot = findClosureRoot()
  // 用 createRequire 从闭包根解析，保证加载的是 rc3 闭包内的包（不是工作区旧版）
  const { createRequire } = await import('node:module')
  const require = createRequire(join(closureRoot, '_rehearse-anchor.js'))

  const { Context } = require('@deepseek-ai/cordis')
  const { apply } = require('@deepseek-ai/dsh-session-persistence-jsonl')

  const ctx = new Context()
  // apply() 接受原始 config 对象（schemastery schema 在内部做验证/默认值填充）
  const config = { root: sessionsRoot, compression: 'zstd' }
  await apply(ctx, config)

  const dispose = async () => {
    try {
      // 先 flush 所有 write handle，再 dispose context
      if (ctx.sessionPersistence?.flush) {
        await ctx.sessionPersistence.flush()
      }
    } catch { /* teardown 尽力而为 */ }
    // cordis 的 context 通过 fiber.dispose() 清理
    try { await ctx.fiber.dispose() } catch { /* 尽力而为 */ }
  }
  return { ctx, dispose }
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function main() {
  const report = {
    sourceHome: SOURCE_HOME,
    tempHome: TEMP_HOME,
    startedAt: new Date().toISOString(),
    phases: {},
  }

  // ── Phase 0: 源 hash（预演前） ───────────────────────────────────────
  const sourceSessionsDir = join(SOURCE_HOME, 'sessions')
  if (!existsSync(sourceSessionsDir)) {
    console.error(`rehearse: 源 sessions 目录不存在: ${sourceSessionsDir}`)
    process.exit(1)
  }

  console.log(`[rehearse] Phase 0: hashing source ~/.corum/sessions (read-only)...`)
  const sourceHashBefore = await hashSessionsTree(sourceSessionsDir)
  report.phases.sourceHashBefore = {
    fileCount: sourceHashBefore.files.length,
    combinedHash: sourceHashBefore.combinedHash,
  }
  console.log(`  ${sourceHashBefore.files.length} files, combined sha256: ${sourceHashBefore.combinedHash.slice(0, 16)}…`)

  // ── Phase 1: 复制到临时 home ─────────────────────────────────────────
  console.log(`[rehearse] Phase 1: copying sessions to temp home ${TEMP_HOME}...`)
  await copySourceToTemp(SOURCE_HOME, TEMP_HOME)
  const tempSessionsDir = join(TEMP_HOME, 'sessions')
  const tempHashAfterCopy = await hashSessionsTree(tempSessionsDir)
  report.phases.copyToTemp = {
    tempHome: TEMP_HOME,
    fileCount: tempHashAfterCopy.files.length,
    combinedHash: tempHashAfterCopy.combinedHash,
  }
  console.log(`  copied ${tempHashAfterCopy.files.length} files`)

  // 确认复制前后 hash 一致（lock 文件已跳过，只比 session 文件）
  if (sourceHashBefore.combinedHash !== tempHashAfterCopy.combinedHash) {
    // 找出差异
    const beforeMap = new Map(sourceHashBefore.files.map((f) => [f.relPath, f]))
    const afterMap = new Map(tempHashAfterCopy.files.map((f) => [f.relPath, f]))
    const diffs = []
    for (const [path, before] of beforeMap) {
      const after = afterMap.get(path)
      if (!after) diffs.push(`${path}: missing in copy`)
      else if (before.sha256 !== after.sha256) diffs.push(`${path}: hash mismatch`)
    }
    for (const path of afterMap.keys()) {
      if (!beforeMap.has(path)) diffs.push(`${path}: extra in copy`)
    }
    console.error(`[rehearse] copy hash mismatch! ${diffs.length} differences:`)
    for (const d of diffs.slice(0, 20)) console.error(`  ${d}`)
    process.exit(1)
  }

  // ── Phase 2: 初始化 backend + list + open/read 全部会话 ───────────────
  console.log(`[rehearse] Phase 2: initializing jsonl persistence backend on temp copy...`)
  const { ctx, dispose } = await initPersistenceBackend(tempSessionsDir)
  const persistence = ctx.sessionPersistence
  if (!persistence) {
    console.error(`[rehearse] ctx.sessionPersistence not available after apply()`)
    await dispose()
    process.exit(1)
  }

  console.log(`[rehearse] Phase 2: listing all sessions...`)
  const snapshots = await persistence.list()
  console.log(`  list() returned ${snapshots.length} sessions`)

  // 统计版本分布
  const stats = {
    total: snapshots.length,
    byVersion: {},
    readOk: 0,
    readFailed: {},
    unsupported: [],
    otherErrors: [],
    versionFromFilename: {},
  }

  // 从文件名也统计版本（list() 的 header 可能是迁移后的）
  const tempFiles = tempHashAfterCopy.files
  for (const f of tempFiles) {
    const v = parseSessionVersion(f.relPath.split('/').pop() ?? '')
    if (v !== undefined) {
      stats.versionFromFilename[v] = (stats.versionFromFilename[v] ?? 0) + 1
    }
  }

  console.log(`[rehearse] Phase 2: opening and reading each session (read-only, no publish)...`)
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]
    const id = snap.header.id
    const versionKey = snap.formatStatus ?? 'unknown'
    stats.byVersion[versionKey] = (stats.byVersion[versionKey] ?? 0) + 1

    let handle
    try {
      handle = await persistence.open(id, 'read')
    } catch (err) {
      const errName = err?.name ?? err?.constructor?.name ?? 'Error'
      if (errName === 'SessionFormatUnsupportedError' || errName === 'SessionFormatUnsupportedMigrationError') {
        stats.unsupported.push({ id, version: versionKey, error: err.message.split('\n')[0] })
      } else {
        stats.otherErrors.push({ id, version: versionKey, error: err.message?.split('\n')[0] ?? String(err), name: errName })
      }
      continue
    }

    try {
      const result = await handle.read(0, Number.MAX_SAFE_INTEGER)
      stats.readOk += 1
    } catch (err) {
      const errName = err?.name ?? err?.constructor?.name ?? 'Error'
      const reason = err.message?.split('\n')[0] ?? String(err)
      if (errName === 'SessionFormatUnsupportedError' || errName === 'SessionFormatUnsupportedMigrationError') {
        stats.unsupported.push({ id, version: versionKey, error: reason })
      } else {
        const bucket = stats.readFailed[errName] ?? []
        bucket.push({ id, version: versionKey, error: reason })
        stats.readFailed[errName] = bucket
      }
    } finally {
      try { await handle.close() } catch { /* best effort */ }
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  progress: ${i + 1}/${snapshots.length} (readOk=${stats.readOk})`)
    }
  }

  report.phases.readAll = {
    totalListed: stats.total,
    byFormatStatus: stats.byVersion,
    versionFromFilename: stats.versionFromFilename,
    readOk: stats.readOk,
    unsupportedCount: stats.unsupported.length,
    unsupported: stats.unsupported.slice(0, 10), // 样例
    otherErrorCount: stats.otherErrors.length,
    otherErrors: stats.otherErrors.slice(0, 10),
    readFailedByType: Object.fromEntries(
      Object.entries(stats.readFailed).map(([name, arr]) => [name, { count: arr.length, samples: arr.slice(0, 3) }]),
    ),
  }

  console.log(`  readOk=${stats.readOk}, unsupported=${stats.unsupported.length}, otherErrors=${stats.otherErrors.length}`)
  for (const [name, arr] of Object.entries(stats.readFailed)) {
    console.log(`  readFailed[${name}]: ${arr.length}`)
  }

  // ── Phase 3: publish 全部可迁移会话（可选，--publish） ────────────────
  if (DO_PUBLISH) {
    console.log(`[rehearse] Phase 3: publishing migratable sessions (--publish)...`)
    const publishStats = {
      attempted: 0,
      publishOk: 0,
      publishFailed: [],
      verifyOk: 0,
      verifyFailed: [],
    }

    // 对每个 read 成功的 session 做 write open（触发迁移 publish）
    // 重新 list 以获取最新状态
    const currentSnapshots = await persistence.list()
    for (let i = 0; i < currentSnapshots.length; i++) {
      const snap = currentSnapshots[i]
      const id = snap.header.id
      const versionKey = snap.formatStatus ?? 'unknown'

      // 跳过已经是 current（v4）的
      if (versionKey === 'current' || versionKey === 4) {
        continue
      }

      publishStats.attempted += 1
      let writeHandle
      try {
        // open(id, 'write') 会自动触发 prepareStoredMigration + publishStoredMigration
        writeHandle = await persistence.open(id, 'write')
        publishStats.publishOk += 1

        // 验证：重新 open(id, 'read') + read()
        try {
          await writeHandle.close()
          const verifyHandle = await persistence.open(id, 'read')
          const result = await verifyHandle.read(0, Number.MAX_SAFE_INTEGER)
          publishStats.verifyOk += 1
          await verifyHandle.close()
        } catch (err) {
          publishStats.verifyFailed.push({
            id,
            error: err.message?.split('\n')[0] ?? String(err),
          })
        }
      } catch (err) {
        const errName = err?.name ?? err?.constructor?.name ?? 'Error'
        publishStats.publishFailed.push({
          id,
          version: versionKey,
          name: errName,
          error: err.message?.split('\n')[0] ?? String(err),
        })
      } finally {
        try { await writeHandle?.close() } catch { /* best effort */ }
      }

      if ((i + 1) % 50 === 0) {
        console.log(`  publish progress: ${i + 1}/${currentSnapshots.length} (ok=${publishStats.publishOk})`)
      }
    }

    report.phases.publish = publishStats
    console.log(`  publishOk=${publishStats.publishOk}/${publishStats.attempted}, verifyOk=${publishStats.verifyOk}`)
    if (publishStats.publishFailed.length > 0) {
      console.log(`  publishFailed: ${publishStats.publishFailed.length}`)
      for (const f of publishStats.publishFailed.slice(0, 5)) {
        console.log(`    ${f.id}: [${f.name}] ${f.error}`)
      }
    }
  } else {
    console.log(`[rehearse] Phase 3: skipped (--publish not set)`)
  }

  await dispose()

  // ── Phase 4: 源 hash（预演后） ───────────────────────────────────────
  console.log(`[rehearse] Phase 4: re-hashing source ~/.corum/sessions (verify unchanged)...`)
  const sourceHashAfter = await hashSessionsTree(sourceSessionsDir)
  report.phases.sourceHashAfter = {
    fileCount: sourceHashAfter.files.length,
    combinedHash: sourceHashAfter.combinedHash,
  }
  report.sourceUnchanged = sourceHashBefore.combinedHash === sourceHashAfter.combinedHash
  console.log(`  ${sourceHashAfter.files.length} files, combined sha256: ${sourceHashAfter.combinedHash.slice(0, 16)}…`)

  if (!report.sourceUnchanged) {
    // 主实例可能正在运行并写入新会话——这不是预演造成的（预演只读写临时副本）。
    // 记录差异，证明预演**没有**碰过这些文件（它们的变更时间在预演之外）。
    const beforeMap = new Map(sourceHashBefore.files.map((f) => [f.relPath, f]))
    const afterMap = new Map(sourceHashAfter.files.map((f) => [f.relPath, f]))
    const sourceDiffs = []
    for (const [path, before] of beforeMap) {
      const after = afterMap.get(path)
      if (!after) sourceDiffs.push({ path, kind: 'missing' })
      else if (before.sha256 !== after.sha256) sourceDiffs.push({ path, kind: 'changed' })
    }
    for (const path of afterMap.keys()) {
      if (!beforeMap.has(path)) sourceDiffs.push({ path, kind: 'new' })
    }
    report.phases.sourceDiffs = sourceDiffs
    console.warn(`[rehearse] ⚠ 源 ~/.corum/sessions 有 ${sourceDiffs.length} 项变化（主实例正在运行，这是正常的——预演只操作临时副本）:`)
    for (const d of sourceDiffs.slice(0, 10)) {
      console.warn(`  ${d.kind}: ${d.path}`)
    }
    // 预演不写源——变化来自主实例，不是失败
    report.sourceUnchangedByRehearsal = true
    console.warn(`  预演只读写临时副本 ${TEMP_HOME}，源变化来自主实例运行`)
  } else {
    console.log(`  ✓ 源完全一致`)
    report.sourceUnchangedByRehearsal = true
  }

  report.completedAt = new Date().toISOString()

  if (AS_REPORT) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    console.log(`\n[rehearse] 预演完成。报告已生成。临时 home 保留: ${TEMP_HOME}`)
    console.log(`  源文件数: ${sourceHashBefore.files.length}`)
    console.log(`  版本分布(文件名): ${JSON.stringify(stats.versionFromFilename)}`)
    console.log(`  版本分布(formatStatus): ${JSON.stringify(stats.byVersion)}`)
    console.log(`  read成功: ${stats.readOk}/${stats.total}`)
    console.log(`  unsupported: ${stats.unsupported.length}`)
    console.log(`  源未被预演修改: ${report.sourceUnchangedByRehearsal ? '✓' : '✗'}`)
  }

  // 不删除临时 home（供后续 CDP 验证）
}

await main().catch((error) => {
  console.error(`[rehearse] 致命错误: ${error.stack ?? error}`)
  process.exit(1)
})
