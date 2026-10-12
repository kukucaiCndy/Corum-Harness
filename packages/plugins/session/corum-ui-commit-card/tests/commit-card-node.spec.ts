/**
 * corum-ui-commit-card 会话流内节点 Definition 单测。
 *
 * 钉的是 `commitCardDefinition` 的「**哪些事件算这个节点**」判定：
 *   - `kind` / `target` 常量（会话流节点注册键，漂移即注册不上 / 渲染器认不出）；
 *   - `match`：只有 `agent/inbox/spliced` 且 `target === 'next-step'` 且
 *     `inserted[].source.kind === 'commit-card'` 的事件才算本节点的锚点（其余返回
 *     null——不误吞别人家的事件）；
 *   - `start`：从锚点事件的 location 取 turn（turn/step location 都认；认不出
 *     兜底 -1）；
 *   - `buildViewNode`：state 缺 / turn < 0 → null（历史会话降级）；否则吐出
 *     `{ kind: 'commit-card', data: { turn } }` 节点。
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
import {
  COMMIT_CARD_SOURCE_KIND, commitCardDefinition,
} from '../src/client/conversation-nodes/commit-card.ts'
import type { CommitCardChatData } from '../src/client/contract.ts'

/** `agent/inbox/spliced` 事件载荷的最小收窄（与 commit-card.ts 的 InboxSplicedData 同构）。 */
interface SpliceData {
  readonly target: string
  readonly inserted: readonly { readonly source: { readonly kind?: string } }[]
}

/** 造一个 `agent/inbox/spliced` 事件。 */
function splicedEvent(seq: number, data: SpliceData): SessionEventLike {
  return { type: 'agent/inbox/spliced', seq, data } as unknown as SessionEventLike
}

/** turn location（kind === 'turn'）。 */
function turnLocation(turn: number): ConversationLocation {
  return { kind: 'turn', turn: { turn, start: undefined, end: undefined, status: 'closed', steps: [], data: null as never } }
}

/** step location（kind === 'step'；嵌一个 turn）。 */
function stepLocation(turn: number, step: number): ConversationLocation {
  const stepLoc = { turn, step, start: undefined, end: undefined, status: 'closed', data: null as never }
  return { kind: 'step', turn: { turn, start: undefined, end: undefined, status: 'closed', steps: [stepLoc], data: null as never }, step: stepLoc }
}

/** 把一个 event + location 包成 start match。 */
function startMatch(seq: number, location: ConversationLocation, data: SpliceData): ConversationStartMatch {
  return { event: splicedEvent(seq, data) as never, role: 'start', location }
}

/** 造一个带 state 的 node context（buildViewNode 用）。 */
function contextWith(state: CommitCardChatData | undefined, match?: ConversationStartMatch): ConversationNodeContext<CommitCardChatData> {
  return {
    key: 'k1', kind: 'commit-card', id: String(match?.event.seq ?? 1),
    matches: match ? [match as ConversationMatch] : [],
    start: match,
    state,
    current: new Map(),
  }
}

describe('commitCardDefinition 常量', () => {
  it('★ kind 逐字为 "commit-card"（会话流节点注册键）', () => {
    expect(commitCardDefinition.kind).toBe('commit-card')
  })

  it('★ target 逐字为 "chat"（只渲染到 chat 流）', () => {
    expect(commitCardDefinition.target).toBe('chat')
  })

  it('★ COMMIT_CARD_SOURCE_KIND 逐字为 "commit-card"（host steer 的 producer-owned 来源标记）', () => {
    expect(COMMIT_CARD_SOURCE_KIND).toBe('commit-card')
  })
})

describe('match —— 锚点判定（哪些事件算本节点）', () => {
  it('★ next-step steer + 带 commit-card 来源 ⇒ start 锚点', () => {
    const e = splicedEvent(7, {
      target: 'next-step',
      inserted: [{ source: { kind: 'commit-card' } }],
    })
    const r = commitCardDefinition.match(e)
    expect(r).toEqual({ id: '7', role: 'start' })
  })

  it('target !== "next-step" ⇒ 不算（如 current-step steer）', () => {
    const e = splicedEvent(7, {
      target: 'current-step',
      inserted: [{ source: { kind: 'commit-card' } }],
    })
    expect(commitCardDefinition.match(e)).toBeNull()
  })

  it('inserted 里没有 commit-card 来源 ⇒ 不算（别人的 steer）', () => {
    const e = splicedEvent(7, {
      target: 'next-step',
      inserted: [{ source: { kind: 'other' } }, { source: {} }],
    })
    expect(commitCardDefinition.match(e)).toBeNull()
  })

  it('★ inserted 里**任一条**带 commit-card 来源即算（批量 splice 里至少一条是提交卡片）', () => {
    const e = splicedEvent(7, {
      target: 'next-step',
      inserted: [{ source: { kind: 'note' } }, { source: { kind: 'commit-card' } }],
    })
    expect(commitCardDefinition.match(e)).toEqual({ id: '7', role: 'start' })
  })

  it('非 agent/inbox/spliced 事件 ⇒ 不算（不误吞别家事件类型）', () => {
    const e = { type: 'turn/start', seq: 1, data: {} } as unknown as SessionEventLike
    expect(commitCardDefinition.match(e)).toBeNull()
  })

  it('data 缺 target / inserted 非数组 ⇒ 不算（畸形载荷不崩）', () => {
    expect(commitCardDefinition.match({ type: 'agent/inbox/spliced', seq: 1, data: {} } as unknown as SessionEventLike)).toBeNull()
    expect(commitCardDefinition.match({ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-step', inserted: 'no' } } as unknown as SessionEventLike)).toBeNull()
  })
})

describe('start —— 从锚点取 turn（节点 data 承载的关联键）', () => {
  it('★ turn location ⇒ data.turn = location.turn.turn', () => {
    const m = startMatch(3, turnLocation(5), { target: 'next-step', inserted: [{ source: { kind: 'commit-card' } }] })
    const state = commitCardDefinition.start({} as never, m, {} as never)
    expect(state).toEqual({ turn: 5 })
  })

  it('★ step location ⇒ data.turn = location.turn.turn（step 也认，回退到 turn）', () => {
    const m = startMatch(3, stepLocation(9, 2), { target: 'next-step', inserted: [{ source: { kind: 'commit-card' } }] })
    const state = commitCardDefinition.start({} as never, m, {} as never)
    expect(state).toEqual({ turn: 9 })
  })

  it('★ 认不出 turn 的 location ⇒ 兜底 { turn: -1 }（不丢节点，标记占位）', () => {
    const m = startMatch(3, { kind: 'session' }, { target: 'next-step', inserted: [{ source: { kind: 'commit-card' } }] })
    const state = commitCardDefinition.start({} as never, m, {} as never)
    expect(state).toEqual({ turn: -1 })
  })
})

describe('buildViewNode —— 产出会话流节点', () => {
  it('★ state 缺 ⇒ null（历史会话重载后 PendingCommitCard 不存在）', () => {
    const node = commitCardDefinition.buildViewNode!(contextWith(undefined))
    expect(node).toBeNull()
  })

  it('★ state.turn < 0 ⇒ null（start 兜底的 -1 不渲染降级行）', () => {
    const node = commitCardDefinition.buildViewNode!(contextWith({ turn: -1 }))
    expect(node).toBeNull()
  })

  it('★ 合法 state + start ⇒ 节点 data === state（turn 关联键原样落到 data）', () => {
    const m = startMatch(7, turnLocation(5), { target: 'next-step', inserted: [{ source: { kind: 'commit-card' } }] })
    const node = commitCardDefinition.buildViewNode!(contextWith({ turn: 5 }, m))
    expect(node).not.toBeNull()
    const n = node as ChatNode<'commit-card'>
    expect(n.kind).toBe('commit-card')
    expect(n.target).toBe('chat')
    expect(n.id).toBe('7')
    expect(n.anchorSeq).toBe(7)
    expect(n.visibility).toBe('visible')
    expect(n.data).toEqual({ turn: 5 })
  })

  it('★ start 缺（event.seq 取不到）⇒ null（防 anchorSeq=undefined 的脏节点）', () => {
    const node = commitCardDefinition.buildViewNode!(contextWith({ turn: 5 }, undefined))
    expect(node).toBeNull()
  })
})

describe('update / publication —— 逐字段对齐', () => {
  it('update 原样返回 state（提交卡片节点无增量更新语义）', () => {
    const m = startMatch(7, turnLocation(5), { target: 'next-step', inserted: [{ source: { kind: 'commit-card' } }] })
    const ctx = contextWith({ turn: 5 }, m) as ConversationNodeContext<CommitCardChatData> & { readonly state: CommitCardChatData }
    const out = commitCardDefinition.update(ctx, m as unknown as ConversationMatch)
    expect(out).toEqual({ turn: 5 })
  })

  it('publication 返回 "immediate"（提交是本 turn 活跃事件，不延迟到帧合并）', () => {
    const m = startMatch(7, turnLocation(5), { target: 'next-step', inserted: [{ source: { kind: 'commit-card' } }] }) as unknown as ConversationMatch
    expect(commitCardDefinition.publication!(m)).toBe('immediate')
  })
})
