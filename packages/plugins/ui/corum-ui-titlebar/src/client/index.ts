import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@corum/corum-ide-ui/client'
import { TitleBar, type TitleBarInjected } from './TitleBar.tsx'

export const inject = ['slots', 'layout', 'sessions', 'corumEditor']
export function apply(ctx: ClientContext): void {
  const editor = ctx.get('corumEditor') as { toggleExplorer(): void }
  ctx.effect(() => ctx.slots.inject('corum.titlebar', () => ctx.slots.register({
    name: 'corum.titlebar',
    inject: (): TitleBarInjected => ({
      hooks: { chrome: ctx.layout.chromeSnapshot() },
      toggleSidebarCollapsed: () => { ctx.layout.setIntegrationsOpen(false); ctx.layout.toggleSidebarCollapsed() },
      toggleRegion: slot => { ctx.layout.setIntegrationsOpen(false); ctx.layout.toggleRegion(slot) },
      toggleExplorer: () => { ctx.layout.setIntegrationsOpen(false); editor.toggleExplorer() },
      closeSession: () => { ctx.layout.setIntegrationsOpen(false); ctx.sessions.clear() },
    }),
  }, TitleBar)), 'ide-titlebar: global window chrome')
}
