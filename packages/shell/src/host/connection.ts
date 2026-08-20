/**
 * @corum-shell/connection — desktop IPC bridge (host half). Wraps the host's
 * ApiProxy behind the same wire contract the browser /api route served:
 * unary and respond requests go through the in-process fetch handler (the
 * isomorphic point, so zod validation and envelope wiring are identical), and
 * the mux/host event streams are iterated directly and framed as full
 * ServerRequest messages for the renderer. Provides the `corumDesktopConnection`
 * service the Electron main registers its ipcMain handlers against.
 *
 * Security stance: the IPC channel is the trust boundary — only this app's
 * own renderer reaches it. The browser /api route's loopback fence does not
 * apply (there is no Origin); the privileged-method gate is a v1 deferred
 * hardening (a compromised renderer would have the same host access a
 * loopback browser tab has today).
 * @module corum-shell/connection
 */

import { randomUUID } from 'node:crypto'
import { readdir, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  RpcId,
  toFetchHandler,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {
  HostFrame,
  MuxFrame,
  RpcRequest,
  ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The desktop IPC transport bridge (provided by this plugin). */
    corumDesktopConnection: CorumDesktopConnection
  }
}

/** Frame stream kind the renderer can open. */
export type CorumStreamKind = 'mux' | 'host'

/** corum 自有目录浏览 RPC 路径（资源管理器文件树的数据源，非官方 /api 路由）。 */
const CORUM_FS_LIST_PATH = 'corum.fs.list'

/** rpc.call('corum.fs', 'list') 拼出的路径形态。 */
const CORUM_FS_LIST_PATH_SLASH = 'corum.fs/list'

/** Unary bridge result: HTTP status plus the response body text. */
export interface CorumUnaryResult {
  status: number
  body: string
}

/** Complete a narrow frame into the ServerRequest full form (same as the SSE carrier). */
function fullFrame(narrow: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: narrow.rpcId,
    method: narrow.payload.type,
    payload: narrow.payload,
  }
}

/**
 * The desktop transport service: unary/respond through the in-process fetch
 * handler, streams through the ApiProxy events face.
 */
export class CorumDesktopConnection extends Service {
  static inject = ['apiProxy']

  private readonly api: Context['apiProxy']
  private readonly fetchHandler: { fetch: (request: Request) => Promise<Response> }

  /**
   * Build the bridge over the settled ApiProxy.
   * @param ctx - plugin context carrying the apiProxy service.
   */
  constructor(ctx: Context) {
    super(ctx, 'corumDesktopConnection')
    this.api = ctx.apiProxy
    // Host the generic `connection` service so transport-independent adapters
    // (the Typert gateway in api-gateway) can register their `/api` RPC
    // interceptors. The web surface gets this from `dsh-client-connection`,
    // whose row the desktop overlay disables; without it, every Typert Remote
    // endpoint (`pluginInventory/list`, `commands/*`, `goals/*`, …) 404s.
    const hostConnection = new HostConnectionService(ctx, [])
    // The shared `/api` handler: an interceptor claims Typert Remote endpoints
    // and everything else falls back to the ApiProxy unary routes.
    this.fetchHandler = hostConnection.createSharedFetchHandler(
      '/api',
      toFetchHandler(ctx.apiProxy),
    )
  }

  /**
   * Run one unary request through the in-process fetch handler.
   * @param pathname - the /api path (e.g. `/api/session.list`, `/api/respond`,
   *   or a Typert Remote endpoint like `/api/pluginInventory/list`).
   * @param body - the raw ClientRequest/ClientResponse envelope JSON.
   * @returns the status and response body the renderer turns into a Response.
   */
  async unary(pathname: string, body: string | undefined): Promise<CorumUnaryResult> {
    // corum 自有 RPC（非官方 /api 路由）：目录浏览（资源管理器文件树）。
    if (pathname === CORUM_FS_LIST_PATH || pathname === CORUM_FS_LIST_PATH_SLASH) {
      return this.handleCorumFsList(body)
    }
    const request = new Request(`http://dsh.internal${pathname}`, {
      method: 'POST',
      ...body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body },
    })
    const response = await this.fetchHandler.fetch(request)
    return { status: response.status, body: await response.text() }
  }

  /**
   * corum.fs.list — 目录浏览（资源管理器文件树的数据源）。以 host 进程 cwd
   * 为项目根：任何真实路径逃出根目录的请求都拒绝（realpath 校验，防止
   * symlink 穿越）。返回 server-response 信封（rpc.call 的返回契约）。
   * @param body - client-request 信封 JSON（payload.path 相对根，'/' = 根）。
   */
  private async handleCorumFsList(body: string | undefined): Promise<CorumUnaryResult> {
    const respond = (rpcId: string | undefined, result: unknown): CorumUnaryResult => ({
      status: 200,
      body: JSON.stringify({ type: 'server-response', rpcId, result }),
    })
    const fail = (rpcId: string | undefined, code: string, message: string): CorumUnaryResult =>
      respond(rpcId, { ok: false, error: { code, message } })
    let envelope: { rpcId?: string; payload?: { path?: string } }
    try {
      envelope = JSON.parse(body ?? '{}') as { rpcId?: string; payload?: { path?: string } }
    } catch {
      return fail(undefined, 'corum-fs-invalid-envelope', 'invalid client-request envelope')
    }
    const rpcId = envelope.rpcId
    const root = resolve(process.cwd())
    const requested = envelope.payload?.path ?? '/'
    let target: string
    try {
      // 路径一律按相对根处理：'/' 与 '' 映射根，剥掉前导斜杠，杜绝
      // resolve(root, '/abs') 被绝对路径覆盖 root 的逃逸。
      const normalized = requested === '/' || requested === '' ? '.' : requested.replace(/^\/+/, '')
      target = resolve(root, normalized)
      if (target !== root && !target.startsWith(root + sep)) {
        return fail(rpcId, 'corum-fs-outside-root', `path escapes the project root: ${requested}`)
      }
      const real = await realpath(target)
      if (real !== root && !real.startsWith(root + sep)) {
        return fail(rpcId, 'corum-fs-outside-root', `path escapes the project root via symlink: ${requested}`)
      }
    } catch (error) {
      return fail(rpcId, 'corum-fs-not-found', `cannot resolve ${requested}: ${String(error)}`)
    }
    try {
      const entries = await readdir(target, { withFileTypes: true })
      const items = entries
        .filter(entry => entry.name !== '.git' && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
        .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' }))
        .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
      return respond(rpcId, { ok: true, value: { path: requested, entries: items } })
    } catch (error) {
      return fail(rpcId, 'corum-fs-read-error', `cannot read ${requested}: ${String(error)}`)
    }
  }

  /**
   * Open one event stream, yielding full ServerRequest frames (method = frame
   * type) until the signal aborts or the impl stream ends.
   * @param kind - the logical stream ('mux' or 'host').
   * @param signal - local stream control; aborting closes the stream.
   */
  openStream(kind: CorumStreamKind, signal: AbortSignal): AsyncIterable<ServerRequest> {
    const narrows = kind === 'mux'
      ? this.api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
      : this.api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
    return {
      async *[Symbol.asyncIterator]() {
        for await (const narrow of narrows) yield fullFrame(narrow)
      },
    }
  }
}

export default CorumDesktopConnection
