/**
 * SessionSidebar — the IDE left column, the project-centric navigator
 * (design.pen ① 项目导航 C8YKJS 浅 / a3RJ4n 深). Structure follows the design
 * frame's children order exactly: brand-logo (b3TLZ / brand-img) → divider
 * (E6I4at) → project-actions (EBAwJ: 新建项目/打开项目) → 「项目」标题 (P0Uk90)
 * → project-picker (RXEsr) → sec-manage (Fi7xf: 计划/任务/事件/文档/问题) →
 * sec-team (btOIK: 团队段头 + 按 Agent 分组的会话列表) → region-actions.
 *
 * Data: the session list still rides the runtime object layer's sessions feed
 * (useSyncExternalStore); the project/team/manage grouping is a static design
 * scaffold until the creation-mode Agent source lands. Real sessions are shown
 * under the first agent group for now (member attribution comes later).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ISessions, SessionSearchResultItem, SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  Activity, CalendarCheck, Check, ChevronDown, ChevronRight, ChevronsUpDown,
  CircleAlert, FileText, Folder, FolderOpen, LayoutList, Plus, Search,
  SquareCheckBig, Users, X,
} from 'lucide-react'
import css from './SessionSidebar.module.css'

/** Injected actions + the live feed (see client/index.ts apply). */
export interface SessionSidebarInjected {
  /** The sessions standard feed (list + selection). */
  list: ISessions['list']
  /** Current workspace display name (the project picker's project label). */
  workspaceName: string
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

/** Design scaffold: 管理段五项（design sec-manage，图标 + 名 + 计数）。 */
const MANAGE_ITEMS = [
  { icon: 'calendar-check', label: '计划', count: 12 },
  { icon: 'square-check-big', label: '任务', count: 12 },
  { icon: 'activity', label: '事件', count: 3 },
  { icon: 'file-text', label: '文档', count: 12 },
  { icon: 'circle-alert', label: '问题', count: 12 },
] as const

/** Design scaffold: 项目列表（L2 项目选择器展开态 picker-dropdown 的 pi-* 项）。 */
const PROJECTS = [
  { name: '矩道 kkc-desktop', sub: '5 成员 · 12 任务' },
  { name: 'corum-ide 重构', sub: '3 成员 · 8 任务' },
  { name: 'mobile-app', sub: '4 成员 · 21 任务' },
] as const

/** 管理段图标映射（design lucide 名 → lucide-react 组件）。 */
function ManageIcon({ name }: { name: string }) {
  const cls = css.manageIcon
  switch (name) {
    case 'calendar-check': return <CalendarCheck size={13} strokeWidth={2} className={cls} />
    case 'square-check-big': return <SquareCheckBig size={13} strokeWidth={2} className={cls} />
    case 'activity': return <Activity size={13} strokeWidth={2} className={cls} />
    case 'file-text': return <FileText size={13} strokeWidth={2} className={cls} />
    case 'circle-alert': return <CircleAlert size={13} strokeWidth={2} className={cls} />
    default: return <FileText size={13} strokeWidth={2} className={cls} />
  }
}

/** The IDE left column (see module doc). */
export function SessionSidebar({ wide, list, workspaceName, open, startSession, search, rename }: SessionSidebarProps) {
  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResultItem[] | null>(null)
  // Rename editing: the session id currently being renamed (null = none).
  const [renamingId, setRenamingId] = useState<SessionId | null>(null)
  // Collapse state per session group (all expanded by default).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  // 项目区块收起（标题/选择器/新建打开整段）；选择器下拉（多项目切换）。
  const [projectCollapsed, setProjectCollapsed] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeProject, setActiveProject] = useState(0)
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

  const toggleGroup = useCallback((name: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

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

  // Group sessions by their composing agent preset (real attribution). Sessions
  // with no preset (ordinary chats, and subagents reported under their own
  // address) collapse into a single "会话" bucket so the counts stay honest
  // instead of being padded into the design's hardcoded agent roster.
  const sessionGroups = ((): { name: string; rows: SessionSummary[] }[] => {
    const byPreset = new Map<string, SessionSummary[]>()
    const plain: SessionSummary[] = []
    for (const row of rows) {
      const preset = row.agentPreset
      if (preset === undefined || preset === '') {
        plain.push(row)
        continue
      }
      const bucket = byPreset.get(preset)
      if (bucket === undefined) byPreset.set(preset, [row])
      else bucket.push(row)
    }
    const groups = [...byPreset.entries()].map(([name, groupRows]) => ({ name, rows: groupRows }))
    if (plain.length > 0 || groups.length === 0) groups.unshift({ name: '会话', rows: plain })
    return groups
  })()

  return (
    <div className={css.sidebar} data-wide={wide || undefined}>
      {/* 品牌行：brand-logo 组件（NwUQL）190×40 图片横幅 + 右上角区域关闭按钮。
          关闭固定在该区域右上角，dispatch corum:close-region 由壳隐藏本区域。 */}
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
        <button
          type="button"
          className={css.regionClose}
          title="关闭此区域（可在状态栏「添加区域」恢复）"
          onClick={() => window.dispatchEvent(new CustomEvent('corum:close-region', { detail: { slot: 'corum.sidebar' } }))}
        >
          <X size={16} strokeWidth={2} />
        </button>
      </header>
      <div className={css.brandDivider} />

      {/* project-actions（EBAwJ）：新建项目 / 打开项目。 */}
      <div className={css.projectActions}>
        <button type="button" className={css.btnNew} onClick={() => startSession()} title="在当前工作区新建会话">
          <Plus size={11} strokeWidth={2.5} /> 新建会话
        </button>
        <button type="button" className={css.btnOpen}>
          <FolderOpen size={11} strokeWidth={2} /> 打开项目
        </button>
      </div>

      {/* 「项目」标题（P0Uk90）+ 区块收起 chevron：点击收起/展开整个项目区
          （标题行 + 选择器 + 新建/打开），为多项目切换与窄空间让位。 */}
      <div className={css.projHead}>
        <button
          type="button"
          className={css.projToggle}
          aria-expanded={!projectCollapsed}
          onClick={() => { setProjectCollapsed(v => !v); setPickerOpen(false) }}
          title={projectCollapsed ? '展开项目区' : '收起项目区'}
        >
          {projectCollapsed
            ? <ChevronRight size={12} strokeWidth={2} className={css.projToggleIcon} />
            : <ChevronDown size={12} strokeWidth={2} className={css.projToggleIcon} />}
          <span className={css.projTitle}>项目</span>
        </button>
      </div>

      {!projectCollapsed && (
        <div className={css.projectBlock}>
          {/* project-picker（RXEsr）+ 展开下拉（L2 picker-dropdown）：点击切换项目。 */}
          <button
            type="button"
            className={css.projectPicker}
            title="切换项目"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen(v => !v)}
          >
            <FolderOpen size={16} strokeWidth={2} className={css.projectIcon} />
            <span className={css.projectMeta}>
              <span className={css.projectName}>{PROJECTS[activeProject].name}</span>
              <span className={css.projectSub}>{PROJECTS[activeProject].sub} · 进行中</span>
            </span>
            <ChevronsUpDown size={13} strokeWidth={2} className={css.projectChev} />
          </button>
          {pickerOpen && (
            <div className={css.pickerDropdown}>
              {PROJECTS.map((p, i) => (
                <button
                  key={p.name}
                  type="button"
                  className={`${css.pickerItem}${i === activeProject ? ` ${css.pickerItemActive}` : ''}`}
                  onClick={() => { setActiveProject(i); setPickerOpen(false) }}
                >
                  {i === activeProject
                    ? <Folder size={14} strokeWidth={2} className={css.pickerItemIconActive} />
                    : <Folder size={14} strokeWidth={2} className={css.pickerItemIcon} />}
                  <span className={css.pickerItemMeta}>
                    <span className={css.pickerItemName}>{p.name}</span>
                    <span className={css.pickerItemSub}>{p.sub}</span>
                  </span>
                  {i === activeProject && <Check size={13} strokeWidth={2} className={css.pickerItemCheck} />}
                </button>
              ))}
              <div className={css.pickerDiv} />
              <button type="button" className={css.pickerNew} onClick={() => { setPickerOpen(false); startSession() }}>
                <Plus size={14} strokeWidth={2} className={css.pickerNewIcon} />
                <span className={css.pickerNewLabel}>新建项目…</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* sec-manage（Fi7xf）：管理段五项。 */}
      <section className={css.secManage}>
        <div className={css.secHead}>
          <LayoutList size={12} strokeWidth={2} className={css.secHeadIcon} />
          <span className={css.secHeadTitle}>管理</span>
        </div>
        {MANAGE_ITEMS.map(item => (
          <button key={item.label} type="button" className={css.manageRow}>
            <ManageIcon name={item.icon} />
            <span className={css.manageLabel}>{item.label}</span>
            <span className={css.manageCount}>{item.count}</span>
          </button>
        ))}
      </section>

      {/* sec-team（btOIK）：会话段头 + 按 Agent 预设分组的会话列表。 */}
      <section className={css.secTeam}>
        <div className={css.secHead}>
          <Users size={12} strokeWidth={2} className={css.secHeadIcon} />
          <span className={css.secHeadTitle}>会话</span>
          <button type="button" className={css.secAdd} title="新建会话" onClick={() => startSession()}>
            <Plus size={11} strokeWidth={2} />
          </button>
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

        <div className={css.teamBody}>
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
          ) : (
            sessionGroups.map(g => {
              const isCollapsed = collapsed.has(g.name)
              return (
                <div key={g.name} className={css.group}>
                  <button
                    type="button"
                    className={css.gh}
                    onClick={() => toggleGroup(g.name)}
                  >
                    {isCollapsed
                      ? <ChevronRight size={10} strokeWidth={2} className={css.ghChev} />
                      : <ChevronDown size={10} strokeWidth={2} className={css.ghChev} />}
                    <span className={css.ghName}>{g.name}</span>
                    <span className={css.ghCnt}>{g.rows.length}</span>
                  </button>
                  {!isCollapsed && (
                    g.rows.length === 0
                      ? null
                      : g.rows.map(row => (
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
              )
            })
          )}
        </div>
      </section>
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
