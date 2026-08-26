/**
 * SessionsPane — 侧栏任务模式内容（design.pen L2 任务模式：新建会话 + 会话列表）。
 *
 * 开源版核心功能面。占 corum.sidebar.sessions 子槽，由骨架 renderSlot 渲染。
 * 数据全部来自运行时对象层（ctx.sessions / ctx.workspaces），不经 RPC。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions, SessionSearchResultItem, SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import { MessageSquarePlus, Plus, Search, Users } from 'lucide-react'
import css from '@corum/corum-ide-ui/sidebar.module.css'

/** Injected actions + the live feed（由 corum.sidebar.sessions 槽的 occupant 插件注入）。 */
export interface SessionsPaneInjected {
  /** The sessions standard feed (list + selection). */
  list: ISessions['list']
  open: (sessionId: SessionId) => void
  startSession: () => void
  search: (query: string, signal: AbortSignal) => Promise<SessionSearchResultItem[]>
  rename: (sessionId: SessionId, title: string) => Promise<void>
}

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

/** 团队成员状态点色调（design gh dot：brand/success/success/warn）。 */
type Tone = 'brand' | 'success' | 'warn' | 'idle'

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

/** tone → CSS Modules 状态点类名的显式映射（避免动态键拼在 CSS Modules 下失配）。 */
const TONE_DOT: Record<Tone, string> = {
  brand: css.dotBrand,
  success: css.dotSuccess,
  warn: css.dotWarn,
  idle: css.dotIdle,
}

/** 任务模式内容（design ①：新建会话 + 搜索 + 扁平会话列表）。 */
export function SessionsPane({ list, open, startSession, search, rename }: SessionsPaneInjected) {
  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResultItem[] | null>(null)
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

  return (
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
