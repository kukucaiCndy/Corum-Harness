/**
 * fork（corum）vendor：官方 `SessionCommandController.updateQueue` 函数体
 * 的逐字拷贝（官方 `@deepseek-ai/dsh-api-session-controller`
 * 0.1.3-alpha.1，源文件 packages/api/session-controller/src/commands.ts:402-450），
 * 从类方法改写为以 commands 实例为 receiver 的自由函数（npm 产物不带
 * src、SessionCommandController 也不在公共导出面，只能拷贝）。非 requeue
 * 分支必须始终与官方逐字一致 —— 升级官方基线时按 docs/fork-delta.md
 * runbook 重拷并 diff。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {
  SessionUpdateQueueRequest, SessionUpdateQueueValue,
} from '@deepseek-ai/dsh-api-session-controller'
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  apiSessionSubagentOwnershipErrorLocal,
  hasApiSessionSubagentOwnerLocal,
} from './agent-guards.ts'

/** 官方 commands 实例的运行时面（官方 updateQueue + corum requeue 共同触达的成员）。 */
export interface OfficialUpdateQueueReceiver {
  /** Host root context：官方 updateQueue 读 `this.ctx.agents`（cordis 服务，有 .get）与 `this.ctx.fileUploads`。 */
  ctx: Context
}

/**
 * 官方 updateQueue（edit/remove/steer 三分支，逐字）。this → receiver。
 */
export function updateQueueOfficial(
  receiver: OfficialUpdateQueueReceiver,
  request: SessionUpdateQueueRequest,
): SessionUpdateQueueValue {
  // fork（corum，issue #211 / 用户 2026-11-12 实测）：官方这里**无条件拒绝**带非文本块的编辑，
  // 于是带图片的排队消息根本改不了文字。放宽为「非文本块必须**原样带回来**」：
  // 编辑只允许改文字，图片/文件块要么不带（纯文本行）、要么与队列里那条逐字相同 ——
  // 这样既支持「改文字但保留图片」，也不会因为替换而**静默丢附件**。
  const agent = receiver.ctx.agents.get(request.sessionId)
  if (agent !== undefined && hasApiSessionSubagentOwnerLocal(receiver.ctx, agent.session, agent as never)) {
    throw apiSessionSubagentOwnershipErrorLocal(request.sessionId)
  }
  if (agent === undefined) {
    throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
  }
  const agentInbox = agent.inbox as unknown as {
    nextTurn: readonly UserMessage[]
    nextStep: readonly UserMessage[]
    replace(messageId: UserMessage['id'], message: UserMessage): boolean
    remove(messageId: UserMessage['id']): boolean
  }
  const nextTurn = agentInbox.nextTurn.find(message => message.id === request.itemId)
  const nextStep = agentInbox.nextStep.find(message => message.id === request.itemId)
  const located = nextTurn === undefined
    ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
    : { target: 'next-turn' as const, message: nextTurn }
  if (located === undefined) {
    throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
  }
  const { target, message } = located
  if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
    throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
  }
  if (request.action.kind === 'edit') {
    // fork（corum，用户 2026-11-12）：编辑**只允许改文字**，非文本块必须与队列里那条逐字相同。
    // 判定从「无条件拒绝非文本」放宽到「不许悄悄换掉附件」——否则带图片的排队消息根本改不了字。
    const carried = request.action.content.filter(block => block.type !== 'text')
    if (carried.length > 0 && JSON.stringify(carried) !== JSON.stringify(message.content.filter(block => block.type !== 'text'))) {
      throw new RemoteError(
        'session/attachment-invalid',
        'queue edits may only change text; attachments must be carried over unchanged',
        { reason: 'QUEUE_EDIT_NON_TEXT' },
      )
    }
    agentInbox.replace(request.itemId, freezeMessage<UserMessage>({
      ...message,
      content: [...request.action.content],
    }))
  } else {
    agentInbox.remove(request.itemId)
    if (request.action.kind === 'remove') {
      const source = message.source
      if (source.kind === 'user' && 'rpcId' in source) {
        receiver.ctx.fileUploads.retirePrompt(agent as never, source.rpcId as string)
      }
    }
    if (request.action.kind === 'steer') agent.steer(message)
  }
  return { accepted: true }
}
