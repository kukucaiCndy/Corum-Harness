/**
 * Team 数据模型：corum 全局团队（预设 Agent 集合，可理解为「部门」）。
 *
 * 团队独立于项目存在，是 corum 框架的一等特色：无论是否有项目，用户都能
 * 创建各种各样能完成任务的 Agent（profile），再把它们组成团队。团队只是
 * 「预设的 Agent 集合」，不直接参与调度——项目创建后把团队（或团队的指定
 * Agent）拉进项目组，运行时围绕项目组分配任务（见 project.ts 的 group）。
 *
 * profile（Agent 设定）是全局的、一份配置（.agent-presets/），团队是 profile
 * 的分组；一个 profile 可属于多个团队，也可不属于任何团队。
 *
 * 存储：`$CORUM_HOME/teams/<teamId>/team.json`。
 * @module @corum/corum-agent-dev/team
 */

/** 一个 corum 团队（预设 Agent 集合）。 */
export interface CorumTeam {
  /** 团队唯一 id（slug，lower-kebab-case）。 */
  id: string
  /** 用户可见团队名（如「后端组」「QA 组」）。 */
  name: string
  /** 团队描述（可选：这个部门/集合是干什么的）。 */
  description?: string
  /** 团队成员的 profile id 列表（引用全局 AgentProfile，只有一份配置）。 */
  memberProfileIds: string[]
  /** 创建时间戳（Unix epoch ms）。 */
  createdAt: number
  /** 乐观锁版本号（每次 save 自增）。 */
  version: number
}

/** 团队 id 合法性：lower-kebab-case，与 profile/project id 同规则。 */
export function isValidTeamId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/** 从团队名派生一个合法 teamId（slug 化；冲突由 store 层加后缀处理）。 */
export function slugifyTeamId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'team' : slug
}
