/**
 * @corum-shell/modules — desktop module graph composer (host half). Scans the
 * host Loader entries for packages declaring `dsh.client`, composes the
 * `window.__DSH_BOOT__` entry graph with `corump://` custom-protocol bundle
 * URLs, and provides the `corumDesktopModules` service the Electron main uses to
 * serve bundles and inject the boot manifest. Same wire shape as the official
 * `dsh-client-modules` node half; the only difference is the URL scheme, so
 * the browser shell consumes the identical graph.
 * @module corum-shell/modules
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** The custom-protocol URL prefix desktop bundles are served under. */
export const BUNDLE_PROTOCOL = 'corump://'

/** One package.json `dsh.client` declaration, validated field by field. */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  immediately?: boolean
}

/** Cached package metadata; `null` means "not a client package" (never expires). */
type PkgMeta = {
  clientPath: string
  inject?: string[]
  immediately: boolean
} | null

/** Missing built client bundle, retained for a loud activation error. */
class MissingClientBundleError extends Error {
  constructor(
    readonly packageName: string,
    readonly clientPath: string,
    cause: unknown,
  ) {
    super(
      [
        'corum-shell-modules: client bundle not found; run `pnpm run build` before launch:',
        `  package: ${packageName}`,
        `  path: ${clientPath}`,
      ].join('\n'),
      { cause },
    )
  }
}

/** sha1 content hash shortened to 12 hex chars. */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** Graph row for one bundle rev; the URL rides the rev as its cache-busting query. */
function graphRow(id: string, rev: string, injectEdges: string[] | undefined, immediately: boolean): WebBootEntry {
  return {
    id,
    url: `${BUNDLE_PROTOCOL}plugins/${id}/client.js?rev=${rev}`,
    rev,
    ...(injectEdges !== undefined ? { inject: injectEdges } : {}),
    ...(immediately ? { immediately: true } : {}),
  }
}

/** Narrow an unknown parsed value to the `dsh.client` declaration. */
function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`corum-shell-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`corum-shell-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  if (decl.inject !== undefined && (!Array.isArray(decl.inject) || decl.inject.some(i => typeof i !== 'string'))) {
    throw new Error(`corum-shell-modules: ${pkgName} dsh.client.inject must be a string array`)
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`corum-shell-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(decl.inject !== undefined ? { inject: decl.inject as string[] } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

/** Resolve `exports["./client"]` to a relative path (string or default-conditional forms). */
function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`corum-shell-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

/**
 * The desktop plugin-table service: activation-time `dsh.client` scan + graph
 * composition + bundle-path map. No incremental/HMR pass in v1: the graph is
 * composed once from the settled tree.
 */
export class CorumDesktopModuleRegistry extends Service {
  static inject = ['loader']

  private readonly table = new Map<string, { entry: WebBootEntry; clientPath: string }>()
  private readonly pkgMeta = new Map<string, PkgMeta>()
  private readonly dirty = new Set<string>()
  private readonly resolvePkgJson: (spec: string) => string
  private flushQueued = false
  private composed: WebBootGraph
  /** Dev-mode rebuild listeners: fired only when a bundle's content rev changes. */
  private readonly rebuildListeners = new Set<(id: string, rev: string) => void>()
  /** Baseline mtime/size per watched bundle (dev HMR poll). */
  private readonly watched = new Map<string, { mtimeMs: number; size: number; dirty: boolean }>()
  private pollTimer: NodeJS.Timeout | undefined

  /**
   * Build the service: subscribe to plugin lifecycle, seed the activation
   * scan, and flush synchronously so the initial graph reflects the settled
   * tree. Later arrivals (sibling rows mounting after this fiber) mark their
   * entry name dirty and land in a microtask flush, so the graph always
   * converges to the live tree.
   * @param ctx - plugin context carrying the loader service.
   */
  constructor(ctx: Context) {
    super(ctx, 'corumDesktopModules')
    if (ctx.baseUrl === undefined) {
      throw new Error('corum-shell-modules: ctx.baseUrl is unset — the node half needs the config-tree anchor to resolve plugin packages')
    }
    const require = createRequire(ctx.baseUrl)
    this.resolvePkgJson = spec => require.resolve(`${spec}/package.json`)

    ctx.on('internal/plugin', (fiber) => {
      const entryName = fiber.entry?.options.name
      if (entryName === undefined) return
      this.dirty.add(entryName)
      if (this.flushQueued) return
      this.flushQueued = true
      queueMicrotask(() => {
        this.flushQueued = false
        try {
          this.flush()
        } catch (error) {
          ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })

    // Activation pass: seed every current entry and flush synchronously.
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name !== undefined) this.dirty.add(entry.options.name)
    }
    this.flush()
    this.composed = this.compose()

    // Dev HMR: stat-poll every graph row's bundle and report content rev
    // changes to the renderer. Enabled only when CORUM_DEV_HMR is set so the
    // packaged app carries no watcher. The poll is unref'd so it never holds
    // the bridge child alive on its own.
    if (process.env.CORUM_DEV_HMR !== undefined && process.env.CORUM_DEV_HMR !== '') {
      const interval = Number.parseInt(process.env.CORUM_DEV_HMR, 10)
      this.startWatch(Number.isFinite(interval) && interval > 0 ? interval : 500)
    }
  }

  /** Current composed entry graph (stable object between changes). */
  graph(): WebBootGraph {
    return this.composed
  }

  /**
   * Absolute path of an entry's client bundle (for the `corump://` protocol
   * handler), or undefined for an unknown id.
   * @param id - entry id (package name).
   */
  clientPath(id: string): string | undefined {
    return this.table.get(id)?.clientPath
  }

  /**
   * Re-hash one bundle and, when the content rev changed, fold the new rev
   * into the graph row and notify rebuild listeners. The dev watch poll is
   * the only caller; mirrors the official client-modules rebuilt() hook.
   * @param id - entry id (package name).
   * @returns the current rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined {
    const record = this.table.get(id)
    if (record === undefined) return undefined
    let rev: string
    try {
      rev = shortHash(readFileSync(record.clientPath))
    } catch {
      return record.entry.rev // bundle momentarily unreadable mid-write; keep serving the old rev
    }
    if (rev === record.entry.rev) return rev
    record.entry = graphRow(id, rev, record.entry.inject, record.entry.immediately === true)
    this.composed = this.compose()
    for (const notify of this.rebuildListeners) {
      try {
        notify(id, rev)
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
    return rev
  }

  /**
   * Subscribe to bundle rebuilds; fires only on a real content-rev change.
   * @param listener - receives the entry id and its new rev.
   * @returns the unsubscriber.
   */
  onRebuilt(listener: (id: string, rev: string) => void): () => void {
    this.rebuildListeners.add(listener)
    return () => { this.rebuildListeners.delete(listener) }
  }

  /** Start the dev stat-poll over every watched bundle. */
  private startWatch(intervalMs: number): void {
    const poll = (): void => {
      for (const [id, record] of this.table) {
        let current: { mtimeMs: number; size: number }
        try {
          current = statSync(record.clientPath)
        } catch {
          continue // bundle removed mid-dev; keep the last good baseline
        }
        const baseline = this.watched.get(id)
        if (baseline !== undefined && !baseline.dirty
          && baseline.mtimeMs === current.mtimeMs && baseline.size === current.size) continue
        this.watched.set(id, { mtimeMs: current.mtimeMs, size: current.size, dirty: false })
        this.rebuilt(id)
      }
    }
    // Seed baselines without firing, so boot does not broadcast a spurious
    // rebuild for every row.
    for (const [id, record] of this.table) {
      try {
        const s = statSync(record.clientPath)
        this.watched.set(id, { mtimeMs: s.mtimeMs, size: s.size, dirty: false })
      } catch { /* seeded lazily on first successful poll */ }
    }
    this.pollTimer = setInterval(poll, intervalMs)
    this.pollTimer.unref()
    this.ctx.effect(() => () => {
      if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
      this.pollTimer = undefined
      this.watched.clear()
    }, 'corum-shell-modules: hmr watch')
  }

  private compose(): WebBootGraph {
    const entries = [...this.table.values()].map(record => record.entry)
    return { rev: shortHash(JSON.stringify(entries)), entries }
  }

  private resolveMeta(pkgName: string): PkgMeta {
    const cached = this.pkgMeta.get(pkgName)
    if (cached !== undefined) return cached
    let pkgPath: string
    try {
      pkgPath = this.resolvePkgJson(pkgName)
    } catch {
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh
    const decl = parseDshClient(
      pkgName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') {
      this.pkgMeta.set(pkgName, null)
      return null
    }
    const clientRel = clientExportOf(pkgName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`corum-shell-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`)
    }
    const meta: PkgMeta = {
      clientPath: join(dirname(pkgPath), clientRel),
      ...(decl.inject !== undefined ? { inject: decl.inject } : {}),
      immediately: decl.immediately === true,
    }
    this.pkgMeta.set(pkgName, meta)
    return meta
  }

  private processOne(entryName: string): void {
    if (this.table.has(entryName)) return
    const meta = this.resolveMeta(entryName)
    if (meta === null) return
    let rev: string
    try {
      rev = shortHash(readFileSync(meta.clientPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new MissingClientBundleError(entryName, meta.clientPath, error)
    }
    this.table.set(entryName, { entry: graphRow(entryName, rev, meta.inject, meta.immediately), clientPath: meta.clientPath })
  }

  /** Reconcile every dirty entry name against the live loader entries. */
  private flush(): void {
    for (const entryName of [...this.dirty]) {
      this.dirty.delete(entryName)
      // Only live, non-disabled entries qualify; a disabled or vanished entry
      // leaves the table.
      const qualifies = [...this.ctx.loader.entries()].some(entry =>
        entry.options.name === entryName && entry.fiber !== undefined && !entry.disabled)
      if (!qualifies) {
        this.table.delete(entryName)
        continue
      }
      this.processOne(entryName)
    }
    this.composed = this.compose()
  }
}

export default CorumDesktopModuleRegistry
