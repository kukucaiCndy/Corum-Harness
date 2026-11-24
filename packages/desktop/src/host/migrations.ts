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
 * 多帧容器：header 帧 + 多个 event 帧，每帧一个独立 append batch）和
 * `session.v4.jsonl`（明文，兼容无压缩安装）。
 *
 * **帧契约**：逐帧保留边界修补——不合并帧。照官方 `scanZstdFrames` 返回
 * `{ frames, tornStart }`：每个完整帧解码→逐行修补→重编码为**一个独立帧**；
 * torn 末帧字节原样保留（官方持久层容忍 torn tail，读路径丢弃、写路径首
 * append 修复，迁移不得把它合并进完整帧否则破坏容忍契约）。
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
const ZSTD_MAGIC = 0xFD2FB528
/** zstd 压缩参数：启用校验和（与官方 persistence-jsonl 的 CHECKSUM_OPTIONS 一致）。 */
const ZSTD_CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

/** 完整帧的字节范围 [start, end)（照官方 `ZstdFrameRange`）。 */
interface FrameRange { start: number; end: number }

/** 帧扫描结果（照官方 `ZstdFrameScan`）：完整帧列表 + 可选的 torn 末帧起点。 */
interface FrameScanResult {
  frames: FrameRange[]
  /** EOF 中断了最后一帧时的起点；官方持久层容忍它、读路径丢弃它，迁移也须原样保留。 */
  tornStart?: number
}

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
 * 扫描 Zstandard 多帧容器的完整帧边界（照官方 `scanZstdFrames` 契约）。
 *
 * 与官方 `dsh-session-persistence-jsonl/src/zstd.ts` 的 `scanZstdFrames` **逐字节对齐**：
 * 遍历 magic → descriptor → optional fields → block loop → optional checksum，
 * 记录每帧的 [start, end)。EOF 落在一帧内部时返回 `tornStart`（该帧起点），
 * 而非静默 `break`——官方持久层容忍 torn 末帧（读路径丢弃、写路径首 append 修复），
 * 迁移**不得**把它合并进完整帧，否则破坏容忍契约导致 corrupt。
 */
function scanZstdFrames(buf: Buffer): FrameScanResult {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    // block loop
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      // RLE block 的 payload固定 1 字节，其余 = blockSize
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 对一段明文 JSONL 逐行修补 `corum/distill-completed` 的 `ignorable:true`。
 *
 * @returns `{ plaintext, modified }`——plaintext 是修补后的完整明文（含 trailing newline），
 *          modified 表示是否有行被改过（幂等短路）。
 */
function patchDistillCompletedIgnorable(plaintext: Buffer): { plaintext: Buffer; modified: boolean } {
  const text = plaintext.toString('utf8')
  if (!text.includes('corum/distill-completed')) return { plaintext, modified: false }

  const lines = text.split('\n')
  let modified = false
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') {
      out.push(line)
      continue
    }
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'corum/distill-completed' && event.ignorable !== true) {
        event.ignorable = true
        modified = true
      }
      out.push(JSON.stringify(event))
    } catch {
      // JSON.parse 失败 → 原样保留（不破坏文件）
      out.push(line)
    }
  }
  if (!modified) return { plaintext, modified: false }
  return { plaintext: Buffer.from(out.join('\n'), 'utf8'), modified: true }
}

/**
 * 处理单个 session.v4.jsonl(.zstd) 文件：逐帧保留边界修补，不合并帧。
 *
 * **zstd 多帧容器**（照官方 persistence-jsonl 帧契约）：
 * - 扫描完整帧 + torn 末帧起点（`scanZstdFrames`）
 * - 每个完整帧：解码→逐行修补→重编码为**一个独立帧**（保留原始帧边界）
 * - torn 末帧字节：原样拷贝（不解码、不合并、不丢弃）——官方读路径容忍它
 * - concat [帧0][帧1]...[帧N-1][torn 原始字节] → 原子写
 *
 * **明文 jsonl**：逐行修补，整体重写（无帧概念）。
 *
 * **幂等**：所有 distill-completed 已标记 ignorable → 不改文件。
 */
function migrateOneSessionFile(filePath: string): void {
  const bytes = readFileSync(filePath)
  const isZstd = filePath.endsWith('.zstd')

  if (isZstd) {
    const scan = scanZstdFrames(bytes)
    if (scan.frames.length === 0) return // 空 / 仅 header-less → 不动

    // 逐帧解码 + 修补，收集需要重写的帧
    const outFrames: Buffer[] = []
    let anyModified = false
    for (const frame of scan.frames) {
      const frameBytes = bytes.subarray(frame.start, frame.end)
      const plaintext = zstdDecompressSync(frameBytes)
      const { plaintext: patched, modified } = patchDistillCompletedIgnorable(plaintext)
      if (modified) {
        anyModified = true
        outFrames.push(zstdCompressSync(patched, ZSTD_CHECKSUM_OPTIONS))
      } else {
        // 未改的帧：保留原始字节（连 checksum 也不动）
        outFrames.push(frameBytes)
      }
    }
    if (!anyModified) return // 幂等：无改动

    // 重组：[帧0][帧1]...[帧N-1] + [torn 原始字节（如有）]
    const parts: Buffer[] = [...outFrames]
    if (scan.tornStart !== undefined) {
      parts.push(bytes.subarray(scan.tornStart))
    }
    const output = Buffer.concat(parts)

    // 原子写：临时文件 + rename（照 storage-json 的 writeAtomic 先例）
    const tmpPath = join(dirname(filePath), `.migration-tmp-${Date.now()}-${process.pid}`)
    writeFileSync(tmpPath, output)
    renameSync(tmpPath, filePath)
  } else {
    // 明文 jsonl：逐行修补
    const { plaintext: patched, modified } = patchDistillCompletedIgnorable(bytes)
    if (!modified) return
    const tmpPath = join(dirname(filePath), `.migration-tmp-${Date.now()}-${process.pid}`)
    writeFileSync(tmpPath, patched)
    renameSync(tmpPath, filePath)
  }
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
