import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import type { SessionsPaneInjected } from '../src/client/SessionsPane.tsx'

// 本组只测槽注入动作，组件渲染交给独立实例的 UI 回归验证。
vi.mock('../src/client/SessionsPane.tsx', () => ({ SessionsPane: () => null }))
vi.mock('../src/client/SidebarSkeleton.tsx', () => ({ SidebarSkeleton: () => null }))

// 在真实槽注册边界取得动作；仅替代 host RPC 与运行时服务，不复制删除逻辑。
function setup(current: string | undefined = 'corum-task-a') {
  let selected = current
  let items = [
    { workspaceId: 'workspace-a', sessionIds: ['corum-task-a', 'corum-task-a2'] },
    { workspaceId: 'workspace-b', sessionIds: ['corum-task-b'] },
  ]
  let actions!: SessionsPaneInjected
  let deleteRemote = async (workspaceId: string) => {
    items = items.filter(ws => ws.workspaceId !== workspaceId)
  }
  const ctx = {
    get: () => ({ rpc: {} }),
    effect: (run: () => unknown, label: string) => {
      if (label === 'ide-sidebar: corum.sidebar.sessions session list') run()
    },
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (entry: { inject: () => SessionsPaneInjected }) => { actions = entry.inject() },
    },
    sessions: {
      list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }) },
    },
    corumNavigation: {
      selection: { getSnapshot: () => ({ sessionId: selected }), subscribe: () => () => {} },
      clearSelection: () => { selected = undefined },
      openSession: (id: string) => { selected = id },
    },
    workspaces: {
      list: { getSnapshot: () => ({ items, archivedSessionIds: [] }) },
      delete: (workspaceId: string) => deleteRemote(workspaceId),
    },
    uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
  }
  apply(ctx as unknown as Parameters<typeof apply>[0])
  return {
    remove: (id = 'workspace-a') => actions.deleteWorkspace(id as Parameters<typeof actions.deleteWorkspace>[0]),
    current: () => selected,
    workspaces: () => items,
    select: (id: string | undefined) => { selected = id },
    setRemote: (remote: typeof deleteRemote) => { deleteRemote = remote },
  }
}

describe('删除工作区后的会话选择', () => {
  it('移除当前工作区后返回首页，即使工作区快照已先更新', async () => {
    const app = setup()
    await app.remove()
    expect(app.workspaces().map(ws => ws.workspaceId)).toEqual(['workspace-b'])
    expect(app.current()).toBeUndefined()
  })

  it('删除其他工作区时保留当前会话', async () => {
    const app = setup('corum-task-b')
    await app.remove()
    expect(app.current()).toBe('corum-task-b')
  })

  it('删除失败时保留当前会话和工作区', async () => {
    const app = setup()
    app.setRemote(async () => { throw new Error('delete failed') })
    await expect(app.remove()).rejects.toThrow('delete failed')
    expect(app.current()).toBe('corum-task-a')
    expect(app.workspaces()).toHaveLength(2)
  })

  it.each([
    ['corum-task-b', 'corum-task-b'],
    ['corum-task-a2', undefined],
  ])('删除等待期间切换到 %s，完成后选择为 %s', async (next, expected) => {
    const app = setup()
    let finish!: () => void
    app.setRemote(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = app.remove()
    expect(app.current()).toBe('corum-task-a')
    app.select(next)
    finish()
    await pending
    expect(app.current()).toBe(expected)
  })

  it('首页删除工作区时保持首页', async () => {
    const app = setup()
    app.select(undefined)
    await app.remove()
    expect(app.current()).toBeUndefined()
  })

  it('移除未知工作区时保留当前会话', async () => {
    const app = setup()
    await app.remove('unknown-workspace')
    expect(app.current()).toBe('corum-task-a')
  })
})
