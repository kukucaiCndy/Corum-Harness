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
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bootDesktop, resolveDesktopHome } from './boot.ts'
import { CorumSessionArchive } from './session-archive.ts'
import { imageMimeOf, videoMimeOf } from './corum-fs.ts'

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

/** 本 home 的 host PID 记录（`<home>/run/host.pid`）——用于启动时清掉上一代孤儿。 */
function hostPidPath(): string {
  return join(resolveDesktopHome(), 'run', 'host.pid')
}

/**
 * 本进程的 host 入口绝对路径 —— 回收时用来确认「记录里的那个进程与本进程是**同一种** host」。
 *
 * 为什么需要（2026-10-01 事故）：dev/verify 的 host 是
 * `<repo>/packages/desktop/lib/bridge.js`，打包态是
 * `<app>/Contents/Resources/host/lib/bridge.js` —— 两者**不是同一个文件**，
 * 原先却用子串 `host/lib/bridge.js` 做判据，于是只有打包态命中、dev/verify 反而不命中。
 * 用**自己的入口路径**比对才是对称且精确的。
 */
const SELF_BRIDGE_PATH = fileURLToPath(import.meta.url)

/**
 * 本进程所在实例的 CDP 端口 —— dev / verify / packaged **共用同一个 home**，
 * 故「同一个 host.pid 文件」里可能记着**另一个实例**的 host。端口是区分 dev(9222)
 * 与 verify(9333) 的那一轴（两者入口路径相同，仅靠路径分不开）。
 */
function selfDebugPort(): string {
  const port = process.env.CORUM_DEBUG_PORT
  return port === undefined || port === '' ? '' : port
}

/**
 * 清掉同一 home 里上一代残留的 host 进程。
 *
 * 2026-09-09 事故：`before-quit` 只 `app.exit(0)`、不杀子进程，而子进程的
 * stdin EOF 后仍被 webserver 句柄吊着 → 每次退出留一个**孤儿 host**，它继续攥着
 * 打开过的 `session.lock`；下次启动的新 host 读/写那些会话直接失败（用户可见：
 * 「模型选择失败」、历史加载失败）。本轮已修两条泄漏路径，本函数负责回收**已经
 * 存在的**孤儿（老版本留下的）。
 *
 * 安全性（三重判据，缺一不可）：PID 记录在**本 home** 的 run/host.pid 里
 * + 该 PID 仍存活 + **记录里的端口与本实例一致** + `ps` 确认命令行含**本进程的
 * 入口路径**。PID 复用导致的误杀由命令行校验挡住，任何异常都静默放过。
 *
 * ⚠️ 2026-10-01 事故（「在 9222 里起 verify 把自己也杀了」）：dev / verify / packaged
 * **三者共用 `~/.corum` 与这一份 host.pid**，而旧判据只有「cmdline 含
 * `host/lib/bridge.js`」这一条子串 —— 恰好只有**打包态**命中 ⇒ 任何 dev/verify 实例
 * 启动，都会把**打包态实例的 host** 顺手 SIGTERM 掉（反之打包态也回收不了 dev/verify
 * 的孤儿）。端口 + 入口路径双判据即消除这种跨实例误杀。
 */
async function reapStaleHost(): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const raw = await readFile(hostPidPath(), 'utf8')
    const record = JSON.parse(raw) as { pid?: unknown; debugPort?: unknown }
    const stale = Number(record.pid)
    if (!Number.isSafeInteger(stale) || stale <= 0 || stale === process.pid) return
    // 不是本实例那一代的记录（另一个端口/另一种形态的 host）⇒ 绝不动它。
    const stalePort = typeof record.debugPort === 'string' ? record.debugPort : ''
    if (stalePort !== selfDebugPort()) return
    try {
      process.kill(stale, 0) // 存活探测
    } catch {
      return // 已经不在了
    }
    let command = ''
    try {
      command = execFileSync('ps', ['-p', String(stale), '-o', 'command='], { encoding: 'utf8' })
    } catch {
      return // 取不到命令行（权限/沙盒）→ 不动它
    }
    if (!command.includes(SELF_BRIDGE_PATH)) return // PID 复用 / 另一种 host，放过
    process.stderr.write(`[corum-desktop] reaping stale host ${String(stale)} (a previous parent exited without killing it)\n`)
    try { process.kill(stale, 'SIGTERM') } catch { /* 竞态：已退出 */ }
    for (let i = 0; i < 20; i += 1) {
      await new Promise(done => setTimeout(done, 100))
      try {
        process.kill(stale, 0)
      } catch {
        return
      }
    }
    try { process.kill(stale, 'SIGKILL') } catch { /* 竞态：已退出 */ }
  } catch {
    // 没有记录 / 记录损坏：没有可回收的对象
  }
}

/** 记录本进程 PID（含端口，供下一代确认是「同一种 host」），写失败不影响运行。 */
async function recordHostPid(): Promise<void> {
  try {
    await mkdir(dirname(hostPidPath()), { recursive: true })
    await writeFile(hostPidPath(), `${JSON.stringify({ pid: process.pid, debugPort: selfDebugPort(), startedAt: Date.now() })}\n`)
  } catch {
    // best effort
  }
}

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

/**
 * 父进程探活看门狗：`CORUM_PARENT_PID` 指向 Electron main，每 2s `kill(pid, 0)`
 * 一次；ESRCH = 父进程已死 → flush 后退出。
 *
 * 为什么不能只靠 stdin EOF：管道写端会被父进程之后 spawn 的其它子进程（renderer /
 * GPU / utility helper）继承，主进程被 `kill -9` 时写端仍被它们握着，EOF 永远不来
 * （2026-09-09 打包版实测：kill -9 主进程后 host 仍存活）。没有环境变量时退回
 * `process.ppid === 1`（被 launchd 收养）判定。
 */
function watchParent(archive: CorumSessionArchive): void {
  const raw = process.env.CORUM_PARENT_PID
  const parentPid = raw === undefined ? Number.NaN : Number(raw)
  const parentGone = (): boolean => {
    if (Number.isSafeInteger(parentPid) && parentPid > 0) {
      try {
        process.kill(parentPid, 0)
        return false
      } catch {
        return true
      }
    }
    return process.ppid === 1
  }
  const timer = setInterval(() => {
    if (!parentGone()) return
    clearInterval(timer)
    process.stderr.write('[corum-desktop] parent process gone — flushing and exiting\n')
    void archive.flushAll()
      .catch((error: unknown) => {
        process.stderr.write(`[corum-desktop] shutdown flush failed: ${String(error)}\n`)
      })
      .finally(() => { process.exit(0) })
  }, 2000)
  timer.unref()
}

async function main(): Promise<void> {
  // 回收上一代孤儿（它可能还攥着会话锁），再登记本进程 PID，最后才 boot。
  await reapStaleHost()
  await recordHostPid()
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

  // Register Monaco worker files on the loopback webserver so the renderer
  // (loaded from http://127.0.0.1:<port>) can construct Workers from the
  // same origin. The corumapp:// protocol can't serve cross-origin Workers.
  const workersDir = join(dirname(fileURLToPath(import.meta.url)), 'workers')
  const webServer = ctx.webServer
  if (webServer !== undefined && typeof webServer.register === 'function') {
    webServer.register({
      kind: 'prefix',
      path: '/monaco',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '', webUrl)
        const name = url.pathname.slice('/monaco/'.length)
        // Path traversal guard
        const safe = resolve(normalize(join(workersDir, name)))
        if (!safe.startsWith(workersDir + sep) && safe !== workersDir) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        try {
          const body = await readFile(safe)
          res.setHeader('content-type', 'text/javascript; charset=utf-8')
          res.setHeader('cache-control', 'no-cache')
          res.end(body)
        } catch {
          res.statusCode = 404
          res.end('not found')
        }
      },
    })
    process.stderr.write('[corum-desktop] monaco workers served at /monaco/\n')

    // 编辑区媒体预览流式路由（HANDOFF §七.6）：视频/大图片走
    // `/corumfs/<相对根路径>` 同源 URL（`<video>`/`<img>` 原生拉流），
    // 不经 RPC（base64 信封对视频太重）。与 corumFs/read 同一 realpath
    // 防穿越基准；视频支持 HTTP Range（进度条拖拽必需）。
    const corumFsSvc = ctx.get('corumFs')
    if (corumFsSvc === undefined) {
      throw new Error('corum-desktop: corumFs service missing after boot')
    }
    webServer.register({
      kind: 'prefix',
      path: '/corumfs',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '', webUrl)
          const rel = decodeURIComponent(url.pathname.slice('/corumfs'.length))
          const mime = videoMimeOf(rel) ?? imageMimeOf(rel)
          if (mime === undefined) {
            res.statusCode = 404
            res.end('not a media file')
            return
          }
          let real: string
          try {
            real = await corumFsSvc.resolveReadablePath(rel)
          } catch {
            res.statusCode = 403
            res.end('forbidden')
            return
          }
          const info = await stat(real)
          if (!info.isFile()) {
            res.statusCode = 404
            res.end('not found')
            return
          }
          res.setHeader('content-type', mime)
          res.setHeader('accept-ranges', 'bytes')
          res.setHeader('cache-control', 'no-cache')
          const range = req.headers.range
          const size = info.size
          if (typeof range === 'string' && range.startsWith('bytes=')) {
            const [startStr, endStr] = range.slice('bytes='.length).split('-')
            const start = Number.parseInt(startStr ?? '', 10)
            const end = endStr === undefined || endStr === '' ? size - 1 : Number.parseInt(endStr, 10)
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= size || start > end) {
              res.statusCode = 416
              res.setHeader('content-range', `bytes */${String(size)}`)
              res.end()
              return
            }
            res.statusCode = 206
            res.setHeader('content-range', `bytes ${String(start)}-${String(end)}/${String(size)}`)
            res.setHeader('content-length', end - start + 1)
            createReadStream(real, { start, end }).pipe(res)
            return
          }
          res.setHeader('content-length', size)
          createReadStream(real).pipe(res)
        } catch {
          if (!res.headersSent) res.statusCode = 404
          res.end('not found')
        }
      },
    })
    process.stderr.write('[corum-desktop] media preview served at /corumfs/\n')
  }

  send({ type: 'ready', authenticatedUrl })
  watchParent(archive)

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
  // stdin EOF = 父进程（Electron main）已经没了（正常退出 / 崩溃 / 被强杀都会关掉
  // 这条管道）。此时必须主动退出：webserver 句柄会把这个进程永远吊着，变成孤儿
  // host 继续攥着 session.lock，下一代启动就再也读不到那些会话
  // （2026-09-09 用户报「模型选择失败」，根因即此）。退出前尽力 flush 一次。
  process.stderr.write('[corum-desktop] parent gone (stdin EOF) — flushing and exiting\n')
  try {
    await archive.flushAll()
  } catch (error) {
    process.stderr.write(`[corum-desktop] shutdown flush failed: ${String(error)}\n`)
  }
  process.exit(0)
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
