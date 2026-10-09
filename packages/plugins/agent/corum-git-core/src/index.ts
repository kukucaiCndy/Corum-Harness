/**
 * @corum/corum-git-core — cordis 服务面（host 装配点）。
 *
 * ## 服务面
 *
 * `gitCore`（cordis 服务，host 侧）：
 *   - `ensureRepo(path)` / `isRepo(path)` / `init(path)` —— 包装 git-primitives，
 *     供 host 创建入口（corum-agent / corumProject）作**强制前置**直调（同进程，
 *     不走 RPC）；也经 `@Remote` 暴露给 client（与旧 desktop corumGit RPC 同名兼容）。
 *   - `assertGitWorkspace(path)` —— 不变式①的机制门禁：创建工作区/任务/项目前的
 *     强制前置；失败（目录不可写/git 缺失）**抛错阻断创建**（fail-loud，不静默降级）。
 *
 * ## turn-stopping 阻塞式提交卡片（2026-10-08 用户定调）
 *
 * 旧机制 `settleCommitOnTurnEnd` 在 turn 结束时直接 `git add -A && git commit`，
 * 导致提交历史被流水号 wip 灌水、跨主题揉团、产物误入 git。
 * 新机制：turn 即将关闭时（`agent/turn-stopping` 钩子，turn 仍 open、可阻塞），
 * 检查 hasEffectiveChanges：
 *   - 无改动 → 直接放过。
 *   - 有改动 → ①出提交卡片（`corum/commit-card/request` waterfall，把 diff --stat
 *     摘要带给 client）；②同时 `agent.steer()` 注入指令让 LLM 自己看 diff、按逻辑
 *     主题分一笔或多笔提交、写语义化 conventional commit message。
 *   - 幂等：steer 后 turn-stopping 再触发时若已干净则跳过。
 *   - 超时降级：5 分钟未提交干净 → `git stash push` 保改动、卡片标记已暂存、放行 turn。
 *
 * ## 不可卸载
 *
 * 本插件是 **corum 核心插件**（用户 2026-09-16 策略③）：cordis.patch.yml 的 insert
 * 段挂载行带 `# core: non-removable` 标记注释；插件管理器（corum-ide-plugin-manager-ui
 * / 设置·插件管理）按包名 `@corum/corum-git-core` 过滤，不显示启停/卸载入口。
 * cordis 本身无原生「不可卸载」行属性，故这是**约定 + UI 过滤 + 文档标记**三层。
 *
 * @module corum-git-core
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { execFileSync } from 'node:child_process'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import {
  ensureRepo,
  initRepo,
  isGitRepo,
  hasEffectiveChanges,
  diffStatSummary,
  stashChanges,
  type SettleCommitFailure,
} from './git-primitives.ts'
// type-only：拉入 @corum/corum-api-remotes/corum-events 的 Events 声明
// （corum/commit-card/request 的 waterfall 与 corum/commit-card/update 的 emit
// key 面由此投影），让本插件的 waterfall 派发与 emit 通过类型检查。
import type {} from '@corum/corum-api-remotes/corum-events'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** git 管理核心机制（corum 核心插件，不可卸载）：工作区 git 侦测/初始化/创建前置门禁。 */
    gitCore: GitCoreService
  }
}

/** turn-stopping 超时降级的时限（5 分钟）。 */
const COMMIT_CARD_TIMEOUT_MS = 5 * 60 * 1000

/** 轮询 hasEffectiveChanges 的间隔（500ms）。 */
const POLL_INTERVAL_MS = 500

/**
 * git 管理核心服务（corum 核心插件，不可卸载）。
 *
 * host 侧 cordis 服务：既经 `@Remote` 暴露 RPC（service 名 `gitCore`，client 可调），
 * 也供 host 创建入口**同进程直调**（corum-agent/corumProject 经 `ctx.gitCore` inject
 * 后调 `assertGitWorkspace` 作创建前置——不变式①的机制保证落点）。
 */
export class GitCoreService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'gitCore')
  }

  /** 侦测目录是否是 git 仓库（含 worktree/子目录）。 */
  @Remote('status')
  async status(path: string): Promise<{ isRepo: boolean }> {
    return { isRepo: await isGitRepo(path) }
  }

  /** 初始化 git 仓库（`git init` + 空初始 commit；幂等）。 */
  @Remote('init')
  async init(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
    const result = await initRepo(path)
    if (result.initialized) this.ctx.logger.info(`git-core: initialized ${path}`)
    return result
  }

  /** 保证目录是 git 仓库（已是则原样返回，否则 init + 初始 commit）。 */
  @Remote('ensureRepo')
  async ensureRepoRemote(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
    return await this.init(path)
  }

  /**
   * 不变式①的机制门禁（host 创建入口的强制前置）：
   * 创建工作区/任务/项目**之前**必须调用——保证目标目录是 git 仓库；
   * 失败（路径非法/不可写/git 缺失）**抛错阻断创建**（fail-loud，不静默降级）。
   *
   * 这是「工作区必须有 git 参考，机制一定要侦测」的**机制层**保证——不再依赖
   * UI 层自觉调用 ensureRepo（旧缺口的根因：新目录建任务/项目可绕过 UI 直命中
   * host 创建入口）。
   *
   * @param path - 任意绝对目录路径（待创建的工作区/任务/项目目录）。
   */
  async assertGitWorkspace(path: string): Promise<void> {
    await ensureRepo(path)
  }
}

/**
 * turn-stopping 阻塞式提交卡片的状态（供 client 渲染三态）。
 *
 * - `pending`：待提交——主态，LLM 正在审查 diff。
 * - `progress`：进行中——LLM 正在逐笔提交。
 * - `done`：已完成——所有提交已落地。
 * - `stashed`：超时降级——改动已 stash，turn 已放行。
 */
export type CommitCardStatus = 'pending' | 'progress' | 'done' | 'stashed'

/**
 * `corum/commit-card/request` 的 host → client 载荷（提交卡片初始状态）。
 */
export interface CorumCommitCardRequestEvent {
  /** 发起卡片的 Agent（waterfall 的 scope 载体）。 */
  readonly agent: Agent
  /** 会话 id（卡片归属会话）。 */
  readonly sessionId: string
  /** turn 编号。 */
  readonly turn: number
  /** 初始状态。 */
  readonly status: CommitCardStatus
  /** 非产物改动文件数。 */
  readonly effectiveFiles: number
  /** 总改动文件数（含产物）。 */
  readonly totalFiles: number
  /** diff --stat 摘要行（非产物，最多 3 行）。 */
  readonly diffLines: readonly string[]
  /** 还有多少产物文件被排除。 */
  readonly excludedArtifacts: number
}

/** `corum/commit-card/update` 的 host → client 状态更新（emit 通道）。 */
export interface CorumCommitCardUpdateEvent {
  /** 会话 id。 */
  readonly sessionId: string
  /** turn 编号。 */
  readonly turn: number
  /** 新状态。 */
  readonly status: CommitCardStatus
  /** 已完成的提交列表（仅 done 态有值）。 */
  readonly commits?: readonly { readonly type: string; readonly scope?: string; readonly message: string }[]
  /** 进度描述（进行中态用）。 */
  readonly progressText?: string
}

/** client → host 的回传（立即解析——卡片无按钮，阻塞由机制保证）。 */
export interface CorumCommitCardOutcomeEvent {
  readonly kind: 'shown'
}

/**
 * 构造注入给 LLM 的 steer 指令（让它审查 diff 并分笔提交）。
 *
 * @param effectiveFiles - 非产物改动文件数。
 * @param diffLines - diff --stat 摘要行。
 * @param sessionId - 会话标识（进溯源）。
 * @returns ContentBlock[]（createUserMessage 的 content 入参）。
 */
function buildCommitSteerMessage(
  effectiveFiles: number,
  diffLines: readonly string[],
  sessionId: string,
): { type: 'text'; text: string }[] {
  const diffPreview = diffLines.length > 0
    ? `\n\n改动概览（diff --stat 摘要，产物路径已排除）：\n${diffLines.map(l => `  ${l}`).join('\n')}`
    : ''
  const text = [
    `本 turn 有 ${effectiveFiles} 个文件的改动需要提交（会话 ${sessionId}）。`,
    diffPreview,
    '\n请审查改动，按逻辑主题分成一笔或多笔提交。每笔提交写语义化 conventional commit message',
    '（feat/fix/refactor/docs/chore/ci/build/perf/test + scope + 简短描述）。',
    '产物路径（lib/、dist/、build/、main.js、*.tsbuildinfo、node_modules/）已排除，不要提交它们。',
    '用 bash 工具自己 git add / git commit（一笔或多笔）。提交干净后结束本 turn。',
  ].join('')
  return [{ type: 'text', text }]
}

/**
 * 轮询 hasEffectiveChanges 直到返回 false（LLM 已提交干净）或超时。
 *
 * @param cwd - 工作区目录。
 * @param timeoutMs - 超时毫秒。
 * @param onProgress - 进度回调（每次轮询时调用，供更新卡片状态）。
 * @returns `true` = 已干净（提交完成）；`false` = 超时。
 */
async function pollUntilClean(
  cwd: string,
  timeoutMs: number,
  onProgress?: () => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!hasEffectiveChanges(cwd)) return true
    onProgress?.()
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return !hasEffectiveChanges(cwd)
}

/**
 * 从 git log 提取本 turn 新增的提交列表（供卡片「已完成」态展示）。
 *
 * @param cwd - 工作区目录。
 * @param sinceMinutes - 往回看多少分钟（默认 6 分钟，略大于 5 分钟超时）。
 * @returns 提交列表（type/scope/message）。
 */
function recentCommits(
  cwd: string,
  sinceMinutes = 6,
): { type: string; scope?: string; message: string }[] {
  try {
    const log = execFileSync('git', ['-C', cwd, 'log', `--since=${sinceMinutes}.minutes ago`, '--format=%s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return log.trim().split('\n').filter(Boolean).map((subject): { type: string; scope?: string; message: string } => {
      // 解析 conventional commit: type(scope): message
      const match = subject.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/)
      if (match) {
        return { type: match[1], scope: match[2] ?? undefined, message: match[3] }
      }
      return { type: 'chore', message: subject }
    })
  } catch {
    return []
  }
}

/**
 * turn-stopping 阻塞式提交卡片的主逻辑。
 *
 * 在 `agent/turn-stopping` 钩子里调用（serial dispatch，可阻塞 turn）。
 *
 * @param ctx - host cordis context。
 * @param agent - turn 所属的 Agent。
 * @param turn - turn 编号。
 */
async function handleTurnStoppingCommit(ctx: Context, agent: Agent, turn: number): Promise<void> {
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd === '') return
  // 幂等：已干净就放过（steer 后重进 turn-stopping 时这是关键路径）。
  if (!hasEffectiveChanges(cwd)) return

  const summary = diffStatSummary(cwd, 3)
  const sessionId = String(agent.session.id)
  const excludedArtifacts = Math.max(0, summary.totalFiles - summary.effectiveFiles)

  // ①出卡片（waterfall，把 diff --stat 摘要带给 client）。
  // next 回退立即返回 shown——卡片无按钮，阻塞由机制保证（不依赖用户操作）。
  const request: CorumCommitCardRequestEvent = {
    agent,
    sessionId,
    turn,
    status: 'pending',
    effectiveFiles: summary.effectiveFiles,
    totalFiles: summary.totalFiles,
    diffLines: summary.lines,
    excludedArtifacts,
  }
  try {
    await ctx.waterfall(
      scopeTarget(agent, agent),
      'corum/commit-card/request',
      request,
      async (): Promise<CorumCommitCardOutcomeEvent> => ({ kind: 'shown' }),
    )
  } catch (error: unknown) {
    // 通路断开（无 UI 插件 / headless）→ 不阻断，继续走 steer（LLM 仍会处理）。
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`git-core: commit-card waterfall failed for ${sessionId}: ${detail}`)
  }

  // ②同时 steer 注入指令让 LLM 自己处理。
  const steerContent = buildCommitSteerMessage(summary.effectiveFiles, summary.lines, sessionId)
  try {
    agent.steer(createUserMessage({
      content: steerContent,
      source: { kind: 'user' },
    }))
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`git-core: could not steer agent ${sessionId} for commit: ${detail}`)
    // steer 失败 → 不无限阻塞，让 turn 关闭（改动留在树里）。
    return
  }

  // ③发 progress 状态更新。
  emitCommitCardUpdate(ctx, sessionId, turn, {
    status: 'progress',
    progressText: `AI 正在审查 diff、按逻辑主题分笔写提交信息…`,
  })

  // ④轮询等提交干净（5 分钟超时）。
  const clean = await pollUntilClean(cwd, COMMIT_CARD_TIMEOUT_MS)

  if (clean) {
    // 提交完成 → 发 done 状态更新。
    const commits = recentCommits(cwd)
    emitCommitCardUpdate(ctx, sessionId, turn, {
      status: 'done',
      commits,
    })
  } else {
    // 超时降级 → stash 保改动。
    const stashFailure = stashChanges(cwd, `wip(turn-${sessionId.slice(-8)})`)
    if (stashFailure !== undefined) {
      ctx.logger.warn(`git-core: stash fallback failed for ${sessionId}: ${stashFailure.reason}`)
    }
    emitCommitCardUpdate(ctx, sessionId, turn, {
      status: 'stashed',
      progressText: stashFailure === undefined
        ? '超时降级：改动已暂存（git stash），turn 已放行'
        : `超时降级失败：${stashFailure.reason}（改动仍留在工作区）`,
    })
  }
}

/**
 * 通过 emit 通道推送提交卡片状态更新（client 据此更新三态）。
 */
function emitCommitCardUpdate(
  ctx: Context,
  sessionId: string,
  turn: number,
  update: Omit<CorumCommitCardUpdateEvent, 'sessionId' | 'turn'>,
): void {
  try {
    ctx.emit('corum/commit-card/update', { sessionId, turn, ...update } as CorumCommitCardUpdateEvent)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`git-core: commit-card update emit failed for ${sessionId}: ${detail}`)
  }
}

/**
 * 插件 apply（cordis 装配点）：new 出 GitCoreService 挂到 host ctx，
 * 并注册 agent/turn-stopping 监听器（阻塞式提交卡片）。
 * cordis.patch.yml 的 insert 段挂载行使本 apply 运行（immediately）。
 * @param ctx - host cordis context。
 */
export function apply(ctx: Context): void {
  new GitCoreService(ctx)
  // turn-stopping 阻塞式提交卡片：turn 将关时检查 git 改动，有改动则出卡片 + steer LLM。
  // serial dispatch（可 await 阻塞 turn），turn-stopping 一轮可能触发多次（steer 后重读
  // 收件箱再进）——用 hasEffectiveChanges 判幂等，已提交干净就不再触发。
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      await handleTurnStoppingCommit(ctx, agent, turn)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`git-core: turn-stopping commit handler failed: ${detail}`)
    }
  })
}
