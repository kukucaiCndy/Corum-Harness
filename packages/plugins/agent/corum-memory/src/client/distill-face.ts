/**
 * 记忆归档面板的**能力接口**与**wire 类型**（红线 3 + 红线 4）。
 *
 * ## 为什么不 import host 实现包类型（红线 3）
 *
 * dsh 会把 `@corum/*` 源码内联进每个消费方 bundle，跨包 import 会把整个
 * host 实现包拉进本包的 bundle 图。故这里**本地声明** wire 类型（与 host 侧
 * `corumAgent/distill*` RPC 的字段名逐字一致），改动时两处需同步——但类型
 * 面收窄、运行期按 RPC 服务名取值，不耦合实现。
 *
 * ## 能力接口（红线 3 + 红线 4）
 *
 * `DistillArchiveCapableLayout` 收窄 `ctx.layout`（cordis 服务名 'layout'）新增的
 * 记忆归档 API 面。照 `corum-ui-split-pane` 的 `SplitPaneCapableLayout` 先例
 * （本包已有的 trajectory occupant 先例亦同构）：本地定义能力接口 + 延迟取服务
 * （`ctx.get('layout')`），不用 `ctx.get` 取未装配服务（红线 4：apply 执行时
 * ide-shell 已激活，layout 一定已 provide）。
 *
 * @module @corum/corum-memory/client/distill-face
 */
import type { Context } from '@deepseek-ai/cordis'

/* ── wire 类型：distill* RPC 的入参 / 出参（本地声明，不 import host 包）── */

/** 候选记忆的留存档位。 */
export type Retention = 'temporary' | 'short' | 'long' | 'permanent'

/** 候选记忆的处理态。 */
export type CandidateState = 'pending' | 'committed' | 'discarded'

/** 经验沉淀任务的状态。 */
export type DistillStatus = 'running' | 'done' | 'error' | 'cancelled'

/** 一个候选记忆（distillStatus.candidates[] 的项）。 */
export interface DistillCandidate {
  id: string
  fact: string
  importance: number
  retention: Retention
  state: CandidateState
}

/** 经验沉淀任务（distillStatus / distillListPending 返回的 job）。 */
export interface DistillJob {
  jobId: string
  status: DistillStatus
  factCount: number
  phase: string
  error?: string
  sessionId: string
  candidates?: DistillCandidate[]
  origin?: string
}

/** distillCommit 的入参项（只传勾选且编辑后的值）。 */
export interface DistillCommitItem {
  id: string
  fact: string
  importance: number
  retention: Retention
}

/** distillCommit 的出参。 */
export interface DistillCommitResult {
  written: number
  failed: number
}

/** distillDiscard 的出参。 */
export interface DistillDiscardResult {
  discarded: number
}

/** distillListPending 的出参。 */
export interface DistillListPendingResult {
  jobs: DistillJob[]
}

/* ── 能力接口：DistillArchiveCapableLayout（红线 3 收窄 ctx.layout）── */

/** 记忆归档面板的打开载荷（壳 LayoutController 新增的 DistillArchivePayload）。 */
export interface DistillArchivePayload {
  jobId?: string
  sessionId?: string
}

/**
 * ctx.layout 的记忆归档能力面（corum IDE 壳 LayoutController 提供，超出官方
 * 基座窄 ILayout 的部分）。cordis 服务跨 bundle 单例，本插件经它读/写
 * 归档打开态，壳的 layout 控制器经同一服务发 openDistillArchive 事件。
 *
 * ⚠️ 照 `corum-ui-split-pane` 的 `SplitPaneCapableLayout` 先例（红线 3 + 4）：
 * 不 import 实现包类型，本地定义收窄面；用 `ctx.get('layout')` 延迟取——
 * apply 里订阅 onOpenDistillArchive 是同步注册（服务名 'layout' 已在 inject 声明），
 * 回调执行时 layout 一定已 provide。
 */
export interface DistillArchiveCapableLayout {
  openDistillArchive(payload: DistillArchivePayload): void
  onOpenDistillArchive(listener: (payload: DistillArchivePayload) => void): () => void
  consumePendingDistillArchive(): DistillArchivePayload | null
  getDistillArchivePayload(): DistillArchivePayload | null
  closeDistillArchive(): void
}

/**
 * 取 ctx.layout 的记忆归档能力面。
 *
 * layout 在 inject 里声明（硬依赖），apply 同步路径直接取；若回调里延迟取，
 * 用此函数 fail-soft（照 SplitPaneCapableLayout 的 fail-soft 纪律）。
 * @param ctx - client context。
 * @returns 归档能力面；layout 未装配时返回 no-op stub。
 */
export function distillArchiveLayout(ctx: Context): DistillArchiveCapableLayout {
  const layout = ctx.get('layout')
  if (layout === undefined) {
    // 不应到达（inject 已声明 'layout'）。但 fail-soft 而非 crash。
    return {
      openDistillArchive() { /* layout not yet available */ },
      onOpenDistillArchive() { return () => {} },
      consumePendingDistillArchive() { return null },
      getDistillArchivePayload() { return null },
      closeDistillArchive() { /* layout not yet available */ },
    }
  }
  return layout as unknown as DistillArchiveCapableLayout
}
