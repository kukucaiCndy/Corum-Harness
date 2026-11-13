/**
 * unknown-surface fallback 的「内部协议事件」过滤回归。
 *
 * 2026-11-13 实机事故：MCP 渐进式索引把动态工具注册以 `developer/message`
 * （source.kind = 'tool-registry'）差量声明进会话，聊天兜底把它渲染成
 * 「未知 surface 事件」JSON 卡。这类事件是模型消费的协议事实，不是会话内容，
 * fallback 不得认领。
 */

import { describe, expect, it } from 'vitest'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'

type MatchEvent = Parameters<NonNullable<typeof unknownFallbackDefinition.match>>[0]

/** 造一个最小 append-surface 事件（fallback 只读 type / surfaceOp / seq / data）。 */
function appendEvent(type: string, data: unknown): MatchEvent {
  return {
    type,
    seq: 1,
    time: 0,
    surfaceOp: 'append',
    data,
  } as unknown as MatchEvent
}

/** MCP 索引差量声明的 developer/message（tool-registry source）。 */
function toolRegistryEvent(): MatchEvent {
  return appendEvent('developer/message', {
    turn: 17,
    step: 1,
    headerSeq: 100,
    message: {
      role: 'developer',
      source: { kind: 'tool-registry' },
      content: [{ type: 'tool-addition', toolName: 'mcp_index' }],
    },
  })
}

describe('unknownFallbackDefinition internal-event filter', () => {
  it('不认领 tool-registry 的 developer/message（不进未知卡）', () => {
    expect(unknownFallbackDefinition.match?.(toolRegistryEvent())).toBeNull()
  })

  it('普通 user/message 仍被兜底认领（不误伤）', () => {
    const event = appendEvent('user/message', {
      id: 'm1',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })
    expect(unknownFallbackDefinition.match?.(event)).toEqual({ id: '1', role: 'start' })
  })

  it('source.kind 非 tool-registry 的 developer/message 仍兜底可见', () => {
    const event = appendEvent('developer/message', {
      turn: 1,
      step: 1,
      message: { role: 'developer', source: { kind: 'other' }, content: [] },
    })
    expect(unknownFallbackDefinition.match?.(event)).toEqual({ id: '1', role: 'start' })
  })
})
