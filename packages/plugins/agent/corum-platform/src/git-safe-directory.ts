/**
 * Windows「git dubious ownership」对策 —— 在**不改用户全局配置**的前提下让
 * corum 能操作工作区仓库。
 *
 * ## 问题（2026-10-12 用户在真机踩到）
 *
 * Windows 上 git 有 `safe.directory` 检查：仓库的**工作区根目录**属主与当前用户
 * 不一致时，**所有** git 命令一律 `fatal: detected dubious ownership`（exit 128）。
 * 用户实测原文：
 *
 * ```
 * gateway/internal: git initial commit failed (exit 128): fatal: detected dubious ownership
 *   in repository at 'F:/work/agent'
 *   'F:/work/agent' is owned by: USER-20231001WG/Administrator (S-1-5-21-…-500)
 *   but the current user is:          USER-20231001WG/remote      (S-1-5-21-…-1007)
 * ```
 *
 * ## 三个**必须知道**的判定细节（都是实测得出，别凭直觉改）
 *
 * 1. **检查看的是「工作区根」的属主，不是 `.git/` 的属主。**
 *    实测 `F:\work\agent` 属主 = `Administrator`，而它下面 `.git/` 属主 = `remote`
 *    （`git init` 是 `remote` 跑的）。结果**照样被拒**。
 * 2. **`git init` 本身不会被拦，第一个 `commit` 才会。**
 *    （同一实测：`init` 成功、`add` 成功、`commit` exit 128。）⇒ 症状是
 *    「工作区看起来建好了，但 corum 报初始 commit 失败」。
 * 3. **新建的目录不出问题**：`remote` 自己创建的目录属主就是 `remote`，检查通过。
 *    ⇒ 只有「**预存在的、属于别的用户的目录**」会炸——这恰好是用户把已有工作区
 *    加进 corum 的常见场景，也是最不该失败的场景。
 *
 * ## 为什么不能靠用户的全局配置
 *
 * 该机的 `Administrator` 有 `safe.directory = *`，但**那是每用户配置**：
 * 应用实际以 `remote` 运行，而 `C:\Users\remote\.gitconfig` **根本不存在**
 * （实测），所以那条豁免完全帮不上。⇒ 让用户自己去 `git config --global` 不是
 * 可交付的修法（应用装到哪台机器、以谁的身份跑都不确定）。
 *
 * ## 修法：`-c safe.directory=<目录>`，**逐次注入、只放行该目录**
 *
 * 用命令行 `-c` 把豁免限定在**本次调用要操作的那个仓库根**，不写任何持久配置：
 * 既不碰用户的 global/local config，也不像 `safe.directory=*` 那样把 git 这层
 * 保护整个关掉（那会让「别人的仓库被当自己的执行」这类攻击重新可行）。
 *
 * ⚠️ **只对 Windows 注入**：POSIX 上 git 的所有权语义不同（`safe.directory` 在
 * 那边主要防的是 root/容器的属主漂移），而 macOS/Linux 上本仓既有行为正常——
 * 不引入无谓的行为变化（三平台纪律：改一处要问另两处会不会变）。
 *
 * ## 覆盖边界（**别夸大**）
 *
 * 覆盖的是 git 的**工作区检查**。若某个调用操作的是 `--git-dir` 指向的 **bare
 * 仓库**（如 review 的影子仓库），该目录本身不是工作区，注入不产生副作用、也不
 * 解决问题——那类路径的所有权问题需另行确认（当前无实测证据表明它会失败）。
 *
 * @module corum-platform/git-safe-directory
 */

/** git 的 `safe.directory` 豁免值，按目录逐次注入用。 */
export interface GitSafeDirectoryOptions {
  /** 要操作的工作区（仓库）根目录；`undefined` 表示调用方拿不到根（则不注入）。 */
  readonly worktreeRoot?: string
}

/**
 * 是否需要在 git 调用上注入 `safe.directory` 豁免。**仅 Windows**（见模块头）。
 * @returns Windows 上返回 `true`。
 */
export function needsGitSafeDirectory(): boolean {
  return process.platform === 'win32'
}

/**
 * 把 `-c safe.directory=<root>` 前缀插到 git 参数前面（**仅 Windows**，其它平台原样返回）。
 *
 * 用法（注意：`-c` 必须出现在**子命令之前**，这是 git 的参数解析规则）：
 *
 * ```ts
 * spawn('git', [...gitSafeDirectoryArgs(worktreeRoot), 'status', '--porcelain'], { cwd })
 * ```
 *
 * 对已是「以 `-C`/`--git-dir` 起头」的调用同样适用——`-c` 与它们同属全局选项，
 * 顺序上 `-c` 在前即可。
 *
 * ⚠️ `safe.directory` 的**值必须是 git 能识别的路径形态**：Windows 上传
 * `F:\work\agent` 与 `F:/work/agent` 都可（git 自己会归一），但**不要**传
 * `file://` URL 或带引号的字符串（会被当成字面量路径而匹配不上）。
 * 也**不要**转义反斜杠——`-c` 走 argv 不经 shell，无需转义。
 *
 * @param worktreeRoot - 工作区根目录绝对路径；`undefined`/空串则不注入（调用方拿不到根时宁可少注入，也不要注入一个错的路径把豁免浪费掉）。
 * @returns 要拼在 git 参数最前面的数组（不需要时为空数组）。
 */
export function gitSafeDirectoryArgs(worktreeRoot?: string): string[] {
  if (!needsGitSafeDirectory()) return []
  if (typeof worktreeRoot !== 'string' || worktreeRoot.trim() === '') return []
  // 归一为 git 惯用的正斜杠形态（Windows 上也接受反斜杠，但正斜杠能避免
  // 后续被任何一层当转义序列处理；且与 git 自己打印的 `F:/work/agent` 一致）。
  const normalized = worktreeRoot.replace(/\\/g, '/')
  // 单个目录：`safe.directory=<path>`。刻意**不用** `*`（见模块头 §修法）。
  return ['-c', `safe.directory=${normalized}`]
}

/**
 * 给一个已在运行的 git 命令行补上「子目录也要能解析」的豁免。
 *
 * 为什么需要：`safe.directory` 的匹配是**按路径精确/前缀**的。corum 有些调用
 * 在仓库的**子目录**里跑（worktree 子目录、工作区内的相对 cwd），而 git 判定
 * 「dubious ownership」时用的是该仓库的**工作区根**。注入根的路径即可覆盖
 * 子目录调用（git 会把 cwd 上溯到根再比对），故**不需要**为每个子目录单独放行。
 *
 * 本函数存在的意义是把这条推理写进代码，避免后人「顺手把 cwd 也加进去」而
 * 把豁免列表撑大（每多一条就多一分攻击面）。
 *
 * @param worktreeRoot - 该仓库的工作区根。
 * @returns 与 {@link gitSafeDirectoryArgs} 相同。
 */
export function gitSafeDirectoryArgsForRepo(worktreeRoot?: string): string[] {
  return gitSafeDirectoryArgs(worktreeRoot)
}
