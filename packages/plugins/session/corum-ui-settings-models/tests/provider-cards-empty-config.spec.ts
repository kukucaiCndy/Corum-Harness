/**
 * 主页「空壳供应商卡片」缺陷回归测试。
 *
 * ## 缺陷
 *
 * `collectProviderCards` 用 `providerUsable(row)`（store.ts）做显示过滤：active
 * 路由 + apiKeyEnv===undefined → usable=true。内置 DeepSeek Account 路由 active、
 * 无密钥要求、user 段={} → 被显示成 0 模型空壳卡。
 *
 * ## 根因
 *
 * `providerUsable` 是宽口径判据（还服务 onboarding/connected 语义）：无密钥要求
 * 的内置路由（native-auth 或目录型）在 user 段空时也判 usable。而函数头注释明确
 * 意图「只列 usable 的供应商（有密钥或自定义 route），未配置的内置 provider 不进
 * 主页」——实现违背意图。
 *
 * ## 修法
 *
 * 在 `collectProviderCards` 的 namespace 存在分支加显示门控：对有 settings 地址
 * 的 row，要求 user 段真有内容（与 ConfigureWizard.tsx 的 configuredProviders()
 * 同口径）。settingsNs==='' 的 Ollama 只读卡路径不动。
 *
 * ## 本文件钉住
 *
 * a. 内置整节 user={} → 无卡片（deepseek-account 形态）；
 * b. 内置整节 user 有 models/apiKeyEnv → 有卡片（deepseek-official 形态）；
 * c. 自定义 route user 有值 → 有卡片；
 * d. 自定义 route user 无值 → 无卡片；
 * e. Ollama（settingsNs=''）→ 只读卡片仍在；
 * f. 源码守卫：collectProviderCards 含 user 段判据（hasPath / Object.keys）。
 */
import { describe, expect, it } from 'vitest'
import { collectProviderCards } from '../src/client/model-cards.ts'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import type { SettingsSchemaOperations } from '../src/client/schema-operations.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 与 wizard-duplicate-provider.spec.ts 同款的 schema 替身（getPath / hasPath）。 */
const schema = {
  getPath: (value: unknown, path: readonly string[]) => path.reduce((v: any, key) => v?.[key], value),
  hasPath: (value: unknown, path: readonly string[]) => {
    if (value === undefined || value === null) return false
    let v: any = value
    for (const key of path) {
      if (v === undefined || v === null) return false
      v = v[key]
      if (v === undefined) return false
    }
    return true
  },
} as SettingsSchemaOperations

/* ── snapshot 工厂 ── */

/** 一行 provider 的最小形态（只填 collectProviderCards 读的字段）。 */
function row(overrides: Partial<ProviderRow> & { entry: ProviderRow['entry'] }): ProviderRow {
  return {
    configured: true,
    removable: true,
    apiKeyEnv: overrides.apiKeyEnv,
    credential: overrides.credential,
    ...overrides,
  } as ProviderRow
}

/** DeepSeek Account 形态：整节（settingsPath=[]），route active，无密钥要求，user 段={}。 */
function snapshotDeepseekAccountUserEmpty(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, routeModels: new Map(),
    rows: [row({
      entry: { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      apiKeyEnv: undefined, credential: undefined,
    })],
    namespaces: new Map([
      ['llm-deepseek', {
        ns: 'llm-deepseek', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { models: [{ id: 'deepseek-chat' }] },
        user: {},
        value: { models: [{ id: 'deepseek-chat' }] },
      } as never],
    ]),
  }
}

/** DeepSeek Official 形态：整节（settingsPath=[]），route active，user 段有 models + apiKeyEnv。 */
function snapshotDeepseekOfficialConfigured(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, routeModels: new Map(),
    rows: [row({
      entry: { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { ref: 'DEEPSEEK_API_KEY', configured: true, writable: true },
    })],
    namespaces: new Map([
      ['llm-deepseek', {
        ns: 'llm-deepseek', revision: 3, schema: {}, applies: 'live' as const, secrets: [],
        base: { models: [] },
        user: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-chat' }] },
        value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-chat' }] },
      } as never],
    ]),
  }
}

/** 自定义 route 有值：user 段有 providers.my-gateway。 */
function snapshotCustomRouteConfigured(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, routeModels: new Map(),
    rows: [row({
      entry: { provider: 'my-gateway', displayName: 'My Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my-gateway'], active: true },
      apiKeyEnv: 'MY_GATEWAY_API_KEY',
      credential: { ref: 'MY_GATEWAY_API_KEY', configured: true, writable: true },
    })],
    namespaces: new Map([
      ['llm-pi-ai', {
        ns: 'llm-pi-ai', revision: 5, schema: {}, applies: 'live' as const, secrets: [],
        base: { providers: {} },
        user: { providers: { 'my-gateway': {
          api: 'openai-completions', baseURL: 'https://gw.example/v1',
          apiKeyEnv: 'MY_GATEWAY_API_KEY', models: [{ id: 'gw-model' }],
        } } },
        value: { providers: { 'my-gateway': {
          api: 'openai-completions', baseURL: 'https://gw.example/v1',
          apiKeyEnv: 'MY_GATEWAY_API_KEY', models: [{ id: 'gw-model' }],
        } } },
      } as never],
    ]),
  }
}

/**
 * 自定义 route 无值：base 有 openai 预设，user 段为空对象 {}。
 * 模拟未配置的内置 route（providerUsable 判 true 但 user 段无此 path）。
 */
function snapshotCustomRouteUserEmpty(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, routeModels: new Map(),
    rows: [row({
      entry: { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
      apiKeyEnv: undefined, credential: undefined,
    })],
    namespaces: new Map([
      ['llm-pi-ai', {
        ns: 'llm-pi-ai', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { providers: { openai: { api: 'openai-completions', baseURL: 'https://api.openai.com/v1', models: [] } } },
        user: {},
        value: { providers: { openai: { api: 'openai-completions', baseURL: 'https://api.openai.com/v1', models: [] } } },
      } as never],
    ]),
  }
}

/** Ollama：无 settingsNs（settingsNs=''），route 注册但无配置界面。 */
function snapshotOllama(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true,
    routeModels: new Map([['ollama', []]]),
    rows: [row({
      entry: { provider: 'ollama', displayName: 'Ollama', settingsNs: '', settingsPath: [], active: true },
      apiKeyEnv: undefined, credential: undefined,
    })],
    namespaces: new Map(),
  }
}

/* ── 行为测试 ── */

describe('collectProviderCards —— 空配置内置供应商不进主页', () => {
  it('a. 内置整节 user={}（deepseek-account 形态）→ 无卡片', () => {
    const cards = collectProviderCards(snapshotDeepseekAccountUserEmpty(), schema)
    expect(cards).toHaveLength(0)
  })

  it('b. 内置整节 user 有 models/apiKeyEnv（deepseek-official 形态）→ 有卡片', () => {
    const cards = collectProviderCards(snapshotDeepseekOfficialConfigured(), schema)
    expect(cards).toHaveLength(1)
    expect(cards[0].provider).toBe('deepseek')
    expect(cards[0].modelCount).toBe(1)
    expect(cards[0].cards.map(c => c.modelId)).toEqual(['deepseek-chat'])
  })

  it('c. 自定义 route user 有值 → 有卡片', () => {
    const cards = collectProviderCards(snapshotCustomRouteConfigured(), schema)
    expect(cards).toHaveLength(1)
    expect(cards[0].provider).toBe('my-gateway')
    expect(cards[0].modelCount).toBe(1)
    expect(cards[0].cards.map(c => c.modelId)).toEqual(['gw-model'])
  })

  it('d. 自定义 route user 无值（base 预设，user 段空）→ 无卡片', () => {
    const cards = collectProviderCards(snapshotCustomRouteUserEmpty(), schema)
    expect(cards).toHaveLength(0)
  })

  it('e. Ollama（settingsNs=\'\'）→ 只读卡片仍在', () => {
    const cards = collectProviderCards(snapshotOllama(), schema)
    expect(cards).toHaveLength(1)
    expect(cards[0].provider).toBe('ollama')
    expect(cards[0].settingsNs).toBe('')
    expect(cards[0].desc).toContain('本地模型')
  })
})

/* ── 源码守卫：user 段判据已落地 ── */

const SOURCE = readFileSync(join(import.meta.dirname, '../src/client/model-cards.ts'), 'utf8')

describe('源码守卫 —— collectProviderCards 含 user 段判据', () => {
  it('f. 含 hasUserConfig 门控（Object.keys / schema.hasPath）', () => {
    expect(SOURCE).toContain('hasUserConfig')
    expect(SOURCE).toContain('Object.keys(namespace.user')
    expect(SOURCE).toContain('schema.hasPath(namespace.user')
    expect(SOURCE).toContain('if (!hasUserConfig) continue')
  })

  it('f. 注释标明与 ConfigureWizard configuredProviders 同口径', () => {
    expect(SOURCE).toContain('configuredProviders()')
    expect(SOURCE).toContain('同口径')
  })
})
