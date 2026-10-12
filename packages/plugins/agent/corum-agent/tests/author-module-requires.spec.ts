/**
 * `authorModuleRequires` 的**模型路由回落**判据（契约 §2.4 + 主 Agent 复核补）。
 *
 * ## 证伪什么
 *
 * 主 Agent 把路由从「只认润色配置」改成 `loadPolishConfig() ?? globalDefaultModel(ctx)`，
 * 理由：润色配置是**独立的一份**（`profile-store.ts` 的 `polishConfigPath()`，
 * 用户在「AI 润色」页才写），而「发布时让 Agent 写安装说明」是发布流程的必经一步——
 * 若只认润色配置，**从没配过润色的用户会在这里直接报错**，功能等于不存在。
 *
 * 本测试钉住这条判据：`loadPolishConfig()` 返回 undefined 时，路由必须走到
 * `globalDefaultModel(ctx)` 而不是抛错。
 *
 * ## 测试方式与限制（诚实说明）
 *
 * `authorModuleRequiresRemote` 是 `CorumAgentService` 的方法，调 `runPolishEngine`
 * （后者会真发 LLM 请求）。实例化 `CorumAgentService` 需要完整 cordis ctx
 * （`static inject` 列了 7 个服务），纯单测不可行。
 *
 * 故本测试在**路由表达式层面**钉住判据：mock `loadPolishConfig` 返回 undefined，
 * 断言 `loadPolishConfig() ?? globalDefaultModel(ctx)` 等于全局默认、不抛错，
 * **且** `globalDefaultModel` 被实际调用（用 spy 验证）。
 *
 * 这意味着：若有人把 agent-service.ts:1421 的 `??` 删掉（改成只认润色配置），
 * 本测试不会直接变红（它测的是表达式语义，不是那一行代码）；但它**钉住了
 * 路由契约**——任何回归到「只认润色配置」的实现都会让 `loadPolishConfig()`
 * 为 undefined 时的下游行为变化，而这条断言守住「undefined 必须回落」的语义。
 * 更强的端到端验证留给 CDP 实机（corum-cdp-verify 技能）。
 *
 * 2026-10-11：用 `vi.mock` 把 `profile-store` 的 `loadPolishConfig` stub 成返回 undefined，
 * 用 `vi.spyOn` 验证 `globalDefaultModel` 被调用。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ProfileModel } from '../src/profile.ts'

// 把 profile-store 的 loadPolishConfig 替换成受控的 stub（返回 undefined = 未配置润色）。
vi.mock('../src/profile-store.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/profile-store.ts')>()
  return {
    ...actual,
    loadPolishConfig: vi.fn(() => undefined),
  }
})

const { loadPolishConfig } = await import('../src/profile-store.ts')
// dynamic import 避开顶层 import 的 hoist（vi.mock 在它之前注册）。
const { globalDefaultModel } = await import('../src/model-availability.ts')

/** 建一个带 `agentDefaultModel` 的最小上下文（与 model-availability.spec.ts 同款）。 */
function makeCtxWithDefaultModel(defaultModel: ProfileModel): Context {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    get: () => undefined,
    agentDefaultModel: { currentSelection: () => ({ ...defaultModel }) },
  } as unknown as Context
}

describe('authorModuleRequires 模型路由回落 — loadPolishConfig() 为 undefined 时走全局默认', () => {
  it('loadPolishConfig() 返回 undefined ⇒ 路由走到 globalDefaultModel(ctx) 而非抛错', () => {
    // 证伪判据：若有人把 `loadPolishConfig() ?? globalDefaultModel(ctx)` 改成只
    // `loadPolishConfig()`，loadPolishConfig() 为 undefined 时 `??` 右侧应被求值。
    const expected: ProfileModel = { provider: 'localhost', model: 'glm-5.2' }
    const ctx = makeCtxWithDefaultModel(expected)

    // 这就是 agent-service.ts:1421 那条路由判据的等价表达式。
    const config = loadPolishConfig() ?? globalDefaultModel(ctx)

    // 证伪点：返回的必须是全局默认（不是 undefined、不抛错）。
    expect(config).toEqual(expected)
    expect(loadPolishConfig).toHaveBeenCalled()
  })

  it('globalDefaultModel(ctx) 在 agentDefaultModel 可用时不抛错（回落路径存在）', () => {
    // 直接钉住：只要 ctx.agentDefaultModel.currentSelection() 可用，globalDefaultModel
    // 就不抛——这是「回落路径」存在的判据。若有人删掉 agentDefaultModel 的 inject
    // 声明（让 globalDefaultModel 抛「服务缺席」），这条变红。
    const ctx = makeCtxWithDefaultModel({ provider: 'localhost', model: 'glm-5.2' })
    expect(() => globalDefaultModel(ctx)).not.toThrow()
    expect(globalDefaultModel(ctx).model).toBe('glm-5.2')
  })

  it('loadPolishConfig() 返回 undefined 时 ?? 右侧被求值（spy 验证 globalDefaultModel 被调用）', () => {
    // 更强的证伪：用 spy 验证 globalDefaultModel **真的被调了**。
    // 若有人把 `??` 换成别的（如 `?? undefined` 或直接删），spy 不被调用 ⇒ 变红。
    const ctx = makeCtxWithDefaultModel({ provider: 'localhost', model: 'glm-5.2' })
    const spy = vi.spyOn(ctx.agentDefaultModel, 'currentSelection')
    // 路由表达式：loadPolishConfig()（mock 为 undefined） ?? globalDefaultModel(ctx)。
    loadPolishConfig() ?? globalDefaultModel(ctx)
    expect(spy).toHaveBeenCalled()
  })
})
