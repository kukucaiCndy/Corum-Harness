// fork（corum）：子 Agent 改动区——展开 SubagentCard 时列出子会话改动的文件，
// 每条带 ±N 行数 + 打开 diff + 单文件撤销。
//
// 背景：父会话的 Review 卡只查 PARENT session 的轮次，子 Agent 的改动落在 CHILD
// session 的轮次（影子 git 仓库按 writing session id 分轮），所以父侧看不到。本区
// 把子会话的改动摘要（由 host 在终态帧 corum/subagent/progress.changeSummary 补发）
// 直接渲染进子 Agent 卡片的展开区，让用户在父会话里就能审查子 Agent 改了什么。
//
// 数据路径：
//   host corumAgent.emitChangeSummary(childSessionId)
//     → corumReview.snapshot(childSessionId)  [影子 git 快照：path/added/removed]
//     → corumOrchestration.entriesOf(parent)  [台账 status：integrated 判定]
//     → emit('corum/subagent/progress', { ..., changeSummary })
//   renderer: subagentProgressSubscribe → 本组件 useChangeSummary
//
// 隔离场景：改动在 worktree 里（childSessionId 的轮次仍由 corumReview 记录，
// 因为 corumReview 按 session.id + header.cwd 分轮，worktree 的 cwd 不同于父）。
// 台账 status='integrated' 时翻成「已集成」——由 worktree-ledger 推送帧实时更新。
//
// diff 打开与 per-file 撤销复用父侧 Review 卡同款 RPC：
//   openDiff  → corumReview/fileBefore(childSessionId, path) → corumEditor.openContentDiff
//   revertFile → corumReview/rollback { sessionId: childSessionId, path }

import { useEffect, useState } from 'react'
import { FileDiff, GitBranch, GitMerge, Loader, RotateCcw } from 'lucide-react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { SubagentChangeSummary } from '@corum/corum-api-remotes/corum-events'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { chatRuntimeRef, subagentProgressSubscribe, worktreeLedgerSubscribe } from '../chat-runtime.ts'
import { joinPath } from '@corum/corum-ui-base/client'
import css from './SubagentChanges.module.css'

/** 推送帧的窄化形（只取 changeSummary 字段；与 SubagentProgressEvent 同构）。 */
interface ProgressFrame {
  readonly sessionId: string
  readonly changeSummary?: SubagentChangeSummary
}

/** 台账帧的窄化形（只取 entries）。 */
interface LedgerFrame {
  readonly sessionId: string
  readonly entries: readonly { readonly slug: string; readonly status: string }[]
}

/**
 * 当前（父）会话 cwd（diff 打开的路径解析基准，问题 1-③）。
 *
 * 数据源 = apply.ts 在会话日志会话 header 里挂出的 `sessionCwd`（dsh 会话 header
 * 的 cwd 字段，host corumReview 轮次按它分工作区）。经 chatRuntime cordis 服务的
 * cwd 桥取用——与 openContentDiff 同一条 apply 注入路径，不新拉依赖。
 */
function useSessionCwd(): string | undefined {
  const [cwd, setCwd] = useState<string | undefined>(() => chatRuntimeRef.current?.sessionCwd())
  useEffect(() => {
    // apply 注入晚于首渲染时补一次（cwd 桥是同步读取，无订阅需求——会话切换
    // 会重建整个 ChatView 树，组件随之一起重挂载）。
    setCwd(chatRuntimeRef.current?.sessionCwd())
  }, [])
  return cwd
}

/**
 * RPC fileBefore 返回形（与 review-source.ts 同款）。
 *
 * 2026-09-13 收口（问题 1-④）：host 内部 pre-image 本来就有 content/blob/absent/
 * unavailable 四态，旧上线投影 `{exists, content, created}` 把 `unavailable` 与
 * 「文件本来就是空的」压平成同形（`{exists:true, content:'', created:false}`），
 * 调用方把「取不到改前内容」当成「改前为空」开出假 diff。现加 `status` 枚举
 * （'content' | 'absent' | 'unavailable' | 'missing'），调用方按 status 分支；
 * exists/content/created 三个旧字段保留作兼容投影（旧客户端行为不变）。
 */
interface FileBeforeResult {
  exists: boolean
  content: string
  created: boolean
  /** 改前内容状态：content=有原文；absent=本轮新建（左侧应为空）；unavailable=过大/二进制取不到；missing=不在本轮改动里。 */
  status?: 'content' | 'absent' | 'unavailable' | 'missing'
}

/** 单文件行的改前状态（snapshot/files 逐项带来；undefined = 未知，按旧行为可点）。 */
type FileRowStatus = 'content' | 'absent' | 'unavailable' | 'missing' | undefined

/**
 * RPC `corumReview/fileAfter` 返回形（2026-09-18 收口）。
 *
 * diff 视图的**右侧**改由 host 给内存内容：审查卡的右侧原先只能现读磁盘
 * （`worktreePath + rel`），而隔离 worktree 在集成后会被回收 ⇒ 右侧永远只有一行
 * 「（无法读取 …）」。改后内容其实已在影子仓库里（`ReviewFileEntry.hash` 是它的 blob 号），
 * host 从 git 取回后交这里透传给编辑器。
 */
interface FileAfterResult {
  exists: boolean
  content: string
  status?: 'content' | 'missing' | 'unavailable'
}

/** RPC rollback 返回形（与 review-source.ts 同款）。 */
interface RollbackResult {
  ok: boolean
  restored: number
  failed: number
  message?: string
}

/** RPC `corumReview/snapshot` 返回形（与 host corum-review.ts 同款；只取 files）。 */
interface ReviewSnapshotResult {
  readonly files?: readonly {
    readonly path: string
    readonly added: number
    readonly removed: number
    /** 该文件的改前状态（2026-09-13 收口）；旧 host 缺省。 */
    readonly status?: 'content' | 'absent' | 'unavailable' | 'missing'
  }[]
}

/** `__corumNotify` 一次写只读桥（规范 §1 例外：CorumNotification 面）。 */
interface CorumNotifyBridge {
  __corumNotify?: (n: { tone: 'error'; title: string; message?: string | undefined }) => void
}

/** 用户可见失败反馈（与 apply.ts notifyUser 同款）。 */
function notifyUser(title: string, message?: string | undefined): void {
  const notify = (window as unknown as CorumNotifyBridge).__corumNotify
  notify?.({ tone: 'error', title, ...message === undefined ? {} : { message } })
}

/** 路径显示：超长时头省略（与 ReviewCard displayPath 同口径，但无 cwd 相对化）。 */
function displayPath(path: string): string {
  const MAX = 72
  if (path.length <= MAX) return path
  return `…${path.slice(-(MAX - 1))}`
}

/**
 * 从终态进度帧里取改动摘要。
 *
 * 订阅 'corum/subagent/progress' 推送帧，按 sessionId 过滤本卡子会话，
 * 取 changeSummary 字段。host 在终态时异步补发（见 agent-service.emitChangeSummary）。
 */
function useChangeSummary(childSessionId: string | undefined): SubagentChangeSummary | undefined {
  const [summary, setSummary] = useState<SubagentChangeSummary | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) { setSummary(undefined); return undefined }
    let cancelled = false
    const sub = subagentProgressSubscribe((frame: ProgressFrame) => {
      if (cancelled || frame.sessionId !== childSessionId) return
      if (frame.changeSummary !== undefined) setSummary(frame.changeSummary)
    })
    // 基线拉取（与「并行工作区」台账同款理由，2026-09-12 真机实测的必修项）：
    // 本组件只在**卡片展开**时挂载，而 host 的 changeSummary 只在子 Agent 终态那一刻
    // 发一帧——用户几乎总是跑完才展开，纯订阅永远收不到那一帧，改动段从不出现。
    // 直连 host 真值 `corumReview/snapshot(childSessionId)` 补齐；帧后到者优先
    // （帧带 worktreePath/committed/integrated，快照没有），故用 `prev ?? pulled`。
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const result = await conn.rpc.call('/api', 'corumReview/snapshot', {
          args: { sessionId: childSessionId },
        }) as { ok: boolean; value?: ReviewSnapshotResult }
        if (cancelled || !result.ok || result.value === undefined) return
        const files = result.value.files ?? []
        setSummary(prev => prev ?? {
          filesChanged: files.length,
          files: files.map(f => ({
            path: f.path,
            added: f.added,
            removed: f.removed,
            ...f.status === undefined ? {} : { status: f.status },
          })),
        })
      } catch {
        // ⚠️ 此处是**故意**静默（2026-09-13 督办方核对确认）：快照基线拉取是
        // 「终态帧可能错过」的补帧通道，取不到（子会话从未开过轮次 / RPC 未就绪）
        // 属于常规情形，正确行为就是保持缺省、不渲染改动段——与旧行为一致。
        // 不要照下面 openDiff/revertFile 那样 warn + notify：那会把「本来就没有
        // 改动段可显示」误报成用户可见错误。
      }
    })()
    return () => { cancelled = true; sub.unsubscribe() }
  }, [childSessionId])
  return summary
}

/**
 * 台账 integrated 状态的实时更新。
 *
 * 终态帧的 changeSummary.integrated 是快照值；用户事后在别处点「集成」会让
 * 台账 status 翻成 integrated → worktree-ledger 推送帧 → 本 hook 更新。
 * 按本卡 worktree.slug 在帧 entries 里匹配。
 */
function useIntegratedStatus(
  worktreeSlug: string | undefined,
): boolean | undefined {
  const [integrated, setIntegrated] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (worktreeSlug === undefined) { setIntegrated(undefined); return undefined }
    let cancelled = false
    const sub = worktreeLedgerSubscribe((frame: LedgerFrame) => {
      if (cancelled) return
      // 台账帧按父 sessionId 广播；本卡只关心自己的 slug。
      const entry = frame.entries.find(e => e.slug === worktreeSlug)
      if (entry !== undefined) {
        setIntegrated(entry.status === 'integrated')
      }
    })
    return () => { cancelled = true; sub.unsubscribe() }
  }, [worktreeSlug])
  return integrated
}

/**
 * 子 Agent 改动区（SubagentCard 展开区的一个 section）。
 *
 * 当子 Agent 还在运行时（无 changeSummary）不渲染——终态帧到达后才有数据。
 * 当 changeSummary 到达但 filesChanged=0 → 渲染「无改动」。
 * 当有文件 → 逐条列出 path + ±N + 打开 diff + 撤销。
 */
export function SubagentChanges({
  childSessionId, worktree, t,
}: {
  childSessionId: string | undefined
  worktree: { readonly slug: string; readonly branch: string } | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  const summary = useChangeSummary(childSessionId)
  // 非隔离时 diff 打开的绝对路径解析基准：当前（父）会话 cwd，照 ReviewDock
  // 的 apply.ts 写法（resolveWorkspacePath(cwd, path)）。旧实现直接把快照里的
  // 相对路径当绝对路径传给 editor，必然报「路径不在当前工作区根下」（问题 1-③）。
  const sessionCwd = useSessionCwd()
  // 台账 integrated 实时更新（终态帧快照值 + 推送帧增量）。
  // ⚠️ hooks 必须无条件调用（React #310）：slug 在 summary 到达前取 worktree 兜底。
  const slug = summary?.worktreeSlug ?? worktree?.slug
  const ledgerIntegrated = useIntegratedStatus(slug)
  // 终态帧尚未到达（子 Agent 还在跑）→ 不渲染改动区（与展开区的 prompt 区共存）。
  if (summary === undefined) return null

  const integrated = summary.integrated ?? ledgerIntegrated

  const files = summary.files ?? []
  const hasChanges = files.length > 0 || summary.filesChanged > 0

  return (
    <div className={css.section}>
      <div className={css.head}>
        <FileDiff size={14} strokeWidth={2} className={css.headIcon} />
        <span className={css.headTitle}>{t('subagent.changes')}</span>
        {/* 隔离 worktree slug/branch + 已提交/已集成 状态行。 */}
        {(summary.worktreeSlug ?? worktree?.slug) !== undefined && (
          <span className={css.worktreeRow} title={t('subagent.worktreeTitle')}>
            <GitBranch size={12} strokeWidth={2} className={css.worktreeIcon} />
            <span className={css.worktreeText}>
              {summary.worktreeSlug ?? worktree?.slug}
            </span>
            {integrated ? (
              <span className={css.integratedChip}>
                <GitMerge size={11} strokeWidth={2.5} />
                {t('subagent.integrated')}
              </span>
            ) : summary.committed ? (
              <span className={css.committedChip}>{t('subagent.committed')}</span>
            ) : null}
          </span>
        )}
      </div>
      {!hasChanges ? (
        <div className={css.empty}>{t('subagent.noChanges')}</div>
      ) : (
        <ul className={css.fileList}>
          {files.map(file => (
            <FileRow
              key={file.path}
              path={file.path}
              added={file.added}
              removed={file.removed}
              status={(file as { status?: FileRowStatus }).status}
              childSessionId={childSessionId}
              worktreePath={summary.worktreePath}
              sessionCwd={sessionCwd}
              t={t}
            />
          ))}
          {/* 有 count 但无逐文件详情时（host 取不到 diff）→ 显示总数。 */}
          {files.length === 0 && summary.filesChanged > 0 && (
            <li className={css.fileRowFallback}>
              <span className={css.filePath}>{t('subagent.filesChanged', { count: summary.filesChanged })}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * 单文件行：path + ±N + 打开 diff + 撤销。
 *
 * `status`（host snapshot/fileBefore 的改前状态枚举）驱动置灰（2026-09-13 收口，
 * 问题 1-④⑤）：`unavailable`（过大/二进制取不到改前内容）或「无可撤销内容」的
 * 行不可点、不可撤销——旧实现把它们当「改前为空」开出假 diff / 假撤销。
 */
function FileRow({
  path, added, removed, status, childSessionId, worktreePath, sessionCwd, t,
}: {
  path: string
  added: number
  removed: number
  status: FileRowStatus
  childSessionId: string | undefined
  worktreePath: string | undefined
  sessionCwd: string | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  const [busy, setBusy] = useState(false)
  // 改前内容不可得（过大/二进制/轮末兜底补入但影子仓库里没有改前版本）→ 整行置灰。
  const unavailable = status === 'unavailable'

  const openDiff = (): void => {
    if (childSessionId === undefined || unavailable) return
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const result = await conn.rpc.call('/api', 'corumReview/fileBefore', {
          args: { sessionId: childSessionId, path },
        }) as { ok: boolean; value?: FileBeforeResult }
        const value = result.value
        // 状态枚举分支（host 2026-09-13 收口后始终带 status；缺省按旧 exists 语义兜底）。
        const statusNow = value?.status ?? (value?.exists === true ? 'content' : 'missing')
        if (!result.ok || value === undefined || statusNow === 'missing') {
          notifyUser('取不到该文件的改动前内容', path)
          return
        }
        if (statusNow === 'unavailable') {
          notifyUser('取不到该文件的改动前内容', '文件过大或非文本，没有保留改动前内容')
          return
        }
        // 经 chatRuntime cordis 服务的 openContentDiff 桥 → corumEditor 直调
        // （apply.ts 注入，与 ReviewDock 的 openDiff 同款收窄）。
        // 注意：必须经服务对象调用（.openContentDiff(...)），不能把方法摘下来再调
        // ——impl 是普通类方法、方法体访问私有字段 #openContentDiff，脱离 receiver
        // 调用会抛 "Cannot read properties of undefined (reading '#openContentDiff')"
        // （2026-09-13 Review 面小轮修复：用户症状「子卡打开 diff 失败」的末段根因）。
        const runtime = chatRuntimeRef.current
        if (runtime?.openContentDiff === undefined) {
          notifyUser('无法打开改动对比', '编辑器服务未就绪')
          return
        }
        // absolutePath：隔离时 = worktreePath/path（worktree 在编辑器工作区内）；
        // 非隔离时快照给的是**相对子会话 cwd** 的路径，直接当绝对路径传给 editor
        // 必然报「路径不在当前工作区根下」（问题 1-③）——照 ReviewDock 的 apply.ts
        // 写法：resolveWorkspacePath(会话 cwd, path) 解析成绝对路径。
        const absolutePath = worktreePath !== undefined
          ? joinPath(worktreePath, path) // 分隔符按平台（P2：原硬拼 `/`）
          : resolveWorkspacePath(sessionCwd, path)
        // 右侧内容：优先向 host 要（工作区健在 = 当前内容；已被回收 = git 里的改后 blob）。
        // 取不到就退回旧行为（编辑器自己读绝对路径）——注意 `worktreePath` 只随终态推送帧
        // 到达、不重放，刷新后它会缺省，此时旧行为会把**主树**里同名文件当成右侧（可能混进
        // 父 Agent 之后的编辑）。所以只要 host 给得出，就一定用它。
        let modifiedContent: string | undefined
        try {
          const after = await conn.rpc.call('/api', 'corumReview/fileAfter', {
            args: { sessionId: childSessionId, path },
          }) as { ok: boolean; value?: FileAfterResult }
          if (after.ok && after.value !== undefined && after.value.status === 'content') {
            modifiedContent = after.value.content
          }
        } catch (err) {
          // 取不到改后内容不是错误路径（旧 host/影子仓库不可用）：退回编辑器自己读盘。
          console.warn('[ui-chat] subagent fileAfter failed, falling back to disk read:', err, { path })
        }
        const opened = await runtime.openContentDiff({
          absolutePath,
          originalContent: value.content,
          ...modifiedContent === undefined ? {} : { modifiedContent },
          ...(value.created || statusNow === 'absent') ? { note: '该文件是本轮新建的，左侧为空' } : {},
        })
        if (!opened.ok) {
          notifyUser('无法打开改动对比', opened.error)
        }
      } catch (err) {
        // 问题 1-①：旧实现静默吞异常、把 path 当原因——用户看到的「无法打开改动
        // 对比：<路径>」毫无诊断价值。改 console.warn 真实异常 + 呈现 err.message。
        console.warn('[ui-chat] subagent openDiff threw:', err, { path })
        notifyUser('无法打开改动对比', err instanceof Error ? err.message : String(err))
      }
    })()
  }

  const revertFile = (): void => {
    if (childSessionId === undefined || busy || unavailable) return
    setBusy(true)
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) { setBusy(false); return }
      try {
        const result = await conn.rpc.call('/api', 'corumReview/rollback', {
          args: { sessionId: childSessionId, path },
        }) as { ok: boolean; value?: RollbackResult }
        if (!result.ok || result.value === undefined || !result.value.ok) {
          notifyUser('撤销失败', result.value?.message ?? path)
        }
      } catch (err) {
        // 问题 1-① 同型（审计漏列的第二处）：同样改 console.warn + 呈现 err.message。
        console.warn('[ui-chat] subagent revertFile threw:', err, { path })
        notifyUser('撤销失败', err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <li className={css.fileRow} {...unavailable ? { 'data-unavailable': '' } : {}}>
      {unavailable ? (
        <span
          className={css.filePathDisabled}
          title={`${path} — ${t('subagent.diffUnavailable')}`}
        >
          {displayPath(path)}
        </span>
      ) : (
        <button
          type="button"
          className={css.filePathButton}
          title={`${path} — ${t('subagent.openDiff')}`}
          onClick={openDiff}
        >
          {displayPath(path)}
        </button>
      )}
      <span className={css.fileDiff}>
        <span className={css.added}>+{added}</span>
        <span className={css.removed}>−{removed}</span>
      </span>
      <span className={css.fileActions}>
        <button
          type="button"
          className={css.fileActionButton}
          disabled={busy || unavailable}
          title={unavailable ? t('subagent.revertUnavailable') : t('subagent.revert')}
          aria-label={`${t('subagent.revert')} ${displayPath(path)}`}
          onClick={revertFile}
        >
          {busy ? <Loader size={12} strokeWidth={2} className={css.actionIconSpin} /> : <RotateCcw size={12} strokeWidth={2} />}
          {t('subagent.revert')}
        </button>
      </span>
    </li>
  )
}
