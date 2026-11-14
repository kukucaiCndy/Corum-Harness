/**
 * 主页「已配置模型卡片」聚合：遍历已配置 provider 的 models[]，每个模型汇成
 * 一张卡片（模型名/供应商/上下文/思考/图片/费用）。只展示**已配置**的
 * （有密钥或自定义 route），未配置的内置 provider 不进主页（去配置向导选）。
 */

import type { ModelsSettingsState } from './store.ts'
import { providerUsable } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { readModel } from './model-profile.ts'
import { brandOf } from './brands.tsx'
import type { Brand } from './brands.tsx'
import { familyOfNamespace } from './reasoning.ts'
import { formatCapacity } from './model-profile.ts'

/** 一张模型卡片。 */
export interface ModelCard {
  /** provider route id。 */
  provider: string
  /** 模型 id。 */
  modelId: string
  /** 品牌（未知 undefined → 自定义默认图标）。 */
  brand: Brand | undefined
  /** 供应商显示名。 */
  providerName: string
  /** 上下文（格式化如 1M；undefined 不显示）。 */
  contextWindow?: number
  /** 思考档（如 high；undefined 不显示）。 */
  thinking?: string
  /** 图片输入。 */
  imageInput: boolean
  /** 费用三档。 */
  pricing?: { cacheHit?: number; cacheMiss?: number; output?: number }
  /** 该模型所在 provider 的 settingsNs / settingsPath（编辑定位用）。 */
  settingsNs: string
  settingsPath: readonly string[]
  family: 'deepseek' | 'pi-ai' | undefined
}

/** 规格摘要行（上下文 · 思考 · 图片）。 */
export function specsOf(card: ModelCard): string {
  const parts: string[] = []
  if (card.contextWindow !== undefined) parts.push(`上下文 ${formatCapacity(card.contextWindow)}`)
  if (card.thinking !== undefined) parts.push('思考')
  if (card.imageInput) parts.push('图片')
  return parts.join(' · ')
}

/** 费用摘要行（命中/未命中/输出）。 */
export function priceOf(card: ModelCard): string {
  const p = card.pricing
  if (p === undefined) return '未配置费用'
  const fmt = (n: number | undefined): string => (n === undefined ? '—' : `¥${n}/M`)
  return `命中 ${fmt(p.cacheHit)} · 未命中 ${fmt(p.cacheMiss)} · 输出 ${fmt(p.output)}`
}

/**
 * 聚合已配置模型卡片。
 * @param state - 模型页 store 快照。
 * @param schema - settings schema 操作。
 * @returns 已配置（usable）provider 的所有模型卡片。
 */
export function collectModelCards(state: ModelsSettingsState, schema: SettingsSchemaOperations): ModelCard[] {
  const cards: ModelCard[] = []
  for (const row of state.rows) {
    if (!providerUsable(row)) continue
    const namespace = state.namespaces.get(row.entry.settingsNs)
    if (namespace === undefined) continue
    const family = familyOfNamespace(row.entry.settingsNs)
    const brand = brandOf(row.entry.provider) ?? brandOf(row.entry.settingsNs)
    // 读该 provider 的模型目录 id 列表。
    const listRaw = schema.getPath(namespace.value, [...row.entry.settingsPath, 'models'])
    const ids: string[] = Array.isArray(listRaw)
      ? listRaw
        .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
        .map(m => (typeof m.id === 'string' ? m.id : ''))
        .filter(s => s !== '')
      : []
    for (const modelId of ids) {
      const d = readModel(schema, namespace, row.entry.settingsPath, modelId)
      cards.push({
        provider: row.entry.provider,
        modelId,
        brand,
        providerName: row.entry.displayName,
        ...(d.contextWindow === undefined ? {} : { contextWindow: d.contextWindow }),
        ...(d.thinking === undefined ? {} : { thinking: d.thinking }),
        imageInput: d.imageInput,
        ...(d.pricing === undefined ? {} : { pricing: d.pricing }),
        settingsNs: row.entry.settingsNs,
        settingsPath: row.entry.settingsPath,
        family,
      })
    }
  }
  return cards
}

/* ── 两级结构：供应商卡片（主页）+ 其下模型卡（供应商详情） ── */

/** 一张供应商卡片（主页）。 */
export interface ProviderCard {
  provider: string
  providerName: string
  brand: Brand | undefined
  /** 副标题（官方目录路由 / 自定义 · baseURL）。 */
  desc: string
  /** 已配置模型数。 */
  modelCount: number
  /** 是否已连接（有密钥或可服务）。 */
  connected: boolean
  /** 该供应商的模型卡片。 */
  cards: ModelCard[]
  settingsNs: string
  settingsPath: readonly string[]
  family: 'deepseek' | 'pi-ai' | undefined
  /** 密钥引用（供应商配置卡显示用）。 */
  apiKeyEnv: string | undefined
  /** baseURL（自定义供应商显示；官方目录路由无）。 */
  baseURL: string | undefined
  row: import('./store.ts').ProviderRow
}

/**
 * 聚合已配置供应商卡片（主页两级结构的顶层）。只列 user 段真有配置的
 * 供应商（有密钥或自定义 route），未配置的内置 provider 不进主页
 * （去配置向导选）。与 ConfigureWizard.tsx 的 configuredProviders() 同口径
 * （user 段判据）：providerUsable 的宽口径会让无密钥要求的内置路由在 user
 * 段空时也判 usable，此函数在 namespace 存在分支再收窄为 user 段判据。
 */
export function collectProviderCards(state: ModelsSettingsState, schema: SettingsSchemaOperations): ProviderCard[] {
  const out: ProviderCard[] = []
  for (const row of state.rows) {
    if (!providerUsable(row)) continue
    const namespace = state.namespaces.get(row.entry.settingsNs)
    // fork（corum）：无 settingsNs 的 provider（如本地 Ollama，route 注册但无
    // 配置界面）不跳过，显示一张只读卡片。
    if (namespace === undefined) {
      if (row.entry.settingsNs === '') {
        const brand = brandOf(row.entry.provider) ?? { name: { en: row.entry.provider }, mark: row.entry.provider.slice(0, 2).toUpperCase(), color: '#888888' }
        const cards = state.routeModels.get(row.entry.provider) ?? []
        out.push({
          provider: row.entry.provider,
          providerName: row.entry.displayName,
          brand,
          desc: '本地模型 · 无需配置',
          modelCount: cards.length,
          connected: true,
          cards,
          settingsNs: '',
          settingsPath: [],
          family: undefined,
          apiKeyEnv: undefined,
          baseURL: undefined,
          row,
        })
      }
      continue
    }
    // 显示门控：只列 user 段真有配置的供应商，空配置内置路由（如 DeepSeek
    // Account，user 段为 {}）不进主页。与 ConfigureWizard.tsx 的
    // configuredProviders() 同口径（user 段判据），避免两套口径漂移：
    //   - 整节 provider（settingsPath 为空，如 llm-deepseek）→ user 段非空才显示；
    //   - path provider（自定义 route）→ schema.hasPath(user, settingsPath) 才显示。
    // providerUsable 的宽口径（active + apiKeyEnv===undefined → true）会让无密钥
    // 要求的内置路由（native-auth 或目录型）在 user 段空时也判 usable，这里收窄。
    // native-auth 内置（Bedrock/Vertex 空配置）同样不进主页，经向导配置后出现。
    const hasUserConfig = row.entry.settingsPath.length === 0
      ? Object.keys(namespace.user ?? {}).length > 0
      : schema.hasPath(namespace.user, row.entry.settingsPath)
    if (!hasUserConfig) continue
    const family = familyOfNamespace(row.entry.settingsNs)
    const brand = brandOf(row.entry.provider) ?? brandOf(row.entry.settingsNs)
    const isOfficial = row.entry.settingsNs === 'llm-deepseek'
    const baseURLRaw = schema.getPath(namespace.value, [...row.entry.settingsPath, 'baseURL'])
    const baseURL = typeof baseURLRaw === 'string' && baseURLRaw !== '' ? baseURLRaw : undefined
    const desc = isOfficial
      ? '官方目录路由'
      : `自定义${baseURL !== undefined ? ` · ${baseURL.replace(/^https?:\/\//, '')}` : ''}`
    // 该供应商的模型卡片（复用 collectModelCards 的单卡逻辑）。
    const listRaw = schema.getPath(namespace.value, [...row.entry.settingsPath, 'models'])
    const ids: string[] = Array.isArray(listRaw)
      ? listRaw
        .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
        .map(m => (typeof m.id === 'string' ? m.id : ''))
        .filter(s => s !== '')
      : []
    const cards: ModelCard[] = ids.map((modelId) => {
      const d = readModel(schema, namespace, row.entry.settingsPath, modelId)
      return {
        provider: row.entry.provider,
        modelId,
        brand,
        providerName: row.entry.displayName,
        ...(d.contextWindow === undefined ? {} : { contextWindow: d.contextWindow }),
        ...(d.thinking === undefined ? {} : { thinking: d.thinking }),
        imageInput: d.imageInput,
        ...(d.pricing === undefined ? {} : { pricing: d.pricing }),
        settingsNs: row.entry.settingsNs,
        settingsPath: row.entry.settingsPath,
        family,
      }
    })
    out.push({
      provider: row.entry.provider,
      providerName: row.entry.displayName,
      brand,
      desc,
      modelCount: cards.length,
      connected: row.credential?.configured === true || providerUsable(row),
      cards,
      settingsNs: row.entry.settingsNs,
      settingsPath: row.entry.settingsPath,
      family,
      apiKeyEnv: row.apiKeyEnv,
      baseURL,
      row,
    })
  }
  return out
}
