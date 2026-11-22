/**
 * 「模型设置的默认思考档要在各处选择器上自动展示」——issue #236 第二条回归网
 *（2026-11-22 用户报障 + 官方源码取证）。
 *
 * ## 缺陷本体
 *
 * pi-ai 族的默认档此前只写**模型级** `reasoning`。而官方 `dsh-llm-pi-ai` 的
 * `modelInfo()` 读的是 **profile（路由）那一层**：
 *
 *     const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
 *
 * `session/modelCatalog` 的 `reasoning.defaultEffort` 就出自它。于是只写模型级时
 * 配置页能回显、catalog 却给不出默认档 ⇒ 新建任务表单 / Agent 预设 / composer 的
 * 模型菜单全都只显示「default」，用户设的档位哪都不生效。
 *
 * 修法是同一次 mutate 里补一条路由级 `providers.<route>.reasoning`。本文件钉住
 * 该映射的三个边界（`routeReasoningOp`）。
 */
import { describe, expect, it } from 'vitest'
import { KNOWN_LEVELS, piAiThinkingWrite, routeReasoningOp } from '../src/client/reasoning.ts'

const ROUTE = ['providers', 'localhost'] as const

describe('routeReasoningOp — 默认档到路由级的映射', () => {
  it('有非 off 默认档 ⇒ set 到 <route>.reasoning（catalog 才会给 defaultEffort）', () => {
    const written = piAiThinkingWrite(['off', 'low', 'high'], 'high')
    expect(routeReasoningOp(written, ROUTE)).toEqual({
      op: 'set',
      path: ['providers', 'localhost', 'reasoning'],
      value: 'high',
    })
  })

  it('默认档是 off ⇒ unset（不替用户选中任何档，交回 provider 默认）', () => {
    const written = piAiThinkingWrite(['off', 'low', 'high'], 'off')
    expect(written.defaultLevel).toBe('')
    expect(routeReasoningOp(written, ROUTE)).toEqual({
      op: 'unset',
      path: ['providers', 'localhost', 'reasoning'],
    })
  })

  it('显式「非推理模型」（efforts === false）⇒ unset（给路由挂档位自相矛盾）', () => {
    const written = piAiThinkingWrite([], '')
    expect(written.efforts).toBe(false)
    expect(routeReasoningOp(written, ROUTE)).toEqual({
      op: 'unset',
      path: ['providers', 'localhost', 'reasoning'],
    })
  })

  it('档位不在 pi-ai 键域内 ⇒ unset（路由级校验更严，写进去会让整段失效）', () => {
    // 手造成「默认档是个历史自定义 id」的形态：绕过 piAiThinkingWrite 的归一。
    const op = routeReasoningOp({ efforts: { high: 'high' }, defaultLevel: 'ultra' }, ROUTE)
    expect(op).toEqual({ op: 'unset', path: ['providers', 'localhost', 'reasoning'] })
  })

  it('路由路径按原样展开（自定义 route 与内置同构）', () => {
    const written = piAiThinkingWrite(['low', 'max'], 'max')
    expect(routeReasoningOp(written, ['providers', 'my-gateway']).path)
      .toEqual(['providers', 'my-gateway', 'reasoning'])
  })

  it('set 的值必定落在 KNOWN_LEVELS 内（与 pi-ai 的 z.union 同域）', () => {
    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const written = piAiThinkingWrite([level], level)
      const op = routeReasoningOp(written, ROUTE)
      expect(op.op).toBe('set')
      expect(KNOWN_LEVELS).toContain(level)
    }
  })
})
