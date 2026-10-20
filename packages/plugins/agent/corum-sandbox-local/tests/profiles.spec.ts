import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { corumGitWriteRoots, corumResetGitRootsCache } from '../src/git-write-roots.ts'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'corum-sandbox-local-')))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** 建一个临时仓库 + 一条 worktree，返回两者的规范路径。 */
function repoWithWorktree(name: string): { repo: string; worktree: string; gitdir: string; common: string } {
  const repo = join(scratch, name)
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
  git(repo, ['config', 'user.email', 'test@corum.local'])
  git(repo, ['config', 'user.name', 'corum-test'])
  git(repo, ['commit', '--allow-empty', '-m', 'init'])
  const worktree = join(repo, '.corum-worktrees', 'wt-spec01')
  git(repo, ['worktree', 'add', worktree, '-b', 'wt/wt-spec01'])
  corumResetGitRootsCache()
  return {
    repo: realpathSync.native(repo),
    worktree: realpathSync.native(worktree),
    gitdir: realpathSync.native(join(repo, '.git', 'worktrees', 'wt-spec01')),
    common: realpathSync.native(join(repo, '.git')),
  }
}

describe('corumGitWriteRoots — fork（corum）git 数据可写根', () => {
  it('非 git 目录：返回空（能力自动关闭，不抛错）', () => {
    const plain = join(scratch, 'plain')
    mkdirSync(plain, { recursive: true })
    corumResetGitRootsCache()
    expect(corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: plain })).toEqual([])
  })

  it('read-only：不追加任何根（一个字节都不该写）', () => {
    const { worktree } = repoWithWorktree('repo-readonly')
    expect(corumGitWriteRoots({ mode: 'read-only', workspaceRoot: worktree })).toEqual([])
  })

  it('worktree：只给 git 数据目录（worktree gitdir + objects/refs/logs）', () => {
    const { worktree, gitdir, common } = repoWithWorktree('repo-wt')
    expect(corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: worktree })).toEqual([
      gitdir,
      join(common, 'objects'),
      join(common, 'refs'),
      join(common, 'logs'),
      join(common, 'packed-refs'),
      join(common, 'packed-refs.lock'),
    ])
  })

  it('安全边界：配置与代码目录绝不出现在可写根里（hooks/config/info/modules/其它 worktree）', () => {
    const { worktree, common } = repoWithWorktree('repo-boundary')
    const roots = corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: worktree })
    for (const forbidden of [
      join(common, 'hooks'),
      join(common, 'config'),
      join(common, 'config.worktree'),
      join(common, 'info'),
      join(common, 'modules'),
      join(common, 'worktrees'),
      common, // 整个 .git 也不给（只给它的数据子目录）
    ]) {
      expect(roots).not.toContain(forbidden)
    }
  })

  it('主仓（gitdir === common）：返回空——不因本 fork 扩大非 worktree 会话的面', () => {
    const { repo } = repoWithWorktree('repo-main')
    expect(corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: repo })).toEqual([])
  })

  it('仓库子目录（gitdir === common）：返回空——维持「子目录会话写不了 .git」的既有行为', () => {
    const { repo } = repoWithWorktree('repo-subdir')
    const sub = join(repo, 'packages', 'inner')
    mkdirSync(sub, { recursive: true })
    corumResetGitRootsCache()
    expect(corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: sub })).toEqual([])
  })

  it('探测结果进程内缓存（同一 workspace 反复 confine 不重复 fork git）', () => {
    const { worktree, gitdir } = repoWithWorktree('repo-cache')
    const first = corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: worktree })
    const second = corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: worktree })
    expect(second).toEqual(first)
    expect(second).toContain(gitdir)
  })
})

describe('平台 profile 的 git 数据授权（fork 增量落点）', () => {
  /**
   * SBPL 里的字符串按实现（`sbplString`）的转义口径拼：`\` → `\\`、`"` → `\"`。
   * POSIX 路径没有反斜杠，所以直接比原文也绿；**Windows 上路径一律含 `\`**，比原文
   * 必然失败（2026-10-20 三平台门禁首跑实测：expected `(subpath "C:\Users\…")`，
   * received `(subpath "C:\\Users\\…")`）——这是测试的平台假设，不是实现缺陷。
   */
  function sbplSubpath(path: string): string {
    return `(subpath "${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}")`
  }

  it('Seatbelt：SBPL 含 workspace 根与 git 数据目录，且不含 hooks/config/整个 .git', () => {
    const { worktree, gitdir, common } = repoWithWorktree('repo-seatbelt')
    const profile = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: worktree })[1]
    expect(profile).toContain(sbplSubpath(worktree))
    expect(profile).toContain(sbplSubpath(gitdir))
    expect(profile).toContain(sbplSubpath(join(common, 'objects')))
    expect(profile).toContain(sbplSubpath(join(common, 'refs')))
    expect(profile).toContain(sbplSubpath(join(common, 'logs')))
    expect(profile).not.toContain(sbplSubpath(join(common, 'hooks')))
    expect(profile).not.toContain(sbplSubpath(join(common, 'config')))
    expect(profile).not.toContain(sbplSubpath(common))
    // packed-refs 是引用数据（与 refs/ 同类），为消除 git commit 的 lock 报错而授权。
    expect(profile).toContain(sbplSubpath(join(common, 'packed-refs')))
    // 写仍然被整体拒绝（(deny file-write*) 在授权之前），只是多几个白名单根。
    expect(profile).toContain('(deny file-write*)')
  })

  it('Seatbelt：read-only 不含任何 git 根（探针路径也不额外授权）', () => {
    const { worktree, gitdir } = repoWithWorktree('repo-seatbelt-ro')
    const profile = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: worktree })[1]
    expect(profile).not.toContain(sbplSubpath(gitdir))
  })

  it('bwrap / Landlock：git 数据目录进入 bind / readWrite 面，整个 .git 不进', () => {
    const { worktree, gitdir, common } = repoWithWorktree('repo-linux')
    const bwrap = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: worktree }).join(' ')
    expect(bwrap).toContain(`--bind-try ${gitdir} ${gitdir}`)
    expect(bwrap).toContain(`--bind-try ${join(common, 'objects')} ${join(common, 'objects')}`)
    expect(bwrap).not.toContain(`--bind-try ${common} ${common}`)
    expect(bwrap).not.toContain(`--bind-try ${join(common, 'hooks')}`)
    const landlock = landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: worktree })
    expect(landlock).toContain(gitdir)
    expect(landlock).toContain(join(common, 'refs'))
    expect(landlock).not.toContain(common)
  })
})
