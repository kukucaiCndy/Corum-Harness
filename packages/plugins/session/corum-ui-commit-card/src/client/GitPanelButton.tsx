/**
 * GitPanelButton —— 输入框工具栏的 git 按钮 + 向上展开的面板。
 *
 * 按钮注册在 `conversation.input.left` 槽（26×26 r8 git-branch 图标 19px）。
 * 点击后面板向上展开（absolute bottom 定位在输入框上方）。
 *
 * 三态（照设计稿 J17）：
 *   ① 空闲可操作：分支可切、文件可勾选、可提交
 *   ② 提交后：结果条 + 注入预览
 *   ③ Agent 工作时：全置灰（分支切换与提交都禁用）
 *
 * idle 判据：会话快照的 `running` 字段。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitPanelData, BranchInfo, ChangeEntry } from './contract.ts'
import {
  buildInjectPreview,
  canWrite,
  describeBranchSwitch,
  describeCommit,
  inferCommitMessage,
  panelMode,
  sumSelected,
} from './panel-model.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { GitBranch, CircleCheck, ChevronDown, Lock, Clock3, X, Check, Info, ArrowDownToLine } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import styles from './GitPanel.module.css'

/** 操作结果（②态展示）。 */
interface CommitResult {
  /** 结果描述。 */
  text: string
}

/** 调 host RPC 拉面板数据。 */
async function fetchPanelData(call: CorumRpcCall, cwd: string): Promise<GitPanelData | null> {
  try {
    const status = await call('gitCore', 'panelStatus', { path: cwd }) as { branch: string; ahead: number; behind: number; upstream: string | null; isRepo: boolean }
    if (!status.isRepo) return null
    const [branchesResult, changesResult] = await Promise.all([
      call('gitCore', 'listBranches', { path: cwd }) as Promise<{ current: string; branches: BranchInfo[] }>,
      call('gitCore', 'listChanges', { path: cwd }) as Promise<{ files: ChangeEntry[] }>,
    ])
    return {
      branch: status.branch,
      ahead: status.ahead,
      behind: status.behind,
      upstream: status.upstream,
      isRepo: true,
      branches: branchesResult.branches,
      changes: changesResult.files,
    }
  } catch {
    return null
  }
}

/** 从 sessions store 取会话 cwd。 */
function useSessionCwd(sessions: ISessions, sessionId: SessionId | undefined): string | undefined {
  return useSyncExternalStore(
    sessions.list.subscribe,
    () => {
      if (sessionId === undefined) return undefined
      const snapshot = sessions.list.getSnapshot()
      return (snapshot.byId as Record<string, { cwd?: string }>)[String(sessionId)]?.cwd
    },
  )
}

/** 从 sessions store 取 running 状态。 */
function useSessionRunning(sessions: ISessions, sessionId: SessionId | undefined): boolean {
  return useSyncExternalStore(
    sessions.list.subscribe,
    () => {
      if (sessionId === undefined) return false
      const snapshot = sessions.list.getSnapshot()
      return (snapshot.byId as Record<string, { running?: boolean }>)[String(sessionId)]?.running ?? false
    },
  )
}

/**
 * 创建 GitPanelButton 组件（闭包注入 sessions + remote）。
 *
 * 槽组件不直接拿 ctx，故经工厂函数闭包注入服务面。
 */
export function createGitPanelButton(sessions: ISessions, rpcCall: CorumRpcCall) {
  return function GitPanelButton({ sessionId }: { sessionId?: SessionId }) {
    const [open, setOpen] = useState(false)
    const [data, setData] = useState<GitPanelData | null>(null)
    const [loading, setLoading] = useState(false)
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
    const [commitMessage, setCommitMessage] = useState('')
    const [branchDropdownOpen, setBranchDropdownOpen] = useState(false)
    const [result, setResult] = useState<CommitResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    // 本次面板会话里已发生的 git 操作（顺序）。预览与 host 注入都以此为准，
    // 而不是「最后一次操作」——否则用户连切两次分支时，预览只会显示后一次。
    const [pendingOps, setPendingOps] = useState<string[]>([])
    const panelRef = useRef<HTMLDivElement>(null)

    const cwd = useSessionCwd(sessions, sessionId)
    const running = useSessionRunning(sessions, sessionId)
    const mode = panelMode(loading, data !== null, running)
    const idle = canWrite(mode)

    // 打开面板时拉数据
    useEffect(() => {
      if (!open || cwd === undefined) return
      setLoading(true)
      setError(null)
      fetchPanelData(rpcCall, cwd).then(d => {
        setData(d)
        setLoading(false)
        if (d !== null) {
          setSelectedFiles(new Set(d.changes.map(c => c.path)))
          setCommitMessage(inferCommitMessage(d.changes))
        }
      })
      // 预览以 host 的真实待注入列表为准（面板关掉再打开时，之前的操作仍在队列里）
      void (async () => {
        const pending = await rpcCall('gitCore', 'getPendingGitOperations', { sessionId: String(sessionId) }) as { operations: string[] }
        setPendingOps(pending.operations)
      })().catch(() => {})
    }, [open, cwd, sessionId])

    // 点击面板外部关闭
    useEffect(() => {
      if (!open) return
      const handler = (e: MouseEvent) => {
        if (panelRef.current !== null && !panelRef.current.contains(e.target as Node)) {
          setOpen(false)
          setResult(null)
        }
      }
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }, [open])

    // 用最新数据重置「选中文件 + 提交信息」，避免切分支后选中集与列表错位
    const resetSelection = useCallback((next: GitPanelData | null) => {
      if (next === null) {
        setSelectedFiles(new Set())
        setCommitMessage('')
        return
      }
      setSelectedFiles(new Set(next.changes.map(c => c.path)))
      setCommitMessage(inferCommitMessage(next.changes))
    }, [])

    // 切换分支
    const handleSwitchBranch = useCallback(async (branch: string) => {
      if (!idle || cwd === undefined) return
      setBranchDropdownOpen(false)
      setError(null)
      const from = data?.branch ?? ''
      const res = await rpcCall('gitCore', 'switchBranch', { path: cwd, branch }) as { success: boolean; error?: string }
      if (res.success) {
        const operation = describeBranchSwitch(from, branch)
        const d = await fetchPanelData(rpcCall, cwd)
        setData(d)
        // 分支变了 ⇒ 改动列表与选中集必须跟着重算，否则显示的是上个分支的文件
        resetSelection(d)
        setPendingOps(prev => [...prev, operation])
        // 记录操作到 host（供下一轮 pre-step 注入）
        await rpcCall('gitCore', 'recordGitOperation', { sessionId: String(sessionId), operation }).catch(() => {})
        setResult({ text: `已切换到 ${branch}` })
      } else {
        setError(res.error ?? '切换失败')
      }
    }, [idle, cwd, data, sessionId, resetSelection])

    // 提交
    const handleCommit = useCallback(async () => {
      if (!idle || cwd === undefined || selectedFiles.size === 0) return
      setError(null)
      const files = [...selectedFiles]
      const { added, deleted } = sumSelected(data?.changes ?? [], selectedFiles)
      const res = await rpcCall('gitCore', 'commitFiles', { path: cwd, files, message: commitMessage }) as { success: boolean; commitHash?: string; error?: string }
      if (res.success) {
        const hash = res.commitHash ?? ''
        const operation = describeCommit(hash, commitMessage, files.length, added, deleted)
        setPendingOps(prev => [...prev, operation])
        // 记录操作到 host（供下一轮 pre-step 注入）
        await rpcCall('gitCore', 'recordGitOperation', { sessionId: String(sessionId), operation }).catch(() => {})
        const d = await fetchPanelData(rpcCall, cwd)
        setData(d)
        // 提交后工作区可能仍有未提交改动：重算默认选中，而不是留一个空集
        resetSelection(d)
        setResult({ text: `已提交 ${hash}（${files.length} 个文件）` })
      } else {
        setError(res.error ?? '提交失败')
      }
    }, [idle, cwd, selectedFiles, commitMessage, data, sessionId, resetSelection])

    // 切换文件选中
    const toggleFile = useCallback((path: string) => {
      setSelectedFiles(prev => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        const selected = data?.changes.filter(c => next.has(c.path)) ?? []
        setCommitMessage(inferCommitMessage(selected))
        return next
      })
    }, [data])

    // 全选/取消全选
    const toggleAll = useCallback(() => {
      if (data === null) return
      setSelectedFiles(prev => {
        if (prev.size === data.changes.length) return new Set()
        return new Set(data.changes.map(c => c.path))
      })
    }, [data])

    if (sessionId === undefined) return null

    return (
      <div className={styles.gitButtonWrap} ref={panelRef}>
        <button
          type="button"
          className={styles.gitBtn}
          aria-label="版本控制"
          aria-expanded={open}
          onMouseDown={e => e.preventDefault()}
          onClick={() => { setOpen(!open); setResult(null); setError(null); setPendingOps([]) }}
        >
          <GitBranch size={19} />
        </button>

        {open && (
          <div className={styles.panel} data-busy={!idle}>
            <div className={styles.phead}>
              <GitBranch size={15} className={styles.pheadIcon} />
              <span className={styles.pheadTitle}>版本控制</span>
              <div className={styles.spacer} />
              {!idle && <span className={styles.busyBadge}>● Agent 工作中</span>}
              <button type="button" className={styles.closeBtn} onClick={() => { setOpen(false); setResult(null) }}>
                <X size={14} />
              </button>
            </div>

            <div className={styles.divider} />

            {loading && <div className={styles.loading}>加载中…</div>}
            {error !== null && <div className={styles.error}>{error}</div>}
            {!loading && data === null && error === null && <div className={styles.empty}>非 git 仓库或读取失败</div>}

            {!loading && data !== null && (
              <>
                <div className={styles.branchSection}>
                  <div className={styles.branchHeader}>
                    <span className={styles.label}>当前分支</span>
                    <div className={styles.spacer} />
                    {data.ahead > 0 && <span className={styles.ahead}>↑{data.ahead}</span>}
                    {data.behind > 0 && <span className={styles.behind}>↓{data.behind}</span>}
                    {data.upstream !== null && data.ahead === 0 && data.behind === 0 && (
                      <span className={styles.upSync}>{data.upstream} 已同步</span>
                    )}
                  </div>

                  <button
                    type="button"
                    className={styles.branchSelect}
                    disabled={!idle}
                    onClick={() => setBranchDropdownOpen(!branchDropdownOpen)}
                  >
                    <GitBranch size={14} />
                    <span className={styles.branchName}>{data.branch}</span>
                    <div className={styles.spacer} />
                    <span className={styles.branchCount}>共 {data.branches.length} 个分支</span>
                    <ChevronDown size={15} />
                  </button>

                  <div className={styles.idleNote}>
                    {idle ? (
                      <>
                        <CircleCheck size={12} />
                        <span>Agent 空闲中 · 可切换分支。Agent 正在工作时此项禁用</span>
                      </>
                    ) : (
                      <>
                        <Lock size={12} />
                        <span>工作中不可切换</span>
                      </>
                    )}
                  </div>

                  {branchDropdownOpen && idle && (
                    <div className={styles.branchDropdown}>
                      {data.branches.map(br => (
                        <button
                          key={br.name}
                          type="button"
                          className={`${styles.branchRow} ${br.current ? styles.branchRowCurrent : ''}`}
                          onClick={() => handleSwitchBranch(br.name)}
                        >
                          <span className={styles.branchMark}>{br.current ? '*' : ''}</span>
                          <span className={`${styles.branchItemName} ${br.current ? styles.branchItemNameCurrent : ''}`}>{br.name}</span>
                          <div className={styles.spacer} />
                          <span className={styles.branchMeta}>{br.current ? '当前' : br.lastCommitRelative}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {!idle && (
                    <div className={styles.warnNote}>
                      <Clock3 size={12} />
                      <span>本轮结束后自动恢复可用</span>
                    </div>
                  )}
                </div>

                <div className={styles.divider} />

                <div className={styles.changesSection}>
                  <div className={styles.changesHeader}>
                    <span className={styles.changesTitle}>未提交的更改</span>
                    <div className={styles.spacer} />
                    <button type="button" className={styles.selectAll} onClick={toggleAll} disabled={!idle}>
                      {selectedFiles.size === data.changes.length && data.changes.length > 0 ? '取消全选' : '全选'}
                    </button>
                  </div>

                  {data.changes.length === 0 ? (
                    <div className={styles.noChanges}>工作区干净</div>
                  ) : (
                    data.changes.map(file => (
                      <label key={file.path} className={`${styles.fileRow} ${!idle ? styles.fileRowDisabled : ''}`}>
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.path)}
                          disabled={!idle}
                          onChange={() => toggleFile(file.path)}
                          className={styles.checkbox}
                        />
                        <span className={styles.fileStatus}>{file.status}</span>
                        <span className={styles.filePath}>{file.path}</span>
                        <div className={styles.spacer} />
                        {file.added > 0 && <span className={styles.added}>+{file.added}</span>}
                        {file.deleted > 0 && <span className={styles.deleted}>−{file.deleted}</span>}
                      </label>
                    ))
                  )}
                </div>

                {idle && data.changes.length > 0 && (
                  <>
                    <div className={styles.divider} />
                    <div className={styles.commitSection}>
                      <div className={styles.commitHeader}>
                        <span className={styles.changesTitle}>提交信息</span>
                        <div className={styles.spacer} />
                        <span className={styles.commitRule}>按路径规则生成</span>
                      </div>
                      <textarea
                        className={styles.commitInput}
                        value={commitMessage}
                        onChange={e => setCommitMessage(e.target.value)}
                        rows={2}
                        placeholder="提交信息"
                      />
                      <div className={styles.commitHint}>
                        <Info size={12} />
                        <span>提交信息按文件路径规则拼（不调 LLM），可手改</span>
                      </div>
                    </div>
                  </>
                )}

                <div className={styles.pfoot}>
                  {result !== null ? (
                    <>
                      <CircleCheck size={15} className={styles.resultIcon} />
                      <span className={styles.resultText}>{result.text}</span>
                      <div className={styles.spacer} />
                      <button type="button" className={styles.cancelBtn} onClick={() => { setResult(null); setOpen(false) }}>关闭</button>
                    </>
                  ) : idle ? (
                    <>
                      <span className={styles.fileCount}>已选 {selectedFiles.size} / {data.changes.length} 个文件</span>
                      <div className={styles.spacer} />
                      <button type="button" className={styles.cancelBtn} onClick={() => setOpen(false)}>取消</button>
                      <button
                        type="button"
                        className={styles.commitBtn}
                        disabled={selectedFiles.size === 0}
                        onClick={handleCommit}
                      >
                        <Check size={13} />
                        <span>提交</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={styles.fileCountDimmed}>Agent 工作中，提交暂不可用</span>
                      <div className={styles.spacer} />
                      <button type="button" className={styles.commitBtnDisabled} disabled>
                        <Lock size={13} />
                        <span>提交</span>
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

            {result !== null && (
              <div className={styles.injectPreview}>
                <div className={styles.injectHeader}>
                  <ArrowDownToLine size={13} className={styles.injectIcon} />
                  <span className={styles.injectTitle}>下轮注入给 Agent 的内容</span>
                  <div className={styles.spacer} />
                  <span className={styles.injectChip}>自动</span>
                </div>
                <pre className={styles.injectBody}>{buildInjectPreview(pendingOps)}</pre>
                <div className={styles.injectNote}>
                  <Info size={12} />
                  <span>注入只发生在「有操作」时；没手动操作则下一轮不注入</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }
}
