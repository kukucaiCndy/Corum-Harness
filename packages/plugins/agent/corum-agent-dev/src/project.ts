/**
 * Project 数据模型：corum「Agent 驱动项目管理平台」的项目单元。
 *
 * 团队属项目（见 docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md §1）：
 * 一个团队（一组角色 Agent / profile）可同时服务多个项目，但每个项目
 * 独立实例化一套 Agent 实例 + 一份调度事件日志 + 一套调度状态，彼此隔离。
 *
 * 本模型是「轻量版」——只承载 projectId 的生成与项目元信息（name/path），
 * 打通「创建项目 → 拿 projectId」链路。PRD §3 的完整项目实体（计划/阶段/
 * 需求/任务/BUG 等）后续迁入 project-core 数据层，本模型届时对齐扩展。
 *
 * 存储：`$CORUM_HOME/projects/<projectId>/project.json`。
 * @module @corum/corum-agent-dev/project
 */

/** 一个 corum 项目（轻量版元信息）。 */
export interface CorumProject {
  /** 项目唯一 id（slug，lower-kebab-case）。即调度事件日志的落点目录名。 */
  id: string
  /** 用户可见项目名。 */
  name: string
  /** 项目工作目录（绝对路径；代码所在，可为空 = 尚未关联工作区）。 */
  cwd?: string
  /** 简短描述（可选）。 */
  description?: string
  /** 创建时间戳（Unix epoch ms）。 */
  createdAt: number
  /** 最后打开时间戳（项目选择器排序用）。 */
  lastOpenedAt: number
  /** 乐观锁版本号（每次 save 自增）。 */
  version: number
}

/** 项目 id 合法性：lower-kebab-case，与 profile id 同规则。 */
export function isValidProjectId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/** 从项目名派生一个合法 projectId（slug 化；冲突由 store 层加后缀处理）。 */
export function slugifyProjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'project' : slug
}
