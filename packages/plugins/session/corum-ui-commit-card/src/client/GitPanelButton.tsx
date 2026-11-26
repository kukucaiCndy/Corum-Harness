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
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { GitBranch, CircleCheck, ChevronDown, Lock, Clock3, X, Check, Info, ArrowDownToLine } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import styles from './GitPanel.module.css'

/** 提交结果（②态展示）。 */
interface CommitResult {
  /** 结果描述。 */
  text: string
  /** 注入预览文本。 */
  injectPreview: string
}

/** 从改动文件路径推断 conventional commit type + scope（规则拼，不调 LLM）。 */
function inferCommitMessage(files: ChangeEntry[]): string {
  if (files.length === 0) return 'chore: no files selected'
  const firstPath = files[0].path
  const topDir = firstPath.split('/')[0] ?? ''
  let type = 'fix'
  let scope = topDir
  if (topDir === 'docs') { type = 'docs'; scope = '' }
  else if (topDir === 'packages') {
    const parts = firstPath.split('/')
    scope = parts[3] ?? parts[2] ?? topDir
    if (parts.includes('tests') || parts.includes('test')) type = 'test'
    else type = 'feat'
  } else if (topDir === 'scripts') { type = 'chore'; scope = 'scripts' }
  else if (topDir === '.github') { type = 'ci'; scope = '' }
  const scopePart = scope !== '' ? `(${scope})` : ''
  const fileCount = files.length
  const fileDesc = fileCount === 1 ? files[0].path : `${fileCount} 个文件`
  return `${type}${scopePart}: 手动提交 ${fileDesc}`
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
    const panelRef = useRef<HTMLDivElement>(null)

    const cwd = useSessionCwd(sessions, sessionId)
    const running = useSessionRunning(sessions, sessionId)
    const idle = !running

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
    }, [open, cwd])

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

    // 切换分支
    const handleSwitchBranch = useCallback(async (branch: string) => {
      if (!idle || cwd === undefined) return
      setBranchDropdownOpen(false)
      setError(null)
      const res = await rpcCall('gitCore', 'switchBranch', { path: cwd, branch }) as { success: boolean; error?: string }
      if (res.success) {
        const d = await fetchPanelData(rpcCall, cwd)
        setData(d)
        // 记录操作到 host（供下一轮 pre-step 注入）
        await rpcCall('gitCore', 'recordGitOperation', { sessionId: String(sessionId), operation: `切换：→ ${branch}（成功）` }).catch(() => {})
        setResult(prev => ({
          text: `已切换到 ${branch}`,
          injectPreview: prev === null
            ? `[git] 用户在对话外操作了 git，请据此更新认知：\n  · 切换：→ ${branch}（成功）`
            : prev.injectPreview,
        }))
      } else {
        setError(res.error ?? '切换失败')
      }
    }, [idle, cwd])

    // 提交
    const handleCommit = useCallback(async () => {
      if (!idle || cwd === undefined || selectedFiles.size === 0) return
      setError(null)
      const files = [...selectedFiles]
      const res = await rpcCall('gitCore', 'commitFiles', { path: cwd, files, message: commitMessage }) as { success: boolean; commitHash?: string; error?: string }
      if (res.success) {
        const hash = res.commitHash ?? ''
        const fileCount = files.length
        const added = data?.changes.filter(c => selectedFiles.has(c.path)).reduce((s, c) => s + c.added, 0) ?? 0
        const deleted = data?.changes.filter(c => selectedFiles.has(c.path)).reduce((s, c) => s + c.deleted, 0) ?? 0
        setResult({
          text: `已提交 ${hash}（${fileCount} 个文件）`,
          injectPreview: `[git] 用户在对话外操作了 git，请据此更新认知：\n  · 提交：${hash} ${commitMessage}\n  · ${fileCount} 个文件 +${added} −${deleted}；请勿重复这些操作`,
        })
        // 记录操作到 host（供下一轮 pre-step 注入）
        await rpcCall('gitCore', 'recordGitOperation', { sessionId: String(sessionId), operation: `提交：${hash} ${commitMessage}（${fileCount} 个文件 +${added} −${deleted}）` }).catch(() => {})
        const d = await fetchPanelData(rpcCall, cwd)
        setData(d)
        setSelectedFiles(new Set())
      } else {
        setError(res.error ?? '提交失败')
      }
    }, [idle, cwd, selectedFiles, commitMessage, data])

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
          onClick={() => { setOpen(!open); setResult(null); setError(null) }}
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
                <pre className={styles.injectBody}>{result.injectPreview}</pre>
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
