/**
 * Skill 管理的数据类型定义。
 * @module @corum/dev-skill-manager/types
 */

/** UI 投影的 skill 摘要信息。 */
export interface SkillInfo {
  /** skill 名称（目录名）。 */
  name: string
  /** skill 描述（从 SKILL.md frontmatter 提取）。 */
  description: string
  /** skill 目录的绝对路径。 */
  path: string
  /** git commit hash（短），用于版本追踪。 */
  gitCommit?: string
  /** 是否有未提交的修改。 */
  gitDirty?: boolean
  /** 创建时间（ISO 字符串，从 git 首次提交提取）。 */
  createdAt?: string
}

/** skill 版本绑定（Agent 引用 skill 时锁定到某个 commit）。 */
export interface SkillBinding {
  /** skill 名称。 */
  name: string
  /** 锁定的 git commit hash。 */
  commitHash: string
}

/** git 历史条目。 */
export interface SkillHistoryEntry {
  /** commit hash（短）。 */
  hash: string
  /** commit message。 */
  message: string
  /** commit 日期（ISO 字符串）。 */
  date: string
  /** 作者。 */
  author: string
}

/** 导入操作结果。 */
export interface ImportResult {
  /** 是否成功。 */
  ok: boolean
  /** 失败时的错误信息。 */
  error?: string
  /** 成功时的 skill 信息。 */
  skill?: SkillInfo
}
