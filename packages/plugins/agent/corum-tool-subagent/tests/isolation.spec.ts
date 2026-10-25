/**
 * fork（corum）隔离层单测：
 *   1. corumIsWriteTask — 写工具判定（readonlyResearch 恒只读、有效 deny 全覆盖才只读）；
 *   2. corumGit worktree 创建/清理 — mkdtempSync 临时 git 仓库里的 add/remove/branch -D；
 *   3. maxParallelChildren 口径 — 台账 Map 直接操作，settled 不占额度；
 *   4. corumPendingIntegration — integrate 准入（空拒绝 / settled 放行）；
 *   5. corumMarkSettled — subagent/end settle 联动（runId 精确 / childId 回退）。
 * 覆盖边界：execute 层的 cordis ctx/runtimeCtx 过重，本 spec 只测抽出的纯函数与
 * git 命令面；execute 编排由 CDP 实机验证（PLAN §5 第 10 步）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * 本 spec 的**每条**用例都要经 `repoWithBranch()` 起一个真 git 仓库
 * （`execFileSync('git', …)` × 4：init / config×2 / commit），
 * 而 vitest 默认 `testTimeout` 是 **5000ms**。
 *
 * 实测（2026-10-26）：整个文件在 macOS arm64 上耗时 **3.95s**，已逼近上限；
 * Windows CI runner 的进程启动显著更慢 ⇒ 单条用例超时，CI 在
 * `platform-tests (windows-latest)` 挂掉，报
 *   `Test timed out in 5000ms` (isolation.spec.ts:350)
 * 而本地全绿 83/83。**这是环境速度问题，不是产品缺陷**。
 *
 * 放宽到 30s：不改变任何断言语义，只给真 git 子进程留出余量。
 * 更彻底的做法是合并 repoWithBranch 里的 4 次 git 调用（改 `-c` 内联 config），
 * 但那会改动这一批测试的共同夹具，风险大于收益。
 */
vi.setConfig({ testTimeout: 30_000 })
import {
  corumDetectIntegrateChecks,
  corumEntryDead,
  corumIntegratorPersona,
  corumEffectiveToolFilter,
  corumGit,
  corumIsGitRepo,
  corumIsolationBoundaryNotice,
  corumIsWriteTask,
  corumMainTreeIntentOf,
  corumResolveIsolationRequest,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumPendingIntegration,
  corumMutationToolsForPlatform,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumWriteToolsForPlatform,
  CorumOrchestration,
  type CorumWorktreeEntry,
} from '../src/index.ts'

const scratch = mkdtempSync(join(tmpdir(), 'corum-tool-subagent-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function entry(overrides: Partial<CorumWorktreeEntry> = {}): CorumWorktreeEntry {
  return {
    slug: 'wt-test01',
    branch: 'wt/wt-test01',
    path: join(scratch, 'wt-test01'),
    status: 'active',
    ...overrides,
  }
}


/** 建临时 git 仓库并预建分支——台账「活条目」判定需要分支真实存在（worktree 目录可不存在）。 */
function repoWithBranch(name: string, branch: string): string {
  const repo = join(scratch, name)
  rmSync(repo, { recursive: true, force: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
  corumGit(repo, ['branch', branch])
  return repo
}

describe('corumIsWriteTask — fork（corum）写工具判定', () => {
  it('无 toolFilter 时是写任务（denyDirectFs 默认附加 str_replace_editor 但其余写工具仍在）', () => {
    expect(corumIsWriteTask(undefined, false)).toBe(true)
  })

  it('readonlyResearch 恒只读', () => {
    expect(corumIsWriteTask(undefined, true)).toBe(false)
    expect(corumIsWriteTask({ deny: ['bash'] }, true)).toBe(false)
  })

  it('有效 deny 覆盖全部 5 个写工具时判定为只读（不触发 write-tasks 隔离）', () => {
    const denyAll = { deny: ['write', 'edit', 'bash', 'pwsh'] } // str_replace_editor 由 denyDirectFs 附加
    expect(corumIsWriteTask(denyAll, false)).toBe(false)
    const explicitAll = { deny: ['str_replace_editor', 'write', 'edit', 'bash', 'pwsh'] }
    expect(corumIsWriteTask(explicitAll, false, false)).toBe(false)
  })

  it('只 deny 部分写工具仍是写任务', () => {
    expect(corumIsWriteTask({ deny: ['bash'] }, false)).toBe(true)
  })

  it('denyDirectFs=false 时不附加 str_replace_editor', () => {
    const filter = corumEffectiveToolFilter(undefined, false)
    expect(filter.deny).toEqual([])
    expect(corumEffectiveToolFilter({ deny: ['bash'] }, true).deny).toEqual(['bash', 'str_replace_editor'])
  })
})

describe('corumShouldIsolate — 不变式⑤：凡写委派恒隔离（2026-09-16）', () => {
  it('★ 写任务恒隔离，**与并发无关**（前台/后台/可继续一视同仁）', () => {
    // 旧口径是「单发前台写不隔离」——不变式⑤取消了这条豁免。下面每一格都必须为 true，
    // 不论 mode 与 concurrent 怎么组合。
    for (const mode of ['always', 'write-tasks'] as const) {
      for (const concurrent of [true, false]) {
        expect(corumShouldIsolate(mode, true, false, concurrent), `mode=${mode} concurrent=${concurrent}`).toBe(true)
      }
      // 缺省 concurrent 同样隔离（形参已废弃，保留只为签名兼容）。
      expect(corumShouldIsolate(mode, true, false)).toBe(true)
    }
  })

  it('★ 回归锚点：单发前台写委派（concurrent=false）也必须隔离——这正是被取消的豁免', () => {
    // 2026-09-09 的旧断言此处是 `false`（用户当时反馈「只派一个 TASK 还是走隔离」）。
    // 2026-09-16 用户裁定收紧：那条豁免取消，此处必须为 true。
    expect(corumShouldIsolate('write-tasks', true, false, false)).toBe(true)
    expect(corumShouldIsolate('always', true, false, false)).toBe(true)
  })

  it('readonlyResearch 恒不隔离（只读不落盘，无需隔离）', () => {
    expect(corumShouldIsolate('always', true, true)).toBe(false)
    expect(corumShouldIsolate('write-tasks', true, true, true)).toBe(false)
    expect(corumShouldIsolate('always', false, true, false)).toBe(false)
  })

  it('非写任务（工具面被 deny 到无写能力）：只有显式 always 才隔离', () => {
    expect(corumShouldIsolate('write-tasks', false, false, true)).toBe(false)
    expect(corumShouldIsolate('write-tasks', false, false, false)).toBe(false)
    expect(corumShouldIsolate('always', false, false)).toBe(true)
  })

  it('`off` 已从类型面清除（无逃生口）——mode 只剩 always / write-tasks', () => {
    // 编译期断言：'off' 不再是合法取值（若有人把它加回来，下面的 @ts-expect-error 会失效）。
    // @ts-expect-error 'off' 已按用户裁定清除（2026-09-16 不变式⑤）
    const forbidden: Parameters<typeof corumShouldIsolate>[0] = 'off'
    void forbidden
  })

  /**
   * fork（corum）2026-09-27（用户裁定 A）：第 5 个形参是**逐次派发的语义出口**。
   *
   * 它不是把不变式⑤打开：`mode` / `taskIsolation` **仍然**关不掉隔离（上面几条用例覆盖），
   * 只有调用方逐次显式声明 `isolation: 'main'`（= 这次要在主树/跨仓工作）才不建 worktree。
   * 病根（会话 corum-task-56b7d485）：主 Agent 想让子 Agent 去主树/跨仓落盘却表达不出来，
   * 只能派隔离子 Agent，于是一轮里 4 个零提交的撞墙子会话。
   */
  it('★ 显式 isolation:\'main\' ⇒ 不隔离（语义出口，不是 off 逃生口）', () => {
    expect(corumShouldIsolate('write-tasks', true, false, false, 'main')).toBe(false)
    expect(corumShouldIsolate('always', true, false, true, 'main')).toBe(false)
    // 缺省 / 显式 worktree 仍是恒隔离（默认行为一字未改）。
    expect(corumShouldIsolate('write-tasks', true, false, false, 'worktree')).toBe(true)
    expect(corumShouldIsolate('write-tasks', true, false, false)).toBe(true)
    // 只读研究即使声明 main 也只读（readonlyResearch 先判，沙箱层另有 read-only 钉）。
    expect(corumShouldIsolate('always', true, true, false, 'main')).toBe(false)
  })
})

/**
 * fork（corum）2026-09-27（用户裁定 A）：`isolation` 的解析与**结构性矛盾拦截**。
 *
 * 用户裁定的原话：「有问题的是之前的主 Agent 指派子 Agent 时传入的参数不合适，比如希望
 * 子 Agent 合并分支，但仍然派出了隔离的子 Agent 工作在新的 worktree 上」⇒ 矛盾的参数组合
 * 必须在**派发之前**抛错，而不是让子 Agent 跑去撞隔离墙（那正是本场 20 次派发的浪费来源）。
 */
describe('corumResolveIsolationRequest — 隔离意图解析 + 矛盾 fail loud', () => {
  it('缺省 ⇒ worktree 路线（不隔离需要显式声明）', () => {
    expect(corumResolveIsolationRequest({})).toEqual({ placement: 'worktree', integrator: false })
  })

  it('isolation:\'main\' ⇒ placement=main', () => {
    expect(corumResolveIsolationRequest({ isolation: 'main' })).toEqual({ placement: 'main', integrator: false })
  })

  it('档位取值（always / write-tasks）走 mode 维度，placement 仍 worktree', () => {
    expect(corumResolveIsolationRequest({ isolation: 'always' })).toEqual({ mode: 'always', placement: 'worktree', integrator: false })
    expect(corumResolveIsolationRequest({ isolation: 'write-tasks' })).toEqual({ mode: 'write-tasks', placement: 'worktree', integrator: false })
  })

  it('integrate:true 单独使用 ⇒ 集成者路线（在主树）', () => {
    expect(corumResolveIsolationRequest({ integrate: true })).toEqual({ placement: 'worktree', integrator: true })
  })

  it('★ integrate:true + isolation 任意取值 ⇒ 抛错（两条路线混淆）', () => {
    for (const bad of ['worktree', 'main', 'always', 'write-tasks'] as const) {
      expect(() => corumResolveIsolationRequest({ integrate: true, isolation: bad }), `isolation=${bad}`).toThrow(/integrate: true already runs the child as the INTEGRATOR/)
    }
    // 错误文本必须给出两条合法路线（否则模型只会重试同一条）。
    expect(() => corumResolveIsolationRequest({ integrate: true, isolation: 'worktree' })).toThrow(/isolation: "main"/)
  })

  it('★ 非法取值 ⇒ 抛错并列出词汇表（不静默退回默认）', () => {
    for (const bad of ['off', 'MAIN', 'mainTree', '', 42, null] as const) {
      expect(() => corumResolveIsolationRequest({ isolation: bad }), `isolation=${String(bad)}`).toThrow(/isolation must be one of/)
    }
  })
})

describe('CorumOrchestration — 在跑写子 Agent 计数（并发感知隔离信号④）', () => {
  it('begin/end 成对计数，归零即删表', () => {
    const orchestration = new CorumOrchestration(new Context())
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(0)
    orchestration.beginWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(1)
    orchestration.beginWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(2)
    orchestration.endWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(1)
    orchestration.endWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(0)
  })
  it('多余 end 不会出现负计数；会话之间互不串扰', () => {
    const orchestration = new CorumOrchestration(new Context())
    orchestration.endWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(0)
    orchestration.beginWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s2')).toBe(0)
  })
})

describe('corumGit — fork（corum）worktree 创建/清理', () => {
  const repo = join(scratch, 'repo')
  const wtRoot = join(scratch, 'worktrees')

  it('git init + 初始 commit 后可 worktree add，remove + branch -D 后干净', () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: scratch, stdio: 'pipe' })
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })

    const slug = 'wt-spec01'
    const wtPath = join(wtRoot, slug)
    const branch = `wt/${slug}`
    corumGit(repo, ['worktree', 'add', wtPath, '-b', branch])
    expect(existsSync(wtPath)).toBe(true)

    // 清理：worktree remove --force + branch -D（与 execute 的 autoCleanup 同路径）。
    corumGit(repo, ['worktree', 'remove', '--force', wtPath])
    corumGit(repo, ['branch', '-D', branch])
    expect(existsSync(wtPath)).toBe(false)
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' })
    expect(branches.trim()).toBe('')
  })

  it('worktree add 失败时抛错（execute 层据此回滚）', () => {
    expect(() => corumGit(repo, ['worktree', 'add', join(wtRoot, 'wt-spec02'), '-b', 'no/such/ref/..bad']))
      .toThrow()
  })
})

describe('maxParallelChildren — fork（corum）并行上限口径', () => {
  it('只计 active；settled/integrated/discarded 不占额度', () => {
    const sessionId = 'spec-session-limit'
    // fork（corum）：台账已下沉 CorumOrchestration service（红线 1），单测经
    // _testLedger() 直接操作 service 台账字段（与 execute 层同口径）。
    const orchestration = new CorumOrchestration(new Context())
    const ledger = orchestration._testLedger()
    ledger.set(sessionId, [
      entry({ slug: 'wt-a', status: 'active' }),
      entry({ slug: 'wt-b', status: 'settled' }),
      entry({ slug: 'wt-c', status: 'integrated' }),
      entry({ slug: 'wt-d', status: 'discarded' }),
    ])
    const entries = ledger.get(sessionId)!
    const activeCount = entries.filter(item => item.status === 'active').length
    // 与 execute 同判定：active >= maxParallelChildren(4) 才拒绝。
    expect(activeCount).toBe(1)
    expect(activeCount >= 4).toBe(false)
    ledger.delete(sessionId)
  })
})

describe('corumPendingIntegration — fork（corum）integrate 准入', () => {
  it('无 active/settled 条目时为空（execute 层据此拒绝）', () => {
    expect(corumPendingIntegration([])).toEqual([])
    expect(corumPendingIntegration([entry({ status: 'integrated' }), entry({ status: 'discarded', slug: 'wt-x' })]))
      .toEqual([])
  })

  it('settled 条目放行（修复第一阶段只认 active 的缺陷）', () => {
    const pending = corumPendingIntegration([
      entry({ slug: 'wt-a', status: 'settled' }),
      entry({ slug: 'wt-b', status: 'active' }),
      entry({ slug: 'wt-c', status: 'integrated' }),
    ])
    expect(pending.map(item => item.slug)).toEqual(['wt-a', 'wt-b'])
  })
})

describe('corumMarkSettled — fork（corum）subagent/end settle 联动', () => {
  it('runId 精确匹配 active 条目翻转为 settled', () => {
    const entries = [entry({ runId: 'run-1' })]
    expect(corumMarkSettled(entries, { runId: 'run-1', childId: 'child-1' })).toBe(true)
    expect(entries[0].status).toBe('settled')
  })

  it('runId 未命中时 childId 回退匹配唯一 active（continuable 登记的是 childId）', () => {
    // 夹具语义 = 「没有绑定 runId」。exactOptionalPropertyTypes 下 `runId?: string` 不接受
    // 显式 `undefined`，所以用「不传」表达同一现场（`corumMarkSettled` 按值比较，两者等价）。
    const entries = [entry()]
    expect(corumMarkSettled(entries, { runId: 'run-unknown', childId: 'child-9' })).toBe(true)
    expect(entries[0].status).toBe('settled')
    expect(entries[0].runId).toBe('run-unknown')
  })

  it('多条无 runId 的 active 时 childId 回退拒绝猜测', () => {
    const entries = [entry({ slug: 'wt-a' }), entry({ slug: 'wt-b' })]
    expect(corumMarkSettled(entries, { childId: 'child-x' })).toBe(false)
    expect(entries.every(item => item.status === 'active')).toBe(true)
  })

  it('已非 active 的条目不再翻转', () => {
    const entries = [entry({ runId: 'run-2', status: 'settled' })]
    expect(corumMarkSettled(entries, { runId: 'run-2', childId: 'child-2' })).toBe(false)
  })

  it('结算回退分支也写 childSessionId（否则浮层工作区行是死行，2026-09-12 真机实测）', () => {
    // 同上：夹具语义 = 「没有绑定 runId」，exactOptionalPropertyTypes 下用「不传」表达。
    const entries = [entry()]
    expect(corumMarkSettled(entries, { runId: 'run-fb', childId: 'child-fb' })).toBe(true)
    expect(entries[0].runId).toBe('run-fb')
    expect(entries[0].childSessionId).toBe('child-fb')
  })

  it('精确命中路径补写缺失的 childSessionId（存量台账只有 runId）', () => {
    const entries = [entry({ runId: 'run-only' })]
    expect(corumMarkSettled(entries, { runId: 'run-only', childId: 'child-only' })).toBe(true)
    expect(entries[0].childSessionId).toBe('child-only')
  })
})

describe('corumMarkSettled — fork（corum）并行精确匹配（2026-09-09 settle 修复）', () => {
  it('按绑定的 runId 精确翻转，只动命中条目', () => {
    const entries = [entry({ slug: 'wt-a', runId: 'run-1' }), entry({ slug: 'wt-b', runId: 'run-2' })]
    expect(corumMarkSettled(entries, { runId: 'run-2', childId: 'child-2' })).toBe(true)
    expect(entries[0].status).toBe('active')
    expect(entries[1].status).toBe('settled')
  })

  it('按 childId 命中（continuable 绑定的就是 childId）', () => {
    const entries = [entry({ slug: 'wt-a', runId: 'child-7' })]
    expect(corumMarkSettled(entries, { runId: 'run-7', childId: 'child-7' })).toBe(true)
    expect(entries[0].status).toBe('settled')
  })

  it('并行两条都未绑定时不误翻转（唯一 active 回退在 ≥2 并行时本就不成立）', () => {
    const entries = [entry({ slug: 'wt-a' }), entry({ slug: 'wt-b' })]
    expect(corumMarkSettled(entries, { runId: 'run-x', childId: 'child-x' })).toBe(false)
    expect(entries.every(item => item.status === 'active')).toBe(true)
  })
})

describe('CorumOrchestration — bindRunId + settleFromEnd（settle 修复）', () => {
  it('绑定 runId 后 settleFromEnd 精确翻转（父 Agent 经 carrier 传入）', () => {
    const repo = repoWithBranch('settle-repo-1', 'wt/wt-s1')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-settle-1'
    orchestration.addActiveEntry(sessionId, repo, {
      slug: 'wt-s1', branch: 'wt/wt-s1', path: join(repo, '.corum-worktrees', 'wt-s1'),
    })
    orchestration.bindRunId(sessionId, 'wt-s1', 'run-42')
    // 旧实现：监听端把父 Agent 当第二参数收，恒 undefined → parentAgent.session.id
    // 抛错被 emitter 吞掉，settle 从未生效（docs/TODO.md）。
    const parent = { session: { id: sessionId } } as never
    expect(orchestration.settleFromEnd({ runId: 'run-42', id: 'child-42' } as never, parent)).toBe(true)
    expect(orchestration.entriesOf(sessionId)[0].status).toBe('settled')
  })

  it('bindRunId 幂等（已绑定的条目不被覆盖）', () => {
    const repo = repoWithBranch('settle-repo-2', 'wt/wt-s2')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-settle-idem'
    orchestration.addActiveEntry(sessionId, repo, {
      slug: 'wt-s2', branch: 'wt/wt-s2', path: join(repo, '.corum-worktrees', 'wt-s2'),
    })
    orchestration.bindRunId(sessionId, 'wt-s2', 'run-first')
    orchestration.bindRunId(sessionId, 'wt-s2', 'run-second')
    expect(orchestration.entriesOf(sessionId)[0].runId).toBe('run-first')
  })

  it('carrier 缺失时经 agents 服务反查父会话（子会话 header.parentSession 兜底）', () => {
    const ctx = new Context()
    ctx.provide('agents', {
      get: (id: unknown) => id === 'child-9'
        ? { session: { header: { parentSession: 'spec-settle-2' } } }
        : undefined,
    })
    const repo = repoWithBranch('settle-repo-3', 'wt/wt-s3')
    const orchestration = new CorumOrchestration(ctx)
    orchestration.addActiveEntry('spec-settle-2', repo, {
      slug: 'wt-s3', branch: 'wt/wt-s3', path: join(repo, '.corum-worktrees', 'wt-s3'),
    })
    orchestration.bindRunId('spec-settle-2', 'wt-s3', 'run-9')
    expect(orchestration.settleFromEnd({ runId: 'run-9', id: 'child-9' } as never)).toBe(true)
    expect(orchestration.entriesOf('spec-settle-2')[0].status).toBe('settled')
  })

  it('解析不出父会话时静默返回 false（旧实现在此处抛错）', () => {
    const orchestration = new CorumOrchestration(new Context())
    expect(() => orchestration.settleFromEnd({ runId: 'r', id: 'c' } as never)).not.toThrow()
    expect(orchestration.settleFromEnd({ runId: 'r', id: 'c' } as never)).toBe(false)
  })
})

describe('corumEntryDead / entriesOf 死条目剔除（2026-09-09）', () => {
  it('worktree 目录与分支都不存在 → 死条目', () => {
    expect(corumEntryDead(scratch, { path: join(scratch, 'nope'), branch: 'wt/nope' })).toBe(true)
  })

  it('分支仍在（worktree 已回收）→ 活条目（仍可集成，不剔除）', () => {
    const repo = join(scratch, 'dead-repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
    corumGit(repo, ['branch', 'wt/alive'])
    expect(corumEntryDead(repo, { path: join(repo, 'gone'), branch: 'wt/alive' })).toBe(false)
    expect(corumEntryDead(repo, { path: join(repo, 'gone'), branch: 'wt/gone' })).toBe(true)
  })

  it('entriesOf 剔除死条目（旧强删遗留不再占用 maxParallelChildren 额度）', () => {
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-dead-1'
    orchestration.addActiveEntry(sessionId, scratch, {
      slug: 'wt-dead', branch: 'wt/wt-dead', path: join(scratch, 'gone'),
    })
    expect(orchestration._testLedger().get(sessionId)?.length).toBe(1)
    expect(orchestration.entriesOf(sessionId)).toEqual([])
    expect(orchestration._testLedger().get(sessionId)?.length).toBe(0)
  })
})

describe('entriesOf/emitFrame — 认账「主 Agent 派子 Agent 合并掉的分支」并回收现场（2026-09-12）', () => {
  /** 真 git 仓库 + 一条已 commit 的隔离 worktree，条目已 settle。 */
  function settledWorktreeEntry(name: string, slug: string): { repo: string; worktree: string; branch: string } {
    const repo = join(scratch, name)
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
    const branch = `wt/${slug}`
    const worktree = join(repo, '.corum-worktrees', slug)
    corumGit(repo, ['worktree', 'add', '-q', worktree, '-b', branch])
    writeFileSync(join(worktree, `${slug}.txt`), 'child payload')
    corumGit(worktree, ['add', '-A'])
    execFileSync('git', ['-C', worktree, '-c', 'user.name=c', '-c', 'user.email=c@corum.local', 'commit', '-q', '-m', `add ${slug}`], { stdio: 'pipe' })
    return { repo, worktree, branch }
  }

  it('settle 后分支被外部合并 → entriesOf 认账 integrated 且 worktree 现场被安全回收', () => {
    const { repo, worktree, branch } = settledWorktreeEntry('recon-repo-1', 'wt-r1')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-recon-1'
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-r1', branch, path: worktree })
    orchestration.bindRunId(sessionId, 'wt-r1', 'run-r1')
    orchestration.settleFromEnd({ runId: 'run-r1', id: 'child-r1' } as never, { session: { id: sessionId } } as never)
    expect(orchestration.entriesOf(sessionId)[0].status).toBe('settled')
    // 主 Agent 派子 Agent 直接用 git 合并（机制全程不知情）
    corumGit(repo, ['-c', 'user.name=child', '-c', 'user.email=child@corum.local', 'merge', '--no-ff', '-m', 'merge(wt-r1)', branch])
    const entries = orchestration.entriesOf(sessionId)
    expect(entries[0].status).toBe('integrated')
    expect(existsSync(worktree)).toBe(false) // 现场已回收
    // 现场回收了，但**记录留着**：终态条目是「并行工作区」栏的历史与分类来源
    // （2026-09-12 用户实测「隔离那一栏整段消失」后定的口径）。死条目剔除只针对
    // 待集成（active/settled）条目，它们才占 maxParallelChildren 额度。
    const after = orchestration.entriesOf(sessionId)
    expect(after.length).toBe(1)
    expect(after[0]?.status).toBe('integrated')
  })

  it('终态记录在 worktree/分支都已消失后仍然保留（那一栏不会随清理消失）', () => {
    const { repo, worktree, branch } = settledWorktreeEntry('recon-repo-7', 'wt-r7')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-recon-7'
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-r7', branch, path: worktree })
    orchestration.bindRunId(sessionId, 'wt-r7', 'run-r7')
    orchestration.settleFromEnd({ runId: 'run-r7', id: 'child-r7' } as never, { session: { id: sessionId } } as never)
    corumGit(repo, ['-c', 'user.name=c', '-c', 'user.email=c@corum.local', 'merge', '--no-ff', '-m', 'merge(wt-r7)', branch])
    expect(orchestration.entriesOf(sessionId)[0]?.status).toBe('integrated')
    // 现场被彻底清掉（目录 + 分支都不在——上面那次 entriesOf 的安全回收已经删了分支）后，
    // 记录仍应保留（终态条目例外于死条目剔除）。
    rmSync(worktree, { recursive: true, force: true })
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' }).trim()).toBe('')
    const kept = orchestration.entriesOf(sessionId)
    expect(kept.length).toBe(1)
    expect(kept[0]?.status).toBe('integrated')
  })

  it('settle 的 worktree 有未提交改动 → 认账 integrated 但保留现场（安全清理）', () => {
    const { repo, worktree, branch } = settledWorktreeEntry('recon-repo-2', 'wt-r2')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-recon-2'
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-r2', branch, path: worktree })
    orchestration.bindRunId(sessionId, 'wt-r2', 'run-r2')
    orchestration.settleFromEnd({ runId: 'run-r2', id: 'child-r2' } as never, { session: { id: sessionId } } as never)
    corumGit(repo, ['-c', 'user.name=child', '-c', 'user.email=child@corum.local', 'merge', '--no-ff', '-m', 'merge(wt-r2)', branch])
    writeFileSync(join(worktree, 'uncommitted.txt'), '写在工作区、从未提交')
    expect(orchestration.entriesOf(sessionId)[0].status).toBe('integrated')
    expect(existsSync(worktree)).toBe(true)
    expect(existsSync(join(worktree, 'uncommitted.txt'))).toBe(true)
  })

  it('active 条目被外部合并 → 认账 integrated 但不回收（子 Agent 可能还在该目录里干活）', () => {
    const { repo, worktree, branch } = settledWorktreeEntry('recon-repo-3', 'wt-r3')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-recon-3'
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-r3', branch, path: worktree })
    corumGit(repo, ['-c', 'user.name=child', '-c', 'user.email=child@corum.local', 'merge', '--no-ff', '-m', 'merge(wt-r3)', branch])
    expect(orchestration.entriesOf(sessionId)[0].status).toBe('integrated')
    expect(existsSync(worktree)).toBe(true)
  })

  it('emitFrame 发帧前也对账（帧不得把已合并分支显示成待集成）', () => {
    const { repo, worktree, branch } = settledWorktreeEntry('recon-repo-4', 'wt-r4')
    const ctx = new Context()
    const frames: Array<{ pending: number; statuses: string[] }> = []
    ctx.on('corum/worktree-ledger', frame => {
      frames.push({ pending: frame.pending, statuses: frame.entries.map(e => e.status) })
    })
    const orchestration = new CorumOrchestration(ctx)
    const sessionId = 'spec-recon-4'
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-r4', branch, path: worktree })
    orchestration.bindRunId(sessionId, 'wt-r4', 'run-r4')
    orchestration.settleFromEnd({ runId: 'run-r4', id: 'child-r4' } as never, { session: { id: sessionId } } as never)
    corumGit(repo, ['-c', 'user.name=child', '-c', 'user.email=child@corum.local', 'merge', '--no-ff', '-m', 'merge(wt-r4)', branch])
    orchestration.emitFrame(sessionId)
    const last = frames.at(-1)
    expect(last?.statuses).toEqual(['integrated'])
    expect(last?.pending).toBe(0)
  })

  it('新建 worktree（空分支 tip === HEAD）不会被误认账成 integrated', () => {
    const repo = join(scratch, 'recon-repo-5')
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-recon-5'
    const child = orchestration.createWorktreeChild(sessionId, repo)
    expect(orchestration.entriesOf(sessionId)[0].status).toBe('active')
    expect(existsSync(child.path)).toBe(true)
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', child.branch], { encoding: 'utf8' }).trim()).not.toBe('')
  })

  it('空分支 + main 往前走（tip 变成 HEAD 的祖先）同样不认账：跨重启实测的误判路径', () => {
    const repo = join(scratch, 'recon-repo-6')
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-recon-6'
    const child = orchestration.createWorktreeChild(sessionId, repo)
    // main 往前一步：空分支的 tip 现在成了 HEAD 的**严格祖先** → `--merged` 会列出它，
    // 只看 tip !== HEAD 判不出来（重启后真机就是这么被误判的）。
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'main moves on'], { stdio: 'pipe' })
    expect(orchestration.entriesOf(sessionId)[0].status).toBe('active')
    expect(existsSync(child.path)).toBe(true)
  })
})

describe('git 判据是运行时探测，不是产品开关', () => {
  it('产品代码里已不存在 `autoInitGit` 开关（2026-09-11 用户定调：打开工作区固定「探测，没有就初始化」）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    // 仓库根（tests → 包 → agent → plugins → packages → 根）。
    // ⚠️ 必须用 `fileURLToPath`，不能用 `new URL(...).pathname`：Windows 上后者返回
    // `/D:/a/…`（前导斜杠 + 正斜杠），`existsSync` 直接为假 ⇒ sources 恒为 0，
    // 断言 `>50` 必挂（2026-10-21 三平台门禁 Windows leg 实测）。
    const reposRoot = fileURLToPath(new URL('../../../../..', import.meta.url))
    const walk = (dir: string): string[] => fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          return ['node_modules', 'lib', 'dist', 'build', '.git'].includes(entry.name) ? [] : walk(full)
        }
        // 排除测试自身（它的搜索词就是 `autoInitGit` 字面量）。
        return /\.[cm]?tsx?$/.test(entry.name) && !/\.spec\.[cm]?tsx?$/.test(entry.name) ? [full] : []
      })
      : []
    const sources = [
      ...walk(path.join(reposRoot, 'packages/plugins')),
      ...walk(path.join(reposRoot, 'packages/desktop/src')),
    ]
    expect(sources.length).toBeGreaterThan(50)
    // 只看**代码**：注释里保留「为什么移除该开关」的历史说明是有价值的，
    // 不能因为注释提到这个词就让断言失败，所以先剥注释再扫。
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const offenders = sources.filter(file => stripComments(fs.readFileSync(file, 'utf8')).includes('autoInitGit'))
    expect(offenders.map(file => path.relative(reposRoot, file))).toEqual([])
  })

  it('机制侧判据是 corumIsGitRepo(cwd)（git rev-parse 探测当前工作区）', async () => {
    const fs = await import('node:fs')
    const toolSrc = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(toolSrc).toContain('corumIsGitRepo(parentCwdForRepo)')
    const providerSrc = fs.readFileSync(new URL('../../corum-subagent/src/isolated/index.ts', import.meta.url), 'utf8')
    expect(providerSrc).toContain('corumIsGitRepo(parentCwd)')
  })
})

describe('非 git 降级：强制隔离被跳过时告知子 Agent（2026-09-10 核查）', () => {
  it('工具层：跳过隔离时 prompt 追加说明（降级而非报错）', async () => {
    const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'))
    expect(src).toContain('corumIsolationSkipped')
    // 2026-09-27 P2：说明文本移进通知的单一事实源（按原因参数化），工具层只传原因 ⇒
    // 这里断言「工具层把该情形映射成 skipped-non-git」，文本本身在 orchestration 包内断言
    //（见 corum-orchestration/tests/direct-write-notice.spec.ts）。
    expect(src).toContain("corumDirectWriteNotice(corumMainTreeReason)")
    expect(src).toContain("corumIsolationBoundary === 'main-requested'")
    const noticeSrc = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../corum-orchestration/src/orchestration.ts', import.meta.url), 'utf8'))
    expect(noticeSrc).toContain('this workspace is not a git repository, so isolation was skipped')
    // 措辞与实现一致：降级而非报错（不变式⑤后机制段改述，但这条语义未变）。
    expect(src).toContain('Isolation needs a git repository')
    expect(src).not.toContain('on an orchestrate task fails loud')
  })
})

describe('corumIsGitRepo — 非 git 工作区降级 + 手动 git init 后可恢复（2026-09-10 核查）', () => {
  it('非 git 目录判 false；`git init` 后同进程内再判为 true（负结果不再缓存）', () => {
    // 注意：scratch 本身在本文件的另一个用例里被 `git init` 过（line ~142），
    // 所以非 git 场景必须用 scratch 之外的临时目录（git 会向上层查找仓库）。
    const dir = mkdtempSync(join(tmpdir(), 'corum-late-git-'))
    // 用户关掉「新工作区自动 git init」→ 首次派遣时判非 git，机制自动降级。
    expect(corumIsGitRepo(dir)).toBe(false)
    // 用户随后手动 git init：同进程内必须立刻恢复（此前负结果被永久缓存）。
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' })
    expect(corumIsGitRepo(dir)).toBe(true)
  })
})

describe('isolation notice — fork（corum）prompt 前缀', () => {
  it('通知文本单一事实源在编排包，工具层与 isolated provider 都引用它', async () => {
    // 机制验证：实机 CDP（fork-delta §11.5）——probe4 无此前缀撞沙箱、probe5 有则直写成功。
    // 2026-09-10：文本下沉到 @corum/corum-orchestration（工具层 + provider 共用），
    // 这里断言「文本语义 + 两个消费点都走 helper」，防重构时丢失或分叉。
    const fs = await import('node:fs')
    const orchestrationSrc = fs.readFileSync(new URL('../../corum-orchestration/src/orchestration.ts', import.meta.url), 'utf8')
    expect(orchestrationSrc).toContain('[corum isolation]')
    expect(orchestrationSrc).toContain('RELATIVE path only')
    // 2026-09-09 措辞更正：沙箱只拒写（读仍允许），旧文本的 read-denied 是错的。
    expect(orchestrationSrc).toContain('write-denied by the sandbox')
    expect(orchestrationSrc).toContain('reads are still allowed')
    expect(orchestrationSrc).toContain('export function corumIsolationNotice')
    const toolSrc = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(toolSrc).toContain('corumIsolationNotice(child)')
    expect(toolSrc).toContain('corumDirectWriteNotice(corumMainTreeReason)')
    const providerSrc = fs.readFileSync(new URL('../../corum-subagent/src/isolated/index.ts', import.meta.url), 'utf8')
    // 2026-09-10：provider 直接引用编排包的 helper（不再自持副本）。
    expect(providerSrc).toContain('corumIsolationNotice(child)')
    expect(providerSrc).toContain("corumDirectWriteNotice('sequential-iteration')")
  })
})

describe('corumDetectIntegrateChecks — fork（corum）探测式默认 checks（P0-1）', () => {
  it('pnpm workspace → pnpm -r typecheck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corum-checks-pnpm-'))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    expect(corumDetectIntegrateChecks(dir)).toEqual(['pnpm -r typecheck'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('package.json scripts.typecheck → npm run typecheck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corum-checks-tsc-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }))
    expect(corumDetectIntegrateChecks(dir)).toEqual(['npm run typecheck'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('package.json 仅 scripts.test → npm test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corum-checks-test-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    expect(corumDetectIntegrateChecks(dir)).toEqual(['npm test'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('均无 → git diff --check（保守兜底）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corum-checks-none-'))
    expect(corumDetectIntegrateChecks(dir)).toEqual(['git diff --check'])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('corumIntegratorPersona — fork（corum）声明式验证（2026-09-08 定调）', () => {
  const entries = [
    { slug: 'wt-aaaaaa', branch: 'wt/wt-aaaaaa', path: '/repo/.corum-worktrees/wt-aaaaaa', status: 'settled' as const },
  ]

  it('主 Agent 声明 verify → 原样注入 + 保留失败不提交约束', () => {
    const persona = corumIntegratorPersona(entries, ['git diff --check'], 'parent', 'cd studio && npm test')
    expect(persona).toContain('declared by the delegating agent')
    expect(persona).toContain('cd studio && npm test')
    expect(persona).toContain('do NOT commit')
    // 声明存在时 checks 段仍在（最低限度约束）
    expect(persona).toContain('git diff --check')
  })

  it('未声明 → 标注最低限度格式校验语义', () => {
    const persona = corumIntegratorPersona(entries, [], 'parent')
    expect(persona).toContain('did not declare')
    expect(persona).toContain('minimum bar')
    expect(persona).toContain('git diff --check')
  })

  it('merger 汇报语义：主 Agent 最终验收（final acceptance call）', () => {
    const persona = corumIntegratorPersona(entries, [], 'parent')
    expect(persona).toContain('final acceptance call')
    const mergerPersona = corumIntegratorPersona(entries, [], 'merger')
    expect(mergerPersona).toContain('verification results')
  })
})

describe('corumResearchToolFilter — fork（corum）research 只读硬约束', () => {
  it('readonlyResearch=false 返回 undefined（不补 deny）', () => {
    expect(corumResearchToolFilter(undefined, false)).toBeUndefined()
    expect(corumResearchToolFilter({ deny: ['bash'] }, false)).toBeUndefined()
  })

  // fork（corum）2026-09-12 用户定调：research **开放 shell**（调研必须能跑命令），
  // 只读性改由子会话沙箱（readonlySandbox → read-only）保证——工具面只 deny 变异工具。
  it('research=true + 无 toolFilter → deny 变异工具，但**保留 shell**', () => {
    const filter = corumResearchToolFilter(undefined, true)
    for (const tool of corumMutationToolsForPlatform()) {
      expect(filter?.deny).toContain(tool)
    }
    expect(filter?.deny).not.toContain('bash')
    expect(filter?.deny).not.toContain('pwsh')
  })

  it('research=true + 部分 deny → 补全缺失的变异工具（不动 shell）', () => {
    const filter = corumResearchToolFilter({ deny: ['write'] }, true)
    for (const tool of corumMutationToolsForPlatform()) {
      expect(filter?.deny).toContain(tool)
    }
    expect(filter?.deny).not.toContain('bash')
  })

  it('research=true + 已全 deny → 返回 undefined（幂等，不重复）', () => {
    const allDeny = { deny: [...corumMutationToolsForPlatform()] }
    expect(corumResearchToolFilter(allDeny, true)).toBeUndefined()
  })

  it('allow 保持 config 原值（只读任务不扩权）', () => {
    const filter = corumResearchToolFilter({ allow: ['grep', 'glob'], deny: ['bash'] }, true)
    expect(filter?.allow).toEqual(['grep', 'glob'])
  })
})

describe('corumNarrowDenyFilter — fork（corum）deny 收敛到已注册工具（2026-09-10 官方 preset 全崩修复）', () => {
  const known = new Set(['read', 'write', 'edit', 'bash'])

  it('未知名从 deny 中剔除，已注册名保留（str_replace_editor 不在官方 preset）', () => {
    // 实机根因：官方 standard/ptc/cordis 挂 write/edit 不挂 str_replace_editor，
    // 机制追加的 deny 含未知名 → tools.restrict() fail-loud → 子 Agent 创建失败。
    expect(corumNarrowDenyFilter({ deny: ['str_replace_editor', 'write', 'edit', 'bash'] }, known))
      .toEqual({ deny: ['write', 'edit', 'bash'] })
  })

  it('deny 全部命中时原样返回（引用不变，避免无谓复制）', () => {
    const filter = { deny: ['write', 'bash'] }
    expect(corumNarrowDenyFilter(filter, known)).toBe(filter)
  })

  it('deny 全被剔除且无 allow → undefined（等于不限制）', () => {
    expect(corumNarrowDenyFilter({ deny: ['str_replace_editor'] }, known)).toBeUndefined()
  })

  it('deny 全被剔除但有 allow → 只留 allow（不把只读实例变成无限制）', () => {
    expect(corumNarrowDenyFilter({ allow: ['grep'], deny: ['str_replace_editor'] }, known))
      .toEqual({ allow: ['grep'], deny: [] })
  })

  it('allow 名单不收敛（写错的 allow 必须继续 fail-loud）', () => {
    expect(corumNarrowDenyFilter({ allow: ['no_such_tool'] }, known)).toEqual({ allow: ['no_such_tool'] })
  })

  it('无 deny / undefined 原样返回', () => {
    expect(corumNarrowDenyFilter(undefined, known)).toBeUndefined()
    const allowOnly = { allow: ['read'] }
    expect(corumNarrowDenyFilter(allowOnly, known)).toBe(allowOnly)
  })
})

describe('CorumOrchestration.discardEntry — fork（corum）spawn 失败回滚（2026-09-10 泄漏修复）', () => {
  it('强清理 worktree + 分支并移除台账条目（active 泄漏会占额度并恒判并发）', () => {
    const repo = repoWithBranch('discard-repo-1', 'wt/wt-d1')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-discard-1'
    const wtPath = join(repo, '.corum-worktrees', 'wt-d1')
    execFileSync('git', ['-C', repo, 'worktree', 'add', wtPath, 'wt/wt-d1'], { stdio: 'pipe' })
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-d1', branch: 'wt/wt-d1', path: wtPath })

    orchestration.discardEntry(sessionId, 'wt-d1')

    expect(orchestration.entriesOf(sessionId)).toEqual([])
    expect(orchestration._testLedger().get(sessionId)).toEqual([])
    expect(existsSync(wtPath)).toBe(false)
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'wt/wt-d1'], { encoding: 'utf8' })
    expect(branches.trim()).toBe('')
  })

  it('已绑定 runId 的条目不回滚（那条 run 真实存在，settle 路径负责它）', () => {
    const repo = repoWithBranch('discard-repo-2', 'wt/wt-d2')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-discard-2'
    const wtPath = join(repo, '.corum-worktrees', 'wt-d2')
    execFileSync('git', ['-C', repo, 'worktree', 'add', wtPath, 'wt/wt-d2'], { stdio: 'pipe' })
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-d2', branch: 'wt/wt-d2', path: wtPath })
    orchestration.bindRunId(sessionId, 'wt-d2', 'run-live')

    orchestration.discardEntry(sessionId, 'wt-d2')

    expect(orchestration.entriesOf(sessionId).map(item => item.slug)).toEqual(['wt-d2'])
    expect(existsSync(wtPath)).toBe(true)
  })

  it('未知 slug 静默 no-op（无隔离的 spawn 失败路径）', () => {
    const orchestration = new CorumOrchestration(new Context())
    expect(() => orchestration.discardEntry('spec-discard-3', 'wt-none')).not.toThrow()
  })
})

/**
 * 隔离边界的**可见性**（2026-09-13 用户定调「先做可见性」；2026-09-16 不变式⑤收窄到两档）。
 *
 * 由来：隔离落点必须让**父 Agent** 从工具结果里读到，而不是只写在给子 Agent 的提示词里
 * ——2026-09-12 的探针就是这么被骗的（要求「派前台隔离子 Agent」，机制按当时口径没隔离，
 * 父侧却以为隔离了）。
 *
 * **2026-09-16 不变式⑤**：写委派恒隔离 ⇒ git 工作区下**不再有**「直落父树」这一档，
 * `'parent-tree'` 已从枚举**删除**（不可达状态在类型上不可表示）。唯一残留的「没隔离」
 * 是**非 git 工作区**的自动降级（worktree 建不出来），即 `'skipped-non-git'`。
 */
describe('corumIsolationBoundaryNotice — 父 Agent 可见的隔离边界', () => {
  it('★ `parent-tree` 已删除：写委派不再有「直落父树」这一档', () => {
    // 编译期断言：'parent-tree' 不再是合法取值（若有人把它加回来，这行会失效）。
    // @ts-expect-error 'parent-tree' 已按不变式⑤删除（写委派恒隔离）
    const forbidden: Parameters<typeof corumIsolationBoundaryNotice>[0] = 'parent-tree'
    void forbidden
  })

  it('skipped-non-git：明说隔离因「不是 git 仓库」被跳过', () => {
    const text = corumIsolationBoundaryNotice('skipped-non-git')
    expect(text).toContain('PARENT working tree')
    expect(text).toContain('not isolated')
    expect(text).toContain('not a git repository')
    expect(text).toContain('ALREADY in your tree')
    expect(text).toContain('nothing will merge')
  })

  it('worktree：报已隔离 + 分支，且说明要经 integrate 才进主树', () => {
    const text = corumIsolationBoundaryNotice('worktree', 'wt/abc123')
    expect(text).toContain('ISOLATED worktree')
    expect(text).toContain('wt/abc123')
    expect(text).toContain('integrate')
  })

  it('两档互不混淆（父 Agent 不能把「没隔离」读成「隔离了」）', () => {
    const skipped = corumIsolationBoundaryNotice('skipped-non-git')
    const worktree = corumIsolationBoundaryNotice('worktree', 'wt/x')
    expect(skipped).not.toBe(worktree)
    expect(skipped).not.toContain('ISOLATED')
    expect(worktree).not.toContain('ALREADY in your tree')
  })

  it('语言纪律：工具结果里的说明用英文（与 prompt-language.spec.ts 同口径）', () => {
    for (const boundary of ['main-requested', 'skipped-non-git', 'worktree'] as const) {
      expect(/[\u4e00-\u9fff]/.test(corumIsolationBoundaryNotice(boundary, 'wt/x'))).toBe(false)
    }
  })
})

/**
 * fork（corum）2026-09-27（用户实机反馈）：「同意推送两个仓」之后，指挥者把 brief 交给
 * **默认隔离**的 worker ⇒ `git push` 被守卫硬拒（提权重试也拒、**不出卡**）⇒ 一个子会话
 * 只换来「this is a manual step or a non-isolated session」，推送没发生。
 *
 * 修法两层：① 提示词/persona 明说「需要真工作区就传 `isolation: \"main\"`」；
 * ② 本判据在**派发前**把这类组合拦下来（窄判据 + 否定语境豁免，宁可漏判不误伤）。
 */
describe('corumMainTreeIntentOf — 只有主树/非隔离会话才能做的意图（窄判据）', () => {
  it('★ 命中 push / pull / worktree 写 / branch 写', () => {
    expect(corumMainTreeIntentOf('Push both repos: run `git push origin main`')).toContain('git push')
    expect(corumMainTreeIntentOf('then run git push')).toContain('git push')
    expect(corumMainTreeIntentOf('git -C /repo push origin main')).toContain('git push')
    expect(corumMainTreeIntentOf('run git pull --rebase first')).toContain('git pull')
    expect(corumMainTreeIntentOf('run git worktree remove --force .corum-worktrees/wt-x')).toContain('git worktrees')
    expect(corumMainTreeIntentOf('run git branch -D wt/old')).toContain('branch ref')
  })

  it('★ 否定语境不误伤（"do NOT push" 是常见纪律句）', () => {
    for (const prompt of [
      'Do NOT push anything — just commit on your branch.',
      'never push; the integrator handles it',
      'you cannot push from this worktree, so report instead',
      'finish without pushing: commit only',
      'report whether a push is needed',
    ]) {
      expect(corumMainTreeIntentOf(prompt), prompt).toBeUndefined()
    }
  })

  it('普通实现类 brief 不触发（避免误伤正常委派）', () => {
    for (const prompt of [
      'Implement the parser in src/parse.ts and commit on your branch.',
      'Read the config, then edit src/a.ts so the flag defaults to true.',
      'Add a unit test for the new helper; do not touch other files.',
    ]) {
      expect(corumMainTreeIntentOf(prompt), prompt).toBeUndefined()
    }
  })
})

/**
 * 2026-09-27：**钉住「worker 恒隔离」这类过时声明不再回来**，并钉住新能力被写进模型可见文本。
 *
 * 上一轮我加了 `isolation` 参数，却漏改两处模型可见文本（subagent 工具描述与 orchestrate
 * 说明仍写「there is no opt-out」）⇒ 模型根本不会去用它，于是「推送分支」被派给隔离子 Agent。
 * 本用例把「描述必须提 main 路由」与「不得再声称没有 opt-out」同时钉死。
 */
describe('★ 提示词不得再声称「没有 opt-out / worker 恒隔离」（2026-09-27 实机）', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
  it('subagent 工具描述提到 isolation 的 main 路由，且不再有 no opt-out', () => {
    expect(src).toContain('Pass `isolation: \"main\"` when the child must work in your REAL tree')
    expect(src).not.toMatch(/no opt-out/i)
  })
  it('orchestrate 说明提到 task 级 isolation: \"main\"', () => {
    expect(src).toContain('declares `isolation: \"main\"`')
  })
})

