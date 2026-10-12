/**
 * CommitCardNode —— 提交卡片的会话流内 keyed 渲染器（`conversation.chat.node` key = 'commit-card'）。
 *
 * 节点 data 只承载 `turn`（关联键）；按 sessionId + turn 从 `pendingInteractions`
 * 解析出 PendingCommitCard，渲染现有的 `<CommitCard/>`（三态由
 * `corum/commit-card/update` emit 驱动）。
 *
 * 历史会话（应用重启/重载后）：PendingCommitCard 是内存对象，重载后不存在，
 * 本渲染器返回 `null`（keyed 渲染器允许 decline 自己的行）。
 */
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from '@corum/corum-ui-chat/client'
import { PendingCommitCard } from '../contract.ts'
import { CommitCard } from '../CommitCard.tsx'

/** pendingInteractions 的收窄接口（与 client 主装配处同一形态）。 */
export interface PendingInteractionsFace {
  getSnapshot: () => ReadonlyMap<string, unknown>
  subscribe: (fn: () => void) => () => void
}

/** 本渲染器实际消费的 props 子集（keyed 槽运行时 props 是超集，结构收窄兼容）。 */
interface CommitCardNodeProps {
  readonly node: ChatNode<'commit-card'>
  readonly sessionId: SessionId
}

/**
 * 会话流内提交卡片节点渲染器。
 * @param props - keyed 槽运行时 props（本组件只消费 node 与 sessionId）。
 * @param pendingInteractions - 会话 pending 表（解析卡片数据来源）。
 */
export function createCommitCardNodeView(
  pendingInteractions: PendingInteractionsFace,
) {
  return function CommitCardNodeView({ node, sessionId }: CommitCardNodeProps) {
    const turn = node.data.turn
    const pending = useSyncExternalStore(pendingInteractions.subscribe, () => {
      for (const value of pendingInteractions.getSnapshot().values()) {
        if (value instanceof PendingCommitCard
          && String(value.sessionId) === String(sessionId)
          && value.request.turn === turn) return value
      }
      return null
    })
    if (pending === null) return null
    return <CommitCard key={pending.key} pending={pending} />
  }
}
