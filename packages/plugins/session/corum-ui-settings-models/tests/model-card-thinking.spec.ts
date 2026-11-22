/**
 * 「配置了思考档位，模型卡片却显示没有思考」——issue #236 第一条回归网
 *（2026-11-22 用户报障 + 可复现取证）。
 *
 * ## 缺陷本体
 *
 * pi-ai 族保存时，**默认档为 off 或未选**的形态会让代码 `delete next.reasoning`
 *（见 ModelConfigView 与 `piAiThinkingWrite`：off = 不指定 provider 默认档）。
 * 于是模型条目里只剩 `reasoningEfforts`（用户勾选的档位集合）。
 *
 * 旧 `readModel` 只看模型级单值字段（`reasoningEffort` / `reasoning`）⇒ 读不到 ⇒
 * `thinking: undefined` ⇒ `specsOf()` 不渲染「思考」⇒ 卡片看起来「没有思考」，
 * 而用户明明勾了 low/high/max。
 *
 * 修法：单值字段缺席时回退到 `reasoningEfforts` 里第一个非 off 档（仅用于显示，
 * 不参与请求派发——真正门控请求的是会话级 reasoningEffort 与路由级 reasoning）。
 */
import { describe, expect, it } from 'vitest'
import { readModel } from '../src/client/model-profile.ts'
import { specsOf } from '../src/client/model-cards.ts'
import type { SettingsSchemaOperations } from '../src/client/schema-operations.ts'

/** 极简 schema 操作替身：getPath 走真实对象路径（与官方语义一致）。 */
const schema = {
  getPath(value: unknown, path: readonly string[]): unknown {
    let cur: unknown = value
    for (const segment of path) {
      if (typeof cur !== 'object' || cur === null) return undefined
      cur = (cur as Record<string, unknown>)[segment]
    }
    return cur
  },
} as unknown as SettingsSchemaOperations

const PATH = ['providers', 'localhost'] as const

/** 造一个 provider namespace view。 */
const view = (models: unknown[]): never =>
  ({ value: { providers: { localhost: { models } } }, revision: 1 }) as never

describe('readModel — 思考能力判定（issue #236 第一条）', () => {
  it('只有 reasoningEfforts（无模型级单值）⇒ 仍判为支持思考（旧实现这里读不到）', () => {
    const d = readModel(schema, view([{
      id: 'glm-5.2',
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
    }]), PATH, 'glm-5.2')
    expect(d.thinking).toBe('low')
  })

  it('模型级 reasoning 优先于档位集合（用户显式选的默认档）', () => {
    const d = readModel(schema, view([{
      id: 'glm-5.2',
      reasoning: 'high',
      reasoningEfforts: { off: null, low: 'low', high: 'high' },
    }]), PATH, 'glm-5.2')
    expect(d.thinking).toBe('high')
  })

  it('deepseek 族的 reasoningEffort 同样优先', () => {
    const d = readModel(schema, view([{
      id: 'deepseek-v4',
      reasoningEffort: 'max',
      reasoningEfforts: { low: 'low' },
    }]), PATH, 'deepseek-v4')
    expect(d.thinking).toBe('max')
  })

  it('只声明 off ⇒ 不支持思考（不显示「思考」）', () => {
    const d = readModel(schema, view([{ id: 'plain', reasoningEfforts: { off: null } }]), PATH, 'plain')
    expect(d.thinking).toBeUndefined()
  })

  it('reasoningEfforts === false（显式非推理模型）⇒ 不支持思考', () => {
    const d = readModel(schema, view([{ id: 'nonthink', reasoningEfforts: false }]), PATH, 'nonthink')
    expect(d.thinking).toBeUndefined()
  })

  it('两个字段都没有 ⇒ 不支持思考（能力未知不冒充支持）', () => {
    const d = readModel(schema, view([{ id: 'bare' }]), PATH, 'bare')
    expect(d.thinking).toBeUndefined()
  })

  it('空档位集合 / 数组形态 ⇒ 不支持思考（形状不合法不当成支持）', () => {
    expect(readModel(schema, view([{ id: 'a', reasoningEfforts: {} }]), PATH, 'a').thinking).toBeUndefined()
    expect(readModel(schema, view([{ id: 'b', reasoningEfforts: ['high'] }]), PATH, 'b').thinking).toBeUndefined()
  })
})

describe('specsOf — 卡片摘要行（用户看到的「思考」字样）', () => {
  it('回退判定生效后，卡片摘要行出现「思考」', () => {
    const d = readModel(schema, view([{
      id: 'glm-5.2',
      contextWindow: 1000000,
      reasoningEfforts: { off: null, low: 'low', high: 'high' },
    }]), PATH, 'glm-5.2')
    const specs = specsOf({
      provider: 'localhost',
      modelId: 'glm-5.2',
      brand: undefined,
      providerName: 'Tencent',
      contextWindow: d.contextWindow,
      ...(d.thinking === undefined ? {} : { thinking: d.thinking }),
      imageInput: d.imageInput,
      settingsNs: 'llm-pi-ai',
      settingsPath: PATH,
      family: 'pi-ai',
    })
    expect(specs).toContain('思考')
    expect(specs).toContain('上下文 1M')
  })
})
