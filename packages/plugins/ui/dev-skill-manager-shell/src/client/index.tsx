/**
 * @corum/dev-skill-manager-shell client half — Skill Manager 的浏览器半。
 *
 * 导出 SkillManagerPanel 组件，供其他 shell（如 dev-agent-shell）嵌入。
 * 也可以独立注册 root 槽（用于单独的 skill-manager combo，未来 IDE 复用）。
 *
 * SkillManagerPanel 通过桌面 IPC 桥（window.corumDesktop.unary）调
 * /api/skillManager/* 端点（SkillManagerService @Remote）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ThemePresenter } from '@corum/shell-base/client'
import { SkillManagerPanel } from './SkillManagerPanel.tsx'

export { SkillManagerPanel } from './SkillManagerPanel.tsx'

export const inject = ['slots', 'theme']

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
  }, 'dev-skill-manager-shell: theme presenter')

  // root 槽注册：当作为独立 combo 运行时，SkillManagerPanel 占满窗口。
  // 当与 dev-agent-shell 一起运行时，dev-agent-shell 的 root 注册优先
  //（同 slot 后注册覆盖前注册），这里不影响。
  ctx.effect(() => {
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {},
      inject: () => ({}),
    }, SkillManagerPanel)
    return () => { disposeRegistration() }
  }, 'dev-skill-manager-shell: root registration')
}
