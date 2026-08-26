/**
 * SessionSidebar — the IDE left column, the 任务/项目 双模式侧栏
 * (design.pen L2 侧栏双模式：任务模式·会话列表 = col-① UDA6D / k1nfr4).
 * Structure follows the design frame's children order: brand-row (brand-logo
 * + mode-switch「项目/任务」分段) → div 分隔线 → btn-new-session →
 * sec-sessions（sh 段头「会话 + 计数 badge」+ 扁平会话行 sr-*）。
 *
 * Data: the session list rides the runtime object layer's sessions feed
 * (useSyncExternalStore). 任务模式 = 新建会话 + 扁平会话列表（状态点+标题+时间，
 * 首个选中）；无会话 → 空态引导。项目模式内容（打开/新建项目 + 项目详情）本步
 * 留占位，后续接 corumProject/* 时落地。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ISessions, SessionSearchResultItem, SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  FolderOpen, LoaderCircle, MessageSquarePlus, Plus, Search, Users, X,
} from 'lucide-react'
import css from './SessionSidebar.module.css'

/** Injected actions + the live feed (see client/index.ts apply). */
export interface SessionSidebarInjected {
  /** The sessions standard feed (list + selection). */
  list: ISessions['list']
  open: (sessionId: SessionId) => void
  startSession: () => void
  search: (query: string, signal: AbortSignal) => Promise<SessionSearchResultItem[]>
  rename: (sessionId: SessionId, title: string) => Promise<void>
}

/** Composed props: the shell's owner share + this plugin's injected face. */
export type SessionSidebarProps = PropsRuntime<'corum.sidebar'> & SessionSidebarInjected

/** Relative-time label for a row's updatedAt (design "2m"/"1h"/"3h"/"2d"). */
function timeLabel(updatedAt: number | undefined): string {
  if (updatedAt === undefined || updatedAt <= 0) return ''
  const diff = Date.now() - updatedAt
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  const d = new Date(updatedAt)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** One row's display title: the host-computed durable label, blank fallback. */
function rowTitle(row: SessionSummary): string {
  return row.displayTitle || (row.blank === true ? '新会话' : '未命名会话')
}

/**
 * One row's status dot from the live session fields (design sidebar dot
 * semantics): pendingInteraction = amber（等待用户操作）, completed = green
 * （后台跑完未查看）, running = brand（执行中）, else idle. Selected state
 * stays on the row's background/border, not the dot.
 */
function rowDotTone(row: SessionSummary): Tone {
  if (row.pendingInteraction !== undefined) return 'warn'
  if (row.completed === true) return 'success'
  if (row.running) return 'brand'
  return 'idle'
}

/** 团队成员状态点色调（design gh dot：brand/success/success/warn）。 */
type Tone = 'brand' | 'success' | 'warn' | 'idle'

/** tone → CSS Modules 状态点类名的显式映射（避免动态键拼在 CSS Modules 下失配）。 */
const TONE_DOT: Record<Tone, string> = {
  brand: css.dotBrand,
  success: css.dotSuccess,
  warn: css.dotWarn,
  idle: css.dotIdle,
}

/** 侧栏模式（design mode-switch：任务=默认 / 项目）。 */
type SidebarMode = 'task' | 'project'

/** 项目模式所需的最小 `corumProject` DTO（host 端 CorumProject 的浏览器镜像）。 */
interface CorumProject {
  id: string
  name: string
  cwd?: string
  description?: string
  group?: { members: Array<{ profileId: string }> }
  createdAt: number
  lastOpenedAt: number
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** 调用 host 的 Typert remote；IDE combo 仅在注入 corum-agent-dev 后提供此服务。 */
async function callProjectRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `corumProject/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/corumProject/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`corumProject/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error(`corumProject/${method}: rpcId mismatch`)
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

/** The IDE left column (see module doc). */
export function SessionSidebar({ wide, list, open, startSession, search, rename }: SessionSidebarProps) {
  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const [mode, setMode] = useState<SidebarMode>('task')
  const [projects, setProjects] = useState<readonly CorumProject[]>([])
  const [activeProject, setActiveProject] = useState<CorumProject | null>(null)
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResultItem[] | null>(null)
  // Rename editing: the session id currently being renamed (null = none).
  const [renamingId, setRenamingId] = useState<SessionId | null>(null)
  const searchTimer = useRef<number | null>(null)

  // Debounced search: >= 2 chars triggers the session.search unary.
  useEffect(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    const q = query.trim()
    if (q.length < 2) {
      setResults(null)
      return
    }
    const ac = new AbortController()
    searchTimer.current = window.setTimeout(() => {
      search(q, ac.signal).then(r => setResults(r)).catch(() => setResults(null))
    }, 250)
    return () => {
      ac.abort()
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    }
  }, [query, search])

  const openSearchItem = useCallback((sessionId: SessionId): void => {
    setQuery('')
    setResults(null)
    open(sessionId)
  }, [open])

  // Submit the in-place rename: forward to the injected RPC and clear editing.
  const submitRename = useCallback((sessionId: SessionId, title: string): void => {
    const trimmed = title.trim()
    setRenamingId(null)
    if (trimmed === '') return
    void rename(sessionId, trimmed).catch(() => { /* surfaced on the list store */ })
  }, [rename])

  const current = snapshot.current
  const rows = snapshot.ids
    .map(id => snapshot.byId[id])
    .filter(row => row !== undefined)
  const searching = results !== null

  const refreshProjects = useCallback(async (): Promise<void> => {
    setProjectsLoading(true)
    setProjectError(null)
    try {
      const result = await callProjectRemote<{ projects: CorumProject[] }>('listProjects', {})
      setProjects(result.projects)
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (mode === 'project') void refreshProjects()
  }, [mode, refreshProjects])

  const openProject = useCallback(async (id: string): Promise<void> => {
    setProjectsLoading(true)
    setProjectError(null)
    try {
      const result = await callProjectRemote<{ project: CorumProject }>('openProject', { id })
      setActiveProject(result.project)
      await refreshProjects()
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
      setProjectsLoading(false)
    }
  }, [refreshProjects])

  const createProject = useCallback(async (name: string): Promise<void> => {
    const cleanName = name.trim()
    if (cleanName === '') return
    setProjectsLoading(true)
    setProjectError(null)
    try {
      const result = await callProjectRemote<{ project: CorumProject }>('createProject', { name: cleanName })
      setActiveProject(result.project)
      await refreshProjects()
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
      setProjectsLoading(false)
      throw error
    }
  }, [refreshProjects])

  return (
    <div className={css.sidebar} data-wide={wide || undefined}>
      {/* brand-row（pXl6H）：brand-logo + mode-switch「项目/任务」分段。
          侧边栏不可关闭（2026-08-25 设计：移除 region-actions）。 */}
      <header className={css.brandRow}>
        <span className={css.brand}>
          <img
            className={css.brandImg}
            src="corumapp://app/assets/brand_logo_light_crop.png"
            alt="矩道"
            draggable={false}
          />
          <img
            className={css.brandImgDark}
            src="corumapp://app/assets/brand_logo_dark_crop.png"
            alt="矩道"
            draggable={false}
          />
        </span>
        <div className={css.modeSwitch} role="tablist" aria-label="侧栏模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'project'}
            className={`${css.modeSeg}${mode === 'project' ? ` ${css.modeSegActive}` : ''}`}
            onClick={() => setMode('project')}
          >
            项目
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'task'}
            className={`${css.modeSeg}${mode === 'task' ? ` ${css.modeSegActive}` : ''}`}
            onClick={() => setMode('task')}
          >
            任务
          </button>
        </div>
      </header>
      <div className={css.brandDivider} />

      {mode === 'project' ? (
        <ProjectMode
          projects={projects}
          activeProject={activeProject}
          loading={projectsLoading}
          error={projectError}
          onOpenProject={openProject}
          onCreateProject={createProject}
          onCloseProject={() => setActiveProject(null)}
          onRefresh={() => { void refreshProjects() }}
        />
      ) : (
        <>
          {/* btn-new-session（sVRmO）：品牌色主按钮。 */}
          <button type="button" className={css.btnNew} onClick={() => startSession()} title="在当前工作区新建会话">
            <Plus size={11} strokeWidth={2.5} /> 新建会话
          </button>

          {/* sec-sessions（JTNMJ）：段头「会话 + 计数 badge」+ 扁平会话行。 */}
          <section className={css.secSessions}>
            <div className={css.secHead}>
              <Users size={12} strokeWidth={2} className={css.secHeadIcon} />
              <span className={css.secHeadTitle}>会话</span>
              <span className={css.secHeadBadge}>{searching ? results.length : rows.length}</span>
              <span className={css.secSpacer} />
              <div className={css.searchBox} data-active={query.trim() !== '' || undefined}>
                <Search size={13} strokeWidth={2} className={css.searchIcon} />
                <input
                  className={css.searchInput}
                  placeholder="搜索会话…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>

            <div className={css.sessionList}>
              {searching ? (
                results.length === 0
                  ? <div className={css.empty}>无匹配会话</div>
                  : results.map(item => (
                    <button
                      key={item.sessionId}
                      type="button"
                      className={css.sr}
                      onClick={() => openSearchItem(item.sessionId)}
                    >
                      <span className={`${css.dot} ${css.dotIdle}`} />
                      <span className={css.srTitle}>{item.snippet}</span>
                    </button>
                  ))
              ) : rows.length === 0 ? (
                /* 空态（m4dvOO）：无会话引导。 */
                <div className={css.emptyState}>
                  <MessageSquarePlus size={20} strokeWidth={1.8} className={css.emptyIcon} />
                  <span className={css.emptyTitle}>暂无会话</span>
                  <span className={css.emptyHint}>点击「新建会话」开始对话</span>
                </div>
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
                  />
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

/** 项目模式：真实项目列表 / 创建 / 打开，以及当前项目的最小详情。 */
function ProjectMode({
  projects, activeProject, loading, error, onOpenProject, onCreateProject, onCloseProject, onRefresh,
}: {
  projects: readonly CorumProject[]
  activeProject: CorumProject | null
  loading: boolean
  error: string | null
  onOpenProject: (id: string) => Promise<void>
  onCreateProject: (name: string) => Promise<void>
  onCloseProject: () => void
  onRefresh: () => void
}) {
  const [showProjects, setShowProjects] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setCreateError(null)
    try {
      await onCreateProject(name)
      setName('')
      setCreating(false)
      setShowProjects(false)
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [name, onCreateProject])

  if (activeProject !== null) {
    const members = activeProject.group?.members.length ?? 0
    return (
      <section className={css.projectMode} aria-label="当前项目">
        <div className={css.projectCard}>
          <div className={css.projectCardHead}>
            <FolderOpen size={16} strokeWidth={2} className={css.projectCardIcon} />
            <span className={css.projectCardTitle} title={activeProject.name}>{activeProject.name}</span>
            <button type="button" className={css.closeProject} title="关闭项目" onClick={onCloseProject}>
              <X size={14} strokeWidth={2} />
            </button>
          </div>
          <span className={css.projectCardMeta}>{members} 位成员 · {activeProject.cwd ?? '未关联工作目录'}</span>
          {activeProject.description !== undefined && activeProject.description !== '' && (
            <p className={css.projectCardDescription}>{activeProject.description}</p>
          )}
        </div>
        <div className={css.projectDetailHint}>项目管理与团队详情将在下一步接入。</div>
        <button type="button" className={css.btnOpenProject} onClick={() => { setShowProjects(v => !v); onRefresh() }}>
          <FolderOpen size={11} strokeWidth={2} /> 切换项目
        </button>
        {showProjects && <ProjectList projects={projects} activeId={activeProject.id} loading={loading} onOpen={onOpenProject} />}
      </section>
    )
  }

  return (
    <div className={css.projectMode}>
      <div className={css.emptyState}>
        {loading ? <LoaderCircle size={28} strokeWidth={1.8} className={`${css.emptyIcon} ${css.loadingIcon}`} /> : <FolderOpen size={28} strokeWidth={1.8} className={css.emptyIcon} />}
        <span className={css.emptyTitle}>未打开项目</span>
        <span className={css.emptyHint}>打开或新建一个项目开始协作</span>
      </div>
      {error !== null && <div className={css.projectError} role="alert">项目服务不可用：{error}</div>}
      {showProjects && <ProjectList projects={projects} activeId={null} loading={loading} onOpen={onOpenProject} />}
      {creating && (
        <form className={css.createProjectForm} onSubmit={(event) => { void submit(event) }}>
          <input
            className={css.createProjectInput}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="项目名称"
            aria-label="项目名称"
          />
          <button type="submit" className={css.createProjectSubmit} disabled={loading || name.trim() === ''}>创建</button>
          {createError !== null && <span className={css.createProjectError}>{createError}</span>}
        </form>
      )}
      <div className={css.projectActions}>
        <button type="button" className={css.btnOpenProject} onClick={() => { setShowProjects(v => !v); onRefresh() }}>
          <FolderOpen size={11} strokeWidth={2} /> 打开项目
        </button>
        <button type="button" className={css.btnNewProject} onClick={() => setCreating(v => !v)}>
          <Plus size={11} strokeWidth={2} /> 新建项目
        </button>
      </div>
    </div>
  )
}

function ProjectList({ projects, activeId, loading, onOpen }: {
  projects: readonly CorumProject[]
  activeId: string | null
  loading: boolean
  onOpen: (id: string) => Promise<void>
}) {
  if (loading) return <div className={css.projectListStatus}>正在读取项目…</div>
  if (projects.length === 0) return <div className={css.projectListStatus}>暂无项目</div>
  return (
    <div className={css.projectList} aria-label="项目列表">
      {projects.map(project => (
        <button
          key={project.id}
          type="button"
          className={`${css.projectListRow}${project.id === activeId ? ` ${css.projectListRowActive}` : ''}`}
          onClick={() => { void onOpen(project.id) }}
        >
          <FolderOpen size={14} strokeWidth={2} className={css.projectListIcon} />
          <span className={css.projectListText}>
            <span className={css.projectListTitle}>{project.name}</span>
            <span className={css.projectListMeta}>{project.cwd ?? '未关联工作目录'}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * One session row (design session-row r1lskG): live status dot + title +
 * relative time. Double-clicking the title turns it into an in-place rename
 * field (Enter submits, Escape cancels, blur submits) backed by the injected
 * rename RPC.
 */
function SessionRow({ row, active, renaming, onOpen, onStartRename, onSubmitRename, onCancelRename }: {
  row: SessionSummary
  active: boolean
  renaming: boolean
  onOpen: () => void
  onStartRename: () => void
  onSubmitRename: (sessionId: SessionId, title: string) => void
  onCancelRename: () => void
}) {
  const [draft, setDraft] = useState(rowTitle(row))
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Focus + select the existing title when the row enters rename mode.
  useEffect(() => {
    if (!renaming) return
    setDraft(rowTitle(row))
    queueMicrotask(() => { inputRef.current?.select() })
  }, [renaming, row])

  return (
    <button
      type="button"
      className={`${css.sr}${active ? ` ${css.srActive}` : ''}`}
      onClick={onOpen}
      onDoubleClick={(e) => { e.preventDefault(); onStartRename() }}
      title={rowTitle(row)}
    >
      <span className={`${css.dot} ${TONE_DOT[rowDotTone(row)]}`} />
      {renaming ? (
        <input
          ref={inputRef}
          className={css.srRename}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onSubmitRename(row.id, draft) }
            if (e.key === 'Escape') { e.preventDefault(); onCancelRename() }
          }}
          onBlur={() => { onSubmitRename(row.id, draft) }}
        />
      ) : (
        <span className={`${css.srTitle}${active ? '' : ` ${css.srTitleDim}`}`}>{rowTitle(row)}</span>
      )}
      <span className={css.srTime}>{timeLabel(row.updatedAt)}</span>
    </button>
  )
}
