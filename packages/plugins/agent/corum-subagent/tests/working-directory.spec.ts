/**
 * fork（corum）2026-10-27：移植官方 `working-directory.spec.ts`（rc3）。
 *
 * 使用真实 `WorkingDirectoryService`（`mountAgentLoopTestDependencies` 的
 * `{ workingDirectory: true }` 选项），验证子会话工作目录的继承、显式设置、
 * 冷恢复持久化三条官方能力面。与官方测试同构，断言采用 fork 真实 provider 名。
 *
 * @module @corum/corum-subagent/tests/working-directory.spec
 */

import { startTestActivation } from './local-activation.ts'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Spawn from '../src/spawn/index.ts'
import * as Fork from '../src/fork/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'corum-child-directory-'))
  const origin = join(root, 'origin')
  const first = join(origin, 'first')
  const second = join(origin, 'second')
  await mkdir(first, { recursive: true })
  await mkdir(second)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  const adapter = new MockAdapter([textResponse('parent'), textResponse('child'), textResponse('continued')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent: parent } = await ctx.agents.create({
    sessionId: SessionId('directory-parent'),
    meta: { cwd: origin },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, parent, origin, first, second, adapter }
}

describe('subagent working directories', () => {
  it.each(['spawn', 'fork'])('%s inherits current directory independently of origin and inherited history', async (provider) => {
    const { ctx, parent, origin, first, second } = await fixture()
    await ctx.workingDirectory.set(parent, first)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'record first directory' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const selected = await ctx.workingDirectory.set(parent, second)
    const run = await startTestActivation(ctx, provider, {
      parent, prompt: [{ type: 'text', text: 'child' }], signal: new AbortController().signal,
    })
    await run.result
    const child = run.localAgent
    expect(child.session.header.cwd).toBe(origin)
    expect(ctx.workingDirectory.get(child.session)).toBe(selected)
    await ctx.workingDirectory.set(parent, first)
    expect(ctx.workingDirectory.get(child.session)).toBe(selected)
    await run.dispose()
  })

  // fork（corum）：官方测试用 relative + absolute 两种形态；fork 的 `assertChildCwd`
  // 拒绝非绝对路径（隔离 confine 路径的安全校验），所以只测 absolute 形态——relative
  // 路径由 `resolveDirectory` 在解析后等价，但被 `assertChildCwd` 在解析前拒绝。
  it('retains an explicit absolute directory when a continuable child cold-resumes', async () => {
    const { ctx, parent, origin, first, second } = await fixture()
    const selected = await realpath(second)
    const started = await ctx.subagents.startActivation({
      delivery: 'caller',
      provider: 'spawn', label: 'directory child',
      request: { parent, cwd: second, prompt: [{ type: 'text', text: 'child' }] },
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
    await ctx.workingDirectory.set(parent, first)
    await ctx.subagents.sendMessage(parent, started.childId, [{ type: 'text', text: 'continue' }], {
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
    using observed = await ctx.sessionQuery.observeSession(started.childId)
    expect(observed.header.cwd).toBe(origin)
    const last = observed.events.findLast(event => event.type === 'working-directory/change')
    expect(last?.data).toMatchObject({ cwd: selected })
  })

  it('rolls back a local child whose setup realm has no directory service', async () => {
    const { ctx, parent, second, adapter } = await fixture()
    const beforeSessions = ctx.sessions.list().length
    const childId = SessionId('missing-directory-service')
    const create = ctx.agents.create.bind(ctx.agents)
    const creation = vi.spyOn(ctx.agents, 'create').mockImplementation(options => create({
      ...options,
      setup: (childCtx, child) => options.setup?.(childCtx.isolate('workingDirectory'), child),
    }))
    try {
      await expect(ctx.subagents.startActivation({
        delivery: 'caller',
        provider: 'spawn', label: 'unavailable directory service', childId,
        request: { parent, cwd: second, prompt: [{ type: 'text', text: 'child' }] },
        signal: new AbortController().signal,
      })).rejects.toThrow(/subagents require the working-directory service/)

      expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
      expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toEqual([])
      expect(ctx.sessions.list()).toHaveLength(beforeSessions)
      expect(adapter.requests).toEqual([])
    } finally {
      creation.mockRestore()
    }
  })
})
