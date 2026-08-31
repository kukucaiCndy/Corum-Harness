/**
 * Project 数据模型：corum「Agent 驱动项目管理平台」的项目单元。
 *
 * 团队属项目（见 docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md §1）：
 * 一个团队（一组角色 Agent / profile）可同时服务多个项目，但每个项目
 * 独立实例化一套 Agent 实例 + 一份调度事件日志 + 一套调度状态，彼此隔离。
 *
 * 本模型是「轻量版」——只承载 projectId 的生成与项目元信息（name/path），
 * 打通「创建项目 → 拿 projectId」链路。PRD §3 的完整项目实体（计划/阶段/
 * 需求/任务/BUG 等）的项目数据层在本包内演进（project-core 已废弃移除），
 * 本模型届时对齐扩展。
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
  /**
   * 项目自定义工作类型（在框架兜底 BUILTIN_WORK_TYPES 之上扩展）。
   * 完整类型表 = BUILTIN_WORK_TYPES + 本字段（按 slug 去重，内置优先）。
   * 缺省/空 = 仅框架兜底类型。
   */
  workTypes?: WorkType[]
  /**
   * 项目组（项目的运行时组织，一个项目只有一个）。所有运行时（对话/调度/
   * assign_task/list_team_tasks）都围绕项目组成员分配；非项目组成员不参与、
   * 不可见、不调度。缺省 = 空项目组（仅框架默认带入的 PM）。
   */
  group?: ProjectGroup
  /** 创建时间戳（Unix epoch ms）。 */
  createdAt: number
  /** 最后打开时间戳（项目选择器排序用）。 */
  lastOpenedAt: number
  /** 乐观锁版本号（每次 save 自增）。 */
  version: number
}

/**
 * 项目组（虚拟组织）：项目的运行时成员集合。成员引用全局 AgentProfile
 * （只有一份配置，不是拷贝），来源可以是整个团队 / 某团队的指定 Agent /
 * 无团队的独立 Agent。
 */
export interface ProjectGroup {
  /** 项目组成员列表。 */
  members: ProjectGroupMember[]
}

/** 项目组成员（引用一个全局 AgentProfile）。 */
export interface ProjectGroupMember {
  /** 引用的全局 profile id。 */
  profileId: string
  /**
   * 调度角色：pm（会话统筹 + 人机交互入口 + 协调工具）或 member（普通执行成员）。
   * 一个项目组至少一个 pm。
   */
  role: 'pm' | 'member'
  /**
   * 数据层专业角色（权限网关用，可选）。缺省推导：pm → pm；member → dev。
   * 这与调度 role 解耦：一个执行成员可戴 QA/PD/TL 等专业帽子，后续由团队管理界面任命。
   */
  profession?: 'pd' | 'techLead' | 'dev' | 'qa'
  /** 来源团队 id（可追溯「这个成员来自哪个团队」；独立 Agent 无此字段）。 */
  fromTeam?: string
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

// ── 工作类型（session type）────────────────────────────────────────────

/**
 * 一个工作类型泳道：任务按 type 路由到对应会话，实现「session 专注度」——
 * 同 type 的工作进同一会话，不同 type 互不插入（如 A 的开发会话不插 B/C 任务）。
 *
 * 类型表 = 框架兜底类型 + 项目自定义类型（见 CorumProject.workTypes）。
 */
export interface WorkType {
  /** 类型 slug（lower-kebab-case），进 sessionId 的 type 段。 */
  slug: string
  /** 用户可见名（如「通用」「UI」「核心开发」）。 */
  label: string
  /** 说明（可选：该泳道处理什么工作，供路由/展示）。 */
  description?: string
  /** 是否框架兜底内置（内置不可删除/改名）。 */
  builtin: boolean
}

/**
 * 框架兜底工作类型：所有项目预置，覆盖通用问答与常见泳道。
 * 项目可在其上做自定义扩展，但不可删除这些内置项。
 */
export const BUILTIN_WORK_TYPES: readonly WorkType[] = [
  { slug: 'general', label: '通用', description: '一般问答、未归类任务的细化', builtin: true },
  { slug: 'ui', label: 'UI', description: 'UI 绘制、界面相关 BUG 与任务', builtin: true },
  { slug: 'debug', label: '调试', description: '调试、问题排查、修 BUG', builtin: true },
]

/** 保留的兜底 type slug（未归类任务的默认归属）。 */
export const GENERAL_WORK_TYPE = 'general'

/** type slug 合法性：lower-kebab-case。 */
export function isValidWorkTypeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug)
}

/**
 * 解析一个项目的完整工作类型表：框架兜底类型在前，项目自定义类型追加
 * （按 slug 去重，内置优先——自定义与内置同 slug 时忽略自定义，防覆盖兜底）。
 * @param project - 项目实体（其 workTypes 为自定义扩展，可缺省）。
 * @returns 完整可用类型表（内置 + 自定义）。
 */
export function resolveWorkTypes(project: Pick<CorumProject, 'workTypes'>): WorkType[] {
  const table = new Map<string, WorkType>()
  for (const t of BUILTIN_WORK_TYPES) table.set(t.slug, t)
  for (const t of project.workTypes ?? []) {
    if (!isValidWorkTypeSlug(t.slug)) continue
    if (table.has(t.slug)) continue // 内置优先，忽略同 slug 自定义
    table.set(t.slug, { ...t, builtin: false })
  }
  return [...table.values()]
}

/**
 * 项目组成员的 profile id 集合（运行时成员边界）。
 * 空项目组（无 group 或 members 为空）返回空集合——仅框架默认带入的 PM 不在此列。
 */
export function groupMemberIds(project: Pick<CorumProject, 'group'>): ReadonlySet<string> {
  return new Set((project.group?.members ?? []).map(m => m.profileId))
}

/** 判断一个 profile 是否是项目组成员（参与该项目工作/调度的边界）。 */
export function isGroupMember(project: Pick<CorumProject, 'group'>, profileId: string): boolean {
  return (project.group?.members ?? []).some(m => m.profileId === profileId)
}

/** 取项目组的 PM 成员（会话统筹 + 人机交互入口；空项目组应至少有一个）。 */
export function groupPm(project: Pick<CorumProject, 'group'>): ProjectGroupMember | undefined {
  return (project.group?.members ?? []).find(m => m.role === 'pm')
}
