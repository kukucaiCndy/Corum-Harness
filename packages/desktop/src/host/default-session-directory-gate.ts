import { Service, type Context } from '@deepseek-ai/cordis'

/** Cordis unload 会记录而不抛 disposer 错误；持有 logger 读回本次停机诊断。 */
export async function stopDefaultSessionDirectoryHost(ctx: Context): Promise<void> {
  const logger = ctx.logger
  const previousSize = logger.bufferSize
  logger.bufferSize = Math.max(previousSize, 1000)
  const previous = logger.buffer.at(-1)?.sn ?? -1
  try {
    await ctx.fiber.dispose()
    const errors = logger.buffer.filter(record => record.sn > previous && record.type === 'error')
    if (errors.length) throw new Error(`会话服务停机失败，请重试：${errors.map(record => record.args.map(String).join(' ')).join('; ')}`)
  } finally { logger.bufferSize = previousSize }
}

interface MigratingAgent {
  status: string
  send(...args: unknown[]): unknown
  runMaintenance(task: (signal: AbortSignal) => Promise<void>): Promise<void>
}
declare module '@deepseek-ai/cordis' {
  interface Context { defaultSessionDirectoryGate: DefaultSessionDirectoryGate }
}

/** 全宿主写门禁。状态仅存根 Cordis service；同步入口保留同步拒绝。 */
export class DefaultSessionDirectoryGate extends Service {
  private closed = false
  private inFlight = 0
  private readonly guarded = new WeakMap<object, Set<string>>()
  private readonly agents = new Map<MigratingAgent, MigratingAgent['runMaintenance']>()

  constructor(ctx: Context) {
    super(ctx, 'defaultSessionDirectoryGate')
    ctx.on('agent/created', ({ agent }) => {
      this.assertOpen()
      this.watchAgent(agent as unknown as MigratingAgent)
    })
    ctx.on('agent/disposed', ({ agent }) => { this.agents.delete(agent as unknown as MigratingAgent) })
    const services: Record<string, string[]> = {
      agents: ['create', 'resume'],
      sessions: ['create', 'fork'],
      corumAgent: ['createAgentForTask'],
      corumFs: ['write', 'mkdirp', 'remove', 'renamePath', 'revertWrites'],
      corumTerminal: ['create', 'write'],
      terminals: ['spawn', 'startSend'],
      shell: ['run', 'start'],
      corumGit: ['init', 'ensureRepo'],
      corumReview: ['rollback', 'setRetention', 'snapshot', 'ensureRepo', 'settleRound', 'enqueue', 'persistCapture', 'persistFrozen', 'appendJournal', 'compactJournal', 'compactFrozen', 'pruneRepo', 'applyWorktreeChanges'],
      corumSessionArchive: ['importZip', 'deleteSession'],
    }
    for (const [name, methods] of Object.entries(services)) {
      ctx.inject([name], scoped => {
        const target = scoped.get(name)
        if (target) this.guard(target, methods)
        if (name === 'agents') for (const agent of (target as { list(): MigratingAgent[] }).list()) this.watchAgent(agent)
      })
    }
  }

  assertOpen(): void { if (this.closed) throw new Error('默认会话目录正在迁移，请稍后重试') }
  guard(target: object, names: readonly string[]): void {
    const record = target as Record<string, unknown>
    const wrapped = this.guarded.get(target) ?? new Set<string>()
    this.guarded.set(target, wrapped)
    const gate = this
    for (const name of names) {
      const original = record[name]
      if (typeof original !== 'function' || wrapped.has(name)) continue
      wrapped.add(name)
      record[name] = function (this: unknown, ...args: unknown[]) {
        gate.assertOpen()
        gate.inFlight++
        let async = false
        try {
          const result: unknown = Reflect.apply(original, this, args)
          if (name === 'start' && result !== null && typeof result === 'object' && 'done' in result) {
            async = true
            void Promise.resolve(result.done).then(() => { gate.inFlight-- }, () => { gate.inFlight-- })
          }
          if (result !== null && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
            async = true
            return Promise.resolve(result).finally(() => { gate.inFlight-- })
          }
          return result
        } finally { if (!async) gate.inFlight-- }
      }
    }
  }

  watchAgent(agent: MigratingAgent): void {
    if (this.agents.has(agent)) return
    this.agents.set(agent, agent.runMaintenance)
    this.guard(agent, ['send', 'runMaintenance'])
  }

  /** 关门与 in-flight 判定在第一个 await 前，不打断任何外部工作区任务。 */
  async prepare(): Promise<void> {
    this.assertOpen()
    this.closed = true
    try {
      this.assertQuiet()
      for (const [agent, maintenance] of this.agents) {
        // 安装门禁之前已开始的 maintenance 也必须被识别；其 public status 仍为 idle。
        await maintenance.call(agent, async () => {})
      }
      this.assertQuiet()
    } catch (error) { this.closed = false; throw error }
  }

  assertQuiet(): void {
    if (this.inFlight) throw new Error('仍有操作正在执行，请完成后重试迁移')
    const terminals = this.ctx.get('terminals') as { hasOwnerActivity(owner: unknown): boolean } | undefined
    for (const agent of this.agents.keys()) {
      if (agent.status !== 'idle' || terminals?.hasOwnerActivity(agent)) throw new Error('仍有 Agent 或终端任务正在执行，请结束后重试迁移')
    }
    const terminal = this.ctx.get('corumTerminal') as { hasActiveSessions(): boolean } | undefined
    if (terminal?.hasActiveSessions()) throw new Error('请关闭正在运行的终端后重试迁移')
  }
  release(): void { this.closed = false }
}
