/**
 * Agent 运行时：在官方 Agent Loop 之外叠加的一层（角色运行时 + 任务队列 + 串行调度）。
 *
 * 核心职责（对应设计文档 §1）：
 *   1. 每个角色（dev/test/pm）一个 root Agent，能力在 `setup` 里注入；
 *   2. 每角色一个任务队列，串行调度（一个 Agent 同一时刻只处理一件事）；
 *   3. 取到任务 → followup 派活到该角色的 root Agent；
 *   4. complete_task 上报 → taskDone 闭环 → 出队下一个。
 *
 * 这是纯增量：官方 `ReactLoopAgent` 的执行引擎原样复用，本服务只管
 * "取哪个任务、派给哪个角色、何时算完成"。
 * @module @corum/corum-project-core/runtime
 */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// 空类型 import：让 `ctx.agentDefaultModel` 的 Context 合并生效（headless 同款做法）。
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ROLE_DEFINITIONS, installRolePersona, installRoleToolFilter } from './roles.ts'
import type { RoleId } from './roles.ts'
import { createTask } from './task.ts'
import type { Task } from './task.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum 项目管理 Agent 运行时（角色运行时 + 任务调度）。 */
    projectCore: AgentRuntime
  }
}

/** 一个角色的运行时状态。 */
interface RoleRuntime {
  readonly role: RoleId
  agent: Agent | undefined
  /** 待处理任务队列（FIFO）。 */
  readonly queue: Task[]
  /** 当前正在处理的任务。 */
  current: Task | undefined
}

/** complete_task 工具的返回结构。 */
interface CompleteTaskArgs {
  /** 完成的说明（做了什么、结果如何）。 */
  summary: string
}

/**
 * corum 项目管理 Agent 运行时。
 *
 * 一个进程内单例（Service 注册在 host 根 ctx），持有每个角色的 root Agent
 * 句柄 + 任务队列。角色 Agent 是独立 root Agent，调度 authority 来自本服务
 * 直接持有的 `Agent` 句柄（`agent.followup`，无 authority 限制）。
 */
export class AgentRuntime extends Service {
  static inject = ['agents', 'agentDefaultModel', 'sessions']

  /** 每角色的运行时状态。 */
  private readonly roles = new Map<RoleId, RoleRuntime>()

  constructor(ctx: Context) {
    super(ctx, 'projectCore')
    for (const role of Object.keys(ROLE_DEFINITIONS) as RoleId[]) {
      this.roles.set(role, { role, agent: undefined, queue: [], current: undefined })
    }
  }

  /**
   * 将一个任务入队到目标角色，并尝试驱动该角色的串行调度。
   * @param input - 任务字段（除 id/status，由本方法补全）。
   * @returns 入队的任务。
   */
  enqueue(input: Omit<Task, 'id' | 'status'>): Task {
    const task = createTask({ ...input, id: `task-${randomUUID()}` })
    const runtime = this.roles.get(input.targetRole)
    if (runtime === undefined) {
      throw new Error(`projectCore: unknown role "${input.targetRole}"`)
    }
    runtime.queue.push(task)
    void this.drive(input.targetRole)
    return task
  }

  /**
   * 串行驱动一个角色：若空闲且有排队任务，取出一个、确保 root Agent 存在，
   * 然后 followup 派活。
   */
  private async drive(role: RoleId): Promise<void> {
    const runtime = this.roles.get(role)
    if (runtime === undefined) return
    if (runtime.current !== undefined) return // 正在处理，串行等待

    const task = runtime.queue.shift()
    if (task === undefined) return // 队列空，保持待命

    const agent = await this.ensureAgent(runtime)
    if (agent === undefined) {
      // 创建失败：任务放回队首，稍后重试。
      runtime.queue.unshift(task)
      return
    }

    runtime.current = task
    task.status = 'running'
    this.ctx.logger.info(`projectCore: [${role}] dispatch task "${task.id}" — ${task.summary}`)

    agent.followup(this.renderTaskMessage(task))
  }

  /**
   * 确保一个角色的 root Agent 已创建（懒创建，能力在 setup 注入）。
   */
  private async ensureAgent(runtime: RoleRuntime): Promise<Agent | undefined> {
    if (runtime.agent !== undefined) return runtime.agent

    const role = ROLE_DEFINITIONS[runtime.role]
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const sessionId = SessionId(`corum-${runtime.role}-${randomUUID()}`)

    try {
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installRolePersona(agentCtx, role)
          installRoleToolFilter(agentCtx, role)
          this.installCompleteTaskTool(agentCtx, runtime.role)
        },
      })
      runtime.agent = handle.agent
      this.ctx.logger.info(`projectCore: [${runtime.role}] root agent created — ${sessionId}`)
      return handle.agent
    } catch (error) {
      this.ctx.logger.error(`projectCore: [${runtime.role}] agent creation failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * 在角色 Agent 的 setup 里注册 complete_task 工具（agent-scoped）。
   * 工具执行时经闭包回调 `onTaskDone`，形成 taskDone 闭环。
   */
  private installCompleteTaskTool(agentCtx: Context, role: RoleId): void {
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
      execute: async (args: CompleteTaskArgs) => {
        this.onTaskDone(role, args.summary)
        return `任务已上报完成：${args.summary}`
      },
    }))
  }

  /**
   * complete_task 回调：标记当前任务完成，继续驱动下一个。
   * @param role - 上报完成的角色。
   * @param summary - 完成说明。
   */
  private onTaskDone(role: RoleId, summary: string): void {
    const runtime = this.roles.get(role)
    if (runtime === undefined) return
    const task = runtime.current
    if (task === undefined) return
    task.status = 'done'
    runtime.current = undefined
    this.ctx.logger.info(`projectCore: [${role}] task done "${task.id}" — ${summary}`)
    void this.drive(role)
  }

  /**
   * 把任务渲染成一条 followup 消息（summary + 增量 context 组装成 user message）。
   */
  private renderTaskMessage(task: Task): ReturnType<typeof createUserMessage> {
    const lines: string[] = [
      `【任务】${task.summary}`,
    ]
    if (task.increment.transferNote !== undefined && task.increment.transferNote !== '') {
      lines.push(`【上下文】${task.increment.transferNote}`)
    }
    lines.push('请开始处理该任务；完成后调用 complete_task 上报。')
    return createUserMessage({
      content: [{ type: 'text', text: lines.join('\n\n') }],
      source: { kind: 'plugin', plugin: '@corum/corum-project-core' },
    })
  }
}

export default AgentRuntime
