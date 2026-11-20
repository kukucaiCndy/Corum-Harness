/**
 * DistillArchiveView —— 记忆归档面板（经验沉淀候选取舍）。
 *
 * 从 `@corum/corum-ui-split-pane` 的 `DistillReviewView` 搬逻辑，**剥离**：
 *   - SplitPane 分栏容器（改单列全高面板）
 *   - 左栏「会话回放 / 候选列表」tab（回放功能属 SplitPane 形态，归档面板不需要）
 *   - closeSplitPane（改调 closeDistillArchive）
 *
 * 接 `corumAgent/distill*` 四个 RPC（经本包 makeCall 构造的 MemoryCall）：
 *   - distillStatus({jobId}) → DistillJob | null：查任务状态与候选列表。
 *   - distillCommit({jobId, items}) → {written, failed}：写入选中记忆。
 *   - distillDiscard({jobId}) → {discarded}：舍弃候选。
 *   - distillListPending() → {jobs}：列出其他待取舍任务。
 *
 * ## 布局（单列全高）
 *
 * - 顶栏：标题「记忆归档」+ 关闭按钮（调 closeDistillArchive）。
 * - running 时每 2s 轮询 distillStatus 显示 phase；done 后展示候选。
 * - pending 候选卡片（勾选默认全选、fact 可编辑 textarea、importance 0-100、
 *   retention 下拉），底部「写入 N 条选中记忆」+「全部舍弃」（二次确认）。
 * - job 为 null 时显示「任务已过期」空态 + distillListPending 列出其他待取舍任务入口。
 * - commit/discard 后刷新 job 状态并显示结果（写入 N 条/失败 M 条）。
 * - props 入参 {jobId?, sessionId?}：无 jobId 时先 distillListPending 取最新。
 *
 * 错误态不白屏（RPC 失败显示可重试提示）。样式全走 `--corum-*` / `--dsw-alias-*`
 * token（照本包 ui.tsx 惯例，内联 style）。
 *
 * @module @corum/corum-memory/client/DistillArchiveView
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, ConfirmDialog, ErrorNote, Hint } from './ui.tsx'
import type { MemoryCall } from './MemorySettingsPage.tsx'
import type {
  DistillArchivePayload,
  DistillCandidate,
  DistillCommitResult,
  DistillDiscardResult,
  DistillJob,
  DistillListPendingResult,
  Retention,
} from './distill-face.ts'

/* ── token（照 ui.tsx 的 T 常量；此处复制以避免循环依赖）── */

const T = {
  glass1: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
  glass2: 'var(--corum-glass-2, rgba(255,255,255,0.12))',
  border: 'var(--corum-glass-border, rgba(255,255,255,0.14))',
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  labelTertiary: 'var(--dsw-alias-label-tertiary)',
  error: 'var(--dsw-alias-state-error-primary)',
} as const

const FONT = 'var(--corum-ui-font-family, Inter, -apple-system, sans-serif)'

/** DistillArchiveView 的 props（由 occupant 下发）。 */
export interface DistillArchiveViewProps extends DistillArchivePayload {
  /** host RPC 调用函数（本包 makeCall 构造）。 */
  call: MemoryCall
  /** 关闭回调（occupant 下发，调 closeDistillArchive）。 */
  close: () => void
}

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
 * 渲染记忆归档面板。
 * @param props - 见 {@link DistillArchiveViewProps}。
 * @returns 面板元素。
 */
export function DistillArchiveView(props: DistillArchiveViewProps): ReactNode {
  const { call, close, jobId: initialJobId } = props

  const [job, setJob] = useState<DistillJob | null>(null)
  const [jobId, setJobId] = useState<string | undefined>(initialJobId)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
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
    try {
      // typert 按形参名绑定：distillStatus(input: { jobId }) → wire { input: { jobId } }。
      const result = await call<DistillJob | null>('corumAgent', 'distillStatus', { input: { jobId: jid } })
      setJob(result)
      setExpired(result === null)
      if (result !== null) {
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
  }, [call])

  /** 初始化：无 jobId 时先 distillListPending 取最新。 */
  useEffect(() => {
    void (async (): Promise<void> => {
      if (jobIdRef.current !== undefined) {
        await refreshJob(jobIdRef.current)
        return
      }
      // 无 jobId：取最新 pending job。
      try {
        // distillListPending 无参 → wire {}。
        const result = await call<DistillListPendingResult>('corumAgent', 'distillListPending', {})
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
  }, [call])

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

  /** 刷新 pending jobs 列表（job 过期空态用）。 */
  const refreshPendingJobs = useCallback(async (): Promise<void> => {
    try {
      const result = await call<DistillListPendingResult>('corumAgent', 'distillListPending', {})
      setPendingJobs(result.jobs ?? [])
    } catch {
      // 静默——列表是辅助入口。
    }
  }, [call])

  /** 切换到某个 pending job。 */
  const switchToJob = useCallback((jid: string): void => {
    setJobId(jid)
    setJob(null)
    setEdits(new Map())
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
    if (jobId === undefined) return
    const selected: CandidateEdit[] = []
    for (const edit of edits.values()) {
      if (edit.checked) selected.push(edit)
    }
    if (selected.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await call<DistillCommitResult>('corumAgent', 'distillCommit', {
        input: {
          jobId,
          items: selected.map((e) => ({ id: e.id, fact: e.fact, importance: e.importance, retention: e.retention })),
        },
      })
      setActionResult({ kind: 'commit', written: result.written, failed: result.failed })
      // 刷新 job 状态（committed 候选态变化）。
      await refreshJob(jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [call, jobId, edits, refreshJob])

  /** 舍弃全部候选（二次确认）。 */
  const handleDiscard = useCallback(async (): Promise<void> => {
    if (jobId === undefined) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await call<DistillDiscardResult>('corumAgent', 'distillDiscard', { input: { jobId } })
      setActionResult({ kind: 'discard', discarded: result.discarded })
      setConfirmDiscard(false)
      await refreshJob(jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [call, jobId, refreshJob])

  // ── 渲染分支 ──

  if (loading && job === null && !expired) {
    return <PanelFrame close={close}><LoadingState label="加载中…" /></PanelFrame>
  }

  if (expired && job === null) {
    return (
      <PanelFrame close={close}>
        <div style={styles.emptyBody}>
          <span style={styles.emptyIcon}>⚠</span>
          <span style={styles.emptyText}>任务已过期或不存在</span>
          {pendingJobs.length > 0 ? (
            <div style={styles.pendingList}>
              <span style={styles.pendingHint}>其他待取舍任务：</span>
              {pendingJobs.map((j) => (
                <button key={j.jobId} type="button" style={styles.pendingJobBtn} onClick={() => switchToJob(j.jobId)}>
                  {j.origin ?? j.jobId} · {j.status} · {j.factCount} 条
                </button>
              ))}
            </div>
          ) : (
            <button type="button" style={styles.retryBtn} onClick={() => void refreshPendingJobs()}>
              刷新待取舍列表
            </button>
          )}
        </div>
      </PanelFrame>
    )
  }

  if (job === null) {
    return (
      <PanelFrame close={close}>
        <ErrorState
          message="无法加载任务"
          onRetry={() => { if (jobId !== undefined) void refreshJob(jobId) }}
        />
      </PanelFrame>
    )
  }

  const pendingCandidates: DistillCandidate[] = (job.candidates ?? []).filter((c) => c.state === 'pending')
  const pendingEdits: CandidateEdit[] = pendingCandidates
    .map((c) => edits.get(c.id))
    .filter((e): e is CandidateEdit => e !== undefined)
  const selectedCount = pendingEdits.filter((e) => e.checked).length

  return (
    <PanelFrame close={close}>
      {/* running 时显示 phase */}
      {job.status === 'running' && (
        <div style={styles.phaseBanner}>
          <span style={styles.spin}>◐</span>
          <span>进行中：{job.phase}</span>
        </div>
      )}
      {/* 错误条 */}
      {error !== null && (
        <div style={styles.errorBanner}>
          <ErrorNote>{error}</ErrorNote>
          <button type="button" style={styles.retrySmall} onClick={() => { if (jobId !== undefined) void refreshJob(jobId) }}>重试</button>
        </div>
      )}
      {/* 操作结果提示 */}
      {actionResult !== null && (
        <div style={styles.resultBanner}>
          {actionResult.kind === 'commit' ? (
            <span>写入 {actionResult.written ?? 0} 条{actionResult.failed !== undefined && actionResult.failed > 0 ? `，失败 ${actionResult.failed} 条` : ''}</span>
          ) : (
            <span>已舍弃 {actionResult.discarded ?? 0} 条</span>
          )}
          <button type="button" style={styles.resultDismiss} onClick={() => setActionResult(null)}>✕</button>
        </div>
      )}
      {/* 候选卡片区（可滚动） */}
      <div style={styles.candidateCards}>
        {pendingCandidates.length === 0 ? (
          <div style={styles.noPending}>
            <Hint>无待处理候选</Hint>
          </div>
        ) : (
          <>
            <div style={styles.selectAllRow}>
              <label style={styles.checkboxLabel}>
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
      {/* 底栏：写入 + 舍弃 */}
      <div style={styles.bottomBar}>
        <Button variant="primary" disabled={submitting || selectedCount === 0} onClick={() => void handleCommit()}>
          写入 {selectedCount} 条选中记忆
        </Button>
        {confirmDiscard ? (
          <div style={styles.confirmInline}>
            <span>确认舍弃全部？</span>
            <button type="button" style={styles.btnDangerSm} disabled={submitting} onClick={() => void handleDiscard()}>确认舍弃</button>
            <button type="button" style={styles.btnCancelSm} disabled={submitting} onClick={() => setConfirmDiscard(false)}>取消</button>
          </div>
        ) : (
          <Button variant="danger" disabled={submitting || pendingCandidates.length === 0} onClick={() => setConfirmDiscard(true)}>
            全部舍弃
          </Button>
        )}
      </div>
      {/* 舍弃二次确认弹窗（兜底；行内确认已够用，弹窗作 Esc 可取消的备选） */}
      {confirmDiscard && (
        <ConfirmDialog
          danger
          title="确认舍弃全部候选？"
          desc={`将舍弃 ${pendingCandidates.length} 条待处理候选，不可恢复。`}
          confirmLabel="确认舍弃"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => { void handleDiscard() }}
        />
      )}
    </PanelFrame>
  )
}

/* ── 子组件 ── */

/** spin 动画的 keyframes（本包无 CSS module，用 React <style> 注入；幂等）。 */
const SPIN_KEYFRAMES = '@keyframes corum-distill-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'

/** 面板骨架（单列全高）：顶栏标题「记忆归档」+ 关闭按钮。 */
function PanelFrame(props: { close: () => void; children: ReactNode }): ReactNode {
  const { close, children } = props
  return (
    <div style={styles.container}>
      <style>{SPIN_KEYFRAMES}</style>
      <header style={styles.header}>
        <span style={styles.headerTitle}>记忆归档</span>
        <button type="button" style={styles.closeBtn} onClick={close} aria-label="关闭">✕</button>
      </header>
      <div style={styles.body}>{children}</div>
    </div>
  )
}

/** 加载态。 */
function LoadingState(props: { label: string }): ReactNode {
  return (
    <div style={styles.loading}>
      <span style={styles.spin}>◐</span>
      <span>{props.label}</span>
    </div>
  )
}

/** 错误态（可重试）。 */
function ErrorState(props: { message: string; onRetry: () => void }): ReactNode {
  const { message, onRetry } = props
  return (
    <div style={styles.errorState}>
      <ErrorNote>{message}</ErrorNote>
      <button type="button" style={styles.retryBtn} onClick={onRetry}>重试</button>
    </div>
  )
}

/** 单个候选编辑卡片。 */
function CandidateCard(props: { edit: CandidateEdit; onChange: (patch: Partial<CandidateEdit>) => void }): ReactNode {
  const { edit, onChange } = props
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <label style={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={edit.checked}
            onChange={(e) => onChange({ checked: e.target.checked })}
          />
        </label>
      </div>
      <textarea
        style={styles.factInput}
        value={edit.fact}
        onChange={(e) => onChange({ fact: e.target.value })}
        rows={3}
      />
      <div style={styles.cardFooter}>
        <label style={styles.fieldLabel}>
          重要性
          <input
            type="number"
            style={styles.importanceInput}
            min={0}
            max={100}
            value={edit.importance}
            onChange={(e) => {
              const val = Number(e.target.value)
              onChange({ importance: Number.isFinite(val) ? Math.min(100, Math.max(0, val)) : 0 })
            }}
          />
        </label>
        <label style={styles.fieldLabel}>
          留存
          <select
            style={styles.retentionSelect}
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

/* ── 内联样式（照 ui.tsx 的 T token 惯例；不写死 hex）── */

const styles: Record<string, CSSProperties> = {
  /* 容器骨架 */
  container: {
    display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
    minHeight: 0, boxSizing: 'border-box', background: T.glass1,
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    flex: 'none', gap: 8, padding: '8px 12px',
    borderBottom: `1px solid ${T.border}`,
  },
  headerTitle: {
    fontFamily: FONT, fontSize: 14, fontWeight: 600, color: T.labelPrimary,
  },
  closeBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flex: 'none', width: 28, height: 28, border: 'none', borderRadius: 8,
    background: 'transparent', cursor: 'pointer', color: T.labelTertiary,
    fontSize: 14, fontFamily: FONT,
  },
  body: {
    flex: 1, minHeight: 0, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },

  /* phase / 错误 / 结果 banner */
  phaseBanner: {
    display: 'flex', alignItems: 'center', gap: 6, flex: 'none',
    padding: '6px 10px', color: T.labelSecondary,
    borderBottom: `1px solid ${T.border}`,
    fontFamily: FONT, fontSize: 11,
  },
  errorBanner: {
    display: 'flex', alignItems: 'center', gap: 6, flex: 'none',
    padding: '6px 10px',
    borderBottom: `1px solid ${T.border}`,
  },
  resultBanner: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 6, flex: 'none', padding: '6px 10px',
    color: T.labelPrimary, background: T.glass2,
    borderBottom: `1px solid ${T.border}`,
    fontFamily: FONT, fontSize: 11,
  },
  resultDismiss: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    color: T.labelTertiary, fontSize: 12, fontFamily: FONT,
  },
  retrySmall: {
    border: `1px solid ${T.border}`, borderRadius: 6, background: T.glass2,
    cursor: 'pointer', padding: '2px 8px',
    fontFamily: FONT, fontSize: 10, color: T.labelPrimary,
  },

  /* 候选卡片区 */
  candidateCards: {
    flex: 1, minHeight: 0, overflow: 'auto',
    display: 'flex', flexDirection: 'column', gap: 8, padding: 8,
  },
  noPending: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100%', fontFamily: FONT, fontSize: 12, color: T.labelSecondary,
  },
  selectAllRow: {
    display: 'flex', alignItems: 'center', padding: '2px 0',
  },
  checkboxLabel: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontFamily: FONT, fontSize: 11, color: T.labelSecondary, cursor: 'pointer',
  },

  /* 候选编辑卡片 */
  card: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: 10,
    borderRadius: 12, border: `1px solid ${T.border}`, background: T.glass2,
  },
  cardHeader: {
    display: 'flex', alignItems: 'center',
  },
  factInput: {
    width: '100%', boxSizing: 'border-box', padding: '6px 8px',
    border: `1px solid ${T.border}`, borderRadius: 8,
    background: T.glass1, color: T.labelPrimary,
    fontFamily: FONT, fontSize: 12, lineHeight: 1.5,
    resize: 'vertical', minHeight: 40, outline: 'none',
  },
  cardFooter: {
    display: 'flex', gap: 12, alignItems: 'flex-end',
  },
  fieldLabel: {
    display: 'flex', flexDirection: 'column', gap: 3,
    fontFamily: FONT, fontSize: 10, color: T.labelTertiary,
  },
  importanceInput: {
    width: 60, boxSizing: 'border-box', padding: '4px 6px',
    border: `1px solid ${T.border}`, borderRadius: 6,
    background: T.glass1, color: T.labelPrimary,
    fontFamily: FONT, fontSize: 12, outline: 'none',
  },
  retentionSelect: {
    boxSizing: 'border-box', padding: '4px 6px',
    border: `1px solid ${T.border}`, borderRadius: 6,
    background: T.glass1, color: T.labelPrimary,
    fontFamily: FONT, fontSize: 12, cursor: 'pointer', outline: 'none',
  },

  /* 底栏 */
  bottomBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    gap: 10, flex: 'none', padding: '8px 12px',
    borderTop: `1px solid ${T.border}`,
  },
  confirmInline: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontFamily: FONT, fontSize: 11, color: T.labelSecondary,
  },
  btnDangerSm: {
    padding: '4px 10px', border: 'none', borderRadius: 8,
    background: T.error, cursor: 'pointer',
    fontFamily: FONT, fontSize: 11, fontWeight: 600, color: '#fff',
  },
  btnCancelSm: {
    padding: '4px 10px', border: `1px solid ${T.border}`, borderRadius: 8,
    background: T.glass2, cursor: 'pointer',
    fontFamily: FONT, fontSize: 11, color: T.labelPrimary,
  },

  /* 空态 */
  emptyBody: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 12, padding: 32, height: '100%', justifyContent: 'center',
  },
  emptyIcon: {
    fontSize: 32, color: T.labelTertiary,
  },
  emptyText: {
    fontFamily: FONT, fontSize: 13, color: T.labelSecondary,
  },
  pendingList: {
    display: 'flex', flexDirection: 'column', gap: 6,
    width: '100%', maxWidth: 360,
  },
  pendingHint: {
    fontFamily: FONT, fontSize: 11, color: T.labelTertiary,
  },
  pendingJobBtn: {
    padding: '8px 12px', border: `1px solid ${T.border}`, borderRadius: 10,
    background: T.glass2, cursor: 'pointer', textAlign: 'left',
    fontFamily: FONT, fontSize: 12, color: T.labelPrimary,
  },
  retryBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '6px 12px', border: `1px solid ${T.border}`, borderRadius: 10,
    background: T.glass2, cursor: 'pointer',
    fontFamily: FONT, fontSize: 12, color: T.labelPrimary,
  },

  /* 加载 / 错误态 */
  loading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: '100%',
    fontFamily: FONT, fontSize: 13, color: T.labelSecondary,
  },
  errorState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 10, height: '100%', justifyContent: 'center',
    fontFamily: FONT, fontSize: 13,
  },

  /* 旋转动画图标 */
  spin: {
    display: 'inline-block',
    animation: 'corum-distill-spin 1s linear infinite',
    color: T.labelTertiary,
  },
}
