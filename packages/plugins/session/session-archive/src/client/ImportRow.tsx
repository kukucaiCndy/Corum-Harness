/**
 * Session-log import row in General settings: one native-open gesture lands
 * ZIP session artifacts into this home's sessions directory.
 */

import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionArchiveState } from './controller.ts'
import { NS } from './locales.ts'
import css from './ImportRow.module.css'

/** Registration-side business face for the import row. */
export interface SessionArchiveImportInjected {
  hooks: {
    /** Import snapshot bound by the renderer as useSessionArchive. */
    sessionArchive: ObservableSnapshot<SessionArchiveState>
  }
  /** Whether the native desktop bridges are available (false outside the desktop shell). */
  desktopAvailable: () => boolean
  /** Run the native open dialog and import the chosen ZIP(s). */
  requestImport: () => Promise<void>
  /** Reset the row back to its idle state. */
  dismissImport: () => void
}

/** Full component props. */
export type SessionArchiveImportRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionArchiveImportInjected>

/**
 * Render the import row and its outcome modal.
 * @param props - composed slot props.
 * @returns the row, plus the success/error modal when an import settled.
 */
export function SessionArchiveImportRow({
  useSessionArchive, desktopAvailable, requestImport, dismissImport, t,
}: SessionArchiveImportRowProps): ReactNode {
  const entry = useSessionArchive(state => state.importEntry)
  const available = desktopAvailable()
  const busy = entry.status === 'importing'
  const description = available ? t('import.description') : t('import.unavailable')

  const showResult = entry.status === 'success' || entry.status === 'error'
  const error = entry.status === 'error' ? entry.error || t('import.failed') : null

  return (
    <>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('import.title')}</div>
          <div className={css.desc} role={available ? undefined : 'alert'}>{description}</div>
        </div>
        <button
          type="button"
          className={css.selector}
          disabled={!available || busy}
          aria-busy={busy}
          onClick={() => { void requestImport() }}
        >
          {busy ? t('import.importing') : t('import.button')}
        </button>
      </div>
      <Modal
        open={showResult}
        onClose={dismissImport}
        title={t('import.title')}
        description={error ?? t('import.successHint')}
        closeLabel={t('import.dismiss')}
        footer={<Button variant="primary" onClick={dismissImport}>{t('import.dismiss')}</Button>}
      >
        {entry.status === 'success' && (
          <div className={css.result}>
            {entry.imported.length === 0 && entry.skipped.length === 0 && (
              <div className={css.resultHint}>{t('import.none')}</div>
            )}
            {entry.imported.length > 0 && (
              <div>
                <div>{t('import.importedLabel')}</div>
                <ul className={css.resultList}>
                  {entry.imported.map(id => <li key={id}>{id}</li>)}
                </ul>
              </div>
            )}
            {entry.skipped.length > 0 && (
              <div>
                <div>{t('import.skippedLabel')}</div>
                <ul className={css.resultList}>
                  {entry.skipped.map(id => <li key={id}>{id}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
