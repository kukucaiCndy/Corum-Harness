/**
 * corum-ui-commit-card —— turn-stopping 阻塞式提交卡片。
 *
 * ## 通路
 *
 * 监听 host 侧的**独立通路** `corum/commit-card/request`（waterfall）+
 * `corum/commit-card/update`（emit）。与 corum/model-ask 同款走 corum 自有通路，
 * 但卡片**无按钮**——回传立即解析为 `{ kind: 'shown' }`，阻塞由机制保证
 * （serial dispatch + steer LLM 自己处理），不依赖用户操作。
 *
 * ## 挂载
 *
 * 与 model-ask 同槽位 `conversation.input.dock`（输入框正上方，不遮盖对话与输入框）。
 * dock 的 owner 是 `InputZone`，故本插件自行订阅 `ctx.uiSession.pendingInteractions`
 * 取当前会话的待展示项。状态更新经 `corum/commit-card/update` emit 通道推送，
 * pending.applyUpdate 驱动卡片重渲染三态。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// type-only：拉入 corum-ui-conversation 的 SlotMap 声明（conversation.input.dock
// 槽由它声明）与 corum-api-remotes 的 corum 事件声明（corum/commit-card/request
// 的 $on key 面由此投影），让本插件的 dock 注册与 remote 监听通过类型检查。
import type {} from '@corum/corum-ui-conversation/client'
import type {} from '@corum/corum-api-remotes/client'
import { PendingCommitCard, type CommitCardUpdate } from './contract.ts'
import { CommitCard } from './CommitCard.tsx'
import { en, NS, zh } from './locales.ts'

export { PendingCommitCard } from './contract.ts'
export type { CommitCardRequest, CommitCardUpdate, CommitCardAnswer, CommitCardStatus } from './contract.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

type CommitCardRequestListener = TypertClientEventListener<'corum/commit-card/request'>
type ClientCommitCardRequest = Parameters<CommitCardRequestListener>[0]
type ClientCommitCardNext = Parameters<CommitCardRequestListener>[1]
type CommitCardUpdateListener = TypertClientEventListener<'corum/commit-card/update'>

/**
 * 呈现一个提交卡片直到 host 推送 done/stashed 状态（或通路生命周期结束）。
 *
 * 卡片无按钮——回传立即解析为 `{ kind: 'shown' }`，阻塞由机制保证。卡片持续
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
  // pending 会在 applyUpdate 收到 done/stashed 后自然留在表里（由 host 控制）。
  // remove 会在通路断开时调用。
  void remove
  return { kind: 'shown' }
}

/** dock 面板：订阅 pendingInteractions，渲染当前会话的提交卡片（若有）。 */
function CommitCardDock({ sessionId, pendingInteractions }: {
  sessionId: SessionId
  pendingInteractions: {
    getSnapshot: () => ReadonlyMap<string, unknown>
    subscribe: (fn: () => void) => () => void
  }
}) {
  const pending = useSyncExternalStore(pendingInteractions.subscribe, () => {
    for (const value of pendingInteractions.getSnapshot().values()) {
      if (value instanceof PendingCommitCard && String(value.sessionId) === String(sessionId)) return value
    }
    return null
  })
  if (pending === null) return null
  return <CommitCard key={pending.key} pending={pending} />
}

/**
 * Client plugin body: register the input-dock commit card and the scoped
 * `corum/commit-card/request` waterfall consumer + `corum/commit-card/update` emit consumer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingCommitCard>(() => 1)
  const pendingInteractions = ctx.uiSession.pendingInteractions as unknown as {
    getSnapshot: () => ReadonlyMap<string, unknown>
    subscribe: (fn: () => void) => () => void
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-commit-card: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'commit-card', order: 0, locale: NS },
    (props: { sessionId?: SessionId }) => (
      props.sessionId === undefined
        ? null
        : <CommitCardDock sessionId={props.sessionId} pendingInteractions={pendingInteractions} />
    ),
  ))
  // waterfall：host 下发卡片初始载荷。回传立即解析（无按钮）。
  ctx.remote.$on('corum/commit-card/request', function (request, next) {
    return showCommitCard(ctx, this, request, next, registerPendingInteraction)
  })
  // emit：host 推送状态更新（pending → progress → done/stashed）。
  ctx.remote.$on('corum/commit-card/update', function (update: CommitCardUpdate) {
    // 找到对应会话的 pending，applyUpdate 驱动重渲染。
    const snapshot = pendingInteractions.getSnapshot()
    for (const value of snapshot.values()) {
      if (value instanceof PendingCommitCard && String(value.sessionId) === String(update.sessionId)) {
        value.applyUpdate(update)
        break
      }
    }
  } as unknown as CommitCardUpdateListener)
}
