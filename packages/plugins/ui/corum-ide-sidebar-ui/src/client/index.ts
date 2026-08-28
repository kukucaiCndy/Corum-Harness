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
          startSession: (workspaceId?: WorkspaceId) => { ctx.workspaces.startSession(workspaceId) },
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
          // 分叉会话：从源会话最近完成轮次切出子会话并打开（官方 fork 语义）。
          fork: async (sessionId) => {
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
