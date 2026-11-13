/**
 * 唤醒消息卡片（turn trigger）。
 *
 * ## 为什么需要它
 *
 * 会话里的「用户消息」并非都是用户敲进来的。宿主会把若干**非用户输入的唤醒源**以
 * user-role 消息投递进会话，并带上 `source` 归因（官方词汇表见
 * `@deepseek-ai/dsh-llm` 的 `MessageSourceMap`）：
 *
 *   · `agent-message`   —— 另一个 Agent 发给本会话的消息（`Agent <id> sent a message: …`）
 *   · `subagent-settled`—— 后台子 Agent 结束的运行时账单（`Background subagent <id> finished …`）
 *   · `goal` / `team-message` / `schedule` / `webhook` / `tool-jobs` / `cordis-host-runner`
 *
 * 用户看到的却是「You + 内容」的气泡 —— 也就是**把它当成了自己说的话**。实测报障：
 * 子 Agent 的返回在阻塞时以「用户输入」形态出现在对话流里，看起来像用户自己粘了一大段
 * 子 Agent 日志。
 *
 * 官方 ui-chat 的做法是给这类消息一个独立的 turn-trigger 卡片（标题按 source 家族区分，
 * 正文可展开）。本 fork 接管了 ui-chat 但没有搬这块，于是退回成默认气泡。本文件把这块
 * 补回来：**有 source 且不是用户自己的提交 ⇒ 渲染成卡片，不出现 "You"**。
 *
 * ## 为什么按 source 而不是按文案匹配
 *
 * 按 `Agent <id> sent a message` 这类前缀做正则，会在文案改动时静默失效，也会误伤用户
 * 正常输入的内容。`source` 是**持久化归因**（每条事件都写进日志），是唯一稳定判据。
 *
 * @module @corum/corum-ui-chat/chat/TurnTriggerCard
 */
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { triggerSourceOf, type TurnTriggerKind, type TurnTriggerSource } from '@corum/corum-ui-conversation/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './TurnTriggerCard.module.css'

// 判据（kind 词汇表 + `triggerSourceOf`）住 `@corum/corum-ui-conversation`：pending 阶段的
// 另一个消费面 `QueueDock` 也在那里，依赖方向是 chat → conversation。这里只做转发，
// 现有 import 方（MessageItem、tests）继续从本模块取，不动调用点。
export { triggerSourceOf }
export type { TurnTriggerKind, TurnTriggerSource }

/**
 * 把内容块收敛成卡片正文（只取文本；非文本块用占位说明，避免整条消失）。
 *
 * @param content - 消息的内容块。
 * @returns 可渲染的纯文本。
 */
export function triggerBodyText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
    else parts.push('[附件]')
  }
  return parts.join('\n').trim()
}

/** 标题 key 的映射（source 家族 → 文案 key）。 */
function titleKeyOf(source: TurnTriggerSource): ChatViewSlotProps['t'] extends (key: infer K, ...args: never[]) => unknown ? K : never {
  switch (source.kind) {
    case 'agent-message': return 'trigger.agentMessage' as never
    case 'subagent-settled': return 'trigger.subagentSettled' as never
    case 'goal': return 'trigger.goal' as never
    case 'team-message': return 'trigger.teamMessage' as never
    case 'schedule': return 'trigger.schedule' as never
    case 'tool-jobs': return 'trigger.job' as never
    case 'webhook': return (source.provider === 'github' ? 'trigger.github' : 'trigger.webhook') as never
    case 'cordis-host-runner': return 'trigger.plugin' as never
    default: return 'trigger.request' as never
  }
}

/**
 * 渲染一条唤醒消息卡片（默认收起，点标题展开正文）。
 *
 * @param props - 触发源、内容块、时间与文案函数。
 * @returns 卡片节点。
 */
export function TurnTriggerCard({ source, content, time, t }: {
  readonly source: TurnTriggerSource
  readonly content: readonly ContentBlock[]
  readonly time?: number | undefined
  readonly t: ChatViewSlotProps['t']
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const body = triggerBodyText(content)
  const timeText = time === undefined
    ? ''
    : new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={css.root} data-turn-trigger={source.kind}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className={css.title}>{t(titleKeyOf(source))}</span>
        {source.senderSessionId !== undefined && (
          <span className={css.sender} title={source.senderSessionId}>{source.senderSessionId}</span>
        )}
        <span className={css.time}>{timeText}</span>
        <ChevronDown size={14} strokeWidth={2} className={open ? css.chevronOpen : css.chevron} />
      </button>
      {!open && source.summary !== undefined && source.summary !== '' && (
        <p className={css.summary}>{source.summary}</p>
      )}
      {open && body !== '' && <pre className={css.body}>{body}</pre>}
    </div>
  )
}