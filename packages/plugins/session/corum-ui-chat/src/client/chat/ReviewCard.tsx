// fork（corum）：Review 卡（文件更改审查卡）——固定在消息流底部、composer
// 上方的玻璃卡。官方 dsh 无此功能，是 corum 特有新建。折叠态一行摘要
// （N 文件 + 总 diff），展开态列出每文件 +N −M；「全部撤销」反向 apply 本轮
// 写操作，「全部保留」确认并收起卡片。

import { useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReviewChanges } from './review-changes.ts'
import css from './ReviewCard.module.css'

/** Review 卡视图所需的全部业务回调（由 ChatView 装配时注入）。 */
export interface ReviewCardActions {
  /** 「全部撤销」：按 revertOrder 逆序反向 apply 本轮所有写操作。 */
  onRevertAll: () => Promise<{ ok: boolean; reverted: number; failed: number; message?: string }>
  /** 「全部保留」：确认本轮写操作，dismiss 卡片。 */
  onKeepAll: () => void
  /** 展开态点击文件行：在编辑器打开「本轮改动前 ↔ 当前」的 diff 视图。
   *  （原文由 host 逆序反推重建 —— 会话事件流不含文件旧内容。） */
  onOpenDiff?: ((path: string) => void) | undefined
  /** 「保留此文件」：只确认这一个文件，它随即从卡片消失，其它文件不受影响。 */
  onKeepFile?: ((path: string) => void) | undefined
  /** 「撤销此文件」：只反向 apply 这一个文件的写操作。 */
  onRevertFile?: ((path: string) => void) | undefined
}

/** 文案 t 函数的最小面（chat 命名空间）。 */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** 路径显示：优先相对 cwd 的相对路径，超长时头省略。 */
function displayPath(path: string, cwd: string | undefined): string {
  let shown = path
  if (cwd !== undefined && cwd !== '' && path.startsWith(cwd + '/')) {
    shown = path.slice(cwd.length + 1)
  }
  const MAX = 72
  if (shown.length <= MAX) return shown
  return `…${shown.slice(-(MAX - 1))}`
}

export function ReviewCard({
  changes, cwd, busy, onRevertAll, onKeepAll, onOpenDiff, onKeepFile, onRevertFile, t,
}: {
  changes: ReviewChanges
  cwd: string | undefined
  busy: boolean
  t: Translate
} & ReviewCardActions) {
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const revertAll = () => {
    if (busy) return
    setNotice(null)
    void onRevertAll().then((result) => {
      if (result.ok) {
        setNotice(null)
        return
      }
      setNotice(result.message ?? t('review.revertFailed', { count: result.failed }))
    })
  }

  return (
    <div className={css.root} data-open={open || undefined} data-review-card="">
      <button
        type="button"
        className={css.summary}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconChevronDownOutlineMedium className={css.chevron} />
        <span className={css.title}>
          {t('review.filesChanged', { count: changes.files.length })}
        </span>
        <span className={css.diff}>
          <span className={css.added}>+{changes.totalAdded}</span>
          <span className={css.removed}>−{changes.totalRemoved}</span>
        </span>
        <span className={css.spacer} />
      </button>
      <div className={css.actions}>
        <button
          type="button"
          className={clsx(css.actionButton, css.revertButton)}
          disabled={busy}
          onClick={revertAll}
        >
          {busy ? t('review.reverting') : t('review.revertAll')}
        </button>
        <button
          type="button"
          className={clsx(css.actionButton, css.keepButton)}
          disabled={busy}
          onClick={onKeepAll}
        >
          {t('review.keepAll')}
        </button>
      </div>
      {open && (
        <ul className={css.fileList}>
          {changes.files.map(file => (
            <li key={file.path} className={css.fileRow}>
              {onOpenDiff !== undefined
                ? (
                  <button
                    type="button"
                    className={css.filePathButton}
                    title={`${file.path} — 查看本轮改动`}
                    onClick={() => { onOpenDiff(file.path) }}
                  >
                    {displayPath(file.path, cwd)}
                  </button>
                )
                : (
                  <span className={css.filePath} title={file.path}>
                    {displayPath(file.path, cwd)}
                  </span>
                )}
              <span className={css.fileDiff}>
                {/* 问题 2 父卡聚合：子 Agent 归属标注（该行的 pre-image/撤销按子会话路由）。 */}
                {file.fromSubagent !== undefined && (
                  <span className={css.subagentChip} title={file.fromSubagent}>
                    {t('review.fromSubagent')}
                  </span>
                )}
                <span className={css.added}>+{file.added}</span>
                <span className={css.removed}>−{file.removed}</span>
              </span>
              {/* 单文件粒度动作：只作用于这一行对应的文件（水位/撤销都按文件隔离，
                  见 review-source.ts 的 publishFileSeq）。hover 才显形，避免列表噪声。 */}
              {(onKeepFile !== undefined || onRevertFile !== undefined) && (
                <span className={css.fileActions}>
                  {onRevertFile !== undefined && (
                    <button
                      type="button"
                      className={css.fileActionButton}
                      disabled={busy}
                      title={`撤销 ${displayPath(file.path, cwd)} 的改动`}
                      aria-label={`撤销 ${displayPath(file.path, cwd)} 的改动`}
                      onClick={() => { onRevertFile(file.path) }}
                    >
                      {t('review.revert')}
                    </button>
                  )}
                  {onKeepFile !== undefined && (
                    <button
                      type="button"
                      className={clsx(css.fileActionButton, css.fileKeepButton)}
                      disabled={busy}
                      title={`保留 ${displayPath(file.path, cwd)} 的改动`}
                      aria-label={`保留 ${displayPath(file.path, cwd)} 的改动`}
                      onClick={() => { onKeepFile(file.path) }}
                    >
                      {t('review.keep')}
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice !== null && <div className={css.notice}>{notice}</div>}
    </div>
  )
}
