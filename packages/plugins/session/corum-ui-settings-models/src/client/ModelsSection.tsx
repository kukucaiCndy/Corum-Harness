/**
 * corum 模型页：两级结构的供应商/模型管理。
 *
 * 主页 = 已配置**供应商**卡片（品牌徽标+名称+状态+模型数 ›）+ ＋配置供应商；
 * 供应商详情 = 供应商配置（密钥/地址(官方隐藏)/连通）+ 其下已配置模型卡 + ＋添加模型；
 * 模型配置 = 容量/思考/费用/连接（ModelConfigView）。
 * 配置向导（＋配置供应商）= 选品牌/自定义 → 侦测 → 选模型（ConfigureWizard）。
 *
 * 对齐 design.pen：主页 ijX9e / 供应商详情 ONwOm / 模型配置 r2UVjg / 向导 bPtoz·nMytR。
 * API Key 本地加密存储见 host 层 safeStorage 适配（credentials/set 值永不过线）。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import { collectProviderCards } from './model-cards.ts'
import type { ModelCard, ProviderCard } from './model-cards.ts'
import { AddModelSelectView } from './AddModelSelectView.tsx'
import { BrandLogo } from './brands.tsx'
import { IconCpu, IconPlus, IconChevronRight, StatusPill } from './controls.tsx'
import { ProviderDetailView } from './ProviderDetailView.tsx'
import { ModelConfigView } from './ModelConfigView.tsx'
import { ConfigureWizard } from './ConfigureWizard.tsx'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  controller: ModelsSettingsStore
  hooks: { snapshot: ModelsSettingsStore['store'] }
  api: ModelsWire
  schema: SettingsSchemaOperations
  t: (key: keyof typeof en) => string
  /** Active locale id (e.g. `zh-CN`), read on render so names follow the language. */
  activeLocale: () => string
}

type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'
type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>
type ModelsSectionFace = InjectFace<ModelsSectionInjected>

/** 跳页视图：主页（供应商卡）/ 供应商详情 / 模型配置 / 配置向导 / 添加模型。 */
type View =
  | { kind: 'home' }
  | { kind: 'provider'; provider: ProviderCard }
  | { kind: 'config'; card: ModelCard }
  | { kind: 'wizard' }
  | { kind: 'addModel'; provider: ProviderCard }

/** The Models section content column (jump-page router). */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema, t, activeLocale, renderSlot } = props
  if (
    controller === undefined || useSnapshot === undefined || api === undefined
    || schema === undefined || t === undefined || activeLocale === undefined
  ) return null
  return <Loaded injected={{ controller, useSnapshot, api, schema, t, activeLocale }} renderSlot={renderSlot} />
}

function Loaded({ injected, renderSlot }: { injected: ModelsSectionFace; renderSlot: ModelsRenderSlot }): ReactNode {
  const { controller, api, schema, t, activeLocale } = injected
  const state = injected.useSnapshot(s => s)
  const [view, setView] = useState<View>({ kind: 'home' })

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['btn']} onClick={() => { void controller.load() }}>{t('retry')}</button>
      </div>
    )
  }

  const reload = (): void => { void controller.load() }
  const toHome = (): void => { setView({ kind: 'home' }) }

  if (view.kind === 'wizard') {
    return (
      <ConfigureWizard
        state={state}
        api={api}
        schema={schema}
        onBack={toHome}
        onChanged={reload}
        activeLocale={activeLocale}
      />
    )
  }
  if (view.kind === 'addModel') {
    const freshProviderCard = collectProviderCards(state, schema).find(p =>
      p.provider === view.provider.provider && p.settingsNs === view.provider.settingsNs) ?? view.provider
    return (
      <AddModelSelectView
        provider={freshProviderCard}
        state={state}
        api={api}
        schema={schema}
        onBack={() => { setView({ kind: 'provider', provider: freshProviderCard }) }}
        onChanged={reload}
      />
    )
  }
  if (view.kind === 'config') {
    return (
      <ModelConfigView
        /* key 按模型身份：ModelConfigView 用 useState 初始化器读 props（档位集合/
           wire 值/容量），实例复用会把上一个模型的编辑态带进下一个（同
           HANDOFF-2026-09-25 的「缺 React key ⇒ 组件实例被复用」事故形态）。 */
        key={`cfg:${view.card.provider}/${view.card.modelId}`}
        card={view.card}
        state={state}
        api={api}
        schema={schema}
        onBack={() => {
          const provider = collectProviderCards(state, schema).find(p => p.provider === view.card.provider)
          setView(provider === undefined ? { kind: 'home' } : { kind: 'provider', provider })
        }}
        onChanged={reload}
      />
    )
  }
  if (view.kind === 'provider') {
    return (
      <ProviderDetailView
        provider={view.provider}
        state={state}
        api={api}
        schema={schema}
        onBack={toHome}
        onOpenModel={(card) => { setView({ kind: 'config', card }) }}
        onAddModel={() => { setView({ kind: 'addModel', provider: view.provider }) }}
        onChanged={reload}
      />
    )
  }

  // ── 主页：已配置供应商卡片 ──
  const providers = collectProviderCards(state, schema)
  return (
    <div className={styles['section']}>
      <p className={styles['hint']}>
        {providers.length > 0 ? '已配置的供应商 · 点击进入管理其模型，点 ＋ 配置新供应商' : '还没有配置供应商 · 点 ＋ 配置第一个'}
      </p>
      <div className={styles['providerList']}>
        {providers.map(p => (
          <ProviderRowCard key={p.provider} provider={p} onOpen={() => { setView({ kind: 'provider', provider: p }) }} />
        ))}
        <button type="button" className={styles['addProviderCard']} onClick={() => { setView({ kind: 'wizard' }) }}>
          <IconPlus size={16} />
          <span>配置供应商</span>
        </button>
      </div>
      {renderSlot('settings.models.footer', {})}
    </div>
  )
}

/* ── 供应商卡片（主页，横排大卡） ── */

function ProviderRowCard({ provider, onOpen }: { provider: ProviderCard; onOpen: () => void }): ReactNode {
  return (
    <button type="button" className={styles['providerCard']} onClick={onOpen} aria-label={provider.providerName}>
      <span className={styles['providerCardLeft']}>
        <BrandLogo brand={provider.brand} size={34} fallback={<IconCpu size={17} />} />
        <span className={styles['cardHeadTitle']}>
          <span className={styles['cardName']}>{provider.providerName}</span>
          <span className={styles['cardDesc']}>{provider.desc}</span>
        </span>
      </span>
      <span className={styles['providerCardRight']}>
        <StatusPill tone={provider.connected ? 'success' : 'dim'} label={`${provider.modelCount} 个模型`} />
        <IconChevronRight size={16} />
      </span>
    </button>
  )
}
