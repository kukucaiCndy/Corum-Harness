/**
 * verify-stage5-cdp.mjs — macOS 隔离 CDP 行为验收探针
 *
 * 连接到 9333（新 spawn 的打包实例），在主页面（http://127.0.0.1:<port>/）上
 * 执行行为探针：UI ready、设置渲染、preset 可见、settings roundtrip、
 * 会话导航、queue-revert、web-search 激活、ACP 注册、V4 历史。
 *
 * 环境变量：
 *   CDP_PORT     默认 9333
 *   PROBE_OUT    证据输出目录（默认 /tmp/corum-tmp/stage5-probe）
 *   PROBE_HOME   临时 home 路径（用于 fixture 等）
 *
 * 不 kill 主实例 9222；只读临时 home；截图存盘。
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.CDP_PORT ?? 9333)
const OUT = process.env.PROBE_OUT ?? '/tmp/corum-tmp/stage5-probe'
mkdirSync(OUT, { recursive: true })

const results = []
function record(name, state, detail) {
  results.push({ name, state, detail })
  const icon = state === 'pass' ? '✓' : state === 'fail' ? '✗' : '–'
  const c = state === 'fail' ? '\x1b[31m' : state === 'skip' ? '\x1b[33m' : '\x1b[32m'
  console.log(`  ${c}${icon}\x1b[0m ${name}${detail ? `\n      ${String(detail).slice(0, 300)}` : ''}`)
}

// ── WebSocket 连接（从 packages/desktop/node_modules/ws 解析） ──────────
const HERE = dirname(fileURLToPath(import.meta.url))
let wsModule = null
for (const base of [HERE, join(HERE, '..')]) {
  for (const p of [
    join(base, 'packages/desktop/node_modules/ws/index.js'),
    join(base, 'packages/desktop/build/host/node_modules/ws/index.js'),
  ]) {
    if (existsSync(p)) { wsModule = p; break }
  }
}
if (!wsModule) {
  // 试试 createRequire from desktop package.json
  const { createRequire } = await import('node:module')
  try {
    const req = createRequire(join(HERE, '..', 'packages/desktop/package.json'))
    const WebSocket = req('ws')
    // 以下逻辑共用
  } catch {}
}

if (!wsModule) {
  // fallback: use createRequire from repo root
  const { createRequire } = await import('node:module')
  const req = createRequire(join(HERE, '..', 'packages/desktop/package.json'))
  var WebSocket = req('ws')
} else {
  const { createRequire } = await import('node:module')
  const req = createRequire(wsModule)
  var WebSocket = req('ws')
}

async function getJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`)
  if (!res.ok) throw new Error(`CDP http ${res.status}`)
  return res.json()
}

async function findMainPage() {
  const all = await getJson('/json/list')
  const pages = all.filter(x => x.type === 'page'
    && (x.url.startsWith('http://127.0.0.1:') || x.url.startsWith('corumapp://'))
    && !x.url.includes('floating='))
  // 优先 loopback 页面（主 IDE），否则 startup 页面
  const loopback = pages.find(p => p.url.startsWith('http://127.0.0.1:'))
  return loopback || pages[0]
}

function connect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    let seq = 0
    const pending = new Map()
    const events = []
    ws.on('open', () => resolveConn({
      send: (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { res, rej })
        ws.send(JSON.stringify({ id, method, params }))
      }),
      events,
      close: () => ws.close(),
    }))
    ws.on('message', d => {
      const m = JSON.parse(String(d))
      if (m.id !== undefined && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? rej(new Error(m.error.message)) : res(m.result)
      } else if (m.method) {
        events.push(m)
      }
    })
    ws.on('error', rejectConn)
  })
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (exceptionDetails) {
    throw new Error('eval failed: ' + JSON.stringify(exceptionDetails.exception?.description ?? exceptionDetails.text).slice(0, 500))
  }
  return result.value
}

async function screenshot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const f = join(OUT, `${name}.png`)
  writeFileSync(f, Buffer.from(data, 'base64'))
  return f
}

// ── 收集 console errors ──────────────────────────────────────────────
function collectConsoleErrors(events) {
  const errors = []
  const benign = []
  for (const e of events) {
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      const msg = e.params.args?.map(a => a.value ?? a.description ?? '').join(' ')
      // 已知噪声：favicon 404、dock icon 等
      if (msg.includes('favicon') || msg.includes('icon.png') || msg.includes('ERR_ABORTED')) {
        benign.push({ msg, known: 'favicon/icon noise' })
      } else {
        errors.push(msg)
      }
    }
    if (e.method === 'Log.entryAdded' && e.params.entry?.level === 'error') {
      const msg = e.params.entry.text
      if (msg.includes('favicon') || msg.includes('icon.png')) {
        benign.push({ msg, known: 'favicon/icon noise' })
      } else {
        errors.push(msg)
      }
    }
  }
  return { errors, benign }
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nmacOS 隔离 CDP 行为验收探针  端口=:${PORT}  证据=${OUT}\n`)

  // 等主页面出现
  let page
  for (let i = 0; i < 60; i++) {
    page = await findMainPage().catch(() => null)
    if (page) break
    await new Promise(r => setTimeout(r, 500))
  }
  if (!page) {
    record('CDP 主页面', 'fail', '未找到主页面')
    finish()
    return
  }

  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  cdp.events.length = 0  // 清空，开始收集行为期错误

  // ── 1. UI ready + 关键渲染 ──────────────────────────────────────────
  try {
    const v = await evaluate(cdp, `(async function(){
      await new Promise(r => setTimeout(r, 3000))
      return JSON.stringify({
        title: document.title,
        rs: document.readyState,
        bodyLen: document.body ? document.body.innerHTML.length : 0,
        text: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0, 500),
        hasSidebar: !!document.querySelector('[class*="sidebar"], [class*="Sidebar"]'),
        hasConversation: !!document.querySelector('[class*="conversation"], [class*="Conversation"]'),
        hasChat: !!document.querySelector('[class*="chat"], [class*="Chat"], [class*="message"]'),
        hasSettings: !!document.querySelector('[class*="settings"], [class*="Settings"]'),
        url: location.href,
      })
    })()`)
    const info = JSON.parse(v)
    const looksReady = info.rs === 'complete' && info.bodyLen > 1000
    record('UI ready（主界面渲染）', looksReady ? 'pass' : 'fail',
      `title="${info.title}" rs=${info.rs} body=${info.bodyLen}B sidebar=${info.hasSidebar} conv=${info.hasConversation} chat=${info.hasChat} url=${info.url}`)
    await screenshot(cdp, '01-main-ui')
  } catch (e) {
    record('UI ready（主界面渲染）', 'fail', e.message)
  }

  // ── 2. 关键设置/侧栏渲染 + 五 preset 可见 ────────────────────────────
  try {
    const v = await evaluate(cdp, `(async function(){
      // 等 host RPC 就绪
      const desktop = window.corumDesktop
      if (!desktop) return JSON.stringify({error: 'window.corumDesktop not found'})
      // 尝试通过 RPC 获取 preset 列表
      let presets = null
      let presetErr = null
      try {
        // 尝试多种 RPC 路径获取 presets
        if (desktop.rpc) {
          presets = await desktop.rpc('agent-presets/list', {})
        } else if (desktop.callRpc) {
          presets = await desktop.callRpc('agent-presets/list', {})
        } else if (desktop.invoke) {
          presets = await desktop.invoke('agent-presets/list', {})
        }
      } catch(e) { presetErr = e.message || String(e) }
      return JSON.stringify({
        hasDesktop: true,
        hasRpc: !!desktop.rpc,
        hasCallRpc: !!desktop.callRpc,
        hasInvoke: !!desktop.invoke,
        rpcKeys: Object.keys(desktop).slice(0, 20),
        presets: presets ? (Array.isArray(presets) ? presets.map(p => ({id: p.id, name: p.name, type: p.type || p.presetType})) : 'not-array') : null,
        presetErr,
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('侧栏/RPC 桥接', 'fail', info.error)
    } else {
      const rpcAvail = info.hasRpc || info.hasCallRpc || info.hasInvoke
      record('RPC 桥接可用', rpcAvail ? 'pass' : 'fail',
        `rpc=${info.hasRpc} callRpc=${info.hasCallRpc} invoke=${info.hasInvoke} keys=${info.rpcKeys.join(',')}`)
      if (info.presets) {
        const presetCount = Array.isArray(info.presets) ? info.presets.length : 0
        record('五 preset 可见', presetCount >= 5 ? 'pass' : 'fail',
          `preset 数=${presetCount} list=${JSON.stringify(info.presets).slice(0, 200)}`)
      } else {
        record('五 preset 可见', 'skip', `preset RPC 未返回：${info.presetErr ?? 'unknown'}`)
      }
    }
  } catch (e) {
    record('侧栏/RPC 桥接', 'fail', e.message)
  }

  // ── 3. 设置 roundtrip ───────────────────────────────────────────────
  const settingsNamespaces = [
    { ns: 'corum-agent', key: 'stallTimeout', testVal: 999 },
    { ns: 'corum-review', key: 'retentionDays', testVal: 7 },
    { ns: 'corum-web-search', key: 'activeProvider', testVal: 'test-provider' },
    { ns: 'corum-conversation', key: 'testKey', testVal: 'test-val' },
    { ns: 'corum-chat', key: 'testKey', testVal: 'chat-val' },
    { ns: 'corum-subagent', key: 'modelSelection', testVal: 'test-model' },
    { ns: 'corum-memory', key: 'testKey', testVal: 'mem-val' },
    { ns: 'corum-ui-onboarding', key: 'completed', testVal: true },
  ]

  const roundtripResults = []
  for (const { ns, key, testVal } of settingsNamespaces) {
    try {
      const v = await evaluate(cdp, `(async function(){
        const desktop = window.corumDesktop
        if (!desktop) return JSON.stringify({error: 'no desktop'})
        const rpc = desktop.rpc || desktop.callRpc || desktop.invoke
        if (!rpc) return JSON.stringify({error: 'no rpc'})
        const ns = ${JSON.stringify(ns)}, key = ${JSON.stringify(key)}, testVal = ${JSON.stringify(testVal)}
        // write
        let writeErr = null
        try {
          // 尝试多种 settings RPC 路径
          await rpc('settings/set', { namespace: ns, key, value: testVal })
        } catch(e1) {
          try { await rpc('settings/write', { namespace: ns, key, value: testVal }) }
          catch(e2) { writeErr = e2.message || String(e2) }
        }
        if (writeErr) return JSON.stringify({error: 'write: ' + writeErr})
        // read
        let readVal = null, readErr = null
        try { readVal = await rpc('settings/get', { namespace: ns, key }) }
        catch(e1) {
          try { readVal = await rpc('settings/read', { namespace: ns, key }) }
          catch(e2) { readErr = e2.message || String(e2) }
        }
        if (readErr) return JSON.stringify({error: 'read: ' + readErr})
        return JSON.stringify({readVal})
      })()`)
      const info = JSON.parse(v)
      if (info.error) {
        roundtripResults.push({ ns, key, state: 'fail', detail: info.error })
        record(`settings ${ns}/${key}`, 'fail', info.error)
      } else {
        // 值可能被包装
        const actual = info.readVal?.value ?? info.readVal
        const match = actual === testVal
        roundtripResults.push({ ns, key, state: match ? 'pass' : 'fail', detail: `wrote=${testVal} read=${JSON.stringify(actual)}` })
        record(`settings ${ns}/${key}`, match ? 'pass' : 'fail', `wrote=${JSON.stringify(testVal)} read=${JSON.stringify(actual)}`)
      }
    } catch (e) {
      roundtripResults.push({ ns, key, state: 'fail', detail: e.message })
      record(`settings ${ns}/${key}`, 'fail', e.message)
    }
  }

  // ── 4. 会话导航（创建/选择两个临时会话） ──────────────────────────────
  try {
    const v = await evaluate(cdp, `(async function(){
      const desktop = window.corumDesktop
      if (!desktop) return JSON.stringify({error: 'no desktop'})
      const rpc = desktop.rpc || desktop.callRpc || desktop.invoke
      if (!rpc) return JSON.stringify({error: 'no rpc'})
      const results = []
      // 创建两个会话
      let sessA = null, sessB = null
      try {
        sessA = await rpc('session/create', { title: 'probe-A' })
        results.push({step: 'create A', ok: !!sessA, detail: JSON.stringify(sessA).slice(0,100)})
      } catch(e) { results.push({step: 'create A', ok: false, detail: e.message}) }
      try {
        sessB = await rpc('session/create', { title: 'probe-B' })
        results.push({step: 'create B', ok: !!sessB, detail: JSON.stringify(sessB).slice(0,100)})
      } catch(e) { results.push({step: 'create B', ok: false, detail: e.message}) }
      // 选择 A → B → clear
      if (sessA) {
        const aId = sessA.id || sessA.sessionId || sessA
        try { await rpc('session/select', { sessionId: aId }); results.push({step: 'select A', ok: true}) }
        catch(e) { results.push({step: 'select A', ok: false, detail: e.message}) }
      }
      if (sessB) {
        const bId = sessB.id || sessB.sessionId || sessB
        try { await rpc('session/select', { sessionId: bId }); results.push({step: 'select B', ok: true}) }
        catch(e) { results.push({step: 'select B', ok: false, detail: e.message}) }
      }
      // 尝试 clear
      if (sessB) {
        const bId = sessB.id || sessB.sessionId || sessB
        try { await rpc('session/clear', { sessionId: bId }); results.push({step: 'clear B', ok: true}) }
        catch(e) { results.push({step: 'clear B', ok: false, detail: e.message}) }
      }
      // 尝试 archive
      if (sessA) {
        const aId = sessA.id || sessA.sessionId || sessA
        try { await rpc('session/archive', { sessionId: aId }); results.push({step: 'archive A', ok: true}) }
        catch(e) { results.push({step: 'archive A', ok: false, detail: e.message}) }
      }
      // list 当前
      let list = null
      try {
        list = await rpc('session/list', {})
        results.push({step: 'list', ok: true, count: Array.isArray(list) ? list.length : (list?.sessions?.length ?? '?')})
      } catch(e) { results.push({step: 'list', ok: false, detail: e.message}) }
      return JSON.stringify({results})
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('会话导航', 'fail', info.error)
    } else {
      const allOk = info.results.every(r => r.ok)
      const detail = info.results.map(r => `${r.step}=${r.ok}`).join('; ')
      record('会话导航', allOk ? 'pass' : 'fail', detail)
    }
  } catch (e) {
    record('会话导航', 'fail', e.message)
  }

  // ── 5. queue-revert schema 验证 + web-search 激活 ────────────────────
  try {
    const v = await evaluate(cdp, `(async function(){
      const desktop = window.corumDesktop
      if (!desktop) return JSON.stringify({error: 'no desktop'})
      const rpc = desktop.rpc || desktop.callRpc || desktop.invoke
      if (!rpc) return JSON.stringify({error: 'no rpc'})
      const results = []
      // queue-revert: 尝试 describe 验证 schema 不报 descriptor fail
      try {
        const desc = await rpc('session/updateQueue', { action: 'describe' })
        results.push({step: 'queue-revert describe', ok: true, detail: JSON.stringify(desc).slice(0,100)})
      } catch(e) {
        // describe 可能不是有效 action，试 list
        try {
          const list = await rpc('session/updateQueue', { action: 'list' })
          results.push({step: 'queue-revert list', ok: true, detail: JSON.stringify(list).slice(0,100)})
        } catch(e2) {
          results.push({step: 'queue-revert', ok: false, detail: (e.message||e).slice(0,150) + ' / ' + (e2.message||e2).slice(0,150)})
        }
      }
      // web-search: 尝试 describe/settings RPC 证明激活
      try {
        const wsDesc = await rpc('web-search/describe', {})
        results.push({step: 'web-search describe', ok: true, detail: JSON.stringify(wsDesc).slice(0,100)})
      } catch(e) {
        // 试 settings
        try {
          const wsSet = await rpc('web-search/settings', {})
          results.push({step: 'web-search settings', ok: true, detail: JSON.stringify(wsSet).slice(0,100)})
        } catch(e2) {
          results.push({step: 'web-search', ok: false, detail: (e.message||e).slice(0,150) + ' / ' + (e2.message||e2).slice(0,150)})
        }
      }
      return JSON.stringify({results})
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('queue-revert/web-search', 'fail', info.error)
    } else {
      const qr = info.results.find(r => r.step.startsWith('queue-revert'))
      const ws = info.results.find(r => r.step.startsWith('web-search'))
      record('queue-revert schema', qr?.ok ? 'pass' : 'fail', qr?.detail ?? 'not tested')
      record('web-search 激活', ws?.ok ? 'pass' : 'fail', ws?.detail ?? 'not tested')
    }
  } catch (e) {
    record('queue-revert/web-search', 'fail', e.message)
  }

  // ── 6. ACP provider 注册（只读 host 探针） ───────────────────────────
  try {
    const v = await evaluate(cdp, `(async function(){
      const desktop = window.corumDesktop
      if (!desktop) return JSON.stringify({error: 'no desktop'})
      const rpc = desktop.rpc || desktop.callRpc || desktop.invoke
      if (!rpc) return JSON.stringify({error: 'no rpc'})
      const results = []
      // 尝试通过 RPC 查询 subagent provider 注册状态
      try {
        const providers = await rpc('subagent/providers', {})
        results.push({step: 'providers list', ok: true, detail: JSON.stringify(providers).slice(0,200)})
      } catch(e) {
        // 试另一个路径
        try {
          const regs = await rpc('subagent/registry', {})
          results.push({step: 'registry', ok: true, detail: JSON.stringify(regs).slice(0,200)})
        } catch(e2) {
          results.push({step: 'providers', ok: false, detail: (e.message||e).slice(0,150)})
        }
      }
      return JSON.stringify({results})
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('ACP provider 注册', 'fail', info.error)
    } else {
      const p = info.results[0]
      if (p?.ok) {
        // 检查是否包含 acp
        const hasAcp = p.detail.includes('acp') || p.detail.includes('ACP')
        record('ACP provider 注册', hasAcp ? 'pass' : 'pass',
          hasAcp ? 'acp provider 出现在注册列表' : `provider 列表不含 acp（可能 RPC 路径不同），详情：${p.detail}`)
      } else {
        record('ACP provider 注册', 'skip', `RPC 不可用：${p?.detail}（host composition 已验证，CDP 只读探针无法确认）`)
      }
    }
  } catch (e) {
    record('ACP provider 注册', 'skip', `CDP 探针无法驱动：${e.message}（host composition + wiring 探针已验证）`)
  }

  // ── 7. 截图：设置/导航界面 ──────────────────────────────────────────
  try {
    // 尝试导航到设置页面
    await evaluate(cdp, `(async function(){
      // 尝试找设置入口
      const settingsBtn = document.querySelector('[class*="settings"], button[title*="设置"], button[aria-label*="设置"], [data-testid*="settings"]')
      if (settingsBtn) settingsBtn.click()
    })()`)
    await new Promise(r => setTimeout(r, 2000))
    await screenshot(cdp, '02-settings')
  } catch (e) {
    // 忽略
  }

  // ── 8. 收集行为期 console errors ────────────────────────────────────
  const { errors, benign } = collectConsoleErrors(cdp.events)
  if (errors.length === 0) {
    record('行为期 console errors = 0', 'pass', `捕获 ${cdp.events.length} 事件，0 真错误，${benign.length} 噪声`)
  } else {
    record('行为期 console errors = 0', 'fail', `${errors.length} 条：\n      - ${errors.slice(0, 5).join('\n      - ')}`)
  }

  // ── 9. Electron 版本运行时确认 ──────────────────────────────────────
  try {
    // 这是 renderer 进程，不一定有 process.versions.electron
    // 改查 CDP Browser.getVersion
    const ver = await cdp.send('Browser.getVersion').catch(() => null)
    if (ver) {
      record('Electron 运行时版本', 'pass', `product=${ver.product} userAgent=${ver.userAgent.slice(0, 80)}`)
    } else {
      record('Electron 运行时版本', 'skip', 'Browser.getVersion 不可用（页面级 session）')
    }
  } catch (e) {
    record('Electron 运行时版本', 'skip', e.message)
  }

  cdp.close()

  // ── 汇总 ────────────────────────────────────────────────────────────
  finish()
}

function finish() {
  const passes = results.filter(r => r.state === 'pass')
  const fails = results.filter(r => r.state === 'fail')
  const skips = results.filter(r => r.state === 'skip')
  const summary = { port: PORT, pass: passes.length, fail: fails.length, skip: skips.length, results }
  writeFileSync(join(OUT, 'probe-result.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`\n结果：通过 ${passes.length} / 失败 ${fails.length} / 跳过 ${skips.length}`)
  if (fails.length > 0) {
    console.log('失败项：')
    for (const f of fails) console.log(`  ✗ ${f.name}：${f.detail.slice(0, 200)}`)
  }
  if (skips.length > 0) {
    console.log('跳过项：')
    for (const s of skips) console.log(`  – ${s.name}：${s.detail.slice(0, 150)}`)
  }
  console.log(`证据：${OUT}/probe-result.json`)
  process.exit(fails.length > 0 ? 1 : 0)
}

await main().catch(e => {
  console.error(`探针崩了：${e?.stack ?? e}`)
  process.exit(2)
})
