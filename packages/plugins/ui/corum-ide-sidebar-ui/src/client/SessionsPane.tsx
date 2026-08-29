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
  Archive, ChevronRight, Folder, FolderOpen, GitFork, LoaderCircle,
  MessageSquarePlus, MoreHorizontal, Pencil, Plus, Search, SlidersHorizontal,
  Sparkles, X,
} from 'lucide-react'
import css from '@corum/corum-ide-ui/sidebar.module.css'

/** Injected actions + the live feed（由 corum.sidebar.sessions 槽的 occupant 插件注入）。 */
export interface SessionsPaneInjected {
  /** The sessions standard feed (list + selection). */
  list: ISessions['list']
  /** The workspaces standard feed（分组数据源）. */
  workspaces: ObservableSnapshot<WorkspaceListState>
  open: (sessionId: SessionId) => void
  /** 新会话：带 workspaceId 在该工作区复用/新建 blank 会话；省略时继承当前会话所属。 */
  startSession: (workspaceId?: WorkspaceId) => void
  search: (query: string, signal: AbortSignal) => Promise<SessionSearchResultItem[]>
  rename: (sessionId: SessionId, title: string) => Promise<void>
  /** 分叉会话：从源会话最近完成轮次切出子会话并打开（官方 fork 语义）。 */
  fork: (sessionId: SessionId) => Promise<void>
  /** 归档会话：隐藏出分组列表（日志保留；归档当前会话回新会话视图）。 */
  archive: (sessionId: SessionId) => Promise<void>
  /** 添加工作区：把一个已存在的目录注册为工作区。 */
  addWorkspace: (path: string) => Promise<void>
  /** Host 原生目录选择器；用户取消返回 null。 */
  pickDirectory: () => Promise<string | null>
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** uiSession.pendingInteractions 快照（0.1.2 起「等待操作」pending 在此，SessionId keyed）。 */
  pendingInteractions: ObservableSnapshot<ReadonlyMap<string, { kind: string }>>
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

/** One row's display title: the host-computed durable label, blank fallback. */
function rowTitle(row: SessionSummary): string {
  return row.displayTitle || (row.blank === true ? '新会话' : '未命名会话')
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
 * 任务模式列表行过滤（对齐官方 WorkspaceBrowser deriveGroups 的可见性规则）：
 * id 前缀 + **origin !== 'subagent'**——子 Agent 路由会话（origin='subagent'，
 * UUID 形态 id）不进分组列表：它们的标题由 subagent routing 管理（host 拒绝
 * rename：「owned by subagent routing」），且由对话区子 Agent 卡承载，与官方
 * 一致不在此列出。2026-08-28 用户报「未分组会话重命名不生效」即此漏滤所致。
 */
function isTaskSession(row: SessionSummary): boolean {
  return isTaskSessionId(row.id) && row.origin !== 'subagent'
}

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
    const ungrouped = rows.filter(row => !accounted.has(row.id))
    if (orderBy === 'updated') ungrouped.sort((a, b) => b.updatedAt - a.updatedAt)
    result.push({ key: '', workspace: null, sessions: ungrouped })
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

  const visibleResults = results?.filter(item => isTaskSessionId(item.sessionId)) ?? null
  // 搜索态双重防护：query 已清空（<2 字）时即使 results 因迟到写回也不进搜索分支。
  const searching = query.trim().length >= 2 && visibleResults !== null

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
  const addWorkspace = useCallback(async (): Promise<void> => {
    setAddWorkspaceError(null)
    setAddingWorkspace(true)
    try {
      const path = await props.pickDirectory()
      if (path === null) return // 用户取消
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
      <button type="button" className={css.btnNew} onClick={() => startSession()} title="在当前工作区新建会话">
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
          ) : rows.length === 0 ? (
            /* 空态（design m4dvOO）：无会话引导。 */
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
                current={current}
                renamingId={renamingId}
                onToggle={() => toggleGroup(group.key)}
                onOpen={open}
                onStartSession={() => { startSession(group.workspace?.workspaceId) }}
                onRenameRequest={() => { if (group.workspace !== null) setRenaming(group.workspace) }}
                onDeleteRequest={() => { if (group.workspace !== null) setDeleting(group.workspace) }}
                onStartRowRename={(id) => { setRenamingId(id) }}
                onSubmitRename={submitRename}
                onCancelRename={() => { setRenamingId(null) }}
                onForkRow={(id) => { void props.fork(id).catch(() => { /* 错误经列表 store 投影 */ }) }}
                onArchiveRow={(id) => { void props.archive(id).catch(() => {}) }}
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
function WorkspaceGroup({ group, collapsed, current, renamingId, onToggle, onOpen, onStartSession, onRenameRequest, onDeleteRequest, onStartRowRename, onSubmitRename, onCancelRename, onForkRow, onArchiveRow, pendings }: {
  group: { key: string; workspace: WorkspaceView | null; sessions: readonly SessionSummary[] }
  collapsed: boolean
  current: SessionId | undefined
  renamingId: SessionId | null
  onToggle: () => void
  onOpen: (sessionId: SessionId) => void
  onStartSession: () => void
  onRenameRequest: () => void
  onDeleteRequest: () => void
  onStartRowRename: (id: SessionId) => void
  onSubmitRename: (sessionId: SessionId, title: string) => void
  onCancelRename: () => void
  onForkRow: (id: SessionId) => void
  onArchiveRow: (id: SessionId) => void
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
      {/* 组内会话行（design sr：缩进 32 对齐 folder 右侧）。 */}
      {!collapsed && group.sessions.length > 0 && (
        <div className={css.groupSessions}>
          {group.sessions.map(row => (
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
              pendings={pendings}
            />
          ))}
        </div>
      )}
      {!collapsed && group.sessions.length === 0 && (
        <div className={css.groupEmpty}>（无会话）</div>
      )}
    </div>
  )
}

/**
 * One session row (design session-row): live status dot + title + relative
 * time. Double-clicking the title turns it into an in-place rename field
 * (Enter submits, Escape cancels, blur submits) backed by the injected
 * rename RPC.
 */
function SessionRow({ row, active, nested, renaming, onOpen, onStartRename, onSubmitRename, onCancelRename, onFork, onArchive, pendings }: {
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
    <button
      type="button"
      className={`${css.sr}${nested ? ` ${css.srNested}` : ''}${active ? ` ${css.srActive}` : ''}`}
      onClick={onOpen}
      onDoubleClick={(e) => { e.preventDefault(); onStartRename() }}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
      title={rowTitle(row)}
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
      <span className={css.srTime}>{timeLabel(row.updatedAt)}</span>
    </button>
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
        { type: 'separator', id: 'distill-sep' },
        { id: 'distill', label: '提炼经验', icon: <Sparkles size={14} strokeWidth={2} />, disabled: true },
      ]}
      onSelect={(id) => {
        setMenuOpen(false)
        if (id === 'rename') onStartRename()
        else if (id === 'archive') onArchive()
        else if (id === 'fork') onFork()
        // distill：占位禁用（语义待定义），不响应。
      }}
      anchor={rowEl}
    />
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
