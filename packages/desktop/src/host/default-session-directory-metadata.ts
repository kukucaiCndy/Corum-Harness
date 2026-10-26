import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { readDirectoryStorage, type DirectoryStorageBackend, type DirectoryStorageSnapshot } from '@corum/corum-agent'
import { directoryEntries, mapDirectoryPath, type DirectoryMove } from './default-session-directory-files.ts'

export interface ArtifactMove extends DirectoryMove { files: Array<{ name: string; contents: string }> }
export interface RecoveryMetadata { path: string; before: string; after: string }
export interface MetadataPlan {
  artifacts: ArtifactMove[]
  reviews: ArtifactMove[]
  recoveries?: RecoveryMetadata[]
  index: null | { before: string; after: string }
  storage: { before: DirectoryStorageSnapshot[]; after: DirectoryStorageSnapshot[] }
  sessionIds: string[]
}
function projectKey(cwd: string): string {
  let readable = '', separator = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i), char = cwd[i]!
    if (char === '/' || char === '\\' || char === ':') { if (!separator) readable += '-'; separator = true }
    else { readable += /^[A-Za-z0-9._-]$/.test(char) ? char : `~${code.toString(16).toUpperCase().padStart(4, '0')}`; separator = false }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
function encodeSegment(id: string): string {
  if (id === '.' || id === '..') throw new Error('无效会话 artifact ID')
  return id.replace(/[^A-Za-z0-9._-]/g, char => `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}
export function migratedSessionArtifactPath(home: string, cwd: string, id: string, filename: string): string {
  return join(home, 'sessions', projectKey(cwd), encodeSegment(id), filename)
}

/** JSONL writer 将 header 与每次 append 写成独立 zstd frame；Node 的整包解压只返回首帧。 */
function zstdFrames(bytes: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  const incomplete = (): never => { throw new Error('会话 zstd 尾帧不完整') }
  while (offset < bytes.length) {
    const start = offset
    if (bytes.length - offset < 5) incomplete()
    if (bytes.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`会话 zstd frame 无效：${offset}`)
    offset += 4
    const descriptor = bytes[offset++]!
    if (descriptor & 0x18) throw new Error(`会话 zstd frame header 无效：${start}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const headerBytes = (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) +
      (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    if (bytes.length - offset < headerBytes) incomplete()
    offset += headerBytes
    for (;;) {
      if (bytes.length - offset < 3) incomplete()
      const block = bytes.readUIntLE(offset, 3)
      offset += 3
      const kind = (block >>> 1) & 3
      if (kind === 3) throw new Error(`会话 zstd block 无效：${offset - 3}`)
      const size = kind === 1 ? 1 : block >>> 3
      if (bytes.length - offset < size) incomplete()
      offset += size
      if (block & 1) break
    }
    if (checksum) {
      if (bytes.length - offset < 4) incomplete()
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  if (frames.length === 0) incomplete()
  return frames
}

/** 仅结构字段参与路径改写；消息与相对文件名不做替换。 */
function mapFields(value: unknown, moves: DirectoryMove[], fields: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(item => mapFields(item, moves, fields))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    fields.has(key) && typeof item === 'string' ? mapDirectoryPath(item, moves) : mapFields(item, moves, fields),
  ]))
}

export async function scanDirectoryArtifacts(home: string, moves: DirectoryMove[]): Promise<{ artifacts: ArtifactMove[]; sessionIds: string[]; cwds: Set<string> }> {
  const artifacts: ArtifactMove[] = [], ids = new Set<string>(), cwds = new Set<string>()
  const sessions = join(home, 'sessions')
  for (const project of await directoryEntries(sessions)) {
    const projectPath = join(sessions, project)
    if (!(await lstat(projectPath)).isDirectory()) continue
    for (const segment of await directoryEntries(projectPath)) {
      const from = join(projectPath, segment)
      if (!(await lstat(from)).isDirectory()) continue
      let move: ArtifactMove | undefined
      for (const name of await directoryEntries(from)) {
        const compressed = name.endsWith('.zstd')
        const version = parseSessionFormatLogFilename(compressed ? name.slice(0, -5) : name)
        if (version === undefined) {
          if (/^session(?:\.v\d+)?\.jsonl\./.test(name) && !/\.(?:tmp|bak|backup)/.test(name)) throw new Error(`不支持的 artifact 编码：${name}`)
          continue
        }
        if (version > SESSION_FORMAT_VERSION) throw new Error(`不支持的会话格式：${name}`)
        const bytes = await readFile(join(from, name))
        const frames = compressed ? zstdFrames(bytes) : []
        const decodedFrames = frames.map(frame => zstdDecompressSync(bytes.subarray(frame.start, frame.end)))
        const decoded = compressed ? Buffer.concat(decodedFrames) : bytes
        const newline = decoded.indexOf(10)
        if (newline < 0) throw new Error(`会话 header 不完整：${from}`)
        const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded.subarray(0, newline))) as Record<string, unknown>
        if (header.type !== 'session' || header.version !== version || typeof header.id !== 'string' || !header.id || (header.cwd !== undefined && typeof header.cwd !== 'string')) throw new Error(`会话 header 损坏：${from}`)
        if (typeof header.cwd !== 'string') continue
        const cwd = mapDirectoryPath(header.cwd, moves)
        if (cwd === header.cwd) continue
        // 解析事件只用于完整性验证；写入使用原始后缀 Buffer。
        const suffix = decoded.subarray(newline + 1)
        for (const line of new TextDecoder('utf-8', { fatal: true }).decode(suffix).split('\n')) if (line.trim()) JSON.parse(line)
        cwds.add(header.cwd); ids.add(header.id)
        const to = join(sessions, projectKey(cwd), encodeSegment(header.id))
        if (move && move.to !== to) throw new Error(`会话各 generation 身份不一致：${from}`)
        move ??= { from, to, files: [] }
        const changed = Buffer.concat([Buffer.from(JSON.stringify({ ...header, cwd }) + '\n'), suffix])
        const contents = compressed
          ? Buffer.concat([
            zstdCompressSync(Buffer.from(JSON.stringify({ ...header, cwd }) + '\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
            ...(decodedFrames[0]!.length > newline + 1 ? [zstdCompressSync(decodedFrames[0]!.subarray(newline + 1), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })] : []),
            bytes.subarray(frames[0]!.end),
          ])
          : changed
        move.files.push({ name, contents: contents.toString('base64') })
      }
      if (move) artifacts.push(move)
    }
  }
  return { artifacts, sessionIds: [...ids], cwds }
}

export async function planDirectoryMetadata(home: string, moves: DirectoryMove[], backend: DirectoryStorageBackend): Promise<MetadataPlan> {
  const scanned = await scanDirectoryArtifacts(home, moves)
  const before = await readDirectoryStorage(home, backend)
  const after = before.map(snapshot => {
    if (snapshot.descriptor.name === 'session_projcache') return { ...snapshot, tables: { sessions: {} } }
    const fields = new Set(snapshot.descriptor.name === 'workspace' ? ['path'] : ['cwd', 'path', 'parentCwd', 'worktreePath'])
    return { ...snapshot, tables: mapFields(snapshot.tables, moves, fields) as DirectoryStorageSnapshot['tables'] }
  })
  for (const snapshot of before) if (snapshot.descriptor.name === 'workspace') {
    for (const row of Object.values(snapshot.tables.workspaces ?? {})) {
      const path = (row as { path?: string }).path
      if (path && mapDirectoryPath(path, moves) !== path) scanned.cwds.add(path)
    }
  }
  let index: MetadataPlan['index'] = null
  try {
    const original = await readFile(join(home, 'sessions.json'), 'utf8')
    index = { before: original, after: JSON.stringify(mapFields(JSON.parse(original), moves, new Set(['cwd'])), null, 2) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const reviews: ArtifactMove[] = []
  const reviewRoot = join(home, 'review')
  // 包括只存在于 frozen/journal 的已经回收的 worktree。
  for (const key of await directoryEntries(reviewRoot)) {
    const from = join(reviewRoot, key)
    if (!(await lstat(from)).isDirectory()) continue
    const files: ArtifactMove['files'] = []
    let oldWorkspace: string | undefined
    for (const name of ['round-journal.jsonl', 'frozen.jsonl']) {
      let contents: string
      try { contents = await readFile(join(from, name), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      const mapped = contents.split('\n').map(line => {
        if (!line.trim()) return line
        const row = JSON.parse(line) as { workspace?: string }
        if (row.workspace && mapDirectoryPath(row.workspace, moves) !== row.workspace) oldWorkspace = row.workspace
        return JSON.stringify(mapFields(row, moves, new Set(['workspace', 'parentCwd'])))
      }).join('\n')
      files.push({ name, contents: Buffer.from(mapped).toString('base64') })
    }
    oldWorkspace ??= [...scanned.cwds].find(cwd => reviewKey(cwd) === key)
    if (oldWorkspace) {
      if (reviewKey(oldWorkspace) !== key) throw new Error(`Review 工作区与存储目录不一致：${from}`)
      reviews.push({ from, to: join(reviewRoot, reviewKey(mapDirectoryPath(oldWorkspace, moves))), files })
    }
  }
  const recoveries: RecoveryMetadata[] = []
  const recoveryRoot = join(home, 'review-recovery')
  for (const key of await directoryEntries(recoveryRoot)) {
    if (!/^[a-f0-9]{64}$/.test(key)) continue
    const directory = join(recoveryRoot, key)
    for (const name of await directoryEntries(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const path = join(directory, name)
      await validateRecoveryPath(home, path)
      const original = await readFile(path, 'utf8')
      const batch = parseRecoveryBatch(original, name)
      const workspace = mapDirectoryPath(batch.workspace, moves)
      if (workspace !== batch.workspace) recoveries.push({ path, before: original, after: JSON.stringify({ ...batch, workspace }) })
    }
  }
  return { artifacts: scanned.artifacts, reviews, recoveries, index, storage: { before, after }, sessionIds: scanned.sessionIds }
}

function parseRecoveryBatch(contents: string, name: string): { id: string; workspace: string; files: unknown[] } {
  const batch = JSON.parse(contents) as { id: string; workspace: string; files: unknown[] }
  if (batch.id + '.json' !== name || !Array.isArray(batch.files) || typeof batch.workspace !== 'string' || !isAbsolute(batch.workspace)) throw new Error('RecoveryBatch 恢复记录损坏，已停止迁移')
  return batch
}

async function validateRecoveryPath(home: string, path: string): Promise<void> {
  const root = join(home, 'review-recovery'), parts = relative(root, path).split(sep)
  if (!isAbsolute(path) || parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[0]!) || !/^[a-f0-9-]{36}\.json$/.test(parts[1]!)) throw new Error('Recovery metadata journal 文件归属无效')
  // 原地更新固定 hash/UUID 文件；禁止通过任一层链接写出应用数据目录。
  for (const entry of [root, dirname(path), path]) {
    const stat = await lstat(entry)
    if (stat.isSymbolicLink() || (entry === path ? !stat.isFile() : !stat.isDirectory())) throw new Error('Recovery metadata journal 文件归属无效')
  }
}

export async function validateRecoveryMetadata(home: string, records: RecoveryMetadata[], moves: DirectoryMove[]): Promise<void> {
  for (const record of records) {
    await validateRecoveryPath(home, record.path)
    const batch = parseRecoveryBatch(record.before, basename(record.path))
    if (JSON.stringify({ ...batch, workspace: mapDirectoryPath(batch.workspace, moves) }) !== record.after) throw new Error('Recovery metadata journal 路径映射无效')
  }
}

/** before 保留原始 JSON 字节供 rollback；after 仅改顶层 workspace。 */
export async function writeRecoveryMetadata(records: RecoveryMetadata[], side: 'before' | 'after'): Promise<void> {
  for (const record of records) {
    const temporary = `${record.path}.migration-${randomUUID()}.tmp`
    try { await writeFile(temporary, record[side], { mode: 0o600, flush: true }); await rename(temporary, record.path) }
    finally { await rm(temporary, { force: true }) }
  }
}
function reviewKey(cwd: string): string { return createHash('sha1').update(cwd).digest('hex').slice(0, 16) }
export async function writePreparedArtifact(move: ArtifactMove): Promise<void> {
  for (const file of move.files) await writeFile(join(move.to, file.name), Buffer.from(file.contents, 'base64'))
}
