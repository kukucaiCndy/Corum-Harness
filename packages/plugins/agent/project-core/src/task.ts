/**
 * 任务队列类型：corum 项目管理平台的领域级任务。
 *
 * 队列条目 = 引用 + 摘要 + 增量 + 来源追溯（轻量指针，全文在 ctx.project 共享实体）。
 * 依赖关系不放在队列条目里，而是存任务实体（ctx.project），本文件只定义运行时需要的轻量视图。
 *
 * 这是 Agent Loop 这一层的第一个增量：官方 inbox 排 `UserMessage`，这里排「任务」。
 * @module @corum/project-core/task
 */

import type { RoleId } from './roles.ts'

/** 任务来源通道（谁提交的，走什么通道）。 */
export type TaskVia =
  | 'transfer'        // 角色 Agent 转交
  | 'bug-report'      // BUG 上报
  | 'user-instruction' // 用户指令（经 PM）
  | 'dependency'      // 阻塞派生依赖任务
  | 'pm-decision'     // PM 决策派发

/** 任务因果。 */
export interface TaskCause {
  readonly kind: 'blocked-by' | 'depends-on' | 'assigned' | 'reported'
  readonly byTaskId?: string
}

/** 来源追溯。 */
export interface TaskSource {
  /** 提交方 agentId（谁组装谁填）。 */
  readonly submitter: string
  readonly via: TaskVia
  readonly at: number
  readonly cause?: TaskCause
}

/** 增量 context（动态层，提交方组装）。 */
export interface TaskIncrement {
  /** 提交方推理结论/说明（自然语言）。 */
  readonly transferNote?: string
  /** 关联任务即时状态（结构化，后续由 ctx.project 定义精确 schema）。 */
  readonly relatedState?: unknown
}

/** 任务状态（领域级，含可恢复的阻塞中间态）。 */
export type TaskStatus = 'pending' | 'running' | 'blocked' | 'done'

/** 任务队列条目（轻量视图）。 */
export interface Task {
  /** 任务实体 id（指向 ctx.project 的 task/bug/requirement）。 */
  readonly id: string
  /** 实体类型。 */
  readonly entityType: 'task' | 'bug' | 'requirement' | 'discussion' | 'review'
  /** 标签 = 需求ID + 类型（决定 session 路由；后续接入 session 池时使用）。 */
  readonly label: string
  /** 目标角色。 */
  readonly targetRole: RoleId
  /** 摘要（提交方生成）。 */
  readonly summary: string
  /** 增量 context。 */
  readonly increment: TaskIncrement
  /** 来源追溯。 */
  readonly source: TaskSource
  /** 当前状态。 */
  status: TaskStatus
}

/**
 * 构建一条任务队列条目。
 * @returns 状态为 `pending` 的任务。
 */
export function createTask(input: Omit<Task, 'status'>): Task {
  return { ...input, status: 'pending' }
}
