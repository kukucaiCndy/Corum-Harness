/**
 * corum-desktop/corum-git — 工作区 git 侦测与初始化 Host 半（Typert Remote，
 * service 名 `corumGit`）。
 *
 * 背景：corum 的子 Agent 编排隔离（worktree）/ 声明式 verify / integrate 全部依赖
 * git 仓库；非 git 工作区这些能力不可用（实测 `isolation: always` 在非 git 目录
 * `git worktree add` 直接报 `fatal: not a git repository`）。
 *
 * **产品策略（2026-09-11 用户定调）**：corum 不再提供「是否初始化 git」开关。
 * 打开工作区的行为固定为「探测是否已是 git 仓库，没有就初始化」——因此
 * `corum-workspace.autoInitGit` 设置项及其 UI 已移除，调用方统一走 `ensureRepo`。
 *
 * 与 corumFs 的差异：corumFs 以「host 进程 cwd 为项目根」防穿越（文件树数据源）；
 * 本服务接受**任意绝对路径**——用户添加的工作区可在文件系统任意位置，不存在
 * 「项目根」概念，故不做根校验，仅 realpath 归一后在目标目录跑 git。
 *
 * @Remote 方法直接 return value（Typert Remote 信封自动包 `{ ok: true, value }`），
 * 失败 throw（包成 `{ ok: false, error }`）。
 * @module corum-desktop/corum-git
 */

import { realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { gitSafeDirectoryArgs } from '@corum/corum-platform'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 工作区 git 侦测/初始化服务（子 Agent 编排隔离等 git 依赖能力的前置）。 */
    corumGit: CorumGitService
  }
}

/**
 * 在目录下跑一个 git 子命令；exit 0 resolve stdout，否则 reject 带 stderr。
 *
 * Windows 上前置 `-c safe.directory=<cwd>`：工作区目录属主与当前用户不一致时
 * git 会拒绝一切操作（2026-10-12 真机事故 —— 用户加 `F:\work\agent`
 * （属主 Administrator）而应用以 `remote` 跑，`git init` 成功但首个 commit exit 128）。
 * 详见 `@corum/corum-platform` 的 git-safe-directory 模块。
 */
function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // windowsHide：Windows 上 git.exe 是控制台子系统程序，父进程（Electron GUI，
    // 无控制台）拉起时会新开一个可见黑框；该选项让它无窗口运行。非 Windows 平台忽略，
    // 故无需按平台分支（三平台同代码）。
    const child = spawn('git', [...gitSafeDirectoryArgs(cwd), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 })
    })
  })
}

export class CorumGitService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'corumGit')
  }

  /** realpath 归一目标目录（symlink/.. 解析），不存在则抛错。 */
  private async resolveDir(path: string): Promise<string> {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error('path must be a non-empty absolute directory path')
    }
    return realpath(path)
  }

  /**
   * 侦测目录是否是 git 仓库（含 worktree/子目录——`git rev-parse --git-dir` 在
   * 仓库任意子目录都成功）。
   * @param path - 任意绝对目录路径。
   */
  @Remote('status')
  async status(path: string): Promise<{ isRepo: boolean }> {
    const dir = await this.resolveDir(path)
    try {
      const { code } = await runGit(dir, ['rev-parse', '--git-dir'])
      return { isRepo: code === 0 }
    } catch {
      // git 未安装 / 目录不可读等——按非仓库处理（调用方走「询问初始化」分支）。
      return { isRepo: false }
    }
  }

  /**
   * 初始化 git 仓库：`git init` + 一个空初始 commit。
   *
   * 必须带初始 commit：worktree/分支需要至少一个 commit 才能创建（空仓库
   * `git worktree add <path> -b <branch>` 会失败，隔离仍不可用）。空 commit 不
   * 触碰用户的任何文件（`--allow-empty`），保持最小侵入。
   *
   * 幂等：已是仓库时直接返回 initialized:false（不重复 init/commit）。
   * @param path - 任意绝对目录路径。
   */
  @Remote('init')
  async init(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
    const dir = await this.resolveDir(path)
    const existing = await this.status(dir)
    if (existing.isRepo) return { initialized: false, alreadyRepo: true }

    const initResult = await runGit(dir, ['init'])
    if (initResult.code !== 0) {
      // 带上 stderr：早期实现把它吞了，导致失败只剩「git init failed (exit 1)」这句
      // 无从下手的报错（实测 ai-lab / dsh_test 就卡在这里）。
      throw new Error(`git init failed (exit ${initResult.code}): ${initResult.stderr || 'no stderr'}`)
    }
    // 空初始 commit：worktree/分支的前置。git 可能因缺 user.name/user.email 失败——
    // 用 -c 传入一次性身份（不写用户的 global/local config，最小侵入）。
    const commitResult = await runGit(dir, [
      '-c', 'user.name=corum',
      '-c', 'user.email=corum@localhost',
      'commit', '--allow-empty', '-m', 'chore: initial commit',
    ])
    if (commitResult.code !== 0) {
      throw new Error(`git initial commit failed (exit ${commitResult.code}): ${commitResult.stderr || 'no stderr'}`)
    }
    this.ctx.logger.info(`git initialized: ${dir}`)
    return { initialized: true, alreadyRepo: false }
  }

  /**
   * 保证目录是一个 git 仓库：已是仓库则原样返回，否则 `git init` + 初始 commit。
   *
   * 这是**产品策略的唯一落点**（2026-09-11 用户定调）：corum 不再提供「是否初始化
   * git」开关 —— 打开工作区的行为固定为「探测，没有就初始化」。调用方一律用本方法，
   * 不要再各自拼 status + init 两跳。
   *
   * @param path - 任意绝对目录路径。
   * @returns `initialized` 表示本次是否真的创建了仓库。
   */
  @Remote('ensureRepo')
  async ensureRepo(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
    return await this.init(path)
  }
}
