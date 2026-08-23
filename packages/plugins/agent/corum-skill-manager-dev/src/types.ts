/**
 * Skill 管理的数据类型定义。
 * @module @corum/corum-skill-manager-dev/types
 */

/** UI 投影的 skill 摘要信息。 */
export interface SkillInfo {
  /** skill 名称（目录名）。 */
  name: string
  /** skill 描述（从 SKILL.md frontmatter 提取）。 */
  description: string
  /** skill 目录的绝对路径。 */
  path: string
  /** 当前版本 ID（如 2026-08-22-01）。 */
  currentVersion?: string
  /** 版本数量。 */
  versionCount: number
  /** 创建时间（ISO 字符串）。 */
  createdAt?: string
}

/** skill 版本条目。 */
export interface SkillVersion {
  /** 版本 ID（日期+序号，如 2026-08-22-01）。 */
  id: string
  /** 版本创建时间（ISO 字符串）。 */
  date: string
  /** 版本标签/备注。 */
  label: string
}

/** skill 版本绑定（Agent 引用 skill 时锁定到某个版本）。 */
export interface SkillBinding {
  /** skill 名称。 */
  name: string
  /** 锁定的版本 ID。 */
  versionId: string
}

/** 版本历史返回。 */
export interface SkillHistoryResult {
  versions: SkillVersion[]
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

/** 版本配置文件结构（skill-versions.json）。 */
export interface SkillVersionsConfig {
  versions: SkillVersion[]
}

/** 目录扫描结果：识别到的可导入 skill 预览项。 */
export interface ScannedSkill {
  /** skill 目录名（作为导入后的 skill 名）。 */
  name: string
  /** skill 描述（从 SKILL.md frontmatter 提取）。 */
  description: string
  /** 源目录绝对路径。 */
  sourcePath: string
}

/** 目录扫描结果。 */
export interface ScanDirectoryResult {
  /** 已识别的 skill（含有效 SKILL.md + frontmatter）。 */
  skills: ScannedSkill[]
  /** 已存在（同名已导入）的 skill 名列表，导入时会跳过或覆盖。 */
  existing: string[]
}

/** 批量导入目录的结果。 */
export interface ImportDirectoryResult {
  /** 成功导入的数量。 */
  imported: number
  /** 跳过（已存在）的数量。 */
  skipped: number
  /** 失败项（名称 + 原因）。 */
  failed: Array<{ name: string; error: string }>
}
