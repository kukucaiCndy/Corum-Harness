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
}

const IDLE_IMPORT: SessionArchiveImportEntry = {
  status: 'idle',
  imported: [],
  skipped: [],
  error: null,
}

const INITIAL: SessionArchiveState = { bySession: {}, deleteBySession: {}, importEntry: IDLE_IMPORT }

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
   * @param bridge - desktop native bridge; pass undefined outside the desktop shell.
   */
  constructor(private readonly bridge: SessionArchiveBridge | undefined = desktopBridge()) {}

  /** Whether the native desktop bridges are available in this environment. */
  get desktopAvailable(): boolean {
    return this.bridge !== undefined
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

  /** Reach quiescence; native dialogs already handed to the OS settle on their own. */
  async dispose(): Promise<void> {
    this.disposed = true
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
