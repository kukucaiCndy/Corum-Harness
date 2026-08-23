/** Web-only plugin: ide-panel-bottom carries no Host-side contributions. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'ide-panel-bottom'

/** Required services (none — every contribution lives in the browser half). */
export const inject: string[] = []

/**
 * No-op Host half; kept so the package graph entry stays a valid plugin.
 * @param _ctx - Host context (unused).
 */
export function apply(_ctx: Context): void {
  // The bottom-panel surface is browser-only.
}
