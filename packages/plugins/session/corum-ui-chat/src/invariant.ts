/** Package-owned invariant companion for the Chat UI target. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@corum/corum-ui-chat'

/** Cordis companion plugin name. */
export const name = 'corum-ui-chat-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/** No runtime invariant: Conversation and Slot registration enforce Chat target consistency. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
