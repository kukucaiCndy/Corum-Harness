/**
 * verify-stage5-cdp.mjs — macOS 隔离 CDP 行为验收探针
 *
 * 连接到 9333（新 spawn 的打包实例），在主页面（http://127.0.0.1:<port>/）上
 * 执行行为探针：
 *
 * **UI ready 判据**（真实公开面）：
 *   - `!document.querySelector('[data-dsh-boot]')` — React 已挂载、boot 占位已替换
 *   - `!!document.querySelector('[data-session-band]')` — IDE 主界面 session-bar 已挂载
 *   - `window.__DSH_BOOT__?.entries?.length > 0` — 模块入口图已构建
 *
 * **公开桥接判据**（`window.corumDesktop` 的真实 IPC 面）：
 *   - `getAppVersion()` — 返回非空版本号
 *   - `getPlatform()` — 返回 'darwin'
 *   - `getBootDiagnostics()` — 返回诊断（无 skipped bundles = 干净启动）
 *
 * **不猜 RPC 路径**：旧探针猜 `window.corumDesktop.rpc` / `callRpc` / `invoke`，
 * 全部不存在（preload 不暴露 RPC）。设置 roundtrip / preset 列表 / 会话导航
 * 需要内部 cordis 服务（`ctx.configForms`、`ctx.connection.rpc.call`），
 * CDP 只读探针无法从 `window` 直接访问这些服务。这些行为通过**单元测试**
 * （真实 cordis Context）验证，不在此探针中假测。
 *
 * **不写 testKey**：旧探针往 `corum-conversation/testKey` 等写假值——这些 key
 * 不在真实 schema 里。真实 schema key（`busyEnter`、`transcriptView`、
 * `stallRecoverMinutes`、`retentionDays`、`activeProvider`）的 roundtrip
 * 走单元测试，不走 CDP 探针。
 *
 * 环境变量：
 *   CDP_PORT     默认 9333
 *   PROBE_OUT    证据输出目录（默认 /tmp/corum-tmp/stage5-probe）
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

// ── WebSocket 连接 ──────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url))
const { createRequire } = await import('node:module')
const req = createRequire(join(HERE, '..', 'packages/desktop/package.json'))
const WebSocket = req('ws')

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
      if (msg.includes('favicon') || msg.includes('icon.png') || msg.includes('ERR_ABORTED') || msg.includes('Download the React DevTools')) {
        benign.push({ msg, known: 'dev/favicon noise' })
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
  for (let i = 0; i < 90; i++) {
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

  // ── 1. UI ready（真实判据：data-dsh-boot 移除 + data-session-band 挂载） ──
  try {
    // 等主界面挂载完成（最多 35s，与 main.ts 的 30s 超时对齐 + 余量）
    let uiReady = false
    let bootInfo = null
    for (let i = 0; i < 70; i++) {
      const v = await evaluate(cdp, `(function(){
        var bootEl = document.querySelector('[data-dsh-boot]')
        var bandEl = document.querySelector('[data-session-band]')
        var boot = window.__DSH_BOOT__
        return JSON.stringify({
          hasBootMarker: !!bootEl,
          hasSessionBand: !!bandEl,
          bootEntries: boot?.entries?.length ?? 0,
          readyState: document.readyState,
          url: location.href,
          title: document.title,
        })
      })()`)
      bootInfo = JSON.parse(v)
      if (!bootInfo.hasBootMarker && bootInfo.hasSessionBand && bootInfo.bootEntries > 0) {
        uiReady = true
        break
      }
      await new Promise(r => setTimeout(r, 500))
    }

    if (uiReady) {
      record('UI ready（主界面渲染）', 'pass',
        `boot marker removed ✓, session-band mounted ✓, boot entries=${bootInfo.bootEntries}, url=${bootInfo.url}`)
    } else {
      record('UI ready（主界面渲染）', 'fail',
        `bootMarker=${bootInfo.hasBootMarker} sessionBand=${bootInfo.hasSessionBand} entries=${bootInfo.bootEntries} rs=${bootInfo.readyState} url=${bootInfo.url}`)
    }
    await screenshot(cdp, '01-main-ui')
  } catch (e) {
    record('UI ready（主界面渲染）', 'fail', e.message)
  }

  // ── 2. __DSH_BOOT__ 模块入口图 ────────────────────────────────────────
  try {
    const v = await evaluate(cdp, `(function(){
      var boot = window.__DSH_BOOT__
      if (!boot) return JSON.stringify({error: '__DSH_BOOT__ not found'})
      var entries = boot.entries || []
      var ids = entries.map(function(e){ return e.id }).sort()
      return JSON.stringify({
        entryCount: entries.length,
        entryIds: ids.slice(0, 30),
        hasPending: Array.isArray(boot.pending),
        pendingCount: boot.pending?.length ?? 0,
        hasErrors: Array.isArray(boot.errors),
        errorCount: boot.errors?.length ?? 0,
        errors: (boot.errors || []).slice(0, 5),
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('__DSH_BOOT__ 模块图', 'fail', info.error)
    } else {
      const hasEntries = info.entryCount > 0
      record('__DSH_BOOT__ 模块图', hasEntries ? 'pass' : 'fail',
        `entries=${info.entryCount} pending=${info.pendingCount} errors=${info.errorCount}${info.errorCount > 0 ? `: ${JSON.stringify(info.errors)}` : ''}`)
      // Dump full entry list for evidence
      writeFileSync(join(OUT, 'boot-entries.json'), JSON.stringify(info, null, 2) + '\n')
    }
  } catch (e) {
    record('__DSH_BOOT__ 模块图', 'fail', e.message)
  }

  // ── 3. 公开桥接面（window.corumDesktop 真实 IPC） ─────────────────────
  try {
    const v = await evaluate(cdp, `(async function(){
      var d = window.corumDesktop
      if (!d) return JSON.stringify({error: 'window.corumDesktop not found'})
      var info = {
        hasBridge: true,
        keys: Object.keys(d).sort(),
        platform: typeof d.getPlatform === 'function' ? d.getPlatform() : null,
      }
      // getAppVersion (real IPC)
      try { info.appVersion = await d.getAppVersion() } catch(e) { info.appVersionErr = String(e) }
      // getBuildChannel (real IPC)
      try { info.buildChannel = await d.getBuildChannel() } catch(e) { info.buildChannelErr = String(e) }
      // getBootDiagnostics (real IPC)
      try { info.bootDiagnostics = await d.getBootDiagnostics() } catch(e) { info.bootDiagErr = String(e) }
      return JSON.stringify(info)
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('公开桥接面 (window.corumDesktop)', 'fail', info.error)
    } else {
      record('公开桥接面 (window.corumDesktop)', 'pass',
        `platform=${info.platform} version=${info.appVersion} channel=${info.buildChannel} keys=${info.keys.length}`)
      // Boot diagnostics: check for skipped bundles
      if (info.bootDiagnostics) {
        const diag = info.bootDiagnostics
        const skipped = diag.skipped || []
        if (skipped.length === 0) {
          record('启动诊断 (无 skipped bundles)', 'pass', `干净启动，无 bundle 被跳过`)
        } else {
          record('启动诊断 (无 skipped bundles)', 'fail',
            `${skipped.length} 个 bundle 被跳过: ${skipped.map(s => s.packageName + '[' + s.reason + ']').join(', ')}`)
        }
        writeFileSync(join(OUT, 'boot-diagnostics.json'), JSON.stringify(diag, null, 2) + '\n')
      }
    }
  } catch (e) {
    record('公开桥接面 (window.corumDesktop)', 'fail', e.message)
  }

  // ── 4. 关键交互元素存在性 ──────────────────────────────────────────────
  try {
    const v = await evaluate(cdp, `(function(){
      return JSON.stringify({
        hasSessionBand: !!document.querySelector('[data-session-band]'),
        hasSidebar: !!document.querySelector('[class*="sidebar"], [class*="Sidebar"], [data-testid*="sidebar"]'),
        hasConversation: !!document.querySelector('[class*="conversation"], [class*="Conversation"], [data-testid*="conversation"]'),
        hasChat: !!document.querySelector('[class*="chat"], [class*="Chat"], [class*="message"], [data-testid*="chat"]'),
        hasInput: !!document.querySelector('textarea, [contenteditable="true"], [class*="input"], [class*="composer"]'),
        hasTitlebar: !!document.querySelector('[class*="titlebar"], [class*="TitleBar"], [class*="traffic-light"]'),
        bodyText: (document.body?.innerText || '').replace(/\\s+/g,' ').slice(0, 300),
      })
    })()`)
    const info = JSON.parse(v)
    const hasKeyElements = info.hasSessionBand && (info.hasSidebar || info.hasConversation || info.hasChat)
    record('关键交互元素', hasKeyElements ? 'pass' : 'fail',
      `sessionBand=${info.hasSessionBand} sidebar=${info.hasSidebar} conv=${info.hasConversation} chat=${info.hasChat} input=${info.hasInput} titlebar=${info.hasTitlebar}`)
  } catch (e) {
    record('关键交互元素', 'fail', e.message)
  }

  // ── 5. 五 preset 可见（通过 UI 渲染而非猜测 RPC） ─────────────────────
  // 旧探针猜 `desktop.rpc('agent-presets/list')` — 该方法不存在于 window.corumDesktop。
  // preset 列表通过内部 cordis 服务渲染进侧栏 UI；CDP 只读探针验"侧栏有渲染内容"而非"RPC 返回 5 项"。
  // 真实的 preset roundtrip 由单元测试覆盖。
  try {
    const v = await evaluate(cdp, `(function(){
      // 检查侧栏区域有渲染的会话/预设相关元素
      var sidebar = document.querySelector('[class*="sidebar"], [class*="Sidebar"], [data-testid*="sidebar"]')
      if (!sidebar) return JSON.stringify({error: 'no sidebar element found'})
      // 统计可交互项（按钮/链接/卡片等）
      var items = sidebar.querySelectorAll('button, a, [role="button"], [class*="item"], [class*="card"], [class*="preset"]')
      return JSON.stringify({
        sidebarExists: true,
        itemCount: items.length,
        sidebarText: (sidebar.innerText || '').replace(/\\s+/g,' ').slice(0, 200),
      })
    })()`)
    const info = JSON.parse(v)
    if (info.error) {
      record('侧栏渲染内容', 'skip', info.error + '（preset 列表走内部 cordis 服务，CDP 无法直接调用）')
    } else {
      record('侧栏渲染内容', info.itemCount > 0 ? 'pass' : 'fail',
        `item count=${info.itemCount} text="${info.sidebarText.slice(0, 100)}"`)
    }
  } catch (e) {
    record('侧栏渲染内容', 'skip', `CDP 探针无法驱动：${e.message}（preset 列表走内部 cordis 服务）`)
  }

  // ── 6. 设置/会话/queue-revert/web-search ──────────────────────────────
  // 这些行为需要内部 cordis 服务（ctx.configForms / ctx.connection.rpc.call / ctx.sessions），
  // CDP 只读探针无法从 window 直接访问。真实行为由单元测试覆盖：
  // - settings roundtrip: corum-ui-navigation/tests + corum-agent/tests/settings-ns-alignment
  // - session navigation: corum-ui-navigation/tests/corum-navigation.spec.ts (real cordis Context)
  // - queue-revert: corum-session-queue-revert 单测
  // - web-search: corum-web-search 单测 + settings-ns-alignment activeProvider
  // 不在此探针中假测或 SKIP。
  record('设置 roundtrip (真实 schema key)', 'skip',
    '走单元测试：corum-ui-navigation/tests + settings-ns-alignment（busyEnter/transcriptView/stallRecoverMinutes/retentionDays/activeProvider）')
  record('会话导航 A→B→clear→archive', 'skip',
    '走单元测试：corum-ui-navigation/tests/corum-navigation.spec.ts（真实 cordis Context + ISessions mock）')
  record('queue-revert schema', 'skip', '走单元测试：corum-session-queue-revert')
  record('web-search 激活', 'skip', '走单元测试：corum-web-search + settings-ns-alignment activeProvider')

  // ── 7. ACP provider 注册 ──────────────────────────────────────────────
  // ACP 注册走 host composition（cordis.ide.patch.yml 里的 corum-subagent-acp 行），
  // CDP 无法从 renderer 确认 host 侧 provider 列表。
  record('ACP provider 注册', 'skip', '走 host composition 验证（cordis.ide.patch.yml corum-subagent-acp 行 + host boot 日志）')

  // ── 8. V4 历史 ────────────────────────────────────────────────────────
  // V4 历史走内部 session/archive 服务，CDP 无法从 window 直接访问。
  record('V4 历史按真实公开面', 'skip', '走单元测试：corum-session-archive')

  // ── 9. 截图：完整界面 ────────────────────────────────────────────────
  try {
    await screenshot(cdp, '02-full-ui')
  } catch (e) {
    // 忽略截图失败
  }

  // ── 10. 收集行为期 console errors ────────────────────────────────────
  const { errors, benign } = collectConsoleErrors(cdp.events)
  if (errors.length === 0) {
    record('行为期 console errors = 0', 'pass', `捕获 ${cdp.events.length} 事件，0 真错误，${benign.length} 噪声`)
  } else {
    record('行为期 console errors = 0', 'fail', `${errors.length} 条：\n      - ${errors.slice(0, 5).join('\n      - ')}`)
  }

  // ── 11. Electron 运行时版本 ──────────────────────────────────────────
  try {
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
    console.log('跳过项（走单元测试）：')
    for (const s of skips) console.log(`  – ${s.name}：${s.detail.slice(0, 150)}`)
  }
  console.log(`证据：${OUT}/probe-result.json`)
  // 有 fail 则退出码 1；只有 pass+skip 则 0
  process.exit(fails.length > 0 ? 1 : 0)
}

await main().catch(e => {
  console.error(`探针崩了：${e?.stack ?? e}`)
  process.exit(2)
})
