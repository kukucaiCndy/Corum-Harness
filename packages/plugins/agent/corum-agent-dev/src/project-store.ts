/**
 * Project 持久化：读写 `$CORUM_HOME/projects/<projectId>/project.json`。
 *
 * 每个项目是一个独立目录（`<projects-root>/<id>/`），包含：
 *   project.json              — CorumProject 元信息
 *   scheduler-events.jsonl    — 团队调度事件日志（后续由调度器写入，见
 *                               docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md §3.1）
 *
 * 目录即「项目实例化边界」：本项目的一套 Agent 实例 / 调度状态 / 事件日志
 * 都挂在该目录下，多项目天然隔离。
 * @module @corum/corum-agent-dev/project-store
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { CorumProject } from './project.ts'
import { isValidProjectId } from './project.ts'

/** 项目存储根（$CORUM_HOME/projects）。 */
export function projectsRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'projects')
}

/** 一个项目的目录路径。 */
export function projectDir(id: string): string {
  if (!isValidProjectId(id)) throw new Error(`dev-agent: invalid project id "${id}"`)
  return join(projectsRoot(), id)
}

/** project.json 的路径。 */
function projectJsonPath(id: string): string {
  return join(projectDir(id), 'project.json')
}

/** 读取一个项目的元信息（不存在返回 undefined）。 */
export function loadProject(id: string): CorumProject | undefined {
  const path = projectJsonPath(id)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CorumProject
  } catch {
    return undefined
  }
}

/** 列出所有项目（按 lastOpenedAt 倒序，最近打开在前）。 */
export function listProjects(): CorumProject[] {
  const root = projectsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && isValidProjectId(d.name))
    .map(d => loadProject(d.name))
    .filter((p): p is CorumProject => p !== undefined)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

/** 写入项目元信息（version 自增）。 */
export function saveProject(project: CorumProject): void {
  const path = projectJsonPath(project.id)
  mkdirSync(dirname(path), { recursive: true })
  const current = loadProject(project.id)
  const next: CorumProject = { ...project, version: (current?.version ?? 0) + 1 }
  writeFileSync(path, JSON.stringify(next, null, 2))
}

/** 删除一个项目的整个目录（含调度事件日志）。 */
export function deleteProject(id: string): void {
  rmSync(projectDir(id), { recursive: true, force: true })
}
