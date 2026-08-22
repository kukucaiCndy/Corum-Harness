/**
 * SkillManagerService — corum Skill 管理服务。
 *
 * 管理全局 skill 目录（~/.dsh/skills/）下的 skill 生命周期：
 *   - 导入（从目录路径或粘贴文本）
 *   - 删除
 *   - git 版本追踪（init + commit + log）
 *   - 版本锁定（返回 SkillBinding 供 Agent 引用）
 *
 * 继承 TypertRemoteService，通过 @Remote 装饰器把 listAll / importFromFile /
 * importFromText / deleteSkill / getSkillHistory / pinVersion 暴露为
 * /api/skillManager/* 端点，供浏览器半（dev-agent-shell）经桌面 IPC 桥调用。
 *
 * @module @corum/dev-skill-manager/skill-manager-service
 */

import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillBinding, SkillHistoryEntry, SkillInfo, ImportResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum Skill 管理服务（导入 / 删除 / 版本追踪 / 绑定）。 */
    skillManager: SkillManagerService
  }
}

/**
 * SkillManagerService — Skill 全局管理服务。
 */
export class SkillManagerService extends TypertRemoteService {
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'skillManager')
  }

  // ── TypertRemoteService @Remote 端点（/api/skillManager/*） ──────────

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
    gitInitAndCommit(targetDir)

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
    gitInitAndCommit(targetDir)

    return { ok: true, skill: readSkillInfo(skillName) }
  }

  @Remote('deleteSkill')
  deleteSkill(name: string): { ok: boolean; error?: string } {
    if (!isValidSkillName(name)) {
      return { ok: false, error: `invalid skill name: "${name}"` }
    }
    const dir = skillDirPath(name)
    if (!existsSync(dir)) {
      return { ok: false, error: `skill "${name}" does not exist` }
    }
    rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  }

  @Remote('getSkillHistory')
  getSkillHistory(name: string): { history: SkillHistoryEntry[] } {
    if (!isValidSkillName(name)) return { history: [] }
    const dir = skillDirPath(name)
    if (!existsSync(dir)) return { history: [] }
    return { history: getGitLog(dir) }
  }

  @Remote('pinVersion')
  pinVersion(name: string, commitHash: string): { binding: SkillBinding } {
    if (!isValidSkillName(name)) throw new Error(`invalid skill name: "${name}"`)
    const dir = skillDirPath(name)
    if (!existsSync(dir)) throw new Error(`skill "${name}" does not exist`)
    try {
      execSync(`git cat-file -t ${commitHash}`, { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      throw new Error(`commit "${commitHash}" not found in skill "${name}"`)
    }
    return { binding: { name, commitHash } }
  }
}

export default SkillManagerService

// ── 文件系统 skill 扫描与管理（~/.dsh/skills/ 全局目录） ──────────────────

/**
 * 解析 skills 根目录路径（~/.dsh/skills/）。
 * 不依赖 DSH_HOME（corum 把它设成了 ~/.corum-shell）。
 */
function skillsRootPath(): string {
  return join(resolveDshHome('~/.dsh'), 'skills')
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

/** git 执行选项：stdio pipe 抑制 stderr 输出到终端。 */
const GIT_STDIO = ['pipe', 'pipe', 'pipe'] as Array<'pipe'>

function getGitInfo(dir: string): { gitCommit?: string; gitDirty?: boolean } {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: GIT_STDIO }).trim()
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: GIT_STDIO }).trim()
    return { gitCommit: commit, gitDirty: status !== '' }
  } catch {
    return {}
  }
}

function gitInitAndCommit(dir: string): void {
  try {
    execSync('git init', { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: GIT_STDIO })
    execSync('git add -A', { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: GIT_STDIO })
    execSync('git commit -m "initial import"', { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: GIT_STDIO })
  } catch {
    // git 不可用或 commit 失败时静默跳过
  }
}

function getCreatedAt(dir: string): string | undefined {
  try {
    const date = execSync('git log --reverse --format=%cI', { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: GIT_STDIO }).trim().split('\n')[0]
    return date || undefined
  } catch {
    return undefined
  }
}

function getGitLog(dir: string): SkillHistoryEntry[] {
  try {
    const log = execSync('git log --format=%h\t%s\t%cI\t%an', { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: GIT_STDIO }).trim()
    if (log === '') return []
    return log.split('\n').map(line => {
      const [hash, message, date, author] = line.split('\t')
      return { hash: hash ?? '', message: message ?? '', date: date ?? '', author: author ?? '' }
    })
  } catch {
    return []
  }
}

function readSkillInfo(name: string): SkillInfo {
  const dir = skillDirPath(name)
  const skillMdPath = join(dir, 'SKILL.md')
  let description = ''
  if (existsSync(skillMdPath)) {
    const parsed = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf8'))
    if (parsed !== undefined) description = parsed.description
  }
  const git = getGitInfo(dir)
  const createdAt = getCreatedAt(dir)
  return {
    name,
    description,
    path: dir,
    ...git,
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

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
