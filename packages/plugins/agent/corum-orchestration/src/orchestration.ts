/**
 * fork（corum）：子 Agent 编排器——隔离台账状态 + worktree 编排的单一事实源
 * （docs/plan/PLAN-subagent-orchestration.md §5）。
 *
 * 从 fork #10 `index.ts` 的 execute 层下沉：
 * - **台账状态**：`corumWorktreeLedger`（模块级 Map，红线 1 禁止形态）→
 *   `CorumOrchestration` service 实例字段（cordis 根上下文 provide，跨 bundle
 *   单例）。同时是 §11.9 台账持久化的前置（service 可持有持久化句柄）。
 * - **纯函数**：写任务判定/隔离触发/准入/结算/persona 拼装/git 命令/worktree
 *   清理——全部移入本模块，`index.ts` 从中 re-export 保持对外 API 兼容（单测
 *   import 路径不变）。
 *
 * 消费方：fork #10 工具（当前，经 service 调用保持行为等价）→ Phase 2 的
 * `orchestrate` 工具（任务清单语义）。
 *
 * 2026-09 重构 1：本文件从 @corum/corum-tool-subagent 整体迁入独立包
 * @corum/corum-orchestration（挂载方式：新包自己挂 cordis 行 provide，见本包
 * index.ts）。
 *
 * @module @corum/corum-orchestration/orchestration
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { gitSafeDirectoryArgs } from '@corum/corum-platform'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
// fork（corum）：git 机制归一到 git-core 核心插件（用户 2026-09-16 策略「所有 git 管理
// 收进一个独立插件」）——收口强制提交的底层原语 settleCommit 由 git-core 提供，
// 本包不再自实现 `git add/commit`（消除与 corumCommitWorktreeOnSettle 的重复实现）。
import { settleCommit as gitCoreSettleCommit, abortMerge as gitCoreAbortMerge, mergeInProgress as gitCoreMergeInProgress, ensureWorktreeGitignore as gitCoreEnsureWorktreeGitignore } from '@corum/corum-git-core/git-primitives'

/**
 * `subagent/end` 载荷的**局部窄化形**（只取本包用到的两个字段）。
 *
 * 为什么不用官方 `SubagentRunEndInfo`：`import type ... from '@deepseek-ai/dsh-subagent'`
 * 会把**发布版**的 d.ts 拉进编译图，而发布版与本仓 fork（`@corum/corum-subagent`）各自
 * `declare module '@deepseek-ai/cordis' { subagents: SubagentRuntime }`——两份同名属性
 * 来自不同来源的同名类型 → 任何 consumer 只要 import 本包就报 TS2717，编译不过
 * （2026-09-11 实测：corum-subagent 加一行 import 就被这个卡住）。
 * 与文件内既有做法一致（红线 3：跨包类型用局部能力接口收窄，不耦合官方实现包）。
 */
interface CorumSubagentEndInfo {
  /** 与配对 start 事件共享的 run 身份。 */
  readonly runId: unknown
  /** 子 Agent 的会话 id。 */
  readonly id: unknown
}


// ── 台账类型与事件 ─────────────────────────────────────────────────────────

/** fork（corum）：会话级隔离台账条目（settled 不占 maxParallelChildren 额度）。 */
export interface CorumWorktreeEntry {
  readonly slug: string
  readonly branch: string
  readonly path: string
  status: 'active' | 'settled' | 'integrated' | 'discarded'
  /** settle 关联键——subagent/start|end 事件的 runId（session 级去重）。 */
  runId?: string
  /** fork（corum）：子会话 id（与 runId 同值；浮层行点击 → 进入子会话）。 */
  childSessionId?: string
  /**
   * fork（corum）：现场（worktree 目录 + 分支）是否已被回收。
   *
   * 只在**完整清理成功**后置 true（`corumCleanupWorktree` 返回 true）。
   * 用途：把「工作已进主树、现场已回收」与「未集成就被丢弃」在 UI 上分开——
   * 前者是 `integrated + reclaimed`（显示「已集成 · 现场已回收」），后者才是 `discarded`
   * （「已丢弃」）。2026-09-12 用户实测：机制集成成功+清理后条目落成 discarded，
   * 折叠行写成「已集成 0 · 已丢弃 1」，看着像把成功的工作扔了。
   */
  reclaimed?: boolean
  /**
   * fork（corum）：分支创建点（`git worktree add -b` 那一刻的 HEAD）。
   *
   * 对账判据的一部分：`tip === base` 说明这条分支**一个提交都没做**——空分支在
   * `git branch --merged HEAD` 里与「真合并过的分支」同形（main 往前走一步就认不出），
   * 不设防就会把「什么都没干、甚至是还在跑」的条目签收成 `integrated`。
   */
  base?: string
  /**
   * fork（corum）：分支 tip 的**台账快照**（分支被删除后仍能证明「这份工作已进 HEAD」）。
   *
   * 由来（2026-09-20 机制 bug）：判定集成时按**分支名**跑
   * `git merge-base --is-ancestor <branch> HEAD`，但「合并后 `branch -D`」正是机制自己
   * 鼓励的合规收尾（`corumCleanupWorktree` 自己就删分支）——分支一没，两条命令都非零退出
   * ⇒ 判定 false ⇒ **集成实际成功却被误判未落地**，抛
   * `Error: integrate did not persist into the main tree`。
   *
   * 快照点（都在分支被删**之前**）：条目创建（= `base`）、settle 强制提交之后、
   * 集成前、以及 `corumCleanupWorktree` 执行 `branch -D` 之前。判定时分支已不存在
   * 就用它跑 `merge-base --is-ancestor <tip> HEAD`——tip 在 HEAD 祖先链上即证明已并入。
   */
  tip?: string
}

/** 台账快照的一帧：某父会话的 worktree 条目全量投影（renderer 直接渲染）。 */
export interface CorumWorktreeLedgerFrame {
  readonly sessionId: string
  readonly entries: readonly CorumWorktreeEntry[]
  /** 待集成 = active+settled。 */
  readonly pending: number
}

// fork（corum）：台账快照事件（renderer「并行工作区」chip 订阅源）。
// cordis Events 合并声明自包含（与 corum-api-remotes 转发 allowlist 配套）。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'corum/worktree-ledger': (frame: CorumWorktreeLedgerFrame) => void
  }
}

// ── 台账持久化（Phase 4：§11.9 遗留决策项①落盘）───────────────────────────

/** 持久化的一条会话台账：worktree 条目 + 父 cwd（重启恢复孤儿 worktree 识别）。 */
export interface CorumLedgerRecord {
  /** 父会话 cwd（dispose/restart 清理时定位 git 主干）。 */
  readonly cwd: string
  /** 待集成条目（active/settled；integrated/discarded 已清理，不落盘）。 */
  readonly entries: readonly CorumWorktreeEntry[]
}

/** 台账 record zod schema（落盘边界校验）。 */
const corumLedgerRecordSchema = z.object({
  cwd: z.string(),
  entries: z.array(z.object({
    slug: z.string(),
    branch: z.string(),
    path: z.string(),
    status: z.enum(['active', 'settled', 'integrated', 'discarded']),
    runId: z.string().optional(),
    childSessionId: z.string().optional(),
    base: z.string().optional(),
    tip: z.string().optional(),
    reclaimed: z.boolean().optional(),
  })),
}) as unknown as z.ZodType<CorumLedgerRecord>

/** fork（corum）：编排台账 domain（单表 ledger，key=sessionId）。 */
export const corumOrchestrationDomainSpec = defineDomain({
  name: 'corum_orchestration',
  version: 1,
  layout: 'per-record',
  tables: {
    ledger: domainTable<string, CorumLedgerRecord>(corumLedgerRecordSchema),
  },
})

// ── 纯函数（无状态；单测直接测，语义与 fork #10 逐字一致）──────────────────

/** fork（corum）：写工具清单——按工具面判定写任务（§2 逐字核实）。 */
const CORUM_MUTATION_TOOLS = ['str_replace_editor', 'write', 'edit']
const CORUM_SHELL_TOOLS = ['bash', 'pwsh']
const CORUM_WRITE_TOOLS = [...CORUM_MUTATION_TOOLS, ...CORUM_SHELL_TOOLS]

/**
 * fork（corum）：平台实际存在的写工具（deny 名单只能包含已注册工具——
 * tools.restrict 对未知名 fail loud。pwsh 仅在 win32 装载）。与 corum-agent
 * compile.ts 的 corumWriteToolsForPlatform 逐字对账（dev-conventions §4a 第 2 条
 * 两处对账）。orchestrate 任务级 research 的只读硬约束用它预 deny 写工具。
 */
/**
 * 本平台的「写/执行」工具名清单（**可能含未装载的名字**，如 `str_replace_editor`
 * 在 corum preset 里已退场）。
 *
 * 纪律（2026-09-12 事故后补）：本清单只表达**意图**，落到 `tools.restrict()` 之前
 * **必须**先按目标 scope 真实可见的工具名收敛（`corumNarrowDenyFilter` /
 * `corum-subagent` 的 `narrowChildToolFilter`）——`tools.restrict()` 对未知名
 * fail-loud，直接拿本清单去 restrict 会让整次派遣抛错（实测：`subagent_research`
 * 100% 失败，表现为「指挥者发两份重复的子 Agent」）。
 */
export function corumWriteToolsForPlatform(): readonly string[] {
  return process.platform === 'win32'
    ? CORUM_WRITE_TOOLS
    : CORUM_WRITE_TOOLS.filter(tool => tool !== 'pwsh')
}

/**
 * fork（corum）：只读研究子 Agent 要 deny 的**变异**工具（2026-09-12 用户定调）。
 *
 * 为什么与 {@link corumWriteToolsForPlatform} 分开：用户要求「research 需要开放 shell
 * 来执行命令完成调研」——调研常常必须跑命令（`git log`、读 PID 文件、跑 verify 脚本的
 * status）。此前 research 与写子 Agent 共用同一份 deny 名单（含 bash），于是研究子
 * Agent 连 `git status` 都跑不了，只能靠磁盘证据推断（实机报告原文：「本会话无
 * bash/write 工具」）。现在 research **允许 shell、只 deny 变异工具**，只读性由
 * **子会话沙箱钉成 `read-only`** 保证（见 corum-subagent 的 `readonlySandbox`）——
 * 工具面与文件效果两层分工：工具面禁写文件，沙箱层禁写文件系统。
 * @returns 本平台上的变异工具名（research 的 deny 名单）。
 */
export function corumMutationToolsForPlatform(): readonly string[] {
  return process.platform === 'win32' ? CORUM_MUTATION_TOOLS : CORUM_MUTATION_TOOLS
}

/** fork（corum）：git 命令同步执行（父会话 header.cwd 下）。 */
export function corumGit(cwd: string, args: string[]): void {
  execFileSync('git', [...gitSafeDirectoryArgs(cwd), ...args], { cwd, stdio: 'pipe' })
}

/**
 * fork（corum）：目录是否 git 仓库（含 worktree/子目录——`git rev-parse --git-dir`
 * 在仓库任意子目录都成功；git 未安装/目录不可读/非仓库均返回 false）。
 *
 * 用途（2026-09-09 用户需求）：非 git 工作区自动降级——子 Agent 编排的隔离
 * （worktree）/ 声明式 verify / integrate 全部依赖 git 仓库，非 git 目录下
 * `git worktree add` 直接报 `fatal: not a git repository`（实测 ai-lab 工作区）。
 * spawnOne 在隔离判定前用本函数侦测父 cwd，非 git 时强制不隔离（git 依赖能力
 * 自动关闭，不再报错）。带 Map 缓存（同一会话反复 spawn 不重复 fork git）。
 */
const corumGitRepoCache = new Set<string>()
export function corumIsGitRepo(cwd: string): boolean {
  // 2026-09-10：只缓存**肯定结果**。此前负结果也缓存——用户关掉「新工作区自动
  // git init」后手动 `git init`，同一进程内会一直判非 git（隔离/git 能力永不启用）。
  // 非 git 的探测成本很低（一次 git rev-parse 失败），且失败路径只在派遣时走一次。
  if (corumGitRepoCache.has(cwd)) return true
  try {
    execFileSync('git', [...gitSafeDirectoryArgs(cwd), 'rev-parse', '--git-dir'], { cwd, stdio: 'pipe' })
    corumGitRepoCache.add(cwd)
    return true
  } catch {
    return false
  }
}

// ── git 实况探测（机制真值门禁的判定面）─────────────────────────────────────

/**
 * fork（corum）：脏主树/未提交场景的**集成 diff 口**（2026-09-14 用户同意 B 条）。
 *
 * 解决什么：主树可能有与本轮无关的未提交在制品，集成者按纪律**不许**动它
 * （`corumIntegratorPersona` 明禁 reset/checkout/clean/stash），而 `git merge`
 * 在一棵脏树上既可能被拒、又可能拒绝得不明不白。这条口把「分支带来的改动」直接
 * 落到主树 HEAD 上，完全不碰主树工作区：**临时 index 上试三方**（不改工作区、
 * 不建 git 状态），成功才真提交。
 *
 * 三步：
 *   ① `GIT_INDEX_FILE=<tmp> git read-tree HEAD` + `git diff <base>..<branch> |
 *      git apply --cached --3way` —— 在**临时 index** 上试三方；冲突以非零退出，
 *      工作区与主 index 一个字节都没动（2026-09-14 实测：冲突时工作区文件的
 *      `git status` 仍是干净的）。
 *   ② 试合成功 → 由临时 index 写树、`commit-tree` 提交，`update-ref` 推进 HEAD。
 *      **不 checkout**：主树工作区的在制品原样保留。
 *   ③ 主树当前 HEAD 必须仍是本地记录的分支，且工作区无改动，否则拒绝（绝不在
 *      未知状态上推 ref）。
 *
 * 仍然受「机制真值门禁」约束：本函数**只负责让分支的工作进 HEAD**，集成是否算
 * 成功一律由 {@link corumIntegrationTruth} 按 git 实况判定，不放宽任何门禁——
 * 落不了就是失败，现场保留，报告里给 git 实况。
 *
 * base 缺失时退化为分支与 HEAD 的分叉点。纯 git、无 cordis 依赖，可单测。
 * @param cwd - 主树工作目录。
 * @param entry - 待集成的隔离条目（读 `branch`；`base` 可选，作为 diff 起点）。
 * @param message - 落地提交的信息（缺省时用分支名）。
 * @returns 落盘结果——`applied` 为真表示分支的工作已在 HEAD 上。
 */
/**
 * fork（corum）2026-09-27：分支树尖里仍存在的 **gitlink**（mode 160000）路径。
 *
 * 只查 `touched`（本次 diff 涉及的路径）以省一次全树扫描；`git ls-tree -r` 不递归进 gitlink
 * （它自己就是条目），故能如实列出 `160000 commit <sha>\t<path>`。
 *
 * @param cwd - 主树工作目录。
 * @param branch - 待落盘的分支。
 * @param paths - 该分支本次改动涉及的路径。
 * @returns gitlink 路径数组；查询失败时返回空数组（宁可漏判也不误伤：落盘后集成侧的
 *   验收仍会看到现场）。
 */
function gitlinkPathsInBranch(cwd: string, branch: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return []
  try {
    const out = execFileSync('git', ['ls-tree', '-r', branch, '--', ...paths], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('160000 ') && line.includes('\t'))
      .map(line => line.slice(line.indexOf('\t') + 1))
      .filter(line => line !== '')
  } catch {
    return []
  }
}

export function corumPortBranchDiff(
  cwd: string,
  entry: Pick<CorumWorktreeEntry, 'branch' | 'base'>,
  message?: string,
): { applied: boolean; base: string; patchBytes: number; head: string; error?: string } {
  const fail = (error: string, base = '', patchBytes = 0): { applied: boolean; base: string; patchBytes: number; head: string; error: string } =>
    ({ applied: false, base, patchBytes, head: corumGitHead(cwd), error })
  const base = entry.base !== undefined && entry.base !== ''
    ? entry.base
    : corumMergeBase(cwd, entry.branch)
  if (base === '') return fail(`cannot resolve a diff base for branch ${entry.branch}`)
  let patch = ''
  let touched: string[] = []
  try {
    // 只取该分支自己的改动；`--binary` 让二进制产物也能过。
    patch = execFileSync('git', ['diff', '--binary', `${base}..${entry.branch}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    touched = execFileSync('git', ['diff', '--name-only', `${base}..${entry.branch}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').map(line => line.trim()).filter(line => line !== '')
  } catch (error: unknown) {
    return fail(corumGitErrorText(error), base)
  }
  if (patch.trim() === '') {
    // 分支相对 base 没有文本改动（例如只改了被忽略的产物）——不是错误。
    return fail('branch adds no diff against its base', base)
  }
  // fork（corum）2026-09-27（用户裁定）：**拒收仍带 gitlink 的分支**。gitlink（mode 160000）
  // 是「另一个仓的指针」，不是本仓的文件——它一旦落进主树索引，就是一条连 `.gitmodules`
  // 都没有的幽灵 submodule。实测：正是 `dcf5082 port wt/wt-471e5f: 1 file(s)` 把子 Agent
  // 在 worktree 里新建的闭源仓指针搬进了开源仓主树（随后得单独派一个子会话去清）。
  //
  // 判据只看**分支树尖**是否仍含 gitlink（而不是看 diff）：于是「删除 gitlink 的那个提交」
  // 照常可以落盘（`f6c8268` 那类清理不会被这条误伤）。
  const gitlinks = gitlinkPathsInBranch(cwd, entry.branch, touched)
  if (gitlinks.length > 0) {
    return fail(
      `branch ${entry.branch} tracks an INDEPENDENT nested git repository (gitlink/submodule pointer): ${gitlinks.slice(0, 3).join(', ')}${gitlinks.length > 3 ? ` (+${gitlinks.length - 3} more)` : ''} — that repository is a separate artifact, not a file of this one. Port it as its own repository (or leave it for the user) instead of merging a submodule pointer into this tree.`,
      base,
      patch.length,
    )
  }
  // 落盘只动 HEAD（工作区一个字节都不碰），所以主树**有**未提交在制品本身不是
  // 阻塞——那正是这条口存在的场景。唯一的真冲突是「分支要改的文件在主树里也有
  // 未提交改动」：那时推进 HEAD 会留下一个说不清谁覆盖谁的现场。此时拒绝并点名。
  const dirtyPaths = new Set(
    corumGitStatusPorcelain(cwd).split('\n').map(line => line.trim()).filter(line => line !== '')
      .map(line => line.replace(/^..\s+/, '').replace(/^.*\s->\s/, '').replace(/^"|"$/g, '')),
  )
  const clash = touched.filter(file => dirtyPaths.has(file))
  if (clash.length > 0) {
    return fail(
      `main tree has uncommitted changes to file(s) this branch also changes: ${clash.slice(0, 5).join(', ')} — commit or stash them first, then port`,
      base,
      patch.length,
    )
  }
  const indexPath = path.join(mkdtempSync(path.join(tmpdir(), 'corum-port-index-')), 'index')
  try {
    const withIndex = <T,>(args: string[], input?: string): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        input,
        env: { ...process.env, GIT_INDEX_FILE: indexPath },
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    withIndex(['read-tree', 'HEAD'])
    withIndex(['apply', '--cached', '--3way', '--whitespace=nowarn', '-'], patch)
    const tree = withIndex(['write-tree']).trim()
    const parent = corumGitHead(cwd)
    if (parent === '') return fail('cannot resolve the main tree HEAD', base, patch.length)
    const summary = message !== undefined && message.trim() !== ''
      ? message.trim()
      : `port ${entry.branch}: ${touched.length} file(s)`
    const commit = execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', summary], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    // HEAD 在试合期间不能被别人推进（同一进程内的集成是串行的，这里只是防御）。
    if (corumGitHead(cwd) !== parent) return fail('main tree HEAD moved while porting', base, patch.length)
    corumGit(cwd, ['update-ref', 'HEAD', commit, parent])
    // 只推 HEAD 不碰工作区，于是工作区现在「落后于 HEAD」：把**只有本次落盘新增的
    // 路径**同步到工作区，否则主树看起来缺文件（集成者的 verify 会跑在缺文件的树上）。
    // 只对「本来就在工作区、且是这次落盘产生的差异」动手，绝不做全树 checkout——
    // 主树的无关在制品必须一字不动。
    corumSyncPortedPathsToWorktree(cwd, parent, commit)
    return { applied: true, base, patchBytes: patch.length, head: commit }
  } catch (error: unknown) {
    return fail(corumGitErrorText(error), base, patch.length)
  } finally {
    rmSync(path.dirname(indexPath), { recursive: true, force: true })
  }
}

/**
 * fork（corum）：把刚落盘提交带来的**文件集合变化**同步进工作区（`corumPortBranchDiff` 的内部收尾）。
 *
 * 为什么需要：口子只推 HEAD，工作区因此会停在旧内容上（新文件在 HEAD 里、不在磁盘；
 * 上游改过的文件在工作区里是旧版本）。集成者随后的 verify 跑在这棵树上就会测错东西。
 *
 * 边界（不做全树 checkout 的原因）：只对「前一个 HEAD 与刚落盘 HEAD 的差异」做 checkout
 * ——那恰好是本次落盘新增/修改的路径；主树里与它们无关的在制品不受影响。若某路径在
 * 工作区里也有未提交改动，本函数按路径 checkout 会覆盖它，所以调用方已在上游用
 * `touched ∩ dirty` 把这种情况挡掉（见 `clash`）。
 * @param cwd - 主树工作目录。
 * @param before - 落盘前的主树 HEAD。
 * @param head - 刚落盘的提交。
 */
function corumSyncPortedPathsToWorktree(cwd: string, before: string, head: string): void {
  let paths: string[] = []
  try {
    paths = execFileSync('git', ['diff', '--name-only', before, head], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').map(line => line.trim()).filter(line => line !== '')
  } catch {
    return
  }
  for (const file of paths) {
    try {
      corumGit(cwd, ['checkout', head, '--', file])
    } catch {
      // 单文件同步失败不改变「工作已进 HEAD」这个事实：真值门禁按 HEAD 判定。
    }
  }
}

/** fork（corum）：分支与 HEAD 的分叉点（无共同祖先/git 失败返回空串）。 */
export function corumMergeBase(cwd: string, branch: string): string {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', branch], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return ''
  }
}

/** fork（corum）：把 execFileSync 的失败收成一行可读文本（stderr 优先，缺则 message）。 */
function corumGitErrorText(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string } | undefined)?.stderr
  const text = stderr === undefined ? '' : String(stderr).trim()
  if (text !== '') return text.split('\n').slice(0, 4).join(' | ')
  return error instanceof Error ? error.message : String(error)
}

/** fork（corum）：主树 HEAD（集成前后推进/祖先判定用；git 不可用返回空串）。 */
export function corumGitHead(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return ''
  }
}

/** fork（corum）：主树未提交改动（porcelain 原文；git 不可用返回空串）。 */
export function corumGitStatusPorcelain(cwd: string): string {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: 'pipe' })
  } catch {
    return ''
  }
}

/**
 * fork（corum）：分支是否已并入 HEAD（`git merge-base --is-ancestor` 退出码 0）。
 * 用于**清理安全阀**——未并入 HEAD 的分支是那批工作的唯一留存，绝不 `branch -D`。
 */
export function corumBranchMerged(cwd: string, branch: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * fork（corum）：分支的工作是否已进入 HEAD——祖先关系 **或** patch 等价
 * （`git cherry HEAD <branch>` 无 `+` 行，覆盖集成者用 cherry-pick 等价落地的情况）。
 * 无新提交的分支返回 true（空 cherry 输出）；分支不存在/git 不可用返回 false。
 *
 * ⚠️ **按分支名的这条路径在分支被删除后必然返回 false**——这是「合并后删分支」这一
 * 合规收尾下的正常形态，不是「没集成」。不要直接用它判集成；集成判定统一走
 * {@link corumEntryIntegrated}（它先用台账 tip 快照证明并入，再回落到这里）。
 */
export function corumBranchIntegrated(cwd: string, branch: string): boolean {
  if (corumBranchMerged(cwd, branch)) return true
  try {
    const out = execFileSync('git', ['cherry', 'HEAD', branch], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return out.split('\n').every(line => !line.startsWith('+'))
  } catch {
    return false
  }
}

/**
 * fork（corum）：`sha` 是否已在 HEAD 的祖先链上（`merge-base --is-ancestor`；任何失败 → false）。
 *
 * 为什么用「快照 sha」而不是分支名判集成（2026-09-20 机制 bug 修复）：
 * 分支是**可变引用**——集成后 `branch -D` 就没了，而删分支是机制自己鼓励的合规收尾
 * （`corumCleanupWorktree` 自己就删）。sha 不会：只要那个 commit 还在历史里，
 * 「它是不是 HEAD 的祖先」就永远可判。故集成判定以**台账快照**为准。
 */
export function corumShaInHead(cwd: string, sha: string): boolean {
  if (sha === '') return false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * fork（corum）：**集成判定的唯一口径**——接台账条目而非裸分支名
 * （2026-09-20 机制 bug 修复）。
 *
 * 事故（用户实测）：集成实际成功、分支已被合规删除，机制仍抛
 * `Error: integrate did not persist into the main tree`。根因是判定按**分支名**跑
 * `merge-base --is-ancestor <branch> HEAD` + `git cherry`，分支被删后两条命令非零退出
 * ⇒ false ⇒ 一次真落地的集成被判失败（连带保住现场、翻转不了台账）。
 *
 * 判定顺序（保守优先，绝不为「看起来像成功」放宽既有门禁）：
 *   ① **分支在场**：走 {@link corumBranchIntegrated}（祖先或 patch 等价，语义不变）；
 *   ② **分支已删**：用台账 tip 快照跑祖先判定；但**空分支不认账**——
 *      `tip === base`（创建后从未提交）与 `tip === HEAD`（fast-forward 到与 HEAD 重合）同罚，
 *      口径与 `corumReconcileIntegrated` 的空分支豁免一致；
 *   ③ 无 tip / 无法判定：**保守 false**（旧的失败行为原样保留）。
 *
 * @param cwd - 主树工作目录。
 * @param entry - 台账条目（用 branch/base/tip）：`tip` 缺失时退化为按分支名判定。
 * @returns 该条目的工作是否已确证进入 HEAD。
 */
export function corumEntryIntegrated(
  cwd: string,
  entry: Pick<CorumWorktreeEntry, 'branch' | 'base'> & { tip?: string },
): boolean {
  // ① 分支还在：既有口径原样保留（未合并分支在场时照样报 false）。
  if (corumBranchTip(cwd, entry.branch) !== undefined) return corumBranchIntegrated(cwd, entry.branch)
  // ② 分支已删（合规收尾）——只能靠快照 sha 证明并入。
  const tip = entry.tip
  if (tip === undefined || tip === '') return false
  // 空分支不认账（与对账口径对齐）：tip === base = 一个提交都没做。
  if (entry.base !== undefined && tip === entry.base) return false
  // tip === HEAD：fast-forward 重合形态，同样不算「这份工作落地」（安全侧失败）。
  if (tip === corumGitHead(cwd)) return false
  return corumShaInHead(cwd, tip)
}

/**
 * fork（corum）：**集成前**给每条待集成条目补一次分支 tip 快照（原地写入 `entry.tip`）。
 *
 * 调用时机必须早于任何删分支动作（集成者的 `branch -D`、清理、coordinate 回收）——
 * 这是把「分支名」这份会消失的引用，换成「sha」这份不会消失的证据的唯一时机。
 * 排障日志（2026-09-20）：快照条数写主日志，配 `integrate truth check` 定位误判。
 *
 * @param cwd - 主树工作目录。
 * @param entries - 待集成条目（原地修改，不改变 status）。
 * @returns 本次真的写入/刷新了几条（分支已不存在且无旧快照则不计）。
 */
export function corumSnapshotBranchTips(
  cwd: string,
  entries: readonly CorumWorktreeEntry[],
): number {
  let written = 0
  for (const entry of entries) {
    const tip = corumBranchTip(cwd, entry.branch)
    if (tip === undefined) continue
    if (entry.tip === tip) continue
    entry.tip = tip
    written += 1
  }
  return written
}

/** fork（corum）：worktree 是否有未提交改动（目录已不存在 → false）。 */
export function corumWorktreeHasUncommitted(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim() !== ''
  } catch {
    return false
  }
}

/**
 * fork（corum）：**隔离前置校验 —— 父树必须干净**（2026-09-15 机制补漏，用户裁定「严格」）。
 *
 * 由来（真实事故，用户 2026-09-15 亲述）：子 Agent 的「Integrate BEFORE evidence branch」失败，
 * 根因是**派发前父树的改动未提交**。机制链条：
 * `git worktree add <path> -b <branch>`（**不指定 base**）⇒ git 默认**从 HEAD 建分支**；
 * 而父工作树的未提交改动**只存在于工作树、不在任何提交里** ⇒ **隔离子看不到它们**。
 * 实证（2026-09-15）：在父树改过的 `theme.css` 里 grep 新增值 `1D112B9E`——
 * **父树命中 1、worktree 命中 0**；隔离子实际工作在旧 HEAD，代码基不含父树那批改动。
 * ⇒ 子会在**过时的树**上开发/验证，**并可能报告成功**（静默失真，比显式失败更危险）。
 *
 * **判据取「严格」档**（用户 2026-09-15 裁定）：`porcelain` **任何**一行都拦，**含 untracked `??`**。
 * 理由：**子的树必须等于父的树**——untracked 的**新源码**同样致命（若父树有新文件未提交，
 * 子会缺这个文件而构建失败或行为不同）。
 *
 * @param parentCwd - 父工作树目录。
 * @returns 拒绝原因（可直接抛给调用方的多行文本）；干净或 git 不可用时返回 `undefined`。
 */
export function corumDirtyParentRefusal(parentCwd: string): string | undefined {
  const porcelain = corumGitStatusPorcelain(parentCwd)
  if (porcelain === '') return undefined
  const lines = porcelain.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return undefined
  const shown = lines.slice(0, 5).map((line) => `  ${line}`).join('\n')
  const more = lines.length > 5 ? `\n  …and ${lines.length - 5} more` : ''
  return [
    `isolation refused: the parent working tree has ${lines.length} uncommitted change(s) in ${parentCwd}`,
    shown + more,
    'An isolated child branches off HEAD, so it CANNOT see uncommitted work: it would develop and',
    'verify against a stale tree and may report success while the parent state differs.',
    'Commit (or stash) the parent changes first, then retry the delegation.',
  ].join('\n')
}

/** fork（corum）：收口强制提交的结果（失败原因**结构化**，供上层投递给模型）。 */
export interface CorumSettleCommitFailure {
  readonly slug: string
  readonly path: string
  /** 可读的失败原因（git stderr 摘要或异常文本）。 */
  readonly reason: string
}

/**
 * fork（corum）2026-09-18：一次委派的 spawn 事实（供**异步失败**时问用户）。
 *
 * 为什么需要：后台一次性 / continuable 的失败不在工具栈上，`subagent/end` 到达时
 * 只剩 runId/childId/stopReason，缺「用户配的是哪个模型 / label / 角色」——那三样正是
 * 提问与「永久写哪个键」必需的（见 `CorumOrchestration.childSpawns` 的说明）。
 */
export interface CorumChildSpawnFacts {
  /** 委派方会话 id（问用户时定位提问落在哪个会话）。 */
  readonly parentSessionId: string
  /** 委托标签（提问文案的人话上下文）。 */
  readonly label: string
  /** 该角色（决定永久档写 subagentModel 还是 researchModel）。 */
  readonly role: 'worker' | 'research'
  /** 用户为该角色配置的模型路由（即"可能不可用"的那个）。 */
  readonly configured: { provider: string; model: string }
  /**
   * 该委派能否「继续」（continuable）。
   *
   * 决定失败后的处置形态（用户两规则的分界）：**能 continue** 的会话可以**带着新模型
   * 续跑同一个子会话**（上下文不丢）；**一次性**任务只能由主 Agent 重新指派一个新子会话。
   */
  readonly continuable: boolean
}

/** 机制自动提交的提交信息（可识别，**不冒充** Agent 的提交）。 */
export const CORUM_AUTO_COMMIT_SUBJECT = 'wip(isolated): auto-commit on settle'

/**
 * fork（corum）：**收口强制提交** —— 把 worktree 里未提交的改动就地提交（2026-09-15 机制补漏）。
 *
 * 用户 2026-09-15 裁定：「一旦做成基于 git worktree 的隔离分支形式，**无论如何每次工作结束
 * Agent 必须提交**，这一点要在**机制上保证**，而**不是 Agent 自己决定是否要提交**」。
 * ⇒ 因此这里**由机制执行**：收口前把「未提交」这一态消灭掉，而不是发个提醒等 Agent 自觉。
 *
 * 提交发生在**隔离分支**上（我们自己的分支，不是用户的主干历史）⇒ 安全且必要：
 * 那些提交是该分支工作的**唯一副本**（既有代码注释原话：nobody sees them otherwise）。
 * 顺带修好一个既有问题：`reconcileAndReclaim` 与 `corumCleanupWorktree` 在 worktree 脏时
 * **跳过回收/保留现场**，于是留下孤儿目录；自动提交后这一态不再出现。
 *
 * @param worktreePath - 目标 worktree 目录。
 * @param slug - 台账条目的 slug（进提交信息，便于追责与检索）。
 * @returns `undefined` = 成功或无需提交（干净/目录不存在/非 git）；否则为**结构化失败原因**。
 */
export function corumCommitWorktreeOnSettle(
  worktreePath: string,
  slug: string,
): CorumSettleCommitFailure | undefined {
  // fork（corum）：实现委托给 git-core 核心插件的 settleCommit 原语（用户 2026-09-16 策略
  // 「所有 git 管理收进一个独立插件」）——本包不再自跑 git add/commit，只把 worktree 语境
  // （slug 溯源 + 提交信息）适配到原语；返回值保持 { slug, path, reason } 兼容既有调用方。
  const failure = gitCoreSettleCommit(
    worktreePath,
    CORUM_AUTO_COMMIT_SUBJECT +
      `\n\nIsolated worktree ${slug} still had uncommitted changes at settle; the mechanism committed them` +
      ' so that no isolated work can be lost (user rule 2026-09-15: a work round must end committed).',
  )
  if (failure === undefined) return undefined
  return { slug, path: worktreePath, reason: failure.reason }
}

/**
 * fork（corum）：一次性读出「已并入 HEAD 的分支名」集合（单条 git 命令）。
 * @param cwd - 主树工作目录。
 * @returns 分支短名集合；git 不可用/失败时返回空集合（对账退化为「什么都不翻」）。
 */
export function corumMergedBranches(cwd: string): Set<string> {
  try {
    const out = execFileSync('git', ['branch', '--merged', 'HEAD', '--format=%(refname:short)'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    })
    return new Set(out.split('\n').map(line => line.trim()).filter(line => line !== ''))
  } catch {
    return new Set()
  }
}

/** fork（corum）：realpath（macOS 的 /var → /private/var 符号链接会让前缀/相等比较失配）。 */
function corumRealPath(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/** fork（corum）：分支是否带着 HEAD 之外的提交（true = 有独立工作，不能删）。 */
export function corumBranchAddsCommits(cwd: string, branch: string): boolean {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `HEAD..${branch}`], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return Number.parseInt(out.trim(), 10) > 0
  } catch {
    // 分支不存在/git 失败：当作「有独立工作」保守处理，绝不动它。
    return true
  }
}

/**
 * fork（corum）：列出**本仓自己的**隔离 worktree（`<cwd>/.corum-worktrees/*`）。
 *
 * 只认这个根下的路径——别人的 worktree（用户手动建的、别的工具的）一律不进清扫面。
 * @param cwd - 主树工作目录。
 * @returns `{ path, branch }` 列表（git 失败返回空数组）。
 */
export function corumListIsolatedWorktrees(cwd: string): { path: string; branch: string }[] {
  const root = `${corumRealPath(path.resolve(cwd, '.corum-worktrees'))}${path.sep}`
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', stdio: 'pipe' })
    const items: { path: string; branch: string }[] = []
    let current: string | undefined
    for (const raw of out.split('\n')) {
      const line = raw.trimEnd()
      if (line.startsWith('worktree ')) { current = line.slice('worktree '.length).trim(); continue }
      if (line.startsWith('branch ') && current !== undefined) {
        const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
        items.push({ path: current, branch })
        current = undefined
      }
    }
    return items.filter(item => corumRealPath(item.path).startsWith(root))
  } catch {
    return []
  }
}

/**
 * fork（corum）：**孤儿 worktree 清扫**——台账已经不记得、也没有留存价值的隔离工作区。
 *
 * 为什么需要（2026-09-12 实测）：台账记录在「没有待集成条目」时会被删掉，而子 Agent
 * 被进程退出杀掉时永远不会 settle → worktree 与分支留在磁盘上**没有任何记录引用它们**，
 * 之后的对账/懒剔除都碰不到（本仓实测 10 个这样的纯空目录，加上台账内的共 17 个）。
 *
 * 只在启动调用（唯一能确定没有子 Agent 在跑的时刻）。三重保守闸门，任一不满足就跳过：
 * ① 有未提交改动 → 留目录；② 分支带着 HEAD 之外的提交 → 整个留（那是唯一留存）；
 * ③ 台账里还活着的条目 → 不碰。只有「干净 + 分支对 HEAD 零新增」才会目录和分支一起删。
 *
 * @param cwd - 主树工作目录。
 * @param keep - 台账在册的 worktree 路径（活着的一律不动）。
 * @returns 实际回收的数量。
 */
export function corumReapOrphanWorktrees(cwd: string, keep: ReadonlySet<string> = new Set()): number {
  // keep 集合与 git 报的路径都可能带/不带符号链接解析（macOS tmpdir /var ↔ /private/var）
  // → 两边统一成 realpath 再比。
  const keepReal = new Set([...keep].map(corumRealPath))
  let reaped = 0
  for (const item of corumListIsolatedWorktrees(cwd)) {
    if (keepReal.has(corumRealPath(item.path))) continue
    if (corumWorktreeHasUncommitted(item.path)) continue
    if (corumBranchAddsCommits(cwd, item.branch)) continue
    if (corumCleanupWorktree(cwd, item, { force: false })) reaped += 1
  }
  return reaped
}

/**
 * fork（corum）：**启动清扫**——恢复台账时把「已经没有留存价值」的条目连现场一起回收。
 *
 * 为什么只能在启动做：这是唯一能确定「没有任何子 Agent 还在跑」的时刻。子 Agent 被
 * 进程退出杀掉时永远不会 settle，条目就以 `active` 留在台账里——既不回收（安全清理
 * 只对 settle 过的条目生效，避免拔掉活子 Agent 的工作目录），也不消失（next `entriesOf`
 * 判它「分支还在 = 活条目」），于是 `.corum-worktrees` 永久堆积（2026-09-12 实测 20+ 个，
 * 其中 13 个零提交零改动的纯空目录）。
 *
 * 判据 = 既有的**安全清理**返回值：`corumCleanupWorktree(force:false)` 只在
 * 「分支不并入 HEAD 就留分支、worktree 有未提交改动就留目录」都通过、现场真的被清干净时
 * 才返回 true。清干净 ⇒ 磁盘上什么都没了 ⇒ 条目没有留存价值，从台账剔除（否则它会在
 * 下一次 `entriesOf` 被判成「死条目」再剔一次，日志与状态都会多绕一圈）。
 *
 * @param cwd - 主树工作目录。
 * @param entries - 恢复出来的台账条目。
 * @returns 保留的条目（现场未清干净的一律保留，状态如实）。
 */
export function corumReapRestoredEntries(cwd: string, entries: readonly CorumWorktreeEntry[]): CorumWorktreeEntry[] {
  return entries.filter(entry => {
    if (!corumCleanupWorktree(cwd, entry, { force: false })) return true
    // 清干净了：已集成的记录保持 integrated 并标 reclaimed（见 corumCleanupLedgerEntries
    // 的分档说明），未被集成的僵尸条目才落 discarded。
    if (entry.status === 'integrated') entry.reclaimed = true
    else { entry.status = 'discarded'; entry.reclaimed = true }
    return false
  })
}

/**
 * fork（corum）：分支 tip（sha；分支不存在/git 不可用 → undefined）。
 *
 * 用途只有一个：把「分支 tip 就是 HEAD」的**空分支**挡在对账之外。空分支（worktree
 * 建好后子 Agent 一个提交都没做）在 `git branch --merged HEAD` 里与「真合并过的分支」
 * 长得一模一样——只看 `--merged` 会把什么都没干的分支翻成 `integrated`
 * （单测 `settleFromEnd 精确翻转` 就是这么红的：fixture 的 `git branch wt/wt-s1` 是纯空分支）。
 *
 * @param cwd - 主树工作目录。
 * @param branch - 分支短名（`wt/wt-xxxxxx`）。
 * @returns tip sha；`undefined` = 分支不存在或 git 调用失败。
 */
export function corumBranchTip(cwd: string, branch: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    })
    const tip = out.trim()
    return tip === '' ? undefined : tip
  } catch {
    return undefined
  }
}

/**
 * fork（corum）：**台账与 git 实况对账**——把「分支其实已经并入 HEAD」的待集成条目翻成
 * `integrated`（2026-09-12 用户实测后补）。
 *
 * 为什么必须有：集成不只有机制那条路。主 Agent 完全可以（而且实测就是）**派一个子 Agent
 * 用 git 把分支合并掉**——机制对此一无所知：台账里 4 条仍是 `settled`，卡片照旧显示
 * 「集成者 · 未启动 · 4 个分支待集成」，而 git 里 4 个分支**早就都在 main 上**。后果是
 * 连环的：卡片说谎、pending 通知对着已合并的分支报「未合并」、worktree 永不回收
 * （BUG-26「条目越堆越多」的根就在这）。
 *
 * 判据只用 git 真相（`git branch --merged HEAD`），不看任何自述；翻状态不改动 git 现场。
 * **空分支不翻**：`tip === HEAD` 说明这条分支从没往前走（纯空分支，或 fast-forward 到
 * 与 HEAD 重合），翻成 integrated 等于替一条什么都没干的分支签收——这类条目该走的是
 * 回收，不是认账（代价：真被 ff 合并的分支会退化成旧的「留待手动集成」，安全侧失败）。
 *
 * @param cwd - 主树工作目录。
 * @param entries - 该会话的台账条目。
 * @returns 对账后的条目 + 本次翻成 integrated 的 slug 列表（供持久化/发帧判断）。
 */
export function corumReconcileIntegrated(
  cwd: string,
  entries: readonly CorumWorktreeEntry[],
): { entries: CorumWorktreeEntry[]; flipped: string[] } {
  const hasPending = entries.some(entry => entry.status === 'active' || entry.status === 'settled')
  if (!hasPending) return { entries: [...entries], flipped: [] }
  // 2026-09-20：分支可能已被合规删除，`git branch --merged HEAD` 那时什么都看不到
  // （这正是「集成成功却判未落地」的另一半）。故先补 tip 快照，再按合并集合 ∪
  // 「已删且快照在 HEAD 祖先链上」判定；`merged.size === 0` 的提前返回随之取消——
  // 一条分支都没有时仍可能有「已删分支」的待集成条目要靠快照翻。
  corumSnapshotBranchTips(cwd, entries)
  const merged = corumMergedBranches(cwd)
  const head = corumGitHead(cwd)
  const flipped: string[] = []
  const next = entries.map(entry => {
    if (entry.status !== 'active' && entry.status !== 'settled') return entry
    // 分支已删：走 tip 快照判定（与 `corumIntegrationTruth` 共享同一口径——
    // `corumEntryIntegrated` 只依赖 branch/base/tip，与合并集合的判定等价）。
    const branchGone = corumBranchTip(cwd, entry.branch) === undefined
    if (branchGone) {
      // tip === HEAD 的空分支豁免在这里同样成立（corumEntryIntegrated 内），
      // 但下面那句 `tip === head` 早退只在分支在场时有意义，故分支已删时直接交给判定函数。
      if (!corumEntryIntegrated(cwd, entry)) return entry
      flipped.push(entry.slug)
      return { ...entry, status: 'integrated' as const }
    }
    if (!merged.has(entry.branch)) return entry
    const tip = corumBranchTip(cwd, entry.branch)
    if (tip === undefined || tip === head) return entry
    // 空分支（创建后从未提交）不认账：`tip === base` 说明这条分支与它的创建点分毫不差，
    // 合并它等于什么都没并。缺 `base`（2026-09-12 之前的存量条目）时无从判断，
    // 只靠上面的 `tip !== head` 兜底。
    if (entry.base !== undefined && tip === entry.base) return entry
    flipped.push(entry.slug)
    return { ...entry, status: 'integrated' as const }
  })
  return { entries: next, flipped }
}

/**
 * fork（corum）：台账条目是否已**彻底失效**——worktree 目录与分支都不存在。
 *
 * 这类条目既不能集成（无分支可并）也不能再跑，却会在 `maxParallelChildren` 里永久
 * 占用额度。来源是 2026-09-09 之前的强删清理（`worktree remove --force` + `branch -D`
 * 之后条目仍留在台账/落盘记录里，见 docs/TODO.md 的 4 条 `active` 实证）。任一留存
 * （目录在 / 分支在）都算活条目——分支还在就仍可集成。
 */
export function corumEntryDead(cwd: string, entry: Pick<CorumWorktreeEntry, 'path' | 'branch'>): boolean {
  if (existsSync(entry.path)) return false
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}`], { cwd, stdio: 'pipe' })
    return false
  } catch {
    return true
  }
}

/**
 * fork（corum）：research 任务的 toolFilter——当任务声明只读（research=true）且
 * 实例 config 未显式 deny 全部写工具时，补 deny 全部写工具（与 subagent_research
 * 只读实例同款口径）。allow 保持 config 原值（只读任务不扩权）。
 */
export function corumResearchToolFilter(
  toolFilter: { allow?: string[]; deny?: string[] } | undefined,
  readonlyResearch: boolean,
): { allow?: string[]; deny?: string[] } | undefined {
  if (!readonlyResearch) return undefined
  if (corumMutationToolsForPlatform().every(t => toolFilter?.deny?.includes(t) === true)) return undefined
  return {
    ...toolFilter?.allow !== undefined ? { allow: toolFilter.allow } : {},
    deny: [...new Set([...(toolFilter?.deny ?? []), ...corumMutationToolsForPlatform()])],
  }
}

/**
 * fork（corum）：某个 scope 当前**可见**的全局工具名集合——`tools.restrict()` 的合法
 * 名字面。
 *
 * `dsh-tools` 的 `restrict()` 按「该 scope 的 known names」校验（未知名 fail-loud），而
 * preset 常驻层注册的工具属于该 scope 的祖先层：只有 `scopeOf(ctx)` + `schemas(scope)`
 * 这一对才能看到它们。任何「机制按名字裁工具/追加 deny」的调用点都应先过这里
 * （`corumNarrowDenyFilter` 的 `known` 参数即本函数返回值）。
 *
 * 注意：返回的是**可见**名（已应用链上既有 restriction）——它一定是 known 的子集，用作
 * deny 收敛只会多丢「本来就不存在/已被裁掉」的名字，不会漏掉真实存在的工具。
 * @param ctx - 目标 Agent 的 scoped 上下文（`agent.ctx` / agent scope 的创建窗口）。
 * @returns 该 scope 可见的工具名（省略 scope 时退化为全局视图，调用方应始终传 scoped ctx）。
 */
export function corumVisibleToolNames(ctx: Context): ReadonlySet<string> {
  return new Set(ctx.tools.schemas(scopeOf(ctx)).map(schema => schema.name))
}

/**
 * fork（corum）：把机制生成的 deny 名单收敛到「子 Agent 真正注册的工具名」。
 *
 * 背景（2026-09-10 实机，官方 preset 三模式全部派不出子 Agent）：corum 的写工具
 * 名单是**平台口径的硬编码**，其中 `str_replace_editor` 只有挂了
 * `str-replace-editor` 行的 preset（corum 自己的 profile、官方 minimal）才有；
 * 官方 standard/ptc/cordis 挂的是 `write`/`edit`。而 `tools.restrict()` 对未知名
 * fail-loud（dsh-tools），于是机制追加的 deny（denyDirectFs 的 str_replace_editor、
 * research 的写工具全家）让子 Agent 创建**直接抛错**：
 * `tools.restrict() names unknown global tool "str_replace_editor"`。
 *
 * 语义边界：只收敛 `deny`——deny 一个不存在的工具本就无从谈起（它不可能被调用），
 * 静默丢弃是正确结果；`allow` 原样保留，因为 allow 是「只留这些」的断言，写错必须
 * 继续 fail-loud（那是配置错误，不是平台差异）。preset 里**手写**的 config.toolFilter
 * 也不收敛（作者断言，同 allow 口径）。
 *
 * BUG-6（2026-09-11）：deny 中的裸 MCP 服务名（如 `pencil-mcp`）需要展开为
 * 带前缀的完整工具名列表（`mcp__<服务名>__*`）。MCP 工具在系统中的注册名是
 * `mcp__<服务名>__<工具名>` 格式（与官方 dsh-mcp-client 逐字一致的名字，
 * 现由 @corum/corum-mcp-manager/proxy 复刻，见其 tool-naming.ts），但 compile.ts 的
 * `mcpDenyNames` 只放了服务名本身。本函数在收敛时把裸服务名展开为该服务的
 * 全部已知工具名，保持 deny 语义（research 实例真的禁掉 MCP 工具）。
 *
 * @param filter - 机制生成的过滤器（config 原样透传的除外，见调用点）。
 * @param known - 目标 scope 可见的工具名（父 Agent scope 的可见名是其超集）。
 * @returns 收敛后的过滤器；deny 全被丢弃且无 allow 时返回 undefined（等于不限制）。
 */
export function corumNarrowDenyFilter(
  filter: { allow?: string[]; deny?: string[] } | undefined,
  known: ReadonlySet<string>,
): { allow?: string[]; deny?: string[] } | undefined {
  if (filter === undefined || filter.deny === undefined) return filter
  const deny: string[] = []
  // 是否发生过「丢弃 / 展开」——都没发生时原样返回**同一个引用**。
  // 这是既有约定（且已被单测锁定）：调用方会拿返回值做引用比较来判断「过滤器是否
  // 被改过」，无谓复制会让它误判。BUG-6 的展开逻辑早期版本丢了这条快路径，
  // 被 `isolation.spec.ts` 抓回来。
  let changed = false
  for (const name of filter.deny) {
    if (known.has(name)) {
      deny.push(name)
      continue
    }
    // BUG-6：裸 MCP 服务名展开为 `mcp__<服务名>__<工具名>` 前缀的全部已知工具。
    // 前缀格式 `mcp__<name>__`：已知工具名以此前缀开头的全部收入 deny。
    // 前缀无命中（服务未装载/名写错）时什么都不加 —— 等价于原「丢弃未知名」语义。
    const prefix = `mcp__${name}__`
    for (const tool of known) {
      if (tool.startsWith(prefix)) deny.push(tool)
    }
    changed = true
  }
  if (!changed) return filter
  if (deny.length === 0 && filter.allow === undefined) return undefined
  return { ...filter.allow !== undefined ? { allow: filter.allow } : {}, deny }
}

/**
 * fork（corum）：有效 toolFilter——config.toolFilter 与 denyDirectFs 的 deny 并集
 * （denyDirectFs=false 时不附加；config.toolFilter 缺省时并集只有附加项）。
 */
export function corumEffectiveToolFilter(
  toolFilter: { allow?: string[]; deny?: string[] } | undefined,
  denyDirectFs: boolean,
): { allow?: string[]; deny: string[] } {
  return {
    ...toolFilter?.allow !== undefined ? { allow: toolFilter.allow } : {},
    deny: [...toolFilter?.deny ?? [], ...denyDirectFs ? ['str_replace_editor'] : []],
  }
}

/**
 * fork（corum）：写工具判定——readonlyResearch 恒只读；否则看有效 toolFilter
 * 是否已把全部写工具 deny。
 */
export function corumIsWriteTask(
  toolFilter: { allow?: string[]; deny?: string[] } | undefined,
  readonlyResearch: boolean,
  denyDirectFs = true,
): boolean {
  if (readonlyResearch) return false
  const deny = corumEffectiveToolFilter(toolFilter, denyDirectFs).deny
  // 平台实际装载的写工具口径（pwsh 仅 win32——未装载的工具不会被 deny，
  // 也不应参与「全 deny 即只读」的判定，否则非 win32 恒判写任务）。
  const presentWriteTools = process.platform === 'win32'
    ? CORUM_WRITE_TOOLS
    : CORUM_WRITE_TOOLS.filter(tool => tool !== 'pwsh')
  return !presentWriteTools.every(tool => deny.includes(tool))
}

/**
 * fork（corum）：隔离触发判定（readonlyResearch 实例恒不隔离）。
 *
 * ## 不变式⑤（invariant.write-delegation-always-isolated，用户 2026-09-16 裁定）
 *
 * > 「**无论是前台还是后台，只要进行并行 work，就要隔离**」+「**收紧**」——
 * > 即**取消「孤立前台写委派可以直接在主工作区干活」这条豁免**：**凡写委派恒隔离**。
 *
 * ### 为什么取消那条豁免（它此前的理由已不成立）
 * 旧口径（2026-09-09）是「隔离的存在理由是并发写冲突，没有并发就没有冲突」，
 * 于是单发前台写委派直写主树。但实测（2026-09-16）暴露它有两个真问题：
 *  ① **不对称**：同一条消息里并发两个前台写调用时，**第一个直写主树、第二个隔离**
 *     （并发信号是「此刻是否已有写子 Agent 在跑」，而首个派遣时第二个还没注册）。
 *     模型以为两次委托等价，实际一个已落主树、一个在分支上等集成。
 *  ② **永不进主树的分支 vs 混收的改动**：直写路径的改动与主 Agent 自己的未提交改动
 *     混在同一工作区，只能靠文件名区分归属；隔离路径的产物则统一走 integrate（可验收、
 *     可追溯）。既然验收统一由主 Agent 做，就没有理由让任何写委派绕过这条通道。
 *
 * ### `off` 已清除（同一次裁定）
 * 用户原话：「隔离恒定生效，**off 语义应该被清除**」。故 `mode` 只剩 `always` /
 * `write-tasks`，两者对写任务**等价**（都隔离）——保留 `write-tasks` 是为了不动存量
 * 配置的取值（它现在只是「写任务隔离」的同义词）。
 *
 * ### 2026-09-27（用户裁定 A）：新增**语义出口** `isolation: 'main'`，档位出口仍然没有
 *
 * 实测病根（会话 `corum-task-56b7d485`）不是「隔离太严」，而是**派发参数表达不了意图**：
 * 主 Agent 想让子 Agent 去主树 / 跨仓落盘（甚至合并），却只能派出一个隔离 worktree 子
 * Agent，于是整轮在「派出去 → 撞墙 → 再派一个 → 再撞墙」里打转（20 次派发、4 个零提交
 * 子会话、3 次把搬运外包给用户）。修法是让「这次在主树工作」**可表达**，且由调用方
 * **逐次显式声明**：
 *   · 它不是 `off`：`mode` 与任务级 `taskIsolation` **仍然无法**关掉隔离，写委派默认恒隔离；
 *   · 它不改隔离的语义（工作区隔离 = 防并发改写互相踩），只是说明**这一次不需要那个壳**；
 *   · 主仓硬线不受影响：派到主树的子 Agent 同样受「主 Agent 的权限面」约束，而隔离期那条
 *     「不许写当前仓库非自己 worktree」对没有 worktree 的它本来就不适用。
 *
 * ### 边界（不是逃生口，是另一条轴）
 *  - `readonlyResearch`（只读研究实例/任务）：恒不隔离——它不落盘，无需隔离。
 *  - 非 git 工作区：由调用方在 `corumIsGitRepo` 为假时降级（worktree 建不出来），
 *    与 mode 无关。
 *  - **迭代/provider 级 `track` 模式**（ralph 等顺序迭代）：不经过本函数，属**独立模式**
 *    （用户 2026-09-16：「迭代模式是一个单独模式，和 plan 一样，除非用户显式指定不然
 *    LLM 不触发」）。
 *
 * @param mode - 生效隔离模式（任务级覆盖 > 预设 > 全局 > 默认）。`off` 已从枚举移除。
 * @param isWriteTask - 有效工具面判定出的写任务（corumIsWriteTask）。
 * @param readonlyResearch - 只读研究实例/任务（恒不隔离）。
 * @param concurrent - **已废弃、不再参与判定**（保留形参避免改动所有调用点与单测签名）。
 *   不变式⑤后写任务恒隔离，与并发无关；仅只读判定与 mode 生效。
 * @param isolation - **本次派发的显式意图**（默认 `'worktree'`）：`'worktree'` = 常规隔离
 *   路线（自己 worktree + 分支，要 integrate 才进主树）；`'main'` = 明确要求子 Agent
 *   **直接在主工作树里工作**（跨仓 / 主树落盘 / 合并这类任务）。只有调用方逐次显式声明才
 *   生效——预设与档位都表达不了它（见头注「语义出口」段）。
 */
export function corumShouldIsolate(
  mode: 'always' | 'write-tasks',
  isWriteTask: boolean,
  readonlyResearch: boolean,
  concurrent = true,
  isolation: 'worktree' | 'main' = 'worktree',
): boolean {
  void concurrent
  if (readonlyResearch) return false
  // fork（corum）2026-09-27：显式「在主树工作」⇒ 不建 worktree。只读研究在上面已经返回，
  // 故这里不可能把只读实例放进主树写（那条约束由 research 的沙箱 read-only + 工具面 deny 守）。
  if (isolation === 'main') return false
  // 不变式⑤：凡写委派恒隔离（前台/后台/可继续一视同仁），无 off 逃生口。
  if (isWriteTask) return true
  // 非写任务（工具面被 deny 到无写能力）：只有显式 always 才隔离（保持既有语义）。
  return mode === 'always'
}

/** fork（corum）：清理选项——`force` 为无条件强删（仅集成成功后调用）。 */
export interface CorumCleanupOptions {
  /**
   * true = 无条件强删（`worktree remove --force` + `branch -D`）。
   * 仅当**工作已确认并入 HEAD**（集成成功）时才可传——否则会销毁未合并工作的
   * 唯一留存（docs/TODO.md 的 autoIntegrate 数据丢失事故）。
   * 缺省/false = 安全清理：worktree 有未提交改动则保留目录，分支未并入 HEAD 则保留分支。
   */
  readonly force?: boolean
}

/**
 * fork（corum）：最佳努力回滚/清理（清理失败不掩盖原始错误）。
 *
 * 2026-09-09 加固（机制真值门禁配套）：非 force 模式下——
 * - worktree 目录：有未提交改动 → **保留现场**（不删目录）；
 * - 分支：未并入 HEAD → **保留分支**（未合并提交是那批工作的唯一留存，
 *   `branch -D` 会让 commit 变成 unreachable，实测即数据丢失）。
 * @returns 是否已完整清理（worktree 目录已消失且分支已删除）。
 */
export function corumCleanupWorktree(
  cwd: string,
  entry: Pick<CorumWorktreeEntry, 'path' | 'branch'> & { tip?: string },
  options: CorumCleanupOptions = {},
): boolean {
  const force = options.force === true
  const keepWorktree = !force && corumWorktreeHasUncommitted(entry.path)
  const keepBranch = !force && !corumBranchMerged(cwd, entry.branch)
  // 2026-09-20：**删分支之前**先把 tip 记进台账。删掉的是「分支名」这个可变引用，
  // 快照下来的 sha 仍能证明这份工作已进 HEAD（否则下一轮集成判定会假阴，
  // 正是「集成成功却抛 integrate did not persist」的机制 bug）。
  // 只更新非空快照：分支已不存在时保留旧快照（旧值仍是有效证据）。
  const tipNow = corumBranchTip(cwd, entry.branch)
  if (tipNow !== undefined) entry.tip = tipNow
  let worktreeRemoved = false
  if (!keepWorktree) {
    try {
      corumGit(cwd, ['worktree', 'remove', '--force', entry.path])
      worktreeRemoved = true
    } catch {
      // Best effort: 台账仍登记，dispose 清理会重试。
    }
  }
  let branchDeleted = false
  if (!keepBranch) {
    try {
      corumGit(cwd, ['branch', '-D', entry.branch])
      branchDeleted = true
    } catch {
      // Best effort: 分支可能未建或已删。
    }
  }
  return branchDeleted && (worktreeRemoved || !existsSync(entry.path))
}

/**
 * fork（corum）：删除指定状态的台账条目（worktree remove + branch -D + 标 discarded）。
 *
 * 2026-09-09 加固：仅在**完整清理**（目录已消失 + 分支已删）时才改状态——
 * 安全模式下被保留的未合并分支/脏 worktree 保持原 status 并落盘，台账状态如实
 * 反映现场（此前无条件标 discarded 导致「worktree 已清、台账仍 active」的漂移）。
 *
 * 2026-09-12 修正（分档，用户实测）：清理成功后**已集成的条目保持 `integrated`**
 * 并置 `reclaimed: true`（工作确已进主树，只是现场回收了）；只有「没集成就被清掉」
 * 的才落 `discarded`。此前一律落 discarded，UI 会把成功集成写成「已丢弃」。
 */
export function corumCleanupLedgerEntries(
  cwd: string,
  entries: CorumWorktreeEntry[],
  statuses: readonly CorumWorktreeEntry['status'][],
  options: CorumCleanupOptions = {},
): void {
  for (const entry of entries) {
    if (!statuses.includes(entry.status)) continue
    // 清理前先记住「工作是否已进主树」——它决定清理后落哪个状态。
    const landedInMain = entry.status === 'integrated'
    if (!corumCleanupWorktree(cwd, entry, options)) continue
    if (landedInMain) {
      // 已集成 + 现场回收：状态如实保持 integrated，只补 reclaimed 标记
      // （UI 显示「已集成 · 现场已回收」）。**不能写 discarded**——那在 UI 上是
      // 「已丢弃」，对一份已经进主树的工作是谎（2026-09-12 用户实测指出）。
      entry.reclaimed = true
    } else {
      // 没集成却被清掉（显式丢弃 / 现场已不存在的僵尸条目）→ discarded 才是实话。
      entry.status = 'discarded'
      entry.reclaimed = true
    }
  }
}

/**
 * fork（corum）：台账里**终态记录**（integrated/discarded）的保留上限。
 *
 * 终态条目是「并行工作区」这一栏的历史与分类来源（用户 2026-09-12 实测：
 * 隔离任务那一栏整段消失了）。现场（worktree 目录 + 分支）回收后记录仍要留下，
 * 否则该栏会随着清理一起消失；但也不能无限增长，故保留最近 N 条。
 */
const CORUM_LEDGER_TERMINAL_KEEP = 30

/** fork（corum）：条目是否已到终态（integrated / discarded）。 */
function isTerminalEntry(entry: Pick<CorumWorktreeEntry, 'status'>): boolean {
  return entry.status === 'integrated' || entry.status === 'discarded'
}

/** fork（corum）：integrate 准入——active 或 settled 的待集成条目。 */
export function corumPendingIntegration(entries: CorumWorktreeEntry[]): CorumWorktreeEntry[] {
  return entries.filter(entry => entry.status === 'active' || entry.status === 'settled')
}

/**
 * fork（corum）：subagent/end settle 联动——按 runId/childId 精确翻转 active→settled。
 *
 * 2026-09-09 修复：条目在 spawn 后经 `bindRunId` 绑定 id（前台 one-shot 绑 run.id、
 * continuable 绑 childId），故**先按 runId 再按 childId 精确匹配**——并行多个子 Agent
 * 时各自精确命中，不再依赖「唯一 active 回退」（该回退在 ≥2 并行时必然失败，是
 * docs/TODO.md「settle 联动未生效」的第二半）。回退分支保留给未绑定 id 的存量条目。
 */
export function corumMarkSettled(
  entries: CorumWorktreeEntry[],
  settle: { runId?: string; childId?: string },
): boolean {
  const match = (id: string | undefined): CorumWorktreeEntry | undefined =>
    id === undefined ? undefined : entries.find(entry => entry.status === 'active' && entry.runId === id)
  // childSessionId 与 runId 同值（见 CorumWorktreeEntry 注释），但**必须单独补写**：
  // 浮层「并行工作区」行的可点性只看 childSessionId。2026-09-12 真机实测：本仓台账里
  // 2 条已结算条目只有 runId、没有 childSessionId（走的是下面的回退分支），于是
  // 「工作区行点击进入子会话」在真实数据上**全是死行**（渲染成 div，没有 → 与 title）。
  const childIdOf = (entry: CorumWorktreeEntry): string | undefined =>
    entry.childSessionId ?? settle.childId ?? entry.runId
  const byId = match(settle.runId) ?? match(settle.childId)
  if (byId !== undefined) {
    byId.status = 'settled'
    const childId = childIdOf(byId)
    if (childId !== undefined) byId.childSessionId = childId
    return true
  }
  if (settle.childId === undefined) return false
  const candidates = entries.filter(entry => entry.status === 'active' && entry.runId === undefined)
  if (candidates.length === 1) {
    candidates[0].status = 'settled'
    candidates[0].runId = settle.runId ?? settle.childId
    candidates[0].childSessionId = settle.childId ?? settle.runId
    return true
  }
  return false
}

/**
 * fork（corum）：**机制真值门禁**的判定结果——集成是否真的持久化进主树历史。
 * 语义（2026-09-09 数据丢失事故修复，docs/TODO.md）：
 * - `unmerged`：分支的工作未进入 HEAD（集成者没合并/合并失败/只改了工作区没提交）；
 * - `uncommitted`：worktree 里残留未提交改动（子 Agent 写了没提交 = 未持久化）；
 * - `dirtyDelta`：主树新增的未提交改动（集成前后对比，仅供提示，不作失败判据）；
 * - `dirtyBeforeCount`：**集成前主树就有**的未提交改动条数（无关在制品；见
 *   `corumDirtyOwnershipLines` 的由来注释）——同样的「只作提示、不作判据」；
 * - `integrated`：`unmerged` 与 `uncommitted` 均空才算真集成。
 */
export interface CorumIntegrationTruth {
  readonly integrated: boolean
  readonly unmerged: readonly string[]
  readonly uncommitted: readonly string[]
  readonly dirtyDelta: readonly string[]
  readonly dirtyBeforeCount: number
  readonly head: string
}

/**
 * fork（corum）：按 git 实况判定集成是否成功——**不再信任集成者自述**
 * （`settleForegroundRun` 只保证子 Agent 正常结束，不代表它真的合并了）。
 *
 * 事故链条（2026-09-09）：集成者自称「已 merge + verify 通过」→ 机制无条件把台账
 * 写 `integrated` 并 `worktree remove --force` + `branch -D` → 子任务 commit 变成
 * unreachable、文件从主树消失（`git log --all` 只剩 init）。本函数是该链条的闸门。
 *
 * 2026-09-20 修正（反向误判，机制 bug）：闸门**不得因为「分支已删」就报失败**——
 * 「确认并入 HEAD 之后删掉分支」是合规收尾（`corumCleanupWorktree` 自己就删），
 * 那时 `merge-base --is-ancestor <branch> HEAD` 与 `git cherry` 都非零退出，旧实现据此
 * 判 false ⇒ **集成实际成功却抛 `integrate did not persist into the main tree`**。
 * 现在每条条目先补 tip 快照、再按 {@link corumEntryIntegrated} 判定（分支已删时用快照
 * sha 的祖先关系证明并入）。「分支已删」不再等于失败；只有**既无分支也无有效快照**才是。
 *
 * @param cwd - 主树（父会话）工作目录。
 * @param entries - 待集成的台账条目（active/settled）。
 * @param dirtyBefore - 集成前 `corumGitStatusPorcelain(cwd)` 原文（dirtyDelta 基线）。
 *
 * fork（corum）2026-09-12 修正（实机事故）：判定条件里的 `uncommitted` 曾**参与
 * `integrated`**，而 `entries` 是**该会话全部 active/settled 条目**——于是任何兄弟
 * worktree 的未提交残留（哪怕与本次 fan-in 无关，实测是一个 scratch 文件）都会让一次
 * 已经落地的集成被判失败：首轮派发的会话 corum-task-d51272e3 因此拿到
 * 「integrate did not persist into the main tree … worktrees with UNCOMMITTED changes:
 * wt-5700d6」，而主树 HEAD 明明已推进（704f855e → 254df321），主 Agent 后续的
 * 「重启验证实例 / 三层实机验证 / 落位台账」三阶段整条没起来。
 *
 * 现在的口径：**「分支是否已并入 HEAD」才是集成失败的唯一闸门**（那是「接到的活儿
 * 有没有落地」）；worktree 里的未提交改动属**未持久化**，由调用方按条目处理——
 * 该条目**保持 pending 并保留现场**（不标 integrated、不清理），并在结果里显式告知，
 * 而不是把整次 fan-in 判死。真未落地（分支不在 HEAD）依旧抛错 + 保留现场。
 */
/**
 * fork（corum）：`orchestrate` 要不要由机制收尾（纯函数，2026-09-12 两轮用户实测后定稿）。
 *
 * 演进：旧口径是「`merge.autoIntegrate` 缺省 = 只报告」，把合并交给模型记性。实测代价极大——
 * 12 个用过 orchestrate 的会话里 `autoIntegrate` 声明 true 仅 5 次、false 10 次、未声明 6 次，
 * **真正发生过集成的只有 3 个会话**，隔离分支（那份工作的唯一副本）静默搁浅；用户据此报
 * 「编排工作流的最后一个节点始终不会运行」。随后改成「声明 verify 即默认自动集成」，
 * 但用户点出关键：**这个字段对模型是个诱人的 footgun**——10 次提及里 10 次设成 false，
 * 而它几乎不会回来执行（见 BUG-29）。
 *
 * 定稿口径：**声明即执行**。传了 `merge`（哪怕只有 verify，甚至是空对象）= 要机制跑完流水线；
 * 不传 = 分支留着给调用方，收尾走**显式动作** `subagent { integrate: true }`——
 * 从「随手设 false 就忘」变成「必须真的调一次」，这正是两者可靠性的差别。
 *
 * @param merge - orchestrate 的 merge 声明（缺省 = 调用方自己收尾）。
 * @returns 是否由机制自动 merge + verify + commit。
 */
export function corumAutoIntegrate(merge: { verify?: string } | undefined): boolean {
  return merge !== undefined
}

/**
 * fork（corum）：集成成功的**补充口**——主树脏/未提交时的 diff 落盘。
 *
 * 用法（机制侧）：集成者跑完、`corumIntegrationTruth` 报「有分支没进 HEAD」时，
 * 对每条未合并条目调一次本函数再复判一次真值。这是**补救路径**，不是放宽门禁：
 * `applied === false` 时照样走失败分支（抛错 + 保留现场）。
 * @param cwd - 主树工作目录。
 * @param entries - 待集成条目（只处理 `applied` 需要的分支信息）。
 * @returns 每条分支的落盘结果（顺序与入参一致，便于报告对照）。
 */
export function corumPortPendingBranches(
  cwd: string,
  entries: readonly CorumWorktreeEntry[],
): { branch: string; applied: boolean; base: string; patchBytes: number; error?: string }[] {
  return entries.map(entry => ({ branch: entry.branch, ...corumPortBranchDiff(cwd, entry) }))
}

export function corumIntegrationTruth(
  cwd: string,
  entries: readonly CorumWorktreeEntry[],
  dirtyBefore = '',
): CorumIntegrationTruth {
  // 2026-09-20：判定前补一次 tip 快照。分支在这一刻可能已被合规删除（集成者 merge 后
  // 自行 `branch -D`，或上一轮清理已删），此后它再也无法用分支名寻址——先把 sha 记下来，
  // 判定才有证据可用（见 `corumEntryIntegrated`）。
  corumSnapshotBranchTips(cwd, entries)
  const unmerged: string[] = []
  const uncommitted: string[] = []
  for (const entry of entries) {
    // 按条目判定（分支在场走 merge-base/cherry；分支已删走 tip 快照）——**不要**退回
    // 裸分支名。按分支名判会在「已合并 + 已合规删分支」时假阴，正是 2026-09-20 的机制 bug。
    if (!corumEntryIntegrated(cwd, entry)) unmerged.push(entry.branch)
    else if (corumWorktreeHasUncommitted(entry.path)) uncommitted.push(`${entry.slug} (${entry.path})`)
  }
  const beforeLines = dirtyBefore.split('\n').filter(line => line.trim() !== '')
  const before = new Set(beforeLines)
  const dirtyDelta = corumGitStatusPorcelain(cwd)
    .split('\n')
    .filter(line => line.trim() !== '' && !before.has(line))
  return {
    integrated: unmerged.length === 0,
    unmerged,
    uncommitted,
    dirtyDelta,
    // 主树**集成前就有的**未提交改动（与本次 fan-in 无关的在制品）。判据本身只看
    // 「分支有没有进 HEAD」，与主树脏不脏无关；这个计数只有一个用途：让报告能说清
    // 「本轮只对自己产出的 diff 负责」，而不是把既存脏读成「集成没落地」。
    dirtyBeforeCount: beforeLines.length,
    head: corumGitHead(cwd),
  }
}

/**
 * fork（corum）：主树既存未提交改动的提示行（集成报告共用；无则返回空数组）。
 *
 * 由来（2026-09-12 实机）：集成者把主树里**与本次无关的未提交在制品**当成了任务
 * 子 Agent 的工作，据此判「集成没落地」→ 整轮报失败（用户看到「集成失败」）。
 * 判据已改成「分支是否并入 HEAD」，但报告仍要说清两块 diff 的归属，否则同一个
 * 困惑会以另一种形式回来（「主树这些改动是谁的？」）。
 * @param truth - 集成真值（读 `dirtyBeforeCount` / `dirtyDelta`）。
 * @returns 报告行数组（可能为空）。
 */
export function corumDirtyOwnershipLines(truth: CorumIntegrationTruth): string[] {
  const lines: string[] = []
  if (truth.dirtyBeforeCount > 0) {
    lines.push(
      `main tree ALREADY had ${truth.dirtyBeforeCount} uncommitted path(s) before this integrate — unrelated work-in-progress, neither produced nor claimed by this round. The verdict above is about the pending BRANCHES only.`,
    )
  }
  if (truth.dirtyDelta.length > 0) {
    lines.push(
      `main tree ALSO gained ${truth.dirtyDelta.length} uncommitted path(s) during this round (e.g. ${truth.dirtyDelta.slice(0, 3).join(', ')}) — the integrator's own writes if it edited outside its worktree; they are NOT part of any branch commit unless committed.`,
    )
  }
  return lines
}

/**
 * fork（corum）：**部分集成**的结果说明——所有待集成分支都已并入 HEAD，但有个别
 * worktree 还留着未提交改动（写了没提交）。这些条目**不标 integrated、保留现场**，
 * 由主 Agent 决定补提交还是丢弃；其余条目正常翻转并（按需）清理。
 *
 * @param truth - 集成真值（`integrated === true` 时调用）。
 * @param headBefore - 集成前的主树 HEAD（报告里给前后对照）。
 * @returns 给主 Agent 的说明文本（含未持久化条目与路径）。
 */
export function corumPartialIntegrationNotice(
  truth: CorumIntegrationTruth,
  headBefore: string,
): string {
  const lines: string[] = [
    'integrate PARTIALLY persisted: every pending branch is now in the main tree, but some worktrees still hold UNCOMMITTED changes (written, never committed).',
    `main tree HEAD: ${headBefore === '' ? '(unknown)' : headBefore.slice(0, 12)} -> ${truth.head === '' ? '(unknown)' : truth.head.slice(0, 12)}`,
    `NOT integrated (kept pending, worktree + branch preserved): ${truth.uncommitted.join(', ')}`,
  ]
  if (truth.dirtyDelta.length > 0) {
    lines.push(`main tree also has ${truth.dirtyDelta.length} uncommitted path(s) not present before integrate (e.g. ${truth.dirtyDelta.slice(0, 3).join(', ')})`)
  }
  lines.push(...corumDirtyOwnershipLines(truth))
  lines.push('Next: commit (or discard) those leftovers in their worktrees, then call integrate again for them — or discard them explicitly.')
  return lines.join('\n')
}

/**
 * fork（corum）：集成未达标的失败报告——把「集成者自述 vs git 实况」一并交给主
 * Agent，并明确现场已保留（worktree/分支未清理，可继续修或人工合并）。
 *
 * 2026-09-20 修正（机制 bug）：「分支已被删除」**本身不是失败证据**。合并进 HEAD 之后
 * 删掉分支是机制自己鼓励的合规收尾（`corumCleanupWorktree` 就删），此时工作已经落地。
 * 判定已改为按条目（分支在场走 merge-base/cherry，分支已删走 tip 快照祖先关系）——
 * 所以本报告的 `unmerged` 名单现在只包含**确实没有证据表明进了 HEAD** 的条目：
 * 既没分支、也没 tip 快照可查（详见 `corumEntryIntegrated`）。这条文案据此改写，
 * 不再把「分支不存在」笼统说成「这份 commit 是唯一留存」。
 */
export function corumIntegrationFailure(
  truth: CorumIntegrationTruth,
  headBefore: string,
  entries: readonly CorumWorktreeEntry[],
  claim = '',
): string {
  const lines: string[] = [
    'integrate did not persist into the main tree — the mechanism checked git and the declared integration did not land.',
    `main tree HEAD: ${headBefore === '' ? '(unknown)' : headBefore.slice(0, 12)} -> ${truth.head === '' ? '(unknown)' : truth.head.slice(0, 12)}`,
  ]
  if (truth.unmerged.length > 0) {
    lines.push(`branches with NO evidence of being integrated into HEAD: ${truth.unmerged.join(', ')}`)
    lines.push('(a branch that was merged into HEAD and then deleted is NOT a failure — that is the sanctioned cleanup; these entries failed the check because neither a live branch nor a recorded tip proves their work is in HEAD)')
  }
  if (truth.uncommitted.length > 0) {
    lines.push(`worktrees with UNCOMMITTED changes (written but never committed): ${truth.uncommitted.join(', ')}`)
  }
  // 先把两块 diff 的归属说清，再给 delta——否则「主树有改动」会被读成本轮的锅
  // （2026-09-12 我本人踩过：主树是在制品，机制却报了「集成没落地」）。
  lines.push(...corumDirtyOwnershipLines(truth))
  lines.push('Worktrees and branches are PRESERVED — nothing was cleaned up. Merge them yourself (or re-run integrate) after fixing the failure.')
  lines.push(`Pending entries: ${entries.map(entry => `${entry.slug}@${entry.branch} -> ${entry.path}`).join('; ')}`)
  const trimmedClaim = claim.trim()
  if (trimmedClaim !== '') {
    lines.push(`Integrator's own report (NOT trusted as evidence):\n${trimmedClaim.slice(0, 2000)}`)
  }
  return lines.join('\n')
}

// ── 机制侧 verify 门禁（2026-09-16 根因修复）─────────────────────────────────

/**
 * fork（corum）：机制侧 verify 的默认超时（10 分钟）。
 *
 * 为什么必须有界：verify 是调用方声明的 shell 命令（`pnpm -r typecheck` 这类可以跑很久），
 * 但机制会**同步等它**；无界等待会把一次 orchestrate 挂死成「永远运行中」。超时判**失败**
 * （不是成功）：拿不到退出码 0 就不该签收，宁可让调用方看到「verify 超时」再决定。
 */
export const CORUM_INTEGRATE_VERIFY_TIMEOUT_MS = 600_000

/** 机制侧 verify 的单次执行结果（结构化，供报告与工具结果寻址）。 */
export interface CorumVerifyResult {
  /** 原样执行的命令（调用方声明的那条字符串）。 */
  readonly command: string
  /** 退出码 0 才算通过；超时/启动失败恒 false。 */
  readonly ok: boolean
  /** 进程退出码；超时或未能启动时为 -1。 */
  readonly code: number
  /** 是否因超时被杀（ok=false 的一个**具体**原因，与「命令自己失败」区分）。 */
  readonly timedOut: boolean
  /** stdout+stderr 尾部（截断；报告用，不做完整日志搬运）。 */
  readonly output: string
  /** 实际耗时（毫秒）。 */
  readonly durationMs: number
}

/**
 * fork（corum）：**集成被机制拒绝**的结构化错误（2026-09-16）。
 *
 * 为什么需要类型而不是一条 Error 文本：两种拒绝形态的**现状与出路完全不同**，调用方
 * 必须能分辨，否则会照着错误前提去修、或发出与事实不符的通知：
 *   · `'unmerged'` —— 分支**没进** HEAD（工作只存在于分支上）。出路：修合并/再集成；
 *     此时「分支未合并」的 pending 通知是**准确**的。
 *   · `'verify'`   —— 分支**已在** HEAD（集成者的合并提交本身就在主树里），但声明的
 *     验收没过。出路：修问题后再验，或显式丢弃。此时发「分支未合并」的通知是**错的**
 *     （`corumReconcileIntegrated` 下一次读台账就会按 git 实况把条目翻成 integrated，
 *     因为它判的是「工作进没进主树」，与验收与否是两个正交的轴）。
 *
 * 另外：`pendingBranches` 随错误携带，因为抛出后 `entriesOf` 会对账翻转那些条目，
 * 调用方**无法**再从台账还原「本次被拒的是哪几条」。
 */
export class CorumIntegrateRejected extends Error {
  /** 拒绝形态（决定调用方该发哪种通知、报告该怎么读）。 */
  readonly kind: 'unmerged' | 'verify'
  /** 给主 Agent 的完整报告文本（已含现状、出路、保留现场说明）。 */
  readonly notice: string
  /** 本次被拒的分支名（抛出时快照，不受后续台账对账影响）。 */
  readonly pendingBranches: readonly string[]
  constructor(kind: 'unmerged' | 'verify', notice: string, pendingBranches: readonly string[]) {
    super(notice)
    this.name = 'CorumIntegrateRejected'
    this.kind = kind
    this.notice = notice
    this.pendingBranches = pendingBranches
  }
}

/**
 * fork（corum）：**机制侧 verify 门禁** —— 机制自己跑调用方声明的 verify，取它的退出码。
 *
 * ## 为什么必须有（2026-09-16 根因修复，用户实测的「verify 失败居然没拦住」）
 *
 * 事故形态（会话 `corum-task-b7122dc0`，`/tmp/corum-bugb2`）：`merge.verify = test -f u1.md
 * && test -f u2.md && test -f zzz.md`（`zzz.md` 不存在）。集成者合并两个分支后**如实**跑了
 * verify、拿到 exit 1、按 persona 纪律**没有额外提交**——但 `git merge` 产生的**合并提交本身
 * 就是提交**：分支工作已经进了 HEAD，于是只判 git 实况的 {@link corumIntegrationTruth} 报
 * `integrated === true`，机制对外宣告「merged + committed into the main tree」——**verify 的
 * 失败被彻底忽略**。同样形态在会话 `corum-task-d0a24b08` 却被正确拦住，差别只在集成者那次
 * 恰好用了 `git merge --no-commit`（分支 tip 没进 HEAD，真值门禁兜住了）——**成败取决于子
 * Agent 偶然选了哪条 git 命令**，这正是红线「机制优先于提示词」禁止的形态：verify 是否被
 * 执行、退出码是否被检查，此前**完全托付给集成者的自觉**（persona 里那句 "commit only when
 * all pass"），机制侧没有任何断言。
 *
 * ⇒ 修法：机制自己跑一遍声明，**退出码非 0 即判集成未通过**（与真值门禁并列的第二道闸门）。
 * 命令在**主树**执行（合并后的真实状态才是 verify 的对象），经 shell 解释（声明是
 * shell 表达式，如 `a && b`，不能按 argv 拆词）。
 *
 * 边界：只跑**声明的**那条 verify。探测式 `corumDetectIntegrateChecks` 的结果仍是集成者的
 * 指令（「最低门槛」），不进机制门禁——它们可能是 `pnpm -r typecheck` 这种分钟级命令，机制
 * 强制跑会把一次编排的成本与超时风险都放大一档（契约见 dev-conventions「Declarative
 * verification」：声明的强制执行，探测的只是兜底）。
 *
 * @param cwd - 主树工作目录（verify 的执行目录）。
 * @param command - 调用方声明的 verify 原文。
 * @param timeoutMs - 超时上限（默认 {@link CORUM_INTEGRATE_VERIFY_TIMEOUT_MS}）。
 * @returns 结构化结果（**不抛**：门禁的失败也是一条要报给调用方的事实）。
 */
export function corumRunIntegrateVerify(
  cwd: string,
  command: string,
  timeoutMs: number = CORUM_INTEGRATE_VERIFY_TIMEOUT_MS,
): CorumVerifyResult {
  const started = Date.now()
  const run = (file: string, args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(file, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' },
    })
  // 平台 shell 口径与工具面一致：win32 是 pwsh（corum preset 装载的 shell），POSIX 是 bash
  // （`bash` 工具同款）；bash 缺失的镜像（精简容器）回落 POSIX `sh`。
  let result = process.platform === 'win32'
    ? run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command])
    : run('bash', ['-c', command])
  if (process.platform !== 'win32' && (result.error as { code?: string } | undefined)?.code === 'ENOENT') {
    result = run('sh', ['-c', command])
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const merged = [stdout, stderr].filter(part => part.trim() !== '').join('\n').trim()
  // 超时判定：spawnSync 把超时收成 error.code='ETIMEDOUT' 并杀掉子进程（此时 status 为 null、
  // signal 为 SIGTERM）。「启动失败」（ENOENT 等）同样是 status=null，但 error 是另一种码——
  // 故不按「status 为空」泛判，避免把「shell 不存在」误报成超时。
  const errorCode = (result.error as { code?: string } | undefined)?.code
  const timedOut = errorCode === 'ETIMEDOUT'
    || (errorCode === undefined && result.status === null && result.signal !== null && result.signal !== undefined)
  const code = typeof result.status === 'number' ? result.status : -1
  return {
    command,
    ok: code === 0,
    code,
    timedOut,
    output: merged.length > 4000 ? `…(truncated)\n${merged.slice(-4000)}` : merged,
    durationMs: Date.now() - started,
  }
}

/**
 * fork（corum）：**集成总判定** —— git 实况 **与** 声明式 verify **都**通过才算集成成功。
 *
 * 单一入口的理由：这两道闸门曾各自为政（真值门禁只判 git，verify 只写在 persona 里），
 * 于是「分支进了 HEAD 但 verify 失败」的形态被判成成功（2026-09-16 事故，见
 * {@link corumRunIntegrateVerify}）。把「成功」收成一个函数，任何调用方都无法只取一半。
 *
 * @param cwd - 主树工作目录。
 * @param entries - 待集成的台账条目。
 * @param dirtyBefore - 集成前的 `git status --porcelain` 原文（dirtyDelta 基线）。
 * @param declared - 调用方声明的 verify；缺省 = 无声明式闸门（探测式检查不进机制）。
 * @param timeoutMs - verify 超时上限。
 * @returns 真值 + verify 结果 + 合取后的 `integrated`。
 */
export function corumIntegrationVerdict(
  cwd: string,
  entries: readonly CorumWorktreeEntry[],
  dirtyBefore: string,
  declared: string | undefined,
  timeoutMs?: number,
): { truth: CorumIntegrationTruth; verify?: CorumVerifyResult; integrated: boolean } {
  const truth = corumIntegrationTruth(cwd, entries, dirtyBefore)
  // 真值没过就不必跑 verify：主树还没到「该验收」的状态，跑它是误导性的额外成本。
  if (!truth.integrated) return { truth, integrated: false }
  if (declared === undefined || declared.trim() === '') return { truth, integrated: true }
  const verify = corumRunIntegrateVerify(cwd, declared, timeoutMs)
  return { truth, verify, integrated: verify.ok }
}

/**
 * fork（corum）：**被拒集成后的现场解卡**（2026-09-16 实机补）。
 *
 * ## 为什么必须有
 *
 * 门禁把 persona 改成「先 `git merge --no-commit` 合、验完再提交」以后（为了消掉「合并即提交」
 * 让 verify 失败被盖过的那条路），verify 失败被拒时主树会**停在一个未结清的合并现场**：
 * `MERGE_HEAD` 存在 ⇒ 后续**每一次** merge/commit 都被 git 拒绝
 * （`fatal: You have not concluded your merge`），包括下一轮 orchestrate 的集成者与 turn-end
 * 收口。实测（`corum-task-78da6133`）：那一轮的 `integration.error` 里因此同时出现
 * 「分支未进 HEAD」与「A u1.md」两条证据——工作区被半合的暂存态污染了。
 *
 * ## 为什么放弃合并是安全的
 *
 * 被拒的分支**从未被删除**（门禁纪律：失败保留现场），其提交仍在分支上、是工作的唯一副本；
 * `git merge --abort` 只回退**本次合并**引入的暂存/工作区改动，不碰合并前的在制品
 * （与 persona 明禁的 `reset --hard` / `checkout .` / `clean -fd` / `stash` 语义不同）。
 * ⇒ 解卡不丢工作，只把「半合进去但没提交」还原成「干净可继续」。
 *
 * 只在**被拒**时调用；调用方把返回的原因写进日志（解卡失败不掩盖原始失败，只多一行 fact）。
 * @param cwd - 主树工作目录。
 * @returns `undefined` = 无需解卡或解卡成功；否则为失败原因（调用方记日志，不抛）。
 */
export function corumResolveRejectedIntegration(cwd: string): string | undefined {
  if (!gitCoreMergeInProgress(cwd)) return undefined
  const failure = gitCoreAbortMerge(cwd)
  return failure === undefined ? undefined : failure.reason
}

/**
 * fork（corum）：**声明式 verify 拒绝集成**的报告（2026-09-16 根因修复配套）。
 *
 * 与 {@link corumIntegrationFailure} 并列的第二种失败形态——两者必须说清区别，
 * 否则主 Agent 会照着错误的前提去修。关键差异：真值失败 = 「分支还没进 HEAD」（工作只存在
 * 于分支上，**现场与分支都必须保留**，那是唯一副本）；verify 失败 = 「分支**已经**进了 HEAD，
 * 但声明的验收没过」——工作**没有丢**（合并提交就在主树历史里），机制**不**替调用方回滚历史。
 *
 * ⚠️ **不能承诺「现场已保留」**（2026-09-16 实机纠正）：本形态下分支已并入 HEAD，于是台账
 * 对账（`corumReconcileIntegrated`）与安全清理会**正常回收** worktree + 分支（清理安全阀
 * 只保护「未并入 HEAD」的分支——这里恰好不满足）。实机（`corum-task-4e821e74`）观测到：
 * 报告写着 PRESERVED，而 `git branch` 已只剩 main。⇒ 报告如实说清「工作已进历史、现场可能
 * 已回收」，出路给「在**主树**里修 + 重跑 verify」，而不是「重跑 integrate」（那会因为
 * 没有 pending 条目而短路）。
 * @param verify - 机制跑出来的 verify 结果（命令/退出码/输出/耗时）。
 * @param truth - 集成真值（取 HEAD 前后对照）。
 * @param headBefore - 集成前的主树 HEAD。
 * @param entries - 被拒的台账条目（报告里给 slug@branch -> path 供溯源）。
 */
export function corumVerifyFailureNotice(
  verify: CorumVerifyResult,
  truth: CorumIntegrationTruth,
  headBefore: string,
  entries: readonly CorumWorktreeEntry[],
): string {
  const lines: string[] = [
    'integrate REJECTED by the declared verification — every pending branch IS in the main tree, but the verification you declared did not pass.',
    `declared verify: ${verify.command}`,
    `exit code: ${verify.code}${verify.timedOut ? ` (KILLED after ${CORUM_INTEGRATE_VERIFY_TIMEOUT_MS / 1000}s timeout — no exit code was produced)` : ''} · took ${verify.durationMs}ms`,
    `main tree HEAD: ${headBefore === '' ? '(unknown)' : headBefore.slice(0, 12)} -> ${truth.head === '' ? '(unknown)' : truth.head.slice(0, 12)}`,
  ]
  if (verify.output !== '') lines.push(`verify output (tail):\n${verify.output}`)
  lines.push(
    'This is NOT the same failure as "branches did not land": their merge commits ARE in HEAD, so the WORK IS NOT LOST and the mechanism does NOT rewrite main-tree history to undo it.',
    // 2026-09-16 实机纠正（corum-task-4e821e74）：此前这里写「Worktrees and branches are
    // PRESERVED」——**与事实不符**。本形态下分支已并入 HEAD，台账对账 + 安全清理会正常回收
    // worktree/分支（安全阀只保护「未并入 HEAD」的分支，这里恰好不满足），实测报告说保留、
    // 而 `git branch` 已只剩 main。报告的每一句都要能在现场复核，故如实写。
    'The integration is NOT accepted. The isolated worktrees/branches may already be RECLAIMED (their commits are in the main tree, so the branch copy is redundant and nothing is lost by that) — do not expect to re-run `integrate` for them.',
    'Next: fix the cause IN THE MAIN TREE and run the verification again yourself, then commit with `git commit` (the mechanism does not re-verify a round it already rejected).',
    `Entries this verdict was about: ${entries.map(entry => `${entry.slug}@${entry.branch} -> ${entry.path}`).join('; ')}`,
  )
  return lines.join('\n')
}

/**
 * fork（corum）：探测式默认 integrateChecks——按父 cwd 仓库形态生成核查命令。
 * 显式 config（preset 的 integrateChecks）恒优先，本函数不参与。
 */
export function corumDetectIntegrateChecks(cwd: string): string[] {
  if (existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) return ['pnpm -r typecheck']
  try {
    const pkgPath = path.join(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
      if (typeof pkg.scripts?.typecheck === 'string') return ['npm run typecheck']
      if (typeof pkg.scripts?.test === 'string') return ['npm test']
    }
  } catch {
    // package.json 不可读/坏 JSON → 落保守兜底。
  }
  return ['git diff --check']
}

/**
 * fork（corum）：integrate 召唤的集成者 persona（机制拼装，非 LLM 自由写）。
 * 声明式验证语义（2026-09-08 定调）：declared 原样注入并强制执行，功能性验收
 * 由主 Agent 基于原始目标最终裁决；探测式默认仅作未声明时的兜底。
 */
export function corumIntegratorPersona(
  entries: CorumWorktreeEntry[],
  checks: string[],
  merger: 'parent' | 'merger' = 'parent',
  declared?: string,
): string {
  const branches = entries.map(entry => `- ${entry.branch} (worktree: ${entry.path})`).join('\n')
  const checkLines = checks.length > 0
    ? checks.map(check => `- ${check}`).join('\n')
    : '- git diff --check'
  const declaredBlock = declared !== undefined && declared.trim() !== ''
    ? `\nHow to build, run, and verify this repository (declared by the delegating agent — follow it exactly):\n${declared.trim()}\n`
    : '\nThe delegating agent did not declare how to build or verify this repository: run the checks below and treat them as the minimum bar only.\n'
  return 'You are the integration manager. Merge the branches listed below into the main working tree IN ORDER. Branches:\n'
    + branches
    + declaredBlock
    + '\nChecks (run every one; commit only when all pass):\n'
    + checkLines
    + '\nIf any check or declared verification step fails, report and leave the tree dirty — do NOT commit.\n'
    + '\nIf you leave the tree with an UNCONCLUDED merge (e.g. you merged with `--no-commit` and then the verification failed), say so explicitly and finish it (`git merge --abort` if the merge should not land): a lingering `MERGE_HEAD` makes every later merge/commit in this tree fail.\n'
    + '\nNever run destructive git commands on the main tree (git reset --hard, git checkout ., git clean -fd, git stash): it may contain unrelated uncommitted work that is not yours to discard. If the tree is dirty in a way that blocks the merge, report it instead of wiping it.\n'
    + 'The mechanism independently verifies afterwards that every listed branch really landed in HEAD AND re-runs the declared verification itself; a report that does not match git will be rejected.\n'
    + (merger === 'merger'
      ? 'You are a dedicated integration specialist: after completing the merge and verification, report a per-branch summary (merged/conflicts/verification results) as your final answer.'
      : 'Report the integration outcome (merge result, verification output, and anything that looks off) so the delegating agent can make the final acceptance call against the original goal.')
}

/**
 * fork（corum）：**隔离边界说明行**——给**父 Agent** 看的一行事实（用户 2026-09-13 定调「先做可见性」）。
 *
 * 由来：`subagent` 工具没有按次 isolation 开关，缺省策略（write-tasks）下**单发前台写任务
 * 直接在主工作区改**（无 worktree、无分支）。这件事此前只写在**给子 Agent 的提示词**里
 * （{@link corumDirectWriteNotice}），父 Agent 拿到结果时看不出边界——2026-09-12 的探针
 * 就是这么被骗的：用户要求「派一个前台隔离子 Agent」，机制按口径没隔离，而父侧从结果里
 * 读不出「其实没隔离」。
 *
 * 本函数只产出**一句事实**，不改任何机制语义（隔离判据仍在 `corumShouldIsolate`）。
 * 纯函数，可单测；渲染方按平台无关的英文写（本仓提示词/工具结果纪律）。
 *
 * @param boundary - 本次委派的隔离落点：`worktree`（隔离，带分支）/ `skipped-non-git`
 *   （非 git 工作区导致隔离被跳过）。
 *
 * **2026-09-16 不变式⑤**：`'parent-tree'` 这一档已**删除**——凡写委派恒隔离，git 工作区下
 * 不存在「写委派直落父树」的形态。唯一「没隔离」的落点是**非 git 工作区**的自动降级
 * （worktree 建不出来），故枚举收窄为两档，让不可达状态在类型上就不可表示。
 * @param branch - `worktree` 时的分支名（缺省时只报「已隔离」）。
 * @returns 一行说明。**2026-09-18：两档都必须报**（此前调用方对 `worktree` 「可选择性省略」，
 *   实际就是省略掉了——而那一档恰恰是唯一需要模型采取动作的情形，见下方 `worktree` 分支文本）。
 */
export function corumIsolationBoundaryNotice(
  boundary: 'worktree' | 'skipped-non-git' | 'main-requested',
  branch?: string,
): string {
  if (boundary === 'worktree') {
    // 2026-09-18：这句必须**点明动作**（`subagent { integrate: true }`），不能只说 "through
    // integrate"——实测（作者本场会话）模型没收到任何提示时手工 cherry-pick 收尾，机制台账
    // 因此从未翻成 integrated、autoCleanup 没跑，worktrees 堆到 2.4GB/13 个。孤立分支上
    // 的提交是那份工作的**唯一副本**，且 verify/集成门禁只在 integrate 路径上生效 ⇒
    // 让模型记住「还要 integrate」是这条提示的全部意义。
    return `[corum isolation] this delegation ran in an ISOLATED worktree${branch === undefined || branch === '' ? '' : ` (branch ${branch})`} — its commits exist ONLY on that branch and are NOT in your working tree yet. `
      + 'You MUST finish it yourself with `subagent { integrate: true }` (merge + verify + commit); until you do, the work is invisible to everything else and the worktree is never reclaimed. Do not merge or cherry-pick the branch by hand — that bypasses the verify gate and leaves the mechanism ledger stale.'
  }
  if (boundary === 'main-requested') {
    // fork（corum）2026-09-27（用户裁定 A）：`isolation: 'main'` 那一档。刻意与「非 git 降级」
    // 分开写：两者都「没隔离」，但**原因与后果不同**——降级是环境所致（worktree 建不出来），
    // 本档是调用方自己的选择（跨仓 / 主树落盘 / 合并）。措辞要让父 Agent 立刻明白两件事：
    // ① 没有分支要合并（别再去 integrate）；② 产物已经在自己的树里，**在它上面继续动手之前
    // 先看一眼**（并发写没有壳保护）。
    return '[corum isolation] this delegation ran DIRECTLY IN YOUR MAIN WORKING TREE because you asked for it (`isolation: "main"`): there is no branch and nothing to merge — its edits are ALREADY in your tree, so read them before building on them. The worktree shell exists to keep concurrent writers from colliding: use the default isolated route unless the task really needs main-tree or cross-repository writes.'
  }
  return '[corum isolation] this delegation ran in the PARENT working tree (not isolated): the workspace is not a git repository, so isolation was skipped — its edits are ALREADY in your tree and nothing will merge them.'
}

// ── 编排器 service（台账状态下沉；红线 1 合规）──────────────────────────────

/**
 * fork（corum）：编排器 service——持有会话级隔离台账（实例字段，非模块级单例），
 * 提供台账登记/结算/清理/帧发射。继承 cordis `Service`（`super(ctx, name)` 自动
 * provide + 随 owning fiber 注销）。挂载到**根上下文**（跨会话/跨 bundle 单例，
 * 红线 1 合规）；消费方经 `ctx.root.get('corumOrchestration')` 读取。
 */
/** fork（corum）：隔离 worktree 子会话的创建选项（工具层与 isolated provider 共用）。 */
export interface CorumWorktreeChildOptions {
  /** worktree 根目录（相对父 cwd 或绝对路径，默认 `.corum-worktrees`）。 */
  worktreeRoot?: string
  /** 分支名前缀（默认 `wt/`）。 */
  branchPrefix?: string
  /** 并发上限（默认 4；达到即抛错，调用方提示模型等待或先集成）。 */
  maxParallelChildren?: number
}

/** fork（corum）：已创建的隔离子会话三件套。 */
export interface CorumWorktreeChild {
  readonly slug: string
  readonly branch: string
  readonly path: string
}

/**
 * fork（corum）：隔离子 Agent 的 prompt 前缀（单一事实源——工具层与 isolated
 * provider 必须给子 Agent 同一套纪律：相对路径、父树只读、在分支内提交）。
 * @param entry - 已创建的 worktree 条目（只取 branch）。
 * @returns 注入到子 Agent prompt 最前面的通知文本（含尾随空行）。
 */
export function corumIsolationNotice(entry: Pick<CorumWorktreeChild, 'branch'>): string {
  return `[corum isolation] You are working inside an isolated git worktree (branch ${entry.branch}). Your working directory IS the worktree root; address every file by RELATIVE path only. The parent working tree outside this worktree is write-denied by the sandbox (reads are still allowed for reference). Commit your changes on branch ${entry.branch} inside this worktree; do not attempt to write outside it.\n\n`
}

/**
 * fork（corum）：非隔离写委托的 prompt 前缀（主工作区直连时禁止 git 操作——父 Agent
 * 可能留有未提交的无关改动，子 Agent 一句 `git add -A` 会把它一起卷进提交）。
 *
 * **2026-09-16 不变式⑤后仍保留**：凡写委派恒隔离 ⇒ 工具层的「单发前台直写」路径已消失，
 * 但本通知仍有两个**真实**消费方，且都不是逃生口：
 *  ① `corum-isolated` provider 的 **`track` 模式**（ralph 等顺序迭代——独立模式，
 *     不建 worktree 是因为必须看到上一轮改动）；
 *  ② 工具层的**非 git 工作区降级**（worktree 建不出来，只能就地写）。
 * 文案因此不再声称「没有并发写任务」（那已不是本通知的语义，见旧文本），只陈述纪律本身。
 * @returns 注入到子 Agent prompt 最前面的通知文本（含尾随空行）。
 */
export type CorumDirectWriteReason = 'caller-requested-main' | 'skipped-non-git' | 'sequential-iteration'

export function corumDirectWriteNotice(reason: CorumDirectWriteReason = 'skipped-non-git'): string {
  const cause = reason === 'caller-requested-main' ? 'the delegating agent explicitly asked for the main tree (`isolation: "main"`) because the work needs it' : reason === 'skipped-non-git' ? 'this workspace is not a git repository, so isolation was skipped' : 'this run is a sequential-iteration mode that must see the previous round\'s changes'
  const gitRule = reason === 'caller-requested-main' ? 'Version control IS available to you here: when the brief asks for a commit, a merge or a `git push`, do it.' : 'Leave version control to the delegating agent: do NOT run `git add` / `commit` / `checkout` / `stash` / `reset`, and do not create branches.'
  return '[corum orchestration] This delegation works DIRECTLY in the delegating agent\'s working tree (no isolated worktree), because ' + cause + '.\n\n'
    + 'Consequences:\n'
    + '- Dependencies may already be installed, and a build or an install the brief asks for IS part of your work: the isolated-worktree premises ("no dependencies", "do not build") do NOT apply to you.\n'
    + '- Edit files in place; there is no branch and nothing to merge.\n'
    + '- ' + gitRule + '\n\n'
}

export class CorumOrchestration extends Service {
  /** 会话级隔离台账（key=父 session id）。service 实例字段，非模块级单例。 */
  private readonly ledger = new Map<string, CorumWorktreeEntry[]>()
  /** 台账 session → 父会话 cwd（dispose 清理时定位 git 主干）。 */
  private readonly ledgerCwds = new Map<string, string>()
  /**
   * 收口时**强制提交失败**的暂存（key=父 session id）。
   *
   * 为什么用实例字段而不是返回值：`settleFromEnd` 在 `subagent/end` 监听里被调用，
   * 而 emitter 的 **per-listener 容错会吞掉抛错** ⇒ 失败无法靠 throw 抵达模型。
   * 故 settle 暂存、调用方经 {@link drainSettleCommitFailures} 取走并以 notice 投递给模型。
   */
  private readonly commitFailures = new Map<string, CorumSettleCommitFailure[]>()
  /**
   * 会话级**临时子 Agent 模型覆盖**（key = `<父 session id> <worker|research>`）。
   *
   * fork（corum）2026-09-19：key 从裸 sessionId 升级为「sessionId + 角色后缀」——
   * corum preset 里 tool-subagent 是**双实例**（worker + research，见
   * corum-agent/compile.ts），两个实例各有自己的 `config.model` 锁面；补偿/临时改
   * 模型必须能按角色分别落地，否则改 research 锁面会连 worker 一起被覆盖。
   * key 用 **空格** 做分隔符：sessionId 由官方 agent-loop 生成（`…-session-` +
   * `randomUUID()`，dsh-agent-loop lib/index.ts:428），恒不含空格 ⇒ 分隔是单射的。
   *
   * 用户选了「临时改用主 Agent 模型」后落在这里：后续本会话的子 Agent 一律用该路由，
   * 但**绝不写入 settings.yaml / 预设**（用户原话「临时生效，不覆盖用户的设置，即用户
   * 新建对话，如果用户还配置了原来不可用的大模型，仍然会调用失败」）。同样只存内存。
   *
   * ⚠️ 2026-10-11 三档语义：值域含 `'follow-main'` 哨兵（预设/会话显式选了「跟随
   * 主 Agent」）。它**不是路由**——消费方（corum-tool-subagent）必须把它当成「跳过
   * 全局兜底档」，而不是拿去当 provider 名。见 `corum-agent/profile.ts` 的 `FOLLOW_MAIN`。
   */
  private readonly modelOverrides = new Map<string, { provider: string; model: string; reasoningEffort?: string } | 'follow-main'>()
  /**
   * 已就哪些分支发过「待集成」通知（key = `sessionId + '\u0000' + branch`）。
   *
   * 为什么需要（2026-09-18，修掉早退后暴露）：`corum-tool-subagent` 在 corum preset 里是
   * **双实例**（worker + research，见 corum-agent/compile.ts），两个实例各自 `apply()`、
   * 各自注册一个 `{global:true}` 的 `subagent/end` 监听 ⇒ 同一个 settle 事件被处理**两次**。
   * `takeChildSpawn` / `drainSettleCommitFailures` 都是「取走即删」故天然只生效一次；
   * 而「待集成」通知是**纯读**（`entriesOf` 不消费状态）⇒ 两个实例各发一条一模一样的通知
   * （实机：同一会话 seq 24 与 25 内容逐字相同）。这里用「认领」语义去重。
   *
   * 住 service 实例字段而非模块级（红线 1）：两个实例共享同一个 `corumOrchestration`。
   * 只存内存：分支被集成/丢弃后不再需要记住。
   */
  private readonly pendingNotified = new Set<string>()
  /** Phase 4：持久化 domain 句柄（storageDomain 缺失时为 undefined，回落纯内存）。 */
  private readonly domainPromise: Promise<Domain<typeof corumOrchestrationDomainSpec>> | undefined

  constructor(ctx: Context) {
    super(ctx, 'corumOrchestration')
    // fork（corum）：Phase 4 台账持久化（§11.9 决策项①落盘）。storageDomain 是
    // 根上下文服务，缺失时（单测/未装配）回落纯内存，行为与下沉前一致。
    const storageDomain = ctx.get('storageDomain')
    if (storageDomain === undefined) {
      this.domainPromise = undefined
      return
    }
    this.domainPromise = storageDomain.open(corumOrchestrationDomainSpec)
    // 恢复 + 关闭句柄（随 owning fiber）。
    void this.domainPromise.then((domain) => {
      this.ctx.effect(() => () => { void domain.close() }, 'corumOrchestration.domainClose')
      // 启动恢复：重建台账（仅 active/settled 待集成条目——孤儿 worktree 识别）。
      for (const [sessionId, record] of domain.table('ledger').entries()) {
        // 存量修补：childSessionId 与 runId 同值（见 CorumWorktreeEntry 注释），但
        // 2026-09-12 之前的结算回退路径只写了 runId → 恢复后的条目在浮层里是**死行**
        // （「并行工作区」行的可点性只看 childSessionId）。这里就地补齐，不改动语义。
        this.ledger.set(sessionId, corumReapRestoredEntries(record.cwd, record.entries.map(e => e.childSessionId !== undefined || e.runId === undefined
          ? { ...e }
          : { ...e, childSessionId: e.runId })))
        this.ledgerCwds.set(sessionId, record.cwd)
        this.persist(sessionId)
      }
      // 台账之外的孤儿 worktree 也清一遍（台账记录会因「无待集成条目」被删掉，那些
      // worktree 就再没有任何记录引用；实测本仓 10 个纯空目录属于这一类）。
      for (const cwd of new Set(this.ledgerCwds.values())) {
        const keep = new Set<string>()
        for (const entries of this.ledger.values()) for (const entry of entries) keep.add(entry.path)
        const reaped = corumReapOrphanWorktrees(cwd, keep)
        if (reaped > 0) this.ctx.logger.info(`corumOrchestration: 启动清扫回收 ${reaped} 个孤儿 worktree（${cwd}）`)
      }
    }).catch((error: unknown) => {
      this.ctx.logger.error(`corumOrchestration: open domain failed: ${String(error)}`)
    })
  }

  /** Phase 4：台账变更后异步落盘（fire-and-forget；domain 未就绪/缺失时静默跳过）。 */
  private persist(sessionId: string): void {
    if (this.domainPromise === undefined) return
    void this.domainPromise.then(async (domain) => {
      const entries = this.ledger.get(sessionId)
      const cwd = this.ledgerCwds.get(sessionId)
      // 落盘待集成条目 + **最近 N 条终态记录**。
      //
      // 2026-09-12 修正（用户实测「隔离那一栏整段消失」）：旧实现只落 active/settled，
      // 现场一回收记录就没了 → 「并行工作区」栏（含 已集成/已丢弃 分类）随之消失，
      // 重启后也回不来。终态记录是那一栏的历史与分类来源，必须留下；
      // 用 CORUM_LEDGER_TERMINAL_KEEP 限制条数以免无限增长。
      const pending = entries?.filter(e => !isTerminalEntry(e)) ?? []
      const terminal = (entries?.filter(isTerminalEntry) ?? []).slice(-CORUM_LEDGER_TERMINAL_KEEP)
      const kept = [...pending, ...terminal]
      if (kept.length === 0 || cwd === undefined) {
        await domain.table('ledger').delete(sessionId)
        return
      }
      await domain.table('ledger').put(sessionId, { cwd, entries: kept.map(e => ({ ...e })) })
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`corumOrchestration: persist ledger failed: ${String(error)}`)
    })
  }

  /**
   * 认账「已并入 HEAD 的分支」并**顺带安全回收其现场**（不发帧、不落盘、**不剔除死条目**
   * ——死条目的清除时机仍是 `entriesOf` 的懒清除，有单测钉住）。
   *
   * 两个入口都必须走这里：`entriesOf`（工具层查询）与 `emitFrame`（UI 帧）。只在
   * `entriesOf` 里对账的话，帧由 `addActiveEntry`/`markSettled` 等事件直接发射，照旧把
   * 已被子 Agent 合并掉的分支显示成「待集成」（2026-09-12 用户实测的卡片说谎）。
   * 顺带挡住一个反向坑：新建 worktree 的分支 tip === HEAD，若不设防就会在
   * `addActiveEntry` 那一刻被 `--merged` 误判成已集成。
   *
   * 回收（用户实测的第二半：分支早就在 main 上，worktree 却永远留着）只针对**翻之前
   * 就已 settle** 的条目——active 的子 Agent 可能还在那个目录里干活，拔掉目录会让它
   * 后续每次工具调用都失败。且一律走**安全清理**（`force:false`）：worktree 有未提交
   * 改动就保留目录（那是唯一留存），分支未并入 HEAD 就保留分支。状态保持 `integrated`
   * （工作确已进 main），不标 `discarded`（那在 UI 上显示成「已丢弃」，是谎）。
   *
   * @param sessionId - 父会话 id（台账键）。
   * @param entries - 台账条目（可能已剔除死条目；**不得就地修改**）。
   * @returns 对账后的条目 + 是否发生翻转（未翻转时原样返回入参引用）。
   */
  private reconcileAndReclaim(
    sessionId: string,
    entries: readonly CorumWorktreeEntry[],
  ): { entries: readonly CorumWorktreeEntry[]; flipped: boolean } {
    const cwd = this.ledgerCwds.get(sessionId)
    if (cwd === undefined || entries.length === 0) return { entries, flipped: false }
    const wasSettled = new Set(entries.filter(e => e.status === 'settled').map(e => e.slug))
    const reconciled = corumReconcileIntegrated(cwd, entries)
    if (reconciled.flipped.length === 0) return { entries, flipped: false }
    for (const entry of reconciled.entries) {
      if (entry.status !== 'integrated' || !wasSettled.has(entry.slug)) continue
      // 完整回收成功才标 reclaimed（安全清理可能保留脏 worktree / 未并分支）。
      if (corumCleanupWorktree(cwd, entry, { force: false })) entry.reclaimed = true
    }
    return { entries: reconciled.entries, flipped: true }
  }

  /**
   * 读某会话台账条目（不存在返回空数组，不自动建）。
   *
   * 2026-09-09：顺带剔除**彻底失效**的条目（worktree 与分支都不存在）——旧强删清理
   * 遗留的 active 条目会永久占用 `maxParallelChildren` 额度（实证：本仓
   * `corum-task-7cebf463` 的 3 条死条目使后续 spawn 只剩 1 个名额）。剔除后落盘。
   * 2026-09-12：再叠加 git 实况对账（`corumReconcileIntegrated`）——分支可能已被
   * **主 Agent 派子 Agent 合并掉**，机制必须认账。
   */
  entriesOf(sessionId: string): CorumWorktreeEntry[] {
    const entries = this.ledger.get(sessionId) ?? []
    const cwd = this.ledgerCwds.get(sessionId)
    if (cwd === undefined || entries.length === 0) return entries
    // 死条目的剔除只针对**待集成**条目（active/settled 占并发额度、且已无法集成）；
    // 终态记录（integrated/discarded）即使现场已回收也留着——那是「并行工作区」栏的
    // 历史与分类（见 persist 的说明）。
    const alive = entries.filter(entry => isTerminalEntry(entry) || !corumEntryDead(cwd, entry))
    const reconciled = this.reconcileAndReclaim(sessionId, alive)
    if (alive.length === entries.length && !reconciled.flipped) return entries
    const next = [...reconciled.entries]
    this.ledger.set(sessionId, next)
    this.persist(sessionId)
    if (reconciled.flipped) this.emitFrame(sessionId)
    return next
  }

  /** 登记一条 active 条目并记录父 cwd（worktree 创建成功后调用）。 */
  addActiveEntry(sessionId: string, cwd: string, entry: Omit<CorumWorktreeEntry, 'status'>): void {
    const entries = this.ledger.get(sessionId) ?? []
    entries.push({ ...entry, status: 'active' })
    this.ledger.set(sessionId, entries)
    this.ledgerCwds.set(sessionId, cwd)
    this.persist(sessionId)
    this.emitFrame(sessionId)
  }

  /**
   * fork（corum）：为一个委托创建隔离 worktree 子会话（工具层与 isolated provider 共用）。
   *
   * 步骤与失败语义（与工具层原实现逐条等价）：
   *   ① 并发上限：active 条目 ≥ maxParallelChildren 即抛错（调用方提示模型等待/先集成）；
   *   ② `git worktree add <path> -b <branch>`；失败时回滚半成品 worktree 再抛；
   *   ③ 登记 active 台账条目（run id 待 spawn 后 `bindRunId` 绑定）。
   * @param sessionId - 父会话 id（台账键）。
   * @param parentCwd - 父会话工作目录（worktree 根与 git 操作基准）。
   * @param options - worktree 根/分支前缀/并发上限。
   * @returns 新建的隔离子会话三件套（slug/branch/path）。
   */
  createWorktreeChild(
    sessionId: string,
    parentCwd: string,
    options: CorumWorktreeChildOptions = {},
  ): CorumWorktreeChild {
    const maxParallel = options.maxParallelChildren ?? 4
    const entries = this.entriesOf(sessionId)
    if (entries.filter(entry => entry.status === 'active').length >= maxParallel) {
      throw new Error('parallel child limit reached; wait for one to settle or integrate first')
    }
    const slug = `wt-${randomBytes(3).toString('hex')}`
    const root = path.resolve(parentCwd, options.worktreeRoot ?? '.corum-worktrees')
    const branch = `${options.branchPrefix ?? 'wt/'}${slug}`
    const worktreePath = path.join(root, slug)
    // ── 不变式⑤的两条配套（2026-09-16）───────────────────────────────────────
    // 隔离改为「写委派恒隔离」后，**每一次**写委派都要走到下面这道 `corumDirtyParentRefusal`
    // 严格门（任何 porcelain 行含 untracked 都拦）。不加配套会直接阻断两条常见工作流：
    //
    // 配套①：**建 worktree 前先自动提交父树**。
    //   主 Agent 在**同一 turn 内**改完代码（write/edit/bash）再派写子 Agent 是极常见序列，
    //   而 turn-end 强制提交（`settleCommitOnTurnEnd`）只在 turn **结束**时触发 ⇒ 那一刻父树
    //   是脏的 ⇒ 门必然拒绝 ⇒ 委派失败。机制自己把父树收口提交掉，语义与不变式②（每次修改
    //   完毕必须提交）一致，且比「turn 结束才提交」更早、更贴合「子从 HEAD 建分支」的前提。
    //   提交信息可识别（`wip(corum): auto-commit before isolation`），不冒充 Agent 的提交。
    //
    // 配套②：**保证 `.corum-worktrees/` 已被 ignore**。
    //   `ensureWorktreeGitignore` 原先只在 `initRepo` 调用 ⇒ 只对「corum 自己 init 的仓库」
    //   生效。用户**既有**仓库缺这一行时，第一个 worktree 建好后 `.corum-worktrees/` 会以
    //   `?? .corum-worktrees/` 判脏 ⇒ **下一个委派必被拒**（实测复现）。这里在建目录前补齐，
    //   于是上面那次收口提交会把它一并提交掉（自身不留未提交改动）。
    const gitignoreChanged = gitCoreEnsureWorktreeGitignore(parentCwd)
    // 收口提交：父树有未提交改动（含我们刚写的 ignore 行）时先提交掉；干净则跳过。
    // 放在严格门**之前**，让「主 Agent 改完代码立刻派活」这一常见序列不会被自家门拒掉。
    const settled = corumDirtyParentRefusal(parentCwd) === undefined
      ? undefined
      : gitCoreSettleCommit(
          parentCwd,
          'wip(corum): auto-commit before isolation'
            + '\n\nThe mechanism committed the parent tree before creating an isolated worktree:'
            + ' an isolated child branches off HEAD, so uncommitted parent work would be invisible to it.',
        )
    if (settled !== undefined) {
      // 收口失败（git 身份/钩子等）→ 不静默，但也不掩盖下面那道门的原始拒绝原因。
      this.ctx.logger.warn(`isolation pre-commit failed for ${parentCwd}: ${settled.reason}`)
    } else if (gitignoreChanged) {
      // 父树本就干净、只有我们刚写的 ignore 行：单独提交它，避免它自己成为未提交改动
      // 而被**下一次**派遣判脏（正是「第二个委派必被拒」那个缺口）。
      const ignoreSettled = gitCoreSettleCommit(parentCwd, 'chore(corum): ignore .corum-worktrees/')
      if (ignoreSettled !== undefined) {
        this.ctx.logger.warn(`could not commit .corum-worktrees ignore in ${parentCwd}: ${ignoreSettled.reason}`)
      }
    }
    // 2026-09-15 机制补漏（用户裁定「严格」）：父树有**任何**未提交改动（含 untracked）即拒绝隔离 ——
    // 子从 HEAD 建分支、看不到未提交工作，会在过时的树上开发/验证并可能**静默**报成功。
    // 放在 `mkdirSync`/`worktree add` **之前**，连半成品目录都不产生。
    const refusal = corumDirtyParentRefusal(parentCwd)
    if (refusal !== undefined) throw new Error(refusal)
    mkdirSync(root, { recursive: true })
    try {
      corumGit(parentCwd, ['worktree', 'add', worktreePath, '-b', branch])
    } catch (error: unknown) {
      corumCleanupWorktree(parentCwd, { path: worktreePath, branch })
      throw error
    }
    // 记下分支创建点（= 当时的 HEAD）。对账时用「tip 有没有离开 base」区分
    // 「真的做了事的分支」与「一条提交都没有的空分支」——空分支一旦 main 往前走了，
    // 在 `git branch --merged HEAD` 里与真合并过的分支完全同形（2026-09-12 实测：
    // 两条刚建好的空分支在重启后就被误判成 integrated 并回收）。
    const base = corumBranchTip(parentCwd, branch)
    // 2026-09-20：创建即记 tip 快照（此刻 tip === base，空分支豁免照旧成立）——
    // 分支被删后判定仍能寻址到这个 sha。
    this.addActiveEntry(sessionId, parentCwd, {
      slug,
      branch,
      path: worktreePath,
      ...base === undefined ? {} : { base, tip: base },
    })
    return { slug, branch, path: worktreePath }
  }

  /** 台账变更后发射快照帧（renderer chip 订阅源）。发帧前先对账 git 实况。 */
  emitFrame(sessionId: string): void {
    const current = this.ledger.get(sessionId) ?? []
    const reconciled = this.reconcileAndReclaim(sessionId, current)
    if (reconciled.flipped) {
      this.ledger.set(sessionId, [...reconciled.entries])
      this.persist(sessionId)
    }
    const entries = this.ledger.get(sessionId) ?? []
    const pending = entries.filter(e => e.status === 'active' || e.status === 'settled').length
    this.ctx.emit('corum/worktree-ledger', {
      sessionId,
      entries: entries.map(e => ({ ...e })),
      pending,
    } satisfies CorumWorktreeLedgerFrame)
  }

  /**
   * 父 scope dispose 时清理未集成的 worktree。
   *
   * 2026-09-09 加固：走**安全清理**（非 force）——未并入 HEAD 的分支保留（那是该批
   * 工作的唯一留存），worktree 有未提交改动则连目录一起保留；只有真正清干净的条目
   * 才标 `discarded`（状态如实，避免「worktree 已清、台账仍 active」的漂移）。
   */
  cleanupOnDispose(statuses: readonly CorumWorktreeEntry['status'][] = ['active', 'settled']): void {
    for (const [sessionId, entries] of this.ledger) {
      const cwd = this.ledgerCwds.get(sessionId)
      if (cwd === undefined) continue
      corumCleanupLedgerEntries(cwd, entries, statuses, { force: false })
      this.persist(sessionId)
    }
  }

  /**
   * fork（corum）：集成**成功**后的状态翻转 + 落盘 + 帧发射。
   * 仅当调用方已用 `corumIntegrationTruth` 确认集成真的落进 HEAD 后才可调用——
   * 未达标时必须抛错并保留现场（不写 integrated、不清理）。
   * @param cleanup - 是否顺带强清理已集成的 worktree/分支（config.isolation.autoCleanup）。
   */
  markIntegrated(sessionId: string, entries: CorumWorktreeEntry[], cleanup: boolean): void {
    const cwd = this.ledgerCwds.get(sessionId)
    for (const entry of entries) entry.status = 'integrated'
    if (cleanup && cwd !== undefined) {
      // 集成成功 = 每个分支都已并入 HEAD，此处强清理是安全的（唯一合法 force 点）。
      corumCleanupLedgerEntries(cwd, entries, ['integrated'], { force: true })
    }
    this.persist(sessionId)
    this.emitFrame(sessionId)
  }

  /**
   * fork（corum）：把 spawn 得到的 run/child id 绑定到台账条目（精确 settle 的前置）。
   *
   * 2026-09-09 修复（docs/TODO.md「台账 settle 联动未生效」）：worktree 条目在
   * `subagents.start` 之前创建（request 需要 worktree 路径），此时 run id 未知；
   * start 返回后立刻绑定，`subagent/end` 到达时即可按 id 精确匹配——并行多个子 Agent
   * 时不再依赖「唯一 active 回退」（该回退在 ≥2 并行时必然失败）。
   */
  bindRunId(sessionId: string, slug: string, runId: string): void {
    const entry = this.ledger.get(sessionId)?.find(item => item.slug === slug)
    if (entry === undefined || entry.runId !== undefined) return
    entry.runId = runId
    entry.childSessionId = runId
    this.persist(sessionId)
    // 绑定后立即发射，让已打开的浮层行可点击（与 addActiveEntry/markIntegrated 同口径）。
    this.emitFrame(sessionId)
  }

  /**
   * fork（corum）：回滚一条「worktree 已建、子 Agent 未起」的条目（spawn 抛错路径）。
   *
   * 条目在 `subagents.start` **之前**登记（request 需要 worktree 路径），因此 start
   * 失败时台账会留下一条永远 active、且永不绑定 runId 的条目：它占满
   * `maxParallelChildren` 额度，并让该会话后续每次派遣都命中并发信号③而强制隔离。
   * （2026-09-10 实机：官方 preset 三个会话各泄漏数条 worktree。）
   *
   * 此时 worktree 目录与分支都是本次 spawn 的产物，子 Agent 从未执行过任何工具，
   * 不可能有未合并提交——强清理安全。已绑定 runId 的条目一律不动（那条 run 真实
   * 存在，settle 路径负责它）。
   */
  discardEntry(sessionId: string, slug: string): void {
    const entries = this.ledger.get(sessionId)
    const cwd = this.ledgerCwds.get(sessionId)
    const entry = entries?.find(item => item.slug === slug)
    if (entries === undefined || entry === undefined || cwd === undefined) return
    if (entry.runId !== undefined) return
    corumCleanupWorktree(cwd, entry, { force: true })
    this.ledger.set(sessionId, entries.filter(item => item.slug !== slug))
    this.persist(sessionId)
    this.emitFrame(sessionId)
  }

  /**
   * fork（corum）：会话级「在跑写子 Agent」计数——并发感知隔离的输入。
   *
   * 与台账的区别：台账只登记**已隔离**的条目（worktree 路径/分支是它的语义），
   * 而并发判定必须连**不隔离**的在跑写子 Agent 一起算——否则同一条消息里并发发出
   * 的两个 `subagent` 前台调用会各自认为「没有并发」，双双写主工作区。
   * 计数在 spawn 前同步自增（JS 单线程，第二个调用必然看到第一个），settle/异常
   * 路径 `finally` 自减；不落盘（进程内事实）。
   */
  private readonly runningWriteChildren = new Map<string, number>()

  /** 登记一个在跑写子 Agent（spawn 前同步调用）。 */
  beginWriteChild(sessionId: string): void {
    this.runningWriteChildren.set(sessionId, (this.runningWriteChildren.get(sessionId) ?? 0) + 1)
  }

  /** 注销一个在跑写子 Agent（settle/异常后调用；计数归零即删表）。 */
  endWriteChild(sessionId: string): void {
    const next = (this.runningWriteChildren.get(sessionId) ?? 0) - 1
    if (next <= 0) this.runningWriteChildren.delete(sessionId)
    else this.runningWriteChildren.set(sessionId, next)
  }

  /** 该会话当前在跑的写子 Agent 数（>0 表示新派遣与它并发）。 */
  runningWriteChildrenOf(sessionId: string): number {
    return this.runningWriteChildren.get(sessionId) ?? 0
  }

  /**
   * 认领「该分支的待集成通知」——**只有第一个调用者拿到 true**，其余实例静默跳过。
   *
   * 消费方（corum-tool-subagent 的 subagent/end 监听）在投递前先调本方法；
   * 双实例因此只发一条（见 {@link pendingNotified} 的说明）。
   * @param sessionId - 父会话 id。
   * @param branch - 分支名。
   * @returns true = 本次由我投递；false = 已有人投递过，跳过。
   */
  claimPendingIntegrationNotice(sessionId: string, branch: string): boolean {
    // key 用**长度前缀**而不是裸分隔符拼接：`'a' + 'b\0c'` 与 `'a\0b' + 'c'` 用纯分隔符
    // 拼会撞成同一个 key。实测中 sessionId / 分支名都不含 NUL，但长度前缀让 key **恒单射**，
    // 不依赖调用方输入的字符集（单测里那条边界用例就是钉这个）。
    const key = `${sessionId.length}:${sessionId}\u0000${branch}`
    if (this.pendingNotified.has(key)) return false
    this.pendingNotified.add(key)
    return true
  }

  /**
   * 登记该会话的临时子 Agent 模型覆盖（用户选「临时改用主 Agent 模型」，
   * 或永久档写下的 `'follow-main'` 哨兵 = 显式跟随主 Agent）。
   */
  setModelOverride(
    sessionId: string,
    route: { provider: string; model: string; reasoningEffort?: string } | 'follow-main',
  ): void
  /**
   * fork（corum）2026-09-19：带角色的重载——补偿「预设保存后存量会话仍用旧模型」。
   *
   * 机制（{@link CorumOrchestration#modelOverrides} 两键语义）：worker 键 = 原 2 参调用
   * 的行为（model-ask-run.ts 的 temporary/permanent 档原样兼容）；research 键 =
   * compile.ts 那个 research 实例（`tool-subagent-research` 行）的锁面。两个角色互相
   * 独立，写入互不覆盖。幂等：同键重复写同值，Map.set 覆盖后 snapshot 相同。
   */
  setModelOverride(
    sessionId: string,
    role: 'worker' | 'research',
    route: { provider: string; model: string; reasoningEffort?: string } | 'follow-main',
  ): void
  setModelOverride(
    sessionId: string,
    roleOrRoute: 'worker' | 'research' | { provider: string; model: string; reasoningEffort?: string } | 'follow-main',
    route?: { provider: string; model: string; reasoningEffort?: string } | 'follow-main',
  ): void {
    if (route !== undefined) {
      // `'follow-main'` 原样存（不是路由，不能 spread——字符串 spread 会变成字符索引对象）。
      this.modelOverrides.set(
        `${sessionId} ${roleOrRoute as 'worker' | 'research'}`,
        typeof route === 'string' ? route : { ...route },
      )
      return
    }
    // 原 2 参形态 = worker 角色（tool-subagent 行的锁面）——历史调用方（model-ask 的
    // temporary/permanent 档）改的就是委派主实例，语义与旧行为一致。
    // ⚠️ 第三态：`'follow-main'` 哨兵同样可走这条（2 参 = worker + 跟随主 Agent）。
    this.modelOverrides.set(
      `${sessionId} worker`,
      typeof roleOrRoute === 'string' && roleOrRoute !== 'worker' && roleOrRoute !== 'research'
        ? roleOrRoute
        : { ...(roleOrRoute as { provider: string; model: string; reasoningEffort?: string }) },
    )
  }

  /** 取该会话的临时子 Agent 模型覆盖（无则 undefined = 按预设/全局/跟随主 Agent 原样解析）。 */
  modelOverrideOf(sessionId: string): { provider: string; model: string; reasoningEffort?: string } | 'follow-main' | undefined
  /** fork（corum）2026-09-19：带角色取值（见 {@link CorumOrchestration#modelOverrides}）。 */
  modelOverrideOf(sessionId: string, role: 'worker' | 'research'): { provider: string; model: string; reasoningEffort?: string } | 'follow-main' | undefined
  modelOverrideOf(
    sessionId: string,
    role: 'worker' | 'research' = 'worker',
  ): { provider: string; model: string; reasoningEffort?: string } | 'follow-main' | undefined {
    const route = this.modelOverrides.get(`${sessionId} ${role}`)
    if (route === undefined) return undefined
    return typeof route === 'string' ? route : { ...route }
  }

  /** 清除该会话的临时覆盖（用户改回原配置时用；缺省两角色一起清）。 */
  clearModelOverride(sessionId: string): void
  /** fork（corum）2026-09-19：只清指定角色（预设保存补偿用——一次保存只改一个角色的锁面）。 */
  clearModelOverride(sessionId: string, role: 'worker' | 'research'): void
  clearModelOverride(sessionId: string, role?: 'worker' | 'research'): void {
    // 缺省 = 两角色一起清：调用方（model-ask 的 decline 档）语义是「本会话的临时决定
    // 整体作废」。带角色 = 只清该键（corum-agent 的预设保存补偿按角色清）。
    if (role === undefined) {
      this.modelOverrides.delete(`${sessionId} worker`)
      this.modelOverrides.delete(`${sessionId} research`)
      return
    }
    this.modelOverrides.delete(`${sessionId} ${role}`)
  }

  /**
   * 登记一次委派的 spawn 事实（key=子会话/run id），供**异步失败**时问用户用。
   *
   * 为什么需要它（2026-09-18）：后台一次性 / continuable 这两条路的失败**不在工具调用
   * 的栈上发生**——工具早已返回（后台 job id / 子会话 id），失败要等 `subagent/end`
   * 才到。那时手里只有 `info`（runId / childId / stopReason），**没有**「用户为该角色
   * 配的是哪个模型、label 是什么」这些提问必需的事实。故 spawn 时记一份，settle 时取走。
   *
   * 只对「用户配置了锁定模型」的委派登记（没有配置就不存在"配置的模型不可用"这件事；
   * 那种情况子 Agent 用的就是主路由，失败与模型选择无关）。取走即删，避免长期驻留。
   */
  private readonly childSpawns = new Map<string, CorumChildSpawnFacts>()

  /** 登记 spawn 事实（仅锁定路由的委派；见 {@link childSpawns} 的说明）。 */
  rememberChildSpawn(childId: string, facts: CorumChildSpawnFacts): void {
    this.childSpawns.set(childId, { ...facts, configured: { ...facts.configured } })
  }

  /** 取走 spawn 事实（取走即删；拿不到=该委派与「配置模型不可用」无关）。 */
  takeChildSpawn(childId: string): CorumChildSpawnFacts | undefined {
    const facts = this.childSpawns.get(childId)
    if (facts === undefined) return undefined
    this.childSpawns.delete(childId)
    return facts
  }

  /**
   * fork（corum）：解析 `subagent/end` 对应的父会话 id。
   *
   * 优先用 dispatch carrier 解出的父 Agent（调用方经 `carrierKeyOf(this)` 取）；
   * carrier 缺失时用子会话 id 经 `agents` 服务反查 `session.header.parentSession`
   * （与 corum-tool-subagent 模型选择路径同款用法）。拿不到就返回 undefined——
   * 调用方静默跳过，绝不抛错（旧实现在此处抛错导致 settle 静默失效）。
   */
  private parentSessionIdOf(info: CorumSubagentEndInfo, parentAgent?: Agent): string | undefined {
    if (parentAgent !== undefined) return String(parentAgent.session.id)
    // 红线 3：跨包类型用局部能力接口收窄，不耦合官方实现包。
    const agents = this.ctx.get('agents') as
      | { get: (id: unknown) => { session: { header: { parentSession?: unknown } } } | undefined }
      | undefined
    const parent = agents?.get(info.id)?.session.header.parentSession
    return parent === undefined ? undefined : String(parent)
  }

  /**
   * subagent/end settle 联动（翻转成功时发射台账帧）。
   *
   * 2026-09-09 修复：`parentAgent` 改为可选——fork #9 的 `subagent/end` 声明父 Agent 是
   * dispatch 的 `this`（scope carrier）而非第二参数，监听端若拿不到就传 undefined；
   * 此时用 `info.id`（子会话 id）经 agents 服务反查父会话（session.header.parentSession）
   * 兜底，绝不抛错（旧实现 `parentAgent.session.id` 恒抛、被 emitter 吞掉 → settle 从未生效）。
   */
  settleFromEnd(info: CorumSubagentEndInfo, parentAgent?: Agent): boolean {
    const sessionId = this.parentSessionIdOf(info, parentAgent)
    if (sessionId === undefined) return false
    const entries = this.ledger.get(sessionId)
    if (entries === undefined) return false
    // 2026-09-15 机制补漏：**收口前强制提交**（用户裁定：机制保证，不由 Agent 自己决定）。
    // 在 `corumMarkSettled` **之前**做：未提交的隔离成果不允许存活过收口。
    // ⚠️ 本函数在 `subagent/end` 监听里被调用，而 **emitter 的 per-listener 容错会吞掉抛错**
    // （既有注释明写此前 `parentAgent.session.id` 抛错就是被吞掉的）⇒ **失败不能靠 throw 传给模型**，
    // 故失败原因**暂存到台账实例**，由调用方（corum-tool-subagent，已有 notice 投递机制）取走并投递。
    const failures: CorumSettleCommitFailure[] = []
    for (const entry of entries) {
      if (entry.status !== 'active') continue
      const failure = corumCommitWorktreeOnSettle(entry.path, entry.slug)
      if (failure !== undefined) failures.push(failure)
    }
    if (failures.length > 0) this.commitFailures.set(sessionId, failures)
    // 2026-09-20：收口提交之后立刻刷新 tip 快照——这是分支**最后一次确定还活着**、
    // 且带着子 Agent 全部提交的时刻（此后集成者可能 merge + `branch -D`）。
    // cwd 未知（台账未记父目录）时跳过：`git` 不接受空 cwd，且那时快照也无处落。
    const settleCwd = this.ledgerCwds.get(sessionId)
    if (settleCwd !== undefined) corumSnapshotBranchTips(settleCwd, entries)
    const flipped = corumMarkSettled(entries, { runId: String(info.runId), childId: String(info.id) })
    if (flipped) {
      this.persist(sessionId)
      this.emitFrame(sessionId)
    }
    return flipped
  }

  /**
   * fork（corum）：**取走**该会话最近一次收口的提交失败（取出即清，避免重复投递）。
   *
   * 与 {@link settleFromEnd} 配对：settle 负责尝试提交并暂存失败，
   * 调用方（`corum-tool-subagent`）取走后经 `parent.inject(...)` 以 notice 形态交给模型，
   * 由模型把提交完成（用户裁定：「commit 失败后交由模型处理并完成提交」）。
   * @param sessionId - 父会话 id（台账键）。**省略时取走并清空全部会话的暂存**——
   * 调用方拿不到父会话（`parent` undefined）时用它兜底，避免失败在实例里越积越多。
   * @returns 失败清单；无失败时为空数组。
   */
  drainSettleCommitFailures(sessionId?: string): readonly CorumSettleCommitFailure[] {
    if (sessionId !== undefined) {
      const failures = this.commitFailures.get(sessionId)
      if (failures === undefined) return []
      this.commitFailures.delete(sessionId)
      return failures
    }
    const all = [...this.commitFailures.values()].flat()
    this.commitFailures.clear()
    return all
  }

  /** 供单测直接操作台账（行为等价迁移前的测试面）。 */
  _testLedger(): Map<string, CorumWorktreeEntry[]> {
    return this.ledger
  }
}
