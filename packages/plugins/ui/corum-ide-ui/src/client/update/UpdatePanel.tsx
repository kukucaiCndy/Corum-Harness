/**
 * UpdatePanel —— 更新结果面板（四态，品牌头图 + 状态卡片）。
 *
 * 从活动栏用户菜单「检查更新」或活动栏更新提醒按钮触发后弹出。展示更新流程的
 * 当前状态：
 *   ① 有更新·待下载（自动开始下载）
 *   ② 下载中（进度条）
 *   ③ 下载完成·重启安装
 *   ④ 已是最新
 *   + 检查失败 / 下载失败 降级态。
 *
 * 设计稿 = design.pen「应用更新 · 终稿」① 段四态。三条硬约束：
 *   1. **hero 480×107（4.486:1）≈ 打包资产 4320×960（4.5:1）** ⇒ cover 零裁切。
 *      旧版 380×130（2.9:1）会左右各裁 17.7%，把鲸鱼与「Corum Harness」字样切掉。
 *   2. **状态 chip 放正文标题行**，不压头图 —— 旧版压在头图右下、与字样重叠。
 *   3. **版本脚注同时给应用版与 dsh 基座版**（用户 2026-10-16 要求；基座版经
 *      `window.corumDesktop.getDshBaselineVersion` 读**实际安装**的官方锚点包）。
 *
 * 更新日志（用户 2026-10-23 要求）：正文随后安装包分发（CHANGELOG.md），面板里
 * 显示当前版本摘要并给「历史版本」入口 —— 点击把整份日志在**编辑器**里打开
 * （只读预览，不落盘）。「更新后自动打开」由 AppFrame 在检测到版本变化时触发。
 *
 * 轮询策略：面板打开时每 800ms 拉一次 getState（downloading 态）或 3s（非下载态）。
 * 关闭时停止。安装动作走 IPC（window.corumDesktop.installUpdate）。
 *
 * @module corum-ide-ui/client/update/UpdatePanel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, ExternalLink, RotateCw, RefreshCw, CircleCheck, Info, X, History, FileText } from 'lucide-react'
import {
  readDshBaselineVersion, readChangelog, openChangelogInEditor, parseChangelog,
  type ChangelogDoc, type ChangelogSection, type CorumEditorCapable,
  type UpdateApi, type UpdateState,
} from './update-api.ts'
import css from './UpdatePanel.module.css'

interface UpdatePanelProps {
  readonly api: UpdateApi
  readonly onClose: () => void
  /** 品牌头图 URL（corumapp://app/assets/...）。须为 4.5:1 横幅资产。 */
  readonly heroImageSrc: string
  /**
   * 编辑器打开能力（`ctx.corumEditor` 的窄化面）。缺席时「历史版本」按钮仍
   * 可点，但只提示不可用——不阻断面板其它功能。
   */
  readonly editor?: CorumEditorCapable | null
}

const POLL_FAST_MS = 800
const POLL_SLOW_MS = 3000

/** `window.corumDesktop` 的窄化面（只用到安装动作一项）。 */
interface InstallBridge {
  installUpdate?: (downloadedPath: string) => Promise<{ ok: boolean; error?: string }>
}

export function UpdatePanel({ api, onClose, heroImageSrc, editor = null }: UpdatePanelProps) {
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  /** dsh 基座版本；null = 未取到（老 preload / 非桌面壳）⇒ 脚注里省略该段。 */
  const [dshVersion, setDshVersion] = useState<string | null>(null)
  /** 更新日志文档；null = 未取到（老产物没有该文件）⇒ 省略日志区，不编造。 */
  const [changelog, setChangelog] = useState<ChangelogDoc | null>(null)
  /** 「在编辑器打开」的失败原因；非空时下方显示一行提示。 */
  const [openError, setOpenError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = useCallback(async () => {
    const s = await api.getState()
    setState(s)
  }, [api])

  useEffect(() => {
    void poll()
    const interval = state?.phase === 'downloading' ? POLL_FAST_MS : POLL_SLOW_MS
    timerRef.current = setInterval(() => { void poll() }, interval)
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current)
    }
  }, [poll, state?.phase])

  // 基座版本 + 更新日志挂载时各拉一次并缓存（进程内不变，轮询无需重复取）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [v, doc] = await Promise.all([readDshBaselineVersion(), readChangelog()])
      if (cancelled) return
      setDshVersion(v)
      setChangelog(doc)
    })()
    return () => { cancelled = true }
  }, [])

  /** Esc 关闭（与 SettingsShell 基线一致）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const handleRecheck = useCallback(async () => {
    setBusy(true)
    try { await api.check(); await poll() } finally { setBusy(false) }
  }, [api, poll])

  const handleDownload = useCallback(async () => {
    setBusy(true)
    try { await api.download(); await poll() } finally { setBusy(false) }
  }, [api, poll])

  const handleInstall = useCallback(async () => {
    const file = state?.downloadedFile
    if (file === null || file === undefined) return
    const bridge = (window as unknown as { corumDesktop?: InstallBridge }).corumDesktop
    if (bridge?.installUpdate === undefined) return
    await bridge.installUpdate(file.path)
  }, [state])

  /** 在编辑器打开整份更新日志（只读预览）。 */
  const handleOpenLog = useCallback(async () => {
    if (changelog === null) return
    setOpenError(null)
    const result = await openChangelogInEditor(editor, changelog.path)
    if (!result.ok) setOpenError(result.error ?? '无法在编辑器中打开')
    else onClose()
  }, [changelog, editor, onClose])

  const phase = state?.phase ?? null
  const isReady = phase === 'downloaded-ready'
  const failed = phase === 'check-failed' || phase === 'download-failed'
  /** 当前版本的日志节（用于面板内摘要）；匹配不到时取最新一节。 */
  const sections: ChangelogSection[] = changelog !== null ? parseChangelog(changelog.content) : []
  const currentSection = sections.find(sec => stripV(sec.version) === stripV(state?.currentVersion ?? '')) ?? sections[0] ?? null

  return createPortal(
    <div className={css.overlay}>
      <div className={css.mask} onClick={onClose} aria-hidden="true" />
      <div
        className={`${css.panel} ${isReady ? css.panelReady : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="应用更新"
        data-update-panel="true"
      >
        <div className={css.hero} style={{ backgroundImage: `url(${heroImageSrc})` }} data-update-hero="true">
          <button type="button" className={css.closeBtn} onClick={onClose} aria-label="关闭" data-update-close="true">
            <X size={12} />
          </button>
        </div>
        <div className={css.body}>
          {state === null && <p className={css.title}>正在检查更新…</p>}

          {state !== null && phase === 'update-available' && (
            <>
              <HeadRow title="发现新版本" verLine={`当前 v${state.currentVersion} → 最新 v${state.latestVersion ?? ''}`}>
                <span className={`${css.chip} ${css.chipNew}`}>可更新</span>
              </HeadRow>
              {state.downloadAsset !== null && (
                <div className={css.metaRow}>
                  <span className={css.metaTag}>{platformLabel(state.downloadAsset.platform)} · {state.downloadAsset.arch}</span>
                  <span className={css.metaTag}>{formatSize(state.downloadAsset.size)}</span>
                </div>
              )}
              <NotesHead
                label="更新日志"
                onOpenLog={handleOpenLog}
                showLink={changelog !== null}
              />
              {currentSection !== null
                ? <p className={css.notes}>{initialBullets(currentSection.body)}</p>
                : state.releaseNotes !== null && <p className={css.notes}>{state.releaseNotes}</p>}
              <Actions>
                <button type="button" className={`${css.btn} ${css.btnSecondary}`} onClick={onClose}>稍后</button>
                <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={handleDownload} disabled={busy}>
                  <Download size={12} /> 立即下载
                </button>
              </Actions>
            </>
          )}

          {state !== null && phase === 'downloading' && (
            <>
              <HeadRow
                title="正在后台下载更新"
                verLine={state.downloadProgress !== null
                  ? `v${state.latestVersion ?? ''} · 已完成 ${Math.round(state.downloadProgress.percent)}%`
                  : `v${state.latestVersion ?? ''}`}
              />
              <div className={css.track}>
                <div className={css.fill} style={{ width: `${state.downloadProgress?.percent ?? 0}%` }} />
              </div>
              <div className={css.dlBox}>
                <div className={css.dlDetail}>
                  <span className={css.dlName}>{state.downloadAsset?.filename ?? ''}</span>
                  <span>
                    {formatBytes(state.downloadProgress?.receivedBytes ?? 0)} / {formatBytes(state.downloadProgress?.totalBytes ?? 0)}
                  </span>
                </div>
              </div>
              <p className={css.hint}>后台下载，不影响使用。完成后活动栏会亮起提醒。</p>
              <Actions>
                <button type="button" className={`${css.btn} ${css.btnSecondary}`} onClick={onClose}>隐藏</button>
              </Actions>
            </>
          )}

          {state !== null && isReady && (
            <>
              <HeadRow
                title="更新已就绪"
                verLine={`v${state.latestVersion ?? ''} 已下载完成${state.downloadAsset !== null ? ` · ${platformLabel(state.downloadAsset.platform)} · ${state.downloadAsset.arch}` : ''}`}
              >
                <span className={`${css.chip} ${css.chipDone}`}>已下载</span>
              </HeadRow>
              {changelog !== null && (
                <LogEntry
                  icon={<FileText size={13} />}
                  label="在编辑器查看本次更新日志"
                  onClick={handleOpenLog}
                />
              )}
              <div className={css.noteBox}>
                <Info size={14} className={css.noteIcon} />
                <span className={css.noteText}>重启应用后自动完成安装，当前会话进度不会丢失。</span>
              </div>
              <Actions>
                <button type="button" className={`${css.btn} ${css.btnSecondary}`} onClick={onClose}>稍后重启</button>
                <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={handleInstall}>
                  <RotateCw size={12} /> 重启安装
                </button>
              </Actions>
            </>
          )}

          {state !== null && phase === 'up-to-date' && (
            <>
              <HeadRow title="已是最新版本" verLine={`你正在使用最新版本 v${state.currentVersion}`} />
              <div className={css.noteBox}>
                <CircleCheck size={15} className={`${css.noteIcon} ${css.noteIconOk}`} />
                <span className={css.noteText}>没有可用更新</span>
              </div>
              {changelog !== null && (
                <LogEntry
                  icon={<History size={13} />}
                  label="查看历史更新日志"
                  onClick={handleOpenLog}
                />
              )}
              <div className={`${css.actions} ${css.actionsSplit}`}>
                <span className={css.timeText}>
                  {state.checkedAt !== null ? `上次检查：${formatTime(state.checkedAt)}` : ''}
                </span>
                <button type="button" className={`${css.btn} ${css.btnSecondary}`} onClick={handleRecheck} disabled={busy}>
                  <RefreshCw size={12} className={busy ? css.spinner : ''} /> 重新检查
                </button>
              </div>
            </>
          )}

          {state !== null && failed && (
            <>
              <HeadRow title={phase === 'check-failed' ? '检查失败' : '下载失败'} verLine="" />
              {state.error !== null && <p className={css.notes}>{state.error}</p>}
              {phase === 'check-failed' && (
                <p className={css.hint}>可能是网络连接问题或 GitHub API 限流，请稍后重试。</p>
              )}
              <Actions>
                {phase === 'download-failed' ? (
                  <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={handleDownload} disabled={busy}>
                    <Download size={12} /> 重试下载
                  </button>
                ) : (
                  <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={handleRecheck} disabled={busy}>
                    <RefreshCw size={12} className={busy ? css.spinner : ''} /> 重试
                  </button>
                )}
                {state.releaseUrl !== null && (
                  <a href={state.releaseUrl} target="_blank" rel="noreferrer" className={`${css.btn} ${css.btnSecondary}`}>
                    <ExternalLink size={12} /> 前往
                  </a>
                )}
              </Actions>
            </>
          )}

          {openError !== null && <p className={css.hint} data-update-error="true">{openError}</p>}

          {/* 版本脚注：应用版 + dsh 基座版。应用版来自 updateChecker 的 currentVersion
              （读安装产物的 package.json）；基座版来自 preload 桥，取不到就省略该段。 */}
          {state !== null && (
            <div className={css.verFoot} data-update-verfoot="true">
              <span>Corum v{state.currentVersion}</span>
              {dshVersion !== null && (
                <>
                  <span className={css.verFootSep}>·</span>
                  <span>dsh 基座 {dshVersion}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 标题行：左「标题 + 版本行」，右可选 chip。 */
function HeadRow({ title, verLine, children }: {
  readonly title: string
  readonly verLine: string
  readonly children?: React.ReactNode
}) {
  return (
    <div className={css.headRow}>
      <div className={css.titleCol}>
        <p className={css.title}>{title}</p>
        {verLine !== '' && <p className={css.verLine}>{verLine}</p>}
      </div>
      {children}
    </div>
  )
}

/** 「更新日志」标题行 + 右侧「历史版本 ›」入口。 */
function NotesHead({ label, onOpenLog, showLink }: {
  readonly label: string
  readonly onOpenLog: () => void
  readonly showLink: boolean
}) {
  return (
    <div className={css.notesHead}>
      <p className={css.notesLabel}>{label}</p>
      {showLink && (
        <button type="button" className={css.notesLink} onClick={onOpenLog} data-update-history="true">
          历史版本
          <History size={10} />
        </button>
      )}
    </div>
  )
}

/** 整行可点的日志入口（状态③/④）。 */
function LogEntry({ icon, label, onClick }: {
  readonly icon: React.ReactNode
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <button type="button" className={css.logEntry} onClick={onClick} data-update-log="true">
      <span className={css.logEntryLeft}>
        {icon}
        <span>{label}</span>
      </span>
      <History size={12} className={css.logEntryArrow} />
    </button>
  )
}

/** 动作行容器（统一右侧对齐）。 */
function Actions({ children }: { readonly children: React.ReactNode }) {
  return <div className={css.actions}>{children}</div>
}

/** 版本号归一（比对时忽略 `v` 前缀与空白）。 */
function stripV(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/**
 * 面板内只展示该版本日志的前若干条项目（完整内容在编辑器里看）。
 * 取 `- ` 开头的行，剥掉前缀，最多 3 条；没有项目行时回退到正文前 160 字。
 */
function initialBullets(body: string): string {
  const bullets = body.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('- ') || line.startsWith('* '))
    .map(line => `• ${line.slice(2).replace(/\*\*/g, '')}`)
  if (bullets.length === 0) {
    const plain = body.replace(/^#+\s.*$/gm, '').replace(/\*\*/g, '').trim()
    return plain.length > 160 ? `${plain.slice(0, 160)}…` : plain
  }
  return bullets.slice(0, 3).join('\n')
}

function platformLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function formatSize(bytes: number): string {
  return formatBytes(bytes)
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return sameDay ? `今天 ${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}
