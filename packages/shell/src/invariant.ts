/**
 * Package-owned invariant companion for `corum-shell`.
 * @module corum-shell/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Side-effect type import: resolves `ctx.invariants` to the registry service.
import type {} from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'corum-shell-app-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the desktop transport (module graph + IPC bridge) is
 * exercised end to end by the app's smoke launch, not by a unit-testable
 * service relation. The manifest still registers so the companion pattern
 * stays uniform with the rest of the dsh family.
 */
const install: InvariantInstaller = (_ctx, _fail) => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('corum-shell', install))
