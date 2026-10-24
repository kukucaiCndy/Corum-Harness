/**
 * SettingsSessionManagementSection —「会话管理」独立 section 页（issue #121 修订版）。
 *
 * ## 形态（用户 2026-10-22 验收裁定）
 *
 * 原 ManageDialog（Modal）**形态错了**：用户要求的是设置中心里的**独立 section
 * 页**，不是对话框。本页即该形态 —— 1:1 复刻设计稿 `mdBB5`
 * 「设置 · 会话管理 Sessions · 深色」（FVQMa「数据管理」屏右侧那一页）：
 * - header 标题由壳的 SettingsShell 统一渲染（取 section label）；
 * - 一组「归档会话 · 共 N 条」（N 动态）；
 * - toolbar：左=全选 checkbox + 「全选」+ 分隔竖线 + 「已选 N 项」，
 *   中=填充，右=「导出所选」(download) / 「删除所选」(trash-2, 红) / 「导入」(upload)；
 * - 列表行：勾选框(14×14) + meta(标题 13px/600 + 副标「工作区名 · 归档于 YYYY-MM-DD」
 *   11px tertiary) + 三个行内图标按钮(24×24)：还原(undo-2) / 导出(download) / 删除(trash-2)；
 * - 底部一行 hint：四个动作的语义与「删除所选需输入 DELETE 确认」。
 *
 * ## 能力归属
 *
 * 动作全部落在 `corum-session-archive`（cordis 服务 `sessionArchive`，可选
 * 插件）：本页只渲染 + 持勾选态 + typed-confirm，不自己调桥。缺席时整页
 * 降级为「仅桌面端可用」的事实陈述（§6.1：不留死按钮）。
 *
 * - 还原（单条+批量）→ host `workspace/unarchiveSession` RPC；
 * - 导出单条 → 现有 `window.corumDesktop.saveSessionLog(sessionId)`；
 * - 导出批量（导出所选）→ 新增 `window.corumDesktop.exportSessionsZip(ids)`
 *   （host 拼一个外层 ZIP，一次保存框落盘）；
 * - 删除单条 → 现有 `window.corumDesktop.deleteSession(sessionId)`（native 确认）；
 * - 删除批量（删除所选）→ 逐条 `deleteSession`，前置**输入式确认**（输入
 *   `DELETE` 才放行，复用 ManageDialog 的 CONFIRM_TOKEN 模式）；
 * - 导入 → 现有 `window.corumDesktop.importSessionLog()`（多选 ZIP）。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsSessionManagementSection
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Check, Download, Trash2, Undo2, Upload } from 'lucide-react'
import { type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { SettingGroup } from '../SettingGroup.tsx'
import { GlassButton } from '../shared.tsx'
import { useSessionArchiveCapability } from './useSessionArchiveCapability.tsx'
import css from '../SettingsSections.module.css'

/** 批量删除的输入式确认 token（沿用 ManageDialog 的既有模式）。 */
const CONFIRM_TOKEN = 'DELETE'

/** 能力缺席时的空订阅（useSyncExternalStore 需要稳定函数）。 */
function noopSubscribe(): () => void {
  return () => { /* 无源可订 */ }
}

/** 控制器 manageEntry 的窄化读面（只声明本页用到的字段）。 */
interface ManageEntryFace {
  readonly status: 'idle' | 'restoring' | 'deleting' | 'result'
  readonly total: number
  readonly done: readonly string[]
  readonly outcome: { readonly kind: 'restore' | 'delete'; readonly done: readonly string[]; readonly failed: readonly { id: string; error: string }[] } | null
  readonly exportFailed: readonly string[]
}

/** 列表行的窄化读面。 */
interface ArchivedRowFace {
  readonly id: string
  readonly title: string
  readonly workspaceName: string
  readonly archivedAt: string | null
}

/**
 * 渲染「会话管理」section：归档会话列表 + 全生命周期动作。
 * @returns the section element tree.
 */
export function SessionManagementSection() {
  const capability = useSessionArchiveCapability()
  const available = capability !== null && capability.desktopAvailable

  const [selected, setSelected] = useState<readonly string[]>([])
  const [tokenOpen, setTokenOpen] = useState(false)
  const [token, setToken] = useState('')
  const [tokenError, setTokenError] = useState(false)

  // 订阅控制器快照（uSES 源）：批量运行/结果/导出失败都是异步落进来的，
  // 不订阅页面就停在按下按钮那一刻的状态。getSnapshot 每次返回同一引用
  // （store 的不可变更新），选择器只投影本页要的 manageEntry 字段。
  const entry = useSyncExternalStore(
    capability === null ? noopSubscribe : (onChange) => capability.store.subscribe(onChange),
    () => ((capability?.store.getSnapshot() as { manageEntry?: ManageEntryFace } | undefined)?.manageEntry),
  )
  const rows = useMemo<readonly ArchivedRowFace[]>(
    () => ((capability?.store.getSnapshot() as { manageEntry?: { rows?: readonly ArchivedRowFace[] } } | undefined)?.manageEntry?.rows ?? []) as readonly ArchivedRowFace[],
    [capability, entry],
  )

  // 把「此刻」的归档行发布进控制器状态（控制器自己不读 workspace/session
  // 快照——它只持 bridge 操作；宿主每帧读取，页面在此落地）。批量运行中
  // 不覆盖（controller 侧也会挡），这里再挡一层避免无谓更新。
  useEffect(() => {
    if (capability === null) return
    const current = (capability.store.getSnapshot() as { manageEntry?: { rows?: readonly unknown[] } }).manageEntry?.rows ?? []
    const next = capability.archivedRows()
    if (current.length === next.length
      && current.every((row, index) => (row as { id?: string }).id === (next[index] as { id?: string }).id)) return
    capability.setManageRows(next)
  }, [capability, entry])

  const busy = entry !== undefined && (entry.status === 'restoring' || entry.status === 'deleting')
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const selectedCount = selected.length
  const allSelected = rows.length > 0 && selectedCount === rows.length

  // 行集合变化后，清掉已不存在的勾选（删除/还原后 id 会消失）。
  const rowIds = useMemo(() => rows.map(row => row.id).join('\u0000'), [rows])
  useEffect(() => {
    if (rows.length === 0) {
      if (selected.length > 0) setSelected([])
      return
    }
    const live = new Set(rows.map(row => row.id))
    const kept = selected.filter(id => live.has(id))
    if (kept.length !== selected.length) setSelected(kept)
  }, [rowIds, rows, selected])

  const toggleOne = useCallback((id: string) => {
    setSelected(previous => (previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]))
  }, [])

  const toggleAll = useCallback(() => {
    setSelected(previous => (previous.length === rows.length ? [] : rows.map(row => row.id)))
  }, [rows])

  const closeToken = useCallback(() => {
    setTokenOpen(false)
    setToken('')
    setTokenError(false)
  }, [])

  /** 批量删除：输入式确认通过后逐条调（controller 内部串行）。 */
  const confirmBatchDelete = useCallback(() => {
    if (token.trim() !== CONFIRM_TOKEN) {
      setTokenError(true)
      return
    }
    const ids = [...selected]
    closeToken()
    if (capability !== null && ids.length > 0) void capability.deleteArchived(ids)
    setSelected([])
  }, [capability, closeToken, selected, token])

  const total = rows.length
  const outcome = entry?.outcome ?? null
  const exportFailed = entry?.exportFailed ?? []

  return (
    <>
      <SettingGroup title={`归档会话 · 共 ${String(total)} 条`}>
        {!available && (
          <div className={css.sessionEmpty}>
            仅桌面端可用（未安装会话存档插件或非桌面壳）。
          </div>
        )}
        {available && rows.length === 0 && (
          <div className={css.sessionEmpty}>暂无归档会话。归档后的会话会出现在这里。</div>
        )}
        {available && rows.length > 0 && (
          <>
            {/* ── toolbar ───────────────────────────────────────────── */}
            <div className={css.sessionToolbar}>
              <label className={css.sessionSelectAll}>
                <input
                  type="checkbox"
                  className={css.sessionRowCheckbox}
                  style={{ width: 14, height: 14, margin: 0 }}
                  checked={allSelected}
                  disabled={busy}
                  onChange={toggleAll}
                  aria-label="全选"
                />
                <span>全选</span>
              </label>
              <span className={css.sessionToolbarDivider} />
              <span className={css.sessionSelectedCount}>已选 {String(selectedCount)} 项</span>
              <span className={css.sessionToolbarFill} />
              <button
                type="button"
                className={css.sessionActionBtn}
                disabled={busy || selectedCount === 0}
                onClick={() => {
                  if (capability === null || selectedCount === 0) return
                  void capability.exportArchived([...selected])
                }}
              >
                <Download size={13} />
                导出所选
              </button>
              <button
                type="button"
                className={`${css.sessionActionBtn} ${css.sessionActionBtnDanger}`}
                disabled={busy || selectedCount === 0}
                onClick={() => { setTokenOpen(true) }}
              >
                <Trash2 size={13} />
                删除所选
              </button>
              <button
                type="button"
                className={css.sessionActionBtn}
                disabled={busy}
                onClick={() => { capability?.importSessionLog() }}
              >
                <Upload size={13} />
                导入
              </button>
            </div>

            {/* ── 列表 ─────────────────────────────────────────────── */}
            {rows.map((row, index) => (
              <div key={row.id}>
                <div className={css.sessionRow}>
                  <input
                    type="checkbox"
                    className={css.sessionRowCheckbox}
                    style={{ width: 14, height: 14, margin: 0 }}
                    checked={selectedSet.has(row.id)}
                    disabled={busy}
                    onChange={() => { toggleOne(row.id) }}
                    aria-label={`选择 ${row.title}`}
                  />
                  <div className={css.sessionRowMeta}>
                    <div className={css.sessionRowTitle}>{row.title}</div>
                    <div className={css.sessionRowSub}>
                      {row.workspaceName} · 归档于 {row.archivedAt ?? '时间未知'}
                    </div>
                  </div>
                  <div className={css.sessionRowActions}>
                    <button
                      type="button"
                      className={css.sessionIconBtn}
                      disabled={busy}
                      title="还原"
                      aria-label={`还原 ${row.title}`}
                      onClick={() => { if (capability !== null) void capability.restoreArchived([row.id]) }}
                    >
                      <Undo2 size={13} />
                    </button>
                    <button
                      type="button"
                      className={css.sessionIconBtn}
                      disabled={busy}
                      title="导出"
                      aria-label={`导出 ${row.title}`}
                      onClick={() => { if (capability !== null) void capability.saveSession(row.id) }}
                    >
                      <Download size={13} />
                    </button>
                    <button
                      type="button"
                      className={`${css.sessionIconBtn} ${css.sessionIconBtnDanger}`}
                      disabled={busy}
                      title="删除"
                      aria-label={`删除 ${row.title}`}
                      onClick={() => {
                        if (capability === null) return
                        void capability.deleteArchived([row.id])
                        setSelected(previous => previous.filter(item => item !== row.id))
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {index < rows.length - 1 && <div className={css.divider} />}
              </div>
            ))}

            {/* ── 运行态 / 结果 / 导出失败提示 ──────────────────────── */}
            {busy && entry !== undefined && (
              <div className={css.sessionStatus}>
                {entry.status === 'restoring' ? '正在还原 ' : '正在删除 '}
                {String(entry.done.length)}/{String(entry.total)}…
              </div>
            )}
            {!busy && outcome !== null && (
              <div className={css.sessionStatus}>
                {outcome.kind === 'restore' ? '已还原 ' : '已删除 '}
                {String(outcome.done.length)} 条
                {outcome.failed.length > 0 && (
                  <span className={css.sessionStatusError}>
                    ；失败 {String(outcome.failed.length)} 条
                  </span>
                )}
                <button
                  type="button"
                  className={css.sessionActionBtn}
                  style={{ marginLeft: 8 }}
                  onClick={() => { capability?.dismissManageOutcome() }}
                >
                  知道了
                </button>
              </div>
            )}
            {!busy && exportFailed.length > 0 && (
              <div className={`${css.sessionStatus} ${css.sessionStatusError}`}>
                {String(exportFailed.length)} 条会话导出失败（已跳过）。
                <button
                  type="button"
                  className={css.sessionActionBtn}
                  style={{ marginLeft: 8 }}
                  onClick={() => { capability?.dismissManageOutcome() }}
                >
                  知道了
                </button>
              </div>
            )}

            {/* ── typed-confirm（删除所选）──────────────────────────── */}
            {tokenOpen && (
              <div className={css.sessionToolbar} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10, paddingTop: 10 }}>
                <div className={css.sessionTokenPrompt}>
                  将删除 {String(selectedCount)} 条归档会话，不可恢复。请输入{' '}
                  <span className={css.sessionTokenStrong}>{CONFIRM_TOKEN}</span> 以确认
                </div>
                <input
                  className={css.sessionTokenInput}
                  value={token}
                  placeholder={CONFIRM_TOKEN}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`请输入 ${CONFIRM_TOKEN} 以确认删除`}
                  onChange={(event) => { setToken(event.target.value); setTokenError(false) }}
                  onKeyDown={(event) => { if (event.key === 'Enter') confirmBatchDelete() }}
                />
                {tokenError && <div className={`${css.sessionStatus} ${css.sessionStatusError}`}>请输入 {CONFIRM_TOKEN} 后才能删除。</div>}
                <div className={css.sessionToolbar}>
                  <span className={css.sessionToolbarFill} />
                  <GlassButton onClick={closeToken}>取消</GlassButton>
                  <GlassButton variant="danger" onClick={confirmBatchDelete}>确认删除</GlassButton>
                </div>
              </div>
            )}
          </>
        )}
      </SettingGroup>

      {/* ── 底部说明（设计稿 hint）────────────────────────────────── */}
      <div className={css.sessionHint}>
        还原 = 放回工作区；导出 = 下载 ZIP；删除不可恢复。
      </div>
    </>
  )
}

/** 供 capability 解析用的 store 选择器类型（避免在组件里 import 控制器类型）。 */
export type SessionArchiveStore = ObservableSnapshot<{ manageEntry: ManageEntryFace }>
