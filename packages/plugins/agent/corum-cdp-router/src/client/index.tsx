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
        // ⚠️ typert gateway 的 args 描述符是按**形参名**建的：本服务的 9 个 RPC 都只
        // 有一个形参 `input`（`Record<string, unknown> | undefined`），所以实参必须
        // 再套一层 `input:`。直接写 `{ scanPorts: true }` 会被网关拒：
        // `gateway/arguments-invalid: … args fields do not match the descriptor: unexpected "scanPorts"`
        // （实测 2026-10-30，安装态 /Applications + CDP）。
        rpc('cdpRouter', 'discoverTargets', { input: { scanPorts: true } }) as Promise<DiscoverPayload>,
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
