// fork（corum）：Review 卡（文件更改审查卡）——固定在消息流底部、composer
// 上方的玻璃卡。官方 dsh 无此功能，是 corum 特有新建。折叠态一行摘要
// （N 文件 + 总 diff），展开态列出每文件 +N −M；「全部撤销」反向 apply 本轮
// 写操作，「全部保留」确认并收起卡片。

import { useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReviewChanges } from './review-changes.ts'
import css from './ReviewCard.module.css'

/** Review 卡视图所需的全部业务回调（由 ChatView 装配时注入）。 */
export interface ReviewCardActions {
  /** 「全部撤销」：按 revertOrder 逆序反向 apply 本轮所有写操作。 */
  onRevertAll: () => Promise<{ ok: boolean; reverted: number; failed: number; message?: string }>
  /** 「全部保留」：确认本轮写操作，dismiss 卡片。 */
  onKeepAll: () => void
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
  changes, cwd, busy, onRevertAll, onKeepAll, t,
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
        <IconChevronDownOutline14 className={css.chevron} />
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
              <span className={css.filePath} title={file.path}>
                {displayPath(file.path, cwd)}
              </span>
              <span className={css.fileDiff}>
                <span className={css.added}>+{file.added}</span>
                <span className={css.removed}>−{file.removed}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {notice !== null && <div className={css.notice}>{notice}</div>}
    </div>
  )
}
