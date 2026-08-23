/**
 * @corum/corum-agent-ui-dev client half — dev-agent combo 的浏览器半。
 *
 * 注册一个 root 槽 + 一个 dev.agent.test 区域槽，填充 AgentTestPanel。
 * AgentTestPanel 通过桌面 IPC 桥（window.corumDesktop.unary）调
 * /api/corumAgent/* 端点（CorumAgentService @Remote），验证：
 *   - listProfiles：列出已保存的 AgentProfile
 *   - createAgent：创建 root Agent
 *   - runPrompt：给 Agent 一个 prompt，等回复
 *   - verify：冒烟测试
 *   - listAgents：列出已创建的 Agent
 *
 * 不依赖官方 ui-layout/ui-sidebar 等（dev-agent combo 不叠加 IDE overlay）。
 * 自带一个最小主题 presenter（shell-base ThemePresenter）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ThemePresenter } from '@corum/corum-ui-base/client'
import { AgentTestPanel } from './AgentTestPanel.tsx'

export const inject = ['slots', 'theme']

export function apply(ctx: ClientContext): void {
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
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {},
      inject: () => ({}),
    }, AgentTestPanel)
    return () => { disposeRegistration() }
  }, 'dev-agent-shell: root registration')
}
