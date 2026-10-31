/**
 * 添加模型：锁定供应商 + 多选发现列表 + 自定义 id，一次追加到现有 models。
 *
 * 与「配置新供应商」向导完全分离：无路径切换、无品牌网格、无 API Key（沿用
 * 供应商已配密钥）。侦测走该供应商的 llm/discoverModels。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { messageOf } from './store.ts'
import type { ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ProviderCard } from './model-cards.ts'
import { formatCapacity } from './model-profile.ts'
import { catalogFallbackModels, isNoDiscoveryError } from './catalog-fallback.ts'
import { BrandLogo } from './brands.tsx'

import {
  BackRow, GlassButton, IconCheck, IconCpu, IconZap,
} from './controls.tsx'
import styles from './ModelsSection.module.css'

type Snapshot = ReturnType<ModelsSettingsStore['store']['getSnapshot']>

export function AddModelSelectView({ provider, state, api, schema, onBack, onChanged }: {
  provider: ProviderCard
  state: Snapshot
  api: ModelsWire
  schema: SettingsSchemaOperations
  onBack: () => void
  onChanged: () => void
}): ReactNode {
  const [models, setModels] = useState<LlmDiscoveredModel[] | undefined>(undefined)
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [catalog, setCatalog] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [customId, setCustomId] = useState('')
  const savingRef = useRef(false)
  const discoveryGeneration = useRef(0)

  const namespace = state.namespaces.get(provider.settingsNs)
  const profile = namespace === undefined ? undefined : schema.getPath(namespace.value, provider.settingsPath)
  const snapshotFailure = namespace === undefined || typeof namespace.revision !== 'number'
    ? '无法解析设置命名空间，请返回后重试。'
    : profile === undefined || profile === null ? '供应商配置已不存在，请返回后重试。' : undefined
  const modelsPath = [...provider.settingsPath, 'models']
  const existingRaw = namespace === undefined ? undefined : schema.getPath(namespace.value, modelsPath)
  const existing = Array.isArray(existingRaw) ? existingRaw : []
  // 从最新快照判断已有 ID，原有行（含所有自定义字段）仅在保存时原样追加。
  const configured = new Set(existing.flatMap((m: unknown) =>
    typeof m === 'object' && m !== null && 'id' in m && typeof m.id === 'string' ? [m.id] : []))
  const candidates = [...new Map((models ?? []).map(m => [m.id, m])).values()]
  const selectable = candidates.filter(m => !configured.has(m.id))
  const additions = [...new Set([...selected, customId.trim()].filter(id => id !== '' && !configured.has(id)))]
  const disabled = detecting || saving || !state.writable
  const canSave = !disabled && snapshotFailure === undefined && additions.length > 0
  const allSelected = selectable.length > 0 && selectable.every(m => selected.has(m.id))

  const detect = async (): Promise<void> => {
    if (savingRef.current) return
    const generation = ++discoveryGeneration.current
    setDetecting(true)
    setModels(undefined)
    setSelected(new Set())
    setFailure(undefined)
    setCatalog(false)
    try {
      // 自定义路由（pi-ai）需带 baseURL 才能探测；catalog 目录路由不用。
      const req: Record<string, unknown> = { provider: provider.provider }
      if (provider.baseURL !== undefined && provider.baseURL !== '') req.baseURL = provider.baseURL
      const protocol = namespace === undefined ? undefined : schema.getPath(namespace.value, [...provider.settingsPath, 'api'])
      if (typeof protocol === 'string') req.api = protocol
      const res = await api.llm.discoverModels(provider.settingsNs, req as unknown as Parameters<ModelsWire['llm']['discoverModels']>[1])
      if (generation !== discoveryGeneration.current) return
      if (!res.ok) {
        // catalog 目录路由：discoverModels 不注册网络发现——读该 provider 自己的
        // 模型目录（profile 已解析 models → 内置 catalog 表），不是失败。
        if (isNoDiscoveryError(res.error.message)) {
          setCatalog(true)
          setModels(catalogFallbackModels(schema, state.namespaces.get(provider.settingsNs), provider.settingsPath, provider.provider))
          return
        }
        // pi-ai 无 catalog 路由且无法网络探测：给「手动输入」提示（非硬错误）。
        if (/ships no catalog/i.test(res.error.message)) {
          setModels([])
          setFailure('该供应商无法在线侦测模型 · 请用下方自定义输入模型 id 添加')
          return
        }
        setFailure(res.error.message)
        return
      }
      setModels(res.value)
    } catch (error) {
      if (generation === discoveryGeneration.current) setFailure(messageOf(error))
    } finally {
      if (generation === discoveryGeneration.current) setDetecting(false)
    }
  }

  // 进页自动侦测一次（官方目录路由返回内置目录，自定义走网络）。
  useEffect(() => {
    void detect() /* eslint-disable-line react-hooks/exhaustive-deps */
    return () => { discoveryGeneration.current++ }
  }, [provider.provider])

  const save = async (): Promise<void> => {
    if (savingRef.current || !canSave || namespace === undefined) return
    savingRef.current = true
    setSaving(true)
    setFailure(undefined)
    try {
      const added = additions.map(id => {
        const discovered = candidates.find(m => m.id === id)
        return {
          id,
          ...(discovered?.contextWindow === undefined ? {} : { contextWindow: discovered.contextWindow }),
          ...(discovered?.maxTokens === undefined ? {} : { maxTokens: discovered.maxTokens }),
        }
      })
      const res = await api.settings.mutate(provider.settingsNs,
        [{ op: 'set', path: modelsPath, value: [...existing, ...added] as JsonValue }], namespace.revision)
      if (!res.ok) { setFailure(res.error.message); return }
      onChanged()
      onBack()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className={styles['section']}>
      <BackRow onBack={() => { if (!savingRef.current) onBack() }} label={`返回 ${provider.providerName}`} />

      {/* 锁定供应商顶栏（只读） */}
      <span className={styles['lockedProvider']}>
        <BrandLogo brand={provider.brand} size={22} fallback={<IconCpu size={13} />} />
        <span className={styles['lockedProviderName']}>{provider.providerName}</span>
        <span className={styles['lockedProviderTag']}>· 已锁定</span>
      </span>

      <span className={styles['btnRowBetween']}>
        <span className={styles['settingGroupTitle']}>选择要添加的模型（多选）</span>
        <GlassButton icon={<IconZap size={12} />} disabled={detecting || saving} onClick={() => { void detect() }}>
          {detecting ? '侦测中…' : '侦测可用模型'}
        </GlassButton>
      </span>

      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {snapshotFailure === undefined ? null : <p className={styles['error']}>{snapshotFailure}</p>}
      {catalog
        ? <p className={styles['notice']}>该供应商使用内置模型目录（未发网络请求）。</p>
        : null}

      <div className={styles['fieldCol']} style={{ gap: 6 }}>
        <GlassButton disabled={disabled || selectable.length === 0} onClick={() => {
          setSelected(allSelected ? new Set() : new Set(selectable.map(m => m.id)))
        }}>
          {allSelected ? '取消全选' : '全选'}
        </GlassButton>
        {candidates.map((m) => {
          const isConfigured = configured.has(m.id)
          const on = selected.has(m.id) && !isConfigured
          const spec = [
            m.contextWindow !== undefined ? formatCapacity(m.contextWindow) : null,
          ].filter(Boolean).join(' · ')
          return (
            <button
              key={m.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={isConfigured || disabled}
              className={`${styles['selRow']} ${on ? styles['selRowActive'] as string : ''} ${isConfigured ? styles['selRowDisabled'] as string : ''}`}
              onClick={() => {
                if (isConfigured || disabled) return
                setSelected(current => {
                  const next = new Set(current)
                  if (next.has(m.id)) next.delete(m.id)
                  else next.add(m.id)
                  return next
                })
              }}
            >
              <span className={`${styles['selCb']} ${on ? styles['selCbOn'] as string : ''}`}>
                {on ? <IconCheck size={11} /> : null}
              </span>
              <span className={styles['selRowId']}>{m.id}</span>
              {spec === '' ? null : <span className={styles['selRowSpec']}>{spec}</span>}
              {isConfigured ? <span className={styles['selRowTag']}>已配置</span> : null}
            </button>
          )
        })}
        <label className={styles['customIdField']}>
          <span className={styles['customIdLabel']}>自定义模型 id</span>
          <input
            className={styles['customIdInput']}
            value={customId}
            disabled={disabled}
            placeholder="输入模型 id，例如 my-model-v1"
            onChange={e => { setCustomId(e.target.value) }}
          />
        </label>
      </div>

      <div className={styles['foot']}>
        <span />
        <span className={styles['footRight']}>
          <GlassButton onClick={onBack} disabled={saving}>取消</GlassButton>
          <GlassButton kind="primary" disabled={!canSave} onClick={() => { void save() }}>
            {saving ? '保存中…' : `添加所选模型（${additions.length}）`}
          </GlassButton>
        </span>
      </div>
    </div>
  )
}
