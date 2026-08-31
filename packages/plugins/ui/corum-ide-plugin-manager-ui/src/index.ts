/** Web-only plugin: ide-plugin-manager carries no Host-side contributions. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'ide-plugin-manager'

/** Required services (none — every contribution lives in the browser half). */
export const inject: string[] = []

/**
 * No-op Host half; kept so the package graph entry stays a valid plugin.
 * @param _ctx - Host context (unused).
 */
export function apply(_ctx: Context): void {
  // The plugin-manager panel contributions are browser-only; the pluginManager
  // RPC lives in corum-desktop's host (src/host/plugin-manager.ts).
}
