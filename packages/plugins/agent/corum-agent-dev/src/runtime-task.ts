/**
 * runtime-task —— AgentRuntime 的任务模型与纯函数（从 runtime.ts 拆出，包内文件拆分）。
 *
 * 领域级 Task 的完整 schema（对齐 DESIGN §3.5）+ 三个纯函数：
 *   - laneLabel / makeTaskSource / normalizeTask（enqueue 的构造/规范化）；
 *   - taskRef / renderTaskMessage（事件载荷快照与 followup 消息渲染）。
 * 纯数据层：不碰 cordis / 文件系统 / 服务实例。
 * @module @corum/corum-agent-dev/runtime-task
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TaskEntityType, TaskRef, TaskSource, TaskVia } from './events.ts'

/** 任务状态（领域级）。 */
export type TaskStatus = 'pending' | 'running' | 'done'

/** enqueue 的可选完整队列 schema 字段（DESIGN §3.5）。 */
export interface EnqueueOptions {
  readonly entityType?: TaskEntityType
  readonly entityId?: string
  readonly requirementId?: string
  readonly label?: string
  readonly via?: TaskVia
  readonly priority?: number
  readonly cause?: TaskSource['cause']
}

/** 计算泳道路由标签：关联需求 = `<requirementId>:<type>`；未关联兼容退化为 `<type>`。 */
export function laneLabel(type: string, requirementId?: string): string {
  return requirementId !== undefined && requirementId !== '' ? `${requirementId}:${type}` : type
}

/** 由 actor/选项构造来源追溯（谁提交、经哪条通道、因果边）。 */
export function makeTaskSource(actor: string, options: EnqueueOptions): TaskSource {
  const via: TaskVia = options.via
    ?? (actor === 'user' ? 'user-instruction'
      : actor === 'runtime' ? 'dependency'
      : actor === 'pm' ? 'pm-decision'
      : 'transfer')
  return {
    submitter: actor,
    via,
    at: Date.now(),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
  }
}

/**
 * 一条领域级任务（轻量：引用 + 摘要 + 增量 + 来源；全文在共享实体 ctx.project）。
 * 队列条目完整 schema 对齐 DESIGN §3.5；label 是泳道路由键（需求ID + 类型，
 * 未关联需求的兼容任务退化为 type）。
 */
export interface Task {
  readonly id: string
  /** 所属项目 id（团队属项目，调度隔离边界）。 */
  readonly projectId: string
  /** 目标角色 = AgentProfile id。 */
  readonly profileId: string
  /** 实体类型（轻量指针指向的共享实体类别；调度期临时任务也用 task）。 */
  readonly entityType: TaskEntityType
  /** 指向 ctx.project 共享实体的 id（未接实体时缺省）。 */
  readonly entityId?: string
  /** 泳道路由标签：关联需求时为 `<requirementId>:<type>`，否则兼容退化为 `<type>`。 */
  readonly label: string
  /** 工作类型 slug：泳道语义（路由键是 label）。 */
  readonly type: string
  /** 关联需求 id（label 的需求段；未关联缺省）。 */
  readonly requirementId?: string
  /** 任务摘要（提交方生成）。 */
  readonly summary: string
  /** 增量 context（提交方组装，可选）。 */
  readonly transferNote?: string
  /** 来源追溯（提交方/通道/时间/因果）。 */
  readonly source: TaskSource
  /** 优先级（0-3，可选；排序策略后续接）。 */
  readonly priority?: number
  /** 派发者（派活的角色 / 'user' / 'runtime'），用于领域事件台账（兼容字段，事实以 source 为准）。 */
  readonly actor?: string
  /** 挂起时的阻塞源任务 id（report_blocked 回填；唤醒后清除）。 */
  blockedByTaskId?: string
  status: TaskStatus
}

/** 规范化队列条目（兼容旧事件/旧调用：补完整 schema 缺省值；显式 undefined 不进 JSON）。 */
export function normalizeTask(task: Task): Task {
  const requirementId = task.requirementId
  const label = task.label !== undefined && task.label !== '' ? task.label : laneLabel(task.type, requirementId)
  const source = task.source ?? makeTaskSource(task.actor ?? 'user', {})
  return {
    ...task,
    entityType: task.entityType ?? 'task',
    label,
    ...(requirementId !== undefined ? { requirementId } : {}),
    source,
  }
}

/** 取任务的领域引用快照（领域事件载荷；显式 undefined 不进 JSON）。 */
export function taskRef(task: Task): TaskRef {
  return {
    id: task.id,
    projectId: task.projectId,
    profileId: task.profileId,
    entityType: task.entityType,
    ...(task.entityId !== undefined ? { entityId: task.entityId } : {}),
    label: task.label,
    type: task.type,
    ...(task.requirementId !== undefined ? { requirementId: task.requirementId } : {}),
    summary: task.summary,
    ...(task.transferNote !== undefined && task.transferNote !== '' ? { transferNote: task.transferNote } : {}),
    source: task.source,
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
  }
}

/** 把任务渲染成一条 followup 消息（摘要 + 增量 + 完成指令）。 */
export function renderTaskMessage(task: Task): ReturnType<typeof createUserMessage> {
  const lines = [`【任务】${task.summary}`, `【路由】${task.label}（实体 ${task.entityType}${task.entityId !== undefined ? `#${task.entityId}` : ''}）`]
  if (task.transferNote !== undefined && task.transferNote !== '') {
    lines.push(`【上下文】${task.transferNote}`)
  }
  lines.push('请开始处理该任务；完成后调用 complete_task 上报。')
  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n\n') }],
    source: { kind: 'plugin', plugin: '@corum/corum-agent-dev' },
  })
}
