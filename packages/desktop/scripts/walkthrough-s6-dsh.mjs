/** DSH 基座聚合卡走查：主列表（功能插件 + 基座卡）→ 深入二级视图（基元清单）。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const WebSocket = require('ws')
function argVal(n, f) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f }
const PORT = Number(argVal('port', '9240'))
const OUT = resolve(argVal('out', join(process.cwd(), 'build', 'walkthrough-s5')))
mkdirSync(OUT, { recursive: true })
async function getJson(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function waitForPage(t = 60000) { const dl = Date.now() + t; for (;;) { try { const ts = await getJson('/json/list'); const pg = ts.find(x => x.type === 'page' && x.url.startsWith('corumapp://')); if (pg) return pg } catch {} if (Date.now() > dl) throw new Error('timeout'); await new Promise(r => setTimeout(r, 500)) } }
function connect(wsUrl) { return new Promise((res, rej) => { const ws = new WebSocket(wsUrl, { perMessageDeflate: false }); let seq = 0; const pend = new Map(); ws.on('open', () => res({ send: (m, p = {}, s) => new Promise((rc, rj) => { const id = ++seq; pend.set(id, { rc, rj }); ws.send(JSON.stringify(s ? { id, method: m, params: p, sessionId: s } : { id, method: m, params: p })) }), close: () => ws.close() })); ws.on('message', d => { const m = JSON.parse(String(d)); if (m.id !== undefined && pend.has(m.id)) { const { rc, rj } = pend.get(m.id); pend.delete(m.id); m.error ? rj(new Error(m.error.message)) : rc(m.result) } }); ws.on('error', rej) }) }
let cdp, sessionId
async function evaluate(expression) { const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(exceptionDetails.exception?.description ?? exceptionDetails.text)); return result.value }
async function shot(name) { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId); const f = join(OUT, name); writeFileSync(f, Buffer.from(data, 'base64')); console.log('shot:', f); return f }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const click = (sel) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'missing'; el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return 'ok'})()`)

const page = await waitForPage()
const version = await getJson('/json/version')
cdp = await connect(version.webSocketDebuggerUrl)
const att = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
sessionId = att.sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId)
await sleep(800)
await evaluate(`localStorage.removeItem('corum.ide.grid.v3'); document.documentElement.style.overflow='hidden'; document.body.style.overflow='hidden'`)
// 关 onboarding（若弹）
await evaluate(`(() => { const d=document.querySelector('[class*="_root_15u5s_"]'); if(!d) return 'gone'; const c=[...d.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='继续'); if(c) c.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return 'closed' })()`)
await sleep(500)

// 开插件中心
await click('[data-corum-menu] [data-menu="plugins"]')
await sleep(1000)
console.log('main list:', JSON.stringify(await evaluate(`(() => { const d=document.querySelector('[aria-label="插件中心"]'); return { pluginRows: d.querySelectorAll('[class*="_rowMainBtn"]').length, dshCard: !!d.querySelector('[class*="_dshCardBtn"]'), dshVersion: (d.querySelector('[class*="_dshCardVersion"]')||{}).textContent, dshCount: (d.querySelector('[class*="_dshCardCount"]')||{}).textContent } })()`)))
await shot('s6-dsh-main.png')

// 点 DSH 基座卡 → 二级视图
await click('[aria-label="插件中心"] [class*="_dshCardBtn"]')
await sleep(700)
console.log('dsh detail view:', JSON.stringify(await evaluate(`(() => { const d=document.querySelector('[aria-label="插件中心"]'); return { backBtn: !!d.querySelector('[class*="_backBtn"]'), groups: [...d.querySelectorAll('[class*="_groupLabel"]')].map(x=>x.textContent), runtimeRows: d.querySelectorAll('[class*="_rowMainBtn"]').length } })()`)))
await shot('s6-dsh-inside.png')

cdp.close()
process.exit(0)
