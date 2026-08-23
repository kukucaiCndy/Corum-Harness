/**
 * AgentProfile 持久化：读写 `~/.corum/.agent-presets/<id>/agent.json`。
 *
 * 每个 Agent 是一个独立目录（`<preset-root>/<id>/`），包含：
 *   agent.json          — AgentProfile 描述文件（标准 Agent 描述）
 *   agent.cordis.yml     — 编译后的 Cordis 组合（由 compilePreset 生成）
 *   preset.yml           — preset 元数据
 *
 * Skill 采用引用绑定：agent.json 只记录 skill name 列表，不复制文件。
 * Skill 全局统一管理在 ~/.dsh/skills/，Agent mount 时 skill-filesystem
 * 从该目录发现 skill。
 *
 * 兼容旧路径：`~/.corum/agent-profiles/<id>.json` 会被自动迁移。
 * @module @corum/corum-agent-dev/profile-store
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AgentProfile } from './profile.ts'
import { isValidProfileId } from './profile.ts'

/** Agent 目录的存储根（= agent-presets user root）。 */
function agentsRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
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
    : '~/.corum'
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

/** 删除一个 Agent 的整个目录。 */
export function deleteProfile(id: string): void {
  const dir = agentDir(id)
  rmSync(dir, { recursive: true, force: true })
}

/** 获取一个 Agent 的目录绝对路径（供 compile/service 层使用）。 */
export function agentDirPath(id: string): string {
  return agentDir(id)
}
