/**
 * DistillReviewView —— 经验沉淀取舍视图。
 *
 * 接 `corumAgent/distill*` 五个 RPC（经 SplitPaneRpcContext 下发的 CorumRpcCall）：
 *   - distillStatus({jobId}) → DistillJob | null：查任务状态与候选列表。
 *   - distillReplay({sessionId}) → {messages}：会话回放（只读消息流）。
 *   - distillCommit({jobId, items}) → {written, failed}：写入选中记忆。
 *   - distillDiscard({jobId, candidateIds?}) → {discarded}：舍弃候选。
 *   - distillListPending() → {jobs}：列出其他待取舍任务。
 *
 * ## 布局
 *
 * - 顶栏：标题 + 关闭按钮（调 close / closeSplitPane）。
 * - 左栏 tabs：「会话回放」（distillReplay 只读消息流）与「候选列表」（全部候选含已处理态）。
 * - 右栏：pending 候选卡片（勾选框默认全选、fact 可编辑 textarea、importance 数字输入
 *   0-100、retention 下拉），底部「写入 N 条选中记忆」+「全部舍弃」（二次确认）。
 * - running 时每 2s 轮询 distillStatus 显示 phase；done 后展示候选。
 * - commit/discard 后刷新 job 状态并显示结果（写入 N 条/失败 M 条）。
 * - job 为 null 时显示「任务已过期」空态 + distillListPending 列出其他待取舍任务入口。
 * - props 入参 {jobId?, sessionId?}：无 jobId 时先 distillListPending 取最新。
 *
 * 比例持久化 storageKey='distill-review'。错误态不白屏（RPC 失败显示可重试提示）。
 *
 * @module corum-ui-split-pane/client/DistillReviewView
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Loader2, MessageSquare, ListChecks, RefreshCw, X } from 'lucide-react'
import { SplitPane } from './SplitPane.tsx'
import { useSplitPaneRpc } from './face.ts'
import type {
  DistillCandidate,
  DistillJob,
  DistillReplayMessage,
  Retention,
} from './face.ts'
import css from './DistillReviewView.module.css'

/** DistillReviewView 的 props。 */
export interface DistillReviewViewProps {
  /** 任务 ID（无则从 distillListPending 取最新）。 */
  jobId?: string
  /** 会话 ID（无则从 job.sessionId 取）。 */
  sessionId?: string
  /** 关闭回调（occupant 下发，调 closeSplitPane）。 */
  close?: () => void
}

/** 左栏 tab。 */
type LeftTab = 'replay' | 'candidates'

/** 候选编辑态（本地可编辑的 pending 候选）。 */
interface CandidateEdit {
  id: string
  fact: string
  importance: number
  retention: Retention
  checked: boolean
}

/** commit/discard 操作结果提示。 */
interface ActionResult {
  kind: 'commit' | 'discard'
  written?: number
  failed?: number
  discarded?: number
}

/** 运行态轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 2000

/** retention 选项（下拉用）。 */
const RETENTION_OPTIONS: ReadonlyArray<{ value: Retention; label: string }> = [
  { value: 'temporary', label: '临时' },
  { value: 'short', label: '短期' },
  { value: 'long', label: '长期' },
  { value: 'permanent', label: '永久' },
]

/**
 * 渲染经验沉淀取舍视图。
 * @param props - 见 {@link DistillReviewViewProps}。
 * @returns 视图元素。
 */
export function DistillReviewView(props: DistillReviewViewProps): ReactNode {
  const { jobId: initialJobId, sessionId: initialSessionId, close } = props
  const rpc = useSplitPaneRpc()

  const [job, setJob] = useState<DistillJob | null>(null)
  const [jobId, setJobId] = useState<string | undefined>(initialJobId)
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [leftTab, setLeftTab] = useState<LeftTab>('replay')
  const [replay, setReplay] = useState<DistillReplayMessage[]>([])
  const [replayLoading, setReplayLoading] = useState<boolean>(false)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Map<string, CandidateEdit>>(new Map())
  const [actionResult, setActionResult] = useState<ActionResult | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<boolean>(false)
  const [pendingJobs, setPendingJobs] = useState<DistillJob[]>([])
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [expired, setExpired] = useState<boolean>(false)

  /** 轮询定时器 ref。 */
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  /** 最新 jobId ref（轮询闭包用）。 */
  const jobIdRef = useRef(jobId)
  jobIdRef.current = jobId

  /** 调 distillStatus 刷新 job。 */
  const refreshJob = useCallback(async (jid: string): Promise<void> => {
    if (rpc === null) {
      setError('RPC 通道未就绪')
      setLoading(false)
      return
    }
    try {
      const result = await rpc<DistillJob | null>('corumAgent', 'distillStatus', { jobId: jid })
      setJob(result)
      setExpired(result === null)
      if (result !== null) {
        setSessionId((prev) => prev ?? result.sessionId)
        // 初始化 pending 候选的编辑态（只初始化一次，避免覆盖用户编辑）。
        setEdits((prev) => {
          const next = new Map(prev)
          for (const c of result.candidates ?? []) {
            if (c.state === 'pending' && !next.has(c.id)) {
              next.set(c.id, {
                id: c.id,
                fact: c.fact,
                importance: c.importance,
                retention: c.retention,
                checked: true,
              })
            }
          }
          return next
        })
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [rpc])

  /** 初始化：无 jobId 时先 distillListPending 取最新。 */
  useEffect(() => {
    if (rpc === null) return
    void (async (): Promise<void> => {
      if (jobIdRef.current !== undefined) {
        await refreshJob(jobIdRef.current)
        return
      }
      // 无 jobId：取最新 pending job。
      try {
        const result = await rpc<{ jobs: DistillJob[] }>('corumAgent', 'distillListPending', {})
        const jobs = result.jobs ?? []
        setPendingJobs(jobs)
        if (jobs.length > 0) {
          const latest = jobs[0]
          setJobId(latest.jobId)
          await refreshJob(latest.jobId)
        } else {
          setExpired(true)
          setLoading(false)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc])

  /** running 时轮询。 */
  useEffect(() => {
    if (job === null || job.status !== 'running') {
      if (pollRef.current !== undefined) {
        clearInterval(pollRef.current)
        pollRef.current = undefined
      }
      return
    }
    const jid = job.jobId
    pollRef.current = setInterval(() => {
      void refreshJob(jid)
    }, POLL_INTERVAL_MS)
    return () => {
      if (pollRef.current !== undefined) {
        clearInterval(pollRef.current)
        pollRef.current = undefined
      }
    }
  }, [job, refreshJob])

  /** 加载会话回放。 */
  const loadReplay = useCallback(async (sid: string): Promise<void> => {
    if (rpc === null) return
    setReplayLoading(true)
    setReplayError(null)
    try {
      const result = await rpc<{ messages: DistillReplayMessage[] }>('corumAgent', 'distillReplay', { sessionId: sid })
      setReplay(result.messages ?? [])
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : String(err))
    } finally {
      setReplayLoading(false)
    }
  }, [rpc])

  /** 切到回放 tab 时加载（按需）。 */
  useEffect(() => {
    if (leftTab !== 'replay') return
    const sid = sessionId ?? job?.sessionId
    if (sid === undefined) return
    if (replay.length > 0) return
    void loadReplay(sid)
  }, [leftTab, sessionId, job, replay.length, loadReplay])

  /** 刷新 pending jobs 列表（job 过期空态用）。 */
  const refreshPendingJobs = useCallback(async (): Promise<void> => {
    if (rpc === null) return
    try {
      const result = await rpc<{ jobs: DistillJob[] }>('corumAgent', 'distillListPending', {})
      setPendingJobs(result.jobs ?? [])
    } catch {
      // 静默——列表是辅助入口。
    }
  }, [rpc])

  /** 切换到某个 pending job。 */
  const switchToJob = useCallback((jid: string): void => {
    setJobId(jid)
    setJob(null)
    setEdits(new Map())
    setReplay([])
    setActionResult(null)
    setLoading(true)
    void refreshJob(jid)
  }, [refreshJob])

  /** 更新单个候选编辑态。 */
  const updateEdit = useCallback((id: string, patch: Partial<CandidateEdit>): void => {
    setEdits((prev) => {
      const next = new Map(prev)
      const existing = next.get(id)
      if (existing === undefined) return prev
      next.set(id, { ...existing, ...patch })
      return next
    })
  }, [])

  /** 全选 / 全不选 pending 候选。 */
  const toggleAllChecked = useCallback((checked: boolean): void => {
    setEdits((prev) => {
      const next = new Map(prev)
      for (const [id, edit] of next) {
        next.set(id, { ...edit, checked })
      }
      return next
    })
  }, [])

  /** 提交写入选中记忆。 */
  const handleCommit = useCallback(async (): Promise<void> => {
    if (rpc === null || jobId === undefined) return
    const selected: CandidateEdit[] = []
    for (const edit of edits.values()) {
      if (edit.checked) selected.push(edit)
    }
    if (selected.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await rpc<{ written: number; failed: number }>('corumAgent', 'distillCommit', {
        jobId,
        items: selected.map((e) => ({ id: e.id, fact: e.fact, importance: e.importance, retention: e.retention })),
      })
      setActionResult({ kind: 'commit', written: result.written, failed: result.failed })
      // 刷新 job 状态（committed 候选态变化）。
      await refreshJob(jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [rpc, jobId, edits, refreshJob])

  /** 舍弃全部候选（二次确认）。 */
  const handleDiscard = useCallback(async (): Promise<void> => {
    if (rpc === null || jobId === undefined) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await rpc<{ discarded: number }>('corumAgent', 'distillDiscard', { jobId })
      setActionResult({ kind: 'discard', discarded: result.discarded })
      setConfirmDiscard(false)
      await refreshJob(jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [rpc, jobId, refreshJob])

  // ── 渲染分支 ──

  if (rpc === null) {
    return <ErrorState message="RPC 通道未就绪" />
  }

  if (loading && job === null && !expired) {
    return <LoadingState label="加载中…" />
  }

  if (expired && job === null) {
    return (
      <div className={css.container}>
        <Header title="经验沉淀取舍" {...(close !== undefined && { onClose: close })} />
        <div className={css.body}>
          <div className={css.emptyState}>
            <AlertCircle size={32} className={css.emptyIcon} />
            <p className={css.emptyText}>任务已过期或不存在</p>
            {pendingJobs.length > 0 ? (
              <div className={css.pendingList}>
                <p className={css.pendingHint}>其他待取舍任务：</p>
                {pendingJobs.map((j) => (
                  <button key={j.jobId} type="button" className={css.pendingJobBtn} onClick={() => switchToJob(j.jobId)}>
                    {j.origin ?? j.jobId} · {j.status} · {j.factCount} 条
                  </button>
                ))}
              </div>
            ) : (
              <button type="button" className={css.retryBtn} onClick={() => void refreshPendingJobs()}>
                <RefreshCw size={14} /> 刷新待取舍列表
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (job === null) {
    return <ErrorState message="无法加载任务" onRetry={() => { if (jobId !== undefined) void refreshJob(jobId) }} />
  }

  const pendingCandidates: DistillCandidate[] = (job.candidates ?? []).filter((c) => c.state === 'pending')
  const allCandidates: DistillCandidate[] = job.candidates ?? []
  const pendingEdits: CandidateEdit[] = pendingCandidates
    .map((c) => edits.get(c.id))
    .filter((e): e is CandidateEdit => e !== undefined)
  const selectedCount = pendingEdits.filter((e) => e.checked).length

  const leftPane = (
    <div className={css.leftPane}>
      <div className={css.tabs}>
        <button
          type="button"
          className={leftTab === 'replay' ? css.tabActive : css.tab}
          onClick={() => setLeftTab('replay')}
        >
          <MessageSquare size={14} /> 会话回放
        </button>
        <button
          type="button"
          className={leftTab === 'candidates' ? css.tabActive : css.tab}
          onClick={() => setLeftTab('candidates')}
        >
          <ListChecks size={14} /> 候选列表
        </button>
      </div>
      <div className={css.tabBody}>
        {leftTab === 'replay' ? (
          <ReplayPane messages={replay} loading={replayLoading} error={replayError} onRetry={() => { const sid = sessionId ?? job.sessionId; if (sid !== undefined) void loadReplay(sid) }} />
        ) : (
          <CandidateListPane candidates={allCandidates} />
        )}
      </div>
    </div>
  )

  const rightPane = (
    <div className={css.rightPane}>
      {job.status === 'running' && (
        <div className={css.phaseBanner}>
          <Loader2 size={14} className={css.spin} />
          <span>进行中：{job.phase}</span>
        </div>
      )}
      {error !== null && (
        <div className={css.errorBanner}>
          <AlertCircle size={14} />
          <span>{error}</span>
          <button type="button" className={css.retrySmall} onClick={() => { if (jobId !== undefined) void refreshJob(jobId) }}>重试</button>
        </div>
      )}
      {actionResult !== null && (
        <div className={css.resultBanner}>
          {actionResult.kind === 'commit' ? (
            <span>写入 {actionResult.written ?? 0} 条{actionResult.failed !== undefined && actionResult.failed > 0 ? `，失败 ${actionResult.failed} 条` : ''}</span>
          ) : (
            <span>已舍弃 {actionResult.discarded ?? 0} 条</span>
          )}
          <button type="button" className={css.resultDismiss} onClick={() => setActionResult(null)}>✕</button>
        </div>
      )}
      <div className={css.candidateCards}>
        {pendingCandidates.length === 0 ? (
          <div className={css.noPending}>无待处理候选</div>
        ) : (
          <>
            <div className={css.selectAllRow}>
              <label className={css.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={pendingEdits.length > 0 && pendingEdits.every((e) => e.checked)}
                  onChange={(e) => toggleAllChecked(e.target.checked)}
                />
                全选（{selectedCount}/{pendingCandidates.length}）
              </label>
            </div>
            {pendingCandidates.map((c) => {
              const edit = edits.get(c.id)
              if (edit === undefined) return null
              return (
                <CandidateCard
                  key={c.id}
                  edit={edit}
                  onChange={(patch) => updateEdit(c.id, patch)}
                />
              )
            })}
          </>
        )}
      </div>
      <div className={css.bottomBar}>
        <button
          type="button"
          className={css.btnPrimary}
          disabled={submitting || selectedCount === 0}
          onClick={() => void handleCommit()}
        >
          写入 {selectedCount} 条选中记忆
        </button>
        {confirmDiscard ? (
          <div className={css.confirmInline}>
            <span>确认舍弃全部？</span>
            <button type="button" className={css.btnDangerSm} disabled={submitting} onClick={() => void handleDiscard()}>确认舍弃</button>
            <button type="button" className={css.btnCancelSm} disabled={submitting} onClick={() => setConfirmDiscard(false)}>取消</button>
          </div>
        ) : (
          <button
            type="button"
            className={css.btnDanger}
            disabled={submitting || pendingCandidates.length === 0}
            onClick={() => setConfirmDiscard(true)}
          >
            全部舍弃
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className={css.container}>
      <Header title="经验沉淀取舍" {...(close !== undefined && { onClose: close })} />
      <div className={css.body}>
        <SplitPane
          left={leftPane}
          right={rightPane}
          storageKey="distill-review"
          defaultRatio={0.5}
        />
      </div>
    </div>
  )
}

/* ── 子组件 ── */

/** 顶栏。 */
function Header(props: { title: string; onClose?: () => void }): ReactNode {
  const { title, onClose } = props
  return (
    <header className={css.header}>
      <span className={css.headerTitle}>{title}</span>
      {onClose !== undefined && (
        <button type="button" className={css.closeBtn} onClick={onClose} aria-label="关闭">
          <X size={16} />
        </button>
      )}
    </header>
  )
}

/** 加载态。 */
function LoadingState(props: { label: string }): ReactNode {
  return (
    <div className={css.container}>
      <div className={css.loading}>
        <Loader2 size={20} className={css.spin} />
        <span>{props.label}</span>
      </div>
    </div>
  )
}

/** 错误态。 */
function ErrorState(props: { message: string; onRetry?: () => void }): ReactNode {
  const { message, onRetry } = props
  return (
    <div className={css.container}>
      <div className={css.errorState}>
        <AlertCircle size={24} />
        <p>{message}</p>
        {onRetry !== undefined && (
          <button type="button" className={css.retryBtn} onClick={onRetry}>
            <RefreshCw size={14} /> 重试
          </button>
        )}
      </div>
    </div>
  )
}

/** 会话回放面板。 */
function ReplayPane(props: { messages: DistillReplayMessage[]; loading: boolean; error: string | null; onRetry: () => void }): ReactNode {
  const { messages, loading, error, onRetry } = props
  if (loading) return <div className={css.replayLoading}>加载回放中…</div>
  if (error !== null) {
    return (
      <div className={css.replayError}>
        <span>{error}</span>
        <button type="button" className={css.retrySmall} onClick={onRetry}>重试</button>
      </div>
    )
  }
  if (messages.length === 0) {
    return <div className={css.replayEmpty}>无回放消息</div>
  }
  return (
    <div className={css.replayList}>
      {messages.map((m) => (
        <div key={m.seq} className={m.role === 'user' ? css.bubbleUser : css.bubbleAssistant}>
          <span className={css.bubbleRole}>{m.role === 'user' ? '用户' : '助手'}</span>
          <p className={css.bubbleText}>{m.text}</p>
        </div>
      ))}
    </div>
  )
}

/** 候选列表面板（只读，全部候选含已处理态）。 */
function CandidateListPane(props: { candidates: DistillCandidate[] }): ReactNode {
  const { candidates } = props
  if (candidates.length === 0) {
    return <div className={css.replayEmpty}>无候选</div>
  }
  return (
    <div className={css.candidateList}>
      {candidates.map((c) => (
        <div key={c.id} className={css.candidateListItem}>
          <span
            className={
              c.state === 'committed'
                ? css.stateCommitted
                : c.state === 'discarded'
                  ? css.stateDiscarded
                  : css.statePending
            }
          >
            {stateLabel(c.state)}
          </span>
          <p className={css.candidateFact}>{c.fact}</p>
          <span className={css.candidateMeta}>重要性 {c.importance} · {retentionLabel(c.retention)}</span>
        </div>
      ))}
    </div>
  )
}

/** 单个候选编辑卡片。 */
function CandidateCard(props: { edit: CandidateEdit; onChange: (patch: Partial<CandidateEdit>) => void }): ReactNode {
  const { edit, onChange } = props
  return (
    <div className={css.card}>
      <div className={css.cardHeader}>
        <label className={css.checkboxLabel}>
          <input
            type="checkbox"
            checked={edit.checked}
            onChange={(e) => onChange({ checked: e.target.checked })}
          />
        </label>
      </div>
      <textarea
        className={css.factInput}
        value={edit.fact}
        onChange={(e) => onChange({ fact: e.target.value })}
        rows={3}
      />
      <div className={css.cardFooter}>
        <label className={css.fieldLabel}>
          重要性
          <input
            type="number"
            className={css.importanceInput}
            min={0}
            max={100}
            value={edit.importance}
            onChange={(e) => {
              const val = Number(e.target.value)
              onChange({ importance: Number.isFinite(val) ? Math.min(100, Math.max(0, val)) : 0 })
            }}
          />
        </label>
        <label className={css.fieldLabel}>
          留存
          <select
            className={css.retentionSelect}
            value={edit.retention}
            onChange={(e) => onChange({ retention: e.target.value as Retention })}
          >
            {RETENTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

/** 候选态中文标签。 */
function stateLabel(state: DistillCandidate['state']): string {
  switch (state) {
    case 'pending': return '待处理'
    case 'committed': return '已写入'
    case 'discarded': return '已舍弃'
  }
}

/** retention 中文标签。 */
function retentionLabel(r: Retention): string {
  const opt = RETENTION_OPTIONS.find((o) => o.value === r)
  return opt !== undefined ? opt.label : r
}
