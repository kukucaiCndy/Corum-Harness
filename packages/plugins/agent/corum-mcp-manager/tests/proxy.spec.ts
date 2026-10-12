/**
 * 代理行单测：preset 行 → 池 → 独占租约这条链的**接缝**。
 *
 * 分两层测，各有理由：
 *   · **桩池**（大多数用例）：验协议细节——注册用什么名、`execute` 转发的是**原始名**还是公共名、
 *     归属从哪来、`isError` 会不会抛、换代与回滚的顺序、signal 有没有透传。这些用桩才看得清。
 *   · **真池 + 真子进程**（末条）：验端到端确实跑通（注册到调用到结果），避免"桩对了、真链断了"。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpPool } from '../src/pool.ts'
import { apply, canonicalResultOf, ownerOf, type McpProxyConfig } from '../src/proxy.ts'
import type { McpServerConfig } from '../src/types.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs')
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 记录型桩池。 */
function stubPool(tools: readonly { name: string; description?: string; inputSchema?: unknown }[] = [{ name: 'echo' }]) {
  const calls: {
    retain: string[]
    listTools: string[]
    released: number
    changed: (tools: readonly never[]) => void
    invoked: {
      serverName: string; tool: string; args: unknown; owner: unknown
      signal?: AbortSignal
    }[]
  } = { retain: [], listTools: [], released: 0, changed: () => {}, invoked: [] }
  const pool = {
    retain(serverName: string) {
      calls.retain.push(serverName)
      return () => { calls.released += 1 }
    },
    async listTools(serverName: string) {
      calls.listTools.push(serverName)
      return tools
    },
    onToolsChanged(_serverName: string, listener: (next: readonly never[]) => void) {
      calls.changed = listener
      return () => {}
    },
    async callTool(
      serverName: string,
      tool: string,
      args: unknown,
      owner: unknown,
      options?: { signal?: AbortSignal },
    ) {
      calls.invoked.push({
        serverName, tool, args, owner,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      })
      return { content: [{ type: 'text', text: `ok:${tool}` }] }
    },
  }
  return { pool, calls }
}

/** 记录型桩注册面 + 桩上下文。 */
function stubContext(pool: unknown, tools: unknown) {
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
    // 可选服务探测面（`ctx.get` 的桩：本组桩里没有 systemPrompt ⇒ 恒 undefined，
    // 等价于「老宿主不提供该服务」）。真 Context 的语义由 guidance-mount.spec.ts 覆盖。
    get: () => undefined,
  }
  return { ctx, effects, disposers, warnings }
}

function registryStub() {
  const registered = new Map<string, { name: string; description: string; parameters: unknown; output: unknown; execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const disposed: string[] = []
  const failOn: Set<string> = new Set()
  return {
    registered,
    disposed,
    failOn,
    tools: {
      register(definition: { name: string; description: string; parameters: unknown; output: unknown; execute: (args: unknown, exec: unknown) => Promise<unknown> }) {
        if (failOn.has(definition.name)) throw new Error(`squatted: ${definition.name}`)
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name); disposed.push(definition.name) }
      },
    },
  }
}

describe('MCP 代理行：注册与命名', () => {
  it('★ 工具按官方命名注册，description/parameters 原样透传', async () => {
    const { pool } = stubPool([
      { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ])
    const registry = registryStub()
    const { ctx } = stubContext(pool, registry.tools)
    apply(ctx as never, { serverName: 'fake' })
    await tick(10)
    const definition = registry.registered.get('mcp__fake__echo')
    expect(definition).toBeDefined()
    expect(definition?.description).toBe('echo back')
    expect(definition?.parameters).toEqual({ type: 'object', properties: { text: { type: 'string' } } })
    expect(definition?.output).toBeDefined()
  })

  it('超长工具名走官方哈希形态（与池的命名同一实现）', async () => {
    const long = `long_${'x'.repeat(80)}`
    const { pool } = stubPool([{ name: long }])
    const registry = registryStub()
    const { ctx } = stubContext(pool, registry.tools)
    apply(ctx as never, { serverName: 'fake' })
    await tick(10)
    const name = [...registry.registered.keys()][0] ?? ''
    expect(name).toHaveLength(64)
    expect(name.startsWith('mcp__fake__long_')).toBe(true)
  })

  it('配置非法 ⇒ fail loud；服务缺失 / 服务不在注册表 ⇒ warn 且不影响挂载', () => {
    const registry = registryStub()
    expect(() => apply(stubContext(stubPool().pool, registry.tools).ctx as never, { serverName: '' })).toThrow(/serverName is required/)
    // 服务缺失
    const missing = stubContext(undefined, registry.tools)
    expect(() => apply(missing.ctx as never, { serverName: 'fake' })).not.toThrow()
    expect(missing.warnings.join(' ')).toContain('missing')
    // 池拿不住（注册表里没有该服务）
    const throwing = stubContext({ retain: () => { throw new Error('not in the registry') } }, registry.tools)
    expect(() => apply(throwing.ctx as never, { serverName: 'nope' })).not.toThrow()
    expect(throwing.warnings.join(' ')).toContain('not in the registry')
  })
})

describe('MCP 代理行：调用语义', () => {
  it('★ execute 用**原始名**调池（公共名只是模型面），归属取自 exec.agent，signal 透传', async () => {
    const { pool, calls } = stubPool()
    const registry = registryStub()
    const { ctx } = stubContext(pool, registry.tools)
    apply(ctx as never, { serverName: 'fake' })
    await tick(10)
    const definition = registry.registered.get('mcp__fake__echo')
    const controller = new AbortController()
    const value = await definition?.execute({ text: 'hi' }, { agent: { id: 'agent-7', session: { id: 'sess-9' } }, signal: controller.signal })
    expect(value).toEqual({ content: [{ type: 'text', text: 'ok:echo' }] })
    expect(calls.invoked).toHaveLength(1)
    expect(calls.invoked[0]?.tool).toBe('echo')
    expect(calls.invoked[0]?.owner).toEqual({ agentId: 'agent-7', sessionId: 'sess-9' })
    expect(calls.invoked[0]?.signal).toBe(controller.signal)
  })

  it('★ isError ⇒ 抛错（让 ToolRuntime 走失败路径，而不是"成功但内容写着错误"）', async () => {
    const { pool } = stubPool()
    const registry = registryStub()
    const { ctx } = stubContext(pool, registry.tools)
    apply(ctx as never, { serverName: 'fake' })
    await tick(10)
    const definition = registry.registered.get('mcp__fake__echo')
    // 把池的返回值换成 MCP 错误结果
    const failing = { ...pool, callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) }
    const failingCtx = stubContext(failing, registry.tools)
    apply(failingCtx.ctx as never, { serverName: 'fake' })
    await tick(10)
    const failingDefinition = [...registry.registered.values()].find(entry => entry.name === 'mcp__fake__echo')
    await expect(failingDefinition?.execute({}, { agent: { id: 'a' } })).rejects.toThrow(/boom/)
    // 纯函数侧同样钉住
    expect(() => canonicalResultOf({ isError: true, content: [{ type: 'text', text: 'x' }] }, 'echo')).toThrow(/x/)
    expect(canonicalResultOf({ content: [{ type: 'text', text: 'y' }] }, 'echo').content).toHaveLength(1)
    expect(definition).toBeDefined()
  })

  it('ownerOf：没有 agent 时退化为 unknown-agent（拒绝文本仍可读）', () => {
    expect(ownerOf(undefined)).toEqual({ agentId: 'unknown-agent' })
    expect(ownerOf({ agent: { id: 'a1' } })).toEqual({ agentId: 'a1' })
    expect(ownerOf({ agent: { id: '', session: { id: '' } } })).toEqual({ agentId: 'unknown-agent' })
  })
})

describe('MCP 代理行：工具面换代与回滚', () => {
  it('★ 工具表变更 ⇒ 先 dispose 旧一代再注册新一代（同一行内的换代）', async () => {
    // ⚠️ 必须是**同一行**的 listener 被触发才算换代：调两次 `apply` 是挂**两行**，
    // 它们各自持有自己那一代、互不干扰（首版我把这两件事混为一谈，断言因此失败）。
    const state = { tools: [{ name: 'echo' }] as readonly { name: string }[] }
    const listeners: Array<(next: readonly never[]) => void> = []
    const pool = {
      retain: () => () => {},
      listTools: async () => state.tools,
      onToolsChanged: (_serverName: string, listener: (next: readonly never[]) => void) => {
        listeners.push(listener)
        return () => {}
      },
      callTool: async () => ({ content: [] }),
    }
    const registry = registryStub()
    const { ctx } = stubContext(pool, registry.tools)
    apply(ctx as never, { serverName: 'fake' })
    await tick(10)
    expect([...registry.registered.keys()]).toEqual(['mcp__fake__echo'])
    expect(listeners).toHaveLength(1)
    // 服务端换了工具表（去掉 echo、加上 slow），同一行收到变更通知
    state.tools = [{ name: 'slow' }]
    listeners[0]?.(state.tools as never)
    await tick(10)
    expect(registry.disposed).toContain('mcp__fake__echo')
    expect([...registry.registered.keys()]).toEqual(['mcp__fake__slow'])
  })

  it('★ 注册冲突 ⇒ 本次已注册的全部回滚（宁可零工具也不要半代）', async () => {
    const { pool } = stubPool([{ name: 'echo' }, { name: 'slow' }])
    const registry = registryStub()
    registry.failOn.add('mcp__fake__slow')
    const { ctx, warnings } = stubContext(pool, registry.tools)
    apply(ctx as never, { serverName: 'fake' })
    await tick(20)
    expect([...registry.registered.keys()]).not.toContain('mcp__fake__echo')
    expect(warnings.join(' ')).toContain('registration failed')
  })

  it('tools/list 失败 ⇒ 不撤掉已有工具面（池还有重连机会）', async () => {
    const { pool } = stubPool([{ name: 'echo' }])
    const registry = registryStub()
    const { ctx, warnings } = stubContext(pool, registry.tools)
    apply(ctx as never, { serverName: 'fake' })
    await tick(10)
    expect(registry.registered.size).toBe(1)
    const broken = { ...pool, listTools: async () => { throw new Error('connect ECONNREFUSED') } }
    const brokenCtx = stubContext(broken, registry.tools)
    apply(brokenCtx.ctx as never, { serverName: 'fake' })
    await tick(10)
    // 前一代仍在（这次失败没有摘掉它）
    expect([...registry.registered.keys()]).toContain('mcp__fake__echo')
    // 告警要看**这一行**的出口（首版断言的是上一行 ctx 的 warnings ⇒ 空数组，红）
    expect(brokenCtx.warnings.join(' ')).toContain('ECONNREFUSED')
    expect(warnings).toEqual([])
  })

  it('挂载时会 retain，卸载时释放（引用计数交给池）', async () => {
    const { pool, calls } = stubPool()
    const registry = registryStub()
    const { ctx, disposers, effects } = stubContext(pool, registry.tools)
    apply(ctx as never, { serverName: 'fake' })
    await tick(10)
    expect(calls.retain).toEqual(['fake'])
    expect(effects).toContain('corumMcpProxy.retain')
    for (const dispose of disposers) dispose()
    expect(calls.released).toBe(1)
  })
})

describe('MCP 代理行：与真池 + 真子进程的端到端', () => {
  it('★ 授权 → 注册 → 经独占租约调用 → 结果回到模型面', async () => {
    const definitions = new Map<string, McpServerConfig>([
      ['fake', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE] }],
    ])
    const pool = new McpPool({ resolve: name => definitions.get(name), log: () => {} })
    const registry = registryStub()
    const config: McpProxyConfig = { serverName: 'fake' }
    const { ctx } = stubContext(pool, registry.tools)
    // 先让池连上（真实路径里 sync 是 fire-and-forget；测试要确定性）
    await pool.listTools('fake')
    apply(ctx as never, config)
    await tick(50)
    const definition = registry.registered.get('mcp__fake__echo')
    expect(definition).toBeDefined()
    const value = await definition?.execute({ text: 'end-to-end' }, { agent: { id: 'e2e-agent' } })
    const text = (value as { content: readonly { text: string }[] }).content[0]?.text ?? ''
    expect(JSON.parse(text)).toMatchObject({ text: 'end-to-end' })
    // 调用结束后租约已归还（没有把 server 占住）
    expect(pool.snapshot()[0]?.holder).toBeUndefined()
    await pool.disposeAll()
  })
})

describe('池日志出口：CORUM_MCP_POOL_LOG（dev 宿主 ctx.logger 不落盘的替代观测面）', () => {
  it('未设变量 ⇒ 原样走 ctx.logger；设了 ⇒ 同时追加文件', async () => {
    const { poolLogSink } = await import('../src/mcp-pool-service.ts')
    const seen: string[] = []
    const fallback = (level: string, message: string) => { seen.push(`${level}:${message}`) }
    poolLogSink({}, fallback as never)('info', 'no-file')
    expect(seen).toEqual(['info:no-file'])

    const file = join(tmpdir(), `corum-pool-log-${Date.now()}.txt`)
    const sink = poolLogSink({ CORUM_MCP_POOL_LOG: file } as never, fallback as never)
    sink('warn', 'busy: held by agent-A')
    expect(seen).toContain('warn:busy: held by agent-A')
    expect(readFileSync(file, 'utf8')).toContain('busy: held by agent-A')
    rmSync(file, { force: true })
  })
})

describe('首次同步必须是有界 await（2026-09-27 实机竞态：冷启动首回合看不到 MCP 工具）', () => {
  it('★ 返回的 promise 在工具注册完成后才 resolve（挂好即工具在场）', async () => {
    const { pool } = stubPool([{ name: 'echo' }])
    const registry = registryStub()
    const { ctx } = stubContext(pool, registry.tools)
    const applied = apply(ctx as never, { serverName: 'fake' })
    expect(registry.registered.size).toBe(0) // 还没 await
    await applied
    expect([...registry.registered.keys()]).toEqual(['mcp__fake__echo'])
  })

  it('★ 连不上/超时：有界返回且只 warn（绝不让 preset 挂载失败）', async () => {
    const never = {
      retain: () => () => {},
      listTools: () => new Promise(() => {}),
      onToolsChanged: () => () => {},
      callTool: async () => ({ content: [] }),
    }
    const registry = registryStub()
    const { ctx, warnings } = stubContext(never, registry.tools)
    const started = Date.now()
    await apply(ctx as never, { serverName: 'fake', initialSyncTimeoutMs: 120 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(registry.registered.size).toBe(0)
    expect(warnings.join(' ')).toContain('initial sync still running')
  })

  it('apply 永不 reject：listTools 抛错也只 warn', async () => {
    const broken = {
      retain: () => () => {},
      listTools: async () => { throw new Error('ECONNREFUSED') },
      onToolsChanged: () => () => {},
      callTool: async () => ({ content: [] }),
    }
    const registry = registryStub()
    const { ctx, warnings } = stubContext(broken, registry.tools)
    await expect(apply(ctx as never, { serverName: 'fake' })).resolves.toBeUndefined()
    expect(warnings.join(' ')).toContain('ECONNREFUSED')
  })
})
