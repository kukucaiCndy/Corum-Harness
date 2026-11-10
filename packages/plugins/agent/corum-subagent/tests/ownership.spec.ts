/**
 * fork（corum）2026-10-19：**子 Agent 的运行期归属（owner）必须成立**。
 *
 * ## 为什么单独一个文件
 *
 * 这是一处**静默的语义漂移**，不是功能缺失：官方在 `0b8956aab9`
 * （refactor(agent): move runtime parent into options，2026-09-02）把 owner 从
 * 「loop 隐式取 `ownerCtx.agent`」改为「读 `options.parentAgent`」。本 fork 建在
 * `dsh-v0.1.3-alpha.1`（该提交**晚于**此 tag），基线里本就没有这个字段；升级
 * 0.1.5 时未跟改——而它是**可选字段**，编译器不报错，`fork-drift` 又只校验
 * 「corum 增量在不在」，于是整条链路上没有任何一处会红。
 *
 * ## 缺陷形态（issue #75 实测）
 *
 * `driver/index.ts` 漏传 `parentAgent` ⇒ `entry.owner === undefined` ⇒
 * `agents.roots()` 把**子 Agent 也当成顶层 Agent**。连锁后果：
 *
 *   1. `userQuestions.ask()` 的 `DELEGATED_CALLER` 门禁放行（官方那条
 *      `if (!agents.roots().includes(agent)) throw` 永远是 false）；
 *   2. 提问请求落到 **scope 在子会话** 的 `user-questions/request` waterfall 上，
 *      客户端按会话渲染提问卡片 ⇒ 子会话不可视 ⇒ **没有任何地方会出现卡片**；
 *   3. 前台委派下父 Agent `await run.result` ⇒ 父 Agent 一起挂死。
 *
 * 实测（会话 `f185c1b9`，父 `corum-task-d98d67b6`）：一次 `ask_user_question`
 * 从提交到返回 `ASK_ABORTED` 历时 **517 秒**，且 abort 完全来自用户手动点停止
 * （`turn/end reason = {kind:'aborted', reason:{kind:'parent'}}`）——不点就是永久等待。
 *
 * ## 判据形状
 *
 * 不读源码文本（那只能证「写了这行」），而是**真的起一个子 Agent，查 registry 的
 * 三个运行期事实**：`isOwnedBy`、`roots()`、以及官方的 `DELEGATED_CALLER` 是否
 * 真的抛出。第三个是端到端判据：它同时覆盖 owner、`roots()` 与 ask 门禁三环。
 *
 * @module @corum/corum-subagent/tests/ownership
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import * as CorumSpawn from '../src/spawn/index.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the runtime with a real AgentLoop so the registry is the production one. */
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'corum-subagent-ownership-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  // ⚠️ 必须挂 **corum 的** spawn provider：官方 spawn 走官方 manager，那条路径
  // 一直传 `parentAgent`（无缺陷）。缺陷在 corum 自己的 one-shot driver，
  // 只有 `corum-spawn` 才会经过它——挂错 provider 会让本文件假绿。
  await ctx.plugin(CorumSpawn, { providerName: 'corum-spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('child done')]))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, root, parent }
}

/**
 * Start one one-shot (non-continuable) child — the path issue #75 was reported on.
 *
 * ⚠️ 断言必须在**存活期**做：`run.dispose()` 会把子 Agent 从 registry 移除，
 * 之后 `isOwnedBy` / `roots()` 都只能看到「它不在了」，无法区分「有 owner 但已销毁」
 * 与「从来没被赋 owner」——本文件首版就是这样假绿的。故 helper 只负责 start，
 * 断言与清理都交给调用方按顺序做。
 */
async function startOneShotChild(ctx: Context, parent: Agent) {
  let created: Agent | undefined
  const stop = ctx.on('agent/created', ({ agent }) => {
    if (agent !== parent) created = agent
  })
  const run = await ctx.subagents.startActivation({
    provider: 'corum-spawn',
    label: 'one-shot child',
    request: {
      prompt: [{ type: 'text' as const, text: 'go' }],
      parent,
    },
    signal: new AbortController().signal,
    delivery: 'caller',
  })
  stop()
  const live = ctx.agents.get(run.childId)
  expect(live, 'one-shot child was not published').toBeDefined()
  // The created-listener must have observed the same instance the registry holds.
  if (created !== undefined) expect(live).toBe(created)
  return { run, child: live as Agent }
}

/** Settle and dispose a fixture run so no live child outlives its test. */
async function settle(ctx: Context, fixture: Awaited<ReturnType<typeof startOneShotChild>>): Promise<void> {
  await fixture.run.result.catch(() => undefined)
  await fixture.run.dispose().catch(() => undefined)
}

describe('子 Agent 的运行期归属（owner）', () => {
  it('★ one-shot 子 Agent 不是 root：isOwnedBy 成立、roots() 不含它', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup()
    const fixture = await startOneShotChild(ctx, parent)
    const child = fixture.child

    // ① owner 关系：这是 `options.parentAgent` 是否真的传下去的直接判据。
    expect(
      ctx.agents.isOwnedBy(child.id, parent),
      'child is not owned by its parent — driver/index.ts dropped options.parentAgent',
    ).toBe(true)

    // ② 顶层口径：子 Agent 不该被当成 root。
    const rootIds = ctx.agents.roots().map(agent => String(agent.id))
    expect(rootIds).toContain(String(parent.id))
    expect(
      rootIds,
      'child appears in roots() — it will bypass every root-only guard (DELEGATED_CALLER, goal authority)',
    ).not.toContain(String(child.id))

    // ③ 控制组：父 Agent 自己必须是 root（否则本文件证不出「子 Agent 是异常的那一方」）。
    expect(rootIds).toContain(String(parent.id))

    await settle(ctx, fixture)
  })

  it('★★ 官方的 ask 委派门禁判定式对子 Agent 必须为「拒绝」', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup()
    const fixture = await startOneShotChild(ctx, parent)
    const child = fixture.child

    // 本包不依赖 `@deepseek-ai/dsh-user-questions`（server 实现），故不在此起 UI 栈；
    // 改为直接断言**官方那道门禁所用的同一个判定式**：
    //
    //   packages/interaction/user-questions/src/index.ts:101-106
    //   if (!agents.roots().includes(agent)) throw new UserQuestionError(..., 'DELEGATED_CALLER')
    //
    // 判据与实现同源（`agents.roots()`），因此「本断言为拒绝」⇔「ask() 会抛
    // DELEGATED_CALLER」。这比文本扫描强：它跑的是真实 registry 状态。
    const askWouldBeDelegated = (agent: Agent): boolean => !ctx.agents.roots().includes(agent)
    expect(
      askWouldBeDelegated(child),
      'ask() would be ALLOWED for this child — its question then lands on a subagent-scoped '
      + 'waterfall nobody renders, hanging the foreground parent forever (issue #75)',
    ).toBe(true)
    // 控制组：同一个判定式对父 Agent 必须是「放行」，否则本断言沦为恒真。
    expect(askWouldBeDelegated(parent)).toBe(false)

    await settle(ctx, fixture)
  })
})
