/**
 * @corum/corum-ide-statusbar-ui client half — the IDE status bar (design.pen ⑦, 34px).
 * Registers the status strip into the shell's `corum.statusBar` slot:
 * conn-dot + Connected + project + spacer + model. Connection state rides the
 * shell's host-description source (provided by corum-desktop's client).
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@corum/corum-ide-ui/client'
import './statusbar-slot.ts' // 声明合并：补上壳已移除的 corum.statusBar 槽类型
import type { CorumHostDescriptionSource } from './types.ts'
import { StatusBar } from './StatusBar.tsx'

/** Injected live state (see the component's prop type). */
export interface StatusBarInjected {
  /** The shell's host-description source (present value = connected). */
  hostDescription: CorumHostDescriptionSource
}

/** Required services: the slots registry + the shell connection handle. */
export const inject = ['slots', 'connection']

/**
 * Client plugin body: register the status strip into corum.statusBar.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as {
    hostDescription: CorumHostDescriptionSource
  }
  ctx.effect(
    () => ctx.slots.inject('corum.statusBar', () => ctx.slots.register(
      {
        name: 'corum.statusBar',
        id: 'ide-statusbar',
        inject: (): StatusBarInjected => ({
          hostDescription: connection.hostDescription,
        }),
      },
      StatusBar,
    )),
    'ide-statusbar: corum.statusBar status strip',
  )
}
