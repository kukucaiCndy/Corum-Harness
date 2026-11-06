/**
 * 供应商品牌徽标：文字缩写 + 品牌色（方案 A，对齐设计稿主页/向导）。
 * dsh 无品牌元数据，所以按 provider route id / settingsNs 映射到 corum 品牌表。
 * 自定义供应商给默认 cpu 图标（返回 undefined，调用方渲染 IconCpu）。
 *
 * ## 双语显示名
 *
 * 供应商名是**产品名词**，不是界面文案：它不能进 `locales.ts` 的键值字典
 * （那需要为每家供应商手写一个键，等于又建一份自维护清单），而应随名称一起携带
 * 多语言取值。所以 `name` 用官方的 `LocalizedText` 形态（`{ en, zh }`），由
 * `brandNameOf()` 按当前语言解析（本仓 locale 包是 0.1.5-rc.3，未提供 resolveText）。
 *
 * 未提供中文的品牌（海外厂商）只写 `en`，中文界面下自然落到英文——这比造一个
 * 生硬音译更符合实际用法。
 */

import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'
import { regionGroupOf, regionSuffixPair } from './regions.ts'

/** 供应商显示名：单语字符串，或 `{ en, zh }` 多语言映射（官方 LocalizedText 形态）。 */
export interface BrandName {
  readonly en: string
  readonly [locale: string]: string
}

export interface Brand {
  /** 显示名；多语言用 `{ en, zh }`。 */
  name: BrandName
  /** 徽标文字（缩写/单字）。 */
  mark: string
  /** 品牌色（hex；token 体系外的固定品牌资产，属设计稿既定值）。 */
  color: string
}

/** 只给英文的简写（海外厂商不造中文音译）。 */
const en = (text: string): BrandName => ({ en: text })

/** 中英双语。 */
const both = (en_: string, zh: string): BrandName => ({ en: en_, zh })

/**
 * 给品牌名加上区域后缀（`月之暗面` → `月之暗面（国内）`）。
 *
 * 只对**区域变体路由**生效——它们是同品牌的两条独立通道，密钥不通用（见
 * `regions.ts` 模块头）。不加后缀的话，`moonshotai` 与 `moonshotai-cn` 在已配置
 * 列表里显示成两个一模一样的「月之暗面」，用户无法判断该在哪条上填 Key。
 *
 * @param brand - 品牌（含基础名）。
 * @param provider - provider route id。
 * @returns 带区域后缀的名字；非区域变体原样返回。
 */
function withRegion(brand: Brand, provider: string): Brand {
  const suffix = regionSuffixPair(provider)
  if (suffix === undefined) return brand
  const { name } = brand
  const zh = name.zh ?? name.en
  return { ...brand, name: { ...name, en: `${name.en}${suffix.en}`, zh: `${zh}${suffix.zh}` } }
}

/** provider route id / 关键字 → 品牌。匹配用 includes 小写。 */
const BRANDS: ReadonlyArray<readonly [string, Brand]> = [
  ['deepseek', { name: both('DeepSeek', '深度求索'), mark: 'DS', color: '#4D6BFE' }],
  // 阿里百炼有三条独立通道（不同区域/订阅），显示名必须能区分，否则用户看到三个
  // 一模一样的「阿里百炼」无从选择。差异是实测的：
  //   -cn         cn-beijing 节点，18 个模型（团队/企业订阅）
  //   （无后缀）    ap-southeast-1 节点，18 个模型（海外）
  //   -individual ap-southeast-1 节点， 9 个模型（个人订阅，模型更少）
  // 区域/订阅差别由 `regions.ts` 的后缀统一表达（见 withRegion），这里不重复写。
  ['qwen-token-plan-cn', { name: both('Alibaba Bailian', '阿里百炼'), mark: '百', color: '#FF6A00' }],
  ['qwen-token-plan-individual', { name: both('Alibaba Bailian', '阿里百炼'), mark: '百', color: '#FF6A00' }],
  ['qwen-token-plan', { name: both('Alibaba Bailian', '阿里百炼'), mark: '百', color: '#FF6A00' }],
  ['qwen', { name: both('Qwen', '通义千问'), mark: '千', color: '#FF6A00' }],
  ['zai', { name: both('Z.ai', '智谱'), mark: 'GLM', color: '#3B5BFD' }],
  ['glm', { name: both('GLM', '智谱'), mark: 'GLM', color: '#3B5BFD' }],
  ['moonshot', { name: both('Moonshot', '月之暗面'), mark: 'K', color: '#1A1A1A' }],
  ['kimi-coding', { name: both('Kimi Code', 'Kimi Code'), mark: 'K', color: '#1A1A1A' }],
  ['kimi', { name: both('Kimi', '月之暗面'), mark: 'K', color: '#1A1A1A' }],
  ['minimax', { name: both('MiniMax', 'MiniMax'), mark: 'M', color: '#6C5CE7' }],
  ['volcengine', { name: both('Volcengine Ark', '火山方舟'), mark: '火', color: '#325AB4' }],
  ['volc', { name: both('Volcengine Ark', '火山方舟'), mark: '火', color: '#325AB4' }],
  ['xiaomi-token-plan', { name: both('Xiaomi MiMo', '小米 MiMo'), mark: 'MI', color: '#FF6900' }],
  ['xiaomi', { name: both('Xiaomi', '小米'), mark: 'MI', color: '#FF6900' }],
  ['anthropic', { name: en('Anthropic'), mark: 'A', color: '#D97757' }],
  ['openai', { name: en('OpenAI'), mark: '✦', color: '#10A37F' }],
  ['google', { name: en('Google'), mark: 'G', color: '#4285F4' }],
  ['openrouter', { name: en('OpenRouter'), mark: 'OR', color: '#6366F1' }],
  ['xai', { name: en('xAI'), mark: 'X', color: '#1A1A1A' }],
  ['mistral', { name: en('Mistral'), mark: 'M', color: '#FF7000' }],
  ['ollama', { name: en('Ollama'), mark: '🦙', color: '#22C55E' }],
  ['groq', { name: en('Groq'), mark: 'Q', color: '#F55036' }],
  ['bedrock', { name: en('AWS Bedrock'), mark: 'B', color: '#FF9900' }],
  ['azure', { name: en('Azure'), mark: 'Az', color: '#0078D4' }],
]

/**
 * Providers kept at the top of the wizard's brand grid, in this order.
 *
 * **This is a presentation preference, never a whitelist.** The set of providers
 * the user may add comes from pi-ai's own catalog, surfaced through the host's
 * provider directory (`state.rows`) — see {@link providerChoices}. This list only
 * decides which of those appear above the "更多" fold, so a commonly used route is
 * one click away instead of buried among three dozen.
 *
 * A route in here that pi-ai no longer ships simply stops matching and drops out,
 * and a provider pi-ai adds appears under "更多" automatically. That asymmetry is
 * the point: forgetting to update this list degrades presentation, never
 * functionality.
 */
const PINNED: readonly string[] = [
  'deepseek',
  // 阿里百炼：token plan 通道（内含千问/DeepSeek/GLM/Kimi/MiniMax 五家 18 个模型）。
  // 「千问」只是其中一族，所以显示名用平台名而非模型名。
  'qwen-token-plan-cn',
  'zai',
  'moonshotai',
  'kimi-coding',
  'minimax',
  // 火山方舟：方舟平台的豆包模型入口（第三方通道，见 CUSTOM_TEMPLATES）。
  'volcengine-ark',
  'anthropic',
  'openai',
  'google',
]

/**
 * Resolve a {@link BrandName} against an active locale id.
 *
 * Mirrors the locale service's own fallback rule: try the exact id, then its
 * language subtag, then English. The installed `dsh-client-locale` (0.1.5-rc.3)
 * exposes `getLocale().active` but not a `resolveText` helper, so the two-line
 * chain lives here instead of reaching for an API this version does not ship.
 *
 * @param name - the brand's multilingual name.
 * @param active - active locale id, e.g. `zh-CN` or `en`.
 * @returns the display string in that language, falling back to English.
 */
export function brandNameOf(name: BrandName, active: string): string {
  const id = active.toLowerCase()
  return name[id] ?? name[id.split('-')[0] ?? ''] ?? name.en
}

/**
 * Third-party channels that pi-ai does not ship a route for.
 *
 * They are **not** pi-ai providers, so they must not pretend to be one: the wizard
 * prefills a custom route (protocol + base URL) from these instead. Keeping them in
 * a separate list is what makes the distinction honest — `providerChoices` unions
 * them with the live directory, but nothing here can ever shadow or replace an
 * upstream route, and removing a vendor is a one-line deletion rather than a hunt
 * through a 13-line "official" list.
 *
 * 火山方舟（Volcengine Ark）是豆包模型的唯一来源，pi-ai 39 家 route 里没有任何一个
 * 指向 volces，所以它只有走自定义通道这一条路。
 */
export interface CustomTemplate {
  /** Route id the wizard writes for the custom provider. */
  readonly id: string
  readonly name: BrandName
  readonly mark: string
  readonly color: string
  /** Wire protocol the endpoint speaks. */
  readonly api: 'openai-completions' | 'anthropic-messages'
  /** Base URL prefilled in the custom-provider form. */
  readonly baseUrl: string
  /** Seed model ids, so the user is not staring at an empty list. */
  readonly models: readonly string[]
}

/** Third-party channels offered alongside the pi-ai directory. */
export const CUSTOM_TEMPLATES: readonly CustomTemplate[] = [
  {
    id: 'volcengine-ark',
    name: both('Volcengine Ark', '火山方舟'),
    mark: '火',
    color: '#325AB4',
    api: 'openai-completions',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-seed-1-6-flash-250615'],
  },
]

/** One choice in the wizard's brand grid. */
export interface ProviderChoice extends Brand {
  /** The provider route key the wizard writes (区域变体各写自己的 route id). */
  readonly id: string
}

/**
 * Turn the live provider directory into brand-grid choices.
 *
 * @param rows - `state.rows`, i.e. pi-ai's configurable-provider directory joined
 *   with whatever routes are currently registered.
 * @returns pinned providers first (in {@link PINNED} order), then the rest
 *   alphabetically. Every row appears exactly once.
 */
export function providerChoices(rows: ReadonlyArray<{ provider: string; displayName: string }>): ProviderChoice[] {
  const byId = new Map<string, ProviderChoice>()
  // Third-party channels first: they are never in the directory, and a same-id
  // upstream route (should pi-ai ever ship one) wins by overwriting below.
  for (const t of CUSTOM_TEMPLATES) byId.set(t.id, { id: t.id, name: t.name, mark: t.mark, color: t.color })
  for (const row of rows) {
    // Skip the directory's probe pseudo-route: it exists to name a schema node, not
    // to be configured. Mirrors the filter the models list already applies.
    if (row.provider.startsWith('\u0000')) continue
    // 区域变体**不合并**：`月之暗面-中国` 与 `月之暗面-国际` 各占一个卡片，名字自带
    // 区域（`withRegion` 加后缀）。平铺直给比「先选厂商、再二段式切区域」少一步，
    // 也少一类「看着一样其实选错了」的误配（2026-11-06 用户定调）。
    byId.set(row.provider, {
      ...(brandOf(row.provider) ?? { name: { en: row.displayName }, mark: initialOf(row.displayName), color: '#6B7280' }),
      id: row.provider,
    })
  }
  // 排序名次按「组内任一变体被置顶即视为置顶」：PINNED 里只写了 `moonshotai`，
  // 但 `moonshotai-cn` 必须并排出现在常用区，否则「中国」那条又被折进「更多」里。
  const rank = new Map<string, number>()
  PINNED.forEach((id, index) => rank.set(id, index))
  const rankOf = (id: string): number | undefined => {
    const own = rank.get(id)
    const group = regionGroupOf(id)
    if (group === undefined) return own
    const ranks = group.variants.map(v => rank.get(v.id)).filter((r): r is number => r !== undefined)
    const best = ranks.length === 0 ? undefined : Math.min(...ranks)
    if (best === undefined) return own
    return own === undefined ? best : Math.min(own, best)
  }
  return [...byId.values()].sort((a, b) => {
    // 同一家厂商的区域变体必须**按分组表声明序**相邻排列，压过下面所有规则：
    // 否则未置顶的厂商会退化成按英文名排（`-Singapore` 会排到 `-United States` 前面）。
    const ga = regionGroupOf(a.id)?.key
    if (ga !== undefined && ga === regionGroupOf(b.id)?.key) return regionOrderOf(a.id) - regionOrderOf(b.id)
    const ra = rankOf(a.id)
    const rb = rankOf(b.id)
    if (ra !== undefined && rb !== undefined) {
      if (ra !== rb) return ra - rb
      // 同一组（同一次置顶）内按区域牌序：中国 → 国际 → 个人，稳定且与语言无关。
      const va = regionOrderOf(a.id)
      const vb = regionOrderOf(b.id)
      return va - vb
    }
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    // Sort by the English name: it is present on every entry and keeps the order
    // identical across languages, so switching locale never reshuffles the grid.
    return a.name.en.localeCompare(b.name.en)
  })
}

/** Providers the wizard shows above the fold. */
export function isPinnedProvider(id: string): boolean {
  if (PINNED.includes(id)) return true
  return regionGroupOf(id)?.variants.some(v => PINNED.includes(v.id)) ?? false
}

/**
 * 区域变体在组内的展示顺序：**按分组表里的声明序**（中国 → 国际 / 美国 / 新加坡 → …）。
 *
 * 不按 `region` 归类排（那样美国与新加坡同为 global 会互相打架、顺序取决于目录行序），
 * 表序是唯一确定的：改表即改顺序，用户看到的顺序与代码里读到的顺序同一套。
 */
function regionOrderOf(id: string): number {
  const group = regionGroupOf(id)
  if (group === undefined) return 0
  const index = group.variants.findIndex(v => v.id === id)
  return index === -1 ? 0 : index
}

/** Last-resort monogram for a provider with no brand entry. */
function initialOf(name: string): string {
  const first = [...name.trim()][0]
  return first === undefined ? '?' : first.toUpperCase()
}

/** 按 provider route id / settingsNs 推品牌。未知返回 undefined（自定义默认图标）。 */
export function brandOf(key: string | undefined): Brand | undefined {
  if (key === undefined) return undefined
  const k = key.toLowerCase()
  // Longest keyword wins, so `kimi-coding` cannot be swallowed by the shorter
  // `kimi` — and the result no longer depends on array order. This was a real bug
  // (it made Kimi Code display as 月之暗面) that only passed review because the
  // longer entry happened to sit first.
  let best: readonly [string, Brand] | undefined
  for (const entry of BRANDS) {
    const [kw] = entry
    if (!k.includes(kw)) continue
    if (best === undefined || kw.length > best[0].length) best = entry
  }
  return best === undefined ? undefined : withRegion(best[1], k)
}

/** 品牌徽标（品牌色方块 + 缩写）。未知品牌调用方传 fallback（IconCpu）。 */
export function BrandLogo({ brand, size = 30, fallback }: {
  brand: Brand | undefined
  size?: number
  fallback?: ReactNode
}): ReactNode {
  if (brand === undefined) {
    return (
      <span className={styles['brandLogo']} style={{ width: size, height: size }}>
        {fallback}
      </span>
    )
  }
  const fontSize = brand.mark.length > 1 ? Math.round(size * 0.34) : Math.round(size * 0.44)
  return (
    <span
      className={styles['brandLogo']}
      style={{ width: size, height: size, background: brand.color, fontSize }}
      aria-hidden
    >
      {brand.mark}
    </span>
  )
}
