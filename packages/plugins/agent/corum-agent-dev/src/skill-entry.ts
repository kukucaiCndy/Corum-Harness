/**
 * SkillEntry —— UI 投影的可用 skill 摘要（agent-service 与 skill-catalog 共享）。
 *
 * 从 agent-service.ts 拆出（包内文件拆分）：skill-catalog 的扫描产出类型，
 * agent-service 的 listSkills 端点返回类型；独立成模块避免两者循环依赖。
 * @module @corum/corum-agent-dev/skill-entry
 */

/**
 * UI 投影的可用 skill 摘要。
 * Skill 全局统一管理在 ~/.dsh/skills/，Agent 只引用 name 不复制文件。
 */
export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** skill 目录的绝对路径。 */
  path: string
  /** 当前版本 ID。 */
  currentVersion?: string
  /** 版本数量。 */
  versionCount: number
}
