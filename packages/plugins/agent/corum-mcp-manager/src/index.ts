import type { Context } from '@deepseek-ai/cordis'
import { McpManagerService } from './mcp-manager-service.ts'
import { McpPoolService } from './mcp-pool-service.ts'

export const name = 'mcp-manager'
export const inject: string[] = []
export function apply(ctx: Context): void {
  new McpManagerService(ctx)
  /**
   * 宿主级 MCP 连接池（2026-09-27 用户模型：框架统一管理、一个服务名一个进程、授权共用、独占）。
   * 与注册表服务同生命周期；preset 代理行（`./proxy` 子路径导出）通过 `inject: ['corumMcpPool']` 取用。
   */
  ctx.provide('corumMcpPool', new McpPoolService(ctx))
}

export { McpManagerService } from './mcp-manager-service.ts'
export type {
  McpServerConfig, McpStdioServer, McpHttpServer, McpServerSummary,
  SaveMcpServerInput, McpToolSummary, TestConnectionResult,
} from './types.ts'
export { isValidMcpServerName } from './types.ts'
export { listServers, getServer, saveServer, deleteServer } from './registry-store.ts'
export { testConnection } from './test-connection.ts'
// 第 ② 层可达性探测：分得出「命令不存在(ENOENT)」与「握手失败」——这是它相对 testConnection（第 ③ 层）存在的理由。
export { probeReachability } from './reachability.ts'
export type { ReachabilityResult, ReachabilityOptions } from './reachability.ts'
export { McpPoolService } from './mcp-pool-service.ts'
export { McpPool, McpLeaseTimeoutError, describeOwner, fingerprintOf } from './pool.ts'
export type { McpPoolTool, McpLeaseOwner, McpPoolOptions, McpPoolSnapshot } from './pool.ts'
export { publicToolName, MAX_PUBLIC_NAME_LENGTH, HASH_LENGTH } from './tool-naming.ts'
