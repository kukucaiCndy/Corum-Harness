import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useId, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconCheckOutlineMedium, IconChevronDownOutlineMedium, IconChevronUpOutlineMedium, IconCloseOutlineMedium,
  IconEditOutlineMedium, IconQueueOutlineMedium, IconSendOutlineMedium, IconTrashOutlineMedium, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { projectUserText } from '../user-text-projection.tsx'
import type { QueueAction, QueueItemId, QueueRow } from '../contract/queue.ts'
import { NS } from '../locales.ts'
import css from './QueueDock.module.css'

/** Queue operations injected by the session-scoped registration. */
export interface QueueDockInjected {
  updateQueue: (itemId: QueueItemId, action: QueueAction) => Promise<void>
  /**
   * Restore one removed row's structured content into the composer draft
   * (session input facade); returns the block tally for messaging.
   */
  restoreDraft: (content: QueueRow['content']) => { text: boolean; attachments: number }
  notify: (level: 'info' | 'error', text: string) => void
}

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat + the locale seat. */
export type QueueDockProps = PropsRuntime<'conversation.input.dock'> & QueueDockInjected & PropsLocale<'conversation'>

/**
 * Extract plain text from a UserMessage's content blocks (rc3 adaptation;
 * the old QueuedMessage had `preview`/`text` fields that no longer exist).
 */
function messageText(content: readonly { type: string; text?: string }[]): string {
  return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
}

/**
 * Queue strip: one item renders directly; multiple items default to a
 * collapsible count header; an empty queue renders nothing.
 */
export function QueueDock({ useSession, useProjection, updateQueue, restoreDraft, notify, t }: QueueDockProps) {
  // rc3: SessionSnapshot.queue was removed; inbox is now a projection.
  const inboxSnapshot = useProjection('inbox') as { readonly 'next-turn'?: readonly QueueRow[] } | undefined
  const inbox = inboxSnapshot?.['next-turn'] ?? []
  // rc3: all next-turn items are queued (placement concept removed).
  const queue = inbox
  const running = useSession(s => s.running)
  const queueMutable = useSession(s => s.subagent === null)
  const [editing, setEditing] = useState<{ id: QueueItemId; text: string } | null>(null)
  const [busy, setBusy] = useState<QueueItemId | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()

  useEffect(() => {
    if (queue.length === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && (!queueMutable || !queue.some(row => row.id === editing.id))) setEditing(null)
  }, [collapsed, editing, queue, queueMutable])

  if (queue.length === 0) return null

  const interactionActive = queueMutable && (editing !== null || busy !== null)
  const expanded = !collapsed || interactionActive
  const listVisible = queue.length === 1 || expanded

  const applyAction = async (
    itemId: QueueItemId,
    action: QueueAction,
    failure: string,
  ): Promise<boolean> => {
    setBusy(itemId)
    try {
      await updateQueue(itemId, action)
      return true
    } catch {
      notify('error', failure)
      return false
    } finally {
      setBusy(current => current === itemId ? null : current)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (editing === null || editing.text.trim() === '') return
    if (await applyAction(
      editing.id,
      { kind: 'edit', content: [{ type: 'text', text: editing.text }] },
      t('queue.editFailed'),
    )) setEditing(null)
  }

  /**
   * Remove one queued row after restoring its structured content into the
   * composer (the 「删除即回到对话框」 gesture). Restore runs first so a
   * rejected removal (already claimed) silently keeps the queue row without
   * duplicating text into the draft; the Host removes the whole row, so
   * attachment blocks cannot be selectively kept — their loss is the one
   * thing worth an info notice.
   */
  const removeAndRestore = async (row: QueueRow): Promise<void> => {
    const restored = restoreDraft(row.content)
    if (await applyAction(row.id, { kind: 'remove' }, t('queue.removeFailed')) && restored.attachments > 0) {
      notify('info', t('queue.removeAttachmentsDropped'))
    }
  }

  return (
    <div className={css.dock} data-queue-dock="">
      <div className={css.panel}>
        {queue.length > 1 && (
          <button
            type="button"
            className={css.header}
            aria-controls={listId}
            aria-expanded={expanded}
            disabled={interactionActive}
            onClick={() => { setCollapsed(value => !value) }}
          >
            <span className={css.lead} aria-hidden><IconQueueOutlineMedium /></span>
            <span className={css.count}>{t('queue.count', { n: queue.length })}</span>
            <span className={css.chevron} aria-hidden>
              {expanded ? <IconChevronDownOutlineMedium /> : <IconChevronUpOutlineMedium />}
            </span>
          </button>
        )}
        <ul id={listId} className={css.list} hidden={!listVisible}>
          {listVisible && queue.map(row => (
            <li key={row.id} className={css.row}>
              {/* Single-item strip has no count header, so the row itself carries the queue glyph. */}
              {queue.length === 1 && <span className={css.lead} aria-hidden><IconQueueOutlineMedium /></span>}
              {editing?.id === row.id
                ? (
                  <input
                    autoFocus
                    className={css.editor}
                    aria-label={t('queue.edit')}
                    value={editing.text}
                    onChange={(event) => { setEditing({ id: row.id, text: event.currentTarget.value }) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setEditing(null)
                        return
                      }
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void saveEdit()
                      }
                    }}
                  />
                )
                : <span className={css.preview}>{projectUserText(messageText(row.content), [])}</span>}
              {queueMutable && <div className={css.actions}>
                {editing?.id === row.id
                  ? (
                    <>
                      <Tooltip label={t('queue.save')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.save')}
                          disabled={busy !== null || editing.text.trim() === ''}
                          onClick={() => { void saveEdit() }}
                        >
                          <IconCheckOutlineMedium size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('queue.cancelEdit')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.cancelEdit')}
                          disabled={busy !== null}
                          onClick={() => { setEditing(null) }}
                        >
                          <IconCloseOutlineMedium size={14} />
                        </button>
                      </Tooltip>
                    </>
                  )
                  : (
                    <>
                      <Tooltip label={t('queue.edit')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.edit')}
                          disabled={busy !== null}
                          onClick={() => {
                            setEditing({ id: row.id, text: messageText(row.content) })
                          }}
                        >
                          <IconEditOutlineMedium size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('queue.remove')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.remove')}
                          disabled={busy !== null}
                          onClick={() => { void removeAndRestore(row) }}
                        >
                          <IconTrashOutlineMedium size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('queue.steer')} side="bottom" delayMs={500} disabled={!running}>
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.steer')}
                          title={running ? undefined : t('queue.steer.unavailable')}
                          disabled={busy !== null || !running}
                          onClick={() => {
                            void applyAction(
                              row.id,
                              { kind: 'steer' },
                              t('queue.steerFailed'),
                            )
                          }}
                        >
                          <IconSendOutlineMedium />
                        </button>
                      </Tooltip>
                    </>
                  )}
              </div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Registers queue actions backed by the session-scoped conversation service. */
export const queueDockEntry = {
  name: 'conversation-queue-dock',
  inject: ['slots', 'conversation', 'sessions'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'queue',
      order: 20,
      locale: NS,
      inject: (sessionId: SessionId): QueueDockInjected => {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`queue dock: session "${sessionId}" resolved no scope`)
        const conversation = actx.get('conversation')
        if (conversation === undefined) throw new Error('queue dock: conversation service unavailable')
        return {
          updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
          restoreDraft: content => conversation.input.for(actx).restoreDraft(content),
          notify: (level, text) => { conversation.input.for(actx).notify(level, text) },
        }
      },
    }, QueueDock))
  },
}
