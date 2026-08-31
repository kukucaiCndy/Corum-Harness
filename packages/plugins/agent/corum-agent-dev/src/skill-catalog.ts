/**
 * 文件系统 skill 目录扫描 —— CORUM_HOME/skills/ 全局 skill 目录的读取。
 *
 * 从 agent-service.ts 拆出（包内文件拆分，零 RPC 面变化）。只读文件系统：
 * 解析各 skill 目录的 SKILL.md frontmatter（name/description/whenToUse/
 * invocation policy）+ skill-versions.json，汇总为 SkillEntry 列表。
 * @module @corum/corum-agent-dev/skill-catalog
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { corumHome } from './home.ts'
import type { SkillEntry } from './skill-entry.ts'

/**
 * 解析 SKILL.md 的 YAML frontmatter，提取 name / description / whenToUse /
 * invocation policy。只做最小解析（不引 yaml 库，手动提取必需字段）。
 */
function parseSkillFrontmatter(content: string): {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
} | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch === null) return undefined
  const fm = fmMatch[1]
  const fields = new Map<string, string>()
  for (const line of fm.split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/)
    if (m !== null) fields.set(m[1], m[2].trim())
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (name === undefined || description === undefined) return undefined
  const whenToUse = fields.get('whenToUse')
  const disableModelInvocation = fields.get('disable-model-invocation') === 'true'
  const userInvocable = fields.get('user-invocable') !== 'false'
  return {
    name,
    description,
    ...(whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {}),
    modelInvocable: !disableModelInvocation,
    userInvocable,
  }
}

/**
 * 读取 skill 目录的版本配置（skill-versions.json）。
 */
function readSkillVersions(dir: string): { versions: Array<{ id: string; date: string; label: string }> } {
  const configPath = join(dir, 'skill-versions.json')
  if (!existsSync(configPath)) return { versions: [] }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return { versions: [] }
  }
}

/**
 * 扫描全局 skill 目录（CORUM_HOME/skills/），返回可用 skill 列表。
 */
export function scanSkills(): SkillEntry[] {
  const skillsRoot = join(corumHome(), 'skills')
  if (!existsSync(skillsRoot)) return []

  let entries
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: SkillEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    const parsed = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf8'))
    if (parsed === undefined) continue
    const { versions } = readSkillVersions(skillDir)
    const latest = versions.length > 0 ? versions[versions.length - 1] : undefined
    skills.push({
      ...parsed,
      path: skillDir,
      versionCount: versions.length,
      ...(latest !== undefined ? { currentVersion: latest.id } : {}),
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}
