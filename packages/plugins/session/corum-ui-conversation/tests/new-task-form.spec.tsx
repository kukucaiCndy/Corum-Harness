import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EmptyStateHero } from '../src/client/skeleton/EmptyStateHero.tsx'

// 使用仓库已有 turndown 的 DOM 实现，不增加运行时或测试依赖。
const store = resolve(import.meta.dirname, '../../../../../node_modules/.pnpm')
const domino = readdirSync(store).find(name => name.startsWith('@mixmark-io+domino@'))!
const { createWindow } = createRequire(import.meta.url)(join(store, domino, 'node_modules/@mixmark-io/domino'))
const globalModel = { provider: 'local', model: 'global-a', reasoningEffort: 'medium' }
const profileModel = { provider: 'local', model: 'profile-b', reasoningEffort: 'high' }
let root: Root
let container: HTMLElement

beforeEach(() => {
  const window = createWindow('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
  container = document.getElementById('root')!
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})
async function click(text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
async function render(defaultId?: string, workspaces = [{ id: 'ws', title: 'Workspace', path: 'C:/fixture' }]) {
  const newTask = vi.fn(async () => {})
  const actions = {
    listAgents: async () => [{ id: 'official', name: 'Official', source: 'official' },
      { id: 'custom', name: 'Custom Agent', source: 'corum', trust: 'system', defaultModel: profileModel }],
    defaultAgentPreset: async () => defaultId,
    listModelCatalog: async () => ({ default: globalModel, groups: [{ id: 'local', name: 'Local', models: [
      { id: 'global-a', name: 'Global A', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'max', name: 'Maximum' }], defaultEffort: 'medium' } },
      { id: 'profile-b', name: 'Profile B', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
    ] }] }),
    listWorkspaces: async () => workspaces,
    listPermissions: async () => ({ defaultPreset: 'workspace-write', presets: [{ id: 'read-only', name: '只读' }, { id: 'workspace-write', name: '工作区写入' }] }),
    newTask,
  }
  await act(async () => root.render(<EmptyStateHero emptyActions={actions as never} newTaskForm={{ consumePending: () => true, onOpen: () => () => {} }} recentTasks={[]} dark={false} />))
  return newTask
}
async function submit() {
  const event = document.createEvent('Event'); event.initEvent('submit', true, true);
  await act(async () => container.querySelector('form')!.dispatchEvent(event))
}

describe('NewTaskForm 用户意图与模型预览', () => {
  it.each([undefined, 'official', 'custom'])('默认 Agent %s 只预览全局模型，提交不伪造选择', async defaultId => {
    const newTask = await render(defaultId)
    expect(container.textContent).toContain('默认 Agent（跟随设置）')
    expect(container.textContent).toContain('Global A')
    expect(container.textContent).toContain('Medium')
    await submit()
    expect(newTask).toHaveBeenCalledWith({ cwd: 'C:/fixture', permission: 'workspace-write' })
  })
  it('手选 Agent 才提交 profileId，模型预览包含 effort 且不伪造 model', async () => {
    const newTask = await render('official')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择执行 Agent"]')!.click())
    await click('Custom Agent')
    expect(container.textContent).toContain('Profile B')
    expect(container.textContent).toContain('High')
    await submit()
    expect(newTask).toHaveBeenCalledWith({ cwd: 'C:/fixture', permission: 'workspace-write', profileId: 'custom' })
  })
  it('选择默认 Agent 可以回到全局默认语义', async () => {
    const newTask = await render()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择执行 Agent"]')!.click())
    await click('Custom Agent')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择执行 Agent"]')!.click())
    await click('默认 Agent（跟随设置）')
    expect(container.textContent).toContain('Global A')
    await submit()
    expect(newTask).toHaveBeenCalledWith({ cwd: 'C:/fixture', permission: 'workspace-write' })
  })
  it('没有工作区仍阻止提交', async () => {
    const newTask = await render(undefined, [])
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true)
    await submit()
    expect(newTask).not.toHaveBeenCalled()
  })
  it('显式模型与 effort 保留最高优先，切换 Agent 不覆盖它', async () => {
    const newTask = await render()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择模型与推理等级"]')!.click())
    await click('模型Global A')
    await click('Global A')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择模型与推理等级"]')!.click())
    await click('推理等级Medium')
    await click('Maximum')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择执行 Agent"]')!.click())
    await click('Custom Agent')
    expect(container.textContent).toContain('Global A')
    expect(container.textContent).toContain('Maximum')
    await submit()
    expect(newTask).toHaveBeenCalledWith({ cwd: 'C:/fixture', permission: 'workspace-write', profileId: 'custom', model: { ...globalModel, reasoningEffort: 'max' } })
  })
})
