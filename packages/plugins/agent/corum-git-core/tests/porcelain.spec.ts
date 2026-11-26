/**
 * `git status --porcelain=v1 -z` 解析 + 分支名校验的回归网（2026-11-26）。
 *
 * ## 为什么必须有这个文件（不是形式主义）
 *
 * 面板的「未提交更改」默认**全选**，用户点一次「提交」就会 `git add -- <每一条路径>`。
 * 解析错一条记录 ⇒ 生成一个不存在的路径 ⇒ `git add` 失败 ⇒ 整次提交失败，
 * 而用户看到的只是「提交失败」，没有任何线索指向解析。此前 `R` 记录（重命名）
 * 的第二条字段被当成独立记录，产出 `{path:'xt', status:'a.'}` 这种幽灵行。
 *
 * 判据用**真实 `git` 输出**：先建临时仓库制造重命名/复制/中文名/未跟踪/删除，
 * 再把 git 的原始 `-z` stdout 喂给解析器。手写字符串只能证明「我以为是这个格式」。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isSafeBranchName, parsePorcelainZ, parsePorcelainZText, splitPorcelainZ } from '../src/porcelain.ts'

const scratch = mkdtempSync(join(tmpdir(), 'corum-porcelain-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

/**
 * 建一个临时仓库并返回其「原始 `status -z` stdout」与 git 执行器。
 * @param name - 仓库目录名后缀（各用例独立，避免互相污染）。
 * @returns 仓库路径、git 执行器、取原始 stdout 的函数。
 */
function makeRepo(name: string): { repo: string; git: (...args: string[]) => string; raw: () => string } {
  const repo = join(scratch, name)
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'test@localhost')
  git('config', 'user.name', 'test')
  git('config', 'core.quotePath', 'false')
  return {
    repo,
    git,
    raw: () => git('status', '--porcelain=v1', '-z', '--untracked-files=all'),
  }
}

describe('parsePorcelainZ（真实 git -z 输出）', () => {
  it('重命名记录只产出一条（源路径不得变成幽灵行）', () => {
    const { git, raw } = makeRepo('rename')
    writeFileSync(join(scratch, 'rename', 'a.txt'), 'hello\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    git('mv', 'a.txt', 'b.txt')

    const entries = parsePorcelainZText(raw())
    expect(entries).toHaveLength(1)
    expect(entries[0]?.path).toBe('b.txt')
    expect(entries[0]?.status).toBe('R')
    expect(entries[0]?.renameSource).toBe('a.txt')
  })

  it('重命名 + 普通改动的字段顺序不会互相挤位', () => {
    const { git, raw } = makeRepo('rename-mixed')
    writeFileSync(join(scratch, 'rename-mixed', 'a.txt'), 'hello\n')
    writeFileSync(join(scratch, 'rename-mixed', 'keep.txt'), 'keep\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    git('mv', 'a.txt', 'b.txt')
    writeFileSync(join(scratch, 'rename-mixed', 'keep.txt'), 'keep changed\n')

    const entries = parsePorcelainZText(raw())
    expect(entries.map(e => e.path).sort()).toEqual(['b.txt', 'keep.txt'])
    // 关键判据：不得出现任何以源路径片段/状态残渣为路径的条目
    for (const entry of entries) {
      expect(entry.path).not.toBe('xt')
      expect(entry.status).not.toContain('.')
    }
  })

  it('非 ASCII 路径原样保留（不转义）', () => {
    const { raw } = makeRepo('unicode')
    writeFileSync(join(scratch, 'unicode', '中文文件.txt'), 'x\n')
    const entries = parsePorcelainZText(raw())
    expect(entries).toHaveLength(1)
    expect(entries[0]?.path).toBe('中文文件.txt')
    expect(entries[0]?.status).toBe('??')
  })

  it('删除 + 未跟踪 + 修改可同时解析', () => {
    const { git, raw } = makeRepo('multi')
    writeFileSync(join(scratch, 'multi', 'gone.txt'), 'gone\n')
    writeFileSync(join(scratch, 'multi', 'mod.txt'), 'mod\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    rmSync(join(scratch, 'multi', 'gone.txt'))
    writeFileSync(join(scratch, 'multi', 'mod.txt'), 'mod changed\n')
    writeFileSync(join(scratch, 'multi', 'new.txt'), 'new\n')

    const entries = parsePorcelainZText(raw())
    const byPath = new Map(entries.map(e => [e.path, e.status]))
    expect(byPath.get('gone.txt')).toBe('D')
    expect(byPath.get('mod.txt')).toBe('M')
    expect(byPath.get('new.txt')).toBe('??')
  })

  it('末尾空字段不算记录', () => {
    expect(splitPorcelainZ('M  a.txt\0')).toEqual(['M  a.txt'])
    expect(splitPorcelainZ('')).toEqual([])
  })

  it('异常短字段被跳过而不是产出空路径', () => {
    expect(parsePorcelainZ(['M', '', 'ab'])).toEqual([])
  })
})

describe('isSafeBranchName（防 git 参数注入）', () => {
  it('常规分支名放行', () => {
    for (const name of ['main', 'feat/git-panel', 'origin/release/v1.2.3', 'fix_issue-1', 'v0.8.3']) {
      expect(isSafeBranchName(name), name).toBe(true)
    }
  })

  it('以 - 开头的 token 一律拒绝（会被 git 当选项）', () => {
    for (const name of ['-f', '--orphan', '-b', '--', '-']) {
      expect(isSafeBranchName(name), name).toBe(false)
    }
  })

  it('git 保留字符与空白一律拒绝', () => {
    for (const name of ['a b', 'a..b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a//b', '']) {
      expect(isSafeBranchName(name), name).toBe(false)
    }
  })
})

describe('状态码首字符是空格（trim 陷阱，真机 2026-11-26 抓到）', () => {
  it('` D del.txt` 的路径必须是 del.txt，不是 el.txt', () => {
    // 工作区删除、未暂存：首字符是空格占位。
    // `stdout.trim()` 会把这条空格吃掉 ⇒ slice(3) 少切一位 ⇒ `el.txt`。
    const entries = parsePorcelainZText(' D del.txt\0')
    expect(entries.map(e => e.path)).toEqual(['del.txt'])
    expect(entries[0]?.status).toBe('D')
  })

  it('未暂存修改 ` M x.txt` 同样正确', () => {
    expect(parsePorcelainZText(' M x.txt\0')[0]?.path).toBe('x.txt')
  })

  it('首字符非空格的形态不受影响（对照）', () => {
    for (const [code, path] of [['M  a.txt', 'a.txt'], ['?? b.txt', 'b.txt'], ['A  c.txt', 'c.txt']] as const) {
      expect(parsePorcelainZText(code + '\0')[0]?.path, code).toBe(path)
    }
  })

  it('真实仓库里「工作区删除」与「已暂存删除」都能解析出完整路径', () => {
    const { git, raw } = makeRepo('leading-space')
    writeFileSync(join(scratch, 'leading-space', 'staged.txt'), 'x\n')
    writeFileSync(join(scratch, 'leading-space', 'unstaged.txt'), 'y\n')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'init')
    git('rm', '-q', 'staged.txt')          // 已暂存删除：`D `
    rmSync(join(scratch, 'leading-space', 'unstaged.txt'))  // 工作区删除：` D`

    const paths = parsePorcelainZText(raw()).map(e => e.path).sort()
    expect(paths).toEqual(['staged.txt', 'unstaged.txt'])
  })
})
