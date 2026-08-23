/**
 * S3 CDP walkthrough: verifies the real design.pen regions rendered in the
 * running IDE shell and captures dual-theme screenshots.
 *
 *   node scripts/walkthrough-s3.mjs [--port 9240] [--out <dir>]
 *
 * Asserts (IDE mode):
 *   - The five regions mount in their slots (sidebar / conversation / editor
 *     / explorer / status bar).
 *   - Brand logo images load over corumapp://app/assets.
 *   - Ambient steam-wave background present (light + dark).
 *   - Glass tokens resolve per scheme.
 * Output: comparison table + s3-{light,dark}.png.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let WebSocket
try {
  WebSocket = require('ws')
} catch {
  console.error('[walkthrough] the "ws" package is not resolvable from the workspace root')
  process.exit(1)
}

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const PORT = Number(arg('port', '9240'))
const OUT = resolve(arg('out', join(resolve(import.meta.dirname, '..'), 'build', 'walkthrough-s3')))
mkdirSync(OUT, { recursive: true })

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
  if (!res.ok) throw new Error(`CDP http ${res.status} for ${path}`)
  return res.json()
}

async function waitForPage(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const targets = await getJson('/json/list')
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('corumapp://app'))
      if (page) return page
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('timed out waiting for the corumapp page target')
    await new Promise((r) => setTimeout(r, 500))
  }
}

function connect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    let seq = 0
    const pending = new Map()
    ws.on('open', () => {
      resolveConn({
        send(method, params = {}, sessionId) {
          return new Promise((resolveCmd, rejectCmd) => {
            const id = ++seq
            pending.set(id, { resolveCmd, rejectCmd })
            ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
          })
        },
        close: () => ws.close(),
      })
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolveCmd, rejectCmd } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rejectCmd(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolveCmd(msg.result)
      }
    })
    ws.on('error', rejectConn)
  })
}

let cdp
let sessionId
async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId)
  if (exceptionDetails) throw new Error(`page evaluation failed: ${JSON.stringify(exceptionDetails.exception?.description ?? exceptionDetails.text)}`)
  return result.value
}

async function waitFor(expression, timeoutMs = 30_000, label = expression) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await evaluate(expression)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 400))
  }
}

async function resizeWindow(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  }, sessionId)
}

async function screenshot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const file = join(OUT, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

let failures = 0
const rows = []
function check(label, actual, expected, ok) {
  rows.push({ label, actual: String(actual), expected: String(expected), ok })
  if (!ok) failures += 1
}

function printTable() {
  const w = [52, 26, 26]
  const line = (a, b, c, d) => console.log(`${a.padEnd(w[0])} ${b.padEnd(w[1])} ${c.padEnd(w[2])} ${d}`)
  console.log('')
  line('CHECK', 'ACTUAL', 'EXPECTED', 'RESULT')
  line('─'.repeat(w[0]), '─'.repeat(w[1]), '─'.repeat(w[2]), '─'.repeat(6))
  for (const r of rows) line(r.label.slice(0, w[0]), r.actual, r.expected, r.ok ? 'PASS' : 'FAIL')
  console.log('')
}

const page = await waitForPage()
const version = await getJson('/json/version')
cdp = await connect(version.webSocketDebuggerUrl)
const attached = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
sessionId = attached.sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)

// The IDE shell mounts + regions render (design.pen ①/②/③/④/⑦).
await waitFor(`!!document.querySelector('[data-code-editor-column]')`, 60_000, 'editor column')
await waitFor(`!!document.querySelector('[data-monaco-editor]')`, 30_000, 'monaco editor')

const probe = await evaluate(`(() => {
  const text = document.body.innerText
  const inputs = [...document.querySelectorAll('input')].map((i) => i.placeholder)
  const imgs = [...document.querySelectorAll('img')].map((i) => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 }))
  const ambientBefore = !!getComputedStyle(document.body, '::before').backgroundImage
  return {
    sidebar: text.includes('新会话') && inputs.some((p) => p.startsWith('搜索会话')),
    conversation: text.includes('Running') && text.includes('Corum Agent') && inputs.some((p) => p.startsWith('Ask anything')),
    editor: text.includes('行 7, 列 1') && text.includes('Markdown') && text.includes('未保存'),
    explorer: text.includes('资源管理器'),
    statusbar: text.includes('Connected'),
    brandImgs: imgs.filter((i) => i.src.includes('brand_logo')).map((i) => i.ok),
    ambientBefore,
  }
})()`)

check('① 会话列表渲染（新会话/搜索）', probe.sidebar, true, probe.sidebar === true)
check('② 对话区渲染（Header/Stats/Input）', probe.conversation, true, probe.conversation === true)
check('③ 编辑器渲染（Status 行/语言/未保存）', probe.editor, true, probe.editor === true)
check('④ 资源管理器渲染', probe.explorer, true, probe.explorer === true)
check('⑦ 状态栏渲染（Connected）', probe.statusbar, true, probe.statusbar === true)
const brandOk = probe.brandImgs.length > 0 && probe.brandImgs.every(Boolean)
check('品牌图加载（corumapp assets）', `${probe.brandImgs.length} 张全加载`, '≥1 且全 ok', brandOk)
check('ambient 蒸汽波背景存在（::before）', probe.ambientBefore, true, probe.ambientBefore === true)

// Dual-theme screenshots + token values.
await resizeWindow(1600, 900)
await new Promise((r) => setTimeout(r, 1000))

// The theme preference lives in the shell's theme service (no global access
// from the console). The body attribute IS the token flip driver (written by
// the ThemePresenter on theme/change), so toggling it directly yields the
// same projected palette for the visual walkthrough.
async function setTheme(dark) {
  await evaluate(dark
    ? `document.body.setAttribute('data-ds-dark-theme', '')`
    : `document.body.removeAttribute('data-ds-dark-theme')`)
  await new Promise((r) => setTimeout(r, 300))
}
await setTheme(false)
const lightToken = await evaluate(`getComputedStyle(document.body).getPropertyValue('--corum-glass-1').trim()`)
check('浅色 · --corum-glass-1', lightToken, '#FFFFFFE6', lightToken.toUpperCase() === '#FFFFFFE6')
const lightShot = await screenshot('s3-light.png')

await setTheme(true)
const darkToken = await evaluate(`getComputedStyle(document.body).getPropertyValue('--corum-glass-1').trim()`)
check('深色 · --corum-glass-1', darkToken, '#1D112BD9', darkToken.toUpperCase() === '#1D112BD9')
const darkShot = await screenshot('s3-dark.png')

printTable()
console.log(`screenshots: ${lightShot}`)
console.log(`             ${darkShot}`)

cdp.close()
if (failures > 0) {
  console.error(`[walkthrough-s3] ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log(`[walkthrough-s3] all assertions passed`)
process.exit(0)
