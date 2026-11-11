import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useId, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconCheckOutlineMedium, IconChevronDownOutlineMedium, IconChevronUpOutlineMedium, IconCloseOutlineMedium,
  IconEditOutlineMedium, IconQueueOutlineMedium, IconSendOutlineMedium, IconTrashOutlineMedium, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { projectUserText } from '../user-text-projection.tsx'
import type { QueueAction, QueueItemId, QueueRow } from '../contract/queue.ts'
import { NS } from '../locales.ts'
import css from './QueueDock.module.css'

/** Queue operations injected by the session-scoped registration. */
export interface QueueDockInjected {
  updateQueue: (itemId: QueueItemId, action: QueueAction) => Promise<void>
  /**
   * 取排队行里图片附件的可显示 URL（issue #211）。
   *
   * 排队行只画文本 ⇒ **纯图片消息渲染成一行空白**，用户以为图丢了。图片本身没丢
   * （durable ref 一直在 `next-turn` 的 content 里，模型收到的是完整两块），丢的是
   * 展示。这里复用 chat 的同一条取图通路（先 peek 命中缓存，未命中再异步取）。
   */
  imageUrl: (attachment: ImageAttachmentRef) => string | undefined
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
 * 一行排队消息里的「非文本块」拆解（issue #211）。
 *
 * 排队行原先只取 text 块投影：纯图片消息于是渲染成空白行。这里把图片/文件块分开，
 * 供缩略图与「N 个附件」占位使用。
 *
 * @param content - 排队消息的 content 块。
 * @returns 图片块、其它非文本块数量、是否含非文本块。
 */
export function queueAttachmentsOf(content: readonly { readonly type: string; readonly attachment?: unknown }[]): {
  readonly images: readonly ImageAttachmentRef[]
  readonly files: number
  readonly hasNonText: boolean
} {
  const images: ImageAttachmentRef[] = []
  let files = 0
  for (const block of content) {
    if (block.type === 'image' && block.attachment !== undefined) images.push(block.attachment as ImageAttachmentRef)
    else if (block.type !== 'text') files += 1
  }
  return { images, files, hasNonText: images.length > 0 || files > 0 }
}

/**
 * Queue strip: one item renders directly; multiple items default to a
 * collapsible count header; an empty queue renders nothing.
 */
export function QueueDock({ useSession, useProjection, updateQueue, restoreDraft, notify, imageUrl, t }: QueueDockProps) {
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
                : (() => {
                  const preview = projectUserText(messageText(row.content), [])
                  const { images, files, hasNonText } = queueAttachmentsOf(row.content)
                  const fileLabel = files === 0 ? '' : t('queue.attachments', { n: files })
                  if (!hasNonText) {
                    return <span className={css.preview}>{preview}</span>
                  }
                  return (
                    <span className={css.preview}>
                      {preview !== '' && <span>{preview}</span>}
                      {images.map((attachment, index) => {
                        const url = imageUrl(attachment)
                        return url === undefined
                          ? <span key={`image-${index}`} className={css.attachmentChip}>{t('queue.attachments', { n: 1 })}</span>
                          : (
                            <img
                              key={`image-${index}`}
                              className={css.attachmentThumb}
                              src={url}
                              alt={t('queue.attachments', { n: images.length })}
                              data-queue-attachment="image"
                            />
                          )
                      })}
                      {fileLabel !== '' && <span className={css.attachmentChip} data-queue-attachment="file">{fileLabel}</span>}
                    </span>
                  )
                })()}
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
                      <Tooltip
                        label={queueAttachmentsOf(row.content).hasNonText ? t('queue.editUnavailableAttachments') : t('queue.edit')}
                        side="bottom"
                        delayMs={500}
                      >
                        <button
                          type="button"
                          className={css.action}
                          aria-label={t('queue.edit')}
                          // issue #211：编辑是**整份替换**（host 侧 `inbox.replace` 只收文本），
                          // 含附件的行一旦编辑，图片就永久变成文字。故此处禁用，并给出原因。
                          disabled={busy !== null || queueAttachmentsOf(row.content).hasNonText}
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
  inject: ['slots', 'conversation', 'sessions', 'uiConversation'],
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
        // issue #211：排队行也要能出图。先 peek 命中缓存（本地回显退休时已 seed），
        // 未命中返回 undefined ⇒ 该处退化成「N 个附件」占位（不阻塞渲染、不发请求）。
        const images = ctx.uiConversation
        return {
          imageUrl: (attachment) => images?.peekImageUrl(sessionId, attachment),
          updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
          restoreDraft: content => conversation.input.for(actx).restoreDraft(content),
          notify: (level, text) => { conversation.input.for(actx).notify(level, text) },
        }
      },
    }, QueueDock))
  },
}
