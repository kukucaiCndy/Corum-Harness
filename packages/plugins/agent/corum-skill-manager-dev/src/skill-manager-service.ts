/**
 * SkillManagerService — corum Skill 管理服务。
 *
 * 管理全局 skill 目录（~/.dsh/skills/）下的 skill 生命周期：
 *   - 导入（从目录路径或粘贴文本）
 *   - 删除
 *   - 版本管理（日期+序号，文件系统快照，配置文件记录）
 *   - 版本锁定（返回 SkillBinding 供 Agent 引用）
 *
 * 版本管理方案（不依赖 git）：
 *   ~/.dsh/skills/<name>/
 *     SKILL.md               ← 当前版本的 SKILL.md
 *     skill-versions.json    ← 版本配置文件
 *     .versions/             ← 历史版本快照
 *       2026-08-22-01/
 *         SKILL.md
 *
 * 导入时创建初始版本；Agent 绑定时指定 versionId，
 * Agent 创建前把对应版本的 SKILL.md 复制为当前 SKILL.md。
 *
 * @module @corum/corum-skill-manager-dev/skill-manager-service
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillBinding, SkillInfo, SkillVersion, SkillVersionsConfig, ImportResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillManager: SkillManagerService
  }
}

export class SkillManagerService extends TypertRemoteService {
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'skillManager')
  }

  @Remote('listAll')
  listAll(): { skills: SkillInfo[] } {
    return { skills: scanAllSkills() }
  }

  @Remote('importFromFile')
  importFromFile(skillName: string, sourcePath: string): ImportResult {
    if (!skillName || !isValidSkillName(skillName)) {
      return { ok: false, error: `invalid skill name: "${skillName}"` }
    }
    if (!existsSync(sourcePath)) {
      return { ok: false, error: `source path does not exist: ${sourcePath}` }
    }
    const skillMdPath = join(sourcePath, 'SKILL.md')
    if (!existsSync(skillMdPath)) {
      return { ok: false, error: `SKILL.md not found in source directory. 标准格式要求源目录下必须有一个 SKILL.md 文件（YAML frontmatter 含 name + description，后接 markdown body）。` }
    }
    const content = readFileSync(skillMdPath, 'utf8')
    const parsed = parseSkillFrontmatter(content)
    if (parsed === undefined) {
      return { ok: false, error: `SKILL.md 格式不正确。标准格式：文件开头 --- 之间为 YAML frontmatter，必须包含 name 和 description 字段。` }
    }

    const targetDir = skillDirPath(skillName)
    if (existsSync(targetDir)) {
      return { ok: false, error: `skill "${skillName}" already exists` }
    }

    mkdirSync(targetDir, { recursive: true })
    cpSync(sourcePath, targetDir, { recursive: true })
    // 创建初始版本
    createVersion(targetDir, '初始导入')

    return { ok: true, skill: readSkillInfo(skillName) }
  }

  @Remote('importFromText')
  importFromText(skillName: string, content: string): ImportResult {
    if (!skillName || !isValidSkillName(skillName)) {
      return { ok: false, error: `invalid skill name: "${skillName}"` }
    }
    if (!content || content.trim() === '') {
      return { ok: false, error: `content is empty` }
    }
    const parsed = parseSkillFrontmatter(content)
    if (parsed === undefined) {
      return { ok: false, error: `SKILL.md 格式不正确。标准格式：文件开头 --- 之间为 YAML frontmatter，必须包含 name 和 description 字段，后接 markdown body。示例：\n---\nname: my-skill\ndescription: A skill description\n---\nMarkdown body here.` }
    }

    const targetDir = skillDirPath(skillName)
    if (existsSync(targetDir)) {
      return { ok: false, error: `skill "${skillName}" already exists` }
    }

    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'SKILL.md'), content, 'utf8')
    createVersion(targetDir, '初始导入')

    return { ok: true, skill: readSkillInfo(skillName) }
  }

  @Remote('deleteSkill')
  deleteSkill(name: string): { ok: boolean; error?: string } {
    if (!isValidSkillName(name)) return { ok: false, error: `invalid skill name: "${name}"` }
    const dir = skillDirPath(name)
    if (!existsSync(dir)) return { ok: false, error: `skill "${name}" does not exist` }
    rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  }

  @Remote('getSkillHistory')
  getSkillHistory(name: string): { versions: SkillVersion[] } {
    if (!isValidSkillName(name)) return { versions: [] }
    const dir = skillDirPath(name)
    if (!existsSync(dir)) return { versions: [] }
    return { versions: readVersions(dir) }
  }

  @Remote('pinVersion')
  pinVersion(name: string, versionId: string): { binding: SkillBinding } {
    if (!isValidSkillName(name)) throw new Error(`invalid skill name: "${name}"`)
    const dir = skillDirPath(name)
    if (!existsSync(dir)) throw new Error(`skill "${name}" does not exist`)
    const versions = readVersions(dir)
    if (!versions.some(v => v.id === versionId)) {
      throw new Error(`version "${versionId}" not found in skill "${name}"`)
    }
    return { binding: { name, versionId } }
  }
}

export default SkillManagerService

// ── 文件系统 skill 扫描与管理 ────────────────────────────────────────

function skillsRootPath(): string {
  return join(resolveDshHome(), 'skills')
}

function skillDirPath(name: string): string {
  return join(skillsRootPath(), name)
}

function isValidSkillName(name: string): boolean {
  if (!name || name.length === 0) return false
  if (name.startsWith('.')) return false
  if (name.includes('/') || name.includes('\\')) return false
  return true
}

function parseSkillFrontmatter(content: string): { name: string; description: string } | undefined {
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
  return { name, description }
}

const VERSIONS_FILE = 'skill-versions.json'
const VERSIONS_DIR = '.versions'

/** 读取版本配置文件。 */
function readVersions(dir: string): SkillVersion[] {
  const configPath = join(dir, VERSIONS_FILE)
  if (!existsSync(configPath)) return []
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as SkillVersionsConfig
    return config.versions ?? []
  } catch {
    return []
  }
}

/** 写入版本配置文件。 */
function writeVersions(dir: string, versions: SkillVersion[]): void {
  const config: SkillVersionsConfig = { versions }
  writeFileSync(join(dir, VERSIONS_FILE), JSON.stringify(config, null, 2), 'utf8')
}

/** 生成下一个版本 ID（日期+序号）。 */
function nextVersionId(dir: string): string {
  const today = new Date().toISOString().slice(0, 10) // 2026-08-22
  const versions = readVersions(dir)
  const todayVersions = versions.filter(v => v.id.startsWith(today))
  const seq = todayVersions.length + 1
  return `${today}-${String(seq).padStart(2, '0')}`
}

/**
 * 创建一个新版本快照。
 * 把当前 SKILL.md 复制到 .versions/<versionId>/SKILL.md，
 * 并更新 skill-versions.json。
 */
function createVersion(dir: string, label: string): string {
  const versionId = nextVersionId(dir)
  const versionsDir = join(dir, VERSIONS_DIR)
  const versionDir = join(versionsDir, versionId)
  mkdirSync(versionDir, { recursive: true })

  // 复制当前 SKILL.md 到版本目录
  const skillMdPath = join(dir, 'SKILL.md')
  if (existsSync(skillMdPath)) {
    cpSync(skillMdPath, join(versionDir, 'SKILL.md'))
  }

  // 更新版本配置
  const versions = readVersions(dir)
  versions.push({
    id: versionId,
    date: new Date().toISOString(),
    label,
  })
  writeVersions(dir, versions)
  return versionId
}

/** 读取单个 skill 的信息。 */
function readSkillInfo(name: string): SkillInfo {
  const dir = skillDirPath(name)
  const skillMdPath = join(dir, 'SKILL.md')
  let description = ''
  if (existsSync(skillMdPath)) {
    const parsed = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf8'))
    if (parsed !== undefined) description = parsed.description
  }
  const versions = readVersions(dir)
  const latest = versions.length > 0 ? versions[versions.length - 1] : undefined
  return {
    name,
    description,
    path: dir,
    versionCount: versions.length,
    ...(latest !== undefined ? { currentVersion: latest.id, createdAt: latest.date } : {}),
  }
}

/** 扫描全局 skill 目录。 */
function scanAllSkills(): SkillInfo[] {
  const skillsRoot = skillsRootPath()
  if (!existsSync(skillsRoot)) return []

  let entries
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: SkillInfo[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    skills.push(readSkillInfo(entry.name))
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}
