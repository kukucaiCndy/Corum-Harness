/**
 * @corum/corum-ide-panel-bottom-ui client half — the IDE terminal (design.pen ⑥). The
 * panel is now a normal grid leaf (registered into the shell's `corum.panel`
 * slot, added to defaultGrid's bottom row), so it can be resized / rearranged
 * with the other regions. The × close hides the leaf via `ctx.layout.closeRegion`
 * (reopen from the plugin manager's 视图管理); no window-event bridge remains.
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@corum/corum-ide-ui/client'
import { BottomPanel } from './BottomPanel.tsx'
import type { BottomPanelInjected } from './BottomPanel.tsx'

export type { BottomPanelInjected } from './BottomPanel.tsx'

/** Required services: the slots registry + the layout face (ctx.layout.closeRegion)。 */
export const inject = ['slots', 'layout']

/**
 * Client plugin body: register the terminal into corum.panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('corum.panel', () => ctx.slots.register(
      {
        name: 'corum.panel',
        inject: (): BottomPanelInjected => ({
          closeRegion: () => { ctx.layout.closeRegion('corum.panel') },
        }),
      },
      BottomPanel,
    )),
    'ide-panel-bottom: corum.panel terminal',
  )
}
