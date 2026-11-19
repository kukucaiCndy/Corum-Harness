/**
 * corum-ui-distill-card —— 经验沉淀完成卡片。
 *
 * ## 通路
 *
 * 监听 durable 会话事件 `corum/distill-completed`（host 侧 corum-agent 经
 * `session.append('corum/distill-completed', payload)` 追加，仅 factCount>0 时
 * append）。与 commit-card 走独立 waterfall + emit 通路不同：distill 卡片是
 * **终态完成卡**，锚点事件本身就是完成态，不需要实时状态更新通路。
 *
 * ## 卡片 UI
 *
 * 「经验沉淀完成」+「N 条候选待取舍」+「查看归档」按钮 → 能力探测调
 * `layout.openDistillArchive({jobId, sessionId})`（本地收窄面不 import 壳），
 * 不具备回落 `openSettingsSection('memory-agent')`。
 *
 * ## 挂载
 *
 * 卡片渲染在会话流内：`conversation.chat.node` keyed kind 'distill-card'，
 * 锚点 = durable 会话事件 `corum/distill-completed`。节点 data 承载完整事件数据
 * （jobId / sessionId / factCount），卡片据此渲染 + 按钮据此打开归档面板。
 *
 * ## 注册顺序（isAppendSurfaceEvent 教训）
 *
 * 注册为**普通 Definition**（`ctx.uiConversation.events.register`），不是
 * fallback。corum-ui-chat 的 `register.ts:43` 在所有普通 Definition 之后才调
 * `registerUnknownConversationFallback`——assembler 的 `dispatchInput` 先遍历
 * 全部普通 Definition（`eventDefinitions.entries()`）、最后才试 fallback
 * （`fallbackEntry()`）。本 Definition match `corum/distill-completed` ⇒ 普通匹配
 * 命中后 fallback 不再认领该事件（`matchedTargets.has(target)` 为 true ⇒ 跳过
 * fallback）。故即使本插件装载晚于 corum-ui-chat，匹配优先级仍正确。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// type-only：拉入 corum-ui-chat 的 SlotMap 声明（conversation.chat.node 槽由它声明）、
// corum-ui-conversation 的事件注册面。
import type {} from '@corum/corum-ui-chat/client'
import type {} from '@corum/corum-ui-conversation/client'
import { registerDistillCardConversationNode } from './conversation-nodes/distill-card.ts'
import { createDistillCardNodeView } from './chat/DistillCardNode.tsx'
import type { DistillArchiveCapableLayout } from './contract.ts'
import { en, NS, zh } from './locales.ts'

export type { DistillCompletedData, DistillCardChatData, DistillArchiveCapableLayout } from './contract.ts'

/** Required services: Slot registry, Conversation nodes, and copy. layout via ctx.get (capability probe). */
export const inject = ['slots', 'uiConversation', 'locale']

/**
 * ctx.layout 的记忆归档能力面收窄（红线 3：不 import 壳实现包、本地能力接口收窄）。
 * 运行时探测：layout 具备 openDistillArchive 时返回收窄面，否则返回 undefined
 * ⇒ 卡片「查看归档」按钮禁用（不伪造行为）。
 */
function distillArchiveLayout(layout: unknown): DistillArchiveCapableLayout | undefined {
  if (layout === null || typeof layout !== 'object') return undefined
  const l = layout as Record<string, unknown>
  // openDistillArchive 是 corum 壳新增能力，旧基座不具备 ⇒ 探测。
  // openSettingsSection 是壳的基本能力（fallback 用）。
  if (typeof l.openDistillArchive !== 'function' && typeof l.openSettingsSection !== 'function') return undefined
  return layout as unknown as DistillArchiveCapableLayout
}

/**
 * Client plugin body: register the in-stream distill completion card node
 * (definition + keyed renderer)。
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
  // layout 经 ctx.get 取（不 inject：本插件不强依赖壳的 layout 服务，
  // 运行时可能不具备 ⇒ 能力探测）。与 notification-bridge.ts:321 同款手法。
  const layout = distillArchiveLayout(ctx.get('layout' as never))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-distill-card: dictionaries')
  // 注册会话流节点 Definition（普通 Definition，在 fallback 之前——见文件头注）。
  registerDistillCardConversationNode(ctx)
  // 注册 keyed 渲染器（conversation.chat.node key = 'distill-card'）。
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'distill-card', locale: 'chat' },
    createDistillCardNodeView(layout),
  ))
}
