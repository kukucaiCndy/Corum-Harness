/**
 * Desktop session-archive host service: durable flush, log export, and log
 * import — the three capabilities the desktop surface adds over the official
 * web flow.
 *
 * Why these live in the shell host (not a UI plugin):
 *  - FLUSH is a host-lifecycle act: the Electron main's before-quit hook must
 *    drain `session/flush` before the process exits, or a Cmd+Q / kill drops
 *    the buffered tail of the append-only log (the torn frame the user hit).
 *  - EXPORT reuses the official session-log-export ZIP builder in-process
 *    (no HTTP on the desktop) and hands raw bytes to the main process, which
 *    owns the native save dialog and the file write.
 *  - IMPORT writes a ZIP's session artifact(s) back into this home's session
 *    store in the backend's EXACT physical encoding (zstd-compressed, the
 *    desktop store's configured compression), so the loader discovers them on
 *    the next session.list.
 *
 * Binary crosses the bridge as base64 (the stdio protocol is line-delimited
 * JSON; session archives are a few MB at most).
 *
 * ⚠️ SESSION ARTIFACT FILENAMES ARE VERSIONED — NEVER HARDCODE ONE NAME.
 * The on-disk log of one session is named by its Session *format generation*:
 * `session.jsonl` (generation 0) or `session.vN.jsonl` (generation N), plus the
 * store's compression suffix (`.zstd`) — the single source of truth is
 * `sessionFormatLogFilename` / `parseSessionFormatLogFilename` from
 * `@deepseek-ai/dsh-session-format` (dsh 0.1.5-rc.3 writes **v3**, so a live
 * artifact is `session.v3.jsonl.zstd`). A hardcoded `session.jsonl.zstd` is the
 * v0-era name and silently ENOENTs against every current session: the
 * delete-archived-session flow's artifact lookup failed exactly that way. So
 * this module resolves artifacts through the official helpers, and any code
 * that must *discover* a log inside a session directory lists the directory
 * and matches canonical names (see `resolveArtifactCwd`) rather than assuming
 * a fixed one.
 * @module corum-desktop/host/session-archive
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompress, zstdDecompress } from 'node:zlib'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { parseSessionFormatLogFilename, sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  streamSessionLogZip,
} from '@deepseek-ai/dsh-session-log-export'
import { unzipSync, zipSync } from 'fflate'

const zstdCompressAsync = promisify(zstdCompress)

/**
 * The Session format generation this build WRITES an artifact under, read from
 * the baseline's own constant (`@deepseek-ai/dsh-session`) rather than pinned
 * here: the official `session-log-export` builder names its ZIP entries the
 * same way (`SESSION_LOG_FILENAME = sessionFormatLogFilename(SESSION_FORMAT_VERSION)`),
 * so `importZip` must agree with what the baseline produces — a literal would
 * silently drift the next time the format bumps.
 *
 * Only the *import* path needs it. The delete path is generation-agnostic on
 * purpose: `resolveArtifactCwd` accepts any canonical name and
 * `removeArtifact` deletes the whole directory.
 */
const CURRENT_WRITE_FORMAT_VERSION = SESSION_FORMAT_VERSION

/** Escape a literal for `new RegExp` (the log basename is interpolated above). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The backend's project-directory key for one cwd (`--slug--`), mirrored from
 * `session-persistence-jsonl`'s projectKey so imported artifacts land where
 * the loader's discovery looks. Kept self-contained: the package does not
 * export its format helpers through package.json `exports`.
 */
function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * One session id as a single safe path segment (matches encodeSegment).
 * 安全确认（S4）：本函数对 sessionId 逐字符白名单编码——仅 `A-Za-z0-9._-`
 * 原样保留，其余所有字符（含 `/`、`\`、`~`、`..` 的 `.` 之外字符、控制符、
 * 非 ASCII）一律转义为 `~XXXX`（Unicode 码位十六进制）。编码输出绝不包含路径
 * 分隔符、父目录引用或绝对路径锚点，因此 exportZip/deleteSession/importZip 把
 * sessionId 经 encodeSegment 拼进文件路径（sessionDirPath / resolveArtifactCwd）
 * 不存在路径注入风险——已防注入，无需额外的 slug 形态校验。
 */
function encodeSegment(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * The project directory name one stored cwd maps to (mirrors the backend's
 * `projectDir`: `undefined` selects `_no-cwd`).
 */
function projectDirName(cwd: string | undefined): string {
  return cwd === undefined || cwd === '' ? '_no-cwd' : projectKey(cwd)
}

/**
 * The directory that owns one session's artifacts (`<project>/<encoded-id>/`).
 *
 * Deliberately returns the DIRECTORY, never a log filename: the log's basename
 * is format-generation-versioned (`session.jsonl` / `session.vN.jsonl` +
 * compression suffix — see the module header), so a filename-level helper here
 * would have to pin a generation and would silently go stale. Callers that
 * need a specific log name it with {@link sessionFormatLogFilename} and the
 * store's compression suffix; callers that merely need the bytes remove the
 * whole directory.
 */
function sessionDirPath(sessionsRoot: string, cwd: string | undefined, id: string): string {
  return join(sessionsRoot, projectDirName(cwd), encodeSegment(id))
}

/** Parse the session id + cwd out of an artifact's first (header) line. */
function parseHeader(firstLine: string): { id: string; cwd?: string } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const header = parsed as { id?: unknown; cwd?: unknown }
  if (typeof header.id !== 'string' || header.id === '') return undefined
  return { id: header.id, ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}) }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Desktop session-archive service (flush/export/import). */
    corumSessionArchive: CorumSessionArchive
  }
}

/** The store roots for this harness home. */
export interface SessionArchivePaths {
  /** Absolute sessions root (…/sessions). */
  sessionsRoot: string
  /** Absolute storages root (…/storages), for workspace.json / session_projcache.json. */
  storagesRoot: string
}

/** Result of one import: the session ids materialized vs already present. */
export interface SessionImportResult {
  imported: string[]
  skipped: string[]
}

/**
 * The desktop session-archive service. Constructed with the boot context and
 * the sessions root; the bridge registers it as `corumSessionArchive`.
 */
export class CorumSessionArchive extends Service {
  static inject = ['sessions', 'agents']

  constructor(
    ctx: Context,
    private readonly paths: SessionArchivePaths,
  ) {
    super(ctx, 'corumSessionArchive')
  }

  private get sessions(): SessionStore {
    return this.ctx.sessions as SessionStore
  }

  /**
   * Durably flush every live session's buffered events. The Electron main
   * calls this from its before-quit hook and waits for the promise before
   * exiting, so a Cmd+Q / window close never strands the un-flushed tail.
   * @returns the number of sessions flushed.
   */
  async flushAll(): Promise<number> {
    const live = this.sessions.list()
    let flushed = 0
    for (const session of live) {
      try {
        await this.sessions.flush(session)
        flushed += 1
      } catch (error) {
        this.ctx.logger.warn(`corum-session-archive: flush of "${session.id}" failed: ${String(error)}`)
      }
    }
    return flushed
  }

  /**
   * Build one session's export ZIP in-process and return its bytes. Reuses
   * the official session-log-export builder (the same archive layout the web
   * export route streams) so the result round-trips through {@link importZip}.
   * @param sessionId - the root session to export.
   * @returns the ZIP bytes.
   */
  async exportZip(sessionId: string): Promise<Uint8Array> {
    const id = SessionId(sessionId)
    const signal = new AbortController().signal
    const deps = sessionLogExportDeps(this.ctx)
    if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
      throw new Error('export failed: session log export is unavailable (missing session-query, session-persistence, or attachments service)')
    }
    await flushLiveSessionLog(deps, id, signal)
    // fork（corum）：官方 0.1.3 session-persistence handle seam —— readRaw/
    // supportsRawArtifacts 已删，导出改由调用方先 readSessionLogText 读+序列化
    // root（read handle 链），再交 streamSessionLogZip 流式打包。
    const root = await readSessionLogText(deps.sessionPersistence, id, signal)
    if (root === undefined) throw new Error(`export failed: session not found: ${sessionId}`)
    const stream = streamSessionLogZip(
      { sessionQuery: deps.sessionQuery, sessionPersistence: deps.sessionPersistence, attachments: deps.attachments, sessions: deps.sessions },
      root,
      id,
      true,
      DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
      signal,
    )
    // The archive is a few MB at most and already crosses the bridge as
    // base64; buffer the streamed chunks into one byte array.
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    const buffer = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      buffer.set(chunk, offset)
      offset += chunk.byteLength
    }
    return buffer
  }

  /**
   * Build one export ZIP containing several sessions: each session's own
   * export ZIP (built by {@link exportZip}, the same archive layout
   * `importZip` round-trips) is nested as `<name>.zip` under the outer ZIP,
   * so a batch export is ONE file the user can hand around, and each member
   * still imports individually.
   *
   * Failures are per-session: one unbuildable archive skips its entry and
   * the rest still land (a batch export is a bulk gesture — refusing the
   * whole file because one session is gone would discard the others). The
   * returned map reports which ids produced no member so the caller can
   * tell the user.
   * @param sessionIds - the sessions to export.
   * @returns the outer ZIP bytes plus the ids that produced no member.
   */
  async exportSessionsZip(sessionIds: readonly string[]): Promise<{ zip: Uint8Array; failed: string[] }> {
    const members: Record<string, Uint8Array> = {}
    const failed: string[] = []
    for (const sessionId of sessionIds) {
      try {
        // `encodeSegment` keeps the member name a safe single path segment
        // (see its safety note): no separators, no parent references.
        members[`${encodeSegment(sessionId)}.zip`] = await this.exportZip(sessionId)
      } catch (error) {
        this.ctx.logger.warn(`corum-session-archive: batch export skipped "${sessionId}": ${String(error)}`)
        failed.push(sessionId)
      }
    }
    // A wholly-failed batch still yields a valid (empty-member) ZIP so the
    // save dialog writes something rather than erroring after the pick.
    return { zip: zipSync(members, { level: 6 }), failed }
  }

  /**
   * Import one export ZIP: materialize each session artifact it carries into
   * this home's session store in the backend's physical encoding. Ids that
   * already exist here are skipped (never overwrite a live store entry).
   * @param zipBytes - the export ZIP.
   * @returns which session ids were imported vs skipped.
   */
  async importZip(zipBytes: Uint8Array): Promise<SessionImportResult> {
    const files = unzipSync(zipBytes)
    const imported: string[] = []
    const skipped: string[] = []
    for (const [path, data] of Object.entries(files)) {
      // Session artifacts are the root log and each
      // `subagents/<id>/<log>` — the official exporter names them with the
      // CURRENT generation's canonical basename (`session.v3.jsonl` for the
      // v3 baseline), which is what {@link sessionFormatLogFilename} yields.
      // Media entries live elsewhere and are out of scope for the v1 import
      // (their ids stay referenced-but-absent).
      const logBasename = sessionFormatLogFilename(CURRENT_WRITE_FORMAT_VERSION)
      if (path !== logBasename && !new RegExp(`^subagents/[^/]+/${escapeRegExp(logBasename)}$`).test(path)) continue
      const text = new TextDecoder().decode(data)
      const meta = parseHeader(text.split('\n', 1)[0] ?? '')
      if (meta === undefined) {
        this.ctx.logger.warn(`corum-session-archive: skipping "${path}" — unreadable header`)
        continue
      }
      // Write through the backend's path convention + physical (zstd) encoding
      // so the loader's discovery and decode both recognize the artifact. The
      // target is the session's DIRECTORY named via sessionFormatLogFilename
      // for the generation this build writes — never a hardcoded basename
      // (see the module header).
      const target = sessionDirPath(this.paths.sessionsRoot, meta.cwd, meta.id)
      const artifact = join(target, sessionFormatLogFilename(CURRENT_WRITE_FORMAT_VERSION))
      if (await this.exists(artifact)) {
        skipped.push(meta.id)
        continue
      }
      await mkdir(target, { recursive: true, mode: 0o700 })
      const compressed = await zstdCompressAsync(Buffer.from(text, 'utf8'))
      await writeFile(artifact, compressed)
      imported.push(meta.id)
    }
    return { imported, skipped }
  }

  /**
   * Physically delete one session: refuse while its agent is mid-turn,
   * dispose a live-but-idle agent (which also removes the session from the
   * live store), strip every durable reference (workspace membership, the
   * projection-cache row), drain the persistence layer's trailing writes,
   * and only then remove the on-disk artifact directory.
   *
   * ORDERING INVARIANT — references before bytes. The workspace membership
   * and the projection cache are how the UI reopens a session, so they are
   * purged BEFORE the artifact directory is removed: a failure anywhere up
   * to and including the rm aborts the delete with the session still fully
   * listed and resumable (no zombie references), and only the final rm can
   * leave the (harmless, filtered-at-display) archive-set entry behind.
   * Purges are applied best-effort BEFORE the barrier because every step is
   * idempotent — a retried delete re-runs them safely.
   *
   * Why the barrier before rm: fiber disposal starts the persistence
   * backend's retirement asynchronously — the write-behind queue of the
   * disposed session can still be draining when the agent registry has
   * already forgotten the agent. `persistence.load(id)` serializes behind
   * exactly that pending work (`waitForRetirement` + the per-id op chain),
   * so awaiting it guarantees no append can follow the rm into the deleted
   * directory (which would fail ENOENT: the backend's append path assumes
   * the artifact's directory still exists and does not recreate it).
   *
   * Why the artifact is located by header cwd: only the live store and the
   * registry's workspace membership are consulted — a session whose cwd
   * directory no longer exists would be invisible to both, so the header
   * line of the artifact itself is the authoritative location record.
   * @param sessionId - the session to delete.
   * @returns whether an artifact directory was removed and whether the
   *   session was live (and had to be disposed) at deletion time.
   * @throws when the session's agent is currently running, the artifact's
   *   stored cwd points outside the sessions root, or the persistence
   *   layer could not settle the session (delete aborted — retry).
   */
  async deleteSession(sessionId: string): Promise<{ deleted: boolean; wasLive: boolean }> {
    const id = SessionId(sessionId)
    // 1. Live agent: a running loop means the user may be mid-conversation —
    //    refuse. An idle live agent is disposed, which stops the loop,
    //    unregisters the agent, AND removes the session from the live store
    //    (ctx.sessions), so later steps see a cold session.
    const agent = this.agents.get(id)
    let wasLive = agent !== undefined
    if (agent !== undefined) {
      if (agent.status === 'running') {
        throw new Error(`session "${sessionId}" is running and cannot be deleted`)
      }
      await agent.ctx.fiber.dispose()
      // Belt and braces: fiber disposal settles after cleanup, but poll the
      // registry briefly in case a deferred detach still trails the settle.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (this.agents.get(id) === undefined) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (this.agents.get(id) !== undefined) {
        throw new Error(`session "${sessionId}" could not be disposed (agent still registered)`)
      }
    }
    // A live session without a registered agent is a zombie attached view:
    // its buffered events belong to no conversation anymore. Flush so the
    // artifact we are about to remove is complete on disk (the rm then
    // takes the tail with it), then it leaves the store with its owner.
    const live = this.sessions.get(id)
    if (live !== undefined) {
      wasLive = true
      await this.sessions.flush(live).catch((error: unknown) => {
        this.ctx.logger.warn(`corum-session-archive: pre-delete flush of "${sessionId}" failed: ${String(error)}`)
      })
    }
    // 2. Resolve the artifact location BEFORE the reference purges, so a
    //    lookup failure aborts the delete with every reference intact.
    const cwd = await this.resolveArtifactCwd(sessionId, live?.header.cwd)
    // 3. Durable references first (see the ORDERING INVARIANT above): the
    //    workspace membership through each entity's public mutation, then
    //    the projection-cache row. Both are idempotent and re-run on retry.
    //    The archive set (archivedSessionIds) has NO public removal on the
    //    registry: the id may linger there until the next boot, which is
    //    harmless — grouping surfaces filter membership against live
    //    headers, and the archive set only intersects with displayed
    //    sessions (known limitation).
    await this.purgeWorkspaceReferences(id)
    await this.purgeProjectionCache(sessionId)
    // 4. Persistence barrier: drain the disposed session's trailing
    //    write-behind queue AND retire its backend state before the rm.
    //    Without this, an append racing the rm lands in the deleted
    //    directory and fails ENOENT (the observed regression).
    await this.awaitPersistenceRetirement(sessionId)
    // 5. Physical artifact: remove the whole `<project>/<encoded-id>/`
    //    directory as the LAST mutation — nothing after this point can
    //    resurrect a reference to bytes that no longer exist.
    const removed = await this.removeArtifact(sessionId, cwd)
    return { deleted: removed, wasLive }
  }

  /** The live agent registry, read through ctx so the inject name stays explicit. */
  private get agents(): AgentRegistryFace {
    return this.ctx.agents as AgentRegistryFace
  }

  /**
   * Block the delete until the persistence layer has fully settled this
   * session: every write queued before disposal is durably appended (or
   * logged as failed) and the backend's per-session state is retired.
   * `persistence.load(id)` queues behind exactly that work — the public
   * service exposes no retirement barrier of its own — and returns the
   * recovered durable view. After it resolves, no append for this id can
   * still be in flight, so the subsequent rm cannot be followed by a
   * write into the deleted directory.
   * @throws when the backend reports the session's log as corrupt or its
   *   trailing writes failed — the delete is aborted (retryable) rather
   *   than destroying an artifact the backend still considers live.
   */
  private async awaitPersistenceRetirement(sessionId: string): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceFace | undefined
    if (persistence === undefined) return
    const id = SessionId(sessionId)
    try {
      await persistence.load(id)
    } catch (error) {
      throw new Error(
        `persistence layer did not settle session "${sessionId}" for deletion `
        + `(aborting before any file removal; retry the delete): ${String(error)}`,
      )
    }
  }

  /**
   * Find the artifact's stored cwd: prefer the live header, then the
   * persistence listing's header (the authoritative cold record). Falls
   * back to scanning the sessions root for the one directory named by this
   * id when persistence has no listing for it (e.g. a corrupt row the
   * backend refuses to list).
   *
   * The fallback is filename-agnostic BY DESIGN: it lists the session
   * directory and reads the header of every canonical log it finds, so it
   * works for any format generation and either physical encoding. A fixed
   * `session.jsonl.zstd` name (the v0-era basename) is exactly what broke the
   * delete of an archived session on the v3 baseline — see the module header.
   * @returns the stored cwd, or undefined when no artifact exists anywhere.
   * @throws when the lookup itself fails — the caller must NOT treat an
   *   errored lookup as "nothing to delete" and skip the rm silently.
   */
  private async resolveArtifactCwd(sessionId: string, liveCwd: string | undefined): Promise<string | undefined> {
    if (liveCwd !== undefined && liveCwd !== '') return liveCwd
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceFace | undefined
    if (persistence !== undefined) {
      const header = (await persistence.list()).find(meta => String(meta.id) === sessionId)
      if (header !== undefined && typeof header.cwd === 'string' && header.cwd !== '') {
        return header.cwd
      }
    }
    // Fallback: ids are unique across projects by construction, so the one
    // directory named by this id holds its log. Enumerate each candidate
    // project's session directory and read the header of every canonical log
    // in it — the header is what names the cwd authoritatively.
    const encoded = encodeSegment(sessionId)
    let projects: string[]
    try {
      projects = await readdir(this.paths.sessionsRoot)
    } catch {
      return undefined
    }
    for (const project of projects) {
      const sessionDir = join(this.paths.sessionsRoot, project, encoded)
      let entries: string[]
      try {
        entries = await readdir(sessionDir)
      } catch {
        continue
      }
      for (const entry of entries) {
        // Only canonical session logs: `session.jsonl[.zstd]` (generation 0)
        // or `session.vN.jsonl[.zstd]` (generation N). `parseSessionFormatLogFilename`
        // rejects locks, `.tmp` files, migration intermediates and backups
        // (`.bak-*`), all of which live in the same directory.
        const compressed = entry.endsWith('.zstd')
        const generation = parseSessionFormatLogFilename(compressed ? entry.slice(0, -'.zstd'.length) : entry)
        if (generation === undefined) continue
        try {
          const raw = await readFile(join(sessionDir, entry))
          const text = compressed ? await zstdDecompressText(raw) : raw.toString('utf8')
          const meta = parseHeader(text.split('\n', 1)[0] ?? '')
          if (meta !== undefined && meta.id === sessionId) return meta.cwd ?? ''
        } catch {
          continue
        }
      }
    }
    return undefined
  }

  /**
   * Remove `<project>/<encoded-id>/` under the sessions root — the whole
   * session directory, not a specific log file: the log's basename is
   * generation-versioned (`session.jsonl` / `session.vN.jsonl` + compression
   * suffix — see the module header), so naming one file would miss every
   * current session. The encoded segment carries no separators by
   * construction, but the project key is derived from an untrusted stored cwd
   * — verify the resolved directory still sits under the sessions root before
   * rm.
   * @returns whether a directory was removed.
   */
  private async removeArtifact(sessionId: string, cwd: string | undefined): Promise<boolean> {
    if (cwd === undefined) return false
    const dir = sessionDirPath(this.paths.sessionsRoot, cwd, sessionId)
    const resolvedDir = resolve(dir)
    const resolvedRoot = resolve(this.paths.sessionsRoot)
    if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + sep)) {
      throw new Error(`refusing to delete "${resolvedDir}": outside the sessions root`)
    }
    try {
      await rm(resolvedDir, { recursive: true, force: false })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Strip the id from every workspace account through the registry's public
   * entity API: `detachSession` is the entity's durable mutation (it writes
   * the workspaces table itself), so no JSON file is touched here. Runs
   * BEFORE the artifact rm (see the delete's ORDERING INVARIANT), so a
   * throw aborts the delete with the session still listed and resumable.
   * Idempotent: detaching an id a workspace no longer holds is a no-op, so
   * a retried delete re-runs this safely. The global `archivedSessionIds`
   * has no public removal — a deleted-but-archived id lingers in that set
   * until the next boot, which is harmless (the archive set only intersects
   * with sessions the header index still knows; the artifact is gone, so
   * nothing displays it).
   * @throws when any workspace detach fails — aborts the delete before the
   *   artifact is touched.
   */
  private async purgeWorkspaceReferences(id: SessionId): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryFace | undefined
    if (registry === undefined) return
    for (const workspace of registry.list()) {
      try {
        await workspace.detachSession(id)
      } catch (error) {
        throw new Error(
          `detaching "${id}" from workspace "${workspace.id}" failed `
          + `(aborting deletion; the session is intact — retry): ${String(error)}`,
        )
      }
    }
  }

  /**
   * Drop this id's checkpoint row from the projection-cache store. Runs
   * BEFORE the artifact rm (see the delete's ORDERING INVARIANT) and is
   * idempotent (a missing file or row is a no-op), so a retried delete
   * re-runs it safely.
   * @throws when the row exists but the purge write fails — aborts the
   *   delete before the artifact is touched.
   */
  private async purgeProjectionCache(sessionId: string): Promise<void> {
    const path = join(this.paths.storagesRoot, 'session_projcache.json')
    let document: ProjectionCacheJsonDocument
    try {
      document = JSON.parse(await readFile(path, 'utf8')) as ProjectionCacheJsonDocument
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const rows = document.tables?.sessions
    if (rows === null || typeof rows !== 'object' || !(sessionId in rows)) return
    delete rows[sessionId]
    await writeFile(path, JSON.stringify(document, null, 2))
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await readFile(path)
      return true
    } catch {
      return false
    }
  }
}

/**
 * The slice of `ctx.agents` the archive needs, declared structurally so the
 * shell does not depend on the agent package's exports. `ctx.dispose()` on
 * the agent's scope unwinds the whole ownership chain (loop drain, registry
 * detach, session store removal) — the same teardown the AgentHandle's
 * dispose() performs, reachable without the owner-only capability.
 */
interface AgentRegistryFace {
  get(id: SessionId): { status: string; ctx: Context } | undefined
}

/**
 * The slice of `ctx.workspaceRegistry` the purge uses. Membership removal
 * goes through each entity's durable `detachSession`; the global archive
 * set has no public removal (documented known limitation of the delete).
 */
interface WorkspaceRegistryFace {
  list(): Array<{ id: string; detachSession(sessionId: SessionId): Promise<void> }>
}

/** The slice of `ctx.sessionPersistence` used to locate a cold session's cwd
 * and to await the backend's settlement of a deleted session's trailing
 * writes (see `awaitPersistenceRetirement`). */
interface SessionPersistenceFace {
  list(signal?: AbortSignal): Promise<Array<{ id: SessionId; cwd?: string }>>
  load(id: SessionId): Promise<unknown>
}

/** The durable JSON shape of `storages/session_projcache.json`. */
interface ProjectionCacheJsonDocument {
  tables?: { sessions?: Record<string, unknown> | null }
}

/** Decompress one zstd artifact into its JSONL text. */
async function zstdDecompressText(compressed: Buffer): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    zstdDecompress(compressed, (error, result) => {
      if (error !== null) rejectPromise(error)
      else resolvePromise(result.toString('utf8'))
    })
  })
}

export default CorumSessionArchive
