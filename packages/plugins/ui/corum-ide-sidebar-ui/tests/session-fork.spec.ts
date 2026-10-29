import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import type { SessionsPaneInjected } from '../src/client/SessionsPane.tsx'

// 本组只测槽注入的 fork 动作（真实槽注册边界），组件渲染交给实机验证。
vi.mock('../src/client/SessionsPane.tsx', () => ({ SessionsPane: () => null }))
vi.mock('../src/client/SidebarSkeleton.tsx', () => ({ SidebarSkeleton: () => null }))

function setup() {
  let actions!: SessionsPaneInjected
  const opened: string[] = []
  const forkCalls: Array<{ sessionId: string }> = []
  const ctx = {
    // makeCorumRpcCall(ctx.get('connection')) 经 connection.rpc.call('/api', 'svc/method', {args})。
    // fork 现在走 corum 自有端点 corumAgent/forkTaskAgent（官方 session/fork 对
    // corum profile 必然失败，见 forkAgentForTask 头注）。
    get: (name: string) => name === 'connection'
      ? {
          rpc: {
            call: async (_path: string, method: string, opts: { args: { sessionId: string } }) => {
              forkCalls.push({ method, sessionId: opts.args.sessionId } as never)
              return { ok: true, value: { sessionId: 'corum-fork-abc123' } }
            },
          },
        }
      : { rpc: {} },
    effect: (run: () => unknown, label: string) => {
      if (label === 'ide-sidebar: corum.sidebar.sessions session list') run()
    },
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (entry: { inject: () => SessionsPaneInjected }) => { actions = entry.inject() },
    },
    sessions: {
      list: { getSnapshot: () => ({ current: 'corum-task-a', ids: [], byId: {} }) },
      open: (id: string) => { opened.push(id) },
      binding: () => undefined,
      search: async () => ({ ok: true, value: { items: [] } }),
    },
    workspaces: {
      list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) },
      archiveSession: async () => {},
    },
    uiSession: { pendingInteractions: {} },
  }
  apply(ctx as unknown as Parameters<typeof apply>[0])
  return { actions, opened, forkCalls }
}

/**
 * 2026-10-29 用户反馈「分叉会话功能不可用」的回归网。
 *
 * 修复前 `index.ts` 对 `corum-task-*` 直接 `console.warn` + `return`，而侧栏列表
 * 只放行泳道会话 ⇒ 每一行可见会话点「分叉会话」都是 no-op（规范 §13.1 假入口）。
 * 这里钉住「泳道会话必须真的发起 fork 并打开子会话」。
 */
describe('泳道会话分叉', () => {
  it('对 corum-task-* 会话真正发起 fork（不再被拦截）', async () => {
    const app = setup()
    await app.actions.fork('corum-task-a' as Parameters<typeof app.actions.fork>[0])
    expect(app.forkCalls).toEqual([{ method: 'corumAgent/forkTaskAgent', sessionId: 'corum-task-a' }])
  })

  it('分叉成功后打开子会话（用户可见结果，不是静默 no-op）', async () => {
    const app = setup()
    await app.actions.fork('corum-task-a' as Parameters<typeof app.actions.fork>[0])
    expect(app.opened).toEqual(['corum-fork-abc123'])
  })
})
