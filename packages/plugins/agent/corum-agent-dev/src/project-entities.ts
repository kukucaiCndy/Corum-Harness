/**
 * ctx.project 数据层实体 schema（第一刀：需求 / 任务 / BUG）。
 *
 * 设计依据：
 *   - docs/PRD-project-management.md §7.1（实体 schema 与状态机）
 *   - docs/agent-foundation/AGENT-FOUNDATION-GAP-ANALYSIS.md §5（数据层与
 *     领域事件词汇 / 共享黑板一体设计）
 *   - 工程约束：存储底座复用官方 dsh-storage-domain（defineDomain + domain/changed），
 *     不自研存储引擎；显式 undefined 不进 JSON（exactOptionalPropertyTypes）。
 *
 * 边界说明：本文件只定义「共享实体」的持久 schema 与纯函数推导；写入入口、
 * 权限网关、状态机校验在 project-data-service.ts。调度队列条目仍是轻量指针，
 * 依赖关系（blockedBy/dependencies）存任务实体而非队列条目（DESIGN §3.5/§3.14）。
 * @module @corum/corum-agent-dev/project-entities
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 数据层专业角色（PRD §4 角色标签；human 是真人入口）。 */
export const projectRoleSchema = z.enum(['pm', 'pd', 'techLead', 'dev', 'qa', 'human'])
export type ProjectRole = z.infer<typeof projectRoleSchema>

/** BUG 严重度（PRD §3.4：阻断/严重必须清零，一般/轻微可遗留）。 */
export const bugSeveritySchema = z.enum(['blocker', 'critical', 'major', 'minor'])
export type BugSeverity = z.infer<typeof bugSeveritySchema>

/** 状态流转埋点（§6.5 看板度量地基；派生态不进此列）。 */
export const statusTransitionSchema = z.object({
  status: z.string(),
  at: z.number(),
  /** actor：真人 'user' 或 Agent sessionId。 */
  by: z.string(),
})
export type StatusTransition = z.infer<typeof statusTransitionSchema>

/** 需求状态（主线心脏；finished 仅 PM 裁决，其余由系统派生）。 */
export const requirementStatusSchema = z.enum(['submitted', 'in_dev', 'dev_done', 'verifying', 'finished'])
export type RequirementStatus = z.infer<typeof requirementStatusSchema>

/** 任务状态（dev_done → completed 仅 PM 裁决）。 */
export const taskStatusSchema = z.enum(['todo', 'doing', 'dev_done', 'completed'])
export type TaskStatus = z.infer<typeof taskStatusSchema>

/** BUG 状态（closed 仅 QA；reopened 回 processing 待 Dev 再处理）。 */
export const bugStatusSchema = z.enum(['open', 'processing', 'fixed', 'rejected', 'pending_verify', 'closed', 'reopened'])
export type BugStatus = z.infer<typeof bugStatusSchema>

const idSchema = z.string().min(1)
const projectIdSchema = z.string().min(1)
const timestampSchema = z.number().int().nonnegative()
const versionSchema = z.number().int().nonnegative()

/** 需求实体（PRD §7.1 Requirement，P0 切片）。 */
export const requirementEntitySchema = z.object({
  id: idSchema,
  projectId: projectIdSchema,
  /** 关联计划阶段/计划 id（P0 单阶段可缺省；后续接 Plan 实体）。 */
  planId: z.string().optional(),
  stageId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  /** PD/创建者（profileId 或 user）。 */
  ownerId: z.string().min(1),
  status: requirementStatusSchema,
  priority: z.number().int().min(0).max(3).default(1),
  statusHistory: z.array(statusTransitionSchema).default([]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.optional(),
  version: versionSchema,
})
export type RequirementEntity = z.infer<typeof requirementEntitySchema>

/** 任务实体（PRD §7.1 Task；依赖关系存这里，不进队列条目）。 */
export const taskEntitySchema = z.object({
  id: idSchema,
  projectId: projectIdSchema,
  requirementId: idSchema,
  parentTaskId: idSchema.optional(),
  title: z.string().min(1),
  desc: z.string().optional(),
  /** 是否功能单元（参与需求完成度聚合）。 */
  isFeature: z.boolean().default(true),
  status: taskStatusSchema,
  priority: z.number().int().min(0).max(3).default(1),
  /** 当前执行者（profileId）。 */
  assigneeId: idSchema,
  /** 执行者专业角色快照（冗余便于审计/展示）。 */
  assigneeRole: projectRoleSchema.optional(),
  /** 关联泳道会话（MVP 唯一关联；后续接 session 池标签）。 */
  sessionId: z.string().optional(),
  acceptance: z.string().optional(),
  estimateMin: z.number().int().nonnegative().optional(),
  dueAt: timestampSchema.optional(),
  /** 阻塞/依赖：本任务被哪些任务阻塞（单阻塞链原则下同刻至多一个有效阻塞源）。 */
  blockedBy: z.array(idSchema).default([]),
  statusHistory: z.array(statusTransitionSchema).default([]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.optional(),
  version: versionSchema,
})
export type TaskEntity = z.infer<typeof taskEntitySchema>

/** BUG 转交记录（追加只写）。 */
export const bugTransferSchema = z.object({
  fromUserId: z.string().min(1),
  toUserId: z.string().min(1),
  reason: z.string().optional(),
  at: timestampSchema,
})
export type BugTransfer = z.infer<typeof bugTransferSchema>

/** BUG 实体（PRD §7.1 Bug；closed 仅 QA 验收/接受驳回后）。 */
export const bugEntitySchema = z.object({
  id: idSchema,
  projectId: projectIdSchema,
  requirementId: idSchema,
  taskId: idSchema.optional(),
  testCaseId: idSchema.optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  reproSteps: z.string().optional(),
  severity: bugSeveritySchema,
  reporterId: idSchema,
  assigneeId: idSchema,
  status: bugStatusSchema,
  /** fixed 必填：指向真实 Release（Release 实体后续补齐，本期先记 id）。 */
  fixReleaseId: idSchema.optional(),
  rejectReason: z.string().optional(),
  transferHistory: z.array(bugTransferSchema).default([]),
  statusHistory: z.array(statusTransitionSchema).default([]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.optional(),
  version: versionSchema,
})
export type BugEntity = z.infer<typeof bugEntitySchema>

/** 轻量审计记录（覆盖 100% 写操作；查询 UI/轮转 P1）。 */
export const projectAuditSchema = z.object({
  id: idSchema,
  projectId: projectIdSchema,
  entityType: z.enum(['requirement', 'task', 'bug']),
  entityId: idSchema,
  action: z.string().min(1),
  actor: z.string().min(1),
  role: projectRoleSchema,
  /** 变更摘要（人类可读；diff 明细后续补结构化 before/after）。 */
  summary: z.string(),
  at: timestampSchema,
  sessionId: z.string().optional(),
})
export type ProjectAudit = z.infer<typeof projectAuditSchema>

/**
 * ctx.project 领域声明：一域多项目，记录 key 用 `<projectId>/<entityId>` 隔离。
 * 官方 storage-domain 负责：schema 校验、单域写链、持久化后发 domain/changed。
 */
export const projectDataDomainSpec = defineDomain({
  name: 'corum_project',
  version: 1,
  tables: {
    requirements: domainTable<string, RequirementEntity>(requirementEntitySchema),
    tasks: domainTable<string, TaskEntity>(taskEntitySchema),
    bugs: domainTable<string, BugEntity>(bugEntitySchema),
    audits: domainTable<string, ProjectAudit>(projectAuditSchema),
  },
})

/** 实体表键：`<projectId>/<entityId>`（一域多项目隔离）。 */
export function entityKey(projectId: string, entityId: string): string {
  return `${projectId}/${entityId}`
}

/** 需求结束判定聚合视图（PRD §3.5，服务端重算，不冗余存计数）。 */
export interface RequirementReadiness {
  readonly requirementId: string
  readonly featureTotal: number
  readonly featureCompleted: number
  readonly openBlockers: number
  readonly readyToFinish: boolean
  readonly blockingBugIds: readonly string[]
}

/** 由任务/BUG 实时计算需求 Readiness（单源事实 = 实体表）。 */
export function computeRequirementReadiness(
  requirementId: string,
  tasks: readonly TaskEntity[],
  bugs: readonly BugEntity[],
): RequirementReadiness {
  const featureTasks = tasks.filter(t => t.requirementId === requirementId && t.deletedAt === undefined && t.isFeature)
  const featureTotal = featureTasks.length
  const featureCompleted = featureTasks.filter(t => t.status === 'dev_done' || t.status === 'completed').length
  const blockingBugs = bugs.filter(b =>
    b.requirementId === requirementId
    && b.deletedAt === undefined
    && (b.severity === 'blocker' || b.severity === 'critical')
    && b.status !== 'closed',
  )
  const openBlockers = blockingBugs.length
  return {
    requirementId,
    featureTotal,
    featureCompleted,
    openBlockers,
    readyToFinish: featureTotal > 0 && featureTotal === featureCompleted && openBlockers === 0,
    blockingBugIds: blockingBugs.map(b => b.id),
  }
}

/** 需求派生态（PRD §3.3：不落 statusHistory，不产生独立审计）。 */
export function deriveRequirementStatus(
  current: RequirementStatus,
  requirementId: string,
  tasks: readonly TaskEntity[],
  bugs: readonly BugEntity[],
): RequirementStatus {
  if (current === 'finished') return current
  const relatedTasks = tasks.filter(t => t.requirementId === requirementId && t.deletedAt === undefined)
  const relatedBugs = bugs.filter(b => b.requirementId === requirementId && b.deletedAt === undefined)
  const featureTasks = relatedTasks.filter(t => t.isFeature)
  const hasBugActivity = relatedBugs.length > 0
  const allFeatureDone = featureTasks.length > 0 && featureTasks.every(t => t.status === 'dev_done' || t.status === 'completed')
  const hasDoing = relatedTasks.some(t => t.status === 'doing' || t.status === 'dev_done' || t.status === 'completed')
  if (hasBugActivity) return 'verifying'
  if (allFeatureDone) return 'dev_done'
  if (hasDoing) return 'in_dev'
  return 'submitted'
}
