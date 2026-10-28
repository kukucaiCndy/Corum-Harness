#!/usr/bin/env node
/**
 * mock-acp-server.mjs —— 最小 ACP JSON-RPC mock server（stdio NDJSON）。
 *
 * 实现的 ACP 方法：
 *   - initialize → 返回 protocolVersion + capabilities
 *   - session/new → 返回 sessionId
 *   - session/prompt → 返回 stopReason + output（text）
 *   - session/cancel → 空响应
 *
 * 还响应客户端的 session/request_permission 请求（reject/allow 由 env 控制）。
 *
 * 环境变量：
 *   MOCK_ACP_PERMISSION - "reject" 或 "allow"（默认 "reject"）
 *   MOCK_ACP_OUTPUT - prompt 返回的文本（默认 "mock-acp-output"）
 *   MOCK_ACP_STOP_REASON - stop reason（默认 "stopped"）
 *   MOCK_ACP_REPORT_ENV - "1" 时在 prompt 响应中报告 DSH_HOME 是否存在 + MOCK_SECRET 是否不存在
 *
 * 从 stdin 逐行读 NDJSON JSON-RPC 请求，向 stdout 写 NDJSON 响应。
 *
 * @module mock-acp-server
 */

const PROTOCOL_VERSION = '2025-03-26'

const MOCK_PERMISSION = process.env.MOCK_ACP_PERMISSION ?? 'reject'
const MOCK_OUTPUT = process.env.MOCK_ACP_OUTPUT ?? 'mock-acp-output'
const MOCK_STOP_REASON = process.env.MOCK_ACP_STOP_REASON ?? 'stopped'
const REPORT_ENV = process.env.MOCK_ACP_REPORT_ENV === '1'

let sessionIdCounter = 0
const sessions = new Map()

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function handleRequest(msg) {
  const { id, method, params } = msg
  if (id === undefined) return // notification, no response

  switch (method) {
    case 'initialize': {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverCapabilities: {},
        },
      })
      break
    }
    case 'session/new': {
      const sid = `mock-session-${++sessionIdCounter}`
      sessions.set(sid, { created: Date.now() })
      send({
        jsonrpc: '2.0',
        id,
        result: { sessionId: sid },
      })
      break
    }
    case 'session/prompt': {
      const sid = params?.sessionId ?? 'unknown'
      const envReport = REPORT_ENV
        ? {
          dshHomePresent: process.env.DSH_HOME !== undefined,
          mockSecretPresent: process.env.MOCK_SECRET !== undefined,
          dshHome: process.env.DSH_HOME ?? '(unset)',
        }
        : undefined
      send({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId: sid,
          stopReason: MOCK_STOP_REASON,
          output: [
            {
              type: 'text',
              text: MOCK_OUTPUT + (envReport ? ` | env: ${JSON.stringify(envReport)}` : ''),
            },
          ],
        },
      })
      break
    }
    case 'session/cancel': {
      send({ jsonrpc: '2.0', id, result: {} })
      break
    }
    case 'session/close': {
      const sid = params?.sessionId
      if (sid !== undefined) sessions.delete(sid)
      send({ jsonrpc: '2.0', id, result: {} })
      break
    }
    default: {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
    }
  }
}

// Handle client-bound requests (session/request_permission)
function handleClientRequest(msg) {
  const { id, method } = msg
  if (method === 'session/request_permission') {
    const response = MOCK_PERMISSION === 'allow'
      ? { outcome: 'allow' }
      : { outcome: 'reject', reason: 'mock server rejects all permissions (negative-case baseline)' }
    send({ jsonrpc: '2.0', id, result: response })
  }
}

// Read NDJSON lines from stdin
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line === '') continue
    try {
      const msg = JSON.parse(line)
      // Check if it's a client request (has id + is a method the client handles)
      if (msg.method === 'session/request_permission') {
        handleClientRequest(msg)
      } else if (msg.method !== undefined) {
        handleRequest(msg)
      }
    } catch {
      // ignore parse errors
    }
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})
