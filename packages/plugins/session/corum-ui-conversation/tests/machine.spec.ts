/**
 * SubmitMachine 状态机守卫 —— 会话输入提交面的唯一纯逻辑所有者。
 *
 * 为什么这层必须是**判据**而不是靠实机点几下确认：
 *
 * - 机器自己 `dispatch(事件) → 效果数组`，零 React / DOM / cordis。它的正确性
 *   完全在「事件顺序」上，而那正是实机最难复现的维度 —— 真实用户的一次 Enter
 *   背后可能是 `claim → enter → adjudicated → submit-settled` 四步，也可能是
 *   `enter → adjudicated(undefined) → sink-settled` 的两条并行路径。
 * - **反洗（anti-backwash）**判据：settled 事件带着 attempt.seq，过期 attempt 必须
 *   被丢弃。这类缺陷的形态是「上一个会话的结果落到这个会话」，UI 上看不出、只有
 *   把过期 seq 真的喂进去才暴露。
 * - 冻结槽与分离槽的区别（命令式 send 占单槽、普通消息 detach 后并发）是把
 *   「编辑器能否立刻清空」与「主机往返是否还在飞」解耦的那条不变式。
 *
 * 测试只断言**契约层面的事实**（phase / 效果类型 / retainSuffixOf / abort），
 * 不断言内部字段，这样重构状态机不必重写判据。
 */
import { describe, expect, it } from 'vitest'
import { SubmitMachine } from '../src/client/input/machine.ts'
import type { CommandClaim, InputEffect } from '../src/client/contract/input.ts'

/** 一个只有 token 的 claim（submit 闭包在机器里从不被调用）。 */
function claimOf(token: string, extra: Partial<CommandClaim> = {}): CommandClaim {
  return {
    token,
    submit: async () => ({ kind: 'success' }),
    ...extra,
  }
}

/** 取出某类效果，顺带保证调用的确是那个类型。 */
function effectsOfType<T extends InputEffect['type']>(
  effects: readonly InputEffect[],
  type: T,
): Extract<InputEffect, { type: T }>[] {
  return effects.filter((e): e is Extract<InputEffect, { type: T }> => e.type === type)
}

/** 走完「普通消息 Enter → default-sink」那一步，返回 attempt。 */
function enterPlain(machine: SubmitMachine, draft: string) {
  const effects = machine.dispatch({ type: 'enter', mode: 'queue', draft })
  const sinks = effectsOfType(effects, 'default-sink')
  expect(sinks).toHaveLength(1)
  return sinks[0]!.attempt
}

describe('SubmitMachine · 初始与草稿观察', () => {
  it('初始为 plain，无 claim', () => {
    const machine = new SubmitMachine()
    expect(machine.state.phase).toBe('plain')
    expect(machine.state.claim).toBeUndefined()
  })

  it('draft-changed 恒零效果（文本变更不驱动提交面）', () => {
    const machine = new SubmitMachine()
    expect(machine.dispatch({ type: 'draft-changed', draft: 'hello' })).toEqual([])
  })
})

describe('SubmitMachine · claim 的建立与撤销', () => {
  it('claim 后进入 claimed 并快照 token/hint/attachments', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan', { hint: 'hint', attachments: true }) })
    expect(machine.state.phase).toBe('claimed')
    expect(machine.state.claim).toEqual({ token: '/plan', hint: 'hint', attachments: true })
  })

  it('claim 快照**不**泄漏 submit 闭包（可序列化面）', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    expect(machine.state.claim).not.toHaveProperty('submit')
  })

  it('草稿破坏 token 前缀 ⇒ 自动掉回 plain（integrity watch）', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    machine.dispatch({ type: 'draft-changed', draft: '/pl' })
    expect(machine.state.phase).toBe('plain')
    expect(machine.state.claim).toBeUndefined()
  })

  it('草稿仍以 token 开头 ⇒ 保持 claimed', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    machine.dispatch({ type: 'draft-changed', draft: '/plan 详细一点' })
    expect(machine.state.phase).toBe('claimed')
  })

  it('busy 相位（submitting）拒绝新的 claim', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    machine.dispatch({ type: 'enter', mode: 'queue', draft: '/plan' })
    expect(machine.state.phase).toBe('submitting')
    machine.dispatch({ type: 'claim', claim: claimOf('/other') })
    expect(machine.state.claim?.token).toBe('/plan')
  })
})

describe('SubmitMachine · Enter 的三条分支', () => {
  it('空草稿 ⇒ 零效果（不铸 attempt）', () => {
    const machine = new SubmitMachine()
    expect(machine.dispatch({ type: 'enter', mode: 'queue', draft: '   ' })).toEqual([])
    expect(machine.state.phase).toBe('plain')
  })

  it('claimed ⇒ begin-submit，args 是 token 之后的正文', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    const effects = machine.dispatch({ type: 'enter', mode: 'queue', draft: '/plan 写一个测试' })
    const submits = effectsOfType(effects, 'begin-submit')
    expect(submits).toHaveLength(1)
    expect(submits[0]!.args).toBe(' 写一个测试')
    expect(machine.state.phase).toBe('submitting')
  })

  it('args 是 token 之后的**原文**：不折叠空白（命令自己 trim）', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    const effects = machine.dispatch({ type: 'enter', mode: 'queue', draft: '  /plan   a  b' })
    // 契约事实：草稿直接以 token 开头时走 slice(token.length)，后续空白原样保留。
    // 只有「草稿不以 token 开头」的兜底分支才吃掉一个分隔空白（见下一条）。
    expect(effectsOfType(effects, 'begin-submit')[0]!.args).toBe('   a  b')
  })

  it('兜底分支：草稿不以 token 开头时，吃掉一个分隔空白', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan ') })
    // claim token 带尾随空格，草稿写的是不带空格的形式 ⇒ 走 base=trimEnd 分支。
    const effects = machine.dispatch({ type: 'enter', mode: 'queue', draft: '/plan x' })
    expect(effectsOfType(effects, 'begin-submit')[0]!.args).toBe('x')
  })

  it('草稿以 / 开头且未 claim ⇒ 走 adjudicate 并进 adjudicating', () => {
    const machine = new SubmitMachine()
    const effects = machine.dispatch({ type: 'enter', mode: 'queue', draft: '/unknown x' })
    expect(effectsOfType(effects, 'adjudicate')).toHaveLength(1)
    expect(machine.state.phase).toBe('adjudicating')
  })

  it('普通消息 ⇒ detachedEffects：default-sink + commit-draft，且相位移回 plain', () => {
    const machine = new SubmitMachine()
    const effects = machine.dispatch({ type: 'enter', mode: 'skip', draft: 'hello' })
    expect(effects.map(e => e.type)).toEqual(['default-sink', 'commit-draft'])
    const commit = effectsOfType(effects, 'commit-draft')[0]!
    expect(commit.retainSuffixOf).toBe('hello')
    expect(effectsOfType(effects, 'default-sink')[0]!.mode).toBe('skip')
    expect(machine.state.phase).toBe('plain')
  })

  it('adjudicating / submitting 相位下的 Enter 被吞掉（不重复铸 attempt）', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'enter', mode: 'queue', draft: '/cmd' })
    expect(machine.state.phase).toBe('adjudicating')
    expect(machine.dispatch({ type: 'enter', mode: 'queue', draft: '/cmd' })).toEqual([])
  })
})

describe('SubmitMachine · adjudication 收敛', () => {
  /** 走到 adjudicating 并取回 attempt。 */
  function toAdjudicating(machine: SubmitMachine) {
    const effects = machine.dispatch({ type: 'enter', mode: 'queue', draft: '/cmd x' })
    return effectsOfType(effects, 'adjudicate')[0]!.attempt
  }

  it('返回 claim ⇒ begin-submit 并进 submitting', () => {
    const machine = new SubmitMachine()
    const attempt = toAdjudicating(machine)
    const effects = machine.dispatch({
      type: 'adjudicated',
      attempt,
      outcome: { claim: claimOf('/cmd') },
    })
    const submits = effectsOfType(effects, 'begin-submit')
    expect(submits).toHaveLength(1)
    expect(submits[0]!.args).toBe(' x')
    expect(machine.state.phase).toBe('submitting')
    expect(machine.state.claim?.token).toBe('/cmd')
  })

  it("返回 'handled' ⇒ 回 plain 且零效果（命令自己处理了，不再发消息）", () => {
    const machine = new SubmitMachine()
    const attempt = toAdjudicating(machine)
    expect(machine.dispatch({ type: 'adjudicated', attempt, outcome: 'handled' })).toEqual([])
    expect(machine.state.phase).toBe('plain')
  })

  it('返回 undefined ⇒ 回落到普通消息（两条 detached 效果）', () => {
    const machine = new SubmitMachine()
    const attempt = toAdjudicating(machine)
    const effects = machine.dispatch({ type: 'adjudicated', attempt, outcome: undefined })
    expect(effects.map(e => e.type)).toEqual(['default-sink', 'commit-draft'])
    expect(machine.state.phase).toBe('plain')
  })

  it('过期的 adjudicated（seq 不匹配）被丢弃 —— 反洗', () => {
    const machine = new SubmitMachine()
    const attempt = toAdjudicating(machine)
    const stale = { ...attempt, seq: attempt.seq + 99 }
    expect(machine.dispatch({ type: 'adjudicated', attempt: stale, outcome: undefined })).toEqual([])
    expect(machine.state.phase).toBe('adjudicating')
  })

  it('adjudication-failed ⇒ 回 plain 并给一条 error notice', () => {
    const machine = new SubmitMachine()
    const attempt = toAdjudicating(machine)
    const effects = machine.dispatch({
      type: 'adjudication-failed',
      attempt,
      message: 'boom',
    })
    expect(effects).toEqual([{ type: 'notice', level: 'error', text: 'boom' }])
    expect(machine.state.phase).toBe('plain')
  })
})

describe('SubmitMachine · 结算与反洗', () => {
  /** 走到 submitting 并取回 attempt。 */
  function toSubmitting(machine: SubmitMachine) {
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    const effects = machine.dispatch({ type: 'enter', mode: 'queue', draft: '/plan go' })
    return effectsOfType(effects, 'begin-submit')[0]!.attempt
  }

  it('成功结算 ⇒ 清 claim、回 plain、commit-draft 保留发送快照', () => {
    const machine = new SubmitMachine()
    const attempt = toSubmitting(machine)
    const effects = machine.dispatch({
      type: 'submit-settled',
      attempt,
      ok: true,
      draft: '/plan go',
    })
    expect(machine.state.phase).toBe('plain')
    expect(machine.state.claim).toBeUndefined()
    expect(effectsOfType(effects, 'commit-draft')[0]!.retainSuffixOf).toBe('/plan go')
  })

  it('成功且带 outcome.text ⇒ 追加一条 notice，severity 跟随 kind', () => {
    const machine = new SubmitMachine()
    const attempt = toSubmitting(machine)
    const okEffects = machine.dispatch({
      type: 'submit-settled',
      attempt,
      ok: true,
      draft: '/plan go',
      outcome: { kind: 'success', text: 'done' },
    })
    expect(okEffectsOf(okEffects, 'info')).toBe('done')

    const machine2 = new SubmitMachine()
    const attempt2 = toSubmitting(machine2)
    const errEffects = machine2.dispatch({
      type: 'submit-settled',
      attempt: attempt2,
      ok: true,
      draft: '/plan go',
      outcome: { kind: 'error', text: 'bad' },
    })
    expect(okEffectsOf(errEffects, 'error')).toBe('bad')
  })

  it('失败但草稿未变且仍以 token 开头 ⇒ 留在 claimed（可直接重试）', () => {
    const machine = new SubmitMachine()
    const attempt = toSubmitting(machine)
    machine.dispatch({ type: 'submit-settled', attempt, ok: false, draft: '/plan go', message: '网络' })
    expect(machine.state.phase).toBe('claimed')
    expect(machine.state.claim?.token).toBe('/plan')
  })

  it('失败且草稿已被改写 ⇒ 彻底回 plain（claim 不复活）', () => {
    const machine = new SubmitMachine()
    const attempt = toSubmitting(machine)
    machine.dispatch({ type: 'submit-settled', attempt, ok: false, draft: '/plan 改了', message: 'x' })
    expect(machine.state.phase).toBe('plain')
    expect(machine.state.claim).toBeUndefined()
  })

  it('过期的 submit-settled 不改变相位 —— 反洗', () => {
    const machine = new SubmitMachine()
    const attempt = toSubmitting(machine)
    machine.dispatch({
      type: 'submit-settled',
      attempt: { ...attempt, seq: attempt.seq + 1 },
      ok: true,
      draft: '/plan go',
    })
    expect(machine.state.phase).toBe('submitting')
  })

  it('sink-settled 只认分离槽里的 attempt；重复结算被忽略', () => {
    const machine = new SubmitMachine()
    const attempt = enterPlain(machine, 'hi')
    const first = machine.dispatch({
      type: 'sink-settled',
      attempt,
      ok: true,
      outcome: { kind: 'success', text: 'ok' },
    })
    expect(okEffectsOf(first, 'info')).toBe('ok')
    // 第二次同一 attempt：已从分离槽移除 ⇒ 零效果（不会重复弹 notice）
    expect(machine.dispatch({ type: 'sink-settled', attempt, ok: true, outcome: { kind: 'success', text: 'ok' } })).toEqual([])
  })

  it('sink-settled 的 severity：ok 且非 error ⇒ info，否则 error', () => {
    const m1 = new SubmitMachine()
    const a1 = enterPlain(m1, 'hi')
    expect(okEffectsOf(m1.dispatch({ type: 'sink-settled', attempt: a1, ok: true, message: 'm' }), 'info')).toBe('m')

    const m2 = new SubmitMachine()
    const a2 = enterPlain(m2, 'hi')
    expect(okEffectsOf(m2.dispatch({ type: 'sink-settled', attempt: a2, ok: false, message: 'm' }), 'error')).toBe('m')

    const m3 = new SubmitMachine()
    const a3 = enterPlain(m3, 'hi')
    const effects = m3.dispatch({
      type: 'sink-settled',
      attempt: a3,
      ok: true,
      outcome: { kind: 'error', text: 'err' },
    })
    expect(okEffectsOf(effects, 'error')).toBe('err')
  })
})

describe('SubmitMachine · send-committed 与 release', () => {
  it('send-committed 只在 plain 相位清空草稿（attachment-only 发送）', () => {
    const machine = new SubmitMachine()
    const effects = machine.dispatch({ type: 'send-committed' })
    expect(effects).toEqual([{ type: 'commit-draft', retainSuffixOf: null }])

    const busy = new SubmitMachine()
    busy.dispatch({ type: 'claim', claim: claimOf('/plan') })
    busy.dispatch({ type: 'enter', mode: 'queue', draft: '/plan' })
    expect(busy.dispatch({ type: 'send-committed' })).toEqual([])
  })

  it('release 中止在飞的冻结槽与全部 detached 槽，并回 plain', () => {
    const machine = new SubmitMachine()
    // 分离槽先攒两条（普通消息），再进冻结槽 —— detached 槽是跨相位累积的。
    const detachedA = enterPlain(machine, 'one')
    const detachedB = enterPlain(machine, 'two')
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    const frozen = effectsOfType(machine.dispatch({ type: 'enter', mode: 'queue', draft: '/plan' }), 'begin-submit')[0]!.attempt

    expect(machine.dispatch({ type: 'release' })).toEqual([])
    expect(frozen.signal.aborted).toBe(true)
    expect(detachedA.signal.aborted).toBe(true)
    expect(detachedB.signal.aborted).toBe(true)
    expect(machine.state.phase).toBe('plain')
    expect(machine.state.claim).toBeUndefined()
  })

  it('release 之后已结算的 attempt 不再被二次中止（所有权随结算转移）', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    const frozen = effectsOfType(machine.dispatch({ type: 'enter', mode: 'queue', draft: '/plan' }), 'begin-submit')[0]!.attempt
    machine.dispatch({ type: 'submit-settled', attempt: frozen, ok: true, draft: '/plan' })
    machine.dispatch({ type: 'release' })
    // 契约事实：结算即交出所有权；release 只中止仍归机器所有的 attempt。
    expect(frozen.signal.aborted).toBe(false)
  })

  it('release 后过期 attempt 的结算不会再产生 notice', () => {
    const machine = new SubmitMachine()
    machine.dispatch({ type: 'claim', claim: claimOf('/plan') })
    const attempt = effectsOfType(machine.dispatch({ type: 'enter', mode: 'queue', draft: '/plan' }), 'begin-submit')[0]!.attempt
    machine.dispatch({ type: 'release' })
    expect(machine.dispatch({
      type: 'submit-settled',
      attempt,
      ok: true,
      draft: '/plan',
      outcome: { kind: 'success', text: 'late' },
    })).toEqual([])
  })
})

describe('SubmitMachine · attempt 序号单调', () => {
  it('每次铸 attempt 都拿到递增且唯一的 seq', () => {
    const machine = new SubmitMachine()
    const a = enterPlain(machine, 'one')
    const b = enterPlain(machine, 'two')
    expect(a.seq).toBeGreaterThan(0)
    expect(b.seq).toBe(a.seq + 1)
    expect(a.signal).not.toBe(b.signal)
  })

  it('draftSnapshot 是 Enter 时的草稿原文', () => {
    const machine = new SubmitMachine()
    const attempt = enterPlain(machine, '  keep  spacing ')
    expect(attempt.draftSnapshot).toBe('  keep  spacing ')
  })
})

/** 取某 severity 的 notice 文本（无则 undefined）。 */
function okEffectsOf(effects: readonly InputEffect[], level: 'info' | 'error'): string | undefined {
  return effectsOfType(effects, 'notice').find(n => n.level === level)?.text
}
