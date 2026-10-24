/**
 * SkillsPage — 集成中心 · 技能页（design.pen VNH3k「集成中心·技能 SKILL」）。
 *
 * 数据链路（RPC 方法名与参数逐字不变）：skillManager/listAll|getSkillContent|
 * getSkillHistory|pinVersion|commitVersion|deleteSkill|importFromFile|
 * importFromText|scanDirectory|importDirectory|importBuiltinSkills
 * + corumAgent/listProfiles（绑定数）。
 *
 * 视图结构（design.pen VNH3k）：页头单行（市场|已装 pill tab + 280×31 搜索框 +
 * 分类 chips + 右端「导入技能 / 导入内置技能」）→ 全宽分隔线 → 磁贴群
 * （节头「技能 SKILL」+ 第一张「添加」磁贴 + 技能磁贴，卡片只留图标/名称/
 * 版本徽章/作者小字 —— 技能没有启停概念，磁贴上无开关）+ 右侧详情面板
 * （hero 150 + body）。
 *
 * 详情面板就地承担完整管理（不再跳二级 SkillDetailView 页）：
 *   统一字段六项打头（名称 → id → 版本 → 发布日期 → 作者 → 日志，顺序固定，
 *   与 MCP 页同构），其后才是技能语义的真值（类型 / 存储路径 / 创建时间）；
 *   版本管理（getSkillHistory + pinVersion 的 VersionSelect 下拉）与
 *   绑定此技能的 Agent（corumAgent/listProfiles 过滤）直接常驻面板内；
 *   SKILL.md 内容查看 / 编辑提交（getSkillContent/commitVersion）与
 *   删除（deleteSkill，走 DeleteSkillDialog）作为面板内的展开区。
 * 底部仅一个居中按钮：未安装语义「安装」/ 已安装语义「卸载」（技能库即本机，
 * 「已装」= 已在库中；这里按磁贴是否在库呈现对应语义）。
 *
 * rpc 为 null 时降级为静态占位提示。
 * @module corum-ide-integrations-pages-ui/client/SkillsPage
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown, Download, FileSearch, GitPullRequest, Hammer, PackagePlus,
  Plus, Search, ShieldCheck, Sparkles, Terminal, Trash2, X, Zap,
} from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { useIntegrationsRpc } from './face.tsx'
import { useExtensionOwnership, provenanceLabel, packOwnedTitle, type ExtensionOwnership } from './ownership.ts'
import type { SkillInfo, SkillVersion, ProfileSummary, ScannedSkill, SkillAgentBind, BuiltinSkillImportResult } from './types.ts'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import type { LucideIcon } from 'lucide-react'
import {
  buildMosaic, MosaicTileBody, MosaicWall, mosaicStyles, mosaicTileClass, useMosaicColumns,
} from '@corum/corum-ui-base/client'
import type { MosaicItemHint, MosaicSize, MosaicTint } from '@corum/corum-ui-base/client'
import css from './SkillsPage.module.css'
import shared from './IntegrationsPages.module.css'

/* ── 技能 ──────────────────────────────────────────────────────────── */

/**
 * 把「导入内置技能」的三桶摘要压成一行读得懂的结果。
 * 空桶不出现；三桶全空说明内置技能都已就位，给一句明确结论而不是空白。
 */
function formatBuiltinSummary(r: BuiltinSkillImportResult): string {
  const parts: string[] = []
  if (r.installed.length > 0) parts.push(`新装 ${r.installed.length} 个（${r.installed.join('、')}）`)
  if (r.skipped.length > 0) parts.push(`跳过 ${r.skipped.length} 个已有同名的，未覆盖（${r.skipped.join('、')}）`)
  if (r.tombstoned.length > 0) parts.push(`不复活 ${r.tombstoned.length} 个你删除过的（${r.tombstoned.join('、')}）`)
  if (parts.length === 0) return '内置技能都已在库，没有需要变更的。'
  return parts.join('；')
}

export function SkillsPage() {
  const rpc = useIntegrationsRpc()
  const ownership = useExtensionOwnership(rpc)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SkillInfo | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [builtinBusy, setBuiltinBusy] = useState(false)
  const [builtinResult, setBuiltinResult] = useState<BuiltinSkillImportResult | null>(null)
  const [tab, setTab] = useState<'market' | 'installed'>('installed')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('all')
  /** 详情面板选中态。 */
  const [selectedName, setSelectedName] = useState<string | null>(null)

  const reload = async () => {
    if (!rpc) return
    try {
      const [sk, pf] = await Promise.all([
        rpc<{ skills: SkillInfo[] }>('skillManager', 'listAll', {}),
        rpc<{ profiles: ProfileSummary[] }>('corumAgent', 'listProfiles', {}),
      ])
      setSkills(sk.skills)
      setProfiles(pf.profiles)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  /**
   * 「导入内置技能」：把随包分发的官方技能集装进技能库。
   * 幂等且不破坏——已有同名一律不覆盖、用户删过的不复活（host 侧策略），
   * 这里只负责发起 + 把三桶结果如实摊给用户看。
   */
  const importBuiltin = async () => {
    if (!rpc) return
    setBuiltinBusy(true)
    setBuiltinResult(null)
    try {
      const r = await rpc<BuiltinSkillImportResult>('skillManager', 'importBuiltinSkills', {})
      setBuiltinResult(r)
      if (r.ok) await reload()
    } catch (e) {
      setBuiltinResult({ ok: false, error: e instanceof Error ? e.message : String(e), installed: [], skipped: [], tombstoned: [] })
    } finally {
      setBuiltinBusy(false)
    }
  }

  /** 计算某 skill 被多少个 Agent 绑定。 */
  const bindCount = (name: string) =>
    profiles.filter(p => (p.skills ?? []).some(s => s.name === name)).length

  if (!rpc) {
    return <p className={css.hintText}>技能服务未就绪。</p>
  }

  /** 详情面板选中项（默认选第一个；过滤后选中项出列则回落——与插件页同一口径）。 */
  const selected = selectedName !== null
    ? (skills ?? []).find(s => s.name === selectedName) ?? (skills ?? [])[0] ?? null
    : (skills ?? [])[0] ?? null

  /** 绑定选中技能的 Agent 投影（含各自 pin 的版本），来自 corumAgent/listProfiles。 */
  const selectedBindings = useMemo<SkillAgentBind[]>(() => {
    if (selected === null) return []
    return profiles
      .filter(p => (p.skills ?? []).some(s => s.name === selected.name))
      .map(p => ({
        agentId: p.id,
        agentName: p.nickname ?? p.id,
        versionId: (p.skills ?? []).find(s => s.name === selected.name)!.versionId,
      }))
  }, [profiles, selected])

  return (
    <>
      <SkillMarketView
        skills={skills}
        error={error}
        tab={tab}
        setTab={setTab}
        query={query}
        setQuery={setQuery}
        category={category}
        setCategory={setCategory}
        selectedName={selectedName}
        setSelectedName={setSelectedName}
        selected={selected}
        selectedBindings={selectedBindings}
        bindCount={bindCount}
        rpc={rpc}
        ownership={ownership}
        onDeleted={() => { setSelectedName(null); void reload() }}
        onChanged={() => { void reload() }}
        onDelete={(s) => setDeleting(s)}
        onImport={() => setImportOpen(true)}
        onImportBuiltin={() => void importBuiltin()}
        builtinBusy={builtinBusy}
        builtinResult={builtinResult}
      />
      {deleting && (
        <DeleteSkillDialog
          skill={deleting}
          bindCount={bindCount(deleting.name)}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); void reload() }}
          rpc={rpc}
        />
      )}
      {importOpen && (
        <ImportSkillDialog
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); void reload() }}
          rpc={rpc}
        />
      )}
    </>
  )
}

/* ── 技能市场视图：Metro 磁贴 + 右侧详情面板 ───────────────────────── */

/** 分类筛选 chips（名称关键词归桶；全部永远有）。文案与顺序对应 design.pen VNH3k。 */
const CATEGORIES: { id: string; label: string; match: RegExp | null }[] = [
  { id: 'all', label: '全部', match: null },
  { id: 'verify', label: '验证', match: /verify|cdp|test|check|audit/ },
  { id: 'code', label: '代码', match: /code|review|refactor|lint|commit|git|dev/ },
  { id: 'deploy', label: '部署', match: /deploy|pack|build|release|publish|ship/ },
]

function categoryOf(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase()
  for (const c of CATEGORIES) {
    if (c.match !== null && c.match.test(text)) return c.id
  }
  return 'other'
}

/**
 * 磁贴图标按技能名语义映射到 lucide（design.pen VNH3k 用 ShieldCheck/
 * FileSearch/GitPullRequest/Terminal/Zap 等具体图标，不是统一 Star）。
 */
function skillIconOf(name: string): LucideIcon {
  const n = name.toLowerCase()
  if (/verify|cdp|check|audit/.test(n)) return ShieldCheck
  if (/review|lint/.test(n)) return FileSearch
  if (/pr|pull|flow/.test(n)) return GitPullRequest
  if (/dev|server|serve/.test(n)) return Terminal
  if (/auto|deploy|pack/.test(n)) return Zap
  return Sparkles
}

/* ── 磁贴 tint 档：按分类给底色（design.pen VNH3k 的四档真实色值 token）────── */

function skillTintOf(s: SkillInfo, size: MosaicSize): MosaicTint {
  if (size === 'big') return 'deep'
  if (size === 'wide') return 'mauve'
  if (size === 'tall') return 'slate'
  const cat = categoryOf(s.name, s.description ?? '')
  if (cat === 'verify') return 'violet'
  if (cat === 'code') return 'mauve'
  if (cat === 'deploy') return 'violet'
  return 'slate'
}

/**
 * 磁贴小字 = 作者口径（design.pen VNH3k「@corum · 官方」/「社区」）。
 * 判据：随包分发的内置技能集（packages/desktop/shipped-skills/，即
 * 「导入内置技能」装入的那批，PROVENANCE.md 判定的官方技能）写
 * 「@corum · 官方」；其余（用户从文件/文本/目录导入的）写「社区」。
 * 注意 listAll wire 上没有来源字段，这里按本仓技能库的既定组成近似：
 * 内置技能清单在编译期可知，与其求交集。
 */
const OFFICIAL_SKILL_NAMES = new Set([
  'cordis-plugin-development', 'dsh-archive-agent-notes', 'dsh-ci-test-reliability',
  'dsh-code-review', 'dsh-doc', 'dsh-find-simplifications', 'dsh-merging-stacked-prs',
  'dsh-pre-push-checks', 'dsh-prose-standard', 'dsh-translate-docs',
  'dsh-trim-cot-leakage', 'editing-cordis-compositions', 'record-browser-gif',
])
function skillAuthorLabel(name: string): string {
  return OFFICIAL_SKILL_NAMES.has(name) ? '@corum · 官方' : '社区'
}

/* ── 详情面板统一字段的展示口径 ─────────────────────────────────────── */

/** wire 上无发布/更新日期且本地也无真值时的占位（不造日期）。 */
const MISSING_VALUE = '—'

/** 详情面板「日志」区的一行（结构同插件页：版本 / 日期 / 变更说明）。 */
interface ChangelogEntry {
  version: string
  date: string
  note: string
}

/**
 * 更新日志：skillManager wire 不返回该字段。此处是**展示用假数据**，
 * 只为让「日志」区有内容可看；真值接入后换成从 RPC 读到的 changelog
 * 即可（结构保持不变）。
 */
const CHANGELOG_PLACEHOLDER: ChangelogEntry[] = [
  { version: 'v3', date: '2026-09-24', note: '补充反例与失败模式清单' },
  { version: 'v2', date: '2026-09-08', note: '拆出「先看现场再下结论」一节' },
  { version: 'v1', date: '2026-08-19', note: '首个版本：适用范围与检查清单' },
]

/** 把 ISO 时间戳压成日期（`2026-09-24T…` → `2026-09-24`）；无真值给占位。 */
function dateOnly(iso: string | undefined): string {
  if (iso === undefined || iso === '') return MISSING_VALUE
  const t = iso.indexOf('T')
  return t === -1 ? iso : iso.slice(0, t)
}

function SkillMarketView({ skills, error, tab, setTab, query, setQuery, category, setCategory,
  selectedName, setSelectedName, selected, selectedBindings, bindCount, rpc, ownership, onDeleted, onChanged,
  onDelete, onImport, onImportBuiltin, builtinBusy, builtinResult }: {
  skills: SkillInfo[] | null
  error: string | null
  tab: 'market' | 'installed'
  setTab: (t: 'market' | 'installed') => void
  query: string
  setQuery: (q: string) => void
  category: string
  setCategory: (c: string) => void
  selectedName: string | null
  setSelectedName: (n: string) => void
  selected: SkillInfo | null
  selectedBindings: SkillAgentBind[]
  bindCount: (name: string) => number
  rpc: CorumRpcCall
  ownership: ExtensionOwnership
  onDeleted: () => void
  onChanged: () => void
  onDelete: (s: SkillInfo) => void
  onImport: () => void
  onImportBuiltin: () => void
  builtinBusy: boolean
  builtinResult: BuiltinSkillImportResult | null
}) {
  /** 过滤后的技能池（搜索 + 分类）。
   *
   * fork（corum）2026-10-06 用户定调：「市场」tab 表示**在线技能市场**（尚未开放），
   * 整块收成「添加」+「建设中」两张磁贴，本地技能列表只在「已装」tab 显示。
   * 故市场 tab 的 pool 恒为空（技能磁贴不渲染），已装 tab 才是完整列表。 */
  const pool = useMemo(() => {
    if (tab === 'market') return []
    let list = skills ?? []
    const q = query.trim().toLowerCase()
    if (q !== '') {
      list = list.filter(s => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
    }
    if (category !== 'all') {
      list = list.filter(s => categoryOf(s.name, s.description ?? '') === category)
    }
    return list
  }, [tab, skills, query, category])

  /**
   * 磁贴序列（0 号恒为「添加」入口贴，`null` 作哨兵）+ 排布块。
   * 排布算法与几何都来自 `@corum/corum-ui-base/client`：固定种子 ⇒ 同一份数据
   * 每次渲染完全一致，过滤/搜索改变条数时才会重排；`pinFirstTwoSmalls` 把入口贴
   * 钉在左上角且为 small。
   */
  const tiles = useMemo<Array<SkillInfo | null>>(() => [null, ...pool], [pool])
  /**
   * 排布提示（与 `tiles` 同序）：算法据此把**名字长的**放进 264 宽槽，不再随机
   * 落进 128 窄贴被截断。贴面渲染的名字就是 `s.name`，故按它算长度；入口贴（0 号）
   * 由 `pinFirstTwoSmalls` 单独钉住，提示给 0 不参与抢宽槽。
   */
  const hints = useMemo<MosaicItemHint[]>(
    () => tiles.map(s => s === null
      ? { nameLength: 0 }
      : { nameLength: s.name.length, hasDescription: s.description !== '' }),
    [tiles],
  )
  /** 磁贴群列数：`ref` 挂在下面包 `MosaicWall` 的 `css.tiles` 容器上，窄窗自动降 3 列。 */
  const tilesRef = useRef<HTMLDivElement>(null)
  const columns = useMosaicColumns(tilesRef)
  const mosaic = useMemo(
    () => buildMosaic(tiles, { pinFirstTwoSmalls: true, columns, hints }),
    [tiles, columns, hints],
  )

  return (
    <div className={css.page}>
      {/* 页头单行：市场|已装 pill tab + 搜索框 + 分类 chips + 右端导入按钮（design.pen VNH3k） */}
      <div className={css.headerRow} role="tablist" aria-label="技能分区">
        <button type="button" role="tab" aria-selected={tab === 'installed'} className={`${css.tab}${tab === 'installed' ? ' ' + css.tabActive : ''}`} onClick={() => setTab('installed')}>已装</button>
        {/* 市场 tab：在线市场占位「建设中」，搜索框与分类 chips 只服务本地列表，隐藏。 */}
        {tab !== 'market' && (
          <>
            <div className={css.searchBox}>
              <Search size={14} className={css.searchIcon} />
              <input
                className={css.searchInput}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索技能…"
              />
            </div>
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                type="button"
                className={`${css.filterChip}${category === c.id ? ' ' + css.filterChipActive : ''}`}
                onClick={() => setCategory(c.id)}
              >{c.label}</button>
            ))}
          </>
        )}
        <span className={css.headerSpacer} />
        <button type="button" className={css.addBtn} onClick={onImport}>
          <PackagePlus size={14} />导入技能
        </button>
        <button type="button" className={css.addBtn} onClick={onImportBuiltin} disabled={builtinBusy}>
          <Download size={14} />{builtinBusy ? '导入中…' : '导入内置技能'}
        </button>
      </div>

      {/* 全宽分隔线（页头行与磁贴群之间） */}
      <div className={css.divider} />

      {builtinResult !== null && (
        builtinResult.ok
          ? <p className={css.hintText}>内置技能：{formatBuiltinSummary(builtinResult)}</p>
          : <p className={shared.confirmWarn}>导入内置技能失败：{builtinResult.error ?? '未知错误'}</p>
      )}

      <div className={css.body}>
        {/* 左：Metro 磁贴群（节头 + 添加磁贴 + 技能磁贴） */}
        <div className={css.tiles} ref={tilesRef}>
          <span className={css.sectionHead}>技能 SKILL</span>
          {error !== null && <p className={css.hintText}>加载失败：{error}</p>}
          {skills === null && error === null && <p className={css.hintText}>加载中…</p>}
          <MosaicWall
            items={tiles}
            blocks={mosaic}
            columns={columns}
            renderTile={(s, size, index) => {
              /* 尺寸走 data-tile-size，贴必须是列的直接子元素（MosaicWall 不包壳层）。 */
              if (s === null) {
                return (
                  <button
                    key="add"
                    type="button"
                    data-tile-size={size}
                    className={mosaicTileClass({ size, tint: 'slate' })}
                    aria-label="添加技能"
                    onClick={onImport}
                  >
                    <MosaicTileBody
                      icon={<Plus size={24} />}
                      name="添加"
                      version="SKILL"
                      sub="新技能"
                    />
                  </button>
                )
              }
              const active = selected !== null && selected.name === s.name
              const Icon = skillIconOf(s.name)
              const packOwner = ownership.ownerOf('skills', s.name)
              return (
                <button
                  key={`${s.name}:${index}`}
                  type="button"
                  data-tile-size={size}
                  className={mosaicTileClass({
                    size,
                    tint: skillTintOf(s, size),
                    active,
                    glow: size === 'big',
                  })}
                  aria-pressed={active}
                  onClick={() => setSelectedName(s.name)}
                >
                  {/* 卡片只留：图标 / 名称 / 版本徽章 / 作者小字（技能无启停概念）。
                      pack-owned 技能补一枚「扩展包」角标（不破坏磁贴布局）。 */}
                  <MosaicTileBody
                    icon={<Icon size={size === 'big' ? 30 : 24} />}
                    name={s.name}
                    version={s.currentVersion ?? '—'}
                    /* 除 small 外都传描述（tall 纵向空间富余）；空串不渲染。 */
                    sub={skillAuthorLabel(s.name)}
                    corner={packOwner !== null ? (
                      <span className={css.tilePackChip} title={`扩展包 · ${packOwner}`}>扩展包</span>
                    ) : undefined}
                  />
                </button>
              )
            }}
          />
          {/* 市场 tab = 在线技能市场（未开放）：在「添加」磁贴后补一张「建设中」磁贴。
              已装 tab 不渲染它（pool 已是完整技能列表）。 */}
          {tab === 'market' && (
            <div
              className={mosaicTileClass({ size: 'big', tint: 'violet', glow: true, className: css.wipTile })}
              data-tile-size="big"
              aria-label="技能市场建设中"
            >
              <MosaicTileBody
                icon={<Hammer size={30} />}
                name="技能市场建设中"
                version="SKILL"
                sub="在线技能市场暂未开放。可点左侧「添加」从文件 / 文本 / 目录 / 内置导入技能。"
              />
            </div>
          )}
          {/* 空态占位（无技能时）：独立的高 128 块，三张 128×128 虚线卡。
              末块本就允许截断（块生成器只为真实磁贴保证 808），故此处宽 3×128+2×8 = 400。 */}
          {tab !== 'market' && skills !== null && pool.length === 0 && error === null && (
            <div className={mosaicStyles.mosaicBlock} data-mosaic-block="128">
              {[0, 1, 2].map(i => (
                <div key={i} className={mosaicStyles.mosaicCol} data-col="128">
                  <div className={mosaicStyles.tilePlaceholder} data-tile-size="small"><span className={mosaicStyles.tilePlaceholderIcon}><Plus size={20} /></span><p className={mosaicStyles.tilePlaceholderText}>即将上线</p></div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右：详情面板（点击磁贴就地展开；版本管理 + 绑定 Agent 常驻）。
            市场 tab 无技能磁贴可选（仅「添加」+「建设中」），恒显示空态引导。 */}
        <aside className={css.detail} aria-label="技能详情">
          {tab === 'market' || selected === null
            ? <DetailEmpty
                title="选择一个技能"
                desc=""
              />
            : (
              <SkillDetailPanel
                skill={selected}
                bindings={selectedBindings}
                rpc={rpc}
                ownerName={ownership.ownerOf('skills', selected.name)}
                onDeleted={onDeleted}
                onChanged={onChanged}
                onRequestDelete={() => onDelete(selected)}
              />
            )}
        </aside>
      </div>
    </div>
  )
}

/* ── 详情面板共用：空态 ───────────────────────────────────────────── */

/** 详情面板空态（未选中任何磁贴）：产品 logo + glow + 引导文案。 */
function DetailEmpty({ title, desc }: { title: string; desc: string }) {
  return (
    <div className={css.detailEmpty}>
      <div className={css.detailEmptyHero}>
        <img className={css.detailEmptyLogo} src="corumapp://app/assets/icon.png" alt="" draggable={false} />
      </div>
      <p className={css.detailEmptyTitle}>{title}</p>
      {desc !== '' && <p className={css.detailEmptyDesc}>{desc}</p>}
    </div>
  )
}

/* ── 详情面板（版本管理 / 绑定 Agent 常驻；SKILL.md 为展开区）────────── */

function SkillDetailPanel({ skill, bindings, rpc, ownerName, onDeleted, onChanged, onRequestDelete }: {
  skill: SkillInfo
  bindings: SkillAgentBind[]
  rpc: CorumRpcCall
  /** 扩展包归属的包显示名（name ?? id）；null = 非扩展包拥有（用户导入）。 */
  ownerName: string | null
  onDeleted: () => void
  onChanged: () => void
  onRequestDelete: () => void
}) {
  const Icon = skillIconOf(skill.name)
  /** 分类名（元信息「类型」）；未归类给默认口径。 */
  const catLabel = CATEGORIES.find(c => c.id === categoryOf(skill.name, skill.description ?? ''))?.label
  /** 版本历史（getSkillHistory）与当前 pin（pinVersion 后回填）。 */
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [pinned, setPinned] = useState<string | undefined>(skill.currentVersion)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** SKILL.md 内容展开区（getSkillContent / commitVersion）。 */
  const [contentOpen, setContentOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [commitOpen, setCommitOpen] = useState(false)

  const loadVersions = async () => {
    try {
      const h = await rpc<{ versions: SkillVersion[] }>('skillManager', 'getSkillHistory', { name: skill.name })
      setVersions(h.versions)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const loadContent = async () => {
    try {
      const c = await rpc<{ ok: boolean; error?: string; content?: string }>('skillManager', 'getSkillContent', { name: skill.name })
      if (c.ok && c.content !== undefined) setContent(c.content)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    setVersions([])
    setPinned(skill.currentVersion)
    setContent(null)
    setEditing(false)
    setContentOpen(false)
    setError(null)
    void loadVersions()
  }, [skill.name])

  const switchVersion = async (versionId: string) => {
    setBusy(true)
    try {
      await rpc('skillManager', 'pinVersion', { name: skill.name, versionId })
      setPinned(versionId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveAndCommit = async (label?: string) => {
    setBusy(true)
    try {
      const r = await rpc<{ ok: boolean; error?: string; version?: SkillVersion }>(
        'skillManager', 'commitVersion', { name: skill.name, content: draft, label: label ?? '手动提交' })
      if (!r.ok) { setError(r.error ?? '提交失败'); return }
      setEditing(false)
      setCommitOpen(false)
      await loadVersions()
      if (r.version) setPinned(r.version.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = () => { setDraft(content ?? ''); setEditing(true) }

  return (
    <>
      <div className={css.detailHero}>
        <span className={css.detailHeroBadge}><Icon size={30} /></span>
      </div>
      <div className={css.detailBody}>
        <div>
          <div className={css.detailTitleRow}>
            <span className={css.detailName}>{skill.name}</span>
            <span className={css.detailVersion}>{pinned ?? skill.currentVersion ?? MISSING_VALUE}</span>
          </div>
          {skill.description !== '' && <p className={css.detailDesc}>{skill.description}</p>}

          {/* 统一字段六项：名称 → id → 版本 → 发布日期 → 作者 → 日志（与插件页同构）。
              技能名即 id；版本取 pin ?? currentVersion（真值）；发布日期取 createdAt
              真值；日志 wire 无此字段，用 CHANGELOG_PLACEHOLDER 假数据先填。
              作者只在字段区出现一次——标题下方不再重复同一行小字。 */}
          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>名称</span>
              <span className={css.detailMetaValue}>{skill.name}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>id</span>
              <span className={`${css.detailMetaValue} ${css.detailMetaMono}`}>{skill.name}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>版本</span>
              <span className={css.detailMetaValue}>{pinned ?? skill.currentVersion ?? MISSING_VALUE}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>发布日期</span>
              {/* 真值取技能的 createdAt（wire 无独立的发布日期字段）。 */}
              <span className={css.detailMetaValue}>{dateOnly(skill.createdAt)}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>作者</span>
              <span className={css.detailMetaValue}>{OFFICIAL_SKILL_NAMES.has(skill.name) ? 'corum · 官方技能' : 'corum 技能库'}</span>
            </div>
            {/* 来源（P5d）：扩展包拥有的技能标「扩展包 · <pack>」，其余按既有口径「用户导入」。 */}
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>来源</span>
              <span className={css.detailMetaValue}>{provenanceLabel(ownerName, '用户导入')}</span>
            </div>
          </div>

          {/* 日志：静态占位 changelog（wire 无此字段，见 CHANGELOG_PLACEHOLDER）。 */}
          <div className={css.detailSection}>
            <span className={css.detailSectionHead}>日志（{CHANGELOG_PLACEHOLDER.length}）</span>
            {CHANGELOG_PLACEHOLDER.map(entry => (
              <div key={entry.version} className={css.detailLogRow}>
                <span className={css.detailLogVersion}>{entry.version}</span>
                <span className={css.detailLogDate}>{entry.date}</span>
                <span className={css.detailLogNote}>{entry.note}</span>
              </div>
            ))}
          </div>

          {/* 以下为技能已有的真值字段，保持在六项之后。 */}
          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>类型</span>
              <span className={css.detailMetaValue}>{catLabel !== undefined ? `${catLabel} · 技能（SKILL.md 指令包）` : '技能（SKILL.md 指令包）'}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>存储路径</span>
              <span className={css.detailMetaValue}>{skill.path}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>创建时间</span>
              <span className={css.detailMetaValue}>{skill.createdAt ?? '—'}</span>
            </div>
          </div>

          {/* 版本管理（getSkillHistory + pinVersion）常驻面板内。 */}
          <div className={css.detailSection}>
            <span className={css.detailSectionHead}>版本历史（{versions.length}）</span>
            {versions.length === 0 && <p className={css.hintText}>暂无版本记录。</p>}
            {versions.length > 0 && (
              <VersionSelect
                versions={versions}
                pinned={pinned}
                onSelect={id => void switchVersion(id)}
                disabled={busy}
              />
            )}
          </div>

          {/* 绑定 Agent（corumAgent/listProfiles 过滤）常驻面板内。 */}
          <div className={css.detailSection}>
            <span className={css.detailSectionHead}>绑定此技能的 Agent（{bindings.length}）</span>
            {bindings.length === 0 && <p className={css.hintText}>暂无 Agent 绑定此技能。</p>}
            {bindings.map(b => (
              <div key={b.agentId} className={css.detailBindRow}>
                <span className={css.detailBindAvatar}>{b.agentName[0] ?? '?'}</span>
                <span className={css.detailBindName}>{b.agentName}</span>
                <span className={css.detailVersion}>pin {b.versionId}</span>
              </div>
            ))}
            <p className={css.hintText}>绑定关系在 Agent 预设中管理，此处仅展示。</p>
          </div>

          {/* SKILL.md 内容展开区（查看 / 编辑提交 getSkillContent/commitVersion）。 */}
          <div className={css.detailSection}>
            {contentOpen
              ? (
                <>
                  <button type="button" className={css.sharedPlainBtn} onClick={() => { setContentOpen(false); setEditing(false) }}>
                    <ChevronDown size={13} />收起 SKILL.md
                  </button>
                  {error !== null && <p className={css.hintText}>{error}</p>}
                  {!editing
                    ? (
                      <>
                        <pre className={css.detailFormJson}>{content ?? '加载中…'}</pre>
                        <div className={css.detailInlineActions}>
                          <button type="button" className={css.sharedPlainBtn} onClick={startEdit}>编辑</button>
                          <button
                            type="button"
                            className={css.sharedPlainBtn}
                            onClick={() => { setDraft(content ?? ''); void loadContent(); setCommitOpen(true) }}
                          >提交新版本</button>
                        </div>
                      </>
                    )
                    : (
                      <>
                        <textarea
                          className={css.detailFormJson}
                          value={draft}
                          onChange={e => setDraft(e.target.value)}
                          rows={14}
                        />
                        <p className={css.hintText}>编辑不会立即生效——保存后将当前内容提交为新版本（自动设为当前版本）。</p>
                        <div className={css.detailInlineActions}>
                          <button type="button" className={css.sharedPlainBtn} onClick={() => setEditing(false)}>取消</button>
                          <button type="button" className={css.sharedPlainBtn} disabled={busy} onClick={() => void saveAndCommit()}>
                            {busy ? '提交中…' : '保存并提交新版本'}
                          </button>
                        </div>
                      </>
                    )}
                </>
              )
              : (
                <button
                  type="button"
                  className={css.sharedPlainBtn}
                  onClick={() => { setContentOpen(true); if (content === null) void loadContent() }}
                >
                  <ChevronDown size={13} />SKILL.md 内容
                </button>
              )}
          </div>
        </div>

        {/* 底部操作行：仅一个居中按钮（已装语义「卸载」= 删除，走 DeleteSkillDialog 确认）。
            pack-owned 技能禁用（只能整包卸载），title 引导到 集成中心 › 扩展包。 */}
        <div className={css.detailActions}>
          <button
            type="button"
            className={css.actionPrimary}
            disabled={ownerName !== null}
            title={ownerName !== null ? packOwnedTitle(ownerName) : undefined}
            onClick={onRequestDelete}
          >
            <Trash2 size={14} />卸载
          </button>
        </div>
      </div>

      {commitOpen && (
        <CommitVersionDialog
          name={skill.name}
          onClose={() => setCommitOpen(false)}
          onSubmit={label => void saveAndCommit(label)}
          busy={busy}
        />
      )}
    </>
  )
}

/* ── 版本选择下拉（触发按钮 + portal 面板，面板内每个版本用 item 富形态）────── */

function VersionSelect({ versions, pinned, onSelect, disabled }: {
  versions: SkillVersion[]
  pinned: string | undefined
  onSelect: (versionId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const current = versions.find(v => v.id === pinned) ?? versions[versions.length - 1]

  useEffect(() => {
    if (!open) return
    const btn = btnRef.current
    if (btn) {
      const r = btn.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: r.left, width: r.width })
    }
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <div className={shared.versionSelectWrap}>
      <button
        ref={btnRef}
        type="button"
        className={shared.versionSelectBtn}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className={shared.radioOn} />
        <span className={shared.versionMeta}>
          <span className={shared.versionId}>{current.id}</span>
          <span className={shared.versionLabel}>{current.label}</span>
        </span>
        <ChevronDown size={16} className={shared.versionSelectChevron} />
      </button>
      {open && !disabled && pos && createPortal(
        <div
          ref={panelRef}
          className={shared.versionPanel}
          role="listbox"
          style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width }}
        >
          {versions.map(v => {
            const active = v.id === current.id
            return (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? shared.versionRowActive : shared.versionRow}
                onClick={() => { onSelect(v.id); setOpen(false) }}
              >
                <span className={active ? shared.radioOn : shared.radioOff} />
                <div className={shared.versionMeta}>
                  <span className={shared.versionId}>{v.id}</span>
                  <span className={shared.versionLabel}>{v.label}</span>
                </div>
                {active && <span className={shared.currentTag}>当前使用</span>}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

/* ── 提交新版本对话框 ─────────────────────────────────────────────── */

function CommitVersionDialog({ name, onClose, onSubmit, busy }: {
  name: string
  onClose: () => void
  onSubmit: (label: string) => void
  busy: boolean
}) {
  const [label, setLabel] = useState('')
  return createPortal(
    <div className={shared.modalOverlay} onClick={onClose}>
      <div className={shared.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={shared.modalHeader}>
          <span className={shared.modalTitle}>提交新版本</span>
          <button type="button" className={shared.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={shared.modalBody}>
          <p className={shared.hintText}>把「{name}」当前的 SKILL.md 保存为一个新版本快照。</p>
          <div className={shared.formGroup}>
            <label className={shared.fieldLabel}>版本备注</label>
            <input className={shared.fieldInput} value={label} onChange={e => setLabel(e.target.value)} placeholder="如：优化评审分级模板" />
          </div>
          <p className={shared.hintText}>提交后该版本将自动设为当前生效版本；Agent 仍按各自 pin 的版本引用。</p>
        </div>
        <div className={shared.modalFooter}>
          <div className={shared.footerLeft} />
          <div className={shared.footerRight}>
            <button type="button" className={shared.btnDefault} onClick={onClose}>取消</button>
            <button type="button" className={css.actionPrimary} disabled={busy} onClick={() => onSubmit(label || '手动提交')}>
              {busy ? '提交中…' : '提交'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 删除技能确认对话框 ───────────────────────────────────────────── */

function DeleteSkillDialog({ skill, bindCount, onClose, onDeleted, rpc }: {
  skill: SkillInfo
  bindCount: number
  onClose: () => void
  onDeleted: () => void
  rpc: CorumRpcCall
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const doDelete = async () => {
    setBusy(true)
    try {
      const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'deleteSkill', { name: skill.name })
      if (!r.ok) { setError(r.error ?? '删除失败'); setBusy(false); return }
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      title="卸载技能"
      message={<>确定卸载技能「{skill.name}」吗？</>}
      warning={bindCount > 0 ? `该技能已绑定 ${bindCount} 个 Agent。卸载后这些 Agent 将失去此技能，且不可恢复。` : undefined}
      error={error}
      confirmLabel="卸载"
      busyLabel="卸载中…"
      busy={busy}
      onConfirm={() => void doDelete()}
      onCancel={onClose}
    />
  )
}

/* ── 导入技能对话框（文件 / 文本粘贴 / 扫描目录）───────────────────── */

type ImportTab = 'file' | 'text' | 'scan'

function ImportSkillDialog({ onClose, onImported, rpc }: {
  onClose: () => void
  onImported: () => void
  rpc: CorumRpcCall
}) {
  const [tab, setTab] = useState<ImportTab>('file')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // file
  const [filePath, setFilePath] = useState('')
  // text
  const [textName, setTextName] = useState('')
  const [textContent, setTextContent] = useState('')
  // scan
  const [scanDir, setScanDir] = useState('')
  const [scanned, setScanned] = useState<ScannedSkill[] | null>(null)
  const [existing, setExisting] = useState<string[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const importFile = () => run(async () => {
    const name = filePath.replace(/\/+$/, '').split('/').pop() ?? ''
    const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'importFromFile', { skillName: name, sourcePath: filePath })
    if (!r.ok) { setError(r.error ?? '导入失败'); return }
    onImported()
  })

  const importText = () => run(async () => {
    const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'importFromText', { skillName: textName, content: textContent })
    if (!r.ok) { setError(r.error ?? '导入失败'); return }
    onImported()
  })

  const doScan = () => run(async () => {
    const r = await rpc<{ skills: ScannedSkill[]; existing: string[] }>('skillManager', 'scanDirectory', { sourcePath: scanDir })
    setScanned(r.skills)
    setExisting(r.existing)
    setChecked(new Set(r.skills.filter(s => !r.existing.includes(s.name)).map(s => s.name)))
  })

  const importScanned = () => run(async () => {
    const r = await rpc<{ imported: number; skipped: number; failed: { name: string; error: string }[] }>('skillManager', 'importDirectory', { sourcePath: scanDir })
    if (r.failed.length > 0) { setError(`部分失败：${r.failed.map(f => f.name).join('、')}`); return }
    onImported()
  })

  const TABS: { id: ImportTab; label: string }[] = [
    { id: 'file', label: '从文件导入' },
    { id: 'text', label: '从文本粘贴' },
    { id: 'scan', label: '扫描目录' },
  ]

  return createPortal(
    <div className={shared.modalOverlay} onClick={onClose}>
      <div className={shared.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={shared.modalHeader}>
          <span className={shared.modalTitle}>导入技能</span>
          <button type="button" className={shared.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={shared.modalBody}>
          <div className={shared.transportPills}>
            {TABS.map(t => (
              <button key={t.id} type="button" className={`${shared.transportPill}${tab === t.id ? ' ' + shared.transportPillActive : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
          {error && <p className={shared.confirmWarn}>{error}</p>}

          {tab === 'file' && (
            <div className={shared.formGroup}>
              <label className={shared.fieldLabel}>技能目录或 SKILL.md 路径</label>
              <input className={shared.fieldInput} value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="/path/to/skill" />
              <p className={shared.hintText}>需包含有效 frontmatter（name + description）的 SKILL.md。</p>
            </div>
          )}

          {tab === 'text' && (
            <>
              <div className={shared.formGroup}>
                <label className={shared.fieldLabel}>技能名称</label>
                <input className={shared.fieldInput} value={textName} onChange={e => setTextName(e.target.value)} placeholder="my-skill" />
              </div>
              <div className={shared.formGroup}>
                <label className={shared.fieldLabel}>SKILL.md 内容</label>
                <textarea className={shared.skillEditor} value={textContent} onChange={e => setTextContent(e.target.value)} rows={10} placeholder={'---\nname: my-skill\ndescription: 技能描述\n---\n在此粘贴 markdown 正文…'} />
                <p className={shared.hintText}>frontmatter 必须包含 name 和 description 字段。</p>
              </div>
            </>
          )}

          {tab === 'scan' && (
            <>
              <div className={shared.formGroup}>
                <label className={shared.fieldLabel}>目录路径</label>
                <div className={shared.formCols}>
                  <input className={shared.fieldInput} value={scanDir} onChange={e => setScanDir(e.target.value)} placeholder="/Users/you/my-skills" style={{ flex: 1 }} />
                  <button type="button" className={shared.btnDefault} onClick={() => void doScan()} disabled={busy || !scanDir}>扫描</button>
                </div>
              </div>
              {scanned !== null && (
                <div className={shared.formGroup}>
                  <label className={shared.fieldLabel}>识别到 {scanned.length} 个技能（已存在将跳过）</label>
                  {scanned.length === 0 && <p className={shared.hintText}>该目录下未识别到技能。</p>}
                  {scanned.map(s => {
                    const exists = existing.includes(s.name)
                    return (
                      <label key={s.name} className={shared.scanRow}>
                        <input
                          type="checkbox"
                          checked={checked.has(s.name)}
                          disabled={exists}
                          onChange={e => setChecked(prev => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(s.name); else next.delete(s.name)
                            return next
                          })}
                        />
                        <span className={exists ? shared.scanNameDim : shared.scanName}>{s.name}</span>
                        <span className={shared.scanDesc}>{s.description}</span>
                        {exists && <span className={shared.scanExists}>已存在</span>}
                      </label>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <div className={shared.modalFooter}>
          <div className={shared.footerLeft} />
          <div className={shared.footerRight}>
            <button type="button" className={shared.btnDefault} onClick={onClose}>取消</button>
            {tab === 'file' && <button type="button" className={css.actionPrimary} onClick={() => void importFile()} disabled={busy || !filePath}>{busy ? '导入中…' : '导入'}</button>}
            {tab === 'text' && <button type="button" className={css.actionPrimary} onClick={() => void importText()} disabled={busy || !textName || !textContent}>{busy ? '导入中…' : '导入'}</button>}
            {tab === 'scan' && <button type="button" className={css.actionPrimary} onClick={() => void importScanned()} disabled={busy || scanned === null || checked.size === 0}>{busy ? '导入中…' : `导入（${checked.size}）`}</button>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
