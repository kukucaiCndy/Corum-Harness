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
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ISessions, SessionSearchResultItem, SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  Bug, CalendarClock, CalendarRange, ChevronDown, Circle, CircleCheck, CircleDot,
  FileText, Folder, FolderOpen, ListTodo, LoaderCircle, MessageSquarePlus, Plus,
  Search, Square, SquareCheckBig, Users, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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
  group?: { members: Array<{ profileId: string; role: 'pm' | 'member'; profession?: string }> }
  createdAt: number
  lastOpenedAt: number
}

/** `corumAgent/listProfiles` 的浏览器镜像（团队段取成员显示名用）。 */
interface ProfileSummary {
  id: string
  nickname?: string
  title?: string
}

/** `corumProjectData` 管理段计数用的最小实体镜像。 */
interface RequirementMirror { id: string }
interface TaskMirror { id: string }
interface BugMirror { id: string }

/** `corumTeam/listTeams` 的浏览器镜像（创建向导团队下拉）。 */
interface TeamMirror {
  id: string
  name: string
  memberProfileIds: string[]
}

/** `corumProject/openProjectByPath` 结果镜像。 */
type OpenByPathResult =
  | { kind: 'existing'; project: CorumProject }
  | { kind: 'wizard'; cwd: string; suggestedName: string }

/** 创建向导状态（null = 未打开）。 */
interface WizardState {
  cwd: string
  suggestedName: string
}

/** 桌面桥原生目录选择器（preload 暴露）。 */
function pickDirectory(title: string): Promise<string | null> {
  const bridge = (window as unknown as {
    corumDesktop?: { pickDirectory?: (options?: { title?: string }) => Promise<{ path: string | null; cancelled?: boolean }> }
  }).corumDesktop
  if (bridge?.pickDirectory === undefined) return Promise.resolve(null)
  return bridge.pickDirectory({ title }).then(r => r.path)
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

/** 调用任意 Typert 服务（corumAgent / corumProjectData 等同构端点）。 */
async function callServiceRemote<T>(service: string, method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `${service}/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/${service}/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`${service}/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error(`${service}/${method}: rpcId mismatch`)
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
  // 项目详情：profile 目录（团队成员显示名）+ 管理段计数（需求/任务/BUG）。
  const [profiles, setProfiles] = useState<readonly ProfileSummary[]>([])
  const [manageCounts, setManageCounts] = useState<{ requirements: number; tasks: number; bugs: number } | null>(null)
  // 创建向导（打开空目录时弹出）。
  const [wizard, setWizard] = useState<WizardState | null>(null)
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

  // 团队段会话计数：成员 profileId → 其泳道会话数（泳道 sessionId 内嵌 profile 段）。
  const memberSessionCounts = new Map<string, number>()
  if (activeProject !== null) {
    for (const member of activeProject.group?.members ?? []) {
      const tag = `-agent${member.profileId}-`
      memberSessionCounts.set(member.profileId, rows.filter(row => row.id.includes(tag)).length)
    }
  }

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

  // 打开项目后：加载 profile 目录（团队成员显示名）+ 管理段计数（失败静默降级为占位）。
  useEffect(() => {
    if (activeProject === null) {
      setManageCounts(null)
      return
    }
    const projectId = activeProject.id
    let cancelled = false
    void callServiceRemote<{ profiles: ProfileSummary[] }>('corumAgent', 'listProfiles', {})
      .then(r => { if (!cancelled) setProfiles(r.profiles) })
      .catch(() => { /* profile 目录不可用时成员行退回显示 profileId */ })
    void Promise.all([
      callServiceRemote<{ requirements: RequirementMirror[] }>('corumProjectData', 'listRequirements', { projectId }),
      callServiceRemote<{ tasks: TaskMirror[] }>('corumProjectData', 'listTasks', { projectId }),
      callServiceRemote<{ bugs: BugMirror[] }>('corumProjectData', 'listBugs', { projectId }),
    ])
      .then(([reqs, tasks, bugs]) => {
        if (!cancelled) setManageCounts({ requirements: reqs.requirements.length, tasks: tasks.tasks.length, bugs: bugs.bugs.length })
      })
      .catch(() => { if (!cancelled) setManageCounts(null) })
    return () => { cancelled = true }
  }, [activeProject])

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

  // 「打开项目」：原生选目录 → openProjectByPath 分流（已有直读 / 空目录进向导）。
  const openProjectByPath = useCallback(async (): Promise<void> => {
    setProjectError(null)
    const path = await pickDirectory('打开项目目录')
    if (path === null) return // 用户取消
    setProjectsLoading(true)
    try {
      const result = await callProjectRemote<OpenByPathResult>('openProjectByPath', { cwd: path })
      if (result.kind === 'existing') {
        setActiveProject(result.project)
        await refreshProjects()
      } else {
        setWizard({ cwd: result.cwd, suggestedName: result.suggestedName })
        setProjectsLoading(false)
      }
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error))
      setProjectsLoading(false)
    }
  }, [refreshProjects])

  // 向导完成：activeProject 已由 completeSetup 返回，关掉向导刷新列表。
  const completeWizard = useCallback(async (project: CorumProject): Promise<void> => {
    setWizard(null)
    setActiveProject(project)
    await refreshProjects()
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
          profiles={profiles}
          manageCounts={manageCounts}
          memberSessionCounts={memberSessionCounts}
          loading={projectsLoading}
          error={projectError}
          onOpenProject={openProject}
          onOpenProjectByPath={() => { void openProjectByPath() }}
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
      {/* 项目创建向导（空目录触发）：portal 到 body 避开 backdrop-filter 包含块。 */}
      {wizard !== null && createPortal(
        <ProjectWizard
          cwd={wizard.cwd}
          suggestedName={wizard.suggestedName}
          profiles={profiles}
          onCancel={() => setWizard(null)}
          onDone={(project) => { void completeWizard(project) }}
        />,
        document.body,
      )}
    </div>
  )
}

/** 项目模式：真实项目列表 / 创建 / 打开，以及当前项目详情（管理段 + 团队段）。 */
function ProjectMode({
  projects, activeProject, profiles, manageCounts, memberSessionCounts, loading, error,
  onOpenProject, onOpenProjectByPath, onCloseProject, onRefresh,
}: {
  projects: readonly CorumProject[]
  activeProject: CorumProject | null
  profiles: readonly ProfileSummary[]
  manageCounts: { requirements: number; tasks: number; bugs: number } | null
  memberSessionCounts: ReadonlyMap<string, number>
  loading: boolean
  error: string | null
  onOpenProject: (id: string) => Promise<void>
  onOpenProjectByPath: () => void
  onCloseProject: () => void
  onRefresh: () => void
}) {
  const [showProjects, setShowProjects] = useState(false)

  if (activeProject !== null) {
    const members = activeProject.group?.members ?? []
    return (
      <section className={css.projectMode} aria-label="当前项目">
        <div className={css.projectDetail}>
          <div className={css.projectCard}>
            <div className={css.projectCardHead}>
              <FolderOpen size={16} strokeWidth={2} className={css.projectCardIcon} />
              <span className={css.projectCardTitle} title={activeProject.name}>{activeProject.name}</span>
              <button type="button" className={css.closeProject} title="关闭项目" onClick={onCloseProject}>
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            <span className={css.projectCardMeta}>{members.length} 位成员 · {activeProject.cwd ?? '未关联工作目录'}</span>
            {activeProject.description !== undefined && activeProject.description !== '' && (
              <p className={css.projectCardDescription}>{activeProject.description}</p>
            )}
          </div>
          <ManageSection counts={manageCounts} />
          <TeamSection members={members} profiles={profiles} sessionCounts={memberSessionCounts} />
        </div>
        <button type="button" className={css.btnOpenProject} onClick={() => { setShowProjects(v => !v); onRefresh() }}>
          <FolderOpen size={11} strokeWidth={2} /> 切换项目
        </button>
        {showProjects && <ProjectList projects={projects} activeId={activeProject.id} loading={loading} onOpen={onOpenProject} />}
      </section>
    )
  }

  return (
    <div className={css.projectMode}>
      {/* 主按钮（与任务模式「新建会话」同位同款）：打开项目——已有项目直读，
          空目录进创建向导（空目录即新建，不再单独提供「新建项目」按钮）。 */}
      <button type="button" className={css.btnNew} onClick={onOpenProjectByPath} disabled={loading}>
        {loading
          ? <LoaderCircle size={11} strokeWidth={2.5} className={css.loadingIcon} />
          : <FolderOpen size={11} strokeWidth={2.5} />} 打开项目
      </button>
      <div className={css.emptyState}>
        <FolderOpen size={28} strokeWidth={1.8} className={css.emptyIcon} />
        <span className={css.emptyTitle}>未打开项目</span>
        <span className={css.emptyHint}>打开项目开始协作 · 空目录即新建</span>
      </div>
      {error !== null && <div className={css.projectError} role="alert">{error}</div>}
      <button type="button" className={css.btnOpenProject} onClick={() => { setShowProjects(v => !v); onRefresh() }}>
        <FolderOpen size={11} strokeWidth={2} /> 最近项目
      </button>
      {showProjects && <ProjectList projects={projects} activeId={null} loading={loading} onOpen={onOpenProject} />}
    </div>
  )
}

/** 项目创建向导（design L2「项目创建向导」：① 基本信息 → ② 团队与成员 → ③ 创建完成）。 */
function ProjectWizard({ cwd, suggestedName, profiles, onCancel, onDone }: {
  cwd: string
  suggestedName: string
  profiles: readonly ProfileSummary[]
  onCancel: () => void
  onDone: (project: CorumProject) => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [name, setName] = useState(suggestedName)
  const [teams, setTeams] = useState<readonly TeamMirror[]>([])
  const [teamId, setTeamId] = useState<string>('')
  // whole=整队加入；部分成员加入时勾选 team 成员子集。
  const [whole, setWhole] = useState(true)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [created, setCreated] = useState<CorumProject | null>(null)

  // 进第 2 步时拉团队列表（此时用户确定要配成员）。
  useEffect(() => {
    if (step !== 2) return
    void callServiceRemote<{ teams: TeamMirror[] }>('corumTeam', 'listTeams', {})
      .then(r => {
        setTeams(r.teams)
        if (r.teams.length > 0 && teamId === '') setTeamId(r.teams[0].id)
      })
      .catch(() => { /* 团队服务不可用 → 仅可跳过 */ })
  }, [step, teamId])

  const team = teams.find(t => t.id === teamId)
  const teamMembers = team?.memberProfileIds ?? []
  const displayName = (profileId: string): string =>
    profiles.find(p => p.id === profileId)?.nickname
    ?? profiles.find(p => p.id === profileId)?.title
    ?? profileId

  const toggleMember = (profileId: string): void => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(profileId)) next.delete(profileId)
      else next.add(profileId)
      return next
    })
  }

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const input: Record<string, unknown> = { name: name.trim(), cwd }
      if (team !== undefined) {
        if (whole) {
          input.teamIds = [team.id]
        } else if (picked.size > 0) {
          input.members = [...picked].map(profileId => ({ profileId, fromTeam: team.id }))
        }
      }
      const result = await callProjectRemote<{ project: CorumProject }>('completeSetup', { input })
      setCreated(result.project)
      setStep(3)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const memberCount = created?.group?.members.length ?? 0

  return (
    <div className={css.wizardOverlay} role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !submitting) onCancel() }}>
      <div className={css.wizardDialog} role="dialog" aria-modal="true" aria-label="创建项目">
        <header className={css.wizardHeader}>
          <span className={css.wizardTitle}>创建项目</span>
          <button type="button" className={css.closeProject} title="取消" onClick={onCancel} disabled={submitting}>
            <X size={14} strokeWidth={2} />
          </button>
        </header>
        {/* 步骤条：① 基本信息 —— ② 团队与成员 */}
        <div className={css.wizardStepper}>
          <span className={`${css.wizardStep}${step >= 1 ? ` ${css.wizardStepActive}` : ''}`}>1 · 基本信息</span>
          <span className={css.wizardStepConn} />
          <span className={`${css.wizardStep}${step >= 2 ? ` ${css.wizardStepActive}` : ''}`}>2 · 团队与成员</span>
        </div>
        <div className={css.wizardDivider} />

        {step === 1 && (
          <div className={css.wizardBody}>
            <label className={css.wizardLabel} htmlFor="wizard-name">项目名称</label>
            <input
              id="wizard-name"
              className={css.wizardInput}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="项目名称"
            />
            <span className={css.wizardLabel}>目录</span>
            <div className={css.wizardDir}>
              <Folder size={12} strokeWidth={2} className={css.wizardDirIcon} />
              <span className={css.wizardDirPath} title={cwd}>{cwd}</span>
              <span className={css.wizardDirBadge}>空目录</span>
            </div>
            <span className={css.wizardHint}>空目录将作为新项目创建</span>
          </div>
        )}

        {step === 2 && (
          <div className={css.wizardBody}>
            <span className={css.wizardLabel}>选取团队</span>
            {teams.length === 0 ? (
              <div className={css.wizardHint}>暂无团队——可直接创建（仅带 PM 助理），项目建成后再添加成员。</div>
            ) : (
              <>
                <div className={css.wizardTeamPicker}>
                  <Users size={12} strokeWidth={2} className={css.wizardDirIcon} />
                  <select
                    className={css.wizardTeamSelect}
                    value={teamId}
                    onChange={(e) => { setTeamId(e.target.value); setPicked(new Set()) }}
                    aria-label="选取团队"
                  >
                    {teams.map(t => (
                      <option key={t.id} value={t.id}>{t.name} · {t.memberProfileIds.length} 名成员</option>
                    ))}
                  </select>
                  <ChevronDown size={12} strokeWidth={2} className={css.wizardDirIcon} />
                </div>
                <button type="button" className={css.wizardRadio} onClick={() => setWhole(true)} aria-pressed={whole}>
                  {whole ? <CircleDot size={13} strokeWidth={2} className={css.wizardRadioOn} /> : <Circle size={13} strokeWidth={2} className={css.wizardRadioOff} />}
                  整个团队加入
                </button>
                <button type="button" className={css.wizardRadio} onClick={() => setWhole(false)} aria-pressed={!whole}>
                  {!whole ? <CircleDot size={13} strokeWidth={2} className={css.wizardRadioOn} /> : <Circle size={13} strokeWidth={2} className={css.wizardRadioOff} />}
                  部分成员加入
                </button>
                {!whole && (
                  <div className={css.wizardMembers}>
                    {teamMembers.map(profileId => {
                      const on = picked.has(profileId)
                      return (
                        <button key={profileId} type="button" className={css.wizardMemberRow} onClick={() => toggleMember(profileId)} aria-pressed={on}>
                          {on ? <SquareCheckBig size={13} strokeWidth={2} className={css.wizardRadioOn} /> : <Square size={13} strokeWidth={2} className={css.wizardRadioOff} />}
                          <span className={css.wizardMemberName}>{displayName(profileId)}</span>
                          <span className={css.wizardMemberId}>{profileId}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            )}
            {submitError !== null && <div className={css.projectError} role="alert">{submitError}</div>}
          </div>
        )}

        {step === 3 && (
          <div className={css.wizardBody}>
            <div className={css.wizardDone}>
              <CircleCheck size={32} strokeWidth={1.8} className={css.wizardDoneIcon} />
              <span className={css.wizardDoneTitle}>项目已创建</span>
              <span className={css.wizardDoneSub}>{created?.name ?? name} · 已加入 {memberCount} 名成员</span>
            </div>
          </div>
        )}

        <footer className={css.wizardFooter}>
          {step === 1 && (
            <>
              <button type="button" className={css.wizardBtnGhost} onClick={onCancel}>取消</button>
              <button type="button" className={css.wizardBtnPrimary} disabled={name.trim() === ''} onClick={() => setStep(2)}>下一步</button>
            </>
          )}
          {step === 2 && (
            <>
              <button type="button" className={css.wizardBtnGhost} onClick={() => setStep(1)} disabled={submitting}>上一步</button>
              <button type="button" className={css.wizardBtnPrimary} disabled={submitting} onClick={() => { void submit() }}>
                {submitting ? '创建中…' : '创建项目'}
              </button>
            </>
          )}
          {step === 3 && (
            <button type="button" className={css.wizardBtnPrimary} onClick={() => { if (created !== null) onDone(created) }}>
              进入项目
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

/** 管理段（design 项目详情：计划/任务/事件/文档/问题 五维计数行）。 */
function ManageSection({ counts }: {
  counts: { requirements: number; tasks: number; bugs: number } | null
}) {
  const items: Array<{ key: string; label: string; icon: LucideIcon; count: number | null }> = [
    { key: 'plan', label: '计划', icon: CalendarRange, count: null },
    { key: 'task', label: '任务', icon: ListTodo, count: counts?.tasks ?? null },
    { key: 'event', label: '事件', icon: CalendarClock, count: null },
    { key: 'doc', label: '文档', icon: FileText, count: null },
    { key: 'issue', label: '问题', icon: Bug, count: counts?.bugs ?? null },
  ]
  return (
    <section className={css.manageSection} aria-label="项目管理">
      <div className={css.secHead}>
        <ListTodo size={12} strokeWidth={2} className={css.secHeadIcon} />
        <span className={css.secHeadTitle}>管理</span>
      </div>
      <div className={css.manageList}>
        {items.map(item => (
          <div key={item.key} className={css.manageRow} data-pending={item.count === null || undefined}>
            <item.icon size={13} strokeWidth={2} className={css.manageIcon} />
            <span className={css.manageLabel}>{item.label}</span>
            <span className={css.manageCount}>{item.count ?? '—'}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** 团队段成员。 */
type GroupMember = NonNullable<CorumProject['group']>['members'][number]

/** 成员显示名：profile 目录的 nickname/title 优先，退回 profileId。 */
function memberDisplayName(member: GroupMember, profiles: readonly ProfileSummary[]): string {
  const profile = profiles.find(p => p.id === member.profileId)
  return profile?.nickname ?? profile?.title ?? member.profileId
}

/** 成员角色标签：数据层专业帽子优先，退回调度角色。 */
function memberRoleLabel(member: GroupMember): string {
  if (member.profession !== undefined) {
    const map: Record<string, string> = { pd: '产品', techLead: '技术负责人', dev: '开发', qa: '测试' }
    return map[member.profession] ?? member.profession
  }
  return member.role === 'pm' ? 'PM' : '成员'
}

/** 团队段（design 项目详情：成员组 = chevron + 状态点 + 名称 + 角色标签 + 会话计数）。 */
function TeamSection({ members, profiles, sessionCounts }: {
  members: readonly GroupMember[]
  profiles: readonly ProfileSummary[]
  sessionCounts: ReadonlyMap<string, number>
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <section className={css.teamSection} aria-label="项目团队">
      <button type="button" className={css.secHead} onClick={() => setCollapsed(v => !v)} aria-expanded={!collapsed}>
        <ChevronDown size={12} strokeWidth={2} className={`${css.teamChevron}${collapsed ? ` ${css.teamChevronCollapsed}` : ''}`} />
        <Users size={12} strokeWidth={2} className={css.secHeadIcon} />
        <span className={css.secHeadTitle}>团队</span>
        <span className={css.secHeadBadge}>{members.length}</span>
      </button>
      {!collapsed && (
        members.length === 0 ? (
          <div className={css.teamEmpty}>暂无成员</div>
        ) : (
          <div className={css.teamList}>
            {members.map(member => {
              const sessions = sessionCounts.get(member.profileId) ?? 0
              return (
                <div key={member.profileId} className={css.teamRow} title={member.profileId}>
                  <span className={`${css.dot} ${sessions > 0 ? css.dotBrand : css.dotIdle}`} />
                  <span className={css.teamName}>{memberDisplayName(member, profiles)}</span>
                  <span className={css.teamRole}>{memberRoleLabel(member)}</span>
                  {sessions > 0 && <span className={css.teamCount}>{sessions}</span>}
                </div>
              )
            })}
          </div>
        )
      )}
    </section>
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
