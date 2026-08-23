/**
 * MCP 连接探测：用 @modelcontextprotocol/sdk 发起真实握手
 *（initialize → listTools → close），返回工具列表或错误。
 *
 * stdio 起子进程时合并 process.env（子进程需要 PATH 等），
 * 全程带超时与进程清理兜底。
 * @module @corum/dev-mcp-manager/test-connection
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig, TestConnectionResult } from './types.ts'

/** 默认探测超时（ms）。 */
const PROBE_TIMEOUT_MS = 10_000

function buildTransport(config: McpServerConfig): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    })
  }
  // SDK 构造的 transport 在 exactOptionalPropertyTypes 下与 Transport 接口有
  // 属性类型宽度差异（与官方 dsh-mcp-client 同样的 cast 处理）。
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers !== undefined ? { requestInit: { headers: config.headers } } : {},
  ) as Transport
}

/**
 * 探测一个 MCP 服务的连接并列出工具。
 * 不会抛出：所有失败收敛为 { ok: false, error }。
 */
export async function testConnection(
  config: McpServerConfig,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<TestConnectionResult> {
  const client = new Client(
    { name: 'corum-mcp-manager-probe', version: '0.1.0' },
    { capabilities: {} },
  )
  const transport = buildTransport(config)
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport)
        const result = await client.listTools()
        return {
          ok: true as const,
          tools: result.tools.map(t => ({
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
          })),
        }
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => { reject(new Error(`连接超时（${timeoutMs}ms）`)) }, timeoutMs)
      }),
    ])
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    // close 会终止 stdio 子进程（SIGTERM）；失败兜底再补一次 transport close。
    try { await client.close() } catch { /* 忽略 */ }
    try { await transport.close() } catch { /* 忽略 */ }
  }
}
