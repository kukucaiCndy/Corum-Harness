/** Web-only plugin: corum-ui-split-pane carries no Host-side contributions. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'corum-split-pane'

/** Required services（none —— 全部贡献在浏览器半）。 */
export const inject: string[] = []

/**
 * No-op Host half；保留以使包图入口是一个合法插件。
 * @param _ctx - Host context（未使用）。
 */
export function apply(_ctx: Context): void {
  // 通用分栏容器与取舍视图都是浏览器半的事。
}
