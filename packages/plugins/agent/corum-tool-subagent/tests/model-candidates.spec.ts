/**
 * issue #165：子 Agent 模型候选集（全局一份）+ 能力标注。
 *
 * 本 spec 钉三件**行为**事实（不是源码长相）：
 * 1. 老配置（没有 `tags`/`note`）照旧可读、可通过校验——新增字段完全向后兼容；
 * 2. `list_subagent_models` 对已配置候选的那条路径带出标注，没标注时输出与改动前逐字相同；
 * 3. 提示词段在候选为空时**不产出任何文本**（机制省略空段 ⇒ 模型看不到空候选表）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { listSubagentModels } from '../src/list-models.ts'
import { corumSubagentModelCandidatesSection, routeCandidateLine } from '../src/model-candidates.ts'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  type AllowedModelRoute,
  type ModelSelectionPolicy,
} from '../src/model-selection.ts'

/** One advertised model as the directory returns it. */
interface AdvertisedModel { id: string; name: string; description?: string }

/** Minimal `llm` stand-in; only the three calls this tool makes are implemented. */
function fakeLlm(models: AdvertisedModel[], providers: LlmProviderInfo[] = [
  { id: 'p-a', name: 'Provider A' },
] as LlmProviderInfo[]): LlmRuntime {
  return {
    listProviders: () => providers,
    listModels: async () => models,
    resolveModelInfo: async (_provider: string, model: string) => (
      models.find(candidate => candidate.id === model) ?? { id: model, name: model }
    ),
  } as unknown as LlmRuntime
}

/** Minimal Context whose only answered lookup is `llm`. */
function fakeContext(llm: LlmRuntime): Context {
  return { get: (name: string) => (name === 'llm' ? llm : undefined) } as unknown as Context
}

const SIGNAL = new AbortController().signal

const policyOf = (...routes: AllowedModelRoute[]): ModelSelectionPolicy => ({ routes })

describe('#165 候选路由 schema：能力标注向后兼容', () => {
  it('老配置（没有 tags/note）原样可读，套上 schema 不会造出备注', () => {
    const legacy = { provider: 'p-a', model: 'm-1' }
    const parsed = AllowedModelRouteSchema(legacy)
    expect(parsed.provider).toBe('p-a')
    expect(parsed.model).toBe('m-1')
    // schemastery 把缺省数组归一成 `[]`——「没有标签」与「空标签列表」必须等价，
    // 否则老配置会被渲染出空 `[]`。备注是标量，缺省即 `undefined`。
    expect(parsed.tags ?? []).toEqual([])
    expect(parsed.note).toBeUndefined()
  })

  it('带标注的配置原样保留 tags / note', () => {
    const tagged = { provider: 'p-a', model: 'm-1', tags: ['长上下文', '快速'], note: '长文首选' }
    expect(AllowedModelRouteSchema(tagged)).toEqual(tagged)
  })

  it('校验器同时放行老形态与新形态', () => {
    expect(() => { assertAllowedModelRoutes([
      { provider: 'p-a', model: 'm-1' },
      { provider: 'p-b', model: 'm-2', tags: ['多模态'], note: '看图' },
    ]) }).not.toThrow()
  })

  it('标注本身被校验：非字符串 / 空白标签 / 非字符串备注都拒绝', () => {
    expect(() => { assertAllowedModelRoutes([{ provider: 'p-a', model: 'm-1', tags: [1] }]) })
      .toThrow(/tags/)
    expect(() => { assertAllowedModelRoutes([{ provider: 'p-a', model: 'm-1', tags: ['  '] }]) })
      .toThrow(/tags/)
    expect(() => { assertAllowedModelRoutes([{ provider: 'p-a', model: 'm-1', note: 3 }]) })
      .toThrow(/note/)
  })

  it('重复路由照旧被拒（标注不改变身份）', () => {
    expect(() => { assertAllowedModelRoutes([
      { provider: 'p-a', model: 'm-1', tags: ['快速'] },
      { provider: 'p-a', model: 'm-1', tags: ['长上下文'] },
    ]) }).toThrow(/repeats route/)
  })
})

describe('#165 list_subagent_models 带出候选标注', () => {
  it('已配置候选的模型行列内带 [标签] 与备注', async () => {
    const text = await listSubagentModels(
      fakeContext(fakeLlm([{ id: 'm-1', name: 'Model One' }, { id: 'm-2', name: 'Model Two' }])),
      policyOf(
        { provider: 'p-a', model: 'm-1', tags: ['长上下文', '快速'], note: '长文首选' },
        { provider: 'p-a', model: 'm-2' },
      ),
      { provider: 'p-a' },
      SIGNAL,
    )
    expect(text).toContain('p-a/m-1 — Model One [长上下文, 快速] — 长文首选')
    // 没标注的候选与改动前逐字一致（不留空 `[]`、不留悬空 `—`）。
    expect(text).toContain('p-a/m-2 — Model Two')
    expect(text).not.toContain('Model Two [')
  })

  it('精确模型查询同样带标注，且推理强度段不受影响', async () => {
    const text = await listSubagentModels(
      fakeContext(fakeLlm([{ id: 'm-1', name: 'Model One' }])),
      policyOf({ provider: 'p-a', model: 'm-1', tags: ['多模态'], note: '看图' }),
      { provider: 'p-a', model: 'm-1' },
      SIGNAL,
    )
    expect(text.split('\n')[0]).toBe('p-a/m-1 — Model One [多模态] — 看图')
    expect(text).toContain('Reasoning efforts:')
  })

  it('候选集为空时不报错、不输出空表（沿用既有的「无 provider」行）', async () => {
    const text = await listSubagentModels(
      fakeContext(fakeLlm([{ id: 'm-1', name: 'Model One' }])),
      policyOf(),
      {},
      SIGNAL,
    )
    expect(text).toBe('(no LLM providers)')
    expect(text.trim().length).toBeGreaterThan(0)
  })
})

describe('#165 提示词段：候选为空不出现，非空才列出候选与标注', () => {
  it('候选为空 ⇒ 空串（机制省略空段，模型看不到空候选表）', () => {
    expect(corumSubagentModelCandidatesSection([])).toBe('')
  })

  it('候选非空 ⇒ 列出每条候选（含标注）+「按任务特点挑选」', () => {
    const text = corumSubagentModelCandidatesSection([
      { provider: 'p-a', model: 'm-1', tags: ['长上下文'], note: '大改首选' },
      { provider: 'p-b', model: 'm-2', tags: ['多模态', '快速'] },
      { provider: 'p-c', model: 'm-3' },
    ])
    expect(text).toContain('`p-a/m-1 [长上下文] — 大改首选`')
    expect(text).toContain('`p-b/m-2 [多模态, 快速]`')
    expect(text).toContain('`p-c/m-3`')
    expect(text).toContain('Pick the route by the shape of the work')
    // 选择出口只有三个字段，且列表外的路由会被机制拒绝——这句话必须给到模型。
    expect(text).toContain('REJECTED by the mechanism')
  })

  it('单条候选行渲染：标注按 tags 顺序、备注在标签之后', () => {
    expect(routeCandidateLine({ provider: 'p', model: 'm', tags: ['快速', '多模态'], note: '小活' }))
      .toBe('p/m [快速, 多模态] — 小活')
    expect(routeCandidateLine({ provider: 'p', model: 'm' })).toBe('p/m')
  })

  it('接线对账：段由候选非空守卫注册，文本走同一个纯函数（不是声明了没接线）', () => {
    const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
    expect(SRC).toContain('name: \'corum:subagent-model-candidates\'')
    expect(SRC).toContain('modelSelectionPolicy.routes.length > 0')
    expect(SRC).toContain('corumSubagentModelCandidatesSection(candidateRoutes)')
    // 候选集开着时，「模型不能选路由」这句旧口径必须已被换掉（否则提示词自相矛盾）。
    expect(SRC).toContain('...modelSelectionEnabled')
  })
})