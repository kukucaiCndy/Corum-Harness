import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { corumModelAskOptions, corumResolveModelAskDecision } from '../src/model-ask.ts'
import { corumAskAboutModelFailure, corumAskAboutModelOnce, corumAskAboutModelUnlessStale, corumResetModelAskLocks } from '../src/model-ask-run.ts'

const facts = { label: 'task', configured: { provider: 'p', model: 'broken' }, fallback: { provider: 'p', model: 'main' }, cause: 'unavailable', role: 'worker' as const }
afterEach(() => { corumResetModelAskLocks() })

describe('模型不可用四档处理', () => {
  it('不同候选模型并发失败各自重试原模型，不共用另一候选的路由', async () => {
    let calls = 0
    const deps = {
      state: { modelOverrideOf: () => undefined, setModelOverride: () => {}, clearModelOverride: () => {} },
      channel: { call: async () => { calls += 1; return { kind: 'retry' as const } } },
    }
    const parent = { session: { id: 'session' } } as unknown as Agent
    const [first, second] = await Promise.all([
      corumAskAboutModelOnce(deps, parent, facts, new AbortController().signal, { warn: () => {} }),
      corumAskAboutModelOnce(deps, parent, { ...facts, configured: { provider: 'p', model: 'other-broken' } }, new AbortController().signal, { warn: () => {} }),
    ])
    expect(calls).toBe(2)
    expect(first.override).toEqual({ provider: 'p', model: 'broken' })
    expect(second.override).toEqual({ provider: 'p', model: 'other-broken' })
  })

  it('显式候选失败不被不同的角色默认覆盖误判为陈旧', async () => {
    let calls = 0
    const explicitFacts = { ...facts, explicitModelSelection: true }
    const result = await corumAskAboutModelUnlessStale({
      state: { modelOverrideOf: () => ({ provider: 'p', model: 'saved-default' }), setModelOverride: () => {}, clearModelOverride: () => {} },
      channel: { call: async () => { calls += 1; return { kind: 'retry' } } },
    }, { session: { id: 'session' } } as unknown as Agent, explicitFacts, new AbortController().signal, { warn: () => {} })
    expect(calls).toBe(1)
    expect(result.override).toEqual(facts.configured)
  })

  it('只下发临时指定、永久指定、重试、取消四个可见选项', () => {
    expect(corumModelAskOptions().map(option => option.kind)).toEqual(['temporary', 'permanent-route', 'retry', 'decline'])
  })

  it('取消当前候选委派不清除既有永久模型的会话覆盖', async () => {
    const writes: unknown[] = []
    const result = await corumAskAboutModelFailure({
      state: { modelOverrideOf: () => ({ provider: 'p', model: 'saved' }), setModelOverride: (...args) => { writes.push(args) }, clearModelOverride: () => { writes.push('clear') } },
      channel: { call: async () => ({ kind: 'decline' }) },
    }, { session: { id: 'session' } } as unknown as Agent, facts, new AbortController().signal, { warn: () => {} })
    expect(result.override).toBeUndefined()
    expect(writes).toEqual([])
  })

  it('临时选择可用任意指定模型，且缺路由时保留旧主模型行为', () => {
    expect(corumResolveModelAskDecision('temporary', facts.fallback, { provider: 'other', model: 'fast' }))
      .toEqual({ kind: 'temporary', route: { provider: 'other', model: 'fast' } })
    expect(corumResolveModelAskDecision('temporary', facts.fallback, undefined))
      .toEqual({ kind: 'temporary', route: facts.fallback })
  })

  it.each(['temporary', 'retry'])('%s 仅返回本次重跑路由，不写 settings 或会话覆盖', async (kind) => {
    const writes: unknown[] = []
    const result = await corumAskAboutModelFailure({
      state: { modelOverrideOf: () => undefined, setModelOverride: (...args) => { writes.push(args) }, clearModelOverride: () => { writes.push('clear') } },
      channel: { call: async () => ({ kind, route: { provider: 'other', model: 'fast' } } as never) },
      profile: { applySubagentModelForSession: (...args) => { writes.push(args); return { presetId: 'test', applied: undefined } } },
    }, { session: { id: 'session' } } as unknown as Agent, facts, new AbortController().signal, { warn: () => {} })
    expect(result.override).toEqual(kind === 'retry' ? facts.configured : { provider: 'other', model: 'fast' })
    expect(result.persisted).toBe(false)
    expect(writes).toEqual([])
  })

  it('永久选择允许当前主模型，以具体路由写入正确角色', async () => {
    const writes: unknown[] = []
    const result = await corumAskAboutModelFailure({
      state: { modelOverrideOf: () => undefined, setModelOverride: (...args) => { writes.push(args) }, clearModelOverride: () => {} },
      channel: { call: async () => ({ kind: 'permanent-route', route: facts.fallback }) },
      profile: { applySubagentModelForSession: (...args) => { writes.push(args); return { presetId: 'test', applied: facts.fallback } } },
    }, { session: { id: 'session' } } as unknown as Agent, facts, new AbortController().signal, { warn: () => {} })
    expect(result.override).toEqual(facts.fallback)
    expect(result.persisted).toBe(true)
    expect(writes).toEqual([['session', 'worker', facts.fallback], ['session', facts.fallback, 'worker']])
  })
})
