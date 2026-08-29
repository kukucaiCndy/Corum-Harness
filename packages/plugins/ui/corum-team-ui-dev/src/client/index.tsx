/**
 * @corum/corum-team-ui-dev client half — 全局团队管理的浏览器半。
 *
 * 导出 TeamManagerPanel 组件，供其他 shell（如 dev-agent-shell 的 AgentTestPanel
 * 「团队」tab）嵌入；也可独立注册 root 槽（用于单独的团队管理 combo / IDE 复用）。
 *
 * TeamManagerPanel 经官方 connection.rpc（0.1.2 起）调 /api/corumTeam/*
 * （CorumTeamService）与 /api/corumAgent/listProfiles（选 Agent）；旧
 * corumDesktop.unary IPC 桥已退役。
 * 团队是全局的预设 Agent 集合，与项目无关——项目组在项目语境里单独管理。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { ThemePresenter } from '@corum/corum-ui-base/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
import { TeamManagerPanel } from './TeamManagerPanel.tsx'

export { TeamManagerPanel } from './TeamManagerPanel.tsx'
export type { TeamManagerPanelProps } from './TeamManagerPanel.tsx'

export const inject = ['slots', 'theme', 'connection']

export function apply(ctx: ClientContext): void {
  // 主题投影
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'dev-team-shell: theme presenter')

  // root 槽注册：当作为独立 combo 运行时，TeamManagerPanel 占满窗口。
  ctx.effect(() => {
    const callRemote = makeCorumRpcCall(ctx.get('connection') as ConnectionHandle)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {},
      inject: () => ({ callRemote }),
    }, TeamManagerPanel)
    return () => { disposeRegistration() }
  }, 'dev-team-shell: root registration')
}
