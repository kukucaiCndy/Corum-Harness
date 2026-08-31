/**
 * @corum/corum-agent-ui-dev client half — dev-agent combo 的浏览器半。
 *
 * 注册一个 root 槽 + 一个 dev.agent.test 区域槽，填充 AgentTestPanel。
 * AgentTestPanel 经官方 connection.rpc（0.1.2 起）调 /api/corumAgent/* 等
 * 端点（CorumAgentService @Remote；旧 corumDesktop.unary IPC 桥已退役），验证：
 *   - listProfiles：列出已保存的 AgentProfile
 *   - createAgent：创建 root Agent
 *   - runPrompt：给 Agent 一个 prompt，等回复
 *   - verify：冒烟测试
 *   - listAgents：列出已创建的 Agent
 *
 * 不依赖官方 ui-layout/ui-sidebar 等（dev-agent combo 不叠加 IDE overlay）。
 * 自带一个最小主题 presenter（shell-base ThemePresenter）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { ThemePresenter, registerSlot } from '@corum/corum-ui-base/client'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
import { AgentTestPanel } from './AgentTestPanel.tsx'

export const inject = ['slots', 'theme', 'connection']

/** 本插件自声明的网格槽 key（C1：插件自声明 UI 能力，替代壳层 EXCLUDE 清单）。 */
export const AGENT_TEST_SLOT = '@corum/corum-agent-ui-dev'

export function apply(ctx: ClientContext): void {
  // C1 插件自声明槽：visibility 'addable' —— 在 IDE combo 下本插件作为
  // 「Agent 测试面板」区域可被用户经插件中心/添加区域拖入网格；壳不再用
  // EXCLUDE 清单枚举它。dev-agent combo 下无壳扫描，本注册为无害 no-op。
  registerSlot(AGENT_TEST_SLOT, { label: 'Agent 测试', defaultWeight: 400, visibility: 'addable' })
  // 主题投影：body palette（官方 ui-layout 在 dev-agent 模式不禁用，
  // 但 ThemePresenter 是 shell-base 自带的，保证 dark mode 视觉一致）。
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'dev-agent-shell: theme presenter')

  // root 槽注册：AgentTestPanel 直接占满整个窗口。
  ctx.effect(() => {
    const callRemote = makeCorumRpcCall(ctx.get('connection') as ConnectionHandle)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {},
      inject: () => ({ callRemote }),
    }, AgentTestPanel)
    return () => { disposeRegistration() }
  }, 'dev-agent-shell: root registration')
}
