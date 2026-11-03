/**
 * cdp-router 的 client 半 —— 「设置 › 扩展 › CDP 目标」面板。
 *
 * ## 这个面板回答什么
 *
 * 两个不同的问题，页面上也分成两块，**不要混成一张表**：
 *
 *  1. **现场有什么？**（扫描结果）—— 本机正在跑、且开了 CDP 调试端口的 Corum 实例。
 *     由插件**启动时自动扫一次**（`startAutoScan`），页面首屏只展示那次缓存结果；
 *     用户可点「重新扫描」显式刷新。
 *  2. **配置里有什么？**（已采纳目标）—— 写进 `cdp-targets.json`、由 Agent 工具按 id
 *     寻址的那些。它们可能指向**此刻并不存在**的实例（实例关了 / 端口变了）。
 *
 * ## 为什么状态必须来自探活，而不是「配置合法」
 *
 * 旧实现只有一根轴：`disabledReason()`（护栏：9222 需 allowMain）。于是一条指向早已
 * 关闭端口的配置照样显示「可用」——**状态是谎报**，比不显示更糟（用户实测踩到：三条
 * 配置全不通，界面全绿）。现在 `disabled`（策略）与 `reachable`（现场）分开显示。
 *
 * ## 视觉：照「设置 › 扩展 › 联网搜索」页复刻
 *
 * 设计稿里**没有**独立画 CDP 目标页（只有左侧导航项 `item-cdp-targets`），故按同一
 * 扩展组已定稿的「联网搜索」页（`设置中心.pen` 节点 `u9P4u`）的组件语言复刻：
 * intro（13/600 标题 + 11 说明）→ 若干分组卡片（`$glass-1` / r16 / pad 6,16,10,16）→
 * 组内 row（`$label-primary` 13/600 + `$label-tertiary` 11 说明 + 右侧控件）。
 *
 * 全部内联 style + 壳 token，**零字面 hex、零 CSS Module**（同 corum-web-search 的
 * 做法，红线 §3.5：插件不得静态 value-import 壳 client bundle 的组件）。
 *
 * @module @corum/corum-cdp-router/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { defineSettingsSection, registerSettingsSection } from '@corum/plugin-ui-contract'

/** 已配置的 target（与服务侧 `ProbedTarget` 同形）。 */
interface TargetRow {
  readonly id: string
  readonly ip: string
  readonly port: number
  readonly readOnly?: boolean
  readonly allowMain?: boolean
  readonly description?: string
  /** 非 null = 被护栏禁用（如 9222 没给 allowMain）。 */
  readonly disabled: string | null
  /** 此刻端点是否应答（`disabled` 非 null 时恒 false，不探）。 */
  readonly reachable: boolean
  /** 探活失败原因；`'未探测（probe: false）'` 表示根本没探，不是「不通」。 */
  readonly probeError: string | null
}

/** 自动发现到的实例（与服务侧 `DiscoveredTarget` 同形）。 */
interface DiscoveredRow {
  readonly id: string
  readonly port: number
  readonly role: string
  /** 端点类型（`corum` / `chrome` / `electron` / `unknown`）—— 决定显示哪一类身份信息。 */
  readonly endpointKind?: string
  readonly appName?: string | null
  /** corum 特有：基座版本。非 corum 端点恒为 null，**不要渲染**。 */
  readonly releaseVersion: string | null
  readonly releaseCommit: string | null
  readonly electronVersion: string | null
  /** 浏览器版本（如 `156.0.8078.80`）。 */
  readonly browserVersion?: string | null
  readonly headless?: boolean
  readonly source: string
}

interface TargetsPayload {
  readonly configPath: string
  readonly generation: number
  readonly targets: readonly TargetRow[]
  readonly lastError: string | null
}

interface ScanPayload {
  readonly targets: readonly DiscoveredRow[]
  readonly problems: readonly string[]
  readonly scannedAt?: string | null
  readonly scanning?: boolean
}

/**
 * 自动扫描设置视图（与服务侧 `ScanSettingsView` 同形）。
 *
 * `scanIntervalMs` 是**配置值**，`activeIntervalMs` 是**定时器真正在用的值** ——
 * 两者不一致就说明「设置存了但没生效」，页面据此提示，而不是假装一致。
 */
interface ScanSettingsView {
  readonly autoDiscover: boolean
  readonly scanIntervalMs: number
  readonly activeIntervalMs: number | null
  readonly timerActive: boolean
  readonly minIntervalMs: number
  readonly maxIntervalMs: number
  readonly defaultIntervalMs: number
  readonly lastScanAt: string | null
}

/** 调 host RPC 的最小接口（`connection.rpc.call` 的形状）。 */
interface RpcCaller {
  (service: string, method: string, args?: Record<string, unknown>): Promise<unknown>
}

/** 面板注入面。 */
interface Injected {
  readonly rpc: RpcCaller
}

// ── 设计稿取值的样式常量（数值全部来自 设置中心.pen 节点 u9P4u 及其子节点） ──

/** 分组卡片：设计稿 `group-*` = fill $glass-1 / r16 / pad [6,16,10,16] / vertical。 */
const GROUP: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '10px 16px 10px 16px',
  borderRadius: 16,
  background: 'var(--corum-glass-1)',
}

/** 组标题：设计稿 `gt` = 12/600 / $label-secondary。 */
const GROUP_TITLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary)',
}

/** 行：设计稿 `row-*` = gap 12 / pad [10,2]。 */
const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '10px 2px',
}

/** 行的左侧（label + desc）：设计稿 `meta` = vertical / gap 2 / fill_container。 */
const META: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  flex: 1,
  minWidth: 0,
}

/** 行标题：13/600 / $label-primary。 */
const LABEL: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

/** 行说明：11 / normal / $label-tertiary。 */
const DESC: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 'normal',
  color: 'var(--dsw-alias-label-tertiary)',
}

/** 分隔线：设计稿 `d*` = h1 / $glass-border。 */
const DIVIDER: React.CSSProperties = {
  height: 1,
  background: 'var(--corum-glass-border)',
  margin: '0 2px',
}

/** 按钮：设计稿 `btn-*` = $glass-3 / r8 / pad [7,12] / 12-600 label。 */
const BUTTON: React.CSSProperties = {
  padding: '7px 12px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--corum-glass-3)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/** 数值/端点一律等宽（设计稿里 id、端口、版本号都是 mono 语感）。 */
const MONO: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
}

/** 数字输入（复用行内 input 的取值规格：r8 / $glass-2 / pad 7,10 / 12）。 */
const INPUT: React.CSSProperties = {
  width: 72,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--corum-glass-border)',
  background: 'var(--corum-glass-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  outline: 'none',
}

/**
 * 开关控件 —— 1:1 复刻设计稿 `switch-off`（CDs9f）与 on 态。
 *
 * 尺寸/配色全按设计稿：36×20 / radius 10 / off `$glass-3` + `$glass-border` stroke、
 * knob 16×16 `$label-secondary` 居左；on `$brand-primary`、knob 移右。
 * 用内联样式而非 CSS Module：本插件不引任何 CSS Module（红线 §3.5）。
 *
 * @param props.checked - 当前状态
 * @param props.onChange - 切换回调
 * @param props.disabled - 是否禁用（请求进行中）
 * @param props.label - 无障碍标签
 */
function Switch({ checked, onChange, disabled, label }: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  const knob: React.CSSProperties = {
    position: 'absolute',
    top: 1,
    left: checked ? 18 : 2,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: checked ? 'var(--corum-label-on-brand)' : 'var(--dsw-alias-label-secondary)',
    transition: 'left 0.2s ease, background 0.2s ease',
  }
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => { if (disabled !== true) onChange(!checked) }}
      style={{
        position: 'relative',
        flex: 'none',
        width: 36,
        height: 20,
        padding: 0,
        border: `1px solid ${checked ? 'transparent' : 'var(--corum-glass-border)'}`,
        borderRadius: 10,
        background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--corum-glass-3)',
        cursor: disabled === true ? 'not-allowed' : 'pointer',
        opacity: disabled === true ? 0.5 : 1,
        overflow: 'hidden',
        transition: 'background 0.2s ease',
      }}
    >
      <span style={knob} />
    </button>
  )
}

/**
 * 一条实例/目标的条目卡：设计稿 `provider-card` = $glass-2 / r10 / pad [8,10] / gap 10。
 *
 * @param props.name - 主标题（id 或实例名）
 * @param props.meta - 副行（端点 · 版本 · 来源）
 * @param props.state - 右侧状态文本
 * @param props.stateColor - 状态颜色 token
 * @param props.action - 右侧可选按钮
 */
function Card({ name, meta, state, stateColor, action }: {
  name: string
  meta: string
  state: string
  stateColor: string
  action?: ReactNode
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 10px',
      borderRadius: 10,
      background: 'var(--corum-glass-2)',
      border: '1px solid var(--corum-glass-border)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{name}</span>
        <span style={{ ...MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</span>
      </div>
      <span style={{ fontSize: 11, color: stateColor, whiteSpace: 'nowrap' }}>{state}</span>
      {action}
    </div>
  )
}

/**
 * 把一个扫描到的端点描述成「标题 / 副行 / 徽标」，**按端点类型分档**。
 *
 * 这一层存在的理由：`releaseVersion`（基座版本）是 **corum 特有**的，只有在目标实例
 * 页面的 `__DSH_BOOT__.release` 里才有。对用户手起的 `chrome --remote-debugging-port`
 * 渲染「基座版本未知」是错的 —— 它根本没有基座，谈不上「未知」。所以身份信息必须
 * 按 `endpointKind` 分流，而不是把 corum 的字段对所有端点套一遍。
 *
 * @param t - 扫描结果里的一条
 * @returns 标题、副行、徽标文案
 */
function describeEndpoint(t: DiscoveredRow): { title: string; meta: string; badge: string } {
  const port = `127.0.0.1:${t.port}`
  const kind = t.endpointKind ?? 'unknown'

  if (kind === 'corum') {
    // corum：基座版本是主信息（跨版本对照的前提），来源与有没有窗口也一并给出。
    const version = t.releaseVersion === null ? '基座版本未知' : `基座 ${t.releaseVersion}`
    const commit = t.releaseCommit === null ? '' : `@${t.releaseCommit}`
    return {
      title: 'Corum',
      meta: `${port} · ${version}${commit} · ${t.source}`,
      badge: t.role === 'main' ? '主实例' : t.role === 'verify' ? '验证实例' : '实例',
    }
  }

  if (kind === 'chrome' || kind === 'electron') {
    // 浏览器/Electron：显示应用名 + 它自己的版本，**不出现基座版本**。
    const name = kind === 'electron' ? (t.appName ?? 'Electron 应用') : (t.appName ?? 'Chrome')
    const version = kind === 'electron' ? t.electronVersion : t.browserVersion
    const bits = [port, version === null || version === undefined ? null : `v${version}`]
      .filter((x): x is string => x !== null)
    return {
      title: t.headless === true ? `${name}（无头）` : name,
      meta: [...bits, t.source].join(' · '),
      badge: kind === 'chrome' ? '浏览器' : 'Electron',
    }
  }

  // unknown：只要能连上就是合法 CDP 端点，但别假装知道它是什么。
  return {
    title: 'CDP 端点',
    meta: `${port} · ${t.source}`,
    badge: '未识别',
  }
}

/** 状态色：把 (disabled, reachable) 两条轴收敛成一个给人看的结论 + 颜色。 */
function statusOf(t: TargetRow): { text: string; color: string } {
  const offline = 'var(--dsw-alias-state-error-primary)'
  const warn = 'var(--dsw-alias-state-warn-primary)'
  const ok = 'var(--dsw-alias-state-success-primary)'
  if (t.disabled !== null) return { text: '被护栏禁用', color: warn }
  if (t.probeError === '未探测（probe: false）') return { text: '未探测', color: 'var(--dsw-alias-label-tertiary)' }
  if (t.reachable) return { text: t.readOnly === true ? '在线 · 只读' : '在线', color: ok }
  return { text: '离线（端口无应答）', color: offline }
}

/**
 * 「CDP 目标」设置面板。
 *
 * 只读展示 + 「重新扫描」一个写动作：增删改交给 Agent 工具（`cdp_adopt_discovered`
 * 等）或手改 `cdp-targets.json`，全仓只有**一份**校验逻辑（`targets.ts`），不会因为
 * UI 各写一套而漂移。
 *
 * @param props.rpc - host RPC 调用器
 */
function CdpTargetsPanel({ rpc }: Injected): JSX.Element {
  const [listed, setListed] = useState<TargetsPayload | null>(null)
  const [scan, setScan] = useState<ScanPayload | null>(null)
  const [settings, setSettings] = useState<ScanSettingsView | null>(null)
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * 载入首屏：配置（**带探活**，这样「离线」才是真结论）+ 上次自动扫描的缓存
   * + 自动扫描设置。
   *
   * 用 `lastScan` 而不是 `discoverTargets`：插件启动时已按配置扫过，
   * 首屏直接读那次结果即可 —— 开设置页这个动作不该再打一轮端口。
   */
  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const [l, s, st] = await Promise.all([
        // 传 `{}`（= 无参）：网关对**空参**是放行的，只有「带了字段却不叫 input」才被拒。
        // 这三条 RPC 都不需要参数（探活与否是缺省行为），所以不做 `input` 包装。
        rpc('cdpRouter', 'listTargets', {}) as Promise<TargetsPayload>,
        rpc('cdpRouter', 'lastScan', {}) as Promise<ScanPayload>,
        rpc('cdpRouter', 'scanSettings', {}) as Promise<ScanSettingsView>,
      ])
      setListed(l)
      setScan(s)
      setSettings(st)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [rpc])

  /** 用户显式点「重新扫描」：走 `rescan`（真扫 + 更新缓存），再重读一遍配置探活。 */
  const rescan = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const s = await rpc('cdpRouter', 'rescan', {}) as ScanPayload
      setScan(s)
      // 扫描后重读配置与设置：实例可能刚起来，上一轮的「离线」结论需要更新；
      // 设置里的 lastScanAt 也跟着变了。
      const [l, st] = await Promise.all([
        rpc('cdpRouter', 'listTargets', {}) as Promise<TargetsPayload>,
        rpc('cdpRouter', 'scanSettings', {}) as Promise<ScanSettingsView>,
      ])
      setListed(l)
      setSettings(st)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [rpc])

  /**
   * 保存自动扫描设置（开关或间隔）。host 写盘后会**立刻重挂定时器**，
   * 所以返回的视图里 `activeIntervalMs` 应该马上跟着变。
   *
   * @param patch - 只改给的字段
   */
  const saveSettings = useCallback(async (patch: { autoDiscover?: boolean; scanIntervalMs?: number }) => {
    setBusy(true)
    setError(null)
    try {
      const st = await rpc('cdpRouter', 'setScanSettings', {
        // typert 网关按**形参名**取字段：本方法只有一个形参 `input`，带字段时必须套一层。
        input: patch,
      }) as ScanSettingsView
      setSettings(st)
      setIntervalDraft(null)
      // 开关刚被打开 ⇒ host 顺手扫了一次，把结果拉回来。
      setScan(await rpc('cdpRouter', 'lastScan', {}) as ScanPayload)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [rpc])

  useEffect(() => { void load() }, [load])

  const scannedLabel = scan?.scannedAt != null
    ? `上次扫描 ${new Date(scan.scannedAt).toLocaleTimeString()}`
    : '尚未扫描'
  const onlineCount = listed?.targets.filter(t => t.disabled === null && t.reachable).length ?? 0
  /** 秒是最贴近用户心智的单位；配置里存毫秒（host 契约不变）。 */
  const intervalSeconds = settings === null ? null : Math.round(settings.scanIntervalMs / 1000)
  const intervalValue = intervalDraft ?? (intervalSeconds === null ? '' : String(intervalSeconds))
  const autoOn = settings?.autoDiscover === true

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── intro：设计稿 intro = 13/600 标题 + 11 说明 ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={LABEL}>CDP 目标</span>
        <span style={{ ...DESC, lineHeight: 1.6 }}>
          决定 Agent 能连哪几个 Corum 实例做真机验证。测的永远是别的实例，不是自己 ——
          自测证明不了「同一功能在另一个基座版本上是否还成立」。
        </span>
      </div>

      {/* ── ① 扫描结果（现场有什么） ── */}
      <div style={GROUP}>
        <span style={GROUP_TITLE}>扫描到的实例</span>

        {/* 自动扫描：开关 + 间隔。关掉即不挂定时器（保存后立刻生效）。 */}
        <div style={ROW}>
          <div style={META}>
            <span style={LABEL}>自动扫描</span>
            <span style={DESC}>
              开启后按下面的间隔自动刷新本机实例列表；关掉则只在点「重新扫描」时扫。
            </span>
          </div>
          <Switch
            checked={autoOn}
            disabled={busy || settings === null}
            label="自动扫描"
            onChange={(next) => { void saveSettings({ autoDiscover: next }) }}
          />
        </div>

        <div style={DIVIDER} />

        {/* 间隔：只在开启时可编辑（关掉时它不生效，编辑它没有意义）。 */}
        <div style={ROW}>
          <div style={META}>
            <span style={LABEL}>扫描间隔</span>
            <span style={DESC}>
              {settings === null
                ? '读取中…'
                : `秒。允许 ${settings.minIntervalMs / 1000}~${settings.maxIntervalMs / 1000} 秒，默认 ${settings.defaultIntervalMs / 1000} 秒。`}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              style={{ ...INPUT, opacity: autoOn ? 1 : 0.5 }}
              inputMode="numeric"
              aria-label="扫描间隔（秒）"
              placeholder={settings === null ? '' : String(settings.defaultIntervalMs / 1000)}
              value={intervalValue}
              disabled={!autoOn || busy || settings === null}
              onChange={e => setIntervalDraft(e.target.value)}
            />
            <button
              type="button"
              style={{ ...BUTTON, opacity: (!autoOn || busy || intervalDraft === null) ? 0.5 : 1 }}
              disabled={!autoOn || busy || intervalDraft === null}
              onClick={() => {
                const secs = Number(intervalValue)
                if (!Number.isInteger(secs) || secs <= 0) {
                  setError('扫描间隔必须是正整数秒')
                  return
                }
                void saveSettings({ scanIntervalMs: secs * 1000 })
              }}
            >
              保存
            </button>
          </div>
        </div>

        <div style={DIVIDER} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 2px' }}>
          <button
            type="button"
            style={{ ...BUTTON, opacity: busy ? 0.5 : 1 }}
            disabled={busy}
            onClick={() => void rescan()}
          >
            {busy ? '扫描中…' : '重新扫描'}
          </button>
          <span style={DESC}>
            {scannedLabel}
            {autoOn ? `（自动：每 ${intervalSeconds} 秒）` : '（自动扫描已关闭，仅手动）'}
          </span>
        </div>
        <div style={DIVIDER} />
        {scan === null || scan.targets.length === 0
          ? (
            <div style={{ padding: '10px 2px' }}>
              <span style={DESC}>
                本机没有发现可连接的实例。实例需要开启 CDP 调试端口才会被发现
                （验证实例：<span style={{ ...MONO, fontSize: 11 }}>corum-instance.sh start --home=verify</span>）。
              </span>
            </div>
          )
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 2px 10px' }}>
              {scan.targets.map(t => {
                const ident = describeEndpoint(t)
                return (
                  <Card
                    key={`${t.id}-${t.port}`}
                    name={`${ident.title} · 127.0.0.1:${t.port}`}
                    meta={ident.meta}
                    state={ident.badge}
                    stateColor="var(--dsw-alias-brand-primary)"
                  />
                )
              })}
            </div>
          )}
      </div>

      {/* ── ② 已采纳目标（配置里有什么） ── */}
      <div style={GROUP}>
        <span style={GROUP_TITLE}>已采纳的目标</span>
        <div style={{ ...ROW, padding: '8px 2px' }}>
          <div style={META}>
            <span style={DESC}>
              写进配置、由 Agent 按 id 寻址的目标；状态为实时探活结果。
              {listed !== null ? `在线 ${onlineCount} / 共 ${listed.targets.length}。` : null}
            </span>
          </div>
        </div>
        <div style={DIVIDER} />
        {listed === null
          ? <div style={{ padding: '10px 2px' }}><span style={DESC}>读取中…</span></div>
          : listed.targets.length === 0
            ? (
              <div style={{ padding: '10px 2px' }}>
                <span style={DESC}>
                  还没有采纳任何目标。在上面的扫描结果里用 Agent 工具
                  <span style={{ ...MONO, fontSize: 11 }}> cdp_adopt_discovered </span>
                  采纳，或手动编辑配置文件。
                </span>
              </div>
            )
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 2px 10px' }}>
                {listed.targets.map(t => {
                  const s = statusOf(t)
                  return (
                    <Card
                      key={t.id}
                      name={`${t.id} · ${t.ip}:${t.port}`}
                      meta={t.disabled !== null
                        ? t.disabled
                        : t.description ?? (t.reachable ? '已应答 /json/version' : t.probeError ?? '无应答')}
                      state={s.text}
                      stateColor={s.color}
                    />
                  )
                })}
              </div>
            )}
        {listed?.lastError != null
          ? (
            <div style={{ padding: '8px 2px' }}>
              <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' }}>
                配置问题：{listed.lastError}
              </span>
            </div>
          )
          : null}
      </div>

      {/* ── ③ 位置指引（照设计稿「去哪改 / 去哪配」） ── */}
      <div style={GROUP}>
        <span style={GROUP_TITLE}>配置文件与诊断</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 2px' }}>
          <span style={{ ...DESC, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
            配置文件：<span style={{ ...MONO, fontSize: 11 }}>{listed?.configPath ?? '…'}</span>
            （改完即时生效，不需要重启）
          </span>
          <span style={{ ...DESC, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
            增删改不在此页操作：Agent 工具 <span style={{ ...MONO, fontSize: 11 }}>cdp_adopt_discovered</span>
            {' '}/ <span style={{ ...MONO, fontSize: 11 }}>cdp_upsert_target</span>
            {' '}/ <span style={{ ...MONO, fontSize: 11 }}>cdp_remove_target</span>
            与你手改配置走的是同一份校验逻辑。
          </span>
          {scan !== null && scan.problems.length > 0
            ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
                  诊断（{scan.problems.length}）
                </span>
                {scan.problems.map((p, i) => (
                  <span key={i} style={{ ...DESC, lineHeight: 1.6 }}>· {p}</span>
                ))}
              </div>
            )
            : null}
        </div>
      </div>

      {error !== null
        ? <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</span>
        : null}
    </div>
  )
}

/** 面板声明（落进设置 ›「扩展」分组）。 */
const section = defineSettingsSection<Injected>({
  id: 'corum-cdp-router.targets',
  label: () => 'CDP 目标',
  // 走「扩展」分组，与其它插件设置同列
  order: 600,
  Component: CdpTargetsPanel,
})

/** 官方 `connection` 服务的最小能力面（只用到 `rpc.call`，红线 3：不耦合实现包类型）。 */
interface RpcConnection {
  readonly rpc: {
    call(
      channel: string,
      endpoint: string,
      payload: { args: Record<string, unknown> },
    ): Promise<
      | { readonly ok: true; readonly value: unknown }
      | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
    >
  }
}

/**
 * 由 `connection` 造一个命名空间化 RPC 调用器。
 *
 * 不 import `@corum/plugin-sdk/client`（它 re-export 的 `makeCorumRpcCall` 会把
 * `@corum/corum-ui-base` 的样式链拉进 client bundle，见文件头注释），这里就地写
 * 三行等价实现：`connection.rpc.call('/api', '<service>/<method>', { args })`。
 *
 * @param connection - client `connection` 服务
 * @returns `rpc(service, method, args)`
 */
function makeRpc(connection: RpcConnection): RpcCaller {
  return async (service, method, args = {}) => {
    const result = await connection.rpc.call('/api', `${service}/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
}

/**
 * client 半的 inject 声明（**cordis 服务名**；与 `package.json` 的
 * `dsh.client.inject` 是两件事，那边写的是包名边）。
 *
 * ⚠️ 本模块**不能有 `export default`**：cordis 的 `Loader.unwrapExports` 对 ESM
 * 只取 `exports.default ?? exports`，一旦有 default 导出，插件对象就变成那个裸函数，
 * 命名空间上的 `inject` 被**整个丢掉** ⇒ fiber 的 inject 集合为空 ⇒ `ctx.slots`
 * 抛 `cannot get property "slots" without inject` ⇒ 该 entry apply 失败 ⇒
 * web boot 的 `assertEntriesActive` 抛错 ⇒ 整页「Failed to load plugins」，
 * `[data-session-band]` 永不出现（表现为「主界面加载超时」）。
 * 实测证据（2026-10-30，安装态 /Applications/Corum.app + CDP）：
 * `failed to apply loader entry (@corum/corum-cdp-router): cannot get property "slots" without inject`。
 */
export const inject = ['slots', 'connection']

/**
 * client 半入口：注册设置面板。
 *
 * 用 `ctx.inject([...], cb)` 等 `slots` / `connection` 就绪后再注册（红线 4：不直接
 * 摸未装配的服务）；面板要的 `rpc` 由本节声明的 `inject` 注入面下发，而不是从
 * `renderSlot` 的 owner props 里取（壳只下发 `{ close }`）。
 *
 * @param ctx - client 上下文
 */
export function apply(ctx: unknown): void {
  const face = ctx as {
    inject(names: string[], callback: (scoped: unknown) => void): void
  }
  face.inject(['slots', 'connection'], (scoped) => {
    const ready = scoped as {
      slots: unknown
      connection?: RpcConnection
    }
    if (ready.connection === undefined) return
    const rpc = makeRpc(ready.connection)
    const dispose = registerSettingsSection(ready.slots, {
      ...section,
      inject: (): Injected => ({ rpc }),
    } as never)
    // 面板随插件卸载一起消失
    ;(scoped as { effect?: (fn: () => () => void) => void }).effect?.(() => dispose)
  })
}
