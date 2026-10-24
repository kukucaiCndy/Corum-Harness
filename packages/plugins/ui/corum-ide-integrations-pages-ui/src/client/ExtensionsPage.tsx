/**
 * ExtensionsPage — 集成中心 · 扩展包页（design.pen F5「扩展包（已装）· 磁贴版」）。
 *
 * P5b：**只读**列表 + 详情 + 空态 + 开发者 gated 本地导入。
 *
 * 数据链路（P5a/P5c 已落地的 `extensionManager` RPC）：
 *   list()    → { packs: PackSummary[] }（registry + 六类计数 + 安装时间）
 *   detail(packId) → { pack, dir, manifest?, error? }
 *   installLocal({ sourcePath }) → InstallLocalPackResult | { ok:false, error }
 *
 * 视图结构（与 McpPage/SkillsPage 同一套 Metro 磁贴 + 右侧详情面板骨架，
 * 设计稿 §2.1 明确「沿用既有磁贴群，不再自造列表/卡片」）：
 *   页头单行（[已装] pill tab + 搜索框 280 + 状态 chips 全部/已生效/需重启/有更新
 *   + spacer + 「导入本地扩展包」按钮 [仅 developerMode]）
 *   → 全宽分隔线 → 磁贴群（节头「扩展包」+ 扩展包磁贴）+ 右侧详情面板。
 *
 * 磁贴：bento 尺寸沿用 mosaicStyles（264×264 精选 / 264×128 横片 /
 * 128×264 竖片 / 128×128 小片），紫色调（#5B21F533，设计稿 §2.3 扩展包=紫）；
 * 内容 = 类型图标 + 名称 + 版本 chip + 作者「扩展包 · corum」。
 *
 * 详情面板：hero 150 + 标题/版本/作者/描述 + meta（类型/状态/内容计数）+
 * 底部按钮「查看包内容」（disabled，本轮 no-op）+「卸载扩展包」（danger，
 * 弹 ConfirmDialog → rpc uninstall → 结果面板 → 刷新 list）。
 *
 * 空态：包图标 +「还没有安装扩展包」；开发者另有「导入本地扩展包」按钮，
 * 非开发者看到「设置 › 高级 › 开发者模式」提示（§1.3）。
 *
 * 导入流程（§3）：「导入本地扩展包」按钮 → 内联菜单（目录 / ZIP）→
 * 目录走 `corumDesktop.pickDirectory`，ZIP 走 `corumDesktop.pickFile`（P5b 新增桥）→
 * `rpc('extensionManager','installLocal',{ sourcePath })` → 结果面板（已装/跳过/
 * 需重启/失败逐条）inline 在详情面板顶部 → 刷新 list()。
 *
 * 卸载流程（P4）：「卸载扩展包」按钮 → ConfirmDialog →
 * `rpc('extensionManager','uninstall',{ packId })` → 结果面板（删除/保留/
 * 警告/需重启）inline 在详情面板顶部 → 刷新 list()（成功时）/ 不刷新（失败时）。
 *
 * rpc 为 null 时降级为静态占位提示。
 * @module corum-ide-integrations-pages-ui/client/ExtensionsPage
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ChevronDown, FolderOpen, Package, Search, X, Zap,
} from 'lucide-react'
import { useIntegrationsRpc } from './face.tsx'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import {
  buildMosaic, MosaicTileBody, MosaicWall, mosaicTileClass, useMosaicColumns, tintForName,
  ConfirmDialog,
} from '@corum/corum-ui-base/client'
import type { MosaicItemHint, MosaicSize } from '@corum/corum-ui-base/client'
import css from './ExtensionsPage.module.css'

/* ── 开发者模式开关（与 corum-ide-ui 同一 localStorage 键 + 同一事件，单开关）──
 *
 * 设计稿 §1.3：复用「设置 › 高级 › 开发者模式」，不新增第二个开关。
 * shell 已从 `@corum/corum-ide-ui/client` 导出 `useDeveloperMode`，但本包的
 * client bundle 会把 `@corum/corum-ide-ui` 整包内联（它是 module-table 外的
 * fork 包），而 shell 的 lib/client.js 本身是 `window.__ModuleLoader__.load()`
 * CJS 闭包、无可静态分析的命名导出 ⇒ 跨包 value-import 在 tsdown 阶段失败。
 * 故此处按同一份键 + 同一事件名就地实现（键/事件与 shell 逐字一致，开关仍是
 * 单一事实源：shell 写 `localStorage` + 派发事件，本包订阅同一事件即时响应）。
 */
const DEV_STORAGE_KEY = 'corum.settings.developerMode'
const DEV_CHANGE_EVENT = 'corum:developer-mode-change'
function readDevMode(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEV_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
function subscribeDevMode(cb: () => void): () => void {
  const handler = (): void => { cb() }
  globalThis.addEventListener?.(DEV_CHANGE_EVENT, handler)
  globalThis.addEventListener?.('storage', handler)
  return () => {
    globalThis.removeEventListener?.(DEV_CHANGE_EVENT, handler)
    globalThis.removeEventListener?.('storage', handler)
  }
}
/** 响应式读取开发者模式开关（与 shell useDeveloperMode 同键同事件，单开关）。 */
function useDeveloperMode(): boolean {
  return useSyncExternalStore(subscribeDevMode, readDevMode, () => false)
}

/* ── 数据模型（extensionManager RPC 投影；与 host 侧 extension-manager.ts 同形）── */

/** 六类资源类别（与 registry 的 ExtensionItemKind 同口径）。 */
type ExtensionItemKind = 'presets' | 'skills' | 'mcp' | 'plugins' | 'themes' | 'ui'

/** list() 返回的包摘要（host 侧 extension-manager.ts list() 的返回项）。 */
interface PackSummary {
  readonly id: string
  readonly version: string
  readonly name?: string
  readonly installedAt: string
  readonly counts: Record<ExtensionItemKind, number>
  readonly dir: string
  readonly hasManifest: boolean
}

/** registry.json 的包记录（detail() 返回的 pack 字段）。 */
interface ExtensionPackRecord {
  id: string
  version: string
  name?: string
  installedAt: string
  items?: Partial<Record<ExtensionItemKind, Array<{ name: string }>>>
}

/** installLocal 的成功结果（与 @corum/corum-extension-pack InstallLocalPackResult 同形）。 */
interface InstallLocalPackResult {
  readonly packId: string
  readonly version: string
  readonly name?: string
  readonly skills: { readonly installed: readonly string[]; readonly skipped: readonly string[] }
  readonly mcp: { readonly applied: readonly string[]; readonly kept: readonly string[] }
  readonly presets: readonly unknown[]
  readonly plugins: readonly { spec: string; ok: boolean; restartRequired?: boolean; error?: string }[]
  readonly deferred: readonly { kind: string; name: string }[]
  readonly restartRequired: boolean
  readonly warnings: readonly string[]
}

/** 桌面桥：只取本页用到的 pickDirectory / pickFile 两个方法（红线 3 窄接口）。 */
interface DesktopBridge {
  pickDirectory?: (options?: { title?: string; defaultPath?: string }) =>
    Promise<{ path: string | null; cancelled?: boolean; error?: string }>
  pickFile?: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
    Promise<{ path: string | null; cancelled?: boolean; error?: string }>
}

/* ── 展示口径 ─────────────────────────────────────────────────────── */

/** 磁贴 tint 档（扩展包统一紫色调，设计稿 §2.3 扩展包=紫 #5B21F533）。 */

/** 状态筛选 chips（客户端过滤 list() 结果）。 */
type StatusFilter = 'all' | 'active' | 'restart' | 'update'

/**
 * 把 installedAt（ISO 时间戳）格式化成「MM-DD HH:mm」展示。
 * 解析失败 / 缺省时回落「—」（不假造日期）。
 */
function installedAtLabel(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const d = new Date(t)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${min}`
}
const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '已生效' },
  { id: 'restart', label: '需重启' },
  { id: 'update', label: '有更新' },
]

/**
 * 包的「状态」判定（设计稿 §2.1 meta 行「状态」字段）。
 * list() 的 wire 不带 restartRequired 真值（那是 installLocal 的结果字段），
 * 故本页「状态」只做展示口径的近似：所有已装包都标「已生效」（registry 有记录即已落盘）。
 * 「需重启」「有更新」在 P5b 无真值来源，filter 留实现但恒为空集（诚实骨架，
 * 不假造——见设计稿 §8 风险 4）。
 */
function packStatus(_pack: PackSummary): 'active' | 'restart' | 'update' {
  return 'active'
}

/* ── 导入结果面板 ──────────────────────────────────────────────────── */

/** 导入结果的展示投影（installLocal 成功 / 失败两态）。 */
type ImportOutcome =
  | { kind: 'ok'; result: InstallLocalPackResult }
  | { kind: 'error'; message: string }

/** 卸载结果（与 @corum/corum-extension-pack UninstallPackResult 同形）。 */
interface UninstallPackResult {
  readonly ok: boolean
  readonly packId: string
  readonly removed: {
    readonly presets: readonly string[]
    readonly skills: readonly string[]
    readonly mcp: readonly string[]
    readonly plugins: readonly string[]
    readonly themes: readonly string[]
    readonly ui: readonly string[]
  }
  readonly kept: ReadonlyArray<{ kind: string; name: string; reason: string }>
  readonly warnings: readonly string[]
  readonly restartRequired: boolean
  readonly error?: string
}

/** 卸载结果的展示投影（uninstall 成功 / 失败两态）。 */
type UninstallOutcome =
  | { kind: 'ok'; result: UninstallPackResult }
  | { kind: 'error'; message: string }

/* ── 主组件 ───────────────────────────────────────────────────────── */

export function ExtensionsPage() {
  const rpc = useIntegrationsRpc()
  if (rpc === null) return <p className={css.hintText}>RPC 服务未就绪。</p>
  return <ExtensionsView rpc={rpc} />
}

function ExtensionsView({ rpc }: { rpc: CorumRpcCall }) {
  const developerMode = useDeveloperMode()
  const [packs, setPacks] = useState<PackSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 导入菜单展开态（目录 / ZIP 二选一）。 */
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  /** 导入进行中。 */
  const [importing, setImporting] = useState(false)
  /** 导入结果（成功/失败），inline 显示在详情面板顶部。 */
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null)
  /** 卸载确认弹窗。 */
  const [uninstallConfirm, setUninstallConfirm] = useState<PackSummary | null>(null)
  /** 卸载进行中。 */
  const [uninstalling, setUninstalling] = useState(false)
  /** 卸载结果（成功/失败），inline 显示在详情面板顶部。 */
  const [uninstallOutcome, setUninstallOutcome] = useState<UninstallOutcome | null>(null)

  const reload = async () => {
    try {
      const r = await rpc<{ packs: PackSummary[] }>('extensionManager', 'list', {})
      setPacks(r.packs)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  /** 客户端过滤：搜索 + 状态 chips。 */
  const filtered = useMemo(() => {
    const pool = packs ?? []
    const q = query.trim().toLowerCase()
    let list = pool
    if (q !== '') {
      list = list.filter(p => (p.name ?? p.id).toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
    }
    if (statusFilter !== 'all') {
      list = list.filter(p => packStatus(p) === statusFilter)
    }
    return list
  }, [packs, query, statusFilter])

  /** 详情面板选中项（默认选第一个；过滤后选中项出列则回落）。 */
  const selected = useMemo(() => {
    const pool = filtered
    if (pool.length === 0) return null
    if (selectedId === null) return pool[0]
    return pool.find(p => p.id === selectedId) ?? pool[0]
  }, [filtered, selectedId])

  /** 磁贴序列（无「添加」哨兵——扩展包页不在此添加，走头部「导入」按钮）。 */
  const tiles = useMemo<Array<PackSummary>>(() => filtered, [filtered])
  const hints = useMemo<MosaicItemHint[]>(
    () => tiles.map(p => ({ nameLength: (p.name ?? p.id).length, hasDescription: p.hasManifest })),
    [tiles],
  )
  const tilesRef = useRef<HTMLDivElement>(null)
  const columns = useMosaicColumns(tilesRef)
  const mosaic = useMemo(
    () => buildMosaic(tiles, { pinFirstTwoSmalls: false, columns, hints }),
    [tiles, columns, hints],
  )

  /** 取桌面桥（合法 window 挂载，红线 3 窄接口；未装配时降级）。 */
  const bridge = (window as unknown as { corumDesktop?: DesktopBridge }).corumDesktop

  /**
   * 导入本地扩展包：目录 / ZIP 两路。
   * 目录走 pickDirectory，ZIP 走 pickFile（P5b 新增桥）。
   * 成功后刷新 list() 并把结果 inline 显示。
   */
  const doImport = async (kind: 'dir' | 'zip') => {
    setImportMenuOpen(false)
    if (bridge === undefined) {
      setImportOutcome({ kind: 'error', message: '桌面桥不可用（非桌面壳？）' })
      return
    }
    setImporting(true)
    setImportOutcome(null)
    try {
      let picked: { path: string | null; cancelled?: boolean; error?: string }
      if (kind === 'dir') {
        if (bridge.pickDirectory === undefined) {
          setImportOutcome({ kind: 'error', message: 'pickDirectory 桥不可用' })
          return
        }
        picked = await bridge.pickDirectory({ title: '选择扩展包目录' })
      } else {
        if (bridge.pickFile === undefined) {
          setImportOutcome({ kind: 'error', message: 'pickFile 桥不可用（需重启加载新 preload）' })
          return
        }
        picked = await bridge.pickFile({
          title: '选择扩展包 ZIP',
          filters: [{ name: '扩展包 ZIP', extensions: ['zip'] }],
        })
      }
      if (picked.cancelled === true || picked.path === null) {
        // 用户取消，不当作错误。
        return
      }
      if (picked.error !== undefined) {
        setImportOutcome({ kind: 'error', message: picked.error })
        return
      }
      const result = await rpc<InstallLocalPackResult | { ok: false; error: string }>(
        'extensionManager', 'installLocal', { sourcePath: picked.path },
      )
      if ('ok' in result && result.ok === false) {
        setImportOutcome({ kind: 'error', message: result.error })
        return
      }
      setImportOutcome({ kind: 'ok', result: result as InstallLocalPackResult })
      await reload()
    } catch (e) {
      setImportOutcome({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setImporting(false)
    }
  }

  /**
   * 卸载扩展包：确认弹窗 → rpc('extensionManager','uninstall',{packId}) → 结果面板 → 刷新。
   *
   * 失败（ok:false）时显示 error 且不刷新列表。
   * 成功后刷新 list()——包磁贴消失（或剩空态）。
   */
  const doUninstall = async (pack: PackSummary) => {
    setUninstalling(true)
    setUninstallOutcome(null)
    try {
      const result = await rpc<UninstallPackResult | { ok: false; error: string }>(
        'extensionManager', 'uninstall', { packId: pack.id },
      )
      if ('ok' in result && result.ok === false) {
        const errMsg = (result as { error?: string }).error ?? '卸载失败'
        setUninstallOutcome({ kind: 'error', message: errMsg })
        return
      }
      const r = result as UninstallPackResult
      if (!r.ok) {
        setUninstallOutcome({ kind: 'error', message: r.error ?? '卸载失败' })
        return
      }
      setUninstallOutcome({ kind: 'ok', result: r })
      await reload()
    } catch (e) {
      setUninstallOutcome({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setUninstalling(false)
      setUninstallConfirm(null)
    }
  }

  return (
    <div className={css.page}>
      {/* 页头单行：[已装] pill tab + 搜索框 280 + 状态 chips + spacer + 导入按钮（仅开发者）。 */}
      <div className={css.headerRow} role="tablist" aria-label="扩展包分区">
        <button
          type="button"
          role="tab"
          aria-selected={true}
          className={`${css.tab} ${css.tabActive}`}
        >已装</button>
        <div className={css.searchBox}>
          <Search size={14} className={css.searchIcon} />
          <input
            className={css.searchInput}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索扩展包…"
          />
        </div>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.id}
            type="button"
            className={`${css.filterChip}${statusFilter === f.id ? ' ' + css.filterChipActive : ''}`}
            onClick={() => setStatusFilter(f.id)}
          >{f.label}</button>
        ))}
        <span className={css.headerSpacer} />
        {developerMode && (
          <div className={css.importWrap}>
            <button
              type="button"
              className={css.addBtn}
              disabled={importing}
              onClick={() => setImportMenuOpen(v => !v)}
            >
              <Package size={14} />{importing ? '导入中…' : '导入本地扩展包'}
            </button>
            {importMenuOpen && (
              <div className={css.importMenu} role="menu">
                <button type="button" role="menuitem" className={css.importMenuItem} onClick={() => { void doImport('dir') }}>
                  <FolderOpen size={14} />目录
                </button>
                <button type="button" role="menuitem" className={css.importMenuItem} onClick={() => { void doImport('zip') }}>
                  <Package size={14} />ZIP
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={css.divider} />

      <div className={css.body}>
        {/* 左：磁贴群 */}
        <div className={css.tiles} ref={tilesRef}>
          <span className={css.sectionHead}>扩展包</span>
          {loadError !== null && <p className={css.hintText}>加载失败：{loadError}</p>}
          {packs !== null && packs.length === 0 && loadError === null && (
            <div className={css.emptyState}>
              <div className={css.emptyHero}>
                <Package size={40} />
              </div>
              <p className={css.emptyTitle}>还没有安装扩展包</p>
              <p className={css.emptyDesc}>
                {developerMode
                  ? '点右上角「导入本地扩展包」从本地目录或 ZIP 安装一个扩展包。'
                  : '扩展包是技能 / MCP / 预设 / 插件的集合。开启「设置 › 高级 › 开发者模式」后可导入本地扩展包。'}
              </p>
            </div>
          )}
          {tiles.length > 0 && tiles.length === 1 && (
            // 仅一个包时 buildMosaic 会按块骨架落到 128 小贴（名字被截成「Corum …」）。
            // 设计稿的精选包是 264×264，这里直接给首包大贴，避免「唯一一个包却最小」。
            <div className={css.singleTileRow}>
              <button
                type="button"
                data-tile-size="big"
                style={{
                  width: 'calc(264px * var(--corum-density-scale, 1))',
                  height: 'calc(264px * var(--corum-density-scale, 1))',
                }}
                className={mosaicTileClass({ size: 'big', tint: tintForName(tiles[0]!.id), active: true, glow: true })}
                aria-pressed
                title={tiles[0]!.name ?? tiles[0]!.id}
              >
                <MosaicTileBody
                  icon={<Package size={30} />}
                  name={tiles[0]!.name ?? tiles[0]!.id}
                  version={tiles[0]!.version}
                  sub="扩展包 · corum"
                />
              </button>
            </div>
          )}
          {tiles.length > 1 && (
            <MosaicWall
              items={tiles}
              blocks={mosaic}
              columns={columns}
              renderTile={(p, size, index) => {
                const active = selected !== null && selected.id === p.id
                return (
                  <button
                    key={`${p.id}:${index}`}
                    type="button"
                    data-tile-size={size}
                    className={mosaicTileClass({
                      size,
                      tint: tintForName(p.id),
                      active,
                      glow: size === 'big',
                    })}
                    aria-pressed={active}
                    title={p.name ?? p.id}
                    onClick={() => { setSelectedId(p.id); setImportOutcome(null) }}
                  >
                    <MosaicTileBody
                      icon={<Package size={size === 'big' ? 30 : 24} />}
                      name={p.name ?? p.id}
                      version={p.version}
                      sub="扩展包 · corum"
                    />
                  </button>
                )
              }}
            />
          )}
        </div>

        {/* 右：详情面板 */}
        <aside className={css.detail} aria-label="扩展包详情">
          {selected === null
            ? <DetailEmpty />
            : (
              <ExtensionsDetail
                rpc={rpc}
                pack={selected}
                importOutcome={importOutcome}
                onDismissOutcome={() => setImportOutcome(null)}
                uninstallOutcome={uninstallOutcome}
                onDismissUninstallOutcome={() => setUninstallOutcome(null)}
                onUninstallClick={() => {
                  setUninstallOutcome(null)
                  setUninstallConfirm(selected)
                }}
                uninstalling={uninstalling}
              />
            )}
        </aside>
      </div>

      {/* 卸载确认弹窗 */}
      {uninstallConfirm !== null && (
        <ConfirmDialog
          title="卸载扩展包"
          message={<>确定卸载扩展包「{uninstallConfirm.name ?? uninstallConfirm.id}」吗？</>}
          warning="该操作会删除扩展包拥有的技能、MCP 和插件。用户修改过的资源会保留。"
          confirmLabel="卸载"
          tone="danger"
          busy={uninstalling}
          busyLabel="卸载中…"
          onConfirm={() => { void doUninstall(uninstallConfirm) }}
          onCancel={() => { if (!uninstalling) setUninstallConfirm(null) }}
        />
      )}
    </div>
  )
}

/* ── 详情面板空态（未选中任何包）────────────────────────────────────── */

function DetailEmpty() {
  return (
    <div className={css.detailEmpty}>
      <div className={css.detailEmptyHero}>
        <img className={css.detailEmptyLogo} src="corumapp://app/assets/icon.png" alt="" draggable={false} />
      </div>
      <p className={css.detailEmptyTitle}>选择一个扩展包</p>
    </div>
  )
}

/* ── 详情面板 · 查看模式 ──────────────────────────────────────────── */

function ExtensionsDetail({ rpc, pack, importOutcome, onDismissOutcome, uninstallOutcome, onDismissUninstallOutcome, onUninstallClick, uninstalling }: {
  rpc: CorumRpcCall
  pack: PackSummary
  importOutcome: ImportOutcome | null
  onDismissOutcome: () => void
  uninstallOutcome: UninstallOutcome | null
  onDismissUninstallOutcome: () => void
  onUninstallClick: () => void
  uninstalling: boolean
}) {
  const [detail, setDetail] = useState<{ pack?: ExtensionPackRecord; dir: string; manifest?: unknown; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    void (async () => {
      try {
        const r = await rpc<{ pack?: ExtensionPackRecord; dir: string; manifest?: unknown; error?: string }>(
          'extensionManager', 'detail', { packId: pack.id },
        )
        if (!cancelled) {
          setDetail(r)
          if (r.error !== undefined) setError(r.error)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [rpc, pack.id])

  /** 内容计数一行（六类非零项拼接）。 */
  const contentSummary = useMemo(() => {
    const parts: string[] = []
    const labels: Record<ExtensionItemKind, string> = {
      presets: '预设', skills: '技能', mcp: 'MCP', plugins: '插件', themes: '主题', ui: 'UI',
    }
    for (const kind of Object.keys(pack.counts) as ExtensionItemKind[]) {
      const n = pack.counts[kind]
      if (n > 0) parts.push(`${labels[kind]} ${n}`)
    }
    return parts.length > 0 ? parts.join(' · ') : '无内容'
  }, [pack.counts])

  /** manifest 描述（容错：parse 失败时 detail.error 已有提示）。 */
  const manifestDesc = useMemo<string>(() => {
    if (detail?.manifest === undefined || detail.manifest === null) return ''
    const m = detail.manifest as { description?: unknown }
    return typeof m.description === 'string' ? m.description : ''
  }, [detail])

  return (
    <>
      <div className={css.detailHero}>
        <span className={css.detailHeroBadge}><Package size={30} /></span>
      </div>
      <div className={css.detailBody}>
        <div>
          {/* 导入结果 inline 面板（成功/失败），显示在详情顶部。 */}
          {importOutcome !== null && (
            <div className={importOutcome.kind === 'ok' ? css.outcomeOk : css.outcomeError}>
              <div className={css.outcomeHead}>
                <span className={css.outcomeTitle}>
                  {importOutcome.kind === 'ok' ? '导入成功' : '导入失败'}
                </span>
                <button type="button" className={css.outcomeClose} onClick={onDismissOutcome} aria-label="关闭结果">
                  <X size={13} />
                </button>
              </div>
              {importOutcome.kind === 'ok'
                ? <ImportResultBody result={importOutcome.result} />
                : <p className={css.hintText}>{importOutcome.message}</p>}
            </div>
          )}

          {error !== null && <p className={css.hintText}>{error}</p>}

          {/* 卸载结果 inline 面板（成功/失败），显示在详情顶部。 */}
          {uninstallOutcome !== null && (
            <div className={uninstallOutcome.kind === 'ok' ? css.outcomeOk : css.outcomeError}>
              <div className={css.outcomeHead}>
                <span className={css.outcomeTitle}>
                  {uninstallOutcome.kind === 'ok' ? '卸载完成' : '卸载失败'}
                </span>
                <button type="button" className={css.outcomeClose} onClick={onDismissUninstallOutcome} aria-label="关闭结果">
                  <X size={13} />
                </button>
              </div>
              {uninstallOutcome.kind === 'ok'
                ? <UninstallResultBody result={uninstallOutcome.result} />
                : <p className={css.hintText}>{uninstallOutcome.message}</p>}
            </div>
          )}

          <div className={css.detailTitleRow}>
            <span className={css.detailName}>{pack.name ?? pack.id}</span>
            <span className={css.detailVersion}>{pack.version}</span>
          </div>
          <p className={css.detailDesc}>
            {manifestDesc !== '' ? manifestDesc : '—'}
          </p>

          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>类型</span>
              <span className={css.detailMetaValue}>扩展包</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>状态</span>
              <span className={css.detailMetaValue}>{packStatus(pack) === 'active' ? '已生效' : packStatus(pack)}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>内容</span>
              <span className={css.detailMetaValue}>{contentSummary}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>id</span>
              <span className={`${css.detailMetaValue} ${css.detailMetaMono}`}>{pack.id}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>安装</span>
              <span className={css.detailMetaValue}>{installedAtLabel(pack.installedAt)}</span>
            </div>
          </div>
        </div>

        <div>
          {/* 底部操作行：查看包内容（no-op disabled）+ 卸载扩展包（P4）。 */}
          <div className={css.detailActions}>
            <button
              type="button"
              className={css.actionBtn}
              disabled
              title="本轮暂未提供查看包内容"
            >
              <FolderOpen size={13} />查看包内容
            </button>
            <button
              type="button"
              className={`${css.actionBtn} ${css.actionDanger}`}
              disabled={uninstalling}
              title={uninstalling ? '卸载中…' : '卸载此扩展包'}
              onClick={onUninstallClick}
            >
              <X size={13} />{uninstalling ? '卸载中…' : '卸载扩展包'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

/* ── 导入结果明细（成功态逐项列出）────────────────────────────────── */

function ImportResultBody({ result }: { result: InstallLocalPackResult }) {
  return (
    <div className={css.outcomeBody}>
      <div className={css.outcomeRow}>
        <Zap size={13} className={css.outcomeIcon} />
        <span className={css.outcomeLabel}>已装技能 {result.skills.installed.length} 个</span>
        {result.skills.installed.length > 0 && <span className={css.outcomeValue}>{result.skills.installed.join('、')}</span>}
      </div>
      {result.skills.skipped.length > 0 && (
        <div className={css.outcomeRow}>
          <ChevronDown size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>跳过技能 {result.skills.skipped.length} 个（已有同名）</span>
        </div>
      )}
      {result.mcp.applied.length > 0 && (
        <div className={css.outcomeRow}>
          <Zap size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>应用 MCP {result.mcp.applied.length} 个</span>
          <span className={css.outcomeValue}>{result.mcp.applied.join('、')}</span>
        </div>
      )}
      {result.plugins.length > 0 && (
        <div className={css.outcomeRow}>
          <Zap size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>
            插件 {result.plugins.filter(p => p.ok).length}/{result.plugins.length} 个成功
          </span>
        </div>
      )}
      {result.deferred.length > 0 && (
        <div className={css.outcomeRow}>
          <ChevronDown size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>
            暂未实现（{result.deferred.map(d => d.kind).join('、')}）
          </span>
        </div>
      )}
      {result.restartRequired && (
        <p className={css.outcomeRestart}>部分内容（UI 包）需重启应用后生效。</p>
      )}
      {result.warnings.length > 0 && (
        <div className={css.outcomeWarnings}>
          {result.warnings.map((w, i) => <p key={i} className={css.hintText}>{w}</p>)}
        </div>
      )}
    </div>
  )
}

/* ── 卸载结果明细（成功态逐项列出）────────────────────────────────── */

function UninstallResultBody({ result }: { result: UninstallPackResult }) {
  const removedTotal = result.removed.skills.length + result.removed.mcp.length + result.removed.plugins.length
  return (
    <div className={css.outcomeBody}>
      {removedTotal > 0 && (
        <div className={css.outcomeRow}>
          <Zap size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>已删除 {removedTotal} 项资源</span>
        </div>
      )}
      {result.removed.skills.length > 0 && (
        <div className={css.outcomeRow}>
          <Zap size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>删除技能 {result.removed.skills.length} 个</span>
          <span className={css.outcomeValue}>{result.removed.skills.join('、')}</span>
        </div>
      )}
      {result.removed.mcp.length > 0 && (
        <div className={css.outcomeRow}>
          <Zap size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>删除 MCP {result.removed.mcp.length} 个</span>
          <span className={css.outcomeValue}>{result.removed.mcp.join('、')}</span>
        </div>
      )}
      {result.removed.plugins.length > 0 && (
        <div className={css.outcomeRow}>
          <Zap size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>卸载插件 {result.removed.plugins.length} 个</span>
          <span className={css.outcomeValue}>{result.removed.plugins.join('、')}</span>
        </div>
      )}
      {result.kept.length > 0 && (
        <div className={css.outcomeRow}>
          <ChevronDown size={13} className={css.outcomeIcon} />
          <span className={css.outcomeLabel}>保留 {result.kept.length} 项</span>
        </div>
      )}
      {result.kept.length > 0 && (
        <div className={css.outcomeWarnings}>
          {result.kept.map((k, i) => (
            <p key={i} className={css.hintText}>{k.name}：{k.reason}</p>
          ))}
        </div>
      )}
      {result.restartRequired && (
        <p className={css.outcomeRestart}>部分内容需重启应用后完全生效。</p>
      )}
      {result.warnings.length > 0 && (
        <div className={css.outcomeWarnings}>
          {result.warnings.map((w, i) => <p key={i} className={css.hintText}>{w}</p>)}
        </div>
      )}
    </div>
  )
}
