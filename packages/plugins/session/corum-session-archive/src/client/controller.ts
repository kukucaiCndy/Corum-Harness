/** Desktop-bridge save/import state shared by the Session Header button and the settings row. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { type SessionId } from '@deepseek-ai/dsh-session/types'
import { desktopBridge, type SessionArchiveBridge } from './bridge.ts'

/** Save phases presented by the shared modal. */
export type SessionArchiveSaveStatus = 'saving' | 'success' | 'error'

/** One Session's current save-dialog state. */
export interface SessionArchiveSaveEntry {
  readonly open: boolean
  readonly status: SessionArchiveSaveStatus
  readonly path: string | null
  readonly error: string | null
}

/** Import phases presented by the settings row. */
export type SessionArchiveImportStatus = 'idle' | 'importing' | 'success' | 'error'

/** The settings row's current import state. */
export interface SessionArchiveImportEntry {
  readonly status: SessionArchiveImportStatus
  readonly imported: readonly string[]
  readonly skipped: readonly string[]
  readonly error: string | null
}

/** Delete phases presented by the Session-scoped delete dialog. */
export type SessionArchiveDeleteStatus = 'deleting' | 'success' | 'error'

/** One Session's current delete-dialog state. */
export interface SessionArchiveDeleteEntry {
  readonly open: boolean
  readonly status: SessionArchiveDeleteStatus
  readonly error: string | null
}

/** Save states keyed by Session plus the one shared import state. */
export interface SessionArchiveState {
  bySession: Record<string, SessionArchiveSaveEntry | undefined>
  deleteBySession: Record<string, SessionArchiveDeleteEntry | undefined>
  importEntry: SessionArchiveImportEntry
  /** Session-management section state (settings "会话管理" page). */
  manageEntry: SessionArchiveManageEntry
}

/** One archived session row as presented by the session-management section. */
export interface ArchivedSessionRow {
  readonly id: string
  readonly title: string
  readonly workspaceName: string
  readonly archivedAt: string | null
}

/**
 * Session-management section status.
 *
 * - `idle`: list only.
 * - `restoring` / `deleting`: a batch run is in flight (`done`/`total`
 *   drive the progress line).
 * - `result`: the last run's outcome is on screen.
 */
export type SessionArchiveManageStatus = 'idle' | 'restoring' | 'deleting' | 'result'

/** Outcome of one archive-management run (restore or delete). */
export interface SessionArchiveManageOutcome {
  readonly kind: 'restore' | 'delete'
  /** Ids the run handled successfully. */
  readonly done: readonly string[]
  readonly failed: readonly { id: string; error: string }[]
}

/** The session-management section's current state. */
export interface SessionArchiveManageEntry {
  readonly status: SessionArchiveManageStatus
  readonly rows: readonly ArchivedSessionRow[]
  /** Number of sessions the running batch is targeting (0 when idle). */
  readonly total: number
  /** Sessions already handled by the running batch. */
  readonly done: readonly string[]
  readonly outcome: SessionArchiveManageOutcome | null
  /** Ids the last batch export could not build (host skipped them). */
  readonly exportFailed: readonly string[]
}

const IDLE_IMPORT: SessionArchiveImportEntry = {
  status: 'idle',
  imported: [],
  skipped: [],
  error: null,
}

const IDLE_MANAGE: SessionArchiveManageEntry = {
  status: 'idle',
  rows: [],
  total: 0,
  done: [],
  outcome: null,
  exportFailed: [],
}

const INITIAL: SessionArchiveState = { bySession: {}, deleteBySession: {}, importEntry: IDLE_IMPORT, manageEntry: IDLE_MANAGE }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns the native save/import operations and publishes dialog/row state. */
export class SessionArchiveController {
  /** uSES-safe state source shared by every contribution. */
  readonly store: SnapshotStore<SessionArchiveState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, Promise<void>>()
  private readonly deletes = new Map<SessionId, Promise<void>>()
  private importActive: Promise<void> | null = null
  private disposed = false

  /**
   * Host-side restore hook (one id per call) set by the plugin's apply:
   * the workspace controller's `unarchiveSession` RPC, bound there. Left
   * unset outside the desktop shell ⇒ restore reports a failure per id
   * rather than throwing into the render.
   */
  private unarchive: ((sessionId: string) => Promise<void>) | undefined

  /**
   * @param bridge - desktop native bridge; pass undefined outside the desktop shell.
   */
  constructor(private readonly bridge: SessionArchiveBridge | undefined = desktopBridge()) {}

  /** Whether the native desktop bridges are available in this environment. */
  get desktopAvailable(): boolean {
    return this.bridge !== undefined
  }

  /**
   * Row reader the settings section uses to publish the live archived set
   * into {@link setManageRows}. Bound from the plugin's apply, where the
   * workspace/session snapshots live (the controller owns bridge
   * operations only and never reads those projections itself).
   */
  private readRows: (() => readonly ArchivedSessionRow[]) | undefined

  /**
   * Bind the archived-row reader (workspace archive set ∩ live session list).
   * Called once from the plugin's apply.
   * @param readRows - reader returning the presentable archived rows.
   */
  bindArchivedRows(readRows: () => readonly ArchivedSessionRow[]): void {
    this.readRows = readRows
  }

  /** The presentable archived rows right now (empty until bound). */
  archivedRows(): readonly ArchivedSessionRow[] {
    return this.readRows?.() ?? []
  }

  /**
   * Bind the host-side restore operation (workspace `unarchiveSession`).
   * Called once from the plugin's apply; the controller never reaches for
   * cordis services itself (it owns bridge operations only).
   * @param unarchive - one-id restore call.
   */
  bindUnarchive(unarchive: (sessionId: string) => Promise<void>): void {
    this.unarchive = unarchive
  }

  /**
   * Save one Session's log ZIP through the native save dialog; concurrent
   * gestures for the same Session share one operation. A cancelled dialog
   * resolves silently (no dialog state is published).
   * @param sessionId - Session whose archive is saved.
   * @returns after the save settles, an error state is published, or a late post-disposal request is ignored.
   */
  save(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing
    if (this.disposed || this.bridge === undefined) return Promise.resolve()
    const done = this.runSave(sessionId).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, done)
    return done
  }

  /**
   * Import session log ZIP(s) through the native open dialog; concurrent
   * gestures share one operation. A cancelled dialog resolves silently.
   * @returns after the import settles or a late post-disposal request is ignored.
   */
  import(): Promise<void> {
    if (this.importActive !== null) return this.importActive
    if (this.disposed || this.bridge === undefined) return Promise.resolve()
    const done = this.runImport().finally(() => {
      this.importActive = null
    })
    this.importActive = done
    return done
  }

  /**
   * Physically delete one Session through the native confirm dialog;
   * concurrent gestures for the same Session share one operation. A
   * cancelled dialog resolves silently. The confirm lives in the main
   * process, so this promise settling means the user already confirmed.
   * @param sessionId - Session to delete.
   * @returns after the delete settles, an error state is published, or a late post-disposal request is ignored.
   */
  deleteSession(sessionId: SessionId): Promise<void> {
    const existing = this.deletes.get(sessionId)
    if (existing !== undefined) return existing
    if (this.disposed || this.bridge === undefined) return Promise.resolve()
    const done = this.runDelete(sessionId).finally(() => {
      this.deletes.delete(sessionId)
    })
    this.deletes.set(sessionId, done)
    return done
  }

  /**
   * Close one Session's delete dialog.
   * @param sessionId - Session whose modal closes.
   */
  dismissDelete(sessionId: SessionId): void {
    const current = this.store.getSnapshot().deleteBySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publishDelete(sessionId, { ...current, open: false })
  }

  /**
   * Close one Session's save dialog.
   * @param sessionId - Session whose modal closes.
   */
  dismissSave(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publishSave(sessionId, { ...current, open: false })
  }

  /** Reset the settings row back to its idle state. */
  dismissImport(): void {
    const current = this.store.getSnapshot().importEntry
    if (current.status === 'importing') return
    this.store.update((state) => {
      state.importEntry = IDLE_IMPORT
    })
  }

  /**
   * Publish the archived rows the section should list. Called by the host
   * plugin on every render (it reads the live workspace/session snapshots
   * itself — this controller deliberately does NOT: it owns bridge
   * operations, not the workspace/session projections).
   * @param rows - archived session rows to present.
   */
  setManageRows(rows: readonly ArchivedSessionRow[]): void {
    if (this.store.getSnapshot().manageEntry.status === 'restoring'
      || this.store.getSnapshot().manageEntry.status === 'deleting') return
    this.store.update((state) => {
      state.manageEntry = { ...state.manageEntry, rows: [...rows] }
    })
  }

  /** Clear the last run's outcome / export-failure note (keeps the rows). */
  dismissManageOutcome(): void {
    const current = this.store.getSnapshot().manageEntry
    if (current.outcome === null && current.exportFailed.length === 0) return
    this.store.update((state) => {
      state.manageEntry = { ...state.manageEntry, outcome: null, exportFailed: [] }
    })
  }

  /**
   * Restore the given archived sessions: drop each id from the workspace
   * archive set through the host's `workspace/unarchiveSession` RPC (the
   * same endpoint the sidebar's undo-archive toast rides), one call per id.
   * Sequential by design: each RPC writes the durable archive set, and
   * parallel writes on one registry would serialize on the host anyway.
   * @param ids - archived session ids to restore.
   * @returns after every id settles; the outcome is published.
   */
  async restoreArchived(ids: readonly string[]): Promise<void> {
    if (this.disposed || ids.length === 0) return
    if (this.store.getSnapshot().manageEntry.status === 'restoring'
      || this.store.getSnapshot().manageEntry.status === 'deleting') return
    this.store.update((state) => {
      state.manageEntry = { ...state.manageEntry, status: 'restoring', total: ids.length, done: [], outcome: null }
    })
    const done: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      if (this.disposed) break
      if (this.unarchive === undefined) {
        failed.push({ id, error: 'restore unavailable (not the desktop shell)' })
        continue
      }
      try {
        await this.unarchive(id)
        done.push(id)
      } catch (error: unknown) {
        failed.push({ id, error: messageOf(error) })
      }
      if (this.disposed) break
      this.store.update((state) => {
        state.manageEntry = { ...state.manageEntry, done: [...state.manageEntry.done, id] }
      })
    }
    if (this.disposed) return
    this.store.update((state) => {
      state.manageEntry = {
        ...state.manageEntry,
        status: 'result',
        total: ids.length,
        done,
        outcome: { kind: 'restore', done, failed },
      }
    })
  }

  /**
   * Export the given archived sessions into ONE zip through the native save
   * dialog (host builds each session's own export zip as a member). A
   * cancelled dialog resolves silently; ids the host could not build are
   * published as `exportFailed` so the section can name them.
   * @param ids - archived session ids to export.
   * @returns after the export settles.
   */
  async exportArchived(ids: readonly string[]): Promise<void> {
    if (this.disposed || this.bridge === undefined || ids.length === 0) return
    try {
      const result = await this.bridge.exportSessionsZip([...ids])
      if (this.disposed) return
      if (result.path === null && result.error === undefined) return
      this.store.update((state) => {
        state.manageEntry = { ...state.manageEntry, exportFailed: result.failed ?? [] }
      })
    } catch (error: unknown) {
      if (this.disposed) return
      this.store.update((state) => {
        state.manageEntry = { ...state.manageEntry, exportFailed: ids.map(id => id) }
      })
    }
  }

  /**
   * Delete the given archived sessions one by one through the existing
   * single-session bridge. Sequential by design: each call opens a native
   * confirm dialog, and parallel dialogs would stack invisibly on top of
   * each other. Progress is published after every settled call so the
   * section can show `done/total`.
   *
   * A cancelled native dialog resolves with `cancelled: true` and counts as
   * "not deleted" (neither success nor failure) — the run continues with
   * the remaining ids.
   * @param ids - archived session ids to delete.
   * @returns after every id settles or a concurrent run already owns the batch.
   */
  async deleteArchived(ids: readonly string[]): Promise<void> {
    if (this.disposed || this.bridge === undefined) return
    const status = this.store.getSnapshot().manageEntry.status
    if (status === 'deleting' || status === 'restoring') return
    this.store.update((state) => {
      state.manageEntry = {
        ...state.manageEntry,
        status: 'deleting',
        total: ids.length,
        done: [],
        outcome: null,
      }
    })
    const done: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      if (this.disposed) break
      try {
        const result = await this.bridge.deleteSession(id)
        if (result.cancelled === true && result.error === undefined) continue
        if (result.error !== undefined) {
          failed.push({ id, error: result.error })
          continue
        }
        if (result.deleted !== true) {
          failed.push({ id, error: 'not deleted' })
          continue
        }
        done.push(id)
      } catch (error: unknown) {
        failed.push({ id, error: messageOf(error) })
      }
      if (this.disposed) break
      this.store.update((state) => {
        state.manageEntry = { ...state.manageEntry, done: [...state.manageEntry.done, id] }
      })
    }
    if (this.disposed) return
    this.store.update((state) => {
      state.manageEntry = {
        ...state.manageEntry,
        status: 'result',
        total: ids.length,
        done,
        outcome: { kind: 'delete', done, failed },
      }
    })
  }

  /** Reach quiescence; native dialogs already handed to the OS settle on their own. */
  async dispose(): Promise<void> {
    this.disposed = true
    // The batch run polls `disposed` between bridge calls, so setting the
    // flag above is what stops it; the in-flight call settles on its own.
    await Promise.allSettled([
      ...this.active.values(),
      ...this.deletes.values(),
      ...(this.importActive === null ? [] : [this.importActive]),
    ])
  }

  private async runDelete(sessionId: SessionId): Promise<void> {
    const bridge = this.bridge
    if (bridge === undefined) return
    try {
      // The native confirm dialog opens FIRST (inside deleteSession): the
      // user confirms or cancels while NO modal is shown — publishing
      // "deleting" before this await would flash a stale dialog over the
      // native prompt. Only after the native dialog resolves do we surface
      // any state.
      const result = await bridge.deleteSession(String(sessionId))
      if (this.disposed) return
      // Cancelled native dialog: resolve silently, no feedback surface.
      if (result.cancelled === true && result.error === undefined) {
        this.clearDelete(sessionId)
        return
      }
      if (result.error !== undefined) {
        this.publishDelete(sessionId, { open: true, status: 'error', error: result.error })
        return
      }
      this.publishDelete(sessionId, { open: true, status: 'success', error: null })
    } catch (error: unknown) {
      if (this.disposed) return
      this.publishDelete(sessionId, { open: true, status: 'error', error: messageOf(error) })
    }
  }

  private async runSave(sessionId: SessionId): Promise<void> {
    const bridge = this.bridge
    if (bridge === undefined) return
    try {
      // The native save dialog opens FIRST (inside saveSessionLog): the user
      // picks a path or cancels while NO modal is shown. Publishing "saving"
      // before this await would flash a stale "saving" dialog over the native
      // picker — and leave it visible when the user cancels. Only after the
      // native dialog resolves do we surface any state.
      const result = await bridge.saveSessionLog(String(sessionId))
      if (this.disposed) return
      // Cancelled native dialog: resolve silently, no feedback surface.
      if (result.path === null && result.error === undefined) {
        this.clearSave(sessionId)
        return
      }
      if (result.error !== undefined) {
        this.publishSave(sessionId, { open: true, status: 'error', path: null, error: result.error })
        return
      }
      this.publishSave(sessionId, { open: true, status: 'success', path: result.path, error: null })
    } catch (error: unknown) {
      if (this.disposed) return
      this.publishSave(sessionId, { open: true, status: 'error', path: null, error: messageOf(error) })
    }
  }

  private async runImport(): Promise<void> {
    const bridge = this.bridge
    if (bridge === undefined) return
    this.store.update((state) => {
      state.importEntry = { status: 'importing', imported: [], skipped: [], error: null }
    })
    try {
      const result = await bridge.importSessionLog()
      if (this.disposed) return
      if (result.cancelled === true && result.error === undefined) {
        this.store.update((state) => {
          state.importEntry = IDLE_IMPORT
        })
        return
      }
      if (result.error !== undefined) {
        this.store.update((state) => {
          state.importEntry = { status: 'error', imported: [], skipped: [], error: result.error ?? null }
        })
        return
      }
      this.store.update((state) => {
        state.importEntry = {
          status: 'success',
          imported: result.imported,
          skipped: result.skipped,
          error: null,
        }
      })
    } catch (error: unknown) {
      if (this.disposed) return
      this.store.update((state) => {
        state.importEntry = { status: 'error', imported: [], skipped: [], error: messageOf(error) }
      })
    }
  }

  private publishSave(sessionId: SessionId, entry: SessionArchiveSaveEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }

  private clearSave(sessionId: SessionId): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: undefined }
    })
  }

  private publishDelete(sessionId: SessionId, entry: SessionArchiveDeleteEntry): void {
    this.store.update((state) => {
      state.deleteBySession = { ...state.deleteBySession, [String(sessionId)]: entry }
    })
  }

  private clearDelete(sessionId: SessionId): void {
    this.store.update((state) => {
      state.deleteBySession = { ...state.deleteBySession, [String(sessionId)]: undefined }
    })
  }
}
