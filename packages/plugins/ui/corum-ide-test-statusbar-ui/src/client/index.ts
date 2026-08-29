/**
 * @corum/corum-ide-test-statusbar-ui client half — the S0 composition probe for the
 * shell's status bar. It registers ONE placeholder strip ("连接 · 项目 · 模型"
 * placeholder text) into the LIST-kind `corum.statusBar` slot, proving a
 * content plugin can register into a shell bar slot. S1 replaces this probe
 * with @corum/corum-ide-statusbar-ui (live connection / project / model state).
 *
 * The slot is declared only by @corum/corum-ide-ui (IDE mode); the type-only
 * import of the shell's client module pulls the SlotMap row so the register
 * call type-checks, while the runtime registration rides the slots service.
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@corum/corum-ide-ui/client'
import { TestStatusBar } from './TestStatusBar.tsx'

/** Required services: the slots registry this probe registers into. */
export const inject = ['slots']

/**
 * Client plugin body: register the placeholder strip into corum.statusBar.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Deferred registration: runs once the shell has declared the slot (see
  // ide-test-sidebar for the rationale).
  ctx.effect(
    () => ctx.slots.inject('corum.statusBar', () => ctx.slots.register({ name: 'corum.statusBar', id: 'ide-test-statusbar' }, TestStatusBar)),
    'ide-test-statusbar: corum.statusBar placeholder',
  )
}
