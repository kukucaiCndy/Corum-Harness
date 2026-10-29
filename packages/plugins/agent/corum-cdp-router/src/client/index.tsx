/**
 * cdp-router 的 client 半 —— **CDP 目标状态面板（只读）**。
 *
 * ## 为什么是只读
 *
 * 目标管理是**低频配置操作**，而「本机能测哪些实例」靠自动发现已经能回答
 * （`cdpRouter/discoverTargets` 扫 pid 记录 + 探测 CDP + 读基座版本）。
 * 用户真正需要的是**可观测性**：
 *
 *  - 现在能测谁？（发现的实例 + 已配置的 targets）
 *  - 各是什么基座版本？（跨版本对照的前提）
 *  - 为什么某个 target 连不上？（护栏 disabled 原因 / problems）
 *
 * 增删改交给 Agent 工具（`cdp_adopt_discovered` 等）或手改 `cdp-targets.json` ——
 * 那样只有**一份**校验逻辑（本体 targets.ts），不会因为 UI 各写一套而漂移。
 *
 * ## 为什么放设置页而不是浮窗
 *
 * 用户口径（2026-10-29）：「不再用浮窗按钮展示，而是放在 setting 的扩���面板中」。
 * 低频、只读的状态信息不该常驻一个浮窗占地方。
 *
 * @module @corum/corum-cdp-router/client
 */

import { useCallback, useEffect, useState } from 'react'
import { defineSettingsSection, registerSettingsSection } from '@corum/plugin-ui-contract'

/** 已配置的 target（与服务侧 `CdpTarget` + disabled 同形）。 */
interface TargetRow {
  readonly id: string
  readonly ip: string
  readonly port: number
  readonly readOnly?: boolean
  readonly allowMain?: boolean
  readonly description?: string
  /** 非 null = 被护栏禁用（如 9222 没给 allowMain）。 */
  readonly disabled: string | null
  readonly discovered?: {
    readonly role?: string | null
    readonly releaseVersion?: string | null
    readonly releaseCommit?: string | null
    readonly source?: string | null
  }
}

/** 自动发现到的实例（与服务侧 `DiscoveredTarget` 同形）。 */
interface DiscoveredRow {
  readonly id: string
  readonly port: number
  readonly role: string
  readonly releaseVersion: string | null
  readonly releaseCommit: string | null
  readonly electronVersion: string | null
  readonly source: string
}

interface TargetsPayload {
  readonly configPath: string
  readonly generation: number
  readonly autoDiscover: boolean
  readonly targets: readonly TargetRow[]
  readonly lastError: string | null
}

interface DiscoverPayload {
  readonly targets: readonly DiscoveredRow[]
  readonly problems: readonly string[]
}

/** 调 host RPC 的最小接口（`connection.rpc.call` 的形状）。 */
interface RpcCaller {
  (service: string, method: string, args?: Record<string, unknown>): Promise<unknown>
}

/** 面板注入面。 */
interface Injected {
  readonly rpc: RpcCaller
}

/**
 * 状态面板组件。
 *
 * 只做三件事：列已配置 targets、列发现到的实例、把 problems 摊开。**没有任何写操作**。
 *
 * @param props - 注入的 rpc 调用器
 */
function CdpTargetsPanel({ rpc }: Injected): JSX.Element {
  const [listed, setListed] = useState<TargetsPayload | null>(null)
  const [found, setFound] = useState<DiscoverPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const [l, d] = await Promise.all([
        rpc('cdpRouter', 'listTargets', {}) as Promise<TargetsPayload>,
        rpc('cdpRouter', 'discoverTargets', { scanPorts: true }) as Promise<DiscoverPayload>,
      ])
      setListed(l)
      setFound(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [rpc])

  useEffect(() => { void reload() }, [reload])

  const styled = {
    section: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
    hint: { opacity: 0.7, fontSize: 12, lineHeight: 1.5 },
    table: { borderCollapse: 'collapse' as const, width: '100%', fontSize: 13 },
    th: { textAlign: 'left' as const, padding: '6px 8px', borderBottom: '1px solid var(--corum-line, #e5e5e5)', fontWeight: 600 },
    td: { padding: '6px 8px', borderBottom: '1px solid var(--corum-line, #f0f0f0)', verticalAlign: 'top' as const },
    mono: { fontFamily: 'var(--corum-font-mono, monospace)', fontSize: 12 },
    warn: { color: 'var(--corum-warn, #b35900)' },
    err: { color: 'var(--corum-danger, #c0392b)' },
    row: { display: 'flex', gap: 8, alignItems: 'center' },
    btn: { padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
    card: { border: '1px solid var(--corum-line, #e5e5e5)', borderRadius: 8, padding: 12 },
  }

  return (
    <div style={styled.section}>
      <div style={styled.hint}>
        CDP 目标决定「能测哪些实例」。本面板**只读**：目标由自动发现 + Agent 工具管理。
        <br />
        配置文件：<span style={styled.mono}>{listed?.configPath ?? '…'}</span>
        {listed !== null ? `（autoDiscover ${listed.autoDiscover ? '已开' : '已关'}）` : null}
      </div>

      <div style={styled.row}>
        <button type="button" style={styled.btn} disabled={busy} onClick={() => void reload()}>
          {busy ? '刷新中…' : '刷新'}
        </button>
        {error !== null ? <span style={{ ...styled.err, fontSize: 12 }}>{error}</span> : null}
      </div>

      {listed !== null && listed.lastError !== null
        ? <div style={{ ...styled.warn, fontSize: 12 }}>配置问题：{listed.lastError}</div>
        : null}

      <div style={styled.card}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>已配置的目标（{listed?.targets.length ?? 0}）</div>
        {listed === null || listed.targets.length === 0
          ? <div style={styled.hint}>还没有配置目标。可在下方「发现的实例」里用 Agent 工具采纳，或手动编辑配置文件。</div>
          : (
            <table style={styled.table}>
              <thead>
                <tr>
                  <th style={styled.th}>id</th>
                  <th style={styled.th}>端点</th>
                  <th style={styled.th}>基座版本</th>
                  <th style={styled.th}>状态</th>
                </tr>
              </thead>
              <tbody>
                {listed.targets.map(t => (
                  <tr key={t.id}>
                    <td style={{ ...styled.td, ...styled.mono }}>{t.id}</td>
                    <td style={{ ...styled.td, ...styled.mono }}>{t.ip}:{t.port}</td>
                    <td style={styled.td}>
                      {t.discovered?.releaseVersion ?? '—'}
                      {t.discovered?.releaseCommit != null ? ` @${t.discovered.releaseCommit}` : ''}
                    </td>
                    <td style={styled.td}>
                      {t.disabled === null
                        ? <span>可用{t.readOnly === true ? '（只读）' : ''}</span>
                        : <span style={styled.warn}>{t.disabled}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      <div style={styled.card}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>发现的实例（{found?.targets.length ?? 0}）</div>
        {found === null || found.targets.length === 0
          ? <div style={styled.hint}>本机没有发现可连接的实例（实例需开启 CDP 调试端口）。</div>
          : (
            <table style={styled.table}>
              <thead>
                <tr>
                  <th style={styled.th}>建议 id</th>
                  <th style={styled.th}>端口</th>
                  <th style={styled.th}>角色</th>
                  <th style={styled.th}>基座版本</th>
                  <th style={styled.th}>来源</th>
                </tr>
              </thead>
              <tbody>
                {found.targets.map(t => (
                  <tr key={`${t.id}-${t.port}`}>
                    <td style={{ ...styled.td, ...styled.mono }}>{t.id}</td>
                    <td style={{ ...styled.td, ...styled.mono }}>{t.port}</td>
                    <td style={styled.td}>{t.role}</td>
                    <td style={styled.td}>{t.releaseVersion ?? '（旧基座，无 release 字段）'}</td>
                    <td style={{ ...styled.td, ...styled.hint }}>{t.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        {found !== null && found.problems.length > 0
          ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>诊断（{found.problems.length}）</div>
              <ul style={{ ...styled.hint, margin: '4px 0 0 16px', padding: 0 }}>
                {found.problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )
          : null}
      </div>
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

/**
 * client 半入口：注册状态面板。
 *
 * @param ctx - client 上下文（`ctx.slots` 由壳提供）
 */
/** client 半的 inject 声明（清单 `dsh.client.inject` 里必须有同样的项）。 */
export const inject = ['slots']

/**
 * client 半入口：注册设置面板。
 *
 * ## 为什么不 import `defineClientPlugin`
 *
 * 那个 helper 只是恒等函数（`return plugin`），但 `@corum/plugin-sdk/client` 同时
 * re-export 了 `makeCorumRpcCall`（来自 `@corum/corum-rpc-client/client`），而后者
 * 把 `@corum/corum-ui-base` 的样式一并拉了进来 —— 构建产物里因此多出
 * `lib/style.css`（12.67 kB，全是 ui-base 的类名如 `.n0nNtq_card`）。
 *
 * 实测（2026-10-29）：不清掉这条链，本插件的 client bundle 里会**白白内联一整套
 * 未使用的壳样式**。这个面板只需要 `slots`，不需要任何 rpc helper。
 *
 * ## 类型说明
 *
 * `ctx.slots` 在 `inject: ['slots']` 之后才可用；这里按**能力面**取用（而不是把
 * `Context` 断言成自己的窄类型 —— 后者会让 `(ctx:{slots})=>void` 与
 * `(ctx: Context)=>void` 逆变不兼容，实测 TS2322）。
 *
 * @param ctx - client 上下文
 */
export function apply(ctx: unknown): void {
  const face = ctx as {
    slots: unknown
    effect?: (fn: () => () => void) => void
  }
  const dispose = registerSettingsSection(face.slots, section as never)
  // 面板随插件卸载一起消失
  face.effect?.(() => dispose)
}

export default apply
