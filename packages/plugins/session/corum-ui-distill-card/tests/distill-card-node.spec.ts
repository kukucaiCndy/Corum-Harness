/**
 * corum-ui-distill-card 会话流内节点 Definition 单测。
 *
 * 钉的是 `distillCardDefinition` 的「**哪些事件算这个节点**」判定：
 *   - `kind` / `target` 常量（会话流节点注册键，漂移即注册不上 / 渲染器认不出）；
 *   - `match`：只有 `corum/distill-completed` 事件才算本节点的锚点（其余返回
 *     null——不误吞别人家的事件）；
 *   - `start`：从事件 data 读出 jobId / sessionId / factCount；
 *   - `buildViewNode`：state 缺 → null；否则吐出 `{ kind: 'distill-card', data }` 节点。
 *
 * 不起 UI、不引 jsdom——直接喂模拟事件对象给纯函数 Definition，断言返回。
 */
import { describe, expect, it } from 'vitest'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationLocation, ConversationMatch, ConversationNodeContext,
  ConversationStartMatch,
} from '@corum/corum-ui-conversation/client'
import type { ChatNode } from '@corum/corum-ui-chat/client'
import { distillCardDefinition } from '../src/client/conversation-nodes/distill-card.ts'
import type { DistillCardChatData } from '../src/client/contract.ts'

/** `corum/distill-completed` 事件载荷的最小收窄。 */
interface DistillCompletedPayload {
  readonly jobId: string
  readonly sessionId: string
  readonly factCount: number
}

/** 造一个 `corum/distill-completed` 事件。 */
function distillEvent(seq: number, data: DistillCompletedPayload): SessionEventLike {
  return { type: 'corum/distill-completed', seq, data } as unknown as SessionEventLike
}

/** turn location（kind === 'turn'）。 */
function turnLocation(turn: number): ConversationLocation {
  return { kind: 'turn', turn: { turn, start: undefined, end: undefined, status: 'closed', steps: [], data: null as never } }
}

/** 把一个 event + location 包成 start match。 */
function startMatch(seq: number, location: ConversationLocation, data: DistillCompletedPayload): ConversationStartMatch {
  return { event: distillEvent(seq, data) as never, role: 'start', location }
}

/** 造一个带 state 的 node context（buildViewNode 用）。 */
function contextWith(state: DistillCardChatData | undefined, match?: ConversationStartMatch): ConversationNodeContext<DistillCardChatData> {
  return {
    key: 'k1', kind: 'distill-card', id: String(match?.event.seq ?? 1),
    matches: match ? [match as ConversationMatch] : [],
    start: match,
    state,
    current: new Map(),
  }
}

/** 样例 payload。 */
const SAMPLE_PAYLOAD: DistillCompletedPayload = {
  jobId: 'job-abc-123',
  sessionId: 'corum-task-xyz',
  factCount: 5,
}

describe('distillCardDefinition 常量', () => {
  it('★ kind 逐字为 "distill-card"（会话流节点注册键）', () => {
    expect(distillCardDefinition.kind).toBe('distill-card')
  })

  it('★ target 逐字为 "chat"（只渲染到 chat 流）', () => {
    expect(distillCardDefinition.target).toBe('chat')
  })
})

describe('match —— 锚点判定（哪些事件算本节点）', () => {
  it('★ corum/distill-completed 事件 ⇒ start 锚点', () => {
    const e = distillEvent(7, SAMPLE_PAYLOAD)
    const r = distillCardDefinition.match(e)
    expect(r).toEqual({ id: '7', role: 'start' })
  })

  it('非 corum/distill-completed 事件 ⇒ 不算（不误吞别家事件类型）', () => {
    const e = { type: 'turn/start', seq: 1, data: {} } as unknown as SessionEventLike
    expect(distillCardDefinition.match(e)).toBeNull()
  })

  it('agent/inbox/spliced 事件 ⇒ 不算（commit-card 的锚点不误吞）', () => {
    const e = { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-step', inserted: [{ source: { kind: 'commit-card' } }] } } as unknown as SessionEventLike
    expect(distillCardDefinition.match(e)).toBeNull()
  })
})

describe('start —— 从事件 data 读出完整卡片数据', () => {
  it('★ 读出 jobId / sessionId / factCount（节点 data 承载完整事件数据）', () => {
    const m = startMatch(3, turnLocation(5), SAMPLE_PAYLOAD)
    const state = distillCardDefinition.start({} as never, m, {} as never)
    expect(state).toEqual({
      jobId: 'job-abc-123',
      sessionId: 'corum-task-xyz',
      factCount: 5,
    })
  })
})

describe('buildViewNode —— 产出会话流节点', () => {
  it('★ state 缺 ⇒ null', () => {
    const node = distillCardDefinition.buildViewNode!(contextWith(undefined))
    expect(node).toBeNull()
  })

  it('★ 合法 state + start ⇒ 节点 data === state（完整数据原样落到 data）', () => {
    const m = startMatch(7, turnLocation(5), SAMPLE_PAYLOAD)
    const state: DistillCardChatData = { jobId: 'job-abc-123', sessionId: 'corum-task-xyz', factCount: 5 }
    const node = distillCardDefinition.buildViewNode!(contextWith(state, m))
    expect(node).not.toBeNull()
    const n = node as ChatNode<'distill-card'>
    expect(n.kind).toBe('distill-card')
    expect(n.target).toBe('chat')
    expect(n.id).toBe('7')
    expect(n.anchorSeq).toBe(7)
    expect(n.visibility).toBe('visible')
    expect(n.data).toEqual(state)
  })

  it('★ start 缺（event.seq 取不到）⇒ null（防 anchorSeq=undefined 的脏节点）', () => {
    const state: DistillCardChatData = { jobId: 'job-abc-123', sessionId: 'corum-task-xyz', factCount: 5 }
    const node = distillCardDefinition.buildViewNode!(contextWith(state, undefined))
    expect(node).toBeNull()
  })
})

describe('update / publication —— 逐字段对齐', () => {
  it('update 原样返回 state（distill 卡片节点无增量更新语义）', () => {
    const m = startMatch(7, turnLocation(5), SAMPLE_PAYLOAD)
    const state: DistillCardChatData = { jobId: 'job-abc-123', sessionId: 'corum-task-xyz', factCount: 5 }
    const ctx = contextWith(state, m) as ConversationNodeContext<DistillCardChatData> & { readonly state: DistillCardChatData }
    const out = distillCardDefinition.update(ctx, m as unknown as ConversationMatch)
    expect(out).toEqual(state)
  })

  it('publication 返回 "immediate"（完成事件立即展示，不延迟到帧合并）', () => {
    const m = startMatch(7, turnLocation(5), SAMPLE_PAYLOAD) as unknown as ConversationMatch
    expect(distillCardDefinition.publication!(m)).toBe('immediate')
  })
})
