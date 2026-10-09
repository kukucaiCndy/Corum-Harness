/**
 * fork（corum）**收口强制提交**的单测（不变式②：commit-after-modification）。
 *
 * 为什么补这个文件（2026-09-18，用户定调）：本包的 `package.json` 一直声明
 * `"test": "vitest run"` 但仓库里**没有任何测试文件** ⇒ 脚本恒以 exit 1 失败。
 * 同时 `settleCommit` / `hasEffectiveChanges` 是全库**零覆盖**的机制兜底路径
 * ——它每轮对话都会跑，静默失效的后果是「空提交刷屏」或「改动丢在树里没人管」，
 * 两者都不会报错。故这里用**真实临时 git 仓库**逐条钉住规则。
 *
 * 用户规则原文（2026-09-18）：「**除了 .gitignore 中的之外，只要修改了就算有效**。
 * 当然 Agent 可以自己 check，有额外的可手动剔除并更新 .gitignore」。
 *   · ignored 路径 → 不算有效修改（git 的 porcelain 本就不列，故机制无需自建排除表）；
 *   · 其余任何改动（含**未跟踪新文件**）→ 算有效修改；
 *   · **没有有效修改 ⇒ 不提交**（否则每轮对话留下一条没有内容的提交）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hasEffectiveChanges, hasUncommittedChanges, independentRepoPathsOf, settleCommit, diffStatSummary, stashChanges } from '../src/git-primitives.ts'

const scratch = mkdtempSync(join(tmpdir(), 'corum-git-core-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

let seq = 0
/** 建一个干净的临时 git 仓库（含一次初始提交），返回其路径与该仓库的提交数查询。 */
function makeRepo(): { repo: string; commitCount: () => number; head: () => string } {
  const repo = join(scratch, `repo-${seq++}`)
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 'test@localhost')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'tracked.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '--no-verify', '-m', 'init')
  return {
    repo,
    commitCount: () => Number(git('rev-list', '--count', 'HEAD')),
    head: () => git('rev-parse', 'HEAD'),
  }
}

describe('hasEffectiveChanges — 有效修改的判据（.gitignore 之外都算）', () => {
  it('干净仓库 → 无有效修改', () => {
    const { repo } = makeRepo()
    expect(hasEffectiveChanges(repo)).toBe(false)
  })

  it('★ 只有 .gitignore 覆盖的改动 → **不算**有效修改（机制不自建产物排除表）', () => {
    const { repo } = makeRepo()
    writeFileSync(join(repo, '.gitignore'), '*.log\nbuild/\n')
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--no-verify', '-m', 'ignore'], { stdio: 'pipe' })
    // 现在制造「只有 ignored 改动」的状态
    writeFileSync(join(repo, 'noise.log'), 'noise\n')
    mkdirSync(join(repo, 'build'), { recursive: true })
    writeFileSync(join(repo, 'build', 'out.js'), 'x\n')
    expect(hasEffectiveChanges(repo), 'ignored 改动不得触发收口提交').toBe(false)
  })

  it('★ 未跟踪的新文件 → **算**有效修改（「Agent 新建源文件」就是真实工作）', () => {
    const { repo } = makeRepo()
    writeFileSync(join(repo, 'brand-new.ts'), 'export const x = 1\n')
    expect(hasEffectiveChanges(repo)).toBe(true)
  })

  it('已跟踪文件的内容修改 → 算', () => {
    const { repo } = makeRepo()
    appendFileSync(join(repo, 'tracked.txt'), 'two\n')
    expect(hasEffectiveChanges(repo)).toBe(true)
  })

  it('删除已跟踪文件 → 算', () => {
    const { repo } = makeRepo()
    unlinkSync(join(repo, 'tracked.txt'))
    expect(hasEffectiveChanges(repo)).toBe(true)
  })

  it('非 git 目录 / 不存在的目录 → false（不抛错）', () => {
    const plain = join(scratch, `plain-${seq++}`)
    mkdirSync(plain, { recursive: true })
    expect(hasEffectiveChanges(plain)).toBe(false)
    expect(hasEffectiveChanges(join(scratch, 'does-not-exist'))).toBe(false)
  })

  it('与 hasUncommittedChanges 判据一致（策略是 git 事实之上的命名层）', () => {
    const { repo } = makeRepo()
    expect(hasEffectiveChanges(repo)).toBe(hasUncommittedChanges(repo))
    appendFileSync(join(repo, 'tracked.txt'), 'x\n')
    expect(hasEffectiveChanges(repo)).toBe(hasUncommittedChanges(repo))
  })
})

describe('settleCommit — 没有有效修改就不提交（不留噪声提交）', () => {
  it('★★ 干净仓库：不提交、不造空提交（提交数不变）', () => {
    const { repo, commitCount } = makeRepo()
    const before = commitCount()
    expect(settleCommit(repo, 'wip(turn-abc): auto-commit on turn end')).toBeUndefined()
    expect(commitCount(), '干净状态下不得新增提交').toBe(before)
  })

  it('★★ 只有 ignored 改动：同样不提交（否则每轮对话都会留下一条没有内容的提交）', () => {
    const { repo, commitCount } = makeRepo()
    writeFileSync(join(repo, '.gitignore'), '*.log\n')
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--no-verify', '-m', 'ignore'], { stdio: 'pipe' })
    const before = commitCount()
    writeFileSync(join(repo, 'x.log'), 'noise\n')
    expect(settleCommit(repo, 'wip(turn-abc): auto-commit on turn end')).toBeUndefined()
    expect(commitCount(), 'ignored 改动不得产生提交').toBe(before)
  })

  it('★★ 连调用两次：第二次是 no-op（绝不出现空提交）', () => {
    const { repo, commitCount, head } = makeRepo()
    appendFileSync(join(repo, 'tracked.txt'), 'changed\n')
    expect(settleCommit(repo, 'wip(turn-1): auto-commit on turn end')).toBeUndefined()
    const after1 = commitCount()
    const head1 = head()
    expect(after1, '第一次应真的提交').toBe(2)
    // 第二次：树已干净 ⇒ 不提交
    expect(settleCommit(repo, 'wip(turn-1): auto-commit on turn end')).toBeUndefined()
    expect(commitCount(), '第二次不得产生提交').toBe(after1)
    expect(head(), 'HEAD 不得移动').toBe(head1)
  })

  it('有有效修改 → 提交，且把改动收进去（含未跟踪新文件）', () => {
    const { repo, commitCount } = makeRepo()
    appendFileSync(join(repo, 'tracked.txt'), 'more\n')
    writeFileSync(join(repo, 'added.ts'), 'export {}\n')
    expect(settleCommit(repo, 'wip(turn-2): auto-commit on turn end')).toBeUndefined()
    expect(commitCount()).toBe(2)
    const files = execFileSync('git', ['-C', repo, 'show', '--name-only', '--format=', 'HEAD'], {
      stdio: 'pipe', encoding: 'utf8',
    })
    expect(files).toContain('tracked.txt')
    expect(files, '未跟踪的新文件也应被收进提交').toContain('added.ts')
    // 收口后树是干净的
    expect(hasEffectiveChanges(repo)).toBe(false)
  })

  it('隔离前收口用的 subject 同样生效（同一原语、两种调用点）', () => {
    const { repo, commitCount } = makeRepo()
    appendFileSync(join(repo, 'tracked.txt'), 'x\n')
    expect(settleCommit(repo, 'wip(corum): auto-commit before isolation')).toBeUndefined()
    expect(commitCount()).toBe(2)
    const subject = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s'], {
      stdio: 'pipe', encoding: 'utf8',
    }).trim()
    expect(subject).toBe('wip(corum): auto-commit before isolation')
  })

  it('不存在的目录 → undefined（不抛错）', () => {
    expect(settleCommit(join(scratch, 'nope'), 'wip(x): y')).toBeUndefined()
  })

  it('非 git 目录 → undefined（不抛错）', () => {
    const plain = join(scratch, `plain2-${seq++}`)
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'f.txt'), 'x\n')
    expect(settleCommit(plain, 'wip(x): y')).toBeUndefined()
  })

  it('★ 收口提交不带 --allow-empty（防回潮：它会让每个项目都刷空提交）', () => {
    // 本仓唯一允许 --allow-empty 的地方是「建仓初始化」。收口路径绝不能有它，
    // 否则「没有有效修改就不提交」这道保证会被绕过。
    const src = execFileSync('node', ['-e', "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
      join(import.meta.dirname, '../src/git-primitives.ts')], { encoding: 'utf8' })
    const fn = src.slice(src.indexOf('export function settleCommit('), src.indexOf('\n}', src.indexOf('export function settleCommit(')))
    expect(fn).not.toContain('--allow-empty')
    expect(fn, 'settleCommit 必须走 hasEffectiveChanges 准入').toContain('hasEffectiveChanges')
  })
})

/**
 * fork（corum）2026-09-27（用户裁定）：**独立嵌套 git 仓不进自动提交**。
 *
 * 由来（会话 corum-task-56b7d485，两次实测污染）：
 *   · `cdb58d5 wip(isolated): auto-commit on settle` 把子 Agent 在 worktree 里新建的闭源仓
 *     记成 **gitlink**（mode 160000）⇒ 随后被 port 进开源仓主树的索引（幽灵 submodule）；
 *   · `456d3ef` 更严重：同一机制把剥离产物的 **36 个文件**提交进开源仓，进了 main 的祖先链，
 *     只能用 `git filter-repo` 重写未推送段历史清掉。
 * 用户裁定「嵌套新仓是独立产物」⇒ 收口提交必须排除它，并在提交信息里点名。
 */
describe('★ 独立嵌套 git 仓不进自动提交（2026-09-27）', () => {
  /** 在 repo 里造一个真正的独立嵌套仓（有自己的 .git 与一次提交）。 */
  function makeNested(repo: string, name: string): void {
    const dir = join(repo, name)
    mkdirSync(dir, { recursive: true })
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.email', 'nested@localhost')
    git('config', 'user.name', 'nested')
    writeFileSync(join(dir, 'inner.txt'), 'inner\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'inner init')
  }

  it('independentRepoPathsOf 只认「未跟踪顶层目录 + 其下有 .git」', () => {
    const { repo } = makeRepo()
    makeNested(repo, 'ClosedRepo')
    writeFileSync(join(repo, 'plain-dir-file.txt'), 'x\n')
    mkdirSync(join(repo, 'plain-dir'), { recursive: true })
    writeFileSync(join(repo, 'plain-dir', 'a.txt'), 'a\n')
    expect(independentRepoPathsOf(repo)).toEqual(['ClosedRepo'])
  })

  it('★★ 嵌套仓既不被收编也不产生 gitlink（ghost submodule 的根因）', () => {
    const { repo, commitCount } = makeRepo()
    makeNested(repo, 'ClosedRepo')
    writeFileSync(join(repo, 'real-work.txt'), 'work\n')
    expect(commitCount()).toBe(1)
    expect(settleCommit(repo, 'wip(isolated): auto-commit on settle')).toBeUndefined()
    expect(commitCount()).toBe(2)
    const tracked = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    // 真工作照常收进提交；嵌套仓内容一个字都不进本仓。
    expect(tracked).toContain('real-work.txt')
    expect(tracked).not.toContain('ClosedRepo/inner.txt')
    // 关键判据：索引里**没有** mode 160000 的条目。
    const staged = execFileSync('git', ['-C', repo, 'ls-files', '-s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(staged).not.toContain('160000')
    // 提交信息点名被排除的独立仓（可追责、可追溯）。
    const body = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(body).toContain('ClosedRepo')
  })

  it('嵌套仓留在原地（没被删除、没被 ignore、也不阻塞提交）', () => {
    const { repo } = makeRepo()
    makeNested(repo, 'ClosedRepo')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    expect(settleCommit(repo, 'wip(x): y')).toBeUndefined()
    expect(existsSync(join(repo, 'ClosedRepo', 'inner.txt'))).toBe(true)
    expect(existsSync(join(repo, 'ClosedRepo', '.git'))).toBe(true)
    expect(independentRepoPathsOf(repo)).toEqual(['ClosedRepo'])
  })
})

/**
 * fork（corum）2026-10-08：**产物路径排除**测试。
 *
 * 机制级硬排除清单（不依赖项目 .gitignore）：lib/ dist/ build/ main.js（任意深度）
 * tsbuildinfo node_modules。实测 packages/desktop/main.js 曾误入 git。
 */
describe('★ 产物路径排除（2026-10-08）', () => {
  it('只有产物改动 → hasEffectiveChanges 返回 false（不算有效修改）', () => {
    const { repo } = makeRepo()
    mkdirSync(join(repo, 'lib'), { recursive: true })
    writeFileSync(join(repo, 'lib', 'index.js'), 'bundle output\n')
    mkdirSync(join(repo, 'dist'), { recursive: true })
    writeFileSync(join(repo, 'dist', 'app.js'), 'packed\n')
    writeFileSync(join(repo, 'main.js'), 'desktop bundle\n')
    writeFileSync(join(repo, 'app.tsbuildinfo'), 'incremental info\n')
    expect(hasEffectiveChanges(repo), '产物改动不得触发收口提交').toBe(false)
  })

  it('产物 + 真实源码改动 → hasEffectiveChanges 返回 true（真改动在）', () => {
    const { repo } = makeRepo()
    writeFileSync(join(repo, 'main.js'), 'desktop bundle\n')
    appendFileSync(join(repo, 'tracked.txt'), 'real change\n')
    expect(hasEffectiveChanges(repo)).toBe(true)
  })

  it('diffStatSummary 排除产物、只统计有效改动', () => {
    const { repo } = makeRepo()
    mkdirSync(join(repo, 'lib'), { recursive: true })
    writeFileSync(join(repo, 'lib', 'index.js'), 'bundle\n')
    writeFileSync(join(repo, 'main.js'), 'packed\n')
    writeFileSync(join(repo, 'src.ts'), 'real source\n')
    const summary = diffStatSummary(repo, 3)
    expect(summary.effectiveFiles, '只算 src.ts 一个有效文件').toBe(1)
    expect(summary.totalFiles, '总改动含产物 = 3').toBe(3)
    expect(summary.lines.length).toBe(1)
    expect(summary.lines[0]).toContain('src.ts')
  })

  it('settleCommit 不提交产物路径（main.js 不进提交）', () => {
    const { repo, commitCount } = makeRepo()
    writeFileSync(join(repo, 'main.js'), 'desktop bundle\n')
    writeFileSync(join(repo, 'real.ts'), 'real source\n')
    expect(settleCommit(repo, 'feat: test artifact exclusion')).toBeUndefined()
    expect(commitCount()).toBe(2)
    const files = execFileSync('git', ['-C', repo, 'show', '--name-only', '--format=', 'HEAD'], {
      stdio: 'pipe', encoding: 'utf8',
    })
    expect(files, '真实源码应进提交').toContain('real.ts')
    expect(files, '产物 main.js 不应进提交').not.toContain('main.js')
  })

  it('stashChanges 暂存非产物改动（产物不进 stash）', () => {
    const { repo } = makeRepo()
    writeFileSync(join(repo, 'main.js'), 'packed\n')
    writeFileSync(join(repo, 'work.ts'), 'real work\n')
    expect(stashChanges(repo, 'wip(turn-test)')).toBeUndefined()
    // stash 后工作区干净
    expect(hasEffectiveChanges(repo)).toBe(false)
    // stash 列表里有一条
    const stashList = execFileSync('git', ['-C', repo, 'stash', 'list'], {
      stdio: 'pipe', encoding: 'utf8',
    }).trim()
    expect(stashList).toContain('wip(turn-test)')
  })

  it('无改动时 stashChanges 是 no-op', () => {
    const { repo } = makeRepo()
    expect(stashChanges(repo, 'wip(turn-test)')).toBeUndefined()
    const stashList = execFileSync('git', ['-C', repo, 'stash', 'list'], {
      stdio: 'pipe', encoding: 'utf8',
    }).trim()
    expect(stashList, '干净仓库不应产生 stash').toBe('')
  })
})
