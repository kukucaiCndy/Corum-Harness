/**
 * fork（corum）**turn-stopping 的作用域**回归测试（2026-10-10 实测事故后补）。
 *
 * ## 为什么有这个文件
 *
 * 旧机制 `settleCommitOnTurnEnd` 挂在 `session/event` 上，**只收口主会话**：
 *
 * ```ts
 * // 5dc6e40^ agent-service.ts:702（原文）
 * if (session.header.origin !== 'subagent' && event.type === 'turn/end') { ...收口... }
 * ```
 *
 * 2026-10-09 迁移到 `agent/turn-stopping` 钩子（提交卡片机制）时，这段作用域
 * **没有跟着搬**（`corum-git-core/src/` 里 `origin` 出现 0 次）。旧机制不阻塞
 * （`turn/end` 的返回值被 void 丢弃），同一个缺陷只是「甩下就跑」；新钩子是
 * **serial 且可 await 的阻塞钩子**，于是缺陷升级为事故：
 *
 * 委派子 Agent 的沙箱由 delegation 继承、常年 `read-only`（只读研究），却被要求
 * 交出它物理上做不到的 commit ⇒ `pollUntilClean` 死等满 `COMMIT_CARD_TIMEOUT_MS`
 * （实测会话 `8927c635`：22:37:35.332 → 22:42:35.667 = **300.335s**），父会话被
 * 同一个 await 拖住（`corum-task-77a22010` turn 4），用户点「停止」在中止信号
 * 抵达 `pollUntilClean` 之前毫无观感（该函数不读 signal，是另一处独立缺陷）。
 *
 * ## 本文件钉住的判据（双向，缺一不可）
 *
 * 1. **子会话（`origin === 'subagent'`）→ 完全不进机制**：不 steer、不出卡、
 *    不 stash、不动 git。这是本次要恢复的旧语义。
 * 2. **主会话（`origin` 缺省）→ 机制照常启动**（steer 注入提交指令）。
 *    没有这条反向断言，一个「把整个机制改坏成空跑」的改动也会让测试全绿。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

const scratch = mkdtempSync(join(tmpdir(), 'corum-turn-stopping-scope-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

let seq = 0
/** 建一个**有未提交改动**的临时 git 仓库（机制的必要触发条件）。 */
function makeDirtyRepo(): string {
  const repo = join(scratch, `repo-${seq++}`)
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
  }
  git('init', '-q')
  git('config', 'user.email', 'test@localhost')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'tracked.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '--no-verify', '-m', 'init')
  // 有效修改（未跟踪新文件）——与 hasEffectiveChanges 同口径。
  writeFileSync(join(repo, 'dirty-new-file.ts'), 'export const x = 1\n')
  return repo
}

/** 造一个只够本机制使用的最小 Agent 桩（只需要 session.header + steer）。 */
function stubAgent(
  repo: string,
  origin?: 'subagent',
  onSteer?: () => void,
): {
  agent: never
  steered: string[]
} {
  const steered: string[] = []
  const agent = {
    session: {
      id: origin === 'subagent' ? 'child-session-0001' : 'main-session-0001',
      header: { cwd: repo, ...(origin === undefined ? {} : { origin }) },
    },
    steer: (message: { content: readonly { type: string; text?: string }[] }) => {
      steered.push(message.content.map(part => part.text ?? '').join(''))
      onSteer?.()
    },
  }
  return { agent: agent as never, steered }
}

/**
 * 触发一次 `agent/turn-stopping` 并等待串行监听器跑完。
 *
 * 本机制的监听器是 async 的，裸 `ctx.emit` 不等待 ⇒ 用 `ctx.parallel`
 * 取得可 await 的分发（与官方 `agentEvents(...).serial(...)` 同为串行等待语义，
 * 但不需要拉起完整 agent-loop 装置）。
 */
async function dispatchTurnStopping(ctx: Context, agent: unknown): Promise<void> {
  await ctx.parallel('agent/turn-stopping' as never, {
    agent,
    turn: 1,
    signal: new AbortController().signal,
  } as never)
}

describe('turn-stopping 作用域 —— 只收口主会话（2026-10-10 恢复的旧语义）', () => {
  it('★ 子会话（origin=subagent）→ 完全不进机制：不 steer（实测事故会话 8927c635 的复现闸门）', async () => {
    const repo = makeDirtyRepo()
    const { agent, steered } = stubAgent(repo, 'subagent')
    const ctx = new Context()
    apply(ctx)

    await dispatchTurnStopping(ctx, agent)

    expect(steered, '只读/隔离子 Agent 不得被要求提交——它交不出 commit，机制会死等 5 分钟').toEqual([])
    // 子会话的收口另有通路（隔离 worktree → corumCommitWorktreeOnSettle），
    // 本机制一个字节都不该动它的树。
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim())
      .toContain('?? dirty-new-file.ts')
  })

  it('主会话（origin 缺省）→ 机制照常启动：steer 注入提交指令（反向对照，防「整体改坏成空跑」）', async () => {
    const repo = makeDirtyRepo()
    // 桩的 steer 模拟「LLM 收到指令后把改动提交干净」——这是机制的正常收敛路径，
    // 也让 pollUntilClean 立即返回，避免测试真等满 5 分钟超时。
    const { agent, steered } = stubAgent(repo, undefined, () => {
      execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
      execFileSync('git', ['-C', repo, 'commit', '-q', '--no-verify', '-m', 'chore: settle'], { stdio: 'pipe' })
    })
    const ctx = new Context()
    apply(ctx)

    await dispatchTurnStopping(ctx, agent)

    expect(steered.length, '主会话有有效改动时机制必须启动').toBe(1)
    expect(steered[0]).toContain('git add')
    expect(steered[0]).toContain('conventional commit')
  })

  it('主会话但工作树干净 → 幂等放过（不 steer）', async () => {
    const repo = makeDirtyRepo()
    // 手动作成干净态：把刚才那个未跟踪文件提交掉。
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--no-verify', '-m', 'clean'], { stdio: 'pipe' })
    const { agent, steered } = stubAgent(repo)
    const ctx = new Context()
    apply(ctx)

    await dispatchTurnStopping(ctx, agent)

    expect(steered).toEqual([])
  })
})
