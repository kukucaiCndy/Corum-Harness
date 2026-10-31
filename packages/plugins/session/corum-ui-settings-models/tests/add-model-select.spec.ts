import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AddModelSelectView } from '../src/client/AddModelSelectView.tsx'
import type { ModelsSettingsState, ModelsWire } from '../src/client/store.ts'
import type { SettingsSchemaOperations } from '../src/client/schema-operations.ts'
import { collectProviderCards } from '../src/client/model-cards.ts'

// 复用 workspace 已安装的 DOM/React DOM，不给产品包增加运行时依赖。
const store = resolve(import.meta.dirname, '../../../../../node_modules/.pnpm')
const domino = readdirSync(store).find(name => name.startsWith('@mixmark-io+domino@'))!
const { createWindow } = createRequire(import.meta.url)(join(store, domino, 'node_modules/@mixmark-io/domino'))
const window = createWindow('<html><body></body></html>')
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = createRequire(resolve(import.meta.dirname, '../../corum-ui-conversation/package.json'))('react-dom/client')

const schema = {
  getPath: (value: unknown, path: readonly string[]) => path.reduce((v: any, key) => v?.[key], value),
} as SettingsSchemaOperations
const existing = {
  id: 'existing', contextWindow: 96000, maxTokens: 12000, input: ['text', 'image'],
  reasoningEfforts: { off: {}, high: {} }, pricing: { output: 2.5 }, custom: { keep: ['all', 'fields'] },
}
function snapshot(): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, routeModels: new Map(),
    rows: [{
      entry: { provider: 'saved-gateway', displayName: 'Saved gateway', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'saved-gateway'], active: true },
      configured: true, removable: true, apiKeyEnv: undefined, credential: undefined,
    }],
    namespaces: new Map([['llm-pi-ai', {
      ns: 'llm-pi-ai', revision: 7, schema: {}, base: {}, user: {},
      value: { providers: { 'saved-gateway': {
        api: 'anthropic-messages', baseURL: 'http://127.0.0.1:18349/v1', apiKeyEnv: 'KEEP_KEY',
        compat: { supportsDeveloperRole: false }, defaultModel: 'existing', models: [existing],
      } } },
    } as never]]),
  }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function mount(options: { state?: ModelsSettingsState; discoverModels?: any; mutate?: any } = {}) {
  let state = options.state ?? snapshot()
  const provider = collectProviderCards(state, schema)[0]!
  const discoverModels = options.discoverModels ?? vi.fn(async () => ({ ok: true, value: [
    { id: 'existing' }, { id: 'new-a', contextWindow: 128000, maxTokens: 16000 }, { id: 'new-b' },
  ] }))
  const mutate = options.mutate ?? vi.fn(async () => ({ ok: true, value: { revision: 8, user: {} } }))
  const onChanged = vi.fn()
  const onBack = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async () => {
    await act(async () => root.render(createElement(AddModelSelectView, {
      provider, state, schema, api: { llm: { discoverModels }, settings: { mutate } } as unknown as ModelsWire,
      onChanged, onBack,
    })))
  }
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove() })
  await render()
  const button = (text: string): HTMLButtonElement => {
    const found = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
    expect(found, `button ${text}`).toBeDefined()
    return found!
  }
  return {
    container, button, discoverModels, mutate, onChanged, onBack,
    click: async (text: string) => { await act(async () => button(text).click()) },
    input: async (value: string) => { await input(container.querySelector('input')!, value) },
    rerender: async (next: ModelsSettingsState) => { state = next; await render() },
  }
}

async function input(element: HTMLInputElement, value: string): Promise<void> {
  // 使用原生 setter，模拟用户输入，让 React 的 value tracker 观察到变化。
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  await act(async () => element.dispatchEvent(new window.Event('input', { bubbles: true })))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('多选 A/B 一次追加，保留旧模型完整字段且仅写 models path 和 revision', async () => {
  const ui = await mount()
  await ui.click('new-a128K')
  await ui.click('new-b')
  // 旧单选实现到这里仅保留 B，且只能进入配置页；批量操作必须存在并保存 A/B。
  expect(ui.container.textContent).toContain('添加所选模型（2）')
  await ui.click('添加所选模型（2）')
  expect(ui.mutate).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', [{
    op: 'set', path: ['providers', 'saved-gateway', 'models'], value: [existing,
      { id: 'new-a', contextWindow: 128000, maxTokens: 16000 }, { id: 'new-b' }],
  }], 7)
  expect(ui.onChanged).toHaveBeenCalledTimes(1)
  expect(ui.onBack).toHaveBeenCalledTimes(1)
})

it('再次侦测确实重新请求，并清空旧发现及勾选、保留手动 ID', async () => {
  const pending = deferred<unknown>()
  const discoverModels = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: [{ id: 'new-a' }] })
    .mockReturnValueOnce(pending.promise)
  const ui = await mount({ discoverModels })
  await ui.click('new-a')
  await ui.input('  manual  ')
  await ui.click('侦测可用模型')
  expect(discoverModels).toHaveBeenCalledTimes(2)
  expect(discoverModels).toHaveBeenLastCalledWith('llm-pi-ai', {
    provider: 'saved-gateway', baseURL: 'http://127.0.0.1:18349/v1', api: 'anthropic-messages',
  })
  expect(ui.container.textContent).not.toContain('new-a')
  expect(ui.container.querySelector('input')!.value).toBe('  manual  ')
  expect(ui.button('添加所选模型（1）').disabled).toBe(true)
  await act(async () => pending.resolve({ ok: true, value: [{ id: 'new-b' }] }))
  await ui.click('添加所选模型（1）')
  expect(ui.mutate.mock.calls[0][1][0].value).toEqual([existing, { id: 'manual' }])
})

it('全选仅包含新增 ID，发现重复和手动重复都只添加一次，已有项不可选择', async () => {
  const ui = await mount({ discoverModels: vi.fn(async () => ({ ok: true, value: [
    { id: 'existing' }, { id: 'new-a' }, { id: 'new-a' }, { id: 'new-b' },
  ] })) })
  expect(ui.button('existing已配置').disabled).toBe(true)
  expect(Array.from(ui.container.querySelectorAll('button')).filter(b => b.textContent === 'new-a')).toHaveLength(1)
  await ui.click('全选')
  expect(ui.button('添加所选模型（2）').disabled).toBe(false)
  await ui.click('取消全选')
  expect(ui.button('添加所选模型（0）').disabled).toBe(true)
  await ui.click('全选')
  await ui.input('  new-a  ')
  expect(ui.button('添加所选模型（2）').disabled).toBe(false)
  await ui.click('添加所选模型（2）')
  expect(ui.mutate.mock.calls[0][1][0].value).toEqual([existing, { id: 'new-a' }, { id: 'new-b' }])
})

it('手动输入空白或已有 ID 不可保存，取消多选不写入', async () => {
  const ui = await mount()
  await ui.input('  ')
  expect(ui.button('添加所选模型（0）').disabled).toBe(true)
  await ui.input(' existing ')
  expect(ui.button('添加所选模型（0）').disabled).toBe(true)
  await ui.click('new-b')
  await ui.click('取消')
  expect(ui.onBack).toHaveBeenCalledTimes(1)
  expect(ui.mutate).not.toHaveBeenCalled()
})

it('发现错误显示并允许重试，错误后可手动添加，刷新失败不残留旧候选', async () => {
  const discoverModels = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: [{ id: 'old-candidate' }] })
    .mockResolvedValueOnce({ ok: false, error: { code: 'model-discovery-failed', message: '401 authentication failed' } })
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValueOnce({ ok: true, value: [] })
    .mockResolvedValueOnce({ ok: false, error: { code: 'model-discovery-failed', message: 'network unavailable' } })
  const ui = await mount({ discoverModels })
  await ui.click('old-candidate')
  await ui.click('侦测可用模型')
  expect(ui.container.textContent).toContain('401 authentication failed')
  expect(ui.container.textContent).not.toContain('old-candidate')
  expect(ui.button('添加所选模型（0）').disabled).toBe(true)
  await ui.click('侦测可用模型')
  expect(ui.container.textContent).toContain('network unavailable')
  await ui.click('侦测可用模型')
  expect(ui.container.textContent).not.toContain('network unavailable')
  expect(ui.button('添加所选模型（0）').disabled).toBe(true)
  await ui.input('custom-only')
  await ui.click('侦测可用模型')
  expect(ui.container.textContent).toContain('network unavailable')
  await ui.click('添加所选模型（1）')
  expect(ui.mutate.mock.calls[0][1][0].value).toEqual([existing, { id: 'custom-only' }])
})

it('保留无网络发现的官方 catalog fallback 和无目录的手动提示', async () => {
  const state = snapshot()
  const ui = await mount({ state, discoverModels: vi.fn(async () => ({ ok: false, error: {
    code: 'NO_DISCOVERY', message: 'no model discovery is registered for llm-pi-ai',
  } })) })
  expect(ui.container.textContent).toContain('内置模型目录')
  expect(ui.button('existing96K已配置').disabled).toBe(true)
  expect(ui.mutate).not.toHaveBeenCalled()
  const manual = await mount({ discoverModels: vi.fn(async () => ({ ok: false, error: {
    code: 'model-discovery-failed', message: 'provider ships no catalog',
  } })) })
  expect(manual.container.textContent).toContain('请用下方自定义输入模型 id 添加')
  await manual.input('manual')
  await manual.click('添加所选模型（1）')
  expect(manual.mutate).toHaveBeenCalledTimes(1)
})

it('只读、侦测中和保存中不可提交；保存中刷新、选择、输入及返回不能改变操作', async () => {
  const pendingDiscovery = deferred<unknown>()
  const pendingSave = deferred<unknown>()
  const ui = await mount({ discoverModels: vi.fn(() => pendingDiscovery.promise), mutate: vi.fn(() => pendingSave.promise) })
  expect(ui.button('添加所选模型（0）').disabled).toBe(true)
  expect(ui.button('侦测中…').disabled).toBe(true)
  await act(async () => pendingDiscovery.resolve({ ok: true, value: [{ id: 'new-a' }, { id: 'new-b' }] }))
  await ui.click('new-a')
  const readOnly = snapshot()
  readOnly.writable = false
  await ui.rerender(readOnly)
  expect(ui.button('添加所选模型（1）').disabled).toBe(true)
  await ui.rerender(snapshot())
  await act(async () => { ui.button('添加所选模型（1）').click(); ui.button('添加所选模型（1）').click() })
  expect(ui.mutate).toHaveBeenCalledTimes(1)
  expect(ui.button('保存中…').disabled).toBe(true)
  expect(ui.button('侦测可用模型').disabled).toBe(true)
  expect(ui.button('new-b').disabled).toBe(true)
  expect(ui.button('取消').disabled).toBe(true)
  expect(ui.container.querySelector('input')!.disabled).toBe(true)
  await ui.click('返回 Saved gateway')
  expect(ui.onBack).not.toHaveBeenCalled()
  await act(async () => pendingSave.resolve({ ok: true, value: { revision: 8, user: {} } }))
  expect(ui.onChanged).toHaveBeenCalledTimes(1)
  expect(ui.onBack).toHaveBeenCalledTimes(1)
})

it('最新 snapshot 用最新 revision 与完整旧行；缺失 namespace 或 profile 时安全失败', async () => {
  const ui = await mount()
  await ui.click('new-b')
  const missing = snapshot()
  missing.namespaces = new Map()
  await ui.rerender(missing)
  expect(ui.button('添加所选模型（1）').disabled).toBe(true)
  expect(ui.container.textContent).toContain('无法解析设置命名空间')
  const missingProfile = snapshot()
  missingProfile.namespaces.get('llm-pi-ai')!.value = { providers: {} }
  await ui.rerender(missingProfile)
  expect(ui.button('添加所选模型（1）').disabled).toBe(true)
  expect(ui.container.textContent).toContain('供应商配置已不存在')
  expect(ui.mutate).not.toHaveBeenCalled()
  const next = snapshot()
  const namespace = next.namespaces.get('llm-pi-ai')!
  Object.assign(namespace, { revision: 12 })
  ;(namespace.value as any).providers['saved-gateway'].models.push({ id: 'concurrent', extra: true })
  await ui.rerender(next)
  await ui.click('添加所选模型（1）')
  expect(ui.mutate).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', [{ op: 'set',
    path: ['providers', 'saved-gateway', 'models'],
    value: [existing, { id: 'concurrent', extra: true }, { id: 'new-b' }],
  }], 12)
})

it('revision 冲突和保存异常显示失败，留在页面并保留选择，不回报成功', async () => {
  const mutate = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'settings/conflict', message: 'revision conflict' } })
    .mockRejectedValueOnce(new Error('write unavailable'))
  const ui = await mount({ mutate })
  await ui.click('new-b')
  await ui.click('添加所选模型（1）')
  expect(ui.container.textContent).toContain('revision conflict')
  expect(ui.button('添加所选模型（1）').disabled).toBe(false)
  await ui.click('添加所选模型（1）')
  expect(ui.container.textContent).toContain('write unavailable')
  expect(ui.onChanged).not.toHaveBeenCalled()
  expect(ui.onBack).not.toHaveBeenCalled()
})

it('供应商详情更新地址后，添加页从最新 state 取得 endpoint、api 和已有模型', async () => {
  const { ModelsSection } = await import('../src/client/ModelsSection.tsx')
  let state = snapshot()
  const discoverModels = vi.fn(async () => ({ ok: true, value: [{ id: 'existing' }, { id: 'added-elsewhere' }, { id: 'new-b' }] }))
  const mutate = vi.fn(async (_ns, ops) => {
    ;(state.namespaces.get('llm-pi-ai')!.value as any).providers['saved-gateway'].models = ops[0].value
    return { ok: true, value: { revision: 13, user: {} } }
  })
  const load = vi.fn(async () => {})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async () => { await act(async () => root.render(createElement(ModelsSection, {
    controller: { load } as never, useSnapshot: (select: any) => select(state),
    api: { llm: { discoverModels }, settings: { mutate } } as unknown as ModelsWire, schema,
    t: (key: any) => key, activeLocale: () => 'zh-CN', renderSlot: () => null,
  }))) }
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove() })
  const click = async (text: string) => { await act(async () => {
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)
    expect(button, text).toBeDefined()
    button!.click()
  }) }
  await render()
  await click('Saved gateway')
  // 原有模型仍进入可编辑页面，清理新建路由不能影响编辑/删除入口。
  const modelButton = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('existing'))!
  await act(async () => modelButton.click())
  expect(container.textContent).toContain('删除模型')
  expect(container.textContent).toContain('连通性测试')
  await click('取消')
  state = snapshot()
  const profile = (state.namespaces.get('llm-pi-ai')!.value as any).providers['saved-gateway']
  profile.baseURL = 'http://127.0.0.1:18350/v2'
  profile.api = 'openai-responses'
  profile.models.push({ id: 'added-elsewhere' })
  await render()
  await click('添加模型')
  expect(discoverModels).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', {
    provider: 'saved-gateway', baseURL: 'http://127.0.0.1:18350/v2', api: 'openai-responses',
  })
  const configured = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'added-elsewhere已配置')!
  expect(configured.disabled).toBe(true)
  await click('new-b')
  await click('添加所选模型（1）')
  expect(load).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('添加模型')
  expect(container.textContent).toContain('new-b')
})
