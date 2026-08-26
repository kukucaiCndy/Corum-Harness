/** Web-only plugin: ide-project carries no Host-side contributions. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'ide-project'

/** Required services (none — every contribution lives in the browser half). */
export const inject: string[] = []

/**
 * No-op Host half; kept so the package graph entry stays a valid plugin.
 * @param _ctx - Host context (unused).
 */
export function apply(_ctx: Context): void {
  // The project-pane contributions are browser-only; the corumProject/*
  // RPCs live in @corum/corum-agent-dev (combo host plugins).
}
