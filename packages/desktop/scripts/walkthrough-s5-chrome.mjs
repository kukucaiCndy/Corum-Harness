/** 菜单栏/插件中心走查：CDP 真实鼠标点击 + 移除遮挡 modal。 */
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
async function clickAt(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
}
// 触发 React 合成事件点击（.click() 在 drag 区/委托下不可靠；直接派发
// React 识别的 click）。用 data-menu 精确定位，与文本解耦。
async function menuClick(key) {
  return evaluate(`(() => {
    const el = document.querySelector('[data-corum-menu] [data-menu="${key}"]')
    if (!el) return 'missing'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
}

const page = await waitForPage()
const version = await getJson('/json/version')
cdp = await connect(version.webSocketDebuggerUrl)
const att = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
sessionId = att.sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId)
await sleep(800)

// 锁定滚动去重影。内测声明 modal 走「继续」正常关闭（不用 .remove()，避免
// 破坏 React 树）。若保存状态失败重开则多轮点。
await evaluate(`localStorage.removeItem('corum.ide.grid.v3'); document.documentElement.style.overflow='hidden'; document.body.style.overflow='hidden'`)
// onboarding 命名空间已修复（ide 模式在 host boot 注册），内测声明弹窗若
// 未确认可正常点「继续」关闭。走查前正常关掉它（确认态持久化，后续不再弹）。
await evaluate(`(() => {
  const dlg = document.querySelector('[class*="_root_15u5s_"]')
  if (!dlg) return 'gone'
  const cont = [...dlg.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '继续')
  if (cont) cont.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return 'closed'
})()`)
await sleep(600)

// 菜单探测。
console.log('menu:', JSON.stringify(await evaluate(`(() => { const g=document.querySelector('[data-corum-menu]'); return { items:[...g.querySelectorAll('[data-menu]')].map(b=>b.getAttribute('data-menu')), theme: document.querySelectorAll('[class*="_themeButton"]').length } })()`)))
await shot('s5-bar.png')

// 视图下拉。
console.log('view click:', await menuClick('view'))
await sleep(500)
console.log('view dropdown:', JSON.stringify(await evaluate(`(() => { const d=document.querySelector('[class*="_menuDropdown"]'); return { open:!!d, rows: d?[...d.querySelectorAll('[class*="_menuDropdownItem"]')].map(b=>(b.textContent||'').trim()):[] } })()`)))
await shot('s5-view-menu.png')
await menuClick('view') // 关掉
await sleep(300)

// 插件中心。
console.log('plugins click:', await menuClick('plugins'))
await sleep(1000)
console.log('pm:', JSON.stringify(await evaluate(`(() => { const d=document.querySelector('[role="dialog"][aria-label="插件中心"]'); if(!d) return {open:false}; return { open:true, tabs:[...d.querySelectorAll('[role="tab"]')].map(t=>(t.textContent||'').trim()), rows:d.querySelectorAll('[class*="_rowName"]').length } })()`)))
await shot('s5-pm-installed.png')

// 视图管理 tab。
await evaluate(`(() => {
  const d=document.querySelector('[role="dialog"][aria-label="插件中心"]')
  const t=d&&[...d.querySelectorAll('[role="tab"]')].find(x=>(x.textContent||'').trim()==='视图管理')
  if (t) t.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, view:window }))
})()`)
await sleep(500)
console.log('pm views:', JSON.stringify(await evaluate(`(() => { const d=document.querySelector('[role="dialog"][aria-label="插件中心"]'); return { toggles: d?d.querySelectorAll('[class*="_viewToggle"]').length:0 } })()`)))
await shot('s5-pm-views.png')

// 回到已安装，展开运行时折叠区 + 打开首个功能插件详情。
await evaluate(`(() => {
  const d=document.querySelector('[role="dialog"][aria-label="插件中心"]')
  const t=d&&[...d.querySelectorAll('[role="tab"]')].find(x=>(x.textContent||'').trim()==='已安装')
  if (t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}))
})()`)
await sleep(700)
console.log('installed:', JSON.stringify(await evaluate(`(() => { const d=document.querySelector('[role="dialog"][aria-label="插件中心"]'); return { pluginRows: d.querySelectorAll('[class*="_rowMainBtn"]').length, runtimeGroup: !!d.querySelector('[class*="_runtimeGroup"]'), runtimeToggle: (d.querySelector('[class*="_runtimeToggle"]')||{}).textContent?.trim() } })()`)))
await shot('s5-pm-installed-cn.png')
// 展开运行时折叠
await evaluate(`(() => { const d=document.querySelector('[role="dialog"][aria-label="插件中心"]'); const t=d&&d.querySelector('[class*="_runtimeToggle"]'); if(t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})) })()`)
await sleep(400)
await shot('s5-pm-runtime.png')
// 收起 + 打开第一个功能插件详情
await evaluate(`(() => { const d=document.querySelector('[role="dialog"][aria-label="插件中心"]'); const t=d&&d.querySelector('[class*="_runtimeToggle"]'); if(t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})) })()`)
await sleep(200)
await evaluate(`(() => { const d=document.querySelector('[role="dialog"][aria-label="插件中心"]'); const r=d&&d.querySelector('[class*="_rowMainBtn"]'); if(r) r.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})) })()`)
await sleep(900)
console.log('detail:', JSON.stringify(await evaluate(`(() => { const d=document.querySelector('[role="dialog"][aria-label="插件中心"]'); return { name:(d.querySelector('[class*="_detailName"]')||{}).textContent, fields: d.querySelectorAll('[class*="_detailField"]').length, actions: d.querySelectorAll('[class*="_detailActionBtn"]').length, readonly: !!d.querySelector('[class*="_detailReadonly"]') } })()`)))
await shot('s5-pm-detail.png')

cdp.close()
process.exit(0)
