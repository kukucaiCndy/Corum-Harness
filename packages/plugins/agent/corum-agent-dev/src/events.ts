/**
 * corum 领域事件词汇（自研）—— Agent 地基三缺口之一。
 *
 * 词汇表（均为「项目 × 角色」调度域的事实，JSON-safe）：
 *   - corum/task/assigned   任务入队到某「项目 × 角色」队列（谁派的、队列水位）。
 *   - corum/task/started    调度器已把任务派进泳道会话（followup 已发出）。
 *   - corum/task/completed  执行侧 complete_task 上报，任务闭环（含完成说明）。
 *   - corum/task/deferred   派发失败（泳道会话创建失败等），任务放回队首稍后重试。
 *   - corum/task/evicted    任务未执行即被逐出队列（成员被移出项目组等）。
 *   - corum/task/blocked    任务遇阻塞即停（单阻塞链），挂起等依赖解除（§3.14）。
 *   - corum/task/unblocked  依赖任务完成，挂起任务被唤醒回队列（方案 A 反查推导）。
 *   - corum/task/stalled    执行中任务超过阈值无活动（卡住感知，信息事件）。
 *   - corum/task/steered    PM/用户对执行中任务插入引导（收敛干预）。
 *   - corum/task/cancelled  PM/用户中止执行中任务（fate=requeue/evicted/reassigned）。
 *   - corum/group/member-added    项目组成员加入（调度边界扩大）。
 *   - corum/group/member-removed  项目组成员移除（调度边界收缩，触发运行时回收）。
 *
 * 载体（诚实分层）：
 *   - 本步（词汇表）：cordis 事件总线（ctx.emit，进程内实时订阅）——后续
 *     「事件驱动唤起角色 Agent」的调度器和 UI 通知都订阅本层。每个事实只在
 *     其真实发生点发布一次，不重复记录。
 *   - 下一步（数据层/共享黑板）：持久台账归 ctx.project 数据层，底座复用官方
 *     dsh-storage-domain（defineDomain + domain/changed，dsh-workspace 同款），
 *     不在本层伪装持久化。刻意不写泳道会话日志——泳道会话按（项目×角色×泳道）
 *     隔离、平级 Agent 互不可见，写进去会把项目级台账切碎且对协作方不可见。
 *
 * 设计依据：docs/agent-foundation/AGENT-FOUNDATION-GAP-ANALYSIS.md §4（领域事件
 * 词汇与 ctx.project 数据层、共享黑板一体设计；本文件是词汇的事实源）。
 * @module @corum/corum-agent-dev/events
 */

import type { Context } from '@deepseek-ai/cordis'
import { appendSchedulerEvent } from './event-log.ts'
import type { ProjectGroupMember } from './project.ts'

/** 队列条目实体类型（DESIGN §3.5；轻量指针，全文在 ctx.project 共享实体）。 */
export type TaskEntityType = 'task' | 'bug' | 'requirement' | 'discussion' | 'review'

/** 队列条目来源通道（谁提交的、经哪条路进入调度）。 */
export type TaskVia = 'transfer' | 'bug-report' | 'user-instruction' | 'dependency' | 'pm-decision'

/** 队列条目来源追溯（提交方组装谁填；支撑回溯与依赖追踪）。 */
export interface TaskSource {
  /** 提交方：角色 profileId、'user' 或 'runtime'。 */
  readonly submitter: string
  readonly via: TaskVia
  readonly at: number
  /** 因果链（阻塞派生/依赖解除/转交等）。 */
  readonly cause?: {
    readonly kind: 'blocked-by' | 'depends-on' | 'assigned' | 'reported'
    readonly byTaskId?: string
  }
}

/**
 * 任务的领域引用（队列条目的 JSON-safe 快照；全文后续接 ctx.project 共享实体）。
 * 完整 schema 见 DESIGN §3.5：引用 + 摘要 + 增量 + 来源；label 是泳道路由键
 * （需求ID + 类型；未关联需求的兼容任务退化为 type）。
 */
export interface TaskRef {
  readonly id: string
  /** 所属项目 id（调度隔离边界）。 */
  readonly projectId: string
  /** 目标角色 = AgentProfile id。 */
  readonly profileId: string
  /** 实体类型（轻量指针指向的共享实体类别；调度期临时任务也用 task）。 */
  readonly entityType: TaskEntityType
  /** 指向 ctx.project 共享实体的 id（未接实体时缺省，队列 id 即临时实体引用）。 */
  readonly entityId?: string
  /** 泳道路由标签：关联需求时为 `<requirementId>:<type>`，否则兼容退化为 `<type>`。 */
  readonly label: string
  /** 工作类型 slug（泳道语义仍保留；路由键是 label）。 */
  readonly type: string
  /** 关联需求 id（label 的需求段；未关联缺省）。 */
  readonly requirementId?: string
  /** 任务摘要。 */
  readonly summary: string
  /** 增量 context（提交方组装，可选）。 */
  readonly transferNote?: string
  /** 来源追溯（提交方/通道/时间/因果）。 */
  readonly source: TaskSource
  /** 优先级（0-3，可选；排序策略后续接）。 */
  readonly priority?: number
}

/** corum/task/assigned：任务入队。 */
export interface TaskAssignedEvent {
  readonly task: TaskRef
  /** 派发者：派活的角色 profileId、'user'（界面/RPC）或 'runtime'（调度器自派生）。 */
  readonly actor: string
  /** 入队后该「项目 × 角色」的队列长度（水位信号）。 */
  readonly queueLength: number
}

/** corum/task/started：任务已派进泳道会话。 */
export interface TaskStartedEvent {
  readonly task: TaskRef
  /** 承载该任务的泳道会话 id。 */
  readonly sessionId: string
  /** 任务占用该会话的起始 seq（团队日志 → Agent 工作现场的下钻起点）。 */
  readonly fromSeq: number
}

/** 指向泳道会话日志里一段工作成果的引用（TEAM-SCHEDULER-EVENT-LOG §6）。 */
export interface SessionResultRef {
  /** 泳道会话 id（官方 session 日志身份）。 */
  readonly sessionId: string
  /** 任务占用该会话的 seq 区间起点。 */
  readonly fromSeq: number
  /** 区间终点（completed 时补齐）。 */
  readonly toSeq: number
}

/** corum/task/completed：任务闭环。 */
export interface TaskCompletedEvent {
  readonly task: TaskRef
  /** 成果落点引用（下钻路径：resultRef → 官方 session 日志 readFrom(sessionId, fromSeq)）。 */
  readonly resultRef: SessionResultRef
  /** 执行侧的完成说明（complete_task 上报原文）。 */
  readonly result: string
}

/** corum/task/deferred：派发失败，任务放回队首重试（泳道会话未建立，无 sessionId）。 */
export interface TaskDeferredEvent {
  readonly task: TaskRef
  /** 失败原因（真实异常摘要）。 */
  readonly reason: string
}

/** 领域事件类型 → 载荷 的词汇表。 */
export interface CorumDomainEventMap {
  'corum/task/assigned': TaskAssignedEvent
  'corum/task/started': TaskStartedEvent
  'corum/task/completed': TaskCompletedEvent
  'corum/task/deferred': TaskDeferredEvent
  'corum/task/evicted': TaskEvictedEvent
  'corum/task/blocked': TaskBlockedEvent
  'corum/task/unblocked': TaskUnblockedEvent
  'corum/task/stalled': TaskStalledEvent
  'corum/task/steered': TaskSteeredEvent
  'corum/task/cancelled': TaskCancelledEvent
  'corum/group/member-added': GroupMemberAddedEvent
  'corum/group/member-removed': GroupMemberRemovedEvent
}

/** 领域事件类型联合。 */
export type CorumDomainEventType = keyof CorumDomainEventMap

/** corum/task/blocked：任务遇阻塞即停，挂起（单阻塞链：同刻至多一个阻塞源）。 */
export interface TaskBlockedEvent {
  readonly task: TaskRef
  /** 阻塞原因（执行侧陈述缺什么前置信息）。 */
  readonly reason: string
  /** 派生的「解除阻塞」任务 id（阻塞源；它完成时本任务被反查唤醒）。 */
  readonly blockedByTaskId: string
}

/** corum/task/unblocked：依赖任务完成，挂起任务回队列（调度器反查推导，C 无需知道 B）。 */
export interface TaskUnblockedEvent {
  readonly task: TaskRef
  /** 解除阻塞的任务 id（刚 completed 的那个）。 */
  readonly unblockedByTaskId: string
}

/** corum/task/stalled：执行中任务超过阈值无活动（卡住感知；不改变任务状态）。 */
export interface TaskStalledEvent {
  readonly task: TaskRef
  /** 距最后活动的秒数。 */
  readonly idleSec: number
}

/** corum/task/steered：对执行中任务插入引导（下一步边界生效，不打断）。 */
export interface TaskSteeredEvent {
  readonly task: TaskRef
  /** 引导内容（收敛指令）。 */
  readonly note: string
  /** 操作者（'pm' | 'user'）。 */
  readonly by: string
}

/** corum/task/cancelled：中止执行中/挂起任务。 */
export interface TaskCancelledEvent {
  readonly task: TaskRef
  /** 中止原因。 */
  readonly reason: string
  /** 处置：requeue（回队重派）| evicted（废弃）| reassigned（改派他人，新 assigned 另发）。 */
  readonly fate: 'requeue' | 'evicted' | 'reassigned'
  /** 操作者（'pm' | 'user'）。 */
  readonly by: string
}

/** corum/group/member-added：成员加入项目组。 */
export interface GroupMemberAddedEvent {
  readonly projectId: string
  /** 加入的成员（引用式：profileId + role + 可选 fromTeam）。 */
  readonly member: ProjectGroupMember
}

/** corum/group/member-removed：成员被移出项目组（调度器据此回收其运行时）。 */
export interface GroupMemberRemovedEvent {
  readonly projectId: string
  readonly profileId: string
}

/** corum/task/evicted：任务未执行即被逐出队列。 */
export interface TaskEvictedEvent {
  readonly task: TaskRef
  /** 逐出原因（如成员被移出项目组）。 */
  readonly reason: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** corum/task/assigned：任务入队到「项目 × 角色」队列。 */
    'corum/task/assigned'(data: TaskAssignedEvent): void
    /** corum/task/started：任务派进泳道会话（followup 已发出）。 */
    'corum/task/started'(data: TaskStartedEvent): void
    /** corum/task/completed：任务闭环（complete_task 上报）。 */
    'corum/task/completed'(data: TaskCompletedEvent): void
    /** corum/task/deferred：派发失败，任务放回队首重试。 */
    'corum/task/deferred'(data: TaskDeferredEvent): void
    /** corum/task/evicted：任务未执行即被逐出队列。 */
    'corum/task/evicted'(data: TaskEvictedEvent): void
    /** corum/task/blocked：任务遇阻塞挂起（单阻塞链）。 */
    'corum/task/blocked'(data: TaskBlockedEvent): void
    /** corum/task/unblocked：依赖解除，挂起任务回队列。 */
    'corum/task/unblocked'(data: TaskUnblockedEvent): void
    /** corum/task/stalled：执行中任务超时无活动（卡住感知）。 */
    'corum/task/stalled'(data: TaskStalledEvent): void
    /** corum/task/steered：对执行中任务插入引导。 */
    'corum/task/steered'(data: TaskSteeredEvent): void
    /** corum/task/cancelled：中止任务（fate=requeue/evicted/reassigned）。 */
    'corum/task/cancelled'(data: TaskCancelledEvent): void
    /** corum/group/member-added：项目组成员加入。 */
    'corum/group/member-added'(data: GroupMemberAddedEvent): void
    /** corum/group/member-removed：项目组成员移除（调度器回收其运行时）。 */
    'corum/group/member-removed'(data: GroupMemberRemovedEvent): void
  }
}

/** 一条已发布的领域事件记录（进程内回放视图，seq 单调递增；重启归零，持久台账归数据层）。 */
export interface DomainEventRecord<K extends CorumDomainEventType = CorumDomainEventType> {
  readonly seq: number
  readonly type: K
  readonly data: CorumDomainEventMap[K]
  readonly time: number
}

/**
 * 发布一条领域事件（事实只在真实发生点记一次，两通道同源、单一入口）：
 *   1. 项目级持久日志（scheduler-events.jsonl，唯一事实源，重启 fold 恢复）；
 *   2. cordis 总线（实时订阅；监控 hook 接入点 1，UI/调度器经 ctx.on 接收）。
 * 所有事实发布都走本函数（AgentRuntime.record / 各 Service 直调），
 * 保证「持久台账」与「实时流」永远同源、不分叉。
 */
export function publishDomainEvent<K extends CorumDomainEventType>(
  ctx: Context,
  type: K,
  data: CorumDomainEventMap[K],
  causedBy: readonly string[] = [],
): { id: string } {
  const event = appendSchedulerEvent(domainEventProjectId(data), type, data, causedBy)
  // cordis emit 的重载按字面量键解析参数元组，泛型 K 无法匹配——此处键与载荷
  // 已由 CorumDomainEventMap 约束配对，收窄为运行时签名转发。
  ;(ctx.emit as (type: string, data: unknown) => void)(type, data)
  return { id: event.id }
}

/** 从领域事件载荷提取 projectId（task.* 事件在 task.projectId，group.* 事件在 projectId）。 */
function domainEventProjectId(data: CorumDomainEventMap[CorumDomainEventType]): string {
  const task = (data as { task?: TaskRef }).task
  const projectId = task?.projectId ?? (data as { projectId?: string }).projectId
  if (projectId === undefined) throw new Error('dev-agent: 领域事件载荷缺 projectId')
  return projectId
}
