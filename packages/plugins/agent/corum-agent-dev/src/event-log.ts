/**
 * 团队调度事件日志（项目级持久化）—— TEAM-SCHEDULER-EVENT-LOG.md 最小闭环落地。
 *
 * 存储形态（设计 §3）：`$CORUM_HOME/projects/<projectId>/scheduler-events.jsonl`
 *   - append-only JSONL，每行一个事件；只追加、不改写、不删除；
 *   - 崩溃半行在 fold 时截断忽略（视为崩溃残留，不计入）；
 *   - seq 从 0 连续递增（per-project），fold 校验空洞/乱序拒绝恢复（宁可拒载）。
 *
 * 与运行时词汇（events.ts）的关系：events.ts 的 CorumDomainEventMap 是「类型 +
 * 载荷」词汇事实源，本模块给它套上持久化信封（seq/id/causedBy/at/version）。
 * 写入路径：SchedulerEventLog.append(projectId, type, payload) → 落盘 + 发
 * cordis 领域事件（监控 hook §7.1 接入点 1：cordis 即实时流，不再另发）。
 *
 * fold 恢复（§7）：重启时各项目全量 fold 推导调度状态（每角色队列/当前任务），
 * AgentRuntime 据此重建 runLoop——事件是唯一事实源，状态是派生物。
 *
 * 本期范围（§8 最小闭环）：task 主线（assigned/started/completed/deferred/
 * evicted）+ group 成员事件；blocked/unblocked/transferred 词汇后续扩展。
 * @module @corum/corum-agent-dev/event-log
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { projectDir } from './project-store.ts'
import type { CorumDomainEventMap, CorumDomainEventType } from './events.ts'

/** 持久化事件信封（物理线性 seq + 逻辑因果 causedBy，设计 §4.1）。 */
export interface SchedulerEvent<K extends CorumDomainEventType = CorumDomainEventType> {
  /** 本日志内全局单调递增序号（从 0 连续；fold/时间线索引）。 */
  readonly seq: number
  /** 事件唯一 id（causedBy 引用它；稳定、抗 fold 中插入）。 */
  readonly id: string
  /** 事件类型（词汇见 events.ts）。 */
  readonly type: K
  /** 所属项目（恒等于日志落点 projectId，冗余便于跨项目聚合）。 */
  readonly projectId: string
  /** 因果父事件 id 列表（DAG 边；本期最小闭环暂不填，恒 []）。 */
  readonly causedBy: readonly string[]
  /** 事件载荷（随 type 不同，见 events.ts 词汇表）。 */
  readonly payload: CorumDomainEventMap[K]
  /** Unix epoch ms。 */
  readonly at: number
  /** payload schema 版本（演化用）。 */
  readonly version: 1
}

/** fold 推导出的一个「项目 × 角色」调度状态（重启重建 runLoop 的输入）。 */
export interface FoldedProfileState {
  readonly profileId: string
  /** 待处理任务队列（按 assigned 顺序；deferred 回队首、evicted 移除）。 */
  readonly queue: readonly CorumDomainEventMap['corum/task/assigned']['task'][]
  /** 执行中任务（started 未 completed/evicted/blocked）。 */
  readonly current: CorumDomainEventMap['corum/task/assigned']['task'] | undefined
  /** 挂起中任务（blocked 未 unblocked；等依赖解除，不自动恢复；带阻塞源 id）。 */
  readonly blocked: readonly { task: CorumDomainEventMap['corum/task/assigned']['task']; blockedByTaskId: string }[]
}

/** fold 推导出的项目调度状态（事件是唯一事实源，状态是派生物）。 */
export interface FoldedSchedulerState {
  readonly projectId: string
  /** 事件总数（= 下一个 seq）。 */
  readonly eventCount: number
  /** 有队列/当前任务的「项目 × 角色」状态列表。 */
  readonly profiles: readonly FoldedProfileState[]
  /** 项目组成员（fold group/member-* 推导；不含 role，role 以 project.json 为准）。 */
  readonly memberIds: readonly string[]
}

/** 项目的事件日志文件路径（$CORUM_HOME/projects/<id>/scheduler-events.jsonl）。 */
export function schedulerEventLogPath(projectId: string): string {
  return join(projectDir(projectId), 'scheduler-events.jsonl')
}

/**
 * 追加一条事件到项目日志（单行 JSON + \n，同步落盘 = 写后屏障）。
 * @returns 完整事件信封（seq 由日志当前长度推导）。
 */
/** 每项目的下一条 seq 缓存（避免每次 append 全量扫文件；同步写保证一致）。 */
const seqCache = new Map<string, number>()

export function appendSchedulerEvent<K extends CorumDomainEventType>(
  projectId: string,
  type: K,
  payload: CorumDomainEventMap[K],
  causedBy: readonly string[] = [],
): SchedulerEvent<K> {
  const path = schedulerEventLogPath(projectId)
  let seq = seqCache.get(projectId)
  if (seq === undefined) {
    seq = nextSeq(path)
  }
  const event: SchedulerEvent<K> = {
    seq,
    id: `evt-${randomUUID()}`,
    type,
    projectId,
    causedBy: [...causedBy],
    payload,
    at: Date.now(),
    version: 1,
  }
  mkdirSync(projectDir(projectId), { recursive: true })
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
  seqCache.set(projectId, seq + 1)
  return event
}

/** 读取项目事件日志的全部有效事件（崩溃半行截断忽略；seq 空洞/乱序抛错拒载）。 */
export function readSchedulerEvents(projectId: string): SchedulerEvent[] {
  const path = schedulerEventLogPath(projectId)
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n')
  // 尾行不完整（文件不以 \n 结尾）→ 最后一段是崩溃残留，截断忽略。
  const completeLines = raw.endsWith('\n') ? lines.slice(0, -1) : lines.slice(0, -1)
  const events: SchedulerEvent[] = []
  for (const line of completeLines) {
    if (line.trim() === '') continue
    let event: SchedulerEvent
    try {
      event = JSON.parse(line) as SchedulerEvent
    } catch {
      // 解析失败的行视为崩溃残留，截断忽略其后全部（抗半行写入）。
      break
    }
    if (event.seq !== events.length) {
      throw new Error(`event-log: [${projectId}] seq 不连续（期望 ${events.length}，实得 ${event.seq}），拒绝 fold`)
    }
    events.push(event)
  }
  return events
}

/** 从 fromSeq 开始的增量事件（RPC 回放用；fromSeq 之后的全部有效事件）。 */
export function readSchedulerEventsFrom(projectId: string, fromSeq: number): SchedulerEvent[] {
  return readSchedulerEvents(projectId).filter(e => e.seq >= fromSeq)
}

/**
 * fold 项目事件日志 → 当前调度状态（重启恢复用，设计 §7，逐事件幂等应用）。
 * 规则：
 *   assigned  → 入对应角色队尾；当前无任务则不进 current（等 started）
 *   started   → 该角色 current = 该任务（并从队列移除）
 *   completed → current 清除；反查 blockedOn 索引 → 被它阻塞的任务推导唤醒回队列（§7 方案 A）
 *   deferred  → current 清除，任务回队首
 *   evicted   → 从队列/current/blocked 移除
 *   blocked   → current 清除，任务入挂起集，登记 blockedOn[blockerTaskId]
 *   unblocked → 挂起集移除，任务回对应角色队尾
 *   member-added/removed → memberIds 增减（成员边界投影）
 */
export function foldSchedulerEvents(projectId: string): FoldedSchedulerState {
  const events = readSchedulerEvents(projectId)
  type TaskRefT = CorumDomainEventMap['corum/task/assigned']['task']
  const queues = new Map<string, TaskRefT[]>()
  const currents = new Map<string, TaskRefT>()
  const blockedSet = new Map<string, { task: TaskRefT; blockedByTaskId: string }>() // taskId → 挂起任务
  const blockedOn = new Map<string, TaskRefT[]>() // blockerTaskId → 被它阻塞的任务
  const members = new Set<string>()
  const queueOf = (profileId: string): TaskRefT[] => {
    let q = queues.get(profileId)
    if (q === undefined) { q = []; queues.set(profileId, q) }
    return q
  }
  const removeTask = (taskId: string): void => {
    for (const q of queues.values()) {
      const i = q.findIndex(t => t.id === taskId)
      if (i >= 0) q.splice(i, 1)
    }
    for (const [pid, cur] of currents) {
      if (cur.id === taskId) currents.delete(pid)
    }
    blockedSet.delete(taskId)
    blockedOn.delete(taskId)
  }
  /** 从 blockedOn 反查索引移除某挂起任务（显式 unblocked 事件路径）。 */
  const removeFromBlockedOn = (taskId: string): void => {
    for (const [blocker, list] of blockedOn) {
      const i = list.findIndex(t => t.id === taskId)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) blockedOn.delete(blocker)
    }
  }
  /** 推导唤醒（§7 方案 A）：某任务完成 → 被它阻塞的任务回队尾（C 无需知道 B）。 */
  const deriveUnblocks = (completedTaskId: string): void => {
    const woken = blockedOn.get(completedTaskId)
    if (woken === undefined) return
    blockedOn.delete(completedTaskId)
    for (const t of woken) {
      blockedSet.delete(t.id)
      queueOf(t.profileId).push(t)
    }
  }
  for (const e of events) {
    switch (e.type) {
      case 'corum/task/assigned': {
        const p = e.payload as CorumDomainEventMap['corum/task/assigned']
        queueOf(p.task.profileId).push(p.task)
        break
      }
      case 'corum/task/started': {
        const p = e.payload as CorumDomainEventMap['corum/task/started']
        removeTask(p.task.id)
        currents.set(p.task.profileId, p.task)
        break
      }
      case 'corum/task/completed': {
        const p = e.payload as CorumDomainEventMap['corum/task/completed']
        removeTask(p.task.id)
        deriveUnblocks(p.task.id)
        break
      }
      case 'corum/task/blocked': {
        const p = e.payload as CorumDomainEventMap['corum/task/blocked']
        for (const [pid, cur] of currents) {
          if (cur.id === p.task.id) currents.delete(pid)
        }
        for (const q of queues.values()) {
          const i = q.findIndex(t => t.id === p.task.id)
          if (i >= 0) q.splice(i, 1)
        }
        blockedSet.set(p.task.id, { task: p.task, blockedByTaskId: p.blockedByTaskId })
        const list = blockedOn.get(p.blockedByTaskId) ?? []
        list.push(p.task)
        blockedOn.set(p.blockedByTaskId, list)
        break
      }
      case 'corum/task/cancelled': {
        const p = e.payload as CorumDomainEventMap['corum/task/cancelled']
        if (p.fate === 'requeue') {
          // current 清除 + 任务回队首（重派语义）。
          for (const [pid, cur] of currents) {
            if (cur.id === p.task.id) currents.delete(pid)
          }
          if (!queues.get(p.task.profileId)?.some(t => t.id === p.task.id)) {
            queueOf(p.task.profileId).unshift(p.task)
          }
        } else {
          // evicted / reassigned：任务移除（reassigned 的新 assigned 另行入队）。
          removeTask(p.task.id)
        }
        break
      }
      case 'corum/task/unblocked': {
        const p = e.payload as CorumDomainEventMap['corum/task/unblocked']
        // 幂等：若 fold 已在 completed 时推导唤醒过（显式事件是审计记录），跳过。
        if (blockedSet.has(p.task.id)) {
          blockedSet.delete(p.task.id)
          removeFromBlockedOn(p.task.id)
          queueOf(p.task.profileId).push(p.task)
        }
        break
      }
      case 'corum/task/deferred': {
        const p = e.payload as CorumDomainEventMap['corum/task/deferred']
        removeTask(p.task.id)
        queueOf(p.task.profileId).unshift(p.task)
        break
      }
      case 'corum/task/evicted': {
        const p = e.payload as CorumDomainEventMap['corum/task/evicted']
        removeTask(p.task.id)
        break
      }
      case 'corum/group/member-added': {
        const p = e.payload as CorumDomainEventMap['corum/group/member-added']
        members.add(p.member.profileId)
        break
      }
      case 'corum/group/member-removed': {
        const p = e.payload as CorumDomainEventMap['corum/group/member-removed']
        members.delete(p.profileId)
        break
      }
      default:
        // 不认识的 type 跳过（词汇演化规则：自己读写，宽容跳过）。
        break
    }
  }
  const profiles: FoldedProfileState[] = []
  const profileIds = new Set<string>([...queues.keys(), ...currents.keys()])
  for (const b of blockedSet.values()) profileIds.add(b.task.profileId)
  for (const profileId of profileIds) {
    const queue = queues.get(profileId) ?? []
    const current = currents.get(profileId)
    const blocked = [...blockedSet.values()].filter(b => b.task.profileId === profileId)
    if (queue.length > 0 || current !== undefined || blocked.length > 0) {
      profiles.push({ profileId, queue, current, blocked })
    }
  }
  return { projectId, eventCount: events.length, profiles, memberIds: [...members] }
}

/** 日志当前下一条 seq（= 有效事件数；崩溃半行不计）。 */
function nextSeq(path: string): number {
  if (!existsSync(path)) return 0
  const raw = readFileSync(path, 'utf8')
  if (raw === '') return 0
  const lines = raw.endsWith('\n') ? raw.split('\n').slice(0, -1) : raw.split('\n').slice(0, -1)
  let count = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      JSON.parse(line)
      count += 1
    } catch {
      break
    }
  }
  return count
}
