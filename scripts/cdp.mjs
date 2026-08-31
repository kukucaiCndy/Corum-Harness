/**
 * corum 桌面应用 CDP 驱动脚本（连 CORUM_DEBUG_PORT 主窗口）。
 *
 * 用法：
 *   node cdp.mjs eval '<js表达式>'        # Runtime.evaluate（returnByValue + awaitPromise）
 *   node cdp.mjs evalfile <path.js>       # 从文件读 JS 执行（推荐：避免 shell 转义地狱）
 *   node cdp.mjs shot <name>              # 截图到 ${CDP_OUT:-/tmp/corum-cdp/shots}/<name>.png
 *   node cdp.mjs evalshot '<js>' <name>   # eval + 截图
 *
 * 环境变量：
 *   CDP_PORT  CDP 端口（默认 9222，需与启动应用的 CORUM_DEBUG_PORT 一致）
 *   CDP_OUT   截图输出目录（默认 /tmp/corum-cdp/shots）
 *
 * 注意：访问 127.0.0.1:9222 在沙箱内会被拦截（Operation not permitted），
 * 需要提升权限（require_escalated）运行本脚本。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// ws 从桌面应用包的 node_modules 解析（kkc-desktop/packages/desktop 下有 ws 依赖）。
// 若仓库位置不同，设 CORUM_DESKTOP_PKG 指向 desktop 包目录。
const DESKTOP_PKG = process.env.CORUM_DESKTOP_PKG ?? '/Users/kukucai/work/kkc-desktop/packages/desktop/package.json'
const require = createRequire(DESKTOP_PKG)
const WebSocket = require('ws')

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT = process.env.CDP_OUT ?? '/tmp/corum-cdp/shots'
mkdirSync(OUT, { recursive: true })

async function getJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`)
  if (!res.ok) throw new Error(`CDP http ${res.status}`)
  return res.json()
}
async function waitPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      // 主页面：旧 corumapp:// 自定义协议，或 0.1.2 起的官方 loopback webserver
      // （http://127.0.0.1:<ephemeral>/）。floating 窗排除。
      const t = (await getJson('/json/list')).find(x => x.type === 'page'
        && (x.url.startsWith('corumapp://') || x.url.startsWith('http://127.0.0.1:'))
        && !x.url.includes('floating='))
      if (t) return t
    } catch {}
    if (Date.now() > deadline) throw new Error('no main page (应用未启动或 CDP 端口不对)')
    await new Promise(r => setTimeout(r, 500))
  }
}
function connect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    let seq = 0
    const pending = new Map()
    ws.on('open', () => resolveConn({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { res, rej })
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
      }),
      close: () => ws.close(),
    }))
    ws.on('message', d => {
      const m = JSON.parse(String(d))
      if (m.id !== undefined && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? rej(new Error(m.error.message)) : res(m.result)
      }
    })
    ws.on('error', rejectConn)
  })
}

const page = await waitPage()
const version = await getJson('/json/version')
const cdp = await connect(version.webSocketDebuggerUrl)
const att = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
const sessionId = att.sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(exceptionDetails.exception?.description ?? exceptionDetails.text))
  return result.value
}
async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const f = `${OUT}/${name}.png`
  writeFileSync(f, Buffer.from(data, 'base64'))
  return f
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'eval') {
    console.log(JSON.stringify(await evaluate(rest[0]), null, 2))
  } else if (cmd === 'evalfile') {
    console.log(JSON.stringify(await evaluate(readFileSync(rest[0], 'utf8')), null, 2))
  } else if (cmd === 'shot') {
    console.log(await shot(rest[0]))
  } else if (cmd === 'evalshot') {
    console.log(JSON.stringify(await evaluate(rest[0]), null, 2))
    console.log(await shot(rest[1]))
  } else {
    console.error('usage: eval|evalfile|shot|evalshot')
    process.exit(2)
  }
} finally {
  cdp.close()
}
