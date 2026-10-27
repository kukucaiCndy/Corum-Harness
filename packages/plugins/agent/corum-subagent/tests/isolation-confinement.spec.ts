/**
 * fork（corum）2026-09-22：**隔离写边界门禁真的装上了**（修法 2 的接线断言）。
 *
 * ## 为什么单独一个文件
 *
 * `confinement.spec.ts` 只证「门禁函数本身判得对」；`continuation-inheritance.spec.ts`
 * 只证「沙箱档位被钉对」（修法 1）。**两者都不证「门禁被装进了子会话」**——而这正是
 * `process.prompt.promise-vs-mechanism` 那一类缺陷的经典形态：**说明与实际相反**
 * （提示词承诺了一条机制里不存在的通路）。本次用户核对会话时问的第二个问题
 * （「worktree 的 Agent 为什么还能改 main」）本质上就是这种「以为有边界、实际没有」。
 *
 * 因此本文件用**真实子会话 + 真实 tool 执行**断言：隔离子会话里，越界写被 guard 拒绝、
 * 界内写放行；并且**非隔离子会话不受影响**（门禁不能泄漏给集成者 / track / 普通委派）。
 *
 * 判定形状：不读源码文本（那只能证「写了这行」），而是**真调 `ctx.tools.execute(...)`**
 * 看它是否返回拒绝——工具面的事实来源只有执行结果。
 *
 * @module @corum/corum-subagent/tests/isolation-confinement
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Boot the runtime plus a `write` tool so the child's guard has something real to gate.
 *
 * `workspaceRoot` is set to the temp root, matching the deployment shape where a session's
 * cwd is its workspace-write boundary.
 */
async function setup(script: Script) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  // The registry is mounted by mountAgentLoopTestDependencies since 0.1.5.
  const root = mkdtempSync(join(tmpdir(), 'corum-isolation-confinement-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  // A real mutating tool: the guard's judgment is only observable through execution.
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'write a file',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'written' }],
    },
    execute: () => Promise.resolve({ ok: true }),
  }))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  // 父会话的 cwd = 主工作树（生产形态：委派方的 header.cwd 就是隔离要保护的那棵树）。
  ;(parent.session as { header: unknown }).header = { ...parent.session.header, cwd: root }
  return { ctx, root, parent }
}

/**
 * Run one `write` call through the runtime as `agent` and report the guard's denial reason.
 *
 * ⚠️ 官方 `ToolRuntime` 的 guard 拒绝**不抛异常**：它把拒绝物化成 `isError: true` 的
 * **结果**（`dsh/packages/core/tools/src/index.ts:1520` 的 `post-result` 分支）。首版断言
 * 写成 `expect(throw)`，于是「守卫确实拦下了」被误读成「守卫没生效」——本文件自己踩了一次，
 * 记在这里避免回潮。
 */
async function tryWrite(ctx: Context, agent: Agent, filePath: string): Promise<string | undefined> {
  const result = await ctx.tools.execute({
    callId: ToolCallId('call-1'),
    name: 'write',
    arguments: { file_path: filePath, content: 'x' },
    agent,
    signal: new AbortController().signal,
  })
  const error = (result as { isError?: boolean }).isError === true
  if (!error) return undefined
  const text = (result as { content?: Array<{ type: string; text?: string }> }).content
    ?.map(block => block.text ?? '')
    .join('') ?? ''
  return text
}

/** Start a continuable child and return the live child Agent (before it settles). */
async function startChild(
  ctx: Context,
  parent: Agent,
  request: Record<string, unknown>,
): Promise<Agent> {
  let child: Agent | undefined
  const stop = ctx.on('agent/created', ({ agent }) => {
    if (agent !== parent) child = agent
  })
  const started = await ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'confined child',
    request: { prompt: [{ type: 'text' as const, text: 'go' }], parent, ...request },
    signal: new AbortController().signal,
  })
  // The child is published synchronously at creation; assert that rather than polling.
  const live = ctx.agents.get(started.childId)
  expect(live).toBeDefined()
  stop()
  if (child !== undefined) expect(live).toBe(child)
  return live as Agent
}

describe('隔离子会话的写边界门禁（接线：真的装在子 scope 上）', () => {
  it('★ 隔离子会话：越界写被拒、界内写放行', { timeout: 20_000 }, async () => {
    const { ctx, root, parent } = await setup([textResponse('child done')])
    // 隔离子会话的 cwd = 它自己的 worktree（这里用 root 下的一个真实子目录；机制要求
    // cwd 必须真实存在——`assertChildCwd` fail-fast，见 depth.ts）。
    const worktree = join(root, '.corum-worktrees', 'wt-e2e')
    mkdirSync(worktree, { recursive: true })
    const child = await startChild(ctx, parent, { confinedSandbox: true, cwd: worktree })

    // 界内：相对路径与 worktree 内绝对路径都放行
    expect(await tryWrite(ctx, child, 'src/inside.ts')).toBeUndefined()
    expect(await tryWrite(ctx, child, join(worktree, 'inside.ts'))).toBeUndefined()

    // 越界：主树（root 本身，不是 worktree）被拒
    const denied = await tryWrite(ctx, child, join(root, 'main-tree.ts'))
    expect(denied).toBeDefined()
    expect(denied).toContain('worktree')

    // 越界：兄弟 worktree 也被拒（隔离是「自己的壳」，不是「所有壳」）
    expect(await tryWrite(ctx, child, join(root, '.corum-worktrees', 'wt-other', 'f.ts'))).toBeDefined()
  })

  it('★ 非隔离子会话：门禁不泄漏（集成者/track/普通委派必须能写主树）', { timeout: 20_000 }, async () => {
    const { ctx, root, parent } = await setup([textResponse('child done')])
    // 不传 confinedSandbox ⇒ 不是隔离子会话 ⇒ 装不上门禁。
    const child = await startChild(ctx, parent, {})

    // 主树绝对路径照常放行——这正是集成者 merge + verify 需要的能力。
    expect(await tryWrite(ctx, child, join(root, 'main-tree.ts'))).toBeUndefined()
  })

  it('★ 只读研究子会话（readonlySandbox）：沙箱钉 read-only，且不装写边界门禁', { timeout: 20_000 }, async () => {
    const { ctx, root, parent } = await setup([textResponse('child done')])
    const child = await startChild(ctx, parent, { readonlySandbox: true })

    // 只读性由沙箱 + 工具面 deny 承担；写边界门禁不该参与（它不是隔离语义）。
    // 这里断言沙箱档位，作为「不误装」的可观测判据。
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')
    // 写调用是否被拒由 fs 沙箱决定（此处的 stub 工具不走 fs），故只断言档位——
    // 不断言 execute 结果，避免把「沙箱」与「门禁」两层的断言混为一谈。
    expect(await tryWrite(ctx, child, join(root, 'x.ts'))).toBeUndefined()
  })

  it('★ 门禁随冷恢复重装（descriptor.confined 落盘的用处）', { timeout: 20_000 }, async () => {
    const { ctx, root, parent } = await setup([textResponse('first'), textResponse('resumed')])
    const worktree = join(root, '.corum-worktrees', 'wt-resume')
    mkdirSync(worktree, { recursive: true })
    const child = await startChild(ctx, parent, { confinedSandbox: true, cwd: worktree })
    const childId = child.session.id

    // 先断言「驻留期」门禁生效。
    expect(await tryWrite(ctx, child, join(root, 'main-tree.ts'))).toBeDefined()

    // 让这一轮跑完、Activation 释放（冷恢复的前置）。
    await parent.whenIdle()
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 15_000 })

    // 冷恢复重新物化（composition 从持久化的 descriptor 重建）。sender 必须是**exact
    // live 父 Agent**（机制按身份比对授权，见 continuation.ts 的 UNAUTHORIZED 分支）。
    await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text: 'again' }], {
      signal: new AbortController().signal,
    })
    const live = ctx.agents.get(childId)
    expect(live).toBeDefined()

    // ★ 冷恢复后门禁仍在（`descriptor.confined` 落盘的用处）：越界写照样被拒。
    expect(await tryWrite(ctx, live as Agent, join(root, 'main-tree.ts'))).toBeDefined()
    // 而界内写仍放行（不误伤）。
    expect(await tryWrite(ctx, live as Agent, join(worktree, 'inside.ts'))).toBeUndefined()
  })
})
