/**
 * 子 Agent 模型**三档解析**的行为测试（`child-model-resolution.ts`）。
 *
 * ## 为什么是行为测试而不是源码扫描
 *
 * 本仓既有的 `model-policy.spec.ts` 用 `expect(SRC).toContain(...)` 对账（钉「代码长什么样」）。
 * 那条路对**行为**缺陷是盲的：本轮真正修掉的两个缺陷（哨兵被全局档接管、预设没配时删键
 * 成空操作 ⇒ 无限弹面板）都是行为错，任何源码断言都拦不住。这里用真实组合逐档断言，
 * 将来重构只要行为不变就不会假红，行为变了则必红。
 *
 * ## 用户口径（2026-10-11）
 *
 * 「全局未设置子 Agent 的 LLM 模型、只设置主 Agent 的 LLM 模型的情况下，**即无论如何都
 * 未设置子 Agent 模型时才跟随主 Agent**」——这是**三档**，推翻 2026-09-18 的「始终两档」。
 */
import { describe, expect, it } from 'vitest'
import { FOLLOW_MAIN, resolveChildModel, type ChildModelRoute } from '../src/child-model-resolution.ts'

const A: ChildModelRoute = { provider: 'p-a', model: 'm-a' }
const B: ChildModelRoute = { provider: 'p-b', model: 'm-b' }
const G: ChildModelRoute = { provider: 'p-global', model: 'm-global' }
const GR: ChildModelRoute = { provider: 'p-global-r', model: 'm-global-r' }

/** 便捷构造：默认全部为空（= 什么都没配 ⇒ 跟随主 Agent）。 */
function resolve(over: Partial<Parameters<typeof resolveChildModel>[0]> = {}) {
  return resolveChildModel({
    role: 'worker',
    sessionOverride: undefined,
    presetModel: undefined,
    presetFollowsMain: false,
    global: {},
    ...over,
  })
}

describe('resolveChildModel — 三档优先级', () => {
  it('① 预设配了 ⇒ 用预设（不碰全局）', () => {
    const r = resolve({ presetModel: A, global: { defaultModel: G } })
    expect(r).toEqual({ route: A, tier: 'preset' })
  })

  it('★★ ② 预设没配 + 全局配了 ⇒ 用全局（这是本轮新增的那一档）', () => {
    const r = resolve({ presetModel: undefined, global: { defaultModel: G } })
    expect(r).toEqual({ route: G, tier: 'global' })
  })

  it('★ ③ 预设没配 + 全局也没配 ⇒ 跟随主 Agent（用户措辞的「无论如何都没设」）', () => {
    const r = resolve({ presetModel: undefined, global: {} })
    expect(r).toEqual({ route: undefined, tier: 'follow-main' })
  })

  it('会话级覆盖优先于预设与全局', () => {
    const r = resolve({ sessionOverride: B, presetModel: A, global: { defaultModel: G } })
    expect(r).toEqual({ route: B, tier: 'session-override' })
  })
})

describe('resolveChildModel — 显式跟随主 Agent（哨兵）', () => {
  it('★★ 会话级哨兵 ⇒ 跳过全局档，直接跟随主 Agent', () => {
    const r = resolve({ sessionOverride: FOLLOW_MAIN, global: { defaultModel: G } })
    expect(r).toEqual({ route: undefined, tier: 'follow-main' })
  })

  it('★★ 预设哨兵 ⇒ 跳过全局档（这是「永久跟随主 Agent」在预设侧的等价物）', () => {
    const r = resolve({ presetFollowsMain: true, presetModel: undefined, global: { defaultModel: G } })
    expect(r).toEqual({ route: undefined, tier: 'follow-main' })
  })

  it('★★ 「不覆盖」与「显式跟随」结果必须不同（旧行为下两者同形 ⇒ 哨兵失效）', () => {
    // 同一个全局配置下：
    const notOverridden = resolve({ presetModel: undefined, presetFollowsMain: false, global: { defaultModel: G } })
    const followsMain = resolve({ presetModel: undefined, presetFollowsMain: true, global: { defaultModel: G } })
    // 前者被全局档接管，后者不被 —— 若两者相同，说明哨兵被拍平成了"不覆盖"（本次修的缺陷）。
    expect(notOverridden.tier).toBe('global')
    expect(followsMain.tier).toBe('follow-main')
    expect(notOverridden).not.toEqual(followsMain)
  })

  it('哨兵优先于预设的具体路由（会话级压过预设）', () => {
    const r = resolve({ sessionOverride: FOLLOW_MAIN, presetModel: A })
    expect(r).toEqual({ route: undefined, tier: 'follow-main' })
  })
})

describe('resolveChildModel — research 的回落链', () => {
  it('research 优先 defaultResearchModel', () => {
    const r = resolve({ role: 'research', global: { defaultModel: G, defaultResearchModel: GR } })
    expect(r).toEqual({ route: GR, tier: 'global' })
  })

  it('★ research 未单独配 ⇒ 回落 defaultModel（与预设侧 `researchModel ?? subagentModel` 对称）', () => {
    const r = resolve({ role: 'research', global: { defaultModel: G } })
    expect(r).toEqual({ route: G, tier: 'global' })
  })

  it('worker 不读 defaultResearchModel（角色隔离）', () => {
    const r = resolve({ role: 'worker', global: { defaultResearchModel: GR } })
    expect(r).toEqual({ route: undefined, tier: 'follow-main' })
  })
})

describe('resolveChildModel — 空值/脏值不算配置', () => {
  it('全局里 provider/model 为空串 ⇒ 视为没配（落到跟随主 Agent）', () => {
    const r = resolve({ global: { defaultModel: { provider: '', model: '' } } })
    expect(r).toEqual({ route: undefined, tier: 'follow-main' })
  })

  it('全局 research 项脏 ⇒ 继续回落 worker 项（不是直接放弃）', () => {
    const r = resolve({
      role: 'research',
      global: { defaultResearchModel: { provider: 'p', model: '' }, defaultModel: G },
    })
    expect(r).toEqual({ route: G, tier: 'global' })
  })

  it('预设脏值 ⇒ 不当作预设锁面（继续走全局）', () => {
    const r = resolve({ presetModel: { provider: '', model: '' }, global: { defaultModel: G } })
    expect(r).toEqual({ route: G, tier: 'global' })
  })

  it('reasoningEffort 原样带过', () => {
    const withEffort: ChildModelRoute = { provider: 'p', model: 'm', reasoningEffort: 'high' }
    expect(resolve({ presetModel: withEffort }).route).toEqual(withEffort)
  })
})
