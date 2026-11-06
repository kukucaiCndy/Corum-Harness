import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface DefaultSessionDirectoryStatus {
  root: string
  sessionCount: number
  migration: null | { phase: string; completed: number; total: number }
  error?: string
  warning?: string
}

export interface DefaultSessionDirectories {
  version: 1
  root: string
  sessions: Record<string, string>
}

/** 单文件原子提交；临时文件与目标同盘。 */
export function writeDirectoryJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

export function readDefaultSessionDirectories(home: string): DefaultSessionDirectories {
  let raw: DefaultSessionDirectories
  try { raw = JSON.parse(readFileSync(join(home, 'default-session-directories.json'), 'utf8')) as DefaultSessionDirectories }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, root: resolve(home, 'workspaces'), sessions: {} }
  }
  if (raw.version !== 1 || !isAbsolute(raw.root) || !raw.sessions || Object.values(raw.sessions).some(path => typeof path !== 'string' || !isAbsolute(path))) {
    throw new Error('默认会话目录清单损坏，请保留文件后重试')
  }
  return raw
}

/** 成功创建后才登记，目录使用同一个 sessionId；显式路径不纳入管理。 */
export async function withDefaultSessionDirectory<T>(home: string, sessionId: string, cwd: string | undefined, create: (cwd: string) => Promise<T>): Promise<T> {
  if (cwd?.trim()) return create(cwd)
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('无效的会话 ID')
  const state = readDefaultSessionDirectories(home)
  mkdirSync(state.root, { recursive: true })
  const directory = join(realpathSync(state.root), sessionId)
  mkdirSync(directory)
  try {
    const result = await create(directory)
    const latest = readDefaultSessionDirectories(home)
    latest.sessions[sessionId] = directory
    writeDirectoryJson(join(home, 'default-session-directories.json'), latest)
    return result
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
