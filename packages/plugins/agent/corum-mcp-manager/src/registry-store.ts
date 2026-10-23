/**
 * MCP 服务注册表持久化：读写 ~/.corum/mcp-servers.json。
 * @module @corum/corum-mcp-manager/registry-store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { McpServerConfig } from './types.ts'

/**
 * 注册表文件路径。
 *
 * 落点一致性是 extension-pack（P0）的硬契约：`installProfileModule(input)` 文档承诺
 * 把预设/技能/MCP **全部**装进 `input.home`，技能与预设早就走 `homeRoot`，但旧实现里
 * `saveServer` 只读 `process.env.CORUM_HOME` ⇒ `input.home=/tmp/x` 时技能落 `/tmp/x`，
 * 注册表却落进环境变量指向的另一个根——拆成两棵树，安装不一致（P0 缺陷）。
 *
 * 故增加可选 `home` 形参：
 * - 传**非空字符串** ⇒ 用它解析根（`resolveDshHome`），保证与 `resolveCorumHome` 同口径；
 * - 不传 / 空串 ⇒ 回落环境变量，优先级**逐字对齐** `resolveCorumHome` / `corumHome`：
 *   `CORUM_HOME` → `DSH_HOME` → `~/.corum`（旧实现漏了 `DSH_HOME` 档——只设 `DSH_HOME`
 *   的部署里，UI 加的 MCP 会落 `~/.corum`，而运行期按 `DSH_HOME` 读，配置静默丢失）。
 *
 * @param home - 显式传入的 CORUM_HOME（非空时覆盖环境变量；否则回落环境变量 / 默认值）。
 */
function registryPath(home?: string): string {
  const configured = home !== undefined && home.trim() !== ''
    ? home
    : process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
      ? process.env.CORUM_HOME
      : process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME
        : '~/.corum'
  return join(resolveDshHome(configured), 'mcp-servers.json')
}

/** 读取全部 MCP 服务。 */
export function listServers(home?: string): McpServerConfig[] {
  const path = registryPath(home)
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { servers?: McpServerConfig[] }
    return data.servers ?? []
  } catch {
    return []
  }
}

/** 按名读取单个 MCP 服务。 */
export function getServer(name: string, home?: string): McpServerConfig | undefined {
  return listServers(home).find(s => s.name === name)
}

/** 保存（创建或更新）一个 MCP 服务。 */
export function saveServer(server: McpServerConfig, home?: string): void {
  const path = registryPath(home)
  mkdirSync(dirname(path), { recursive: true })
  // 读与写必须用同一个 home，否则注册表会拆成两棵树（P0 缺陷：旧实现读走 env、写也走 env，
  // 但调用方传了 input.home 时读写在两个根——这里用同一个 home 保证一致）。
  const servers = listServers(home).filter(s => s.name !== server.name)
  servers.push(server)
  writeFileSync(path, JSON.stringify({ servers }, null, 2))
}

/** 删除一个 MCP 服务。 */
export function deleteServer(name: string, home?: string): void {
  const path = registryPath(home)
  const servers = listServers(home).filter(s => s.name !== name)
  writeFileSync(path, JSON.stringify({ servers }, null, 2))
}
