/**
 * @corum/ide-test-sidebar client half — the S0 composition probe for the
 * shell's left column slot. It registers ONE placeholder glass card into
 * `corum.sidebar` ("会话列表槽"), proving a content plugin can claim a shell
 * column slot. S1 replaces this probe with @corum/ide-sidebar (the real
 * session list).
 *
 * The slot is declared only by @corum/ide-shell (IDE mode); the type-only
 * import of the shell's client module pulls the SlotMap row so the register
 * call type-checks, while the runtime registration rides the slots service
 * (no value import of the shell package).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@corum/ide-shell/client'
import { TestSidebarCard } from './TestSidebarCard.tsx'

/** Required services: the slots registry this probe registers into. */
export const inject = ['slots']

/**
 * Client plugin body: register the placeholder card into corum.sidebar.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Deferred registration: the shell declares corum.sidebar inside its own
  // root registration, and fiber activation order across plugins is not the
  // composition's contract — ctx.slots.inject runs the callback once the slot
  // exists (the same pattern the shell's own editor column uses).
  ctx.effect(
    () => ctx.slots.inject('corum.sidebar', () => ctx.slots.register({ name: 'corum.sidebar' }, TestSidebarCard)),
    'ide-test-sidebar: corum.sidebar placeholder',
  )
}
