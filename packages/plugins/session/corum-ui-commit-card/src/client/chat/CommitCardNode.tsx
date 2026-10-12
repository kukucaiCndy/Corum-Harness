/**
 * CommitCardNode —— 提交卡片的会话流内 keyed 渲染器（`conversation.chat.node` key = 'commit-card'）。
 *
 * 节点 data 只承载 `turn`（关联键）；按 sessionId + turn 从 `pendingInteractions`
 * 解析出 PendingCommitCard，渲染现有的 `<CommitCard/>`（三态由
 * `corum/commit-card/update` emit 驱动）。
 *
 * ## 提交段折叠（2026-10-12 用户定调）
 *
 * 卡片充当「提交段」的折叠控制器：展开态由 chat store 持有（ChatNodeSeat 投影，
 * 经 owner prop `commitProcess` 下发给本渲染器）。卡片头部点击 → `commitProcess.setOpen`
 * 写回 chat store → ChatNodeSeat 隐藏/显示锚点之后的同 turn 过程节点。卡片不再
 * 自管展开态（历史会话重载后 `pending` 为 null，本渲染器 decline 返回 null）。
 *
 * 历史会话（应用重启/重载后）：PendingCommitCard 是内存对象，重载后不存在，
 * 本渲染器返回 `null`（keyed 渲染器允许 decline 自己的行）。
 */
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatNode, CommitProcessOwnerProps } from '@corum/corum-ui-chat/client'
import { PendingCommitCard } from '../contract.ts'
import { CommitCard, CommitCardHeaderFallback } from '../CommitCard.tsx'

/** pendingInteractions 的收窄接口（与 client 主装配处同一形态）。 */
export interface PendingInteractionsFace {
  getSnapshot: () => ReadonlyMap<string, unknown>
  subscribe: (fn: () => void) => () => void
}

/** 本渲染器实际消费的 props 子集（keyed 槽运行时 props 是超集，结构收窄兼容）。 */
interface CommitCardNodeProps {
  readonly node: ChatNode<'commit-card'>
  readonly sessionId: SessionId
  /** 提交段折叠态（ChatNodeSeat 经 owner prop 下发；历史会话缺失时 undefined）。 */
  readonly commitProcess?: CommitProcessOwnerProps | undefined
}

/**
 * 会话流内提交卡片节点渲染器。
 * @param props - keyed 槽运行时 props（本组件只消费 node 与 sessionId、commitProcess）。
 * @param pendingInteractions - 会话 pending 表（解析卡片数据来源）。
 */
export function createCommitCardNodeView(
  pendingInteractions: PendingInteractionsFace,
) {
  return function CommitCardNodeView({ node, sessionId, commitProcess }: CommitCardNodeProps) {
    const turn = node.data.turn
    const pending = useSyncExternalStore(pendingInteractions.subscribe, () => {
      for (const value of pendingInteractions.getSnapshot().values()) {
        if (value instanceof PendingCommitCard
          && String(value.sessionId) === String(sessionId)
          && value.request.turn === turn) return value
      }
      return null
    })
    // 无实时卡但被收进提交段容器（历史会话重载）：保留最小头部，否则容器的
    // 过程成员既无展开开关也不渲染 ⇒ 内容不可达（见 CommitCardHeaderFallback）。
    if (pending === null) {
      return commitProcess === undefined
        ? null
        : (
          <CommitCardHeaderFallback
            open={commitProcess.open}
            onToggle={open => commitProcess.setOpen(open)}
          />
        )
    }
    // 受控模式：展开态由提交段容器持有（commitProcess），卡片不再自管；
    // 且 `commitProcess` 存在 ⟺ 卡片被收进容器 ⇒ 自绘外壳交给容器（embedded）。
    // commitProcess 缺失（历史会话 / 无过程成员）时退化为组件内部自管理。
    return (
      <CommitCard
        key={pending.key}
        pending={pending}
        open={commitProcess?.open}
        embedded={commitProcess !== undefined}
        onToggle={commitProcess === undefined
          ? undefined
          : open => commitProcess.setOpen(open)}
      />
    )
  }
}
