/**
 * 区域通道（国内 / 海外）：同一家厂商在 pi-ai 目录里有多条**独立路由**，
 * 区别只在端点所属区域，而**密钥不通用**——用国内站的 Key 打海外端点会得到
 * 401 Invalid Authentication（2026-11-06 实测：`platform.moonshot.cn` 的 Key 在
 * `api.moonshot.ai/v1` 上返回 `{"type":"invalid_authentication_error"}`，同一个 Key 在
 * `api.moonshot.cn/v1` 上 200）。
 *
 * 问题出在 UI：`brandOf()` 按关键字猜品牌，`moonshotai` 与 `moonshotai-cn` 都命中
 * `moonshot` ⇒ 品牌格出现两个一模一样的「月之暗面」，用户只能靠运气点。选错的
 * 后果不是「配置不生效」，而是**看起来配置成功、一发请求就 401**。
 *
 * 所以区域不能藏在同一个入口后面：品牌格里**每个区域各占一个卡片**，名字直接带
 * 区域（`月之暗面-中国` / `月之暗面-国际`）。用户看到的就是他要做的选择本身，
 * 不需要先点厂商、再点二段式开关（2026-11-06 用户定调：选择器不如平铺直给）。
 *
 * ## 表从哪来
 *
 * 每一条分组都对着 pi-ai 目录的 `baseUrl` 核过（`dist/providers/data/*.json`）：
 *
 * | 组 | 国内端点 | 海外端点 |
 * | --- | --- | --- |
 * | `moonshotai` | api.moonshot.cn/v1 | api.moonshot.ai/v1 |
 * | `minimax` | api.minimaxi.com/anthropic | api.minimax.io/anthropic |
 * | `zai` | open.bigmodel.cn | api.z.ai |
 * | `qwen-token-plan` | cn-beijing | ap-southeast-1（团队/个人两条订阅） |
 * | `xiaomi-token-plan` | token-plan-cn | token-plan-ams（美国）/ token-plan-sgp（新加坡） |
 *
 * **这张表只负责「给这些 route 加上区域名 + 排序」，绝不限制可选范围**——可选集合
 * 仍然只由 pi-ai 目录决定（见 `providerChoices`）：表里写了、目录里没有的变体不会
 * 出现（因为没有那一行）；目录里新出现、表里没写的路由照旧单独列出（只是名字不带区域）。
 */

/**
 * 多语言短文本（与 `brands.tsx` 的 `BrandName` 同形）。这里自带一份定义，
 * 免得 `brands.tsx` → 本模块 → `brands.tsx` 形成模块环。
 */
export interface RegionLabel {
  readonly en: string
  readonly [locale: string]: string
}

/** 区域变体的路由 id（真写进 `providers.<route>` 的键）。 */
export interface RegionVariant {
  /** provider route id，例如 `moonshotai-cn`。 */
  readonly id: string
  /** 区域归类：`cn` = 国内站；`global` = 海外站；`individual` = 海外个人订阅。 */
  readonly region: 'cn' | 'global' | 'individual'
  /** 选择器上的短标签（不写长句：选决策所需的最小信息）。 */
  readonly label: RegionLabel
}

/** 一家厂商的区域分组。 */
export interface RegionGroup {
  /** 分组键（取海外主线 route id，仅用于去重与查找）。 */
  readonly key: string
  /** 品牌显示名（分组共用一个，区域由选择器表达）。 */
  readonly name: RegionLabel
  /** 预览里的徽标与色值（与 `brands.tsx` 的品牌表同源）。 */
  readonly mark: string
  readonly color: string
  /** 全部候选变体（实际可选项还要与目录求交，见 `regionsFor`）。 */
  readonly variants: readonly RegionVariant[]
}

/** 标签用的多语言短词。 */
const both = (en_: string, zh: string): RegionLabel => ({ en: en_, zh })

const CN = both('China', '中国')
const GLOBAL = both('International', '国际')
const INDIVIDUAL = both('Individual', '个人')

/**
 * 区域分组表。**顺序即选择器顺序**：国内在前（中文界面下默认选中国内站）。
 *
 * 每加一家，必须先在 pi-ai 目录里核到两条不同 `baseUrl` 的路由，否则不要加：
 * 编造一条不存在的路由，用户点下去只会得到「provider 不存在」。
 */
export const REGION_GROUPS: readonly RegionGroup[] = [
  {
    key: 'moonshotai',
    name: both('Moonshot', '月之暗面'),
    mark: 'K',
    color: '#1A1A1A',
    variants: [
      { id: 'moonshotai-cn', region: 'cn', label: CN },
      { id: 'moonshotai', region: 'global', label: GLOBAL },
    ],
  },
  {
    key: 'minimax',
    name: both('MiniMax', 'MiniMax'),
    mark: 'M',
    color: '#6C5CE7',
    variants: [
      { id: 'minimax-cn', region: 'cn', label: CN },
      { id: 'minimax', region: 'global', label: GLOBAL },
    ],
  },
  {
    key: 'zai',
    name: both('Z.ai', '智谱'),
    mark: 'GLM',
    color: '#3B5BFD',
    variants: [
      { id: 'zai-coding-cn', region: 'cn', label: CN },
      { id: 'zai', region: 'global', label: GLOBAL },
    ],
  },
  {
    key: 'qwen-token-plan',
    name: both('Alibaba Bailian Token Plan', '阿里百炼 Token Plan'),
    mark: '百',
    color: '#FF6A00',
    variants: [
      { id: 'qwen-token-plan-cn', region: 'cn', label: CN },
      { id: 'qwen-token-plan', region: 'global', label: GLOBAL },
      { id: 'qwen-token-plan-individual', region: 'individual', label: INDIVIDUAL },
    ],
  },
  {
    key: 'xiaomi-token-plan',
    name: both('Xiaomi MiMo', '小米 MiMo'),
    mark: 'MI',
    color: '#FF6900',
    variants: [
      { id: 'xiaomi-token-plan-cn', region: 'cn', label: CN },
      // 小米的海外是三个**具体区域**而不是笼统的「国际」：分属不同端点，按国家直接命名。
      { id: 'xiaomi-token-plan-ams', region: 'global', label: both('United States', '美国') },
      { id: 'xiaomi-token-plan-sgp', region: 'global', label: both('Singapore', '新加坡') },
    ],
  },
]

/** route id → 所在分组（不在任何分组里返回 undefined）。 */
export function regionGroupOf(provider: string | undefined): RegionGroup | undefined {
  if (provider === undefined) return undefined
  return REGION_GROUPS.find(group => group.variants.some(v => v.id === provider))
}

/**
 * 变体的区域后缀（双语），由 `brands.tsx` 拼成供应商名：`月之暗面-中国` / `Moonshot-China`。
 *
 * 品牌格与已配置列表**共用**这一份后缀：用户在哪都要能一眼分清两条通道（它们是
 * 独立路由、密钥不通用），所以名字里必须带区域，而不是靠位置或图标区分。
 *
 * @param provider - provider route id。
 * @returns 中英后缀对，或 undefined 表示不是区域变体。
 */
export function regionSuffixPair(provider: string | undefined): { zh: string; en: string } | undefined {
  const group = regionGroupOf(provider)
  if (group === undefined) return undefined
  const variant = group.variants.find(v => v.id === provider)
  if (variant === undefined) return undefined
  return { zh: `-${variant.label.zh ?? variant.label.en}`, en: `-${variant.label.en}` }
}

/** 供测试与诊断：全部受管路由 id。 */
export function regionProviderIds(): string[] {
  return REGION_GROUPS.flatMap(g => g.variants.map(v => v.id))
}
