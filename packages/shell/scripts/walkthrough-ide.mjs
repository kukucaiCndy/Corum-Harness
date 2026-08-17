/**
 * S0 CDP walkthrough: drives the running desktop shell (launched with
 * CORUM_DEBUG_PORT=<port>) through geometry / theme / placeholder-renderer
 * assertions and captures dual-theme screenshots.
 *
 *   node scripts/walkthrough-ide.mjs [--port 9222] [--mode ide|minimal]
 *     [--out <dir>]
 *
 * Asserts (IDE mode):
 *   - Four-column geometry at the 1280 window: sidebar 280, editor 346
 *     (conceded from 430), explorer 180 (conceded to floor), status bar 34,
 *     bottom panel 0 (collapsed default).
 *   - Full-size geometry at a 1600 window: 280 / 430 / 210.
 *   - The concession chain: editor concedes after the explorer hits its floor.
 *   - Narrow-window sidebar auto-collapse (800px window → 56px rail).
 *   - Glass token resolution (light + dark): --dsw-alias-bg-base,
 *     --corum-glass-1, --dsw-alias-brand-primary, ambient glow background.
 *   - The three S0 placeholder renderers mounted in their slots
 *     (sidebar card / status bar strip / panel via ctx.layout.togglePanel).
 *
 * Asserts (minimal mode): the official three-column shell mounts (zero
 * change), no corum placeholders, no corum-glass ambient background.
 *
 * Output: a comparison table on stdout + s0-{light,dark}.png screenshots in
 * --out (default: build/walkthrough).
 */
import { spawn } from 'node:child_process'
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

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const PORT = Number(arg('port', '9222'))
const MODE = arg('mode', 'ide')
const OUT = resolve(arg('out', join(resolve(import.meta.dirname, '..'), 'build', 'walkthrough')))
mkdirSync(OUT, { recursive: true })

// ── minimal CDP client ──────────────────────────────────────────────────
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
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('corumapp://'))
      if (page) return page
    } catch { /* server not up yet */ }
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

// ── page helpers ────────────────────────────────────────────────────────
// `cdp` is the BROWSER-level connection (Browser.* domains); `sessionId` is
// the attached page session (Runtime/Page domains ride it).
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
  // Electron 43 (Chrome 150) dropped the legacy Browser.getWindowForTarget /
  // setWindowBounds pair, so resize the LAYOUT VIEWPORT instead: the shell's
  // concession solver reads the frame's own box (ResizeObserver), which tracks
  // the emulated viewport exactly. Screenshots capture the emulated scene.
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

// ── assertions ──────────────────────────────────────────────────────────
let failures = 0
const rows = []
function check(label, actual, expected, ok) {
  rows.push({ label, actual: String(actual), expected: String(expected), ok })
  if (!ok) failures += 1
}

function printTable() {
  const w = [46, 22, 22]
  const line = (a, b, c, d) => console.log(`${a.padEnd(w[0])} ${b.padEnd(w[1])} ${c.padEnd(w[2])} ${d}`)
  console.log('')
  line('CHECK', 'ACTUAL', 'EXPECTED', 'RESULT')
  line('─'.repeat(w[0]), '─'.repeat(w[1]), '─'.repeat(w[2]), '─'.repeat(6))
  for (const r of rows) line(r.label.slice(0, w[0]), r.actual, r.expected, r.ok ? 'PASS' : 'FAIL')
  console.log('')
}

const GEOMETRY_EXPR = `(() => {
  const cols = [...document.querySelectorAll('[class*="mainRow"] > *')]
  const widths = cols.map((c) => Math.round(c.getBoundingClientRect().width))
  const status = document.querySelector('[class*="statusBar"]')
  const bottom = document.querySelector('[class*="bottomPanel"]')
  const handles = document.querySelectorAll('[class*="handle"]').length
  // Bars are border-box measured; the contract tracks are the content sizes
  // (34px status bar + 1px border each side; 150px panel + 1px border).
  const track = (el) => {
    if (!el) return 0
    const cs = getComputedStyle(el)
    return Math.round(el.getBoundingClientRect().height - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth))
  }
  return {
    columns: widths,
    sidebar: widths[0] ?? 0,
    center: widths[1] ?? 0,
    editor: widths[2] ?? 0,
    explorer: widths[3] ?? 0,
    statusBar: track(status),
    bottom: track(bottom),
    handles,
    rail: !!document.querySelector('[class*="sidebarCol"][data-rail]'),
    innerWidth: window.innerWidth,
  }
})()`

async function setTheme(dark) {
  // The REAL theme path: the test plugin publishes a walkthrough-only
  // ctx.theme.setTheme bridge (window.__corumTestSetTheme), so the flip goes
  // through the preference write → theme/change → ThemePresenter projection
  // — the exact chain a user flip drives (alias tokens AND the body
  // attribute move together).
  await evaluate(`window.__corumTestSetTheme(${JSON.stringify(dark ? 'dark' : 'light')})`)
  await new Promise((r) => setTimeout(r, 400))
}

async function tokenValues() {
  return evaluate(`(() => {
    const cs = getComputedStyle(document.body)
    return {
      bgBase: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
      glass1: cs.getPropertyValue('--corum-glass-1').trim(),
      brand: cs.getPropertyValue('--dsw-alias-brand-primary').trim(),
      glow1: cs.getPropertyValue('--corum-glow-1').trim(),
      ambient: cs.backgroundImage.includes('radial-gradient'),
      font: cs.fontFamily,
    }
  })()`)
}

/**
 * The light/dark pair the shell's corum-glass overrideTokens layer maps a
 * token to (declared in ide-shell's theme-layer.ts); kept for reference — the
 * walkthrough now flips the REAL preference and asserts the projection per
 * scheme directly.
 */


// ── main ────────────────────────────────────────────────────────────────
const page = await waitForPage()
const version = await getJson('/json/version')
cdp = await connect(version.webSocketDebuggerUrl)
const attached = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
sessionId = attached.sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)

if (MODE === 'ide') {
  // Wait for the IDE shell + the S0 placeholders.
  await waitFor(`!!document.querySelector('[data-testid="corum-sidebar-placeholder"]')`, 60_000, 'sidebar placeholder')
  await waitFor(`!!document.querySelector('[data-testid="corum-statusbar-placeholder"]')`, 30_000, 'statusbar placeholder')

  // ── 1280 window: concession chain geometry ──
  await resizeWindow(1280, 860)
  await new Promise((r) => setTimeout(r, 800))
  let g = await evaluate(GEOMETRY_EXPR)
  check('1280 · 会话列表列宽 (design.pen ①, 不让位)', g.sidebar, 280, g.sidebar === 280)
  check('1280 · 资源管理器列宽 (让位链: 210 → 缩到 floor 180)', g.explorer, 180, g.explorer === 180)
  check('1280 · 编辑器列宽 (让位链: 430 → 收缩)', g.editor, 346, g.editor === 346)
  check('1280 · 对话区 flex 兜底 (≥ 400)', `≥400, got ${g.center}`, 454, g.center >= 400)
  check('1280 · 状态栏高度 (design.pen ⑦)', g.statusBar, 34, g.statusBar === 34)
  check('1280 · 底部面板默认收起', g.bottom, 0, g.bottom === 0)
  check('1280 · 拖拽把手存在 (sidebar/editor/explorer)', g.handles, 3, g.handles === 3)

  // ── 1600 window: full-size geometry ──
  await resizeWindow(1600, 900)
  await new Promise((r) => setTimeout(r, 800))
  g = await evaluate(GEOMETRY_EXPR)
  check('1600 · 四栏全尺寸 280/430/210', `${g.sidebar}/${g.editor}/${g.explorer}`, '280/430/210',
    g.sidebar === 280 && g.editor === 430 && g.explorer === 210)

  // ── narrow window: sidebar auto-collapse to the rail ──
  await resizeWindow(800, 700)
  await new Promise((r) => setTimeout(r, 800))
  g = await evaluate(GEOMETRY_EXPR)
  check('800 窄屏 · 侧栏自动收起为 rail (56px + data-rail)', `${g.sidebar}, rail=${g.rail}`, '56, rail=true',
    g.sidebar === 56 && g.rail === true)

  // ── togglePanel: bottom bar slot composition via ctx.layout ──
  // The panel starts collapsed (bottom = 0), so its registrant mounts only
  // after the layout store opens it. The first open rides the test plugin's
  // walkthrough-only global (a cordis service is unreachable from the
  // console); the close step clicks the placeholder's own 收起面板 button —
  // together they prove ctx.layout.togglePanel crosses the boundary.
  await resizeWindow(1280, 860)
  await new Promise((r) => setTimeout(r, 600))
  const opened = await evaluate(`(() => {
    const opener = window.__corumTestTogglePanel
    if (typeof opener !== 'function') return null
    opener()
    return true
  })()`)
  check('togglePanel · 测试面暴露 opener (ide-test-panel inject)', opened, true, opened === true)
  await waitFor(`!!document.querySelector('[data-testid="corum-panel-placeholder"]')`, 15_000, 'panel placeholder after open')
  await new Promise((r) => setTimeout(r, 600))
  g = await evaluate(GEOMETRY_EXPR)
  check('togglePanel · 底部面板展开 (design.pen ⑥ 默认 150)', g.bottom, 150, g.bottom === 150)
  // Click the placeholder's own 收起面板 button — the cross-plugin toggle.
  const panelMounted = await evaluate(`!!document.querySelector('[data-testid="corum-panel-placeholder"]')`)
  check('占位渲染 · corum.panel 占位（展开时已挂载）', panelMounted, true, panelMounted === true)
  await evaluate(`document.querySelector('[data-testid="corum-panel-placeholder"] button').click()`)
  await new Promise((r) => setTimeout(r, 600))
  g = await evaluate(GEOMETRY_EXPR)
  check('togglePanel · 占位按钮点击后收起', g.bottom, 0, g.bottom === 0)

  // ── placeholders render in their slots ──
  const placeholders = await evaluate(`({
    sidebar: !!document.querySelector('[data-testid="corum-sidebar-placeholder"]'),
    statusbar: !!document.querySelector('[data-testid="corum-statusbar-placeholder"]'),
    panel: !!document.querySelector('[data-testid="corum-panel-placeholder"]'),
    settingsSeat: !!document.querySelector('[class*="sidebarFoot"]'),
  })`)
  check('占位渲染 · corum.sidebar 占位卡', placeholders.sidebar, true, placeholders.sidebar === true)
  check('占位渲染 · corum.statusBar 占位条', placeholders.statusbar, true, placeholders.statusbar === true)
  check('设置座 · sidebar.settings 挂载点存在', placeholders.settingsSeat, true, placeholders.settingsSeat === true)

  // ── glass tokens: the real preference flip (setTheme → theme/change →
  // presenter), asserting the full projection per scheme ──
  const initialDark = await evaluate(`document.body.hasAttribute('data-ds-dark-theme')`)

  await setTheme(false)
  let t = await tokenValues()
  check('浅色 token · --dsw-alias-bg-base', t.bgBase, '#E9E9F2', t.bgBase.toUpperCase() === '#E9E9F2')
  check('浅色 token · --corum-glass-1', t.glass1, '#FFFFFFE6', t.glass1.toUpperCase() === '#FFFFFFE6')
  check('浅色 token · --dsw-alias-brand-primary', t.brand, '#5B21F5', t.brand.toUpperCase() === '#5B21F5')
  check('浅色 · ambient 光斑背景透出', t.ambient, true, t.ambient === true)
  const lightShot = await screenshot('s0-light.png')

  await setTheme(true)
  t = await tokenValues()
  check('深色 token · --dsw-alias-bg-base', t.bgBase, '#0D0817', t.bgBase.toUpperCase() === '#0D0817')
  check('深色 token · --corum-glass-1', t.glass1, '#1D112BD9', t.glass1.toUpperCase() === '#1D112BD9')
  check('深色 token · --dsw-alias-brand-primary', t.brand, '#01CDFE', t.brand.toUpperCase() === '#01CDFE')
  check('深色 · ambient 光斑背景透出', t.ambient, true, t.ambient === true)
  const darkShot = await screenshot('s0-dark.png')
  await setTheme(initialDark)

  printTable()
  console.log(`screenshots: ${lightShot}`)
  console.log(`             ${darkShot}`)
} else {
  // ── minimal mode: the official shell, zero change ──
  await waitFor(`document.body.children.length > 0`, 30_000, 'minimal shell mount')
  await new Promise((r) => setTimeout(r, 3000))
  const probe = await evaluate(`(() => {
    const cs = getComputedStyle(document.body)
    return {
      corumSidebar: !!document.querySelector('[data-testid="corum-sidebar-placeholder"]'),
      corumStatusbar: !!document.querySelector('[data-testid="corum-statusbar-placeholder"]'),
      corumPanel: !!document.querySelector('[data-testid="corum-panel-placeholder"]'),
      ambient: cs.backgroundImage.includes('radial-gradient'),
      glassVar: cs.getPropertyValue('--corum-glass-1').trim(),
      hasContent: document.body.innerText.length > 0,
    }
  })()`)
  check('极简 · 无 corum.sidebar 占位', probe.corumSidebar, false, probe.corumSidebar === false)
  check('极简 · 无 corum.statusBar 占位', probe.corumStatusbar, false, probe.corumStatusbar === false)
  check('极简 · 无 corum.panel 占位', probe.corumPanel, false, probe.corumPanel === false)
  check('极简 · 无 ambient 光斑背景', probe.ambient, false, probe.ambient === false)
  check('极简 · 无 --corum-glass-1 变量', probe.glassVar === '' ? '(empty)' : probe.glassVar, '(empty)', probe.glassVar === '')
  check('极简 · 官方壳渲染有内容', probe.hasContent, true, probe.hasContent === true)
  const shot = await screenshot('s0-minimal.png')
  printTable()
  console.log(`screenshot: ${shot}`)
}

cdp.close()
if (failures > 0) {
  console.error(`[walkthrough] ${failures} assertion(s) FAILED (mode=${MODE})`)
  process.exit(1)
}
console.log(`[walkthrough] all assertions passed (mode=${MODE})`)
process.exit(0)
