/**
 * CommitCard —— turn-stopping 阻塞式提交卡片（三态状态展示，无按钮）。
 *
 * 三态：
 *   - pending（主态）：头部 + diff --stat 预览 + 状态行（loader + 「AI 正在审查…」）
 *   - progress：chip「进行中」brand-primary + 4px 进度条 + 进度文本
 *   - done：avatar state-success + chip「已完成」+ 结果区列出分笔提交
 *   - stashed：avatar state-warn + chip「已暂存」+ 进度文本
 *
 * 卡片纯状态展示，用户不能点任何东西（阻塞由机制保证，不依赖用户操作）。
 * 状态更新由 `corum/commit-card/update` emit 通道推送，pending.applyUpdate 驱动重渲染。
 */
import { GitBranch, Loader, Check } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import type { PendingCommitCard } from './contract.ts'
import css from './CommitCard.module.css'

export interface CommitCardProps {
  pending: PendingCommitCard
}

/** 状态对应的 chip 样式。 */
function chipClass(status: PendingCommitCard['status']): string {
  switch (status) {
    case 'pending': return `${css.chip} ${css.chipWarn}`
    case 'progress': return `${css.chip} ${css.chipBrand}`
    case 'done': return `${css.chip} ${css.chipSuccess}`
    case 'stashed': return `${css.chip} ${css.chipWarn}`
    default: return css.chip
  }
}

/** 状态对应的 chip 文本。 */
function chipText(status: PendingCommitCard['status']): string {
  switch (status) {
    case 'pending': return '待提交'
    case 'progress': return '进行中'
    case 'done': return '已完成'
    case 'stashed': return '已暂存'
    default: return ''
  }
}

/** avatar 样式（pending/progress = brand-primary；done = state-success；stashed = state-warn）。 */
function avatarClass(status: PendingCommitCard['status']): string {
  if (status === 'done') return `${css.avatar} ${css.avatarDone}`
  if (status === 'stashed') return `${css.avatar} ${css.avatarStashed}`
  return css.avatar
}

/**
 * 一个订阅 pending 状态变化的 hook（useSyncExternalStore）。
 * 每次 pending.applyUpdate 被调用时触发重渲染。
 */
function usePendingStatus(pending: PendingCommitCard): PendingCommitCard {
  return useSyncExternalStore(
    pending.subscribe.bind(pending),
    () => pending,
  )
}

/**
 * 提交卡片组件。
 * @param props - 待展示项。
 */
export function CommitCard({ pending }: CommitCardProps) {
  const p = usePendingStatus(pending)
  const { request } = p
  const status = p.status

  const diffLines = request.diffLines
  const remaining = Math.max(0, request.effectiveFiles - diffLines.length)

  return (
    <div className={css.shell}>
      <div className={css.card} role="status">
        {/* 头部 */}
        <div className={css.header}>
          <span className={avatarClass(status)}>
            <GitBranch size={11} />
          </span>
          <span className={css.headerTx}>
            <span className={css.title}>整理改动并提交</span>
            <span className={css.subtitle}>
              本 turn 有 {request.effectiveFiles} 个文件改动 · 按逻辑主题分笔提交
            </span>
          </span>
          <span className={chipClass(status)}>
            <span className={css.chipDot} />
            {chipText(status)}
          </span>
        </div>

        {/* diff --stat 预览区（pending/progress 态显示） */}
        {(status === 'pending' || status === 'progress') && diffLines.length > 0 && (
          <div className={css.diffPreview}>
            {diffLines.map((line, i) => (
              <div key={i} className={css.diffLine}>{line}</div>
            ))}
            {remaining > 0 && (
              <div className={css.diffMore}>
                …还有 {remaining} 个{request.excludedArtifacts > 0 ? '（产物已排除）' : ''}
              </div>
            )}
          </div>
        )}

        {/* 状态行（pending 态） */}
        {status === 'pending' && (
          <div className={css.statusRow}>
            <span className={css.statusIcon}>
              <Loader size={14} className="animate-spin" />
            </span>
            <span className={css.statusText}>
              AI 正在审查 diff、按逻辑主题分笔写提交信息…
            </span>
          </div>
        )}

        {/* 进度条 + 进度文本（progress 态） */}
        {status === 'progress' && (
          <>
            <div className={css.progressTrack}>
              <div className={css.progressFill} style={{ width: '40%' }} />
            </div>
            <div className={css.statusRow}>
              <span className={css.statusIcon}>
                <Loader size={14} className="animate-spin" />
              </span>
              <span className={css.statusText}>
                {p.progressText || '正在提交…'}
              </span>
            </div>
          </>
        )}

        {/* 已完成结果区（done 态） */}
        {status === 'done' && p.commits.length > 0 && (
          <div className={css.resultList}>
            {p.commits.map((commit, i) => (
              <div key={i} className={css.resultItem}>
                <Check size={12} className={css.resultCheck} />
                <span>
                  {commit.type}{commit.scope !== undefined ? `(${commit.scope})` : ''}: {commit.message}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 已暂存（stashed 态） */}
        {status === 'stashed' && (
          <div className={css.statusRow}>
            <span className={css.statusText}>
              {p.progressText || '超时降级：改动已暂存，turn 已放行'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
