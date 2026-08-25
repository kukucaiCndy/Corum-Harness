/**
 * AgentRuntime —— corum-agent-dev 的「任务 List + 可阻塞循环」调度层。
 *
 * 在官方 ReactLoopAgent 之外叠加的一层（全局协调器形态）：
 *   - 每个「项目 × 角色」一个任务队列（Task List），FIFO；
 *   - 每个「项目 × 角色」一条常驻可阻塞循环：队列空则阻塞等任务，取到任务则
 *     按任务的 type 路由到对应泳道会话 followup 派活，并阻塞等 complete_task，
 *     完成再取下一个；
 *   - 任务完成判定：Agent 显式调用 complete_task 工具（在泳道会话 setup 里注入）。
 *
 * 【目标模型：一个 Agent 管理多个 session】
 * 注意：我们的目标模型是「一个角色 Agent（按 profile 设定）管理多个 type 会话、
 * 同一时刻只在一个会话工作」——**不是**官方「Agent 绑定一个 session」。官方
 * Agent:Session=1:1 硬绑定暂未支持该模型，当前用「按 (project, profile, type)
 * 多个 rootAgent 实例」模拟（见 createAgentForType）。因此本调度层按目标模型
 * 设计：队列以「项目 × 角色」为维度（一个角色一条串行队列，不在泳道间并行），
 * type 只是任务的属性，决定该任务路由进哪个泳道会话。待官方支持会话切换后，
 * 仅 createAgentForType 内部从「多实例」换成「单实例切会话」，本层不变。
 *
 * 复用 CorumAgentService 创建绑定 persona/工具/skill/MCP 的泳道会话，
 * 只额外注入一个 complete_task 工具形成「任务完成」闭环。
 * @module @corum/corum-agent-dev/runtime
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { simplifyEventData } from './agent-service.ts'
import type { CorumAgentService } from './agent-service.ts'
import { GENERAL_WORK_TYPE, isGroupMember } from './project.ts'
import { loadProject } from './project-store.ts'
import { publishDomainEvent } from './events.ts'
import type { CorumDomainEventMap, CorumDomainEventType, TaskRef } from './events.ts'
import { foldSchedulerEvents, readSchedulerEventsFrom } from './event-log.ts'
import type { SchedulerEvent } from './event-log.ts'
import { listProjects } from './project-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum 任务调度运行时（任务队列 + 可阻塞循环）。 */
    corumRuntime: AgentRuntime
  }
}

/** 单条会话事件的 UI 投影（JSON-safe）。 */
export interface RuntimeEventDto {
  seq: number
  type: string
  data: unknown
  time: number
}

/** 任务状态（领域级）。 */
export type TaskStatus = 'pending' | 'running' | 'done'

/** 一条领域级任务（轻量：引用 + 摘要 + 增量；全文在共享实体，后续接 ctx.project）。 */
export interface Task {
  readonly id: string
  /** 所属项目 id（团队属项目，调度隔离边界）。 */
  readonly projectId: string
  /** 目标角色 = AgentProfile id。 */
  readonly profileId: string
  /** 工作类型 slug：决定该任务路由进哪个泳道会话（缺省 general）。 */
  readonly type: string
  /** 任务摘要（提交方生成）。 */
  readonly summary: string
  /** 增量 context（提交方组装，可选）。 */
  readonly transferNote?: string
  /** 派发者（派活的角色 / 'user' / 'runtime'），用于领域事件台账。 */
  readonly actor?: string
  /** 挂起时的阻塞源任务 id（report_blocked 回填；唤醒后清除）。 */
  blockedByTaskId?: string
  status: TaskStatus
}

/**
 * 一条泳道的运行时状态（泳道 = 「项目 × 角色 × 工作类型」的专属会话）。
 * 路由语义：任务按其 type 路由到同 type 泳道会话，保证模型注意力始终聚焦
 * 一类事物（UI 归 UI 泳道、debug 归 debug 泳道）。session 按 type 隔离、
 * 持久化可 resume（agent-service 的 sessions.json 索引），本结构是其在
 * 调度层的显式投影（未来「标签 = 需求 + 类型」语义化路由落地时，只需把
 * laneKey 从 type 换成标签，本池机制不变）。
 */
interface LaneState {
  /** 泳道键 = 工作类型 slug（当前语义；未来升级为「需求ID + 类型」标签）。 */
  readonly type: string
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
interface ProfileRuntime {
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

/**
 * corum 任务调度运行时（全局协调器）。
 *
 * 单例，持有所有「项目 × 角色」的任务队列。调度 authority 来自
 * 直接持有的 `Agent` 句柄（`agent.followup` 无 authority 限制，见
 * docs/agent-foundation/AGENT-RUNTIME-CONTEXT-DESIGN.md §2.3）。
 * 队列键 = `${projectId}${profileId}`（目标模型：一个角色一条串行队列）。
 */
/** 卡住判定阈值：执行中任务超过此时长无泳道会话活动 → stalled（3 分钟经验起点）。 */
const STALL_THRESHOLD_MS = 3 * 60 * 1000
/** 卡住扫描周期。 */
const STALL_SCAN_INTERVAL_MS = 60 * 1000

export class AgentRuntime extends TypertRemoteService {
  static inject = ['agents', 'sessions']

  private readonly profiles = new Map<string, ProfileRuntime>()

  /** 卡住扫描定时器。 */
  private stallTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    ctx: Context,
    /** 复用的 Agent 实例工厂（AgentProfile → 泳道会话）。 */
    private readonly corumAgent: CorumAgentService,
  ) {
    super(ctx, 'corumRuntime')
    // 调度边界收缩：成员被移出项目组 → 回收其「项目 × 角色」运行时
    //（滞留任务逐条逐出、常驻循环退出；运行中任务不打断，闭环后自然退出）。
    ctx.on('corum/group/member-removed', ({ projectId, profileId }) => {
      this.onMemberRemoved(projectId, profileId)
    })
    // 调度工具统一装配：所有「项目×角色×类型」会话（含用户直聊 PM 的会话）
    // 都装三件套（assign_task/list_team_tasks/complete_task）——PM 统筹会话
    // 与执行会话能力一致，「用户 → PM → assign_task → 成员」闭环才成立。
    corumAgent.registerLaneSetupHook((agentCtx, projectId, profileId) => {
      this.installSchedulerTools(agentCtx, this.runtime(projectId, profileId))
    })
    // 卡住感知：周期扫描执行中任务的泳道会话最后活动时间，超阈值发 stalled。
    this.stallTimer = setInterval(() => { this.scanStalledTasks() }, STALL_SCAN_INTERVAL_MS)
    ctx.effect(() => () => {
      if (this.stallTimer !== undefined) clearInterval(this.stallTimer)
    })
    // 重启恢复（TEAM-SCHEDULER-EVENT-LOG §7）：loader 就绪后 fold 各项目事件日志，
    // 重建「项目 × 角色」队列并重启常驻循环——事件是唯一事实源，状态是派生物。
    void (async () => {
      try {
        await ctx.get('loader')?.await()
      } catch {
        // 无 loader 兄弟（纯 host 组合）时直接恢复。
      }
      this.recoverAll()
    })()
  }

  /**
   * 启动时 fold 全部项目的调度事件日志，恢复调度状态并重启循环。
   * 恢复规则：pending 任务回队列；running 未 completed 的任务（host 重启时其
   * 泳道 Agent 已随进程消亡）回队首重派——泳道会话日志在官方层 resume，
   * Agent 会重新收到该任务的 followup（dev 期可接受的重复，后续接幂等键）。
   * 成员边界：已不在项目组的 profile 不恢复（其滞留事件留在日志里，等
   * member-removed 的 evicted 或后续清理，不静默调度非成员）。
   */
  private recoverAll(): void {
    for (const project of listProjects()) {
      let state
      try {
        state = foldSchedulerEvents(project.id)
      } catch (error) {
        this.ctx.logger.error(`corumRuntime: [${project.id}] fold 事件日志失败，跳过恢复：${String(error)}`)
        continue
      }
      if (state.eventCount === 0) continue
      let restored = 0
      for (const ps of state.profiles) {
        if (!isGroupMember(project, ps.profileId)) continue
        const rt = this.runtime(project.id, ps.profileId)
        // TaskRef → Task：恢复的任务回到 pending（actor 缺省 'user'，事件台账以日志为准）。
        const revive = (ref: TaskRef): Task => ({ ...ref, status: 'pending' })
        if (ps.current !== undefined) rt.queue.unshift(revive(ps.current))
        rt.queue.push(...ps.queue.map(revive))
        // 挂起任务恢复进 suspended（等依赖解除，不自动调度；blockedBy 索引从事件重建）。
        for (const b of ps.blocked) {
          const t = revive(b.task)
          t.blockedByTaskId = b.blockedByTaskId
          rt.suspended.set(t.id, t)
        }
        if (rt.queue.length > 0) {
          this.startLoop(rt)
          restored += rt.queue.length
        }
      }
      this.ctx.logger.info(`corumRuntime: [${project.id}] fold 恢复 ${state.eventCount} 条事件 → ${restored} 条待派任务`)
    }
  }

  /** 泳道会话最后活动时间（无事件/无会话取当前任务派发时间）。 */
  private lastActivityAt(rt: ProfileRuntime): number {
    const events = rt.agent?.session.events
    const last = events !== undefined && events.length > 0 ? events[events.length - 1].time : undefined
    return last ?? rt.currentStartedAt ?? Date.now()
  }

  /** 卡住扫描：执行中任务超阈值无活动 → 发 stalled（每任务报一次，活动恢复后可再报）。 */
  private scanStalledTasks(): void {
    const now = Date.now()
    for (const rt of this.profiles.values()) {
      if (rt.current === undefined || rt.disposed) continue
      const idleMs = now - this.lastActivityAt(rt)
      if (idleMs < STALL_THRESHOLD_MS) {
        rt.stallReported = false // 活动健康，复位可再报
        continue
      }
      if (rt.stallReported) continue
      rt.stallReported = true
      this.record('corum/task/stalled', { task: taskRef(rt.current), idleSec: Math.round(idleMs / 1000) })
      this.ctx.logger.info(`corumRuntime: [${rt.projectId}/${rt.profileId}] task stalled "${rt.current.id}" — ${Math.round(idleMs / 1000)}s 无活动`)
    }
  }

  /**
   * steer：对执行中任务插入引导（下一步边界生效，不打断）。
   * @returns 是否送达（任务不在执行中返回 false）。
   */
  steerTask(projectId: string, profileId: string, note: string, by: string): boolean {
    const rt = this.profiles.get(AgentRuntime.queueKey(projectId, profileId))
    const task = rt?.current
    if (rt === undefined || task === undefined || rt.agent === undefined) return false
    rt.agent.steer(createUserMessage({
      content: [{ type: 'text', text: `【调度引导】${note}` }],
      source: { kind: 'plugin', plugin: '@corum/corum-agent-dev' },
    }))
    this.record('corum/task/steered', { task: taskRef(task), note, by })
    this.ctx.logger.info(`corumRuntime: [${projectId}/${profileId}] steer "${task.id}" by ${by} — ${note}`)
    return true
  }

  /**
   * cancel：中止执行中/挂起任务。
   *   - 执行中：agent.cancel 中止 turn，按 fate 处置（requeue 回队首 / evicted 废弃）并唤醒循环；
   *   - 挂起中：无需中止 turn，直接从 suspended 移除按 fate 处置。
   * @returns 是否找到目标任务。
   */
  cancelTask(projectId: string, profileId: string, reason: string, by: string, fate: 'requeue' | 'evicted' | 'reassigned' = 'requeue'): boolean {
    const rt = this.profiles.get(AgentRuntime.queueKey(projectId, profileId))
    if (rt === undefined) return false

    // 挂起任务路径：无 turn 可中止，直接处置。
    const suspended = [...rt.suspended.values()]
    if (rt.current === undefined && suspended.length > 0) {
      for (const task of suspended) {
        rt.suspended.delete(task.id)
        if (fate === 'requeue') rt.queue.unshift(task)
        this.record('corum/task/cancelled', { task: taskRef(task), reason, fate, by })
      }
      rt.wakeTask?.()
      rt.wakeTask = undefined
      this.startLoop(rt)
      return true
    }

    const task = rt.current
    if (task === undefined) return false
    rt.agent?.cancel({ kind: 'user' })
    rt.current = undefined
    rt.currentFromSeq = undefined
    rt.currentStartedAt = undefined
    const lane = rt.lanes.get(task.type)
    if (lane !== undefined) {
      lane.status = 'idle'
      lane.currentTaskId = undefined
      lane.lastUsedAt = Date.now()
    }
    task.status = 'pending'
    if (fate === 'requeue') rt.queue.unshift(task)
    this.record('corum/task/cancelled', { task: taskRef(task), reason, fate, by })
    this.ctx.logger.info(`corumRuntime: [${projectId}/${profileId}] cancel "${task.id}" fate=${fate} by ${by} — ${reason}`)
    // cancel 不打 complete_task——runLoop 仍阻塞在 wakeDone，必须显式唤醒。
    rt.wakeDone?.()
    rt.wakeDone = undefined
    return true
  }

  /**
   * reassign：中止当前任务并改派另一成员（= cancel(fate='reassigned') + enqueue，
   * 新 assigned 的 causedBy 回指 cancelled 事件）。
   */
  reassignTask(projectId: string, profileId: string, targetProfileId: string, note: string, by: string): boolean {
    const rt = this.profiles.get(AgentRuntime.queueKey(projectId, profileId))
    const task = rt?.current
    if (rt === undefined || task === undefined) return false
    const summary = task.summary
    const type = task.type
    const transfer = `【改派】原执行者 ${profileId} 被中止。${note}${task.transferNote !== undefined && task.transferNote !== '' ? `\n【原上下文】${task.transferNote}` : ''}`
    const cancelledEvt = (() => {
      this.cancelTask(projectId, profileId, note, by, 'reassigned')
      // cancelTask 内 record 的返回值拿不到的折中：重新读最后一条事件 id 太重，
      // 这里直接返回最近一次 record 的 id——改造 record 保存 lastEventId。
      return this.lastEventId
    })()
    this.enqueue(projectId, targetProfileId, type, summary, transfer, by, cancelledEvt !== '' ? [cancelledEvt] : [])
    this.ctx.logger.info(`corumRuntime: [${projectId}] reassign "${task.id}" ${profileId} → ${targetProfileId} by ${by}`)
    return true
  }

  /** 最近一次 record 落盘的事件 id（reassign 挂因果边用）。 */
  private lastEventId = ''

  /**
   * 成员被移出项目组的回收：清空滞留队列（逐条记 corum/task/evicted）+
   * 置 disposed 唤醒循环退出。运行中任务不强行打断（cancel 会留下半截 turn），
   * 其 complete_task 闭环后循环自然退出；此后非成员不再接活。
   */
  private onMemberRemoved(projectId: string, profileId: string): void {
    const key = AgentRuntime.queueKey(projectId, profileId)
    const rt = this.profiles.get(key)
    if (rt === undefined) return
    rt.disposed = true
    const evicted = rt.queue.splice(0)
    for (const task of rt.suspended.values()) evicted.push(task)
    rt.suspended.clear()
    for (const task of evicted) {
      this.record('corum/task/evicted', {
        task: taskRef(task),
        reason: `成员 "${profileId}" 已移出项目 "${projectId}" 项目组`,
      })
    }
    rt.lanes.clear() // 泳道调度投影随成员边界回收（session 本体在官方层持久化，再加入时可 resume）
    this.ctx.logger.info(`corumRuntime: [${projectId}/${profileId}] member removed — runtime disposed（逐出 ${evicted.length} 条滞留任务）`)
    rt.wakeTask?.()
    rt.wakeTask = undefined
  }

  /** 队列键：项目 × 角色（一个角色一条串行队列，泳道只是会话隔离）。 */
  private static queueKey(projectId: string, profileId: string): string {
    return `${projectId}${profileId}`
  }

  /**
   * 发布一条领域事件（事实只在真实发生点记一次，两通道同源）：
   *   1. 项目级持久日志（scheduler-events.jsonl，唯一事实源，重启 fold 恢复）；
   *   2. cordis 总线（实时订阅；监控 hook 接入点 1，UI/调度器经 ctx.on 接收）。
   */
  private record<K extends CorumDomainEventType>(
    type: K,
    data: CorumDomainEventMap[K],
    causedBy: readonly string[] = [],
  ): { id: string } {
    const { id } = publishDomainEvent(this.ctx, type, data, causedBy)
    this.lastEventId = id
    return { id }
  }

  /** 预分配一个任务 id（阻塞派生场景：blocked 事件需先引用派生任务，assigned 再回指 blocked）。 */
  private static preTaskId(): string {
    return `task-${randomUUID()}`
  }

  /** 取（或懒建）该「项目 × 角色」在指定工作类型上的泳道状态。 */
  private laneFor(rt: ProfileRuntime, type: string): LaneState {
    let lane = rt.lanes.get(type)
    if (lane === undefined) {
      lane = { type, sessionId: undefined, status: 'idle', currentTaskId: undefined, lastUsedAt: 0 }
      rt.lanes.set(type, lane)
    }
    return lane
  }

  /** 取（或懒建）一个「项目 × 角色」的运行时状态。 */
  private runtime(projectId: string, profileId: string): ProfileRuntime {
    const key = AgentRuntime.queueKey(projectId, profileId)
    let rt = this.profiles.get(key)
    if (rt === undefined) {
      rt = {
        projectId,
        profileId,
        agent: undefined,
        lanes: new Map(),
        suspended: new Map(),
        queue: [],
        current: undefined,
        currentFromSeq: undefined,
        currentStartedAt: undefined,
        stallReported: false,
        wakeTask: undefined,
        wakeDone: undefined,
        started: false,
        disposed: false,
        loopActive: false,
      }
      this.profiles.set(key, rt)
    }
    return rt
  }

  /**
   * 入队一个任务到目标「项目 × 角色」，并唤醒其阻塞循环。
   * @param projectId - 所属项目 id。
   * @param profileId - 目标角色（AgentProfile id）。
   * @param type - 工作类型 slug（路由进哪个泳道会话，缺省 general）。
   * @param summary - 任务摘要。
   * @param transferNote - 增量 context（可选）。
   * @returns 入队的任务。
   */
  enqueue(projectId: string, profileId: string, type: string, summary: string, transferNote?: string, actor: string = 'user', causedBy: readonly string[] = [], fixedTaskId?: string): Task {
    // 成员边界：只能把任务派给项目组成员（非成员不参与该项目工作）。
    const project = loadProject(projectId)
    if (project === undefined) throw new Error(`corumRuntime: project "${projectId}" not found`)
    if (!isGroupMember(project, profileId)) {
      throw new Error(`corumRuntime: profile "${profileId}" 不是项目 "${projectId}" 的项目组成员，不能把任务派给它`)
    }
    // 成员再加入：若旧实例因被移除而 disposed（其循环等运行中任务闭环后才退出），
    // 丢弃旧实例换新——旧循环由 installSchedulerTools 闭包捕获的 rt 完成闭环后自行退出。
    const existing = this.profiles.get(AgentRuntime.queueKey(projectId, profileId))
    if (existing?.disposed) {
      this.profiles.delete(AgentRuntime.queueKey(projectId, profileId))
    }
    const rt = this.runtime(projectId, profileId)
    const task: Task = {
      id: fixedTaskId ?? `task-${randomUUID()}`,
      projectId,
      profileId,
      type: type === '' ? GENERAL_WORK_TYPE : type,
      summary,
      actor,
      ...(transferNote !== undefined && transferNote !== '' ? { transferNote } : {}),
      status: 'pending',
    }
    rt.queue.push(task)
    this.ctx.logger.info(`corumRuntime: [${projectId}/${profileId}/${task.type}] enqueue "${task.id}" — ${summary}`)
    this.record('corum/task/assigned', { task: taskRef(task), actor, queueLength: rt.queue.length }, causedBy)
    rt.wakeTask?.()
    rt.wakeTask = undefined
    this.startLoop(rt)
    return task
  }

  /**
   * 启动该「项目 × 角色」的常驻循环（幂等防重入）。
   * 双 runLoop 共享 rt 会互相覆盖 wakeTask/wakeDone 挂起点（先阻塞的循环
   * 永远丢失唤醒），因此 loopActive 是执行事实级互斥，重复调用直接忽略。
   */
  private startLoop(rt: ProfileRuntime): void {
    rt.started = true
    if (rt.loopActive) return
    rt.loopActive = true
    void this.runLoop(rt.projectId, rt.profileId).finally(() => {
      rt.loopActive = false
    })
  }

  /**
   * 一个「项目 × 角色」的常驻可阻塞循环：
   *   队列空 → 阻塞等新任务；取到任务 → 按任务 type 路由到泳道会话派活 →
   *   阻塞等 complete_task → 下一个（一个角色串行，不在泳道间并行）。
   */
  private async runLoop(projectId: string, profileId: string): Promise<void> {
    const rt = this.runtime(projectId, profileId)
    const key = AgentRuntime.queueKey(projectId, profileId)
    for (;;) {
      if (rt.disposed) {
        // 成员已移出项目组：回收运行时（map 仍指向自己才清理，不再接活）。
        rt.started = false
        if (this.profiles.get(key) === rt) this.profiles.delete(key)
        return
      }
      const task = rt.queue.shift()
      if (task === undefined) {
        // 队列空：阻塞，直到 enqueue 唤醒。
        await new Promise<void>(resolve => { rt.wakeTask = resolve })
        continue
      }

      rt.current = task
      task.status = 'running'

      // 派发前重做成员校验（防入队后被移出的竞态；onMemberRemoved 已置 disposed 时此处兜底）。
      const project = loadProject(projectId)
      if (rt.disposed || project === undefined || !isGroupMember(project, profileId)) {
        this.record('corum/task/evicted', {
          task: taskRef(task),
          reason: `成员 "${profileId}" 已不在项目 "${projectId}" 项目组`,
        })
        rt.current = undefined
        task.status = 'pending'
        continue
      }

      const ensured = await this.ensureAgent(rt, task)
      if ('error' in ensured) {
        // 创建失败：放回队首，稍后重试。
        rt.queue.unshift(task)
        task.status = 'pending'
        rt.current = undefined
        this.record('corum/task/deferred', { task: taskRef(task), reason: ensured.error })
        await new Promise<void>(resolve => setTimeout(resolve, 1000))
        continue
      }

      // 占用区间的下钻起点：followup 前的会话 seq（成果区间 = [fromSeq, completed 时的 seq]）。
      const fromSeq = ensured.agent.session.seq
      rt.currentFromSeq = fromSeq
      rt.currentStartedAt = Date.now()
      rt.stallReported = false
      // 泳道占用：该 type 泳道开始承载当前任务。
      const lane = this.laneFor(rt, task.type)
      lane.status = 'busy'
      lane.currentTaskId = task.id
      lane.lastUsedAt = Date.now()
      ensured.agent.followup(renderTaskMessage(task))
      // followup 已发出 = 任务开始（事实发生点，只记一次；持久台账归数据层）。
      this.record('corum/task/started', { task: taskRef(task), sessionId: String(ensured.agent.session.id), fromSeq })
      // 阻塞：等该任务 complete_task。
      await new Promise<void>(resolve => { rt.wakeDone = resolve })

      task.status = 'done'
      rt.current = undefined
      rt.currentFromSeq = undefined
      rt.currentStartedAt = undefined
      // 泳道释放：任务闭环，泳道回到 idle 可接活。
      const doneLane = rt.lanes.get(task.type)
      if (doneLane !== undefined) {
        doneLane.status = 'idle'
        doneLane.currentTaskId = undefined
        doneLane.lastUsedAt = Date.now()
      }
      this.ctx.logger.info(`corumRuntime: [${projectId}/${profileId}/${task.type}] task done "${task.id}"`)
    }
  }

  /**
   * 确保当前任务的泳道会话 Agent 已创建（按任务的 type 路由）。
   * 目标模型是一个角色管理多泳道会话；当前用 createAgentForType 的多实例模拟，
   * 故按 (projectId, profileId, task.type) 取/建对应泳道会话，并注入调度工具。
   */
  private async ensureAgent(rt: ProfileRuntime, task: Task): Promise<{ agent: Agent } | { error: string }> {
    try {
      // 调度工具已由 laneSetupHook 统一装配（见构造器），无需 extraSetup。
      const { agent, sessionId } = await this.corumAgent.createAgentForType(
        rt.projectId,
        rt.profileId,
        task.type,
      )
      rt.agent = agent
      // 泳道池登记：路由命中事实（session 建立/恢复后登记，busy 在派发时标记）。
      const lane = this.laneFor(rt, task.type)
      lane.sessionId = String(sessionId)
      return { agent }
    } catch (error) {
      this.ctx.logger.error(`corumRuntime: [${rt.projectId}/${rt.profileId}/${task.type}] agent creation failed: ${String(error)}`)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 在「项目×角色×类型」会话 Agent 的 setup 里注册调度工具（agent-scoped，
   * 经 CorumAgentService.registerLaneSetupHook 对所有泳道/统筹会话统一装配）。
   *
   * 三个工具让 Agent 真正「感知并被驱动于」调度器（半自主：工具是显式入口，
   * 调度器仍是权威，路由走固定代码逻辑非 LLM 实时判断）：
   *   - complete_task：上报当前任务完成（执行侧返回通道）。
   *   - assign_task：往「项目 × 角色 × 泳道」入队一个任务（调度侧派活通道——
   *     转达指令 / 转交 / 派生解除阻塞任务），全角色可用（感知是派送的前提）。
   *   - list_team_tasks：查本项止各成员的任务队列 + 当前任务 + 忙闲（成员感知）。
   * 闭包捕获 (projectId, profileId)——队列维度，与泳道无关（一个角色一条队列）。
   */
  private installSchedulerTools(agentCtx: Context, rt: ProfileRuntime): void {
    const { projectId, profileId } = rt
    agentCtx.tools.register(defineTool({
      name: 'complete_task',
      description: [
        '上报当前任务已完成。调用前必须逐项核对验收标准，确认达标后才可调用；',
        '未达标时继续工作，不要调用。',
      ].join(''),
      parameters: {
        summary: { type: 'string', required: true, description: '完成说明：做了什么、结果如何、验收项核对结论' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args: { summary: string }) => {
        this.onTaskDone(rt, args.summary)
        return `任务已上报完成：${args.summary}`
      },
    }))

    // report_blocked：阻塞即停（§3.14 单阻塞链）。Agent 遇阻塞立即停止，说明缺什么、
    // 派生一个「解除阻塞」任务给能解决的成员；本任务挂起，等对方完成被反查唤醒。
    agentCtx.tools.register(defineTool({
      name: 'report_blocked',
      description: [
        '当前任务遇阻塞（缺前置信息/依赖）时调用：立即停止本任务，派生一个「解除阻塞」任务给能解决的成员。',
        '阻塞即停止——不要自行补全/想象缺失条件继续往下做（会衍生不存在的错误任务）。',
        '对方完成解除阻塞任务后，调度器会自动把你唤醒继续本任务（你无需知道唤醒细节）。',
      ].join(''),
      parameters: {
        reason: { type: 'string', required: true, description: '阻塞原因：缺什么前置信息、为什么无法继续' },
        unblockProfileId: { type: 'string', required: true, description: '能解决该阻塞的项目组成员 profileId（先 list_team_tasks 感知）' },
        unblockSummary: { type: 'string', required: true, description: '派生给对方的解除阻塞任务摘要（要对方做什么/提供什么）' },
        unblockType: { type: 'string', description: '对方任务的泳道（缺省 general）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args: { reason: string; unblockProfileId: string; unblockSummary: string; unblockType?: string }) => {
        return this.onTaskBlocked(rt, args)
      },
    }))

    // assign_task：调度侧派活通道。调用即往目标「项目×角色×泳道」入队任务，
    // 调度器按固定路由（type 决定进目标成员的哪个泳道会话）唤起目标成员干活。
    agentCtx.tools.register(defineTool({
      name: 'assign_task',
      description: [
        '把一个新任务派给团队里的某个成员（转达指令 / 转交 / 派生解除阻塞任务）。',
        '该任务会进入目标成员的任务队列，由调度器唤起该成员处理。',
        '你必须先用 list_team_tasks 感知团队，确认把任务派给哪个角色、进它的哪个工作类型泳道。',
      ].join(''),
      parameters: {
        profileId: { type: 'string', required: true, description: '目标成员的 profile id（派给谁）' },
        type: { type: 'string', required: true, description: '工作类型泳道 slug（进目标成员的哪个会话，如 general/ui/debug 或项目自定义泳道）' },
        summary: { type: 'string', required: true, description: '任务摘要：要做什么、目标是什么' },
        transferNote: { type: 'string', description: '增量上下文（可选）：你的推理结论 / 转交说明 / 关联状态，帮助接收方理解任务来龙去脉' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args: { profileId: string; type: string; summary: string; transferNote?: string }) => {
        const task = this.enqueue(
          projectId,
          args.profileId,
          args.type,
          args.summary,
          args.transferNote,
          profileId, // actor = 派活的角色（调度域事实：谁派的）
        )
        this.ctx.logger.info(`corumRuntime: [${projectId}] ${profileId} assign_task → ${args.profileId}/${args.type} "${task.id}"`)
        return `任务已派给 ${args.profileId}（泳道 ${args.type}），任务 id：${task.id}。对方处理完成后会经调度器闭环。`
      },
    }))

    // PM 专属协调工具（卡住干预三级：steer/cancel/reassign）——普通成员不装配。
    const projectForRole = loadProject(projectId)
    const memberRole = projectForRole?.group?.members.find(m => m.profileId === profileId)?.role
    if (memberRole === 'pm') {
      this.installCoordinatorTools(agentCtx, projectId)
    }

    // list_team_tasks：成员感知。列出项目组各成员的任务队列 + 当前任务 + 忙闲
    //（含尚无任务记录的成员——感知项目组有哪些人是派活的前提）。
    agentCtx.tools.register(defineTool({
      name: 'list_team_tasks',
      description: [
        '查看本项目组各成员当前的任务队列与正在执行的任务（含每个任务所在泳道），以及谁在忙、谁空闲。',
        '用于感知团队状态：项目组有哪些成员、谁能接活，从而决定把新任务派给谁、进哪个泳道。',
      ].join(''),
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async () => {
        const project = loadProject(projectId)
        const members = project?.group?.members ?? []
        if (members.length === 0) return `项目 ${projectId} 的项目组暂无成员。`
        const lines: string[] = []
        for (const member of members) {
          const rt = this.profiles.get(AgentRuntime.queueKey(projectId, member.profileId))
          const roleTag = member.role === 'pm' ? '（PM）' : ''
          let current = '空闲'
          if (rt?.current !== undefined && rt !== undefined) {
            const runSec = rt.currentStartedAt !== undefined ? Math.round((Date.now() - rt.currentStartedAt) / 1000) : 0
            const idleSec = Math.round((Date.now() - this.lastActivityAt(rt)) / 1000)
            const stallMark = idleSec > STALL_THRESHOLD_MS / 1000 ? ' ⚠疑似卡住' : ''
            current = `执行中「${rt.current.summary}」（泳道 ${rt.current.type} · 已执行 ${Math.floor(runSec / 60)}分${runSec % 60}秒 · 最后活动 ${idleSec}秒前${stallMark}）`
          }
          const queued = rt !== undefined && rt.queue.length > 0
            ? `，队列 ${rt.queue.length} 个：${rt.queue.map(t => `「${t.summary}」(${t.type})`).join('、')}`
            : ''
          const suspended = rt !== undefined && rt.suspended.size > 0
            ? `，挂起 ${rt.suspended.size} 个：${[...rt.suspended.values()].map(t => `「${t.summary}」`).join('、')}（等依赖解除）`
            : ''
          lines.push(`- ${member.profileId}${roleTag}：${current}${queued}${suspended}`)
        }
        return `项目 ${projectId} 项目组成员状态：\n${lines.join('\n')}`
      },
    }))
  }

  /**
   * report_blocked 回调（§3.14 阻塞即停 + 单阻塞链）：
   *   1. 当前任务挂起（入 suspended，泳道释放回 idle），发 corum/task/blocked；
   *   2. 派生「解除阻塞」任务给目标成员（enqueue，causedBy 挂因果边 → blocked 事件）；
   *   3. 唤醒本循环取下一个任务（挂起不等于完成，不发 completed）。
   * 唤醒路径在 onTaskDone：依赖任务 completed → 反查 blockedOn → 回队首重派。
   */
  private onTaskBlocked(
    rt: ProfileRuntime,
    args: { reason: string; unblockProfileId: string; unblockSummary: string; unblockType?: string },
  ): string {
    const { projectId, profileId } = rt
    const task = rt.current
    if (task === undefined) return '当前没有执行中的任务，无需挂起。'

    // 挂起当前任务（泳道释放；session 冻结——不再进新消息，上下文完整保留待恢复）。
    rt.current = undefined
    rt.currentFromSeq = undefined
    task.status = 'pending'
    rt.suspended.set(task.id, task)
    const lane = rt.lanes.get(task.type)
    if (lane !== undefined) {
      lane.status = 'idle'
      lane.currentTaskId = undefined
      lane.lastUsedAt = Date.now()
    }

    // 因果边顺序（§4.2 DAG）：预分配派生任务 id → blocked 事件先落盘（引用派生 id）→
    // 派生任务的 assigned 落盘时 causedBy 回指 blocked 事件。
    const blockedRef = taskRef(task)
    const derivedId = AgentRuntime.preTaskId()
    task.blockedByTaskId = derivedId
    // 目标成员预校验（失败则自救回队，不落任何事件）。
    const project = loadProject(projectId)
    if (project === undefined || !isGroupMember(project, args.unblockProfileId)) {
      rt.suspended.delete(task.id)
      rt.queue.unshift(task)
      rt.wakeTask?.()
      rt.wakeTask = undefined
      return `挂起失败："${args.unblockProfileId}" 不是项目 "${projectId}" 的项目组成员。任务已回队列。`
    }
    const blockedEvt = this.record('corum/task/blocked', {
      task: blockedRef,
      reason: args.reason,
      blockedByTaskId: derivedId,
    })
    const derived = this.enqueue(
      projectId,
      args.unblockProfileId,
      args.unblockType ?? '',
      args.unblockSummary,
      `【解除阻塞】${args.reason}\n【被阻塞任务】${task.summary}`,
      profileId, // actor = 被阻塞的角色
      [blockedEvt.id], // 因果边：派生任务因 blocked 而生
      derivedId,
    )
    this.ctx.logger.info(`corumRuntime: [${projectId}/${profileId}] task blocked "${task.id}" — 等 "${derived.id}" 解除`)

    // 唤醒本循环取下一个任务。
    rt.wakeDone?.()
    rt.wakeDone = undefined
    return `任务已挂起。已派生解除阻塞任务给 ${args.unblockProfileId}（id：${derived.id}）；对方完成后你会被自动唤醒继续。`
  }

  /**
   * PM 专属协调工具（STALL-DETECTION-AND-REDISPATCH §4.4）：卡住干预三级。
   * 只装在 role='pm' 成员的会话（协调是 PM 的应用层特权，普通成员无）。
   * 与 UI 的 RPC steerTask/cancelTask/reassignTask 同一实现。
   */
  private installCoordinatorTools(agentCtx: Context, projectId: string): void {
    agentCtx.tools.register(defineTool({
      name: 'steer_task',
      description: [
        '对执行中任务插入一句引导（不打断，下一步边界生效）。',
        '用于任务方向对但节奏拖（如自测过重）：提示收敛（"编译通过即可，直接 complete_task"）。',
      ].join(''),
      parameters: {
        profileId: { type: 'string', required: true, description: '目标成员 profileId' },
        note: { type: 'string', required: true, description: '引导内容（给执行者的收敛指令）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args: { profileId: string; note: string }) => {
        const ok = this.steerTask(projectId, args.profileId, args.note, 'pm')
        return ok ? `已对 ${args.profileId} 插入引导。` : `${args.profileId} 当前没有执行中的任务。`
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'cancel_task',
      description: [
        '中止成员的执行中/挂起任务（明显跑偏/死循环时用）。',
        '默认任务回队首重派（泳道会话保留上下文续跑）；fate=evicted 则废弃任务。',
      ].join(''),
      parameters: {
        profileId: { type: 'string', required: true, description: '目标成员 profileId' },
        reason: { type: 'string', required: true, description: '中止原因' },
        fate: { type: 'string', description: 'requeue（默认，回队重派）| evicted（废弃）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args: { profileId: string; reason: string; fate?: string }) => {
        const fate = args.fate === 'evicted' ? 'evicted' : 'requeue'
        const ok = this.cancelTask(projectId, args.profileId, args.reason, 'pm', fate)
        return ok ? `已中止 ${args.profileId} 的任务（${fate}）。` : `${args.profileId} 当前没有执行中/挂起的任务。`
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'reassign_task',
      description: [
        '中止成员当前任务并改派给另一成员（卡住原因是能力不足/方向不对时用）。',
        '原任务中止（reassigned），同 summary+上下文入队新成员。',
      ].join(''),
      parameters: {
        profileId: { type: 'string', required: true, description: '当前执行者 profileId' },
        targetProfileId: { type: 'string', required: true, description: '改派目标成员 profileId' },
        note: { type: 'string', required: true, description: '改派说明（为什么换、给新执行者的提示）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args: { profileId: string; targetProfileId: string; note: string }) => {
        const ok = this.reassignTask(projectId, args.profileId, args.targetProfileId, args.note, 'pm')
        return ok ? `已把 ${args.profileId} 的任务改派给 ${args.targetProfileId}。` : `${args.profileId} 当前没有执行中的任务。`
      },
    }))
  }

  /** complete_task 回调：发领域事件 + 唤醒该循环实例的阻塞点，进入下一个任务。 */
  private onTaskDone(rt: ProfileRuntime, summary: string): void {
    const { projectId, profileId } = rt
    this.ctx.logger.info(`corumRuntime: [${projectId}/${profileId}] complete_task — ${summary}`)
    const task = rt.current
    if (task !== undefined) {
      // resultRef 区间：[派发时的 fromSeq, 闭环时的会话 seq]——下钻到该任务的工作现场。
      const resultRef = rt.agent !== undefined
        ? { sessionId: String(rt.agent.session.id), fromSeq: rt.currentFromSeq ?? 0, toSeq: rt.agent.session.seq }
        : { sessionId: '', fromSeq: 0, toSeq: 0 }
      const completedEvt = this.record('corum/task/completed', { task: taskRef(task), resultRef, result: summary })
      this.wakeBlockedTasks(projectId, task.id, completedEvt.id)
    }
    rt.wakeDone?.()
    rt.wakeDone = undefined
  }

  /**
   * 依赖解除反查唤醒（§3.14 方案 A）：某任务 completed → 扫全项目 suspended，
   * 凡 blockedByTaskId === 该任务者，回其角色队首重派（同泳道会话 resume，
   * 完整上下文接续）。C 只需正常完成，无需知道 B。
   * blockedBy 索引：suspended 任务的 blockedByTaskId 记在哪？——记在 Task.blockedByTaskId
   * （挂起时回填，fold 恢复时从 blocked 事件重建）。
   */
  private wakeBlockedTasks(projectId: string, completedTaskId: string, completedEvtId: string): void {
    for (const candidate of this.profiles.values()) {
      if (candidate.projectId !== projectId) continue
      for (const [taskId, suspendedTask] of candidate.suspended) {
        if (suspendedTask.blockedByTaskId !== completedTaskId) continue
        candidate.suspended.delete(taskId)
        delete suspendedTask.blockedByTaskId
        // 唤醒：回队首（挂起者优先续跑），发 unblocked 事件（causedBy → completed）。
        candidate.queue.unshift(suspendedTask)
        this.record('corum/task/unblocked', { task: taskRef(suspendedTask), unblockedByTaskId: completedTaskId }, [completedEvtId])
        this.ctx.logger.info(`corumRuntime: [${projectId}/${candidate.profileId}] task unblocked "${taskId}" ← "${completedTaskId}"`)
        candidate.wakeTask?.()
        candidate.wakeTask = undefined
        this.startLoop(candidate)
      }
    }
  }

  // ── TypertRemoteService @Remote 端点（/api/corumRuntime/*） ──────────

  /** 入队一个任务到「项目 × 角色 × 泳道」。 */
  @Remote('enqueue')
  enqueueRemote(projectId: string, profileId: string, type: string, summary: string, transferNote?: string): { task: Task } {
    return { task: this.enqueue(projectId, profileId, type, summary, transferNote) }
  }

  /** 列出所有「项目 × 角色」的任务队列 + 当前任务。current 无任务时为 null（JSON-safe）。 */
  @Remote('listTasks')
  listTasksRemote(): {
    profiles: Array<{
      projectId: string
      profileId: string
      current: Task | null
      queue: Task[]
      suspended: Task[]
      currentStartedAt: number | null
      lastActivityAt: number | null
      stalled: boolean
    }>
  } {
    const now = Date.now()
    return {
      profiles: [...this.profiles.values()].map(rt => {
        const hasCurrent = rt.current !== undefined
        const lastActivity = hasCurrent ? this.lastActivityAt(rt) : null
        return {
          projectId: rt.projectId,
          profileId: rt.profileId,
          current: rt.current ?? null,
          queue: rt.queue,
          suspended: [...rt.suspended.values()],
          currentStartedAt: rt.currentStartedAt ?? null,
          lastActivityAt: lastActivity,
          stalled: hasCurrent && lastActivity !== null && now - lastActivity > STALL_THRESHOLD_MS,
        }
      }),
    }
  }

  /**
   * 读取项目的持久领域事件日志（从 fromSeq 开始；RPC 回放，事实源 =
   * scheduler-events.jsonl）。lastSeq = 下一条预期 seq（= 有效事件总数）。
   */
  @Remote('getDomainEvents')
  getDomainEventsRemote(projectId: string, fromSeq: number): { events: SchedulerEvent[]; lastSeq: number } {
    const events = readSchedulerEventsFrom(projectId, fromSeq)
    return { events, lastSeq: fromSeq + events.length }
  }

  /**
   * 列出泳道池状态（路由框架可见性）：每个「项目 × 角色」的各工作类型泳道
   * （sessionId / busy·idle / 当前任务 / 最近使用），可按项目过滤。
   */
  @Remote('listLanes')
  listLanesRemote(projectId?: string): {
    pools: Array<{
      projectId: string
      profileId: string
      lanes: Array<{ type: string; sessionId: string | null; status: 'idle' | 'busy'; currentTaskId: string | null; lastUsedAt: number }>
    }>
  } {
    const pools = [...this.profiles.values()]
      .filter(rt => projectId === undefined || projectId === '' || rt.projectId === projectId)
      .map(rt => ({
        projectId: rt.projectId,
        profileId: rt.profileId,
        lanes: [...rt.lanes.values()].map(l => ({
          type: l.type,
          sessionId: l.sessionId ?? null,
          status: l.status,
          currentTaskId: l.currentTaskId ?? null,
          lastUsedAt: l.lastUsedAt,
        })),
      }))
    return { pools }
  }

  /** 用户对执行中任务插入引导（与 PM steer_task 工具同一实现）。 */
  @Remote('steerTask')
  steerTaskRemote(projectId: string, profileId: string, note: string): { ok: boolean } {
    return { ok: this.steerTask(projectId, profileId, note, 'user') }
  }

  /** 用户中止任务（fate 缺省 requeue）。 */
  @Remote('cancelTask')
  cancelTaskRemote(projectId: string, profileId: string, reason: string, fate?: 'requeue' | 'evicted'): { ok: boolean } {
    return { ok: this.cancelTask(projectId, profileId, reason, 'user', fate ?? 'requeue') }
  }

  /** 用户把当前任务改派另一成员。 */
  @Remote('reassignTask')
  reassignTaskRemote(projectId: string, profileId: string, targetProfileId: string, note: string): { ok: boolean } {
    return { ok: this.reassignTask(projectId, profileId, targetProfileId, note, 'user') }
  }

  /**
   * 读取一个「项目 × 角色」当前任务的会话事件流（从 fromSeq 开始）。
   * 用于界面实时观察 Agent 的思考 / 工具调用 / 输出。
   */
  @Remote('getTaskEvents')
  getTaskEventsRemote(projectId: string, profileId: string, fromSeq: number, type?: string): { events: RuntimeEventDto[]; lastSeq: number } {
    // 泳道感知：指定 type 读对应泳道会话，否则看当前占用泳道（默认行为不变）。
    const agent = type !== undefined && type !== ''
      ? this.corumAgent.getAgentForType(projectId, profileId, type)
      : this.runtime(projectId, profileId).agent
    if (agent === undefined) return { events: [], lastSeq: fromSeq }
    const events: RuntimeEventDto[] = []
    let lastSeq = fromSeq
    for (const event of agent.session.events) {
      if (event.seq < fromSeq) continue
      events.push({
        seq: event.seq,
        type: event.type,
        data: simplifyEventData(event),
        time: event.time,
      })
      lastSeq = event.seq
    }
    return { events, lastSeq }
  }
}

/** 取任务的领域引用快照（领域事件载荷；显式 undefined 不进 JSON）。 */
function taskRef(task: Task): TaskRef {
  return {
    id: task.id,
    projectId: task.projectId,
    profileId: task.profileId,
    type: task.type,
    summary: task.summary,
    ...(task.transferNote !== undefined && task.transferNote !== '' ? { transferNote: task.transferNote } : {}),
  }
}

/** 把任务渲染成一条 followup 消息（摘要 + 增量 + 完成指令）。 */
function renderTaskMessage(task: Task): ReturnType<typeof createUserMessage> {
  const lines = [`【任务】${task.summary}`]
  if (task.transferNote !== undefined && task.transferNote !== '') {
    lines.push(`【上下文】${task.transferNote}`)
  }
  lines.push('请开始处理该任务；完成后调用 complete_task 上报。')
  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n\n') }],
    source: { kind: 'plugin', plugin: '@corum/corum-agent-dev' },
  })
}

export default AgentRuntime
