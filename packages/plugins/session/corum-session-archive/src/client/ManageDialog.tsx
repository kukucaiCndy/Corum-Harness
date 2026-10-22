/**
 * Archive-management dialog: lists every archived session and deletes them
 * through the existing single-session bridge (one native confirm per session).
 *
 * Two surfaces live in one component:
 * - the list (rows + per-row delete + "delete all" + typed confirmation),
 * - the run result (deleted / failed breakdown).
 *
 * The archived ids come from the workspace snapshot and the titles from the
 * session snapshot; both are handed in by the host plugin (this component
 * never reaches for cordis services itself — see the injected face).
 */

import { type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArchivedSessionRow, SessionArchiveManageEntry, SessionArchiveState } from './controller.ts'
import { NS } from './locales.ts'
import css from './ManageDialog.module.css'

/** The typed token a user must enter to confirm a destructive batch. */
const CONFIRM_TOKEN = 'DELETE'

/** Registration-side business face for the archive-management dialog. */
export interface SessionArchiveManageInjected {
  hooks: {
    /** Archive-management snapshot bound by the renderer as useSessionArchive. */
    sessionArchive: ObservableSnapshot<SessionArchiveState>
  }
  /** Whether the native desktop bridges are available (false outside the desktop shell). */
  desktopAvailable: () => boolean
  /** Live archived rows, read by the host plugin from the workspace/session snapshots. */
  archivedRows: () => readonly ArchivedSessionRow[]
  /** Delete the given archived session ids through the single-session bridge. */
  requestDelete: (ids: readonly string[]) => Promise<void>
  /** Open the dialog over the current archived rows. */
  requestOpen: () => void
  /** Close the dialog (ignored while a delete run is in flight). */
  requestDismiss: () => void
}

/**
 * Full component props.
 *
 * Registered on the root `shell.overlay` slot (declared by corum-ide-ui), the
 * same seat as the save-result dialog: the settings button and this dialog
 * belong to different contributions, and the overlay decouples them.
 */
export type SessionArchiveManageDialogProps =
  PropsLocale<typeof NS>
  & InjectFace<SessionArchiveManageInjected>

/** Format an epoch-ms timestamp for the row meta line. */
function formatTime(updatedAt: number | null, unknownLabel: string): string {
  if (updatedAt === null) return unknownLabel
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return unknownLabel
  return date.toLocaleString()
}

/**
 * Render the archive-management dialog and its typed confirmation.
 * @param props - composed slot props.
 * @returns the dialog tree (null while closed).
 */
export function SessionArchiveManageDialog({
  useSessionArchive, desktopAvailable, archivedRows, requestDelete, requestOpen, requestDismiss, t,
}: SessionArchiveManageDialogProps): ReactNode {
  const entry = useSessionArchive(state => state.manageEntry)
  const available = desktopAvailable()
  // The settings button opens this dialog with a fresh row read; keep a local
  // copy so the list stays stable while the dialog is open even if the live
  // snapshot changes underneath (e.g. a session is archived meanwhile).
  const [pendingIds, setPendingIds] = useState<readonly string[] | null>(null)
  const [token, setToken] = useState('')
  const [tokenError, setTokenError] = useState(false)

  const rows = useMemo(() => (entry.open ? entry.rows : []), [entry.open, entry.rows])
  const deleting = entry.status === 'deleting'
  const doneSet = useMemo(() => new Set(entry.done), [entry.done])

  const openDialog = (): void => {
    setToken('')
    setTokenError(false)
    requestOpen()
  }

  const closeDialog = (): void => {
    setPendingIds(null)
    setToken('')
    setTokenError(false)
    requestDismiss()
  }

  const askDelete = (ids: readonly string[]): void => {
    setPendingIds(ids)
    setToken('')
    setTokenError(false)
  }

  const confirmDelete = (): void => {
    if (pendingIds === null) return
    if (token.trim() !== CONFIRM_TOKEN) {
      setTokenError(true)
      return
    }
    setTokenError(false)
    const ids = pendingIds
    setPendingIds(null)
    setToken('')
    void requestDelete(ids)
  }

  const failed = entry.outcome?.failed ?? []
  const deletedCount = entry.outcome?.deleted.length ?? 0

  return (
    <Modal
      open={entry.open && available}
      onClose={closeDialog}
      title={t('manage.title')}
      description={t('manage.description')}
      closeLabel={t('manage.cancel')}
      contentClassName={css.manageListRegion}
      footer={(
        <>
          {entry.status === 'idle' && rows.length > 0 && (
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => { askDelete(rows.map(row => row.id)) }}
            >
              {rows.length > 1
                ? t('manage.deleteAllCount').replace('{n}', String(rows.length))
                : t('manage.deleteAll')}
            </Button>
          )}
          {entry.status === 'result' && (
            <Button variant="primary" onClick={closeDialog}>{t('manage.dismiss')}</Button>
          )}
          {entry.status === 'idle' && rows.length === 0 && (
            <Button variant="outline" onClick={closeDialog}>{t('manage.dismiss')}</Button>
          )}
        </>
      )}
    >
      {entry.status === 'idle' && (
        <div className={css.manageRoot}>
          <div className={css.manageCount}>{t('manage.count').replace('{n}', String(rows.length))}</div>
          {rows.length === 0 ? (
            <div className={css.manageEmpty}>
              <div className={css.manageEmptyTitle}>{t('manage.empty')}</div>
              <div className={css.manageHint}>{t('manage.emptyHint')}</div>
            </div>
          ) : (
            <div className={css.manageList}>
              {rows.map(row => (
                <div className={css.manageRow} key={row.id}>
                  <div className={css.manageRowMain}>
                    <div className={css.manageRowTitle}>{row.title}</div>
                    <div className={css.manageRowMeta}>{formatTime(row.updatedAt, t('manage.unknownTime'))}</div>
                  </div>
                  <Button
                    variant="outline"
                    disabled={deleting}
                    onClick={() => { askDelete([row.id]) }}
                  >
                    {t('manage.deleteOne')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {deleting && (
        <div className={css.manageProgress}>
          {t('manage.deletingAll')
            .replace('{done}', String(doneSet.size))
            .replace('{total}', String(entry.total))}
        </div>
      )}
      {entry.status === 'result' && (
        <div className={css.resultBody}>
          <div className={css.resultSummary}>
            {failed.length === 0
              ? t('manage.resultAllDone').replace('{n}', String(deletedCount))
              : t('manage.resultPartial').replace('{done}', String(deletedCount))}
          </div>
          {failed.length > 0 && (
            <div className={css.resultSection}>
              <div className={css.resultLabel}>{t('manage.resultFailed')}</div>
              <div className={css.resultHint}>{t('manage.resultFailedHint')}</div>
              <ul className={css.resultList}>
                {failed.map(item => <li key={item.id}>{item.id} — {item.error}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      <Modal
        open={pendingIds !== null}
        onClose={() => { setPendingIds(null); setToken(''); setTokenError(false) }}
        title={t('manage.confirmTitle')}
        description={t('manage.confirmWarning')}
        closeLabel={t('manage.cancel')}
        footer={(
          <>
            <Button
              variant="outline"
              onClick={() => { setPendingIds(null); setToken(''); setTokenError(false) }}
            >
              {t('manage.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={token.trim() !== CONFIRM_TOKEN}
              onClick={confirmDelete}
            >
              {t('manage.confirmSubmit')}
            </Button>
          </>
        )}
      >
        <div className={css.confirmBody}>
          <div className={css.confirmPrompt}>
            {t('manage.confirmPrompt')}{' '}
            <span className={css.confirmToken}>{CONFIRM_TOKEN}</span>
          </div>
          <Input
            value={token}
            placeholder={t('manage.confirmPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            data-modal-autofocus
            aria-label={t('manage.confirmPrompt')}
            onChange={(event) => { setToken(event.target.value); setTokenError(false) }}
            onKeyDown={(event) => { if (event.key === 'Enter') confirmDelete() }}
          />
          {tokenError && <div className={css.confirmError}>{t('manage.confirmIncomplete')}</div>}
        </div>
      </Modal>
    </Modal>
  )
}
