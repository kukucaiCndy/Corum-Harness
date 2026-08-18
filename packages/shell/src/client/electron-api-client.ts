/**
 * The desktop IPC API carrier: an AbstractApiClient subclass whose transport
 * is the preload `corumDesktop` bridge instead of fetch/WebSocket. Unary and
 * respond go through `unary()` (the main process runs the in-process fetch
 * handler, so zod validation and envelope wiring are identical to the browser
 * carrier); the mux/host streams are overridden to consume the IPC push
 * channel, framing exactly like the official SSE carrier (full ServerRequest
 * per frame, schema-parsed on arrival).
 * @module corum-shell/client/electron-api-client
 */

import {
  AbstractApiClient,
} from '@deepseek-ai/dsh-host-apiproxy/client'
import {
  serverRequestSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import {
  hostFrameSchema,
  muxFrameSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
  RpcRequest,
  ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { requireBridge } from './ipc-bridge.ts'

/** One pending read waiter on the stream frame queue. */
interface FrameWaiter {
  resolve(frame: ServerRequest): void
  reject(error: Error): void
}

/**
 * Bounded queue bridging the push channel to the async generator: frames
 * arriving with no active reader queue up; a reader with an empty queue waits.
 */
class FrameQueue {
  private readonly queue: ServerRequest[] = []
  private readonly waiters: FrameWaiter[] = []
  private error: Error | undefined
  private ended = false

  /** Push one frame; resolves the oldest waiter when one waits. */
  push(frame: ServerRequest): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve(frame)
    else this.queue.push(frame)
  }

  /** Fail every pending read (and future reads). */
  fail(error: Error): void {
    this.error = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  /** End the stream; pending and future reads settle as done. */
  end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined as unknown as ServerRequest)
  }

  /**
   * Read the next frame.
   * @returns the frame, or undefined when the stream ended.
   * @throws the stream failure when one was reported.
   */
  async next(): Promise<ServerRequest | undefined> {
    if (this.queue.length > 0) return this.queue.shift()
    if (this.error !== undefined) throw this.error
    if (this.ended) return undefined
    return new Promise<ServerRequest | undefined>((resolve, reject) => {
      this.waiters.push({
        resolve: (frame) => resolve(frame),
        reject,
      })
    })
  }
}

/**
 * The desktop transport client. The base class owns all protocol invariants;
 * this subclass supplies only the IPC aspects (unary transport + stream
 * openers).
 */
export class CorumElectronApiClient extends AbstractApiClient {
  protected override async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const pathname = new URL(input).pathname
    const body = typeof init?.body === 'string' ? init.body : undefined
    let result: { status: number; body: string }
    try {
      result = await requireBridge().unary(pathname, body)
    } catch (error) {
      console.error(`[corum-shell] unary ${pathname} IPC error:`, error)
      throw error
    }
    const { status, body: text } = result
    // 诊断（临时，排查 settings 服务消失用，解决后删除）：settings RPC 响应日志。
    if (pathname.includes('settings.')) {
      console.log(`[corum-shell] ${pathname} → status=${status} bodyLen=${text.length} body=${text.slice(0, 400)}`)
    }
    if (status !== 200) {
      console.warn(`[corum-shell] unary ${pathname} → ${status}: ${text.slice(0, 300)}`)
    }
    return new Response(text, { status })
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readIpcStream('mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readIpcStream('host', signal, hostFrameSchema, onOpen)
  }

  /**
   * IPC stream protocol path: open the stream, parse every pushed full
   * ServerRequest frame with the frame schema, tap, and yield the narrow
   * form — the same parse pipeline the official SSE carrier runs.
   */
  private async *readIpcStream<F extends MuxFrame | HostFrame>(
    kind: 'mux' | 'host',
    signal: AbortSignal,
    frameSchema: { parse(data: unknown): F },
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const bridge = requireBridge()
    const id = bridge.openStream(kind)
    const frames = new FrameQueue()
    let opened = false
    const markOpened = (): void => {
      if (opened) return
      opened = true
      onOpen?.()
    }
    const off = bridge.onStreamFrame((message) => {
      if (message.id !== id) return
      if (message.open === true || message.frame !== undefined) markOpened()
      if (message.frame !== undefined) frames.push(message.frame as ServerRequest)
    })
    const onAbort = (): void => frames.fail(new Error('stream aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        const full = await frames.next()
        if (full === undefined) return
        let frame: F
        try {
          const parsed = serverRequestSchema.parse(full)
          frame = frameSchema.parse(parsed.payload) as F
        } catch (error) {
          // One corrupt frame must not kill the stream; gap detection covers
          // whatever the frame carried.
          console.error('[corum-shell] dropping malformed IPC frame:', error)
          continue
        }
        this.onEnvelope(full)
        yield { rpcId: full.rpcId, payload: frame }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      off()
      bridge.closeStream(id)
    }
  }
}
