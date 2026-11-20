/**
 * DistillCard —— 经验沉淀完成 dock 卡片（单态：完成）。
 *
 * 卡片展示「经验沉淀完成」标题 + 「N 条候选待取舍」副标题 + 「查看归档」按钮。
 * 按钮调 `layout.openDistillArchive({jobId, sessionId})`（能力探测），不具备回落
 * `openSettingsSection('memory-agent')`。
 *
 * 二期改造（2026-11-19）：卡片不再锚定 durable 会话事件，改为 dock 区 host 状态
 * 投影——数据由上层 DistillDock 经 RPC distillListPending 查得，卡片只负责渲染。
 *
 * 样式照 commit-card token 惯例（glass-1 底 + glass-border + 圆角 + CSS 变量）。
 */
import { BookMarked, ChevronRight } from 'lucide-react'
import type { DistillArchiveCapableLayout } from './contract.ts'
import css from './DistillCard.module.css'

export interface DistillCardProps {
  /** 归档任务 id。 */
  jobId: string
  /** 会话 id。 */
  sessionId: string
  /** 候选经验条数。 */
  factCount: number
  /** layout 能力面（能力探测用；运行时可能不具备）。 */
  layout: DistillArchiveCapableLayout | undefined
}

/**
 * 经验沉淀完成卡片组件。
 * @param props - jobId / sessionId / factCount + layout 能力面。
 */
export function DistillCard({ jobId, sessionId, factCount, layout }: DistillCardProps) {
  const handleViewArchive = (): void => {
    if (layout === undefined) return
    // 能力探测：layout 具备 openDistillArchive 时打开归档面板，
    // 否则回落 openSettingsSection('memory-agent')。
    if (typeof layout.openDistillArchive === 'function') {
      layout.openDistillArchive({ jobId, sessionId })
    } else if (typeof layout.openSettingsSection === 'function') {
      layout.openSettingsSection('memory-agent')
    }
  }

  return (
    <div className={css.shell}>
      <div className={css.card} role="status">
        {/* 头部：avatar + 标题 + 副标题 */}
        <div className={css.header}>
          <span className={css.avatar}>
            <BookMarked size={12} />
          </span>
          <span className={css.headerTx}>
            <span className={css.title}>经验沉淀完成</span>
            <span className={css.subtitle}>
              {factCount} 条候选待取舍
            </span>
          </span>
        </div>
        {/* 操作区：查看归档按钮 */}
        <button
          type="button"
          className={css.actionBtn}
          onClick={handleViewArchive}
          disabled={layout === undefined}
        >
          <span>查看归档</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
