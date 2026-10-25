// fork（corum）：Review 卡（文件更改审查）的 dock 槽入口。
//
// 为什么是槽注册而不是 portal（2026-09-11 重构）：
// 早先 Review 卡在 ChatView 内部渲染，为了让它不随消息滚动，曾用
// `document.querySelector('[data-composer-seat] [class*="composerStack"]')` +
// `createPortal` 把节点搬进 composer 座位的吸附容器。那是跨插件边界捞宿主
// DOM，`composerStack` 改名就会静默失效（卡片不显示、且不报错）。
// 现改为与 TodoPanel / QueueDock 完全同款的 `conversation.input.dock` 槽注册：
// 由 ConversationRoot 的 sticky composerSeat 统一吸附，几何（宽度/顺序/间距）
// 全部由槽位系统保证，不再依赖任何 DOM 选择器。
//
// 数据来源：本入口只依赖 ctx 服务（sessions / connection / corumEditor），
// 不再依赖 ChatView 的作用域——所以可以脱离 ChatView 独立挂载。
// reviewSource 的 per-binding 缓存留在 apply.ts（WeakMap，ChatView 的
// `review` prop 仍复用同一实例，两侧看到同一份聚合与水位）。

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore, useState, useRef, useEffect } from 'react'
import { ConfirmDialog } from '@corum/corum-ui-base/client'
import { History } from 'lucide-react'
import type {} from '@corum/corum-ui-conversation/client'
import { ReviewCard } from './ReviewCard.tsx'
import type { ReviewSource, ReviewRecovery, RevertAllResult } from './review-source.ts'
import { NS } from '../locale.ts'
import css from './ReviewCard.module.css'

/** `ctx.corumEditor` 的能力收窄（与 apply.ts 同款，dev-conventions §2.4 红线 2/3）。 */
interface EditorOpenCapable {
  openFile?: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>
}

/** 槽位注入面：按会话解析出的 Review 数据 + 打开 diff 动作。 */
export interface ReviewDockInjected {
  review: ReviewSource
  cwd: string | undefined
  /**
   * 点击文件行：在编辑器打开「本轮改动前 ↔ 当前」的 diff。
   *
   * 由 apply.ts 注入（那里才有 corumEditor 服务与路径换算）；本模块只负责渲染，
   * 不重复实现「重建原文 + 开 diff tab」的编排。
   */
  openDiff: (path: string) => void
}

export type ReviewDockProps =
  & PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'chat'>
  & ReviewDockInjected

/** Review 卡与恢复入口：两份列表都为空时不占用槽位。 */
export function ReviewDock({ review, cwd, openDiff, t }: ReviewDockProps) {
  const changes = useSyncExternalStore(review.subscribe, review.getSnapshot)
  const recoveries = useSyncExternalStore(review.recoveries.subscribe, review.recoveries.getSnapshot)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const requestId = useRef(0)
  const messageRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [confirmation, setConfirmation] = useState<{
    id: number; all: boolean; ready: boolean; files: { path: string; hash: string; created?: boolean }[]; error?: string
  } | null>(null)

  useEffect(() => {
    if (confirmation === null) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = messageRef.current?.closest('[role="alertdialog"]')
    const buttons = (): HTMLButtonElement[] => [...dialog?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]
    buttons()[1]?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); setConfirmation(null) }
      if (event.key === 'Tab') {
        const items = buttons(), first = items[0], last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus() }
  }, [confirmation?.id])

  /** 所有异步动作共用 busy：撤销是逐文件落盘的，期间禁止并发触发。 */
  const guarded = async (fn: () => Promise<RevertAllResult>, restoring = false): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await fn()
      if (!result.ok) setNotice({ text: result.message ?? t('review.revertFailed', { count: result.failed }), error: true })
      else if (restoring) setNotice({ text: t('review.restored'), error: false })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const requestRevert = async (path?: string): Promise<void> => {
    if (busyRef.current) return
    const id = ++requestId.current
    const files = review.getSnapshot().files.filter(file => path === undefined || file.path === path).map(file => ({ path: file.path, hash: file.hash }))
    if (files.length === 0) return
    setNotice(null)
    setConfirmation({ id, files, all: path === undefined, ready: false })
    try {
      const previews = await Promise.all(files.map(file => review.fileBefore(file.path)))
      setConfirmation(current => current?.id !== id ? current : { ...current, ready: true,
        files: files.map((file, index) => ({ ...file, created: previews[index]?.created ?? false })) })
    } catch (error) {
      setConfirmation(current => current?.id !== id ? current : { ...current, error: String(error) })
    }
  }

  const confirmRevert = async (): Promise<void> => {
    if (!confirmation?.ready || busyRef.current) return
    const current = review.getSnapshot().files
    if ((confirmation.all && current.length !== confirmation.files.length)
      || confirmation.files.some(file => !current.some(now => now.path === file.path && now.hash === file.hash))) {
      setConfirmation({ ...confirmation, error: t('review.confirmChanged') }); return
    }
    await guarded(() => confirmation.all ? review.revertAll() : review.revertFile(confirmation.files[0]!.path))
    setConfirmation(null)
  }

  const latest = recoveries[0]
  const groups = recoveries.filter((record, index) => recoveries.findIndex(other => (other.groupId ?? other.id) === (record.groupId ?? record.id)) === index)
  const count = (record: ReviewRecovery): number => recoveries.filter(item => (item.groupId ?? item.id) === (record.groupId ?? record.id)).reduce((sum, item) => sum + item.paths.length, 0)
  if (changes.files.length === 0 && recoveries.length === 0 && notice === null && confirmation === null) return null

  return (
    <div className={css.reviewCardWrapper}>
      {changes.files.length > 0 && <ReviewCard
        changes={changes}
        cwd={cwd}
        busy={busy}
        onRevertAll={async () => { await requestRevert(); return { ok: true, reverted: 0, failed: 0 } }}
        onKeepAll={() => { review.keepAll() }}
        onOpenDiff={openDiff}
        onKeepFile={path => { review.keepFile(path) }}
        onRevertFile={path => { void requestRevert(path) }}
        t={t as unknown as (key: string, params?: Record<string, string | number>) => string}
      />}
      {notice && <div className={css.notice} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
      {latest && <section className={css.recovery} aria-label={t('review.recoveryLabel')}>
        <div className={css.recoveryHeader}><History size={16} aria-hidden="true" />
          <span>{t('review.revertedFiles', { count: count(latest) })}</span><span className={css.recoverySpacer} />
          <button type="button" className={css.keepButton + ' ' + css.actionButton} disabled={busy} onClick={() => { void guarded(() => review.restoreRollback(latest), true) }}>{busy ? t('review.restoring') : t('review.restore')}</button>
        </div>
        <details className={css.recoveryDetails}><summary>{t('review.recoveryDetails')}</summary>
          {groups.map(record => <div key={record.id} className={css.recoveryRecord}>
            <ul>{recoveries.filter(item => (item.groupId ?? item.id) === (record.groupId ?? record.id)).flatMap(item => item.paths.map(path => <li key={item.id + path}>{path}</li>))}</ul>
            <button type="button" className={css.actionButton} disabled={busy} onClick={() => { void guarded(() => review.restoreRollback(record), true) }}>{t('review.restore')}</button>
          </div>)}
        </details>
      </section>}
      {confirmation && <ConfirmDialog
        title={confirmation.all ? t('review.confirmAll') : t('review.confirmFile')}
        message={<div ref={messageRef} className={css.confirmBody}>
          <p>{t('review.confirmDescription')}</p>
          <ul>{confirmation.files.map(file => <li key={file.path}><span>{file.path}</span>{file.created && <small>{t('review.confirmCreated')}</small>}</li>)}</ul>
        </div>}
        warning={t('review.confirmRecovery')}
        error={confirmation.error ?? null}
        confirmLabel={t('review.confirmRevert')}
        cancelLabel={t('review.cancel')}
        busy={busy}
        confirmDisabled={!confirmation.ready || confirmation.error !== undefined}
        onConfirm={() => { void confirmRevert() }}
        onCancel={() => { if (!busyRef.current) setConfirmation(null) }}
      />}
    </div>
  )
}

/**
 * 注册 Review 卡到 `conversation.input.dock`。
 *
 * order = -10：设计上 Review 卡排在最上（文件待确认是最需要先看的），
 * Todo 面板 order 0、Queue 面板 order 20 依次在下。
 *
 * `resolve` 由 apply.ts 注入：把「按会话取 ReviewSource / cwd / 打开 diff」
 * 留在 apply 的闭包里（那里已持有 WeakMap 缓存、会话服务与 corumEditor 服务），
 * 本模块只负责「怎么渲染、放哪个槽」，不重复实现数据获取与编排。
 */
export function registerReviewDock(
  ctx: Context,
  resolve: (sessionId: SessionId) => ReviewDockInjected,
): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'review',
    order: -10,
    locale: NS,
    inject: (sessionId: SessionId): ReviewDockInjected => resolve(sessionId),
  }, ReviewDock))
}
