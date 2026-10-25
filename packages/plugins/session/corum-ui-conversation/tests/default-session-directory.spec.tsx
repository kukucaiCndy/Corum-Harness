import { beforeEach, describe, expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as (() => unknown)[], initial: true }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(hooks.values[index]) : next }]
  },
  useRef: (value: unknown) => ({ current: value }), useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => { if (hooks.initial) hooks.effects.push(fn) },
}))
import { EmptyStateHero } from '../src/client/skeleton/EmptyStateHero.tsx'
type Element = { type: unknown; props: Record<string, any> }
function elements(node: any): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return node?.props ? [node, ...elements(node.props.children)] : []
}
async function form(workspaces = [{ id: 'existing', title: '项目', path: 'E:/existing' }]) {
  const submitted: unknown[] = []; let picked = 0
  const actions: any = { listAgents: async () => [{ id: 'agent', source: 'corum', defaultModel: { provider: 'p', model: 'm' } }], defaultAgentPreset: async () => 'agent', listModelCatalog: async () => [],
    listWorkspaces: async () => workspaces, listPermissions: async () => ({ presets: [{ id: 'workspace-write' }], defaultPreset: 'workspace-write' }),
    pickDirectory: async () => { picked++; return 'C:/picked' }, newTask: async (value: unknown) => { submitted.push(value) } }
  hooks.values = [true]; hooks.index = 0
  const hero = EmptyStateHero({ emptyActions: actions, newTaskForm: { consumePending: () => false, onOpen: () => () => {} }, recentTasks: [], dark: true })
  const child = elements(hero).find(node => typeof node.type === 'function' && (node.type as Function).name === 'NewTaskForm')!
  hooks.values = []; hooks.index = 0; hooks.effects = []
  const render = () => { hooks.index = 0; return (child.type as Function)(child.props) }
  let tree = render(); hooks.effects.forEach(effect => effect()); hooks.initial = false
  await new Promise(resolve => setTimeout(resolve, 0)); tree = render()
  return { render, tree, submitted, picked: () => picked }
}
beforeEach(() => { hooks.values = []; hooks.index = 0; hooks.effects = []; hooks.initial = true })
describe('新建会话默认目录', () => {
  it.each([{ workspaces: [] }, { workspaces: [{ id: 'existing', title: '项目', path: 'E:/existing' }] }])('未选择工作区可提交，已有工作区也不自动选首项', async ({ workspaces }) => {
    const x = await form(workspaces)
    const submit = elements(x.tree).find(node => node.props.type === 'submit')!
    expect(submit.props.disabled).toBe(false)
    expect(elements(x.tree).some(node => node.props.children === '默认会话目录')).toBe(true)
    x.tree.props.onSubmit({ preventDefault() {} }); await Promise.resolve()
    expect(x.submitted).toEqual([{ profileId: 'agent', permission: 'workspace-write', model: { provider: 'p', model: 'm' } }]); expect(x.picked()).toBe(0)
  })
  it('明确选择已有工作区才传 cwd，保留 Agent/模型/权限', async () => {
    const x = await form(); elements(x.tree).find(node => node.props['aria-haspopup'] === 'menu')!.props.onClick()
    const open = x.render(); elements(open).find(node => node.type === 'button' && node.props.children?.[1]?.props?.children?.[0]?.props?.children === '项目')!.props.onClick()
    x.render().props.onSubmit({ preventDefault() {} }); await Promise.resolve()
    expect(x.submitted).toEqual([{ cwd: 'E:/existing', profileId: 'agent', permission: 'workspace-write', model: { provider: 'p', model: 'm' } }]); expect(x.picked()).toBe(0)
  })
  it('取消表单不会建目录或选择目录', async () => {
    const x = await form(); elements(x.tree).find(node => node.props['aria-label'] === '取消新建任务')!.props.onClick()
    expect(x.submitted).toEqual([]); expect(x.picked()).toBe(0)
  })
  it('仅明确打开本地文件夹时调用picker，选中的目录传给Host', async () => {
    const x = await form(); elements(x.tree).find(node => node.props['aria-haspopup'] === 'menu')!.props.onClick()
    elements(x.render()).find(node => node.props['data-pick'] === 'new')!.props.onClick(); await Promise.resolve()
    x.render().props.onSubmit({ preventDefault() {} }); await Promise.resolve()
    expect(x.picked()).toBe(1); expect(x.submitted[0]).toMatchObject({ cwd: 'C:/picked' })
  })
})
