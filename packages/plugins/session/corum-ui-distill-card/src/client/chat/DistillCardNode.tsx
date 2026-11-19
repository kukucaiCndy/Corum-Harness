/**
 * DistillCardNode —— 经验沉淀完成卡片的会话流内 keyed 渲染器
 * （`conversation.chat.node` key = 'distill-card'）。
 *
 * 节点 data 承载完整事件数据（jobId / sessionId / factCount）——卡片直接渲染，
 * 不需要 pendingInteractions 订阅（与 commit-card 不同：commit-card 的数据来自
 * 非会话源 emit，需 useSyncExternalStore 订阅；distill 卡是终态完成卡，事件数据
 * 即完整数据）。
 *
 * 「查看归档」按钮调 `layout.openDistillArchive({jobId, sessionId})`（能力探测），
 * 不具备回落 `openSettingsSection('memory-agent')`。layout 能力面经 inject
 * 声明传入（本插件硬依赖 layout，fiber 装配时已 provide）。
 */
import type { ChatNode } from '@corum/corum-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DistillArchiveCapableLayout } from '../contract.ts'
import { DistillCard } from '../DistillCard.tsx'

/** 本渲染器实际消费的 props 子集（keyed 槽运行时 props 是超集，结构收窄兼容）。 */
interface DistillCardNodeProps {
  readonly node: ChatNode<'distill-card'>
  readonly sessionId: SessionId
}

/**
 * 创建会话流内经验沉淀完成卡片节点渲染器。
 * @param layout - layout 能力面（能力探测用；运行时可能不具备）。
 * @returns keyed 槽渲染器函数。
 */
export function createDistillCardNodeView(layout: DistillArchiveCapableLayout | undefined) {
  return function DistillCardNodeView({ node }: DistillCardNodeProps) {
    return (
      <DistillCard
        data={node.data}
        layout={layout}
      />
    )
  }
}
