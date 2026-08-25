/**
 * CorumProjectService — corum 项目服务（轻量版）。
 *
 * 打通「创建项目 → 拿 projectId」链路，为团队调度事件日志提供落点边界
 * （见 docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md）。每个项目是
 * `$CORUM_HOME/projects/<projectId>/` 一个独立目录，天然多项目隔离。
 *
 * 继承 TypertRemoteService，通过 @Remote 暴露 /api/corumProject/* 端点，
 * 供浏览器半（项目选择器 / AgentTestPanel）经桌面 IPC 桥调用。
 *
 * 这是轻量版——只承载 projectId 生成 + 项目元信息 CRUD。PRD §3 的完整
 * 项目实体（计划/需求/任务/BUG）后续迁入 project-core 数据层。
 * @module @corum/corum-agent-dev/project-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { CorumProject, ProjectGroup, ProjectGroupMember, WorkType } from './project.ts'
import { isValidProjectId, isValidWorkTypeSlug, resolveWorkTypes, slugifyProjectId } from './project.ts'
import { loadProject, listProjects, saveProject, projectDir } from './project-store.ts'
import { ensurePmProfile, PM_PROFILE_ID } from './agent-service.ts'
import { loadTeam } from './team-store.ts'
import { isValidProfileId } from './profile.ts'
import { loadProfile } from './profile-store.ts'
import { publishDomainEvent } from './events.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum 项目服务（项目创建/列表 → projectId）。 */
    corumProject: CorumProjectService
  }
}

/** 创建项目的 RPC 入参。 */
export interface CreateProjectInput {
  /** 项目名（必填，用于派生 projectId slug）。 */
  name: string
  /** 工作目录（可选，绝对路径）。 */
  cwd?: string
  /** 描述（可选）。 */
  description?: string
}

/**
 * CorumProjectService — corum 项目服务。
 *
 * 单例（注册在 host 根 ctx），负责：创建/列出/打开项目，返回真实 projectId。
 */
export class CorumProjectService extends TypertRemoteService {
  static inject = ['agents', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 'corumProject')
  }

  /**
   * 创建一个新项目，返回分配了唯一 projectId 的项目实体。
   * projectId 由 name slug 化，冲突时追加 -2/-3 后缀。
   * 项目组默认带入框架预置的 PM 助理（会话统筹 + 人机交互入口）作为第一个成员。
   */
  createProject(input: CreateProjectInput): CorumProject {
    const name = input.name.trim()
    if (name === '') throw new Error('dev-agent: project name must not be empty')
    const base = slugifyProjectId(name)
    let id = base
    for (let n = 2; loadProject(id) !== undefined; n += 1) id = `${base}-${n}`
    const now = Date.now()
    // 项目组默认带 PM（框架预置 PM 助理，确保其 profile 存在）。
    ensurePmProfile()
    const group: ProjectGroup = { members: [{ profileId: PM_PROFILE_ID, role: 'pm' }] }
    const project: CorumProject = {
      id,
      name,
      ...(input.cwd !== undefined && input.cwd.trim() !== '' ? { cwd: input.cwd.trim() } : {}),
      ...(input.description !== undefined && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
      group,
      createdAt: now,
      lastOpenedAt: now,
      version: 0,
    }
    saveProject(project)
    // PM 兜底成员是项目组的初始事实，必须进领域事件（持久日志 seq 0 + 实时流）。
    publishDomainEvent(this.ctx, 'corum/group/member-added', { projectId: id, member: group.members[0] })
    this.ctx.logger.info(`corumProject: created "${id}" — ${name}（PM 助理已带入项目组）(${projectDir(id)})`)
    return project
  }

  /** 记录一次「打开项目」（刷新 lastOpenedAt 排序）。 */
  touchProject(id: string): CorumProject {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    const next = { ...project, lastOpenedAt: Date.now() }
    saveProject(next)
    return next
  }

  // ── TypertRemoteService @Remote 端点（/api/corumProject/*） ──────────

  /** 创建项目。 */
  @Remote('createProject')
  createProjectRemote(name: string, cwd?: string, description?: string): { project: CorumProject } {
    return {
      project: this.createProject({
        name,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(description !== undefined ? { description } : {}),
      }),
    }
  }

  /** 列出所有项目（最近打开在前）。 */
  @Remote('listProjects')
  listProjectsRemote(): { projects: CorumProject[] } {
    return { projects: listProjects() }
  }

  /** 打开项目（刷新 lastOpenedAt）。 */
  @Remote('openProject')
  openProjectRemote(id: string): { project: CorumProject } {
    if (!isValidProjectId(id)) throw new Error(`dev-agent: invalid project id "${id}"`)
    return { project: this.touchProject(id) }
  }

  /** 列出项目的完整工作类型表（框架兜底 + 项目自定义）。 */
  @Remote('listWorkTypes')
  listWorkTypesRemote(id: string): { workTypes: WorkType[] } {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    return { workTypes: resolveWorkTypes(project) }
  }

  /**
   * 给项目新增一个自定义工作类型（泳道）。
   * slug 必须合法且不与现有（含内置）冲突。
   */
  @Remote('addWorkType')
  addWorkTypeRemote(id: string, slug: string, label: string, description?: string): { workTypes: WorkType[] } {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    const cleanSlug = slug.trim().toLowerCase()
    if (!isValidWorkTypeSlug(cleanSlug)) throw new Error(`dev-agent: invalid work type slug "${slug}"`)
    const cleanLabel = label.trim()
    if (cleanLabel === '') throw new Error('dev-agent: work type label must not be empty')
    const existing = resolveWorkTypes(project)
    if (existing.some(t => t.slug === cleanSlug)) {
      throw new Error(`dev-agent: work type "${cleanSlug}" already exists`)
    }
    const custom: WorkType = {
      slug: cleanSlug,
      label: cleanLabel,
      ...(description !== undefined && description.trim() !== '' ? { description: description.trim() } : {}),
      builtin: false,
    }
    saveProject({ ...project, workTypes: [...(project.workTypes ?? []), custom] })
    this.ctx.logger.info(`corumProject: [${id}] add work type "${cleanSlug}" — ${cleanLabel}`)
    return { workTypes: resolveWorkTypes({ ...project, workTypes: [...(project.workTypes ?? []), custom] }) }
  }

  // ── 项目组成员管理（引用式：拉整个团队 / 团队指定 Agent / 独立 Agent） ──

  /** 列出项目组成员（项目组 = 项目的运行时组织）。 */
  @Remote('listGroupMembers')
  listGroupMembersRemote(id: string): { members: ProjectGroupMember[] } {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    return { members: project.group?.members ?? [] }
  }

  /**
   * 把一个团队整体拉进项目组（团队所有成员加入，记录 fromTeam 来源）。
   * 已在项目组的成员跳过（去重）。
   */
  @Remote('addTeamToGroup')
  addTeamToGroupRemote(id: string, teamId: string): { group: ProjectGroup } {
    const project = this.requireProject(id)
    const team = loadTeam(teamId)
    if (team === undefined) throw new Error(`dev-agent: team "${teamId}" not found`)
    const members = [...(project.group?.members ?? [])]
    const existing = new Set(members.map(m => m.profileId))
    const addedMembers: ProjectGroupMember[] = []
    for (const profileId of team.memberProfileIds) {
      if (existing.has(profileId)) continue
      const member: ProjectGroupMember = { profileId, role: 'member', fromTeam: teamId }
      members.push(member)
      addedMembers.push(member)
      existing.add(profileId)
    }
    const group: ProjectGroup = { members }
    saveProject({ ...project, group })
    this.ctx.logger.info(`corumProject: [${id}] add team "${teamId}" to group（+${addedMembers.length} 成员）`)
    for (const member of addedMembers) {
      publishDomainEvent(this.ctx, 'corum/group/member-added', { projectId: id, member })
    }
    return { group }
  }

  /**
   * 把单个 Agent 拉进项目组：可来自某团队（记 fromTeam）或无团队的独立 Agent。
   */
  @Remote('addMemberToGroup')
  addMemberToGroupRemote(id: string, profileId: string, fromTeam?: string, role?: 'pm' | 'member'): { group: ProjectGroup } {
    const project = this.requireProject(id)
    if (!isValidProfileId(profileId)) throw new Error(`dev-agent: invalid profile id "${profileId}"`)
    if (loadProfile(profileId) === undefined) throw new Error(`dev-agent: profile "${profileId}" not found`)
    const members = [...(project.group?.members ?? [])]
    if (members.some(m => m.profileId === profileId)) {
      throw new Error(`dev-agent: profile "${profileId}" 已在项目组`)
    }
    if (fromTeam !== undefined && loadTeam(fromTeam) === undefined) {
      throw new Error(`dev-agent: team "${fromTeam}" not found`)
    }
    members.push({
      profileId,
      role: role ?? 'member',
      ...(fromTeam !== undefined ? { fromTeam } : {}),
    })
    const member: ProjectGroupMember = members[members.length - 1]
    const group: ProjectGroup = { members }
    saveProject({ ...project, group })
    this.ctx.logger.info(`corumProject: [${id}] add member "${profileId}"（role=${role ?? 'member'}${fromTeam !== undefined ? ` from ${fromTeam}` : ''}）`)
    publishDomainEvent(this.ctx, 'corum/group/member-added', { projectId: id, member })
    return { group }
  }

  /** 从项目组移除一个成员（PM 不可移除——项目组必须始终有一个 PM）。 */
  @Remote('removeGroupMember')
  removeGroupMemberRemote(id: string, profileId: string): { group: ProjectGroup } {
    const project = this.requireProject(id)
    const members = project.group?.members ?? []
    const target = members.find(m => m.profileId === profileId)
    if (target === undefined) throw new Error(`dev-agent: profile "${profileId}" 不在项目组`)
    if (target.role === 'pm' && members.filter(m => m.role === 'pm').length === 1) {
      throw new Error('dev-agent: 项目组必须保留至少一个 PM，不可移除唯一的 PM')
    }
    const next = members.filter(m => m.profileId !== profileId)
    const group: ProjectGroup = { members: next }
    saveProject({ ...project, group })
    this.ctx.logger.info(`corumProject: [${id}] remove member "${profileId}"`)
    publishDomainEvent(this.ctx, 'corum/group/member-removed', { projectId: id, profileId })
    return { group }
  }

  /** 取项目（不存在则报错）。 */
  private requireProject(id: string): CorumProject {
    if (!isValidProjectId(id)) throw new Error(`dev-agent: invalid project id "${id}"`)
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    return project
  }
}

export default CorumProjectService
