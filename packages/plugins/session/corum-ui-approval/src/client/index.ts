/** Browser approval consumer over the existing scoped Remote Event waterfall. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@corum/corum-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ApprovalPanel } from './ApprovalPanel.tsx'
// fork（corum）2026-09-26：拉入 corum 领域事件的 client 类型面（含 `corum/escalation/ask`），
// 与 corum-ui-model-ask 同款（`import type {}` 只取声明副作用）。
import type {} from '@corum/corum-api-remotes/client'
import { PendingApproval, isPendingApproval } from './contract/slots.ts'
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

/* jscpd:ignore-start -- Approval and Question intentionally mirror one Remote waterfall lifecycle. */

/**
 * fork（corum）2026-11-11：**发布后自检** —— pending 必须真的落进渲染层读的那份
 * `uiSession.sessionStatus` 快照，否则立刻收口，不许静默挂住。
 *
 * ## 为什么需要（实测事故，会话 `corum-task-452a5fe8`）
 *
 * host 侧 `approval/asked` 在 00:05:39 落盘，`approval/decided` 却到 00:22 才出现
 * （**间隔 988 秒**），outcome 是 `cancelled` —— 那个 `cancelled` 不是"用户拒绝"，
 * 而是用户等了十几分钟看不到任何卡片、按了停止把 turn 中止后**信号 aborted** 的结果。
 * 沙箱据此抛 `approval for escalating to "danger-full-access" was cancelled`，
 * 用户看到的是「卡住了 / 秒取消」，机制里却没有任何一条错误。
 *
 * 官方通路**没有超时**：`ApprovalService.decide()` 的 waterfall 会一直等应答者，
 * 而本插件的应答者一旦登记了 pending 就 `await pending.result`。所以「pending 发布了、
 * 但落在**没在渲染的那个会话/分片**上」这一类失败的表现就是**整轮永久挂起**，
 * 唯一的出路是用户手动中止 —— 这既毁体验，也让真因完全不可见。
 *
 * 自检只做一件事：登记完立刻回读快照确认可见，不可见就把请求交回下游
 * （`next()` ⇒ 宿主按 `unavailable` 收口并给出可读原因）。读不到快照时**放行**
 * （绝不因为诊断代码把正常审批弄坏）。
 *
 * @param ctx - 客户端根 context。
 * @param sessionId - 请求所属会话 id。
 * @param pending - 刚登记的待决交互实例。
 * @returns 是否能在渲染层快照里看到它。
 */
export async function pendingVisibleInStatus(
  ctx: ClientContext,
  sessionId: string,
  pending: PendingApproval,
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

/** Present one request until the user answers or its lifetime ends. */
async function answerApproval(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientApprovalRequest,
  next: ClientApprovalNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingApproval>,
): Promise<ClientApprovalOutcome> {
  const sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) return next()
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
  // 2026-11-11 事故的防线：可见性自检放在**等结果之前**（见 `pendingVisibleInStatus`）。
  if (!await pendingVisibleInStatus(ctx, sessionId, pending)) {
    // 释放登记并**吞掉** pending.result：本路径不再有人应答，别制造未处理的 rejection。
    void pending.result.catch(() => {})
    remove()
    return await next()
  }
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
      // 结构判别而非 `instanceof`（跨 bundle / 非本模块 new 出来的同形状对象也要能选中；
      // 判别字段与理由见 `contract/slots.ts` 的 `isPendingApproval`）。
      isPendingApproval(pendingInteraction) ? pendingInteraction : null,
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
   * 拿不到会话身份时不 `next()` 会静默丢掉请求，故与官方监听器同款：解析不到就交回下游
   * （下游 = 宿主的兜底 = 官方审批卡，见 `escalation-answerer.ts` 的两级通路）。
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
    // 2026-11-11：与官方通路同一道防线 —— 发布后自检，看不见就交回下游
    // （`next` 的兜底是官方审批卡），不让父轮静默挂住。
    if (!await pendingVisibleInStatus(ctx, String(sessionId), pending)) {
      void pending.result.catch(() => {})
      remove()
      return await next()
    }
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
