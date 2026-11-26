/**
 * `agent/pre-step` 注入的决策内核（纯函数，便于单测）。
 *
 * 这里只有一条不变式，但它此前是坏的：**操作只有在「确实进入某一步」后才能算已投递**。
 * 旧实现先清空待投递列表再 `await next()`，于是下游一旦 `{kind:'reject'}`（goal 轮冲突、
 * 被其它监听器拦下）或抛错，这条操作既没进任何 step、也从队列里消失了——静默丢失，
 * 且没有任何日志能看出来。现在改成「先放行 → 放行成功才注入并清空」。
 */
/** 待注入操作拼成的消息开头（host 注入与 UI 预览共用这一句）。 */
export const INJECT_HEADER = '[git] 用户在对话外操作了 git，请据此更新认知：'

/**
 * 把待注入操作拼成一条 user message 文本。
 * @param operations - 操作描述列表（顺序 = 实际发生顺序）。
 * @returns 注入文本。
 */
export function buildInjectMessage(operations: readonly string[]): string {
  return [INJECT_HEADER, ...operations.map(op => `  · ${op}`), '；请勿重复这些操作'].join('\n')
}

/**
 * 本轮是否值得注入（用户刚发起新消息的那一步）。
 *
 * 判据只认 `source.kind === 'user'`：goal 轮与后台子 Agent 轮的源不是 `user`，
 * 天然跳过；没有 source 的历史消息也不算「新的一轮」。
 * @param messages - 进入本步的消息列表。
 */
export function hasFreshUserMessage(messages: readonly { role: string; source?: { kind: string } }[]): boolean {
  return messages.some(m => m.role === 'user' && m.source !== undefined && m.source.kind === 'user')
}

/**
 * 注入是否应该发生。
 * @param pending - 该会话的待注入操作（undefined / 空 ⇒ 不注入）。
 * @param messages - 进入本步的消息列表。
 */
export function shouldInject(
  pending: readonly string[] | undefined,
  messages: readonly { role: string; source?: { kind: string } }[],
): boolean {
  if (pending === undefined || pending.length === 0) return false
  return hasFreshUserMessage(messages)
}

/** 注入用 user message 的形态（与 `createUserMessage` 的入参同构）。 */
export interface InjectMessageSpec {
  /** 正文（单段 text）。 */
  content: [{ type: 'text'; text: string }]
  /** 来源标记（渲染侧据此归为「上下文注入」）。 */
  source: { kind: 'git-panel' }
}

/**
 * 造注入消息的规格。
 * @param operations - 待注入操作。
 */
export function injectMessageSpec(operations: readonly string[]): InjectMessageSpec {
  return { content: [{ type: 'text', text: buildInjectMessage(operations) }], source: { kind: 'git-panel' } }
}
