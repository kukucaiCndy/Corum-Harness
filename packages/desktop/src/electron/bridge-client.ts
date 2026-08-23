/**
 * Electron-main handle to the host bridge child process: spawns the bridge
 * under SYSTEM Node, parses its newline-delimited JSON protocol, and exposes
 * the unary/stream surface the ipcMain handlers and protocol handler consume.
 * @module corum-desktop/electron/bridge-client
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** One ready payload from the child: the boot graph plus per-id bundle paths. */
export interface BridgeReady {
  graph: WebBootGraph
  clientPaths: Record<string, string>
}

interface UnaryPending {
  resolve(result: { status: number; body: string }): void
  reject(error: Error): void
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

/** The child's stdout message union. */
type ChildMessage =
  | { type: 'ready'; graph: WebBootGraph; clientPaths: Record<string, string> }
  | { type: 'result'; id: string; status: number; body: string }
  | { type: 'stream-open'; id: string }
  | { type: 'frame'; id: string; frame: unknown }
  | { type: 'hmr-rebuilt'; id: string; rev: string }
  | ({ type: 'session-op-result'; id: string } & SessionOpResult)
  | { type: 'error'; message: string }

/** Frame listener for one open stream. */
export interface StreamFrameListener {
  (frame: unknown): void
}

/** HMR rebuilt-event listener (renderer hot-reload driver relay). */
export interface HmrListener {
  (id: string, rev: string): void
}

/** Ready-state listener, fired on the first spawn and every restart. */
export interface ReadyListener {
  (ready: BridgeReady): void
}

/**
 * The Electron main's bridge to the host child process. On construction it
 * spawns the child; `ready()` resolves once the child reports its graph.
 */
export class HostBridgeClient {
  private child!: ReturnType<typeof spawn>
  private readonly pendingUnary = new Map<string, UnaryPending>()
  private readonly pendingSessionOp = new Map<string, (result: SessionOpResult) => void>()
  private readonly streamListeners = new Map<string, Set<StreamFrameListener>>()
  private readonly hmrListeners = new Set<HmrListener>()
  private readonly readyListeners = new Set<ReadyListener>()
  private readonly openStreams = new Map<string, 'mux' | 'host'>()
  private readyState: BridgeReady | undefined
  private readyResolve: ((ready: BridgeReady) => void) | undefined
  private readyPromise!: Promise<BridgeReady>
  private restarting = false

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
    // Reject the previous generation's still-pending unaries so their awaiters
    // never hang across a respawn (the ready handshake re-registers nothing).
    const stale = [...this.pendingUnary.values()]
    this.pendingUnary.clear()
    for (const pending of stale) pending.reject(new Error('host bridge respawned'))
    this.child = spawn(this.hostNode, [this.bridgePath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: this.injectedEnv ?? process.env,
      ...(this.cwd !== undefined && this.cwd !== '' ? { cwd: this.cwd } : {}),
    })
    this.child.on('error', (error) => {
      for (const pending of this.pendingUnary.values()) pending.reject(error)
      this.pendingUnary.clear()
    })
    const readline = createInterface({ input: this.child.stdout! })
    readline.on('line', (line) => {
      this.onLine(line)
    })
  }

  /** Resolves with the boot graph once the child reports ready. */
  ready(): Promise<BridgeReady> {
    return this.readyPromise
  }

  /** The ready payload (undefined before the child reports). */
  get graph(): BridgeReady | undefined {
    return this.readyState
  }

  /**
   * Hot-restart the host child: kill the current process and respawn it in
   * place. In-flight unaries are rejected (their callers retry against the
   * new generation); open streams are re-established once the new child is
   * ready. The Electron window and the renderer page stay up — only the host
   * process (and its in-memory session loop) cycles. Session state persists
   * under CORUM_HOME, so the renderer reconnects to recoverable history.
   * @returns the new generation's ready payload.
   */
  async restart(): Promise<BridgeReady> {
    if (this.restarting) return this.readyPromise
    this.restarting = true
    try {
      this.child.kill()
      this.readyState = undefined
      this.spawn()
      const ready = await this.readyPromise
      // Re-establish the renderer's logical streams on the new generation.
      for (const [id, kind] of this.openStreams) {
        this.child.stdin!.write(`${JSON.stringify({ type: 'stream-open', id, kind })}\n`)
      }
      return ready
    } finally {
      this.restarting = false
    }
  }

  /** Run one unary request through the child bridge. */
  unary(pathname: string, body?: string): Promise<{ status: number; body: string }> {
    const id = crypto.randomUUID()
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      this.pendingUnary.set(id, { resolve, reject })
    })
    this.child.stdin!.write(`${JSON.stringify({ type: 'unary', id, pathname, ...body === undefined ? {} : { body } })}\n`)
    return result
  }

  /** Flush every live session's buffered log to durable storage (quit hook). */
  sessionFlush(): Promise<SessionOpResult> {
    return this.sessionOp({ type: 'session-flush' })
  }

  /** Export one session's log ZIP (returned base64). */
  sessionExport(sessionId: string): Promise<SessionOpResult> {
    return this.sessionOp({ type: 'session-export', sessionId })
  }

  /** Import one exported log ZIP (base64). */
  sessionImport(zipBase64: string): Promise<SessionOpResult> {
    return this.sessionOp({ type: 'session-import', zipBase64 })
  }

  /** Physically delete one session (refused by the host while it is running). */
  sessionDelete(sessionId: string): Promise<SessionOpResult> {
    return this.sessionOp({ type: 'session-delete', sessionId })
  }

  /** Shared session-op dispatch. */
  private sessionOp(request: Record<string, unknown>): Promise<SessionOpResult> {
    const id = crypto.randomUUID()
    const result = new Promise<SessionOpResult>((resolve) => {
      this.pendingSessionOp.set(id, resolve)
    })
    this.child.stdin!.write(`${JSON.stringify({ ...request, id })}\n`)
    return result
  }

  /** Open one logical stream under the given id (frames arrive via onStreamFrame). */
  openStream(id: string, kind: 'mux' | 'host'): void {
    this.openStreams.set(id, kind)
    this.child.stdin!.write(`${JSON.stringify({ type: 'stream-open', id, kind })}\n`)
  }

  /** Close one logical stream. */
  closeStream(id: string): void {
    this.openStreams.delete(id)
    this.streamListeners.delete(id)
    this.child.stdin!.write(`${JSON.stringify({ type: 'stream-close', id })}\n`)
  }

  /** Subscribe to one stream's frames; returns the unsubscriber. */
  onStreamFrame(id: string, listener: StreamFrameListener): () => void {
    let set = this.streamListeners.get(id)
    if (set === undefined) {
      set = new Set()
      this.streamListeners.set(id, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.streamListeners.delete(id)
    }
  }

  /** Subscribe to dev HMR rebuilt events; returns the unsubscriber. */
  onHmr(listener: HmrListener): () => void {
    this.hmrListeners.add(listener)
    return () => { this.hmrListeners.delete(listener) }
  }

  /** Subscribe to ready (initial spawn + every restart); returns the unsubscriber. */
  onReady(listener: ReadyListener): () => void {
    this.readyListeners.add(listener)
    return () => { this.readyListeners.delete(listener) }
  }

  /** Stop the child and reject every in-flight unary. */
  dispose(): void {
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
    } else if (message.type === 'result') {
      const pending = this.pendingUnary.get(message.id)
      if (pending === undefined) return
      this.pendingUnary.delete(message.id)
      pending.resolve({ status: message.status, body: message.body })
    } else if (message.type === 'frame') {
      for (const listener of this.streamListeners.get(message.id) ?? []) listener(message.frame)
    } else if (message.type === 'hmr-rebuilt') {
      for (const listener of [...this.hmrListeners]) listener(message.id, message.rev)
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
