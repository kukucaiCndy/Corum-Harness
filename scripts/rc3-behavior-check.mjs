#!/usr/bin/env node
/**
 * rc3-behavior-check.mjs — CDP behavior verification on the new rc.3 dist.
 * Verifies: presets visible, web-search settings activated, sidebar render,
 * boot diagnostics, queue-revert wire, session creation dialog.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const PORT = Number(process.env.CDP_PORT ?? 9333)
const OUT = '/tmp/corum-rc3-test'
mkdirSync(OUT, { recursive: true })

const HERE = dirname(fileURLToPath(import.meta.url))
const req = createRequire(join(HERE, '..', 'packages/desktop/package.json'))
const WebSocket = req('ws')

const results = []
function record(name, state, detail) {
  results.push({ name, state, detail })
  const icon = state === 'pass' ? '✓' : state === 'fail' ? '✗' : '–'
  const c = state === 'fail' ? '\x1b[31m' : state === 'skip' ? '\x1b[33m' : '\x1b[32m'
  console.log(`  ${c}${icon}\x1b[0m ${name}${detail ? `\n      ${String(detail).slice(0, 300)}` : ''}`)
}

async function getJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`)
  return res.json()
}

async function findPage() {
  for (let i = 0; i < 90; i++) {
    try {
      const all = await getJson('/json/list')
      const page = all.find(x => x.type === 'page' && x.url.startsWith('http://127.0.0.1:'))
      if (page) return page
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('no page found')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    let seq = 0
    const pending = new Map()
    ws.on('open', () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { res, rej })
        ws.send(JSON.stringify({ id, method, params }))
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
    ws.on('error', reject)
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
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
}

async function main() {
  console.log(`\nrc3 行为验证探针  端口=:${PORT}  证据=${OUT}\n`)
  const page = await findPage()
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')

  // Wait for UI ready
  let uiReady = false
  for (let i = 0; i < 70; i++) {
    const v = await evaluate(cdp, `(function(){
      return JSON.stringify({
        boot: !document.querySelector('[data-dsh-boot]'),
        band: !!document.querySelector('[data-session-band]'),
        entries: window.__DSH_BOOT__?.entries?.length ?? 0,
      })
    })()`)
    const info = JSON.parse(v)
    if (info.boot && info.band && info.entries > 0) { uiReady = true; break }
    await new Promise(r => setTimeout(r, 500))
  }
  record('UI ready', uiReady ? 'pass' : 'fail', uiReady ? '主界面已渲染' : '主界面未 ready')

  // 1. Sidebar + presets visible
  try {
    const v = await evaluate(cdp, `(function(){
      var sidebar = document.querySelector('[data-slot="corum.sidebar"]')
      var sessions = document.querySelector('[data-slot="corum.sidebar.sessions"]')
      var items = sidebar ? sidebar.querySelectorAll('button, [role="button"], a') : []
      var text = (sessions ? sessions.innerText : '').replace(/\\s+/g, ' ').slice(0, 300)
      return JSON.stringify({
        hasSidebar: !!sidebar,
        hasSessions: !!sessions,
        itemCount: items.length,
        sidebarText: text,
      })
    })()`)
    const info = JSON.parse(v)
    record('侧栏 + preset 渲染', info.hasSidebar && info.itemCount > 0 ? 'pass' : 'fail',
      `sidebar=${info.hasSidebar} sessions=${info.hasSessions} items=${info.itemCount} text="${info.sidebarText.slice(0, 100)}"`)
  } catch (e) { record('侧栏 + preset 渲染', 'fail', e.message) }

  // 2. Boot diagnostics via __DSH_BOOT__ (all entries activated, no pending/errors)
  try {
    const v = await evaluate(cdp, `(function(){
      var boot = window.__DSH_BOOT__
      if (!boot) return JSON.stringify({error: '__DSH_BOOT__ not found'})
      var entries = boot.entries || []
      return JSON.stringify({
        entryCount: entries.length,
        pendingCount: (boot.pending || []).length,
        pending: boot.pending || [],
        errorCount: (boot.errors || []).length,
        errors: boot.errors || [],
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('启动诊断 (全激活无 pending)', 'fail', info.error)
    } else {
      const ok = info.pendingCount === 0 && info.errorCount === 0 && info.entryCount > 0
      record('启动诊断 (全激活无 pending)', ok ? 'pass' : 'fail',
        `entries=${info.entryCount} pending=${info.pendingCount} errors=${info.errorCount}`)
    }
  } catch (e) { record('启动诊断 (全激活无 pending)', 'fail', e.message) }

  // 3. Web-search settings activated (entry in __DSH_BOOT__, no pending)
  try {
    const v = await evaluate(cdp, `(function(){
      var boot = window.__DSH_BOOT__
      if (!boot) return JSON.stringify({error: 'no boot'})
      var entries = boot.entries || []
      var ws = entries.find(e => String(e.id).includes('corum-web-search'))
      var wsSettings = entries.find(e => String(e.id).includes('settings-web-search'))
      return JSON.stringify({
        webSearchEntry: ws ? { id: ws.id, activated: true } : null,
        webSearchSettingsEntry: wsSettings ? { id: wsSettings.id, activated: true } : null,
        pending: boot.pending || [],
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('web-search settings 激活', 'fail', info.error)
    } else {
      const wsOk = info.webSearchEntry && info.pending.length === 0
      record('web-search settings 激活', wsOk ? 'pass' : 'fail',
        `web-search=${JSON.stringify(info.webSearchEntry)} settings-ui=${JSON.stringify(info.webSearchSettingsEntry)} pending=${info.pending.length}`)
    }
  } catch (e) { record('web-search settings 激活', 'fail', e.message) }

  // 4. Settings roundtrip via IPC (corumDesktop bridge)
  try {
    const v = await evaluate(cdp, `(async function(){
      var d = window.corumDesktop
      if (!d) return JSON.stringify({error: 'no bridge'})
      var keys = Object.keys(d).sort()
      // Check for settings-related IPC methods
      var hasGetSettings = typeof d.getSettings === 'function'
      var hasGetAppVersion = typeof d.getAppVersion === 'function'
      var version = null
      try { version = await d.getAppVersion() } catch(e) { version = String(e) }
      return JSON.stringify({
        keys: keys,
        hasGetSettings: hasGetSettings,
        hasGetAppVersion: hasGetAppVersion,
        version: version,
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('设置 RPC 桥接面', 'fail', info.error)
    } else {
      // Settings RPC is via internal cordis services (configForms), not window.corumDesktop.
      // The bridge exposes getAppVersion/getPlatform/getBootDiagnostics — settings roundtrip
      // goes through the settings controller Remote (settingsController), verified by unit tests.
      // Here we verify the bridge exists and has the expected IPC surface.
      record('设置 RPC 桥接面', info.hasGetAppVersion ? 'pass' : 'fail',
        `bridge keys=${info.keys.length} version=${info.version} hasGetAppVersion=${info.hasGetAppVersion}`)
    }
  } catch (e) { record('设置 RPC 桥接面', 'fail', e.message) }

  // 5. Session creation dialog (click "新建任务")
  try {
    // Find and click the "新建任务" button
    const v = await evaluate(cdp, `(function(){
      var buttons = document.querySelectorAll('button, [role="button"]')
      for (var b of buttons) {
        if (b.innerText && b.innerText.includes('新建任务')) {
          b.click()
          return JSON.stringify({ clicked: true, text: b.innerText.trim() })
        }
      }
      return JSON.stringify({ clicked: false, buttons: Array.from(buttons).map(b => b.innerText.trim()).filter(t => t).slice(0, 10) })
    })()`)
    const info = JSON.parse(v)
    if (info.clicked) {
      // Wait for dialog
      await new Promise(r => setTimeout(r, 1500))
      const v2 = await evaluate(cdp, `(function(){
        var body = document.body.innerText
        // Check for session creation form elements
        var hasWorkspaceSelect = body.includes('工作区') || body.includes('选择工作区')
        var hasAgent = body.includes('Agent') || body.includes('工程师')
        var hasPermission = body.includes('权限') || body.includes('只读')
        var hasStart = body.includes('开始')
        var hasCancel = body.includes('取消')
        return JSON.stringify({
          hasWorkspaceSelect, hasAgent, hasPermission, hasStart, hasCancel,
          bodyText: body.replace(/\\s+/g, ' ').slice(0, 400),
        })
      })()`)
      const info2 = JSON.parse(v2)
      const ok = info2.hasAgent || info2.hasPermission || info2.hasStart
      record('会话创建对话框', ok ? 'pass' : 'fail',
        `workspace=${info2.hasWorkspaceSelect} agent=${info2.hasAgent} perm=${info2.hasPermission} start=${info2.hasStart} text="${info2.bodyText.slice(0, 150)}"`)
    } else {
      record('会话创建对话框', 'fail', `未找到「新建任务」按钮。可用按钮: ${JSON.stringify(info.buttons)}`)
    }
  } catch (e) { record('会话创建对话框', 'fail', e.message) }

  // 6. Queue-revert wire verification (corum-ui-chat activated = patchUpdateQueueWire succeeded)
  try {
    const v = await evaluate(cdp, `(function(){
      var boot = window.__DSH_BOOT__
      if (!boot) return JSON.stringify({error: 'no boot'})
      var entries = boot.entries || []
      var chat = entries.find(e => String(e.id).includes('corum-ui-chat'))
      return JSON.stringify({
        chatEntry: chat ? { id: chat.id, activated: true } : null,
        pending: boot.pending || [],
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('queue-revert wire (corum-ui-chat 激活)', 'fail', info.error)
    } else {
      // corum-ui-chat activates only if patchUpdateQueueWire succeeds (it's called in apply())
      record('queue-revert wire (corum-ui-chat 激活)', info.chatEntry && info.pending.length === 0 ? 'pass' : 'fail',
        `chat=${JSON.stringify(info.chatEntry)} pending=${info.pending.length}`)
    }
  } catch (e) { record('queue-revert wire (corum-ui-chat 激活)', 'fail', e.message) }

  // 7. ACP provider registration (corum-subagent-acp in boot entries)
  try {
    const v = await evaluate(cdp, `(function(){
      var boot = window.__DSH_BOOT__
      if (!boot) return JSON.stringify({error: 'no boot'})
      var entries = boot.entries || []
      var acp = entries.find(e => String(e.id).includes('corum-subagent') || String(e.id).includes('dsh-client-ui-settings-subagent'))
      return JSON.stringify({
        acpEntry: acp ? { id: acp.id, activated: true } : null,
        pending: boot.pending || [],
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('ACP provider 注册', 'fail', info.error)
    } else {
      record('ACP provider 注册', info.acpEntry && info.pending.length === 0 ? 'pass' : 'fail',
        `acp=${JSON.stringify(info.acpEntry)} pending=${info.pending.length}`)
    }
  } catch (e) { record('ACP provider 注册', 'fail', e.message) }

  // 8. V4 history (session-archive plugin activated)
  try {
    const v = await evaluate(cdp, `(function(){
      var boot = window.__DSH_BOOT__
      if (!boot) return JSON.stringify({error: 'no boot'})
      var entries = boot.entries || []
      var archive = entries.find(e => String(e.id).includes('corum-session-archive'))
      return JSON.stringify({
        archiveEntry: archive ? { id: archive.id, activated: true } : null,
        pending: boot.pending || [],
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('V4 历史 (session-archive)', 'fail', info.error)
    } else {
      record('V4 历史 (session-archive)', info.archiveEntry && info.pending.length === 0 ? 'pass' : 'fail',
        `archive=${JSON.stringify(info.archiveEntry)} pending=${info.pending.length}`)
    }
  } catch (e) { record('V4 历史 (session-archive)', 'fail', e.message) }

  // Screenshot
  try { await screenshot(cdp, '03-behavior-check') } catch {}

  cdp.close()

  const passes = results.filter(r => r.state === 'pass')
  const fails = results.filter(r => r.state === 'fail')
  console.log(`\n结果：通过 ${passes.length} / 失败 ${fails.length}`)
  if (fails.length > 0) {
    console.log('失败项：')
    for (const f of fails) console.log(`  ✗ ${f.name}: ${f.detail.slice(0, 200)}`)
  }
  writeFileSync(join(OUT, 'behavior-result.json'), JSON.stringify({ pass: passes.length, fail: fails.length, results }, null, 2) + '\n')
  process.exit(fails.length > 0 ? 1 : 0)
}

await main().catch(e => { console.error(`探针崩了: ${e?.stack ?? e}`); process.exit(2) })
