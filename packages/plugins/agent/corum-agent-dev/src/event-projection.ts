/**
 * 会话事件投影 —— SessionEvent → UI 渲染 DTO 的简化/汇总。
 *
 * 从 agent-service.ts 拆出（包内文件拆分，零 RPC 面变化）。纯函数层：
 * 不碰 cordis / 文件系统 / 服务实例，只做事件数据的可读投影。
 *   - extractHeader：从 request/header 事件提取装配的 system prompt + 工具表；
 *   - summarizeText：汇总一段区间内的最终 assistant 文本；
 *   - taskTitleOf：取首条 user/message 作任务标题；
 *   - simplifyEventData：单事件 data 字段简化为 UI 渲染子集（JSON-safe）。
 * @module @corum/corum-agent-dev/event-projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 从 request/header 事件提取最终装配的 system prompt + 工具列表。 */
export function extractHeader(events: readonly SessionEvent[], firstSeq: number): {
  systemPrompt?: string
  tools?: Array<{ name: string; description?: string }>
} {
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type !== 'request/header') continue
    const header = (event.data as { header?: { system?: string; tools?: Array<{ name?: string; description?: string }> } }).header
    if (header === undefined) return {}
    const result: { systemPrompt?: string; tools?: Array<{ name: string; description?: string }> } = {}
    if (header.system !== undefined) result.systemPrompt = header.system
    if (Array.isArray(header.tools)) {
      result.tools = header.tools.map(t => ({
        name: t.name ?? '',
        ...(t.description !== undefined ? { description: t.description } : {}),
      }))
    }
    return result
  }
  return {}
}

/** 汇总一段区间内最终的 assistant 文本（text 块拼接）。 */
export function summarizeText(events: readonly SessionEvent[], firstSeq: number): string {
  let started = false
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
  }
  return text
}

/** 从事件流提取 task 会话标题（首条 user 消息的首行，截断 40 字）。 */
export function taskTitleOf(events: readonly SessionEvent[]): string {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    // user/message content 在 data.content（顶层）或 data.message.content（兼容两种形态）。
    const data = event.data as {
      content?: Array<{ type: string; text?: string }>
      message?: { content?: Array<{ type: string; text?: string }> }
    } | undefined
    const content = data?.content ?? data?.message?.content ?? []
    const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join(' ').trim()
    if (text !== '') {
      const firstLine = text.split('\n')[0]
      return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
    }
  }
  return ''
}

/**
 * 简化 SessionEvent 的 data 字段，只保留 UI 渲染需要的子集。
 */
export function simplifyEventData(event: SessionEvent): unknown {
  let raw: Record<string, unknown>
  switch (event.type) {
    case 'user/message': {
      // 官方 user/message 事件 content 在 data.content（顶层）；少数路径在
      // data.message.content（与 assistant/message 同形）。两种都兼容。
      const data = event.data as {
        content?: Array<{ type: string; text?: string }>
        message?: { content?: Array<{ type: string; text?: string }> }
      }
      const content = data.content ?? data.message?.content ?? []
      raw = {
        content: content.map(b => b.type === 'text' ? { type: 'text', text: b.text ?? '' } : { type: b.type }),
      }
      break
    }
    case 'assistant/message': {
      const data = event.data as {
        message: { content: Array<{ type: string; text?: string; reasoning?: string }> }
        turn?: number
        step?: number
        usage?: unknown
        interrupted?: boolean
      }
      raw = {
        content: data.message.content.map(b => {
          if (b.type === 'text') return { type: 'text', text: b.text ?? '' }
          if (b.type === 'reasoning') return { type: 'reasoning', text: b.reasoning ?? '' }
          if (b.type === 'tool-call') {
            // 内联 tool-call 块：保留 name + arguments（供工具行展示命令/路径）。
            const tb = b as { name?: string; arguments?: unknown }
            const out: Record<string, unknown> = { type: 'tool-call', name: tb.name ?? '' }
            if (tb.arguments !== undefined) out.arguments = tb.arguments
            return out
          }
          return { type: b.type }
        }),
      }
      // turn/step 投影（UI 据此关联 turn/start→turn/end 算耗时、判本 turn 是否落地）。
      if (data.turn !== undefined) raw.turn = data.turn
      if (data.step !== undefined) raw.step = data.step
      if (data.usage !== undefined) raw.usage = data.usage
      if (data.interrupted !== undefined) raw.interrupted = data.interrupted
      break
    }
    case 'tool/call': {
      const data = event.data as { callId?: string; name?: string; arguments?: unknown }
      raw = { callId: data.callId ?? '', name: data.name ?? '' }
      if (data.arguments !== undefined) raw.arguments = data.arguments
      break
    }
    case 'tool/result': {
      const data = event.data as {
        callId?: string
        error?: unknown
        message?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      }
      raw = {
        callId: data.callId ?? '',
        isError: data.message?.isError ?? false,
        content: data.message?.content?.map(b => b.type === 'text' ? { type: 'text', text: b.text ?? '' } : { type: b.type }) ?? [],
      }
      if (data.error !== undefined) raw.error = String(data.error)
      break
    }
    case 'turn/start': {
      raw = { turn: (event.data as { turn?: number }).turn ?? 0 }
      break
    }
    case 'turn/end': {
      const data = event.data as { turn?: number; reason?: unknown }
      // reason 可能是对象（FinishReason 结构）——取可读字符串而非 [object Object]。
      const reason = data.reason
      raw = {
        turn: data.turn ?? 0,
        reason: typeof reason === 'string' ? reason : reason !== undefined ? JSON.stringify(reason) : '',
      }
      break
    }
    case 'step/start':
    case 'step/end': {
      raw = { turn: (event.data as { turn?: number }).turn ?? 0, step: (event.data as { step?: number }).step ?? 0 }
      break
    }
    case 'assistant/chunk': {
      // 流式增量（官方 StreamChunk）：投影 chunk 判别字段 + 增量内容，
      // 供 UI 聚合同 turn+step 的连续 chunk 为「流式增量」块。
      const data = event.data as {
        turn?: number
        step?: number
        chunk?: {
          type?: string
          text?: string
          name?: string
          argumentsDelta?: string
          reason?: unknown
          usage?: unknown
        }
      }
      const chunk = data.chunk ?? {}
      raw = {
        turn: data.turn ?? 0,
        step: data.step ?? 0,
        chunkType: chunk.type ?? '',
      }
      if (chunk.text !== undefined) raw.text = chunk.text
      if (chunk.name !== undefined) raw.name = chunk.name
      if (chunk.argumentsDelta !== undefined) raw.argumentsDelta = chunk.argumentsDelta
      if (chunk.reason !== undefined) raw.reason = String(chunk.reason)
      if (chunk.usage !== undefined) raw.usage = chunk.usage
      break
    }
    default:
      raw = {}
  }
  // 清洗为完全 JSON-safe 的 plain object（Gateway assertJsonValue 要求）
  return JSON.parse(JSON.stringify(raw))
}
