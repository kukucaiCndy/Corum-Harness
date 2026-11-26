// fork（corum）：计划卡片——内联展开的 DisclosureRow，替代官方 PlanCards 的
// sidebar-right 打开（corum 壳没有渲染官方 sidebar-right 面板，原按钮点击静默失败）。
//
// 官方 `dsh-client-ui-plan` 的 PlanCards 是一个 <button>，点击调
// `ctx.sidebarRight.openResource(planAddress(...))`，但 corum 壳未挂载
// `RightbarRoot`（无 `rightbar` 槽渲染），sidebarRight 服务 `require()` 抛
// "no session surface is mounted" → 按钮无反应。
//
// 本组件直接从 ChatSnapshot.nodes.turnDataSource(turn, 'submitted-plan') 读
// 计划节点，用 DisclosureRow 内联展开渲染计划 Markdown——用户点卡片即展开内容，
// 不依赖 sidebar-right。

import { memo, useMemo, useState, useSyncExternalStore } from 'react'
import { DisclosureRow, FileTypeIcon, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'
import { markdownLabels } from '../markdown-labels.ts'
import css from './PlanCard.module.css'

/** Plan node payload (from `planDefinition.buildViewNode` in dsh-client-ui-plan). */
interface PlanData {
  readonly callId: string
  readonly markdown: string
  readonly title: string
}

/** Read plan nodes for one Turn from the Chat node store. */
function usePlanNodes(nodes: ChatNodeStore | undefined, turn: number): readonly ChatConversationViewNode[] {
  return useSyncExternalStore(
    (listener: () => void) => {
      if (nodes === undefined || typeof nodes.turnDataSource !== 'function') return () => {}
      const source = nodes.turnDataSource(turn, 'submitted-plan' as never)
      return source.subscribe(listener)
    },
    () => {
      if (nodes === undefined || typeof nodes.turnDataSource !== 'function') return EMPTY
      const source = nodes.turnDataSource(turn, 'submitted-plan' as never)
      return source.getSnapshot()
    },
    () => EMPTY,
  )
}

const EMPTY: readonly ChatConversationViewNode[] = []

interface PlanCardProps {
  /** Turn number to read plan nodes for. */
  turn: number
  /** Chat snapshot selector hook (from ChatNodeViewProps.useChat). */
  useChat: ChatViewSlotProps['useChat']
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * Renders one expandable card per submitted plan in the Turn tail.
 *
 * Replaces the official PlanCards button (which opens a sidebar-right tab that
 * corum's shell never mounts). Each card is a DisclosureRow that expands inline
 * to show the full plan Markdown.
 */
export const PlanCard = memo(function PlanCard({ turn, useChat, t }: PlanCardProps) {
  const nodeStore = useChat(s => s.nodes)
  const planNodes = usePlanNodes(nodeStore, turn)
  const plans = useMemo(() => planNodes
    .map(node => (node as { data?: PlanData }).data)
    .filter((data): data is PlanData => data !== undefined),
    [planNodes])
  if (plans.length === 0) return null
  return (
    <div className={css.cards} data-corum-plan>
      {plans.map(plan => <PlanCardItem key={plan.callId} plan={plan} t={t} />)}
    </div>
  )
})

interface PlanCardItemProps {
  plan: PlanData
  t: ChatViewSlotProps['t']
}

function PlanCardItem({ plan, t }: PlanCardItemProps) {
  const [expanded, setExpanded] = useState(false)
  const labels = useMemo(() => markdownLabels(t), [t])
  return (
    <div className={css.card} data-plan-card={plan.callId}>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<FileTypeIcon kind="markdown" size={20} />}
        title={plan.title}
        open={expanded}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <span className={css.description}>{t('plan.document')}</span>
        )}
      >
        <div className={css.document}>
          <MarkdownText text={plan.markdown} labels={labels} />
        </div>
      </DisclosureRow>
    </div>
  )
}
