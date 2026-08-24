/**
 * Team 持久化：读写 `$CORUM_HOME/teams/<teamId>/team.json`。
 *
 * 团队是全局配置（独立于项目），每个团队一个独立目录。团队只是 profile 的
 * 命名集合——memberProfileIds 引用全局 AgentProfile（.agent-presets/）。
 * @module @corum/corum-agent-dev/team-store
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { CorumTeam } from './team.ts'
import { isValidTeamId } from './team.ts'

/** 团队存储根（$CORUM_HOME/teams）。 */
export function teamsRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'teams')
}

/** 一个团队的目录路径。 */
export function teamDir(id: string): string {
  if (!isValidTeamId(id)) throw new Error(`dev-agent: invalid team id "${id}"`)
  return join(teamsRoot(), id)
}

/** team.json 的路径。 */
function teamJsonPath(id: string): string {
  return join(teamDir(id), 'team.json')
}

/** 读取一个团队（不存在返回 undefined）。 */
export function loadTeam(id: string): CorumTeam | undefined {
  const path = teamJsonPath(id)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CorumTeam
  } catch {
    return undefined
  }
}

/** 列出所有团队（按创建时间升序）。 */
export function listTeams(): CorumTeam[] {
  const root = teamsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && isValidTeamId(d.name))
    .map(d => loadTeam(d.name))
    .filter((t): t is CorumTeam => t !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 写入团队（version 自增）。 */
export function saveTeam(team: CorumTeam): void {
  const path = teamJsonPath(team.id)
  mkdirSync(dirname(path), { recursive: true })
  const current = loadTeam(team.id)
  const next: CorumTeam = { ...team, version: (current?.version ?? 0) + 1 }
  writeFileSync(path, JSON.stringify(next, null, 2))
}

/** 删除一个团队的整个目录。 */
export function deleteTeam(id: string): void {
  rmSync(teamDir(id), { recursive: true, force: true })
}
