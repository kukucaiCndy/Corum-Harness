/**
 * @corum/corum-ide-test-conversation-ui client half — the S0 composition probe for the
 * shell's center column. It registers ONE self-identifying test module into
 * the `conversation` slot, replacing the official ui-conversation surface
 * (disabled in the S0 IDE overlay) so the ENTIRE frame is test modules. The
 * module carries an openDetails button that exercises the details-drawer
 * panel action across the shell/plugin boundary. S2 replaces this probe with
 * @corum/corum-ide-conversation-ui (the real message flow).
 *
 * The slot is declared only by @corum/corum-ide-ui (IDE mode); the type-only
 * import pulls the SlotMap row + the ctx.layout Context merge so the register
 * call and layout consumption type-check; registration rides the slots
 * service (deferred via ctx.slots.inject — see ide-test-sidebar).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@corum/corum-ide-ui/client'
import { TestConversation } from './TestConversation.tsx'

/** Required services: the slots registry + the shell's layout face. */
export const inject = ['slots', 'layout']

/**
 * Client plugin body: register the test module into conversation.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('conversation', () => ctx.slots.register(
      {
        name: 'conversation',
        inject: () => ({ onOpenDetails: () => ctx.layout.openDetails() }),
      },
      TestConversation,
    )),
    'ide-test-conversation: conversation placeholder',
  )
}
