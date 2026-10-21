/**
 * fork（corum）集成真值门禁单测（docs/TODO.md「orchestrate autoIntegrate 合并回
 * 主树不可靠」修复，2026-09-09）。
 *
 * 事故链条（本 spec 逐环设防）：
 *   集成者自称「已 merge + verify 通过」→ 机制无条件写台账 integrated 并
 *   `worktree remove --force` + `branch -D` → 子任务 commit 变 unreachable、
 *   文件从主树消失。修复后：
 *   1. corumBranchIntegrated — 分支工作是否真进入 HEAD（祖先或 patch 等价）；
 *   2. corumIntegrationTruth — 机制真值判定（未合并 / 写了没提交）；
 *   3. corumCleanupWorktree — 安全清理（未合并分支不删、脏 worktree 保留现场）；
 *   4. corumCleanupLedgerEntries — 仅完整清理才标 discarded（状态如实）；
 *   5. corumIntegrationFailure — 失败报告含「自述 vs 实况」对照 + 现场已保留。
 * 全部用真实临时 git 仓库驱动（无 mock），与 execute 层同一 git 命令面。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  corumBranchIntegrated,
  corumBranchMerged,
  corumBranchTip,
  corumCleanupLedgerEntries,
  corumCleanupWorktree,
  corumGit,
  corumGitHead,
  corumMergedBranches,
  corumReconcileIntegrated,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumIntegrationFailure,
  corumDirtyOwnershipLines,
  corumIntegrationTruth,
  corumIntegratorPersona,
  corumPartialIntegrationNotice,
  corumPortBranchDiff,
  corumPortPendingBranches,
  corumWorktreeHasUncommitted,
  type CorumWorktreeEntry,
} from '../src/index.ts'

const scratchDirs: string[] = []

/** 建一个真实 git 仓库 + 一个隔离 worktree/分支（复刻 spawnOne 的创建命令）。 */
function makeRepoWithWorktree(slug = 'wt-int001'): {
  repo: string
  worktree: string
  branch: string
  entry: CorumWorktreeEntry
} {
  const scratch = mkdtempSync(join(tmpdir(), 'corum-integrate-'))
  scratchDirs.push(scratch)
  const repo = join(scratch, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
  const branch = `wt/${slug}`
  const worktree = join(repo, '.corum-worktrees', slug)
  corumGit(repo, ['worktree', 'add', '-q', worktree, '-b', branch])
  return {
    repo,
    worktree,
    branch,
    entry: { slug, branch, path: worktree, status: 'settled' },
  }
}

/** 在 worktree 里写文件并提交（子 Agent 的正常产出形态）。 */
function commitInWorktree(worktree: string, file: string, content = 'child payload'): string {
  writeFileSync(join(worktree, file), content)
  execFileSync('git', ['-C', worktree, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', `add ${file}`], { stdio: 'pipe' })
  return execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/** 分支是否还存在（清理安全阀的判定面）。 */
function branchExists(repo: string, branch: string): boolean {
  return execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== ''
}

beforeEach(() => { /* scratch 每例独立创建 */ })

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('corumBranchIntegrated — 分支工作是否真进入 HEAD', () => {
  it('子任务已提交但未合并 → false（未并入 HEAD）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    expect(corumBranchMerged(repo, branch)).toBe(false)
    expect(corumBranchIntegrated(repo, branch)).toBe(false)
  })

  it('真实 merge --no-ff 后 → true（祖先关系）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    expect(corumBranchIntegrated(repo, branch)).toBe(true)
  })

  it('cherry-pick 等价落地（分支非祖先）→ true（patch 等价兜底）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree()
    const sha = commitInWorktree(worktree, 'ORCH-INT-2.txt')
    // 用不同 committer 身份落地，避免 SHA 与子任务 commit 相同（同身份 + 同秒会
    // 产生同一对象，祖先判定会误判为已合并，测不到 cherry 等价分支）。
    corumGit(repo, ['-c', 'user.name=integrator', '-c', 'user.email=int@corum.local', 'cherry-pick', sha])
    expect(corumBranchMerged(repo, branch)).toBe(false) // 非祖先
    expect(corumBranchIntegrated(repo, branch)).toBe(true) // 但工作已落地
  })

  it('分支无新提交 → true（空 cherry 输出，不误判）', () => {
    const { repo, branch } = makeRepoWithWorktree()
    expect(corumBranchIntegrated(repo, branch)).toBe(true)
  })
})

describe('corumIntegrationTruth — 机制真值门禁', () => {
  // fork（corum）2026-09-12 语义修正：`uncommitted` 不再参与 `integrated`。
  // 实测事故：兄弟 worktree 的一个 scratch 残留文件让**已落地**的集成被判失败
  // （corum-task-d51272e3：主树 HEAD 704f855e → 254df321 已合并，却收到
  // 「integrate did not persist into the main tree」），主 Agent 的后续
  // 「验证 + 提交 + 落位」三阶段整条没起来。现在：
  //   · 「分支是否已并入 HEAD」= 集成失败的唯一闸门（真未落地仍抛错 + 保留现场）；
  //   · 未提交改动 = 该条目**保持 pending、保留现场**，由调用方通知主 Agent 处理。
  it('写了没提交（分支无新提交 + worktree 脏）→ integrated=true（分支口径），但如实报 uncommitted', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree()
    writeFileSync(join(worktree, 'ORCH-INT-1.txt'), 'written but never committed')
    const truth = corumIntegrationTruth(repo, [entry])
    expect(truth.integrated).toBe(true)
    expect(truth.unmerged).toEqual([])
    expect(truth.uncommitted.join(' ')).toContain(entry.slug)
  })

  it('部分集成会给出可读说明（未持久化条目 + 下一步）', () => {
    const { repo, worktree, entry, branch } = makeRepoWithWorktree()
    writeFileSync(join(worktree, 'ORCH-INT-1.txt'), 'written but never committed')
    const truth = corumIntegrationTruth(repo, [entry])
    const notice = corumPartialIntegrationNotice(truth, 'deadbeefdeadbeef')
    expect(notice).toContain('PARTIALLY persisted')
    expect(notice).toContain(entry.slug)
    expect(notice).toContain('kept pending')
    expect(branch).toBe(entry.branch)
  })

  it('已提交未合并 → integrated=false 且报 unmerged', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const truth = corumIntegrationTruth(repo, [entry])
    expect(truth.integrated).toBe(false)
    expect(truth.unmerged).toEqual([branch])
  })

  it('真实合并 + worktree 干净 → integrated=true，HEAD 前进', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const before = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    const truth = corumIntegrationTruth(repo, [entry], '')
    expect(truth.integrated).toBe(true)
    expect(truth.head).not.toBe(before)
    expect(existsSync(join(repo, 'ORCH-INT-1.txt'))).toBe(true)
  })

  it('dirtyDelta 只报集成后新增的未提交路径（基线过滤）', () => {
    const { repo, entry } = makeRepoWithWorktree()
    writeFileSync(join(repo, 'unrelated.txt'), 'pre-existing')
    const before = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    writeFileSync(join(repo, 'new-from-integrate.txt'), 'stray')
    const truth = corumIntegrationTruth(repo, [entry], before)
    expect(truth.dirtyDelta.join(' ')).toContain('new-from-integrate.txt')
    expect(truth.dirtyDelta.join(' ')).not.toContain('unrelated.txt')
  })

  // 2026-09-13 收口（risk orchestration.integrator.dirty-main-tree）：主树脏时报告
  // 必须说清两块 diff 的归属——「既存无关在制品」与「本轮新增」分开报，否则「主树
  // 有未提交改动」会被读成本轮的锅（2026-09-12 事故里集成者正是这么判的）。
  //
  // 夹具注意：worktree 建在 repo 内的 `.corum-worktrees/`，所以主树 porcelain 天然
  // 带一条 `?? .corum-worktrees/`；基线条数一律**从实况算**，不硬编码。
  const porcelainLines = (raw: string): string[] => raw.split('\n').filter(line => line.trim() !== '')

  it('dirtyBeforeCount 如实报「集成前主树就有」的未提交条数，且不影响判据', () => {
    const { repo, entry } = makeRepoWithWorktree()
    writeFileSync(join(repo, 'wip-a.txt'), 'my work in progress')
    writeFileSync(join(repo, 'wip-b.txt'), 'more wip')
    const before = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    const truth = corumIntegrationTruth(repo, [entry], before)
    expect(truth.dirtyBeforeCount).toBe(porcelainLines(before).length)
    expect(truth.dirtyDelta).toEqual([])
    expect(truth.integrated).toBe(true) // 分支口径与主树脏不脏无关
  })

  it('归属行：既存在制品只算既存，不混进「本轮新增」', () => {
    const { repo, entry } = makeRepoWithWorktree()
    writeFileSync(join(repo, 'wip-a.txt'), 'my work in progress')
    const before = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    const prior = porcelainLines(before).length
    writeFileSync(join(repo, 'integrator-stray.txt'), 'written by integrator outside its worktree')
    const truth = corumIntegrationTruth(repo, [entry], before)
    const text = corumDirtyOwnershipLines(truth).join('\n')
    expect(text).toContain(`ALREADY had ${prior} uncommitted path`)
    expect(text).toContain('unrelated work-in-progress')
    expect(text).toContain('gained 1 uncommitted path')
    expect(text).toContain('integrator-stray.txt')
    expect(text).not.toContain('wip-a.txt') // 既存的不进「本轮新增」清单
  })

  it('基线 == 当前实况（本轮没新增脏）→ 只说既存，不产生「新增」噪音', () => {
    const { repo, entry } = makeRepoWithWorktree()
    writeFileSync(join(repo, 'wip-a.txt'), 'my work in progress')
    const before = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    const truth = corumIntegrationTruth(repo, [entry], before)
    const text = corumDirtyOwnershipLines(truth).join('\n')
    expect(truth.dirtyDelta).toEqual([])
    expect(text).toContain('ALREADY had')
    expect(text).not.toContain('gained')
  })

  it('失败报告里既存在制品先于「现场已保留」出现（先归属、后清单）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree()
    writeFileSync(join(repo, 'wip-a.txt'), 'my work in progress')
    const before = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    commitInWorktree(worktree, 'ORCH-INT-1.txt') // 提交了但没合并 → 真未落地
    const truth = corumIntegrationTruth(repo, [entry], before)
    const report = corumIntegrationFailure(truth, 'deadbeefdeadbeef', [entry])
    expect(truth.integrated).toBe(false)
    // 2026-09-20：文案改为「无并入证据」——旧的「branches NOT integrated into HEAD」把
    // 「已合并后被合规删除的分支」也算进失败，正是本场修的误判（见
    // integrate-branch-deleted.spec.ts）。语义不变：仍然是「这些条目没证明进 HEAD」。
    expect(report).toContain('NO evidence of being integrated into HEAD')
    expect(report).toContain('ALREADY had')
    expect(report.indexOf('ALREADY had')).toBeLessThan(report.indexOf('PRESERVED'))
  })
})

describe('corumCleanupWorktree — 清理安全阀（事故核心防线）', () => {
  it('非 force + 未合并分支 → 保留分支，回收干净目录，返回未完整清理', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const cleaned = corumCleanupWorktree(repo, entry, { force: false })
    expect(cleaned).toBe(false)
    expect(branchExists(repo, branch)).toBe(true) // 工作唯一留存保住了
    expect(existsSync(worktree)).toBe(false) // 目录已回收
    // 分支上的 commit 仍可从仓库读取（数据未丢）
    expect(execFileSync('git', ['-C', repo, 'log', '--oneline', branch], { encoding: 'utf8' }))
      .toContain('add ORCH-INT-1.txt')
  })

  it('非 force + 脏 worktree → 连目录一起保留（现场完整）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    writeFileSync(join(worktree, 'ORCH-INT-1.txt'), 'uncommitted')
    const cleaned = corumCleanupWorktree(repo, entry, { force: false })
    expect(cleaned).toBe(false)
    expect(existsSync(join(worktree, 'ORCH-INT-1.txt'))).toBe(true)
    expect(branchExists(repo, branch)).toBe(true)
  })

  it('非 force + 已合并干净 → 完整清理（目录 + 分支）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    const cleaned = corumCleanupWorktree(repo, entry, { force: false })
    expect(cleaned).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('force → 无条件强删（仅集成成功后调用）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const cleaned = corumCleanupWorktree(repo, entry, { force: true })
    expect(cleaned).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
  })
})

describe('corumCleanupLedgerEntries — 台账状态如实', () => {
  it('未合并 → 条目保持 settled（不标 discarded，落盘可见）', () => {
    const { repo, entry } = makeRepoWithWorktree()
    commitInWorktree(entry.path, 'ORCH-INT-1.txt')
    corumCleanupLedgerEntries(repo, [entry], ['settled'], { force: false })
    expect(entry.status).toBe('settled')
  })

  it('force 完整清理 → 标 discarded', () => {
    const { repo, entry } = makeRepoWithWorktree()
    corumCleanupLedgerEntries(repo, [entry], ['settled'], { force: true })
    expect(entry.status).toBe('discarded')
  })

  it('不在目标 status 集合的条目不被动', () => {
    const { repo, entry } = makeRepoWithWorktree()
    corumCleanupLedgerEntries(repo, [entry], ['active'], { force: true })
    expect(entry.status).toBe('settled')
    expect(existsSync(entry.path)).toBe(true)
  })
})

describe('corumIntegrationFailure — 失败报告（自述 vs 实况）', () => {
  it('含未合并分支、HEAD 前后、现场保留声明、集成者自述', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const truth = corumIntegrationTruth(repo, [entry])
    const message = corumIntegrationFailure(truth, 'deadbeefdeadbeef', [entry], 'I merged everything and all checks passed.')
    expect(message).toContain(branch)
    expect(message).toContain('did not persist into the main tree')
    expect(message).toContain('PRESERVED')
    expect(message).toContain('NOT trusted as evidence')
    expect(message).toContain('I merged everything and all checks passed.')
  })
})

describe('corumIntegratorPersona — 破坏性 git 命令禁令', () => {
  it('禁用 reset --hard / checkout . / clean -fd / stash，并声明机制会独立复核', () => {
    const persona = corumIntegratorPersona([], [])
    expect(persona).toContain('git reset --hard')
    expect(persona).toContain('git clean -fd')
    expect(persona).toContain('independently verifies')
  })
})

describe('corumPortBranchDiff — 脏主树/未提交场景的集成 diff 口（2026-09-14 B）', () => {
  it('主树干净时把分支工作落成主树提交，且工作区不被动过', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-port01')
    commitInWorktree(worktree, 'PORT-1.txt', 'from child')
    const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const result = corumPortBranchDiff(repo, { ...entry, base }, 'port child work')
    expect(result.applied).toBe(true)
    expect(result.base).toBe(base)
    expect(result.patchBytes).toBeGreaterThan(0)
    // HEAD 前进、分支的工作真的进 HEAD（真值门禁判通过）。
    expect(result.head).toBe(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
    expect(corumIntegrationTruth(repo, [entry]).integrated).toBe(true)
    // 工作区与本分支一致：文件在位、内容正确（派生物同步，但不做全树 checkout）。
    expect(existsSync(join(repo, 'PORT-1.txt'))).toBe(true)
    expect(execFileSync('git', ['-C', repo, 'show', 'HEAD:PORT-1.txt'], { encoding: 'utf8' })).toBe('from child')
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'PORT-1.txt'], { encoding: 'utf8' })).toBe('')
    expect(branch).toContain('wt/wt-port01')
  })

  it('主树有无关未提交在制品 → 照常落盘（那正是这条口的场景），在制品一字未动', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-port02')
    commitInWorktree(worktree, 'PORT-2.txt', 'landed')
    writeFileSync(join(repo, 'WIP-unrelated.txt'), 'mine, do not touch')
    const result = corumPortBranchDiff(repo, entry)
    expect(result.applied).toBe(true)
    expect(corumIntegrationTruth(repo, [entry]).integrated).toBe(true)
    expect(readFileSync(join(repo, 'WIP-unrelated.txt'), 'utf8')).toBe('mine, do not touch')
    // 在制品仍是未提交（口子没有把它卷进提交）。
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'WIP-unrelated.txt'], { encoding: 'utf8' })).toContain('WIP-unrelated.txt')
  })

  it('分支要改的文件在主树里也有未提交改动 → 拒绝并点名（不猜谁覆盖谁）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-port02b')
    commitInWorktree(worktree, 'CLASH.txt', 'from child')
    writeFileSync(join(repo, 'CLASH.txt'), 'my unsaved edit\n')
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const result = corumPortBranchDiff(repo, entry)
    expect(result.applied).toBe(false)
    expect(result.error).toContain('CLASH.txt')
    expect(readFileSync(join(repo, 'CLASH.txt'), 'utf8')).toBe('my unsaved edit\n')
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(head)
  })

  it('缺失 base → 退化为与 HEAD 的分叉点（不报错、不误判）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-port03')
    commitInWorktree(worktree, 'PORT-3.txt')
    const result = corumPortBranchDiff(repo, entry)
    expect(result.applied).toBe(true)
    expect(result.base).not.toBe('')
  })

  it('分支没有任何相对改动 → applied=false 且说明原因（不是错误，也不动主树）', () => {
    const { repo, entry } = makeRepoWithWorktree('wt-port04')
    const result = corumPortBranchDiff(repo, entry)
    expect(result.applied).toBe(false)
    expect(result.error).toContain('no diff')
  })

  it('三方冲突 → applied=false，工作区与 HEAD 都保持原样（临时 index 试合，不落半成品）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-port05')
    writeFileSync(join(worktree, 'CONFLICT.txt'), 'child version\n')
    execFileSync('git', ['-C', worktree, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', 'child conflict'], { stdio: 'pipe' })
    const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    // 主树对同一文件写了一个互斥的版本并提交（制造真冲突）。
    writeFileSync(join(repo, 'CONFLICT.txt'), 'main version\n')
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'main conflict'], { stdio: 'pipe' })
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const result = corumPortBranchDiff(repo, { ...entry, base })
    expect(result.applied).toBe(false)
    expect(result.error).toBeTruthy()
    // 冲突文件保持主树版本、工作区干净、HEAD 未动——试合发生在临时 index 上。
    expect(readFileSync(join(repo, 'CONFLICT.txt'), 'utf8')).toBe('main version\n')
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(head)
  })

  it('corumPortPendingBranches 逐条处理，顺序与入参一致', () => {
    const a = makeRepoWithWorktree('wt-port06')
    commitInWorktree(a.worktree, 'PORT-6a.txt')
    const b = makeRepoWithWorktree('wt-port07')
    const results = corumPortPendingBranches(a.repo, [a.entry, { ...b.entry, path: b.worktree }])
    expect(results.map(r => r.branch)).toEqual([a.entry.branch, b.entry.branch])
    expect(results[0].applied).toBe(true)
    expect(results[1].applied).toBe(false)
  })
})

describe('corumWorktreeHasUncommitted — worktree 脏判定', () => {
  it('干净 worktree → false；写入未提交 → true；目录不存在 → false', () => {
    const { worktree } = makeRepoWithWorktree()
    expect(corumWorktreeHasUncommitted(worktree)).toBe(false)
    writeFileSync(join(worktree, 'dirty.txt'), 'x')
    expect(corumWorktreeHasUncommitted(worktree)).toBe(true)
    expect(corumWorktreeHasUncommitted(join(worktree, 'nope'))).toBe(false)
  })
})

/**
 * fork（corum）2026-10：**`corumAutoIntegrate` 的断言已退役**（用户定稿「取消 merge 字段」）。
 *
 * 旧断言钉的是「传了 merge ⇒ 机制收尾 / 不传 ⇒ 分支留给调用方」。现在编排不再有 merge 声明：
 * 收尾行为由机制按**隔离实况**自动判定（见 `closer.spec.ts` 的 `closerScenarioOf` 断言），
 * 故这组断言的对象（merge 声明）已不存在。保留这段说明而不是静默删掉，是为了让下一个
 * 「想顺手把 merge 加回来」的人看到它是被裁决掉的。
 */

describe('corumCleanupLedgerEntries — 已集成与已丢弃分档（2026-09-12 用户定调）', () => {
  it('已集成 + 完整清理 → 状态保持 integrated 并标 reclaimed（不是「已丢弃」）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-split1')
    commitInWorktree(worktree, 'SPLIT-1.txt')
    corumGit(repo, ['-c', 'user.name=c', '-c', 'user.email=c@corum.local', 'merge', '--no-ff', '-m', 'merge(wt-split1)', branch])
    const rows: CorumWorktreeEntry[] = [{ ...entry, status: 'integrated' }]
    corumCleanupLedgerEntries(repo, rows, ['integrated'], { force: true })
    expect(rows[0]?.status).toBe('integrated') // 工作进了主树 → 不能写「已丢弃」
    expect(rows[0]?.reclaimed).toBe(true)
    expect(existsSync(worktree)).toBe(false)
  })

  it('未集成就被清掉 → 落 discarded（那才是真丢弃）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-split2')
    commitInWorktree(worktree, 'SPLIT-2.txt')
    const rows: CorumWorktreeEntry[] = [{ ...entry, status: 'settled' }]
    corumCleanupLedgerEntries(repo, rows, ['settled'], { force: true })
    expect(rows[0]?.status).toBe('discarded')
    expect(rows[0]?.reclaimed).toBe(true)
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('安全清理没清干净 → 状态与 reclaimed 都不动（现场还在）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-split3')
    writeFileSync(join(worktree, 'wip.txt'), 'x')
    const rows: CorumWorktreeEntry[] = [{ ...entry, status: 'settled' }]
    corumCleanupLedgerEntries(repo, rows, ['settled'], { force: false })
    expect(rows[0]?.status).toBe('settled')
    expect(rows[0]?.reclaimed).toBeUndefined()
  })
})

describe('corumReapRestoredEntries — 启动清扫（重启杀掉的僵尸子 Agent 不再永远占着 worktree）', () => {
  it('空分支 + 干净 worktree → 现场回收，条目剔除', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-reap1')
    // 空分支（worktree 建好后一个提交都没做）——重启杀掉子 Agent 的典型形态
    const kept = corumReapRestoredEntries(repo, [{ ...entry, status: 'active' }])
    expect(kept).toEqual([])
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('未提交改动 → 保留目录，条目保留（唯一副本不能丢）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-reap2')
    writeFileSync(join(worktree, 'wip.txt'), '写了一半的工作')
    const kept = corumReapRestoredEntries(repo, [{ ...entry, status: 'active' }])
    expect(kept.length).toBe(1)
    expect(existsSync(join(worktree, 'wip.txt'))).toBe(true)
  })

  it('分支有未并入 HEAD 的提交 → 保留分支与条目（那是唯一留存；目录按既有安全语义可清）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-reap3')
    commitInWorktree(worktree, 'ORCH-REAP-3.txt')
    const kept = corumReapRestoredEntries(repo, [{ ...entry, status: 'settled' }])
    expect(kept.length).toBe(1)
    // 安全清理的既有语义：**分支**（提交的唯一留存）必须保留，目录本身可清
    // （与 cleanupOnDispose 同款——提交进了分支，工作没有丢）。
    expect(branchExists(repo, branch)).toBe(true)
    expect(existsSync(worktree)).toBe(false)
  })
})

describe('corumReconcileIntegrated — 台账认账「外包出去的合并」（2026-09-12 用户实测）', () => {
  it('分支已被合并进 HEAD（机制没参与）→ 条目翻成 integrated', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    // 主 Agent 派子 Agent 直接用 git 合并（机制不知道）
    corumGit(repo, ['-c', 'user.name=child', '-c', 'user.email=child@corum.local', 'merge', '--no-ff', '-m', 'merge(wt)', branch])
    const before = corumIntegrationTruth(repo, [entry])
    expect(before.unmerged).toEqual([]) // git 真相：已落地
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([entry.slug])
    expect(reconciled.entries[0]?.status).toBe('integrated')
  })

  it('分支未合并 → 不动（保持 settled）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-2.txt')
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([])
    expect(reconciled.entries[0]?.status).toBe('settled')
  })

  it('纯空分支（tip === HEAD）→ 不翻：`--merged` 会把「什么都没干」的分支也列进来', () => {
    const { repo, branch, entry } = makeRepoWithWorktree()
    // 只建分支不提交：git branch --merged HEAD 照样列出它（fixture 的形态）
    expect(corumBranchTip(repo, branch)).toBe(corumGitHead(repo))
    expect(corumMergedBranches(repo).has(branch)).toBe(true)
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([])
    expect(reconciled.entries[0]?.status).toBe('settled')
  })

  it('分支不存在 → corumBranchTip undefined 且不翻（对账退化为不动）', () => {
    const { repo, entry } = makeRepoWithWorktree()
    expect(corumBranchTip(repo, 'wt/wt-nope')).toBeUndefined()
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([])
  })
})

describe('corumReapOrphanWorktrees — 台账之外的孤儿 worktree 清扫（2026-09-12 实测 10 个纯空目录）', () => {
  it('干净 + 分支对 HEAD 零新增 → 目录与分支一起回收', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-orphan1')
    expect(corumReapOrphanWorktrees(repo)).toBe(1)
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('分支带着独立提交 → 整个留（那是唯一留存）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-orphan2')
    commitInWorktree(worktree, 'ORPHAN-2.txt')
    expect(corumReapOrphanWorktrees(repo)).toBe(0)
    expect(branchExists(repo, branch)).toBe(true)
    expect(existsSync(worktree)).toBe(true)
  })

  it('有未提交改动 → 留目录（重跑也不动）', () => {
    const { repo, worktree } = makeRepoWithWorktree('wt-orphan3')
    writeFileSync(join(worktree, 'wip.txt'), 'x')
    expect(corumReapOrphanWorktrees(repo)).toBe(0)
    expect(existsSync(join(worktree, 'wip.txt'))).toBe(true)
  })

  it('在册（keep 集合内）→ 不碰，即便干净无提交', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-orphan4')
    expect(corumReapOrphanWorktrees(repo, new Set([worktree]))).toBe(0)
    expect(existsSync(worktree)).toBe(true)
    expect(branchExists(repo, branch)).toBe(true)
  })

  it('只扫本仓 .corum-worktrees 根下的 worktree（别人的不碰）', () => {
    const { repo } = makeRepoWithWorktree('wt-orphan5')
    const outside = join(repo, 'elsewhere', 'wt-manual')
    corumGit(repo, ['worktree', 'add', '-q', outside, '-b', 'manual/branch'])
    // 路径形态按 realpath 归一（macOS tmpdir 的 /var ↔ /private/var），只断言「是本仓
    // .corum-worktrees 下那一个」——序号与后缀足够，不锁 tmpdir 前缀。
    // ⚠️ 尾部比较要按 `/` 归一：`corumListIsolatedWorktrees` 返回的是 **git 的原始输出**，
    // 而 git 的路径恒用正斜杠；`join()` 在 Windows 上产出 `\` ⇒ `endsWith` 必假
    // （2026-10-21 Windows leg 实测）。
    const listed = corumListIsolatedWorktrees(repo)
    expect(listed.length).toBe(1)
    expect(listed[0].path.replace(/\\/g, '/').endsWith('.corum-worktrees/wt-orphan5')).toBe(true)
    expect(corumReapOrphanWorktrees(repo)).toBe(1)
    expect(existsSync(outside)).toBe(true)
  })
})

/**
 * fork（corum）2026-09-20：**集成者报告必须带回主 Agent**（用户实测报障）。
 *
 * 用户原话：「orchestrate 的结果只给了 integrated: true，没有 verify 输出……我希望机制上
 * 能够让最后合并者将合并结果、前面所有子 Agent 执行中提及需要注意的点都汇总后报告给主 Agent」。
 *
 * 实测（会话 corum-task-36e24826）：集成者**确实写了** 1864 字符的报告，含「分支落地确认」表
 * 与「需要委派方注意的几点」（构建产物在 lib/ 不是 dist/、某分支含 auto-commit），而
 * `settleForegroundRun` 已把正文放在 `integrateOutcome.output`，代码却**只取 runId 就丢弃**。
 * ⇒ 主 Agent 只看到 `integrated: true`，用户只能自己进子会话翻。
 *
 * 这些断言钉住「报告进结果」这条通路；`corumOutputText` 的折文本口径与
 * `withDiagnosticAndPartialText` 同源（只取 text block 拼接）。
 */
/**
 * fork（corum）2026-10：**报告透传的载体从集成者换成了 closer**（`merge` 字段取消）。
 *
 * 旧断言钉的是「集成者（`runIntegrate` → `integrateOutcome`）的报告正文透到 orchestrate 的
 * `integration.report`」。现在收尾由 closer 完成，报告的载体是 `closer.report`——同一条用户
 * 诉求（「把合并结果 + 前面所有子 Agent 需要注意的点汇总后报告给主 Agent」）继续被钉住，
 * 只是换了个出口。
 */
describe('收尾报告透传（2026-09-20 用户诉求；2026-10 载体改为 closer）', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

  it('closer 的报告正文来自它的最终答复（corumOutputText 折文本）', () => {
    expect(src).toContain('const report = corumOutputText(outcome.output).trim()')
  })

  it('report 一路透到 orchestrate 的工具结果（schema + render 投影）', () => {
    // schema 声明 + render 投影两处都要有 report（少一处就是 INVALID_TOOL_OUTPUT 整块吞结果）。
    expect(src).toMatch(/closer\?: \{[^\n]*report\?: string/)
    expect(src).toContain('...(out.closer.report !== undefined ? { report: out.closer.report } : {})')
    // 落盘路径同样是契约的一部分（报告写 CORUM_HOME 临时路径）。
    expect(src).toContain('...(out.closer.reportPath !== undefined ? { reportPath: out.closer.reportPath } : {})')
  })

  it('报告为空时如实报错（不产生「成功但没有报告」的假象）', () => {
    // closer 的交付物就是报告：没有报告 = 本次编排没有结果，必须 fail-loud 到 `closer.error`。
    expect(src).toContain("error: 'the closer returned no report'")
  })

  it('折文本只取 text block（与 withDiagnosticAndPartialText 同口径）', () => {
    const i = src.indexOf('function corumOutputText')
    expect(i).toBeGreaterThan(-1)
    const body = src.slice(i, src.indexOf('\n}', i))
    expect(body).toContain("block.type === 'text'")
    expect(body).toContain(".join('')")
  })
})

/**
 * fork（corum）2026-09-27（用户裁定）：**拒收仍带 gitlink 的分支**。
 *
 * 由来（实测）：`dcf5082 port wt/wt-471e5f: 1 file(s)` —— 子 Agent 在自己的 worktree 里
 * 新建了一个闭源仓（嵌套 git 仓），隔离收口把它记成 **gitlink**（mode 160000），port 又
 * 把这条 gitlink 搬进了开源仓主树的索引：一条连 `.gitmodules` 都没有的**幽灵 submodule**。
 * 用户裁定「嵌套新仓是独立产物」⇒ port 必须硬拒，而不是把指针合进来。
 *
 * 判据只看**分支树尖**是否仍含 gitlink（不看 diff）⇒ 「删除 gitlink」的清理提交照常可落盘。
 */
describe('★ corumPortBranchDiff 拒收 gitlink（独立嵌套仓，2026-09-27）', () => {
  it('★ 分支带嵌套仓 ⇒ applied=false + 点名，且主树 HEAD 不前进', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-portgl1')
    const nested = join(worktree, 'ClosedRepo')
    mkdirSync(nested, { recursive: true })
    const nestedGit = (...args: string[]): string =>
      execFileSync('git', ['-C', nested, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim()
    nestedGit('init', '-q')
    nestedGit('config', 'user.email', 'nested@localhost')
    nestedGit('config', 'user.name', 'nested')
    writeFileSync(join(nested, 'inner.txt'), 'inner\n')
    nestedGit('add', '-A')
    nestedGit('commit', '-q', '--no-verify', '-m', 'nested init')
    // 在子分支上把嵌套仓「加进来」⇒ git 记成 gitlink（这正是实测那次收口提交的形态）。
    execFileSync('git', ['-C', worktree, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', worktree, '-c', 'user.name=child', '-c', 'user.email=child@localhost',
      'commit', '-q', '--no-verify', '-m', 'child: add nested repo'], { stdio: 'pipe' })
    const branchTree = execFileSync('git', ['-C', worktree, 'ls-files', '-s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(branchTree).toContain('160000')          // 前提坐实：分支树里真有 gitlink
    const headBefore = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const result = corumPortBranchDiff(repo, entry)
    expect(result.applied).toBe(false)
    expect(result.error).toContain('INDEPENDENT nested git repository')
    expect(result.error).toContain('ClosedRepo')
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(headBefore)
    expect(execFileSync('git', ['-C', repo, 'ls-files', '-s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).not.toContain('160000')
  })
})

/**
 * fork（corum）2026-09-27（T7 实机验收抓到）：**orchestrate 输出 schema 必须声明
 * `integration.report`**。
 *
 * 实测原文：`Error: tool "orchestrate" returned invalid output: "value.integration.report"
 * is not a declared property (additionalProperties: false)` —— 2026-09-20 把集成者报告正文
 * 加进返回值时漏了 schema，于是**每次集成者产出报告，整个 orchestrate 结果都被顶替**
 * （results 全丢），子任务的隔离分支留在那里没人合（实机：`wt/wt-bce8fc` 未合并）。
 * 本用例按源码文本做对账：值里写 `report` ⇒ schema 里必须声明 `report`。
 */
describe('★ orchestrate 输出 schema ↔ 返回值对账（2026-09-27 实机缺陷）', () => {
  it('integration.report 既在返回值里、也在 schema 里声明', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
    // 返回值侧：`out.integration.report !== undefined ? { report: ... }`
    expect(src).toContain('out.integration.report !== undefined ? { report:')
    // schema 侧：integration 对象里声明了 report
    const schemaStart = src.indexOf('integration: {')
    expect(schemaStart).toBeGreaterThan(-1)
    const schemaBlock = src.slice(schemaStart, schemaStart + 2000)
    expect(schemaBlock).toContain('report: { type: \'string\' }')
  })
})
