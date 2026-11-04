/**
 * corum-ui-model-ask 契约单测。
 *
 * 重点是**安全关键**的判定：错判会把用户的「不要」当成「要」，或者默默替用户挑一个
 * 模型。这些判定被抽成纯函数（modelAskAnswerOf / modelAskNeedsRoute）就是为了能在
 * 不起 UI 的前提下被直接钉住。
 */
import { describe, expect, it } from 'vitest'
import { modelAskAnswerOf, modelAskNeedsRoute } from '../src/client/contract.ts'

describe('modelAskNeedsRoute —— 只有「永久改指定模型」需要具体路由', () => {
  it('temporary 需要路由', () => {
    expect(modelAskNeedsRoute('temporary')).toBe(true)
  })

  it('permanent-route 需要路由', () => {
    expect(modelAskNeedsRoute('permanent-route')).toBe(true)
  })

  it('其余三档都不需要路由', () => {
    for (const kind of ['permanent-follow', 'retry', 'decline'] as const) {
      expect(modelAskNeedsRoute(kind), `${kind} 不该要求选模型`).toBe(false)
    }
  })

  it('未选档位时不需要路由（面板不展开模型选择）', () => {
    expect(modelAskNeedsRoute(undefined)).toBe(false)
  })
})

describe('modelAskAnswerOf —— UI 状态收敛成回传契约', () => {
  it('临时指定必须带回用户选择的模型', () => {
    expect(modelAskAnswerOf('temporary', { provider: 'other', model: 'fast' }))
      .toEqual({ kind: 'temporary', route: { provider: 'other', model: 'fast' } })
    expect(modelAskAnswerOf('temporary', undefined)).toEqual({ kind: 'dismissed' })
  })

  it('★ 选「永久改指定模型」但没选模型 ⇒ dismissed（绝不默默替用户挑一个）', () => {
    expect(modelAskAnswerOf('permanent-route', undefined)).toEqual({ kind: 'dismissed' })
  })

  it('选「永久改指定模型」且选了模型 ⇒ 带上路由', () => {
    expect(modelAskAnswerOf('permanent-route', { provider: 'p', model: 'm' }))
      .toEqual({ kind: 'permanent-route', route: { provider: 'p', model: 'm' } })
  })

  it('★ 其余三档原样回传 kind，且**不**携带 route', () => {
    for (const kind of ['permanent-follow', 'retry', 'decline'] as const) {
      const answer = modelAskAnswerOf(kind, undefined)
      expect(answer.kind).toBe(kind)
      // route 只属于 permanent-route 档；多带会让 host 的路由决定权被 client 旁路。
      expect(answer.route).toBeUndefined()
    }
  })

  it('★ 未选档位 ⇒ dismissed（用户没作答，机制按「不改变现状」处理）', () => {
    expect(modelAskAnswerOf(undefined, undefined)).toEqual({ kind: 'dismissed' })
  })

  it('★ 即使选了模型，未选档位仍是 dismissed（模型选择不构成作答）', () => {
    expect(modelAskAnswerOf(undefined, { provider: 'p', model: 'm' })).toEqual({ kind: 'dismissed' })
  })

  it('回传的 route 是快照，不与调用方共享引用', () => {
    const route = { provider: 'p', model: 'm' }
    const answer = modelAskAnswerOf('permanent-route', route)
    route.model = 'mutated'
    expect(answer.route?.model).toBe('m')
  })
})
