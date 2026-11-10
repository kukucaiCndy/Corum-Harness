/**
 * @corum/corum-web-search 的语义回归网。
 *
 * 覆盖用户诉求里三条**必须成立**的语义：
 *   ① 默认子 provider 是 DeepSeek（且它读的是官方 `web-search-deepseek` 设置面 ⇒
 *      配了 DEEPSEEK_API_KEY 就能用，无需任何新配置）；
 *   ② 切换激活项后 `search()` 委托给新项（切换即时生效）；
 *   ③ `available()` 是廉价本地检查，**不做任何网络调用**（dsh 契约
 *      `types.d.ts:100`：`Cheap local usability check; must not make network calls.`）。
 *
 * 另外把两条**刻意的设计决定**钉成断言，避免以后被「顺手改成更合理的样子」：
 *   - 激活项不可用而存在其它可用子 provider 时，聚合 provider 仍 `available() === true`
 *     （保证 overlay pin 常态可解析），失败留给 `search()` 出一句指名道姓的错误；
 *   - 激活项未注册/不可用时**不静默回落**到别的供应商。
 *
 * 为什么不用真 cordis 装配：聚合逻辑全部在 `AggregateWebSearch` 里（纯类），装配只
 * 是把它注册进 `ctx.web`（三行 effect）。真装配要起整套 dsh 组合，收益为零；装配面
 * 由实机 CDP 验证负责（见报告：UI/装配级效果未经实机验证）。
 *
 * @module @corum/corum-web-search/tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from '@deepseek-ai/dsh-web-search-deepseek'
import type { WebSearchSubProvider } from '../src/types.ts'
import { AggregateWebSearch } from '../src/aggregate.ts'
import {
  createDeepSeekSubProvider,
  currentDeepSeekSection,
  DEEPSEEK_SUB_PROVIDER_ID,
  resolveDeepSeekOptions,
} from '../src/deepseek-sub-provider.ts'
import { CORUM_WEB_SEARCH_PROVIDER_ID, CORUM_WEB_SEARCH_SETTINGS_NS } from '../src/web-search-service.ts'

/**
 * 造一个够 `resolveDeepSeekOptions` 用的假 ctx：settings 面（rc3 用 `describe()`
 * 读 namespace 值；`launchEnvironmentOf` 与 credentials/agents 都经 `ctx.get` 读；
 * 返回 undefined 即走「启动环境回落」这条官方合法路径）。
 */
function fakeCtx(section: unknown): never {
  return {
    settings: { describe: () => section === undefined ? [] : [{ ns: 'web-search-deepseek', value: section }] },
    get: () => undefined,
  } as never
}

/** 造一个可观测的假子 provider。 */
function fakeSubProvider(
  id: string,
  options: { available?: boolean; label?: string } = {},
): WebSearchSubProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    id,
    label: options.label ?? `假供应商 ${id}`,
    origin: `plugin:@corum/fake-${id}`,
    calls,
    available: () => options.available ?? true,
    async search(request) {
      calls.push(request.query)
      return { sources: [{ url: `https://example.test/${id}?q=${encodeURIComponent(request.query)}` }], truncated: false }
    },
  }
}

/** 造一个激活项可切换的聚合 provider。 */
function makeAggregate(initial = 'a') {
  let active = initial
  const aggregate = new AggregateWebSearch({
    aggregateId: CORUM_WEB_SEARCH_PROVIDER_ID,
    activeId: () => active,
  })
  return { aggregate, setActive: (id: string) => { active = id } }
}

describe('聚合 provider 的注册键', () => {
  it('id 就是注册键，且与 overlay patch pin 的值、settings namespace 一同固定', () => {
    expect(CORUM_WEB_SEARCH_PROVIDER_ID).toBe('corum-web-search')
    expect(CORUM_WEB_SEARCH_SETTINGS_NS).toBe('corum-web-search')
    const { aggregate } = makeAggregate()
    expect(aggregate.id).toBe(CORUM_WEB_SEARCH_PROVIDER_ID)
  })
})

describe('① 默认子 provider 是 DeepSeek', () => {
  it('内置子 provider 的注册键就是 DeepSeek，来源标记为 builtin', () => {
    expect(DEEPSEEK_SUB_PROVIDER_ID).toBe('deepseek')
  })

  it('设置面缺席时，投影出的选项等于官方 DeepSeek 的默认常量（= 复用同一设置面，不新增配置）', () => {
    // settings namespace 未注册 ⇒ get() 返回 undefined ⇒ 空 section。
    const ctx = fakeCtx(undefined)
    expect(currentDeepSeekSection(ctx)).toEqual({})

    const options = resolveDeepSeekOptions(ctx, {})
    expect(options.baseURL).toBe(DEEPSEEK_DEFAULT_BASE_URL)
    expect(options.model).toBe(DEEPSEEK_DEFAULT_MODEL)
    expect(options.maxUses).toBe(DEEPSEEK_DEFAULT_MAX_USES)
    // Key 走凭据引用（credentialRef 规范化），而不是把 Key 抄进配置。
    expect(options.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(options.resolveApiKey).toBeTypeOf('function')
    expect(options.apiKey).toBeUndefined()
  })

  it('内置子 provider 由官方 DeepSeekSearchProvider 实例驱动（默认可用 = 配了 Key 就能用）', () => {
    const provider = createDeepSeekSubProvider(fakeCtx(undefined))
    expect(provider.id).toBe(DEEPSEEK_SUB_PROVIDER_ID)
    expect(provider.origin).toBe('builtin')
    expect(typeof provider.available()).toBe('boolean')
    // 官方实现：只要 resolveApiKey 存在 + endpoint 可解析 + 两个上限是正整数就为真，
    // 与「有没有 Key」无关（Key 在 search 时才解析，缺失则报 CREDENTIAL_MISSING）。
    expect(provider.available()).toBe(true)
  })

  it('设置面有值时优先用设置面（endpoint 是独立的 Anthropic 兼容地址，与聊天 base URL 不同）', () => {
    const ctx = fakeCtx({ apiKeyEnv: 'MY_KEY', baseURL: 'https://example.test/anthropic/v1', maxUses: 9 })
    const options = resolveDeepSeekOptions(ctx, currentDeepSeekSection(ctx))
    expect(options.apiKeyEnv).toBe('MY_KEY')
    expect(options.baseURL).toBe('https://example.test/anthropic/v1')
    expect(options.maxUses).toBe(9)
    expect(options.model).toBe(DEEPSEEK_DEFAULT_MODEL)
  })

  it('激活项未注册时，search 报错点名它、并列出已注册项（不静默回落）', async () => {
    const { aggregate } = makeAggregate('missing')
    aggregate.register(fakeSubProvider('a'))
    await expect(aggregate.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    })
  })
})

describe('② 切换激活项后 search 委托给新项', () => {
  it('默认激活 a；切到 b 后 a 不再被调用、b 拿到这次查询', async () => {
    const { aggregate, setActive } = makeAggregate('a')
    const a = fakeSubProvider('a')
    const b = fakeSubProvider('b')
    aggregate.register(a)
    aggregate.register(b)

    expect(aggregate.active()?.id).toBe('a')
    await aggregate.search({ query: 'first' })
    expect(a.calls).toEqual(['first'])
    expect(b.calls).toEqual([])

    // 切换 = 只改一个 settings 值；聚合 provider 本身不重注册（dsh 那边没有抖动）。
    setActive('b')
    expect(aggregate.active()?.id).toBe('b')
    await aggregate.search({ query: 'second' })
    expect(a.calls).toEqual(['first'])
    expect(b.calls).toEqual(['second'])
  })

  it('id 重复注册大声失败（WEB_DUPLICATE_PROVIDER，同 dsh 的同一纪律）', () => {
    const { aggregate } = makeAggregate('a')
    aggregate.register(fakeSubProvider('a'))
    expect(() => aggregate.register(fakeSubProvider('a'))).toThrowError(/already registered/)
  })

  it('注销后从列表消失', () => {
    const { aggregate } = makeAggregate('a')
    const dispose = aggregate.register(fakeSubProvider('a'))
    expect(aggregate.list().map(p => p.id)).toEqual(['a'])
    dispose()
    expect(aggregate.list()).toEqual([])
  })
})

describe('③ available() 不做网络调用', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(() => { throw new Error('available() 不得联网') })
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('聚合 provider 的 available() 是同步布尔值，且零 fetch', () => {
    const { aggregate } = makeAggregate('a')
    aggregate.register(fakeSubProvider('a'))
    const result = aggregate.available()
    expect(typeof result).toBe('boolean')
    expect(result).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('全部子 provider 自报不可用 ⇒ available() 为 false，仍零 fetch', () => {
    const { aggregate } = makeAggregate('a')
    aggregate.register(fakeSubProvider('a', { available: false }))
    expect(aggregate.available()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('一个都没有时也零 fetch（不是「至少一个可用」而是「一个都没注册」）', () => {
    const { aggregate } = makeAggregate('a')
    expect(aggregate.available()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('**官方类**的 available() 也零 fetch（内置 DeepSeek 子 provider 走的就是它）', () => {
    const provider = createDeepSeekSubProvider(fakeCtx(undefined))
    expect(provider.available()).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('**刻意**的语义：激活项不可用但另有可用项 ⇒ available() 仍为 true（pin 常态可解析）', async () => {
    const { aggregate } = makeAggregate('broken')
    aggregate.register(fakeSubProvider('broken', { available: false }))
    aggregate.register(fakeSubProvider('ok'))
    expect(aggregate.available()).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    // 但真正的搜索会点名激活项不可用，而不是偷偷换 ok 去跑。
    await expect(aggregate.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    })
  })
})
