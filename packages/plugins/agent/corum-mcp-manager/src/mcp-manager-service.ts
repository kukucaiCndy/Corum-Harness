/**
 * McpManagerService — corum MCP 服务全局注册表。
 *
 * 管理 ~/.corum/mcp-servers.json 中的 MCP 服务配置。
 * AgentProfile 通过 mcpServers: string[] 引用授权的服务名，
 * 编译 preset 时从注册表读取配置生成 **corum-mcp-proxy 行**（只带 serverName；进程与独占租约
 * 由宿主池 `corumMcpPool` 持有，见 pool.ts/proxy.ts）。
 *
 * 继承 TypertRemoteService，暴露 /api/mcpManager/* RPC 端点。
 * @module @corum/corum-mcp-manager/mcp-manager-service
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertNotPackOwned, PackOwnedError } from '@corum/corum-extension-registry'
import type {
  McpServerConfig, McpServerSummary, SaveMcpServerInput, TestConnectionResult,
} from './types.ts'
import { isValidMcpServerName } from './types.ts'
import { listServers, getServer, saveServer, deleteServer } from './registry-store.ts'
import { testConnection } from './test-connection.ts'

function toSummary(s: McpServerConfig): McpServerSummary {
  return {
    name: s.name,
    ...(s.description !== undefined ? { description: s.description } : {}),
    transport: s.transport,
    endpoint: s.transport === 'stdio' ? s.command : s.url,
    ...(s.disabled === true ? { disabled: true } : {}),
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpManager: McpManagerService
  }
}

export class McpManagerService extends TypertRemoteService {
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'mcpManager')
  }

  /** 列出所有已注册的 MCP 服务摘要。 */
  @Remote('listServers')
  listServersRemote(): { servers: McpServerSummary[] } {
    return { servers: listServers().map(toSummary) }
  }

  /** 读取一个 MCP 服务的完整配置（编辑回填用）。 */
  @Remote('getServer')
  getServerRemote(name: string): { server?: McpServerConfig } {
    if (!isValidMcpServerName(name)) {
      throw new Error(`mcp-manager: invalid server name "${name}"`)
    }
    const server = getServer(name)
    return server !== undefined ? { server } : {}
  }

  /** 保存（创建或更新）一个 MCP 服务。 */
  @Remote('saveServer')
  saveServerRemote(input: SaveMcpServerInput): { server: McpServerSummary } {
    if (!isValidMcpServerName(input.name)) {
      throw new Error(`mcp-manager: invalid server name "${input.name}"`)
    }
    saveServer(input)
    return { server: toSummary(input) }
  }

  /** 删除一个 MCP 服务。 */
  @Remote('deleteServer')
  deleteServerRemote(name: string): { ok: boolean } {
    if (!isValidMcpServerName(name)) {
      throw new Error(`mcp-manager: invalid server name "${name}"`)
    }
    // P5 §5.2 双端强制：扩展包拥有的 MCP 不能在 MCP 页单独卸载。
    // 命中归属即抛 Error(e.message)（McpPage 的 doDelete catch 后展示 e.message）。
    try {
      assertNotPackOwned('mcp', name, corumHome())
    } catch (e) {
      if (e instanceof PackOwnedError) throw new Error(e.message)
      throw e
    }
    deleteServer(name)
    return { ok: true }
  }

  /** 真实握手探测：initialize → listTools → close（10s 超时 + 子进程清理）。 */
  @Remote('testConnection')
  async testConnectionRemote(name: string): Promise<TestConnectionResult> {
    if (!isValidMcpServerName(name)) {
      throw new Error(`mcp-manager: invalid server name "${name}"`)
    }
    const server = getServer(name)
    if (server === undefined) {
      return { ok: false, error: `服务 "${name}" 未注册` }
    }
    if (server.disabled === true) {
      return { ok: false, error: '服务已停用' }
    }
    return testConnection(server)
  }

  /** 查询引用该 MCP 服务的 AgentProfile id 列表（删除前提示）。 */
  @Remote('getServerReferences')
  getServerReferencesRemote(name: string): { references: string[] } {
    if (!isValidMcpServerName(name)) {
      throw new Error(`mcp-manager: invalid server name "${name}"`)
    }
    return { references: this.findReferences(name) }
  }

  /** 扫描 CORUM_HOME 下 .agent-presets 中各 profile 的 agent.json，找 mcpServers 引用。 */
  private findReferences(name: string): string[] {
    const presetsDir = join(corumHome(), '.agent-presets')
    const references: string[] = []
    let entries: string[]
    try {
      entries = readdirSync(presetsDir)
    } catch {
      return references
    }
    for (const entry of entries) {
      try {
        const raw = readFileSync(join(presetsDir, entry, 'agent.json'), 'utf8')
        const profile = JSON.parse(raw) as { mcpServers?: string[] }
        if (Array.isArray(profile.mcpServers) && profile.mcpServers.includes(name)) {
          references.push(entry)
        }
      } catch { /* 单个 profile 损坏不阻塞整体 */ }
    }
    return references
  }

  /**
   * 按服务名列表批量读取完整配置（供 compile.ts 调用）。
   * AgentProfile 只记录授权的服务名，编译时从注册表读取完整配置。
   * 已停用（disabled）的服务不返回，不编进 preset。
   */
  resolveServers(names: readonly string[]): McpServerConfig[] {
    const result: McpServerConfig[] = []
    for (const name of names) {
      const server = getServer(name)
      if (server === undefined) {
        this.ctx.logger.warn(`mcp-manager: server "${name}" not found in registry`)
      } else if (server.disabled !== true) {
        result.push(server)
      }
    }
    return result
  }
}

export default McpManagerService

// ── home 解析 ──────────────────────────────────────────────────────────

/**
 * corum 运行目录解析（三档对齐 corum-agent/corum-preset-modules）。
 *
 * `CORUM_HOME` → `DSH_HOME` → `~/.corum`，再交给 `resolveDshHome` 展开 `~`。
 * 归属检查（assertNotPackOwned）必须用与本包 registry-store 同一个 home，
 * 否则台账在 A 处、资源在 B 处，归属检查会漏判。
 */
function corumHome(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : '~/.corum'
  return resolveDshHome(configured)
}
