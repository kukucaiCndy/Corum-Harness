/** Web-only plugin: ide-shell carries no Host-side contributions. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'ide-shell'

/** Required services (none — every contribution lives in the browser half). */
export const inject: string[] = []

/**
 * No-op Host half; kept so the package graph entry stays a valid plugin.
 * （`ui-onboarding` 命名空间注册在 corum-desktop host boot.ts 的根 ctx 完成：
 *  插件 fiber 的 ctx.inject(['settings']) 时序不满足，见 boot.ts。）
 * @param _ctx - Host context (unused).
 */
export function apply(_ctx: Context): void {
  // The IDE-shell contributions are browser-only.
}
