/**
 * issue #3 回归：`guidance` 非空 + 宿主不提供 `systemPrompt` 服务时，代理行**不得**
 * 让整个 preset 挂载失败（文件头承诺的 fail-soft）。
 *
 * ## 为什么必须用**真 cordis Context**（本组的意义所在）
 *
 * `tests/proxy.spec.ts` 用的是普通对象桩 ctx：在桩上读一个没提供的服务只会得到
 * `undefined`，于是 `guidable.systemPrompt !== undefined` 这个守卫**看起来是生效的**，
 * 缺陷永远测不出来。真 Context 的代理对未 `inject` 的服务属性会直接抛
 * `cannot get property "systemPrompt" without inject`；而这个读发生在 `if` **条件**里，
 * 紧随其后的 `try/catch` 根本来不及接住 ⇒ `apply()` 同步抛出 ⇒ loader 判该行失败
 * ⇒ `preset "<x>" failed to mount`，Agent 完全打不开（issue #3 的现场）。
 *
 * @module tests/guidance-mount
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/proxy.ts'

/** 注册表指向临时 home（`registry-store` 每次读盘，无缓存）。 */
let home: string
let previousHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-mcp-guidance-'))
  previousHome = process.env.CORUM_HOME
  process.env.CORUM_HOME = home
  writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify({
    servers: [{
      name: 'guided',
      command: 'node',
      args: ['-e', ''],
      guidance: 'call guided.init before guided.run',
    }],
  }))
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** 最小池桩：只满足 apply 的装配面。 */
function stubPool() {
  return {
    retain: () => () => {},
    listTools: async () => [{ name: 'echo' }],
    onToolsChanged: () => () => {},
    callTool: async () => ({ content: [] }),
  }
}

/** 最小工具注册面桩：记录注册名，register 返回 disposer。 */
function stubTools() {
  const registered: string[] = []
  return {
    registered,
    face: {
      register(definition: { name: string }) {
        registered.push(definition.name)
        return () => {}
      },
    },
  }
}

/**
 * 以**生产的挂载形态**组合该行：经 `ctx.plugin` 挂（fiber 才会有 `runtime`，
 * 代理才会走「未 inject 的服务属性直接抛错」那条路——这正是 loader entry 的现场）。
 * 根 Context 直接调 `apply` 测不出：无 runtime 时代理走 `reflect.get(prop, false)`
 * 安全分支，未提供的服务只得到 `undefined`。
 */
async function mountRow(ctx: Context, tools: { registered: string[] }, serverName: string): Promise<unknown> {
  let failure: unknown
  try {
    await ctx.plugin({
      name: 'corum-mcp-proxy-test-row',
      inject: ['corumMcpPool', 'tools'],
      apply: (rowCtx: Context) => { apply(rowCtx, { serverName }) },
    })
  } catch (error: unknown) {
    failure = error
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  return failure
}

describe('issue #3 回归：guidance 与缺失的 systemPrompt 服务', () => {
  it('★ 宿主无 systemPrompt 服务 ⇒ 该行照常挂载（不得抛错）', async () => {
    const tools = stubTools()
    const ctx = new Context()
    ctx.provide('corumMcpPool', stubPool() as never)
    ctx.provide('tools', tools.face as never)
    const failure = await mountRow(ctx, tools, 'guided')
    expect(failure).toBeUndefined()
    // 挂载没被打断：工具照常进入模型面。
    expect(tools.registered).toContain('mcp__guided__echo')
  })

  it('宿主提供 systemPrompt ⇒ guidance 依约注册为一段（能力在时不得静默丢弃）', async () => {
    const tools = stubTools()
    const sections: { name: string; order: number; text: string }[] = []
    const ctx = new Context()
    ctx.provide('corumMcpPool', stubPool() as never)
    ctx.provide('tools', tools.face as never)
    ctx.provide('systemPrompt', {
      section: (options: { name: string; order: number; text: string }) => {
        sections.push(options)
        return () => {}
      },
      getSectionOrder: () => 100,
    } as never)
    const failure = await mountRow(ctx, tools, 'guided')
    expect(failure).toBeUndefined()
    expect(sections).toHaveLength(1)
    expect(sections[0]?.text).toContain('call guided.init before guided.run')
  })
})
