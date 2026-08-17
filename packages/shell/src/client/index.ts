/**
 * corum-shell client half: provides `ctx.connection` over the corumDesktop IPC
 * bridge, replacing the official browser connection carrier. The runtime
 * object layer injects `connection` and sees the identical handle shape (api,
 * isLoopback, hostDescription, rpc, start) — nothing else in the client tree
 * changes.
 * @module corum-shell/client
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  RpcId,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  serverResponseSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type {
  ResponseValue,
  RpcResult,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { CorumElectronApiClient } from './electron-api-client.ts'
import {
  CorumConnectionController,
  type CorumConnectionSinks,
  type ConnectionState,
} from './connection-controller.ts'
import { requireBridge } from './ipc-bridge.ts'
import * as hmr from './hmr.ts'
// Type-only: pulls the `ctx.slots` Context merge (declared by client-runtime).
import type {} from '@deepseek-ai/dsh-client-runtime/client'

/** Required services: none — this is the wire root; the code-editor view registers lazily below. */
export const inject: string[] = []

/** Successful value returned by the connection-generation host handshake. */
export type HostDescription = ResponseValue<'host.describe'>

/** Observable Host description published by each completed connection handshake. */
export interface CorumHostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Generic logical RPC channel over the same desktop transport. */
export interface CorumRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
}

/** The ctx.connection service shape the runtime object layer consumes. */
export interface CorumConnectionHandle {
  /** Shared api client (desktop IPC carrier). */
  readonly api: IApiClient
  /** The desktop renderer is always the host's own surface. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: CorumHostDescriptionSource
  /** Generic logical RPC channels over the same transport. */
  readonly rpc: CorumRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: CorumConnectionSinks, config?: {
    backoffBaseMs?: number
    backoffFactor?: number
    backoffMaxMs?: number
    streamOpenTimeoutMs?: number
  }): { stop(): void }
}

/** Generic RPC caller over the desktop bridge (mirrors the browser carrier's). */
function createCorumRpc(): CorumRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      const rpcId = RpcId(crypto.randomUUID())
      const message = {
        type: 'client-request' as const,
        rpcId,
        method: endpoint,
        payload,
      }
      const { status, body } = await requireBridge().unary(`${channel}/${endpoint}`, JSON.stringify(message))
      if (signal?.aborted === true) throw new Error(`transport failure for ${channel}/${endpoint}: aborted`)
      if (status !== 200) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${status}`)
      const full = serverResponseSchema.parse(JSON.parse(body))
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

/**
 * Client plugin body: provide ctx.connection over the desktop IPC carrier.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const api = new CorumElectronApiClient()
  const rpc = createCorumRpc()
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[corum-shell] host-description listener threw:', error)
      }
    }
  }
  const handle: CorumConnectionHandle = {
    api,
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new CorumConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop; do not
          // leak a stale connected notification to the consumer afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state: ConnectionState) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)

  // The resident Monaco editor is parked for S0: the whole IDE frame is test
  // modules, and the shell fills `corum.editor` with a self-identifying test
  // card (see @corum/ide-shell's S0 test modules). EditorColumn stays in the
  // tree (Monaco worker/protocol/bundle infrastructure is unchanged) and
  // re-registers into `corum.editor` at S1, when @corum/ide-editor takes the
  // column over from the test card.

  // Dev HMR: mount the hot-reload driver once the client module system and
  // the vendored Loader are available. Gated on the preload's HMR surface so
  // a production build (no CORUM_DEV_HMR, no onHmrEvent) never activates it.
  if (typeof window !== 'undefined' && window.corumDesktop?.onHmrEvent !== undefined) {
    ctx.inject(['modules', 'loader'], (hmrCtx) => {
      hmr.apply(hmrCtx)
    })
  }
}
