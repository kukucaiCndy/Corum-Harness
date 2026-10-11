/**
 * CORUM_HOME 解析（委托官方 `@deepseek-ai/dsh-home-paths`）。
 *
 * ## 为什么必须委托官方 `resolveDshHome`（2026-10-11 修，主 Agent 复核发现分叉面）
 *
 * 本包原本内联了一份解析逻辑，**优先级与 `corum-agent/src/home.ts` 不一致**：
 * 内联版只有 `CORUM_HOME` → `~/.corum` 两档，而 corum-agent 用的是
 * `CORUM_HOME` → `DSH_HOME` → `~/.corum` 三档（委托 `resolveDshHome`）。
 * 这是**静默分叉**：若某部署只设 `DSH_HOME`（不设 `CORUM_HOME`），两处会解析到
 * **不同的家目录**，导致预设在 A 处装、在 B 处找。
 *
 * 修法：加 `@deepseek-ai/dsh-home-paths` 依赖（与 corum-agent / corum-mcp-manager
 * 同款），让本包的解析优先级**逐字对齐** `corum-agent/src/home.ts`：
 * `CORUM_HOME` → `DSH_HOME` → `~/.corum`，再交给 `resolveDshHome` 展开 `~`。
 *
 * @module @corum/corum-preset-modules/home
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * 解析 CORUM_HOME 为绝对路径。
 *
 * 优先级**逐字对齐** `corum-agent/src/home.ts` 的 `corumHome()`：
 * `CORUM_HOME`（空值视为未设）→ `DSH_HOME`（空值视为未设）→ `~/.corum`，
 * 再交给 `resolveDshHome` 展开 `~` 前缀为 OS home。
 *
 * @param home - 显式传入的 CORUM_HOME（为空时回落环境变量 / 默认值）。
 * @returns 绝对路径。
 */
export function resolveCorumHome(home?: string): string {
  const configured = home !== undefined && home.trim() !== ''
    ? home
    : process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
      ? process.env.CORUM_HOME
      : process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME
        : '~/.corum'
  return resolveDshHome(configured)
}
