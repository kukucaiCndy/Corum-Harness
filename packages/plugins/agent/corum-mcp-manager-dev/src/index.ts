import type { Context } from '@deepseek-ai/cordis'
import { McpManagerService } from './mcp-manager-service.ts'

export const name = 'dev-mcp-manager'
export const inject: string[] = []
export function apply(ctx: Context): void {
  new McpManagerService(ctx)
}

export { McpManagerService } from './mcp-manager-service.ts'
export type {
  McpServerConfig, McpStdioServer, McpHttpServer, McpServerSummary,
  SaveMcpServerInput, McpToolSummary, TestConnectionResult,
} from './types.ts'
export { isValidMcpServerName } from './types.ts'
export { listServers, getServer, saveServer, deleteServer } from './registry-store.ts'
export { testConnection } from './test-connection.ts'
