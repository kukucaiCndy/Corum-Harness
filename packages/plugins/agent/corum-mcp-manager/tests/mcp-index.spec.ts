/**
 * index 模式（MCP 渐进式索引，2026-11-12d §2）单测。
 *
 * 分两层：
 *   · **纯文本层**（`mcp-index.ts`）：索引段/查询详情/摘要截断——这些是模型看到的东西，
 *     错一个字就是提示词层面的缺陷，必须逐条钉住（含语言纪律：包装文本无 CJK）。
 *   · **注册态层**（`proxy.ts`）：共享工具**每 scope 只注册一次**、`mcp_load` 走既有注册路径、
 *     guidance 加载才注入、幂等、未知 server/工具 fail-loud、以及 `eager` 路径零变化。
 *
 * 注册面/提示词面都用**会抛错的桩**（撞名注册、同名段重复注入都抛）——真机的 `tools.register`
 * 与 `systemPrompt.section` 就是这个契约，桩若宽容，"每 scope 只注册一次"这条根本测不出来。
 *
 * @module tests/mcp-index
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  filterIndexEntries,
  MCP_INDEX_MAX_LISTED_TOOLS,
  MCP_INDEX_TOOL_DESCRIPTION,
  MCP_INDEX_TOOL_NAME,
  MCP_LOAD_TOOL_DESCRIPTION,
  MCP_LOAD_TOOL_NAME,
  MCP_TOOL_SUMMARY_MAX_CHARS,
  mcpIndexSectionText,
  mcpIndexToolParameters,
  mcpLoadToolParameters,
  renderIndexDetail,
  renderLoadResult,
  summarizeToolDescription,
} from '../src/mcp-index.ts'
import { apply } from '../src/proxy.ts'

const CJK = /[\u4e00-\u9fff]/

/** 注册表指向临时 home（`registry-store` 每次读盘，无缓存）。 */
let home: string
let previousHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-mcp-index-'))
  previousHome = process.env.CORUM_HOME
  process.env.CORUM_HOME = home
  writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify({
    servers: [
      {
        name: 'fake',
        description: 'Fake test server',
        command: 'node',
        args: ['-e', ''],
        guidance: 'call fake.init before fake.run',
      },
      { name: 'other', description: 'Second fake server', command: 'node', args: ['-e', ''] },
    ],
  }))
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

interface StubTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

/** 记录型桩池；`tools` 可换（模拟服务端动态改表）。 */
function stubPool(initial: readonly StubTool[] = [
  { name: 'echo', description: 'Echo back the input text. Then stop.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'slow', description: 'Pretend to do something slow', inputSchema: { type: 'object', properties: {} } },
]) {
  const state = { tools: initial as readonly StubTool[] }
  const calls = { retained: [] as string[], listed: [] as string[] }
  const listeners = new Set<() => void>()
  const pool = {
    retain(serverName: string) {
      calls.retained.push(serverName)
      return () => {}
    },
    async listTools(serverName: string) {
      calls.listed.push(serverName)
      return state.tools
    },
    onToolsChanged(_serverName: string, listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }
  return {
    pool,
    calls,
    state,
    /** 模拟池广播"工具表变了"。 */
    fireToolsChanged: () => { for (const listener of listeners) listener() },
  }
}

interface StubDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly output: unknown
  readonly execute: (args: unknown, exec: unknown) => Promise<{ content: readonly { type: 'text'; text: string }[] }>
}

/** 注册面桩：撞名注册**抛错**（真机契约），并记录每一次注册尝试。 */
function registryStub() {
  const registered = new Map<string, StubDefinition>()
  const attempts: string[] = []
  const face = {
    register(definition: StubDefinition) {
      attempts.push(definition.name)
      if (registered.has(definition.name)) throw new Error(`already registered: ${definition.name}`)
      registered.set(definition.name, definition)
      return () => { registered.delete(definition.name) }
    },
  }
  return { registered, attempts, face }
}

/** 提示词面桩：同名段重复注入**抛错**（真机契约）。 */
function promptStub() {
  const sections = new Map<string, { name: string; order: number; text: string }>()
  const face = {
    section(options: { name: string; order: number; text: string }) {
      if (sections.has(options.name)) throw new Error(`duplicate section: ${options.name}`)
      sections.set(options.name, options)
      return () => { sections.delete(options.name) }
    },
    getSectionOrder: () => 100,
  }
  return { sections, face }
}

/** 桩上下文（`get` 只回 systemPrompt；其它服务视作未提供）。 */
function stubContext(pool: unknown, tools: unknown, systemPrompt?: unknown) {
  const effects: string[] = []
  const disposers: Array<() => void> = []
  const warnings: string[] = []
  const ctx = {
    corumMcpPool: pool,
    tools,
    logger: { info: () => {}, warn: (message: string) => { warnings.push(message) } },
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label ?? '?')
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    },
    get: (name: string) => (name === 'systemPrompt' ? systemPrompt : undefined),
  }
  return { ctx, effects, disposers, warnings }
}

/** 取一段工具结果文本。 */
function textOf(value: { content: readonly { type: 'text'; text: string }[] }): string {
  return value.content[0]?.text ?? ''
}

/** 调一个桩工具定义并取其文本（定义缺失即 fail-loud，别让断言在空值上悄悄通过）。 */
async function runText(definition: StubDefinition | undefined, args: unknown): Promise<string> {
  if (definition === undefined) throw new Error('tool definition missing')
  return textOf(await definition.execute(args, {}))
}

describe('索引文本层：摘要与截断', () => {
  it('★ 摘要取描述**首句**并截到 60 字符上限', () => {
    expect(summarizeToolDescription('Echo back the input text. Then stop.')).toBe('Echo back the input text.')
    // 没有句末标点 ⇒ 整段照用
    expect(summarizeToolDescription('Pretend to do something slow')).toBe('Pretend to do something slow')
    // 首句本身超长 ⇒ 硬截（结果长度仍 ≤ 上限，末位是省略号）
    const long = summarizeToolDescription(`${'x'.repeat(200)}. More.`)
    expect(long).toHaveLength(MCP_TOOL_SUMMARY_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
    // 空描述 ⇒ 空串（调用方只列工具名）
    expect(summarizeToolDescription(undefined)).toBe('')
    expect(summarizeToolDescription('   ')).toBe('')
  })

  it('描述里的点号不当句末（`demo.run` 这种名字不得被切断）', () => {
    expect(summarizeToolDescription('call demo.run before anything else')).toBe('call demo.run before anything else')
    // CJK 句末标点后没有空格，也算句末
    expect(summarizeToolDescription('先读 skill。再执行')).toBe('先读 skill。')
  })
})

describe('索引文本层：索引段', () => {
  const entry = {
    serverName: 'fake',
    description: 'Fake test server',
    tools: [
      { name: 'echo', description: 'Echo back the input text. Then stop.' },
      { name: 'slow', description: 'Pretend to do something slow' },
    ],
  }

  it('★ 索引段 = 一行用途 + 工具名清单（≤60 字符摘要）+ 使用纪律一句；包装无 CJK', () => {
    const text = mcpIndexSectionText(entry)
    expect(text).toContain('## MCP tool index: fake')
    expect(text).toContain('Fake test server')
    expect(text).toContain('- `echo` — Echo back the input text.')
    expect(text).toContain('- `slow` — Pretend to do something slow')
    // 使用纪律：未加载的工具名不可调用 + 指路 mcp_index / mcp_load
    expect(text).toContain('mcp_load')
    expect(text).toContain('mcp_index')
    expect(text).toContain('NOT callable')
    // 每行的摘要都 ≤ 上限
    for (const line of text.split('\n').filter(line => line.startsWith('- `'))) {
      expect(line).toContain('—')
      const summary = line.slice(line.indexOf('—') + 1).trim()
      expect(summary.length).toBeLessThanOrEqual(MCP_TOOL_SUMMARY_MAX_CHARS)
    }
    expect(text).not.toMatch(CJK)
  })

  it('已加载的工具不再列入；全部加载 ⇒ 空串（调用方据此摘掉该段）', () => {
    const partial = mcpIndexSectionText({ ...entry, loaded: ['echo'] })
    expect(partial).not.toContain('- `echo`')
    expect(partial).toContain('- `slow`')
    expect(mcpIndexSectionText({ ...entry, loaded: ['echo', 'slow'] })).toBe('')
  })

  it('工具过多 ⇒ 只列前 40 个 + 一句提示（防索引段随服务端工具数爆掉）', () => {
    const many = Array.from({ length: MCP_INDEX_MAX_LISTED_TOOLS + 3 }, (_, index) => ({ name: `t${index}` }))
    const text = mcpIndexSectionText({ serverName: 'big', tools: many })
    expect(text).toContain(`- \`t${MCP_INDEX_MAX_LISTED_TOOLS - 1}\``)
    expect(text).not.toContain(`- \`t${MCP_INDEX_MAX_LISTED_TOOLS}\``)
    expect(text).toContain('and 3 more')
  })

  it('没有工具 ⇒ 空串（不注入空段）', () => {
    expect(mcpIndexSectionText({ serverName: 'empty', tools: [] })).toBe('')
  })
})

describe('索引文本层：查询详情与加载结果', () => {
  const entries = [
    {
      serverName: 'fake',
      description: 'Fake test server',
      guidance: 'call fake.init before fake.run',
      tools: [
        { name: 'echo', description: 'Echo back the input text. Then stop.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'slow', description: 'Pretend to do something slow' },
      ],
      loaded: ['echo'],
    },
    { serverName: 'other', description: 'Second fake server', tools: [{ name: 'ping' }] },
  ]

  it('★ 详情给全量描述 + 参数 schema + guidance，并标注已加载项', () => {
    const text = renderIndexDetail(entries)
    expect(text).toContain('### `fake`')
    expect(text).toContain('`mcp__fake__echo`')
    expect(text).toContain('server tool name `echo` (loaded)')
    expect(text).toContain('description: Echo back the input text. Then stop.')
    expect(text).toContain('parameters: {"type":"object","properties":{"text":{"type":"string"}}}')
    expect(text).toContain('call fake.init before fake.run')
    expect(text).toContain('### `other`')
    expect(text).not.toMatch(CJK)
  })

  it('server 过滤：精确 / 大小写不敏感 / 未知 server 回给调用方 fail-loud', () => {
    expect(filterIndexEntries(entries, { server: 'fake' }).matched).toHaveLength(1)
    expect(filterIndexEntries(entries, { server: 'FAKE' }).matched).toHaveLength(1)
    expect(filterIndexEntries(entries, { server: 'nope' })).toEqual({ matched: [], unknownServer: 'nope' })
    expect(filterIndexEntries(entries).matched).toHaveLength(2)
  })

  it('query 过滤：匹配工具名与描述（大小写不敏感），零命中 ⇒ 提示而不是空白', () => {
    const hit = filterIndexEntries(entries, { query: 'SLOW' })
    expect(hit.matched).toHaveLength(1)
    expect(hit.matched[0]?.tools.map(tool => tool.name)).toEqual(['slow'])
    expect(filterIndexEntries(entries, { query: 'zzz' }).matched).toHaveLength(0)
    expect(renderIndexDetail([])).toContain('No authorized MCP tool matches this query')
  })

  it('加载结果：报公共名、区分本次新加载与早已加载', () => {
    const text = renderLoadResult('fake', ['echo'], ['slow'])
    expect(text).toContain('Loaded 1 tool(s) from `fake`: `mcp__fake__echo`')
    expect(text).toContain('Already loaded earlier: `mcp__fake__slow`')
    expect(renderLoadResult('fake', [], ['echo'])).toContain('No new tool was loaded')
  })

  it('两个共享工具：名字固定、描述与 schema 文案英文（提示词语言纪律）', () => {
    // 名字是**跨进程契约**：`compile.ts` 的子 Agent deny 名单与提示词里的指路文案都写死这两个名字。
    expect(MCP_INDEX_TOOL_NAME).toBe('mcp_index')
    expect(MCP_LOAD_TOOL_NAME).toBe('mcp_load')
    expect(MCP_INDEX_TOOL_DESCRIPTION).not.toMatch(CJK)
    expect(MCP_LOAD_TOOL_DESCRIPTION).not.toMatch(CJK)
    expect(JSON.stringify(mcpIndexToolParameters())).not.toMatch(CJK)
    expect(JSON.stringify(mcpLoadToolParameters())).not.toMatch(CJK)
    expect(mcpLoadToolParameters()).toMatchObject({ required: ['server'] })
    expect(mcpIndexToolParameters()).toMatchObject({ type: 'object' })
  })
})

describe('index 模式挂载：只铺索引，不注册 server 工具', () => {
  it('★ 缺省（不写 mcpMode）= index：注册 mcp_index/mcp_load，索引段在、guidance 段不在', async () => {
    const { pool, calls } = stubPool()
    const registry = registryStub()
    const prompt = promptStub()
    const { ctx } = stubContext(pool, registry.face, prompt.face)
    await apply(ctx as never, { serverName: 'fake' })
    expect([...registry.registered.keys()]).toEqual(['mcp_index', 'mcp_load'])
    expect(registry.registered.has('mcp__fake__echo')).toBe(false)
    expect(calls.retained).toEqual(['fake'])
    expect(prompt.sections.get('corum:mcp-index:fake')?.text).toContain('- `echo` — Echo back the input text.')
    // guidance 是"加载后才注入"的，挂载时不该占提示词
    expect(prompt.sections.has('corum:mcp-guidance:fake')).toBe(false)
  })

  it('宿主无 systemPrompt 服务 ⇒ 照常挂载（索引段跳过，共享工具仍在）', async () => {
    const { pool } = stubPool()
    const registry = registryStub()
    const { ctx } = stubContext(pool, registry.face, undefined)
    await expect(apply(ctx as never, { serverName: 'fake' })).resolves.toBeUndefined()
    expect([...registry.registered.keys()]).toEqual(['mcp_index', 'mcp_load'])
  })

  it('★ 多 server 多行共享一个 scope ⇒ 两个共享工具**只注册一次**', async () => {
    const { pool } = stubPool()
    const registry = registryStub()
    const prompt = promptStub()
    // 两行 = 两个 cordis fiber（各自的 ctx），同一个 tools 注册面 = 同一个 preset scope
    const first = stubContext(pool, registry.face, prompt.face)
    const second = stubContext(pool, registry.face, prompt.face)
    await Promise.all([
      apply(first.ctx as never, { serverName: 'fake' }),
      apply(second.ctx as never, { serverName: 'other' }),
    ])
    expect(registry.attempts.filter(name => name === 'mcp_index')).toHaveLength(1)
    expect(registry.attempts.filter(name => name === 'mcp_load')).toHaveLength(1)
    // 两段索引各归各的 server
    expect(prompt.sections.has('corum:mcp-index:fake')).toBe(true)
    expect(prompt.sections.has('corum:mcp-index:other')).toBe(true)
    // 共享的两个工具看得见**两个** server
    const index = registry.registered.get('mcp_index')
    const text = await runText(index, {})
    expect(text).toContain('### `fake`')
    expect(text).toContain('### `other`')
  })

  it('工具表变更 ⇒ 刷新索引段（同名段先摘后插，不撞名）', async () => {
    const { pool, state, fireToolsChanged } = stubPool()
    const registry = registryStub()
    const prompt = promptStub()
    const { ctx, warnings } = stubContext(pool, registry.face, prompt.face)
    await apply(ctx as never, { serverName: 'fake' })
    expect(prompt.sections.get('corum:mcp-index:fake')?.text).toContain('- `echo`')
    state.tools = [{ name: 'ping', description: 'Ping the server' }]
    fireToolsChanged()
    await new Promise(resolve => setTimeout(resolve, 10))
    const text = prompt.sections.get('corum:mcp-index:fake')?.text ?? ''
    expect(text).toContain('- `ping` — Ping the server')
    expect(text).not.toContain('- `echo`')
    expect(warnings.join(' ')).not.toContain('duplicate section')
  })

  it('未知 mcpMode ⇒ warn 并落回 index（不静默走 eager）', async () => {
    const { pool } = stubPool()
    const registry = registryStub()
    const { ctx, warnings } = stubContext(pool, registry.face, promptStub().face)
    await apply(ctx as never, { serverName: 'fake', mcpMode: 'lazy' as never })
    expect(warnings.join(' ')).toContain('unknown mcpMode')
    expect(registry.registered.has('mcp__fake__echo')).toBe(false)
  })

  it('listTools 连不上 ⇒ 有界返回 + 只 warn（不让 preset 挂载失败）', async () => {
    const broken = {
      retain: () => () => {},
      listTools: () => new Promise<readonly StubTool[]>(() => {}),
      onToolsChanged: () => () => {},
      callTool: async () => ({ content: [] }),
    }
    const registry = registryStub()
    const { ctx, warnings } = stubContext(broken, registry.face, promptStub().face)
    const started = Date.now()
    await apply(ctx as never, { serverName: 'fake', initialSyncTimeoutMs: 80 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(warnings.join(' ')).toContain('initial index sync still running')
    expect([...registry.registered.keys()]).toEqual(['mcp_index', 'mcp_load'])
  })
})

describe('mcp_load：按需注册 + guidance 注入', () => {
  /** 挂好一行 index 模式代理，返回注册面/提示词面/加载工具。 */
  async function mounted(tools?: readonly StubTool[]) {
    const pool = stubPool(tools)
    const registry = registryStub()
    const prompt = promptStub()
    const context = stubContext(pool.pool, registry.face, prompt.face)
    await apply(context.ctx as never, { serverName: 'fake' })
    const load = registry.registered.get('mcp_load')
    const index = registry.registered.get('mcp_index')
    if (load === undefined || index === undefined) throw new Error('shared tools missing')
    return { ...pool, registry, prompt, context, load, index }
  }

  it('★ 加载选定工具：走既有注册路径（公共名 + 池的原始名转发），并注入 guidance 段', async () => {
    const { registry, prompt, load } = await mounted()
    const value = await load.execute({ server: 'fake', tools: ['slow'] }, { agent: { id: 'a' } })
    expect(textOf(value)).toContain('Loaded 1 tool(s) from `fake`: `mcp__fake__slow`')
    expect(registry.registered.has('mcp__fake__slow')).toBe(true)
    expect(registry.registered.has('mcp__fake__echo')).toBe(false)
    expect(prompt.sections.has('corum:mcp-guidance:fake')).toBe(true)
    // 已加载项从索引段消失，未加载项还在
    const section = prompt.sections.get('corum:mcp-index:fake')?.text ?? ''
    expect(section).not.toContain('- `slow`')
    expect(section).toContain('- `echo`')
    // 注册进工具面的是标准定义（description / parameters / output 齐备）
    const definition = registry.registered.get('mcp__fake__slow')
    expect(definition?.description).toBe('Pretend to do something slow')
    expect(definition?.output).toBeDefined()
  })

  it('★ 缺省 tools = 整 server；全部加载后索引段整体摘掉', async () => {
    const { registry, prompt, load } = await mounted()
    const value = await load.execute({ server: 'fake' }, {})
    expect(textOf(value)).toContain('Loaded 2 tool(s)')
    expect([...registry.registered.keys()].sort()).toEqual(['mcp__fake__echo', 'mcp__fake__slow', 'mcp_index', 'mcp_load'])
    expect(prompt.sections.has('corum:mcp-index:fake')).toBe(false)
    expect(prompt.sections.has('corum:mcp-guidance:fake')).toBe(true)
  })

  it('★ 幂等：重复 load 不再注册（不撞名），结果里报"早已加载"', async () => {
    const { registry, load } = await mounted()
    await load.execute({ server: 'fake', tools: ['echo'] }, {})
    const before = registry.attempts.filter(name => name === 'mcp__fake__echo').length
    const again = await load.execute({ server: 'fake', tools: ['echo'] }, {})
    expect(textOf(again)).toContain('No new tool was loaded')
    expect(textOf(again)).toContain('Already loaded earlier: `mcp__fake__echo`')
    expect(registry.attempts.filter(name => name === 'mcp__fake__echo')).toHaveLength(before)
  })

  it('接受模型可见的 `mcp__server__tool` 名（等价于原始名）', async () => {
    const { registry, load } = await mounted()
    await load.execute({ server: 'fake', tools: ['mcp__fake__echo'] }, {})
    expect(registry.registered.has('mcp__fake__echo')).toBe(true)
  })

  it('★ fail-loud：未知 server / 未知工具名 / 缺 server / tools 形态错 全部抛错', async () => {
    const { load, registry } = await mounted()
    await expect(load.execute({ server: 'nope' }, {})).rejects.toThrow(/unknown MCP server "nope".*authorized in this scope: fake/)
    await expect(load.execute({ server: 'fake', tools: ['nope'] }, {})).rejects.toThrow(/unknown tool\(s\) "nope" — available: echo, slow/)
    await expect(load.execute({}, {})).rejects.toThrow(/requires \{server/)
    await expect(load.execute({ server: 'fake', tools: 'echo' }, {})).rejects.toThrow(/must be an array/)
    // 抛错的一路不得留下半个工具面
    expect(registry.registered.has('mcp__fake__echo')).toBe(false)
  })

  it('注册失败 ⇒ 本次加载整体回滚（宁可零工具也不要半代）', async () => {
    const { registry, load } = await mounted()
    // 占掉一个名字，模拟撞名
    registry.face.register({ name: 'mcp__fake__slow', description: '', parameters: {}, output: {}, execute: async () => ({ content: [] }) })
    await expect(load.execute({ server: 'fake' }, {})).rejects.toThrow(/tool registration failed, nothing loaded/)
    expect(registry.registered.has('mcp__fake__echo')).toBe(false)
  })
})

describe('mcp_index：纯查询（不改工具面）', () => {
  it('★ 查询详情 + server/query 筛选；查询本身不注册任何工具', async () => {
    const { pool } = stubPool()
    const registry = registryStub()
    const prompt = promptStub()
    const { ctx } = stubContext(pool, registry.face, prompt.face)
    await apply(ctx as never, { serverName: 'fake' })
    const index = registry.registered.get('mcp_index')
    if (index === undefined) throw new Error('mcp_index not registered')
    const attemptsBefore = [...registry.attempts]

    const all = await runText(index, {})
    expect(all).toContain('### `fake`')
    expect(all).toContain('parameters: {"type":"object","properties":{"text":{"type":"string"}}}')
    expect(all).toContain('call fake.init before fake.run')

    const filtered = await runText(index, { query: 'SLOW' })
    expect(filtered).toContain('server tool name `slow`')
    expect(filtered).not.toContain('server tool name `echo`')

    await expect(index.execute({ server: 'nope' }, {})).rejects.toThrow(/unknown MCP server "nope" for mcp_index/)
    // 工具面零变化（纯查询）
    expect(registry.attempts).toEqual(attemptsBefore)
  })
})

describe('eager 模式：改造前行为逐字保留', () => {
  it('★ mcpMode: eager ⇒ 挂载即注册全部工具 + 注入 guidance，且**不**注册共享工具', async () => {
    const { pool } = stubPool()
    const registry = registryStub()
    const prompt = promptStub()
    const { ctx } = stubContext(pool, registry.face, prompt.face)
    await apply(ctx as never, { serverName: 'fake', mcpMode: 'eager' })
    expect([...registry.registered.keys()]).toEqual(['mcp__fake__echo', 'mcp__fake__slow'])
    expect(prompt.sections.has('corum:mcp-guidance:fake')).toBe(true)
    expect(prompt.sections.has('corum:mcp-index:fake')).toBe(false)
    expect(registry.attempts).not.toContain('mcp_index')
  })
})

describe('scope 生命周期：最后一行卸载收掉共享工具与已加载工具', () => {
  it('★ 卸载后注册面干净（工具与共享工具都不残留）', async () => {
    const { pool } = stubPool()
    const registry = registryStub()
    const prompt = promptStub()
    const { ctx, disposers } = stubContext(pool, registry.face, prompt.face)
    await apply(ctx as never, { serverName: 'fake' })
    const load = registry.registered.get('mcp_load')
    await load?.execute({ server: 'fake' }, {})
    expect(registry.registered.has('mcp__fake__echo')).toBe(true)
    for (const dispose of disposers) dispose()
    expect([...registry.registered.keys()]).toEqual([])
    expect(prompt.sections.size).toBe(0)
  })
})
