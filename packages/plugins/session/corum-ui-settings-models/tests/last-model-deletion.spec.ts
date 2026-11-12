/**
 * 「删除供应商的最后一个模型」必须连供应商一起删，绝不写空 `models`。
 *
 * ## 事故（用户 2026-11 实测，MY-MAC 供应商）
 *
 * 在详情页删掉了该供应商唯一的模型，界面报：
 *
 * ```
 * llm-pi-ai: provider "mac" resolves no models; the installed catalog does not describe
 * this route, so its models must be listed in configuration
 * ```
 *
 * 真因不是「删除失败」，而是**删除之后留下了一个空供应商**：详情页把 `models: []` 写进
 * settings，而官方 `dsh-llm-pi-ai` 在「已安装目录里没有该 provider、配置里又没列模型」时
 * 直接判非法（`lib/index.js` 的 `entries.length === 0` 分支）。于是用户看到的是适配器的
 * 校验文案，模型也删不掉。
 *
 * ## 用户裁定
 *
 * 「弹确认：这会删掉整个供应商（推荐）」—— 确认后连供应商一起删；取消则一个都不动。
 *
 * ## 本文件钉住
 *
 * 1. 还剩 ≥1 个模型 ⇒ 只写 `models` 数组（一个 `set` op），`removesProvider === false`；
 * 2. 删到 0 个 ⇒ **一个 `unset` op 打在整个 provider 节上**，`removesProvider === true`，
 *    **不出现**任何 `set models` 的 op（这条是事故的形态本身）；
 * 3. 组件确实走这条纯函数，且「最后一个」时弹窗文案点明「会连供应商一起删掉」。
 *
 * @module @corum/corum-ui-settings-models/tests/last-model-deletion
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planModelDeletion } from '../src/client/store.ts'

const DETAIL = readFileSync(join(import.meta.dirname, '../src/client/ProviderDetailView.tsx'), 'utf8')

/** 一个自定义供应商的两条模型（provider id = `mac`，与报障现场一致）。 */
const MODELS = [
  { id: 'm-one', name: 'Model one' },
  { id: 'm-two', name: 'Model two' },
]

describe('planModelDeletion —— 只剩一个模型时删整个供应商', () => {
  it('★ 删到 0 个 ⇒ unset 整个 provider 节（绝不写空 models）', () => {
    const plan = planModelDeletion({ settingsPath: ['providers', 'mac'], models: MODELS.slice(0, 1), modelId: 'm-one' })
    expect(plan.removesProvider).toBe(true)
    expect(plan.remaining).toEqual([])
    expect(plan.ops).toEqual([{ op: 'unset', path: ['providers', 'mac'] }])
    // 事故形态：任何 `set …/models` 的 op 都不允许出现。
    expect(plan.ops.some(op => op.op === 'set')).toBe(false)
  })

  it('还剩 ≥1 个 ⇒ 只写 models 数组，不动 provider 节', () => {
    const plan = planModelDeletion({ settingsPath: ['providers', 'mac'], models: MODELS, modelId: 'm-one' })
    expect(plan.removesProvider).toBe(false)
    expect(plan.remaining).toEqual([{ id: 'm-two', name: 'Model two' }])
    expect(plan.ops).toHaveLength(1)
    expect(plan.ops[0]).toMatchObject({ op: 'set', path: ['providers', 'mac', 'models'] })
  })

  it('models 值不是数组（老/坏配置）⇒ 按「没有模型」处理，仍然删供应商', () => {
    const plan = planModelDeletion({ settingsPath: ['providers', 'mac'], models: undefined, modelId: 'whatever' })
    expect(plan.removesProvider).toBe(true)
    expect(plan.ops).toEqual([{ op: 'unset', path: ['providers', 'mac'] }])
  })

  it('不修改入参数组（纯函数：调用方的快照不被污染）', () => {
    const models = MODELS.map(model => ({ ...model }))
    planModelDeletion({ settingsPath: ['providers', 'mac'], models, modelId: 'm-one' })
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({ id: 'm-one', name: 'Model one' })
  })
})

describe('ProviderDetailView —— 接线与文案', () => {
  it('★ 删除走 planModelDeletion（不再自己拼 models 数组）', () => {
    expect(DETAIL).toContain('planModelDeletion({')
    // 事故形态：组件里不该再出现「把 models 数组直接喂给 mutate」的旧写法。
    expect(DETAIL).not.toContain("{ op: 'set', path: [...provider.settingsPath, 'models']")
  })

  it('★ 最后一个模型的确认弹窗说明「会连整个供应商一起删掉」', () => {
    expect(DETAIL).toContain('这是最后一个模型')
    expect(DETAIL).toContain('会连整个供应商')
    expect(DETAIL).toContain('删除供应商')
    // 普通删除仍保留原文案（两条路径都要在，不能只剩一条）。
    expect(DETAIL).toContain('删除模型')
  })

  it('「是不是最后一个」的判据是当前 models 条数 ≤ 1（不是「点了一次就算」）', () => {
    expect(DETAIL).toContain('modelCountOf() <= 1')
  })

  it('★ 删掉整个供应商后自动回到供应商列表（不留在已不存在的详情页上）', () => {
    // 用户 2026-11 实测：删除成功后界面仍停在被删供应商上，要手动「返回」才看到列表。
    expect(DETAIL).toContain('if (plan.removesProvider) onBack()')
  })
})
