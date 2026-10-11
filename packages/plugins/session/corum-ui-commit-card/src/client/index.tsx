/**
 * corum-ui-commit-card —— turn-stopping 提交卡片。
 *
 * ## 通路
 *
 * 监听 host 侧的**独立通路** `corum/commit-card/request`（waterfall）+
 * `corum/commit-card/update`（emit）。与 corum/model-ask 同款走 corum 自有通路，
 * 但卡片**无按钮**——回传立即解析为 `{ kind: 'shown' }`，不依赖用户操作。
 *
 * ## 卡片不承担阻塞（2026-10-11 用户裁定）
 *
 * 卡片是**给用户的展示**：本次 turn 有哪些改动要提交、AI 正在写什么提交信息。
 * 「LLM 必须提交完才能关 turn」由机制另行保证——host 侧 `agent.steer()` 让
 * `inbox.nextStep` 非空，turn loop 因此不 break（官方 `agent/turn-stopping`
 * 既有语义）。**不需要轮询等待**，卡片也不需要按钮。
 *
 * ## 挂载（2026-10-10 用户定调：会话流内，不再悬停输入框上方）
 *
 * 卡片渲染在会话流内：`conversation.chat.node` keyed kind 'commit-card'，锚点 =
 * 提交 steer 的 `agent/inbox/spliced`（next-step）事件（host 侧 corum-git-core
 * 给 steer 带 producer-owned `source.kind: 'commit-card'` 作确定性标记）。
 * 节点 data 只承载 `turn` 关联键；三态实时数据由 `pendingInteractions` 里的
 * PendingCommitCard 经 `corum/commit-card/update` emit 驱动（与 SubagentCard
 * 订阅 `corum/subagent/progress` 同款：会话事件只做锚点，数据来自非会话源）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// type-only：拉入 corum-ui-chat 的 SlotMap 声明（conversation.chat.node 槽由它声明）、
// corum-ui-conversation 的事件注册面、corum-api-remotes 的 corum 事件声明
// （corum/commit-card/request 的 $on key 面由此投影）。
import type {} from '@corum/corum-ui-chat/client'
import type {} from '@corum/corum-ui-conversation/client'
import type {} from '@corum/corum-api-remotes/client'
import { PendingCommitCard, type CommitCardUpdate } from './contract.ts'
import { registerCommitCardConversationNode } from './conversation-nodes/commit-card.ts'
import { createCommitCardNodeView, type PendingInteractionsFace } from './chat/CommitCardNode.tsx'
import { en, NS, zh } from './locales.ts'

export { PendingCommitCard } from './contract.ts'
export type { CommitCardRequest, CommitCardUpdate, CommitCardAnswer, CommitCardStatus } from './contract.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, Conversation nodes, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale', 'uiConversation']

type CommitCardRequestListener = TypertClientEventListener<'corum/commit-card/request'>
type ClientCommitCardRequest = Parameters<CommitCardRequestListener>[0]
type ClientCommitCardNext = Parameters<CommitCardRequestListener>[1]
type CommitCardUpdateListener = TypertClientEventListener<'corum/commit-card/update'>

/**
 * 呈现一个提交卡片直到 host 推送 done 状态（或通路生命周期结束）。
 *
 * 卡片无按钮——回传立即解析为 `{ kind: 'shown' }`。卡片持续
 * 可见（pendingInteraction 不移除），直到 host 通过 emit 推送终态。
 *
 * @param ctx - client root context。
 * @param owner - waterfall 的 scope 载体（`this`）。
 * @param request - host 下发的载荷。
 * @param next - 让给下游监听者。
 * @param registerPendingInteraction - 把待展示项登记进会话的 pending 表。
 * @returns 回传给 host 的应答。
 */
async function showCommitCard(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientCommitCardRequest,
  next: ClientCommitCardNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingCommitCard>,
): Promise<{ kind: 'shown' }> {
  const sessionId = (ctx.sessions as ISessions).scopeOf(owner)
  // 认不出归属会话 ⇒ 让给下游。
  if (sessionId === undefined) return next()
  const pending = new PendingCommitCard(sessionId, {
    sessionId: request.sessionId,
    turn: request.turn,
    status: request.status,
    effectiveFiles: request.effectiveFiles,
    totalFiles: request.totalFiles,
    diffLines: request.diffLines,
    excludedArtifacts: request.excludedArtifacts,
  })
  // 立即回传 shown（卡片无按钮）——pending 留在 pendingInteractions 里持续渲染。
  pending.shown()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
  })
  // pending 会在 applyUpdate 收到 done 后自然留在表里（由 host 控制）。
  // remove 会在通路断开时调用。
  void remove
  return { kind: 'shown' }
}

/**
 * Client plugin body: register the in-stream commit card node (definition + keyed
 * renderer) and the scoped `corum/commit-card/request` waterfall consumer +
 * `corum/commit-card/update` emit consumer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingCommitCard>(() => 1)
  const pendingInteractions = ctx.uiSession.pendingInteractions as unknown as PendingInteractionsFace
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-commit-card: dictionaries')
  // 2026-10-10 用户定调：卡片阻塞并展示在会话流中（conversation.chat.node keyed kind
  // 'commit-card'），不再悬停在输入框上方（conversation.input.dock 注册已移除）。
  registerCommitCardConversationNode(ctx)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'commit-card', locale: 'chat' },
    createCommitCardNodeView(pendingInteractions),
  ))
  // waterfall：host 下发卡片初始载荷。回传立即解析（无按钮）。
  ctx.remote.$on('corum/commit-card/request', function (request, next) {
    return showCommitCard(ctx, this, request, next, registerPendingInteraction)
  })
  // emit：host 推送状态更新（pending → progress → done）。
  ctx.remote.$on('corum/commit-card/update', function (update: CommitCardUpdate) {
    // 找到对应会话 + **同一 turn** 的 pending，applyUpdate 驱动重渲染。
    // turn 必须参与匹配（2026-10-11 修）：卡片按 turn 累积，且 `remove` 被 `void` 掉、
    // 从不主动移除 ⇒ 一个会话里会同时存在多个 turn 的 PendingCommitCard。
    // 只按 sessionId 匹配会在**第一个**命中项上 break（Map 顺序 = 最早那个 turn 的卡），
    // 于是本 turn 的卡永远收不到 done、停在「进行中」。
    // 节点侧（CommitCardNode）本来就按 sessionId + turn 解析，这里补齐同一判据。
    const snapshot = pendingInteractions.getSnapshot()
    for (const value of snapshot.values()) {
      if (value instanceof PendingCommitCard
        && String(value.sessionId) === String(update.sessionId)
        && value.request.turn === update.turn) {
        value.applyUpdate(update)
        break
      }
    }
  } as unknown as CommitCardUpdateListener)
}
