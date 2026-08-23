import type { ReactNode } from 'react'
import { IconDownloadOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionArchiveSaveDialog, type SessionArchiveSaveDialogProps } from './SaveDialog.tsx'
import { SessionArchiveDeleteDialog, type SessionArchiveDeleteDialogProps } from './DeleteDialog.tsx'
import css from './HeaderAction.module.css'

/**
 * Render the Session Header "save log to…" capsule and its shared result dialog.
 * @param props - Session runtime, save controller, and localized dialog copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionArchiveHeaderAction(props: SessionArchiveSaveDialogProps): ReactNode {
  const { sessionId, useSessionArchive, save, t } = props
  const entry = useSessionArchive(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'saving'

  return (
    <>
      <button
        type="button"
        className={css.sessionArchiveButton}
        disabled={busy}
        aria-busy={busy}
        onClick={() => { void save(sessionId) }}
      >
        <span>{busy ? t('action.savingLabel') : t('action.saveLabel')}</span>
        <IconDownloadOutline16 size={12} />
      </button>
      <SessionArchiveSaveDialog {...props} />
    </>
  )
}

/**
 * Render the Session Header "delete session…" capsule and its result dialog.
 * The confirm is the main process's native dialog (the delete is
 * irreversible and refuses a running session); this button only triggers it.
 * @param props - Session runtime, delete controller, and localized dialog copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionArchiveDeleteHeaderAction(props: SessionArchiveDeleteDialogProps): ReactNode {
  const { sessionId, useSessionArchive, deleteSession, t } = props
  const entry = useSessionArchive(state => state.deleteBySession[String(sessionId)])
  const busy = entry?.status === 'deleting'

  return (
    <>
      <button
        type="button"
        className={css.sessionArchiveButton}
        disabled={busy}
        aria-busy={busy}
        onClick={() => { void deleteSession(sessionId) }}
      >
        <span>{busy ? t('delete.deletingLabel') : t('delete.label')}</span>
        <IconTrashOutline16 size={12} />
      </button>
      <SessionArchiveDeleteDialog {...props} />
    </>
  )
}
