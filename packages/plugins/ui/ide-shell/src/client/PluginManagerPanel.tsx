/**
 * PluginManagerPanel —— 插件中心面板（ide-shell 自建，FloatingLayer 承载）。
 *
 * 三个区：
 *   1. 已安装清单：pluginManager.list 的投影（名称/启停开关/状态点/卸载/更新）。
 *   2. 检索：pluginManager.search 走 npm registry，结果带安装按钮。
 *   3. 视图管理：网格注册表里每个槽位的「显示/隐藏区域」切换，与壳的
 *      setLeafHidden 经 SET_REGION_HIDDEN_EVENT 联动（hidden 集合经
 *      useSyncExternalStore 投影，任何网格变更实时刷新）。
 *
 * RPC 面：Host 的 pluginManager Typert Remote（corum-shell/src/host/
 * plugin-manager.ts），经 /api 拦截器到达（与 pluginInventory 同一机制）。
 * 安装/更新/卸载成功后提示重启（restartHost bridge），不做免重启热载。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  Download, Eye, EyeOff, Power, RefreshCw, Search, Trash2, X,
} from 'lucide-react'
import {
  getAllRegisteredSlots, getSlotMeta, SET_REGION_HIDDEN_EVENT,
} from '@corum/shell-base/client'
import css from './PluginManagerPanel.module.css'

/** pluginManager.list 的一条条目投影（Host 侧 wire 形状）。 */
export interface PluginManagerEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  readonly hasUi: boolean
}

/** 检索结果行。 */
interface PluginSearchResult {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly installed: boolean
}

/** 变更类操作的结果（restartRequired = 需重启 host 生效）。 */
interface MutationResult {
  readonly ok: boolean
  readonly restartRequired: boolean
  readonly log?: string
}

/** RPC 信封（/api 拦截器返回的 server-response result）。 */
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** 面板对外依赖：网格隐藏集投影 + preload 重启桥，全部注入。 */
export interface PluginManagerPanelProps {
  /** 网格 hidden 槽位集合的订阅（useSyncExternalStore 契约）。 */
  subscribeGrid: (listener: () => void) => () => void
  /** 当前 hidden 槽位快照（稳定引用，变更后换引用）。 */
  getHiddenSnapshot: () => readonly string[]
  /** 面板关闭（FloatingLayer closeFloating）。 */
  onClose: () => void
}

/** 桌面 preload 桥上本面板用到的面。 */
interface RestartBridge {
  restartHost?: () => Promise<{ ok: boolean }>
}

/** 经 /api 拦截器调 pluginManager Remote（与 connection.rpc.call 同一信封契约）。 */
async function callRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `pluginManager/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/pluginManager/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`pluginManager/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { type: string; rpcId: string; result: RpcResult<T> }
  if (envelope.rpcId !== rpcId) throw new Error(`pluginManager/${method}: rpcId mismatch`)
  if (!envelope.result.ok) throw new Error(`${envelope.result.error.code}: ${envelope.result.error.message}`)
  return envelope.result.value
}

/** 包名 → 展示名（取最后一段，去 dsh-/ui-/ide- 前缀，连字符转空格）。 */
function displayName(moduleName: string): string {
  const last = moduleName.split('/').pop() ?? moduleName
  return last.replace(/^(dsh|ui|ide)-/g, '').replace(/-/g, ' ')
}

/** 状态点的语义色（active=绿、failed=红、过渡=黄、无 fiber=灰）。 */
function phaseTone(phase: PluginManagerEntry['fiberPhase'], enabled: boolean): string {
  if (!enabled) return css.dotOff
  if (phase === 'active') return css.dotActive
  if (phase === 'failed') return css.dotFailed
  if (phase === null) return css.dotOff
  return css.dotBusy
}

/** 插件中心面板主体。 */
export function PluginManagerPanel({ subscribeGrid, getHiddenSnapshot, onClose }: PluginManagerPanelProps) {
  const [entries, setEntries] = useState<readonly PluginManagerEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<readonly PluginSearchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)

  // 网格 hidden 集投影（壳的 useSyncExternalStore 源）。
  const hidden = useSyncExternalStore(subscribeGrid, getHiddenSnapshot)
  const hiddenSet = new Set(hidden)
  const regionSlots = getAllRegisteredSlots()

  const refresh = useCallback(async () => {
    try {
      const snapshot = await callRemote<{ entries: PluginManagerEntry[] }>('list', {})
      setEntries(snapshot.entries)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const withBusy = useCallback(async (key: string, op: () => Promise<void>) => {
    setBusy(prev => new Set(prev).add(key))
    try {
      await op()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [])

  const onToggleEnabled = useCallback((entry: PluginManagerEntry) => withBusy(entry.entryId, async () => {
    await callRemote('setEnabled', { entryId: entry.entryId, enabled: !entry.enabled })
    await refresh()
  }), [withBusy, refresh])

  const onUninstall = useCallback((entry: PluginManagerEntry) => withBusy(entry.entryId, async () => {
    const result = await callRemote<MutationResult>('uninstall', { entryId: entry.entryId })
    if (!result.ok) {
      setNotice(`卸载失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已卸载 ${entry.moduleName}，重启后生效`)
    await refresh()
  }), [withBusy, refresh])

  const onUpdate = useCallback((entry: PluginManagerEntry) => withBusy(entry.entryId, async () => {
    const result = await callRemote<MutationResult>('update', { spec: entry.moduleName })
    if (!result.ok) {
      setNotice(`更新失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已更新 ${entry.moduleName}，重启后生效`)
  }), [withBusy])

  const onInstall = useCallback((name: string) => withBusy(`install:${name}`, async () => {
    const result = await callRemote<MutationResult>('install', { spec: name })
    if (!result.ok) {
      setNotice(`安装失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已安装 ${name}，重启后生效`)
    setResults(prev => prev?.map(r => r.name === name ? { ...r, installed: true } : r) ?? prev)
    await refresh()
  }), [withBusy, refresh])

  const onSearch = useCallback(async () => {
    setSearching(true)
    setSearchError(null)
    try {
      const { results: rows } = await callRemote<{ results: PluginSearchResult[] }>('search', { query })
      setResults(rows)
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : String(error))
      setResults(null)
    } finally {
      setSearching(false)
    }
  }, [query])

  // 区域显隐切换：dispatch SET_REGION_HIDDEN_EVENT，壳的桥统一 setLeafHidden。
  const onToggleRegion = useCallback((slot: string, currentlyHidden: boolean) => {
    window.dispatchEvent(new CustomEvent(SET_REGION_HIDDEN_EVENT, {
      detail: { slot, hidden: !currentlyHidden },
    }))
  }, [])

  const onRestart = useCallback(() => {
    const bridge = (window as unknown as { corumDesktop?: RestartBridge }).corumDesktop
    void bridge?.restartHost?.().then(() => { setNotice(null) })
  }, [])

  return (
    <div className={css.panel} role="dialog" aria-modal="true" aria-label="插件中心">
      <div className={css.header}>
        <span className={css.title}>插件中心</span>
        <button type="button" className={css.iconButton} aria-label="关闭" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {notice !== null && (
        <div className={css.notice}>
          <span className={css.noticeText}>{notice}</span>
          {notice.includes('重启') && (
            <button type="button" className={css.noticeAction} onClick={onRestart}>立即重启</button>
          )}
          <button type="button" className={css.iconButton} aria-label="关闭提示" onClick={() => { setNotice(null) }}>
            <X size={12} />
          </button>
        </div>
      )}

      <div className={css.body}>
        {/* ── 已安装清单 ── */}
        <section className={css.section}>
          <div className={css.sectionTitle}>已安装</div>
          {loadError !== null && <div className={css.errorText}>加载失败：{loadError}</div>}
          {entries === null && loadError === null && <div className={css.dimText}>加载中…</div>}
          {entries !== null && entries.length === 0 && <div className={css.dimText}>没有插件条目</div>}
          {entries?.map((entry) => (
            <div key={entry.entryId} className={css.row} data-disabled={!entry.enabled || undefined}>
              <span className={`${css.dot} ${phaseTone(entry.fiberPhase, entry.enabled)}`}
                title={entry.fiberPhase ?? 'no fiber'} />
              <div className={css.rowMain}>
                <span className={css.rowName}>{displayName(entry.moduleName)}</span>
                <span className={css.rowMeta}>{entry.moduleName}{entry.hasUi ? ' · UI' : ''}</span>
              </div>
              <button
                type="button"
                className={css.iconButton}
                disabled={busy.has(entry.entryId)}
                title={entry.enabled ? '停用' : '启用'}
                onClick={() => { void onToggleEnabled(entry) }}
              >
                <Power size={14} data-on={entry.enabled || undefined} />
              </button>
              <button
                type="button"
                className={css.iconButton}
                disabled={busy.has(entry.entryId)}
                title="更新"
                onClick={() => { void onUpdate(entry) }}
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                className={css.iconButton}
                disabled={busy.has(entry.entryId)}
                title="卸载"
                onClick={() => { void onUninstall(entry) }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </section>

        {/* ── 检索 ── */}
        <section className={css.section}>
          <div className={css.sectionTitle}>检索</div>
          <div className={css.searchRow}>
            <input
              className={css.searchInput}
              value={query}
              placeholder="搜索 npm 插件包…"
              onChange={e => { setQuery(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void onSearch() }}
            />
            <button type="button" className={css.searchButton} disabled={searching} onClick={() => { void onSearch() }}>
              <Search size={14} />
            </button>
          </div>
          {searchError !== null && <div className={css.errorText}>检索失败：{searchError}</div>}
          {results !== null && results.length === 0 && <div className={css.dimText}>没有匹配的包</div>}
          {results?.map((row) => (
            <div key={row.name} className={css.row}>
              <div className={css.rowMain}>
                <span className={css.rowName}>{row.name}</span>
                <span className={css.rowMeta}>{row.version}{row.description !== undefined && row.description !== '' ? ` · ${row.description}` : ''}</span>
              </div>
              {row.installed
                ? <span className={css.dimText}>已安装</span>
                : (
                  <button
                    type="button"
                    className={css.iconButton}
                    disabled={busy.has(`install:${row.name}`)}
                    title="安装"
                    onClick={() => { void onInstall(row.name) }}
                  >
                    <Download size={14} />
                  </button>
                )}
            </div>
          ))}
        </section>

        {/* ── 视图管理（网格区域显隐）── */}
        <section className={css.section}>
          <div className={css.sectionTitle}>视图管理</div>
          {regionSlots.length === 0 && <div className={css.dimText}>没有可管理的区域</div>}
          {regionSlots.map((slot): ReactNode => {
            const isHidden = hiddenSet.has(slot)
            const label = getSlotMeta(slot)?.label ?? slot
            return (
              <div key={slot} className={css.row}>
                <div className={css.rowMain}>
                  <span className={css.rowName}>{label}</span>
                  <span className={css.rowMeta}>{slot}</span>
                </div>
                <button
                  type="button"
                  className={css.iconButton}
                  title={isHidden ? '显示区域' : '隐藏区域'}
                  onClick={() => { onToggleRegion(slot, isHidden) }}
                >
                  {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}
