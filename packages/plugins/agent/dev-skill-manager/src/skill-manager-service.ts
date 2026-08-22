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
 *
 * 单例（注册在 host 根 ctx），负责 ~/.dsh/skills/ 下所有 skill 的
 * CRUD + git 版本控制。每个 skill 是一个含 SKILL.md 的子目录，
 * 导入时自动 git init + commit，支持版本回溯和锁定。
 */
export class SkillManagerService extends TypertRemoteService {
  static inject = ['typert']

  constructor(ctx: Context) {
    super(ctx, 'skillManager')
  }

  // ── TypertRemoteService @Remote 端点（/api/skillManager/*） ──────────

  /**
   * 列出 ~/.dsh/skills/ 下所有 skill。
   * @returns 所有 skill 的信息（含 git 版本状态）。
   */
  @Remote('listAll')
  listAll(): { skills: SkillInfo[] } {
    return { skills: scanAllSkills() }
  }

  /**
   * 从任意目录路径导入一个 skill。
   * 复制源目录到 ~/.dsh/skills/<name>/，验证 SKILL.md 格式，
   * git init + 初始 commit。
   * @param skillName - skill 名称（目标目录名）。
   * @param sourcePath - 源 skill 目录的绝对路径。
   * @returns 导入结果。
   */
  @Remote('importFromFile')
  importFromFile(skillName: string, sourcePath: string): ImportResult {
    // TODO: 实现完整的目录复制 + 格式验证 + git init + commit 逻辑
    if (!skillName || !isValidSkillName(skillName)) {
      return { ok: false, error: `invalid skill name: "${skillName}"` }
    }
    if (!existsSync(sourcePath)) {
      return { ok: false, error: `source path does not exist: ${sourcePath}` }
    }
    const skillMdPath = join(sourcePath, 'SKILL.md')
    if (!existsSync(skillMdPath)) {
      return { ok: false, error: `SKILL.md not found in source directory` }
    }

    const targetDir = skillDirPath(skillName)
    if (existsSync(targetDir)) {
      return { ok: false, error: `skill "${skillName}" already exists` }
    }

    mkdirSync(targetDir, { recursive: true })
    cpSync(sourcePath, targetDir, { recursive: true })

    gitInitAndCommit(targetDir)

    return {
      ok: true,
      skill: readSkillInfo(skillName),
    }
  }

  /**
   * 从粘贴的文本内容创建一个 skill。
   * 验证 SKILL.md 格式，写入 ~/.dsh/skills/<name>/SKILL.md，
   * git init + 初始 commit。
   * @param skillName - skill 名称（目标目录名）。
   * @param content - SKILL.md 文本内容。
   * @returns 导入结果。
   */
  @Remote('importFromText')
  importFromText(skillName: string, content: string): ImportResult {
    // TODO: 实现完整的格式验证 + 写入 + git init + commit 逻辑
    if (!skillName || !isValidSkillName(skillName)) {
      return { ok: false, error: `invalid skill name: "${skillName}"` }
    }
    if (!content || content.trim() === '') {
      return { ok: false, error: `content is empty` }
    }

    const parsed = parseSkillFrontmatter(content)
    if (parsed === undefined) {
      return { ok: false, error: `invalid SKILL.md format: missing name or description in frontmatter` }
    }

    const targetDir = skillDirPath(skillName)
    if (existsSync(targetDir)) {
      return { ok: false, error: `skill "${skillName}" already exists` }
    }

    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'SKILL.md'), content, 'utf8')

    gitInitAndCommit(targetDir)

    return {
      ok: true,
      skill: readSkillInfo(skillName),
    }
  }

  /**
   * 删除一个 skill 目录。
   * @param name - skill 名称。
   * @returns 是否删除成功。
   */
  @Remote('deleteSkill')
  deleteSkill(name: string): { ok: boolean; error?: string } {
    // TODO: 实现完整的删除逻辑（含安全检查）
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

  /**
   * 获取一个 skill 的 git 提交历史。
   * @param name - skill 名称。
   * @returns git log 条目列表。
   */
  @Remote('getSkillHistory')
  getSkillHistory(name: string): { history: SkillHistoryEntry[] } {
    // TODO: 实现完整的 git log 解析逻辑
    if (!isValidSkillName(name)) {
      return { history: [] }
    }
    const dir = skillDirPath(name)
    if (!existsSync(dir)) {
      return { history: [] }
    }
    return { history: getGitLog(dir) }
  }

  /**
   * 锁定 skill 到某个 commit 版本，返回 SkillBinding 供 Agent 引用。
   * @param name - skill 名称。
   * @param commitHash - 要锁定的 git commit hash。
   * @returns SkillBinding（name + commitHash）。
   */
  @Remote('pinVersion')
  pinVersion(name: string, commitHash: string): { binding: SkillBinding } {
    // TODO: 实现完整的 commit 验证 + 锁定逻辑
    if (!isValidSkillName(name)) {
      throw new Error(`invalid skill name: "${name}"`)
    }
    const dir = skillDirPath(name)
    if (!existsSync(dir)) {
      throw new Error(`skill "${name}" does not exist`)
    }
    // 验证 commit hash 是否存在于该 skill 的 git 仓库中
    try {
      execSync(`git cat-file -t ${commitHash}`, { cwd: dir, encoding: 'utf8', timeout: 3000 })
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
 *
 * 注意：不能用 `process.env.DSH_HOME`，因为 corum 在 boot 时把 DSH_HOME
 * 设成了 `~/.corum-shell`（与 CLI 隔离）。Skill 全局目录始终用 `~/.dsh`。
 */
function skillsRootPath(): string {
  return join(resolveDshHome('~/.dsh'), 'skills')
}

/** 解析单个 skill 目录路径。 */
function skillDirPath(name: string): string {
  return join(skillsRootPath(), name)
}

/** 验证 skill 名称是否合法（不含路径分隔符、不以 . 开头）。 */
function isValidSkillName(name: string): boolean {
  if (!name || name.length === 0) return false
  if (name.startsWith('.')) return false
  if (name.includes('/') || name.includes('\\')) return false
  return true
}

/**
 * 解析 SKILL.md 的 YAML frontmatter，提取 name / description。
 * 只做最小解析（不引 yaml 库，手动提取必需字段）。
 */
function parseSkillFrontmatter(content: string): {
  name: string
  description: string
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
  return { name, description }
}

/**
 * 获取一个 skill 目录的 git 版本信息。
 * - gitCommit：当前 HEAD 的短 commit hash
 * - gitDirty：是否有未提交的修改（status --porcelain 非空）
 */
function getGitInfo(dir: string): { gitCommit?: string; gitDirty?: boolean } {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: dir, encoding: 'utf8', timeout: 3000 }).trim()
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8', timeout: 3000 }).trim()
    return { gitCommit: commit, gitDirty: status !== '' }
  } catch {
    return {}
  }
}

/** 在 skill 目录中执行 git init + 初始 commit。 */
function gitInitAndCommit(dir: string): void {
  try {
    execSync('git init', { cwd: dir, encoding: 'utf8', timeout: 5000 })
    execSync('git add -A', { cwd: dir, encoding: 'utf8', timeout: 5000 })
    execSync('git commit -m "initial import"', { cwd: dir, encoding: 'utf8', timeout: 5000 })
  } catch {
    // git 不可用或 commit 失败时静默跳过——skill 仍然可用，只是没有版本追踪
  }
}

/** 获取 skill 的首次提交时间（创建时间）。 */
function getCreatedAt(dir: string): string | undefined {
  try {
    const date = execSync('git log --reverse --format=%cI --', { cwd: dir, encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0]
    return date || undefined
  } catch {
    return undefined
  }
}

/** 获取 git log 条目列表。 */
function getGitLog(dir: string): SkillHistoryEntry[] {
  try {
    const log = execSync('git log --format=%h\t%s\t%cI\t%an', { cwd: dir, encoding: 'utf8', timeout: 3000 }).trim()
    if (log === '') return []
    return log.split('\n').map(line => {
      const [hash, message, date, author] = line.split('\t')
      return { hash: hash ?? '', message: message ?? '', date: date ?? '', author: author ?? '' }
    })
  } catch {
    return []
  }
}

/** 读取单个 skill 的信息（含 git 版本状态 + 创建时间）。 */
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

/** 扫描全局 skill 目录，返回所有 skill 的信息。 */
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
