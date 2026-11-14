/**
 * 配置向导「添加重复供应商」保护回归测试。
 *
 * ## 缺陷
 *
 * ConfigureWizard.tsx 里 `const taken = state.rows.map(r => r.entry.provider);
 * void taken` —— 已配置供应商列表被计算后丢弃。两条新建路径无条件 op:'set'
 * 覆盖既有配置：
 *   - catalog 主路径（品牌网格选供应商）→ 静默覆盖整个 profile + 密钥引用；
 *   - 自定义表单路径（手填 route id）→ 静默覆盖 `providers.<route>` 整节。
 *
 * 对照：CustomProviderCard.tsx 已有完整重复保护（routeTaken 检查 +
 * customRouteTaken 错误文案 + 禁用提交）。向导缺这套。
 *
 * ## 本文件钉住
 *
 * 1. catalog 主路径：provider 已配置时点保存 → 弹确认对话框（不写入）；
 *    取消 → settings.mutate 零调用；确认 → settings.mutate 调用一次。
 * 2. 自定义表单路径：route 命中 taken → 显示 customRouteTaken 错误 + 保存禁用。
 * 3. 不重复时两条路径正常写入（回归）。
 * 4. 品牌格对已配置供应商显示「已配置」标记。
 *
 * ## 测试技术注记
 *
 * domino + React 18 的合成事件系统不正确处理 `input` 事件的值追踪器，
 * 导致 `dispatchEvent(new Event('input'))` 不触发 React 的 onChange。
 * 此处通过读取 `__reactProps$` 直接调用 onChange handler 来模拟用户输入，
 * 这是 domino 环境下验证受控 input 行为的唯一可靠方式。
 *
 * @module @corum/corum-ui-settings-models/tests/wizard-duplicate-provider
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfigureWizard } from '../src/client/ConfigureWizard.tsx'
import type { ModelsSettingsState, ModelsWire } from '../src/client/store.ts'
import type { SettingsSchemaOperations } from '../src/client/schema-operations.ts'

// 复用 workspace 已安装的 DOM/React DOM，不给产品包增加运行时依赖。
const pnpmStore = resolve(import.meta.dirname, '../../../../../node_modules/.pnpm')
const dominoDir = readdirSync(pnpmStore).find(name => name.startsWith('@mixmark-io+domino@'))!
const { createWindow } = createRequire(import.meta.url)(join(pnpmStore, dominoDir, 'node_modules/@mixmark-io/domino'))
const window = createWindow('<html><body></body></html>')
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = createRequire(resolve(import.meta.dirname, '../../corum-ui-conversation/package.json'))('react-dom/client')

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

/** 一个已有 deepseek 配置的 snapshot（deepseek 的 user 段非空；openai 在目录但未配置）。 */
function snapshotWithDeepseek(): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    routeModels: new Map(),
    rows: [{
      entry: {
        provider: 'deepseek',
        displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek',
        settingsPath: [],
        active: true,
      },
      configured: true,
      removable: true,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: undefined,
    }, {
      // 目录里存在但未配置的供应商（base 预设路由，user 段无此 path）
      entry: {
        provider: 'openai',
        displayName: 'OpenAI',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        active: false,
      },
      configured: false,
      removable: false,
      apiKeyEnv: undefined,
      credential: undefined,
    }],
    namespaces: new Map([
      // deepseek：user 段有写入（整节 settingsPath 为空 → user 非空即 taken）
      ['llm-deepseek', {
        ns: 'llm-deepseek', revision: 3, schema: {}, applies: 'live' as const, secrets: [],
        base: {},
        user: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-chat' }] },
        value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-chat' }] },
      } as never],
      // pi-ai：namespace 存在，base 有 openai 预设，但 user 段无 openai
      ['llm-pi-ai', {
        ns: 'llm-pi-ai', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { providers: { openai: { api: 'openai-completions', baseURL: 'https://api.openai.com/v1', models: [] } } },
        user: { providers: {} },
        value: { providers: { openai: { api: 'openai-completions', baseURL: 'https://api.openai.com/v1', models: [] } } },
      } as never],
    ]),
  }
}

/** 一个没有任何已配置供应商的 snapshot（目录有行但 user 段全空）。 */
function snapshotEmpty(): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    routeModels: new Map(),
    // rows 含目录行，namespace 存在但 user 段为空（模拟实机：命名空间声明但无配置）
    rows: [{
      entry: {
        provider: 'openai',
        displayName: 'OpenAI',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        active: false,
      },
      configured: false,
      removable: false,
      apiKeyEnv: undefined,
      credential: undefined,
    }, {
      entry: {
        provider: 'deepseek',
        displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek',
        settingsPath: [],
        active: false,
      },
      configured: false,
      removable: false,
      apiKeyEnv: undefined,
      credential: undefined,
    }],
    namespaces: new Map([
      // pi-ai：base 有预设，user 为空对象 → hasPath(user,...) = false
      ['llm-pi-ai', {
        ns: 'llm-pi-ai', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { providers: { openai: { api: 'openai-completions', models: [] } } },
        user: {},
        value: { providers: { openai: { api: 'openai-completions', models: [] } } },
      } as never],
      // deepseek：namespace 声明但 user 为空 → Object.keys(user).length = 0 → 不算 taken
      ['llm-deepseek', {
        ns: 'llm-deepseek', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { models: [] },
        user: {},
        value: { models: [] },
      } as never],
    ]),
  }
}

/** 一个已有自定义 route `my-gateway` 的 snapshot（user 段有写入；openai 在目录但未配置）。 */
function snapshotWithCustomRoute(): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    routeModels: new Map(),
    rows: [{
      entry: {
        provider: 'my-gateway',
        displayName: 'My Gateway',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'my-gateway'],
        active: true,
      },
      configured: true,
      removable: true,
      apiKeyEnv: 'MY_GATEWAY_API_KEY',
      credential: undefined,
    }, {
      // 目录里存在但未配置的供应商（base 预设，user 段无此 path）
      entry: {
        provider: 'openai',
        displayName: 'OpenAI',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        active: false,
      },
      configured: false,
      removable: false,
      apiKeyEnv: undefined,
      credential: undefined,
    }],
    namespaces: new Map([
      // pi-ai：user 段有 my-gateway（hasPath(user, ['providers','my-gateway']) = true）；
      // openai 只在 base 预设（hasPath(user, ['providers','openai']) = false）
      ['llm-pi-ai', {
        ns: 'llm-pi-ai', revision: 5, schema: {}, applies: 'live' as const, secrets: [],
        base: { providers: { openai: { api: 'openai-completions', models: [] } } },
        user: { providers: { 'my-gateway': {
          api: 'openai-completions',
          baseURL: 'https://gw.example/v1',
          apiKeyEnv: 'MY_GATEWAY_API_KEY',
          models: [{ id: 'gw-model' }],
        } } },
        value: { providers: {
          'my-gateway': { api: 'openai-completions', baseURL: 'https://gw.example/v1', apiKeyEnv: 'MY_GATEWAY_API_KEY', models: [{ id: 'gw-model' }] },
          openai: { api: 'openai-completions', models: [] },
        } },
      } as never],
    ]),
  }
}

/** t 函数返回 key 本身（测试用 key 字符串做断言）。 */
const t = (key: string): string => key

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/**
 * 通过 React 内部 `__reactProps$` 直接调用 input 的 onChange handler。
 *
 * domino + React 18 的合成事件系统不正确处理 `input` 事件的值追踪器，
 * `dispatchEvent(new Event('input'))` 不触发 onChange。直接调 handler 是
 * domino 环境下验证受控 input 行为的唯一可靠方式。
 */
async function reactChange(element: HTMLInputElement, value: string): Promise<void> {
  const propsKey = Object.keys(element).find(k => k.startsWith('__reactProps$'))
  expect(propsKey, 'react props key on input').toBeDefined()
  const props = (element as any)[propsKey!]
  expect(props.onChange, 'onChange handler on input').toBeDefined()
  await act(async () => props.onChange({ target: { value } }))
}

/** 挂载 ConfigureWizard 并返回交互工具。 */
async function mountWizard(options: {
  state: ModelsSettingsState
  discoverModels?: any
  mutate?: any
  credentialsSet?: any
} = {}) {
  const { state } = options
  const discoverModels = options.discoverModels ?? vi.fn(async () => ({
    ok: true,
    value: [{ id: 'new-model', contextWindow: 64000, maxTokens: 8000 }],
  }))
  const mutate = options.mutate ?? vi.fn(async () => ({ ok: true, value: { revision: 99, user: {} } }))
  const credentialsSet = options.credentialsSet ?? vi.fn(async () => ({
    ok: true,
    value: { ref: 'KEY', configured: true, writable: true },
  }))
  const onChanged = vi.fn()
  const onBack = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = async () => {
    await act(async () => root.render(createElement(ConfigureWizard, {
      state,
      api: {
        llm: { discoverModels },
        settings: { mutate },
        credentials: { set: credentialsSet },
      } as unknown as ModelsWire,
      schema,
      onBack,
      onChanged,
      activeLocale: () => 'zh-CN',
      t: t as any,
    })))
  }
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove() })
  await render()

  const button = (text: string): HTMLButtonElement => {
    const found = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
    expect(found, `button "${text}"`).toBeDefined()
    return found!
  }

  /** Find a button anywhere in document.body (for portal-rendered dialogs). */
  const bodyButton = (text: string): HTMLButtonElement => {
    const found = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
    expect(found, `body button "${text}"`).toBeDefined()
    return found!
  }

  const click = async (text: string): Promise<void> => {
    await act(async () => button(text).click())
  }

  /** Click a button that may be rendered via portal to document.body. */
  const bodyClick = async (text: string): Promise<void> => {
    await act(async () => bodyButton(text).click())
  }

  return {
    container,
    button,
    bodyButton,
    click,
    bodyClick,
    discoverModels,
    mutate,
    credentialsSet,
    onChanged,
    onBack,
    root,
    render,
    reactChange,
  }
}

/* ── 静态守卫：源码结构 ── */

const SOURCE = readFileSync(join(import.meta.dirname, '../src/client/ConfigureWizard.tsx'), 'utf8')

it('★ taken 仅计 user 段有写入的供应商（configuredProviders helper）', () => {
  expect(SOURCE).toContain('configuredProviders(')
  expect(SOURCE).toContain('schema.hasPath(ns.user')
  expect(SOURCE).not.toContain('void taken')
  expect(SOURCE).not.toContain('.filter(r => r.configured)')
})

it('★ 品牌族重复感知（familyConfiguredOf + pendingFamilyCreate）', () => {
  expect(SOURCE).toContain('familyConfiguredOf')
  expect(SOURCE).toContain('brandFamilyOf')
  expect(SOURCE).toContain('pendingFamilyCreate')
  expect(SOURCE).toContain('wizardFamilyConfiguredTitle')
})

it('★ catalog 主路径有 pendingOverwrite 确认弹窗', () => {
  expect(SOURCE).toContain('pendingOverwrite')
  expect(SOURCE).toContain('ConfirmDialog')
})

it('★ 自定义路径有 routeTaken 检查', () => {
  expect(SOURCE).toContain('routeTaken')
  expect(SOURCE).toContain("t('customRouteTaken')")
})

/* ── 行为测试：catalog 重复 → 确认对话框 ── */

it('★ catalog 重复供应商：点保存弹确认，取消则 mutate 零调用', async () => {
  const ui = await mountWizard({ state: snapshotWithDeepseek() })
  // deepseek 已配置（默认选中），侦测模型后选一个，点保存。
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  // 确认对话框经 createPortal 渲染到 document.body，不在 container 内。
  expect(document.body.textContent).toContain('wizardProviderTakenTitle')
  expect(document.body.textContent).toContain('wizardProviderTakenConfirm')
  // 点对话框的取消按钮（cancelLabel = t('wizardProviderTakenCancel')）
  await ui.bodyClick('wizardProviderTakenCancel')
  // mutate 没有被调用
  expect(ui.mutate).not.toHaveBeenCalled()
})

it('★ catalog 重复供应商：确认后 mutate 调用一次', async () => {
  const ui = await mountWizard({ state: snapshotWithDeepseek() })
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  // 确认对话框经 createPortal 渲染到 document.body。
  expect(document.body.textContent).toContain('wizardProviderTakenTitle')
  // 点「覆盖保存」（confirmLabel = t('wizardProviderTakenConfirm')）
  await ui.bodyClick('wizardProviderTakenConfirm')
  expect(ui.mutate).toHaveBeenCalledTimes(1)
  expect(ui.onChanged).toHaveBeenCalledTimes(1)
  expect(ui.onBack).toHaveBeenCalledTimes(1)
})

/* ── 行为测试：自定义 route 重复 → 禁用 + 错误 ── */

it('★ 自定义 route 重复：显示错误且侦测/保存禁用', async () => {
  const ui = await mountWizard({ state: snapshotWithCustomRoute() })
  // 切到「自定义供应商」标签
  await ui.click('自定义供应商')
  // 填入已存在的 route
  const routeInput = ui.container.querySelector('input[placeholder^="my-provider"]') as HTMLInputElement
  expect(routeInput, 'route input').toBeDefined()
  await reactChange(routeInput, 'my-gateway')
  // 错误文案出现（t = key，故渲染 customRouteTaken）
  expect(ui.container.textContent).toContain('customRouteTaken')
  // 填入 baseURL（让 canDetect 只差 routeTaken）
  const baseInput = ui.container.querySelector('input[placeholder*="gateway.example"]') as HTMLInputElement
  expect(baseInput, 'baseURL input').toBeDefined()
  await reactChange(baseInput, 'https://gw.example/v1')
  // 侦测按钮禁用（canDetect = routeOk && !routeTaken && baseURL !== ''）
  const detectBtn = ui.button('侦测模型')
  expect(detectBtn.disabled).toBe(true)
  // 保存按钮禁用（canSave 含 !routeTaken；chosenCount=0 也禁用，但 routeTaken 是硬拦截）
  const saveBtn = ui.button('配置所选模型（0）')
  expect(saveBtn.disabled).toBe(true)
  // mutate 不应被调用
  expect(ui.mutate).not.toHaveBeenCalled()
})

/* ── 回归：不重复时两条路径正常写入 ── */

it('★ 回归：catalog 新供应商（不重复）正常写入不弹确认', async () => {
  const ui = await mountWizard({ state: snapshotEmpty() })
  // taken 为空，选默认 deepseek，侦测模型后选一个，点保存。
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  // 不应出现确认对话框（对话框经 portal 渲染到 document.body）
  expect(document.body.textContent).not.toContain('wizardProviderTakenTitle')
  // 直接写入
  expect(ui.mutate).toHaveBeenCalledTimes(1)
  expect(ui.onChanged).toHaveBeenCalledTimes(1)
  expect(ui.onBack).toHaveBeenCalledTimes(1)
})

it('★ 回归：自定义新 route（不重复）正常写入', async () => {
  const ui = await mountWizard({ state: snapshotEmpty() })
  await ui.click('自定义供应商')
  // 填入新 route
  const routeInput = ui.container.querySelector('input[placeholder^="my-provider"]') as HTMLInputElement
  await reactChange(routeInput, 'new-gateway')
  // 填入 baseURL
  const baseInput = ui.container.querySelector('input[placeholder*="gateway.example"]') as HTMLInputElement
  await reactChange(baseInput, 'https://gw.example/v1')
  // 侦测模型后选一个
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  // 保存按钮可用
  const saveBtn = ui.button('配置所选模型（1）')
  expect(saveBtn.disabled).toBe(false)
  await ui.click('配置所选模型（1）')
  // 不应出现错误文案
  expect(ui.container.textContent).not.toContain('customRouteTaken')
  // 直接写入
  expect(ui.mutate).toHaveBeenCalledTimes(1)
  expect(ui.onChanged).toHaveBeenCalledTimes(1)
  expect(ui.onBack).toHaveBeenCalledTimes(1)
})

/* ── 品牌格「已配置」标记 ── */

it('★ 品牌格对已配置供应商显示「已配置」标记', async () => {
  const ui = await mountWizard({ state: snapshotWithDeepseek() })
  // t = key，故渲染 wizardBrandConfigured（= '已配置' 的 locale key）
  expect(ui.container.textContent).toContain('wizardBrandConfigured')
})

/* ── 修正：taken 仅计 configured 供应商（不全目录） ── */

it('★ 修正：未配置 catalog 品牌不弹确认直接写入', async () => {
  // snapshotEmpty 有 openai 目录行但 configured:false → taken 为空。
  const ui = await mountWizard({ state: snapshotEmpty() })
  // 选默认 deepseek（目录行但 configured:false），侦测模型后选一个，点保存。
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  // 不应出现确认对话框（deepseek 在目录但未配置）
  expect(document.body.textContent).not.toContain('wizardProviderTakenTitle')
  // 直接写入
  expect(ui.mutate).toHaveBeenCalledTimes(1)
})

it('★ 修正：未配置 catalog 品牌不显示「已配置」标记', async () => {
  // snapshotEmpty 的全部 rows 都是 configured:false → 无标记。
  const ui = await mountWizard({ state: snapshotEmpty() })
  expect(ui.container.textContent).not.toContain('wizardBrandConfigured')
})

it('★ 修正：未配置 route 的自定义创建不被拦', async () => {
  // snapshotWithCustomRoute 有 openai 目录行但 user 段无 openai。
  // 用 openai 做 route 不应被拦（它在 base 预设但 user 段没有）。
  const ui = await mountWizard({ state: snapshotWithCustomRoute() })
  await ui.click('自定义供应商')
  const routeInput = ui.container.querySelector('input[placeholder^="my-provider"]') as HTMLInputElement
  await reactChange(routeInput, 'openai')
  // openai 在 base 预设但 user 段无 → routeTaken 应为 false，无错误
  expect(ui.container.textContent).not.toContain('customRouteTaken')
  // 填入 baseURL
  const baseInput = ui.container.querySelector('input[placeholder*="gateway.example"]') as HTMLInputElement
  await reactChange(baseInput, 'https://api.openai.com/v1')
  // 侦测按钮可用（canDetect 不被 routeTaken 拦）
  const detectBtn = ui.button('侦测模型')
  expect(detectBtn.disabled).toBe(false)
})

/* ── 修正轮 2：taken 改用 user 段判据（configured 宽口径误标 base 预设与空命名空间） ── */

/**
 * 命名空间存在但 user 段为空（deepseek-account 形态：namespace 声明了
 * 但没有任何 user 写入）。configured 宽口径会判 true（namespace !== undefined
 * 且 value 能 resolve），但写入不会覆盖任何东西。
 */
function snapshotNamespaceDeclaredUserEmpty(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, routeModels: new Map(),
    rows: [{
      entry: { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      configured: true, removable: false, apiKeyEnv: undefined, credential: undefined,
    }, {
      entry: { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: false },
      configured: true, removable: false, apiKeyEnv: undefined, credential: undefined,
    }],
    namespaces: new Map([
      // namespace 存在，base 有值，user 为空对象 → Object.keys({}).length = 0 → 不算 taken
      ['llm-deepseek', {
        ns: 'llm-deepseek', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { models: [{ id: 'deepseek-chat' }] },
        user: {},
        value: { models: [{ id: 'deepseek-chat' }] },
      } as never],
      // namespace 存在，base 有 openai 预设，user 为空 → hasPath({}, ['providers','openai']) = false
      ['llm-pi-ai', {
        ns: 'llm-pi-ai', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { providers: { openai: { api: 'openai-completions', models: [] } } },
        user: {},
        value: { providers: { openai: { api: 'openai-completions', models: [] } } },
      } as never],
    ]),
  }
}

/**
 * base 预设路由（腾讯形态：value 有 openai 因为 base 有，但 user 段没有）。
 * configured 宽口径判 true（getPath(value, path) !== undefined），但不是 user 写入。
 */
function snapshotBasePresetOnly(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, routeModels: new Map(),
    rows: [{
      entry: { provider: 'tencent', displayName: 'Tencent', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'tencent'], active: false },
      configured: true, removable: false, apiKeyEnv: undefined, credential: undefined,
    }],
    namespaces: new Map([
      // base 有 tencent 预设，user 段有其他 route 但没有 tencent
      ['llm-pi-ai', {
        ns: 'llm-pi-ai', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { providers: { tencent: { api: 'openai-completions', baseURL: 'https://api.tencent.com/v1', models: [] } } },
        user: { providers: { 'other-gw': { api: 'openai-completions', baseURL: 'https://other.example/v1', models: [{ id: 'other' }] } } },
        value: { providers: {
          tencent: { api: 'openai-completions', baseURL: 'https://api.tencent.com/v1', models: [] },
          'other-gw': { api: 'openai-completions', baseURL: 'https://other.example/v1', models: [{ id: 'other' }] },
        } },
      } as never],
    ]),
  }
}

it('★ 修正轮2：命名空间存在但 user 为空（deepseek-account 形态）→ 不标记/不弹确认', async () => {
  const ui = await mountWizard({ state: snapshotNamespaceDeclaredUserEmpty() })
  // 目录品牌格不显示「已配置」（user 段空）
  expect(ui.container.textContent).not.toContain('wizardBrandConfigured')
  // 侦测模型后选一个，点保存 → 不弹确认（user 段空，写入不覆盖）
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  expect(document.body.textContent).not.toContain('wizardProviderTakenTitle')
  expect(ui.mutate).toHaveBeenCalledTimes(1)
})

it('★ 修正轮2：命名空间存在但 user 为空 → 自定义 route 不被拦', async () => {
  const ui = await mountWizard({ state: snapshotNamespaceDeclaredUserEmpty() })
  await ui.click('自定义供应商')
  const routeInput = ui.container.querySelector('input[placeholder^="my-provider"]') as HTMLInputElement
  // 用 openai 做 route：在 base 预设但 user 段无 → 不应被 routeTaken 拦
  await reactChange(routeInput, 'openai')
  expect(ui.container.textContent).not.toContain('customRouteTaken')
})

it('★ 修正轮2：base 预设路由（腾讯形态，value 有但 user 无）→ 不标记/不弹确认', async () => {
  const ui = await mountWizard({ state: snapshotBasePresetOnly() })
  // tencent 在 base 预设但 user 段没有 → 不应显示「已配置」
  expect(ui.container.textContent).not.toContain('wizardBrandConfigured')
  // 用 tencent 做 route：在 base 但 user 无 → 不应被 routeTaken 拦
  await ui.click('自定义供应商')
  const routeInput = ui.container.querySelector('input[placeholder^="my-provider"]') as HTMLInputElement
  await reactChange(routeInput, 'tencent')
  expect(ui.container.textContent).not.toContain('customRouteTaken')
})

it('★ 修正轮2：user 段有写入（整节非空 / path hasPath(user)）→ 标记+确认+拦截', async () => {
  // snapshotWithDeepseek: deepseek user 段非空 → taken 包含 deepseek
  const ui = await mountWizard({ state: snapshotWithDeepseek() })
  expect(ui.container.textContent).toContain('wizardBrandConfigured')
  // 点保存弹确认
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  expect(document.body.textContent).toContain('wizardProviderTakenTitle')
})

/* ── 修正轮 3：品牌族重复感知（同品牌已有配置时提示新建独立路由） ── */

/**
 * 已配置 deepseek-official（llm-deepseek 整节，user 有 models+apiKeyEnv），
 * 目录里同时有 deepseek（llm-pi-ai 路由，settingsPath = ['providers','deepseek']）。
 * 置顶模板格 deepseek 与 deepseek-official 同品牌族但不同 route ID。
 */
function snapshotWithDeepseekOfficial(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, routeModels: new Map(),
    rows: [{
      // deepseek-official：llm-deepseek 整节，user 段有写入
      entry: { provider: 'deepseek-official', displayName: 'DeepSeek Official', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      configured: true, removable: true, apiKeyEnv: 'DEEPSEEK_OFFICIAL_API_KEY', credential: undefined,
    }, {
      // deepseek：llm-pi-ai 路由，目录里有但 user 段没配置
      entry: { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek'], active: false },
      configured: false, removable: false, apiKeyEnv: undefined, credential: undefined,
    }, {
      entry: { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: false },
      configured: false, removable: false, apiKeyEnv: undefined, credential: undefined,
    }],
    namespaces: new Map([
      // deepseek-official 写在 llm-deepseek 整节（user 非空）
      ['llm-deepseek', {
        ns: 'llm-deepseek', revision: 3, schema: {}, applies: 'live' as const, secrets: [],
        base: {},
        user: { apiKeyEnv: 'DEEPSEEK_OFFICIAL_API_KEY', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-coder' }] },
        value: { apiKeyEnv: 'DEEPSEEK_OFFICIAL_API_KEY', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-coder' }] },
      } as never],
      // pi-ai：有 namespace 但 user 段无 deepseek/openai 配置
      ['llm-pi-ai', {
        ns: 'llm-pi-ai', revision: 1, schema: {}, applies: 'live' as const, secrets: [],
        base: { providers: { deepseek: { api: 'openai-completions', models: [] }, openai: { api: 'openai-completions', models: [] } } },
        user: {},
        value: { providers: { deepseek: { api: 'openai-completions', models: [] }, openai: { api: 'openai-completions', models: [] } } },
      } as never],
    ]),
  }
}

it('★ 修正轮3：同族已配置（deepseek-official）选模板 deepseek 保存 → 弹「该品牌已有配置」', async () => {
  const ui = await mountWizard({ state: snapshotWithDeepseekOfficial() })
  // 侦测模型后选一个，点保存（deepseek 不在 taken，但同族有 deepseek-official）
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  // 应弹「该品牌已有配置」（不是「供应商已配置」覆盖确认）
  expect(document.body.textContent).toContain('wizardFamilyConfiguredTitle')
  expect(document.body.textContent).not.toContain('wizardProviderTakenTitle')
  // 正文含 wizardFamilyConfiguredBody（t=key，模板占位符不渲染但 key 在）
  expect(document.body.textContent).toContain('wizardFamilyConfiguredBody')
  // 取消 → mutate 零调用
  await ui.bodyClick('wizardFamilyConfiguredCancel')
  expect(ui.mutate).not.toHaveBeenCalled()
})

it('★ 修正轮3：同族确认后写入新路由（不覆盖既有配置）', async () => {
  const ui = await mountWizard({ state: snapshotWithDeepseekOfficial() })
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  expect(document.body.textContent).toContain('wizardFamilyConfiguredTitle')
  // 点「仍要新建」
  await ui.bodyClick('wizardFamilyConfiguredConfirm')
  expect(ui.mutate).toHaveBeenCalledTimes(1)
  expect(ui.onChanged).toHaveBeenCalledTimes(1)
  expect(ui.onBack).toHaveBeenCalledTimes(1)
})

it('★ 修正轮3：置顶模板格在同族已配置时带标记', async () => {
  const ui = await mountWizard({ state: snapshotWithDeepseekOfficial() })
  // deepseek 格应显示「已配置」（同族 deepseek-official 已配置）
  expect(ui.container.textContent).toContain('wizardBrandConfigured')
})

it('★ 修正轮3：无同族配置时不弹新弹窗', async () => {
  // snapshotEmpty：无任何已配置 → 选 openai 不应弹族确认
  const ui = await mountWizard({ state: snapshotEmpty() })
  await ui.click('侦测模型')
  await ui.click('new-model64K')
  await ui.click('配置所选模型（1）')
  expect(document.body.textContent).not.toContain('wizardFamilyConfiguredTitle')
  expect(document.body.textContent).not.toContain('wizardProviderTakenTitle')
  expect(ui.mutate).toHaveBeenCalledTimes(1)
})
