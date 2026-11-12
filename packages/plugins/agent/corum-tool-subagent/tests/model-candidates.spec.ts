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
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { listSubagentModels } from '../src/list-models.ts'
import { corumSubagentModelCandidatesSection, routeCandidateLine } from '../src/model-candidates.ts'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  requestedAgentOptions,
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
    // schemastery 会把未给的数组字段物化成 `[]`（`roles` 与 `tags` 同款），
    // 故断言用「标注原样保留」而不咬字段集合；空 `roles` 的语义就是「两类都能用」。
    expect(AllowedModelRouteSchema(tagged)).toEqual({ ...tagged, roles: [] })
  })

  it('★ 候选可标「给哪类子 Agent 用」：缺省 = 两类都能用，显式 = 只给勾了的那类', async () => {
    const { routeAppliesToRole, routesForRole } = await import('../src/model-selection.ts')
    const both: AllowedModelRoute = { provider: 'p-a', model: 'm-1' }
    const workerOnly: AllowedModelRoute = { provider: 'p-b', model: 'm-2', roles: ['worker'] }
    const researchOnly: AllowedModelRoute = { provider: 'p-c', model: 'm-3', roles: ['research'] }

    expect(routeAppliesToRole(both, 'worker')).toBe(true)
    expect(routeAppliesToRole(both, 'research')).toBe(true)
    expect(routeAppliesToRole(workerOnly, 'research')).toBe(false)
    expect(routeAppliesToRole(researchOnly, 'worker')).toBe(false)
    expect(routesForRole([both, workerOnly, researchOnly], 'worker').map(r => r.provider)).toEqual(['p-a', 'p-b'])
    expect(routesForRole([both, workerOnly, researchOnly], 'research').map(r => r.provider)).toEqual(['p-a', 'p-c'])
  })

  it('★ roles 被校验：只能是 worker/research，且不许重复', () => {
    expect(() => { assertAllowedModelRoutes([{ provider: 'p-a', model: 'm-1', roles: ['worker'] }]) }).not.toThrow()
    expect(() => { assertAllowedModelRoutes([{ provider: 'p-a', model: 'm-1', roles: ['worker', 'worker'] }]) })
      .toThrow(/duplicate/)
    expect(() => {
      assertAllowedModelRoutes([{ provider: 'p-a', model: 'm-1', roles: ['coder' as never] }])
    }).toThrow(/roles/)
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

/**
 * 用户 2026-11-12：「选择已配置的供应商模型 + **思考程度**」——候选条目必须能记住
 * 思考程度并走到子 Agent 的 agentOptions。
 *
 * ⚠️ 读代码后必须如实记账的一点：corum 的委派工具 schema **已剔除**
 * `provider`/`model`/`reasoning_effort` 三个入参（模型锁，见 `src/index.ts` 的
 * `parameters` 注释与 `tests/model-policy.spec.ts` 的同款断言），`spawnOne` 因此拿到的
 * `modelRequest` 恒为空对象 ⇒ 运行期**没有任何路径**把候选的思考程度写进
 * `request.agentOptions`。本组断言因此钉的是**能钉的部分**：
 *   ① 候选路由（含思考程度）在后端边界被接受且**原样保留**；
 *   ② 「模型确实请求了这条候选」时，思考程度走的是既有落点
 *      （`requestedAgentOptions` → `agentOptions.reasoningEffort`），机制本身没丢这个字段。
 * 缺口（schema 不开 ⇒ 模型无法表达这条请求）不在本轮修：它是「模型锁」用户策略的
 * 冲突面，需人工裁决（见交付报告）。
 */
describe('#165 候选的思考程度：边界接受、原样保留、落到既有落点', () => {
  it('带 reasoningEffort 的候选通过边界校验，且 schema 归一后仍在', () => {
    const routes = [{ provider: 'p-a', model: 'm-1', reasoningEffort: 'high', tags: ['长上下文'] }]
    expect(() => { assertAllowedModelRoutes(routes) }).not.toThrow()
    const parsed = AllowedModelRouteSchema(routes[0])
    expect(parsed.reasoningEffort).toBe('high')
    // 老的「没有思考程度」的候选仍然合法（向后兼容：库里存量值一个都不用改）。
    expect(() => { assertAllowedModelRoutes([{ provider: 'p-a', model: 'm-1' }]) }).not.toThrow()
  })

  it('类型不对的 reasoningEffort 在边界被拒（与 tags/note 同一风格：只校验类型）', () => {
    expect(() => {
      assertAllowedModelRoutes([{ provider: 'p-a', model: 'm-1', reasoningEffort: 3 }])
    }).toThrow(/requires `reasoningEffort` to be a string/)
  })

  it('模型请求了这条候选 ⇒ 思考程度进入子 Agent 的 agentOptions（既有落点没丢字段）', () => {
    const parent = { provider: 'p-parent', model: 'm-parent' } as AgentOptions
    const requested = requestedAgentOptions(
      parent,
      undefined,
      { provider: 'p-a', model: 'm-1', reasoning_effort: 'high' },
      true,
    )
    expect(requested).toEqual({ provider: 'p-a', model: 'm-1', reasoningEffort: 'high' })
  })

  it('★ 接线：候选开启时 schema 声明三参，且 execute 把三者转发进派发参数', () => {
    const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
    const parameters = SRC.slice(SRC.indexOf('parameters: {', SRC.indexOf("name: toolName")))
    const head = parameters.slice(0, parameters.indexOf('output: {'))
    // ① 声明：三参在 `...modelSelectionEnabled ? {` 块里
    const gate = head.indexOf('...modelSelectionEnabled ? {')
    expect(gate, '候选集条件展开块必须存在').toBeGreaterThan(-1)
    const gateBlock = head.slice(gate, head.indexOf('} : {},', gate))
    expect(gateBlock).toMatch(/\breasoning_effort\s*:/)
    // ② 转发：execute 里 `spawnOne(...)` 的 args 必须带这三个字段（不带 ⇒ schema 声明了也白给）
    expect(SRC).toMatch(/\.\.\.args\.provider !== undefined \? \{ provider: args\.provider \}/)
    expect(SRC).toMatch(/\.\.\.args\.model !== undefined \? \{ model: args\.model \}/)
    expect(SRC).toMatch(/\.\.\.args\.reasoning_effort !== undefined \? \{ reasoning_effort: args\.reasoning_effort \}/)
  })
})