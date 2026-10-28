/**
 * 阶段 5 ACP 真实 activation 测试（端到端，无 skip）。
 *
 * 用真实的 SubagentManager（corum SubagentRuntime）+ LocalSubprocessRuntime
 * + 官方 ACP provider（通过 corum wrapper 注册）+ mock ACP JSON-RPC server
 * 子进程完成 initialize/session/new/prompt 全链。
 *
 * 断言：
 *   - kind = external（进程边界，inheritsParentContext = false）
 *   - output 返回真实 mock server 推送的文本（通过 session/update notification）
 *   - settlement = completed（stopReason end_turn → completed）
 *   - continuable/options/outputSchema 被拒绝（走真实 manager 的 capabilities 检查）
 *   - permission reject 真实 server 请求 → child aborted
 *   - env scrub：mock server 看不到 MOCK_SECRET，但看到 DSH_HOME（resolveAcpEnv 只传 DSH_HOME）
 *
 * @module @corum/corum-subagent/tests/acp-real-activation.spec
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubagentRuntime from '../src/index.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { externalTestParent, startExternalActivation } from './external-activation-helpers.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER_PATH = resolve(HERE, 'mock-acp-server.mjs')

/**
 * Set up a full cordis context with SubagentRuntime + LocalSubprocessRuntime +
 * the corum ACP wrapper pointed at the mock server.
 *
 * The corum wrapper reads CORUM_HOST_NODE + CORUM_ACP_CLI_PATH from env to
 * resolve the subprocess command/args. We set them to spawn:
 *   node mock-acp-server.mjs --profile acp
 * (the mock server ignores extra args like --profile acp).
 */
async function setupCtx(env: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)

  // Mount the corum ACP wrapper plugin.
  // It reads CORUM_HOST_NODE + CORUM_ACP_CLI_PATH from process.env.
  const { apply: applyCorumAcp } = await import('../src/acp/index.ts')
  applyCorumAcp(ctx, { providerName: 'acp' })

  return ctx
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('ACP real activation — end-to-end via SubagentManager + mock JSON-RPC server', () => {
  let ctx: Context
  let tempDir: string
  let parent: Agent

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'acp-real-test-'))

    // Reset mock server env vars to defaults (prevent test-order contamination)
    delete process.env.MOCK_ACP_OUTPUT
    delete process.env.MOCK_ACP_STOP_REASON
    delete process.env.MOCK_ACP_REQUEST_PERMISSION
    delete process.env.MOCK_ACP_REPORT_ENV
    delete process.env.MOCK_SECRET

    // Env for the corum ACP wrapper: spawn node with mock server as CLI path.
    // args = [MOCK_SERVER_PATH, '--profile', 'acp'] — mock server ignores extra args.
    process.env.CORUM_HOST_NODE = process.execPath
    process.env.CORUM_ACP_CLI_PATH = MOCK_SERVER_PATH
    process.env.DSH_HOME = tempDir
    process.env.CORUM_HOME = tempDir

    ctx = await setupCtx()

    // Register a parent agent (no model driven — external activation only).
    parent = await externalTestParent(ctx)
  })

  afterEach(async () => {
    try { await ctx?.fiber?.dispose() } catch { /* best effort */ }
    delete process.env.CORUM_HOST_NODE
    delete process.env.CORUM_ACP_CLI_PATH
    delete process.env.DSH_HOME
    delete process.env.CORUM_HOME
    delete process.env.MOCK_ACP_OUTPUT
    delete process.env.MOCK_ACP_STOP_REASON
    delete process.env.MOCK_ACP_REQUEST_PERMISSION
    delete process.env.MOCK_ACP_REPORT_ENV
    delete process.env.MOCK_SECRET
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('real ACP activation: initialize → session/new → prompt returns external output', async () => {
    const run = await startExternalActivation(ctx, 'acp', {
      label: 'test-acp-task',
      prompt: [{ type: 'text', text: 'hello' }],
      parent,
      signal: new AbortController().signal,
    })

    // ACP provider has no prepareContinuable → manager uses startExternal path
    // (process boundary, inheritsParentContext = false)
    const result = await run.result
    // stopReason end_turn → completed
    expect(result.stopReason).toBe('completed')
    // output is the text streamed via session/update notification
    expect(text(result.output)).toBe('mock-acp-output')
    // no diagnostic for a clean end_turn
    expect(result.diagnostic).toBeUndefined()

    await run.dispose()
  })

  it('maps max_tokens stop reason', async () => {
    process.env.MOCK_ACP_STOP_REASON = 'max_tokens'

    const run = await startExternalActivation(ctx, 'acp', {
      label: 'test-max-tokens',
      prompt: [{ type: 'text', text: 'p' }],
      parent,
      signal: new AbortController().signal,
    })

    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    expect(text(result.output)).toBe('mock-acp-output')

    await run.dispose()
  })

  it('real ACP provider rejects continuable activation (no prepareContinuable, process boundary)', async () => {
    // The AcpProvider has no prepareContinuable — only one-shot external activation.
    // A reserved childId requires a local backend (prepareContinuable).
    const { SessionId } = await import('@deepseek-ai/dsh-session')
    await expect(
      ctx.subagents.startActivation({
        provider: 'acp',
        label: 'test-continuable',
        childId: SessionId('reserved-child-id'),
        request: {
          prompt: [{ type: 'text', text: 'p' }],
          parent,
        },
        signal: new AbortController().signal,
        delivery: 'caller',
      }),
    ).rejects.toThrow(/local backend|UNSUPPORTED_CAPABILITY/i)
  })

  it('real ACP provider rejects agentOptions (capabilities.agentOptions = false)', async () => {
    // The AcpProvider advertises agentOptions = false.
    // Sending agentOptions must be rejected by the real manager.
    await expect(
      startExternalActivation(ctx, 'acp', {
        label: 'test-options',
        prompt: [{ type: 'text', text: 'p' }],
        parent,
        signal: new AbortController().signal,
        agentOptions: { someOption: true } as any,
      } as any),
    ).rejects.toThrow(/agentOptions|not supported|capability/i)
  })

  it('real ACP provider rejects outputSchema (capabilities.outputSchema = false)', async () => {
    // The AcpProvider advertises outputSchema = false.
    await expect(
      startExternalActivation(ctx, 'acp', {
        label: 'test-schema',
        prompt: [{ type: 'text', text: 'p' }],
        parent,
        signal: new AbortController().signal,
        outputSchema: { type: 'object' } as any,
      } as any),
    ).rejects.toThrow(/outputSchema|not supported|capability/i)
  })

  it('permission reject: real server request_permission → child aborted', async () => {
    process.env.MOCK_ACP_REQUEST_PERMISSION = '1'

    const run = await startExternalActivation(ctx, 'acp', {
      label: 'test-perm-reject',
      prompt: [{ type: 'text', text: 'p' }],
      parent,
      signal: new AbortController().signal,
    })

    const result = await run.result
    // cancelled stop reason → aborted
    expect(result.stopReason).toBe('aborted')
    // diagnostic should carry permission fact
    expect(result.diagnostic).toBeDefined()

    await run.dispose()
  })

  it('env scrub: mock server sees DSH_HOME, does NOT see MOCK_SECRET', async () => {
    // Set a secret in the parent env — resolveAcpEnv must not forward it.
    process.env.MOCK_SECRET = 'should-not-leak'
    process.env.MOCK_ACP_REPORT_ENV = '1'

    const run = await startExternalActivation(ctx, 'acp', {
      label: 'test-env-scrub',
      prompt: [{ type: 'text', text: 'report env' }],
      parent,
      signal: new AbortController().signal,
    })

    const result = await run.result
    const outputText = text(result.output)

    // DSH_HOME must be present (resolveAcpEnv forwards it)
    expect(outputText).toContain('dshHomePresent')
    // The env report JSON should show dshHomePresent:true
    expect(outputText).toMatch(/"dshHomePresent":true/)
    // MOCK_SECRET must NOT be present in the child env
    expect(outputText).toMatch(/"mockSecretPresent":false/)

    await run.dispose()
  })

  it('produces unique child IDs across activations', async () => {
    const run1 = await startExternalActivation(ctx, 'acp', {
      label: 'first',
      prompt: [{ type: 'text', text: 'p' }],
      parent,
      signal: new AbortController().signal,
    })
    await run1.result
    await run1.dispose()

    const run2 = await startExternalActivation(ctx, 'acp', {
      label: 'second',
      prompt: [{ type: 'text', text: 'p' }],
      parent,
      signal: new AbortController().signal,
    })
    expect(run2.childId).not.toBe(run1.childId)
    await run2.result
    await run2.dispose()
  })
})
