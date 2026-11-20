/**
 * corum-ui-model-ask 契约单测。
 *
 * 重点是**安全关键**的判定：错判会把用户的「不要」当成「要」，或者默默替用户挑一个
 * 模型。这些判定被抽成纯函数（modelAskAnswerOf / modelAskNeedsRoute）就是为了能在
 * 不起 UI 的前提下被直接钉住。
 */
import { describe, expect, it } from 'vitest'
import { modelAskAnswerOf, modelAskNeedsRoute, modelAskRequiresRoute } from '../src/client/contract.ts'

describe('modelAskNeedsRoute —— 只有「永久改指定模型」展开模型选择', () => {
  it('★ temporary 不展开（2026-11 用户裁定：临时档 = 与主 Agent 完全一致，一步应用）', () => {
    // 旧版（issue #166）让临时档也展开列表「可选指定模型」，用户实测反馈那看起来
    // 像「必须挑一个」，与档位名承诺不符 —— 改判后临时档不再给模型选择器。
    expect(modelAskNeedsRoute('temporary')).toBe(false)
  })

  it('permanent-route 展开', () => {
    expect(modelAskNeedsRoute('permanent-route')).toBe(true)
  })

  it('其余档（重试 / 临时 / 取消本次委派 / 旧名不重试）都不展开', () => {
    // 「重试」档的全部含义就是「不换模型」，给它一个模型选择器只会误导。
    for (const kind of ['retry', 'temporary', 'cancel', 'decline'] as const) {
      expect(modelAskNeedsRoute(kind), `${kind} 不该展开模型选择`).toBe(false)
    }
  })

  it('未选档位时不需要路由（面板不展开模型选择）', () => {
    expect(modelAskNeedsRoute(undefined)).toBe(false)
  })
})

describe('modelAskRequiresRoute —— 只有「永久改指定模型」必须选', () => {
  it('★ 只有「永久改指定模型」必须选（它的全部含义就是记住这条路由）', () => {
    expect(modelAskRequiresRoute('permanent-route')).toBe(true)
  })

  it('★ 其余档都不强制选模型（临时档 = 用主 Agent 模型，含其思考档）', () => {
    for (const kind of ['retry', 'temporary', 'cancel'] as const) {
      expect(modelAskRequiresRoute(kind), `${kind} 不该强制要求选模型`).toBe(false)
    }
    expect(modelAskRequiresRoute(undefined)).toBe(false)
  })
})

describe('modelAskAnswerOf —— UI 状态收敛成回传契约', () => {
  it('★ 选「永久改指定模型」但没选模型 ⇒ dismissed（绝不默默替用户挑一个）', () => {
    expect(modelAskAnswerOf('permanent-route', undefined)).toEqual({ kind: 'dismissed' })
  })

  it('选「永久改指定模型」且选了模型 ⇒ 带上路由', () => {
    expect(modelAskAnswerOf('permanent-route', { provider: 'p', model: 'm' }))
      .toEqual({ kind: 'permanent-route', route: { provider: 'p', model: 'm' } })
  })

  it('★ 选了思考档 ⇒ route 带上 reasoningEffort（2026-11 面板新增能力）', () => {
    expect(modelAskAnswerOf('permanent-route', { provider: 'p', model: 'm', reasoningEffort: 'high' }))
      .toEqual({ kind: 'permanent-route', route: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
  })

  it('★ 思考档选「默认」（undefined）⇒ route 不带 reasoningEffort 键（省略 = 模型自己的默认档）', () => {
    // 显式 undefined 键是防御形态（exactOptionalPropertyTypes 下调用方正常不会这么传）。
    const answer = modelAskAnswerOf('permanent-route', { provider: 'p', model: 'm', reasoningEffort: undefined } as unknown as { provider: string; model: string; reasoningEffort?: string })
    expect(answer.route).toEqual({ provider: 'p', model: 'm' })
    expect(Object.keys(answer.route ?? {})).not.toContain('reasoningEffort')
  })

  it('★ 选「临时」且选了模型 ⇒ 带上路由（合法性由 host 校验，client 如实回传）', () => {
    expect(modelAskAnswerOf('temporary', { provider: 'p', model: 'm' }))
      .toEqual({ kind: 'temporary', route: { provider: 'p', model: 'm' } })
  })

  it('★ 选「临时」但没选模型 ⇒ 不带 route（= 用主 Agent 模型，不是未作答）', () => {
    expect(modelAskAnswerOf('temporary', undefined)).toEqual({ kind: 'temporary' })
  })

  it('★ 其余档原样回传 kind，且**不**携带 route', () => {
    for (const kind of ['retry', 'cancel'] as const) {
      const answer = modelAskAnswerOf(kind, undefined)
      expect(answer.kind).toBe(kind)
      // route 只属于 temporary / permanent-route 两档。
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
