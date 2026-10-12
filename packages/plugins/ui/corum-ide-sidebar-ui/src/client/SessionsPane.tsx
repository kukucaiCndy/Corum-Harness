/**
 * SessionsPane — 侧栏任务模式内容（design.pen ① 项目导航：工作区分组会话列表）。
 *
 * 布局按设计稿（V2O1D）：新会话主按钮 → 区头「工作区」（搜索/视图选项/添加工作区
 * 三按钮）→ 工作区分组行（chevron + folder + 名称 + 行尾操作）→ 组内会话行
 * （状态点 + 标题 + 相对时间）；无归属会话落「未分组」桶（无 folder 图标）。
 * 交互按官方 dsh WorkspaceBrowser：区头搜索胶囊点击展开（展开时区头标签与操作
 * 组隐藏、Escape/清除收起）、视图选项菜单（分组方式 按工作区/单列表 + 排序方式
 * 手动/最近更新）、组行 hover 显现行操作（ellipses 菜单 重命名/删除 + plus 在该
 * 工作区新建会话）、当前会话所在组自动展开、blank 会话仅当前选中时可见、
 * archived 会话一律隐藏。
 *
 * 数据全部来自运行时对象层（ctx.sessions / ctx.workspaces），不经 RPC。
 */
import { type ISessions, type SessionSearchResultItem, type SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { type WorkspaceSnapshot as WorkspaceListState, type WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Archive, ChevronRight, Download, Folder, FolderOpen, GitFork, LoaderCircle,
  MessageSquarePlus, MoreHorizontal, Pencil, Plus, Search, SlidersHorizontal,
  Sparkles, X,
} from 'lucide-react'
// 物理相对路径而非 @corum/corum-ui-base 子路径：原因同 ProjectPane.tsx（tsdown
// 跨包 css 子路径 import 错乱，相对路径才能正确抽取内联进 bundle）。
import css from '../../../corum-ui-base/src/client/sidebar.module.css'

/** Injected actions + the live feed（由 corum.sidebar.sessions 槽的 occupant 插件注入）。 */
export interface SessionsPaneInjected {
  /** The sessions standard feed (list + selection). */
  list: ISessions['list']
  /** The workspaces standard feed（分组数据源）. */
  workspaces: ObservableSnapshot<WorkspaceListState>
  open: (sessionId: SessionId) => void
  /** 新会话：带 workspaceId 在该工作区复用/新建 blank 会话；省略时继承当前会话所属。 */
  startSession: (workspaceId?: WorkspaceId) => void
  /** 顶部「新会话」主按钮：回空态 + 打开新建任务表单（选工作区/Agent/模型/权限 →
   *  开始），与空态「新建任务」卡同一流程；不直接建会话。 */
  openNewTaskForm: () => void
  search: (query: string, signal: AbortSignal) => Promise<SessionSearchResultItem[]>
  rename: (sessionId: SessionId, title: string) => Promise<void>
  /** 分叉会话：从源会话最近完成轮次切出子会话并打开（官方 fork 语义）。 */
  fork: (sessionId: SessionId) => Promise<void>
  /** 归档会话：隐藏出分组列表（日志保留；归档当前会话回新会话视图）。 */
  archive: (sessionId: SessionId) => Promise<void>
  /** 添加工作区：把一个已存在的目录注册为工作区。 */
  addWorkspace: (path: string) => Promise<void>
  /** fork（corum）：侦测目录是否 git 仓库（新建工作区的 git 依赖能力前置）。 */
  gitWorkspaceStatus: (path: string) => Promise<boolean>
  /** fork（corum）：在目录初始化 git 仓库（git init + 空初始 commit）。 */
  gitWorkspaceInit: (path: string) => Promise<{ initialized: boolean; alreadyRepo: boolean }>
  /** Host 原生目录选择器；用户取消返回 null。 */
  pickDirectory: () => Promise<string | null>
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** uiSession.pendingInteractions 快照（0.1.2 起「等待操作」pending 在此，SessionId keyed）。 */
  pendingInteractions: ObservableSnapshot<ReadonlyMap<string, { kind: string }>>
  /**
   * 保存会话日志到…（2026-09-16 用户定调把入口从右上角搬进本菜单）。
   *
   * 能力面由 `corum-session-archive` 的 cordis 服务 `sessionArchive` 提供
   * （该包 `index.ts` 的 `ctx.provide('sessionArchive', controller)`）。这里用
   * **局部能力接口**收窄、不 import 实现包 —— 与红线 3 同思路（官方基座类型面
   * 不含该服务，corum 运行时是超集；编译期类型保障、零运行时改动、不强耦合实现包）。
   *
   * ⚠️ **是「解析器」而不是「动作本身」**：调用它（每次渲染一次）才拿到保存函数；
   * 返回 `undefined` = 存档插件缺席 ⇒ 菜单项**不渲染**（不留死按钮）。之所以要多这
   * 一层，是因为槽的 inject 面被 ui-renderer **按 entry 永久缓存**（只求值一次），
   * 若把服务查找写进 inject 面内部算成常量，就会在「存档插件晚于侧栏装配」时永久
   * 冻结成缺席（插件中心可动态启停插件，这不是假想情况）。
   */
  resolveSaveSession?: (() => ((sessionId: SessionId) => Promise<void>) | undefined) | undefined
  /**
   * 会话行**项目徽标**的数据源（PR7，闭源对接点，见 {@link useProjectBadge}）。
   *
   * 开源仓拿不到「会话 → 项目」映射（项目实体/索引读取器在闭源
   * `@corum/corum-project`，会话摘要 `SessionSummary` 只有 `cwd`、无 `projectId`），
   * 故本字段**缺省 undefined ⇒ 徽标不渲染**（不留空胶囊、不报错）。闭源侧把它
   * （连同下面的 `openProjectWorkface`）加进本槽的 inject 面即可点亮徽标——
   * **加两个可选字段就行，无需改本组件**。
   */
  resolveProjectBadge?: ProjectBadgeResolver | undefined
  /**
   * 点项目徽标 → 切到该项目工作面。闭源侧注入实现为
   * `(projectId) => { sidebarModeLayout(ctx).setSidebarMode('project') }`
   * （窄化能力面写法见 `corum-ui-conversation/src/client/apply.ts` 的
   * `SidebarModeCapableLayout`，红线 3：不 import 实现包、不耦合类型）。
   *
   * 与数据源同款：缺省 undefined ⇒ 徽标不渲染（**不留死按钮**——有数据但点了
   * 没反应的胶囊比不显示更糟）。
   */
  openProjectWorkface?: ((projectId: string) => void) | undefined
}

/** 相对时间标签（2026-08-28 用户定调：中文「N 分钟/N 小时/N 天」）。 */
function timeLabel(updatedAt: number | undefined): string {
  if (updatedAt === undefined || updatedAt <= 0) return ''
  const diff = Date.now() - updatedAt
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天`
  const d = new Date(updatedAt)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * One row's display title.
 *
 * **坑（2026-08-30）**：官方 `displayTitleOf(title, cwd, id)` 在会话还没有
 * 持久标题时**回落到工作区目录名**（`dsh-api-session-controller/lib/client.js:2217`
 * 的 `workspaceTitleOf(cwd)` 取路径末段），于是新建的空会话在侧栏显示成
 * 「kkc-desktop」这类目录名，而不是「新会话」。blank 会话的标题要从 summary
 * 本身判断，**不能信 displayTitle**——它此刻不是空，是目录名。
 */
function rowTitle(row: SessionSummary): string {
  if (row.blank === true) return '新会话'
  return row.displayTitle || '未命名会话'
}

/** 状态点色调（design sr status-dot）：等待用户操作 amber / 完成 green / 执行中 brand。 */
type Tone = 'brand' | 'success' | 'warn' | 'idle'

function rowDotTone(row: SessionSummary, pendings: ReadonlyMap<string, { kind: string }>): Tone {
  if (pendings.has(String(row.id))) return 'warn'
  if (row.completed === true) return 'success'
  if (row.running) return 'brand'
  return 'idle'
}

/** tone → CSS Modules 状态点类名的显式映射（避免动态键拼在 CSS Modules 下失配）。 */
const TONE_DOT: Record<Tone, string> = {
  brand: css.dotBrand,
  success: css.dotSuccess,
  warn: css.dotWarn,
  idle: css.dotIdle,
}

/**
 * task 模式只显示 task 泳道会话（corum-task-*，2026-08-28 方案：会话管理回归官方
 * 对象层、按 id 前缀筛泳道）。官方 session-* 测试会话、项目泳道（corum-proj*）、
 * dev 直聊（corum-dev-*）均不进 task 列表。
 */
function isTaskSessionId(id: SessionId): boolean {
  return id.startsWith('corum-task-')
}

/**
 * 折叠前每个工作区可见的**普通**会话行数（2026-09-15 用户指示「会话栏只展示最近
 * 五个，其余折叠，和 dsh 官方行为保持一致」）。
 *
 * 照抄官方 `dsh/packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:43`
 * 的 `COLLAPSED_SESSION_LIMIT = 5`。⚠️ 这是 **UI 层**的上限；`tree.ts:421,438` 另有一个
 * **协议侧** `limit`，两者不是一回事，别混。
 */
const COLLAPSED_SESSION_LIMIT = 5

/**
 * 组内折叠判定：只显示前 `limit` 条**普通**会话，其余交给「展开其余 N 个会话 / 收起」。
 *
 * 口径照抄官方 `collapsedSessionRows`（`WorkspaceBrowser.tsx:45-59`）：
 *   · ⚠️ **`blank`（尚未发过消息的会话）不占名额、永远可见** —— 官方原话「Fold one
 *     Workspace **without charging its provisional New Session against the ordinary-row
 *     limit**」⇒ 否则「刚点新建、还没发消息」的会话会被折叠藏起来。
 *
 * 抽成纯函数便于单测直接断言该语义（渲染与测试共用一份口径）。
 */
function collapseSessions(
  sessions: readonly SessionSummary[],
  limit: number = COLLAPSED_SESSION_LIMIT,
): { visible: readonly SessionSummary[]; hiddenCount: number } {
  let ordinaryCount = 0
  const visible = sessions.filter((session) => {
    if (session.blank === true) return true
    if (ordinaryCount >= limit) return false
    ordinaryCount += 1
    return true
  })
  return { visible, hiddenCount: sessions.length - visible.length }
}

/**
 * 任务模式列表行过滤（对齐官方 WorkspaceBrowser deriveGroups 的可见性规则）：
 * id 前缀 + **origin !== 'subagent'**——子 Agent 路由会话（origin='subagent'，
 * UUID 形态 id）不进分组列表：它们的标题由 subagent routing 管理（host 拒绝
 * rename：「owned by subagent routing」），且由对话区子 Agent 卡承载，与官方
 * 一致不在此列出。2026-08-28 用户报「未分组会话重命名不生效」即此漏滤所致。
 */
function isTaskSession(row: SessionSummary): boolean {
  return isTaskSessionId(row.id) && row.origin !== 'subagent'
}

/**
 * 会话行项目徽标的**数据模型**（PR7）。
 *
 * `projectId` 是「切到哪个项目工作面」的身份（供 `openProjectWorkface` 定位），
 * `name` 是胶囊上显示的项目名（KKC / 矩道…）。两者都由数据源给出——组件不猜、
 * 不从 cwd 末段派生（工作区目录名 ≠ 项目名）。
 */
export interface ProjectBadgeInfo {
  readonly projectId: string
  readonly name: string
}

/**
 * 把一条会话投影成徽标信息；无项目归属返回 `undefined`（**不是空对象**）。
 *
 * 之所以是「解析器」而不是「快照」：它与 `resolveSaveSession` 同因——槽的 inject
 * 面被 ui-renderer 按 entry **永久缓存**（`rootInjectCache` 只跑一次 `runInject`），
 * 投影成常量会在「项目插件晚于侧栏装配」时永久冻结成缺席。闭源侧照此形态提供即可。
 */
export type ProjectBadgeResolver = (session: SessionSummary) => ProjectBadgeInfo | undefined

/**
 * 会话行的项目徽标数据源（PR7 定稿，**闭源对接点**）。
 *
 * ## 为什么开源仓恒为空 —— 调研结论（2026-09-27）
 *
 * 项目模式已整体迁出闭源仓 `Corum-Harness-Project`（`@corum/corum-project`），
 * 本仓只剩 task 模式，故**开源侧没有任何可用的「会话 → 项目」映射**：
 *
 * | 候选数据面 | 实测结论 |
 * | --- | --- |
 * | `SessionSummary`（会话列表） | 只有 `cwd`，**无 projectId/项目名字段**（官方基座类型） |
 * | `listTaskAgents`（corumAgent RPC） | 返回 cwd/profileId/title/lastActive，同样无项目 |
 * | `ctx.workspaces`（工作区列表） | 每个 task 会话天然归属一个工作区，**那个工作区几乎恒等于「本项目自己」**，拿它当徽标只会把目录名挂满每一行 |
 * | 工作区索引 `$CORUM_HOME/projects/<id>/project.json`（`workspace-identity.ts` 可读） | 字段只有 id/name/cwd/type——`name` 是**工作区条目名**（≈目录名），且 task 工作区恒为 `type:'task'`，反解出来不是项目 |
 * | 闭源 `corumProject/listProjects` / `listWorkspaceSessions` | **确实能给出项目名 + cwd**——但要打闭源 namespace，且开源组件读它会在纯开源组合下打到不存在的端点 |
 * | `AgentRegistry.laneOf(sessionId)`（泳道归属索引） | 泳道会话才有归属，而泳道会话（`corum-proj*`）**不进 task 列表**（`isTaskSession` 过滤），对 task 行恒为 undefined |
 *
 * ⇒ 开源仓的实现就是**返回空值**：徽标不渲染、不报错、不留空胶囊。UI 与点击
 * 行为已完整交付（渲染位 + 样式 + `setSidebarMode('project')` 通路）。
 *
 * ## 闭源怎么点亮（三处小改，都在闭源仓）
 *
 * 1. 在本槽（`corum.sidebar.sessions`）的 inject 面加两个字段：
 *    `resolveProjectBadge`（用 `listProjects` 的 `name` + `listWorkspaceSessions` 的
 *    `cwd` 建 cwd → 项目表，按 `session.cwd` 命中）与 `openProjectWorkface`
 *    （`(id) => sidebarModeLayout(ctx).setSidebarMode('project')`，
 *    窄化面写法同 `corum-ui-conversation` 的 `SidebarModeCapableLayout`）；
 * 2. 想同时「定位该项目」，在 `setSidebarMode('project')` 旁再走闭源项目面板自己的
 *    定位动作（本组件不假设它的形态）；
 * 3. 无需改本组件、无需改本仓任何类型——两个字段都是**可选**的。
 *
 * ## 形态说明（与「`useProjectBadge(session)` 每行一调」的差别）
 *
 * 取的是**解析器入参**而非 session 入参：会话行在 `groups.map(...)` / `rows.map(...)`
 * 里渲染，在循环体里调 Hook 违反 Hooks 规则（行数会随折叠/展开变化）。故本 Hook
 * 在 `SessionsPane` 顶层调**一次**、返回一个纯函数，由各行按需调用——对外语义等价
 * （「该会话有没有项目」），且不赌 Hook 调用顺序。
 *
 * @param resolver - inject 面下发的解析器；缺席（开源组合）返回的函数恒为 `undefined`。
 * @returns 按会话解析徽标信息的纯函数；数据源缺席时恒返回 `undefined`。
 */
export function useProjectBadge(
  resolver: ProjectBadgeResolver | undefined,
): (session: SessionSummary) => ProjectBadgeInfo | undefined {
  // 无状态投影：resolver 每次渲染按引用比较（inject 面被缓存 ⇒ 引用稳定），
  // useCallback 只是省掉每行一个新闭包，不是正确性依赖。
  return useCallback(
    (session: SessionSummary) => resolver?.(session),
    [resolver],
  )
}

/**
 * 会话行的项目徽标数据源（PR7）——**开源仓的取值恒为 `undefined`**。
 *
 * 这是 `useProjectBadge` 的缺省解析器：本仓没有「会话 → 项目」映射（见上方调研
 * 表），所以任何用到它的地方都解析出 `undefined` ⇒ 徽标不渲染。存在的价值是把
 * 「开源仓无项目」表达成**一处显式常量**而不是散落的 `undefined`，也让闭源侧一眼
 * 看到替换点（把 inject 面的 `resolveProjectBadge` 填上即可，本常量随之没人用）。
 */
export const NO_PROJECT_BADGE: ProjectBadgeResolver = () => undefined

/** 分组方式（官方视图选项：按工作区 / 单列表）。 */
type GroupBy = 'workspace' | 'flat'
/** 组内排序方式（官方视图选项：手动排序 = 工作区账号顺序 / 最近更新）。 */
type OrderBy = 'manual' | 'updated'

/** 工作区分组行点击或搜索展开等头部动作后的滚动/焦点无需处理，纯 UI 态。 */
const SEARCH_DEBOUNCE_MS = 250

/** 任务模式内容（design ①：新会话按钮 + 工作区分组会话列表）。 */
export function SessionsPane(props: SessionsPaneInjected) {
  const { list, workspaces: workspacesStore, open, startSession, search, rename, pendingInteractions } = props
  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const wsList = useSyncExternalStore(workspacesStore.subscribe, workspacesStore.getSnapshot)
  const pendings = useSyncExternalStore(pendingInteractions.subscribe, pendingInteractions.getSnapshot)

  // 视图选项（官方 WorkspaceBrowser 语义；默认按工作区分组 + 手动排序）。
  const [groupBy, setGroupBy] = useState<GroupBy>('workspace')
  const [orderBy, setOrderBy] = useState<OrderBy>('manual')
  const [viewMenuOpen, setViewMenuOpen] = useState(false)

  // 组折叠态：key = workspaceId（'' = 未分组）。存「已折叠」集合，默认全展开；
  // 用户手动操作过的组记入 explicit——自动展开（切会话撑开所属组）只对未
  // 显式操作的组生效（官方语义：用户折叠的组不被自动重新展开）。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const explicitGroups = useRef<Set<string>>(new Set())
  /**
   * 组内「展开其余 N 个会话」态（2026-09-15 用户指示：会话栏只展示最近 5 条，其余折叠，
   * 与 dsh 官方一致）。
   *
   * **与上面 `collapsed` 是两个正交的轴，别混**：
   *   · `collapsed` = **整组**收起（组头一折全没了）；
   *   · `expandedGroups` = 组**展开着**，但组内**只显示 5 条**、其余藏在「展开其余 N 个会话」后面。
   * 官方也是两层（`WorkspaceBrowser` 的组折叠 + `COLLAPSED_SESSION_LIMIT` 的 overflow 控件）。
   */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set())

  // 搜索：胶囊点击展开（官方 pattern），输入去抖 ≥2 字触发全文检索。
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResultItem[] | null>(null)
  const searchTimer = useRef<number | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)

  // 工作区管理对话框：重命名 / 删除确认（复用 wizard 弹层样式）。
  const [renaming, setRenaming] = useState<WorkspaceView | null>(null)
  const [deleting, setDeleting] = useState<WorkspaceView | null>(null)

  useEffect(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    const q = query.trim()
    if (q.length < 2) {
      setResults(null)
      return
    }
    const ac = new AbortController()
    searchTimer.current = window.setTimeout(() => {
      // 竞态防护：query 已变/已清空后迟到的 RPC 结果不得写回（setResults
      // 只在请求未被 abort 且输入仍有效时生效）。
      search(q, ac.signal)
        .then(r => { if (!ac.signal.aborted) setResults(r) })
        .catch(() => { if (!ac.signal.aborted) setResults(null) })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      ac.abort()
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    }
  }, [query, search])

  const current = snapshot.current
  const allRows = useMemo(() => snapshot.ids
    .map(id => snapshot.byId[id])
    .filter((row): row is SessionSummary => row !== undefined && isTaskSession(row))
    // blank 过滤（官方语义）：空（未发消息）会话不进列表，除非是 current。测试残留的
    // 空泳道（blank 卡住）自然被滤；有消息的泳道正常显示（2026-08-28 用户定调：空会话
    // 是测试遗留，正常使用无此问题）。
    .filter(row => !row.blank || row.id === current), [snapshot, current])

  const archived = useMemo(
    () => new Set(wsList.archivedSessionIds.filter(isTaskSessionId)),
    [wsList.archivedSessionIds],
  )
  const rows = useMemo(() => allRows.filter(row => !archived.has(row.id)), [allRows, archived])

  /**
   * 分组推导（官方 deriveGroups 语义的工作区子集）：
   * 工作区按注册表顺序，每组的会话 = workspace.sessionIds 过滤到可见任务会话；
   * 未分组桶收尾。组内排序：manual = 工作区账号顺序（updatedAt 兜底排序在
   * host 侧维护），updated = updatedAt 倒序。
   */
  const groups = useMemo(() => {
    const byId = new Map(rows.map(row => [row.id as string, row]))
    const accounted = new Set<string>()
    const result: Array<{ key: string; workspace: WorkspaceView | null; sessions: SessionSummary[] }> = []
    for (const ws of wsList.items) {
      const sessions: SessionSummary[] = []
      for (const id of ws.sessionIds) {
        const row = byId.get(id)
        if (row === undefined) continue
        accounted.add(id)
        sessions.push(row)
      }
      if (orderBy === 'updated') sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      result.push({ key: ws.workspaceId, workspace: ws, sessions })
    }
    // 不再渲染「未分组」桶（2026-08-31 用户定调）：现在的交互里会话都挂在工作区
    // 下（新建任务表单必选工作区），不存在无归属会话；历史遗留的未分组行不显示。
    return result
  }, [rows, wsList.items, orderBy])

  // 当前会话所在组自动展开（官方：仅当用户未对该组做过显式折叠操作时）。
  const currentGroupKey = current === undefined
    ? undefined
    : groups.find(g => g.sessions.some(row => row.id === current))?.key
  useEffect(() => {
    if (currentGroupKey === undefined) return
    if (explicitGroups.current.has(currentGroupKey)) return // 用户已显式操作过
    if (!collapsed.has(currentGroupKey)) return
    setCollapsed(prev => {
      const next = new Set(prev)
      next.delete(currentGroupKey)
      return next
    })
  }, [currentGroupKey, collapsed])

  const toggleGroup = useCallback((key: string): void => {
    explicitGroups.current.add(key)
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const openSearchItem = useCallback((sessionId: SessionId): void => {
    setQuery('')
    setResults(null)
    setSearchOpen(false)
    open(sessionId)
  }, [open])

  const submitRename = useCallback((sessionId: SessionId, title: string): void => {
    const trimmed = title.trim()
    setRenamingId(null)
    if (trimmed === '') return
    void rename(sessionId, trimmed).catch((err: unknown) => {
      // 重命名失败不能静默——host 拒绝（如会话无 binding / subagent 路由
      // 会话）时标题不变，用户会以为「没生效」。打 console 并区头下方显示。
      console.error('[SessionsPane] rename failed:', err)
      setRenameError(err instanceof Error ? err.message : String(err))
    })
  }, [rename])

  const [renamingId, setRenamingId] = useState<SessionId | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)

  /**
   * 保存会话日志到…（2026-09-16 用户定调：入口从会话头部右上角搬进会话行右键菜单）。
   *
   * 保存能力**不属于本插件**：实现在 `corum-session-archive`（它经 cordis 服务
   * `sessionArchive` 暴露 save）。本插件只做**菜单入口**，故走能力面
   * `props.resolveSaveSession`（收窄接口，不 import 实现包）。
   *
   * 每次渲染解析一次（**不能**提到组件外或用 useMemo 缓存 —— 服务可能晚于本侧栏装配，
   * 见该字段的注释）；解析不到 ⇒ undefined ⇒ 菜单项不渲染（不留死按钮）。
   *
   * 反馈沿用存档插件原有的结果 Modal（保存路径/错误）：它挂在根级 `shell.overlay` 槽
   * （见该包 SaveDialogHost.tsx），与本菜单解耦 —— 菜单关闭后弹窗照常出现。
   * 取消原生对话框时 controller 静默 resolve（不弹窗），故这里无需分支处理。
   */
  const saveSession = props.resolveSaveSession?.()
  const saveRow = saveSession === undefined
    ? undefined
    : (sessionId: SessionId): void => {
        void saveSession(sessionId).catch((err: unknown) => {
          // controller 内部已把错误 publish 到 store（经弹窗呈现），此处只兜底打日志，
          // 避免「保存失败但控制台全无痕迹」。
          console.error('[SessionsPane] save session failed:', err)
        })
      }

  const visibleResults = results?.filter(item => isTaskSessionId(item.sessionId)) ?? null
  // 搜索态双重防护：query 已清空（<2 字）时即使 results 因迟到写回也不进搜索分支。
  const searching = query.trim().length >= 2 && visibleResults !== null

  // 会话行项目徽标数据源（PR7，闭源对接点；开源组合下 resolveProjectBadge 缺席
  // ⇒ projectBadgeOf 恒返回 undefined ⇒ 徽标整体不渲染）。
  const projectBadgeOf = useProjectBadge(props.resolveProjectBadge ?? NO_PROJECT_BADGE)
  const openProjectWorkface = props.openProjectWorkface

  // 搜索结果行附加上下文：标题（列表 store 的 displayTitle）+ 所属工作区名。
  const workspaceOfSession = useCallback((sessionId: SessionId): string | undefined => {
    for (const ws of wsList.items) {
      if (ws.sessionIds.includes(sessionId)) return ws.title
    }
    return undefined
  }, [wsList.items])

  // 添加工作区：Host 原生目录选择器 → 注册（已存在则幂等解析）。
  const [addingWorkspace, setAddingWorkspace] = useState(false)
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null)
  // fork（corum）：待确认的 git 初始化（非 git 工作区 + 「始终初始化」开关关闭时弹出）。
  const addWorkspace = useCallback(async (): Promise<void> => {
    setAddWorkspaceError(null)
    setAddingWorkspace(true)
    try {
      const path = await props.pickDirectory()
      if (path === null) return // 用户取消
      // fork（corum）：工作区的 git 保证（2026-09-11 用户定调）。行为固定为
      // 「探测，没有就初始化」——不再询问、也没有开关（原 autoInitGit 设置已移除）。
      // 子 Agent 并行隔离、声明式验证、集成合并都依赖 git。
      // `ensureRepo` 幂等：已是仓库（含 worktree/子目录）直接返回。
      await props.gitWorkspaceInit(path)
      await props.addWorkspace(path)
    } catch (error) {
      setAddWorkspaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setAddingWorkspace(false)
    }
  }, [props])
  // 区头标签：分组视图 = 工作区；单列 = 会话（官方 locale 语义）。
  const headLabel = groupBy === 'workspace' ? '工作区' : '会话'

  return (
    <>
      {/* btn-new-session（design ghC5S）：品牌色主按钮 + folder-open 11 + 「新会话」。 */}
      <button type="button" className={css.btnNew} onClick={() => props.openNewTaskForm()} title="新建任务（选工作区/Agent/模型/权限）">
        <FolderOpen size={15} strokeWidth={2.5} /> 新会话
      </button>

      {/* sec-sessions（design）：区头 + 分组会话列表。 */}
      <section className={css.secSessions}>
        <div className={css.secHead}>
          <Folder size={16} strokeWidth={2} className={css.secHeadIcon} />
          <span className={`${css.secHeadTitle}${searchOpen ? ` ${css.secHeadTitleHidden}` : ''}`}>{headLabel}</span>
          <span className={css.secSpacer} />
          {/* 搜索胶囊（官方 pattern）：收起 = 圆形搜索按钮；展开 = 输入框 + 清除，
              展开时区头标签与操作组让位。 */}
          <div className={`${css.headSearch}${searchOpen ? ` ${css.headSearchOpen}` : ''}`}>
            <button
              type="button"
              className={css.headSearchBtn}
              aria-label="搜索会话"
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen(true)
                queueMicrotask(() => { searchInput.current?.focus() })
              }}
            >
              <Search size={16} strokeWidth={2} />
            </button>
            <input
              ref={searchInput}
              className={css.headSearchInput}
              type="text"
              placeholder="搜索会话…"
              value={query}
              tabIndex={searchOpen ? 0 : -1}
              onChange={(e) => { setQuery(e.target.value) }}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                setQuery('')
                setSearchOpen(false)
              }}
            />
            {searchOpen && (
              <button
                type="button"
                className={css.headSearchClear}
                aria-label="清除搜索"
                onClick={(e) => {
                  e.stopPropagation()
                  setQuery('')
                  setSearchOpen(false)
                }}
              >
                <X size={16} strokeWidth={2} />
              </button>
            )}
          </div>
          {/* 操作组（官方 headerActions）：视图选项菜单 + 添加工作区。 */}
          <div className={`${css.headActions}${searchOpen ? ` ${css.headActionsHidden}` : ''}`}>
            <Menu
              open={viewMenuOpen}
              onClose={() => { setViewMenuOpen(false) }}
              align="end"
              dense
              portal
              items={[
                { type: 'label', id: 'group-by', text: '分组方式' },
                { id: 'workspace', label: '按工作区' },
                { id: 'flat', label: '单列表' },
                { type: 'separator', id: 'order-by-separator' },
                { type: 'label', id: 'order-by', text: '排序方式' },
                { id: 'manual', label: '手动排序' },
                { id: 'updated', label: '最近更新' },
              ]}
              selectedIds={[groupBy, orderBy]}
              onSelect={(id) => {
                setViewMenuOpen(false)
                if (id === 'workspace' || id === 'flat') setGroupBy(id)
                else if (id === 'manual' || id === 'updated') setOrderBy(id)
              }}
              anchor={(
                <button
                  type="button"
                  className={css.headBtn}
                  aria-label="视图选项"
                  onClick={() => { setViewMenuOpen(v => !v) }}
                >
                  <SlidersHorizontal size={16} strokeWidth={2} />
                </button>
              )}
            />
            <button
              type="button"
              className={css.headBtn}
              aria-label="添加工作区"
              title="添加工作区"
              disabled={addingWorkspace}
              onClick={() => { void addWorkspace() }}
            >
              {addingWorkspace
                ? <LoaderCircle size={16} strokeWidth={2} className={css.loadingIcon} />
                : <Plus size={16} strokeWidth={2} />}
            </button>
          </div>
        </div>

        {addWorkspaceError !== null && (
          <div className={css.projectError} role="alert">{addWorkspaceError}</div>
        )}
        {renameError !== null && (
          <div className={css.projectError} role="alert">重命名失败：{renameError}</div>
        )}

        <div className={css.sessionList}>
          {searching ? (
            visibleResults.length === 0
              ? <div className={css.empty}>无匹配会话</div>
              : visibleResults.map(item => {
                const row = snapshot.byId[item.sessionId]
                return (
                  <button
                    key={item.sessionId}
                    type="button"
                    className={css.sr}
                    onClick={() => openSearchItem(item.sessionId)}
                  >
                    <span className={`${css.dot} ${row !== undefined ? TONE_DOT[rowDotTone(row, pendings)] : css.dotIdle}`} />
                    <span className={css.srResultBody}>
                      <span className={css.srResultTitle}>
                        {row !== undefined ? rowTitle(row) : item.sessionId}
                      </span>
                      <span className={css.srResultMeta}>
                        {workspaceOfSession(item.sessionId) !== undefined && (
                          <span className={css.srResultCtx}>{workspaceOfSession(item.sessionId)}</span>
                        )}
                        <span className={css.srResultSnippet}>{item.snippet}</span>
                      </span>
                    </span>
                  </button>
                )
              })
          ) : rows.length === 0 && wsList.items.length === 0 ? (
            /* 空态（design m4dvOO）：无会话**且无工作区**时才引导。
               有已注册工作区但无会话时走 groups 渲染空分组——让用户看到
               已注册的工作区（否则 Windows 上「加号选工作区后侧栏不显示
               工作区分组」报障，根因即此条件过早进空态）。 */
            <div className={css.emptyState}>
              <MessageSquarePlus size={20} strokeWidth={1.8} className={css.emptyIcon} />
              <span className={css.emptyTitle}>暂无会话</span>
              <span className={css.emptyHint}>点击「新会话」开始对话</span>
            </div>
          ) : groupBy === 'workspace' ? (
            groups.map(group => (
              <WorkspaceGroup
                key={group.key === '' ? 'ungrouped' : group.key}
                group={group}
                collapsed={collapsed.has(group.key)}
                expanded={expandedGroups.has(group.key)}
                current={current}
                renamingId={renamingId}
                onToggle={() => toggleGroup(group.key)}
                onToggleExpand={() => {
                  setExpandedGroups(prev => {
                    const next = new Set(prev)
                    if (next.has(group.key)) next.delete(group.key)
                    else next.add(group.key)
                    return next
                  })
                }}
                onOpen={open}
                onStartSession={() => { startSession(group.workspace?.workspaceId) }}
                onRenameRequest={() => { if (group.workspace !== null) setRenaming(group.workspace) }}
                onDeleteRequest={() => { if (group.workspace !== null) setDeleting(group.workspace) }}
                onStartRowRename={(id) => { setRenamingId(id) }}
                onSubmitRename={submitRename}
                onCancelRename={() => { setRenamingId(null) }}
                onForkRow={(id) => { void props.fork(id).catch(() => { /* 错误经列表 store 投影 */ }) }}
                onArchiveRow={(id) => { void props.archive(id).catch(() => {}) }}
                onSaveRow={saveRow}
                projectBadgeOf={projectBadgeOf}
                onOpenProject={openProjectWorkface}
                pendings={pendings}
              />
            ))
          ) : (
            rows.map(row => (
              <SessionRow
                key={row.id}
                row={row}
                active={row.id === current}
                renaming={renamingId === row.id}
                onOpen={() => open(row.id)}
                onStartRename={() => { setRenamingId(row.id) }}
                onSubmitRename={submitRename}
                onCancelRename={() => { setRenamingId(null) }}
                onFork={() => { void props.fork(row.id).catch(() => {}) }}
                onArchive={() => { void props.archive(row.id).catch(() => {}) }}
                onSave={saveRow === undefined ? undefined : () => { saveRow(row.id) }}
                projectBadge={projectBadgeOf(row)}
                onOpenProject={openProjectWorkface}
                pendings={pendings}
              />
            ))
          )}
        </div>
      </section>

      {/* 工作区重命名 / 删除确认弹层（复用向导弹层样式，portal 避开裁剪）。 */}
      {renaming !== null && (
        <WorkspaceDialog
          title="重命名工作区"
          label={renaming.title}
          confirmLabel="重命名"
          onCancel={() => { setRenaming(null) }}
          onSubmit={async (value) => {
            await props.renameWorkspace(renaming.workspaceId, value)
            setRenaming(null)
          }}
        />
      )}
      {deleting !== null && (
        <WorkspaceDialog
          title="删除工作区"
          description={`将把「${deleting.title}」从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在「未分组」下。`}
          confirmLabel="删除"
          danger
          cancelLabel="取消"
          inputEnabled={false}
          onCancel={() => { setDeleting(null) }}
          onSubmit={async () => {
            await props.deleteWorkspace(deleting.workspaceId)
            setDeleting(null)
          }}
        />
      )}
    </>
  )
}

/** 一个工作区分组（design d-*：组行 + 组内会话行）。 */
function WorkspaceGroup({ group, collapsed, expanded, current, renamingId, onToggle, onToggleExpand, onOpen, onStartSession, onRenameRequest, onDeleteRequest, onStartRowRename, onSubmitRename, onCancelRename, onForkRow, onArchiveRow, onSaveRow, projectBadgeOf, onOpenProject, pendings }: {
  group: { key: string; workspace: WorkspaceView | null; sessions: readonly SessionSummary[] }
  collapsed: boolean
  /** 组内是否已「展开其余 N 个会话」（与整组 `collapsed` 正交，见调用方注释）。 */
  expanded: boolean
  current: SessionId | undefined
  renamingId: SessionId | null
  onToggle: () => void
  onToggleExpand: () => void
  onOpen: (sessionId: SessionId) => void
  onStartSession: () => void
  onRenameRequest: () => void
  onDeleteRequest: () => void
  onStartRowRename: (id: SessionId) => void
  onSubmitRename: (sessionId: SessionId, title: string) => void
  onCancelRename: () => void
  onForkRow: (id: SessionId) => void
  onArchiveRow: (id: SessionId) => void
  /** 保存会话日志到…（可选：存档插件缺席时不传 ⇒ 菜单项不渲染）。 */
  onSaveRow?: ((id: SessionId) => void) | undefined
  /** 会话行项目徽标数据源（PR7；开源组合下恒 undefined ⇒ 不渲染）。 */
  projectBadgeOf: (session: SessionSummary) => ProjectBadgeInfo | undefined
  /** 点徽标 → 切到该项目工作面（PR7；缺席时徽标不渲染，不留死按钮）。 */
  onOpenProject?: ((projectId: string) => void) | undefined
  pendings: ReadonlyMap<string, { kind: string }>
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const label = group.workspace?.title ?? '未分组'
  const isUngrouped = group.workspace === null
  return (
    <div className={css.groupSection}>
      {/* 组行（design d-*）：chevron + folder（未分组无 folder）+ 名称 + 行尾操作。 */}
      <div
        className={`${css.groupRow}${menuOpen ? ` ${css.groupRowMenuOpen}` : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={label}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() }
        }}
      >
        <ChevronRight
          size={16}
          strokeWidth={2}
          className={`${css.groupChev}${collapsed ? '' : ` ${css.groupChevOpen}`}`}
        />
        {!isUngrouped && <Folder size={18} strokeWidth={2} className={css.groupFolder} />}
        <span className={css.groupTitle} title={label}>{label}</span>
        {/* 行尾操作（官方：hover / 菜单展开时显现）：工作区组 = ellipsis 菜单
            （重命名 / 删除）+ plus（在该工作区新建会话）；未分组组只有 plus。 */}
        <span className={css.groupActions}>
          {!isUngrouped && (
            <Menu
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              align="end"
              portal
              closeOnPointerLeave
              items={[
                { id: 'rename', label: '重命名' },
                { id: 'delete', label: '删除工作区', danger: true },
              ]}
              onSelect={(id) => {
                setMenuOpen(false)
                if (id === 'rename') onRenameRequest()
                else if (id === 'delete') onDeleteRequest()
              }}
              anchor={(
                <button
                  type="button"
                  className={css.groupBtn}
                  aria-label={`工作区「${label}」的操作`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen(v => !v)
                  }}
                >
                  <MoreHorizontal size={16} strokeWidth={2} />
                </button>
              )}
            />
          )}
          <button
            type="button"
            className={css.groupBtn}
            aria-label={`在「${label}」中新建会话`}
            onClick={(e) => {
              e.stopPropagation()
              onStartSession()
            }}
          >
            <Plus size={12} strokeWidth={2} />
          </button>
        </span>
      </div>
      {/* 组内会话行（design sr：缩进 32 对齐 folder 右侧）。
          折叠到最近 5 条 + 「展开其余 N 个会话 / 收起」（2026-09-15 用户指示，口径照抄
          dsh 官方 WorkspaceBrowser：普通行 5 条上限，blank 不占名额）。 */}
      {!collapsed && group.sessions.length > 0 && (() => {
        const { visible, hiddenCount } = expanded
          ? { visible: group.sessions, hiddenCount: 0 }
          : collapseSessions(group.sessions)
        return (
          <div className={css.groupSessions}>
            {visible.map(row => (
              <SessionRow
                key={row.id}
                row={row}
                active={row.id === current}
                nested
                renaming={renamingId === row.id}
                onOpen={() => onOpen(row.id)}
                onStartRename={() => { onStartRowRename(row.id) }}
                onSubmitRename={onSubmitRename}
                onCancelRename={onCancelRename}
                onFork={() => { onForkRow(row.id) }}
                onArchive={() => { onArchiveRow(row.id) }}
                onSave={onSaveRow === undefined ? undefined : () => { onSaveRow(row.id) }}
                projectBadge={projectBadgeOf(row)}
                onOpenProject={onOpenProject}
                pendings={pendings}
              />
            ))}
            {/* 溢出控件：折叠时显示「展开其余 N 个会话」，展开后显示「收起」。
                文案带计数（官方词典 sessions.expand/sessions.collapse 同口径）。 */}
            {(hiddenCount > 0 || expanded) && (
              <button
                type="button"
                className={css.groupMore}
                aria-expanded={expanded}
                onClick={onToggleExpand}
              >
                {expanded ? '收起' : `展开其余 ${hiddenCount} 个会话`}
              </button>
            )}
          </div>
        )
      })()}
      {!collapsed && group.sessions.length === 0 && (
        <div className={css.groupEmpty}>（无会话）</div>
      )}
    </div>
  )
}

/**
 * One session row (design session-row): live status dot + title + optional
 * project badge + relative time. Double-clicking the title turns it into an
 * in-place rename field (Enter submits, Escape cancels, blur submits) backed
 * by the injected rename RPC.
 */
function SessionRow({ row, active, nested, renaming, onOpen, onStartRename, onSubmitRename, onCancelRename, onFork, onArchive, onSave, projectBadge, onOpenProject, pendings }: {
  row: SessionSummary
  active: boolean
  nested?: boolean
  renaming: boolean
  onOpen: () => void
  onStartRename: () => void
  onSubmitRename: (sessionId: SessionId, title: string) => void
  onCancelRename: () => void
  onFork: () => void
  onArchive: () => void
  /** 保存会话日志到…（可选：存档插件缺席时不传 ⇒ 菜单项不渲染）。 */
  onSave?: (() => void) | undefined
  /** 项目徽标（PR7）：undefined = 无归属/数据源缺席 ⇒ 不渲染（不留空胶囊）。 */
  projectBadge?: ProjectBadgeInfo | undefined
  /** 点徽标 → 切到该项目工作面（缺席时徽标不渲染，不留死按钮）。 */
  onOpenProject?: ((projectId: string) => void) | undefined
  pendings: ReadonlyMap<string, { kind: string }>
}) {
  const [draft, setDraft] = useState(rowTitle(row))
  const inputRef = useRef<HTMLInputElement | null>(null)
  // 跑马灯：标题溢出（scrollWidth > clientWidth）时 hover 触发无缝循环滚动。
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  // 右键菜单（2026-08-28）：重命名 / 归档 / 分叉会话 / 提炼经验（占位禁用）。
  const [menuOpen, setMenuOpen] = useState(false)

  // draft 初始化：只在 renaming 从 false→true 的边沿重置为当前标题 + 全选——
  // 不依赖 row 内容变化（桌面环境 session store 持续更新会让 byId[row.id]
  // 换新引用，若 effect 依赖 row 会在用户输入中途把 draft 重置回旧标题，
  // 导致「输入的新名被冲掉、提交的是旧标题」——2026-08-28 用户实测「正确的
  // 会话也改不了名」的根因）。
  const wasRenaming = useRef(false)
  useEffect(() => {
    if (renaming && !wasRenaming.current) {
      setDraft(rowTitle(row))
      queueMicrotask(() => { inputRef.current?.select() })
    }
    wasRenaming.current = renaming
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming])

  // 标题溢出检测（字号/内容/宽度变化时重测）。用 useLayoutEffect 在 paint 前
  // 同步测量——避免改名后「旧 overflowing=true + 新标题」先渲染一帧跑马灯
  // 双份文本（用户看到标题重复两遍的过渡 bug）。row 变化（改名/更新）时
  // 标题内容随之变，layout effect 在浏览器绘制前完成重测。
  const title = rowTitle(row)
  useLayoutEffect(() => {
    const el = titleRef.current
    if (el === null || renaming) return
    const measure = (): void => { setOverflowing(el.scrollWidth > el.clientWidth + 1) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [renaming, title])

  const rowEl = (
    <div
      className={`${css.sr}${nested ? ` ${css.srNested}` : ''}${active ? ` ${css.srActive}` : ''}`}
      onClick={onOpen}
      onDoubleClick={(e) => { e.preventDefault(); onStartRename() }}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
      title={rowTitle(row)}
      draggable={!renaming}
      onDragStart={(e) => {
        if (renaming) { e.preventDefault(); return }
        e.dataTransfer.setData('corum/session-id', String(row.id))
        e.dataTransfer.effectAllowed = 'move'
        // 设置自定义拖拽图像，避免显示整个主窗口的内容
        const dragImage = e.currentTarget.cloneNode(true) as HTMLElement
        dragImage.style.position = 'absolute'
        dragImage.style.top = '-1000px'
        dragImage.style.left = '0'
        dragImage.style.opacity = '0.8'
        dragImage.style.pointerEvents = 'none'
        document.body.appendChild(dragImage)
        // setDragImage 的偏移量是相对于图像的，使用图像的中心点
        const rect = e.currentTarget.getBoundingClientRect()
        const offsetX = rect.width / 2
        const offsetY = rect.height / 2
        e.dataTransfer.setDragImage(dragImage, offsetX, offsetY)
        setTimeout(() => { document.body.removeChild(dragImage) }, 0)
      }}
      role="button"
      tabIndex={0}
    >
      <span className={`${css.dot} ${TONE_DOT[rowDotTone(row, pendings)]}`} />
      {renaming ? (
        <input
          ref={inputRef}
          className={css.srRename}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // IME composition 中的 Enter 是确认候选（不是提交）——
            // isComposing 时不触发重命名提交（否则中文输入按 Enter 确认
            // 候选词会误提交半成品拼音）。
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') { e.preventDefault(); onSubmitRename(row.id, draft) }
            if (e.key === 'Escape') { e.preventDefault(); onCancelRename() }
          }}
          onBlur={() => { onSubmitRename(row.id, draft) }}
        />
      ) : (
        <span
          ref={titleRef}
          className={`${css.srTitle}${active ? '' : ` ${css.srTitleDim}`}${overflowing ? ` ${css.srTitleMarquee}` : ''}`}
        >
          {overflowing ? (
            /* 跑马灯：滚动轨双份文本无缝循环（平移 -50% = 一份+间隔宽）。 */
            <span className={css.marqueeTrack}>
              <span className={css.marqueeChunk}>{rowTitle(row)}</span>
              <span className={css.marqueeChunk} aria-hidden="true">{rowTitle(row)}</span>
            </span>
          ) : (
            rowTitle(row)
          )}
        </span>
      )}
      {/* 项目徽标（PR7，design row · 徽标 KKC/矩道）：标题与时间之间的品牌小胶囊。
          两个条件都为真才渲染——（1）有项目归属数据（projectBadge 非 undefined）、
          （2）有切换动作（onOpenProject 非 undefined）。缺任一条都不渲染：
          「有数据但点了没反应」比「不显示」更糟。
          判定在这里、渲染交给 ProjectBadge（必填 props 子组件）——回调里不再依赖
          外层参数的窄化（窄化在闭包内是否保留随 TS 版本而异，不必赌）。 */}
      {projectBadge !== undefined && onOpenProject !== undefined && (
        <ProjectBadge badge={projectBadge} onOpen={onOpenProject} />
      )}
      <span className={css.srTime}>{timeLabel(row.updatedAt)}</span>
    </div>
  )

  return (
    <Menu
      open={menuOpen}
      onClose={() => { setMenuOpen(false) }}
      align="start"
      portal
      items={[
        { id: 'rename', label: '重命名', icon: <Pencil size={14} strokeWidth={2} /> },
        { id: 'archive', label: '归档', icon: <Archive size={14} strokeWidth={2} /> },
        { id: 'fork', label: '分叉会话', icon: <GitFork size={14} strokeWidth={2} /> },
        // 保存会话日志到…（2026-09-16 用户定调：入口从会话头部右上角搬进本菜单）。
        // 放在分隔线**之前**、与其它「会话级动作」同组 —— 它是常规动作而非占位项。
        // 存档插件缺席（onSave undefined）时整项不渲染（不留死按钮）。
        ...(onSave === undefined
          ? []
          : [{ id: 'save', label: '保存到…', icon: <Download size={14} strokeWidth={2} /> }]),
        { type: 'separator', id: 'distill-sep' },
        { id: 'distill', label: '提炼经验', icon: <Sparkles size={14} strokeWidth={2} />, disabled: true },
      ]}
      onSelect={(id) => {
        setMenuOpen(false)
        if (id === 'rename') onStartRename()
        else if (id === 'archive') onArchive()
        else if (id === 'fork') onFork()
        else if (id === 'save') onSave?.()
        // distill：占位禁用（语义待定义），不响应。
      }}
      anchor={rowEl}
    />
  )
}

/**
 * 会话行项目徽标（PR7，design row · 徽标 KKC/矩道）：brand 描边 999 圆角小胶囊
 * + 项目名；点击切到该项目的工作面（`onOpen` 由 inject 面注入，闭源实现为
 * `ctx.layout.setSidebarMode('project')`）。
 *
 * props 都是**必填**：渲染条件（有数据 + 有动作）由调用方（SessionRow）判定，
 * 本组件只负责「有数据时的样子与行为」，不留「点了没反应」的死按钮。
 */
function ProjectBadge({ badge, onOpen }: {
  badge: ProjectBadgeInfo
  onOpen: (projectId: string) => void
}) {
  return (
    <button
      type="button"
      className={css.projectBadge}
      title={`打开项目「${badge.name}」`}
      aria-label={`打开项目「${badge.name}」`}
      onClick={(e) => {
        // 整行的 onClick 是「打开会话」，徽标的语义是「切项目工作面」——
        // 不拦冒泡会把两件事一起做了。
        e.stopPropagation()
        onOpen(badge.projectId)
      }}
      // 双击/右键同样拦下：整行那两处分别是「就地重命名」与「会话行菜单」，
      // 在徽标上触发它们都是误操作。
      onDoubleClick={(e) => { e.stopPropagation() }}
      onContextMenu={(e) => { e.stopPropagation() }}
    >
      {badge.name}
    </button>
  )
}

/** 工作区重命名 / 删除确认弹层（官方 rename/delete 对话框的简化实现）。 */
function WorkspaceDialog({ title, description, label, confirmLabel, cancelLabel = '取消', danger, inputEnabled = true, onCancel, onSubmit }: {
  title: string
  description?: string
  label?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  inputEnabled?: boolean
  onCancel: () => void
  onSubmit: (value: string) => Promise<void>
}) {
  const [value, setValue] = useState(label ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (inputEnabled && value.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return createPortal(
    <div
      className={css.wizardOverlay}
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}
    >
      <div className={css.wizardDialog} role="dialog" aria-modal="true" aria-label={title}>
        <header className={css.wizardHeader}>
          <span className={css.wizardTitle}>{title}</span>
          <button type="button" className={css.projectHeaderClose} title="取消" onClick={onCancel} disabled={busy}>
            <X size={14} strokeWidth={2} />
          </button>
        </header>
        <div className={css.wizardBody}>
          {inputEnabled ? (
            <>
              <span className={css.wizardLabel}>工作区名称</span>
              <input
                className={css.wizardInput}
                autoFocus
                value={value}
                disabled={busy}
                onChange={(e) => { setValue(e.target.value) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void submit() }
                  if (e.key === 'Escape') { e.preventDefault(); onCancel() }
                }}
              />
            </>
          ) : (
            description !== undefined && <span className={css.wizardHint}>{description}</span>
          )}
          {error !== null && <div className={css.projectError} role="alert">{error}</div>}
        </div>
        <footer className={css.wizardFooter}>
          <button type="button" className={css.wizardBtnGhost} onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button
            type="button"
            className={`${css.wizardBtnPrimary}${danger ? ` ${css.wizardBtnDanger}` : ''}`}
            disabled={busy || (inputEnabled && value.trim() === '')}
            onClick={() => { void submit() }}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
