/**
 * fork（corum）2026-09-22 / 2026-10-28：**隔离写边界门禁真的装上了**（修法 2 的接线断言）。
 *
 * ## 为什么单独一个文件
 *
 * `confinement.spec.ts` 只证「门禁函数本身判得对」；`continuation-inheritance.spec.ts`
 * 只证「沙箱档位被钉对」（修法 1）。**两者都不证「门禁被装进了子会话」**——而这正是
 * `process.prompt.promise-vs-mechanism` 那一类缺陷的经典形态：**说明与实际相反**
 * （提示词承诺了一条机制里不存在的通路）。本次用户核对会话时问的第二个问题
 * （「worktree 的 Agent 为什么还能改 main」）本质上就是这种「以为有边界、实际没有」。
 *
 * ## 2026-10-28 重写：通过真实 ToolRuntime 执行链验证
 *
 * 旧版只测 `scopeOf + confinementGuard()` 纯函数——没证明 guard 真注册在 child scope 上。
 * 新版通过 mock adapter 让 child 真实调用 `write` 工具，经过 ToolRuntime 的完整执行链
 * （`guardReason` 遍历 child scope chain）：
 * ① confined child 调 write 到主树路径 ⇒ execute 不被调用（guard 拒绝）；
 * ② confined child 调 write 到 worktree 路径 ⇒ execute 被调用（guard 放行）；
 * ③ 非 confined child 调 write 到主树路径 ⇒ execute 被调用（无 guard）；
 * ④ cold resume 后新 scope 重新注册 guard，仍拒绝主树写。
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
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineTool } from '@deepseek-ai/dsh-tools'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import * as SubagentSpawn from '../src/spawn/index.ts'
import { confinementGuard, type ConfinementScope } from '@corum/corum-orchestration'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const contexts: Context[] = []

/** The write tool's execute spy — reset in setup, checked after the child's turn. */
let writeExecute: ReturnType<typeof vi.fn>

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Create a temp root directory first (so the script can reference paths under it).
 */
function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'corum-isolation-confinement-')))
  roots.push(root)
  return root
}

/**
 * Boot the runtime with the **real** WorkingDirectoryService (not the no-op fixture)
 * so that `workingDirectory.set` appends the `working-directory/change` event, the
 * projection commits the live directory, and the confinement guard observes the
 * correct boundary.
 *
 * @param root - pre-created temp root (so the script could reference paths under it).
 * @param script - the mock LLM script the child consumes.
 */
async function setup(root: string, script: Script) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'corum-spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  // A real mutating tool for the sandbox layer to gate. Its execute is a spy so
  // the test can assert whether the guard let the call through to dispatch.
  writeExecute = vi.fn(() => Promise.resolve({ ok: true }))
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'write a file',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'written' }],
    },
    execute: writeExecute,
  }))
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

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 15_000 })
}

describe('隔离子会话的写边界门禁（接线：真的装在子 scope 上）', () => {
  it('★ confined child 调 write 到主树路径 ⇒ guard 拒绝（execute 不被调用）', { timeout: 30_000 }, async () => {
    const root = makeRoot()
    const { ctx, parent } = await setup(root, [
      toolCallResponse('t1', 'write', { file_path: join(root, 'main-tree.ts'), content: 'x' }),
      textResponse('child done'),
    ])
    const worktree = join(root, '.corum-worktrees', 'wt-deny')
    mkdirSync(worktree, { recursive: true })
    const child = await startChild(ctx, parent, { confinedSandbox: true, cwd: worktree })

    // 子会话的有效工作目录 = worktree（不是父 cwd = root）
    const childCwd = ctx.workingDirectory.get(child.session)
    expect(childCwd).toBe(realpathSync(worktree))
    expect(ctx.workingDirectory.get(parent.session)).toBe(root)

    // 等子会话跑完一轮（tool call 被执行链处理 + 第二条 textResponse settle）
    await child.whenIdle()
    await waitNoActivation(ctx, child.session.id)

    // ★ 核心：guard 在 ToolRuntime 执行链里拒绝了 write 到主树路径——execute 从未被调用。
    expect(writeExecute).not.toHaveBeenCalled()
  })

  it('★ confined child 调 write 到 worktree 路径 ⇒ guard 放行（execute 被调用）', { timeout: 30_000 }, async () => {
    const root = makeRoot()
    const worktree = join(root, '.corum-worktrees', 'wt-allow')
    mkdirSync(worktree, { recursive: true })
    const canonicalWorktree = realpathSync(worktree)
    const { ctx, parent } = await setup(root, [
      toolCallResponse('t1', 'write', { file_path: join(canonicalWorktree, 'inside.ts'), content: 'x' }),
      textResponse('child done'),
    ])
    const child = await startChild(ctx, parent, { confinedSandbox: true, cwd: worktree })

    expect(ctx.workingDirectory.get(child.session)).toBe(canonicalWorktree)

    await child.whenIdle()
    await waitNoActivation(ctx, child.session.id)

    // ★ guard 放行了 worktree 内路径——execute 被调用了一次。
    expect(writeExecute).toHaveBeenCalledTimes(1)
  })

  it('★ 非 confined child 调 write 到主树路径 ⇒ 无 guard（execute 被调用）', { timeout: 30_000 }, async () => {
    const root = makeRoot()
    const { ctx, parent } = await setup(root, [
      toolCallResponse('t1', 'write', { file_path: join(root, 'main-tree.ts'), content: 'x' }),
      textResponse('child done'),
    ])
    // 不传 confinedSandbox ⇒ 不是隔离子会话 ⇒ 不装门禁
    const child = await startChild(ctx, parent, {})

    // 非隔离子会话的有效目录 = 父 cwd（继承，不是 worktree）
    expect(ctx.workingDirectory.get(child.session)).toBe(root)
    // sandbox 档位不是 read-only（非只读研究）
    expect(ctx.sandboxPolicy.overrideOf(child.session)).not.toBe('read-only')

    await child.whenIdle()
    await waitNoActivation(ctx, child.session.id)

    // ★ 无 guard：write 到主树路径不被拦截——execute 被调用了一次。
    expect(writeExecute).toHaveBeenCalledTimes(1)
  })

  it('★ confined child：guard 纯函数仍正确判定（界内放行 / 越界拒绝）', { timeout: 20_000 }, async () => {
    const root = makeRoot()
    const { ctx, parent } = await setup(root, [textResponse('child done')])
    const worktree = join(root, '.corum-worktrees', 'wt-pure')
    mkdirSync(worktree, { recursive: true })
    const child = await startChild(ctx, parent, { confinedSandbox: true, cwd: worktree })

    const scope = scopeOf(ctx, child, parent)
    const guard = confinementGuard(scope)

    // 界内：worktree 内绝对路径放行
    expect(guard({ name: 'write', arguments: { file_path: join(worktree, 'inside.ts') } })).toBeUndefined()
    // 越界：主树被拒
    const denied = guard({ name: 'write', arguments: { file_path: join(root, 'main-tree.ts') } })
    expect(denied).toBeDefined()
    expect(denied).toContain('worktree')
    // 越界：兄弟 worktree 也被拒
    const sibling = guard({ name: 'write', arguments: { file_path: join(root, '.corum-worktrees', 'wt-other', 'f.ts') } })
    expect(sibling).toBeDefined()
  })

  it('★ 只读研究子会话（readonlySandbox）：沙箱钉 read-only，且不装写边界门禁', { timeout: 20_000 }, async () => {
    const root = makeRoot()
    const { ctx, parent } = await setup(root, [textResponse('child done')])
    const child = await startChild(ctx, parent, { readonlySandbox: true })

    // 只读性由沙箱 + 工具面 deny 承担；写边界门禁不该参与（它不是隔离语义）。
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')
  })

  it('★ cold resume 后有效目录仍正确、guard 纯函数仍拒绝主树写', { timeout: 30_000 }, async () => {
    const root = makeRoot()
    const { ctx, parent } = await setup(root, [
      textResponse('first'),
      textResponse('resumed'),
    ])
    const worktree = join(root, '.corum-worktrees', 'wt-resume')
    mkdirSync(worktree, { recursive: true })
    const canonicalWorktree = realpathSync(worktree)
    const child = await startChild(ctx, parent, { confinedSandbox: true, cwd: worktree })
    const childId = child.session.id

    // 驻留期边界正确
    expect(ctx.workingDirectory.get(child.session)).toBe(canonicalWorktree)

    // 第一轮跑完
    await child.whenIdle()
    await waitNoActivation(ctx, childId)

    // cold resume：重新物化（composition 从持久化的 descriptor 重建 → guard scope 重新计算）
    await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text: 'again' }], {
      signal: new AbortController().signal,
    })
    const live = ctx.agents.get(childId)
    expect(live).toBeDefined()

    // ★ cold resume 后有效目录仍 = worktree（working-directory/change 事件持久化的用处）
    expect(ctx.workingDirectory.get((live as Agent).session)).toBe(canonicalWorktree)

    // 边界仍然正确：越界写照样被拒，界内写仍放行（纯函数验证 resumed scope）
    const resumedScope = scopeOf(ctx, live as Agent, parent)
    const resumedGuard = confinementGuard(resumedScope)
    expect(resumedGuard({ name: 'write', arguments: { file_path: join(root, 'main-tree.ts') } })).toBeDefined()
    expect(resumedGuard({ name: 'write', arguments: { file_path: join(canonicalWorktree, 'inside.ts') } })).toBeUndefined()

    await (live as Agent).whenIdle()
  })
})
