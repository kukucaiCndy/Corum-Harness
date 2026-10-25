import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { DefaultSessionDirectoryStatus } from '@corum/corum-agent'
import { directoryEntries, within } from './default-session-directory-files.ts'
export type { DefaultSessionDirectoryStatus } from '@corum/corum-agent'

export async function recordDefaultSessionDirectoryFailure(home: string, error: string): Promise<void> {
  const path = join(home, 'default-session-directory-result.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify({ error }), { mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}

/** 只能在旧 child 已退出、下一代尚未启动时撤销未执行的请求。 */
export async function recoverDefaultSessionDirectoryAfterExit(home: string, error: string): Promise<void> {
  const path = join(home, 'default-session-directory-migration.json')
  try {
    const pending = JSON.parse(await readFile(path, 'utf8')) as { phase?: string }
    if (pending.phase !== 'requested') throw new Error('迁移已开始，不能按停机失败撤销，请重试恢复')
    await rm(path)
  } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
  await recordDefaultSessionDirectoryFailure(home, error)
}

/** 只依赖 Node 内建模块，Electron 在 Host 离线期间也能读取同一份进度。 */
export async function getDefaultSessionDirectoryStatus(home: string): Promise<DefaultSessionDirectoryStatus> {
  async function json<T>(name: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(join(home, name), 'utf8')) as T }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
  }
  const state = await json('default-session-directories.json', { root: join(home, 'workspaces'), sessions: {} as Record<string, string> })
  const pending = await json<null | { phase: string; completed: number; sessionIds: string[]; moves: unknown[]; prepared?: { artifacts: unknown[]; reviews: unknown[] } }>('default-session-directory-migration.json', null)
  const result = await json<{ error?: string; warning?: string }>('default-session-directory-result.json', {})
  const ids = new Set([...Object.keys(state.sessions), ...(pending?.sessionIds ?? [])])
  if (!pending && Object.keys(state.sessions).length) {
    for (const project of await directoryEntries(join(home, 'sessions'))) {
      if (!(await lstat(join(home, 'sessions', project))).isDirectory()) continue
      for (const segment of await directoryEntries(join(home, 'sessions', project))) {
        const folder = join(home, 'sessions', project, segment)
        if (!(await lstat(folder)).isDirectory()) continue
        for (const name of await directoryEntries(folder)) {
          if (!/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name)) continue
          const bytes = await readFile(join(folder, name))
          const decoded = name.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes
          const header = JSON.parse(decoded.subarray(0, decoded.indexOf(10)).toString()) as { id?: string; cwd?: string }
          if (header.id && header.cwd && Object.values(state.sessions).some(root => within(header.cwd!, root))) ids.add(header.id)
        }
      }
    }
  }
  return {
    root: state.root, sessionCount: ids.size,
    migration: pending ? { phase: pending.phase, completed: pending.completed, total: pending.moves.length + (pending.prepared?.artifacts.length ?? 0) + (pending.prepared?.reviews.length ?? 0) } : null,
    ...result,
  }
}
