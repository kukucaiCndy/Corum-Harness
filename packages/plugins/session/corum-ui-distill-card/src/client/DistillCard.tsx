/**
 * DistillCard —— 经验沉淀完成卡片（会话流内，单态：完成）。
 *
 * 卡片展示「经验沉淀完成」标题 + 「N 条候选待取舍」副标题 + 「查看归档」按钮。
 * 按钮调 `layout.openDistillArchive({jobId, sessionId})`（能力探测），不具备回落
 * `openSettingsSection('memory-agent')`。
 *
 * 与 commit-card 的区别：distill 卡片是**终态完成卡**（锚点事件本身就是完成态），
 * 不需要三态切换、不需要 pendingInteractions 订阅、不需要折叠控制器——卡片数据
 * 全部在节点 data 里（durable session.append，刷新后仍在）。
 *
 * 样式照 commit-card token 惯例（glass-1 底 + glass-border + 圆角 + CSS 变量）。
 */
import { BookMarked, ChevronRight } from 'lucide-react'
import type { DistillCardChatData, DistillArchiveCapableLayout } from './contract.ts'
import css from './DistillCard.module.css'

export interface DistillCardProps {
  /** 节点 data（jobId / sessionId / factCount）。 */
  data: DistillCardChatData
  /** layout 能力面（能力探测用；运行时可能不具备）。 */
  layout: DistillArchiveCapableLayout | undefined
}

/**
 * 经验沉淀完成卡片组件。
 * @param props - 节点 data + layout 能力面。
 */
export function DistillCard({ data, layout }: DistillCardProps) {
  const handleViewArchive = (): void => {
    if (layout === undefined) return
    // 能力探测：layout 具备 openDistillArchive 时打开归档面板，
    // 否则回落 openSettingsSection('memory-agent')。
    if (typeof layout.openDistillArchive === 'function') {
      layout.openDistillArchive({ jobId: data.jobId, sessionId: data.sessionId })
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
              {data.factCount} 条候选待取舍
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
