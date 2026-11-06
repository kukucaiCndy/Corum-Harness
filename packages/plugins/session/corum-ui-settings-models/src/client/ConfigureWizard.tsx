/**
 * 配置向导：选供应商（品牌网格 + API Key + 侦测）或自定义供应商（协议 +
 * baseURL + API Key + 侦测）→ 侦测成功复选模型 / 自定义输入 id → 保存回主页。
 *
 * 侦测走 llm/discoverModels（一次性 apiKey 不过夜）。保存：profile 写对应
 * settingsNs 的 providers.<route>（pi-ai）或整节（deepseek），密钥 credentials/set，
 * 所选模型写入 profile.models[]（含 id/contextWindow/maxTokens）。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { deriveKeyRef, messageOf } from './store.ts'
import type { ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { BrandLogo, brandNameOf, brandOf, CUSTOM_TEMPLATES, isPinnedProvider, providerChoices } from './brands.tsx'
import type { Brand, CustomTemplate } from './brands.tsx'

/**
 * Brand badge for a provider route id (also covers ids like `deepseek-official`).
 *
 * Purely cosmetic: the provider's *existence* comes from the directory, this only
 * decides the logo. An unknown route falls through to `brandOf` and then to the
 * default icon.
 */
function brandOfProvider(provider: string): Brand | undefined {
  return brandOf(provider)
}
import { useConnTest } from './useConnTest.ts'
import { catalogFallbackModels, isNoDiscoveryError, wizardProfilePath } from './catalog-fallback.ts'

import {
  BackRow, GlassButton, IconCheck, IconZap, SelectField, SettingGroup,
} from './controls.tsx'
import styles from './ModelsSection.module.css'

type Snapshot = ReturnType<ModelsSettingsStore['store']['getSnapshot']>

type Path = 'pick' | 'custom'

export function ConfigureWizard({ state, api, schema, onBack, onChanged, presetProvider, activeLocale }: {
  state: Snapshot
  api: ModelsWire
  schema: SettingsSchemaOperations
  onBack: () => void
  onChanged: () => void
  /** 供应商详情「添加模型」入口：预选该供应商并直接进侦测/选模型。 */
  presetProvider?: string | undefined
  /** Active locale id, for bilingual provider names. */
  activeLocale: () => string
  /** 品牌格里选中第三方模板时回调（切到自定义表单并预填）。 */
  onPickTemplate?: (template: CustomTemplate) => void
  /** 待预填的第三方模板（自定义表单用）。 */
  template?: CustomTemplate | undefined
}): ReactNode {
  const [path, setPath] = useState<Path>('pick')
  /** 选中第三方模板（非 pi-ai route）时要预填到自定义表单里。 */
  const [template, setTemplate] = useState<CustomTemplate | undefined>(undefined)
  const pickTemplate = (t: CustomTemplate): void => {
    setTemplate(t)
    setPath('custom')
  }
  return (
    <div className={styles['section']}>
      <BackRow onBack={onBack} />
      <span className={styles['segSwitch']}>
        <button
          type="button"
          className={`${styles['segBtn']} ${path === 'pick' ? styles['segBtnActive'] as string : ''}`}
          onClick={() => { setPath('pick') }}
        >
          选择供应商
        </button>
        <button
          type="button"
          className={`${styles['segBtn']} ${path === 'custom' ? styles['segBtnActive'] as string : ''}`}
          onClick={() => { setPath('custom') }}
        >
          自定义供应商
        </button>
      </span>
      {path === 'pick'
        ? <PickPath state={state} api={api} schema={schema} onChanged={onChanged} onBack={onBack} presetProvider={presetProvider} activeLocale={activeLocale} onPickTemplate={pickTemplate} />
        : <CustomPath state={state} api={api} schema={schema} onChanged={onChanged} onBack={onBack} activeLocale={activeLocale} template={template} />}
    </div>
  )
}

/* ── 侦测 + 模型选择（两路径共用） ── */

interface DetectProps {
  state: Snapshot
  api: ModelsWire
  schema: SettingsSchemaOperations
  onChanged: () => void
  onBack: () => void
  presetProvider?: string | undefined
  /** Active locale id, for bilingual provider names. */
  activeLocale: () => string
  /** 品牌格里选中第三方模板时回调（切到自定义表单并预填）。 */
  onPickTemplate?: (template: CustomTemplate) => void
  /** 待预填的第三方模板（自定义表单用）。 */
  template?: CustomTemplate | undefined
}

function useDetect(api: ModelsWire): {
  models: LlmDiscoveredModel[] | undefined
  detecting: boolean
  failure: string | undefined
  /** true = 结果来自内置目录（该 namespace 没有网络发现），不是网络侦测所得。 */
  catalog: boolean
  /**
   * @param fallback - NO_DISCOVERY 时的内置目录候选（目录型 provider，如官方
   * DeepSeek 整节）。省略则该错误按普通失败显示。
   */
  run: (settingsNs: string, req: Record<string, unknown>, fallback?: () => LlmDiscoveredModel[]) => Promise<void>
} {
  const [models, setModels] = useState<LlmDiscoveredModel[] | undefined>(undefined)
  const [detecting, setDetecting] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [catalog, setCatalog] = useState(false)
  const run = async (settingsNs: string, req: Record<string, unknown>, fallback?: () => LlmDiscoveredModel[]): Promise<void> => {
    setDetecting(true)
    setFailure(undefined)
    setModels(undefined)
    setCatalog(false)
    try {
      const res = await api.llm.discoverModels(settingsNs, req as unknown as Parameters<ModelsWire['llm']['discoverModels']>[1])
      if (!res.ok) {
        // 目录型 provider（官方 DeepSeek 整节）没有注册网络发现——读它自己的
        // 模型目录，不是失败。候选为空才退回错误提示。
        if (fallback !== undefined && isNoDiscoveryError(res.error.message)) {
          const builtin = fallback()
          if (builtin.length === 0) { setFailure(res.error.message); return }
          setCatalog(true)
          setModels(builtin)
          return
        }
        setFailure(res.error.message)
        return
      }
      setModels(res.value)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setDetecting(false)
    }
  }
  return { models, detecting, failure, catalog, run }
}

/* ── 路径 A：选择供应商 ── */

function PickPath({ state, api, schema, onChanged, onBack, presetProvider, activeLocale, onPickTemplate }: DetectProps): ReactNode {
  // 可选供应商来自 pi-ai 目录（state.rows），不是任何自维护清单。
  const choices = providerChoices(state.rows.map(row => row.entry))
  // 目录有 30+ 家时整格铺开会淹没常用项；默认只显示常用，其余点开。
  const [showAllProviders, setShowAllProviders] = useState(false)
  const hiddenProviderCount = choices.filter(b => !isPinnedProvider(b.id)).length
  const [provider, setProvider] = useState(presetProvider ?? choices[0]?.id ?? 'deepseek')
  const [apiKey, setApiKey] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [customId, setCustomId] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const detect = useDetect(api)
  const conn = useConnTest(api)
  void conn

  const brand = choices.find(b => b.id === provider)
  const lockedBrand = brandOfProvider(provider)
  const taken = state.rows.map(r => r.entry.provider)
  void taken

  const doDetect = async (): Promise<void> => {
    // catalog 路由用 provider 名 + apiKey 侦测；多数内置路由读自身目录。
    // 官方 DeepSeek（整节 llm-deepseek）没有网络发现：走内置目录兜底。
    const settingsNs = nsOfProvider(provider)
    await detect.run(
      settingsNs,
      { provider, ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }) },
      () => catalogFallbackModels(schema, state.namespaces.get(settingsNs), wizardProfilePath(settingsNs, provider), provider),
    )
    setPicked(new Set())
  }

  const toggle = (id: string): void => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosenCount = picked.size + (customId.trim() === '' ? 0 : 1)
  const canSave = chosenCount > 0

  const save = async (): Promise<void> => {
    setSaving(true)
    setFailure(undefined)
    try {
      const settingsNs = nsOfProvider(provider)
      const keyRef = deriveKeyRef(provider)
      const modelIds = [...picked, ...(customId.trim() === '' ? [] : [customId.trim()])]
      const detected = detect.models ?? []
      const namespace = state.namespaces.get(settingsNs)
      // 添加模型（presetProvider）：只把新模型**合并**进现有 profile.models，不重建供应商配置。
      if (presetProvider !== undefined) {
        const existingRaw = namespace === undefined ? [] : schema.getPath(namespace.value, [...(settingsNs === 'llm-deepseek' ? [] : ['providers', provider]), 'models'])
        const existing: Record<string, unknown>[] = Array.isArray(existingRaw)
          ? existingRaw.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null).map(m => ({ ...m }))
          : []
        const known = new Set(existing.map(m => (typeof m.id === 'string' ? m.id : '')))
        for (const id of modelIds) {
          if (known.has(id)) continue
          const d = detected.find(m => m.id === id)
          existing.push({
            id,
            ...(d?.contextWindow === undefined ? {} : { contextWindow: d.contextWindow }),
            ...(d?.maxTokens === undefined ? {} : { maxTokens: d.maxTokens }),
          })
        }
        const path = [...(settingsNs === 'llm-deepseek' ? [] : ['providers', provider]), 'models']
        const res = await api.settings.mutate(settingsNs, [{ op: 'set', path, value: existing as unknown as JsonValue }], namespace?.revision)
        if (!res.ok) { setFailure(res.error.message); return }
        if (apiKey.trim() !== '') {
          const cred = await api.credentials.set(keyRef, apiKey.trim())
          if (!cred.ok) { setFailure(cred.error.message); return }
        }
        onChanged()
        onBack()
        return
      }
      // 新建供应商（向导主路径）：写 profile + 密钥。
      const models = modelIds.map(id => {
        const d = detected.find(m => m.id === id)
        return {
          id,
          ...(d?.contextWindow === undefined ? {} : { contextWindow: d.contextWindow }),
          ...(d?.maxTokens === undefined ? {} : { maxTokens: d.maxTokens }),
        }
      })
      const isWholeSection = settingsNs === 'llm-deepseek'
      const profile: Record<string, unknown> = {
        ...(apiKey.trim() === '' ? {} : { apiKeyEnv: keyRef }),
        models,
      }
      const path = isWholeSection ? [] : ['providers', provider]
      const res = await api.settings.mutate(
        settingsNs,
        [{ op: 'set', path, value: profile as JsonValue }],
        namespace?.revision,
      )
      if (!res.ok) { setFailure(res.error.message); return }
      if (apiKey.trim() !== '') {
        const cred = await api.credentials.set(keyRef, apiKey.trim())
        if (!cred.ok) { setFailure(cred.error.message); return }
      }
      onChanged()
      onBack()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className={styles['formCard']}>
        {presetProvider === undefined ? (
          <div className={styles['fieldCol']}>
            <span className={styles['fieldLabel']}>供应商</span>
            <div className={styles['brandGrid']}>
              {choices.filter(b => showAllProviders || isPinnedProvider(b.id)).map(b => (
                <button
                  key={b.id}
                  type="button"
                  className={`${styles['brandCell']} ${b.id === provider ? styles['brandCellActive'] as string : ''}`}
                  onClick={() => {
                    const tpl = CUSTOM_TEMPLATES.find(t => t.id === b.id)
                    if (tpl !== undefined) { onPickTemplate?.(tpl); return }
                    setProvider(b.id)
                  }}
                >
                  <BrandLogo brand={b} size={20} />
                  {brandNameOf(b.name, activeLocale())}
                </button>
              ))}
            </div>
            {!showAllProviders && hiddenProviderCount > 0 && (
              <button
                type="button"
                className={styles['inlineLink']}
                onClick={() => { setShowAllProviders(true) }}
              >
                更多供应商（{hiddenProviderCount}）…
              </button>
            )}
          </div>
        ) : (
          /* 添加模型入口：供应商已锁定，只读显示，不再让重选。 */
          <div className={styles['fieldCol']}>
            <span className={styles['fieldLabel']}>供应商</span>
            <span className={styles['lockedProvider']}>
              <BrandLogo brand={brandOfProvider(provider)} size={22} />
              <span className={styles['lockedProviderName']}>{lockedBrand === undefined ? provider : brandNameOf(lockedBrand.name, activeLocale())}</span>
            </span>
          </div>
        )}
        <div className={styles['fieldCol']}>
          <span className={styles['fieldLabel']}>API Key{presetProvider !== undefined ? '（已配置则留空沿用）' : ''}</span>
          <input
            className={styles['inputFull']}
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={presetProvider !== undefined ? '留空沿用已配置密钥' : `输入${brand?.name ?? ''} API Key`}
            onChange={e => { setApiKey(e.target.value) }}
          />
        </div>
        {provider === 'kimi-coding'
          ? <p className={styles['notice']}>使用 Kimi Code 控制台生成的 API Key，消耗会员编程额度；与月之暗面开放平台的 API Key 不通用。</p>
          : null}
        <span className={styles['footRight']}>
          <GlassButton icon={<IconZap size={12} />} disabled={detect.detecting} onClick={() => { void doDetect() }}>
            {detect.detecting ? '侦测中…' : '侦测模型'}
          </GlassButton>
        </span>
        {detect.failure === undefined ? null : <p className={styles['error']}>{detect.failure}</p>}
        {detect.catalog
          ? <p className={styles['notice']}>该供应商使用内置模型目录（未发网络请求），从下方勾选要启用的模型。</p>
          : null}
      </div>

      {detect.models === undefined ? null : (
        <DetectResult
          models={detect.models}
          picked={picked}
          onToggle={toggle}
          customId={customId}
          onCustomId={setCustomId}
        />
      )}

      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}

      <div className={styles['foot']}>
        <span />
        <span className={styles['footRight']}>
          <GlassButton onClick={onBack} disabled={saving}>取消</GlassButton>
          <GlassButton kind="primary" disabled={saving || !canSave} onClick={() => { void save() }}>
            {saving ? '保存中…' : `配置所选模型（${chosenCount}）`}
          </GlassButton>
        </span>
      </div>
    </>
  )
}

/* ── 路径 B：自定义供应商 ── */

function CustomPath({ state, api, schema, onChanged, onBack, activeLocale, template }: DetectProps): ReactNode {
  const [protocol, setProtocol] = useState<string>(template?.api ?? 'openai-completions')
  const [baseURL, setBaseURL] = useState(template?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [route, setRoute] = useState(template?.id ?? '')
  const [displayName, setDisplayName] = useState(template === undefined ? '' : brandNameOf(template.name, activeLocale()))
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [customId, setCustomId] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const detect = useDetect(api)

  const routeOk = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route)
  const canDetect = baseURL.trim() !== '' && routeOk

  const doDetect = async (): Promise<void> => {
    await detect.run('llm-pi-ai', {
      baseURL: baseURL.trim(),
      api: protocol,
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
    })
    setPicked(new Set())
  }

  const toggle = (id: string): void => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosenCount = picked.size + (customId.trim() === '' ? 0 : 1)
  const canSave = routeOk && baseURL.trim() !== '' && chosenCount > 0

  const save = async (): Promise<void> => {
    setSaving(true)
    setFailure(undefined)
    try {
      const keyRef = deriveKeyRef(route)
      const modelIds = [...picked, ...(customId.trim() === '' ? [] : [customId.trim()])]
      const detected = detect.models ?? []
      const models = modelIds.map(id => {
        const d = detected.find(m => m.id === id)
        return {
          id,
          ...(d?.contextWindow === undefined ? {} : { contextWindow: d.contextWindow }),
          ...(d?.maxTokens === undefined ? {} : { maxTokens: d.maxTokens }),
        }
      })
      const profile: Record<string, unknown> = {
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
        ...(apiKey.trim() === '' ? {} : { apiKeyEnv: keyRef }),
        api: protocol,
        baseURL: baseURL.trim(),
        models,
      }
      const namespace = state.namespaces.get('llm-pi-ai')
      const res = await api.settings.mutate(
        'llm-pi-ai',
        [{ op: 'set', path: ['providers', route], value: profile as JsonValue }],
        namespace?.revision,
      )
      if (!res.ok) { setFailure(res.error.message); return }
      if (apiKey.trim() !== '') {
        const cred = await api.credentials.set(keyRef, apiKey.trim())
        if (!cred.ok) { setFailure(cred.error.message); return }
      }
      onChanged()
      onBack()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className={styles['formCard']}>
        <div className={styles['fieldCol']}>
          <span className={styles['fieldLabel']}>Provider ID</span>
          <input
            className={styles['inputFull']}
            value={route}
            placeholder="my-provider（小写字母/数字/短横线）"
            onChange={e => { setRoute(e.target.value) }}
          />
          {route !== '' && !routeOk ? <p className={styles['error']}>需以小写字母开头，之后可用小写字母、数字和短横线。</p> : null}
        </div>
        <div className={styles['fieldCol']}>
          <span className={styles['fieldLabel']}>显示名称（可空）</span>
          <input className={styles['inputFull']} value={displayName} placeholder="我的 Provider" onChange={e => { setDisplayName(e.target.value) }} />
        </div>
        <div className={styles['fieldCol']}>
          <span className={styles['fieldLabel']}>API 协议</span>
          <SelectField
            value={protocol}
            options={[
              { id: 'openai-completions', label: 'OpenAI 对话补全' },
              { id: 'openai-responses', label: 'OpenAI Responses' },
              { id: 'azure-openai-responses', label: 'Azure OpenAI Responses' },
              { id: 'anthropic-messages', label: 'Anthropic 消息' },
              { id: 'google-generative-ai', label: 'Google Gemini' },
            ]}
            onChange={setProtocol}
            ariaLabel="API 协议"
          />
        </div>
        <div className={styles['fieldCol']}>
          <span className={styles['fieldLabel']}>API 地址</span>
          <input className={styles['inputFull']} value={baseURL} placeholder="https://gateway.example/v1" onChange={e => { setBaseURL(e.target.value) }} />
        </div>
        <div className={styles['fieldCol']}>
          <span className={styles['fieldLabel']}>API Key</span>
          <input className={styles['inputFull']} type="password" autoComplete="off" value={apiKey} placeholder="输入 API Key" onChange={e => { setApiKey(e.target.value) }} />
        </div>
        <span className={styles['footRight']}>
          <GlassButton icon={<IconZap size={12} />} disabled={detect.detecting || !canDetect} onClick={() => { void doDetect() }}>
            {detect.detecting ? '侦测中…' : '侦测模型'}
          </GlassButton>
        </span>
        {detect.failure === undefined ? null : <p className={styles['error']}>{detect.failure}</p>}
      </div>

      {detect.models === undefined ? null : (
        <DetectResult
          models={detect.models}
          picked={picked}
          onToggle={toggle}
          customId={customId}
          onCustomId={setCustomId}
        />
      )}

      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}

      <div className={styles['foot']}>
        <span />
        <span className={styles['footRight']}>
          <GlassButton onClick={onBack} disabled={saving}>取消</GlassButton>
          <GlassButton kind="primary" disabled={saving || !canSave} onClick={() => { void save() }}>
            {saving ? '保存中…' : `配置所选模型（${chosenCount}）`}
          </GlassButton>
        </span>
      </div>
    </>
  )
}

/* ── 侦测结果列表 ── */

function DetectResult({ models, picked, onToggle, customId, onCustomId }: {
  models: readonly LlmDiscoveredModel[]
  picked: ReadonlySet<string>
  onToggle: (id: string) => void
  customId: string
  onCustomId: (v: string) => void
}): ReactNode {
  return (
    <SettingGroup title={`侦测到 ${models.length} 个模型 · 选择要配置的模型`}>
      <div className={styles['fieldCol']} style={{ gap: 6 }}>
        {models.map(m => {
          const on = picked.has(m.id)
          const spec = [
            m.contextWindow !== undefined ? `${Math.round(m.contextWindow / 1000)}K` : null,
          ].filter(Boolean).join(' · ')
          return (
            <button
              key={m.id}
              type="button"
              className={`${styles['selRow']} ${on ? styles['selRowActive'] as string : ''}`}
              onClick={() => { onToggle(m.id) }}
            >
              <span className={`${styles['selCb']} ${on ? styles['selCbOn'] as string : ''}`}>
                {on ? <IconCheck size={11} /> : null}
              </span>
              <span className={styles['selRowId']}>{m.id}</span>
              {spec === '' ? null : <span className={styles['selRowSpec']}>{spec}</span>}
            </button>
          )
        })}
        <label className={styles['customIdField']}>
          <span className={styles['customIdLabel']}>自定义模型 id</span>
          <input
            className={styles['customIdInput']}
            value={customId}
            placeholder="输入模型 id，例如 my-model-v1"
            onChange={e => { onCustomId(e.target.value) }}
          />
        </label>
      </div>
    </SettingGroup>
  )
}

/** provider route id → settingsNs（多数内置路由在 llm-pi-ai，deepseek 单独整节）。 */
function nsOfProvider(provider: string): string {
  if (provider.includes('deepseek')) return 'llm-deepseek'
  return 'llm-pi-ai'
}

