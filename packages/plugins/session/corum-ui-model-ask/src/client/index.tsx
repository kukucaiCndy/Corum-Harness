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
 * ## 取消与超时（★ 2026-11-18 实机事故后与事实对齐）
 *
 * signal 不可跨 Remote 序列化，故载荷里没有它；host 侧在 `corumAskAboutModel` 里把
 * 「调用方信号 + `CORUM_ASK_TIMEOUT_MS`」合并后由 `corumModelAskRaceAbort` **真正 race**
 * 询问的等待（此前该超时只包了异步路径且从未被消费，前台路径面板不出现即永久挂起——
 * 事故会话 `corum-task-f5d3b522`）。client 这一侧的对应防线是**发布后自检**
 * （`pendingVisibleInStatus`，与 approval #171 同款）：pending 登记后必须真的落进渲染层
 * 读的 `sessionStatus` 快照，否则立刻交回下游收口，绝不登记一个看不见的 pending 然后
 * 空等。用户挂起（× / 稍后）走 `dismiss()` 回传 `dismissed`，机制按「不改变现状」处理。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
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

export { PendingModelAsk, modelAskAnswerOf, modelAskNeedsRoute, modelAskRequiresRoute } from './contract.ts'
export type { ModelAskAnswer, ModelAskOption, ModelAskRequest } from './contract.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

type ModelAskListener = TypertClientEventListener<'corum/model-ask/request'>
type ClientModelAskRequest = Parameters<ModelAskListener>[0]
type ClientModelAskNext = Parameters<ModelAskListener>[1]

/**
 * fork（corum）2026-11-18（实机事故 `corum-task-f5d3b522`，与 approval #181 同款）：
 * 载荷上的会话身份回落读取器。
 *
 * 会话身份本由 waterfall 的载体 `this` 给出（`scopeOf(owner)`），但 task agent 在 host
 * 侧完整创建、renderer 从不 materializeScope ⇒ `scopeOf` 恒 undefined。转发 loop 现在
 * 从载体 Agent 的 id 补 `sessionId`（corum-api-remotes），这里按它回落，面板仍能挂到
 * 正确会话。读法守住两点：不假设字段存在（`in` 收窄），值过运行时类型校验再用。
 * @param request - projected Host model-ask request。
 * @returns 载荷携带的可用会话 id；没有则 undefined。
 */
function sessionIdHintOf(request: ClientModelAskRequest): SessionId | undefined {
  if (!('sessionId' in request)) return undefined
  const hinted: unknown = (request as { readonly sessionId?: unknown }).sessionId
  if (typeof hinted !== 'string' || hinted === '') return undefined
  return hinted as SessionId
}

/**
 * fork（corum）2026-11-18：**发布后自检**（与 approval #171 的 `pendingVisibleInStatus`
 * 同款）——pending 必须真的落进渲染层读的那份 `uiSession.sessionStatus` 快照，否则立刻
 * 收口，不许静默挂住。
 *
 * 为什么需要：rc3 的 `sessionStatus` 每会话只暴露**最高优先级**的一个 pendingInteraction。
 * 本会话若已有别的 pending（或会话根本不在渲染），刚登记的 model-ask 就落在「看不见的
 * 分片」上——而应答者一旦 `await pending.result` 就永久等待，host 前台委派随之永久挂起
 * （事故形态：子 Agent 429 失败后面板从未出现，父会话 45+ 分钟零事件）。自检只做一件事：
 * 登记完回读快照确认可见；不可见 ⇒ 调用方交回下游（host 按 dismissed 诚实收口）。
 * 读不到快照时**放行**（绝不因为诊断代码把正常询问弄坏）。
 *
 * @param ctx - 客户端根 context。
 * @param sessionId - 请求所属会话 id。
 * @param pending - 刚登记的待决交互实例。
 * @returns 是否能在渲染层快照里看到它。
 */
export async function pendingVisibleInStatus(
  ctx: ClientContext,
  sessionId: string,
  pending: PendingModelAsk,
): Promise<boolean> {
  const face = (ctx as unknown as {
    uiSession?: { sessionStatus?: { getSnapshot?: () => Map<string, { pendingInteraction?: unknown }> } }
  }).uiSession?.sessionStatus
  const getSnapshot = face?.getSnapshot
  if (typeof getSnapshot !== 'function') return true
  try {
    // 发布链是同步的（publish → notify → publishStatus），但跨一个微任务再读更稳。
    await Promise.resolve()
    const snapshot = getSnapshot.call(face) as Map<string, { pendingInteraction?: unknown }> | undefined
    return snapshot?.get(sessionId)?.pendingInteraction === pending
  } catch {
    return true
  }
}

/**
 * 呈现一个询问直到用户作答、挂起，或通路生命周期结束。
 *
 * ★ 2026-11-18（事故 `corum-task-f5d3b522`）两道防线，与 approval 对齐：
 * ① `scopeOf` 解析不到 ⇒ 按载荷 `sessionId` 回落（#181 形态），仍拿不到才交回下游；
 * ② 登记后先做可见性自检（#171 形态），不可见立刻收口，绝不空等一个看不见的 pending。
 * 两条路都留 `console.warn`：下次现场只看控制台就知道卡在哪一环。
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
  let sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) {
    const hint = sessionIdHintOf(request)
    // 日志一律写「实际取到了什么」——面板不出现时先看这里（与 approval 同款诊断面）。
    const evidence = {
      label: request.label,
      role: request.role,
      scopeOf: undefined,
      payloadSessionId: hint,
      payloadKeys: Object.keys(request),
    }
    if (hint === undefined) {
      console.warn(
        '[ui-model-ask] 取不到会话载体，模型不可用询问无法呈现给用户；交回下游按 dismissed 收口（这不是用户取消）',
        evidence,
      )
      return next()
    }
    console.warn('[ui-model-ask] scopeOf(owner) 解析不到会话载体，回落到载荷里的会话 id', evidence)
    sessionId = hint
  }
  const pending = new PendingModelAsk(sessionId, request)
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  // ★ 发布后自检（#171 同款）：不可见 ⇒ 释放登记并吞掉 pending.result，交回下游。
  if (!await pendingVisibleInStatus(ctx, sessionId, pending)) {
    console.warn(
      '[ui-model-ask] pending 未出现在 sessionStatus 快照（会话不在渲染 / 被更高优先级 pending 遮蔽）；交回下游收口，不空等',
      { sessionId: String(sessionId), key: pending.key },
    )
    void pending.result.catch(() => {})
    remove()
    return await next()
  }
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
