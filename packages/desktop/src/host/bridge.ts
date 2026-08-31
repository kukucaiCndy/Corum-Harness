/**
 * corum-desktop host bridge: the child-process entry the Electron main spawns.
 * It boots the desktop tree under SYSTEM Node (the vendored Cordis loader's
 * internal-ESM resolution does not work inside Electron's embedded Node).
 *
 * Transport stance (0.1.2): the renderer loads the OFFICIAL web surface over
 * loopback HTTP directly — the bridge no longer relays unary/stream traffic.
 * Its remaining jobs over the newline-delimited JSON stdio protocol:
 *   child → parent
 *     { type: 'ready', authenticatedUrl }   — the loopback URL with the launch token
 *     { type: 'session-op-result', ... }     — session-archive op replies
 *     { type: 'error', message }             — fatal boot failure
 *   parent → child
 *     { type: 'session-flush' | 'session-export' | 'session-import' | 'session-delete', ... }
 *
 * The Electron main reads `authenticatedUrl` and `loadURL`s it; the page then
 * talks to the host's own webserver + /api connection like any `dsh web` tab.
 * @module corum-desktop/host/bridge
 */

import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { bootDesktop, resolveDesktopHome } from './boot.ts'
import { CorumSessionArchive } from './session-archive.ts'

/** Flush all live session logs to durable storage (the quit hook). */
interface FlushRequest { type: 'session-flush'; id: string }
/** Export one session's log as a ZIP (base64 over the wire). */
interface ExportRequest { type: 'session-export'; id: string; sessionId: string }
/** Import one exported log ZIP (base64 over the wire). */
interface ImportRequest { type: 'session-import'; id: string; zipBase64: string }
/** Physically delete one session (artifact + workspace refs + caches). */
interface DeleteRequest { type: 'session-delete'; id: string; sessionId: string }

type ParentRequest = FlushRequest | ExportRequest | ImportRequest | DeleteRequest

/** Import payload ceiling (base64 length): 96 MiB ≈ 64 MiB raw ZIP — mirrors the Electron main's entry-side cap. */
const MAX_IMPORT_BASE64_LENGTH = 96 * 1024 * 1024

/** The loopback host the desktop webserver always binds (pinned in cordis.patch.yml). */
const LOOPBACK_HOST = '127.0.0.1'

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
  // pipe (the ready handshake and every session-op reply depend on it). The
  // async overload buffers until the stream drains, which delays `ready` long
  // enough to break the pack smoke check.
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function main(): Promise<void> {
  const ctx = await bootDesktop()
  // The official web transport rows are enabled by the desktop overlay: the
  // webserver binds loopback on an ephemeral port, and the connection row owns
  // the /api gateway + browser-session authentication. Read both back to build
  // the authenticated URL the Electron main loads.
  const port = ctx.webServer?.port
  const connection = ctx.get('connection')
  if (port === undefined || connection === undefined) {
    throw new Error('corum-desktop: official web transport (webServer/connection) missing after boot')
  }
  // Session archive: flush/export/import/delete, rooted at this home's
  // session and storage stores. The Service base registers it as
  // `corumSessionArchive`; the bridge holds the instance directly for the
  // stdio handlers below.
  const archive = new CorumSessionArchive(ctx, {
    sessionsRoot: join(resolveDesktopHome(), 'sessions'),
    storagesRoot: join(resolveDesktopHome(), 'storages'),
  })
  const webUrl = `http://${LOOPBACK_HOST}:${String(port)}`
  const authenticatedUrl = connection.authenticatedUrl(webUrl)
  send({ type: 'ready', authenticatedUrl })

  const readline = createInterface({ input: process.stdin })
  for await (const line of readline) {
    if (line.trim() === '') continue
    let request: ParentRequest
    try {
      request = JSON.parse(line) as ParentRequest
    } catch {
      continue // malformed line: skip, never crash the bridge
    }
    // 防御性帧校验：id 缺失/非 string 的帧无法回包，直接跳过。
    if (typeof request.id !== 'string') continue
    if (request.type === 'session-flush') {
      try {
        const flushed = await archive.flushAll()
        send({ type: 'session-op-result', id: request.id, ok: true, flushed })
      } catch (error) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: String(error) })
      }
    } else if (request.type === 'session-export') {
      if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: 'bad sessionId' })
        continue
      }
      try {
        const zip = await archive.exportZip(request.sessionId)
        send({ type: 'session-op-result', id: request.id, ok: true, zipBase64: Buffer.from(zip).toString('base64') })
      } catch (error) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: String(error) })
      }
    } else if (request.type === 'session-import') {
      // 运行时大小/存在性校验：base64 超长直接拒绝（内存放大防护，与
      // bridge-client 的入口上限对齐）。
      if (typeof request.zipBase64 !== 'string' || request.zipBase64.length > MAX_IMPORT_BASE64_LENGTH) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: 'import payload too large or missing' })
        continue
      }
      try {
        const result = await archive.importZip(new Uint8Array(Buffer.from(request.zipBase64, 'base64')))
        send({ type: 'session-op-result', id: request.id, ok: true, imported: result.imported, skipped: result.skipped })
      } catch (error) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: String(error) })
      }
    } else if (request.type === 'session-delete') {
      if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: 'bad sessionId' })
        continue
      }
      try {
        const result = await archive.deleteSession(request.sessionId)
        send({ type: 'session-op-result', id: request.id, ok: true, deleted: result.deleted, wasLive: result.wasLive })
      } catch (error) {
        send({ type: 'session-op-result', id: request.id, ok: false, error: String(error) })
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
