/**
 * corum-ui-model-ask —— 子 Agent 模型不可用的决定面板（design.pen jO5So「方案C」）。
 *
 * ## 通路
 *
 * 监听 host 侧的**独立通路** `corum/model-ask/request`（waterfall）。这条通路**刻意
 * 不复用** `userQuestions` / `user-questions/request`：后者的消费者是 LLM 主动调用的
 * `ask_user_question` 工具，机制级询问与模型提问共用一条 waterfall 会互相截获
 * （谁先应答、谁被 delegate、超时归谁都不清）。两条通路各自独立监听。
 *
 * ## 挂载
 *
 * 与提问卡同槽位 `conversation.input.dock`（输入框正上方，**不遮盖**对话与输入框）——
 * 方案 C 的通知条正是设计稿里的那个位置。dock 的 owner 是 `InputZone`（不含
 * pendingInteraction），故本插件自行订阅 `ctx.uiSession.pendingInteractions` 取当前
 * 会话的待决定项。
 *
 * ## 为什么不需要 AbortSignal
 *
 * host 侧的超时由 `CORUM_ASK_TIMEOUT_MS` 在机制里 `Promise.race` 兜住；signal 不可跨
 * Remote 序列化，故载荷里没有它。用户挂起（× / 稍后）走 `dismiss()` 回传 `dismissed`，
 * 机制据此按「不改变现状」处理。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PendingInteractionPublisher, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// type-only：拉入 corum-ui-conversation 的 SlotMap 声明（conversation.input.dock
// 槽由它声明）与 corum-api-remotes 的 corum 事件声明（`corum/model-ask/request`
// 的 $on key 面由此投影），让本插件的 dock 注册与 remote 监听通过类型检查。
import type {} from '@corum/corum-ui-conversation/client'
import type {} from '@corum/corum-api-remotes/client'
import { PendingModelAsk, type ModelAskAnswer } from './contract.ts'
import { ModelAskPanel } from './ModelAskPanel.tsx'
import { en, NS, zh } from './locales.ts'

export { PendingModelAsk, modelAskAnswerOf, modelAskNeedsRoute } from './contract.ts'
export type { ModelAskAnswer, ModelAskOption, ModelAskRequest } from './contract.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

type ModelAskListener = TypertClientEventListener<'corum/model-ask/request'>
type ClientModelAskRequest = Parameters<ModelAskListener>[0]
type ClientModelAskNext = Parameters<ModelAskListener>[1]

/**
 * 呈现一个询问直到用户作答、挂起，或通路生命周期结束。
 *
 * @param ctx - client root context。
 * @param owner - waterfall 的 scope 载体（`this`）。
 * @param request - host 下发的载荷。
 * @param next - 让给下游监听者。
 * @param registerPendingInteraction - 把待决定项登记进会话的 pending 表。
 * @returns 回传给 host 的应答。
 */
async function answerModelAsk(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientModelAskRequest,
  next: ClientModelAskNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingModelAsk>,
): Promise<ModelAskAnswer> {
  const sessionId = (ctx.sessions as ISessions).scopeOf(owner)
  // 认不出归属会话 ⇒ 让给下游（没有归属就无法把面板挂到正确的会话里）。
  if (sessionId === undefined) return next()
  const pending = new PendingModelAsk(sessionId, request)
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    try {
      return await pending.result
    } catch (error) {
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    remove()
    completed.resolve()
  }
}

/** dock 面板：订阅 pendingInteractions，渲染当前会话的待决定项（若有）。 */
function ModelAskDock({ sessionId, pendingInteractions }: {
  sessionId: SessionId
  pendingInteractions: {
    getSnapshot: () => ReadonlyMap<string, unknown>
    subscribe: (fn: () => void) => () => void
  }
}) {
  const pending = useSyncExternalStore(pendingInteractions.subscribe, () => {
    for (const value of pendingInteractions.getSnapshot().values()) {
      if (value instanceof PendingModelAsk && String(value.sessionId) === String(sessionId)) return value
    }
    return null
  })
  if (pending === null) return null
  // `key` 绑定 pending 身份（**不是**可选优化，是正确性）。缺了它，同位置的新询问会被
  // React 复用上一个实例的组件 state：上一轮点击留下的 `applying=true`（还有 kind /
  // picked）会带进新面板 ⇒ 新面板一出生就只能显示 disabled 的「应用中…」，用户永远
  // 点不动（实机证据：重跑都已 `turn/end`，面板仍卡在 applying，且该 pending 的
  // `answer()` 从未被调用过）。官方 `QuestionComposer` 对 PlanReviewPanel 用的是同一
  // 手法（`key={question.key}`）。
  return <ModelAskPanel key={pending.key} pending={pending} />
}

/**
 * Derive a pending-interactions face from the rc3 `sessionStatus` observable.
 *
 * rc3 移除了 `UiSession.pendingInteractions`，改为 `sessionStatus`（每会话最高优先级
 * pendingInteraction）。本适配器投影成 `ReadonlyMap<string, unknown>` 保持消费面不变。
 */
function derivedPendingInteractions(
  sessionStatus: HostObservable<SessionStatusSnapshot>,
): { getSnapshot: () => ReadonlyMap<string, unknown>; subscribe: (fn: () => void) => () => void } {
  return {
    subscribe: fn => sessionStatus.subscribe(fn),
    getSnapshot: () => {
      const statusMap = sessionStatus.getSnapshot()
      const result = new Map<string, unknown>()
      for (const [sessionId, status] of statusMap) {
        if (status.pendingInteraction !== undefined) {
          result.set(String(sessionId), status.pendingInteraction)
        }
      }
      return result
    },
  }
}

/**
 * Client plugin body: register dictionaries, the input-dock decision panel, and the
 * scoped `corum/model-ask/request` waterfall consumer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-model-ask: dictionaries')
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingModelAsk>(() => 1)
  const pendingInteractions = derivedPendingInteractions(ctx.uiSession.sessionStatus)
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'model-ask', order: 0, locale: NS },
    (props: { sessionId?: SessionId }) => (
      props.sessionId === undefined
        ? null
        : <ModelAskDock sessionId={props.sessionId} pendingInteractions={pendingInteractions} />
    ),
  ))
  ctx.remote.$on('corum/model-ask/request', function (request, next) {
    return answerModelAsk(ctx, this, request, next, registerPendingInteraction)
  })
}
