import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionsPane, type SessionsPaneInjected } from '../src/client/SessionsPane.tsx'

/**
 * primitives 的运行时产物在本 checkout 里缺 `simple-icons`（官方 npm 包把 `shiki` /
 * `katex` / `simple-icons` 这些**运行时**依赖放进了 devDependencies —— 见
 * docs/LESSONS 与升级交接），直接 import 会让本文件整片 fail。本包只用到其中的 `Menu`
 * 与图标：mock 成无行为占位，被测的排序/默认视图/行组件仍是真实实现。
 * （同款写法见 `@corum/corum-ui-conversation` 的 permission-select.spec.tsx。）
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Icon = (): null => null
  return {
    Menu: ({ children }: { children?: unknown }) => children as never,
    IconChevronDownOutlineMedium: Icon,
    IconChevronUpOutlineMedium: Icon,
    IconChecklistOutlineMedium: Icon,
  }
})

// 服务器渲染只适配外部 store 的读取，排序、默认视图、行组件都走真实实现。
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useLayoutEffect: react.useEffect,
    useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T) =>
      react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot) }
})

function setup() {
  const newerId = 'corum-task-newer' as SessionId
  const olderId = 'corum-task-older' as SessionId
  const row = (id: SessionId, displayTitle: string, updatedAt: number): SessionSummary => ({
    id, displayTitle, cwd: 'C:\\work', running: false, blank: false, updatedAt,
  })
  const list = createSnapshotStore<SessionListState>({
    ids: [newerId, olderId],
    byId: {
      [newerId]: row(newerId, '新建但未再活跃', 2000),
      [olderId]: row(olderId, '较早创建刚刚活跃', 3000),
    },
    current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: [{ workspaceId: 'workspace-windows' as WorkspaceId, path: 'C:\\work', title: 'Windows 工作区',
      sessionIds: [newerId, olderId], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' }],
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  const noop = async () => {}
  // rc3 起 `SessionsPaneInjected` 多了两份必需快照（`sessionStatus` / `currentSelection`），
  // 旧版夹具没有它们 ⇒ 渲染时读 `undefined.subscribe`。本测试只关心排序，给空快照即可。
  const props: SessionsPaneInjected = {
    list,
    workspaces,
    sessionStatus: createSnapshotStore(new Map()),
    currentSelection: createSnapshotStore({}),
    open: () => {}, startSession: () => {}, openNewTaskForm: () => {},
    search: async () => [], rename: noop, fork: noop, archive: noop,
    addWorkspace: noop, gitWorkspaceStatus: async () => true,
    gitWorkspaceInit: async () => ({ initialized: false, alreadyRepo: true }),
    pickDirectory: async () => null, renameWorkspace: noop, deleteWorkspace: noop,
  }
  const titles = () => [...renderToStaticMarkup(<SessionsPane {...props} />)
    .matchAll(/title="(新建但未再活跃|较早创建刚刚活跃)"/g)].map(match => match[1])
  return { list, workspaces, newerId, titles }
}

describe('会话列表最近活跃排序', () => {
  it('默认把最后活跃的旧会话放在创建顺序靠前的新会话之前', () => {
    expect(setup().titles()).toEqual(['较早创建刚刚活跃', '新建但未再活跃'])
  })

  it('收到新的活跃时间后按新时间排序，不修改工作区的手动顺序', () => {
    const app = setup()
    app.list.update(state => {
      state.byId = { ...state.byId, [app.newerId]: { ...state.byId[app.newerId]!, updatedAt: 4000 } }
    })
    expect(app.titles()).toEqual(['新建但未再活跃', '较早创建刚刚活跃'])
    expect(app.workspaces.getSnapshot().items[0]?.sessionIds).toEqual(['corum-task-newer', 'corum-task-older'])
  })
})
