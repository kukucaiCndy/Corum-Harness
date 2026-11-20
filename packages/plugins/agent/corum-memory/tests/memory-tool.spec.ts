/**
 * memory-tool 测试 —— 真实执行工具定义（不扫描源文本）。
 *
 * 覆盖：
 *   - search 强制归属（agentId 由工厂绑定，模型无法覆盖）
 *   - get 越界 / 未归属 / 关闭不可读
 *   - session-start / never 模式工具拒绝（返回 disabled）
 *   - 英文输出（description + disabled reason）
 *   - search 只给线索（不含 evidence），get 给全文
 *   - limit 范围强制（1~20）
 *   - isConcurrencySafe 不声明 true
 */
import { describe, expect, it } from 'vitest'
import { createMemoryRecallTool } from '../src/memory-tool.ts'
import type { MemoryRecallCapable, MemoryToolConfig } from '../src/memory-tool.ts'
import type { MemoryFactView, MemoryRetention } from '../src/memory-entities.ts'

/** 造一条 MemoryFactView（含派生字段）。 */
function view(overrides: Partial<MemoryFactView> = {}): MemoryFactView {
  return {
    id: 'f1',
    entity: '',
    relation: '',
    fact: '用户偏好深色模式',
    importance: 80,
    validAt: null,
    invalidAt: null,
    source: '',
    agentId: 'pm',
    retention: 'long' as MemoryRetention,
    expiresAt: null,
    readCount: 3,
    supersedes: [],
    evidence: ['secret-evidence-not-in-clue'],
    author: 'agent:s1',
    createdAt: 1000,
    lastAccessedAt: 2000,
    effectiveScore: 75.5,
    applicable: true,
    retained: true,
    ...overrides,
  }
}

/** 造假记忆服务（满足 MemoryRecallCapable 窄接口）。 */
function makeMemoryStub(views: MemoryFactView[] = [], getByAgent: ((id: string, agentId: string) => MemoryFactView | null) | null = null): MemoryRecallCapable & { searchCalls: Array<{ agentId?: string; query?: string; mode?: string; limit?: number }>; getCalls: Array<{ id: string; agentId: string }> } {
  const searchCalls: Array<{ agentId?: string; query?: string; mode?: string; limit?: number }> = []
  const getCalls: Array<{ id: string; agentId: string }> = []
  return {
    searchCalls,
    getCalls,
    async searchFacts(input) {
      searchCalls.push({ agentId: input.agentId, query: input.query, mode: input.mode, limit: input.limit })
      return views
    },
    async getFactForAgent(id, agentId) {
      getCalls.push({ id, agentId })
      if (getByAgent !== null) return getByAgent(id, agentId)
      // 默认：只在 views 里找匹配 id + agentId
      return views.find(v => v.id === id && v.agentId === agentId) ?? null
    },
  }
}

/** 造假 getConfig。 */
function makeConfig(config: Partial<MemoryToolConfig> = {}): () => MemoryToolConfig {
  let current: MemoryToolConfig = {
    enabled: config.enabled ?? true,
    injectionMode: config.injectionMode ?? 'recall',
  }
  return () => current
}

/** 最小 exec stub（工具不读 exec 字段，只需有值）。 */
const execStub = { signal: new AbortController().signal } as never

describe('createMemoryRecallTool', () => {
  it('工具名是 memory', () => {
    const tool = createMemoryRecallTool(makeMemoryStub(), 'pm', makeConfig())
    expect(tool.name).toBe('memory')
  })

  it('description 是英文且包含 "not required for every task"', () => {
    const tool = createMemoryRecallTool(makeMemoryStub(), 'pm', makeConfig())
    expect(tool.description).toMatch(/not required for every task/)
    // 全英文——不应有中文
    expect(tool.description).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('parameters 不含 agentId（模型无法覆盖归属）', () => {
    const tool = createMemoryRecallTool(makeMemoryStub(), 'pm', makeConfig())
    const params = tool.parameters as Record<string, unknown>
    const properties = params.properties as Record<string, unknown>
    expect(properties.agentId).toBeUndefined()
    expect(properties.action).toBeDefined()
    expect(properties.query).toBeDefined()
    expect(properties.id).toBeDefined()
    expect(properties.limit).toBeDefined()
  })

  it('isConcurrencySafe 不声明 true（search 有 readCount 写副作用）', () => {
    const tool = createMemoryRecallTool(makeMemoryStub(), 'pm', makeConfig())
    // 不声明 isConcurrencySafe ⇒ undefined（不参与并行组）
    expect(tool.isConcurrencySafe).toBeUndefined()
  })
})

describe('memory tool: search action', () => {
  it('强制归属：searchFacts 收到工厂绑定的 agentId，不是模型入参', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    await tool.execute({ action: 'search', query: '深色' } as never, execStub)
    expect(mem.searchCalls).toHaveLength(1)
    expect(mem.searchCalls[0]!.agentId).toBe('pm')
  })

  it('强制 mode=applicable（模型无法覆盖）', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    await tool.execute({ action: 'search' } as never, execStub)
    expect(mem.searchCalls[0]!.mode).toBe('applicable')
  })

  it('limit 默认 10，范围 1~20', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    await tool.execute({ action: 'search' } as never, execStub)
    expect(mem.searchCalls[0]!.limit).toBe(10)
    await tool.execute({ action: 'search', limit: 50 } as never, execStub)
    expect(mem.searchCalls[1]!.limit).toBe(20)
    await tool.execute({ action: 'search', limit: 0 } as never, execStub)
    expect(mem.searchCalls[2]!.limit).toBe(1)
  })

  it('search 只返回线索（id/fact snippet/retention/importance/effectiveScore），不含 evidence', async () => {
    const mem = makeMemoryStub([view({ evidence: ['secret-evidence-abc'] })])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    const result = await tool.execute({ action: 'search' } as never, execStub) as { kind: string; clues: Array<Record<string, unknown>> }
    expect(result.kind).toBe('search')
    expect(result.clues).toHaveLength(1)
    const clue = result.clues[0]!
    expect(clue.id).toBe('f1')
    expect(clue.fact).toBe('用户偏好深色模式')
    expect(clue.retention).toBe('long')
    expect(clue.importance).toBe(80)
    expect(clue.effectiveScore).toBe(75.5)
    // 不含 evidence 全文
    expect(clue.evidence).toBeUndefined()
  })

  it('fact 超过 160 chars 时截断', async () => {
    const longFact = '这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的事实文本，超过了160个字符的限制所以需要被截断，截断后会加上省略号。'.repeat(2)
    const mem = makeMemoryStub([view({ fact: longFact })])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    const result = await tool.execute({ action: 'search' } as never, execStub) as { kind: string; clues: Array<Record<string, unknown>> }
    const clue = result.clues[0]!
    const fact = clue.fact as string
    expect(fact.length).toBeLessThanOrEqual(163) // 157 + '...'
    expect(fact.endsWith('...')).toBe(true)
  })

  it('search 返回空数组时输出英文 "No matching memories found."', async () => {
    const mem = makeMemoryStub([])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    const result = await tool.execute({ action: 'search' } as never, execStub) as { kind: string; clues: unknown[] }
    expect(result.kind).toBe('search')
    expect(result.clues).toHaveLength(0)
    // render 输出
    const rendered = tool.output.render(undefined as never, result as never)
    expect(rendered[0]!.type).toBe('text')
    expect((rendered[0] as { text: string }).text).toBe('No matching memories found.')
  })
})

describe('memory tool: get action', () => {
  it('get 返回全文与元数据', async () => {
    const v = view({ evidence: ['secret'] })
    const mem = makeMemoryStub([v])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    const result = await tool.execute({ action: 'get', id: 'f1' } as never, execStub) as { kind: string; detail: Record<string, unknown> | undefined }
    expect(result.kind).toBe('get')
    expect(result.detail).toBeDefined()
    expect(result.detail!.fact).toBe('用户偏好深色模式')
    expect(result.detail!.entity).toBe('')
    expect(result.detail!.source).toBe('')
    expect(result.detail!.retention).toBe('long')
    expect(result.detail!.effectiveScore).toBe(75.5)
    expect(result.detail!.createdAt).toBe(1000)
    // get 不返回 evidence（安全：不暴露证据链全文给模型）
    expect(result.detail!.evidence).toBeUndefined()
  })

  it('get 越界（不存在的 id）返回 detail=undefined', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    const result = await tool.execute({ action: 'get', id: 'nonexistent' } as never, execStub) as { kind: string; detail: unknown }
    expect(result.kind).toBe('get')
    expect(result.detail).toBeUndefined()
  })

  it('get 未归属（agentId 不匹配）返回 detail=undefined', async () => {
    const mem = makeMemoryStub([view({ agentId: 'other-agent' })])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    // getFactForAgent 在 stub 里按 agentId 过滤——agentId='pm' 找不到 agentId='other-agent' 的记录
    const result = await tool.execute({ action: 'get', id: 'f1' } as never, execStub) as { kind: string; detail: unknown }
    expect(result.kind).toBe('get')
    expect(result.detail).toBeUndefined()
  })

  it('get 调 getFactForAgent 时传入工厂绑定的 agentId（不是模型入参）', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig())
    await tool.execute({ action: 'get', id: 'f1' } as never, execStub)
    expect(mem.getCalls[0]!.agentId).toBe('pm')
    expect(mem.getCalls[0]!.id).toBe('f1')
  })
})

describe('memory tool: disabled 场景', () => {
  it('enabled=false 时 search 返回 disabled（英文），不执行读取', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig({ enabled: false }))
    const result = await tool.execute({ action: 'search' } as never, execStub) as { kind: string; reason: string }
    expect(result.kind).toBe('disabled')
    expect(result.reason).toMatch(/disabled/i)
    expect(result.reason).not.toMatch(/[\u4e00-\u9fff]/) // 英文
    // 没有调 searchFacts
    expect(mem.searchCalls).toHaveLength(0)
  })

  it('enabled=false 时 get 返回 disabled，不执行读取', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig({ enabled: false }))
    const result = await tool.execute({ action: 'get', id: 'f1' } as never, execStub) as { kind: string; reason: string }
    expect(result.kind).toBe('disabled')
    expect(mem.getCalls).toHaveLength(0)
  })

  it('injectionMode=session-start 时 search 返回 disabled（英文）', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig({ injectionMode: 'session-start' }))
    const result = await tool.execute({ action: 'search' } as never, execStub) as { kind: string; reason: string }
    expect(result.kind).toBe('disabled')
    expect(result.reason).toMatch(/session-start/)
    expect(result.reason).not.toMatch(/[\u4e00-\u9fff]/)
    expect(mem.searchCalls).toHaveLength(0)
  })

  it('injectionMode=never 时 search 返回 disabled（英文）', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig({ injectionMode: 'never' }))
    const result = await tool.execute({ action: 'search' } as never, execStub) as { kind: string; reason: string }
    expect(result.kind).toBe('disabled')
    expect(result.reason).toMatch(/never/)
    expect(result.reason).not.toMatch(/[\u4e00-\u9fff]/)
    expect(mem.searchCalls).toHaveLength(0)
  })

  it('injectionMode=never 时 get 也返回 disabled', async () => {
    const mem = makeMemoryStub([view()])
    const tool = createMemoryRecallTool(mem, 'pm', makeConfig({ injectionMode: 'never' }))
    const result = await tool.execute({ action: 'get', id: 'f1' } as never, execStub) as { kind: string }
    expect(result.kind).toBe('disabled')
    expect(mem.getCalls).toHaveLength(0)
  })
})

describe('memory tool: getConfig 每次调用现读', () => {
  it('配置可在调用之间切换：第一次 recall 可读，改 never 后拒绝', async () => {
    const mem = makeMemoryStub([view()])
    let config: MemoryToolConfig = { enabled: true, injectionMode: 'recall' }
    const getConfig = (): MemoryToolConfig => config
    const tool = createMemoryRecallTool(mem, 'pm', getConfig)

    const r1 = await tool.execute({ action: 'search' } as never, execStub) as { kind: string }
    expect(r1.kind).toBe('search')
    expect(mem.searchCalls).toHaveLength(1)

    config = { enabled: true, injectionMode: 'never' }
    const r2 = await tool.execute({ action: 'search' } as never, execStub) as { kind: string }
    expect(r2.kind).toBe('disabled')
    expect(mem.searchCalls).toHaveLength(1) // 没有新增
  })
})
