/**
 * @corum/corum-git-core — git 管理的核心机制（corum 核心插件，**不可卸载**）。
 *
 * ## 定位（用户 2026-09-16 策略）
 *
 * ① 将所有 git 管理的机制收进**一个独立插件**（git-core）；
 * ② 四条机制级不变式（invariant.workspace-git-required / commit-after-modification /
 *    background-parallel-isolated / merge-strategy）均**基于本插件提供的能力**完成；
 * ③ 本插件为 **corum 核心插件，不可卸载**。
 *
 * ## 本模块（git-primitives）——cordis-free 的 git 原语（纯函数，无 cordis import）
 *
 * 与 desktop host 的 `corum-git.ts` 同源（其能力迁入本插件，desktop 不再手动 new），
 * 但抽成纯函数层以便：① 被 cordis 服务包装（host RPC + 同进程直调两用）；
 * ② 被 host 创建入口（createAgentForTask / openProject）作**强制前置**直调——
 * 不变式①「工作区必须有 git 参考」要求创建入口**机制保证**「探测，没有就初始化」，
 * 而不是靠 UI 层自觉调用（旧缺口的根因，见 invariant.workspace-git-required）。
 *
 * 纪律：本文件保持 cordis-free（纯库），cordis 服务面由 index.ts 声明。
 * @module corum-git-core/git-primitives
 */

import { realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

/** 在目录下跑一个 git 子命令；exit code / stdout / stderr 全回（不抛）。 */
function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** realpath 归一目标目录（symlink/.. 解析），不存在则抛错。 */
function resolveDir(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('path must be a non-empty absolute directory path')
  }
  return realpathSync(path)
}

/**
 * 侦测目录是否是 git 仓库（含 worktree/子目录——`git rev-parse --git-dir` 在
 * 仓库任意子目录都成功）。git 未安装/目录不可读等按非仓库处理（返回 false）。
 * @param path - 任意绝对目录路径。
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const dir = resolveDir(path)
  try {
    const { code } = await runGit(dir, ['rev-parse', '--git-dir'])
    return code === 0
  } catch {
    return false
  }
}

/**
 * 保证 `.gitignore` 含 `.corum-worktrees/`（机制运行时产物的 ignore）。
 *
 * 为什么机制必须自己写（2026-09-16 用户定调）：orchestrate 的隔离 worktree 建在
 * `<cwd>/.corum-worktrees/` 下，若该目录未被 ignore，第二个并行任务的
 * `corumDirtyParentRefusal` 会把 `?? .corum-worktrees/`（任务 1 刚建的 worktree）
 * 当成「父树未提交改动」而**拒绝隔离**——导致「第二个并行任务从未 spawn」（Bug A）。
 * 靠 LLM 每次手动 ignore（e2e-a 的 `5580492`）不可持续 ⇒ 机制在 init 时**默认写好**。
 *
 * 幂等：.gitignore 已含该行（任意位置，含无尾换行的文件末尾）则不动；
 * 不存在则新建、存在但缺该行则**追加**（不覆盖用户既有内容）。
 *
 * **导出原因**（2026-09-16 不变式⑤配套）：本函数原先只在 {@link initRepo} 调用，
 * 于是只对「corum 自己 init 的仓库」生效。用户**既有**仓库（手动 init / clone）若没有
 * 这一行，第一个 worktree 建好后 `.corum-worktrees/` 会以 `?? .corum-worktrees/` 出现在
 * `porcelain` 里 ⇒ **下一个**委派的 `corumDirtyParentRefusal` 必被拒（实测复现）。
 * 隔离改为「写委派恒隔离」后每次委派都过那道门，这个缺口会被放大成「第二次起必被拒」，
 * 故 `createWorktreeChild` 建目录前也调用本函数（而不是只在 init 时写）。
 *
 * @param dir - 已 realpath 归一的目录（主树根）。
 * @returns `true` = 本次写入了 ignore 行（调用方通常随即把它提交掉）；`false` = 已存在，无需改。
 */
export function ensureWorktreeGitignore(dir: string): boolean {
  const file = join(dir, '.gitignore')
  const line = '.corum-worktrees/'
  if (existsSync(file)) {
    const content = readFileSync(file, 'utf8')
    // 已含该行（精确匹配整行，避免误配 `.corum-worktrees-foo/` 之类）。
    if (content.split('\n').some(l => l.trim() === line)) return false
    // 追加（保证前一行有换行；空文件/无尾换行都安全）。
    const prefix = content === '' || content.endsWith('\n') ? '' : '\n'
    writeFileSync(file, `${content}${prefix}${line}\n`)
    return true
  }
  writeFileSync(file, `# corum 编排隔离 worktree 的运行时产物（机制自动写入，勿入库）\n${line}\n`)
  return true
}

/**
 * 初始化 git 仓库：`git init` + 一个空初始 commit。
 *
 * 必须带初始 commit：worktree/分支需要至少一个 commit 才能创建（空仓库
 * `git worktree add <path> -b <branch>` 会失败，隔离仍不可用）。空 commit 不
 * 触碰用户的任何文件（`--allow-empty`），保持最小侵入；`-c user.name/email`
 * 一次性身份不写用户的 global/local config。
 *
 * 幂等：已是仓库时直接返回 alreadyRepo:true（不重复 init/commit）。
 * @param path - 任意绝对目录路径。
 */
export async function initRepo(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
  const dir = resolveDir(path)
  if (await isGitRepo(dir)) return { initialized: false, alreadyRepo: true }

  const initResult = await runGit(dir, ['init'])
  if (initResult.code !== 0) {
    throw new Error(`git init failed (exit ${initResult.code}): ${initResult.stderr || 'no stderr'}`)
  }
  // 机制默认写 .gitignore（.corum-worktrees/）——否则第二个并行任务会被判脏拒掉（Bug A）。
  // 在初始 commit **之前**写，让 ignore 进首个 commit（自身不会成为未提交改动）。
  ensureWorktreeGitignore(dir)
  // 初始 commit 顺带把 .gitignore 收进去（`--allow-empty` 是空 commit，不会自动 add；
  // 先 add .gitignore 再 commit，让 worktree 产物从第一个 commit 起就被 ignore）。
  const addResult = await runGit(dir, ['add', '.gitignore'])
  if (addResult.code !== 0) {
    throw new Error(`git add .gitignore failed (exit ${addResult.code}): ${addResult.stderr || 'no stderr'}`)
  }
  const commitResult = await runGit(dir, [
    '-c', 'user.name=corum',
    '-c', 'user.email=corum@localhost',
    'commit', '--allow-empty', '-m', 'chore: initial commit',
  ])
  if (commitResult.code !== 0) {
    throw new Error(`git initial commit failed (exit ${commitResult.code}): ${commitResult.stderr || 'no stderr'}`)
  }
  return { initialized: true, alreadyRepo: false }
}

/**
 * 保证目录是一个 git 仓库：已是仓库则原样返回，否则 `git init` + 初始 commit。
 *
 * 这是**产品策略的唯一落点**（2026-09-11 用户定调 + 2026-09-16 不变式①）：
 * corum 不提供「是否初始化 git」开关——工作区/任务/项目的创建**机制保证**
 * 「探测，没有就初始化」。host 创建入口一律调本函数作强制前置（不靠 UI 自觉）。
 *
 * @param path - 任意绝对目录路径。
 * @returns `initialized` 表示本次是否真的创建了仓库。
 */
export async function ensureRepo(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
  return await initRepo(path)
}

/* ── 不变式②原语：收口强制提交（commit-after-modification）────────────── */

/** 同步跑一个 git 子命令（execFileSync；exit 0 回 stdout，否则带 stderr/code）。 */
function runGitSync(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
    return { code: 0, stdout: stdout.trim(), stderr: '' }
  } catch (error: unknown) {
    const stderr = (error as { stderr?: Buffer | string }).stderr
    return { code: 1, stdout: '', stderr: stderr === undefined ? String(error) : String(stderr) }
  }
}

/** 目录是否有未提交改动（`git status --porcelain` 非空；非 git/目录不存在返回 false）。 */
export function hasUncommittedChanges(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return runGitSync(path, ['status', '--porcelain']).stdout !== ''
  } catch {
    return false
  }
}

/**
 * fork（corum）：**永不提交的产物路径模式**——机制级排除清单（不依赖项目 .gitignore）。
 *
 * 用户 2026-10-08 定调：`.gitignore` 理论上已经覆盖了 `lib/` `dist/` `build/`
 * `node_modules/` 等，但实测 `packages/desktop/main.js`（2391 行的打包产物）**仍然
 * 进了 git 历史**——因为根 .gitignore 只列了 lib/ 没列通配 main.js，而桌面壳
 * 的 tsdown 产物恰好叫 `main.js` 不是 `lib/main.js`。靠 `.gitignore` 逐项目维护不可靠
 * （产物名可能不在标准模式里），故机制在判定层再加一道**硬排除**。
 *
 * 这道排除只在「收口提交」与「有效修改判定」的路径上生效（即 turn-stopping 的
 * hasEffectiveChanges 检查与 settleCommit 的 git add），不影响用户手动 `git add`
 * 指定路径（那是用户自己的决定）。
 *
 * 排除清单（glob 后缀匹配，对路径任意深度生效）：
 *   - `lib/`、`dist/`、`build/` —— 标准产物目录
 *   - main.js —— 桌面壳打包产物（tsdown 输出，不是源码；任意深度匹配）
 *   - `*.tsbuildinfo` —— TS 增量编译信息
 *   - `node_modules/` —— 依赖（虽通常已 ignore，双保险）
 */
const ARTIFACT_EXCLUDE_PATTERNS: readonly string[] = [
  'lib/',
  'dist/',
  'build/',
  'main.js',
  '.tsbuildinfo',
  'node_modules/',
]

/**
 * 判定一个 porcelain 行里的路径是否是产物（应被排除）。
 *
 * porcelain 行形如 `?? path/to/file` 或 ` M path/to/file` 或 `R  old -> new`。
 * 只需检查路径部分是否命中排除模式（后缀匹配）。
 *
 * @param filePath - 从 porcelain 行提取的文件路径。
 * @returns true = 是产物路径，应排除。
 */
function isArtifactPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  for (const pattern of ARTIFACT_EXCLUDE_PATTERNS) {
    if (pattern.endsWith('/')) {
      // 目录模式：路径以 `dir/` 开头（任意深度），或路径等于 `dir`
      if (normalized === pattern.slice(0, -1)) return true
      if (normalized.startsWith(pattern) || normalized.startsWith(pattern.slice(0, -1) + '/')) return true
    } else {
      // 文件/后缀模式：路径以该模式结尾
      if (normalized.endsWith(pattern)) return true
    }
  }
  return false
}

/**
 * 从 `git status --porcelain` 的原始输出中提取**非产物**的改动行。
 *
 * 先跑 porcelain 取全部改动，再逐行过滤掉产物路径。这样 hasEffectiveChanges
 * 只在「有真实源码改动」时返回 true，产物变化不算。
 *
 * @param path - 目标 git 工作区。
 * @returns 非产物改动行数组（空 = 无有效修改）。
 */
function effectiveChangeLines(path: string): string[] {
  if (!existsSync(path)) return []
  let porcelain = ''
  try {
    porcelain = runGitSync(path, ['status', '--porcelain']).stdout
  } catch {
    return []
  }
  if (porcelain === '') return []
  return porcelain.split('\n').filter(line => {
    const trimmed = line.trim()
    if (trimmed === '') return false
    // porcelain 行的路径在 index 2 之后（`XY path`）；重命名行含 ` -> `，取新路径。
    const pathPart = trimmed.slice(3).replace(/^"|"$/g, '')
    const filePath = pathPart.includes(' -> ')
      ? pathPart.split(' -> ')[1].replace(/^"|"$/g, '')
      : pathPart
    return !isArtifactPath(filePath)
  })
}

/**
 * fork（corum）：**有效修改**判定——收口提交（turn-end / 隔离前）的唯一准入条件。
 *
 * 用户 2026-09-18 定调（原话）：「**除了 .gitignore 中的之外，只要修改了就算有效**。
 * 当然 Agent 可以自己 check，有额外的可手动剔除并更新 .gitignore」。
 * 2026-10-08 补充：产物路径（lib/dist/build/main.js 等）也一律不算有效修改——
 * 它们是打包产物，不该进 git，机制在判定层硬排除（不依赖项目 .gitignore）。
 *
 * 规则：
 *   · **`.gitignore` 覆盖的路径不算有效修改**——而 git 的 `--porcelain` 本来就**不列**
 *     ignored 文件。
 *   · **产物路径不算有效修改**——lib/ dist/ build/ main.js（任意深度）
 *     *.tsbuildinfo node_modules/（机制硬排除，见 {@link ARTIFACT_EXCLUDE_PATTERNS}）。
 *   · **其余任何改动都算**：已跟踪文件的修改/删除/重命名，以及**未跟踪的新文件**。
 *
 * 与 {@link hasUncommittedChanges} 的分工：后者是**纯 git 事实**（porcelain 非空），
 * 本函数是**机制策略**（「什么样的改动值得为它落一条提交」）。
 *
 * 为什么它是机制兜底而不是可选项：没有它，每轮对话都会留下一条**没有内容的**提交。
 * 实测全库 **0 个空提交**，正是靠这道判断在 `settleCommit` 里挡住了空跑。
 *
 * @param path - 目标 git 工作区。
 * @returns true = 有值得提交的有效修改（非产物）。
 */
export function hasEffectiveChanges(path: string): boolean {
  return effectiveChangeLines(path).length > 0
}

/**
 * fork（corum）：获取工作区的 **diff --stat 摘要**（排除产物路径），供提交卡片展示。
 *
 * 返回 porcelain 行的非产物部分（每行 `XY path`），最多取前 N 行，并统计总改动文件数。
 *
 * @param path - 目标 git 工作区。
 * @param maxLines - 最多返回的改动行数（默认 3）。
 * @returns 摘要信息：改动行 + 总文件数（含产物） + 非产物文件数。
 */
export function diffStatSummary(path: string, maxLines = 3): {
  lines: string[]
  totalFiles: number
  effectiveFiles: number
} {
  if (!existsSync(path)) return { lines: [], totalFiles: 0, effectiveFiles: 0 }
  let porcelain = ''
  try {
    porcelain = runGitSync(path, ['status', '--porcelain']).stdout
  } catch {
    return { lines: [], totalFiles: 0, effectiveFiles: 0 }
  }
  const allLines = porcelain.split('\n').filter(l => l.trim() !== '')
  const effective = effectiveChangeLines(path)
  return {
    lines: effective.slice(0, maxLines),
    totalFiles: allLines.length,
    effectiveFiles: effective.length,
  }
}

/** 强制提交失败的结构化原因（供上层注入通知/阻断）。 */
export interface SettleCommitFailure {
  path: string
  reason: string
}

/**
 * 不变式②的核心原语：**收口强制提交**——把目录里未提交的改动就地提交
 * （`git add -A` + `git commit --no-verify`）。
 *
 * 与 orchestration 的 `corumCommitWorktreeOnSettle`（隔离 worktree 专用）同源，但
 * **不绑定 worktree**——任意 git 目录可用：主 Agent 在父树直接改 / 单发前台写任务
 * 在父树写，turn-end 收口时同样强制提交（用户 2026-09-15 裁定「每次工作结束必须
 * 提交，机制保证而非 Agent 自觉」对所有 Agent 生效，不只隔离 worktree）。
 *
 * 提交用 `-c user.name/email` 一次性身份（不写用户的 global/local config）；
 * `--no-verify` 防宿主钩子拦下（钩子失败会让「必须提交」失效）。
 *
 * ⚠️ **两道「不留噪声」的保证**（2026-09-18 用户定调，通用兜底、非本仓专属）：
 *   ① 准入用 {@link hasEffectiveChanges}——**没有有效修改就不提交**。否则每轮对话
 *      都会留下一条没有内容的提交（`.gitignore` 之外的任何改动才算有效修改）。
 *   ② 这里**绝不传 `--allow-empty`**：git 对「无改动」会自行拒绝提交，等于多了一道
 *      与 ① 独立的底。实测全库 **0 个空提交**即这两道的结果。改本函数时不要加
 *      `--allow-empty`（`--allow-empty` 在本仓只允许出现在**建仓初始化**那一处）。
 *
 * @param path - 目标 git 目录（父树主工作区）。
 * @param subject - 提交信息首行（含溯源，如 `wip(<scope>): auto-commit on settle`）。
 * @returns `undefined` = 成功或无需提交（干净/目录不存在/非 git）；否则为失败原因。
 */
export function settleCommit(path: string, subject: string): SettleCommitFailure | undefined {
  if (!existsSync(path)) return undefined
  if (!hasEffectiveChanges(path)) return undefined
  // fork（corum）2026-09-27（用户裁定）：**独立嵌套 git 仓不进本仓的自动提交**——见
  // {@link independentRepoPathsOf} 记录的那两次实测污染（gitlink 幽灵 submodule + 36 个
  // 闭源文件进了开源仓历史）。有它时用 `:(exclude)` 逐条排除，并在提交信息里点名。
  const independent = independentRepoPathsOf(path)
  // fork（corum）2026-10-08：**产物路径不进收口提交**——lib/ dist/ build/
  // main.js（任意深度）tsbuildinfo node_modules/ 一律用 :(exclude) 挡在 git add 之外
  // （见 {@link ARTIFACT_EXCLUDE_PATTERNS}）。实测 packages/desktop/main.js 曾误入 git。
  // 每个模式生成两条排除项：根级（main.js）+ 通配（*/main.js），确保任意深度都命中。
  const artifactExcludes: string[] = []
  for (const pattern of ARTIFACT_EXCLUDE_PATTERNS) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
    artifactExcludes.push(`:(exclude)${name}`)
    artifactExcludes.push(`:(exclude)*/${pattern}`)
    artifactExcludes.push(`:(exclude)*/${name}`)
  }
  const allExcludes = [...independent.map(dir => `:(exclude)${dir}`), ...artifactExcludes]
  const added = runGitSync(path, allExcludes.length === 0
    ? ['add', '-A']
    : ['add', '-A', '--', '.', ...allExcludes])
  if (added.code !== 0) return { path, reason: `git add failed: ${added.stderr.trim()}` }
  // 纵深兜底：即便排除没命中（嵌套仓此前已被跟踪、或形态超出词法判据），也绝不让一条
  // **gitlink**（mode 160000）进入收口提交——它是「另一个仓的指针」，不是本仓的文件。
  const gitlinks = stagedGitlinkPathsOf(path)
  if (gitlinks.length > 0) {
    runGitSync(path, ['rm', '--cached', '-q', '--', ...gitlinks])
  }
  const message = independent.length === 0 && gitlinks.length === 0
    ? subject
    : `${subject}\n\nExcluded from this commit — independent nested git repositories are separate artifacts, not part of this one: ${[...independent, ...gitlinks].join(', ')}`
  const committed = runGitSync(path, [
    '-c', 'user.name=corum',
    '-c', 'user.email=corum@localhost',
    'commit', '--no-verify', '-m', message,
  ])
  if (committed.code === 0) return undefined
  return { path, reason: `git commit failed: ${committed.stderr.trim()}` }
}

/**
 * fork（corum）2026-09-27：工作区里**独立嵌套 git 仓**的顶层路径（收口提交要排除的对象）。
 *
 * ## 为什么必须排除（实测：一次 gitlink 污染 + 一次真正的历史泄漏）
 *
 * `git add -A` 遇到「目录里有自己的 `.git`」时**不递归**，而是把它记成一条 **gitlink**
 * （mode 160000，submodule 指针）。实测（会话 `corum-task-56b7d485`）：
 *   · `cdb58d5 wip(isolated): auto-commit on settle` 把子 Agent 在 worktree 里新建的闭源仓
 *     记成 gitlink；随后 `dcf5082 port wt/wt-471e5f` 把它搬进**开源仓主树的索引**（一条连
 *     `.gitmodules` 都没有的幽灵 submodule）；
 *   · `456d3ef` 更严重：同一个机制把剥离产物的 **36 个文件**提交进了开源仓，进了 `main`
 *     的祖先链——后来只能 `git filter-repo` 重写未推送段的历史才清掉。
 *
 * 用户 2026-09-27 裁定：**嵌套新仓是独立产物**——子 Agent 建它、处理它、上报它，之后主
 * Agent 再针对**那个仓**派隔离子 Agent。它不该被父仓的自动提交收编 ⇒ 本函数把它们找出来，
 * 交给 {@link settleCommit} 排除并在提交信息里点名（可追责、可追溯）。
 *
 * 判据刻意只认「**未跟踪**的顶层目录 + 其下有 `.git`」：已跟踪的 gitlink 属历史遗留状态，
 * 由集成侧另一道（`corumPortBranchDiff` 拒收仍带 gitlink 的分支）负责，不在这里静默改写索引。
 *
 * @param path - 目标 git 工作区。
 * @returns 相对路径（去尾斜杠）数组；无独立仓时为空数组。
 */
export function independentRepoPathsOf(path: string): string[] {
  if (!existsSync(path)) return []
  let porcelain = ''
  try {
    porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return []
  }
  const found = new Set<string>()
  for (const line of porcelain.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('??')) continue
    const target = text.slice(2).trim().replace(/^"|"$/g, '').replace(/\/+$/, '')
    // 只看顶层条目：`-unormal` 对含 `.git` 的目录只列顶层一行；带斜杠的条目属于更深层。
    if (target === '' || target.includes('/')) continue
    if (existsSync(join(path, target, '.git'))) found.add(target)
  }
  return [...found]
}

/**
 * 已被 add 进索引的**gitlink**（mode 160000）路径（收口提交的纵深兜底）。
 * @param path - 目标 git 工作区。
 * @returns 路径数组（`git diff --cached --raw` 里 old/new 任一模式为 160000）。
 */
function stagedGitlinkPathsOf(path: string): string[] {
  try {
    const raw = execFileSync('git', ['diff', '--cached', '--raw'], {
      cwd: path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: string[] = []
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text.startsWith(':')) continue
      const [meta, file] = text.split('\t')
      const fields = (meta ?? '').slice(1).split(' ')
      if (fields[0] !== '160000' && fields[1] !== '160000') continue
      if (file !== undefined && file !== '') out.push(file)
    }
    return out
  } catch {
    return []
  }
}

/**
 * 目录是否处于**未结清的合并/重放中**（`MERGE_HEAD` 存在）。
 *
 * 由来（2026-09-16 实机）：集成门禁把 persona 改成「先 `git merge --no-commit` 合、验完再提交」
 * 以后，verify 失败被拒时主树会**停在一个未结清的合并现场**——`fatal: You have not concluded
 * your merge (MERGE_HEAD exists)` 会让后续**每一次** merge/commit 失败，包括下一轮 orchestrate
 * 的集成者与 turn-end 收口。这既毒化后续判定，也让「保留现场」变成「卡死工作区」。
 *
 * 判据只用 git 自己的状态文件语义（`git rev-parse --verify -q MERGE_HEAD`），不猜、不看输出文案；
 * 非 git / 目录不存在 / 无合并 → false。
 * @param path - 目标 git 目录（主树）。
 */
export function mergeInProgress(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return runGitSync(path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).code === 0
  } catch {
    return false
  }
}

/**
 * **放弃未结清的合并**（`git merge --abort`）——把工作区从「合并中」态解出来。
 *
 * ## 为什么这是**安全**的（与 persona 那条破坏性 git 禁令不冲突）
 *
 * persona 明禁 `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash`：那些会
 * **丢掉主树里与本轮无关的在制品**。`git merge --abort` 的语义不同——它只回退**本次合并**
 * 引入的暂存/工作区改动，把它们还原到合并前状态；合并前的未提交在制品不被丢弃。
 *
 * ## 何时调用（调用方纪律）
 *
 * 只在**集成已被机制拒绝**时调用，且**必须**在「本轮的改动已经不可能靠这次合并落地」之后：
 * 被拒的分支提交仍在分支上（唯一副本，分支从未删除），所以放弃这次未结清的合并**不会丢工作**
 * ——它只是把「半合进去但没提交」的暂存态还原，让工作区回到可继续操作的状态。反之，把
 * `MERGE_HEAD` 留着会让后续每一条 merge/commit 都失败（实测）。
 *
 * @param path - 目标 git 目录（主树）。
 * @returns `undefined` = 成功或本就无合并；否则为失败原因。
 */
export function abortMerge(path: string): SettleCommitFailure | undefined {
  if (!existsSync(path)) return undefined
  if (!mergeInProgress(path)) return undefined
  const aborted = runGitSync(path, ['merge', '--abort'])
  if (aborted.code === 0) return undefined
  return { path, reason: `git merge --abort failed: ${aborted.stderr.trim()}` }
}

/**
 * fork（corum）2026-10-08：**暂存改动**（`git stash push`）——turn-stopping 超时降级。
 *
 * 当 LLM 在 5 分钟超时内未提交干净时，机制用 `git stash push -m "wip(turn-<id>)"`
 * 把改动暂存、放行 turn（不无限阻塞）。改动不会丢失（stash 里留有副本）。
 *
 * 只暂存**非产物**改动（排除 lib/dist/build/main.js 等），与 hasEffectiveChanges 同口径。
 * 无改动时返回 undefined（幂等）。
 *
 * @param path - 目标 git 目录。
 * @param message - stash 的标签信息（如 `wip(turn-abc12345)`）。
 * @returns `undefined` = 成功或无需暂存；否则为失败原因。
 */
export function stashChanges(path: string, message: string): SettleCommitFailure | undefined {
  if (!existsSync(path)) return undefined
  if (!hasEffectiveChanges(path)) return undefined
  // 产物路径用 :(exclude) 排除，与 settleCommit 同口径（根级 + 通配双排除）
  const artifactExcludes: string[] = []
  for (const pattern of ARTIFACT_EXCLUDE_PATTERNS) {
    const name = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
    artifactExcludes.push(`:(exclude)${name}`)
    artifactExcludes.push(`:(exclude)*/${pattern}`)
    artifactExcludes.push(`:(exclude)*/${name}`)
  }
  const stashed = runGitSync(path, [
    'stash', 'push', '--include-untracked', '-m', message, '--', '.', ...artifactExcludes,
  ])
  if (stashed.code === 0) return undefined
  return { path, reason: `git stash push failed: ${stashed.stderr.trim()}` }
}
