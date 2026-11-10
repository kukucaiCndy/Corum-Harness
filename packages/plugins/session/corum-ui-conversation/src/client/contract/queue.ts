/** Queue contracts derived from the Session Controller face. */
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** One address accepted by the Session Controller's queue mutation verb. */
export type QueueItemId = Parameters<SessionFace['updateQueue']>[0]

/**
 * One mutation accepted by the Session Controller's queue mutation verb.
 * fork（corum）：在官方三态（edit/remove/steer）上扩出
 * `{ kind: 'requeue' }` —— 插话撤回 → 退回队首；host 侧由
 * `@corum/corum-session-queue-revert` 的 SessionController 子类承接
 * （Remote 请求走结构化序列化，无 wire schema 校验，两侧类型联合分别补齐）。
 */
export type QueueAction =
  | Parameters<SessionFace['updateQueue']>[1]
  | { readonly kind: 'requeue' }

/**
 * One row projected by the authoritative inbox projection's next-turn queue.
 * rc3: SessionSnapshot.queue was removed; the inbox is now a projection
 * (`session.projections.faceOf('inbox')`) whose `next-turn` entries are
 * `UserMessage` values.
 */
export type QueueRow = UserMessage
