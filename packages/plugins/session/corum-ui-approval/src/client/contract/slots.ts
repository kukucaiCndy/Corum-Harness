/** Approval composer and optional correlated-detail contracts. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ApprovalKey } from '../locales.ts'

/* jscpd:ignore-start -- Approval and Question intentionally own independent pending-settlement lifecycles. */
function settlePendingComposer(settle: () => void, failureMessage: string): Promise<void> {
  try {
    settle()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error
      ? error
      : new Error(failureMessage, { cause: error }))
  }
}
/* jscpd:ignore-end */

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    /** Pending approval request. */
    approval: PendingApproval
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Approval prompt copy. */
    approval: ApprovalKey
  }

  interface SlotMap {
    /** Optional detail for the Tool call correlated with an approval request. */
    'conversation.approval.detail': {
      kind: 'single'
      scope: 'session'
      owner: ApprovalDetailOwnerProps
    }
  }
}

/** Stable identity handed to an optional approval-detail renderer. */
export interface ApprovalDetailOwnerProps {
  /** Tool call correlated with the request. */
  callId: ToolCallId
}

/** Client-visible fields of an approval request projected through Remote Events. */
export interface ApprovalPresentationRequest {
  /** Tool requesting the decision. */
  readonly toolName: string
  /** Tool call correlated with the request. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the requester. */
  readonly reason?: string
  /** Cancellation projected from the Host waterfall. */
  readonly signal?: AbortSignal
}

/** Decisions this interactive Client presentation can return. */
export type ApprovalDecision = 'allowed-once' | 'rejected'

/**
 * fork（corum）2026-09-26：作曲区**实际**能回传的决定集合 —— 比官方审批词汇多一个
 * `always-allow`（三档第 2 档「总是允许」）。
 *
 * ⚠️ 第三个值**只在** `PendingApproval.allowsAlwaysAllow === true` 时合法，也就是**只**用于
 * corum 自有的 `corum/escalation/ask` waterfall。官方 `approval/request` 的 outcome 词汇表是
 * **封闭**的（`user-approval/src/index.ts:288` 会把非词汇返回值归一成 `unavailable`），所以官方
 * 那条路**永远不设**该标志、按钮保持禁用 —— 它回传第五个词只会静默变成「拒绝」。
 */
export type ComposerDecision = ApprovalDecision | 'always-allow'

let nextApprovalKey = 0

/** One answerable Client presentation of a pending Host waterfall. */
export class PendingApproval {
  /** Domain discriminator used by Session pending-interaction consumers. */
  readonly kind = 'approval' as const
  /** Opaque render identity and one-shot remount axis. */
  readonly key: string
  /** Tool requesting the decision. */
  readonly toolName: string
  /** Correlated Tool call, when supplied by the asker. */
  readonly callId: ToolCallId | undefined
  /** Human-readable reason supplied by the asker. */
  readonly reason: string | undefined
  /**
   * Result returned by the Remote Event listener to the Host waterfall.
   *
   * `always-allow` 只在 {@link allowsAlwaysAllow} 为真时才会出现（见 {@link ComposerDecision}）。
   */
  readonly result: Promise<ComposerDecision>
  /**
   * fork（corum）2026-09-26：本卡片是否提供第 2 档「总是允许」。
   *
   * 恒 `false` = 官方 `approval/request`（词汇表封闭，第三档传不回去）；
   * `true` = corum 自有 `corum/escalation/ask`。
   */
  readonly allowsAlwaysAllow: boolean

  readonly #resolve: (outcome: ComposerDecision) => void
  readonly #reject: (reason: unknown) => void
  readonly #signal: AbortSignal | undefined
  readonly #onAbort: (() => void) | undefined
  readonly #delegated = Symbol('pending approval delegated')
  #settled = false

  /**
   * @param sessionId - Agent/Session identity owning the scoped request.
   * @param request - Host approval request projected through the Remote Event.
   * @param options - fork（corum）：`allowsAlwaysAllow` 打开第 2 档「总是允许」。
   */
  constructor(
    readonly sessionId: SessionId,
    request: ApprovalPresentationRequest,
    options: { readonly allowsAlwaysAllow?: boolean } = {},
  ) {
    nextApprovalKey += 1
    this.key = `approval:${String(nextApprovalKey)}`
    this.toolName = request.toolName
    this.callId = request.callId
    this.reason = request.reason
    this.allowsAlwaysAllow = options.allowsAlwaysAllow === true
    const completion = Promise.withResolvers<ComposerDecision>()
    this.result = completion.promise
    this.#resolve = completion.resolve
    this.#reject = completion.reject
    this.#signal = request.signal
    if (request.signal === undefined) {
      this.#onAbort = undefined
      return
    }
    const onAbort = (): void => {
      this.abort(request.signal?.reason ?? new Error('approval request was aborted'))
    }
    this.#onAbort = onAbort
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
  }

  /**
   * Resolve the Host waterfall with the user's decision.
   * @param outcome - supported interactive decision.
   */
  answer(outcome: ApprovalDecision): Promise<void> {
    return settlePendingComposer(() => {
      this.finish(() => { this.#resolve(outcome) })
    }, 'pending approval settlement failed')
  }

  /**
   * fork（corum）2026-09-26：第 2 档「总是允许」——**本次照放行**，并请宿主记一条会话级授权
   * （后续同类提权免问）。
   *
   * @returns Whether the presentation accepted the decision (it throws when it was already
   * settled, or when this card does not offer the always-allow tier).
   */
  answerAlwaysAllow(): Promise<void> {
    if (!this.allowsAlwaysAllow) {
      // 官方卡片没有这一档：宁可抛错也不静默降级成 allowed-once（那会让用户以为「永久生效」了）。
      throw new Error('always-allow is not offered by this approval card')
    }
    return settlePendingComposer(() => {
      this.finish(() => { this.#resolve('always-allow') })
    }, 'pending approval settlement failed')
  }

  /** Delegate an unanswered request to the next waterfall listener. */
  delegate(): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(this.#delegated) })
  }

  /**
   * Test whether a rejection requests waterfall delegation.
   * @param reason - rejection received from {@link PendingApproval.result}.
   * @returns whether {@link PendingApproval.delegate} produced it.
   */
  isDelegation(reason: unknown): boolean {
    return reason === this.#delegated
  }

  /**
   * End an unanswered presentation when its transport, scope, or plugin lifetime ends.
   * @param reason - rejection exposed to the waiting Remote Event listener.
   */
  abort(reason: unknown): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(reason) })
  }

  private finish(settle: () => void): void {
    if (this.#settled) throw new Error(`pending approval ${this.key} is already settled`)
    this.#settled = true
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener('abort', this.#onAbort)
    }
    settle()
  }
}

/**
 * 结构判别：这份 composer 参数里的 pending 交互是不是**真正的审批卡**。
 *
 * ## 为什么不用 `instanceof PendingApproval`
 *
 * 类身份只在「同一份模块实例」内成立：
 *   · 打包器把这个插件的内联副本放进多个 chunk / 宿主再挂一份同包（跨 bundle）时，
 *     同一个对象的类来自**另一份** `PendingApproval` ⇒ `instanceof` 为 `false`，
 *     于是审批卡**静默不渲染**（composer 一直空着，用户看到的是「点击没反应」）；
 *   · 若 pending 交互是经结构化投影/回落对象传进来的（非本模块 `new` 出来的），
 *     `instanceof` 同样为 `false`。
 *
 * ## 判别字段是真实协议字段（不是新造的）
 *
 * `kind` 不是本类的私有约定：框架的 `SessionPendingInteractionBase`（见
 * `@deepseek-ai/dsh-client-ui-session/client` 的 `SessionPendingInteractionBase`）就声明了
 * `readonly kind: string`（"Domain-owned presentation discriminator"），本类第 82 行
 * `readonly kind = 'approval' as const` 正是它的实现；同仓的 `PendingQuestion` 用
 * `'question' | 'plan-review'`、`PendingCommitCard` 同款，互不冲突。
 *
 * ## 为什么还要求 key / answer / answerAlwaysAllow
 *
 * 面板会真的调用 `pending.answer()` / `pending.answerAlwaysAllow()`（`ApprovalPanel.tsx:36`）。
 * 只认 `kind` 会把「形状像审批、却没有结算方法」的对象选进 composer，一旦用户点按钮就
 * 抛 TypeError；故这三个成员一起当结构判据。**非 approval（question / plan-review /
 * commit-card…）与 null/undefined 一律排除**，不给别的域抢 composer。
 *
 * @param value - `conversation.composer` 链参数里的 `pendingInteraction`（未知形状）。
 * @returns 是否为本插件可呈现的审批卡。
 */
export function isPendingApproval(value: unknown): value is PendingApproval {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PendingApproval>
  return candidate.kind === 'approval'
    && typeof candidate.key === 'string'
    && typeof candidate.answer === 'function'
    && typeof candidate.answerAlwaysAllow === 'function'
}

/** Full props of the approval composer takeover. */
export type ApprovalComposerProps =
  PropsRuntime<'conversation.composer'>
  & PropsRenderSlots<'conversation.approval.detail'>
  & { matched: PendingApproval }
  & PropsLocale<'approval'>
