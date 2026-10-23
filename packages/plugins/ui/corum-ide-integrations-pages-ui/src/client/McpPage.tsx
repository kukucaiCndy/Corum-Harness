/**
 * McpPage — 集成中心 · MCP 页（design.pen bFLLQ「集成中心·MCP 服务器」）。
 *
 * 数据链路不变（RPC 方法名与参数逐字未动）：
 *   mcpManager/listServers（列表）+ testConnection（运行状态/工具数）
 *   + getServer（详情回填）+ saveServer（添加/启停/编辑）+ deleteServer
 *   + getServerReferences + corumAgent/listProfiles（绑定 Agent 头像/昵称）。
 *
 * 视图结构（design.pen bFLLQ）：页头单行（市场|已装 pill tab，本页无搜索框、
 * 无分类 chips）→ 全宽分隔线 → 磁贴群（节头「MCP 服务器」+ 第一张「添加」
 * 磁贴 + 服务器磁贴，角标 = 运行状态点 8×8，小字 = 传输 · 启动地址）
 * + 右侧详情面板（hero 150 + body）。
 *
 * 详情面板两种模式：
 *   查看 — 统一字段六项打头（名称 → id → 版本 → 发布日期 → 作者 → 日志，顺序固定），
 *          其后才是 MCP 语义的真值：传输 / 连接状态（testConnection 运行中·工具数）/
 *          范围（cwd，空写「全局」）/ 工具清单（前 4 + 展开全部）/ 绑定 Agent
 *          （corumAgent/listProfiles 过滤）；底部居中「删除服务器」（error 描边，
 *          createPortal 确认框）+ 启停开关（saveServer 翻转 disabled）。
 *   新建 — 点「添加」磁贴后表单就地搬进面板（名称 / 传输 tab stdio·SSE·WebSocket
 *          / 启动配置 JSON / 启动·运行超时 / 使用指导），校验逻辑原样保留；
 *          提交成功回「查看」。
 *
 * rpc 为 null 时降级为静态占位提示。
 * @module corum-ide-integrations-pages-ui/client/McpPage
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, FolderTree, Hammer, Info, Plus, Trash2 } from 'lucide-react'
import { useIntegrationsRpc } from './face.tsx'
import { useExtensionOwnership, provenanceLabel, packOwnedTitle, type ExtensionOwnership } from './ownership.ts'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import {
  buildMosaic, MosaicTileBody, MosaicWall, mosaicStyles, mosaicTileClass, useMosaicColumns,
} from '@corum/corum-ui-base/client'
import type { MosaicItemHint, MosaicSize, MosaicTint } from '@corum/corum-ui-base/client'
import css from './McpPage.module.css'
import shared from './IntegrationsPages.module.css'

/* ── 数据模型（mcpManager RPC 投影） ────────────────────────────────── */

type McpTransport = 'stdio' | 'streamable-http'

interface McpServerSummaryWire {
  name: string
  description?: string
  transport: McpTransport
  endpoint: string
  disabled?: boolean
}

type TestConnectionResultWire =
  | { ok: true; tools: Array<{ name: string; description?: string }> }
  | { ok: false; error: string }

interface McpServerConfigWire {
  name: string
  description?: string
  /** 写给模型的**使用指导**（进提示词；与给人看的 description 不同）。 */
  guidance?: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  disabled?: boolean
}

/** 每服务探测状态（列表磁贴 + 详情面板共用）。 */
interface ProbeState {
  loading: boolean
  toolCount: number | null
  error: string | null
}

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  'stdio': 'stdio',
  'streamable-http': 'sse',
}

/**
 * 「版本」与「发布日期」在 MCP 详情面板里**不显示**：`mcpManager` 的 wire
 * （listServers / getServer）只回 name / transport / endpoint / description /
 * disabled，没有版本号也没有发布或更新日期。与其拿传输方式或破折号充数
 * （假值容易被读成真实元信息），不如省掉这两行。
 */

/* ── 日志（changelog）占位数据 ──────────────────────────────────────── */

/** 详情面板「日志」区的一行（结构同插件页：版本 / 日期 / 变更说明）。 */
interface ChangelogEntry {
  version: string
  date: string
  note: string
}

/**
 * 更新日志：mcpManager wire 不返回该字段。此处是**展示用假数据**，
 * 只为让「日志」区有内容可看；真值接入后把 CHANGELOG_PLACEHOLDER 换成
 * 从 RPC 读到的 changelog 即可（结构保持不变）。
 */
const CHANGELOG_PLACEHOLDER: ChangelogEntry[] = [
  { version: '0.9.1', date: '2026-09-24', note: '路径白名单支持 glob 通配' },
  { version: '0.9.0', date: '2026-09-08', note: '增量同步改为事件驱动，启动更快' },
  { version: '0.8.2', date: '2026-08-19', note: '修复 stdio 子进程退出后未重连' },
]

/** 各传输方式的 JSON 示例（stdio=命令行启动，SSE/WebSocket=URL）。 */
const MCP_JSON_PLACEHOLDERS: Record<AddTransport, string> = {
  'stdio': `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem",
    "/path/to/your/workspace"],
  "env": {
    "API_KEY": "your-key-here"
  }
}`,
  'sse': `{
  "url": "https://mcp.example.com/sse",
  "headers": {
    "Authorization": "Bearer <token>"
  }
}`,
  'websocket': `{
  "url": "ws://127.0.0.1:7788/mcp",
  "headers": {
    "Authorization": "Bearer <token>"
  }
}`,
}

/** 详情面板「新建」模式的传输 tab（stdio / SSE·HTTP / WebSocket）。 */
type AddTransport = 'stdio' | 'sse' | 'websocket'
const ADD_TRANSPORT_OPTIONS: Array<{ value: AddTransport; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'sse', label: 'SSE / HTTP' },
  { value: 'websocket', label: 'WebSocket' },
]

/**
 * 磁贴小字：传输 + 启动地址压缩形（如 `stdio · npx @mcp/fs`）。
 * stdio 取 command 末段 + args 首个非 flag 参数；http 取 URL。
 */
function endpointLabel(s: McpServerSummaryWire): string {
  if (s.transport !== 'stdio') return s.endpoint
  const parts = s.endpoint.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'stdio'
  const bin = parts[0].split('/').pop() ?? parts[0]
  const firstArg = parts.slice(1).find(a => !a.startsWith('-'))
  const argShort = firstArg === undefined ? '' : ` ${firstArg.split('/').pop() ?? firstArg}`
  return `${bin}${argShort}`
}

/**
 * 磁贴 tint 档（design.pen bFLLQ 的四档真实色值 token）：
 * 大贴深紫 + glow、宽贴堇色、小贴紫、「添加」给灰蓝。
 */
function tileTintOf(size: MosaicSize): MosaicTint {
  if (size === 'big') return 'deep'
  if (size === 'wide') return 'mauve'
  if (size === 'tall') return 'slate'
  return 'violet'
}

/* ── 主列表视图：Metro 磁贴 + 右侧详情面板 ──────────────────────────── */

function McpListView({ rpc, ownership }: {
  rpc: CorumRpcCall
  ownership: ExtensionOwnership
}) {
  const [servers, setServers] = useState<McpServerSummaryWire[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [probeMap, setProbeMap] = useState<Record<string, ProbeState>>({})
  /** 详情面板选中态（null = 未选中，展示空态）。 */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 详情面板模式：查看选中服务器 / 新建（「添加」磁贴触发）。 */
  const [panelMode, setPanelMode] = useState<'view' | 'create'>('view')

  const reload = async () => {
    try {
      const r = await rpc<{ servers: McpServerSummaryWire[] }>('mcpManager', 'listServers', {})
      setServers(r.servers)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  // 逐服务探测工具数（停用的跳过，与编译语义一致）
  useEffect(() => {
    if (servers === null) return
    let cancelled = false
    for (const s of servers) {
      if (s.disabled === true) continue
      setProbeMap(prev => (prev[s.name] === undefined
        ? { ...prev, [s.name]: { loading: true, toolCount: null, error: null } }
        : prev))
      void (async () => {
        try {
          const r = await rpc<TestConnectionResultWire>('mcpManager', 'testConnection', { name: s.name })
          if (cancelled) return
          setProbeMap(prev => ({
            ...prev,
            [s.name]: r.ok
              ? { loading: false, toolCount: r.tools.length, error: null }
              : { loading: false, toolCount: null, error: r.error },
          }))
        } catch (e) {
          if (cancelled) return
          setProbeMap(prev => ({
            ...prev,
            [s.name]: { loading: false, toolCount: null, error: e instanceof Error ? e.message : String(e) },
          }))
        }
      })()
    }
    return () => { cancelled = true }
  }, [rpc, servers])

  /** 页头 tab 选中态（两个 tab 目前指向同一份服务器列表，见上方页头注释）。 */
  const [tab, setTab] = useState<'market' | 'installed'>('installed')
  /** 详情面板选中项（默认选第一个；列表变化后回落——与插件页同一口径）。
      市场 tab 无服务器磁贴可选（仅「添加」+「建设中」），selected 恒为 undefined。 */
  const selected = useMemo(() => {
    if (tab === 'market') return undefined
    const pool = servers ?? []
    if (pool.length === 0) return undefined
    if (selectedId === null) return pool[0]
    return pool.find(s => s.name === selectedId) ?? pool[0]
  }, [tab, servers, selectedId])

  /**
   * 磁贴序列（0 号恒为「添加」入口贴，`null` 作哨兵）+ 排布块。
   * 排布算法与几何都来自 `@corum/corum-ui-base/client`：固定种子 ⇒ 同一份数据
   * 每次渲染完全一致；`pinFirstTwoSmalls` 把入口贴钉在左上角且为 small。
   *
   * fork（corum）2026-10-06 用户定调：「市场」tab 表示**在线 MCP 市场**（尚未开放），
   * 只显示「添加」+「建设中」两张磁贴，已配置服务器列表只在「已装」tab 显示。
   * 故市场 tab 的服务器序列为空（只剩「添加」哨兵）。
   */
  const tiles = useMemo<Array<McpServerSummaryWire | null>>(
    () => [null, ...(tab === 'market' ? [] : (servers ?? []))],
    [tab, servers],
  )
  /**
   * 排布提示（与 `tiles` 同序）：算法据此把**名字长的**放进 264 宽槽，不再随机
   * 落进 128 窄贴被截断。贴面渲染的名字就是 `s.name`，故按它算长度；入口贴（0 号）
   * 由 `pinFirstTwoSmalls` 单独钉住，提示给 0 不参与抢宽槽。
   */
  const hints = useMemo<MosaicItemHint[]>(
    () => tiles.map(s => s === null
      ? { nameLength: 0 }
      : { nameLength: s.name.length, hasDescription: s.description !== undefined && s.description !== '' }),
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
      {/* 页头单行：市场|已装 pill tab（design.pen bFLLQ 画了这两个 tab；MCP
          目前只有已配置服务器这一份数据，「市场」态尚未接入 ⇒ 两个 tab 都指向
          同一列表，选中态仍按稿呈现，将来接市场时在此分叉）。 */}
      <div className={css.headerRow} role="tablist" aria-label="MCP 分区">
        <button type="button" role="tab" aria-selected={tab === 'installed'} className={`${css.tab}${tab === 'installed' ? ' ' + css.tabActive : ''}`} onClick={() => { setTab('installed') }}>已装</button>
        <span className={css.headerSpacer} />
      </div>

      {/* 全宽分隔线（页头行与磁贴群之间） */}
      <div className={css.divider} />

      <div className={css.body}>
        {/* 左：Metro 磁贴群（节头 + 添加磁贴 + 服务器磁贴） */}
        <div className={css.tiles} ref={tilesRef}>
          <span className={css.sectionHead}>MCP 服务器</span>
          {loadError !== null && <p className={css.hintText}>加载失败：{loadError}</p>}
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
                    aria-label="添加服务器"
                    onClick={() => { setPanelMode('create'); setSelectedId(null) }}
                  >
                    {/* 角标用停止态状态点的视觉形态（不可交互占位，只表达「尚未存在」）。 */}
                    <MosaicTileBody
                      icon={<Plus size={24} />}
                      name="添加"
                      version="MCP"
                      sub="新端点"
                      corner={(
                        <span className={mosaicStyles.tileCorner}>
                          <span className={`${mosaicStyles.tileDot} ${mosaicStyles.tileDotOff}`} aria-hidden="true" />
                        </span>
                      )}
                    />
                  </button>
                )
              }
              const probe = probeMap[s.name]
              const enabled = s.disabled !== true
              const running = enabled && probe !== undefined && !probe.loading && probe.toolCount !== null
              const active = panelMode === 'view' && selected !== undefined && selected.name === s.name
              return (
                <button
                  key={`${s.name}:${index}`}
                  type="button"
                  data-tile-size={size}
                  className={mosaicTileClass({
                    size,
                    tint: tileTintOf(size),
                    active,
                    glow: size === 'big',
                  })}
                  aria-pressed={active}
                  title={probe?.error ?? undefined}
                  onClick={() => { setPanelMode('view'); setSelectedId(s.name) }}
                >
                  <MosaicTileBody
                    icon={<FolderTree size={size === 'big' ? 30 : 24} />}
                    name={s.name}
                    /* 版本徽章位承载传输方式（wire 无版本字段，占位口径）。 */
                    version={TRANSPORT_LABEL[s.transport]}
                    /* 除 small 外都传描述（tall 纵向空间富余）；空串不渲染。 */
                    sub={`${TRANSPORT_LABEL[s.transport]} · ${endpointLabel(s)}`}
                    corner={(
                      <span className={mosaicStyles.tileCorner}>
                        <span className={`${mosaicStyles.tileDot}${running ? '' : ` ${mosaicStyles.tileDotOff}`}`} />
                      </span>
                    )}
                  />
                </button>
              )
            }}
          />
          {/* 市场 tab = 在线 MCP 市场（未开放）：在「添加」磁贴后补一张「建设中」磁贴。
              已装 tab 不渲染它（列表已是完整服务器）。 */}
          {tab === 'market' && (
            <div
              className={mosaicTileClass({ size: 'big', tint: 'violet', glow: true, className: css.wipTile })}
              data-tile-size="big"
              aria-label="MCP 市场建设中"
            >
              <MosaicTileBody
                icon={<Hammer size={30} />}
                name="MCP 市场建设中"
                version="MCP"
                sub="在线 MCP 市场暂未开放。可点左侧「添加」自行注册一个 MCP 服务器。"
              />
            </div>
          )}
          {tab !== 'market' && servers !== null && servers.length === 0 && loadError === null && (
            <p className={css.hintText}>暂无 MCP 服务器。点击「添加」磁贴注册第一个。</p>
          )}
        </div>

        {/* 右：详情面板（查看选中服务器 / 新建模式两态） */}
        <aside className={css.detail} aria-label="服务器详情">
          {panelMode === 'create'
            ? (
              <McpPanelCreate
                rpc={rpc}
                onSaved={(name) => { setPanelMode('view'); setSelectedId(name); void reload() }}
                onCancel={() => { setPanelMode('view'); setSelectedId(null) }}
              />
            )
            : selected === undefined
              ? <DetailEmpty
                  title="选择一个 MCP 服务器"
                  desc="点左侧任意服务器磁贴，在这里查看它的连接状态、工具与绑定；「添加」磁贴在此新建端点。"
                />
              : (
                <McpPanelView
                  rpc={rpc}
                  server={selected}
                  probe={probeMap[selected.name]}
                  ownerName={ownership.ownerOf('mcp', selected.name)}
                  onToggled={() => { void reload() }}
                  onDeleted={() => { setSelectedId(null); void reload() }}
                />
              )}
        </aside>
      </div>
    </div>
  )
}

/* ── 详情面板共用：空态 + 底部操作行（居中）──────────────────────────── */

/** 详情面板空态（未选中任何磁贴）：产品 logo + glow + 引导文案。 */
function DetailEmpty({ title, desc }: { title: string; desc: string }) {
  return (
    <div className={css.detailEmpty}>
      <div className={css.detailEmptyHero}>
        <img className={css.detailEmptyLogo} src="corumapp://app/assets/icon.png" alt="" draggable={false} />
      </div>
      <p className={css.detailEmptyTitle}>{title}</p>
      <p className={css.detailEmptyDesc}>{desc}</p>
    </div>
  )
}

/* ── 详情面板 · 查看模式（MCP 语义信息面板）──────────────────────────── */

function McpPanelView({ rpc, server, probe, ownerName, onToggled, onDeleted }: {
  rpc: CorumRpcCall
  server: McpServerSummaryWire
  probe: ProbeState | undefined
  /** 扩展包归属的包显示名；null = 非扩展包拥有。 */
  ownerName: string | null
  onToggled: () => void
  onDeleted: () => void
}) {
  const [config, setConfig] = useState<McpServerConfigWire | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tools, setTools] = useState<Array<{ name: string; description?: string }>>([])
  const [expanded, setExpanded] = useState(false)
  const [references, setReferences] = useState<string[] | null>(null)
  /** 绑定 Agent 的展示投影（真实头像 + 昵称-岗位），来自 corumAgent/listProfiles。 */
  const [boundAgents, setBoundAgents] = useState<Array<{ id: string; nickname?: string; title?: string; avatar?: string }>>([])

  // 选中服务器变化：拉完整配置（传输/命令/范围）+ 工具清单 + 绑定关系。
  useEffect(() => {
    let cancelled = false
    setConfig(null)
    setError(null)
    void (async () => {
      try {
        const r = await rpc<{ server?: McpServerConfigWire }>('mcpManager', 'getServer', { name: server.name })
        if (!cancelled) setConfig(r.server ?? null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
      try {
        const r = await rpc<TestConnectionResultWire>('mcpManager', 'testConnection', { name: server.name })
        if (!cancelled && r.ok) setTools(r.tools)
      } catch { /* 工具清单失败不阻塞详情 */ }
      try {
        const r = await rpc<{ references: string[] }>('mcpManager', 'getServerReferences', { name: server.name })
        if (!cancelled) setReferences(r.references)
      } catch { /* 引用列表失败不阻塞详情 */ }
      try {
        const r = await rpc<{ profiles: Array<{ id: string; nickname?: string; title?: string; avatar?: string; mcpServers: string[] }> }>('corumAgent', 'listProfiles', {})
        if (!cancelled) setBoundAgents(r.profiles.filter(p => Array.isArray(p.mcpServers) && p.mcpServers.includes(server.name)))
      } catch { /* 头像/昵称拉取失败时退回 id 首字占位 */ }
    })()
    return () => { cancelled = true }
  }, [rpc, server.name])

  const enabled = server.disabled !== true
  const running = enabled && probe !== undefined && !probe.loading && probe.toolCount !== null
  const startCommand = config === null
    ? ''
    : config.transport === 'stdio'
      ? [config.command, ...(config.args ?? [])].join(' ')
      : config.url ?? ''
  const statusText = !enabled
    ? '已停止'
    : probe === undefined || probe.loading
      ? '检测中…'
      : probe.toolCount !== null
        ? `运行中 · ${probe.toolCount} 个工具`
        : `未连接 · ${probe?.error ?? '探测失败'}`

  /** 启停开关（面板内一行）：saveServer disabled 翻转，RPC 不变。 */
  const toggleDisabled = async () => {
    if (busy || config === null) return
    setBusy(true)
    setError(null)
    try {
      const next = { ...config, disabled: config.disabled === true ? false : true }
      await rpc('mcpManager', 'saveServer', { input: next })
      setConfig(next)
      onToggled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    try {
      await rpc('mcpManager', 'deleteServer', { name: server.name })
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const visibleTools = expanded ? tools : tools.slice(0, 4)
  const hiddenCount = tools.length - visibleTools.length

  return (
    <>
      <div className={css.detailHero}>
        <span className={css.detailHeroBadge}><FolderTree size={30} /></span>
      </div>
      <div className={css.detailBody}>
        <div>
          <div className={css.detailTitleRow}>
            <span className={css.detailName}>{server.name}</span>
            {/* 标题旁的传输指示徽章：传输方式是 wire 上的真值（不是版本占位）。 */}
            <span className={css.detailVersion}>{TRANSPORT_LABEL[server.transport]}</span>
          </div>
          <p className={css.detailDesc}>{server.description ?? '该服务器未提供描述。'}</p>

          {/* 统一字段六项：名称 → id → 日志（与插件页同构的信息架构）。
              MCP 的「版本」「发布日期」wire 上没有真值（mcpManager 只回 name /
              transport / endpoint / description），故这两行**不显示**而不是拿
              传输方式或破折号充数——假值比缺行更容易被误读成真实元信息。
              日志同样是展示用占位（见 MCP_FAKE_CHANGELOG）。 */}
          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>名称</span>
              <span className={css.detailMetaValue}>{server.name}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>id</span>
              <span className={`${css.detailMetaValue} ${css.detailMetaMono}`}>{server.name}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>作者</span>
              <span className={css.detailMetaValue}>modelcontextprotocol · {TRANSPORT_LABEL[server.transport]}</span>
            </div>
            {/* 来源（P5d）：扩展包拥有的 MCP 标「扩展包 · <pack>」，其余保留既有口径「用户导入」。 */}
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

          {/* 以下为 MCP 已有的真值字段，保持在六项之后。 */}
          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>传输</span>
              <span className={css.detailMetaValue}>{TRANSPORT_LABEL[server.transport]}{startCommand !== '' ? ` · ${startCommand}` : ''}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>状态</span>
              <span className={css.detailMetaValue}>{statusText}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>范围</span>
              <span className={css.detailMetaValue}>{config?.cwd !== undefined && config.cwd !== '' ? config.cwd : '全局'}</span>
            </div>
          </div>

          {/* 工具清单概览（前 4 个 + 展开全部） */}
          {tools.length > 0 && (
            <div className={css.detailSwitchRow}>
              <span className={css.detailSwitchLabel}>工具 {tools.length} 个</span>
              {hiddenCount > 0 && !expanded && (
                <button type="button" className={css.sharedPlainBtn} onClick={() => setExpanded(true)}>
                  <ChevronDown size={13} />展开全部
                </button>
              )}
              {expanded && (
                <button type="button" className={css.sharedPlainBtn} onClick={() => setExpanded(false)}>
                  <ChevronUp size={13} />收起
                </button>
              )}
            </div>
          )}
          {visibleTools.map(tool => (
            <div key={tool.name} className={css.detailMetaRow} title={tool.description ?? ''}>
              <span className={css.detailMetaKey}>{running ? '可用' : '工具'}</span>
              <span className={css.detailMetaValue}>{tool.name}</span>
            </div>
          ))}

          {/* Agent 绑定概览 */}
          {references !== null && (
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>绑定</span>
              <span className={css.detailMetaValue}>
                {boundAgents.length > 0
                  ? boundAgents.map(a => `${a.nickname ?? a.id}${a.title !== undefined && a.title !== '' ? '-' + a.title : ''}`).join('、')
                  : `已绑定 ${references.length} 个 Agent 预设`}
              </span>
            </div>
          )}
        </div>

        <div>
          {error !== null && <p className={css.hintText}>{error}</p>}
          {/* 底部操作行：居中（删除服务器 error 描边 + 启停开关，走 saveServer 翻转 disabled）。
              pack-owned MCP 禁用删除（只能整包卸载），停用开关保持可用。 */}
          <div className={css.detailActions}>
            <button
              type="button"
              className={`${css.actionBtn} ${css.actionDanger}`}
              disabled={ownerName !== null}
              title={ownerName !== null ? packOwnedTitle(ownerName) : undefined}
              onClick={() => { setConfirmDelete(true) }}
            >
              <Trash2 size={13} />删除服务器
            </button>
            <span className={css.detailSwitchLabel}>启用此服务器</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={`${server.name} 启用开关`}
              className={mosaicStyles.tileSwitch}
              data-off={enabled ? undefined : ''}
              disabled={busy || config === null}
              onClick={e => { e.stopPropagation(); void toggleDisabled() }}
            >
              <span className={mosaicStyles.tileSwitchKnob} />
            </button>
          </div>
        </div>
      </div>

      {confirmDelete && createPortal(
        <div className={shared.modalOverlay} onClick={() => setConfirmDelete(false)}>
          <div className={shared.modalDialog} onClick={e => e.stopPropagation()}>
            <div className={shared.modalHeader}>
              <span className={shared.modalTitle}>删除服务器「{server.name}」？</span>
              <button type="button" className={shared.modalClose} onClick={() => setConfirmDelete(false)}><Info size={16} /></button>
            </div>
            <div className={shared.modalBody}>
              <p className={css.hintText}>
                该服务器当前状态：{statusText}。删除后相关工具立即失效，正在执行的任务可能中断；绑定它的 Agent 预设将失去其工具。
              </p>
              <p className={css.hintText}>若需保留配置，建议改为停用而非删除。此操作不可撤销。</p>
            </div>
            <div className={shared.modalFooter}>
              <div className={shared.footerLeft} />
              <div className={shared.footerRight}>
                <button type="button" className={shared.btnDefault} onClick={() => setConfirmDelete(false)}>取消</button>
                <button type="button" className={`${css.actionBtn} ${css.actionDanger}`} onClick={() => { setConfirmDelete(false); void doDelete() }}>
                  <Trash2 size={13} />删除服务器
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/* ── 详情面板 · 新建模式（原 McpAddView 表单就地搬进面板，RPC 与校验不变）── */

function McpPanelCreate({ rpc, onSaved, onCancel }: {
  rpc: CorumRpcCall
  onSaved: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<AddTransport>('stdio')
  const [configJson, setConfigJson] = useState('')
  const [startTimeout, setStartTimeout] = useState('60000')
  const [runTimeout, setRunTimeout] = useState('60000')
  const [busy, setBusy] = useState(false)
  // 使用指导（写给模型）：何时用 / 怎么组合 / 坑。
  const [guidance, setGuidance] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (busy) return
    setError(null)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      setError('服务名仅限 1-32 位字母/数字/下划线/连字符')
      return
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(configJson) as Record<string, unknown>
    } catch (e) {
      setError(`配置 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const timeout = Number(runTimeout)
    if (!Number.isFinite(timeout) || timeout <= 0) { setError('运行超时必须是正数（ms）'); return }
    const input: McpServerConfigWire = transport === 'stdio'
      ? {
          name,
          transport: 'stdio',
          command: String(parsed.command ?? ''),
          ...(Array.isArray(parsed.args) ? { args: parsed.args.map(String) } : {}),
          ...(parsed.env !== undefined && typeof parsed.env === 'object' && parsed.env !== null
            ? { env: parsed.env as Record<string, string> } : {}),
          ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
          toolCallTimeoutMs: timeout,
          ...(guidance.trim() !== '' ? { guidance: guidance.trim() } : {}),
        }
      : {
          name,
          transport: 'streamable-http',
          url: String(parsed.url ?? ''),
          ...(parsed.headers !== undefined && typeof parsed.headers === 'object' && parsed.headers !== null
            ? { headers: parsed.headers as Record<string, string> } : {}),
          toolCallTimeoutMs: timeout,
          ...(guidance.trim() !== '' ? { guidance: guidance.trim() } : {}),
        }
    if (transport === 'stdio' && input.command === '') { setError('stdio 配置缺少 command 字段'); return }
    if (transport !== 'stdio' && !input.url) { setError('SSE/WebSocket 配置缺少 url 字段'); return }
    setBusy(true)
    try {
      await rpc('mcpManager', 'saveServer', { input })
      onSaved(name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* 面板头：添加模式标题（对应 hero 位）。 */}
      <div className={css.detailHero}>
        <span className={css.detailHeroBadge}><Plus size={30} /></span>
      </div>
      <div className={css.detailBody}>
        <div className={css.detailFormStack}>
          <span className={css.detailFormTitle}>添加 MCP 服务</span>

          <span className={css.detailFormLbl}>服务器名称</span>
          <input
            className={css.detailFormInput}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="my-mcp-server"
          />

          <span className={css.detailFormLbl}>传输方式</span>
          <div className={css.detailFormTabs} role="tablist" aria-label="传输方式">
            {ADD_TRANSPORT_OPTIONS.map(t => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={t.value === transport}
                className={t.value === transport ? css.detailFormTabActive : css.detailFormTab}
                onClick={() => setTransport(t.value)}
              >{t.label}</button>
            ))}
          </div>

          <span className={css.detailFormLbl}>启动配置 (JSON)</span>
          <textarea
            className={css.detailFormJson}
            value={configJson}
            onChange={e => setConfigJson(e.target.value)}
            placeholder={MCP_JSON_PLACEHOLDERS[transport]}
          />
          <span className={css.detailFormHint}>stdio 使用命令行启动，SSE/WebSocket 填写 URL。</span>

          <div className={css.detailFormCols}>
            <div className={css.detailFormCol}>
              <span className={css.detailFormLbl}>启动超时 (ms)</span>
              <input className={css.detailFormInput} value={startTimeout} onChange={e => setStartTimeout(e.target.value)} />
            </div>
            <div className={css.detailFormCol}>
              <span className={css.detailFormLbl}>运行超时 (ms)</span>
              <input className={css.detailFormInput} value={runTimeout} onChange={e => setRunTimeout(e.target.value)} />
            </div>
          </div>
          <span className={css.detailFormHint}>超时后该服务器将被标记为未连接，并自动尝试重连。</span>

          <span className={css.detailFormLbl}>使用指导（写给模型）</span>
          <textarea
            className={css.detailFormJson}
            value={guidance}
            onChange={e => setGuidance(e.target.value)}
            placeholder={'一句话用途；典型调用顺序；坑。例如：\n先 get_app_state 看当前打开的文件，再 batch_design；同一 .pen 文件不要并发改。'}
          />
          <span className={css.detailFormHint}>
            这段会进提示词，仅对授权了该服务的 Agent 生效（保存后即时生效，不必重启）。留空则不注入。
          </span>

          {error !== null && <p className={css.hintText}>{error}</p>}
        </div>

        {/* 底部操作行：居中（取消 + 提交主按钮）。 */}
        <div className={css.detailActions}>
          <button type="button" className={css.actionBtn} onClick={onCancel}>取消</button>
          <button
            type="button"
            className={css.actionPrimary}
            disabled={busy}
            onClick={() => { void submit() }}
          >
            <Plus size={14} />{busy ? '添加中…' : '添加服务器'}
          </button>
        </div>
      </div>
    </>
  )
}

/* ── Section 入口 ─────────────────────────────────────────────────── */

export function McpPage() {
  const rpc = useIntegrationsRpc()
  const ownership = useExtensionOwnership(rpc)
  if (rpc === null) return <p className={css.hintText}>RPC 服务未就绪。</p>
  return <McpListView rpc={rpc} ownership={ownership} />
}
