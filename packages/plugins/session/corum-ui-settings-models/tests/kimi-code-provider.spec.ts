import { describe, expect, it } from 'vitest'
import { brandNameOf, brandOf, providerChoices } from '../src/client/brands.tsx'

describe('Kimi Code 供应商入口', () => {
  it('为会员编程额度提供独立原生路由，不复用普通 Moonshot API', () => {
    // 可选范围已改由 pi-ai 目录决定，这里用一份等价目录喂进去验证品牌区分。
    const choices = providerChoices([
      { provider: 'kimi-coding', displayName: 'kimi-coding' },
      { provider: 'moonshotai', displayName: 'moonshotai' },
    ])
    expect(choices.find(provider => provider.id === 'kimi-coding')?.name.en).toBe('Kimi Code')
    expect(choices.find(provider => provider.id === 'moonshotai')?.name.en).toBe('Moonshot')
  })

  it('Kimi Code 与月之暗面是两条独立路由，品牌不互相污染', () => {
    const choices = providerChoices([
      { provider: 'kimi-coding', displayName: 'kimi-coding' },
      { provider: 'moonshotai', displayName: 'moonshotai' },
    ])
    // 只断言这两家都在结果里（自定义模板也会出现，不能整体比较）
    const ids = choices.map(c => c.id)
    expect(ids).toContain('kimi-coding')
    expect(ids).toContain('moonshotai')
    expect(brandOf('kimi-coding')?.name.en).toBe('Kimi Code')
    // 区域后缀是 2026-11-06 有意加的（见 regions.ts）：`moonshotai` 是**海外**那条
    // 独立路由，国内站是 `moonshotai-cn`，两者 Key 不通用 ⇒ 名字必须能区分。
    expect(brandOf('moonshotai')?.name.en).toBe('Moonshot (Global)')
  })

  it('原生路由在供应商卡片中显示为 Kimi Code', () => {
    expect(brandOf('kimi-coding')?.name.en).toBe('Kimi Code')
    expect(brandOf('KIMI-CODING')?.name.en).toBe('Kimi Code')
  })

  it('普通 Moonshot API 和既有自定义 Kimi 路由保持原有品牌', () => {
    // 区域变体带区域后缀（国内/海外是两条独立路由），自定义路由不带。
    expect(brandNameOf(brandOf('moonshotai-cn')!.name, 'zh-CN')).toBe('月之暗面（国内）')
    expect(brandNameOf(brandOf('my-kimi-api')!.name, 'zh-CN')).toBe('月之暗面')
  })

  it('kimi-coding 不会被更短的 kimi 关键字吞掉（顺序无关）', () => {
    // 这是实际发生过的 bug：Kimi Code 一度显示成「月之暗面」。
    expect(brandOf('kimi-coding')?.name.en).toBe('Kimi Code')
    expect(brandOf('kimi')?.name.en).toBe('Kimi')
  })
})
