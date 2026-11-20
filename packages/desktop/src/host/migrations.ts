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

import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib'

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

// fork（rc3 适配）：main 的第一条迁移 migrate-remove-stale-runtime-bundle（清理
// 「运行期 bundle」残留）**刻意不移植**——那条迁移的前提是 main 侧已把运行期
// bundle 机制**移除**；而 rc3 的 `runtime-bundle.ts` 是**在用核心机制**（bundle 层
// 是 insert 行唯一合法层，见该文件头注释），把 `corum-desktop-runtime` 从 manifest
// 清掉、把 `$DSH_HOME/desktop-runtime-bundle/` 归档会直接破坏 rc3 的组合。
// 框架本身照常落地：rc3 需要一次性状态修正时在数组末尾追加条目即可。

// ── migrate-distill-completed-ignorable ──────────────────────────────────────

/**
 * 扫描 session.v4.jsonl(.zstd) 文件，对 `corum/distill-completed` 事件补
 * `ignorable:true`。
 *
 * **背景**：二期 memory-distill 用裸 `session.append('corum/distill-completed', …)`
 * 写 durable 会话事件，该类型不在官方 `KNOWN_SESSION_EVENT_TYPES` 且无 `ignorable`
 * 标记 → `validateStoredEvents` 拒绝解释整个会话日志（实机报错：会话
 * corum-task-7e914c2e seq 2583 历史加载失败）。正解改走 `appendPluginRecord`
 * （自动 `ignorable:true`），但**存量已落盘的事件**需一次性补标记。
 *
 * **扫描范围**：`$DSH_HOME/sessions/` 下所有 `session.v4.jsonl.zstd`（zstd 压缩，
 * 多帧容器：header 帧 + event 帧）和 `session.v4.jsonl`（明文，兼容无压缩安装）。
 *
 * **幂等**：已标记 `ignorable:true` 的跳过；无此类型的文件跳过；迁移框架还记 id。
 *
 * **不阻塞启动**：单文件 try/catch，失败只打 stderr。
 *
 * **原子写**：临时文件 + rename（照仓内 storage-json 的 writeAtomic 先例）。
 */
function migrateDistillCompletedIgnorable(ctx: MigrationContext): void {
  const sessionsDir = join(ctx.home, 'sessions')
  if (!existsSync(sessionsDir)) return

  const zstdFiles = collectSessionV4Files(sessionsDir)
  for (const filePath of zstdFiles) {
    try {
      migrateOneSessionFile(filePath)
    } catch (error) {
      process.stderr.write(
        `[corum-desktop] 迁移「migrate-distill-completed-ignorable」单文件失败（忽略）：${filePath}: ${String(error)}\n`,
      )
    }
  }
}

/** Zstandard frame magic number (little-endian). */
const ZSTD_MAGIC = 4247762216
/** zstd 压缩参数：启用校验和（与官方 persistence-jsonl 的 CHECKSUM_OPTIONS 一致）。 */
const ZSTD_CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

/**
 * 递归收集 sessions 目录下所有 `session.v4.jsonl.zstd` 和 `session.v4.jsonl` 文件路径。
 * 照会话存储的目录结构：`sessions/<projectKey>/<sessionId>/session.v4.jsonl(.zstd)`。
 */
function collectSessionV4Files(rootDir: string): string[] {
  const results: string[] = []
  function scan(dir: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(fullPath)
      } else if (entry.isFile() && (entry.name === 'session.v4.jsonl.zstd' || entry.name === 'session.v4.jsonl')) {
        results.push(fullPath)
      }
    }
  }
  scan(rootDir)
  return results
}

/**
 * 扫描 Zstandard 多帧容器的完整帧边界。
 *
 * 照 `dsh-session-persistence-jsonl` 的 `scanZstdFrames` 逻辑：遍历 magic number →
 * descriptor → optional fields → block loop → optional checksum，记录每帧的 [start, end)。
 */
function scanZstdFrames(buf: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) break // 残余字节不足 magic → 停（迁移不修 torn tail）
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buf.length) break
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    // block loop
    for (;;) {
      if (buf.length - offset < 3) break
      const b0 = buf[offset]!
      const b1 = buf[offset + 1]!
      const b2 = buf[offset + 2]!
      const lastBlock = b0 & 1
      const blockSize = ((b0 | (b1 << 8) | (b2 << 16)) >> 3) & 0xFFFFFF
      offset += 3 + blockSize
      if (lastBlock) break
    }
    const checksum = (descriptor & 4) !== 0
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * 解码整个 Zstandard 多帧容器为明文 Buffer（逐帧 decompress 再 concat）。
 */
function decodeZstdFile(bytes: Buffer): Buffer {
  const frames = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const chunks: Buffer[] = []
  for (const frame of frames) {
    const decompressed = zstdDecompressSync(bytes.subarray(frame.start, frame.end))
    chunks.push(decompressed)
  }
  return Buffer.concat(chunks)
}

/**
 * 处理单个 session.v4.jsonl(.zstd) 文件：
 * 1. 读取字节（zstd 或明文）
 * 2. 解码为明文
 * 3. 字符串预筛 `corum/distill-completed`（快速跳过不含此类型的文件）
 * 4. 逐行 JSON.parse，对 `type==='corum/distill-completed'` 且 `ignorable!==true` 的补 `ignorable:true`
 * 5. 重编码为 header 帧 + event 帧（照 persistence-jsonl 的 encodeMaterialization 结构）
 * 6. 原子写（临时文件 + rename）
 *
 * 幂等：所有 distill-completed 事件已标记 ignorable → 不改文件。
 */
function migrateOneSessionFile(filePath: string): void {
  const bytes = readFileSync(filePath)
  const isZstd = filePath.endsWith('.zstd')
  const plaintext = isZstd ? decodeZstdFile(bytes) : bytes
  const text = plaintext.toString('utf8')

  // 快速预筛：不含此类型字符串的文件直接跳过（不解析、不重写）。
  if (!text.includes('corum/distill-completed')) return

  const lines = text.split('\n')
  // 第一行是 header（JSON），其余是事件（JSON per line）。
  // 照 persistence-jsonl 结构：header 行 + 事件行，最后一行可能是空行（trailing \n）。
  let modified = false
  const headerLine = lines[0] ?? ''
  const eventLines: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') {
      eventLines.push(line)
      continue
    }
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'corum/distill-completed' && event.ignorable !== true) {
        event.ignorable = true
        modified = true
      }
      eventLines.push(JSON.stringify(event))
    } catch {
      // JSON.parse 失败 → 原样保留（不破坏文件）
      eventLines.push(line)
    }
  }

  if (!modified) return // 幂等：无需修改

  // 重编码：header 帧 + event 帧（照 persistence-jsonl 的 encodeMaterialization）
  const headerBytes = Buffer.from(headerLine + '\n', 'utf8')
  const eventBody = eventLines.join('\n') + '\n'
  const eventBytes = Buffer.from(eventBody, 'utf8')

  let output: Buffer
  if (isZstd) {
    const headerFrame = zstdCompressSync(headerBytes, ZSTD_CHECKSUM_OPTIONS)
    const eventFrame = zstdCompressSync(eventBytes, ZSTD_CHECKSUM_OPTIONS)
    output = Buffer.concat([headerFrame, eventFrame])
  } else {
    output = Buffer.concat([headerBytes, eventBytes])
  }

  // 原子写：临时文件 + rename（照 storage-json 的 writeAtomic 先例）
  const tmpPath = join(dirname(filePath), `.migration-tmp-${Date.now()}-${process.pid}`)
  writeFileSync(tmpPath, output)
  renameSync(tmpPath, filePath)
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 'migrate-distill-completed-ignorable',
    description: '补 corum/distill-completed 会话事件的 ignorable:true 标记（修复裸 append 导致的会话日志拒绝解释）',
    run: migrateDistillCompletedIgnorable,
  },
]

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
