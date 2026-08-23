/**
 * The desktop connection loop: opens both logical streams and keeps iterating
 * (pull mode), reconnecting with exponential backoff on loss — the same
 * semantics as the official browser ConnectionController, so the runtime
 * object layer sees identical connect/reconnect behavior. The controller
 * faces only IApiClient and the frame sinks.
 * @module corum-desktop/client/connection-controller
 */

import type {
  HostFrame,
  MuxFrame,
  ResponseValue,
  RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'

/** Successful value returned by the connection-generation host handshake. */
export type CorumHostDescription = ResponseValue<'host.describe'>

/** Frame sink callbacks: the controller owns the physical streams; business dispatch belongs to the object layer. */
export interface CorumConnectionSinks {
  onMuxEnvelope?: (envelope: RpcRequest<MuxFrame>) => void
  onHostEnvelope?: (envelope: RpcRequest<HostFrame>) => void
  /** After each connection generation is established (both streams open + describe succeeded), first connect included. */
  onConnected?: (description: CorumHostDescription) => void
  /** Coarse state transitions (deduplicated: fires only on change). */
  onStateChange?: (state: ConnectionState) => void
}

/** Reconnect/backoff tunables; defaults match the official browser carrier. */
export interface CorumConnectionConfig {
  backoffBaseMs?: number
  backoffFactor?: number
  backoffMaxMs?: number
  streamOpenTimeoutMs?: number
}

const DEFAULTS: Required<CorumConnectionConfig> = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  streamOpenTimeoutMs: 3_000,
}

/** Coarse connection state for the UI. */
export type ConnectionState = 'connected' | 'reconnecting'

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/**
 * Open both streams and keep pumping with reconnect, feeding each frame to a
 * sink; state (generation/attempt) is instance-private. A sink throw is
 * isolated — a broken business layer must not drag down the connection.
 */
export class CorumConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  private running = false
  private lastState: ConnectionState | null = null
  private readonly config: Required<CorumConnectionConfig>

  constructor(
    private readonly api: IApiClient,
    private readonly sinks: CorumConnectionSinks = {},
    config: CorumConnectionConfig = {},
  ) {
    this.config = { ...DEFAULTS, ...config }
  }

  /** Idempotent: begin the connect/pump/reconnect loop. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  /** Stop the loop and abort the current generation's streams. */
  stop(): void {
    this.running = false
    this.current?.abort()
    this.current = null
  }

  private backoffDelay(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
    return cap / 2 + Math.random() * (cap / 2)
  }

  private isRunning(): boolean {
    return this.running
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const gen = ++this.generation
      const ac = new AbortController()
      this.current = ac

      let muxOpened = (): void => {}
      let hostOpened = (): void => {}
      const streamsOpen = Promise.all([
        new Promise<void>((resolve) => { muxOpened = resolve }),
        new Promise<void>((resolve) => { hostOpened = resolve }),
      ])

      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (gen === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        void this.pumpStream(this.api.events.mux({}, ac.signal, muxOpened), this.sinks.onMuxEnvelope, settle)
        void this.pumpStream(this.api.events.host({}, ac.signal, hostOpened), this.sinks.onHostEnvelope, settle)
      })

      try {
        // Strict readiness handshake: describe proves unary reachability and
        // each stream's onOpen proves it is established before onConnected.
        const timeout = new AbortController()
        const [description] = await Promise.all([
          this.api.host.describe({}),
          Promise.race([streamsOpen, sleep(this.config.streamOpenTimeoutMs, timeout.signal)]),
        ])
        timeout.abort()
        const descriptionResult = description.result
        if (!descriptionResult.ok) {
          throw new Error(`host.describe failed: ${descriptionResult.error.code}: ${descriptionResult.error.message}`)
        }
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        this.attempt = 0
        this.emitState('connected')
        if (this.isRunning() && !ac.signal.aborted) {
          this.callSink(() => { this.sinks.onConnected?.(descriptionResult.value) })
        }
      } catch {
        if (!ac.signal.aborted) ac.abort()
      }

      await failed
      if (!this.isRunning()) return
      this.emitState('reconnecting')
      this.attempt += 1
      console.warn(`[corum-desktop] connection lost, retry #${this.attempt}`)
      const idle = new AbortController()
      await sleep(this.backoffDelay(this.attempt), idle.signal)
    }
  }

  /** Deduplicated state emission (sink isolation applies). */
  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.callSink(() => this.sinks.onStateChange?.(state))
  }

  private async pumpStream<F extends { type: string }>(
    stream: AsyncIterable<RpcRequest<F>>,
    sink: ((envelope: RpcRequest<F>) => void) | undefined,
    onEnd: () => void,
  ): Promise<void> {
    try {
      for await (const envelope of stream) {
        if (envelope.payload.type === 'stream/error') break
        if (sink !== undefined) this.callSink(() => { sink(envelope) })
      }
    } catch {
      // Stream loss: converge on onEnd, which triggers the shared reconnect.
    }
    onEnd()
  }

  /** Sink exception isolation: a business-layer throw is logged only. */
  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[corum-desktop] connection sink threw:', error)
    }
  }
}
