/**
 * AgentRuntime —— corum-agent-dev 的「任务 List + 可阻塞循环」调度层。
 *
 * 在官方 ReactLoopAgent 之外叠加的一层（全局协调器形态）：
 *   - 每个 profile（角色）一个任务队列（Task List），FIFO；
 *   - 每个 profile 一条常驻可阻塞循环：队列空则阻塞等任务，取到任务则
 *     followup 派活并阻塞等 complete_task，完成再取下一个；
 *   - 任务完成判定：Agent 显式调用 complete_task 工具（在 setup 里注入，
 *     闭包捕获 profileId）。
 *
 * 复用 CorumAgentService 创建绑定 persona/工具/skill/MCP 的 root Agent，
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
  /** 目标角色 = AgentProfile id。 */
  readonly profileId: string
  /** 任务摘要（提交方生成）。 */
  readonly summary: string
  /** 增量 context（提交方组装，可选）。 */
  readonly transferNote?: string
  status: TaskStatus
}

/** 一个 profile 的运行时状态。 */
interface ProfileRuntime {
  readonly profileId: string
  agent: Agent | undefined
  readonly queue: Task[]
  current: Task | undefined
  /** 队列空时阻塞循环的唤醒器。 */
  wakeTask: (() => void) | undefined
  /** 任务执行中阻塞循环的唤醒器（complete_task 触发）。 */
  wakeDone: (() => void) | undefined
  /** 该 profile 的常驻循环是否已启动。 */
  started: boolean
}

/**
 * corum 任务调度运行时（全局协调器）。
 *
 * 单例，持有所有 profile 的任务队列 + Agent 句柄。调度 authority 来自
 * 直接持有的 `Agent` 句柄（`agent.followup` 无 authority 限制，见
 * docs/agent-foundation/AGENT-RUNTIME-CONTEXT-DESIGN.md §2.3）。
 */
export class AgentRuntime extends TypertRemoteService {
  static inject = ['agents', 'sessions']

  private readonly profiles = new Map<string, ProfileRuntime>()

  constructor(
    ctx: Context,
    /** 复用的 Agent 实例工厂（AgentProfile → root Agent）。 */
    private readonly corumAgent: CorumAgentService,
  ) {
    super(ctx, 'corumRuntime')
  }

  /** 取（或懒建）一个 profile 的运行时状态。 */
  private runtime(profileId: string): ProfileRuntime {
    let rt = this.profiles.get(profileId)
    if (rt === undefined) {
      rt = {
        profileId,
        agent: undefined,
        queue: [],
        current: undefined,
        wakeTask: undefined,
        wakeDone: undefined,
        started: false,
      }
      this.profiles.set(profileId, rt)
    }
    return rt
  }

  /**
   * 入队一个任务到目标 profile，并唤醒该 profile 的阻塞循环。
   * @param profileId - 目标角色（AgentProfile id）。
   * @param summary - 任务摘要。
   * @param transferNote - 增量 context（可选）。
   * @returns 入队的任务。
   */
  enqueue(profileId: string, summary: string, transferNote?: string): Task {
    const rt = this.runtime(profileId)
    const task: Task = {
      id: `task-${randomUUID()}`,
      profileId,
      summary,
      ...(transferNote !== undefined && transferNote !== '' ? { transferNote } : {}),
      status: 'pending',
    }
    rt.queue.push(task)
    this.ctx.logger.info(`corumRuntime: [${profileId}] enqueue "${task.id}" — ${summary}`)
    rt.wakeTask?.()
    rt.wakeTask = undefined
    if (!rt.started) {
      rt.started = true
      void this.runLoop(profileId)
    }
    return task
  }

  /**
   * 一个 profile 的常驻可阻塞循环：
   *   队列空 → 阻塞等新任务；取到任务 → 派活 → 阻塞等 complete_task → 下一个。
   */
  private async runLoop(profileId: string): Promise<void> {
    const rt = this.runtime(profileId)
    for (;;) {
      const task = rt.queue.shift()
      if (task === undefined) {
        // 队列空：阻塞，直到 enqueue 唤醒。
        await new Promise<void>(resolve => { rt.wakeTask = resolve })
        continue
      }

      rt.current = task
      task.status = 'running'

      const agent = await this.ensureAgent(profileId)
      if (agent === undefined) {
        // 创建失败：放回队首，稍后重试。
        rt.queue.unshift(task)
        task.status = 'pending'
        rt.current = undefined
        await new Promise<void>(resolve => setTimeout(resolve, 1000))
        continue
      }

      agent.followup(renderTaskMessage(task))
      // 阻塞：等该任务 complete_task。
      await new Promise<void>(resolve => { rt.wakeDone = resolve })

      task.status = 'done'
      rt.current = undefined
      this.ctx.logger.info(`corumRuntime: [${profileId}] task done "${task.id}"`)
    }
  }

  /** 确保一个 profile 的 root Agent 已创建（复用 CorumAgentService，注入 complete_task）。 */
  private async ensureAgent(profileId: string): Promise<Agent | undefined> {
    const rt = this.runtime(profileId)
    if (rt.agent !== undefined) return rt.agent
    try {
      const { agent } = await this.corumAgent.createAgent(profileId, (agentCtx) => {
        this.installCompleteTaskTool(agentCtx, profileId)
      })
      rt.agent = agent
      return agent
    } catch (error) {
      this.ctx.logger.error(`corumRuntime: [${profileId}] agent creation failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * 在角色 Agent 的 setup 里注册 complete_task 工具（agent-scoped）。
   * 工具执行时经闭包回调 onTaskDone，形成「任务完成」闭环。
   */
  private installCompleteTaskTool(agentCtx: Context, profileId: string): void {
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
        this.onTaskDone(profileId, args.summary)
        return `任务已上报完成：${args.summary}`
      },
    }))
  }

  /** complete_task 回调：唤醒该 profile 的阻塞循环，进入下一个任务。 */
  private onTaskDone(profileId: string, summary: string): void {
    const rt = this.runtime(profileId)
    this.ctx.logger.info(`corumRuntime: [${profileId}] complete_task — ${summary}`)
    rt.wakeDone?.()
    rt.wakeDone = undefined
  }

  // ── TypertRemoteService @Remote 端点（/api/corumRuntime/*） ──────────

  /** 入队一个任务。 */
  @Remote('enqueue')
  enqueueRemote(profileId: string, summary: string, transferNote?: string): { task: Task } {
    return { task: this.enqueue(profileId, summary, transferNote) }
  }

  /** 列出所有 profile 的任务队列 + 当前任务。current 无任务时为 null（JSON-safe）。 */
  @Remote('listTasks')
  listTasksRemote(): { profiles: Array<{ profileId: string; current: Task | null; queue: Task[] }> } {
    return {
      profiles: [...this.profiles.values()].map(rt => ({
        profileId: rt.profileId,
        current: rt.current ?? null,
        queue: rt.queue,
      })),
    }
  }

  /**
   * 读取一个 profile 当前任务的会话事件流（从 fromSeq 开始）。
   * 用于界面实时观察 Agent 的思考 / 工具调用 / 输出。
   */
  @Remote('getTaskEvents')
  getTaskEventsRemote(profileId: string, fromSeq: number): { events: RuntimeEventDto[]; lastSeq: number } {
    const rt = this.runtime(profileId)
    const agent = rt.agent
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
