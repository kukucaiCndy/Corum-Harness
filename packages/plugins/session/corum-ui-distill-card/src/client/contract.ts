/**
 * corum-ui-distill-card 契约：durable 会话事件 `plugin:corum-agent/distill-completed` 的载荷。
 *
 * 与 host 侧（corum-agent 的 memory-distill.ts 的 `DistillCompletedSessionEvent`）
 * **各自声明一次**——fork 包之间看不到彼此的类型合并，且 client 半不能 import
 * host-only 包。结构必须逐字段一致。
 *
 * 载荷字段：jobId / sessionId / factCount（host 已补 appendPluginRecord，仅
 * factCount>0 时 append）。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * `plugin:corum-agent/distill-completed` durable 会话事件的载荷（本地声明，不 import host 包）。
 *
 * 与 host 侧 `DistillCompletedSessionEvent`（memory-distill.ts）逐字段一致。
 */
export interface DistillCompletedData {
  /** 归档任务 id（「查看归档」按钮据此打开归档面板）。 */
  readonly jobId: string
  /** 会话 id（卡片归属会话）。 */
  readonly sessionId: string
  /** 候选经验条数（待用户取舍）。 */
  readonly factCount: number
}

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
 * 会话流内经验沉淀完成卡片节点的载荷。
 *
 * 承载完整的 `plugin:corum-agent/distill-completed` 事件数据（jobId / sessionId /
 * factCount）——与 commit-card 不同（commit-card 的节点 data 只承载 turn，实时数据来自
 * pendingInteractions）：distill 卡片是**终态**完成卡，事件本身就是持久锚点，
 * 刷新后仍在（durable session.append），故直接把数据放在节点 data 里。
 */
export interface DistillCardChatData {
  /** 归档任务 id。 */
  readonly jobId: string
  /** 会话 id。 */
  readonly sessionId: string
  /** 候选经验条数。 */
  readonly factCount: number
}

declare module '@corum/corum-ui-chat/client' {
  interface ChatNodeDataMap {
    /**
     * 经验沉淀完成卡片的会话流内节点。锚点 = durable 会话事件
     * `plugin:corum-agent/distill-completed`（host 侧 corum-agent 经
     * `appendPluginRecord` 追加，仅 factCount>0 时 append）。
     */
    'distill-card': DistillCardChatData
  }
}

/** 仅供 SessionId 类型 re-export 使用（避免未使用 import 警告）。 */
export type { SessionId }
