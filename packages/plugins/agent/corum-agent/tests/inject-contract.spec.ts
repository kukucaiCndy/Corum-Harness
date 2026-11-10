/**
 * `corumAgent/setDefaultPreset` 的**依赖装配契约**（2026-10-29 rc3 验收实测缺陷的回归网）。
 *
 * ## 缺陷现象（生产）
 *
 * ```
 * corumAgent/setDefaultPreset → {"code":"gateway/internal",
 *   "message":"cannot get property \"settings\" without inject"}
 * ```
 *
 * ## 根因
 *
 * `CorumAgentService` 的 `static inject` 里有 `settings`，但插件模块
 * （`src/index.ts`）的 `export const inject` 没有。`apply()` 是
 * **直接 `new CorumAgentService(ctx)`**，不是 `ctx.plugin(CorumAgentService)`：
 * 服务方法拿到的 `this.ctx` 是 apply 作用域的 ctx，它只按**模块 inject** 解析
 * 依赖 ⇒ `this.ctx.settings` 抛错 ⇒ 默认预设写整条通道不可用。
 *
 * 所以判据必须是**模块 inject ⊇ 服务 static inject**（本文件 ①），
 * 并用**真实 cordis 装配**证明模块 inject 足够解析出 `settings`（②）；
 * 服务层「写 → 落盘 → 重建读回」的持久化证据在 `default-preset.spec.ts`
 * 的持久化用例 + 隔离实机验收 P4/persist。
 *
 * @module @corum/corum-agent/tests/inject-contract
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CorumAgentService, inject, name } from '../src/index.ts'

/** 真实 cordis 装配里用的 settings 面（只要解析得到，不必实现语义）。 */
function settingsFace(): { update: () => Promise<void>; describe: () => readonly never[] } {
  return { update: async () => {}, describe: () => [] }
}

describe('模块 inject 装配契约', () => {
  afterEach(() => { /* 每个用例自建 root Context，无需清理 */ })

  it('① 模块 inject 覆盖服务 static inject（settings 必须在模块侧声明）', () => {
    const moduleInject = new Set(inject)
    const missing = CorumAgentService.inject.filter(dep => !moduleInject.has(dep))
    expect(missing, `模块 inject 缺少服务静态依赖：${missing.join(', ')}`).toEqual([])
    // 缺陷锚点：这一句在修复前必红（生产报错就是它）。
    expect(moduleInject.has('settings')).toBe(true)
  })

  it('② 真实 cordis 装配：模块 inject 足以解析出 settings（就是 RPC 作用域那条路径）', async () => {
    const root = new Context()
    const face = settingsFace()
    // 依次提供模块声明的依赖；settings 用真实面，其余只需「可解析」。
    for (const dep of inject) root.provide(dep, dep === 'settings' ? face : {})

    let resolved: unknown
    let failure: unknown
    root.plugin({
      name,
      inject,
      apply(scope: Context) {
        try {
          // 与 CorumAgentService 方法体内 `this.ctx.settings` 同一解析路径。
          resolved = scope.settings
        } catch (error) {
          failure = error
        }
      },
    })
    for (let i = 0; i < 50 && resolved === undefined && failure === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(failure).toBeUndefined()
    expect(resolved).toBe(face)
  })

  it('③ 反证：去掉 settings 的同款装配会抛 without inject（判据本身有效）', async () => {
    const root = new Context()
    const withoutSettings = inject.filter(dep => dep !== 'settings')
    for (const dep of withoutSettings) root.provide(dep, {})

    let failure: unknown
    root.plugin({
      name,
      inject: withoutSettings,
      apply(scope: Context) {
        try {
          void scope.settings
        } catch (error) {
          failure = error
        }
      },
    })
    for (let i = 0; i < 50 && failure === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(String(failure)).toMatch(/without inject/)
  })
})
