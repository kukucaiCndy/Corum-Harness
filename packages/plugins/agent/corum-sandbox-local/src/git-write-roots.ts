/**
 * fork（corum）：workspace 的 **VCS 数据可写根**——隔离 worktree 里能否提交的关键。
 *
 * @module @corum/corum-sandbox-local/git-write-roots
 *
 * 为什么需要它（2026-09-09 用户实机复现，docs/TODO.md）：
 * 官方 `writableRoots(policy)` 只给「session workspace（= 会话 cwd）+ /tmp + tmpdir」。
 * 隔离子 Agent 的 cwd 是 worktree（`<repo>/.corum-worktrees/wt-xxxx`），而 git 的
 * 可写状态全在**主仓的 .git 里**：
 *   - `<repo>/.git/worktrees/wt-xxxx/index.lock`（`git add` 的第一件事）
 *   - `<repo>/.git/objects/**`（新对象）
 *   - `<repo>/.git/refs/heads/<branch>`、`<repo>/.git/logs/**`（分支与 reflog）
 * 于是 `git add` 直接 `index.lock: Operation not permitted`（Seatbelt EPERM）——
 * 子 Agent 永远无法在自己的分支上提交，「子 Agent 提交 → 集成者合并」的隔离
 * 语义整条断裂。
 *
 * **安全边界（2026-09-09 加固，安全评审见 docs/fork-delta.md §15）**：只授予
 * **git 数据目录**，绝不授予 **git 配置/代码**：
 *   - 授予：worktree 私有 gitdir + `<common>/objects` + `<common>/refs` +
 *     `<common>/logs`；
 *   - 不授予：`<common>/config`、`<common>/config.worktree`、`<common>/hooks`、
 *     `<common>/info`、`<common>/modules`、`<common>/packed-refs`、
 *     `<common>/worktrees`（其它 worktree 的管理目录）——这些是「持久化到沙箱外
 *     执行」的载体（hooks 会在父 Agent/用户的后续 git 命令里执行；config 的
 *     `core.hooksPath`/`fsmonitor`/`textconv`/`sshCommand` 同理）。
 *   - 父工作区文件仍然写不进去（隔离保护不变，实测三层）。
 *   - 残留风险（有意接受并登记）：子 Agent 可改写 refs/objects（能破坏本仓历史，
 *     与它已有的工作区写权限同级的破坏力），但不能借此在沙箱外执行代码。
 *
 * **范围**：只在「会话 workspace 是 git worktree」时生效（gitdir ≠ common）。
 * 主仓/子目录会话（gitdir === common）返回空——仓根会话的 `.git` 本来就在
 * workspace 之内（官方口径已覆盖），子目录会话维持「写不了 .git」的既有行为，
 * 不因本 fork 扩大面。
 *
 * 平台差异：Seatbelt（macOS）/ bwrap、Landlock（Linux）共用本函数；Windows 的
 * windows-acl runner 只接受单个 `--workspace` 根（runner 侧协议），本函数对它无效
 * ——Windows 上隔离子 Agent 的 git 提交仍不可用（已在 docs/TODO.md 登记）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { gitSafeDirectoryArgs } from '@corum/corum-platform'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** `git rev-parse` 探测超时（ms）：沙箱 confine 是同步路径，绝不能被 git 卡住。 */
const GIT_PROBE_TIMEOUT_MS = 2000

/** workspaceRoot → git 数据可写根（探测一次，进程内缓存；confine 在热路径上）。 */
const gitRootsCache = new Map<string, readonly string[]>()

/**
 * 探测一个 workspace 的 git 数据可写根。
 *
 * 单次 `git rev-parse --git-dir --git-common-dir` 输出两行（worktree 下都是绝对
 * 路径；主仓里可能是相对的 `.git`，按 workspaceRoot 解析）。非 git 目录、git
 * 未安装、命令超时都返回空数组——能力自动关闭，绝不因此让 confine 失败。
 *
 * @param workspaceRoot - 策略的 workspace 根（= 会话 cwd）。
 * @returns 规范化去重后的 git 数据目录绝对路径（可能为空）。
 */
function detectGitWriteRoots(workspaceRoot: string): readonly string[] {
  let output: string
  try {
    output = execFileSync('git', [...gitSafeDirectoryArgs(workspaceRoot), 'rev-parse', '--git-dir', '--git-common-dir'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_PROBE_TIMEOUT_MS,
    })
  } catch {
    return []
  }
  const [rawGitDir, rawCommonDir] = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => path.resolve(workspaceRoot, line))
  if (rawGitDir === undefined || rawCommonDir === undefined) return []
  const gitDir = canonicalPath(rawGitDir)
  const commonDir = canonicalPath(rawCommonDir)
  // 主仓/子模块（gitdir === common）：`.git` 要么已在 workspace 内（仓根会话，
  // 官方口径已覆盖），要么属于「子目录会话写不了 .git」的既有行为——本 fork
  // 不在此扩大面。
  if (gitDir === commonDir) return []
  // 只给 git **数据**：worktree 管理目录（index/HEAD/reflog）+ 公共对象/引用/日志
  // + packed-refs（引用数据，见下）。配置与代码（config/hooks/info/modules/其它
  // worktree）一律不给。
  const data = [
    gitDir,
    path.join(commonDir, 'objects'),
    path.join(commonDir, 'refs'),
    path.join(commonDir, 'logs'),
  ]
  // bwrap 的 `--bind` 要求源路径存在（Landlock 同样按路径建规则）——只登记真实
  // 存在的目录；缺失即跳过（该能力降级，而不是让 confine 失败）。
  const existing = data.filter(entry => existsSync(entry))
  // git ≥ 2.50（Apple Git-155 实测）的 `git commit` 会对 ref 事务加
  // `packed-refs.lock`，**即使 packed-refs 文件并不存在**：不授权就每次 commit 都
  // 打一行 `error: Unable to create '.../packed-refs.lock': Operation not permitted`
  // （exit 0、提交仍成功，但会让子 Agent 误判提交失败）。packed-refs 是**引用
  // 数据**（ref → sha 列表），与已授权的 `refs/` 同类，不引入新的能力类别；
  // `.lock` 是它的临时锁文件，两者一起按字面路径授权（文件可能不存在——
  // Seatbelt 的 subpath 对不存在的路径同样成立；bwrap 用 `--bind-try`、Landlock
  // 按存在性过滤，见 profiles.ts）。
  return [
    ...new Set([
      ...existing,
      path.join(commonDir, 'packed-refs'),
      path.join(commonDir, 'packed-refs.lock'),
    ]),
  ]
}

/**
 * 一个 workspace 的 git 数据根（带进程内缓存）。
 * @param workspaceRoot - 策略的 workspace 根。
 * @returns 缓存的根列表（探测失败时为空数组，同样被缓存）。
 */
function gitWriteRoots(workspaceRoot: string): readonly string[] {
  const cached = gitRootsCache.get(workspaceRoot)
  if (cached !== undefined) return cached
  const roots = detectGitWriteRoots(workspaceRoot)
  gitRootsCache.set(workspaceRoot, roots)
  return roots
}

/**
 * 追加到官方可写根之后的 git 数据根。
 *
 * 只在 `workspace-write` 下返回（`read-only` 一个字节都不该写；`danger-full-access`
 * 不经过 profile 构建），与官方 {@link writableRoots} 的语义面保持一致。
 *
 * @param policy - 本次执行的文件效果策略。
 * @returns 需要额外授予写权限的 git 数据目录（已 canonical 化）。
 */
export function corumGitWriteRoots(policy: SandboxPolicy): readonly string[] {
  if (policy.mode !== 'workspace-write') return []
  return gitWriteRoots(policy.workspaceRoot)
}

/**
 * 单测钩子：清空探测缓存（同一临时目录在测试里反复重建时用）。
 */
export function corumResetGitRootsCache(): void {
  gitRootsCache.clear()
}
