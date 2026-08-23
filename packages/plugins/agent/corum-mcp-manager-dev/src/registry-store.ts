/**
 * MCP 服务注册表持久化：读写 ~/.corum/mcp-servers.json。
 * @module @corum/corum-mcp-manager-dev/registry-store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { McpServerConfig } from './types.ts'

/** 注册表文件路径。 */
function registryPath(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'mcp-servers.json')
}

/** 读取全部 MCP 服务。 */
export function listServers(): McpServerConfig[] {
  const path = registryPath()
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { servers?: McpServerConfig[] }
    return data.servers ?? []
  } catch {
    return []
  }
}

/** 按名读取单个 MCP 服务。 */
export function getServer(name: string): McpServerConfig | undefined {
  return listServers().find(s => s.name === name)
}

/** 保存（创建或更新）一个 MCP 服务。 */
export function saveServer(server: McpServerConfig): void {
  const path = registryPath()
  mkdirSync(dirname(path), { recursive: true })
  const servers = listServers().filter(s => s.name !== server.name)
  servers.push(server)
  writeFileSync(path, JSON.stringify({ servers }, null, 2))
}

/** 删除一个 MCP 服务。 */
export function deleteServer(name: string): void {
  const path = registryPath()
  const servers = listServers().filter(s => s.name !== name)
  writeFileSync(path, JSON.stringify({ servers }, null, 2))
}
