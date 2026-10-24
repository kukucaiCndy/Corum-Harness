/**
 * MarketPage — 集成中心 · 市场页（P5e 统一市场）。
 *
 * 对应 design.pen F5 · 市场（统一）· 磁贴版 · 2026-10-24。
 *
 * 四类资源统一发现：插件 / 技能 / MCP / 扩展包。磁贴群沿用 Metro bento
 * 几何（buildMosaic/MosaicWall，与 ExtensionsPage 同骨架），每张贴带
 * **按类型着色的类型徽标**（紫/青/绿/琥珀）；右侧 510 详情面板。
 *
 * ## 数据源（诚实骨架，不假造）
 *   - 插件：真实 `pluginManager.search`（npm registry 检索），搜索框驱动 +
 *     防抖；空查询不检索，显示搜索提示态而非假数据。安装走 `pluginManager.install`，
 *     与 PluginsPage 同链路；装后刷新并标注 `installed`。
 *   - 技能 / MCP / 扩展包：**当前没有市场源**（§2.3 Q6）。选中这三类筛选时
 *     显示「建设中」空态；在「全部」下它们不出现（不假造条目）。脚注说明
 *     三类后续接入目录源。
 *
 * ## 约束
 *   - 本包不 value-import corum-ide-integrations-ui（跨 bundle）；搜索/安装
 *     逻辑就地投影，经 `useIntegrationsRpc()` → `pluginManager/search`、`install`。
 *   - 不在此卸载（卸载在各自已装页）；详情面板的操作按类型分派。
 *
 * @module corum-ide-integrations-pages-ui/client/MarketPage
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Blocks, BrainCircuit, Cpu, FlaskConical, KeyRound, LoaderCircle, Package,
  Palette, Puzzle, Route, Search, Server, ServerCog, SquareTerminal, WandSparkles, X,
} from 'lucide-react'
import { useIntegrationsRpc } from './face.tsx'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import {
  buildMosaic, MosaicTileBody, MosaicWall, mosaicStyles, mosaicTileClass, useMosaicColumns,
  type MosaicItemHint, type MosaicSize,
} from '@corum/corum-ui-base/client'
import css from './MarketPage.module.css'

/* ── 数据投影（与 host plugin-manager.ts 的 wire 形状对齐）────────────────── */

/** pluginManager.search 的一条结果（npm registry 候选）。 */
interface SearchResult {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly installed: boolean
  readonly date?: string
  readonly weeklyDownloads?: number
  readonly score?: number
}

/** pluginManager.install 的结果（restartRequired = 需重启 host 生效）。 */
interface InstallResult {
  readonly ok: boolean
  readonly restartRequired: boolean
  readonly log?: string
}

/** 市场条目的统一展示口径（只有插件这一类有真值来源）。 */
type MarketKind = 'plugin' | 'skill' | 'mcp' | 'pack'

/** 市场磁贴数据：插件检索结果 + 类型标签。 */
interface MarketTile {
  readonly kind: MarketKind
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly author: string
  readonly installed: boolean
  readonly weeklyDownloads?: number
  readonly date?: string
}

/* ── 展示常量 ─────────────────────────────────────────────────────────────── */

/** 排序 pill tab：推荐 = 来源序；最新 = 按日期降序。 */
type SortTab = 'recommended' | 'latest'

/** 类型筛选 chips：全部 / 插件 / 技能 / MCP / 扩展包。 */
type TypeFilter = 'all' | 'plugin' | 'skill' | 'mcp' | 'pack'

const TYPE_FILTERS: Array<{ id: TypeFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'plugin', label: '插件' },
  { id: 'skill', label: '技能' },
  { id: 'mcp', label: 'MCP' },
  { id: 'pack', label: '扩展包' },
]

/** 没有市场源的三类（技能/MCP/扩展包）。 */
const NO_SOURCE_KINDS: ReadonlySet<MarketKind> = new Set(['skill', 'mcp', 'pack'])

/** 搜索防抖时长（毫秒）。 */
const SEARCH_DEBOUNCE_MS = 350

/** 作者名：npm 结果不带 publisher 字段，按包域反推。 */
function authorOf(moduleName: string): string {
  if (moduleName.startsWith('@corum/')) return 'corum'
  if (moduleName.startsWith('@deepseek-ai/')) return 'deepseek-ai'
  if (moduleName.startsWith('@')) return moduleName.slice(1).split('/')[0] ?? 'community'
  return 'community'
}

/** 展示名：包名末段（去 scope）。 */
function shortName(moduleName: string): string {
  return moduleName.split('/').pop() ?? moduleName
}

/** 周下载量展示形（12.4k / 876）。 */
function heatLabel(weeklyDownloads?: number): string | null {
  if (weeklyDownloads === undefined) return null
  if (weeklyDownloads >= 1000) return `${(weeklyDownloads / 1000).toFixed(1)}k`
  return String(weeklyDownloads)
}

/** 磁贴图标（lucide glyph，按包名语义映射）。 */
function pluginIcon(name: string, size: number): ReactNode {
  const n = name.toLowerCase()
  if (/memory|记忆/.test(n)) return <BrainCircuit size={size} />
  if (/skill|技能|wand/.test(n)) return <WandSparkles size={size} />
  if (/mcp/.test(n)) return <ServerCog size={size} />
  if (/theme|palette|color|主题/.test(n)) return <Palette size={size} />
  if (/route|router|路由/.test(n)) return <Route size={size} />
  if (/terminal|shell|pty/.test(n)) return <SquareTerminal size={size} />
  if (/ssh|sftp|key|credential/.test(n)) return <KeyRound size={size} />
  if (/model|llm|ollama/.test(n)) return <Cpu size={size} />
  if (/agent|orchestrat|subagent|goal/.test(n)) return <Puzzle size={size} />
  if (/search|find|grep|server|api/.test(n)) return <Server size={size} />
  if (/ui|ide-|panel|sidebar|explorer|conversation|chat/.test(n)) return <Blocks size={size} />
  return <Puzzle size={size} />
}

/** 类型标签的文案。 */
function typeLabelOf(kind: MarketKind): string {
  switch (kind) {
    case 'plugin': return '插件'
    case 'skill': return '技能'
    case 'mcp': return 'MCP'
    case 'pack': return '扩展包'
  }
}

/* ── 主组件 ───────────────────────────────────────────────────────── */

export function MarketPage() {
  const rpc = useIntegrationsRpc()
  if (rpc === null) return <p className={css.hintText}>RPC 服务未就绪。</p>
  return <MarketView rpc={rpc} />
}

function MarketView({ rpc }: { rpc: CorumRpcCall }) {
  const [sortTab, setSortTab] = useState<SortTab>('recommended')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')

  // 插件检索态：null = 尚未检索/正在防抖；数组 = 已检索（含空数组）。
  const [results, setResults] = useState<readonly SearchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  // 安装态：按包名记 busy；notice 为结果提示。
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)

  // 选中态：null = 未选中（详情栏走空态引导）。
  const [selectedName, setSelectedName] = useState<string | null>(null)

  /* ── 检索 ── */

  const runSearch = useCallback(async (text: string) => {
    const trimmed = text.trim()
    setSearchError(null)
    if (trimmed === '') {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    try {
      const r = await rpc<{ results: SearchResult[] }>('pluginManager', 'search', { query: trimmed })
      setResults(r.results)
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e))
      setResults(null)
    } finally {
      setSearching(false)
    }
  }, [rpc])

  // 防抖 350ms（Enter 先取消挂起再立即检索）。
  const timerRef = useRef<number | null>(null)
  const cancelPending = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  useEffect(() => cancelPending, [cancelPending])

  const onQueryChange = useCallback((text: string) => {
    setQuery(text)
    cancelPending()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void runSearch(text)
    }, SEARCH_DEBOUNCE_MS)
  }, [cancelPending, runSearch])

  /** Enter 立即检索。 */
  const onSearchSubmit = useCallback(() => {
    cancelPending()
    void runSearch(query)
  }, [cancelPending, runSearch, query])

  /* ── 安装 ── */

  const onInstall = useCallback((tile: MarketTile) => {
    void (async () => {
      setBusy(prev => new Set(prev).add(tile.name))
      setNotice(null)
      try {
        const result = await rpc<InstallResult>('pluginManager', 'install', { spec: tile.name })
        if (!result.ok) {
          setNotice(`安装失败：${result.log ?? '未知错误'}`)
          return
        }
        setNotice(`已安装 ${shortName(tile.name)}，重启后生效`)
        // 标记已安装 + 刷新 results。
        setResults(prev => prev?.map(r => (r.name === tile.name ? { ...r, installed: true } : r)) ?? prev)
      } catch (e) {
        setNotice(`安装失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(prev => { const next = new Set(prev); next.delete(tile.name); return next })
      }
    })()
  }, [rpc])

  /* ── 视图投影 ── */

  /** 把检索结果映射成市场磁贴（全部是插件类）。 */
  const tiles: MarketTile[] = useMemo(() => {
    const rows = results ?? []
    return rows.map(r => ({
      kind: 'plugin' as const,
      name: r.name,
      version: r.version,
      ...(r.description !== undefined ? { description: r.description } : {}),
      author: authorOf(r.name),
      installed: r.installed,
      ...(r.weeklyDownloads !== undefined ? { weeklyDownloads: r.weeklyDownloads } : {}),
      ...(r.date !== undefined ? { date: r.date } : {}),
    }))
  }, [results])

  /** 排序：推荐 = 来源序；最新 = 按日期降序。 */
  const sortedTiles = useMemo(() => {
    if (sortTab === 'recommended') return tiles
    return [...tiles].sort((a, b) => {
      const da = a.date ?? ''
      const db = b.date ?? ''
      return db.localeCompare(da)
    })
  }, [tiles, sortTab])

  /** 类型筛选：「全部」显示插件（唯一有源的类）；技能/MCP/扩展包 → 空态。 */
  const filteredTiles = useMemo(() => {
    if (typeFilter === 'all' || typeFilter === 'plugin') return sortedTiles
    return []
  }, [sortedTiles, typeFilter])

  /** 当前筛选是否落在「无市场源」的三类上。 */
  const isNoSourceFilter = typeFilter === 'skill' || typeFilter === 'mcp' || typeFilter === 'pack'

  /** 磁贴群列数（窄窗降 3 列）。 */
  const tilesRef = useRef<HTMLDivElement>(null)
  const columns = useMosaicColumns(tilesRef)

  /** 排布提示（长名字优先给宽槽）。 */
  const hints = useMemo<MosaicItemHint[]>(
    () => filteredTiles.map(t => ({
      nameLength: shortName(t.name).length,
      hasDescription: t.description !== undefined && t.description !== '',
    })),
    [filteredTiles],
  )

  const mosaic = useMemo(
    () => buildMosaic(filteredTiles, { pinFirstTwoSmalls: false, columns, hints }),
    [filteredTiles, columns, hints],
  )

  /** 选中项（默认选第一个；筛选/搜索变化后回落）。 */
  const selected = useMemo<MarketTile | null>(() => {
    if (filteredTiles.length === 0) return null
    if (selectedName === null) return filteredTiles[0] ?? null
    return filteredTiles.find(t => t.name === selectedName) ?? filteredTiles[0] ?? null
  }, [filteredTiles, selectedName])

  /** 筛选切换时清空选中态。 */
  useEffect(() => { setSelectedName(null) }, [typeFilter, sortTab])

  /* ── 渲染 ── */

  /** 单张磁贴。 */
  const renderTile = (tile: MarketTile, size: MosaicSize): ReactNode => {
    const active = selected !== null && selected.name === tile.name
    const heat = heatLabel(tile.weeklyDownloads)
    return (
      <button
        key={tile.name}
        type="button"
        className={mosaicTileClass({ size, tint: tileTintOf(tile.kind), active, glow: size === 'big' })}
        data-tile-size={size}
        aria-pressed={active}
        title={tile.name}
        onClick={() => { setSelectedName(tile.name); setNotice(null) }}
      >
        <MosaicTileBody
          icon={pluginIcon(tile.name, size === 'big' ? 34 : 24)}
          name={shortName(tile.name)}
          version={`v${tile.version}`}
          sub={`${typeLabelOf(tile.kind)} · ${tile.author}`}
          corner={
            <span className={css.tileTypeBadge} data-type-kind={tile.kind}>
              {typeLabelOf(tile.kind)}
            </span>
          }
        />
        {heat !== null && (
          <span className={css.tileHeat}>
            <FlaskConical size={10} className={css.tileHeatIcon} />
            <span className={css.tileHeatValue}>{heat}</span>
          </span>
        )}
      </button>
    )
  }

  /** 单张磁贴时的 fallback（buildMosaic 单条会落到 128 小贴）。 */
  const renderSingleTile = (tile: MarketTile): ReactNode => (
    <div className={css.singleTileRow}>
      <button
        type="button"
        data-tile-size="big"
        style={{
          width: 'calc(264px * var(--corum-density-scale, 1))',
          height: 'calc(264px * var(--corum-density-scale, 1))',
        }}
        className={mosaicTileClass({ size: 'big', tint: tileTintOf(tile.kind), active: true, glow: true })}
        aria-pressed
        title={tile.name}
        onClick={() => { setSelectedName(tile.name); setNotice(null) }}
      >
        <MosaicTileBody
          icon={pluginIcon(tile.name, 30)}
          name={shortName(tile.name)}
          version={`v${tile.version}`}
          sub={`${typeLabelOf(tile.kind)} · ${tile.author}`}
          corner={
            <span className={css.tileTypeBadge} data-type-kind={tile.kind}>
              {typeLabelOf(tile.kind)}
            </span>
          }
        />
      </button>
    </div>
  )

  return (
    <div className={css.page}>
      {/* 页头：pill tabs 推荐/最新 + 搜索框 + 类型 chips */}
      <div className={css.headerRow}>
        <div className={css.tabGroup} role="tablist" aria-label="市场排序">
          <button
            type="button"
            role="tab"
            aria-selected={sortTab === 'recommended'}
            className={`${css.tab}${sortTab === 'recommended' ? ' ' + css.tabActive : ''}`}
            onClick={() => setSortTab('recommended')}
          >推荐</button>
          <button
            type="button"
            role="tab"
            aria-selected={sortTab === 'latest'}
            className={`${css.tab}${sortTab === 'latest' ? ' ' + css.tabActive : ''}`}
            onClick={() => setSortTab('latest')}
          >最新</button>
        </div>
        <div className={css.searchBox}>
          <Search size={14} className={css.searchIcon} />
          <input
            className={css.searchInput}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSearchSubmit() }}
            placeholder="搜索插件 / 技能 / MCP / 扩展包"
          />
          {searching && <LoaderCircle size={13} className={css.searchSpin} />}
        </div>
        <div className={css.filterGroup} role="group" aria-label="类型筛选">
          {TYPE_FILTERS.map(f => (
            <button
              key={f.id}
              type="button"
              className={`${css.filterChip}${typeFilter === f.id ? ' ' + css.filterChipActive : ''}`}
              onClick={() => setTypeFilter(f.id)}
            >{f.label}</button>
          ))}
        </div>
      </div>

      <div className={css.divider} />

      <div className={css.body}>
        {/* 左：磁贴群 */}
        <div className={css.tiles} ref={tilesRef}>
          {/* 错误态 */}
          {searchError !== null && typeFilter !== 'all' && typeFilter !== 'plugin' && null}
          {searchError !== null && (typeFilter === 'all' || typeFilter === 'plugin') && (
            <div className={css.errorState}>
              <div className={css.errorHero}><X size={36} /></div>
              <p className={css.errorTitle}>市场检索失败</p>
              <p className={css.errorDesc}>{searchError}</p>
            </div>
          )}

          {/* 无市场源的三类：诚实空态「建设中」 */}
          {isNoSourceFilter && (
            <div className={css.emptyState}>
              <div className={css.emptyHero}>
                {typeFilter === 'skill' && <WandSparkles size={40} />}
                {typeFilter === 'mcp' && <ServerCog size={40} />}
                {typeFilter === 'pack' && <Package size={40} />}
              </div>
              <p className={css.emptyTitle}>建设中</p>
            </div>
          )}

          {/* 插件/全部：有查询但无结果 */}
          {!isNoSourceFilter && searchError === null && results !== null && results.length === 0 && query.trim() !== '' && (
            <div className={css.emptyState}>
              <div className={css.emptyHero}><Search size={36} /></div>
              <p className={css.emptyTitle}>没有找到匹配的插件</p>
              <p className={css.emptyDesc}>试试换一个关键词，或检查拼写。</p>
            </div>
          )}

          {/* 插件/全部：尚未搜索（空查询）→ 搜索提示态，不假造内容 */}
          {!isNoSourceFilter && searchError === null && results === null && !searching && (
            <div className={css.emptyState}>
              <div className={css.emptyHero}><Search size={36} /></div>
              <p className={css.emptyTitle}>输入关键词搜索插件</p>
            </div>
          )}

          {/* 检索中 */}
          {!isNoSourceFilter && searching && (results === null || results.length === 0) && (
            <div className={css.emptyState}>
              <div className={css.emptyHero}><LoaderCircle size={36} className={css.spin} /></div>
              <p className={css.emptyTitle}>检索中…</p>
            </div>
          )}

          {/* 磁贴群：有结果时 */}
          {!isNoSourceFilter && searchError === null && filteredTiles.length === 1 && renderSingleTile(filteredTiles[0]!)}
          {!isNoSourceFilter && searchError === null && filteredTiles.length > 1 && (
            <MosaicWall
              items={filteredTiles}
              blocks={mosaic}
              columns={columns}
              renderTile={renderTile}
            />
          )}
        </div>

        {/* 右：详情面板 510 */}
        <aside className={css.detail} aria-label="市场详情">
          {selected === null
            ? <DetailEmpty />
            : (
              <MarketDetail
                tile={selected}
                busy={busy.has(selected.name)}
                notice={notice}
                onInstall={() => onInstall(selected)}
                onDismissNotice={() => setNotice(null)}
              />
            )}
        </aside>
      </div>
    </div>
  )
}

/* ── 磁贴底色 tint（按类型语义映射到共享档位）── */

function tileTintOf(kind: MarketKind): 'violet' | 'deep' | 'slate' | 'mauve' {
  switch (kind) {
    case 'pack': return 'deep'
    case 'mcp': return 'slate'
    case 'skill': return 'mauve'
    case 'plugin': return 'violet'
  }
}

/* ── 详情面板空态（未选中）── */

function DetailEmpty() {
  return (
    <div className={css.detailEmpty}>
      <div className={css.detailEmptyHero}>
        <img className={css.detailEmptyLogo} src="corumapp://app/assets/icon.png" alt="" draggable={false} />
      </div>
      <p className={css.detailEmptyTitle}>选择一个市场条目</p>
    </div>
  )
}

/* ── 详情面板 ── */

function MarketDetail({ tile, busy, notice, onInstall, onDismissNotice }: {
  tile: MarketTile
  busy: boolean
  notice: string | null
  onInstall: () => void
  onDismissNotice: () => void
}) {
  const heat = heatLabel(tile.weeklyDownloads)
  return (
    <>
      <div className={css.detailHero}>
        <span className={css.detailHeroBadge}>{pluginIcon(tile.name, 30)}</span>
        <span className={css.detailTypeBadge} data-type-kind={tile.kind}>
          {typeLabelOf(tile.kind)}
        </span>
      </div>
      <div className={css.detailBody}>
        <div>
          {/* 安装结果 inline 提示 */}
          {notice !== null && (
            <div className={notice.includes('失败') ? css.outcomeError : css.outcomeOk}>
              <div className={css.outcomeHead}>
                <span className={css.outcomeTitle}>
                  {notice.includes('失败') ? '安装失败' : '安装结果'}
                </span>
                <button type="button" className={css.outcomeClose} onClick={onDismissNotice} aria-label="关闭提示">
                  <X size={13} />
                </button>
              </div>
              <p className={css.hintText}>{notice}</p>
            </div>
          )}

          <div className={css.detailTitleRow}>
            <span className={css.detailName}>{shortName(tile.name)}</span>
            <span className={css.detailVersion}>{tile.version}</span>
          </div>
          <p className={css.detailDesc}>
            {tile.description !== undefined && tile.description !== ''
              ? tile.description
              : '—'}
          </p>

          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>类型</span>
              <span className={css.detailMetaValue}>{typeLabelOf(tile.kind)}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>作者</span>
              <span className={css.detailMetaValue}>{tile.author}</span>
            </div>
            {heat !== null && (
              <div className={css.detailMetaRow}>
                <span className={css.detailMetaKey}>热度</span>
                <span className={css.detailMetaValue}>{heat}</span>
              </div>
            )}
            {tile.date !== undefined && (
              <div className={css.detailMetaRow}>
                <span className={css.detailMetaKey}>更新</span>
                <span className={css.detailMetaValue}>{tile.date.slice(0, 10)}</span>
              </div>
            )}
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>包名</span>
              <span className={`${css.detailMetaValue} ${css.detailMetaMono}`}>{tile.name}</span>
            </div>
          </div>
        </div>

        <div>
          <div className={css.detailActions}>
            {tile.kind === 'plugin' && (
              <button
                type="button"
                className={`${css.actionBtn} ${tile.installed ? '' : css.actionPrimary}`}
                disabled={tile.installed || busy}
                title={tile.installed ? '已安装' : busy ? '安装中…' : '安装此插件'}
                onClick={onInstall}
              >
                {busy ? <LoaderCircle size={13} className={css.spin} /> : <Package size={13} />}
                {tile.installed ? '已安装' : busy ? '安装中…' : '安装'}
              </button>
            )}
            {tile.kind === 'pack' && (
              <button
                type="button"
                className={css.actionBtn}
                disabled
                title="市场源未接入（建设中）"
              >
                <Package size={13} />导入
              </button>
            )}
            {(tile.kind === 'skill' || tile.kind === 'mcp') && (
              <button
                type="button"
                className={css.actionBtn}
                disabled
                title="市场源未接入（建设中）"
              >
                {tile.kind === 'skill' ? <WandSparkles size={13} /> : <ServerCog size={13} />}
                建设中
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
