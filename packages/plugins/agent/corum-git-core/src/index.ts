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
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { gitSafeDirectoryArgs } from '@corum/corum-platform'
import {
  ensureRepo,
  initRepo,
  isGitRepo,
} from './git-primitives.ts'

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
    const records = porcelain.text.split('\0').filter(r => r !== '')
    const files: { path: string; status: string; added: number; deleted: number }[] = []
    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      const status = record.slice(0, 2)
      let file = record.slice(3)
      // 重命名行：R  old -> new，取新路径（old 在下一行记录里已被 git -z 合并）
      if (/[RC]/.test(status)) {
        // porcelain -z 格式：重命名时 record 含 old -> new（用 \t 分隔）
        const renameParts = file.split('\t')
        file = renameParts[renameParts.length - 1] ?? file
      }
      // 取增删行数
      const numstat = await runGitText(path, ['diff', '--numstat', '--', file])
      let added = 0
      let deleted = 0
      if (numstat.ok && numstat.text !== '') {
        const parts = numstat.text.split('\t')
        added = parts[0] === '-' ? 0 : (Number(parts[0]) || 0)
        deleted = parts[1] === '-' ? 0 : (Number(parts[1]) || 0)
      }
      files.push({ path: file, status: status.trim(), added, deleted })
    }
    return { files }
  }

  /**
   * 最近提交列表。
   * @param path - 工作区目录。
   * @param count - 返回条数（默认 10）。
   */
  @Remote('recentLog')
  async recentLog(path: string, count = 10): Promise<{
    commits: { hash: string; subject: string; author: string; relativeDate: string }[]
  }> {
    const raw = await runGitText(path, [
      'log', `--max-count=${count}`,
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
   * 切换分支（仅 Agent 空闲时可用——idle 校验由 UI 侧 `useSession(s => s.running)` 做）。
   * @param path - 工作区目录。
   * @param branch - 目标分支名。
   */
  @Remote('switchBranch')
  async switchBranch(path: string, branch: string): Promise<{ success: boolean; error?: string }> {
    const result = await runGitText(path, ['checkout', branch])
    if (!result.ok) return { success: false, error: result.stderr }
    return { success: true }
  }

  /**
   * 提交选定文件（提交信息由调用方拼好传入，不调 LLM）。
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
    // git add 指定文件
    const addResult = await runGitText(path, ['add', '--', ...files])
    if (!addResult.ok) return { success: false, error: addResult.stderr }
    // commit
    const commitResult = await runGitText(path, [
      '-c', 'user.name=corum',
      '-c', 'user.email=corum@localhost',
      'commit', '--no-verify', '-m', message,
    ])
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
}
