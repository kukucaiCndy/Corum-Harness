/**
 * 提交卡片的会话流内节点 Definition（2026-10-10 用户定调：卡片阻塞并展示在会话流中）。
 *
 * ## 锚点
 *
 * 锚点事件 = 提交 steer 的 `agent/inbox/spliced`（`target === 'next-step'`）：它是
 * turn-stopping 阻塞窗口内**唯一** durable 的 mid-turn 事件（`agent.steer()` →
 * `inbox.splice` 立即 `session.append`），凭 `inserted[].source.kind === 'commit-card'`
 * 与卡片确定性关联（host 侧 corum-git-core 给 steer 带的 producer-owned 来源标记）。
 *
 * ## 数据与渲染
 *
 * 节点 data 只承载 `turn`（关联键）；三态实时数据由 `pendingInteractions` 里的
 * PendingCommitCard 经 `corum/commit-card/update` emit 驱动——与 SubagentCard 订阅
 * `corum/subagent/progress` 同款：会话事件只做锚点与重算触发，数据可以来自非会话源。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@corum/corum-ui-conversation/client'
import type { ChatNode } from '@corum/corum-ui-chat/client'
import type { CommitCardChatData } from '../contract.ts'

/** host steer 的 producer-owned 来源标记（与 corum-git-core 一致）。 */
export const COMMIT_CARD_SOURCE_KIND = 'commit-card'

/** `agent/inbox/spliced` 事件载荷的本地收窄（只读锚点判定需要的字段）。 */
interface InboxSplicedData {
  readonly target: string
  readonly inserted: readonly { readonly source: { readonly kind?: string } }[]
}

/** 该事件是否是提交卡片的锚点（next-step steer 且带 commit-card 来源标记）。 */
function isCommitCardAnchor(data: unknown): boolean {
  const splice = data as InboxSplicedData
  if (splice.target !== 'next-step' || !Array.isArray(splice.inserted)) return false
  return splice.inserted.some(message => message.source?.kind === COMMIT_CARD_SOURCE_KIND)
}

/**
 * 提交卡片节点的 ConversationNodeDefinition。
 *
 * 每条锚点事件一个 Context（id = 事件 seq），state 承载 `turn`（buildViewNode 时从
 * 事件 Location 读出——log-only 事件由 location-index 按当前 turn 归属）。
 */
export const commitCardDefinition: ConversationNodeDefinition<CommitCardChatData> = {
  kind: 'commit-card',
  target: 'chat',
  match: (event) => event.type === 'agent/inbox/spliced' && isCommitCardAnchor(event.data)
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    const location = match.location
    const turn = location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.turn
      : undefined
    return turn === undefined ? { turn: -1 } : { turn }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined || context.state.turn < 0) return null
    const anchorSeq = context.start?.event.seq
    if (anchorSeq === undefined) return null
    const node: ChatNode<'commit-card'> = {
      key: context.key,
      kind: 'commit-card',
      id: context.id,
      target: 'chat',
      anchorSeq,
      location: context.start!.location,
      visibility: 'visible',
      data: context.state,
    }
    return node
  },
}

/**
 * 注册提交卡片会话流节点。
 * @param ctx - owning UI Conversation context。
 */
export function registerCommitCardConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(commitCardDefinition)
}
