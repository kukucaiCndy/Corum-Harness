/**
 * corum-ui-distill-card 契约：dock 卡片能力面 + RPC 类型。
 *
 * 二期改造（2026-11-19）：卡片从「会话流内 durable 事件锚点」改为「host 状态投影 +
 * 会话 dock 区」。不再依赖 durable 会话事件 `plugin:corum-agent/distill-completed`
 * （官方架构拒绝外部事件名注册，ignorable 事件不进 surface 流，实机已证卡片不渲染）。
 *
 * 卡片挂载时 RPC `corumAgent/distillListPending`（wire {}）按当前会话 sessionId
 * 过滤 pending 候选 → 有候选时渲染「经验沉淀完成 · N 条候选待取舍 [查看归档]」。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * `ctx.layout` 的记忆归档能力面（corum IDE 壳 LayoutController 提供，超出官方
 * 基座窄 ILayout 的部分）。与 commit-card 的 SplitPaneCapableLayout 同型（红线 3：
 * 不 import 壳实现包、本地能力接口收窄）。openDistillArchive 由壳新增，运行时
 * 可能尚未具备 ⇒ 能力探测。不具备时回落 openSettingsSection('memory-agent')。
 */
export interface DistillArchiveCapableLayout {
  /** 打开记忆归档面板（点亮 corum.distill 区域 + 置 payload）。 */
  openDistillArchive(payload: { jobId?: string; sessionId?: string }): void
  /** 回落：打开设置中心某 section（旧基座 / 壳不具备归档能力时）。 */
  openSettingsSection(id: string): void
}

/**
 * distillListPending 返回的单条 job 的最小收窄（dock 卡片只需 jobId / sessionId /
 * factCount / candidates 的 pending 数）。
 *
 * 与 host 侧 DistillJob 逐字段一致但只取卡片渲染需要的字段（不 import host 包）。
 */
export interface DistillPendingJob {
  /** 归档任务 id（「查看归档」按钮据此打开归档面板）。 */
  readonly jobId: string
  /** 会话 id（卡片归属会话）。 */
  readonly sessionId: string
  /** 候选经验条数。 */
  readonly factCount: number
  /** 候选事实列表（含 pending/committed/discarded 全状态）。 */
  readonly candidates?: readonly {
    readonly id: string
    readonly state: 'pending' | 'committed' | 'discarded'
  }[]
}

/** 仅供 SessionId 类型 re-export 使用（避免未使用 import 警告）。 */
export type { SessionId }
