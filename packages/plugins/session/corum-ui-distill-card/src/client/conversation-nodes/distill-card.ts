/**
 * 经验沉淀完成卡片的会话流内节点 Definition。
 *
 * ## 锚点

 * 锚点事件 = durable 会话事件 `plugin:corum-agent/distill-completed`（host 侧
 * corum-agent 的 memory-distill.ts 经 `appendPluginRecord(session, type, payload)`
 * 追加，自动携带 `ignorable:true`，仅 factCount>0 时 append）。它是**终态**完成
 * 事件——不同于 commit-card 监听 mid-turn steer 事件再靠 emit 驱动三态，distill
 * 卡片只需在事件出现时渲染一张「完成」卡。
 *
 * ## 注册顺序（isAppendSurfaceEvent 教训）
 *
 * 注册为**普通 Definition**（`ctx.uiConversation.events.register`），在
 * `registerFallback` 之前注册（corum-ui-chat 的 register.ts:43 先调
 * `registerUnknownConversationFallback`——但本包是独立插件，apply 在 corum-ui-chat
 * 之后装载；assembler 的 `dispatchInput` 先遍历全部普通 Definition、最后才试
 * fallback，故普通 Definition 注册时序不影响匹配优先级）。fallback 只匹配
 * **未被任何普通 Definition match 的** append-surface 事件，而本 Definition
 * match `plugin:corum-agent/distill-completed` ⇒ fallback 不会再认领它。
 *
 * ## 数据与渲染
 *
 * 节点 data 直接承载完整事件数据（jobId / sessionId / factCount）——卡片渲染
 * 只需这些静态字段，「查看归档」按钮调 `layout.openDistillArchive({jobId, sessionId})`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@corum/corum-ui-conversation/client'
import type { ChatNode } from '@corum/corum-ui-chat/client'
import type { DistillCardChatData } from '../contract.ts'

/** `plugin:corum-agent/distill-completed` 事件载荷的本地收窄（只读锚点判定需要的字段）。 */
interface DistillCompletedEvent {
  readonly jobId: string
  readonly sessionId: string
  readonly factCount: number
}

/**
 * `plugin:corum-agent/distill-completed` 不在官方 SessionEventMap 的 type union 里
 * （它是 host 侧 corum-agent 经 `appendPluginRecord` 写入的 plugin record，自动携带
 * `ignorable:true`）。本插件不 import host 包，故 event.type 的编译期类型不含此字符串。
 * 用 `(event as { type: string })` 收窄到 string 再比较。
 */
function isDistillCompletedEvent(event: { type: string }): boolean {
  return event.type === 'plugin:corum-agent/distill-completed'
}

/**
 * 经验沉淀完成卡片节点的 ConversationNodeDefinition。
 *
 * 每条锚点事件一个 Context（id = 事件 seq），start 直接从事件 data 读出完整
 * 卡片数据（jobId / sessionId / factCount）。
 */
export const distillCardDefinition: ConversationNodeDefinition<DistillCardChatData> = {
  kind: 'distill-card',
  target: 'chat',
  match: (event) => isDistillCompletedEvent(event as { type: string })
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    const data = match.event.data as DistillCompletedEvent
    return {
      jobId: data.jobId,
      sessionId: data.sessionId,
      factCount: data.factCount,
    }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const anchorSeq = context.start?.event.seq
    if (anchorSeq === undefined) return null
    const node: ChatNode<'distill-card'> = {
      key: context.key,
      kind: 'distill-card',
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
 * 注册经验沉淀完成卡片会话流节点。
 * @param ctx - owning UI Conversation context。
 */
export function registerDistillCardConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(distillCardDefinition)
}
