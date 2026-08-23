/**
 * MCP 服务管理数据模型。
 *
 * 全局注册表存储在 ~/.corum-shell/mcp-servers.json，
 * AgentProfile 通过 mcpServers: string[] 引用授权的服务名。
 * @module @corum/dev-mcp-manager/types
 */

/** stdio 传输的 MCP 服务配置。 */
export interface McpStdioServer {
  /** 唯一服务名（Agent 授权引用此名）。 */
  name: string
  /** 显示名。 */
  description?: string
  transport: 'stdio'
  /** 可执行命令。 */
  command: string
  /** 命令参数。 */
  args?: string[]
  /** 环境变量。 */
  env?: Record<string, string>
  /** 工作目录。 */
  cwd?: string
  /** 工具调用超时（ms）。 */
  toolCallTimeoutMs?: number
  /** 停用后不再编译进 preset、不自动探测连接。 */
  disabled?: boolean
}

/** streamable-http 传输的 MCP 服务配置。 */
export interface McpHttpServer {
  /** 唯一服务名。 */
  name: string
  /** 显示名。 */
  description?: string
  transport: 'streamable-http'
  /** MCP 端点 URL。 */
  url: string
  /** 请求头。 */
  headers?: Record<string, string>
  /** 工具调用超时（ms）。 */
  toolCallTimeoutMs?: number
  /** 停用后不再编译进 preset、不自动探测连接。 */
  disabled?: boolean
}

/** MCP 服务配置（判别联合）。 */
export type McpServerConfig = McpStdioServer | McpHttpServer

/** UI 投影的 MCP 服务摘要。 */
export interface McpServerSummary {
  name: string
  description?: string
  transport: 'stdio' | 'streamable-http'
  /** 连接目标（command 或 url）。 */
  endpoint: string
  /** 已停用（不编译进 preset、不自动探测）。 */
  disabled?: boolean
}

/** 添加/更新 MCP 服务的 RPC 入参。 */
export type SaveMcpServerInput = McpServerConfig

/** 握手探测发现的工具摘要。 */
export interface McpToolSummary {
  name: string
  description?: string
}

/** testConnection 探测结果。 */
export type TestConnectionResult =
  | { ok: true; tools: McpToolSummary[] }
  | { ok: false; error: string }

/** 校验服务名（防路径逃逸，与 serverName 命名规则一致）。 */
export function isValidMcpServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(name)
}
