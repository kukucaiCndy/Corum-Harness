/**
 * @corum/corum-ide-project-ui client half — 侧栏项目模式内容（付费版组合）。
 *
 * 占 corum-ide-sidebar-ui 骨架声明的 `corum.sidebar.project` 子槽：打开项目分流
 * （existing 直读 / 空目录进创建向导）+ 项目创建向导 + 项目详情（项目卡 / 管理段 /
 * 团队段）。骨架经 `hooks.projectOccupied` 探测到本子槽有 occupant 后才显示
 * 「项目」tab；付费版组合 = ide-sidebar（骨架+任务）+ 本插件，开源版不含本插件。
 *
 * 数据：项目/团队/计数走 host Typert RPC（corumProject / corumProjectData /
 * corumAgent / corumTeam，IDE combo 注入 @corum/corum-agent-dev 后可用）；团队段的
 * 泳道会话行走运行时对象层 `ctx.sessions.list`（uSES），点击会话经 `ctx.sessions.open`。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@corum/corum-ide-ui/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
import { ProjectPane } from './ProjectPane.tsx'
import type { ProjectPaneInjected } from './ProjectPane.tsx'

/** Required services: the slots registry + the runtime sessions layer + the official connection rpc. */
export const inject = ['slots', 'sessions', 'uiSession', 'connection']

/**
 * Client plugin body: fill the skeleton's project child hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('corum.sidebar.project', () => ctx.slots.register(
      {
        name: 'corum.sidebar.project',
        inject: (): ProjectPaneInjected => ({
          list: ctx.sessions.list,
          open: (sessionId: SessionId) => { ctx.sessions.open(sessionId) },
          pendingInteractions: (ctx as unknown as { uiSession: { pendingInteractions: ProjectPaneInjected['pendingInteractions'] } }).uiSession.pendingInteractions,
          callRemote: makeCorumRpcCall(ctx.get('connection') as ConnectionHandle),
        }),
      },
      ProjectPane,
    )),
    'ide-project: corum.sidebar.project project pane',
  )
}
