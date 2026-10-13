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
 * ## turn-stopping 提交卡片 + steer LLM 自己提交（2026-10-08 定调，10-11 去阻塞）
 *
 * 旧机制 `settleCommitOnTurnEnd` 在 turn 结束时直接 `git add -A && git commit`，
 * 导致提交历史被流水号 wip 灌水、跨主题揉团、产物误入 git。
 * 新机制：turn 即将关闭时（`agent/turn-stopping` 钩子），检查 hasEffectiveChanges：
 *   - **作用域：只收口主会话**（`origin !== 'subagent'`）——旧机制原有语义，
 *     2026-10-09 迁移时丢失、2026-10-10 按用户裁定恢复（详见
 *     {@link handleTurnStoppingCommit} 的注释与实测事故）。
 *   - 无改动 → 直接放过（若本 turn 出过卡片，这里就是**提交成功**的判据 → 发 `done`）。
 *   - 有改动 → ①出提交卡片（`corum/commit-card/request` waterfall，把 diff --stat
 *     摘要带给 client）；②同时 `agent.steer()` 注入指令让 LLM 自己看 diff、按逻辑
 *     主题分一笔或多笔提交、写语义化 conventional commit message；③**立即返回**。
 *   - 幂等：steer 后 turn-stopping 再触发时若已干净则放过并结算卡片。
 *   - **不阻塞、不 stash、不设重试上限**（2026-10-11 用户裁定）：turn 关不掉由
 *     steer 保持 `inbox.nextStep` 非空来保证（官方 turn-stopping 既有语义）；
 *     LLM 若始终不提交，改动就留在工作区可见，机制不代劳。
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
import { gitSafeDirectoryArgs } from '@corum/corum-platform'
import {
  ensureRepo,
  initRepo,
  isGitRepo,
  hasEffectiveChanges,
  effectiveChangeLines,
  diffStatSummary,
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

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * turn-stopping 提交卡片的 steer 指令来源（producer-owned，确定性标记）。
     *
     * 提交卡片的会话流内节点以这条 steer 的 `agent/inbox/spliced` 事件为锚点，
     * 凭 `inserted[].source.kind === 'commit-card'` 与卡片关联（MessageSourceMap
     * 按设计就是 merge-extensible 的——「user messages carry any producer's kind,
     * and consumers fall through unknown kinds」）。
     */
    'commit-card': { kind: 'commit-card' }
  }
}

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
 * turn-stopping 提交卡片的状态（供 client 渲染三态）。
 *
 * - `pending`：待提交——主态，LLM 正在审查 diff。
 * - `progress`：进行中——LLM 正在逐笔提交。
 * - `done`：已完成——提交已落地。
 *
 * 曾有第四个 `stashed`（超时降级），2026-10-11 随 `stashChanges` 一起删除：
 * 去阻塞后没有「超时」这一说，机制不再 stash 改动。
 */
export type CommitCardStatus = 'pending' | 'progress' | 'done'

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

/** client → host 的回传（立即解析——卡片无按钮）。 */
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
 * 从 git log 提取本 turn 新增的提交列表（供卡片「已完成」态展示）。
 *
 * @param cwd - 工作区目录。
 * @param sinceMinutes - 往回看多少分钟（默认 6 分钟；原为略大于 5 分钟轮询超时，
 *   现在没有轮询了，这个窗口只是「本 turn 的提交大概率落在最近几分钟内」的宽松取法）。
 * @returns 提交列表（type/scope/message）。
 */
function recentCommits(
  cwd: string,
  sinceMinutes = 6,
): { type: string; scope?: string; message: string }[] {
  try {
    // `-c` 与 `-C` 同属 git 的全局选项，`-c` 在前即可（Windows 上防 dubious ownership）。
    const log = execFileSync('git', [...gitSafeDirectoryArgs(cwd), '-C', cwd, 'log', `--since=${sinceMinutes}.minutes ago`, '--format=%s'], {
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
 * turn-stopping 提交卡片 + steer LLM 自己提交的主逻辑。
 *
 * 在 `agent/turn-stopping` 钩子里调用（serial dispatch，**不阻塞**——见下）。
 *
 * ## 作用域：只收口**主会话**（2026-10-10 恢复迁移时丢失的旧语义）
 *
 * `origin === 'subagent'` 的会话**不参与**本机制，直接放过。这是旧机制
 * `settleCommitOnTurnEnd` 的原有语义（`agent-service.ts` 原文：「主会话（非 subagent）
 * turn/end 收口时强制提交父树改动」），2026-10-09 迁移到 turn-stopping 钩子时随作用域
 * 一起丢失（旧守卫留在被删掉的那段里，没有搬过来）。
 *
 * 为什么必须恢复（2026-10-10 实测事故，子会话 `8927c635`）：
 * 委派子 Agent 的沙箱由 delegation 继承，**常年是 `read-only`**（只读研究）或在
 * worktree 里干活（收口另有通路，见下）。而本机制在 `agent/turn-stopping` 上是
 * **serial 且可 await 的阻塞钩子** ⇒ 只读子 Agent 被要求交出一个它物理上做不到的
 * commit ⇒ `pollUntilClean` 死等满 5 分钟超时（实测卡住 300.335s），父会话被同一个
 * await 拖住，用户点「停止」也感知不到（中止信号到不了 `pollUntilClean`）。
 * 旧机制因为挂在 `turn/end` 事件上（返回值被 void 丢弃、**不阻塞**），同一个作用域
 * 缺陷只是「甩下就跑」，不会死锁——迁移把它升级成阻塞钩子才把这个洞暴露成事故。
 *
 * 子会话的收口不由本机制负责，走各自既有通路：
 *   · 隔离 worktree 的子 Agent → `corumCommitWorktreeOnSettle`（orchestration，
 *     提交信息 `wip(isolated): auto-commit on settle`，收口在它自己的分支上）；
 *   · 非隔离子 Agent → 不提交（改动归父树，由主会话收口或集成流程处理）。
 *
 * @param ctx - host cordis context。
 * @param agent - turn 所属的 Agent。
 * @param turn - turn 编号。
 */
async function handleTurnStoppingCommit(
  ctx: Context,
  agent: Agent,
  turn: number,
  cardedTurns: Map<string, number>,
  turnSnapshots: Map<string, string[]>,
): Promise<void> {
  // 作用域闸门（旧语义）：只收口主会话，子 Agent 一律放过。
  if (agent.session.header.origin === 'subagent') return
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd === '') return

  const sessionId = String(agent.session.id)

  // turn-scoped 快照对比（方案 A）：只算本 turn **新增**的有效改动，不算工作区
  // 既有的改动（如 turn 开始前就存在的 untracked 文件）。快照在 turn/start 时存
  // （见 apply 的 session/event 监听）；若无快照（如 resume/旧会话）则回退到扫
  // 全工作区（旧行为，不误删既有收口逻辑）。
  const currentChanges = effectiveChangeLines(cwd)
  const snapshot = turnSnapshots.get(sessionId)
  const turnScopedChanges = snapshot !== undefined
    ? currentChanges.filter(line => !snapshot.includes(line))
    : currentChanges

  // 幂等：已干净就放过——**这条路是提交成功的判据**（见下方「done 从哪来」）。
  // 「干净」= 本 turn 无新增改动（turn-scoped）；无快照时回退到全工作区干净。
  const hasTurnChanges = snapshot !== undefined ? turnScopedChanges.length > 0 : hasEffectiveChanges(cwd)
  if (!hasTurnChanges) {
    if (cardedTurns.get(sessionId) === turn) {
      cardedTurns.delete(sessionId)
      emitCommitCardUpdate(ctx, sessionId, turn, { status: 'done', commits: recentCommits(cwd) })
    }
    return
  }

  // 本 turn 已出过卡片并 steer 过 ⇒ 不重复出卡（重复 steer 会因「每个 steer 一个锚点」而
  // 在会话流里堆出多张卡片，见 commit-card.ts 的 `id: String(event.seq)`）。
  // 此时 LLM 尚未提交：改动留在工作区可见（用户 2026-10-11 裁定：不 stash、不设重试上限）。
  if (cardedTurns.get(sessionId) === turn) return

  const summary = diffStatSummary(cwd, 3)
  const excludedArtifacts = Math.max(0, summary.totalFiles - summary.effectiveFiles)
  cardedTurns.set(sessionId, turn)

  // ①出卡片（waterfall，把 diff --stat 摘要带给 client）。
  // next 回退立即返回 shown——卡片无按钮（不依赖用户操作）。
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
      // producer-owned 来源标记：client 会话流内提交卡片节点以此为锚点关联。
      source: { kind: 'commit-card' },
    }))
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`git-core: could not steer agent ${sessionId} for commit: ${detail}`)
    // steer 失败 → 不无限阻塞，让 turn 关闭（改动留在树里）。
    return
  }

  // ③发 progress 状态更新，然后**立即返回**——这里不阻塞。
  //
  // ## 为什么不阻塞（2026-10-11 用户裁定 + 实测事故）
  //
  // 这里曾经 `await pollUntilClean(cwd, 5min)` 等树变干净。那是**自相矛盾的死锁**：
  // 本钩子在 turn loop 里是被 await 的（`agent.ts:343`），而 `steer()` 只是**入队**
  // （`agent.ts:167`）；队列只在 turn loop 走完本钩子之后才被消费（`agent.ts:346-347`）。
  // 于是 poll 等工作树变干净 → 变干净要 LLM 提交 → LLM 提交要 loop 走到 next-step →
  // loop 要等本钩子返回。**环环相扣，必然白等满 5 分钟**（实测 300.6s），随后
  // stashChanges 把 LLM 正要提交的文件抢走，LLM 拿到
  // `fatal: pathspec ... did not match any files`；随后的自查 + `git stash pop`
  // 才是那轮真正提交成功的原因——**不是机制跑通的**。
  //
  // ## turn 关不掉这件事，机制**本来**就保证了，不需要 poll
  //
  // steer 让 `inbox.nextStep` 非空 ⇒ loop 第 346 行不 break ⇒ **turn 关不掉**，
  // LLM 必须在同 turn 内把提交做完。这也是官方 `agent/turn-stopping` 的既有语义
  // （官方契约测试 "steer() from an agent/turn-stopping listener continues the same
  // turn"：listener 里 steer 后**同步返回**，LLM 在同 turn 内接着跑第二次）。
  // LLM 提交干净后 loop 再次进本钩子，第 298 行的幂等判断直接放过 —— **"重入即收敛"
  // 才是驱动器，轮询不是**。
  //
  // ## 用户裁定（2026-10-11）：不设上限、不 stash
  //
  // 曾评估"同 turn 最多催 N 次，到顶 stash 放行"，用户裁定取**信任 LLM**：
  // 不做重入计数、不做 stash 降级。改动若真没被提交，就留在工作区可见
  // （对用户而言是「有未跟踪改动」的可见状态，好过被机制偷偷 stash 走）。
  emitCommitCardUpdate(ctx, sessionId, turn, {
    status: 'progress',
    progressText: `AI 正在审查 diff、按逻辑主题分笔写提交信息…`,
  })
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
 * 并注册 agent/turn-stopping 监听器（提交卡片 + steer LLM 自己提交）。
 * cordis.patch.yml 的 insert 段挂载行使本 apply 运行（immediately）。
 * @param ctx - host cordis context。
 */
export function apply(ctx: Context): void {
  new GitCoreService(ctx)
  // 「本 turn 已出过卡片」的登记（sessionId → turn）。
  // 用途有二：①防同一 turn 重复出卡（每个 steer 会在会话流里锚出一张卡）；
  // ②「重入时发现树已干净」是提交成功的判据，据此发 done。
  // 只记最近一个 turn：turn 前进即覆盖，条目数与会话数同阶，不会长成日志。
  const cardedTurns = new Map<string, number>()
  // turn-scoped git status 快照（方案 A）：turn/start 时存一次 `git status --porcelain`
  // 的 effective change lines；turn-stopping 时对比当前快照，只算本 turn **新增**的
  // 改动——工作区里 turn 开始前就存在的 untracked 文件不算本 turn 改动，不触发
  // 提交卡片（修「发个你好就触发 git commit 既有文件」的 bug）。
  // key = sessionId（只存最近一次 turn 的快照，turn 前进即覆盖）。
  const turnSnapshots = new Map<string, string[]>()
  // turn/start 时存快照：只记主会话（子 Agent 的提交收口在 worktree 通路，
  // 见 handleTurnStoppingCommit 的作用域闸门）。
  ctx.on('session/event', (session, event) => {
    if (session.header.origin === 'subagent') return
    if (event.type !== 'turn/start') return
    const cwd = session.header.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    try {
      turnSnapshots.set(String(session.id), effectiveChangeLines(cwd))
    } catch {
      // git status 失败（非 git 仓库/权限问题）⇒ 不存快照；
      // turn-stopping 时回退到扫全工作区（旧行为）。
    }
  })
  // turn-stopping 提交卡片：turn 将关时检查 git 改动，有改动则出卡片 + steer LLM。
  // **立即返回、不阻塞**（2026-10-11 用户裁定）：turn 关不掉由 steer 保持 nextStep 非空
  // 来保证，LLM 提交干净后重入本钩子即收敛——不需要轮询等待（原因详见
  // {@link handleTurnStoppingCommit} 的「为什么不阻塞」）。
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      await handleTurnStoppingCommit(ctx, agent, turn, cardedTurns, turnSnapshots)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`git-core: turn-stopping commit handler failed: ${detail}`)
    }
  })
}
