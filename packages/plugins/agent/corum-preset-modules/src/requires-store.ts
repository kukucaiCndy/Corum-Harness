/**
 * `requires`（MCP 安装说明）的**存放处**——导入/导出共用的一个 sidecar 文件。
 *
 * ## 为什么必须另找一个地方存（这是本轮补上的一个真缺陷）
 *
 * 设计里有两条**互相咬住**的约束：
 *   ① 安装时**绝不**把 `requires` 写进 `mcp-servers.json`——注册表的 `listServers()`
 *      是裸 `JSON.parse` 无校验（见 `corum-mcp-manager/src/registry-store.ts`），
 *      一个多余的键会**永久留在盘上**；而且 `requires` 是「怎么装」的说明，
 *      不属于 MCP 的运行时配置。
 *   ② 导出（发布）时**必须**有合法的 `requires`，否则闸门拦下（用户裁定「强制补全」）。
 *
 * 两条合起来就产生一个洞：若导出只从注册表读 `requires`，而任何路径都不往注册表写它，
 * 那么**每个 MCP 都会永远被判为「待补全」**——闸门永远打不开，
 * 「让 Agent 补全」补出来的东西下一次调用又丢了（`authorModuleRequires` 的返回值
 * 只活在 UI 的内存里）。
 *
 * 故：`requires` 存进**预设自己的目录**（与 `agent.json` 同级）。这个位置有三条好处：
 *   · 注册表保持干净（①不受影响）；
 *   · 与预设同生共死（删预设即删说明，不留孤儿）；
 *   · 导出时随手就能读到（不需要额外参数在 RPC 之间搬运状态）。
 *
 * ⚠️ 文件名不在 `MODULE_*` 命名空间里：它不是模块格式的一部分，而是**本机**的
 * 编辑态（导出的模块里，`requires` 直接写进 `mcp/<name>.json`）。
 *
 * @module @corum/corum-preset-modules/requires-store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpRequirement } from './module-format.ts'

/** sidecar 文件名（与 `agent.json` 同级）。 */
export const MODULE_REQUIRES_FILE = 'module-requires.json'

/**
 * sidecar 路径。
 *
 * ⚠️ 与 `corum-agent/src/profile-store.ts` 的 `agentDirPath` **必须同构**
 * （`<home>/.agent-presets/<id>/`）。刻意不 import 那边：依赖方向是
 * corum-agent → preset-modules，反向会成环。改布局时两处一起改。
 *
 * @param home - CORUM_HOME（绝对路径）。
 * @param profileId - 预设 id。
 */
export function moduleRequiresPath(home: string, profileId: string): string {
  return join(home, '.agent-presets', profileId, MODULE_REQUIRES_FILE)
}

/**
 * 读一份预设的安装说明。
 *
 * 宽容读：文件不存在 / 坏了 / 结构不对 ⇒ 空对象（导出时自然会走「待补全」闸门，
 * 而不是让一次读盘失败把发布流程整个打挂）。
 *
 * @param home - CORUM_HOME。
 * @param profileId - 预设 id。
 * @returns 服务名 → 依赖声明（浅拷贝，调用方可安全改）。
 */
export function readModuleRequires(home: string, profileId: string): Record<string, McpRequirement> {
  const path = moduleRequiresPath(home, profileId)
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, McpRequirement> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    out[name] = value as McpRequirement
  }
  return out
}

/**
 * 合并写入安装说明（**不是整体替换**）。
 *
 * 合并语义是刻意的：`authorModuleRequires` 可能只确认了其中几项
 * （其余进 `unconfirmed`），整体替换会把用户/上一次 Agent 已经写好的那些抹掉——
 * 那就成了「重试一次，之前补全的反而丢了」。
 *
 * @param home - CORUM_HOME。
 * @param profileId - 预设 id。
 * @param entries - 本次要写入/覆盖的项（未提及的名字保持原值）。
 * @returns 合并后的完整映射（供调用方回给 UI，避免 UI 自己再读一遍盘）。
 */
export function mergeModuleRequires(
  home: string,
  profileId: string,
  entries: Readonly<Record<string, McpRequirement>>,
): Record<string, McpRequirement> {
  const merged = { ...readModuleRequires(home, profileId), ...entries }
  const path = moduleRequiresPath(home, profileId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return merged
}
