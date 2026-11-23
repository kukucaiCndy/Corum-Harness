/**
 * 假 MCP server（测试夹具）：stdio 传输，用于验证池的独占/排队/超时/重连/进程唯一性。
 *
 * 用具名工具而不是 mock 模块，理由：**被验证对象是"真进程上的真协议"** —— 连接、
 * 进程 pid、崩溃重连这些必须在真进程边界上测，否则测的只是我们自己写的假接口。
 *
 * 工具：
 *   · echo({ text })  → { pid, text, calls }
 *   · slow({ delayMs }) → 阻塞 delayMs，返回 { pid, startedAt, endedAt, maxConcurrent }
 *   · stats()          → { pid, calls, maxConcurrent, active }
 *   · crash()          → 先正常返回，再 50ms 后 exit(1)（用于"下一次调用应重连"）
 *   · 超长名工具（>64 字符）→ 供命名规则对照
 *
 * 并发计数在**服务端**统计（`maxConcurrent`）：独占租约若失效，这个数字会大于 1。
 */
import { writeFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const LONG_NAME = `long_${'x'.repeat(80)}`

let calls = 0
let active = 0
let maxConcurrent = 0

/**
 * 可选：把自身状态写到文件，供**实机验收**用（单测不设这个环境变量 ⇒ 行为不变）。
 *
 * 为什么需要：租约的"排队/超时"必须在**两个真会话的调用真正重叠**时才成立，而模型出工具调用
 * 的时刻不可控（实测模型延迟 ~10s）。有了状态文件，验收脚本可以**等到**第一个调用确实在空中
 * （`active === 1`）再发第二个，从而把时序变成确定的，而不是靠 sleep 猜。
 */
const STATE_FILE = process.env.MCP_PROBE_STATE_FILE
function publish(patch) {
  if (STATE_FILE === undefined || STATE_FILE === '') return
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, calls, active, maxConcurrent, ...patch, at: Date.now() }))
  } catch { /* 状态文件只是验收辅助，写不进去不影响协议行为 */ }
}

const server = new Server({ name: 'fake-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'echo back (optionally after a delay)', inputSchema: { type: 'object', properties: { text: { type: 'string' }, delayMs: { type: 'number' } } } },
    { name: 'slow', description: 'sleep', inputSchema: { type: 'object', properties: { delayMs: { type: 'number' } } } },
    { name: 'stats', description: 'server stats', inputSchema: { type: 'object' } },
    { name: 'crash', description: 'die after replying', inputSchema: { type: 'object' } },
    { name: LONG_NAME, description: 'tool with a very long name', inputSchema: { type: 'object' } },
  ],
}))

/** 所有结果都用 JSON 文本包一层，测试侧统一 JSON.parse。 */
function reply(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name
  const args = request.params.arguments ?? {}
  calls += 1
  active += 1
  maxConcurrent = Math.max(maxConcurrent, active)
  const startedAt = Date.now()
  publish({ tool: name, startedAt })
  try {
    if (name === 'echo') {
      const delayMs = Number(args.delayMs ?? 0)
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      return reply({ pid: process.pid, text: args.text ?? '', calls, startedAt, endedAt: Date.now(), maxConcurrent })
    }
    if (name === 'slow') {
      await new Promise(resolve => setTimeout(resolve, Number(args.delayMs ?? 0)))
      return reply({ pid: process.pid, startedAt, endedAt: Date.now(), maxConcurrent })
    }
    if (name === 'stats') return reply({ pid: process.pid, calls, active, maxConcurrent })
    if (name === 'crash') {
      setTimeout(() => process.exit(1), 50)
      return reply({ pid: process.pid, dying: true })
    }
    if (name === LONG_NAME) return reply({ pid: process.pid, long: true })
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
  } finally {
    active -= 1
    publish({ tool: name, endedAt: Date.now() })
  }
})

await server.connect(new StdioServerTransport())
