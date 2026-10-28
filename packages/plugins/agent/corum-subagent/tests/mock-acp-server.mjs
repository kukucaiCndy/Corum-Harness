#!/usr/bin/env node
/**
 * mock-acp-server.mjs —— 最小 ACP JSON-RPC mock server（stdio NDJSON）。
 *
 * 实现 ACP 协议（Agent 侧）：
 *   - initialize → 返回 protocolVersion + agentCapabilities
 *   - session/new → 返回 sessionId
 *   - session/prompt → 通过 session/update notification 推送 agent_message_chunk
 *     文本，然后返回 stopReason（output 通过 notification 流式推送，
 *     不是 prompt 响应的 output 字段——官方 provider 的 fold 只从
 *     notification 收集文本）
 *   - session/cancel → 空响应
 *   - session/close → 空响应
 *
 * 可选 session/request_permission（client-bound 请求）：
 *   当 MOCK_ACP_REQUEST_PERMISSION=1 时，prompt 阶段向 client 发送权限请求，
 *   等待 client 的 JSON-RPC 响应，根据 outcome 决定 stopReason：
 *   - outcome='cancelled'（client reject）→ stopReason='cancelled'
 *   - outcome='selected'（client allow）→ 正常输出 + MOCK_ACP_STOP_REASON
 *
 * 环境变量：
 *   MOCK_ACP_OUTPUT - prompt 推送的文本（默认 "mock-acp-output"）
 *   MOCK_ACP_STOP_REASON - 默认 stop reason（默认 "end_turn"）
 *   MOCK_ACP_REQUEST_PERMISSION - "1" 时在 prompt 阶段请求权限
 *   MOCK_ACP_REPORT_ENV - "1" 时在输出文本中报告 DSH_HOME/MOCK_SECRET 状态
 *
 * 从 stdin 逐行读 NDJSON JSON-RPC 消息，向 stdout 写 NDJSON 响应/notification。
 * 忽略额外 args（如 --profile acp）——兼容 corum wrapper 的 args 传递。
 *
 * @module mock-acp-server
 */

const PROTOCOL_VERSION = '2025-03-26'

const MOCK_OUTPUT = process.env.MOCK_ACP_OUTPUT ?? 'mock-acp-output'
const MOCK_STOP_REASON = process.env.MOCK_ACP_STOP_REASON ?? 'end_turn'
const REPORT_ENV = process.env.MOCK_ACP_REPORT_ENV === '1'
const WANT_PERMISSION = process.env.MOCK_ACP_REQUEST_PERMISSION === '1'

let sessionIdCounter = 0
let permissionIdCounter = 1000 // client-bound request ids (distinct from server-bound)
const sessions = new Map()

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/**
 * 等待 client 对某个 id 的 JSON-RPC 响应。
 * @param {number} id - 期望的 response id
 * @param {number} timeoutMs - 超时
 * @returns {Promise<object>} response 对象
 */
function waitForResponse(id, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`mock-acp-server: timeout waiting for response id=${id}`))
    }, timeoutMs)
    const handler = (chunk) => {
      const lines = chunk.toString('utf8').split('\n')
      for (const line of lines) {
        if (line.trim() === '') continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === id && msg.method === undefined) {
            // This is a response (no method field)
            clearTimeout(timer)
            process.stdin.off('data', handler)
            resolve(msg)
            return
          }
        } catch { /* ignore */ }
      }
    }
    process.stdin.on('data', handler)
  })
}

async function handleRequest(msg) {
  const { id, method, params } = msg
  if (id === undefined) return // notification, no response

  switch (method) {
    case 'initialize': {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          authMethods: [],
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
      const outputText = MOCK_OUTPUT + (envReport ? ` | env: ${JSON.stringify(envReport)}` : '')

      // 若请求权限：先发 session/request_permission，等待 client 响应
      let permissionDenied = false
      if (WANT_PERMISSION) {
        const permId = --permissionIdCounter
        send({
          jsonrpc: '2.0',
          id: permId,
          method: 'session/request_permission',
          params: {
            sessionId: sid,
            toolCall: {
              toolCallId: 'mock-call',
              title: 'mock side effect',
            },
            options: [
              { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
              { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })
        try {
          const permResp = await waitForResponse(permId)
          const outcome = permResp.result?.outcome?.outcome
          if (outcome === 'cancelled') {
            permissionDenied = true
          }
        } catch {
          // timeout or error — treat as denied
          permissionDenied = true
        }
      }

      if (permissionDenied) {
        // client denied permission → return cancelled
        send({
          jsonrpc: '2.0',
          id,
          result: {
            sessionId: sid,
            stopReason: 'cancelled',
            output: [],
          },
        })
      } else {
        // ACP 协议：output 通过 session/update notification 流式推送
        // （agent_message_chunk），官方 provider 的 fold 只从 notification 收集文本。
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: outputText },
            },
          },
        })

        send({
          jsonrpc: '2.0',
          id,
          result: {
            sessionId: sid,
            stopReason: MOCK_STOP_REASON,
            output: [
              {
                type: 'text',
                text: outputText,
              },
            ],
          },
        })
      }
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
      // Only handle requests (have method) — responses (no method) are handled
      // by waitForResponse above.
      if (msg.method !== undefined) {
        handleRequest(msg).catch(() => { /* best effort */ })
      }
    } catch {
      // ignore parse errors
    }
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})
