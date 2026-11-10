import { memo } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import { TurnUsageDisclosure } from './TurnUsageDisclosure.tsx'
import { assistantText } from './turn-assistant.ts'
import css from './TurnTailNodeView.module.css'

type TurnTailNodeViewProps = ChatNodeViewProps<'turn-tail'>
  & PropsRenderSlots<'conversation.chat.turnTail' | 'conversation.chat.assistant-actions'>

/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node, openFile, forkAt, renderSlot, t, useChat,
}: TurnTailNodeViewProps) {
  const data = node.data
  const hasLaterChatNode = useChat(snapshot =>
    snapshot.locations.getTurn(data.turn).at(-1) !== node.key)
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn === undefined) return null
  const closing = data.closing
  const owner: TurnTailOwnerProps = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile }
  // rc3（2026-10-29）：本槽是 **list**（官方 deliverables / plan / schedule 的
  // tail 条目都以 list 注册），故走普通 renderSlot 取全部条目；chain 派发器
  // （renderSlotChain）只服务 chain 槽，chain 声明还会让官方 list 条目注册即抛。
  const tail = renderSlot('conversation.chat.turnTail', owner)
  if (closing === null) return tail === null ? null : <div className={css.root}>{tail}</div>
  const runMs = turn.start === undefined || turn.end === undefined
    ? undefined
    : Math.max(0, turn.end.time - turn.start.time)
  // Interruption-frozen partials carry no messageId, so they address no
  // durable message and contribute no per-message actions.
  const messageId = closing.finalNode.messageId
  const assistantActions = messageId === undefined
    ? null
    : renderSlot('conversation.chat.assistant-actions', { messageId })
  return (
    <div className={css.root} data-turn-tail={data.turn} data-time-hover-root>
      {tail}
      <div className={css.footer}>
        {data.tokenUsage === undefined ? null : <TurnUsageDisclosure usage={data.tokenUsage} t={t} />}
        <MessageIconActions
          text={assistantText(closing.blocks)}
          time={closing.time}
          runMs={runMs}
          ttftMs={data.ttftMs}
          tokensPerSecond={data.tokensPerSecond}
          clock="end"
          onBranch={() => { forkAt(closing.finalNode.seq) }}
          branchUnavailable={data.branchUnavailable || hasLaterChatNode}
          className={css.actions}
          extraActions={assistantActions}
          t={t}
        />
      </div>
    </div>
  )
})
