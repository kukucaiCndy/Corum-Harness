/** Browser approval consumer over the existing scoped Remote Event waterfall. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@corum/corum-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createApprovalStream } from './ApprovalStream.tsx'
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
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale', 'connection']

const NS = 'approval'

type ApprovalListener = TypertClientEventListener<'approval/request'>
// fork（corum）2026-09-26：三档提权询问（host → client waterfall）。与官方 approval/request
// 的关键差别：这条的返回值**不**经过官方归一化，所以它能带回 `always-allow`（三档第 2 档）。
type EscalationListener = TypertClientEventListener<'corum/escalation/ask'>
type ClientApprovalRequest = Parameters<ApprovalListener>[0]
type ClientApprovalNext = Parameters<ApprovalListener>[1]
type ClientApprovalOutcome = Awaited<ReturnType<ApprovalListener>>

/* jscpd:ignore-start -- Approval and Question intentionally mirror one Remote waterfall lifecycle. */
/** Present one request until the user answers or its lifetime ends. */
async function answerApproval(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientApprovalRequest,
  next: ClientApprovalNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingApproval>,
  grants: Map<SessionId, Set<string>>,
): Promise<ClientApprovalOutcome> {
  const sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) return 'unavailable'
  if (request.signal?.aborted) return 'cancelled'
  const grantKey = JSON.stringify([request.toolName, request.reason ?? null])
  if (grants.get(sessionId)?.has(grantKey)) return 'allowed-once'
  const generation = ctx.get('connection').generation.getSnapshot()
  const pending = new PendingApproval(sessionId, {
    toolName: request.toolName,
    ...(request.callId === undefined
      ? {}
      : { callId: request.callId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }, { allowsAlwaysAllow: true })
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    try {
      const decision = await pending.result
      // 会话内记忆只属于本插件；回传官方服务的仍是合法的单次批准。
      if (decision === 'always-allow') {
        if (request.signal?.aborted) return 'cancelled'
        if (generation === undefined || ctx.get('connection').generation.getSnapshot() !== generation
          || ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) return 'allowed-once'
        const remembered = grants.get(sessionId) ?? new Set<string>()
        remembered.add(grantKey)
        grants.set(sessionId, remembered)
        return 'allowed-once'
      }
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
  // 由当前插件 ctx 持有，既不跨会话，也不跨连接或插件生命周期保留授权。
  const grants = new Map<SessionId, Set<string>>()
  ctx.effect(() => ctx.get('connection').generation.subscribe(() => { grants.clear() }), 'ui-approval: connection grants')
  ctx.effect(() => ctx.sessions.list.subscribe(() => {
    const { byId } = ctx.sessions.list.getSnapshot()
    for (const sessionId of grants.keys()) {
      if (byId[sessionId] === undefined) grants.delete(sessionId)
    }
  }), 'ui-approval: session grants')
  ctx.effect(() => () => { grants.clear() }, 'ui-approval: dispose grants')
  ctx.slots.inject('conversation.approval.stream', () => ctx.slots.register({
    name: 'conversation.approval.stream',
    id: 'approval',
    order: 0,
    locale: NS,
    children: {
      'conversation.approval.detail': { kind: 'single', scope: 'session' },
    },
  }, createApprovalStream(ctx.uiSession.pendingInteractions)))
  ctx.remote.$on('approval/request', function (request, next) {
    return answerApproval(ctx, this, request, next, registerPendingInteraction, grants)
  })

  /**
   * fork（corum）2026-09-26：**三档提权询问**（子 Agent 请求更宽沙箱档位）。
   *
   * 与官方审批共用一个面板（`PendingApproval`），但构造时**打开**第 2 档
   * （`allowsAlwaysAllow: true`）⇒ 卡片多出「总是允许」。本监听器的返回值走 **corum 自有
   * waterfall**，不经官方归一化，所以 `always-allow` 能完整传回宿主（宿主据此记一条会话级授权）。
   *
   * corum 通路拿不到会话身份时交回宿主官方审批兜底（见 escalation-answerer.ts）。
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
    }, { allowsAlwaysAllow: true, alwaysAllowScope: 'escalation' })
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
