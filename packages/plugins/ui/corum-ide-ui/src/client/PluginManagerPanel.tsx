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
 * RPC 面：Host 的 pluginManager Typert Remote，0.1.2 起经官方
 * connection.rpc.call('/api', 'pluginManager/<method>', …) 到达（旧
 * corumDesktop.unary IPC 桥已退役）；caller 由壳 inject 注入。
 * 安装/更新/卸载成功后提示重启（restartHost bridge），不做免重启热载。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { type CorumRpcCall } from '@corum/corum-rpc-client/client'
import {
  ChevronLeft, Download, Eye, EyeOff, Power, RefreshCw, Search, Trash2, X,
} from 'lucide-react'
import {
  getAllRegisteredSlots, getSlotMeta, SET_REGION_HIDDEN_EVENT,
} from '@corum/corum-ui-base/client'
import { fallbackName, pluginMeta } from './plugin-meta.ts'
import css from './PluginManagerPanel.module.css'

/** pluginManager.list 的一条条目投影（Host 侧 wire 形状）。 */
export interface PluginManagerEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  readonly hasUi: boolean
  readonly version?: string
  readonly description?: string
  readonly kind: 'plugin' | 'runtime'
}

/** pluginManager.detail 的详情投影。 */
export interface PluginDetail {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginManagerEntry['fiberPhase']
  readonly hasUi: boolean
  readonly kind: 'plugin' | 'runtime'
  readonly origin: 'official' | 'corum' | 'third-party'
  readonly version?: string
  readonly description?: string
  readonly publisher?: string
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: readonly string[]
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

/** 面板对外依赖：网格隐藏集投影 + pluginManager RPC caller，全部注入。 */
export interface PluginManagerPanelProps {
  /** 网格 hidden 槽位集合的订阅（useSyncExternalStore 契约）。 */
  subscribeGrid: (listener: () => void) => () => void
  /** 当前 hidden 槽位快照（稳定引用，变更后换引用）。 */
  getHiddenSnapshot: () => readonly string[]
  /** 判定某注册槽位是否当前网格里的区域（过滤 cordis 内部 slot）。 */
  isRegionSlot: (slot: string) => boolean
  /** 面板关闭（FloatingLayer closeFloating）。 */
  onClose: () => void
  /** pluginManager 命名空间的 RPC caller（0.1.2 起走官方 connection.rpc）。 */
  callRemote: <T>(method: string, args: Record<string, unknown>) => Promise<T>
}

/** 桌面 preload 桥上本面板用到的面。 */
interface RestartBridge {
  restartHost?: () => Promise<{ ok: boolean }>
}

/** 展示名：优先中文元数据表，否则回退格式化包名。 */
function displayName(moduleName: string): string {
  return pluginMeta(moduleName)?.zhName ?? fallbackName(moduleName)
}

/** 展示介绍：优先中文，否则回退英文 description。 */
function displayDesc(moduleName: string, description?: string): string {
  return pluginMeta(moduleName)?.zhDesc ?? description ?? ''
}

/** 来源标签的中文。 */
function originLabel(origin: PluginDetail['origin']): string {
  return origin === 'official' ? '官方' : origin === 'corum' ? '本项目' : '第三方'
}

/** 状态点的语义色（active=绿、failed=红、过渡=黄、无 fiber=灰）。 */
function phaseTone(phase: PluginManagerEntry['fiberPhase'], enabled: boolean): string {
  if (!enabled) return css.dotOff
  if (phase === 'active') return css.dotActive
  if (phase === 'failed') return css.dotFailed
  if (phase === null) return css.dotOff
  return css.dotBusy
}

/** 面板三个区的 tab id。 */
type PanelTab = 'installed' | 'search' | 'views'

/** 插件中心面板主体。 */
export function PluginManagerPanel({ subscribeGrid, getHiddenSnapshot, isRegionSlot, onClose, callRemote }: PluginManagerPanelProps) {
  const [tab, setTab] = useState<PanelTab>('installed')
  const [entries, setEntries] = useState<readonly PluginManagerEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<readonly PluginSearchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  // 详情视图：非 null 时替换列表区（detail = 选中条目的详情）。
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // DSH 基座（运行时组件）二级视图：true = 深入基元清单。
  const [showRuntime, setShowRuntime] = useState(false)

  // 网格 hidden 集投影（壳的 useSyncExternalStore 源）。
  const hidden = useSyncExternalStore(subscribeGrid, getHiddenSnapshot)
  const hiddenSet = new Set(hidden)
  // 只列当前网格里的区域 leaf（过滤 cordis 内部 slot，避免混入 Dsh * 条目）。
  const regionSlots = getAllRegisteredSlots().filter(isRegionSlot)

  const [dshVersion, setDshVersion] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const snapshot = await callRemote<{ entries: PluginManagerEntry[]; dshVersion?: string }>('list', {})
      setEntries(snapshot.entries)
      setDshVersion(snapshot.dshVersion ?? null)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [callRemote])

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
  }), [withBusy, refresh, callRemote])

  const onUninstall = useCallback((entry: PluginManagerEntry) => withBusy(entry.entryId, async () => {
    const result = await callRemote<MutationResult>('uninstall', { entryId: entry.entryId })
    if (!result.ok) {
      setNotice(`卸载失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已卸载 ${entry.moduleName}，重启后生效`)
    await refresh()
  }), [withBusy, refresh, callRemote])

  const onUpdate = useCallback((entry: PluginManagerEntry) => withBusy(entry.entryId, async () => {
    const result = await callRemote<MutationResult>('update', { spec: entry.moduleName })
    if (!result.ok) {
      setNotice(`更新失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已更新 ${entry.moduleName}，重启后生效`)
  }), [withBusy, callRemote])

  // 打开详情页：拉 detail 投影。entryId 来自 list（行点击）。
  const openDetail = useCallback(async (entryId: string) => {
    setDetailLoading(true)
    try {
      const { detail: d } = await callRemote<{ detail: PluginDetail }>('detail', { entryId })
      setDetail(d)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setDetailLoading(false)
    }
  }, [callRemote])
  const closeDetail = useCallback(() => { setDetail(null) }, [])

  const onInstall = useCallback((name: string) => withBusy(`install:${name}`, async () => {
    const result = await callRemote<MutationResult>('install', { spec: name })
    if (!result.ok) {
      setNotice(`安装失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已安装 ${name}，重启后生效`)
    setResults(prev => prev?.map(r => r.name === name ? { ...r, installed: true } : r) ?? prev)
    await refresh()
  }), [withBusy, refresh, callRemote])

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
  }, [query, callRemote])

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
      {/* 头部：标题 + 三区胶囊 tab + 关闭（design.pen 插件中心头部）。 */}
      <div className={css.header}>
        <span className={css.title}>插件中心</span>
        <div className={css.tabs} role="tablist" aria-label="插件中心分区">
          {([
            ['installed', '已安装'],
            ['search', '检索'],
            ['views', '视图管理'],
          ] as ReadonlyArray<readonly [PanelTab, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={css.tab}
              data-active={tab === key || undefined}
              onClick={() => { setTab(key) }}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className={css.iconButton} aria-label="关闭" onClick={onClose}>
          <X size={16} />
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
        {/* ── 详情视图（选中条目后替换列表区）── */}
        {detail !== null ? (
          <PluginDetailView
            detail={detail}
            busy={busy}
            onBack={closeDetail}
            onToggleEnabled={(d) => { void onToggleEnabled(d as unknown as PluginManagerEntry).then(() => void openDetail(d.entryId)) }}
            onUpdate={(d) => { void onUpdate(d as unknown as PluginManagerEntry) }}
            onUninstall={(d) => { void onUninstall(d as unknown as PluginManagerEntry).then(() => closeDetail()) }}
          />
        ) : (
        <>
        {/* ── 已安装清单 ── */}
        {tab === 'installed' && (
          <section className={css.section}>
            {loadError !== null && <div className={css.errorText}>加载失败：{loadError}</div>}
            {entries === null && loadError === null && <div className={css.dimText}>加载中…</div>}
            {entries !== null && entries.length === 0 && <div className={css.dimText}>没有插件条目</div>}
            {detailLoading && <div className={css.dimText}>加载详情…</div>}
            {(() => {
              const plugins = entries?.filter(e => e.kind === 'plugin') ?? []
              const runtimes = entries?.filter(e => e.kind === 'runtime') ?? []
              const corumRuntimes = runtimes.filter(e => e.moduleName.startsWith('@corum/') || e.moduleName.startsWith('corum-desktop'))
              // DSH 基座二级视图：深入一层看全部运行时组件清单（只读）。
              if (showRuntime) {
                return (
                  <>
                    <button type="button" className={css.backBtn} onClick={() => { setShowRuntime(false) }}>
                      <ChevronLeft size={14} /> 返回插件列表
                    </button>
                    <div className={css.dshCard}>
                      <div className={css.dshCardHead}>
                        <span className={css.dshCardName}>DSH 基座</span>
                        {dshVersion !== null && <span className={css.dshCardVersion}>v{dshVersion}</span>}
                        <span className={css.dshCardCount}>{runtimes.length} 个运行时组件</span>
                      </div>
                      <p className={css.dshCardDesc}>
                        DeepSeek Harness 运行时底座：LLM 调用、会话存储、工具链、界面基元等系统组件。
                        本项目覆盖的运行时（corum-desktop 模块加载/桌面连接等）也在此列。这些组件由壳托管，只读不可操作。
                      </p>
                    </div>
                    {corumRuntimes.length > 0 && (
                      <>
                        <div className={css.groupLabel}>本项目覆盖的运行时</div>
                        {corumRuntimes.map((entry) => (
                          <PluginRow key={entry.entryId} entry={entry} busy={false}
                            onOpen={() => { void openDetail(entry.entryId) }}
                            onToggleEnabled={() => {}} onUpdate={() => {}} onUninstall={() => {}} readOnly />
                        ))}
                      </>
                    )}
                    <div className={css.groupLabel}>DSH 运行时组件</div>
                    {runtimes.filter(e => !corumRuntimes.includes(e)).map((entry) => (
                      <PluginRow key={entry.entryId} entry={entry} busy={false}
                        onOpen={() => { void openDetail(entry.entryId) }}
                        onToggleEnabled={() => {}} onUpdate={() => {}} onUninstall={() => {}} readOnly />
                    ))}
                  </>
                )
              }
              // 主列表：功能插件 + DSH 基座聚合卡。
              return (
                <>
                  {plugins.map((entry) => (
                    <PluginRow
                      key={entry.entryId}
                      entry={entry}
                      busy={busy.has(entry.entryId)}
                      onOpen={() => { void openDetail(entry.entryId) }}
                      onToggleEnabled={() => { void onToggleEnabled(entry) }}
                      onUpdate={() => { void onUpdate(entry) }}
                      onUninstall={() => { void onUninstall(entry) }}
                      readOnly={false}
                    />
                  ))}
                  {runtimes.length > 0 && (
                    <button type="button" className={css.dshCardBtn} onClick={() => { setShowRuntime(true) }}>
                      <div className={css.dshCardHead}>
                        <span className={css.dshCardName}>DSH 基座</span>
                        {dshVersion !== null && <span className={css.dshCardVersion}>v{dshVersion}</span>}
                        <span className={css.dshCardCount}>{runtimes.length} 个运行时组件</span>
                      </div>
                      <p className={css.dshCardDesc}>
                        DeepSeek Harness 运行时底座：LLM 调用、会话存储、工具链、界面基元等系统组件，含本项目覆盖的运行时。点入查看（只读）。
                      </p>
                    </button>
                  )}
                </>
              )
            })()}
          </section>
        )}

        {/* ── 检索 ── */}
        {tab === 'search' && (
          <section className={css.section}>
            <div className={css.searchRow}>
              <input
                className={css.searchInput}
                value={query}
                placeholder="搜索插件，如 git、theme、terminal…"
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
        )}

        {/* ── 视图管理（网格区域显隐）── */}
        {tab === 'views' && (
          <section className={css.section}>
            <div className={css.viewsHint}>控制各区域在窗口中的显示/隐藏，隐藏后插件仍在后台运行。</div>
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
                    className={css.viewToggle}
                    data-on={!isHidden || undefined}
                    title={isHidden ? '显示区域' : '隐藏区域'}
                    onClick={() => { onToggleRegion(slot, isHidden) }}
                  >
                    {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    <span className={css.viewToggleKnob} />
                  </button>
                </div>
              )
            })}
          </section>
        )}
        </>
        )}
      </div>
    </div>
  )
}

/** 列表行：状态点 + 中文名/包名 + 介绍 + 行内操作（运行时基元只读）。 */
function PluginRow({ entry, busy, onOpen, onToggleEnabled, onUpdate, onUninstall, readOnly }: {
  entry: PluginManagerEntry
  busy: boolean
  onOpen: () => void
  onToggleEnabled: () => void
  onUpdate: () => void
  onUninstall: () => void
  readOnly: boolean
}) {
  const desc = displayDesc(entry.moduleName, entry.description)
  return (
    <div className={css.row} data-disabled={!entry.enabled || undefined}>
      <span className={`${css.dot} ${phaseTone(entry.fiberPhase, entry.enabled)}`}
        title={entry.fiberPhase ?? 'no fiber'} />
      <button type="button" className={css.rowMainBtn} onClick={onOpen} title="查看详情">
        <span className={css.rowName}>{displayName(entry.moduleName)}</span>
        <span className={css.rowMeta}>{entry.moduleName}{entry.version !== undefined ? ` · v${entry.version}` : ''}</span>
        {desc !== '' && <span className={css.rowDesc}>{desc}</span>}
      </button>
      {!readOnly && (
        <>
          <button type="button" className={css.iconButton} disabled={busy}
            title={entry.enabled ? '停用' : '启用'} onClick={onToggleEnabled}>
            <Power size={14} data-on={entry.enabled || undefined} />
          </button>
          <button type="button" className={css.iconButton} disabled={busy} title="更新" onClick={onUpdate}>
            <RefreshCw size={14} />
          </button>
          <button type="button" className={css.iconButton} disabled={busy} title="卸载" onClick={onUninstall}>
            <Trash2 size={14} />
          </button>
        </>
      )}
    </div>
  )
}

/** 详情视图：来源/版本/发布者/操作（运行时基元只读）。 */
function PluginDetailView({ detail, busy, onBack, onToggleEnabled, onUpdate, onUninstall }: {
  detail: PluginDetail
  busy: ReadonlySet<string>
  onBack: () => void
  onToggleEnabled: (d: PluginDetail) => void
  onUpdate: (d: PluginDetail) => void
  onUninstall: (d: PluginDetail) => void
}) {
  const readOnly = detail.kind === 'runtime'
  const meta = pluginMeta(detail.moduleName)
  const isBusy = busy.has(detail.entryId)
  const field = (label: string, value: ReactNode): ReactNode =>
    value === undefined || value === null || value === '' ? null : (
      <div className={css.detailField}>
        <span className={css.detailLabel}>{label}</span>
        <span className={css.detailValue}>{value}</span>
      </div>
    )
  return (
    <section className={css.section}>
      <button type="button" className={css.backBtn} onClick={onBack}>
        <ChevronLeft size={14} /> 返回列表
      </button>
      <div className={css.detailHead}>
        <span className={`${css.dot} ${phaseTone(detail.fiberPhase, detail.enabled)}`} />
        <span className={css.detailName}>{meta?.zhName ?? fallbackName(detail.moduleName)}</span>
        <span className={css.detailOrigin} data-origin={detail.origin}>{originLabel(detail.origin)}</span>
        {readOnly && <span className={css.detailReadonly}>运行时组件 · 只读</span>}
      </div>
      <div className={css.detailPkg}>{detail.moduleName}</div>
      {(meta?.zhDesc ?? detail.description) !== undefined && (
        <p className={css.detailDesc}>{meta?.zhDesc ?? detail.description}</p>
      )}
      <div className={css.detailGrid}>
        {field('版本', detail.version !== undefined ? `v${detail.version}` : undefined)}
        {field('发布者', detail.publisher)}
        {field('许可证', detail.license)}
        {field('主页', detail.homepage !== undefined ? <a className={css.detailLink} href={detail.homepage} target="_blank" rel="noreferrer">{detail.homepage}</a> : undefined)}
        {field('仓库', detail.repository !== undefined ? <a className={css.detailLink} href={detail.repository} target="_blank" rel="noreferrer">{detail.repository}</a> : undefined)}
        {field('界面', detail.hasUi ? '有界面' : '无界面（后台能力）')}
        {field('状态', detail.enabled ? (detail.fiberPhase === 'active' ? '运行中' : detail.fiberPhase ?? '已启用') : '已停用')}
        {detail.keywords !== undefined && detail.keywords.length > 0 && field('标签', detail.keywords.join('、'))}
      </div>
      {!readOnly && (
        <div className={css.detailActions}>
          <button type="button" className={css.detailActionBtn} disabled={isBusy}
            onClick={() => { onToggleEnabled(detail) }}>
            <Power size={14} data-on={detail.enabled || undefined} /> {detail.enabled ? '停用' : '启用'}
          </button>
          <button type="button" className={css.detailActionBtn} disabled={isBusy}
            onClick={() => { onUpdate(detail) }}>
            <RefreshCw size={14} /> 更新
          </button>
          <button type="button" className={`${css.detailActionBtn} ${css.danger}`} disabled={isBusy}
            onClick={() => { onUninstall(detail) }}>
            <Trash2 size={14} /> 移除
          </button>
        </div>
      )}
    </section>
  )
}
