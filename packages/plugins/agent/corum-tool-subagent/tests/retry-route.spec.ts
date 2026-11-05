/**
 * 重跑路由装配的**行为测试**（`corumApplyRetryRoute`，`src/index.ts`）。
 *
 * ## 为什么必须补这一条（用户 2026-11-05 实机报障）
 *
 * 子 Agent 模型限流失败 ⇒ 用户选「**永久改指定模型**」并挑了一个模型。机制写预设 ✅、
 * 写会话级覆盖 ✅，但决定**这一次重跑**用什么路由的那一行是 `delete request.agentOptions`
 * —— 它把 `asked.route`（用户选的模型）一起扔掉 ⇒ 重跑退回主 Agent 模型。
 *
 * 实测证据（子会话 `9cc60d19` 的 `request/header`）：seq 12 `glm-5.2`（原模型，限流）
 * → seq 190 用户选 `glm-5.3-flash` → seq 217 重跑回到 `glm-5.2`。通知却写着
 * "its worker child-Agent model is now glm-5.3-flash" ⇒ **通知与现场不符**。
 *
 * ## 为什么这组断言是动作驱动而不是源码扫描
 *
 * `model-policy.spec.ts` 里已有源码级对账（钉「三处重跑都调了这个函数」）。那拦不住
 * **函数自己装配错**的情形——例如漏打 `agentOptionsOwnedByMechanism`，driver 的 P1 剥离
 * 会把机制路由再剥一次，用户体验与缺陷原状一模一样，而源码断言全绿。
 * 故这里直接调函数、断言它写进去的字段。
 *
 * @module @corum/corum-tool-subagent/tests/retry-route
 */

import { describe, expect, it } from 'vitest'
import { corumApplyRetryRoute } from '../src/index.ts'

/** 一次重跑请求的最小形态（只声明本函数会碰的两个字段）。 */
function requestOf(over: Record<string, unknown> = {}) {
  return {
    // 典型现场：角色锁已经把「坏模型」写进 agentOptions。
    agentOptions: { provider: 'localhost', model: 'glm-5.2', reasoningEffort: 'high' as const },
    ...over,
  } as Parameters<typeof corumApplyRetryRoute>[0]
}

describe('corumApplyRetryRoute — 把用户选定的路由装进重跑请求', () => {
  it('★ permanent-route：装的是**用户选的模型**，不是主 Agent 路由', () => {
    // 用户实机现场：配的是 glm-5.2（限流），他选永久改成 glm-5.3-flash。
    const request = requestOf()
    corumApplyRetryRoute(request, { provider: 'localhost', model: 'glm-5.3-flash' })
    // 缺陷形态是「被清成 undefined ⇒ 退回父路由」；正确形态是用户选的那条。
    expect(request.agentOptions).toEqual({ provider: 'localhost', model: 'glm-5.3-flash' })
  })

  it('★★ 必须打 agentOptionsOwnedByMechanism —— 否则 driver 的 P1 剥离会再剥一次', () => {
    const request = requestOf()
    corumApplyRetryRoute(request, { provider: 'localhost', model: 'glm-5.3-flash' })
    // 漏了这个标记，用户看到的与缺陷原状完全相同（模型又被换回主路由），
    // 而任何「有没有调这个函数」的源码断言都仍然是绿的。
    expect(request.agentOptionsOwnedByMechanism).toBe(true)
  })

  it('★ permanent-follow / temporary 的 route 就是主路由 ⇒ 装上它等价于旧的「清掉角色锁」', () => {
    const request = requestOf()
    corumApplyRetryRoute(request, { provider: 'tencentpay', model: 'kimi-k3.1-pro' })
    expect(request.agentOptions).toEqual({ provider: 'tencentpay', model: 'kimi-k3.1-pro' })
  })

  it('reasoningEffort：路由带了就带上，没带就不凭空补（避免改变用户选择之外的语义）', () => {
    const withEffort = requestOf()
    corumApplyRetryRoute(withEffort, { provider: 'p', model: 'm', reasoningEffort: 'low' })
    expect(withEffort.agentOptions).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'low' })

    const withoutEffort = requestOf()
    corumApplyRetryRoute(withoutEffort, { provider: 'p', model: 'm' })
    // 关键：不得残留角色锁里的 `reasoningEffort: 'high'`——那是**坏模型**的档位。
    expect(withoutEffort.agentOptions).toEqual({ provider: 'p', model: 'm' })
    expect(withoutEffort.agentOptions).not.toHaveProperty('reasoningEffort')
  })

  it('原地改写：装完不再是「角色锁的坏模型」（缺陷的直接判据）', () => {
    const request = requestOf()
    const before = { ...request.agentOptions }
    corumApplyRetryRoute(request, { provider: 'localhost', model: 'glm-5.3-flash' })
    expect(request.agentOptions?.model).not.toBe(before.model)
    expect(request.agentOptions?.model).toBe('glm-5.3-flash')
  })
})
