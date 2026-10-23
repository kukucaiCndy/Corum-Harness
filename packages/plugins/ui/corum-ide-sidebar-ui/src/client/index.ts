/**
 * @corum/corum-ide-sidebar-ui client half — the IDE left column (design.pen ①, 300px).
 *
 * 开源版组合 = 骨架 + 任务模式内容：
 * - 骨架（SidebarSkeleton）占壳的 `corum.sidebar` 槽，同一次 register 声明
 *   `corum.sidebar.sessions` / `corum.sidebar.project` 两个子槽（declaration = 占坑），
 *   自身只做品牌行（品牌卡 + 版本小字 + 档位徽标）+ 子槽渲染；PR1 起不再有
 *   「项目/任务」模式切换 UI（改由活动栏承担）。
 * - 任务模式内容（SessionsPane）由本包注册进 `corum.sidebar.sessions`，数据来自
 *   运行时对象层（`ctx.sessions` / `ctx.workspaces`），不经 RPC。
 * - 项目模式内容（付费版）由独立插件占 `corum.sidebar.project`；槽空时骨架经
 *   `hooks.projectOccupied` 源探测到无 occupant，不显示项目面板、档位徽标显示「社区版」。
 *
 * The slot declarations belong to @corum/corum-ide-ui (type-only import pulls
 * the SlotMap rows).
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@corum/corum-ide-ui/client'
import type { SidebarMode, SidebarModeSource } from '@corum/corum-ide-ui/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
// C3b：corum-agent 跨域 RPC 契约——方法名常量 + args/result 类型（type-only）。
import {
  CORUM_AGENT_METHODS,
  type CreateTaskAgentArgs, type CreateTaskAgentResult,
} from '@corum/corum-agent/contract'
import { SidebarSkeleton } from './SidebarSkeleton.tsx'
import { SessionsPane } from './SessionsPane.tsx'
import type { SessionsPaneInjected } from './SessionsPane.tsx'

/**
 * 骨架 inject 面：只占坑 + 项目槽占用探测源。骨架不持有业务数据面——
 * 任务/项目内容的数据分别由两个子槽 occupant 各自的 inject 提供。
 */
export interface SidebarSkeletonInjected {
  /** 项目槽占用查询源（uSES）：付费版项目插件占用后骨架渲染项目面板、档位徽标显示 PRO。 */
  hooks: {
    projectOccupied: {
      getSnapshot: () => boolean
      subscribe: (fn: () => void) => () => void
    }
    /**
     * 侧栏模式源（C3a：ctx.layout 服务的 uSES 投影，跨 bundle 单例）。骨架经
     * 选择器 Hook 读当前模式；写模式走 `setSidebarMode` 动作（同服务）。
     * 原 window 全局 __corumSidebarMode 广播已退役。
     */
    sidebarMode: SidebarModeSource
  }
  /** 写侧栏模式（直通 ctx.layout.setSidebarMode）。 */
  setSidebarMode: (mode: SidebarMode) => void
}

/** Required services: the slots registry + the runtime object layer + the official connection rpc + the layout face (ctx.layout.openNewTaskForm)。 */
export const inject = ['slots', 'sessions', 'workspaces', 'uiSession', 'connection', 'layout', 'settingsScope']

/**
 * 调 host 的 corumAgent Typert remote（task 泳道端点，IDE combo 注入 corum-agent-dev 后可用）。
 * 0.1.2 起走官方 connection.rpc（旧 corumDesktop.unary IPC 桥已退役）。
 */
function makeCallAgentRemote(connection: ConnectionHandle) {
  const call = makeCorumRpcCall(connection)
  return function callAgent<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return call('corumAgent', method, args)
  }
}

/**
 * Client plugin body: occupy corum.sidebar with the skeleton (declaring the
 * sessions/project child holes in the same register call), then fill the
 * open-source sessions hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const callAgentRemote = makeCallAgentRemote(connection)
  // 目录选择（host directoryPicker Remote）。**不用 `ctx.remote`**——本插件 fiber 的
  // inject 虽声明了 connection，但 `ctx.remote` 命名空间代理由 connection 服务随
  // fiber 装配，直接 `ctx.remote.directoryPicker` 会抛「cannot get property "remote"
  // without inject」（2026-08-31 用户实测「添加工作区」踩中，PROGRESS §4 同款坑）。
  // 改走官方 `connection.rpc.call` 打同一端点 `directoryPicker/pick`，与
  // makeCorumRpcCall 同通道、同 `{args}` 契约，不依赖 fiber 上的 remote 命名空间。
  const pickDir = async (): Promise<string | null> => {
    const result = await connection.rpc.call('/api', 'directoryPicker/pick', { args: {} })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as string | null
  }
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
            sidebarMode: ctx.layout.sidebarModeSnapshot(),
          },
          setSidebarMode: (mode) => { ctx.layout.setSidebarMode(mode) },
        }),
      },
      SidebarSkeleton,
    )),
    'ide-sidebar: corum.sidebar skeleton',
  )

  /**
   * fork（corum）：**启动时**保证每个已注册工作区都是 git 仓库
   * （2026-09-11 用户定调：打开工作区的行为固定为「探测，没有就初始化」，
   * 不再有 autoInitGit 开关、也不询问）。
   *
   * 只跑一次：等列表首次非空（boot 早期快照可能是空的）→ 串行 ensureRepo →
   * 退订。串行是刻意的：并发会对每个工作区各起一个 git 进程。单个工作区失败只
   * warn 不阻断 —— 不影响其余工作区，且隔离等能力自带非 git 降级。
   */
  ctx.effect(() => {
    let done = false
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    const run = (): void => {
      if (done || cancelled) return
      const items = ctx.workspaces.list.getSnapshot().items
      if (items.length === 0) return
      done = true
      unsubscribe?.()
      void (async () => {
        for (const ws of items) {
          if (cancelled) return
          const path = (ws as { path?: string }).path
          if (typeof path !== 'string' || path === '') continue
          try {
            // eslint-disable-next-line no-await-in-loop -- 串行：避免一次起多个 git 进程
            await connection.rpc.call('/api', 'corumGit/ensureRepo', { args: { path } })
          } catch (error) {
            console.warn('[ui-sidebar] ensureRepo failed', { path, error })
          }
        }
      })()
    }
    unsubscribe = ctx.workspaces.list.subscribe(run)
    run() // 订阅前可能已经加载好了
    return () => { cancelled = true; unsubscribe?.() }
  }, 'ui-sidebar: ensure git repos at boot')

  // 任务模式内容（开源版核心功能面）：工作区分组会话列表 + 搜索 + 工作区管理。
  ctx.effect(
    () => ctx.slots.inject('corum.sidebar.sessions', () => ctx.slots.register(
      {
        name: 'corum.sidebar.sessions',
        inject: (): SessionsPaneInjected => {
          // 0.1.2 修复：ctx.workspaces.list 的 getSnapshot/subscribe 是类实例方法（内部
          // this.refreshSnapshot），作为裸引用传给 useSyncExternalStore 会丢 this 抛
          // 「Cannot read properties of undefined (refreshSnapshot)」。绑定实例后下发。
          const wsList = ctx.workspaces.list
          return {
          list: ctx.sessions.list,
          workspaces: {
            getSnapshot: () => wsList.getSnapshot(),
            subscribe: (listener: () => void) => wsList.subscribe(listener),
          },
          // 0.1.2：SessionSummary.pendingInteraction 移除，状态点的「等待操作」判定改读
          // uiSession.pendingInteractions 快照（SessionId keyed，审批/提问等 pending 在此）。
          pendingInteractions: (ctx as unknown as { uiSession: { pendingInteractions: SessionsPaneInjected['pendingInteractions'] } }).uiSession.pendingInteractions,
          open: (sessionId: SessionId) => { ctx.sessions.open(sessionId) },
          // 顶部「新会话」主按钮：回空态（sessions.clear 取消选中 → 对话区回落到
          // 空态）+ ctx.layout.openNewTaskForm 让空态打开「新建任务」表单。与空态
          // 「新建任务」卡同一流程（选工作区/Agent/模型/权限 → 开始），不直接建会话。
          // openNewTaskForm 内部已含「空态未挂载时置 pending、挂载时认领」语义
          // （替代原 CustomEvent + sessionStorage 桥）。
          openNewTaskForm: () => {
            ctx.sessions.clear()
            ctx.layout.openNewTaskForm()
          },
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
                const args: CreateTaskAgentArgs = { cwd }
                const { sessionId } = await callAgentRemote<CreateTaskAgentResult>(CORUM_AGENT_METHODS.createTaskAgent, args)
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
          // fork（corum）：工作区 git 侦测/初始化（2026-09-09 用户需求）——新建
          // 工作区时侦测 git 仓库，没有则询问初始化（子 Agent 编排隔离等 git 依赖
          // 能力的前置）。调 host corumGit Remote，与 directoryPicker 同一 connection.rpc
          // 通道（不经 fiber remote 命名空间代理，PROGRESS §4 同款坑规避）。
          gitWorkspaceStatus: async (path) => {
            const result = await connection.rpc.call('/api', 'corumGit/status', { args: { path } })
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
            return (result.value as { isRepo: boolean }).isRepo
          },
          gitWorkspaceInit: async (path) => {
            const result = await connection.rpc.call('/api', 'corumGit/init', { args: { path } })
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
            return result.value as { initialized: boolean; alreadyRepo: boolean }
          },
          // 0.1.2：IWorkspaces.pickDirectory 移除，目录选择走 directoryPicker Remote。
          pickDirectory: pickDir,
          renameWorkspace: async (workspaceId, title) => {
            await ctx.workspaces.rename(workspaceId, title)
          },
          deleteWorkspace: async (workspaceId) => {
            // 删除成功时工作区快照可能已移除该项，先保留其会话归属。
            const sessionIds = [...(wsList.getSnapshot().items
              .find(ws => ws.workspaceId === workspaceId)?.sessionIds ?? [])]
            await ctx.workspaces.delete(workspaceId)
            // 读取此刻的选择，避免删除等待期间切换到其他工作区后被误清空。
            const current = ctx.sessions.list.getSnapshot().current
            if (current !== undefined && sessionIds.includes(current)) ctx.sessions.clear()
          },
          // 保存会话日志到…（2026-09-16 用户定调：入口从会话头部右上角搬进会话行右键菜单）。
          //
          // **为什么用 ctx.reflect.get 而不是 inject 声明**：保存能力的实现在
          // `corum-session-archive`，它是**可选**插件（发行版组合可无）。cordis 的
          // `inject` 没有「可选依赖」形态（`Inject = (keyof M)[] | {...}`，声明即硬依赖、
          // fiber 会等它装配）⇒ 若把 sessionArchive 写进本插件顶层 `inject`，未装存档
          // 插件时**整个侧栏都装不起来**（拿不到保存能力不该让会话列表消失）。
          // 官方 `reflect.get` 的文档语义正是这个场景：「Read a service from the store
          // **without the inject requirement**」，未装配时返回 undefined。
          // ⇒ 缺席即不渲染菜单项（`saveSession: undefined`），不留死按钮。
          //
          // ⚠️ **本字段是「解析器」不是「动作」**（每次渲染调用一次）。原因：槽的
          // inject 面结果被 ui-renderer **按 entry 永久缓存**（scoped-slots.tsx 的
          // `rootInjectCache` 只跑一次 `runInject`）。若在这里直接算成常量，一旦存档
          // 插件**晚于**侧栏装配（或经插件中心动态启用），这里会永久冻结成 undefined
          // ⇒ 菜单项永远不出现。返回访问器即可每次拿到「此刻是否已有该服务」。
          //
          // 类型面用**局部能力接口**收窄（红线 3：官方基座类型不含该服务，corum 运行时
          // 是超集），不 import 实现包、不在编译期耦合 ui 组 → session 组。
          resolveSaveSession: () => {
            const archive = (ctx.reflect as unknown as {
              get: (name: string) => { save: (id: SessionId) => Promise<void> } | undefined
            }).get('sessionArchive')
            if (archive === undefined) return undefined
            // 绑定实例方法（与上面 wsList 同一坑：类实例方法作裸引用会丢 this）。
            return (sessionId: SessionId) => archive.save(sessionId)
          },
          }
        },
      },
      SessionsPane,
    )),
    'ide-sidebar: corum.sidebar.sessions session list',
  )
}
