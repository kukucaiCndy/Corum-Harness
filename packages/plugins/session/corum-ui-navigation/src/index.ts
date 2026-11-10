/**
 * @corum/corum-ui-navigation — host half.
 *
 * This package is **client-only** (no host contributions). The host entry
 * exists solely so the package is a valid cordis plugin (the loader requires
 * a host entry; the real work is in `src/client/index.ts`).
 *
 * @module @corum/corum-ui-navigation
 */
import type { Context } from '@deepseek-ai/cordis'

/** Plugin name (cordis loader entry name). */
export const name = '@corum/corum-ui-navigation'

/** No host-side service requirements. */
export const inject: string[] = []

/**
 * No-op Host half; kept so the package graph entry stays a valid plugin.
 * The corumNavigation service is provided entirely in the browser half
 * (`src/client/index.ts`), because it depends on `ISessions` (a client-side
 * service from `@deepseek-ai/dsh-api-session-controller`).
 * @param _ctx - Host context (unused).
 */
export function apply(_ctx: Context): void {
  // corumNavigation is a client-side service (see src/client/index.ts).
}
