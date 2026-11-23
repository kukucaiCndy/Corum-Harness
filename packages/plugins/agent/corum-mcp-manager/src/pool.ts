/**
 * MCP 宿主级连接池 + 独占租约（用户 2026-09-27 拍板的模型：
 * 「框架统一管理，自始至终只有一个进程。可授权给多个 Agent 使用，但独占状态，不支持并发使用」）。
 *
 * ## 它替换掉的是什么（实测现状）
 *
 * 改造前 MCP 是 **preset 组合里的一行**（`@deepseek-ai/dsh-mcp-client`）⇒ 官方为**每个 preset id**
 * 建常驻 scope，于是「同一 profile 共享一套、不同 profile 各起一套、跨框架零共享」；改配置要
 * dispose+重挂（= 重启进程）；且**没有任何并发仲裁**。
 *
 * 改造后：**每个服务名一个进程**，由本池持有；多个 Agent/profile 的授权共用同一个连接
 * （`retain`/`release` 引用计数）；**独占**由租约仲裁（忙时 FIFO 排队 + 超时拒绝并告知持有者）。
 *
 * ## 为什么**只做串行**（2026-09-27 用户决定，别再往回加）
 *
 * 曾经实现过「按资源（`filePath`/`pageId`）分桶 + 可配并发上限」，并有实机验证：
 *   · Pencil MCP：不同 `.pen` 文档确实能真并行（服务端不串行）✓；
 *   · chrome-devtools-mcp：**服务端自己把工具调用串行化**（一个 30s 脚本把后续请求全挡到它结束）✗。
 * 用户随后从产品角度判定：真实使用里用户**基本只专注单个业务**，并行开展业务既少又低效；而
 * 「判断能不能并行 + 施加额外规则」让产品复杂、不可控，还要赌未来各家 MCP 的通用性。
 * ⇒ **产品层面只保留串行**，那条能力连同推导规则一起移除了（见 `docs/LESSONS.md`）。
 * 结论：**不要再引入资源分桶 / 并发上限 / skipLease 这类概念**，除非用户重新拍板。
 *
 * ## 硬约束（都来自实测教训，改动前先读）
 *
 * 1. **按「服务名 → 当前定义」持有，定义指纹变了才换进程**：`args`/`env`/`command` 变了必须换
 *    （进程参数不同，物理上不能共用），其余情况 pids 必须保持不变（用户验收判据之一）。
 * 2. **租约必然释放**：工具返回/抛错走 `finally`；此外还有 **TTL 兜底**（持有者崩死时回收），
 *    回收要 `warn` 点名原持有者——否则用户看到的是「工具莫名卡住」。
 * 3. **连接死亡不等于工具消失**：server 进程崩了只标记 `connected=false`（下次调用重连），
 *    **不**清空工具表——否则一次瞬时崩溃会把工具面从模型眼前抽走。
 * 4. 本类不做 cordis 服务注册（那是 `mcp-pool-service.ts`）；这里只保证「一个名字一份连接」。
 *
 * @module @corum/corum-mcp-manager/pool
 */

import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { getServer } from './registry-store.ts'
import type { McpServerConfig } from './types.ts'

/** 池里的一条工具（**原始名**；`mcp__` 前缀由代理层加，见 `tool-naming.ts`）。 */
export interface McpPoolTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

/** 租约归属：进日志与拒绝文本，便于归因（谁占了、等了多久）。 */
export interface McpLeaseOwner {
  /** Agent id（主 Agent / 子 Agent / 泳道 Agent 的会话 id 或 agent id）。 */
  readonly agentId: string
  /** 所属会话 id（有则记）。 */
  readonly sessionId?: string
  /** 泳道/角色标签（有则记）。 */
  readonly lane?: string
}

/** 池的配置（测试可覆盖解析函数与时长）。 */
export interface McpPoolOptions {
  /** 忙时排队上限；超时即拒绝并告知持有者（用户裁定：排队 + 超时）。默认 60s。 */
  readonly leaseTimeoutMs?: number
  /** 租约 TTL：持有者崩死时的兜底回收。默认 `leaseTimeoutMs * 2`。 */
  readonly leaseTtlMs?: number
  /** 引用计数归零后的停止宽限期（ms）。默认 3s；见 `DEFAULT_STOP_GRACE_MS`。 */
  readonly stopGraceMs?: number
  /** 解析服务定义（默认读全局注册表 `~/.corum/mcp-servers.json`）。 */
  readonly resolve?: (serverName: string) => McpServerConfig | undefined
  /** 日志出口（默认静默；宿主侧接 cordis logger）。 */
  readonly log?: (level: 'info' | 'warn', message: string) => void
}

/** 池的观测投影（UI / 验收用）。 */
export interface McpPoolSnapshot {
  readonly serverName: string
  readonly fingerprint: string
  /** 当前 server 进程 pid（stdio；未连接时缺省）。 */
  readonly pid?: number
  readonly connected: boolean
  readonly toolCount: number
  readonly refs: number
  /** 所有资源键下的排队总数。 */
  readonly queueLength: number
  /** 当前持有者（串行：至多一个）。 */
  readonly holder?: McpLeaseOwner & { readonly sinceMs: number }
}

/** 忙超时的结构化错误：文本必须能回答「谁占着、我排了多久」。 */
export class McpLeaseTimeoutError extends Error {
  readonly serverName: string
  readonly holder: McpLeaseOwner | undefined
  readonly waitedMs: number
  readonly queueLength: number
  constructor(input: {
    readonly serverName: string
    readonly holder: McpLeaseOwner | undefined
    readonly waitedMs: number
    readonly queueLength: number
  }) {
    super(
      `MCP server "${input.serverName}" is busy: held by ${describeOwner(input.holder)}`
      + ` (waited ${input.waitedMs}ms, ${input.queueLength} still queued).`
      + ' This MCP server is exclusive — retry after the holder finishes.',
    )
    this.name = 'McpLeaseTimeoutError'
    this.serverName = input.serverName
    this.holder = input.holder
    this.waitedMs = input.waitedMs
    this.queueLength = input.queueLength
  }
}

/** 归属的可读描述（日志/错误文本共用一处，避免两处措辞漂移）。 */
export function describeOwner(owner: McpLeaseOwner | undefined): string {
  if (owner === undefined) return 'nobody'
  const parts = [`agent ${owner.agentId}`]
  if (owner.sessionId !== undefined) parts.push(`session ${owner.sessionId}`)
  if (owner.lane !== undefined) parts.push(`lane ${owner.lane}`)
  return parts.join(' / ')
}

const DEFAULT_LEASE_TIMEOUT_MS = 60_000

/**
 * 租约 TTL 的默认值（**最后手段**，不是"调用时长上限"）。
 *
 * ## 2026-09-27 实机教训（这条默认值原先写错了）
 *
 * 原实现是 `leaseTimeoutMs * 2`（默认 120s，实机把排队超时调到 8s 后就变成 16s）。实机场景：
 * 一个**合法**跑 40s 的调用持有 `doc-a`，16s 后池认为它"死了" ⇒ **回收槽位** ⇒ 另一个 Agent
 * 立刻拿到同一个 `doc-a` 并**同时改** —— 租约存在的意义（同资源串行）当场失效。
 *
 * 正确语义：正常路径下槽位由 `callTool` 的 `finally` 精确释放，**不需要 TTL**；TTL 只负责
 * 「调用体永不 settle（SDK 挂死）」这种最后手段。故默认给足 10 分钟，并可用
 * `CORUM_MCP_LEASE_TTL_MS` 覆盖。
 */
const DEFAULT_LEASE_TTL_MS = 10 * 60_000

/**
 * 引用计数归零后**延迟这么久**才真的停进程（缺省 3s；`CORUM_MCP_STOP_GRACE_MS` 可覆盖）。
 *
 * ## 为什么必须有（2026-09-27 实机预判 + 用户要求）
 *
 * 用户要求「保存 profile 只改授权、**不再重启 MCP 进程**」。而保存会触发一次预设重挂：
 * 旧常驻 scope 先被销毁（代理行卸载 ⇒ 引用计数 -1）、新 scope 再挂上（+1）。若该 server
 * 只有**一个** profile 授权，计数就会瞬间 1 → 0 → 1 —— 没有宽限期的话，池会在那个瞬间
 * 把进程杀掉、再起一个新的：**pid 变了，正是用户不接受的行为**。
 *
 * 宽限期把"卸载"与"停进程"解耦：窗口内任何一次 `retain` 都会取消停止。真到了窗口结束还没人
 * 用，才停进程（避免长期占着资源）。
 */
const DEFAULT_STOP_GRACE_MS = 3_000

/**
 * 从环境变量读租约时长（运维旋钮；设置 UI 落地前先用它，也让实机验收能在合理时间内触发超时）。
 *
 * · `CORUM_MCP_LEASE_TIMEOUT_MS` —— 忙时排队超时（超时即拒绝并告知持有者）。
 * · `CORUM_MCP_LEASE_TTL_MS` —— 持有者崩死时的兜底回收时长（缺省 = 超时 × 2）。
 *
 * 解析失败/非正数一律回落到默认值（配置写错不该让 MCP 起不来）。
 * @param env - 环境变量表（测试可注入）。
 * @returns 两个时长。
 */
export function leaseTimeoutsFromEnv(env: NodeJS.ProcessEnv = process.env): { leaseTimeoutMs: number; leaseTtlMs?: number; stopGraceMs: number } {
  const read = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  }
  const leaseTimeoutMs = read(env.CORUM_MCP_LEASE_TIMEOUT_MS) ?? DEFAULT_LEASE_TIMEOUT_MS
  const ttl = read(env.CORUM_MCP_LEASE_TTL_MS)
  const stopGraceMs = read(env.CORUM_MCP_STOP_GRACE_MS) ?? DEFAULT_STOP_GRACE_MS
  return { leaseTimeoutMs, ...(ttl !== undefined ? { leaseTtlMs: ttl } : {}), stopGraceMs }
}

/** 定义指纹：只有这些字段变了才算「换了进程」（用户判据：改配置不该重启进程，除非定义变了）。 */
export function fingerprintOf(config: McpServerConfig): string {
  const relevant = config.transport === 'stdio'
    ? { transport: config.transport, command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd ?? '' }
    : { transport: config.transport, url: config.url, headers: config.headers ?? {} }
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16)
}

/** 建 transport（stdio 合并 `process.env`，与 `test-connection.ts` 同款）。 */
function buildTransport(config: McpServerConfig): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    })
  }
  // 与 `test-connection.ts` 同一处 cast（SDK transport 的字段宽度差异）。
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers !== undefined ? { requestInit: { headers: config.headers } } : {},
  ) as Transport
}

/** 排队中的等待者。 */
interface Waiter {
  readonly owner: McpLeaseOwner
  readonly token: symbol
  readonly enqueuedAt: number
  readonly timer: NodeJS.Timeout
  readonly grant: () => void
  readonly fail: (error: unknown) => void
  /** 摘掉 abort 监听（授予/超时/中止/关停四条路径都要摘，否则监听器泄漏）。 */
  readonly detach: () => void
}

/** 调用方撤销（`exec.signal` 中止 / turn 结束）时用的错误。 */
function abortedError(serverName: string, reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : String(reason ?? 'aborted')
  return new Error(`MCP call on "${serverName}" was aborted by its caller (${detail})`)
}

/** 一个服务名对应的连接（池的最小单元：**一份 client + 一份独占租约**）。 */
class PooledServer {
  private client: Client | undefined
  private transport: Transport | undefined
  private tools: readonly McpPoolTool[] = []
  private readonly toolListeners = new Set<(tools: readonly McpPoolTool[]) => void>()
  private connecting: Promise<void> | undefined
  private refs = 0
  /** 待执行的停止定时器（引用计数归零后进入宽限期）。 */
  private stopTimer: NodeJS.Timeout | undefined
  /** 当前持有者（串行：同一时刻至多一个）。 */
  private holder: { owner: McpLeaseOwner; token: symbol; since: number } | undefined
  /** FIFO 队列（串行租约的等待者）。 */
  private queue: Waiter[] = []

  constructor(
    private readonly definition: McpServerConfig,
    private readonly options: { leaseTimeoutMs: number; leaseTtlMs: number; stopGraceMs: number; log: (level: 'info' | 'warn', message: string) => void },
    private readonly onEmpty: () => void,
  ) {}

  get serverName(): string {
    return this.definition.name
  }

  get fingerprint(): string {
    return fingerprintOf(this.definition)
  }

  /** 引用计数 +1；返回释放函数（幂等）。最后一枚释放 ⇒ 停进程。 */
  retain(): () => void {
    this.refs += 1
    // 宽限期内又有人要 ⇒ 取消待停（这正是"保存 profile 不重启进程"的实现点）。
    if (this.stopTimer !== undefined) {
      clearTimeout(this.stopTimer)
      this.stopTimer = undefined
      this.options.log('info', `MCP pool: "${this.serverName}" was re-authorized within the stop grace — keeping pid as is`)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.refs -= 1
      if (this.refs > 0) return
      // 不立刻停：给一次"重挂同一 preset"的窗口，避免保存 profile 就换进程。
      this.options.log(
        'info',
        `MCP pool: last authorization for "${this.serverName}" released — stopping in ${this.options.stopGraceMs}ms unless re-authorized`,
      )
      this.stopTimer = setTimeout(() => {
        this.stopTimer = undefined
        void this.dispose()
        this.onEmpty()
      }, this.options.stopGraceMs)
      // 定时器不该拖住进程退出。
      this.stopTimer.unref?.()
    }
  }

  onToolsChanged(listener: (tools: readonly McpPoolTool[]) => void): () => void {
    this.toolListeners.add(listener)
    return () => { this.toolListeners.delete(listener) }
  }

  /** 工具表（首次调用会连接；已连接用缓存）。 */
  async listTools(): Promise<readonly McpPoolTool[]> {
    await this.ensureConnected()
    return this.tools
  }

  /**
   * 独占调用：取租约（忙则排队/超时）→ 转发 → **必然释放**。
   * @param tool - **原始**工具名。
   * @param args - 调用参数。
   * @param owner - 归属（日志/拒绝文本用）。
   * @returns MCP 原始结果（工具级 `isError` 原样透传，不做语义解释）。
   */
  async callTool(
    tool: string,
    args: unknown,
    owner: McpLeaseOwner,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const release = await this.acquire(owner, options)
    try {
      const client = await this.ensureConnected()
      this.options.log('info', `MCP pool: ${describeOwner(owner)} → ${this.serverName}.${tool}`)
      return await client.callTool(
        { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        // 调用方撤销要能真的传到协议层（否则中止后 server 仍在跑，租约已还、下一个调用会重叠）。
        ...(options.signal !== undefined ? [{ signal: options.signal }] : [{} as { signal?: AbortSignal }]),
      )
    } finally {
      release()
    }
  }

  /**
   * 取串行租约（用户裁定：忙时 **FIFO 排队 + 超时**，超时拒绝并告知持有者）。
   * @param owner - 归属。
   * @param options - 取消信号。
   * @returns 释放函数（幂等；TTL 回收后调用它是空操作）。
   */
  async acquire(
    owner: McpLeaseOwner,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<() => void> {
    this.reclaimIfStale()
    if (options.signal?.aborted === true) throw abortedError(this.serverName, options.signal.reason)
    if (this.holder === undefined) return this.grant(owner)
    const timeoutMs = this.options.leaseTimeoutMs
    return new Promise<() => void>((resolve, reject) => {
      const token = Symbol('mcp-lease')
      /** 出队（授予/超时/中止/关停前先摘监听，幂等）。 */
      const drop = (): void => {
        const index = this.queue.findIndex(candidate => candidate.token === token)
        if (index >= 0) this.queue.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.detach()
      }
      const onAbort = (): void => {
        drop()
        reject(abortedError(this.serverName, options.signal?.reason))
      }
      const waiter: Waiter = {
        owner,
        token,
        enqueuedAt: Date.now(),
        grant: () => { resolve(() => { this.releaseToken(token) }) },
        fail: reject,
        detach: () => { options.signal?.removeEventListener('abort', onAbort) },
        timer: setTimeout(() => {
          if (!this.queue.some(candidate => candidate.token === token)) return
          drop()
          const error = new McpLeaseTimeoutError({
            serverName: this.serverName,
            holder: this.holder?.owner,
            waitedMs: Date.now() - waiter.enqueuedAt,
            queueLength: this.queue.length,
          })
          this.options.log('warn', `MCP pool: ${error.message}`)
          reject(error)
        }, timeoutMs),
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
      this.options.log(
        'info',
        `MCP pool: "${this.serverName}" busy (held by ${describeOwner(this.holder?.owner)}) — `
        + `${describeOwner(owner)} queued at #${this.queue.length}, timeout ${timeoutMs}ms`,
      )
    })
  }

  /** 观测投影。 */
  snapshot(): McpPoolSnapshot {
    const pid = this.transport instanceof StdioClientTransport ? this.transport.pid ?? undefined : undefined
    const now = Date.now()
    return {
      serverName: this.serverName,
      fingerprint: this.fingerprint,
      ...(pid !== undefined ? { pid } : {}),
      connected: this.client !== undefined,
      toolCount: this.tools.length,
      refs: this.refs,
      queueLength: this.queue.length,
      ...(this.holder !== undefined
        ? { holder: { ...this.holder.owner, sinceMs: Date.now() - this.holder.since } }
        : {}),
    }
  }

  /** 关连接（引用计数归零或定义变更时）。 */
  async dispose(): Promise<void> {
    if (this.stopTimer !== undefined) {
      clearTimeout(this.stopTimer)
      this.stopTimer = undefined
    }
    const client = this.client
    const transport = this.transport
    this.client = undefined
    this.transport = undefined
    this.holder = undefined
    for (const waiter of this.queue.splice(0)) {
      {
        clearTimeout(waiter.timer)
        waiter.detach()
        waiter.fail(new Error(`MCP server "${this.serverName}" was stopped before this call could run`))
      }
    }
    if (client !== undefined) await client.close().catch(() => {})
    if (transport !== undefined) await transport.close().catch(() => {})
  }

  private grant(owner: McpLeaseOwner): () => void {
    const token = Symbol('mcp-lease')
    this.holder = { owner, token, since: Date.now() }
    return () => { this.releaseToken(token) }
  }

  /** 释放（幂等）：交给下一个排队者，或清空。 */
  private releaseToken(token: symbol): void {
    if (this.holder?.token !== token) return
    this.holder = undefined
    this.handOff()
  }

  /** 把租约交给队首（若有）。 */
  private handOff(): void {
    const next = this.queue.shift()
    if (next === undefined) return
    clearTimeout(next.timer)
    next.detach()
    this.holder = { owner: next.owner, token: next.token, since: Date.now() }
    next.grant()
  }

  /**
   * TTL 兜底：持有者崩死（或迟到不还）时回收租约。
   *
   * 只在下一次取租约时判——不需要常驻定时器，且语义明确：**没人再要**就不必抢。
   * 回收**不打断**旧持有者的在飞调用（它可能还活着），但租约已经易主并 `warn` 点名。
   */
  private reclaimIfStale(): void {
    if (this.holder === undefined) return
    const age = Date.now() - this.holder.since
    if (age < this.options.leaseTtlMs) return
    const stale = this.holder.owner
    this.options.log(
      'warn',
      `MCP pool: lease on "${this.serverName}" held by ${describeOwner(stale)} for ${age}ms exceeded TTL `
      + `${this.options.leaseTtlMs}ms — reclaiming (the previous holder was killed or never released)`,
    )
    this.holder = undefined
    this.handOff()
  }

  /** 单飞连接（并发调用只连一次）。 */
  private async ensureConnected(): Promise<Client> {
    if (this.client !== undefined) return this.client
    if (this.connecting === undefined) {
      this.connecting = this.connect()
    }
    try {
      await this.connecting
    } finally {
      this.connecting = undefined
    }
    if (this.client === undefined) throw new Error(`MCP server "${this.serverName}" failed to connect`)
    return this.client
  }

  private async connect(): Promise<void> {
    const transport = buildTransport(this.definition)
    const client = new Client({ name: 'corum-mcp-pool', version: '0.1.0' }, { capabilities: {} })
    // 建连期间进程就死掉的标记（见下方 await 之后的判断）。
    let diedDuringConnect = false
    transport.onclose = () => {
      // ⚠️ `handleDeath` 只在**已发布**的连接上生效；建连途中到达的关闭事件
      // 若直接交给它，会因 `this.client === undefined` 提前 return，随后 `connect()`
      // 反而把一个**已死**的 client 赋给 `this.client` —— 池从此抱着死连接，
      // 下一次调用必然 `Connection closed`（2026-11-23 windows-latest 实测：
      // 崩溃那一次调用成功、重连后的 echo 却报 -32000，正是这条路径）。
      if (this.transport === transport) { this.handleDeath('transport closed'); return }
      diedDuringConnect = true
      this.options.log('warn', `MCP pool: "${this.serverName}" transport closed during connect`)
    }
    transport.onerror = (error: unknown) => {
      this.options.log('warn', `MCP pool: transport error on "${this.serverName}": ${String(error)}`)
    }
    await client.connect(transport)
    // 建连期间已死 ⇒ 不发布这条连接，让下一个调用重新建（而不是复用死连接）。
    if (diedDuringConnect) throw new Error(`MCP server "${this.serverName}" closed while connecting`)
    this.client = client
    this.transport = transport
    const pid = transport instanceof StdioClientTransport ? transport.pid : null
    this.options.log('info', `MCP pool: connected "${this.serverName}"${pid !== null ? ` (pid ${pid})` : ''}`)
    await this.refreshTools(client)
  }

  /** 拉一次工具表；变了才广播（避免代理层无谓重注册）。 */
  private async refreshTools(client: Client): Promise<void> {
    const listed = await client.listTools()
    const next: McpPoolTool[] = (listed.tools ?? []).map(tool => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    }))
    const before = JSON.stringify(this.tools)
    this.tools = next
    if (JSON.stringify(next) === before) return
    for (const listener of this.toolListeners) {
      try {
        listener(next)
      } catch (error: unknown) {
        this.options.log('warn', `MCP pool: tools listener failed on "${this.serverName}": ${String(error)}`)
      }
    }
  }

  /**
   * 连接死亡：**只标记不注销工具**（瞬时崩溃不该把工具面从模型眼前抽走；下次调用会重连）。
   * 同时清掉租约——server 都没了，谁也不可能还在被它服务。
   */
  private handleDeath(reason: string): void {
    if (this.client === undefined && this.transport === undefined) return
    this.options.log('warn', `MCP pool: "${this.serverName}" connection died (${reason}) — will reconnect on the next call`)
    this.client = undefined
    this.transport = undefined
    this.holder = undefined
    this.handOff()
  }
}


/**
 * 宿主级池：`serverName → PooledServer`，按定义指纹判「是否需要换进程」。
 *
 * 不作为 cordis 服务注册（那是 `mcp-pool-service.ts` 的职责）；本类可在单测里直接用。
 */
export class McpPool {
  private readonly servers = new Map<string, PooledServer>()
  private readonly options: { leaseTimeoutMs: number; leaseTtlMs: number; stopGraceMs: number; log: (level: 'info' | 'warn', message: string) => void }
  private readonly resolveDefinition: (serverName: string) => McpServerConfig | undefined
  private disposed = false

  constructor(options: McpPoolOptions = {}) {
    const fromEnv = leaseTimeoutsFromEnv()
    const leaseTimeoutMs = options.leaseTimeoutMs ?? fromEnv.leaseTimeoutMs
    this.options = {
      leaseTimeoutMs,
      // ⚠️ 不要用 `leaseTimeoutMs * N` 推导 TTL（见 DEFAULT_LEASE_TTL_MS 的实机教训）。
      leaseTtlMs: options.leaseTtlMs ?? fromEnv.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      stopGraceMs: options.stopGraceMs ?? fromEnv.stopGraceMs,
      log: options.log ?? (() => {}),
    }
    this.resolveDefinition = options.resolve ?? (name => getServer(name))
  }

  /**
   * 取该服务名的池项（必要时建连接）。
   *
   * 定义指纹变了 ⇒ 销毁旧进程、按新定义重建（用户判据：改配置**不该**重启进程，除非定义本身变了）。
   */
  private serverFor(serverName: string): PooledServer {
    const definition = this.resolveDefinition(serverName)
    if (definition === undefined) throw new Error(`MCP server "${serverName}" is not in the registry`)
    // 停用的服务**不起进程**（注册表是唯一事实源；改 `disabled` 立即生效，不必重写 preset）。
    // 代理行会捕获并 warn、零工具，preset 照常挂载（fail-soft）。
    if (definition.disabled === true) throw new Error(`MCP server "${serverName}" is disabled in the registry`)
    const existing = this.servers.get(serverName)
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprintOf(definition)) return existing
      this.options.log('info', `MCP pool: definition of "${serverName}" changed — replacing its process`)
      this.servers.delete(serverName)
      void existing.dispose()
    }
    const created = new PooledServer(definition, this.options, () => {
      if (this.servers.get(serverName) === created) this.servers.delete(serverName)
    })
    this.servers.set(serverName, created)
    return created
  }

  /** 引用计数 +1（preset 代理行挂载时调用）；返回释放函数。 */
  retain(serverName: string): () => void {
    if (this.disposed) throw new Error('MCP pool is disposed')
    return this.serverFor(serverName).retain()
  }

  /** 工具表（原始名）。 */
  async listTools(serverName: string): Promise<readonly McpPoolTool[]> {
    return await this.serverFor(serverName).listTools()
  }

  /** 订阅工具表变更（重连后服务端动态改表也会广播）。 */
  onToolsChanged(serverName: string, listener: (tools: readonly McpPoolTool[]) => void): () => void {
    return this.serverFor(serverName).onToolsChanged(listener)
  }

  /** 独占调用（忙则排队 + 超时）。 */
  async callTool(
    serverName: string,
    tool: string,
    args: unknown,
    owner: McpLeaseOwner,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return await this.serverFor(serverName).callTool(tool, args, owner, options)
  }

  /** 取租约（代理层在需要跨多次调用持有时用；`callTool` 内部已自带）。 */
  async acquire(
    serverName: string,
    owner: McpLeaseOwner,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<() => void> {
    return await this.serverFor(serverName).acquire(owner, options)
  }

  /** 观测投影（UI/验收）。 */
  snapshot(): readonly McpPoolSnapshot[] {
    return [...this.servers.values()].map(server => server.snapshot())
  }

  /** 停掉全部连接（宿主退出时）。 */
  async disposeAll(): Promise<void> {
    this.disposed = true
    const all = [...this.servers.values()]
    this.servers.clear()
    await Promise.all(all.map(server => server.dispose()))
  }
}
