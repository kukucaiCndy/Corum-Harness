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
 *   - `panelStatus(path)` / `listBranches(path)` / `listChanges(path)` /
 *     `recentLog(path)` —— Git 面板只读 RPC（2026-11-26 新增）。
 *   - `switchBranch(path, branch)` / `commitFiles(path, files, message)` ——
 *     Git 面板写操作 RPC（2026-11-26 新增）。
 *
 * ## turn-stopping 催提交机制已删除（2026-11-26）
 *
 * 旧机制在 `agent/turn-stopping` 钩子里检查 git 改动、出提交卡片、steer LLM 自己提交。
 * 2026-11-26 用户定调：改为「用户在会话外操作 git（切分支/手动提交），下一轮对话
 * 开始时注入给 Agent」。旧的 turn-stopping / commit-card / steer 机制**整体删除**。
 * git-primitives.ts 的 `settleCommit` / `hasEffectiveChanges` 等原语**保留**（orchestration
 * 的收口提交路径仍依赖）。
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
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { spawn } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { gitSafeDirectoryArgs } from '@corum/corum-platform'
import {
  ensureRepo,
  initRepo,
  isGitRepo,
} from './git-primitives.ts'
import { isSafeBranchName, parsePorcelainZText } from './porcelain.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** git 管理核心机制（corum 核心插件，不可卸载）：工作区 git 侦测/初始化/创建前置门禁 + Git 面板 RPC。 */
    gitCore: GitCoreService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Git 面板操作的注入消息来源（producer-owned，确定性标记）。 */
    'git-panel': { kind: 'git-panel' }
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
   * @param path - 任意绝对目录路径（待创建的工作区/任务/项目目录）。
   */
  async assertGitWorkspace(path: string): Promise<void> {
    await ensureRepo(path)
  }

  // ── Git 面板 RPC（2026-11-26 新增）──────────────────────────────────

  /**
   * Git 面板状态：当前分支 + ahead/behind + upstream。
   * @param path - 工作区目录。
   */
  @Remote('panelStatus')
  async panelStatus(path: string): Promise<{
    branch: string
    ahead: number
    behind: number
    upstream: string | null
    isRepo: boolean
  }> {
    const { isRepo } = await this.status(path)
    if (!isRepo) return { branch: '', ahead: 0, behind: 0, upstream: null, isRepo: false }
    const branchResult = await runGitText(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = branchResult.text
    const upstreamRaw = await runGitText(path, ['rev-parse', '--abbrev-ref', '@{upstream}'])
    const upstream: string | null = upstreamRaw.ok && upstreamRaw.text !== '' ? upstreamRaw.text : null
    const abRaw = await runGitText(path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    let ahead = 0
    let behind = 0
    if (abRaw.ok) {
      const parts = abRaw.text.split('\t')
      ahead = Number(parts[0] ?? '0') || 0
      behind = Number(parts[1] ?? '0') || 0
    }
    return { branch, ahead, behind, upstream, isRepo: true }
  }

  /**
   * 分支列表（含当前标记 + 相对最后提交时间）。
   * @param path - 工作区目录。
   */
  @Remote('listBranches')
  async listBranches(path: string): Promise<{
    current: string
    branches: { name: string; current: boolean; lastCommitRelative: string }[]
  }> {
    const currentResult = await runGitText(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const current = currentResult.text
    // --format=%(refname:short) %(committerdate:relative)
    const raw = await runGitText(path, ['for-each-ref', '--format=%(refname:short)\t%(committerdate:relative)', 'refs/heads/'])
    const branches = raw.ok
      ? raw.text.split('\n').filter(Boolean).map(line => {
          const [name, lastCommitRelative] = line.split('\t')
          return { name: name ?? '', current: name === current, lastCommitRelative: lastCommitRelative ?? '' }
        })
      : []
    return { current, branches }
  }

  /**
   * 未提交文件列表（状态 M/A/D/?? + 增删行数）。
   * @param path - 工作区目录。
   */
  @Remote('listChanges')
  async listChanges(path: string): Promise<{
    files: { path: string; status: string; added: number; deleted: number }[]
  }> {
    const porcelain = await runGitText(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!porcelain.ok) return { files: [] }
    // 重命名/复制记录在 -z 下是两条字段（目标在前、源在后），必须多消费一条，
    // 否则源路径会被当成一条独立记录 ⇒ 幽灵行 ⇒ 提交时 `git add` 不存在的路径。
    const entries = parsePorcelainZText(porcelain.text)
    const files: { path: string; status: string; added: number; deleted: number }[] = []
    for (const entry of entries) {
      // 取增删行数（未跟踪文件不在 `git diff` 里，故为 0/0，与改动前一致）
      const numstat = await runGitText(path, ['diff', '--numstat', '--', entry.path])
      let added = 0
      let deleted = 0
      if (numstat.ok && numstat.text !== '') {
        const parts = numstat.text.split('\t')
        added = parts[0] === '-' ? 0 : (Number(parts[0]) || 0)
        deleted = parts[1] === '-' ? 0 : (Number(parts[1]) || 0)
      }
      files.push({ path: entry.path, status: entry.status, added, deleted })
    }
    return { files }
  }

  /**
   * 最近提交列表。
   *
   * 形参必须是**纯标识符**（网关用 `Function.toString` 解析形参名，默认值/解构/
   * rest 一律抛 `gateway/signature-invalid`），故条数由调用方显式给，缺省取 10。
   * @param path - 工作区目录。
   * @param count - 返回条数。
   */
  @Remote('recentLog')
  async recentLog(path: string, count: number): Promise<{
    commits: { hash: string; subject: string; author: string; relativeDate: string }[]
  }> {
    const limit = Number.isFinite(count) && count > 0 ? Math.min(Math.trunc(count), 200) : 10
    const raw = await runGitText(path, [
      'log', `--max-count=${limit}`,
      '--format=%h\t%s\t%an\t%cr',
    ])
    const commits = raw.ok
      ? raw.text.split('\n').filter(Boolean).map(line => {
          const [hash, subject, author, relativeDate] = line.split('\t')
          return { hash: hash ?? '', subject: subject ?? '', author: author ?? '', relativeDate: relativeDate ?? '' }
        })
      : []
    return { commits }
  }

  /**
   * 切换分支。
   *
   * 三道门：① **idle 门禁**（host 侧再判一次，不能只信 UI——UI 的 `running`
   * 只看本会话 agent，而同一工作区可能还有continuable 后台子 Agent 在跑）；
   * ② 分支名严格校验（防 `-f` / `--orphan` 一类**参数注入**：`git checkout <branch>`
   * 会把以 `-` 开头的 token 当选项）；③ 用 `git switch` 而非 `git checkout`——
   * `checkout -- <name>` 是「恢复文件」语义，名字撞同名文件时会歧义。
   * @param path - 工作区目录。
   * @param branch - 目标分支名（本地或远程跟踪分支短名）。
   */
  @Remote('switchBranch')
  async switchBranch(path: string, branch: string): Promise<{ success: boolean; error?: string }> {
    if (!isSafeBranchName(branch)) return { success: false, error: `分支名不合法：${branch}` }
    if (!this.workspaceIdle(path)) return { success: false, error: 'Agent 正在该工作区工作，暂不可切换分支' }
    // 用 `switch`（git ≥2.23）而不是 `checkout`：`checkout -- <name>` 是**恢复文件**语义，
    // 名字与工作树里任一文件同名时会歧义甚至误删改动；`switch` 只接受分支，无此歧义。
    const result = await runGitText(path, ['switch', branch])
    if (!result.ok) return { success: false, error: result.stderr }
    return { success: true }
  }

  /**
   * 该工作区是否没有 agent 在跑。
   *
   * 判据是**所有**正在跑的会话的 cwd（由 `agent/status` 维护），而不是某一个会话的
   * `running`：同一 cwd 下可能有另一个会话（含 continuable 后台子 Agent）正在写同一棵
   * 工作树，此时切分支会把它的工作树换掉。
   * @param path - 工作区目录（比较 absolute cwd）。
   */
  private workspaceIdle(path: string): boolean {
    for (const cwd of runningWorkspaces.values()) {
      if (isSameWorkspace(cwd, path)) return false
    }
    return true
  }

  /**
   * 在选中路径里，找出重命名/复制记录的**删除源**（要一并提交的旧路径）。
   *
   * 只认「源路径已不存在」的那些：既避免把仍在磁盘上的普通同名改动误并进来，
   * 也保证用户只勾新路径时旧路径确实被删掉。
   * @param path - 工作区目录。
   * @param files - 用户选中的路径。
   * @returns 需要附加到本次提交的旧路径（可能是空数组）。
   */
  private async renameSourcesFor(path: string, files: readonly string[]): Promise<string[]> {
    const porcelain = await runGitText(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!porcelain.ok) return []
    const selected = new Set(files)
    const sources: string[] = []
    for (const entry of parsePorcelainZText(porcelain.text)) {
      if (entry.renameSource === null) continue
      if (!selected.has(entry.path)) continue
      sources.push(entry.renameSource)
    }
    return sources
  }

  /**
   * 提交选定文件（提交信息由调用方拼好传入，不调 LLM）。
   *
   * 只提交**调用方选中的路径**：先 `git add -- <files>`，再用 `git commit --only --`
   * 限定路径集合。不用裸 `git commit`（那会把 index 里别人已暂存的内容一并带进
   * 这次提交，用户的「勾选」就形同虚设）。
   * @param path - 工作区目录。
   * @param files - 要提交的文件路径列表。
   * @param message - 提交信息。
   */
  @Remote('commitFiles')
  async commitFiles(path: string, files: string[], message: string): Promise<{
    success: boolean
    commitHash?: string
    error?: string
  }> {
    if (files.length === 0) return { success: false, error: '没有选择文件' }
    if (message.trim() === '') return { success: false, error: '提交信息不能为空' }
    if (!this.workspaceIdle(path)) return { success: false, error: 'Agent 正在该工作区工作，暂不可提交' }
    // 重命名的删除源必须一起进这次提交：`commit --only -- b.txt` 只写 b.txt，
    // 旧路径 a.txt 仍留在 HEAD 树里、删除又卡在暂存区 ⇒ 用户会看到一条无法理解的
    // `D a.txt`，仓库里同名文件同时存在新旧两份。
    const sources = await this.renameSourcesFor(path, files)
    // `add` 只给选中文件：重命名的删除源在磁盘上已不存在，`git add -- <它>` 会
    // `pathspec did not match` 整单失败。删除源交给 `commit --only` 一并写进提交。
    const addResult = await runGitText(path, ['add', '--', ...files])
    if (!addResult.ok) return { success: false, error: addResult.stderr }
    // commit：`--only` + 路径集合 ⇒ 只提交这批路径（含重命名删除源），
    // 不挟带 index 里的其它暂存内容。
    const paths = [...new Set([...files, ...sources])]
    const commitResult = await runGitText(path, ['commit', '--no-verify', '--only', '-m', message, '--', ...paths])
    if (!commitResult.ok) return { success: false, error: commitResult.stderr }
    // 取 commit hash
    const hashResult = await runGitText(path, ['rev-parse', '--short', 'HEAD'])
    const commitHash: string | undefined = hashResult.ok && hashResult.text !== '' ? hashResult.text : undefined
    return { success: true, ...(commitHash === undefined ? {} : { commitHash }) }
  }

  // ── 待注入的 git 操作（agent/pre-step 一次性投递）─────────────────────

  /**
   * 记录一条 git 操作（供下一轮用户消息时注入给 Agent）。
   *
   * 由 UI 在切换分支/提交后调用。操作存在内存 Map（sessionId → operations[]），
   * `agent/pre-step` 监听器在下一轮用户消息时取出并注入，注入后清空。
   * @param sessionId - 会话 id。
   * @param operation - 操作描述（如「切换：main → feat/x（成功）」）。
   */
  @Remote('recordGitOperation')
  async recordGitOperation(sessionId: string, operation: string): Promise<{ recorded: boolean }> {
    const ops = pendingGitOperations.get(sessionId) ?? []
    ops.push(operation)
    pendingGitOperations.set(sessionId, ops)
    return { recorded: true }
  }

  /**
   * 取当前待注入的 git 操作（供 UI 展示「下轮注入预览」）。
   * @param sessionId - 会话 id。
   */
  @Remote('getPendingGitOperations')
  async getPendingGitOperations(sessionId: string): Promise<{ operations: string[] }> {
    return { operations: pendingGitOperations.get(sessionId) ?? [] }
  }
}

/**
 * 两个 cwd 是否指向同一工作区。
 *
 * 只做**路径等价**判断（先用 `resolve` 归一，再容忍末尾分隔符差异）；
 * 符号链接/大小写不敏感文件系统上的等价性不在此展开——宁可漏判（放行）也不误判
 * （把用户正常操作挡掉），因为 UI 侧还有一道 `running` 判据。
 * @param a - 一个绝对路径。
 * @param b - 另一个绝对路径。
 */
export function isSameWorkspace(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const resolved = resolve(value)
    return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved
  }
  return norm(a) === norm(b)
}

/**
 * 正在跑、且已知 cwd 的会话（`sessionId → cwd`）。
 *
 * 由 `agent/status` 事件维护：`running` 记入、`idle` 移除。用事件而不是读
 * `ctx.agents` 注册表——本插件是不可卸载的核心插件，把 `agents` 列成 inject 依赖
 * 会牵动装配顺序（git-core 需在 agent 栈就绪前就能提供 `assertGitWorkspace`）。
 * @see GitCoreService.workspaceIdle
 */
const runningWorkspaces = new Map<string, string>()

// ── 待注入的 git 操作（内存存储，sessionId → operations[]）──────────────

/**
 * 每会话待注入的 git 操作列表。
 *
 * UI 调 `recordGitOperation` RPC 记录（切换/提交），`agent/pre-step` 监听器
 * 在下一轮用户消息时取出并注入，注入后清空（一次性投递）。
 *
 * 持久化：注入内容写会话日志（`createUserMessage` → inbox spliced），重启后可重建。
 * 待注入状态本身是内存的——重启后丢失，但操作已落地（git switch/commit 是持久化的），
 * 只是「告诉 Agent」这一步没了，用户重开面板能看到当前状态。
 */
const pendingGitOperations = new Map<string, string[]>()

/**
 * 把待注入操作拼成一条 user message 文本。
 */
function buildInjectMessage(operations: string[]): string {
  const lines = ['[git] 用户在对话外操作了 git，请据此更新认知：']
  for (const op of operations) {
    lines.push(`  · ${op}`)
  }
  lines.push('；请勿重复这些操作')
  return lines.join('\n')
}

// ── Git 面板 RPC 的 git 命令执行辅助（shell:false，三平台安全）──────────

/**
 * 在目录下跑一个 git 子命令，返回 stdout + stderr + ok。
 *
 * 与 git-primitives.ts 的 `runGit` 不同：本函数是 host 侧 RPC 专用的异步包装，
 * 供面板 RPC 直接调（不经过 git-primitives 的同步路径）。
 * `spawn` 一律 `shell:false`（三平台安全：argv 原样传，不走 shell 解释，
 * 分支名/路径含非 ASCII 也不会被 shell 吃掉——PR #245 同类修复）。
 */
function runGitText(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; text: string }> {
  return new Promise(resolve => {
    const child = spawn('git', [...gitSafeDirectoryArgs(cwd), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', () => resolve({ ok: false, stdout: '', stderr: 'spawn failed', text: '' }))
    child.on('exit', code => {
      const ok = code === 0
      resolve({ ok, stdout: stdout.trim(), stderr: stderr.trim(), text: stdout.trim() })
    })
  })
}

/**
 * 插件 apply（cordis 装配点）：new 出 GitCoreService 挂到 host ctx，
 * 并注册 `agent/pre-step` 监听器（一次性注入待投递的 git 操作）。
 * cordis.patch.yml 的 insert 段挂载行使本 apply 运行（immediately）。
 * @param ctx - host cordis context。
 */
export function apply(ctx: Context): void {
  new GitCoreService(ctx)
  // agent/pre-step：在用户发新消息时，把待注入的 git 操作追加为一条 user message。
  // 照 corum-goal-round-driver:491 的范式：判断是否是新用户轮次 → 注入 → 一次性清空。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const sessionId = String(agent.session.id)
    const ops = pendingGitOperations.get(sessionId)
    // 无待注入操作 → 直接放行。
    if (ops === undefined || ops.length === 0) return next()
    // 判断是否是新用户轮次：messages 里有用户消息（source.kind === 'user'）。
    // pre-step 在每个 step 前触发，但我们只想在「用户发了新消息」那个 step 注入。
    // 官方 pre-step 的 messages 参数包含本轮将要处理的 step 的消息列表。
    const hasUserMessage = messages.some(m => m.role === 'user' && (m.source === undefined || m.source.kind === 'user' || m.source.kind === 'git-panel'))
    if (!hasUserMessage) return next()
    // 追加注入消息到 messages。
    const injectText = buildInjectMessage(ops)
    messages.push(createUserMessage({
      content: [{ type: 'text', text: injectText }],
      source: { kind: 'git-panel' },
    }))
    // 一次性投递：注入后清空。
    pendingGitOperations.delete(sessionId)
    // 放行让 Agent 处理（含注入的消息）。
    const decision = await next()
    if (signal.aborted) return decision
    return decision
  })
  // 跟踪「哪些工作区正有 agent 在跑」，供 switchBranch / commitFiles 的 idle 门禁。
  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = String(agent.session.id)
    if (status === 'running') {
      const cwd = agent.session.header.cwd
      if (cwd === undefined) runningWorkspaces.delete(sessionId)
      else runningWorkspaces.set(sessionId, cwd)
    } else {
      runningWorkspaces.delete(sessionId)
    }
  })
}
