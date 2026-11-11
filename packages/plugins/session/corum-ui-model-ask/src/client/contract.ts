/**
 * corum-ui-model-ask 契约：`corum/model-ask/request` 的载荷与应答。
 *
 * 与 host 侧（corum-tool-subagent 的 model-ask.ts / model-ask-run.ts）**各自声明
 * 一次**——fork 包之间看不到彼此的 Events 合并，且 client 半不能 import host-only 包
 * （那会把 node-only 值拖进浏览器 bundle）。结构必须逐字段一致。
 *
 * 协议走 `kind`（稳定标识）而不是选项 label：label 是给人看的文案，会随 UI 改版与
 * 本地化漂移；档位清单由 host 下发（见 `options`），client 只渲染、不硬编码。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * 机制接受的档位（与 host 的 `CorumModelAskDecision['kind']` 同集）。
 *
 * `retry` = 不换模型、用原路由再派一次（机制不写任何状态）；`temporary` = 本次任务临时
 * 换路由（可指定模型）。两者的差别在承诺，不在副作用面：前者连「换成什么模型」都不问。
 */
export type ModelAskKind = 'retry' | 'temporary' | 'permanent-follow' | 'permanent-route' | 'decline'

/** 一个档位的呈现数据（`kind` 是协议，label/description 是文案）。 */
export interface ModelAskOption {
  readonly kind: ModelAskKind
  readonly label: string
  readonly description: string
}

/** 可用模型清单里的一项（供「永久改指定模型」内嵌选择）。 */
export interface ModelAskCatalogProvider {
  readonly provider: string
  readonly label: string
  readonly models: readonly { readonly model: string; readonly label: string }[]
}

/** host → client 的提问载荷（与 CorumModelAskRequestEvent 同构）。 */
export interface ModelAskRequest {
  /** 哪个子 Agent（label，给人话上下文）。 */
  readonly label: string
  /** 用户为该角色配置的模型路由（不可用的那个）。 */
  readonly configured: { readonly provider: string; readonly model: string }
  /** 机制将采用的回退路由（主 Agent 的真实路由）。 */
  readonly fallback: { readonly provider: string; readonly model: string }
  /** 失败原因原文（已由 host 压成一行）。 */
  readonly cause: string
  /** 该角色（决定永久档写哪个预设键）。 */
  readonly role: 'worker' | 'research'
  /** 档位清单（host 是词汇表唯一事实源）。 */
  readonly options: readonly ModelAskOption[]
  /** 可用模型清单（可能为空——列举失败时 host 传空数组）。 */
  readonly catalog: readonly ModelAskCatalogProvider[]
}

/** client → host 的应答（与 CorumModelAskOutcomeEvent 同构）。 */
export interface ModelAskAnswer {
  readonly kind: ModelAskKind | 'dismissed'
  /**
   * 仅 `temporary` / `permanent-route` 两档携带。
   *
   * `temporary` 带 route 表示「这次就用这个模型」；不带表示「就用主 Agent 模型」。host 会
   * 校验带上的那条（不合法则退回主 Agent 路由并在通知里说明），故 client 只需如实回传
   * 用户在列表里点了什么，不做任何裁剪。
   */
  readonly route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    /** 待用户处理的「子 Agent 模型不可用」决定。 */
    modelAsk: PendingModelAsk
  }
}

let nextModelAskKey = 0

/**
 * 一个可渲染的待决定项。
 *
 * 为什么不复用 PendingQuestion：那是提问卡（LLM 提问通路）的类型，`isDelegation` 的
 * 哨兵、abort 语义都锚在 `UserQuestionError` 的 code 上。本决定走自己的通路，混用会把
 * 两条通路的取消语义搅在一起。
 */
export class PendingModelAsk {
  /** pendingInteractions 的判据（与 SessionPendingInteractionMap 的键同名）。 */
  readonly kind = 'modelAsk' as const
  /** 渲染身份（remount 轴）。 */
  readonly key: string
  /** 一次询问内稳定的会话归属（按 sessionId 过滤）。 */
  readonly sessionId: SessionId
  readonly request: ModelAskRequest
  /** 结果回传给 host waterfall。 */
  readonly result: Promise<ModelAskAnswer>

  readonly #resolve: (answer: ModelAskAnswer) => void
  readonly #reject: (reason: unknown) => void
  readonly #delegated = Symbol('pending model-ask delegated')
  #settled = false

  /**
   * @param sessionId - 归属会话（dock 按它过滤）。
   * @param request - host 下发的提问载荷。
   */
  constructor(sessionId: SessionId, request: ModelAskRequest) {
    nextModelAskKey += 1
    this.key = `model-ask:${String(nextModelAskKey)}`
    this.sessionId = sessionId
    this.request = request
    const completion = Promise.withResolvers<ModelAskAnswer>()
    this.result = completion.promise
    this.#resolve = completion.resolve
    this.#reject = completion.reject
  }

  /**
   * 用户点「应用并继续」——把档位回传给 host。
   * @param answer - 用户选定的档位（`permanent-route` 须带 route；`temporary` 可带可不带）。
   */
  answer(answer: ModelAskAnswer): Promise<void> {
    return this.#settle(() => { this.#resolve(answer) }, 'pending model-ask settlement failed')
  }

  /**
   * 用户点 × / 「稍后」——挂起本次询问（host 按「不改变现状」处理）。
   *
   * 与 {@link delegate} 的区别：挂起是**用户的可见选择**，必须回传 dismissed；
   * delegate 是把机会让给下游监听者。
   */
  dismiss(): Promise<void> {
    return this.answer({ kind: 'dismissed' })
  }

  /** 把未应答的询问让给下一个 waterfall 监听者。 */
  delegate(): void {
    if (this.#settled) return
    void this.#settle(() => { this.#reject(this.#delegated) }, 'pending model-ask delegation failed')
      .catch(() => undefined)
  }

  /**
   * 判断一个 rejection 是否来自 {@link delegate}。
   * @param reason - {@link result} 的 rejection。
   * @returns 是否由 delegate 产生。
   */
  isDelegation(reason: unknown): boolean {
    return reason === this.#delegated
  }

  /** 插件卸载 / 通路断开时结束未应答的询问。 */
  abort(reason: unknown): void {
    if (this.#settled) return
    void this.#settle(() => { this.#reject(reason) }, 'pending model-ask abort failed')
      .catch(() => undefined)
  }

  #settle(settle: () => void, failureMessage: string): Promise<void> {
    if (this.#settled) {
      return Promise.reject(new Error(`pending model-ask ${this.key} is already settled`))
    }
    this.#settled = true
    try {
      settle()
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(failureMessage, { cause: error }))
    }
  }
}

/**
 * 选中该档位时**展开**内嵌模型选择吗（决定 picker 是否渲染）。
 *
 * `temporary` 与 `permanent-route` 都要展开：前者「仅本次任务，可选指定模型」，后者
 * 「记住这条路由」。展开 ≠ 必须选——不选时 temporary 退回主 Agent 模型，故「展开」与
 * 「必须选」是两个不同的判据（见 {@link modelAskRequiresRoute}）。
 * @param kind - 选中档位。
 * @returns 是否渲染模型选择。
 */
export function modelAskNeedsRoute(kind: ModelAskKind | undefined): boolean {
  return kind === 'temporary' || kind === 'permanent-route'
}

/**
 * 选中该档位时**必须**先选一个模型才能应用吗（否则回传 dismissed）。
 *
 * 只有 `permanent-route` 是：它的全部含义就是「记住这条路由」，没有路由就等于没作答。
 * `temporary` 不选 = 用主 Agent 模型（那是本档的原始语义），不构成未作答。
 * @param kind - 选中档位。
 * @returns 是否强制要求 route。
 */
export function modelAskRequiresRoute(kind: ModelAskKind | undefined): boolean {
  return kind === 'permanent-route'
}

/**
 * 组装回传的应答（把 UI 状态收敛成契约）。
 *
 * 为什么单独成函数：`permanent-route` 但没选模型时**必须**降级为 dismissed（绝不默默
 * 替用户挑一个模型），这条判定是安全关键的，抽出来才能被单测钉住。`temporary` 相反——
 * 带了 route 就照传（合法性由 host 校验），没带就是「用主 Agent 模型」。
 * @param kind - 选中档位。
 * @param route - 内嵌选择里选中的路由（未选=undefined）。
 * @returns 回传给 host 的应答。
 */
export function modelAskAnswerOf(
  kind: ModelAskKind | undefined,
  route: { provider: string; model: string; reasoningEffort?: string } | undefined,
): ModelAskAnswer {
  if (kind === undefined) return { kind: 'dismissed' }
  if (kind === 'permanent-route') {
    return route === undefined
      ? { kind: 'dismissed' }
      : { kind: 'permanent-route', route: { ...route } }
  }
  if (kind === 'temporary' && route !== undefined) {
    return { kind: 'temporary', route: { ...route } }
  }
  return { kind }
}
