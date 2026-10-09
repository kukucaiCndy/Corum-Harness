/**
 * corum-ui-commit-card 契约：`corum/commit-card/request` + `corum/commit-card/update` 的载荷。
 *
 * 与 host 侧（corum-git-core 的 index.ts）**各自声明一次**——fork 包之间看不到彼此的
 * Events 合并，且 client 半不能 import host-only 包。结构必须逐字段一致。
 *
 * 卡片**无按钮**——回传立即解析为 `{ kind: 'shown' }`，阻塞由机制保证（serial dispatch
 * + steer LLM 自己处理），不依赖用户操作。状态更新走独立的 emit 通道。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 提交卡片状态（三态 + 暂存）。 */
export type CommitCardStatus = 'pending' | 'progress' | 'done' | 'stashed'

/** host → client 的提交卡片初始载荷（与 CorumCommitCardRequestEvent 同构）。 */
export interface CommitCardRequest {
  /** 会话 id（卡片归属会话）。 */
  readonly sessionId: string
  /** turn 编号。 */
  readonly turn: number
  /** 初始状态。 */
  readonly status: CommitCardStatus
  /** 非产物改动文件数。 */
  readonly effectiveFiles: number
  /** 总改动文件数（含产物）。 */
  readonly totalFiles: number
  /** diff --stat 摘要行（非产物，最多 3 行）。 */
  readonly diffLines: readonly string[]
  /** 还有多少产物文件被排除。 */
  readonly excludedArtifacts: number
}

/** host → client 的状态更新（emit 通道；与 CorumCommitCardUpdateEvent 同构）。 */
export interface CommitCardUpdate {
  /** 会话 id。 */
  readonly sessionId: string
  /** turn 编号。 */
  readonly turn: number
  /** 新状态。 */
  readonly status: CommitCardStatus
  /** 已完成的提交列表（仅 done 态有值）。 */
  readonly commits?: readonly { readonly type: string; readonly scope?: string; readonly message: string }[]
  /** 进度描述（进行中态用）。 */
  readonly progressText?: string
}

/** client → host 的回传（立即解析——卡片无按钮）。 */
export interface CommitCardAnswer {
  readonly kind: 'shown'
}

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    /** 待展示的 turn-stopping 提交卡片。 */
    commitCard: PendingCommitCard
  }
}

let nextCommitCardKey = 0

/**
 * 一个可渲染的提交卡片待展示项。
 *
 * 与 PendingModelAsk 同模式（pendingInteractions 注册 + dock 渲染），但**无按钮**——
 * 卡片纯状态展示，状态更新经 `corum/commit-card/update` emit 通道推送，卡片据此
 * 重渲染三态。
 */
export class PendingCommitCard {
  /** pendingInteractions 的判据。 */
  readonly kind = 'commitCard' as const
  /** 渲染身份（remount 轴）。 */
  readonly key: string
  /** 会话归属。 */
  readonly sessionId: SessionId
  /** 初始请求。 */
  readonly request: CommitCardRequest
  /** 回传给 host waterfall 的结果。 */
  readonly result: Promise<CommitCardAnswer>

  /** 当前状态（由 emit 更新驱动）。 */
  #status: CommitCardStatus
  /** 已完成提交列表。 */
  #commits: readonly { readonly type: string; readonly scope?: string; readonly message: string }[] = []
  /** 进度文本。 */
  #progressText = ''
  /** 结果回传给 host waterfall。 */
  readonly #resolve: (answer: CommitCardAnswer) => void
  #settled = false
  /** 订阅回调集。 */
  #listeners = new Set<() => void>()

  constructor(sessionId: SessionId, request: CommitCardRequest) {
    nextCommitCardKey += 1
    this.key = `commit-card:${String(nextCommitCardKey)}`
    this.sessionId = sessionId
    this.request = request
    this.#status = request.status
    const completion = Promise.withResolvers<CommitCardAnswer>()
    this.result = completion.promise
    this.#resolve = completion.resolve
  }

  /** 当前状态。 */
  get status(): CommitCardStatus { return this.#status }
  /** 已完成提交列表。 */
  get commits(): readonly { readonly type: string; readonly scope?: string; readonly message: string }[] { return this.#commits }
  /** 进度文本。 */
  get progressText(): string { return this.#progressText }

  /** 应用状态更新（由 emit 通道驱动）。 */
  applyUpdate(update: CommitCardUpdate): void {
    this.#status = update.status
    if (update.commits !== undefined) this.#commits = update.commits
    if (update.progressText !== undefined) this.#progressText = update.progressText
    this.#notify()
  }

  /** 订阅状态变化。 */
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => { this.#listeners.delete(fn) }
  }

  /** 立即回传 shown（卡片无按钮，waterfall 一发出就解析）。 */
  shown(): void {
    if (this.#settled) return
    this.#settled = true
    this.#resolve({ kind: 'shown' })
  }

  /** 把未应答的询问让给下一个 waterfall 监听者。 */
  delegate(): void {
    // 提交卡片不 delegate（它是唯一的监听者），但保留接口与 PendingModelAsk 同构。
  }

  #notify(): void {
    for (const fn of this.#listeners) fn()
  }
}
