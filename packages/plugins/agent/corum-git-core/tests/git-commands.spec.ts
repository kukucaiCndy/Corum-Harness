/**
 * 面板两个写操作的 **git 命令语义** 回归（2026-11-26）。
 *
 * ## 为什么测这个
 *
 * 写操作里踩过的坑全都不是 TypeScript 能发现的，而是「凭印象写 git 命令」：
 *   · `git checkout -- <branch>` 看着像「切到分支」，实际是**恢复文件**语义 ——
 *     分支名撞上工作树里任一文件时会清掉用户改动，否则直接 `pathspec did not match`；
 *   · 裸 `git commit` 会把 index 里别人已暂存的内容一起带进这次提交，用户的
 *     「只勾这两个文件」就形同虚设。
 *
 * 判据用真实临时仓库跑真 git，而不是断言「我传了哪些 argv」——后者只能证明我
 * 自己写对了调用，证明不了 git 的行为是我以为的那个。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'corum-git-cmds-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

/**
 * 建一个带初始提交的临时仓库。
 * @param name - 目录名（用例间隔离）。
 * @returns 仓库路径与该仓库的 git 执行器。
 */
function makeRepo(name: string): { repo: string; git: (...args: string[]) => string } {
  const repo = join(scratch, name)
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=test@localhost', '-c', 'user.name=test', ...args],
      { stdio: 'pipe', encoding: 'utf8' }).trim()
  git('init', '-q')
  return { repo, git }
}

describe('switchBranch 的 git 语义', () => {
  it('`git switch <branch>` 真的切过去', () => {
    const { repo, git } = makeRepo('switch')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    git('switch', '-q', '-c', 'feature')
    git('switch', '-q', '-')
    const base = git('rev-parse', '--abbrev-ref', 'HEAD')
    expect(base).not.toBe('feature')
    git('switch', 'feature')
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature')
  })

  it('`git checkout -- <branch>` 不是切分支（这条是「别改回去」的反证）', () => {
    const { repo, git } = makeRepo('checkout-pitfall')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    git('checkout', '-q', '-b', 'feature')
    git('checkout', '-q', '-')
    // `checkout -- feature` 把 feature 当路径：不存在则抛错，存在则**覆盖文件**
    expect(() => git('checkout', '--', 'feature')).toThrow()
    // 且绝不会切分支
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).not.toBe('feature')
  })
})

describe('commitFiles 的提交范围语义', () => {
  it('`commit --only -- <files>` 不挟带 index 里其它已暂存内容', () => {
    const { repo, git } = makeRepo('only')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    writeFileSync(join(repo, 'a.txt'), 'a changed\n')
    writeFileSync(join(repo, 'b.txt'), 'b changed\n')
    // 模拟「别的来源已把 b.txt 暂存」
    git('add', 'b.txt')
    git('add', '--', 'a.txt')
    git('commit', '-q', '--no-verify', '--only', '-m', 'only a', '--', 'a.txt')

    const files = git('show', '--name-only', '-z', '--format=', 'HEAD').split('\0').filter(Boolean)
    expect(files).toEqual(['a.txt'])
    // b.txt 仍留在 index（不会被这次提交吃掉）
    expect(git('status', '--short')).toContain('b.txt')
  })

  it('中文路径与中文提交信息原样落库（不被转义/吃掉）', () => {
    const { repo, git } = makeRepo('unicode')
    writeFileSync(join(repo, '说明.md'), 'x\n')
    git('add', '--', '说明.md')
    git('commit', '-q', '--no-verify', '--only', '-m', 'docs: 中文提交信息', '--', '说明.md')
    expect(git('log', '-1', '--format=%s')).toBe('docs: 中文提交信息')
    expect(git('show', '--name-only', '-z', '--format=', 'HEAD').split('\0').filter(Boolean)).toEqual(['说明.md'])
  })
})

describe('重命名提交（真机 2026-11-26 抓到的真实缺陷）', () => {
  it('只勾新路径时，删除源必须一并进提交（否则 HEAD 里新旧两份并存）', () => {
    const { repo, git } = makeRepo('rename-commit')
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    writeFileSync(join(repo, 'keep.txt'), 'keep\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    git('mv', 'a.txt', 'b.txt')
    writeFileSync(join(repo, 'keep.txt'), 'keep changed\n')

    // 面板的行为：选中 b.txt 与 keep.txt；删除源 a.txt 不在选中列表里
    const files = ['b.txt', 'keep.txt']
    // 删除源在磁盘上已不存在 ⇒ 不能交给 `add`（会 pathspec 整单失败）
    git('add', '--', ...files)
    // 但必须交给 `commit --only`，否则 a.txt 留在 HEAD 树里
    git('commit', '-q', '--no-verify', '--only', '-m', 'rename', '--', ...files, 'a.txt')

    const tree = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean).sort()
    expect(tree).toEqual(['b.txt', 'keep.txt'])
    // 工作区不再残留删除源的暂存记录
    expect(git('status', '--porcelain')).toBe('')
  })

  it('反证：只 `commit --only` 新路径 ⇒ HEAD 里新旧两份并存（这就是被修掉的行为）', () => {
    const { repo, git } = makeRepo('rename-bug')
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    git('mv', 'a.txt', 'b.txt')

    // 旧实现的语义：只提交 b.txt
    git('commit', '-q', '--no-verify', '--only', '-m', 'rename', '--', 'b.txt')

    const tree = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean).sort()
    expect(tree).toEqual(['a.txt', 'b.txt'])
    // 且删除源卡在暂存区，用户会看到一条无法理解的 `D a.txt`
    expect(git('status', '--porcelain')).toContain('D  a.txt')
  })
})
