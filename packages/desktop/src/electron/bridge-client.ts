/**
 * Electron-main handle to the host bridge child process: spawns the bridge
 * under SYSTEM Node and parses its newline-delimited JSON protocol.
 *
 * Transport stance (0.1.2): the renderer talks to the host's own webserver
 * over loopback HTTP, so the bridge no longer relays unary/stream traffic.
 * The child reports one `ready` payload carrying the authenticatedUrl the
 * main `loadURL`s; the remaining stdio surface is the session-archive ops
 * (flush/export/import/delete) the shell triggers.
 * @module corum-desktop/electron/bridge-client
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One ready payload from the child: the authenticated loopback URL to load. */
export interface BridgeReady {
  /** The loopback URL with the process launch token; load this in the window. */
  authenticatedUrl: string
}

/** One session-archive op result (flush/export/import/delete). */
export interface SessionOpResult {
  ok: boolean
  error?: string
  flushed?: number
  zipBase64?: string
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
  private readyPromise!: Promise<BridgeReady>

  constructor(
    private readonly hostNode: string,
    private readonly bridgePath: string,
    private readonly injectedEnv?: Record<string, string>,
    private readonly cwd?: string,
  ) {
    this.spawn()
  }

  /** Spawn (or respawn) the host child and wire its stdout protocol. */
  private spawn(): void {
    this.readyPromise = new Promise<BridgeReady>((resolve) => {
      this.readyResolve = resolve
    })
    this.child = spawn(this.hostNode, [this.bridgePath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: this.injectedEnv ?? process.env,
      ...(this.cwd !== undefined && this.cwd !== '' ? { cwd: this.cwd } : {}),
    })
    this.child.on('error', (error) => {
      process.stderr.write(`corum-desktop host bridge spawn error: ${String(error)}\n`)
    })
    const readline = createInterface({ input: this.child.stdout! })
    readline.on('line', (line) => {
      this.onLine(line)
    })
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
  async restart(): Promise<BridgeReady> {
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

  /** Stop the child. */
  dispose(): void {
    // 先主动清掉全部 pending session op（同 restart 的 failAllPending）：子进程
    // 即将被 kill，这些请求永远等不到回复，不 resolve 会悬挂到超时（或 before-quit
    // 场景挂住退出）。failAllPending 只清 Map 并回调、不触碰子进程，与 kill 无
    // 依赖顺序；先 fail 再 kill 语义最干净（先让所有 op 失败，再杀进程）。
    this.failAllPending('host disposed')
    this.child.kill()
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
      this.readyState = message
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
