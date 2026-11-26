/**
 * Git 面板的数据契约（与 host 侧 `GitCoreService` 的 RPC 返回同构）。
 *
 * host 半（corum-git-core）经 `@Remote` 暴露 `panelStatus` / `listBranches` /
 * `listChanges` / `recentLog` / `switchBranch` / `commitFiles`，client 经
 * `ctx.remote.call('gitCore', ...)` 调用。
 */

/** 分支信息。 */
export interface BranchInfo {
  /** 分支名。 */
  name: string
  /** 是否当前分支。 */
  current: boolean
  /** 最后提交的相对时间（如「3 天前」）。 */
  lastCommitRelative: string
}

/** 未提交文件条目。 */
export interface ChangeEntry {
  /** 文件路径。 */
  path: string
  /** git status 标记（M / A / D / ?? 等）。 */
  status: string
  /** 新增行数。 */
  added: number
  /** 删除行数。 */
  deleted: number
}

/** 面板状态快照（panelStatus + listBranches + listChanges 合并拉取）。 */
export interface GitPanelData {
  /** 当前分支名。 */
  branch: string
  /** ahead（领先 upstream 多少个提交）。 */
  ahead: number
  /** behind（落后 upstream 多少个提交）。 */
  behind: number
  /** upstream 名称（null = 无 upstream）。 */
  upstream: string | null
  /** 是否是 git 仓库。 */
  isRepo: boolean
  /** 分支列表。 */
  branches: BranchInfo[]
  /** 未提交文件列表。 */
  changes: ChangeEntry[]
}
