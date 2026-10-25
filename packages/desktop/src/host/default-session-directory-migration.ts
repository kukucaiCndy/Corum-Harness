import { existsSync, readFileSync } from 'node:fs'
import { link, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readDefaultSessionDirectories, writeDirectoryJson, writeDirectoryStorage, type DefaultSessionDirectories, type DirectoryStorageBackend } from '@corum/corum-agent'
import { canonicalDirectory, copyDirectoryChecked, mapDirectoryPath, repairDirectoryGit, within, type DirectoryMove } from './default-session-directory-files.ts'
import { planDirectoryMetadata, scanDirectoryArtifacts, writePreparedArtifact, type ArtifactMove, type MetadataPlan } from './default-session-directory-metadata.ts'
export { migratedSessionArtifactPath } from './default-session-directory-metadata.ts'
export { getDefaultSessionDirectoryStatus } from './default-session-directory-status.ts'
import { acquireDefaultSessionDirectoryGuard } from './default-session-directory-lock.ts'

interface MigrationJournal {
  version: 1
  id: string
  phase: 'requested' | 'files' | 'metadata' | 'active' | 'cleanup'
  backend: DirectoryStorageBackend
  before: DefaultSessionDirectories
  after: DefaultSessionDirectories
  moves: DirectoryMove[]
  sessionIds: string[]
  prepared?: MetadataPlan
  owned: string[]
  completed: number
}
const journalPath = (home: string) => join(home, 'default-session-directory-migration.json')
const resultPath = (home: string) => join(home, 'default-session-directory-result.json')
function journal(home: string): MigrationJournal | undefined {
  try { return JSON.parse(readFileSync(journalPath(home), 'utf8')) as MigrationJournal }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
function save(home: string, value: MigrationJournal) { writeDirectoryJson(journalPath(home), value) }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

async function acquireMigrationLock(home: string): Promise<() => Promise<void>> {
  const release = await acquireDefaultSessionDirectoryGuard(home)
  const path = join(home, 'default-session-directory-migration.lock')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    // OS guard 已排除所有本版 writer/recoverer；遗留空 PID 文件仅是诊断，不作活性猜测。
    await rm(path, { force: true })
    await writeFile(temporary, String(process.pid), { flag: 'wx', mode: 0o600 })
    await link(temporary, path)
    await rm(temporary)
  } catch (error) {
    try { await rm(temporary, { force: true }) } finally { await release() }
    throw error
  }
  return async () => { try { await rm(path, { force: true }) } finally { await release() } }
}

export function defaultSessionDirectoryBackend(config: { backend?: unknown; routes?: Record<string, unknown> } | undefined): DirectoryStorageBackend {
  const routes = ['workspace', 'corum_orchestration', 'session_projcache'].map(name => config?.routes?.[name] ?? config?.backend)
  if (!routes.every(route => route === routes[0]) || (routes[0] !== 'json' && routes[0] !== 'sqlite')) throw new Error('当前存储后端 backend 或分流配置不支持默认目录迁移')
  return routes[0]
}

/** 在任何恢复写入或 recursive rm 前校验清单和 journal 授权边界。 */
async function validateJournal(home: string, pending: MigrationJournal): Promise<void> {
  const fail = () => { throw new Error('迁移 journal 的路径归属或阶段无效，已保留数据，请检查后重试') }
  const same = (a: string, b: string) => within(a, b) && within(b, a)
  if (pending.version !== 1 || !['requested', 'files', 'metadata', 'active', 'cleanup'].includes(pending.phase) || !['json', 'sqlite'].includes(pending.backend)) fail()
  const live = readDefaultSessionDirectories(home)
  if (!same(live.root, pending.before.root) && !(['active', 'cleanup'].includes(pending.phase) && same(live.root, pending.after.root))) fail()
  const oldRoot = await canonicalDirectory(pending.before.root), newRoot = await canonicalDirectory(pending.after.root)
  if (within(oldRoot, newRoot) || within(newRoot, oldRoot)) fail()
  for (const name of ['sessions', 'storages', 'review']) {
    const protectedRoot = await canonicalDirectory(join(home, name))
    if (within(newRoot, protectedRoot) || within(protectedRoot, newRoot) || within(oldRoot, protectedRoot) || within(protectedRoot, oldRoot)) fail()
  }
  if (pending.moves.length !== Object.keys(pending.before.sessions).length || Object.keys(pending.after.sessions).length !== pending.moves.length) fail()
  for (const [id, original] of Object.entries(pending.before.sessions)) {
    const source = await canonicalDirectory(original)
    const move = pending.moves.find(item => same(item.from, source))
    if (!move || !isAbsolute(move.from) || !isAbsolute(move.to) || !within(source, oldRoot) || same(source, oldRoot) || !same(move.to, join(newRoot, basename(source))) || !same(pending.after.sessions[id] ?? '', move.to)) fail()
  }
  const allowed = new Set(pending.moves.map(move => move.to))
  for (const [kind, copies] of [['sessions', pending.prepared?.artifacts ?? []], ['review', pending.prepared?.reviews ?? []]] as const) {
    const root = await canonicalDirectory(join(home, kind))
    for (const copy of copies) {
      for (const path of [copy.from, copy.to]) {
        const canonical = await canonicalDirectory(path)
        const segments = relative(root, canonical).split(sep)
        if (!isAbsolute(path) || !within(canonical, root) || segments.length !== (kind === 'sessions' ? 2 : 1) || segments.some(part => !part || part === '.' || part === '..')) fail()
      }
      if (same(copy.from, copy.to) || copy.files.some(file => basename(file.name) !== file.name || file.name === '.' || file.name === '..')) fail()
      allowed.add(copy.to)
    }
  }
  if (pending.owned.some(path => !allowed.has(path))) fail()
}

/** 只做预检与持久化请求，必须在 Host 门禁持有期间调用。 */
export async function requestDefaultSessionDirectoryMigration(home: string, destination: string, backend: DirectoryStorageBackend = 'sqlite'): Promise<boolean> {
  await mkdir(home, { recursive: true })
  const release = await acquireMigrationLock(home)
  try {
    if (!destination.trim() || !isAbsolute(destination)) throw new Error('请选择完整的目标目录路径')
    if (journal(home)) throw new Error('已有迁移等待恢复，请重启会话服务后重试')
    const before = readDefaultSessionDirectories(home)
    const old = await canonicalDirectory(before.root), target = await canonicalDirectory(destination)
    if (within(old, target) && within(target, old)) return false
    if (within(old, target) || within(target, old)) throw new Error('新旧目录不能互为父子目录或重叠')
    for (const protectedName of ['sessions', 'storages', 'review']) {
      const protectedRoot = await canonicalDirectory(join(home, protectedName))
      if (within(target, protectedRoot) || within(protectedRoot, target)) throw new Error('目标目录与应用数据目录重叠')
    }
    const moves: DirectoryMove[] = []
    for (const [id, ownedPath] of Object.entries(before.sessions)) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('管理清单中的会话 ID 无效')
      const from = await canonicalDirectory(ownedPath)
      if (!within(from, old) || within(old, from)) throw new Error(`管理目录不在默认根目录内：${ownedPath}`)
      const to = join(target, basename(from))
      if (existsSync(to)) throw new Error(`目标会话目录已存在：${to}`)
      if (moves.some(move => within(from, move.from) || within(move.from, from) || move.to === to)) throw new Error('管理清单目录重叠')
      moves.push({ from, to })
    }
    const scanned = await scanDirectoryArtifacts(home, moves)
    await mkdir(target, { recursive: true })
    const probe = join(target, `.corum-write-probe-${randomUUID()}`)
    try { const handle = await open(probe, 'wx', 0o600); await handle.close() } finally { await rm(probe, { force: true }) }
    const after: DefaultSessionDirectories = { ...before, root: target, sessions: Object.fromEntries(Object.entries(before.sessions).map(([id, path]) => [id, mapDirectoryPath(path, moves)])) }
    save(home, { version: 1, id: randomUUID(), phase: 'requested', backend, before, after, moves, sessionIds: [...new Set([...Object.keys(before.sessions), ...scanned.sessionIds])], owned: [], completed: 0 })
    writeDirectoryJson(resultPath(home), {})
    return true
  } finally { await release() }
}

/** flush/正常停机未成功时取消请求；文件搬迁尚未开始。 */
export async function cancelDefaultSessionDirectoryMigration(home: string, error: string): Promise<void> {
  const pending = journal(home)
  if (pending?.phase === 'requested') await rm(journalPath(home))
  writeDirectoryJson(resultPath(home), { error })
}

async function writeIndex(home: string, contents: string): Promise<void> {
  writeDirectoryJson(join(home, 'sessions.json'), JSON.parse(contents))
}

/** 旧 Host 已退出之后、任何运行对象装载之前执行，所有阶段均可幂等恢复。 */
export async function migrateDefaultSessionDirectoriesAtBoot(home: string): Promise<void> {
  if (!journal(home)) return
  const release = await acquireMigrationLock(home)
  try {
    const pending = journal(home)
    if (!pending) return
    await validateJournal(home, pending)
    try {
      if (pending.phase === 'requested' || pending.phase === 'files') {
        pending.prepared ??= await planDirectoryMetadata(home, pending.moves, pending.backend)
        pending.sessionIds = [...new Set([...Object.keys(pending.before.sessions), ...pending.prepared.sessionIds])]
        pending.phase = 'files'; save(home, pending)
        const copies = [...pending.moves, ...pending.prepared.artifacts, ...pending.prepared.reviews]
        for (const copy of copies) if (!pending.owned.includes(copy.to) && existsSync(copy.to)) throw new Error(`目标目录冲突：${copy.to}`)
        pending.completed = 0
        for (const copy of copies) {
          if (pending.owned.includes(copy.to)) await rm(copy.to, { recursive: true, force: true })
          else { pending.owned.push(copy.to); save(home, pending) }
          await mkdir(dirname(copy.to), { recursive: true })
          await copyDirectoryChecked(copy.from, copy.to, pending.moves)
          if ('files' in copy) await writePreparedArtifact(copy as ArtifactMove)
          pending.completed++; save(home, pending)
        }
        for (const move of pending.moves) await repairDirectoryGit(move.to, pending.moves)
        pending.phase = 'metadata'; save(home, pending)
      }
      if (pending.phase === 'metadata') {
        if (!pending.prepared) throw new Error('迁移 metadata 快照缺失')
        await writeDirectoryStorage(home, pending.backend, pending.prepared.storage.after)
        if (pending.prepared.index) await writeIndex(home, pending.prepared.index.after)
        // manifest 是明确 commit point。先写 active journal；下次启动会重做 manifest。
        pending.phase = 'active'; save(home, pending)
      }
      if (pending.phase === 'active') {
        writeDirectoryJson(join(home, 'default-session-directories.json'), pending.after)
        pending.phase = 'cleanup'; save(home, pending)
      }
    } catch (error) {
      if (pending.phase === 'active' || pending.phase === 'cleanup') throw error
      // 已开始写 metadata 时完整回退，然后才允许 boot 继续。
      if (pending.phase === 'metadata' && pending.prepared) {
        await writeDirectoryStorage(home, pending.backend, pending.prepared.storage.before)
        if (pending.prepared.index) await writeIndex(home, pending.prepared.index.before)
      }
      writeDirectoryJson(join(home, 'default-session-directories.json'), pending.before)
      for (const path of pending.owned) await rm(path, { recursive: true, force: true })
      await rm(journalPath(home))
      writeDirectoryJson(resultPath(home), { error: `迁移未完成，原位置仍有效：${message(error)}` })
      return
    }
    try {
      for (const move of [...pending.moves, ...(pending.prepared?.artifacts ?? []), ...(pending.prepared?.reviews ?? [])]) await rm(move.from, { recursive: true, force: true })
      await rm(journalPath(home))
      writeDirectoryJson(resultPath(home), {})
    } catch (error) {
      writeDirectoryJson(resultPath(home), { warning: `新位置已生效，旧目录尚未清理完成：${message(error)}` })
    }
  } finally { await release() }
}
