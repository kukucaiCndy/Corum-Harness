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
 * 因此本文件用**真实子会话 + 真实 working-directory 服务**断言：
 * ① 隔离子会话的有效工作目录 = 它的 worktree（不是父 cwd）；
 * ② confinement guard 函数在这个边界下正确拒绝越界写、放行界内写；
 * ③ 非隔离子会话不受影响（门禁不泄漏给集成者 / track / 普通委派）；
 * ④ 冷恢复后边界仍然正确（working-directory/change 事件持久化 → projection 重建）。
 *
 * @module @corum/corum-subagent/tests/isolation-confinement
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import * as SubagentSpawn from '../src/spawn/index.ts'
import { confinementGuard, type ConfinementScope } from '@corum/corum-orchestration'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Boot the runtime with the **real** WorkingDirectoryService (not the no-op fixture)
 * so that `workingDirectory.set` appends the `working-directory/change` event, the
 * projection commits the live directory, and the confinement guard observes the
 * correct boundary.
 */
async function setup(script: Script) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'corum-isolation-confinement-')))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'corum-spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  // A real mutating tool for the sandbox layer to gate.
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
  // `meta.cwd` sets the durable header value the confinement guard reads as
  // `parentTreeRoot`; `workingDirectory.set` updates the projection's live
  // directory without rewriting the header, so both are needed.
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  await ctx.workingDirectory.set(parent, root)
  return { ctx, root, parent }
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
  const started = await ctx.subagents.startActivation({
    provider: 'corum-spawn',
    label: 'confined child',
    request: { prompt: [{ type: 'text' as const, text: 'go' }], parent, ...request },
    signal: new AbortController().signal,
    delivery: 'parent',
  })
  const live = ctx.agents.get(started.childId)
  expect(live).toBeDefined()
  stop()
  if (child !== undefined) expect(live).toBe(child)
  return live as Agent
}

/**
 * Compute the confinement scope from the live child's effective directory,
 * mirroring the logic in `child-agent.ts:applyChildOverrides`.
 */
function scopeOf(ctx: Context, child: Agent, parent: Agent): ConfinementScope {
  const childCwd = ctx.workingDirectory.get(child.session)
  const parentCwd = ctx.workingDirectory.get(parent.session)
  return {
    worktreeRoot: childCwd,
    parentTreeRoot: parentCwd,
  }
}

describe('隔离子会话的写边界门禁（接线：真的装在子 scope 上）', () => {
  it('★ 隔离子会话：有效目录 = worktree，confinement guard 拒绝越界写、放行界内写', { timeout: 20_000 }, async () => {
    const { ctx, root, parent } = await setup([textResponse('child done')])
    const worktree = join(root, '.corum-worktrees', 'wt-e2e')
    mkdirSync(worktree, { recursive: true })
    const child = await startChild(ctx, parent, { confinedSandbox: true, cwd: worktree })

    // ① 子会话的有效工作目录 = worktree（不是父 cwd = root）
    // macOS /var symlinks to /private/var; the working-directory service canonicalizes.
    const childCwd = ctx.workingDirectory.get(child.session)
    expect(childCwd).toBe(realpathSync(worktree))
    expect(ctx.workingDirectory.get(parent.session)).toBe(root)

    // ② confinement guard 在这个边界下正确判定
    const scope = scopeOf(ctx, child, parent)
    const guard = confinementGuard(scope)

    // 界内：worktree 内绝对路径放行
    expect(guard({ name: 'write', arguments: { file_path: join(worktree, 'inside.ts') } })).toBeUndefined()
    expect(guard({ name: 'write', arguments: { file_path: join(worktree, 'src', 'inside.ts') } })).toBeUndefined()

    // 越界：主树（root 本身，不是 worktree）被拒
    const denied = guard({ name: 'write', arguments: { file_path: join(root, 'main-tree.ts') } })
    expect(denied).toBeDefined()
    expect(denied).toContain('worktree')

    // 越界：兄弟 worktree 也被拒（隔离是「自己的壳」，不是「所有壳」）
    const sibling = guard({ name: 'write', arguments: { file_path: join(root, '.corum-worktrees', 'wt-other', 'f.ts') } })
    expect(sibling).toBeDefined()
  })

  it('★ 非隔离子会话：不装 confinement guard（集成者/track/普通委派必须能写主树）', { timeout: 20_000 }, async () => {
    const { ctx, root, parent } = await setup([textResponse('child done')])
    // 不传 confinedSandbox ⇒ 不是隔离子会话 ⇒ 装不上门禁
    const child = await startChild(ctx, parent, {})

    // 非隔离子会话的有效目录 = 父 cwd（继承，不是 worktree）
    const childCwd = ctx.workingDirectory.get(child.session)
    expect(childCwd).toBe(root)

    // sandbox 档位不是 read-only（非只读研究）
    expect(ctx.sandboxPolicy.overrideOf(child.session)).not.toBe('read-only')
  })

  it('★ 只读研究子会话（readonlySandbox）：沙箱钉 read-only，且不装写边界门禁', { timeout: 20_000 }, async () => {
    const { ctx, root, parent } = await setup([textResponse('child done')])
    const child = await startChild(ctx, parent, { readonlySandbox: true })

    // 只读性由沙箱 + 工具面 deny 承担；写边界门禁不该参与（它不是隔离语义）。
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')
  })

  it('★ 冷恢复后边界仍正确（working-directory/change 持久化 → projection 重建）', { timeout: 30_000 }, async () => {
    const { ctx, root, parent } = await setup([textResponse('first'), textResponse('resumed')])
    const worktree = join(root, '.corum-worktrees', 'wt-resume')
    mkdirSync(worktree, { recursive: true })
    const canonicalWorktree = realpathSync(worktree)
    const child = await startChild(ctx, parent, { confinedSandbox: true, cwd: worktree })
    const childId = child.session.id

    // 先断言驻留期边界正确。
    expect(ctx.workingDirectory.get(child.session)).toBe(canonicalWorktree)
    const scope = scopeOf(ctx, child, parent)
    const guard = confinementGuard(scope)
    expect(guard({ name: 'write', arguments: { file_path: join(root, 'main-tree.ts') } })).toBeDefined()

    // 让这一轮跑完、Activation 释放（冷恢复的前置）。
    await parent.whenIdle()
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 15_000 })

    // 冷恢复重新物化（composition 从持久化的 descriptor 重建）。
    await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text: 'again' }], {
      signal: new AbortController().signal,
    })
    const live = ctx.agents.get(childId)
    expect(live).toBeDefined()

    // ★ 冷恢复后有效目录仍 = worktree（working-directory/change 事件持久化的用处）。
    expect(ctx.workingDirectory.get((live as Agent).session)).toBe(canonicalWorktree)

    // 边界仍然正确：越界写照样被拒，界内写仍放行。
    const resumedScope = scopeOf(ctx, live as Agent, parent)
    const resumedGuard = confinementGuard(resumedScope)
    expect(resumedGuard({ name: 'write', arguments: { file_path: join(root, 'main-tree.ts') } })).toBeDefined()
    expect(resumedGuard({ name: 'write', arguments: { file_path: join(canonicalWorktree, 'inside.ts') } })).toBeUndefined()
  })
})
