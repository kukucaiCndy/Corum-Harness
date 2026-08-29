// fork（corum）：子 Agent 进度卡——主 Agent 召唤子 Agent（delegation）时在消息瀑布
// 中流出的玻璃卡。avatar(bot) + 任务描述 + run-chip（Running/已完成）+ prompt 摘要。
// 降级版：卡片框架 + delegation 信息 + 运行态；精确 step 进度条后续接子会话事件窗。
import { memo } from 'react'
import { Bot, Check, Loader } from 'lucide-react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import css from './SubagentCard.module.css'

/** 一个 delegation 召唤的卡片（运行态由调用方经子会话观测注入，缺省视为运行中）。 */
function SubagentRow({
  description, prompt, running, t,
}: {
  description: string | undefined
  prompt: string | undefined
  running: boolean
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  return (
    <div className={css.card}>
      <div className={css.head}>
        <span className={css.avatar}><Bot size={12} strokeWidth={2} className={css.avatarIcon} /></span>
        <span className={css.meta}>
          <span className={css.name}>{t('subagent.name')}</span>
          {description !== undefined && <span className={css.task}>{description}</span>}
        </span>
        <span className={running ? css.runChip : css.doneChip}>
          {running
            ? <><span className={css.runDot} />{t('subagent.running')}</>
            : <><Check size={12} strokeWidth={2.5} />{t('subagent.done')}</>}
        </span>
      </div>
      {running && (
        <div className={css.stepRow}>
          <Loader size={13} strokeWidth={2} className={css.stepIcon} />
          <span className={css.stepText}>{prompt ?? t('subagent.working')}</span>
        </div>
      )}
    </div>
  )
}

/** 子 Agent 进度卡（一个 Turn 的 delegation 召唤们，各自一张卡）。 */
export const SubagentCard = memo(function SubagentCard({ node, t }: ChatNodeViewProps<'subagent-call'>) {
  const invocations = node.data.invocations
  if (invocations.length === 0) return null
  return (
    <>
      {invocations.map(invocation => (
        <SubagentRow
          key={invocation.callId}
          description={invocation.description}
          prompt={invocation.prompt}
          running
          t={t}
        />
      ))}
    </>
  )
})
