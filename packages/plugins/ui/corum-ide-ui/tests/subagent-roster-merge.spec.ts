/**
 * 花名册条目合并规则（2026-10-09 缺口 B 收口）。
 *
 * 用户报障的原话：「subagent-card 这个如果当前任务结束 done了，主 Agent 又派发了消息，
 * 那么这个卡片需要更新并重新出现在会话流中」。主链路（卡片原卡原地翻回 Running）已正确，
 * 但 `session-bar` 花名册的合并是 `{...prev, ...patch}` —— 帧没带的键**继承旧值**，
 * 于是 `stopReason` 永不清除：子会话被重新唤醒后，花名册行与会话条胶囊恒显示「已完成」。
 *
 * 本 spec 钉死「清除语义只作用于那一种组合」，同时证明其余字段仍按「缺省继承」。
 */
import { describe, expect, it } from 'vitest'
import { mergeRosterEntry, type SubagentRosterEntry } from '../src/client/subagent-roster-merge.ts'

const terminal: SubagentRosterEntry = {
  childSessionId: 'child-1',
  label: '侦察 X',
  step: 9,
  done: true,
  stopReason: 'completed',
  lastActive: 1000,
  role: 'research',
  model: { provider: 'localhost', model: 'glm-5.2' },
  isolated: true,
}

describe('mergeRosterEntry — 缺省继承', () => {
  it('帧没带的字段继承旧值（label/role/model 不被抹掉）', () => {
    const next = mergeRosterEntry(terminal, { done: true, step: 10 })
    expect(next.label).toBe('侦察 X')
    expect(next.role).toBe('research')
    expect(next.model).toEqual({ provider: 'localhost', model: 'glm-5.2' })
    expect(next.isolated).toBe(true)
    expect(next.step).toBe(10)
  })

  it('终态帧重复到达（done:true 且无原因）⇒ 保留旧 stopReason', () => {
    const next = mergeRosterEntry(terminal, { done: true, step: 10 })
    expect(next.stopReason).toBe('completed')
  })

  it('新的 stopReason 覆盖旧值', () => {
    const next = mergeRosterEntry(terminal, { done: true, stopReason: 'aborted' })
    expect(next.stopReason).toBe('aborted')
  })
})

describe('mergeRosterEntry — 清除语义（缺口 B）', () => {
  it('done:false 且无 stopReason ⇒ **删除**旧 stopReason（翻回运行中）', () => {
    const next = mergeRosterEntry(terminal, { done: false, step: 1 })
    expect(next.done).toBe(false)
    expect(next.stopReason).toBeUndefined()
    expect('stopReason' in next).toBe(false) // 是删键，不是置 undefined
  })

  it('清除只针对 stopReason：其余字段仍继承', () => {
    const next = mergeRosterEntry(terminal, { done: false, step: 1 })
    expect(next.label).toBe('侦察 X')
    expect(next.role).toBe('research')
    expect(next.model).toEqual({ provider: 'localhost', model: 'glm-5.2' })
  })

  it('帧同时给出 done:false 与新原因 ⇒ 以帧为准（不清除，写成新原因）', () => {
    const next = mergeRosterEntry(terminal, { done: false, stopReason: 'error' })
    expect(next.stopReason).toBe('error')
  })

  it('不修改入参（纯函数）', () => {
    const before = { ...terminal }
    mergeRosterEntry(terminal, { done: false })
    expect(terminal).toEqual(before)
  })
})
