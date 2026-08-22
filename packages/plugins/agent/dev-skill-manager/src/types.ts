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
