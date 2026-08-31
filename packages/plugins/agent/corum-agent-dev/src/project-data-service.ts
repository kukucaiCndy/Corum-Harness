/**
 * CorumProjectDataService — ctx.project 数据层第一刀（需求 / 任务 / BUG）。
 *
 * 职责：
 *   - 用官方 dsh-storage-domain 承载共享实体（defineDomain + domain/changed），
 *     作为平级 Agent 协作的共享黑板（GAP §2/§4.3）；
 *   - 所有写操作过权限网关（角色由 ToolExecution.agent 反查，模型不可自报）；
 *   - 状态机强制校验 + 乐观锁 version + 轻量审计表（PRD §8）；
 *   - Readiness 聚合与需求派生态同步（PRD §3.3/§3.5）。
 *
 * 非目标（本期不做）：Plan/Release/TestCase/文档注册表实体、审计查询 UI、
 * 自动 schema 迁移、跨进程变更推送（官方 domain/changed 当前仅进程内）。
 * @module @corum/corum-agent-dev/project-data-service
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { CorumAgentService } from './agent-service.ts'
import type { CorumProject, ProjectGroupMember } from './project.ts'
import { loadProject } from './project-store.ts'
import {
  bugSeveritySchema,
  computeRequirementReadiness,
  deriveRequirementStatus,
  entityKey,
  projectDataDomainSpec,
  requirementEntitySchema,
  taskEntitySchema,
  bugEntitySchema,
  projectAuditSchema,
} from './project-entities.ts'
import type {
  BugEntity,
  BugSeverity,
  BugStatus,
  ProjectAudit,
  ProjectRole,
  RequirementEntity,
  RequirementReadiness,
  RequirementStatus,
  TaskEntity,
  TaskStatus,
} from './project-entities.ts'
import { TASK_FLOW, BUG_FLOW, inferProfession, requireMember, transition, parseEntity } from './project-data-guards.ts'
import type { WriteAction } from './project-data-guards.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum 项目数据层（共享实体 + 权限网关 + Readiness）。 */
    corumProjectData: CorumProjectDataService
  }
}

/** 权限网关调用者（可信身份；role 不由模型自报）。 */
export interface ProjectCaller {
  readonly kind: 'human' | 'agent'
  /** 真人 'user'；Agent = profileId。 */
  readonly id: string
  readonly projectId: string
  readonly role: ProjectRole
  /** Agent 调用时的会话 id（审计用）。 */
  readonly sessionId?: string
}

type DomainHandle = Domain<typeof projectDataDomainSpec>
type RequirementsTable = KvTable<string, RequirementEntity>
type TasksTable = KvTable<string, TaskEntity>
type BugsTable = KvTable<string, BugEntity>
type AuditsTable = KvTable<string, ProjectAudit>

interface Tables {
  readonly requirements: RequirementsTable
  readonly tasks: TasksTable
  readonly bugs: BugsTable
  readonly audits: AuditsTable
}

/**
 * ctx.project 数据服务。单例（host 根 ctx），所有写路径串行化在
 * storage-domain 的单域写链上；读路径同步来自 domain 的权威内存态。
 */
export class CorumProjectDataService extends TypertRemoteService {
  static inject = ['storageDomain']

  private readonly domainPromise: Promise<DomainHandle>

  constructor(
    ctx: Context,
    /** 泳道会话反查（ToolExecution.agent → 项目/角色可信身份）。 */
    private readonly corumAgent: CorumAgentService,
  ) {
    super(ctx, 'corumProjectData')
    this.domainPromise = ctx.storageDomain.open(projectDataDomainSpec)
    void this.domainPromise.then(domain => {
      this.ctx.effect(() => () => domain.close(), 'corumProjectData.domainClose')
    }).catch(error => {
      this.ctx.logger.error(`corumProjectData: open domain failed: ${String(error)}`)
    })
  }

  /** 打开后的四张表（requirements/tasks/bugs/audits）。 */
  private async tables(): Promise<Tables> {
    const domain = await this.domainPromise
    return {
      requirements: domain.table('requirements'),
      tasks: domain.table('tasks'),
      bugs: domain.table('bugs'),
      audits: domain.table('audits'),
    }
  }

  /** 真人调用入口（UI/RPC；人拥有最高裁决权，但仍过同一状态机）。 */
  humanCaller(projectId: string): ProjectCaller {
    const project = loadProject(projectId)
    if (project === undefined) throw new Error(`project-data: project "${projectId}" not found`)
    return { kind: 'human', id: 'user', projectId, role: 'human' }
  }

  /** 项目组成员调用入口（host 调度器代执行侧回流状态；角色仍按 project.json 推导）。 */
  profileCaller(projectId: string, profileId: string, sessionId?: string): ProjectCaller {
    const project = loadProject(projectId)
    if (project === undefined) throw new Error(`project-data: project "${projectId}" not found`)
    const member = requireMember(project, profileId)
    return {
      kind: 'agent',
      id: profileId,
      projectId,
      role: inferProfession(member),
      ...(sessionId !== undefined ? { sessionId } : {}),
    }
  }

  /**
   * 从工具执行上下文反查可信调用者（PRD §7.4 顾虑已由官方解决）：
   * `exec.agent` 由 agent loop 注入，模型无法自报；再经 sessionId → 泳道
   * （project/profile）与 project.json 项目组反查数据层专业角色。
   */
  resolveCaller(exec: { readonly agent?: Agent } | undefined, projectId: string): ProjectCaller {
    const agent = exec?.agent
    if (agent === undefined) return this.humanCaller(projectId)
    const sessionId = String(agent.id)
    const lane = this.corumAgent.resolveLaneBySessionId(sessionId)
    if (lane === undefined || lane.projectId !== projectId) {
      throw new Error(`project-data: 无法从会话 "${sessionId}" 反查项目 "${projectId}" 的可信成员身份`)
    }
    const project = loadProject(projectId)
    if (project === undefined) throw new Error(`project-data: project "${projectId}" not found`)
    const member = requireMember(project, lane.profileId)
    return {
      kind: 'agent',
      id: lane.profileId,
      projectId,
      role: inferProfession(member),
      sessionId,
    }
  }

  /** 权限网关：角色 × 实体 × 动作；真人最高裁决（human 放行但仍过状态机）。 */
  private assertWrite(caller: ProjectCaller, entity: 'requirement' | 'task' | 'bug', action: WriteAction, toStatus?: string): void {
    if (caller.role === 'human') return
    const allow = (roles: readonly ProjectRole[]): void => {
      if (!roles.includes(caller.role)) {
        throw new Error(`project-data: 越权拦截 — ${caller.role} 不可对 ${entity} 执行 ${action}${toStatus !== undefined ? `(${toStatus})` : ''}`)
      }
    }
    if (entity === 'requirement') {
      if (action === 'create' || action === 'update') allow(['pd'])
      else if (action === 'status') allow(toStatus === 'finished' ? ['pm'] : ['pd', 'pm'])
      return
    }
    if (entity === 'task') {
      if (action === 'create' || action === 'update') allow(['techLead', 'dev', 'pm'])
      else if (action === 'assign') allow(['techLead', 'pm'])
      else if (action === 'status') {
        if (toStatus === 'completed') allow(['pm'])
        else allow(['dev', 'pm'])
      }
      return
    }
    // bug
    if (action === 'create') allow(['qa'])
    else if (action === 'status') {
      if (toStatus === 'processing' || toStatus === 'fixed' || toStatus === 'rejected') allow(['dev'])
      else if (toStatus === 'pending_verify' || toStatus === 'closed' || toStatus === 'reopened') allow(['qa'])
    } else if (action === 'assign') allow(['dev'])
  }

  /** 写审计（先审计后实体；覆盖 100% 写操作）。 */
  private async audit(
    tables: Tables,
    input: Omit<ProjectAudit, 'id' | 'at'>,
  ): Promise<void> {
    const record = parseEntity(projectAuditSchema, {
      ...input,
      id: `audit-${randomUUID()}`,
      at: Date.now(),
    }, 'audit')
    await tables.audits.put(entityKey(record.projectId, record.id), record)
  }

  /** 列出项目需求（默认不含软删）。 */
  async listRequirements(projectId: string, includeDeleted = false): Promise<RequirementEntity[]> {
    const tables = await this.tables()
    return [...tables.requirements.entries()]
      .filter(([key, value]) => key.startsWith(`${projectId}/`) && (includeDeleted || value.deletedAt === undefined))
      .map(([, value]) => value)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 列出项目任务。 */
  async listTasks(projectId: string, requirementId?: string): Promise<TaskEntity[]> {
    const tables = await this.tables()
    return [...tables.tasks.entries()]
      .filter(([key, value]) => key.startsWith(`${projectId}/`) && value.deletedAt === undefined)
      .map(([, value]) => value)
      .filter(t => requirementId === undefined || t.requirementId === requirementId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 列出项目 BUG。 */
  async listBugs(projectId: string, requirementId?: string): Promise<BugEntity[]> {
    const tables = await this.tables()
    return [...tables.bugs.entries()]
      .filter(([key, value]) => key.startsWith(`${projectId}/`) && value.deletedAt === undefined)
      .map(([, value]) => value)
      .filter(b => requirementId === undefined || b.requirementId === requirementId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 取需求（不存在/软删报错）。 */
  private async requireRequirement(tables: Tables, projectId: string, requirementId: string): Promise<RequirementEntity> {
    const requirement = tables.requirements.get(entityKey(projectId, requirementId))
    if (requirement === undefined || requirement.deletedAt !== undefined) {
      throw new Error(`project-data: requirement "${requirementId}" not found`)
    }
    return requirement
  }

  /** 取任务。 */
  private async requireTask(tables: Tables, projectId: string, taskId: string): Promise<TaskEntity> {
    const task = tables.tasks.get(entityKey(projectId, taskId))
    if (task === undefined || task.deletedAt !== undefined) throw new Error(`project-data: task "${taskId}" not found`)
    return task
  }

  /** 取 BUG。 */
  private async requireBug(tables: Tables, projectId: string, bugId: string): Promise<BugEntity> {
    const bug = tables.bugs.get(entityKey(projectId, bugId))
    if (bug === undefined || bug.deletedAt !== undefined) throw new Error(`project-data: bug "${bugId}" not found`)
    return bug
  }

  /** 乐观锁校验（同 version 双写后者被拒）。 */
  private assertVersion(current: number, expectedVersion?: number): void {
    if (expectedVersion !== undefined && expectedVersion !== current) {
      throw new Error(`project-data: 乐观锁冲突 — 期望 version=${expectedVersion}，当前 version=${current}`)
    }
  }

  /** 创建需求（PD 直写；human/RPC 可代录）。 */
  async createRequirement(
    caller: ProjectCaller,
    input: {
      title: string
      description?: string
      ownerId?: string
      priority?: number
      planId?: string
      stageId?: string
    },
  ): Promise<RequirementEntity> {
    this.assertWrite(caller, 'requirement', 'create')
    const tables = await this.tables()
    const now = Date.now()
    const requirement = parseEntity(requirementEntitySchema, {
      id: `req-${randomUUID()}`,
      projectId: caller.projectId,
      ...(input.planId !== undefined ? { planId: input.planId } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
      title: input.title.trim(),
      ...(input.description !== undefined && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
      ownerId: input.ownerId ?? caller.id,
      status: 'submitted' satisfies RequirementStatus,
      priority: input.priority ?? 1,
      statusHistory: [transition('submitted', caller.id)],
      createdAt: now,
      updatedAt: now,
      version: 0,
    }, 'requirement')
    await this.audit(tables, {
      projectId: caller.projectId,
      entityType: 'requirement',
      entityId: requirement.id,
      action: 'create',
      actor: caller.id,
      role: caller.role,
      summary: `创建需求「${requirement.title}」`,
      ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
    })
    await tables.requirements.put(entityKey(caller.projectId, requirement.id), requirement)
    return requirement
  }

  /** 创建任务（TL/Dev/PM；必须关联已存在需求，assignee 必须是项目组成员）。 */
  async createTask(
    caller: ProjectCaller,
    input: {
      requirementId: string
      title: string
      desc?: string
      isFeature?: boolean
      priority?: number
      assigneeId?: string
      acceptance?: string
      estimateMin?: number
      dueAt?: number
      parentTaskId?: string
    },
  ): Promise<TaskEntity> {
    this.assertWrite(caller, 'task', 'create')
    const tables = await this.tables()
    await this.requireRequirement(tables, caller.projectId, input.requirementId)
    const project = loadProject(caller.projectId)
    if (project === undefined) throw new Error(`project-data: project "${caller.projectId}" not found`)
    const assigneeId = input.assigneeId ?? caller.id
    const assignee = requireMember(project, assigneeId)
    const now = Date.now()
    const task = parseEntity(taskEntitySchema, {
      id: `task-${randomUUID()}`,
      projectId: caller.projectId,
      requirementId: input.requirementId,
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      title: input.title.trim(),
      ...(input.desc !== undefined && input.desc.trim() !== '' ? { desc: input.desc.trim() } : {}),
      isFeature: input.isFeature ?? true,
      status: 'todo' satisfies TaskStatus,
      priority: input.priority ?? 1,
      assigneeId,
      assigneeRole: inferProfession(assignee),
      ...(input.acceptance !== undefined && input.acceptance.trim() !== '' ? { acceptance: input.acceptance.trim() } : {}),
      ...(input.estimateMin !== undefined ? { estimateMin: input.estimateMin } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      blockedBy: [],
      statusHistory: [transition('todo', caller.id)],
      createdAt: now,
      updatedAt: now,
      version: 0,
    }, 'task')
    await this.audit(tables, {
      projectId: caller.projectId,
      entityType: 'task',
      entityId: task.id,
      action: 'create',
      actor: caller.id,
      role: caller.role,
      summary: `创建任务「${task.title}」（需求 ${task.requirementId}，指派 ${assigneeId}）`,
      ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
    })
    await tables.tasks.put(entityKey(caller.projectId, task.id), task)
    await this.syncRequirementDerivedStatus(tables, caller.projectId, task.requirementId)
    return task
  }

  /** 改派任务（TL 直写指派 / PM 直写改派）。 */
  async assignTask(caller: ProjectCaller, taskId: string, assigneeId: string, expectedVersion?: number): Promise<TaskEntity> {
    this.assertWrite(caller, 'task', 'assign')
    const tables = await this.tables()
    const current = await this.requireTask(tables, caller.projectId, taskId)
    this.assertVersion(current.version, expectedVersion)
    const project = loadProject(caller.projectId)
    if (project === undefined) throw new Error(`project-data: project "${caller.projectId}" not found`)
    const assignee = requireMember(project, assigneeId)
    const next = parseEntity(taskEntitySchema, {
      ...current,
      assigneeId,
      assigneeRole: inferProfession(assignee),
      updatedAt: Date.now(),
      version: current.version + 1,
    }, 'task')
    await this.audit(tables, {
      projectId: caller.projectId,
      entityType: 'task',
      entityId: taskId,
      action: 'assign',
      actor: caller.id,
      role: caller.role,
      summary: `任务「${current.title}」改派 ${current.assigneeId} → ${assigneeId}`,
      ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
    })
    await tables.tasks.put(entityKey(caller.projectId, taskId), next)
    return next
  }

  /** 任务状态流转（dev_done→completed 仅 PM；非法跳态必拒）。 */
  async updateTaskStatus(
    caller: ProjectCaller,
    taskId: string,
    toStatus: TaskStatus,
    expectedVersion?: number,
  ): Promise<TaskEntity> {
    this.assertWrite(caller, 'task', 'status', toStatus)
    const tables = await this.tables()
    const current = await this.requireTask(tables, caller.projectId, taskId)
    this.assertVersion(current.version, expectedVersion)
    if (!TASK_FLOW[current.status].includes(toStatus)) {
      throw new Error(`project-data: 非法任务状态流转 ${current.status} → ${toStatus}`)
    }
    const next = parseEntity(taskEntitySchema, {
      ...current,
      status: toStatus,
      statusHistory: [...current.statusHistory, transition(toStatus, caller.id)],
      updatedAt: Date.now(),
      version: current.version + 1,
    }, 'task')
    await this.audit(tables, {
      projectId: caller.projectId,
      entityType: 'task',
      entityId: taskId,
      action: `status:${toStatus}`,
      actor: caller.id,
      role: caller.role,
      summary: `任务「${current.title}」${current.status} → ${toStatus}`,
      ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
    })
    await tables.tasks.put(entityKey(caller.projectId, taskId), next)
    await this.syncRequirementDerivedStatus(tables, caller.projectId, current.requirementId)
    return next
  }

  /** 上报 BUG（QA 直写；reporter/assignee 必须是项目组成员）。 */
  async createBug(
    caller: ProjectCaller,
    input: {
      requirementId: string
      title: string
      severity: BugSeverity
      description?: string
      reproSteps?: string
      assigneeId?: string
      taskId?: string
      testCaseId?: string
    },
  ): Promise<BugEntity> {
    this.assertWrite(caller, 'bug', 'create')
    const tables = await this.tables()
    await this.requireRequirement(tables, caller.projectId, input.requirementId)
    const project = loadProject(caller.projectId)
    if (project === undefined) throw new Error(`project-data: project "${caller.projectId}" not found`)
    const assigneeId = input.assigneeId ?? caller.id
    requireMember(project, assigneeId)
    const now = Date.now()
    const bug = parseEntity(bugEntitySchema, {
      id: `bug-${randomUUID()}`,
      projectId: caller.projectId,
      requirementId: input.requirementId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.testCaseId !== undefined ? { testCaseId: input.testCaseId } : {}),
      title: input.title.trim(),
      ...(input.description !== undefined && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
      ...(input.reproSteps !== undefined && input.reproSteps.trim() !== '' ? { reproSteps: input.reproSteps.trim() } : {}),
      severity: input.severity,
      reporterId: caller.id,
      assigneeId,
      status: 'open' satisfies BugStatus,
      transferHistory: [],
      statusHistory: [transition('open', caller.id)],
      createdAt: now,
      updatedAt: now,
      version: 0,
    }, 'bug')
    await this.audit(tables, {
      projectId: caller.projectId,
      entityType: 'bug',
      entityId: bug.id,
      action: 'create',
      actor: caller.id,
      role: caller.role,
      summary: `上报 BUG「${bug.title}」（${bug.severity}，需求 ${bug.requirementId}）`,
      ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
    })
    await tables.bugs.put(entityKey(caller.projectId, bug.id), bug)
    await this.syncRequirementDerivedStatus(tables, caller.projectId, bug.requirementId)
    return bug
  }

  /** BUG 状态流转（closed 仅 QA；fixed 必填 fixReleaseId；rejected 必填理由）。 */
  async transitionBug(
    caller: ProjectCaller,
    bugId: string,
    toStatus: BugStatus,
    options: { expectedVersion?: number; fixReleaseId?: string; rejectReason?: string } = {},
  ): Promise<BugEntity> {
    this.assertWrite(caller, 'bug', 'status', toStatus)
    const tables = await this.tables()
    const current = await this.requireBug(tables, caller.projectId, bugId)
    this.assertVersion(current.version, options.expectedVersion)
    if (!BUG_FLOW[current.status].includes(toStatus)) {
      throw new Error(`project-data: 非法 BUG 状态流转 ${current.status} → ${toStatus}`)
    }
    if (toStatus === 'fixed' && (options.fixReleaseId === undefined || options.fixReleaseId.trim() === '')) {
      throw new Error('project-data: fixed 必须附 fixReleaseId（指向真实 Release）')
    }
    if (toStatus === 'rejected' && (options.rejectReason === undefined || options.rejectReason.trim() === '')) {
      throw new Error('project-data: rejected 必须填写驳回理由')
    }
    const next = parseEntity(bugEntitySchema, {
      ...current,
      status: toStatus,
      ...(toStatus === 'fixed' ? { fixReleaseId: options.fixReleaseId!.trim() } : {}),
      ...(toStatus === 'rejected' ? { rejectReason: options.rejectReason!.trim() } : {}),
      statusHistory: [...current.statusHistory, transition(toStatus, caller.id)],
      updatedAt: Date.now(),
      version: current.version + 1,
    }, 'bug')
    await this.audit(tables, {
      projectId: caller.projectId,
      entityType: 'bug',
      entityId: bugId,
      action: `status:${toStatus}`,
      actor: caller.id,
      role: caller.role,
      summary: `BUG「${current.title}」${current.status} → ${toStatus}`,
      ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
    })
    await tables.bugs.put(entityKey(caller.projectId, bugId), next)
    await this.syncRequirementDerivedStatus(tables, caller.projectId, current.requirementId)
    return next
  }

  /** BUG 转交（Dev 直写免确认但留痕；转交后回到 processing）。 */
  async transferBug(caller: ProjectCaller, bugId: string, toUserId: string, reason?: string, expectedVersion?: number): Promise<BugEntity> {
    this.assertWrite(caller, 'bug', 'assign')
    const tables = await this.tables()
    const current = await this.requireBug(tables, caller.projectId, bugId)
    this.assertVersion(current.version, expectedVersion)
    const project = loadProject(caller.projectId)
    if (project === undefined) throw new Error(`project-data: project "${caller.projectId}" not found`)
    requireMember(project, toUserId)
    if (current.status !== 'open' && current.status !== 'processing' && current.status !== 'reopened') {
      throw new Error(`project-data: 当前状态 ${current.status} 不可转交（仅 open/processing/reopened 可转）`)
    }
    const next = parseEntity(bugEntitySchema, {
      ...current,
      assigneeId: toUserId,
      status: 'processing' satisfies BugStatus,
      transferHistory: [...current.transferHistory, {
        fromUserId: current.assigneeId,
        toUserId,
        ...(reason !== undefined && reason.trim() !== '' ? { reason: reason.trim() } : {}),
        at: Date.now(),
      }],
      statusHistory: [...current.statusHistory, transition('processing', caller.id)],
      updatedAt: Date.now(),
      version: current.version + 1,
    }, 'bug')
    await this.audit(tables, {
      projectId: caller.projectId,
      entityType: 'bug',
      entityId: bugId,
      action: 'transfer',
      actor: caller.id,
      role: caller.role,
      summary: `BUG「${current.title}」转交 ${current.assigneeId} → ${toUserId}`,
      ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
    })
    await tables.bugs.put(entityKey(caller.projectId, bugId), next)
    await this.syncRequirementDerivedStatus(tables, caller.projectId, current.requirementId)
    return next
  }

  /** 需求 Readiness 聚合（PRD §3.5；服务端实时重算，不冗余存计数）。 */
  async getReadiness(projectId: string, requirementId: string): Promise<RequirementReadiness> {
    const [tasks, bugs] = await Promise.all([this.listTasks(projectId, requirementId), this.listBugs(projectId, requirementId)])
    return computeRequirementReadiness(requirementId, tasks, bugs)
  }

  /** PM 判需求结束（服务端重算 Readiness；空需求/阻断严重未清必拒）。 */
  async finishRequirement(caller: ProjectCaller, requirementId: string, expectedVersion?: number): Promise<RequirementEntity> {
    this.assertWrite(caller, 'requirement', 'status', 'finished')
    const tables = await this.tables()
    const current = await this.requireRequirement(tables, caller.projectId, requirementId)
    this.assertVersion(current.version, expectedVersion)
    const readiness = await this.getReadiness(caller.projectId, requirementId)
    if (!readiness.readyToFinish) {
      throw new Error(
        `project-data: 需求未达结束条件 — feature ${readiness.featureCompleted}/${readiness.featureTotal}，未关闭阻断/严重 BUG ${readiness.openBlockers} 个`,
      )
    }
    const next = parseEntity(requirementEntitySchema, {
      ...current,
      status: 'finished' satisfies RequirementStatus,
      statusHistory: [...current.statusHistory, transition('finished', caller.id)],
      updatedAt: Date.now(),
      version: current.version + 1,
    }, 'requirement')
    await this.audit(tables, {
      projectId: caller.projectId,
      entityType: 'requirement',
      entityId: requirementId,
      action: 'status:finished',
      actor: caller.id,
      role: caller.role,
      summary: `需求「${current.title}」裁决结束`,
      ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
    })
    await tables.requirements.put(entityKey(caller.projectId, requirementId), next)
    return next
  }

  /**
   * 需求派生态同步（PRD §3.3）：任务/BUG 事实变化后重算 submitted/in_dev/
   * dev_done/verifying。派生态不落 statusHistory、不产生独立审计；finished 不回退。
   */
  private async syncRequirementDerivedStatus(tables: Tables, projectId: string, requirementId: string): Promise<void> {
    const requirement = tables.requirements.get(entityKey(projectId, requirementId))
    if (requirement === undefined || requirement.deletedAt !== undefined || requirement.status === 'finished') return
    const [tasks, bugs] = await Promise.all([this.listTasks(projectId, requirementId), this.listBugs(projectId, requirementId)])
    const derived = deriveRequirementStatus(requirement.status, requirementId, tasks, bugs)
    if (derived === requirement.status) return
    await tables.requirements.put(entityKey(projectId, requirementId), parseEntity(requirementEntitySchema, {
      ...requirement,
      status: derived,
      updatedAt: Date.now(),
      version: requirement.version + 1,
    }, 'requirement'))
  }

  /**
   * 在泳道会话 setup 里装配数据层工具（经 CorumAgentService.registerLaneSetupHook
   * 全会话统一装配）。写工具调用者身份由 exec.agent 反查，模型不能自报 role。
   */
  installAgentTools(agentCtx: Context, projectId: string, _profileId: string): void {
    const json = (value: unknown): string => JSON.stringify(value, null, 2)
    const textOutput = {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    } as const

    agentCtx.tools.register(defineTool({
      name: 'list_requirements',
      description: '列出本项目的需求（共享实体；平级协作黑板的需求主线）。',
      parameters: {},
      output: textOutput,
      execute: async () => json(await this.listRequirements(projectId)),
    }))

    agentCtx.tools.register(defineTool({
      name: 'create_task',
      description: [
        '在指定需求下创建一个项目任务（共享实体，不是调度队列条目）。',
        '创建后可用调度工具 assign_task 把执行工作派给对应成员泳道。',
      ].join(''),
      parameters: {
        requirementId: { type: 'string', required: true, description: '所属需求 id' },
        title: { type: 'string', required: true, description: '任务标题' },
        desc: { type: 'string', description: '任务描述/验收补充' },
        assigneeId: { type: 'string', description: '执行者 profileId（缺省=调用者）' },
        isFeature: { type: 'boolean', description: '是否功能单元（缺省 true，参与需求完成度聚合）' },
        priority: { type: 'integer', description: '优先级 0-3（缺省 1）' },
        acceptance: { type: 'string', description: '验收标准' },
      },
      output: textOutput,
      execute: async (args, exec) => json(await this.createTask(this.resolveCaller(exec, projectId), args)),
    }))

    agentCtx.tools.register(defineTool({
      name: 'list_tasks',
      description: '列出项目任务（可按需求过滤）。',
      parameters: {
        requirementId: { type: 'string', description: '可选：只看该需求下的任务' },
      },
      output: textOutput,
      execute: async (args) => json(await this.listTasks(projectId, args.requirementId)),
    }))

    agentCtx.tools.register(defineTool({
      name: 'update_task_status',
      description: [
        '流转项目任务状态。合法边：todo→doing，doing→todo/dev_done，dev_done→completed（仅 PM），completed→doing（PM 驳回返工）。',
        '这是共享实体状态机，不等同于调度上报 complete_task。',
      ].join(''),
      parameters: {
        taskId: { type: 'string', required: true },
        status: { type: 'string', enum: ['todo', 'doing', 'dev_done', 'completed'], required: true },
        expectedVersion: { type: 'integer', description: '可选乐观锁版本（冲突即拒）' },
      },
      output: textOutput,
      execute: async (args, exec) => json(await this.updateTaskStatus(
        this.resolveCaller(exec, projectId),
        args.taskId,
        args.status,
        args.expectedVersion,
      )),
    }))

    agentCtx.tools.register(defineTool({
      name: 'report_bug',
      description: '上报一个 BUG（QA 直写；关联需求，严重度 blocker/critical/major/minor）。',
      parameters: {
        requirementId: { type: 'string', required: true },
        title: { type: 'string', required: true },
        severity: { type: 'string', enum: ['blocker', 'critical', 'major', 'minor'], required: true },
        description: { type: 'string' },
        reproSteps: { type: 'string' },
        assigneeId: { type: 'string', description: '处理人 profileId（缺省=调用者）' },
        taskId: { type: 'string', description: '可选关联任务 id' },
      },
      output: textOutput,
      execute: async (args, exec) => json(await this.createBug(this.resolveCaller(exec, projectId), args)),
    }))

    agentCtx.tools.register(defineTool({
      name: 'transition_bug',
      description: [
        '流转 BUG 状态。Dev：processing/fixed/rejected；QA：pending_verify/closed/reopened。',
        'fixed 必须带 fixReleaseId；rejected 必须带 rejectReason；closed 仅 QA 可执行。',
      ].join(''),
      parameters: {
        bugId: { type: 'string', required: true },
        status: { type: 'string', enum: ['processing', 'fixed', 'rejected', 'pending_verify', 'closed', 'reopened'], required: true },
        fixReleaseId: { type: 'string', description: 'fixed 必填：修复版本 id' },
        rejectReason: { type: 'string', description: 'rejected 必填：驳回理由' },
        expectedVersion: { type: 'integer', description: '可选乐观锁版本' },
      },
      output: textOutput,
      execute: async (args, exec) => json(await this.transitionBug(this.resolveCaller(exec, projectId), args.bugId, args.status, {
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
        ...(args.fixReleaseId !== undefined ? { fixReleaseId: args.fixReleaseId } : {}),
        ...(args.rejectReason !== undefined ? { rejectReason: args.rejectReason } : {}),
      })),
    }))

    agentCtx.tools.register(defineTool({
      name: 'get_requirement_readiness',
      description: '重算需求结束判定（功能任务完成度 + 阻断/严重 BUG 是否清零）。',
      parameters: {
        requirementId: { type: 'string', required: true },
      },
      output: textOutput,
      execute: async (args) => json(await this.getReadiness(projectId, args.requirementId)),
    }))

    agentCtx.tools.register(defineTool({
      name: 'finish_requirement',
      description: 'PM 裁决结束需求：服务端重算 Readiness，空需求或未清阻断/严重 BUG 必拒。',
      parameters: {
        requirementId: { type: 'string', required: true },
        expectedVersion: { type: 'integer', description: '可选乐观锁版本' },
      },
      output: textOutput,
      execute: async (args, exec) => json(await this.finishRequirement(
        this.resolveCaller(exec, projectId),
        args.requirementId,
        args.expectedVersion,
      )),
    }))
  }

  // ── TypertRemoteService @Remote 端点（/api/corumProjectData/*） ──────────

  @Remote('listRequirements')
  async listRequirementsRemote(projectId: string): Promise<{ requirements: RequirementEntity[] }> {
    return { requirements: await this.listRequirements(projectId) }
  }

  @Remote('createRequirement')
  async createRequirementRemote(projectId: string, title: string, description?: string, priority?: number): Promise<{ requirement: RequirementEntity }> {
    return { requirement: await this.createRequirement(this.humanCaller(projectId), {
      title,
      ...(description !== undefined ? { description } : {}),
      ...(priority !== undefined ? { priority } : {}),
    }) }
  }

  @Remote('listTasks')
  async listTasksRemote(projectId: string, requirementId?: string): Promise<{ tasks: TaskEntity[] }> {
    return { tasks: await this.listTasks(projectId, requirementId) }
  }

  @Remote('createTask')
  async createTaskRemote(projectId: string, requirementId: string, title: string, assigneeId?: string): Promise<{ task: TaskEntity }> {
    return { task: await this.createTask(this.humanCaller(projectId), {
      requirementId,
      title,
      ...(assigneeId !== undefined ? { assigneeId } : {}),
    }) }
  }

  @Remote('updateTaskStatus')
  async updateTaskStatusRemote(projectId: string, taskId: string, status: TaskStatus, expectedVersion?: number): Promise<{ task: TaskEntity }> {
    return { task: await this.updateTaskStatus(this.humanCaller(projectId), taskId, status, expectedVersion) }
  }

  @Remote('listBugs')
  async listBugsRemote(projectId: string, requirementId?: string): Promise<{ bugs: BugEntity[] }> {
    return { bugs: await this.listBugs(projectId, requirementId) }
  }

  @Remote('createBug')
  async createBugRemote(projectId: string, requirementId: string, title: string, severity: BugSeverity, assigneeId?: string): Promise<{ bug: BugEntity }> {
    return { bug: await this.createBug(this.humanCaller(projectId), {
      requirementId,
      title,
      severity: bugSeveritySchema.parse(severity),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
    }) }
  }

  @Remote('transitionBug')
  async transitionBugRemote(
    projectId: string,
    bugId: string,
    status: BugStatus,
    fixReleaseId?: string,
    rejectReason?: string,
    expectedVersion?: number,
  ): Promise<{ bug: BugEntity }> {
    return { bug: await this.transitionBug(this.humanCaller(projectId), bugId, status, {
      ...(fixReleaseId !== undefined ? { fixReleaseId } : {}),
      ...(rejectReason !== undefined ? { rejectReason } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    }) }
  }

  @Remote('getRequirementReadiness')
  async getRequirementReadinessRemote(projectId: string, requirementId: string): Promise<{ readiness: RequirementReadiness }> {
    return { readiness: await this.getReadiness(projectId, requirementId) }
  }

  @Remote('finishRequirement')
  async finishRequirementRemote(projectId: string, requirementId: string, expectedVersion?: number): Promise<{ requirement: RequirementEntity }> {
    return { requirement: await this.finishRequirement(this.humanCaller(projectId), requirementId, expectedVersion) }
  }
}

export default CorumProjectDataService
