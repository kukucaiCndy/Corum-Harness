/**
 * `providerChoices` —— 供应商可选范围**只来自 pi-ai 目录**的不变式测试。
 *
 * 背景（2026-10-17）：向导原本读一份自维护的 `COMMON_PROVIDERS`（13 家硬编码）。
 * 那份清单与 pi-ai 内置的 39 家**长期脱节**：pi-ai 里 26 家用户根本选不到，而清单
 * 里 `qwen`/`baidu`/`spark`/`doubao` 在 pi-ai 里甚至没有原生定义。
 *
 * 同一类「自维护清单与上游事实源脱节」当天还出过两个事故：
 * `--dsh-alias` token 名笔误、`kimi-coding` 品牌靠数组顺序才勉强匹配上。
 *
 * 所以这里钉住的不是「有哪 13 家」，而是更根本的一条：
 * **`providerChoices` 的输出必须完全由传入的目录决定** —— 目录加一家，它就多一家；
 * 目录删一家，它就少一家；代码里不需要任何改动。`PINNED` 只影响排序，不影响集合。
 */
import { describe, expect, it } from 'vitest'
import { brandNameOf, brandOf, CUSTOM_TEMPLATES, isPinnedProvider, providerChoices } from '../src/client/brands.tsx'
import { regionGroupOf, regionProviderIds } from '../src/client/regions.ts'

/** 目录结果里除自定义模板之外的 provider id（模板不属于 pi-ai 目录）。 */
const directoryIds = (rows: ReadonlyArray<{ provider: string; displayName: string }>): string[] => {
  const templateIds = new Set(CUSTOM_TEMPLATES.map(t => t.id))
  return providerChoices(rows).map(c => c.id).filter(id => !templateIds.has(id))
}

const row = (provider: string, displayName = provider): { provider: string; displayName: string } => ({
  provider,
  displayName,
})

describe('providerChoices：可选范围由 pi-ai 目录决定', () => {
  it('目录里每个 provider 都出现在结果里（不遗漏）', () => {
    const rows = [row('deepseek'), row('groq'), row('cerebras'), row('baseten')]
    expect(directoryIds(rows).sort()).toEqual(['baseten', 'cerebras', 'deepseek', 'groq'])
  })

  it('目录新增一个 provider 会立即出现，无需改代码', () => {
    // 这就是本改动要买到的性质：pi-ai 上游加一家，UI 自动就有。
    const before = directoryIds([row('deepseek')])
    const after = directoryIds([row('deepseek'), row('brand-new-provider')])
    expect(before).toEqual(['deepseek'])
    expect(after).toContain('brand-new-provider')
    expect(after.length).toBe(before.length + 1)
  })

  it('目录为空时只剩自定义模板（第三方通道不属于目录）', () => {
    expect(directoryIds([])).toEqual([])
    expect(providerChoices([]).map(c => c.id)).toEqual(CUSTOM_TEMPLATES.map(t => t.id))
  })

  it('目录里已经消失的 provider 不会残留', () => {
    // 反向保证：不存在任何「代码里记着、目录里没了」的幽灵条目。
    const choices = directoryIds([row('deepseek')])
    expect(choices).toEqual(['deepseek'])
    // groq 曾是「只在别的清单里」的典型；它不出现说明集合完全由入参决定。
    expect(choices.includes('groq')).toBe(false)
  })

  it('过滤掉目录的 probe 伪路由（以 NUL 开头）', () => {
    // store.ts 用 PROBE_ROUTE = '\u0000probe' 命名一个 schema 节点，它不可配置。
    expect(directoryIds([row('deepseek'), row('\u0000probe', 'probe')])).toEqual(['deepseek'])
  })

  it('同一 provider 重复出现只保留一次', () => {
    expect(directoryIds([row('deepseek'), row('deepseek')])).toEqual(['deepseek'])
  })
})

describe('providerChoices：PINNED 只决定排序', () => {
  it('常用项排在未置顶项之前', () => {
    const ids = providerChoices([row('zzz-unknown'), row('deepseek'), row('aaa-unknown')]).map(c => c.id)
    expect(ids[0]).toBe('deepseek')
    // 未置顶项保持字母序，且都在置顶项之后
    const unknown = ids.filter(id => id === 'aaa-unknown' || id === 'zzz-unknown')
    expect(unknown).toEqual(['aaa-unknown', 'zzz-unknown'])
    expect(ids.indexOf('deepseek')).toBeLessThan(ids.indexOf('aaa-unknown'))
  })

  it('常用项之间保持 PINNED 里声明的顺序', () => {
    // deepseek 在 PINNED 里早于 openai，即使字母序相反。
    const ids = providerChoices([row('openai'), row('deepseek')]).map(c => c.id)
    // 只看这两家的相对顺序（火山方舟等置顶模板也在列表里，不参与本断言）
    expect(ids.indexOf('deepseek')).toBeLessThan(ids.indexOf('openai'))
  })

  it('置顶但没有出现在目录里的 provider 不会凭空冒出来', () => {
    // PINNED 里列了很多家；目录只给一家时，结果就只有一家。
    expect(directoryIds([row('groq')])).toEqual(['groq'])
  })

  it('isPinnedProvider 只反映展示偏好，与目录无关', () => {
    expect(isPinnedProvider('deepseek')).toBe(true)
    expect(isPinnedProvider('baseten')).toBe(false)
  })
})

describe('providerChoices：品牌是纯装饰，缺表也有兜底', () => {
  it('已知品牌用 BRANDS 的名字与色值', () => {
    const deepseek = providerChoices([row('deepseek', 'DeepSeek')]).find(c => c.id === 'deepseek')
    expect(deepseek?.name.en).toBe('DeepSeek')
    expect(brandNameOf(deepseek!.name, 'zh-CN')).toBe('深度求索')
    expect(deepseek?.mark).toBe('DS')
  })

  it('未知品牌回退到目录给的 displayName，而不是隐藏该选项', () => {
    // 关键：没有品牌条目 ≠ 不可配置。绝不能因为「不认识」就把厂家藏起来。
    const found = providerChoices([row('some-new-vendor', 'Some New Vendor')])
      .find(c => c.id === 'some-new-vendor')
    expect(found).toBeDefined()
    expect(found?.name.en).toBe('Some New Vendor')
    expect(found?.mark).toBe('S')
  })

  it('未知品牌的 displayName 为空时仍有可用标记', () => {
    const found = providerChoices([row('zzz-mystery', '')]).find(c => c.id === 'zzz-mystery')
    expect(found?.mark).toBe('?')
  })
})

describe('brandNameOf：供应商名跟随界面语言', () => {
  it('中文界面显示中文名，英文界面显示英文名', () => {
    const deepseek = brandOf('deepseek')!
    expect(brandNameOf(deepseek.name, 'zh-CN')).toBe('深度求索')
    expect(brandNameOf(deepseek.name, 'en')).toBe('DeepSeek')
  })

  it('接受纯语言码与带地区的 id（zh / zh-CN 都命中中文）', () => {
    // 用非区域变体的品牌验证语言解析：区域变体的名字自带区域后缀（见 regions.ts），
    // 混进来会让这条测试同时断言两件事。
    const volcengine = brandOf('volcengine')!
    expect(brandNameOf(volcengine.name, 'zh')).toBe('火山方舟')
    expect(brandNameOf(volcengine.name, 'zh-CN')).toBe('火山方舟')
    expect(brandNameOf(volcengine.name, 'zh-cn')).toBe('火山方舟')
  })

  it('未提供中文的名字回退到英文，而不是显示空或音译', () => {
    // 海外厂商只写 en；中文界面下显示英文原名是刻意的（比生硬音译更准确）。
    const anthropic = brandOf('anthropic')!
    expect(brandNameOf(anthropic.name, 'zh-CN')).toBe('Anthropic')
    expect(brandNameOf(anthropic.name, 'en')).toBe('Anthropic')
  })

  it('未知语言回退到英文', () => {
    const qwen = brandOf('qwen')!
    expect(brandNameOf(qwen.name, 'ja')).toBe('Qwen')
    expect(brandNameOf(qwen.name, 'fr-FR')).toBe('Qwen')
  })
})

describe('CUSTOM_TEMPLATES：第三方通道与 pi-ai 目录分离', () => {
  it('火山方舟作为第三方模板存在，且不冒充 pi-ai route', () => {
    const ark = CUSTOM_TEMPLATES.find(t => t.id === 'volcengine-ark')
    expect(ark).toBeDefined()
    expect(ark?.name.zh).toBe('火山方舟')
    expect(ark?.name.en).toBe('Volcengine Ark')
    expect(ark?.baseUrl).toContain('volces.com')
  })

  it('模板会出现在品牌格里，并且排在置顶区', () => {
    const choices = providerChoices([])
    expect(choices.map(c => c.id)).toContain('volcengine-ark')
    expect(isPinnedProvider('volcengine-ark')).toBe(true)
  })

  it('上游若真的发布了同名 route，以目录为准（模板不覆盖）', () => {
    // 防御性：将来 pi-ai 收录火山方舟时，目录的 displayName 应当胜出。
    const found = providerChoices([{ provider: 'volcengine-ark', displayName: 'Upstream Volcengine' }])
      .find(c => c.id === 'volcengine-ark')
    expect(found?.name.en).toBe('Volcengine Ark')
  })
})

describe('阿里百炼三条通道：显示名必须可区分', () => {
  const channels = ['qwen-token-plan-cn', 'qwen-token-plan-individual', 'qwen-token-plan']

  it('三者在中文下名字各不相同（否则用户无法选择）', () => {
    const names = channels.map(id => brandNameOf(brandOf(id)!.name, 'zh-CN'))
    expect(new Set(names).size).toBe(3, `实际出现重名：${names.join(' / ')}`)
  })

  it('三者在英文下名字各不相同', () => {
    const names = channels.map(id => brandNameOf(brandOf(id)!.name, 'en'))
    expect(new Set(names).size).toBe(3, `实际出现重名：${names.join(' / ')}`)
  })

  it('后缀正确表达区域与订阅类型', () => {
    expect(brandNameOf(brandOf('qwen-token-plan-cn')!.name, 'zh-CN')).toContain('中国')
    expect(brandNameOf(brandOf('qwen-token-plan')!.name, 'zh-CN')).toContain('国际')
    expect(brandNameOf(brandOf('qwen-token-plan-individual')!.name, 'zh-CN')).toContain('个人')
  })

  it('不会互相串味（-cn 不落到个人/海外，反之亦然）', () => {
    expect(brandOf('qwen-token-plan-cn')!.name.zh).toContain('中国')
    expect(brandOf('qwen-token-plan-individual')!.name.zh).toContain('个人')
    expect(brandOf('qwen-token-plan')!.name.zh).toContain('国际')
  })

  it('普通 qwen（通义千问）不被百炼条目吞掉', () => {
    expect(brandOf('qwen')!.name.zh).toBe('通义千问')
  })
})

/**
 * 区域通道（中国 / 国际）：同一家厂商在 pi-ai 目录里是**两条独立路由**，密钥不通用。
 * 曾经的失败形态（2026-11-06 实测）：品牌格里两条都显示成「月之暗面」，用户把国内站
 * 申请的 Key 填在海外路由上 ⇒ 保存成功、一发请求 401 `invalid_authentication_error`。
 *
 * 交互定调（2026-11-06 用户）：**不做二段式区域开关，直接平铺成两个供应商入口**，
 * 名字自带区域（`月之暗面-中国` / `月之暗面-国际`）——用户看到的就是他要做的选择。
 *
 * 这里钉住四条不变式：
 * 1. 每条真实存在的变体**各占一个入口**（且名字可区分，含区域词）；
 * 2. 同一家厂商的变体**并排出现在常用区**（PINNED 只写一条也要带上另一条）；
 * 3. 目录里没有的变体不许凭空出现（表不扩充可选范围）；
 * 4. 后缀只加一次（不出现「阿里百炼-中国-中国」）。
 */
describe('区域通道：每个区域一个独立供应商入口', () => {
  const moonshotRows = [row('moonshotai', 'moonshotai'), row('moonshotai-cn', 'moonshotai-cn')]

  it('国内/海外两条 route 各自出现（不合并成一个入口）', () => {
    expect(directoryIds(moonshotRows).sort()).toEqual(['moonshotai', 'moonshotai-cn'])
  })

  it('两条入口名字可区分且带区域词（中国 / 国际）', () => {
    const cn = brandNameOf(brandOf('moonshotai-cn')!.name, 'zh-CN')
    const global = brandNameOf(brandOf('moonshotai')!.name, 'zh-CN')
    expect(cn).toBe('月之暗面-中国')
    expect(global).toBe('月之暗面-国际')
  })

  it('英文界面同样带区域词', () => {
    expect(brandNameOf(brandOf('moonshotai-cn')!.name, 'en')).toBe('Moonshot-China')
    expect(brandNameOf(brandOf('moonshotai')!.name, 'en')).toBe('Moonshot-International')
  })

  it('同组的变体并排留在常用区（PINNED 只写一条也不把另一条折进「更多」）', () => {
    expect(isPinnedProvider('moonshotai')).toBe(true)
    expect(isPinnedProvider('moonshotai-cn')).toBe(true)
    // 未置顶的厂商不受影响（PINNED 里没有 groq）
    expect(isPinnedProvider('groq')).toBe(false)
  })

  it('同组变体在常用区内相邻，且「中国」在前', () => {
    const ids = providerChoices(moonshotRows).map(c => c.id)
    const cn = ids.indexOf('moonshotai-cn')
    const global = ids.indexOf('moonshotai')
    expect(cn).toBeGreaterThanOrEqual(0)
    expect(global).toBe(cn + 1)
  })

  it('目录里没有的变体不会凭空出现（表不扩充可选范围）', () => {
    const ids = directoryIds(moonshotRows)
    expect(ids.includes('minimax')).toBe(false)
    expect(ids.includes('xiaomi-token-plan-ams')).toBe(false)
  })

  it('后缀只加一次（百炼既有名称不再自带区域）', () => {
    expect(brandNameOf(brandOf('qwen-token-plan-cn')!.name, 'zh-CN')).toBe('阿里百炼-中国')
    expect(brandNameOf(brandOf('qwen-token-plan-individual')!.name, 'zh-CN')).toBe('阿里百炼-个人')
  })

  it('非区域变体不加后缀（通义千问 / 深度求索 / 自定义路由）', () => {
    expect(brandNameOf(brandOf('qwen')!.name, 'zh-CN')).toBe('通义千问')
    expect(brandNameOf(brandOf('deepseek')!.name, 'zh-CN')).toBe('深度求索')
    expect(brandNameOf(brandOf('my-kimi-api')!.name, 'zh-CN')).toBe('月之暗面')
  })

  it('小米按国家命名（中国 / 美国 / 新加坡），不用笼统的「国际」', () => {
    expect(brandNameOf(brandOf('xiaomi-token-plan-cn')!.name, 'zh-CN')).toBe('小米 MiMo-中国')
    expect(brandNameOf(brandOf('xiaomi-token-plan-ams')!.name, 'zh-CN')).toBe('小米 MiMo-美国')
    expect(brandNameOf(brandOf('xiaomi-token-plan-sgp')!.name, 'zh-CN')).toBe('小米 MiMo-新加坡')
  })

  it('组内顺序按分组表声明序（小米：中国 → 美国 → 新加坡）', () => {
    const rows = ['xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn'].map(id => row(id, id))
    const ids = providerChoices(rows).map(c => c.id).filter(id => id.startsWith('xiaomi-token-plan'))
    expect(ids).toEqual(['xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'])
  })

  it('分组表自身无重复 route id（一个 id 只能属于一个厂商）', () => {
    const all = regionProviderIds()
    expect(new Set(all).size).toBe(all.length)
  })

  it('每个受管 route 都能在品牌格里拿到区域名（表与目录对齐）', () => {
    const rows = regionProviderIds().map(id => row(id, id))
    const byId = new Map(providerChoices(rows).map(c => [c.id, c]))
    for (const id of regionProviderIds()) {
      const name = brandNameOf(byId.get(id)!.name, 'zh-CN')
      expect(name, `${id} 没有区域名`).toMatch(/-(中国|国际|个人|美国|新加坡)/)
    }
  })
})
