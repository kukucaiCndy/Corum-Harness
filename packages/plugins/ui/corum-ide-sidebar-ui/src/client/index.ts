/**
 * @corum/corum-ide-sidebar-ui client half — the IDE left column (design.pen ①, 300px).
 *
 * 开源版组合 = 骨架 + 任务模式内容：
 * - 骨架（SidebarSkeleton）占壳的 `corum.sidebar` 槽，同一次 register 声明
 *   `corum.sidebar.sessions` / `corum.sidebar.project` 两个子槽（declaration = 占坑），
 *   自身只做品牌区 + 「项目/任务」模式切换 + 子槽渲染。
 * - 任务模式内容（SessionsPane）由本包注册进 `corum.sidebar.sessions`，数据来自
 *   运行时对象层（`ctx.sessions` / `ctx.workspaces`），不经 RPC。
 * - 项目模式内容（付费版）由独立插件占 `corum.sidebar.project`；槽空时骨架经
 *   `hooks.projectOccupied` 源探测到无 occupant，不显示「项目」tab。
 *
 * The slot declarations belong to @corum/corum-ide-ui (type-only import pulls
 * the SlotMap rows).
 */
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@corum/corum-ide-ui/client'
import { SidebarSkeleton } from './SidebarSkeleton.tsx'
import { SessionsPane } from './SessionsPane.tsx'
import type { SessionsPaneInjected } from './SessionsPane.tsx'

/**
 * 骨架 inject 面：只占坑 + 项目槽占用探测源。骨架不持有业务数据面——
 * 任务/项目内容的数据分别由两个子槽 occupant 各自的 inject 提供。
 */
export interface SidebarSkeletonInjected {
  /** 项目槽占用查询源（uSES）：付费版项目插件占用后骨架显示「项目」tab。 */
  hooks: {
    projectOccupied: {
      getSnapshot: () => boolean
      subscribe: (fn: () => void) => () => void
    }
  }
}

/** Required services: the slots registry + the runtime object layer. */
export const inject = ['slots', 'sessions', 'workspaces']

/** 调 host 的 corumAgent Typert remote（task 泳道端点，IDE combo 注入 corum-agent-dev 后可用）。 */
async function callAgentRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as {
    corumDesktop?: { unary?: (pathname: string, body?: string) => Promise<{ status: number; body: string }> }
  }).corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `corumAgent/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/corumAgent/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`corumAgent/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body) as { rpcId: string; result: { ok: boolean; value?: T; error?: { code: string; message: string } } }
  if (envelope.rpcId !== rpcId) throw new Error(`corumAgent/${method}: rpcId mismatch`)
  if (!envelope.result.ok) throw new Error(`${envelope.result.error?.code}: ${envelope.result.error?.message}`)
  return envelope.result.value as T
}

/**
 * Client plugin body: occupy corum.sidebar with the skeleton (declaring the
 * sessions/project child holes in the same register call), then fill the
 * open-source sessions hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('corum.sidebar', () => ctx.slots.register(
      {
        name: 'corum.sidebar',
        children: {
          'corum.sidebar.sessions': { kind: 'single', scope: 'root' },
          'corum.sidebar.project': { kind: 'single', scope: 'root' },
        },
        inject: (): SidebarSkeletonInjected => ({
          hooks: {
            projectOccupied: {
              getSnapshot: () => ctx.slots.entriesOfSlot('corum.sidebar.project').length > 0,
              subscribe: (fn) => ctx.slots.subscribe('corum.sidebar.project', fn),
            },
          },
        }),
      },
      SidebarSkeleton,
    )),
    'ide-sidebar: corum.sidebar skeleton',
  )

  // 任务模式内容（开源版核心功能面）：工作区分组会话列表 + 搜索 + 工作区管理。
  ctx.effect(
    () => ctx.slots.inject('corum.sidebar.sessions', () => ctx.slots.register(
      {
        name: 'corum.sidebar.sessions',
        inject: (): SessionsPaneInjected => ({
          list: ctx.sessions.list,
          workspaces: ctx.workspaces.list,
          open: (sessionId: SessionId) => { ctx.sessions.open(sessionId) },
          // 新会话：起 task 泳道（corum-task-*），不再走官方 session-*。cwd 取目标工作区
          // 路径（缺省继承当前会话 cwd），创建后 open 切到该泳道（官方对象层选中态驱动
          // 对话区联动）。
          startSession: (workspaceId?: WorkspaceId) => {
            void (async () => {
              const wsList = ctx.workspaces.list.getSnapshot()
              const cwd = workspaceId !== undefined
                ? wsList.items.find(w => w.workspaceId === workspaceId)?.path
                : (() => {
                    const cur = ctx.sessions.list.getSnapshot().current
                    return cur !== undefined ? ctx.sessions.list.getSnapshot().byId[cur]?.cwd : undefined
                  })()
              if (cwd === undefined || cwd === '') {
                console.error('[sidebar] 新会话失败：无法确定工作区路径', workspaceId)
                return
              }
              try {
                const { sessionId } = await callAgentRemote<{ sessionId: string }>('createTaskAgent', { cwd })
                ctx.sessions.open(sessionId as SessionId)
              } catch (err) {
                console.error('[sidebar] 创建 task 泳道会话失败', err)
              }
            })()
          },
          search: async (query, signal) => {
            const result = await ctx.sessions.search(query, signal)
            if (!result.ok) throw new Error(result.error.message)
            return result.value.items
          },
          rename: async (sessionId, title) => {
            const binding = ctx.sessions.binding(sessionId)
            if (binding === undefined) throw new Error(`unknown session "${sessionId}"`)
            const result = await binding.session.rename(title)
            if (!result.ok) throw new Error(result.error.message)
          },
          // 分叉会话：泳道 fork 第一版禁用（2026-08-28 决策 C——泳道 fork 涉及 preset/泳道
          // 归属，语义待单独设计）。官方 session-* 已不进 task 列表，故此处只需拦截泳道。
          fork: async (sessionId) => {
            if (String(sessionId).startsWith('corum-task-')) {
              console.warn('[sidebar] 泳道会话暂不支持分叉（语义待定）', sessionId)
              return
            }
            const childId = await ctx.sessions.fork({ sessionId })
            ctx.sessions.open(childId)
          },
          // 归档会话：隐藏出分组列表（日志与账号槽保留；归档当前会话则清空选择
          // 回新会话视图——官方 archiveSession 语义）。
          archive: async (sessionId) => {
            await ctx.workspaces.archiveSession(sessionId)
          },
          addWorkspace: async (path) => {
            await ctx.workspaces.create({ path })
          },
          pickDirectory: () => ctx.workspaces.pickDirectory(),
          renameWorkspace: async (workspaceId, title) => {
            await ctx.workspaces.rename(workspaceId, title)
          },
          deleteWorkspace: async (workspaceId) => {
            await ctx.workspaces.delete(workspaceId)
          },
        }),
      },
      SessionsPane,
    )),
    'ide-sidebar: corum.sidebar.sessions session list',
  )
}
