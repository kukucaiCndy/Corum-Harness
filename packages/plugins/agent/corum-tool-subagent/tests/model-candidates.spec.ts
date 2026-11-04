import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { registerListSubagentModels } from '../src/list-models.ts'
import { applyChildModelRetryRoute, delegationModelParameters, assertAllowedModelRoutes, assertAllowedModelSelection, preflightChildLlmRoute, requestedAgentOptions } from '../src/model-selection.ts'
import { subagentModelSelectionProjectionDefinition } from '../src/model-selection-state.ts'

const parent = { provider: 'p', model: 'main' }
const routes = [{ provider: 'p', model: 'vision', description: '多模态，适合图片分析' }]

describe('候选模型沿用授权与预检', () => {
  it('模型列表同时展示用户配置的能力说明', async () => {
    let tool: { execute: (args: object, exec: { signal: AbortSignal }) => Promise<string> } | undefined
    const ctx = {
      tools: { register: (definition: typeof tool) => { tool = definition } },
      get: () => ({
        listProviders: () => [{ id: 'p', name: 'Provider' }],
        listModels: async () => [{ id: 'vision', name: 'Vision' }],
      }),
    } as unknown as Context
    registerListSubagentModels(ctx, { routes })
    const result = await tool!.execute({ provider: 'p' }, { signal: new AbortController().signal })
    expect(result).toContain('多模态，适合图片分析')
  })

  it('关闭选择不公开路由字段，开启后公开三项选择字段', () => {
    expect(delegationModelParameters(false)).toEqual({})
    expect(Object.keys(delegationModelParameters(true))).toEqual(['provider', 'model', 'reasoning_effort'])
  })

  it('重跑请求保留用户指定路由与推理强度，并标记机制所有权', () => {
    const request = { agentOptions: { provider: 'p', model: 'broken' }, agentOptionsOwnedByMechanism: false }
    applyChildModelRetryRoute(request, { provider: 'other', model: 'fast', reasoningEffort: 'low' })
    expect(request).toEqual({ agentOptions: { provider: 'other', model: 'fast', reasoningEffort: 'low' }, agentOptionsOwnedByMechanism: true })
  })

  it('Session policy 可恢复带能力说明的新配置和无说明的旧配置', () => {
    expect(subagentModelSelectionProjectionDefinition.stateSchema.parse(routes)).toEqual(routes)
    expect(subagentModelSelectionProjectionDefinition.stateSchema.parse([{ provider: 'p', model: 'old' }]))
      .toEqual([{ provider: 'p', model: 'old' }])
  })

  it('拒绝非字符串说明，而无说明旧配置仍有效', () => {
    expect(() => assertAllowedModelRoutes([{ provider: 'p', model: 'm', description: 10 }])).toThrow()
    expect(() => assertAllowedModelRoutes([{ provider: 'p', model: 'm' }])).not.toThrow()
  })

  it('授权的显式模型覆盖角色默认，并以该模型执行 adapter 预检', async () => {
    const request = { provider: 'p', model: 'vision' }
    const options = requestedAgentOptions(parent, { provider: 'p', model: 'code' }, request, true)
    assertAllowedModelSelection({ routes }, parent, options, request)
    const calls: object[] = []
    await preflightChildLlmRoute({ resolveCallConfig: async (config: object) => { calls.push(config) } } as unknown as LlmRuntime,
      parent, options, new AbortController().signal)
    expect(options).toEqual({ provider: 'p', model: 'vision' })
    expect(calls).toEqual([{ provider: 'p', model: 'vision' }])
  })

  it('显式选回父路由时，预检与实际继承同一父推理强度', () => {
    expect(requestedAgentOptions({ provider: 'p', model: 'main', reasoningEffort: ReasoningEffortId('low') }, { provider: 'p', model: 'code' }, { provider: 'p', model: 'main' }, true))
      .toEqual({ provider: 'p', model: 'main', reasoningEffort: 'low' })
  })

  it('未授权模型被拒绝；关闭选择且未带参数保持原单模型配置', () => {
    const configured = { provider: 'p', model: 'code' }
    expect(requestedAgentOptions(parent, configured, {}, false)).toBe(configured)
    expect(() => assertAllowedModelSelection({ routes }, parent, configured, { provider: 'p', model: 'code' })).toThrow('not allowed')
    expect(() => requestedAgentOptions(parent, configured, { provider: 'p', model: 'vision' }, false)).toThrow('disabled')
  })
})
