/**
 * Electron-main handle to the host bridge child process: spawns the bridge
 * under SYSTEM Node and parses its newline-delimited JSON protocol.
 *
 * Transport stance (0.1.2): the renderer talks to the host's own webserver
 * over loopback HTTP, so the bridge no longer relays unary/stream traffic.
 * The child reports one `ready` payload carrying the authenticatedUrl the
 * main `loadURL`s; the remaining stdio surface is the session-archive ops
 * (flush/export/batch-export/import/delete) the shell triggers.
 * @module corum-desktop/electron/bridge-client
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One ready payload from the child: the authenticated loopback URL to load. */
export interface BridgeReady {
  /** The loopback URL with the process launch token; load this in the window. */
  authenticatedUrl: string
}

/** One session-archive op result (flush/export/batch-export/import/delete). */
export interface SessionOpResult {
  ok: boolean
  error?: string
  flushed?: number
  zipBase64?: string
  /** Ids a batch export could not build (their entries were skipped). */
  failed?: string[]
  imported?: string[]
  skipped?: string[]
  deleted?: boolean
  wasLive?: boolean
}

/** Import payload ceiling: 96 MiB of base64 ≈ 64 MiB of raw ZIP. Larger imports are refused at the entry. */
const MAX_IMPORT_BASE64_LENGTH = 96 * 1024 * 1024

/** Default session-op timeout (export/import/delete). */
const SESSION_OP_TIMEOUT_MS = 30_000

/** Quit-flush timeout: shorter, so before-quit cannot hang the exit forever. */
const SESSION_FLUSH_TIMEOUT_MS = 10_000

/** The child's stdout message union. */
type ChildMessage =
  | { type: 'ready'; authenticatedUrl: string }
  | ({ type: 'session-op-result'; id: string } & SessionOpResult)
  | { type: 'error'; message: string }

/** Ready-state listener, fired on the first spawn and every restart. */
export interface ReadyListener {
  (ready: BridgeReady): void
}

/**
 * 运行期 host 退出（**已 ready 之后**）的观察者。
 *
 * 为什么需要这一层（2026-11-21 用户实测两次「界面卡住、发什么都报
 * `client api: session/cancel failed: Failed to fetch (gateway/internal)`」）：
 * 在此之前 `child.on('exit')` 只处理「ready 之前」的失败 —— 一旦进入 ready，
 * host 之后**任何**方式的死亡都被完全忽略（不记日志、不重启、不清 readyPayload）。
 * 渲染端于是继续对着一个没有任何进程在监听的 loopback 端口发 RPC，每个请求都被
 * gateway 折成 `carrierFailure`（`client api: <endpoint> failed: Failed to fetch`）
 * 并写进会话的 promptError；而 `running` 是 durable snapshot 派的，host 不在就
 * 永远不更新 ⇒ 输入框一直锁在「停止生成」，用户既发不出去也停不下来。
 *
 * 会话日志给出的死亡时刻（`turn/end.reason.kind === 'interrupted'` 是崩溃恢复的
 * **合成闭合事件**，时间戳取最后一条 durable 事件，即真正的断气时刻）：
 * 19:41:39 与 22:16:04，两次都发生在子 Agent 相关的 tool/call 之后，恢复分别在
 * 19:53:26 与 22:33:48 —— 中间 11~17 分钟界面完全处于上述状态。
 */
export interface ExitListener {
  /**
   * @param exit - 子进程退出的 code/signal 与它当时的代数（用于排除竞态）。
   */
  (exit: HostExit): void
}

/** One post-ready host death. */
export interface HostExit {
  /** Exit code reported by Node (null when killed by a signal). */
  code: number | null
  /** Terminating signal, when one is known. */
  signal: string | null
  /** 第几次运行期退出（1 = 第一次）。自动重启据此退避。 */
  attempt: number
  /** Whether the supervisor decided to respawn the child. */
  restarting: boolean
}

/** 运行期自动重启的退避阶梯（毫秒）；用尽后进入给定间隔的稳态重试。 */
const EXIT_BACKOFF_MS = [500, 1_500, 4_000, 10_000, 20_000] as const
/** 稳态重试间隔：host 持续崩时不要打满 CPU，也不能放弃（用户可能只是临时缺资源）。 */
const EXIT_STEADY_RETRY_MS = 30_000

/** host.log 的滚动阈值与保留代数（保留 1 代 .1 备份）。 */
const HOST_LOG_MAX_BYTES = 8 * 1024 * 1024

/**
 * The Electron main's bridge to the host child process. On construction it
 * spawns the child; `ready()` resolves once the child reports its
 * authenticatedUrl.
 */
export class HostBridgeClient {
  private child!: ReturnType<typeof spawn>
  private readonly pendingSessionOp = new Map<string, (result: SessionOpResult) => void>()
  private readonly readyListeners = new Set<ReadyListener>()
  private readyState: BridgeReady | undefined
  private readyResolve: ((ready: BridgeReady) => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private readyPromise!: Promise<BridgeReady>
  private readyTimer: ReturnType<typeof setTimeout> | undefined
  private readonly exitListeners = new Set<ExitListener>()
  /** 运行期退出的累计次数（本实例生命周期内），用于退避与日志代数。 */
  private exitCount = 0
  /** 重启定时器与「已排期待重启」标记：同一时刻只挂一次重启。 */
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private restartPending = false
  /** 主动停止（dispose / restart）：此后所有退出都不得触发自动重启。 */
  private disposed = false
  /** 本次退出由 `restart()` 自己认领（见 restart 的注释），自动重启必须让开。 */
  private restartClaimed = false
  /** 实例级 host.log 写入流（跨 spawn/自动重启复用，见 pipeStderr）。 */
  #logSink: ReturnType<typeof createWriteStream> | undefined

  constructor(
    private readonly hostNode: string,
    private readonly bridgePath: string,
    private readonly injectedEnv?: Record<string, string>,
    private readonly cwd?: string,
    // ⚠️ 位置参数一经公开就被测试与调用方按序使用（tests/startup.test.mjs 传第 5 个
    // 参数 = readyTimeoutMs）。新增能力必须**追加在末尾**，不能插队——插队会让
    // `new HostBridgeClient(n, e, undefined, undefined, 100)` 的 100 被当成别的类型，
    // 超时静默退回默认值（2026-11-22 本轮实测：那条用例当场变红）。
    private readonly readyTimeoutMs = 60_000,
    /**
     * host 子进程 stderr 的落盘路径（通常是 `<home>/run/host.log`）。
     *
     * 为什么必须落盘（2026-11-21）：此前 stderr 是 `'inherit'`，而 Electron main
     * 由 launchd 拉起时 **0/1/2 全部指向 /dev/null**（实测 `lsof -p <pid>`）——
     * 于是 host 侧 `installFailLoud` 写出的那段致命诊断（未捕获异常/拒绝的完整
     * 对象，是 host 唯一的死因记录）**没有任何人看得到**。两次「界面卡住」我只能
     * 从会话日志反推出死亡时刻（19:41:39 / 22:16:04），却查不到原因。
     * 缺省 undefined = 保持旧行为（测试与极简调用方不必落盘）。
     */
    private readonly stderrLogPath?: string,
  ) {
    this.spawn()
  }

  /** Spawn (or respawn) the host child and wire its stdout protocol. */
  private spawn(): void {
    this.readyPromise = new Promise<BridgeReady>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    const child = spawn(this.hostNode, [this.bridgePath], {
      // stderr 走管道而非 inherit（见构造参数 stderrLogPath 的注释）：
      // 'inherit' 在 launchd 拉起的打包态里等于丢进 /dev/null。
      stdio: ['pipe', 'pipe', this.stderrLogPath === undefined ? 'inherit' : 'pipe'],
      env: this.injectedEnv ?? process.env,
      // Windows 后台化：node.exe 是控制台子系统程序，父进程（Electron GUI，
      // 无控制台）拉起时会新开一个可见黑框；CREATE_NO_WINDOW 让它无窗口运行。
      // 非 Windows 平台忽略此选项，故无需按平台分支（三平台同代码）。
      windowsHide: true,
      ...(this.cwd !== undefined && this.cwd !== '' ? { cwd: this.cwd } : {}),
    })
    this.child = child
    this.pipeStderr(child)
    let failed = false
    const failStartup = (error: Error) => {
      if (child !== this.child || this.readyState !== undefined || failed) return
      failed = true
      clearTimeout(this.readyTimer)
      this.readyReject?.(error)
    }
    this.readyTimer = setTimeout(() => {
      failStartup(new Error('后台启动超时，请重试启动并查看启动日志。'))
      child.kill()
    }, this.readyTimeoutMs)
    child.on('error', (error) => {
      process.stderr.write(`corum-desktop host bridge spawn error: ${String(error)}\n`)
      failStartup(error)
    })
    child.on('exit', (code, signal) => {
      if (child !== this.child) return
      // ready 之前退出 = 启动失败（原有语义，保持不改）。
      if (this.readyState === undefined) {
        failStartup(new Error(`后台启动失败：进程提前退出（code ${String(code)}${signal === null ? '' : `, signal ${signal}`}），请查看启动日志。`))
        return
      }
      this.onHostExit(code, signal)
    })
    const readline = createInterface({ input: this.child.stdout! })
    readline.on('line', (line) => {
      if (child === this.child && !failed) this.onLine(line)
    })
  }

  /**
   * 把子进程的 stderr 同时送到两处：**落盘**（诊断的唯一长期载体）与
   * **本进程 stderr**（dev 态终端仍要看得到）。
   *
   * 落盘失败不能影响 host 运行：整个管道是 best-effort，出错就退回只转发，
   * 绝不让「日志写不进去」把宿主拖死（这条路径在启动最早期，任何抛出都会
   * 变成一次静默的启动失败）。
   *
   * 写入流是**实例级**的（`#logSink`）：本方法会被每次 spawn/自动重启重入，
   * 每次都开新流会让 fd 随重启次数线性泄漏（host 可能一天重启几十次）。
   * @param child - 刚 spawn 的子进程。
   */
  private pipeStderr(child: ReturnType<typeof spawn>): void {
    const stream = child.stderr
    if (stream === null || stream === undefined) return
    const sink = this.openLogSink()
    if (sink !== undefined) this.writeLogBanner(sink)
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      // 本进程 stderr：dev 态直通终端；打包态本来就没有消费者，但保持旧行为不变。
      process.stderr.write(chunk)
      this.#logSink?.write(chunk)
    })
    stream.on('error', () => { /* 管道读失败：host 自己的退出事件会接着报告 */ })
  }

  /**
   * 懒开（并按大小滚动）实例级的日志写入流；打不开就返回 undefined，
   * 后续 stderr 只走终端转发，绝不因此阻断宿主。
   * @returns the append sink, or undefined when logging is unavailable.
   */
  private openLogSink(): ReturnType<typeof createWriteStream> | undefined {
    if (this.stderrLogPath === undefined) return undefined
    if (this.#logSink !== undefined) return this.#logSink
    try {
      const path = this.stderrLogPath
      mkdirSync(dirname(path), { recursive: true })
      // 滚动：超过阈值就留一代 .1 备份再重开（host 的日志会跨多次重启累积）。
      try {
        if (existsSync(path) && statSync(path).size > HOST_LOG_MAX_BYTES) {
          renameSync(path, `${path}.1`)
        }
      } catch { /* 滚动失败不阻塞写入 */ }
      const sink = createWriteStream(path, { flags: 'a' })
      // 写入失败（磁盘满/权限变化）：放弃这个 sink，别让管道继续对着死流写。
      sink.on('error', () => { if (this.#logSink === sink) this.#logSink = undefined })
      this.#logSink = sink
      return sink
    } catch {
      return undefined
    }
  }

  /**
   * 写一条分隔横幅，让 `host.log` 里能分清「哪一段属于哪一次启动」。
   *
   * 只写**已知**事实：时间戳与第几次启动。子进程 pid 在这个位置还没拿到
   * （`spawn` 的返回值要到调用处才可见），写一个猜的值会让排障时对错进程 ——
   * 所以不写 pid，而不是写 `pid=?` 这种占位。
   * @param sink - 日志写入流。
   */
  private writeLogBanner(sink: ReturnType<typeof createWriteStream>): void {
    sink.write(
      `\n===== host spawn ${new Date().toISOString()} (generation ${String(this.exitCount + 1)}) =====\n`,
    )
  }

  /**
   * 运行期 host 退出的唯一处理点：记日志 → 清掉「已 ready」的假象 → 通知观察者
   * → 排一次自动重启。
   *
   * `readyPayload` 必须在这里清掉：它是渲染端与 IPC 侧判断「host 还在」的依据
   * （`ipc.ts` 用它构造 baseUrl，session archive 各 op 也直接用它）。不清就等于
   * 让整个外壳继续用一个已死的 loopback URL。
   * @param code - 退出码（被信号杀死时为 null）。
   * @param signal - 终止信号名。
   */
  private onHostExit(code: number | null, signal: string | null): void {
    // 主动 restart() 认领了这次退出：它已经自己 spawn 了新子进程，这里只记一笔。
    if (this.restartClaimed) {
      this.restartClaimed = false
      process.stderr.write(
        `corum-desktop host bridge stopped for a requested restart: code=${String(code)}`
        + `${signal === null ? '' : ` signal=${signal}`}\n`,
      )
      return
    }
    this.exitCount += 1
    const attempt = this.exitCount
    // 先把「已 ready」的假象清掉，再算重启策略：观察者在回调里读 readyPayload
    // 时必须已经看到 undefined。
    this.readyState = undefined
    clearTimeout(this.readyTimer)
    this.failAllPending('host exited')
    const restarting = !this.disposed
    process.stderr.write(
      `corum-desktop host bridge exited after ready: code=${String(code)}`
      + `${signal === null ? '' : ` signal=${signal}`} (occurrence ${String(attempt)}, `
      + `${restarting ? 'respawning' : 'not respawning (shell shutting down)'})\n`,
    )
    for (const listener of [...this.exitListeners]) {
      try {
        listener({ code, signal, attempt, restarting })
      } catch (error) {
        // 观察者异常绝不能打断重启链（它是这条链上唯一的恢复手段）。
        process.stderr.write(`corum-desktop host exit listener threw: ${String(error)}\n`)
      }
    }
    if (restarting) this.scheduleRestart(attempt)
  }

  /**
   * 排一次自动重启，按发生次数退避。
   *
   * 为什么是**自动**重启而不是弹一个「请手动重启」：host 的死亡对用户完全不可见
   * （没有崩溃对话框，窗口还在），手动路径等于要求用户去杀应用。而 host 是
   * 可重建的（会话状态都在 `CORUM_HOME` 磁盘上），重启后 `onReady` 会 loadURL，
   * 页面连同连接一起恢复 —— 这正是用户此前**手动**重启应用才能达到的状态，
   * 现在由外壳自己完成。
   * @param attempt - 第几次运行期退出（1 起）。
   */
  private scheduleRestart(attempt: number): void {
    if (this.disposed || this.restartPending) return
    // 阶梯走完后落到稳态间隔（不是一直停在最后一档）：前几次崩溃要快速恢复
    // （多半是一次偶发故障），持续崩溃则必须放慢，否则会变成一个每 20s 一轮的
    // 崩溃-重启循环，把 CPU 与 host.log 一起拖垮。
    const delay = attempt <= EXIT_BACKOFF_MS.length
      ? EXIT_BACKOFF_MS[attempt - 1] as number
      : EXIT_STEADY_RETRY_MS
    this.restartPending = true
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.restartPending = false
      if (this.disposed) return
      process.stderr.write(`corum-desktop host bridge: respawning after exit #${String(attempt)}\n`)
      this.spawn()
    }, delay)
    // 重启定时器必须让进程能退出（before-quit 期间不能因为一个挂着的 timer 卡住）。
    this.restartTimer.unref?.()
  }

  /** Resolves with the authenticatedUrl once the child reports ready. */
  ready(): Promise<BridgeReady> {
    return this.readyPromise
  }

  /** The ready payload (undefined before the child reports). */
  get readyPayload(): BridgeReady | undefined {
    return this.readyState
  }

  /**
   * Hot-restart the host child: kill the current process and respawn it in
   * place. The Electron window and the renderer page stay up — only the host
   * process (and its in-memory session loop) cycles; the renderer's own
   * connection loop reconnects to the new webserver. Session state persists
   * under CORUM_HOME.
   * @returns the new generation's ready payload (a fresh authenticatedUrl).
   */
  /**
   * 主动重启（combo 切换 / 插件装好后提示重启 / 开发者工具触发）。
   *
   * 必须与运行期自动重启互斥：这里会 kill 旧子进程并**自己**再 spawn 一次，
   * 而那次 kill 也会触发 `child.on('exit')` ⇒ 若不拦住，自动重启会再挂一个
   * 定时器，两个子进程抢同一个 home（`reapStaleHost` 会把对方当孤儿收掉，
   * 表现为「重启后随机起不来」）。所以先立 `restartClaimed`，让那一次 exit
   * 只记日志、不排重启，随后由本方法独占下一次 spawn。
   * @returns the new generation's ready payload (a fresh authenticatedUrl).
   */
  async restart(): Promise<BridgeReady> {
    clearTimeout(this.readyTimer)
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.restartPending = false
    this.restartClaimed = true
    this.child.kill()
    this.readyState = undefined
    // 清掉旧一代的全部 pending session op：子进程已死，这些请求永远等不到
    // 回复，不 resolve 会悬挂到超时（或 before-quit 场景挂住退出）。
    this.failAllPending('host restarted')
    this.spawn()
    return this.readyPromise
  }

  /** Flush every live session's buffered log to durable storage (quit hook). */
  sessionFlush(): Promise<SessionOpResult> {
    // 较短超时：before-quit 路径不能因子进程无响应而永久挂住退出。
    return this.sessionOp({ type: 'session-flush' }, SESSION_FLUSH_TIMEOUT_MS)
  }

  /** Export one session's log ZIP (returned base64). */
  sessionExport(sessionId: string): Promise<SessionOpResult> {
    return this.sessionOp({ type: 'session-export', sessionId })
  }

  /**
   * Export several sessions' logs into ONE zip (returned base64). Each
   * member is that session's own export zip, so the file imports per-member.
   * A per-session build failure skips its member and is reported in
   * `failed` rather than refusing the whole batch.
   */
  sessionExportBatch(sessionIds: readonly string[]): Promise<SessionOpResult> {
    return this.sessionOp({ type: 'session-export-batch', sessionIds: [...sessionIds] })
  }

  /** Import one exported log ZIP (base64). */
  sessionImport(zipBase64: string): Promise<SessionOpResult> {
    // 入口大小上限：超长 payload 直接拒绝，不发往子进程（base64 膨胀 + 子进程
    // 解压双重内存放大）。
    if (zipBase64.length > MAX_IMPORT_BASE64_LENGTH) {
      return Promise.resolve({ ok: false, error: 'import payload too large' })
    }
    return this.sessionOp({ type: 'session-import', zipBase64 })
  }

  /** Physically delete one session (refused by the host while it is running). */
  sessionDelete(sessionId: string): Promise<SessionOpResult> {
    return this.sessionOp({ type: 'session-delete', sessionId })
  }

  /** Shared session-op dispatch (timeout-guarded). */
  private sessionOp(request: Record<string, unknown>, timeoutMs = SESSION_OP_TIMEOUT_MS): Promise<SessionOpResult> {
    if (typeof request.type !== 'string') {
      // 防御：类型本由 TS 保证，这里只断言存在性，避免发出无 type 的帧。
      return Promise.resolve({ ok: false, error: 'bad session op request' })
    }
    const id = crypto.randomUUID()
    const result = new Promise<SessionOpResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingSessionOp.delete(id)) return // 已被正常回复/restart 清掉
        resolve({ ok: false, error: 'session op timed out' })
      }, timeoutMs)
      this.pendingSessionOp.set(id, (opResult) => {
        clearTimeout(timer)
        resolve(opResult)
      })
    })
    this.child.stdin!.write(`${JSON.stringify({ ...request, id })}\n`)
    return result
  }

  /** Fail every pending session op (restart / child death): no reply will ever arrive. */
  private failAllPending(error: string): void {
    for (const pending of this.pendingSessionOp.values()) pending({ ok: false, error })
    this.pendingSessionOp.clear()
  }

  /** Subscribe to ready (initial spawn + every restart); returns the unsubscriber. */
  onReady(listener: ReadyListener): () => void {
    this.readyListeners.add(listener)
    return () => { this.readyListeners.delete(listener) }
  }

  /**
   * Subscribe to post-ready host deaths (including the shell's own automatic
   * respawn decision); returns the unsubscriber.
   * @param listener - called once per runtime exit, before the respawn timer is armed.
   * @returns the unsubscriber.
   */
  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }

  /** Stop the child and cancel every pending automatic respawn. */
  dispose(): void {
    this.disposed = true
    clearTimeout(this.readyTimer)
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.restartPending = false
    // 先主动清掉全部 pending session op（同 restart 的 failAllPending）：子进程
    // 即将被 kill，这些请求永远等不到回复，不 resolve 会悬挂到超时（或 before-quit
    // 场景挂住退出）。failAllPending 只清 Map 并回调、不触碰子进程，与 kill 无
    // 依赖顺序；先 fail 再 kill 语义最干净（先让所有 op 失败，再杀进程）。
    this.failAllPending('host disposed')
    this.child.kill()
    // 关掉实例级日志流：否则 before-quit 之后 fd 仍开着，进程可能迟迟不退出。
    try { this.#logSink?.end() } catch { /* 关闭失败不影响退出 */ }
    this.#logSink = undefined
  }

  private onLine(line: string): void {
    if (line.trim() === '') return
    let message: ChildMessage
    try {
      message = JSON.parse(line) as ChildMessage
    } catch {
      return
    }
    if (message.type === 'ready') {
      clearTimeout(this.readyTimer)
      this.readyState = message
      // 新一代已经健康起来：清掉「认领」标记，后续死亡重新走自动重启路径。
      this.restartClaimed = false
      this.readyResolve?.(message)
      for (const listener of [...this.readyListeners]) listener(message)
    } else if (message.type === 'session-op-result') {
      const pending = this.pendingSessionOp.get(message.id)
      if (pending === undefined) return
      this.pendingSessionOp.delete(message.id)
      const { type: _type, id: _id, ...result } = message
      pending(result)
    } else if (message.type === 'error') {
      process.stderr.write(`corum-desktop host bridge error: ${message.message}\n`)
    }
  }
}

/** Absolute path of the built bridge entry (lib/bridge.js beside this bundle). */
export const BRIDGE_PATH = fileURLToPath(new URL('../bridge.js', import.meta.url))

/** Resolve the bridge entry relative to the built electron bundle directory. */
export function resolveBridgePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'bridge.js')
}
