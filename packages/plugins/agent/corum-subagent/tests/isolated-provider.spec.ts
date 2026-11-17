/**
 * corum isolated provider 单测（`@corum/corum-subagent/isolated`，2026-09-10）。
 *
 * 背景：`orchestrate` 的 script 模式把脚本交给官方 workflow 引擎执行，引擎里的
 * `agent()` **不经过 corum 工具层**——本 provider 把隔离机制搬到 provider 层，让
 * 脚本子会话也建 worktree + 进台账。本 spec 用假编排服务锁定可测内核
 * （`prepareIsolatedChild`）的四件事：
 *   1. 建 worktree 并把 `cwd` 指向它；
 *   2. prompt 前缀注入隔离纪律（与工具层同一文本）；
 *   3. start 成功后 `bindRunId`（settle 精确匹配）；
 *   4. start 失败后 `discardEntry`（否则台账留下永不结算的 active 条目）。
 * 端到端（真实 worktree + 隔离子会话）由 dev 实例实机验证覆盖。
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedSubagentStartRequest } from '../src/index.ts'
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { Config, prepareIsolatedChild, prepareTrackedChild, resolveEffectiveMode } from '../src/isolated/index.ts'

const scratch = mkdtempSync(join(tmpdir(), 'corum-isolated-spec-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

interface Call { readonly kind: string; readonly args: readonly unknown[] }

/** 假编排服务：记录 createWorktreeChild / bindRunId / discardEntry 的调用。 */
function fakeContext(calls: Call[]): Context {
  const ctx = new Context()
  const root = {
    get: (name: string): unknown => name === 'corumOrchestration'
      ? {
          createWorktreeChild: (sessionId: string, parentCwd: string, options: unknown) => {
            calls.push({ kind: 'create', args: [sessionId, parentCwd, options] })
            return { slug: 'wt-spec01', branch: 'wt/wt-spec01', path: '/repo/.corum-worktrees/wt-spec01' }
          },
          bindRunId: (sessionId: string, slug: string, runId: string) => { calls.push({ kind: 'bind', args: [sessionId, slug, runId] }) },
          discardEntry: (sessionId: string, slug: string) => { calls.push({ kind: 'discard', args: [sessionId, slug] }) },
          beginWriteChild: (sessionId: string) => { calls.push({ kind: 'begin', args: [sessionId] }) },
          endWriteChild: (sessionId: string) => { calls.push({ kind: 'end', args: [sessionId] }) },
        }
      : undefined,
  }
  ;(ctx as unknown as { root: unknown }).root = root
  return ctx
}

function request(): ResolvedSubagentStartRequest {
  return {
    parent: {
      session: { id: 'session-parent', header: { cwd: '/repo' } },
    } as unknown as Agent,
    prompt: [{ type: 'text', text: 'do the thing' }],
    label: 'spec',
    signal: new AbortController().signal,
  } as unknown as ResolvedSubagentStartRequest
}

describe('prepareIsolatedChild — workflow 脚本子会话的隔离内核', () => {
  it('建 worktree 并把请求 cwd 指向它（父会话 cwd 作为基准）', () => {
    const calls: Call[] = []
    const prepared = prepareIsolatedChild(fakeContext(calls), request(), Config({} as never))
    expect(calls[0]?.kind).toBe('create')
    expect(calls[0]?.args[0]).toBe('session-parent')
    expect(calls[0]?.args[1]).toBe('/repo')
    expect(prepared.request.cwd).toBe('/repo/.corum-worktrees/wt-spec01')
  })

  it('prompt 前缀注入隔离纪律（与工具层同一文本）', () => {
    const prepared = prepareIsolatedChild(fakeContext([]), request(), Config({} as never))
    const text = prepared.request.prompt.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('[corum isolation]')
    expect(text).toContain('branch wt/wt-spec01')
    expect(text).toContain('RELATIVE path only')
    expect(text).toContain('write-denied by the sandbox')
    expect(text.endsWith('do the thing')).toBe(true)
  })

  it('bind(runId) 绑定台账条目；rollback() 回滚', () => {
    const calls: Call[] = []
    const prepared = prepareIsolatedChild(fakeContext(calls), request(), Config({} as never))
    prepared.bind('run-42')
    prepared.rollback()
    expect(calls.map(call => call.kind)).toEqual(['create', 'bind', 'discard'])
    expect(calls[1]?.args).toEqual(['session-parent', 'wt-spec01', 'run-42'])
    expect(calls[2]?.args).toEqual(['session-parent', 'wt-spec01'])
  })

  it('缺 corumOrchestration 服务时 fail loud（不静默降级成不隔离）', () => {
    const ctx = new Context()
    ;(ctx as unknown as { root: unknown }).root = { get: () => undefined }
    expect(() => prepareIsolatedChild(ctx, request(), Config({} as never))).toThrow(/corumOrchestration/)
  })

  it('默认配置：provider 名 corum-isolated、mode always、并发上限 8', () => {
    const config = Config({} as never)
    expect(config.providerName).toBe('corum-isolated')
    expect(config.mode).toBe('always')
    expect(config.maxParallelChildren).toBe(8)
  })
})

describe('prepareTrackedChild — ralph 的「不隔离但计数」内核（2026-09-10 用户「ralph 一并纳入」）', () => {
  it('登记「在跑写子 Agent」但不建 worktree（ralph 每轮必须看到上一轮改动）', () => {
    const calls: Call[] = []
    const tracked = prepareTrackedChild(fakeContext(calls), request())
    expect(calls.map(call => call.kind)).toEqual(['begin'])
    expect(tracked.request.cwd).toBeUndefined()
    // 只注入直连纪律，不注入隔离通知。
    const text = tracked.request.prompt.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('[corum orchestration]')
    // 2026-09-27 P2：按原因参数化后命令带反引号；意图不变（不许碰版本控制）。
    expect(text).toContain('do NOT run `git add` / `commit`')
    expect(text).not.toContain('[corum isolation]')
    expect(text.endsWith('do the thing')).toBe(true)
  })

  it('release() 注销计数且幂等（settle 与失败路径都安全）', () => {
    const calls: Call[] = []
    const tracked = prepareTrackedChild(fakeContext(calls), request())
    tracked.release()
    tracked.release()
    expect(calls.map(call => call.kind)).toEqual(['begin', 'end'])
    expect(calls[1]?.args).toEqual(['session-parent'])
  })

  it('缺 corumOrchestration 服务时 fail loud', () => {
    const ctx = new Context()
    ;(ctx as unknown as { root: unknown }).root = { get: () => undefined }
    expect(() => prepareTrackedChild(ctx, request())).toThrow(/corumOrchestration/)
  })

  it('track 是合法 mode（ralph 的 provider 配置）', () => {
    expect(Config({ mode: 'track' } as never).mode).toBe('track')
  })
})


describe('resolveEffectiveMode — 非 git 工作区自动降级（2026-09-10 核查）', () => {
  it('非 git 目录：always → track（不建 worktree，但仍计数 + 直连纪律）', () => {
    const dir = mkdtempSync(join(scratch, 'nogit-'))
    expect(resolveEffectiveMode('always', dir)).toBe('track')
  })

  it('git 仓库：always 保持 always', () => {
    const dir = mkdtempSync(join(scratch, 'git-'))
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' })
    expect(resolveEffectiveMode('always', dir)).toBe('always')
  })

  it('track / off 不受影响（本来就不需要 git）', () => {
    const dir = mkdtempSync(join(scratch, 'nogit2-'))
    expect(resolveEffectiveMode('track', dir)).toBe('track')
    expect(resolveEffectiveMode('off', dir)).toBe('off')
  })

  it('降级后的 track 路径不触碰 git（prepareTrackedChild 只计数 + 通知）', () => {
    const calls: Call[] = []
    const tracked = prepareTrackedChild(fakeContext(calls), request())
    expect(calls.map(call => call.kind)).toEqual(['begin'])
    expect(tracked.request.cwd).toBeUndefined()
  })
})
