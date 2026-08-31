/**
 * runtime-state —— AgentRuntime 的运行时状态结构与调度常量（从 runtime.ts 拆出，包内文件拆分）。
 *
 * 两个状态接口（LaneState / ProfileRuntime）+ 卡住感知阈值常量。这些是
 * 「项目 × 角色」调度层在内存中的显式投影：泳道池、串行队列、挂起集、
 * 阻塞循环唤醒器。类方法（runLoop/ensureAgent/installSchedulerTools 等）
 * 留 runtime.ts 原类——本模块只是状态形状与常量的事实源。
 * @module @corum/corum-agent-dev/runtime-state
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Task } from './runtime-task.ts'

/**
 * 一条泳道的运行时状态（泳道 = 「项目 × 角色 × 工作类型」的专属会话）。
 * 路由语义：任务按其 type 路由到同 type 泳道会话，保证模型注意力始终聚焦
 * 一类事物（UI 归 UI 泳道、debug 归 debug 泳道）。session 按 type 隔离、
 * 持久化可 resume（agent-service 的 sessions.json 索引），本结构是其在
 * 调度层的显式投影（未来「标签 = 需求 + 类型」语义化路由落地时，只需把
 * laneKey 从 type 换成标签，本池机制不变）。
 */
export interface LaneState {
  /** 泳道键 = 路由标签（关联需求：`<requirementId>:<type>`；兼容任务：`<type>`）。 */
  readonly key: string
  /** 工作类型 slug（泳道语义；UI/路由展示仍按 type 分组可读）。 */
  readonly type: string
  /** 关联需求 id（标签泳道的需求段；兼容泳道缺省）。 */
  readonly requirementId?: string
  /** 泳道会话 id（ensureAgent 建立后登记；未建立 = undefined）。 */
  sessionId: string | undefined
  /** 占用状态：busy = 正承载当前任务；idle = 可接活（一个角色串行，同刻至多一条 busy）。 */
  status: 'idle' | 'busy'
  /** busy 时承载的任务 id。 */
  currentTaskId: string | undefined
  /** 最近使用时间（池可见性/未来回收依据）。 */
  lastUsedAt: number
}

/** 一个「项目 × 角色」的运行时状态（目标模型：一个角色 Agent，串行队列 + 泳道池）。 */
export interface ProfileRuntime {
  readonly projectId: string
  readonly profileId: string
  /** 当前任务占用的泳道会话 Agent（按任务的 type 路由；任务间可切换）。 */
  agent: Agent | undefined
  /** 泳道池：该角色在本项目各工作类型上的会话状态（路由框架的显式事实）。 */
  readonly lanes: Map<string, LaneState>
  /** 挂起中的任务（blocked 等依赖解除；不参与调度，唤醒后回队列）。 */
  readonly suspended: Map<string, Task>
  readonly queue: Task[]
  current: Task | undefined
  /** 当前任务派发时的会话 seq（completed 的 resultRef.fromSeq 来源）。 */
  currentFromSeq: number | undefined
  /** 当前任务派发时间（卡住感知的执行时长起点）。 */
  currentStartedAt: number | undefined
  /** 当前任务是否已报告过 stalled（活动恢复后复位，可再报）。 */
  stallReported: boolean
  /** 队列空时阻塞循环的唤醒器。 */
  wakeTask: (() => void) | undefined
  /** 任务执行中阻塞循环的唤醒器（complete_task 触发）。 */
  wakeDone: (() => void) | undefined
  /** 该「项目 × 角色」的常驻循环是否已启动。 */
  started: boolean
  /** 循环实例防重入标记（runLoop 执行体持有；started 是调度意图，本标记是执行事实）。 */
  loopActive: boolean
  /** 成员被移出项目组后置位：循环退出、队列不再接活（调度边界收缩回收）。 */
  disposed: boolean
}

/** 卡住判定阈值：执行中任务超过此时长无泳道会话活动 → stalled（3 分钟经验起点）。 */
export const STALL_THRESHOLD_MS = 3 * 60 * 1000
/** 卡住扫描周期。 */
export const STALL_SCAN_INTERVAL_MS = 60 * 1000
