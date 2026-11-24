/**
 * 编辑器/资源管理器的**项目根跟随**判据（纯函数，无 cordis / 无 fs）。
 *
 * 这一条曾被一个错误的读取方式坑过（2026-11 用户报「右侧编辑器和资源管理器不跟随
 * 当前工作区的选中，而是默认为最新创建的工作区目录」）：rc3 的 `ISessions.list`
 * 快照**只有** `{ ids, byId, phase, projectionsBySession }`，**没有 `current` 字段**
 * ——官方把「当前显示哪个会话」的选择权交给 view owner（corum 侧是
 * `corumNavigation.selection`）。早期实现读 `list.getSnapshot().current`，恒为
 * undefined ⇒ 每次回落 `workspaces.items[0].path`，而该数组按 `createdAt` **倒序**
 * （dsh-workspace 的 `compareHeaders`）⇒ 编辑器永远停在最新创建的那个工作区。
 *
 * 本模块把判据固定成可测的三条：
 *   ① 当前会话行**带 cwd** ⇒ 就是它（常态，最准）；
 *   ② 会话行不带 cwd（历史行 / 尚未投影）⇒ 按工作区注册表的 `sessionIds` **反查**
 *      归属工作区，**绝不取 items[0]**（那是「最新创建」，与当前对话无关）；
 *   ③ 没有当前会话 ⇒ `null`（空态）。空态比「随便挑一个工作区」诚实。
 */

/** 会话行里本判据消费的字段。 */
export interface RootSessionRow {
  readonly cwd?: string
}

/** 工作区行里本判据消费的字段。 */
export interface RootWorkspaceRow {
  readonly path: string
  readonly sessionIds?: readonly string[]
}

/** 判据输入（全部是快照读取的结果，注入进来以保持纯函数）。 */
export interface ProjectRootInputs {
  /** 当前选中会话 id（`corumNavigation.selection.sessionId`）；无选择时 undefined。 */
  readonly sessionId: string | undefined
  /** 会话行表（`sessions.list.byId`）。 */
  readonly sessionsById: Readonly<Record<string, RootSessionRow>>
  /** 工作区注册表（`workspaces.list.items`）。 */
  readonly workspaces: readonly RootWorkspaceRow[]
}

/**
 * 解析编辑器/资源管理器应指向的项目根。
 * @param inputs - 当前选择 + 两份快照。
 * @returns 工作区绝对路径；无当前会话或会话无法定位工作区时为 null（空态）。
 */
export function resolveProjectRoot(inputs: ProjectRootInputs): string | null {
  const { sessionId, sessionsById, workspaces } = inputs
  if (sessionId === undefined || sessionId === '') return null
  // ① 会话行自带 cwd —— 最直接的答案。
  const cwd = sessionsById[sessionId]?.cwd
  if (cwd !== undefined && cwd !== '') return cwd
  // ② 反查归属工作区（不取 items[0]：那是「最新创建」，不是「当前对话所属」）。
  const owner = workspaces.find(item => item.sessionIds?.includes(sessionId) === true)
  return owner === undefined || owner.path === '' ? null : owner.path
}
