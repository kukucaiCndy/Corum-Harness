/**
 * AgentProfile 持久化：读写 `~/.corum-shell/.agent-presets/<id>/agent.json`。
 *
 * 每个 Agent 是一个独立目录（`<preset-root>/<id>/`），包含：
 *   agent.json          — AgentProfile 描述文件（标准 Agent 描述）
 *   agent.cordis.yml     — 编译后的 Cordis 组合（由 compilePreset 生成）
 *   preset.yml           — preset 元数据
 *   skills/              — 从外部导入的 skill 目录
 *     <skill-name>/
 *       SKILL.md
 *       ...
 *
 * agent.json 是唯一事实源；agent.cordis.yml + preset.yml 由 saveProfile
 * 编译生成（每次保存都重新编译覆盖）。
 *
 * 兼容旧路径：`~/.corum-shell/agent-profiles/<id>.json` 会被自动迁移。
 * @module @corum/dev-agent/profile-store
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AgentProfile } from './profile.ts'
import { isValidProfileId } from './profile.ts'

/** Agent 目录的存储根（= agent-presets user root）。 */
function agentsRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum-shell'
  return join(resolveDshHome(configured), '.agent-presets')
}

/** 一个 Agent 的目录路径。 */
function agentDir(id: string): string {
  if (!isValidProfileId(id)) throw new Error(`dev-agent: invalid profile id "${id}"`)
  return join(agentsRoot(), id)
}

/** agent.json 的路径。 */
function agentJsonPath(id: string): string {
  return join(agentDir(id), 'agent.json')
}

/** 旧路径（flat JSON，用于自动迁移）。 */
function legacyProfilePath(id: string): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum-shell'
  const legacyRoot = join(resolveDshHome(configured), 'agent-profiles')
  return join(legacyRoot, `${id}.json`)
}

/**
 * 读取一个 Agent 的描述文件（agent.json）。
 * 自动从旧路径迁移：若 agent.json 不存在但旧 JSON 存在，迁移之。
 */
export function loadProfile(id: string): AgentProfile | undefined {
  const path = agentJsonPath(id)
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as AgentProfile
    } catch {
      return undefined
    }
  }
  // 旧路径迁移
  const legacy = legacyProfilePath(id)
  if (existsSync(legacy)) {
    try {
      const profile = JSON.parse(readFileSync(legacy, 'utf8')) as AgentProfile
      // 迁移到新路径（不编译 preset，只写 agent.json）
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(profile, null, 2))
      return profile
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 列出所有 Agent（扫描 agent-presets 目录下有 agent.json 的子目录）。 */
export function listProfiles(): AgentProfile[] {
  const root = agentsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(d.name))
    .map(d => loadProfile(d.name))
    .filter((p): p is AgentProfile => p !== undefined)
}

/**
 * 写入 Agent 描述文件（agent.json）。
 * 只写描述文件，不编译 preset（编译由 agent-service 的 writeAgentDir 负责）。
 */
export function saveProfile(profile: AgentProfile): void {
  const path = agentJsonPath(profile.id)
  mkdirSync(dirname(path), { recursive: true })
  const current = loadProfile(profile.id)
  const next: AgentProfile = {
    ...profile,
    version: (current?.version ?? 0) + 1,
    trust: profile.trust ?? 'user',
  }
  writeFileSync(path, JSON.stringify(next, null, 2))
}

/** 删除一个 Agent 的整个目录（含 skills/、agent.cordis.yml 等）。 */
export function deleteProfile(id: string): void {
  const dir = agentDir(id)
  rmSync(dir, { recursive: true, force: true })
}

/** 获取一个 Agent 的目录绝对路径（供 compile/service 层使用）。 */
export function agentDirPath(id: string): string {
  return agentDir(id)
}

/**
 * 从源路径导入一个 skill 到 Agent 的 skills/ 目录。
 * 源可以是包含 SKILL.md 的目录，也可以是 flat .md 文件。
 * 导入 = 复制（源不受影响，Agent 目录拥有独立副本）。
 */
export function importSkill(agentId: string, skillName: string, sourcePath: string): void {
  const dir = agentDir(agentId)
  const skillDir = join(dir, 'skills', skillName)
  mkdirSync(skillDir, { recursive: true })
  cpSync(sourcePath, skillDir, { recursive: true })
}

/** 列出 Agent 目录中已导入的 skills（skills/ 下的子目录名）。 */
export function listImportedSkills(agentId: string): string[] {
  const dir = join(agentDir(agentId), 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
}

/** 删除 Agent 目录中已导入的一个 skill。 */
export function removeImportedSkill(agentId: string, skillName: string): void {
  const skillDir = join(agentDir(agentId), 'skills', skillName)
  rmSync(skillDir, { recursive: true, force: true })
}
