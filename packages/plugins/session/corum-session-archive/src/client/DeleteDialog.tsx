import type { ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionArchiveState } from './controller.ts'
import { NS } from './locales.ts'

/** Browser operations and state injected into the Session Header delete contribution. */
export interface SessionArchiveDeleteInjected {
  hooks: { sessionArchive: ObservableSnapshot<SessionArchiveState> }
  deleteSession: (sessionId: SessionId) => Promise<void>
  dismiss: (sessionId: SessionId) => void
}

export type SessionArchiveDeleteDialogProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionArchiveDeleteInjected>

/**
 * Modal reporting the native delete-dialog outcome for one Session. The
 * confirm itself is the main process's native dialog — this modal only
 * reports the settled result (a cancelled native dialog never opens it).
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionArchiveDeleteDialog({
  sessionId, useSessionArchive, dismiss, t,
}: SessionArchiveDeleteDialogProps) {
  const entry = useSessionArchive(state => state.deleteBySession[String(sessionId)])

  const status = entry?.status
  const open = entry?.open === true
  const title = status === 'deleting'
    ? t('delete.deletingTitle')
    : status === 'success' ? t('delete.successTitle') : t('delete.errorTitle')
  const description = status === 'deleting'
    ? t('delete.deletingDescription')
    : status === 'success'
      ? t('delete.successDescription')
      : entry?.error ?? t('delete.failed')

  return (
    <Modal
      open={open}
      onClose={() => { dismiss(sessionId) }}
      title={title}
      description={description}
      closeLabel={t('delete.close')}
      footer={<Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('delete.close')}</Button>}
    />
  )
}
