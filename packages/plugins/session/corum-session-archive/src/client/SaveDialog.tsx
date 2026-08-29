import { type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { type SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionArchiveState } from './controller.ts'
import { NS } from './locales.ts'

/** Browser operations and state injected into the Session Header contribution. */
export interface SessionArchiveSaveInjected {
  hooks: { sessionArchive: ObservableSnapshot<SessionArchiveState> }
  save: (sessionId: SessionId) => Promise<void>
  dismiss: (sessionId: SessionId) => void
}

export type SessionArchiveSaveDialogProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionArchiveSaveInjected>

/**
 * Modal reporting the native save-dialog outcome for one Session. A cancelled
 * native dialog never opens this modal (the controller resolves silently).
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionArchiveSaveDialog({
  sessionId, useSessionArchive, dismiss, t,
}: SessionArchiveSaveDialogProps) {
  const entry = useSessionArchive(state => state.bySession[String(sessionId)])

  const status = entry?.status
  const open = entry?.open === true
  const error = status === 'error' ? entry?.error || t('dialog.saveFailed') : null
  const title = status === 'saving'
    ? t('dialog.savingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = status === 'saving'
    ? t('dialog.savingDescription')
    : status === 'success'
      ? `${t('dialog.savedTo')} ${entry?.path ?? ''}`
      : error ?? t('dialog.saveFailed')

  return (
    <Modal
      open={open}
      onClose={() => { dismiss(sessionId) }}
      title={title}
      description={description}
      closeLabel={t('dialog.close')}
      footer={<Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('dialog.close')}</Button>}
    />
  )
}
