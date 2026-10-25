import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { readDirectoryStorage, type DirectoryStorageBackend, type DirectoryStorageSnapshot } from '@corum/corum-agent'
import { directoryEntries, mapDirectoryPath, type DirectoryMove } from './default-session-directory-files.ts'

export interface ArtifactMove extends DirectoryMove { files: Array<{ name: string; contents: string }> }
export interface MetadataPlan {
  artifacts: ArtifactMove[]
  reviews: ArtifactMove[]
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
        const decoded = compressed ? zstdDecompressSync(bytes) : bytes
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
        move.files.push({ name, contents: (compressed ? zstdCompressSync(changed) : changed).toString('base64') })
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
  return { artifacts: scanned.artifacts, reviews, index, storage: { before, after }, sessionIds: scanned.sessionIds }
}
function reviewKey(cwd: string): string { return createHash('sha1').update(cwd).digest('hex').slice(0, 16) }
export async function writePreparedArtifact(move: ArtifactMove): Promise<void> {
  for (const file of move.files) await writeFile(join(move.to, file.name), Buffer.from(file.contents, 'base64'))
}
