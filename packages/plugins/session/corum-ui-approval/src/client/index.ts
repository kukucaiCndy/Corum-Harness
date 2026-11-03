/** Browser approval consumer over the existing scoped Remote Event waterfall. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@corum/corum-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ApprovalPanel } from './ApprovalPanel.tsx'
// fork（corum）2026-09-26：拉入 corum 领域事件的 client 类型面（含 `corum/escalation/ask`），
// 与 corum-ui-model-ask 同款（`import type {}` 只取声明副作用）。
import type {} from '@corum/corum-api-remotes/client'
import { PendingApproval } from './contract/slots.ts'
import { en, zh } from './locales.ts'

export type {
  ApprovalComposerProps,
  ApprovalDecision,
  ApprovalDetailOwnerProps,
  ApprovalPresentationRequest,
  PendingApproval,
} from './contract/slots.ts'
export type { ApprovalKey } from './locales.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

const NS = 'approval'

type ApprovalListener = TypertClientEventListener<'approval/request'>
// fork（corum）2026-09-26：三档提权询问（host → client waterfall）。与官方 approval/request
// 的关键差别：这条的返回值**不**经过官方归一化，所以它能带回 `always-allow`（三档第 2 档）。
type EscalationListener = TypertClientEventListener<'corum/escalation/ask'>
type ClientApprovalRequest = Parameters<ApprovalListener>[0]
type ClientApprovalNext = Parameters<ApprovalListener>[1]
type ClientApprovalOutcome = Awaited<ReturnType<ApprovalListener>>

/**
 * fork（corum）2026-11-03（issue #181）：`approval/request` 载荷上落回会话身份的读取器。
 *
 * 官方 `ApprovalRequestEvent` **不声明** `sessionId` —— 会话身份由 waterfall 的 `this`
 * 载体给出。但载荷是宿主投影过来的普通对象，而 corum 自有事件
 * （`corum/escalation/ask`）本来就随载荷下发 `sessionId`，所以这条回落路子在机制里是
 * 成立的。读法守住两点：**不假设字段存在**（`in` 收窄，缺了就返回 undefined），
 * **不写 `as unknown as` 双重断言**（值先过运行时类型校验，品牌是编译期概念，运行期
 * 就是字符串本身）。
 * @param request - projected Host approval request.
 * @returns the payload-supplied session id when it carries a usable one, else `undefined`.
 */
function sessionIdHintOf(request: ClientApprovalRequest): SessionId | undefined {
  if (!('sessionId' in request)) return undefined
  const hinted: unknown = request.sessionId
  if (typeof hinted !== 'string' || hinted === '') return undefined
  return hinted as SessionId
}

/* jscpd:ignore-start -- Approval and Question intentionally mirror one Remote waterfall lifecycle. */
/** Present one request until the user answers or its lifetime ends. */
async function answerApproval(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientApprovalRequest,
  next: ClientApprovalNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingApproval>,
): Promise<ClientApprovalOutcome> {
  // fork（corum）2026-11-03（issue #181）：这里原本是 `const sessionId = scopeOf(owner)`，
  // 取不到就 `return next()` —— 而水瀑下游没有第二个 answerer 认领，请求于是**悬空**；
  // 官方 `ApprovalService.decide()` 在 signal 中止后把它归一成 `cancelled`，工具侧报
  // 「用户取消了审批」，可用户从来没收到过任何弹窗（`cancelled` 的真实语义是「没人回答」，
  // 与「用户拒绝」完全无法区分）。现在分两步，并且**绝不静默放行**：
  //   ① 先按载荷里的会话 id 回落（`request.sessionId`，可能根本不存在）；
  //   ② 仍拿不到就返回 `unavailable`（官方封闭词汇表内的「没有可用审批通道」），
  //      让 Agent 拿到一个可自述的结论，而不是假装被取消。
  // 两条路都留一条 warn：下次现场只需要看控制台就知道 `scopeOf` 与实际取到了什么。
  let sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) {
    const hint = sessionIdHintOf(request)
    // 日志一律写「实际取到了什么」：`scopeOf` 的结果、载荷里有没有会话 id、载荷带了哪些键。
    // 这是下次诊断的唯一入口——面板不出现时先看这里。刻意不遍历 `owner`：那是 cordis 的
    // 上下文 Proxy，枚举本身就可能抛，诊断不该比故障更脆。
    const evidence = {
      toolName: request.toolName,
      callId: request.callId,
      scopeOf: undefined,
      payloadSessionId: hint,
      payloadKeys: Object.keys(request),
    }
    if (hint === undefined) {
      console.warn(
        '[ui-approval] 取不到会话载体，审批请求无法呈现给用户；按 unavailable 交回宿主（这不是用户取消）',
        evidence,
      )
      return 'unavailable'
    }
    console.warn('[ui-approval] scopeOf(owner) 解析不到会话载体，回落到载荷里的会话 id', evidence)
    sessionId = hint
  }
  const pending = new PendingApproval(sessionId, {
    toolName: request.toolName,
    ...(request.callId === undefined
      ? {}
      : { callId: request.callId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    try {
      const decision = await pending.result
      // fork（corum）2026-09-26：官方卡**不**提供第 2 档（构造时不设 `allowsAlwaysAllow`），
      // 故 `always-allow` 在这里不可能出现；真出现就交回下游（绝不把第五个词喂给官方通路 ——
      // 官方会把它归一成 `unavailable`，看着像批准、实际是拒绝）。
      if (decision === 'always-allow') return await next()
      return decision
    } catch (error) {
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    remove()
    completed.resolve()
  }
}
/* jscpd:ignore-end */

/**
 * Install approval copy and the scoped waterfall consumer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-approval: dictionaries')
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingApproval>(
    () => 0,
  )
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 1,
    select: ({ pendingInteraction }: ComposerChainProps): PendingApproval | null =>
      pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
    locale: NS,
    children: {
      'conversation.approval.detail': { kind: 'single', scope: 'session' },
    },
  }, ApprovalPanel))
  ctx.remote.$on('approval/request', function (request, next) {
    return answerApproval(ctx, this, request, next, registerPendingInteraction)
  })

  /**
   * fork（corum）2026-09-26：**三档提权询问**（子 Agent 请求更宽沙箱档位）。
   *
   * 与官方审批共用一个面板（`PendingApproval`），但构造时**打开**第 2 档
   * （`allowsAlwaysAllow: true`）⇒ 卡片多出「总是允许」。本监听器的返回值走 **corum 自有
   * waterfall**，不经官方归一化，所以 `always-allow` 能完整传回宿主（宿主据此记一条会话级授权）。
   *
   * 拿不到会话身份时不 `next()` 会静默丢掉请求，故这里解析不到就交回下游（下游 = 宿主
   * 的兜底 = 官方审批卡，见 `escalation-answerer.ts` 的两级通路）。注意与上方官方
   * `approval/request` 监听器的**差别**（2026-11-03，issue #181）：官方那条的下游**没有**
   * 第二个 answerer 认领，所以那里改为回落 + `unavailable`，不再 `next()`；本条的
   * `next()` 是真实存在的宿主兜底，仍然正确。
   */
  ctx.remote.$on('corum/escalation/ask', async function (request, next) {
    // 会话身份：先用与官方 `approval/request` 同款的 scope 解析；解析不出时退回**载荷里的
    // 会话 id**（`sessionId`）。这条兜底是 2026-09-26 加的：当时 `scopeOf` 在客户端是否可靠
    // 尚未证实，而载荷这条路不依赖它 —— 宁可多一条确定的路，也不要让请求静默走 `next()`。
    const sessionId = ctx.sessions.scopeOf(this) ?? (request.sessionId as unknown as ReturnType<typeof ctx.sessions.scopeOf>)
    if (sessionId === undefined) return await next()
    const pending = new PendingApproval(sessionId, {
      toolName: 'bash',
      reason: request.justification === undefined || request.justification === ''
        ? `子 Agent 请求提权到 ${request.mode}`
        : `子 Agent 请求提权到 ${request.mode}：${request.justification}`,
    }, { allowsAlwaysAllow: true })
    const completed = Promise.withResolvers<void>()
    const remove = registerPendingInteraction(pending, async () => {
      pending.delegate()
      await completed.promise
    })
    try {
      try {
        return { kind: await pending.result }
      } catch (error) {
        if (pending.isDelegation(error)) return await next()
        throw error
      }
    } finally {
      remove()
      completed.resolve()
    }
  })
}
