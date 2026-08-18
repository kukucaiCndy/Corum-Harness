/**
 * corum-shell host bridge: the child-process entry the Electron main spawns.
 * It boots the desktop tree under SYSTEM Node (the vendored Cordis loader's
 * internal-ESM resolution does not work inside Electron's embedded Node) and
 * exposes the ApiProxy over a newline-delimited JSON stdio protocol that the
 * Electron main relays to the renderer.
 *
 * Wire (one JSON object per line):
 *   child → parent
 *     { type: 'ready', graph, clientPaths }
 *     { type: 'result', id, status, body }
 *     { type: 'stream-open', id }
 *     { type: 'frame', id, frame }
 *   parent → child
 *     { type: 'unary', id, pathname, body? }
 *     { type: 'stream-open', id, kind }
 *     { type: 'stream-close', id }
 * @module corum-shell/host/bridge
 */

import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { bootDesktop, resolveDesktopHome } from './boot.ts'
import { CorumDesktopConnection } from './connection.ts'
import { CorumDesktopModuleRegistry } from './modules.ts'
import { CorumSessionArchive } from './session-archive.ts'

interface UnaryRequest {
  type: 'unary'
  id: string
  pathname: string
  body?: string
}

interface StreamOpenRequest {
  type: 'stream-open'
  id: string
  kind: 'mux' | 'host'
}

interface StreamCloseRequest {
  type: 'stream-close'
  id: string
}

/** Flush all live session logs to durable storage (the quit hook). */
interface FlushRequest { type: 'session-flush'; id: string }
/** Export one session's log as a ZIP (base64 over the wire). */
interface ExportRequest { type: 'session-export'; id: string; sessionId: string }
/** Import one exported log ZIP (base64 over the wire). */
interface ImportRequest { type: 'session-import'; id: string; zipBase64: string }
/** Physically delete one session (artifact + workspace refs + caches). */
interface DeleteRequest { type: 'session-delete'; id: string; sessionId: string }
/** Combo 加载：动态加载/卸载插件。 */
interface ComboLoadRequest {
  type: 'combo-load'
  id: string
  /** 需要加载的插件包名列表（不在列表里的当前插件会被卸载）。 */
  plugins: string[]
}

type ParentRequest =
  | UnaryRequest
  | StreamOpenRequest
  | StreamCloseRequest
  | FlushRequest
  | ExportRequest
  | ImportRequest
  | DeleteRequest
  | ComboLoadRequest

// The parent (Electron main) may exit while a frame is still in flight; a
// synchronous write to its closed stdout then raises EPIPE on the stream. The
// child owns no state worth keeping once its parent is gone, so swallow the
// error and exit quietly instead of crashing on an unhandled 'error' event.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

function send(message: unknown): void {
  // Synchronous write: keeps newline-delimited frames flushed immediately on a
  // pipe (the ready handshake and every unary/stream reply depend on it). The
  // async overload buffers until the stream drains, which delays `ready` long
  // enough to break the pack smoke check.
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function main(): Promise<void> {
  const ctx = await bootDesktop()
  const modules = ctx.get('corumDesktopModules') as CorumDesktopModuleRegistry | undefined
  const connection = ctx.get('corumDesktopConnection') as CorumDesktopConnection | undefined
  if (modules === undefined || connection === undefined) {
    throw new Error('corum-shell: desktop transport services missing after boot')
  }
  // Session archive: flush/export/import/delete, rooted at this home's
  // session and storage stores. The Service base registers it as
  // `corumSessionArchive`; the bridge holds the instance directly for the
  // stdio handlers below.
  const archive = new CorumSessionArchive(ctx, {
    sessionsRoot: join(resolveDesktopHome(), 'sessions'),
    storagesRoot: join(resolveDesktopHome(), 'storages'),
  })
  // Bundle paths the Electron main reads directly to serve corump:// requests.
  const clientPaths: Record<string, string> = {}
  for (const entry of modules.graph().entries) {
    const path = modules.clientPath(entry.id)
    if (path !== undefined) clientPaths[entry.id] = path
  }
  // 诊断（临时，排查 settings 服务消失用，解决后删除）：loader 实际挂载的 entries。
  const loaderEntries: string[] = []
  for (const entry of ctx.loader.entries()) {
    loaderEntries.push(`${entry.options.id ?? '?'}${entry.fiber !== undefined ? '' : ' [NO-FIBER]'}${entry.disabled ? ' [DISABLED]' : ''}`)
  }
  process.stderr.write(`[corum-shell] loader entries (${loaderEntries.length}):\n  ${loaderEntries.sort().join('\n  ')}\n`)
  send({ type: 'ready', graph: modules.graph(), clientPaths })

  // Dev HMR: forward every bundle rebuild to the Electron main, which relays
  // it to the renderer's hot-reload driver over IPC. Log to stderr too so the
  // rebuild is visible in the launching terminal without renderer console.
  modules.onRebuilt((id, rev) => {
    process.stderr.write(`[corum-shell-hmr] bundle rebuilt: ${id} (rev ${rev})\n`)
    send({ type: 'hmr-rebuilt', id, rev })
  })

  const streams = new Map<string, AbortController>()

  const readline = createInterface({ input: process.stdin })
  for await (const line of readline) {
    if (line.trim() === '') continue
    let request: ParentRequest
    try {
      request = JSON.parse(line) as ParentRequest
    } catch {
      continue // malformed line: skip, never crash the bridge
    }
    if (request.type === 'unary') {
      try {
        const result = await connection.unary(request.pathname, request.body)
        send({ type: 'result', id: request.id, status: result.status, body: result.body })
      } catch (error) {
        send({ type: 'result', id: request.id, status: 500, body: `bridge failure: ${String(error)}` })
      }
    } else if (request.type === 'stream-open') {
      const abort = new AbortController()
      streams.set(request.id, abort)
      send({ type: 'stream-open', id: request.id })
      void (async () => {
        try {
          for await (const frame of connection.openStream(request.kind, abort.signal)) {
            send({ type: 'frame', id: request.id, frame })
          }
        } catch {
          // stream loss; the parent's reconnect logic owns the retry
        } finally {
          streams.delete(request.id)
        }
      })()
    } else if (request.type === 'stream-close') {
      streams.get(request.id)?.abort()
      streams.delete(request.id)
    } else if (request.type === 'session-flush') {
      try {
        const flushed = await archive.flushAll()
        send({ type: 'session-op-result', id: request.id, ok: true, flushed })
      } catch (error) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: String(error) })
      }
    } else if (request.type === 'session-export') {
      try {
        const zip = await archive.exportZip(request.sessionId)
        send({ type: 'session-op-result', id: request.id, ok: true, zipBase64: Buffer.from(zip).toString('base64') })
      } catch (error) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: String(error) })
      }
    } else if (request.type === 'session-import') {
      try {
        const result = await archive.importZip(new Uint8Array(Buffer.from(request.zipBase64, 'base64')))
        send({ type: 'session-op-result', id: request.id, ok: true, imported: result.imported, skipped: result.skipped })
      } catch (error) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: String(error) })
      }
    } else if (request.type === 'session-delete') {
      try {
        const result = await archive.deleteSession(request.sessionId)
        send({ type: 'session-op-result', id: request.id, ok: true, deleted: result.deleted, wasLive: result.wasLive })
      } catch (error) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: String(error) })
      }
    } else if (request.type === 'combo-load') {
      try {
        const loader = ctx.loader
        if (loader === undefined) {
          send({ type: 'combo-result', id: request.id, ok: false, error: 'loader service unavailable' })
          continue
        }
        // 收集当前 loader 里的非内置条目（可被 combo 管理的）
        const currentEntries: { id: string; name: string }[] = []
        for (const entry of loader.entries()) {
          const name = entry.options.name
          if (name === undefined) continue
          currentEntries.push({ id: entry.options.id ?? '', name })
        }
        const target = new Set(request.plugins)
        const current = new Set(currentEntries.map((e) => e.name))
        // 卸载：当前有但目标没有的（排除框架核心包）
        const CORE = new Set([
          'corum-shell', '@corum/ide-shell',
          '@corum/session-archive', '@corum/ui-settings-models', '@corum/ui-model-selection',
        ])
        for (const entry of currentEntries) {
          if (CORE.has(entry.name)) continue
          if (!target.has(entry.name) && entry.id !== '') {
            try { await loader.remove(entry.id) } catch { /* already removed */ }
          }
        }
        // 加载：目标有但当前没有的
        for (const name of request.plugins) {
          if (current.has(name)) continue
          if (CORE.has(name)) continue
          try {
            await loader.create({ name })
          } catch (error) {
            // 插件可能不存在或加载失败——记录但不中断
            send({ type: 'combo-progress', id: request.id, plugin: name, ok: false, error: String(error) })
          }
        }
        // 刷新 client module graph
        const graph = modules.graph()
        const clientPathsRefreshed: Record<string, string> = {}
        for (const entry of graph.entries) {
          const path = modules.clientPath(entry.id)
          if (path !== undefined) clientPathsRefreshed[entry.id] = path
        }
        send({ type: 'combo-result', id: request.id, ok: true, graph, clientPaths: clientPathsRefreshed })
      } catch (error) {
        send({ type: 'combo-result', id: request.id, ok: false, error: String(error) })
      }
    }
  }
}

void main().catch((error) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error)
  // Walk the cause chain and print every AggregateError's sub-errors, so a
  // loader tree failure reports WHICH entries failed to apply.
  const parts = [msg]
  let cur: unknown = error
  let depth = 0
  while (cur instanceof Error && depth < 10) {
    const errors = (cur as { errors?: unknown[] }).errors
    if (Array.isArray(errors) && errors.length > 0) {
      parts.push(`--- aggregate errors (depth ${depth}) ---`)
      for (const e of errors) parts.push(e instanceof Error ? (e.stack ?? e.message) : String(e))
    }
    if (cur.cause === undefined || cur.cause === cur) break
    cur = cur.cause
    depth += 1
  }
  send({ type: 'error', message: parts.join('\n') })
  process.exit(1)
})
