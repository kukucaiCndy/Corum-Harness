/**
 * corum-ui-navigation client plugin — provides the `corumNavigation` cordis
 * service (session selection + retain/release lifecycle) as a standalone,
 * dependency-light plugin.
 *
 * **Why a separate plugin** (2026-10-31): `corumNavigation` was originally
 * provided inside `@corum/corum-ui-conversation`'s `apply()`. But conversation
 * hard-injects `layout`, and `@corum/corum-ide-ui` hard-injects
 * `corumNavigation` → layout↔corumNavigation service activation cycle →
 * 23 plugins stuck pending → web boot blocked. This plugin only injects
 * `sessions` (always available from the official session-controller), so it
 * activates first in the dependency chain and breaks the cycle.
 *
 * Loading order (cordis inject-based, not patch-row order):
 * 1. `sessions` service provided by `@deepseek-ai/dsh-api-session-controller` (client half).
 * 2. This plugin (`corum-navigation`) injects `sessions` → activates → provides `corumNavigation`.
 * 3. `@corum/corum-ide-ui` injects `corumNavigation` (+ others) → activates → provides `layout`.
 * 4. `@corum/corum-ui-conversation` injects `corumNavigation` (+ `sessions`, `slots`, …) → activates.
 *
 * @module @corum/corum-ui-navigation/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { applyCorumSessionNavigation } from './corum-navigation.ts'

/** Plugin name (cordis loader entry name). */
export const name = '@corum/corum-ui-navigation'

/**
 * Required services. Only `sessions` — the navigation service depends solely
 * on ISessions.retain/release. No dependency on `layout` or `uiConversation`,
 * which is the whole point of the extraction.
 */
export const inject = ['sessions']

/**
 * Provide the corumNavigation service.
 * @param ctx - Client root context with `sessions` injected.
 */
export function apply(ctx: Context): void {
  applyCorumSessionNavigation(ctx)
}

// Re-export the service interface and implementation for consumers.
export { applyCorumSessionNavigation } from './corum-navigation.ts'
export type { CorumMainSelection, CorumSessionNavigation } from './corum-navigation.ts'
