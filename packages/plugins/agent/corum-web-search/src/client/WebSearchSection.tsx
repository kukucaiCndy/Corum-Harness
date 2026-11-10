/**
 * 「设置 → 扩展 → 联网搜索」section 的渲染面。
 *
 * 三块内容：
 *   ① 供应商列表 —— 当前激活项 + 每个已注册子 provider 的可用性与切换按钮
 *      （这是用户要的「添加并启用其他供应商」的可扩展面：别的插件经
 *      `ctx.corumWebSearch.registerSubProvider()` 注册，注册完刷新即出现在这里）；
 *   ② DeepSeek 配置 —— Key 状态（走既有 credentials 域）+ Key 写入，外加原「Web
 *      search」卡片的 endpoint / maxUses 两个字段（那张卡的唯一渲染者已随
 *      `settings.plugins.tab` 整块移除，字段搬到这里）；
 *   ③ 位置指引 —— 官方包的报错文案指向 `Settings > Plugins > Plugin configuration
 *      > Web search`（`dsh-web-search-deepseek/lib/index.js:191`），**那个页面在
 *      corum 里已经不存在**（渲染 `settings.plugins.tab` 的 ExtensionsSection 于
 *      2026-10-03 移除）。用户已裁定「接受那处过时，我们自己的 UI 补上正确指引」，
 *      本节就是那处指引。
 *
 * 视觉：全部内联 style + 壳 token，**不引任何 CSS Module**（同 corum-ollama 的
 * 做法，红线 §3.5：插件不得静态 value-import 壳 client bundle 的组件）。
 *
 * @module @corum/corum-web-search/client/WebSearchSection
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/** 子 provider 的列表投影（host `WebSearchStatus` 的同形窄化）。 */
export interface WebSearchSubProviderView {
  id: string
  label: string
  origin: string
  available: boolean
  active: boolean
}

/** host `corumWebSearch/describe` 的返回。 */
export interface WebSearchStatus {
  aggregateId: string
  activeId: string
  activeAvailable: boolean
  subProviders: WebSearchSubProviderView[]
}

/** `web-search-deepseek` settings section 里本节编辑的字段。 */
export interface WebSearchSectionValue {
  apiKeyEnv?: string
  baseURL?: string
  maxUses?: number
  model?: string
}

/** settings 面的窄化能力接口（红线 3：不耦合官方 SettingsScope 实现的全面）。 */
export interface WebSearchSettingsFace {
  getSnapshot(): {
    status: string
    value: WebSearchSectionValue | undefined
    user: unknown
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** credentials 域的窄化面（只用到「查一个引用的状态」与「写一个引用」）。 */
export interface WebSearchCredentialsFace {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>
  set(ref: string, value: string): Promise<void>
  /** 引用被别处改动时的失效通知（订阅搬家来源见 client/index.tsx）。 */
  subscribe(listener: (ref: string) => void): () => void
}

/** host RPC（`/api/corumWebSearch/<method>`）。 */
export type WebSearchCall = <T, A extends object = Record<string, unknown>>(
  method: string,
  args?: A,
) => Promise<T>

const MONO: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 12,
}

const INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--corum-glass-border)',
  background: 'var(--corum-glass-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  outline: 'none',
}

const BUTTON: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: 8,
  border: '1px solid var(--corum-glass-border)',
  background: 'var(--corum-glass-3)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/** 一行「标题 + 说明 + 控件」。 */
function Row({ label, desc, children }: { label: string; desc?: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 2px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{label}</span>
        {desc !== undefined && <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{desc}</span>}
      </div>
      {children}
    </div>
  )
}

/** 一个分组卡片容器。 */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '12px 14px', borderRadius: 12,
      border: '1px solid var(--corum-glass-border)',
      background: 'var(--corum-glass-1)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>{title}</span>
      {children}
    </div>
  )
}

/**
 * 「联网搜索」设置 section 的宿主组件。
 *
 * @param props.call - host RPC（`corumWebSearch/*`）。
 * @param props.settings - 绑到 `web-search-deepseek` namespace 的设置面。
 * @param props.credentials - credentials 域窄化面。
 * @param props.keyRef - 当前寻址的凭据引用（由 index.tsx 用 corum-ui-base 的规则算出）。
 */
export function WebSearchSection({ call, settings, credentials, keyRef }: {
  call: WebSearchCall
  settings: WebSearchSettingsFace
  credentials: WebSearchCredentialsFace
  keyRef: string
}) {
  const [, force] = useState(0)
  const [status, setStatus] = useState<WebSearchStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyState, setKeyState] = useState({ configured: false, writable: true })
  /** credentials 域的失效通知计数（Key 可能在别处被改，需要重查）。 */
  const [credentialNonce, setCredentialNonce] = useState(0)
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null)
  const [maxUsesDraft, setMaxUsesDraft] = useState<string | null>(null)

  const snapshot = settings.getSnapshot()
  const section = snapshot.value

  // settings 快照每次替换都重渲染（uSES 风格：组件内订阅 + 强制刷新）。
  useEffect(() => settings.subscribe(() => force(v => v + 1)), [settings])

  // credentials 域的失效通知：Key 可能在「模型」页被同一个引用写。
  useEffect(() => credentials.subscribe(ref => {
    if (ref === keyRef) setCredentialNonce(n => n + 1)
  }), [credentials, keyRef])

  // 当前引用的状态查询。ref 变了（或凭据域报变更）就重来——旧答案不能冒充新引用的状态。
  useEffect(() => {
    let live = true
    void (async () => {
      const view = await credentials.describe(keyRef)
      if (!live) return
      setKeyState({ configured: view.configured, writable: view.writable })
    })()
    return () => { live = false }
  }, [credentials, keyRef, credentialNonce])

  const refresh = (): void => {
    void (async () => {
      try {
        setStatus(await call<WebSearchStatus>('describe'))
        setError(null)
      } catch (e) {
        setError(String(e))
      }
    })()
  }

  // 首次拉取供应商列表（只跑一次：`refresh` 每次渲染都会重建，但它的闭包对
  // call/setStatus/setError 都是稳定的）。
  useEffect(() => { refresh() }, [])

  const switchTo = (id: string): void => {
    setBusy(id)
    void (async () => {
      try {
        setStatus(await call<WebSearchStatus>('setActive', { id }))
        setError(null)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const saveKey = (): void => {
    if (keyDraft.trim() === '') return
    setBusy('key')
    void (async () => {
      try {
        await credentials.set(keyRef, keyDraft.trim())
        const view = await credentials.describe(keyRef)
        setKeyState({ configured: view.configured, writable: view.writable })
        setKeyDraft('')
        setError(null)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const saveField = (field: 'baseURL' | 'maxUses', raw: string): void => {
    setBusy(field)
    void (async () => {
      try {
        if (raw.trim() === '') await settings.unset(field)
        else if (field === 'maxUses') {
          const parsed = Number(raw.trim())
          if (!Number.isInteger(parsed) || parsed < 1) throw new Error('「单次请求最多搜索次数」必须是 ≥1 的整数')
          await settings.set(field, parsed)
        } else await settings.set(field, raw.trim())
        setError(null)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const baseUrlValue = baseUrlDraft ?? section?.baseURL ?? ''
  const maxUsesValue = maxUsesDraft ?? (section?.maxUses !== undefined ? String(section.maxUses) : '')
  const activeLabel = status?.subProviders.find(p => p.active)?.label ?? status?.activeId ?? '（读取中…）'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Row
        label="联网搜索"
        desc="Agent 联网检索走哪个搜索供应商。默认 DeepSeek：配上 DeepSeek 的 API Key 即可用，无需其他配置。"
      />

      {/* ── ① 供应商 ── */}
      <Group title="搜索供应商">
        <Row label="当前生效" desc="切换后立刻生效，不需要重启。">
          <span style={{ ...MONO, color: 'var(--dsw-alias-brand-primary)' }}>{activeLabel}</span>
        </Row>
        {status === null
          ? <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>读取中…</span>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {status.subProviders.map(p => (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderRadius: 10,
                  border: `1px solid ${p.active ? 'var(--corum-glass-border-active)' : 'var(--corum-glass-border)'}`,
                  background: 'var(--corum-glass-2)',
                }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{p.label}</span>
                    <span style={{ ...MONO, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                      id={p.id} · {p.origin} · {p.available ? '可用' : '不可用（配置未完成）'}
                    </span>
                  </div>
                  {p.active
                    ? <span style={{ fontSize: 11, color: 'var(--dsw-alias-brand-primary)' }}>已启用</span>
                    : (
                      <button type="button" style={{ ...BUTTON, opacity: busy === p.id ? 0.5 : 1 }} disabled={busy !== null} onClick={() => switchTo(p.id)}>
                        {busy === p.id ? '切换中…' : '启用'}
                      </button>
                    )}
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button type="button" style={BUTTON} disabled={busy !== null} onClick={refresh}>刷新列表</button>
                <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                  其他插件注册的搜索供应商（经 corumWebSearch 服务）会在刷新后出现在这里。
                </span>
              </div>
            </div>
            )}
        <span style={{ ...MONO, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
          聚合 provider id = {status?.aggregateId ?? 'corum-web-search'}（ctx.web 里 pin 的就是它；子供应商切换只改本站的设置值，不重注册 provider）
        </span>
      </Group>

      {/* ── ② DeepSeek 配置 ── */}
      <Group title="DeepSeek 配置">
        <Row
          label="API Key"
          desc={`凭据引用 ${keyRef}（由本页 section 的 apiKeyEnv 决定；留空即用该默认）。`}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              fontSize: 11,
              color: keyState.configured ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warning-primary)',
            }}>
              {keyState.configured ? '已配置 —— DeepSeek 搜索可用' : '未配置 —— DeepSeek 搜索会在发起时失败（其他供应商不受影响）'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              style={INPUT}
              type="password"
              placeholder="粘贴 API Key 后点「保存 Key」（不写入设置文件）"
              value={keyDraft}
              disabled={!keyState.writable}
              onChange={e => setKeyDraft(e.target.value)}
            />
            <button
              type="button"
              style={{ ...BUTTON, opacity: (busy === 'key' || keyDraft.trim() === '' || !keyState.writable) ? 0.5 : 1 }}
              disabled={busy !== null || keyDraft.trim() === '' || !keyState.writable}
              onClick={saveKey}
            >
              {busy === 'key' ? '保存中…' : '保存 Key'}
            </button>
          </div>
          {!keyState.writable && (
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-warning-primary)' }}>
              当前引用由环境变量提供，无法在此改写。
            </span>
          )}
        </Row>

        <Row
          label="接口地址（Endpoint）"
          desc="搜索用的是 Anthropic 兼容的 Messages API，与聊天用的 base URL 是两个地址，不要混用。留空 = 官方默认 https://api.deepseek.com/anthropic/v1。"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              style={INPUT}
              placeholder="https://api.deepseek.com/anthropic/v1"
              value={baseUrlValue}
              disabled={!snapshot.writable}
              onChange={e => setBaseUrlDraft(e.target.value)}
            />
            <button type="button" style={BUTTON} disabled={busy !== null || !snapshot.writable} onClick={() => saveField('baseURL', baseUrlValue)}>
              {busy === 'baseURL' ? '保存中…' : '保存'}
            </button>
            <button type="button" style={BUTTON} disabled={busy !== null || !snapshot.writable} onClick={() => { setBaseUrlDraft(''); saveField('baseURL', '') }}>
              恢复默认
            </button>
          </div>
        </Row>

        <Row
          label="单次请求最多搜索次数"
          desc="一次请求在必须作答前最多可以搜索多少次（正整数）。留空 = 官方默认 5。"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              style={INPUT}
              inputMode="numeric"
              placeholder="5"
              value={maxUsesValue}
              disabled={!snapshot.writable}
              onChange={e => setMaxUsesDraft(e.target.value)}
            />
            {/* `data-slot` = 稳定语义锚点（黑盒自测定位用）。为什么需要：本页有**两个**文案完全
                相同的「保存」按钮（接口地址 / 单次搜索次数），按文案定位会命中前一个；
                `singleSearchCap` 的保存入口必须有独立锚点才能被真实点击。只加属性，不改行为。 */}
            <button type="button" data-slot="web-search.maxuses.save" style={BUTTON} disabled={busy !== null || !snapshot.writable} onClick={() => saveField('maxUses', maxUsesValue)}>
              {busy === 'maxUses' ? '保存中…' : '保存'}
            </button>
            <button type="button" style={BUTTON} disabled={busy !== null || !snapshot.writable} onClick={() => { setMaxUsesDraft(''); saveField('maxUses', '') }}>
              恢复默认
            </button>
          </div>
        </Row>
        {snapshot.status === 'unavailable' && (
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-warning-primary)' }}>
            设置命名空间 web-search-deepseek 当前不可达（读取中或该 provider 插件未挂载）。
          </span>
        )}
      </Group>

      {/* ── ③ 位置指引 ── */}
      <Group title="去哪改 / 去哪配">
        <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' }}>
          官方 DeepSeek 搜索 provider 在报错时会把你引向「设置 › 插件 › 插件配置 › 网页搜索」——
          那个页面在本应用里**已经不存在**（渲染它的「插件管理」设置分区已于 2026-10-03 整块移除，
          插件配置收编进集成中心）。接口地址就在**本页上面**的「DeepSeek 配置 › 接口地址」里。
        </span>
        <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' }}>
          也可以用环境变量 `DEEPSEEK_SEARCH_BASE_URL` 指定搜索端点（注意它与聊天用的 `DEEPSEEK_BASE_URL`
          不是同一个变量）；Key 仍走凭据域，本页写的就是它。
        </span>
      </Group>

      {error !== null && (
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</span>
      )}
    </div>
  )
}
