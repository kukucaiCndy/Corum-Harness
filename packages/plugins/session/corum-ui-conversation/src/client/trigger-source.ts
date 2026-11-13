/**
 * 唤醒消息（turn trigger）的**归因识别**模块（单一事实源）。
 *
 * ## 为什么判据住在本包
 *
 * 「这条 user-role 消息到底是不是用户敲的」有三个消费面：
 *
 *   · durable 投影 —— chat 的 `conversation-nodes/message.ts` 把非 user
 *     `source` 投影成 context 通知节点（`form: 'notice'`）；
 *   · pending 插话 —— chat 的 `PendingSteeringBubble`（next-step inbox 投影）；
 *   · pending 排队 —— 本包的 `QueueDock`（next-turn inbox 投影）。
 *
 * 后两个面都在 pending 阶段，**投递机制只往 inbox 里塞 user-role 消息 + source**，
 * 于是同一份归因要被两个包各判一次。依赖方向是 chat → conversation，
 * conversation 绝不许反向 import chat，所以判据必须住在本包，由 chat 反过来引用
 * （`chat/TurnTriggerCard.tsx` 只做转发）。
 *
 * ## 为什么按 source 而不是按文案匹配
 *
 * 按 `Agent <id> sent a message` 这类前缀做正则，会在文案改动时静默失效，也会误伤
 * 用户正常输入的内容。`source` 是**持久化归因**（每条事件都写进日志），是唯一稳定判据；
 * 官方词汇表见 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap`。
 *
 * @module @corum/corum-ui-conversation/trigger-source
 */

/** 触发源家族（决定标题与图标）。 */
export type TurnTriggerKind =
  | 'agent-message'
  | 'subagent-settled'
  | 'goal'
  | 'team-message'
  | 'schedule'
  | 'webhook'
  | 'tool-jobs'
  | 'cordis-host-runner'
  | 'request'

/** 每条消息所属的触发源（`kind` 已知时才成立）。 */
export interface TurnTriggerSource {
  readonly kind: TurnTriggerKind
  readonly senderSessionId?: string
  readonly summary?: string
  readonly provider?: string
}

/** 官方词汇表里这些 kind 都不是「用户自己敲的」。 */
export const TRIGGER_KINDS: ReadonlySet<string> = new Set<TurnTriggerKind>([
  'agent-message',
  'subagent-settled',
  'goal',
  'team-message',
  'schedule',
  'webhook',
  'tool-jobs',
  'cordis-host-runner',
  'request',
])

/**
 * 从持久化 `source` 里判出「这是唤醒消息而不是用户输入」。
 *
 * @param source - 用户消息事件上的 `source`（未知形状；inbox 投影项同样携带）。
 * @returns 触发源；用户自己的提交（`kind: 'user'`）、缺失或未知 kind ⇒ `undefined`。
 */
export function triggerSourceOf(source: unknown): TurnTriggerSource | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  const kind = record['kind']
  // 用户自己的提交：`{ kind: 'user', rpcId }`（见 chat 的 observedRpcIds 判据）。
  if (typeof kind !== 'string' || !TRIGGER_KINDS.has(kind)) return undefined
  return {
    kind: kind as TurnTriggerKind,
    ...(typeof record['senderSessionId'] === 'string' ? { senderSessionId: record['senderSessionId'] } : {}),
    ...(typeof record['summary'] === 'string' ? { summary: record['summary'] } : {}),
    ...(typeof record['provider'] === 'string' ? { provider: record['provider'] } : {}),
  }
}
