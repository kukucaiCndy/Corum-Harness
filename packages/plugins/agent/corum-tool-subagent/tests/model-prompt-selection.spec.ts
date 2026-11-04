import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

// 测试只组装提示词；scope 身份与外部注册服务由此边界夹具提供。
vi.mock('@deepseek-ai/dsh-scope', async importOriginal => ({
  ...await importOriginal<object>(),
  scopeOf: (ctx: { scope?: object }) => ctx.scope,
}))

function assembledPrompt(enabled: boolean, hasOrchestrate: boolean): string {
  const routes = [{ provider: 'p', model: 'vision', description: '多模态' }]
  const sections = new Map<string, (context: { scope: object }) => string>()
  const tools = new Map<string, unknown>([['subagent_research', {}]])
  const scope = {}
  const provider = { name: 'corum-spawn', inheritsParentContext: false, capabilities: { depthLimit: true, agentOptions: true } }
  const agent = { ctx: undefined as unknown, session: { firstLiveSeq: 0, eventAt: () => undefined, header: { origin: 'user' }, append: () => {} } }
  const ctx = {
    scope,
    root: { get: () => ({}) },
    get: (name: string) => name === 'agents' ? { list: () => [agent] }
      : name === 'subagentModelSelection' ? { current: () => ({ enabled, allowedModels: routes }) } : undefined,
    inject: () => ({}), on: () => () => {}, effect: () => {},
    logger: { info: () => {}, warn: () => {} },
    subagents: { getProvider: () => provider },
    sessionProjections: { register: () => {}, stateOf: () => enabled ? routes : null },
    tools: {
      register: (tool: { name: string }) => { tools.set(tool.name, tool); return () => {} },
      get: (name: string) => name === 'orchestrate' && !hasOrchestrate ? undefined : tools.get(name),
    },
    systemPrompt: {
      getSectionOrder: () => 2800,
      section: (section: { name: string; text: (context: { scope: object }) => string }) => { sections.set(section.name, section.text) },
    },
  }
  agent.ctx = ctx
  apply(ctx as unknown as Context, { provider: 'corum-spawn', modelSelectionSettings: true })
  return sections.get('corum:subagent-orchestration')!({ scope })
}

describe.each([true, false])('实际组装的模型提示词（orchestrate 可见=%s）', (hasOrchestrate) => {
  it('开启候选时指导按说明选择授权 route，不再声称模型参数不存在', () => {
    const prompt = assembledPrompt(true, hasOrchestrate)
    expect(prompt).toContain('list_subagent_models')
    expect(prompt).toContain('capability descriptions')
    expect(prompt).toContain('allowlist')
    expect(prompt).toContain('`provider`')
    expect(prompt).toContain('`model`')
    expect(prompt).not.toContain('NOT yours to choose')
    expect(prompt).not.toContain('exposes any model parameter')
    expect(prompt).not.toContain('routing is LOCKED')
    expect(prompt).not.toContain('never try to route a child elsewhere')
  })

  it('关闭候选时保留固定路由指导，不引导调用不存在的选择工具', () => {
    const prompt = assembledPrompt(false, hasOrchestrate)
    expect(prompt).toContain(hasOrchestrate ? 'NOT yours to choose' : 'routing is LOCKED')
    expect(prompt).not.toContain('list_subagent_models')
    expect(prompt).not.toContain('capability descriptions')
  })
})
