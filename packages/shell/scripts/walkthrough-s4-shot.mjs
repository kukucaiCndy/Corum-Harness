/** CDP 截图对照：capture 当前 IDE 工作台（浅/深），清旧布局 + 展开底部面板。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const WebSocket = require('ws')

function argVal(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const PORT = Number(argVal('port', '9240'))
const OUT = resolve(argVal('out', join(process.cwd(), 'build', 'walkthrough-s4')))
mkdirSync(OUT, { recursive: true })

async function getJson(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function waitForPage(t = 60000) {
  const dl = Date.now() + t
  for (;;) {
    try { const ts = await getJson('/json/list'); const pg = ts.find(x => x.type === 'page' && x.url.startsWith('corumapp://')); if (pg) return pg } catch {}
    if (Date.now() > dl) throw new Error('timeout waiting page')
    await new Promise(r => setTimeout(r, 500))
  }
}
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    let seq = 0; const pending = new Map()
    ws.on('open', () => res({ send: (m, p = {}, s) => new Promise((rc, rj) => { const id = ++seq; pending.set(id, { rc, rj }); ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p })) }), close: () => ws.close() }))
    ws.on('message', d => { const m = JSON.parse(String(d)); if (m.id !== undefined && pending.has(m.id)) { const { rc, rj } = pending.get(m.id); pending.delete(m.id); m.error ? rj(new Error(m.error.message)) : rc(m.result) } })
    ws.on('error', rej)
  })
}
let cdp, sessionId
async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(exceptionDetails.exception?.description ?? exceptionDetails.text))
  return result.value
}
async function shot(name) { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId); const f = join(OUT, name); writeFileSync(f, Buffer.from(data, 'base64')); return f }

const page = await waitForPage()
const version = await getJson('/json/version')
cdp = await connect(version.webSocketDebuggerUrl)
const att = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
sessionId = att.sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)

// 清旧网格布局残留 + 全尺寸窗口。
await evaluate(`localStorage.removeItem('corum.ide.grid.v3')`)
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId)
await evaluate(`location.reload()`)
await new Promise(r => setTimeout(r, 6000))
// 重新 attach（reload 后 target 不变，session 保持）。
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId)
await new Promise(r => setTimeout(r, 1500))


// GLASS_TOKENS（ide-shell theme-layer.ts）。真实主题翻转由 ThemePresenter 写
// body[data-ds-dark-theme] + 这些 alias token 的 inline 值（按 active.colorScheme
// 选 light/dark）。CDP 无真实切主题 API（偏好存 host），这里按 presenter 的投影
// 规则逐 token 写 inline 值，得到与设计稿一致的干净浅/深渲染。
const GLASS = {
  light: {
    '--dsw-alias-bg-base': '#E9E9F2', '--dsw-alias-bg-layer-1': '#FFFFFFE6', '--dsw-alias-bg-layer-2': '#FFFFFFCC',
    '--dsw-alias-bg-layer-3': '#FFFFFFB3', '--dsw-alias-bg-overlay': '#FFFFFFB3', '--dsw-alias-border-l1': '#FFFFFF',
    '--dsw-alias-label-primary': '#0E0E1C', '--dsw-alias-label-secondary': '#5C5C77', '--dsw-alias-label-tertiary': '#8B8BA3',
    '--dsw-alias-label-dimmed': '#B9B9C9', '--dsw-alias-brand-primary': '#5B21F5', '--dsw-alias-brand-text': '#5B21F5',
    '--dsw-alias-state-error-primary': '#E0245E', '--dsw-alias-state-success-primary': '#0BA57C', '--dsw-alias-state-warn-primary': '#E07A00',
    '--dsw-alias-interactive-bg-hover': 'rgba(14, 14, 28, 0.05)', '--dsw-alias-interactive-bg-active': 'rgba(14, 14, 28, 0.09)',
    '--dsw-alias-markdown-code-block': '#DDDCE8', '--dsw-alias-markdown-inline-code': '#DDDCE8',
    '--dsw-specific-sidebar-fill': '#FFFFFFE6', '--dsw-alias-button-primary-fill': '#5B21F5',
  },
  dark: {
    '--dsw-alias-bg-base': '#0D0817', '--dsw-alias-bg-layer-1': '#1D112BD9', '--dsw-alias-bg-layer-2': '#2A1840D9',
    '--dsw-alias-bg-layer-3': '#372050CC', '--dsw-alias-bg-overlay': '#372050CC', '--dsw-alias-border-l1': '#B98CFF2E',
    '--dsw-alias-label-primary': '#F3ECFF', '--dsw-alias-label-secondary': '#B3A6D9', '--dsw-alias-label-tertiary': '#7E719E',
    '--dsw-alias-label-dimmed': '#55486F', '--dsw-alias-brand-primary': '#01CDFE', '--dsw-alias-brand-text': '#4DE3FF',
    '--dsw-alias-state-error-primary': '#FF5C8A', '--dsw-alias-state-success-primary': '#3EE6B0', '--dsw-alias-state-warn-primary': '#FFB45C',
    '--dsw-alias-interactive-bg-hover': 'rgba(243, 236, 255, 0.08)', '--dsw-alias-interactive-bg-active': 'rgba(243, 236, 255, 0.14)',
    '--dsw-alias-markdown-code-block': '#0A0612', '--dsw-alias-markdown-inline-code': '#1D112B',
    '--dsw-specific-sidebar-fill': '#1D112BD9', '--dsw-alias-button-primary-fill': '#01CDFE',
  },
}
async function applyTheme(mode) {
  await evaluate(`(() => {
    const b = document.body
    if (${JSON.stringify(mode)} === 'dark') b.setAttribute('data-ds-dark-theme', '')
    else b.removeAttribute('data-ds-dark-theme')
    const T = ${JSON.stringify(GLASS)}[${JSON.stringify(mode)}]
    for (const k in T) b.style.setProperty(k, T[k])
  })()`)
  await new Promise(r => setTimeout(r, 500))
}

// 浅色截图。
await applyTheme('light')
const light = await shot('s4-light.png')
// 深色截图。
await applyTheme('dark')
const dark = await shot('s4-dark.png')

console.log('light:', light)
console.log('dark:', dark)
cdp.close()
process.exit(0)
