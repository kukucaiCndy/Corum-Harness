/**
 * 供应商详情页（两级结构的中间层）：供应商配置卡（密钥 / API 地址(官方隐藏) /
 * 连通性测试）+ 其下已配置模型卡片网格（点进模型配置页）+ ＋添加模型。
 *
 * 密钥走 credentials/set（值永不过线；存储加密见 host 层 safeStorage 适配）。
 * 连通测试：官方目录路由读内置目录（catalog 友好结果），自定义路由走网络探测。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmDialog } from '@corum/corum-ui-base/client'
import { keyConfiguredFor, keyRefFor, messageOf, planModelDeletion, saveProviderProfile } from './store.ts'
import type { ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelCard, ProviderCard } from './model-cards.ts'
import { collectProviderCards, priceOf, specsOf } from './model-cards.ts'
import { BrandLogo } from './brands.tsx'
import { useConnTest } from './useConnTest.ts'
import {
  BackRow, ConnResult, GlassButton, IconCpu, IconPlus, IconTrash, IconZap,
  SettingGroup, SettingRow, StatusPill, Switch,
} from './controls.tsx'
import styles from './ModelsSection.module.css'

type Snapshot = ReturnType<ModelsSettingsStore['store']['getSnapshot']>

export function ProviderDetailView({ provider, state, api, schema, onBack, onOpenModel, onAddModel, onChanged }: {
  provider: ProviderCard
  state: Snapshot
  api: ModelsWire
  schema: SettingsSchemaOperations
  onBack: () => void
  onOpenModel: (card: ModelCard) => void
  onAddModel: () => void
  onChanged: () => void
}): ReactNode {
  // 实时按 provider id 从最新 state 取供应商（增删模型后 reload 能反映，不依赖旧快照）。
  const liveProvider = collectProviderCards(state, schema).find(p => p.provider === provider.provider) ?? provider
  provider = liveProvider
  const isOfficial = provider.settingsNs === 'llm-deepseek'
  const keyRef = keyRefFor(provider.provider, provider.apiKeyEnv)
  // 兼容性：pi-ai 对 OpenAI 兼容网关默认按 URL 猜「支持 developer role」，自建/内网
  // 网关普遍不认（system 提示词被拒 → 400 且正文读不出，见 2026-09-09 实测）。
  // 开 = 写 compat.supportsDeveloperRole:false（改用 system role）。
  const settingsNamespace = state.namespaces.get(provider.settingsNs)
  const systemRoleStored = settingsNamespace !== undefined
    && schema.getPath(settingsNamespace.value, [...provider.settingsPath, 'compat', 'supportsDeveloperRole']) === false
  const [keyDraft, setKeyDraft] = useState('')
  // 已配置判定同时认 profile 声明的 ref 与详情页推导出来的 ref：后者是「有密钥但
  // profile 没声明」那种行的唯一密钥证据，只读 credential 会把它显示成未配置。
  const [keyConfigured, setKeyConfigured] = useState(keyConfiguredFor(provider.row))
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? '')
  const [systemRole, setSystemRole] = useState(systemRoleStored)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const conn = useConnTest(api)
  const disabled = busy || !state.writable
  // 删除模型确认弹窗：待删卡片（null = 不弹）。
  const [pendingDelete, setPendingDelete] = useState<ModelCard | null>(null)

  /** 该供应商当前还剩几个模型（删除前判定「是不是最后一个」）。 */
  const modelCountOf = (): number => {
    const namespace = state.namespaces.get(provider.settingsNs)
    const list = namespace === undefined ? undefined : schema.getPath(namespace.value, [...provider.settingsPath, 'models'])
    return Array.isArray(list) ? list.length : 0
  }

  /**
   * 删除一个模型（从该供应商 profile.models[] 移除）。
   *
   * ⚠️ **删到 0 个时不能只写 `models: []`**（2026-11 用户实测）：官方
   * `dsh-llm-pi-ai` 校验「已安装目录里没有、配置里也没列模型」的 provider 时会抛
   * `provider "mac" resolves no models; the installed catalog does not describe this route…`
   * —— 用户点「删除模型」看到的是这句话，等于删不掉。
   *
   * 用户裁定：**删除最后一个模型 = 删除整个供应商**（弹确认说清楚）。故这里分两条路：
   *   · 还剩 ≥1 个模型 ⇒ 只写 models 数组；
   *   · 这是最后一个 ⇒ 走 {@link removeProvider}（unset 整个 provider 节）。
   */
  const removeModel = async (card: ModelCard): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const namespace = state.namespaces.get(provider.settingsNs)
      const plan = planModelDeletion({
        settingsPath: provider.settingsPath,
        models: namespace === undefined ? undefined : schema.getPath(namespace.value, [...provider.settingsPath, 'models']),
        modelId: card.modelId,
      })
      const res = await api.settings.mutate(provider.settingsNs, plan.ops, namespace?.revision)
      if (!res.ok) { setFailure(res.error.message); return }
      onChanged()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 待删的那个模型是不是本供应商的**最后一个**。
   *
   * 是的话弹窗必须说实话（「会连供应商一起删掉」）—— 用户 2026-11 实测的报错
   * `provider "mac" resolves no models…` 就是「只删模型、留下空供应商」的后果，
   * 所以 {@link planModelDeletion} 对这种情况直接 `unset` 整个供应商节。
   */
  const lastModelDelete = pendingDelete !== null && modelCountOf() <= 1

  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      const key = keyDraft.trim()
      const namespace = state.namespaces.get(provider.settingsNs)
      // profile 的全部写入（含 apiKeyEnv 声明）合成一次 mutate，先落盘、再写 credential；
      // 顺序与理由见 saveProviderProfile（credential 先写会留下没人读得到的孤儿密钥）。
      const message = await saveProviderProfile(api, provider.settingsNs, {
        settingsPath: provider.settingsPath,
        declaredApiKeyEnv: provider.apiKeyEnv,
        keyRef,
        key,
        isOfficial,
        baseURL,
        systemRole,
        systemRoleStored,
      }, namespace?.revision)
      if (message !== undefined) { setFailure(message); return }
      if (key !== '') {
        setKeyDraft('')
        setKeyConfigured(true)
      }
      setSaved(true)
      onChanged()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['section']}>
      <BackRow onBack={onBack} label="返回供应商列表" />

      {/* ── 供应商配置卡 ── */}
      <div className={styles['card']}>
        <span className={styles['cardHead']}>
          <span className={styles['cardHeadLeft']}>
            <BrandLogo brand={provider.brand} size={34} fallback={<IconCpu size={17} />} />
            <span className={styles['cardHeadTitle']}>
              <span className={styles['cardName']}>{provider.providerName}</span>
              <span className={styles['cardDesc']}>{provider.desc}</span>
            </span>
          </span>
          <span className={styles['cardHeadRight']}>
            <StatusPill tone={keyConfigured || provider.connected ? 'success' : 'dim'} label={keyConfigured || provider.connected ? '已连接' : '未配置'} />
          </span>
        </span>
        {/* fork（corum）：无 settingsNs 的 route provider（如 Ollama）不需要 API key/baseURL 配置。 */}
        {provider.settingsNs !== '' && (<>
        <div className={styles['hDivider']} />
        <SettingRow
          label="API 密钥"
          desc={`${keyRef} · ${keyConfigured ? '已配置——输入新值可替换' : '未配置'}`}
          control={(
            <input
              className={`${styles['textField']} ${styles['textFieldWide']}`}
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder={keyConfigured ? '••••••••••••••••' : '输入 API 密钥'}
              disabled={disabled}
              onChange={e => { setKeyDraft(e.target.value); setSaved(false) }}
            />
          )}
        />
        {isOfficial ? null : (
          <SettingRow
            label="API 地址"
            desc="该供应商的 endpoint"
            control={(
              <input
                className={`${styles['textField']} ${styles['textFieldWide']}`}
                value={baseURL}
                placeholder="https://gateway.example/v1"
                disabled={disabled}
                onChange={e => { setBaseURL(e.target.value); setSaved(false) }}
              />
            )}
          />
        )}
        {isOfficial ? null : (
          <SettingRow
            label="消息角色兼容性"
            desc={systemRole
              ? 'system role · 适用于不认 developer role 的网关'
              : '自动（按地址判定）· 网关报「400 无正文」时打开'}
            control={(
              <>
                <span className={styles['fieldMeta']}>改用 system role</span>
                <Switch
                  on={systemRole}
                  disabled={disabled}
                  ariaLabel="改用 system role"
                  onChange={on => { setSystemRole(on); setSaved(false) }}
                />
              </>
            )}
          />
        )}
        <SettingRow
          label="连通性测试"
          desc={isOfficial ? '官方目录路由 · 读取内置模型目录' : '向该供应商发送一次模型列表请求'}
          divider={false}
          control={(
            <>
              <ConnResult conn={conn} inline />
              <GlassButton icon={<IconZap size={12} />} disabled={conn.result.kind === 'busy'} onClick={() => {
                void conn.run({
                  settingsNs: provider.settingsNs,
                  provider: provider.provider,
                  baseURL: baseURL || undefined,
                  apiKey: keyDraft.trim() !== '' ? keyDraft.trim() : undefined,
                })
              }}>
                测试连接
              </GlassButton>
            </>
          )}
        />
        {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
        {saved ? <p className={styles['savedNotice']}>已保存。</p> : null}
        <div className={styles['footRight']}>
          <GlassButton kind="primary" disabled={disabled || (keyDraft.trim() === '' && (isOfficial || baseURL === provider.baseURL) && systemRole === systemRoleStored)} onClick={() => { void save() }}>
            {busy ? '保存中…' : '保存'}
          </GlassButton>
        </div>
        </>)}
      </div>

      {/* ── 已配置模型 ── */}
      <span className={styles['settingGroupTitle']}>已配置的模型</span>
      <div className={styles['cardGrid']}>
        {provider.cards.map(card => (
          <span key={card.modelId} className={styles['modelCardWrap']}>
            <button type="button" className={styles['modelCard']} onClick={() => { onOpenModel(card) }} aria-label={card.modelId}>
              <span className={styles['modelCardTop']}>
                <BrandLogo brand={card.brand} size={30} fallback={<IconCpu size={16} />} />
                <span className={styles['modelCardProv']}>{card.providerName}</span>
              </span>
              <span className={styles['modelCardName']}>{card.modelId}</span>
              <span className={styles['modelCardSpecs']}>{specsOf(card)}</span>
              <span className={styles['modelCardDiv']} />
              <span className={styles['modelCardPrice']}>{priceOf(card)}</span>
            </button>
            {/* 删除快捷入口（hover 显示，卡片右上） */}
            <button
              type="button"
              className={styles['modelCardDelete']}
              aria-label={`删除 ${card.modelId}`}
              title={`删除 ${card.modelId}`}
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); setPendingDelete(card) }}
            >
              <IconTrash size={13} />
            </button>
          </span>
        ))}
        <button type="button" className={styles['modelCardAdd']} onClick={onAddModel}>
          <IconPlus size={18} />
          <span>添加模型</span>
        </button>
      </div>

      {pendingDelete !== null && lastModelDelete && (
        <ConfirmDialog
          title="这是最后一个模型"
          message={`删除 ${pendingDelete.modelId} 会连整个供应商「${provider.providerName}」一起删掉。`}
          warning={'供应商必须至少保留一个模型：只删模型会留下一个无法加载的空供应商（官方适配器会拒绝解析）。确认后供应商与其密钥设置一并移除。'}
          tone="danger"
          confirmLabel="删除供应商"
          busy={busy}
          busyLabel="删除中…"
          onConfirm={() => {
            const card = pendingDelete
            setPendingDelete(null)
            void removeModel(card)
          }}
          onCancel={() => { setPendingDelete(null) }}
        />
      )}

      {pendingDelete !== null && !lastModelDelete && (
        <ConfirmDialog
          title="删除模型"
          message={`删除模型 ${pendingDelete.modelId}？`}
          warning={`将从 ${provider.providerName} 的目录中移除。`}
          tone="danger"
          confirmLabel="删除"
          busy={busy}
          busyLabel="删除中…"
          onConfirm={() => {
            const card = pendingDelete
            setPendingDelete(null)
            void removeModel(card)
          }}
          onCancel={() => { setPendingDelete(null) }}
        />
      )}
    </div>
  )
}

export { SettingGroup }
