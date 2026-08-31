/**
 * corum-ui-questions —— 提问卡片（corum 重设计，design.pen K2M4e9）。
 *
 * 与官方 `dsh-client-ui-user-questions` 的关系：**数据通路完全复用**（同一
 * `user-questions/request` Remote waterfall + 官方 `PendingQuestion`），**渲染层
 * 替换**——官方接管整个 composer（遮盖对话与输入框），corum 把提问做成卡片挂在
 * `conversation.composer.dock`（输入框正上方、不遮盖），用户可边看清上下文边作答，
 * 正在编辑的指令不被打断。
 *
 * 挂 dock 而非 composer chain 的代价：dock 的 owner 是 `InputZone`（不含
 * pendingInteraction），故卡片自行订阅 `ctx.uiSession.pendingInteractions` 取当前
 * 会话的 PendingQuestion；发送拦截经 `ConversationController.blocks`（答完才能发）。
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
// type-only：拉入 corum-ui-conversation 的 SlotMap 声明（conversation.composer.dock
// 槽由它声明），让本插件的 dock 注册通过类型检查（TS 模块合并全局生效）。
import type {} from '@corum/corum-ui-conversation/client'
import { PendingQuestion } from './contract.ts'
import { QuestionCard } from './QuestionCard.tsx'
import { en, zh, NS } from './locales.ts'

export { PendingQuestion } from './contract.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, copy,
 *  and Conversation (composer send-block while a question awaits an answer). */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale', 'conversation']

/** The composer send-block registry face (ctx.conversation.blocks). */
interface ConversationBlocks {
  set(sessionId: SessionId, block: { reason: string } | undefined): void
}

type QuestionListener = TypertClientEventListener<'user-questions/request'>
type ClientQuestionRequest = Parameters<QuestionListener>[0]
type ClientQuestionNext = Parameters<QuestionListener>[1]
type ClientQuestionAnswer = Awaited<ReturnType<QuestionListener>>

/** Present one request until the user answers, cancels, or its lifetime ends. */
async function answerQuestion(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientQuestionRequest,
  next: ClientQuestionNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingQuestion>,
): Promise<ClientQuestionAnswer> {
  const sessionId = (ctx.sessions as ISessions).scopeOf(owner)
  if (sessionId === undefined) return next()
  const pending = new PendingQuestion(sessionId, request.questions, request.signal)
  // 发送拦截（用户定调：答完问题才能发消息）：提问挂起期间 set composer block——
  // 输入框仍可复制/剪切/编辑（block 只禁发送、保留编辑器与模型选择），答完 clear。
  const blocks = (ctx.get('conversation') as { blocks?: ConversationBlocks } | undefined)?.blocks
  blocks?.set(sessionId, { reason: '请先回答上方的问题' })
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
    blocks?.set(sessionId, undefined)
    completed.resolve()
  }
}

/** dock 卡片：订阅 pendingInteractions，渲染当前会话的 PendingQuestion（若有）。 */
function QuestionDock({ sessionId, pendingInteractions }: {
  sessionId: SessionId
  pendingInteractions: {
    getSnapshot: () => ReadonlyMap<string, unknown>
    subscribe: (fn: () => void) => () => void
  }
}) {
  const pending = useSyncExternalStore(pendingInteractions.subscribe, () => {
    for (const value of pendingInteractions.getSnapshot().values()) {
      if (value instanceof PendingQuestion && String(value.sessionId) === String(sessionId)) return value
    }
    return null
  })
  if (pending === null) return null
  return <QuestionCard pending={pending} />
}

/**
 * Client plugin body: register dictionaries, the composer.dock question card, and
 * the scoped `user-questions/request` waterfall consumer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-questions: dictionaries')
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingQuestion>(
    pending => pending.kind === 'plan-review' ? 2 : 1,
  )
  const pendingInteractions = ctx.uiSession.pendingInteractions as unknown as {
    getSnapshot: () => ReadonlyMap<string, unknown>
    subscribe: (fn: () => void) => () => void
  }
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'question', order: -1, locale: NS },
    (props: { sessionId?: SessionId }) => (
      props.sessionId === undefined ? null : <QuestionDock sessionId={props.sessionId} pendingInteractions={pendingInteractions} />
    ),
  ))
  ctx.remote.$on('user-questions/request', function (request, next) {
    return answerQuestion(ctx, this, request, next, registerPendingInteraction)
  })
}
