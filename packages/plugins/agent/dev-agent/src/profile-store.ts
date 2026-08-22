/**
 * AgentProfile 持久化：读写 `~/.corum-shell/agent-profiles/<id>.json`。
 *
 * 与 PRD §4.0.2 一致：全局存储（不 per-workspace），配置文件不可由 Agent 修改
 * （这里只提供宿主侧读写；Agent 侧不暴露写入口）。
 * @module @corum/dev-agent/profile-store
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AgentProfile } from './profile.ts'
import { isValidProfileId } from './profile.ts'

/** AgentProfile 存储根目录。 */
function profilesRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum-shell'
  return join(resolveDshHome(configured), 'agent-profiles')
}

/** 一个 profile 的文件路径。 */
function profilePath(id: string): string {
  if (!isValidProfileId(id)) throw new Error(`dev-agent: invalid profile id "${id}"`)
  return join(profilesRoot(), `${id}.json`)
}

/** 读取一个 profile（不存在返回 undefined）。 */
export function loadProfile(id: string): AgentProfile | undefined {
  const path = profilePath(id)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentProfile
  } catch {
    return undefined
  }
}

/** 列出所有 profile（按 id）。 */
export function listProfiles(): AgentProfile[] {
  const root = profilesRoot()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(name => name.endsWith('.json'))
    .map(name => loadProfile(name.slice(0, -'.json'.length)))
    .filter((p): p is AgentProfile => p !== undefined)
}

/** 写入一个 profile（创建目录；trust 默认 user；version 自增）。 */
export function saveProfile(profile: AgentProfile): void {
  const path = profilePath(profile.id)
  mkdirSync(dirname(path), { recursive: true })
  const current = loadProfile(profile.id)
  const next: AgentProfile = {
    ...profile,
    version: (current?.version ?? 0) + 1,
    trust: profile.trust ?? 'user',
  }
  writeFileSync(path, JSON.stringify(next, null, 2))
}

/** 删除一个 profile。 */
export function deleteProfile(id: string): void {
  const path = profilePath(id)
  rmSync(path, { force: true })
}
