/**
 * 阶段 5 ACP 能力拒绝测试：通过 wrapper 注册真实官方 AcpProvider，
 * 拦截 registerProvider 调用以从真实 provider 实例读 capabilities。
 * 不自造常量——从真实注册的 AcpProvider 实例读。
 *
 * @module @corum/corum-subagent/tests/acp-capability-rejection.spec
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { SubagentProvider } from '../src/types.ts'

/**
 * 创建一个 fake ctx，其 ctx.subagents.registerProvider 捕获真实 AcpProvider
 * 实例。apply() 不需要完整 cordis context——它只调 ctx.subagents.registerProvider
 * + assertPositiveFinite（纯 config 校验）。
 */
function createCapturingCtx(): { ctx: object; captured: () => SubagentProvider | undefined } {
  let provider: SubagentProvider | undefined
  const ctx = {
    subagents: {
      registerProvider(p: SubagentProvider): () => void {
        provider = p
        return () => { provider = undefined }
      },
    },
    // AcpProvider constructor stores ctx but doesn't call anything at construction.
    // apply() calls assertPositiveFinite (pure) then registerProvider.
    logger: { warn: vi.fn() },
  }
  return { ctx, captured: () => provider }
}

describe('ACP capability rejection — real AcpProvider instance', () => {
  beforeEach(() => {
    process.env.CORUM_HOST_NODE = '/usr/local/bin/node'
    process.env.CORUM_ACP_CLI_PATH = '/path/to/dsh/lib/bin.js'
    process.env.DSH_HOME = '/tmp/test-dsh-home'
    process.env.CORUM_HOME = '/tmp/test-corum-home'
  })

  afterEach(() => {
    delete process.env.CORUM_HOST_NODE
    delete process.env.CORUM_ACP_CLI_PATH
    delete process.env.DSH_HOME
    delete process.env.CORUM_HOME
  })

  it('registers a real AcpProvider with name "acp"', async () => {
    const { ctx, captured } = createCapturingCtx()
    const { apply } = await import('../src/acp/index.ts')
    apply(ctx, { providerName: 'acp' })
    const provider = captured()
    expect(provider).toBeDefined()
    expect(provider!.name).toBe('acp')
  })

  it('advertises agentOptions = false', async () => {
    const { ctx, captured } = createCapturingCtx()
    const { apply } = await import('../src/acp/index.ts')
    apply(ctx, { providerName: 'acp' })
    expect(captured()!.capabilities.agentOptions).toBe(false)
  })

  it('advertises agentPreset = false', async () => {
    const { ctx, captured } = createCapturingCtx()
    const { apply } = await import('../src/acp/index.ts')
    apply(ctx, { providerName: 'acp' })
    expect(captured()!.capabilities.agentPreset).toBe(false)
  })

  it('advertises outputSchema = false', async () => {
    const { ctx, captured } = createCapturingCtx()
    const { apply } = await import('../src/acp/index.ts')
    apply(ctx, { providerName: 'acp' })
    expect(captured()!.capabilities.outputSchema).toBe(false)
  })

  it('advertises depthLimit = false', async () => {
    const { ctx, captured } = createCapturingCtx()
    const { apply } = await import('../src/acp/index.ts')
    apply(ctx, { providerName: 'acp' })
    expect(captured()!.capabilities.depthLimit).toBe(false)
  })

  it('does not inherit parent context (process boundary)', async () => {
    const { ctx, captured } = createCapturingCtx()
    const { apply } = await import('../src/acp/index.ts')
    apply(ctx, { providerName: 'acp' })
    expect(captured()!.inheritsParentContext).toBe(false)
  })

  it('has no prepareContinuable (one-shot external activation only)', async () => {
    const { ctx, captured } = createCapturingCtx()
    const { apply } = await import('../src/acp/index.ts')
    apply(ctx, { providerName: 'acp' })
    const provider = captured() as SubagentProvider & { prepareContinuable?: unknown }
    expect(provider.prepareContinuable).toBeUndefined()
  })

  it('start() is a function (external activation path)', async () => {
    const { ctx, captured } = createCapturingCtx()
    const { apply } = await import('../src/acp/index.ts')
    apply(ctx, { providerName: 'acp' })
    const provider = captured()
    expect(typeof provider!.start).toBe('function')
  })
})
