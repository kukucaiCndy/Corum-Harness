#!/usr/bin/env node
/**
 * ui-verify.mjs —— 声明式 UI 断言跑器（CDP）。
 *
 * ## 为什么需要它（2026-09-12 实测痛点）
 *
 * 指挥模式那轮实测：**实现只花 9.1 分钟，验证花了 98.8 分钟**（占整轮 84%），
 * 因为验证子 Agent 写了 **48 个一次性探针脚本**（a0_inject_topbar.js / a1_open.js /
 * a2_assert.js / a3_detail.js / a4_cards.js …）—— 每加一条断言就要新写一个脚本
 * 加一次 bash 往返。本跑器把「一轮 UI 验证」压成**一份声明式规格 + 一次调用**：
 *
 *     node .agents/skills/corum-cdp-verify/scripts/ui-verify.mjs spec.json
 *
 * ## 规格格式（JSON 或导出同构对象的 .mjs）
 *
 * ```json
 * {
 *   "port": 9333,
 *   "before": [ { "click": "button[aria-label='插件中心']" }, { "wait": 800 } ],
 *   "assert": [
 *     { "label": "浮层已打开", "selector": "[data-plugin-manager-overlay]", "exists": true },
 *     { "label": "搜索框唯一", "selector": "input[type=search]", "count": 1 },
 *     { "label": "标题含已安装", "selector": "[class*=panel]", "textContains": "已安装" },
 *     { "label": "面板圆角 24", "selector": "[class*=panel]", "style": { "borderRadius": "24px" } },
 *     { "label": "市场截图", "screenshot": "market-overlay" }
 *   ]
 * }
 * ```
 *
 * - `before` 步骤（按序执行）：`click`（CSS 选择器，或 `text:` 前缀按可见文字找按钮）、
 *   `wait`（毫秒）、`eval`（原始 JS，返回值忽略）、`type`（真打字：`{ type, into?, submit? }`
 *   —— 走 CDP `Input.insertText`，React 受控组件只有这条路数；`submit: true` 追加 Enter）、
 *   `key`（单键/组合键，如 `"Escape"`、`"Meta+a"`）。
 * - `assert` 条目（按序执行）：`exists` / `count` / `textContains` / `textEquals` /
 *   `style`（计算样式精确匹配，值做去空格比较）/ `js`（原始表达式，与 `expect` 做
 *   JSON 深比较；省略 `expect` 即「取真值」——滚动量、折叠行数这类测得值用它）/
 *   `screenshot`（存到 CDP_OUT）。
 *   任一条失败 → 该条标 FAIL，最后汇总并**以非零码退出**（可直接当门禁用）。
 * - 顶层 `target`：`"main"`（缺省，排除浮窗）或 `"floating"`（`?floating=<slotKey>` 浮窗，
 *   先用 `window.corumDesktop.openFloating(slotKey)` 打开）；`pageUrlIncludes` 可做任意子串
 *   匹配。浮窗验证**必须**指定，否则断言打在主窗上（假绿）。
 *
 * ## 与 cdp.mjs 的关系
 *
 * 同一个 CDP 连接方式（`ws` 从 desktop 包解析、`Target.attachToTarget` flatten）。
 * cdp.mjs 是「跑一段 JS / 截一张图」的瑞士军刀；本跑器是「一份规格 → 一份 PASS/FAIL
 * 报告」的验证装置。**多断言场景一律用本跑器**，不要退回一轮写一个脚本。
 *
 * ## 环境
 *   CDP_PORT     默认 9333（= corum-instance.sh --home=verify 的验证实例端口）
 *   CDP_OUT      截图目录，默认 /tmp/corum-cdp/shots
 *   CORUM_DESKTOP_PKG  desktop 包 package.json 路径（解析 `ws` 用）
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 连接/规格错误。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 主 checkout 解析（与 verify-instance.sh / cdp.mjs 同口径）：本脚本可能从仓库
 * `scripts/`、技能包 `$CORUM_HOME/skills/corum-cdp-verify/scripts/`、或隔离 worktree 的
 * cwd 调用，三处都要定位到同一份带依赖的主 checkout。
 * @returns 主 checkout 绝对路径；解析失败返回 undefined。
 */
function resolveRepoRoot() {
  const fromEnv = process.env.CORUM_REPO
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(join(fromEnv, 'packages/desktop/package.json'))) return fromEnv
  const own = dirname(dirname(fileURLToPath(import.meta.url)))
  if (existsSync(join(own, 'packages/desktop/package.json'))) return own
  for (const cwd of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    try {
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const root = dirname(resolve(cwd, common))
      if (existsSync(join(root, 'packages/desktop/package.json'))) return root
    } catch { /* 不在 git 仓库里：继续试下一个 */ }
  }
  return undefined
}

/** 主实例硬闸（与 cdp.mjs 同口径）：缺省禁止打 :9222，需 CORUM_ALLOW_MAIN=1 显式放行。 */
function assertMainInstanceAllowed(port) {
  if (port !== 9222) return
  if (process.env.CORUM_ALLOW_MAIN === '1') return
  process.stderr.write('[ui-verify] 拒绝操作 :9222（用户主实例）；验证请用 :9333（spec.port 或 CDP_PORT）。\n')
  process.exit(2)
}
const REPO_ROOT = resolveRepoRoot()
const DESKTOP_PKG = process.env.CORUM_DESKTOP_PKG
  ?? (REPO_ROOT === undefined ? undefined : join(REPO_ROOT, 'packages/desktop/package.json'))
if (DESKTOP_PKG === undefined || !existsSync(DESKTOP_PKG)) {
  process.stderr.write('[ui-verify] 找不到主 checkout 的 packages/desktop/package.json；'
    + '设 CORUM_REPO=<主 checkout 根> 后重试（隔离 worktree 里没有依赖，验证一律回主 checkout 跑）。\n')
  process.exit(2)
}
const require = createRequire(DESKTOP_PKG)
const WebSocket = require('ws')

const OUT = process.env.CDP_OUT ?? '/tmp/corum-cdp/shots'

/** 读规格：支持 .json 与 .mjs（导出同构对象）。 */
async function loadSpec(path) {
  if (!path) throw new Error('缺少规格文件参数：ui-verify.mjs <spec.json|spec.mjs>')
  if (extname(path) === '.mjs' || extname(path) === '.js') {
    const mod = await import(pathToFileURL(path).href)
    return mod.default ?? mod.spec
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let seq = 0
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { res, rej })
      ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
    })
    ws.on('open', () => resolve({
      send, close: () => ws.close(),
    }))
    ws.on('message', (d) => {
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

async function getJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return r.json()
}

/**
 * 连到指定端口的 page。
 *
 * 选面（`spec.target` / `spec.pageUrlIncludes`）：
 *   - 缺省 / `'main'`：主窗口（**排除** `?floating=` 的浮窗——浮窗也是 page，
 *     「取第一个」在浮窗先建时会挑错窗口，断言就会打在错的 DOM 上）；
 *   - `'floating'`：浮窗（`?floating=<slotKey>`，用 `window.corumDesktop.openFloating(slotKey)` 打开）；
 *   - `pageUrlIncludes`：任意子串匹配（优先级最高，用于多浮窗/自定义场景）。
 */
async function attach(port, target = 'main', pageUrlIncludes) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`)
  const pages = list.filter(p => p.type === 'page')
  if (pages.length === 0) throw new Error(`no page on :${port}（应用没起或端口不对）`)
  const page = pageUrlIncludes !== undefined
    ? pages.find(p => (p.url ?? '').includes(pageUrlIncludes))
    : target === 'floating'
      ? pages.find(p => (p.url ?? '').includes('floating='))
      : pages.find(p => !(p.url ?? '').includes('floating=')) ?? pages[0]
  if (page === undefined) {
    throw new Error(`no page on :${port}（target=${target}${pageUrlIncludes === undefined ? '' : `, pageUrlIncludes=${pageUrlIncludes}`}）（应用没起、端口不对，或浮窗没打开）`)
  }
  const version = await getJson(`http://127.0.0.1:${port}/json/version`)
  const cdp = await connect(version.webSocketDebuggerUrl)
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  return { cdp, sessionId }
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId,
  )
  if (exceptionDetails) {
    throw new Error('eval failed: ' + (exceptionDetails.exception?.description ?? exceptionDetails.text))
  }
  return result.value
}

/** 把「CSS 选择器 / text:可见文字」解析成一段返回元素（或 null）的 JS。 */
function finder(target) {
  if (target.startsWith('text:')) {
    const want = JSON.stringify(target.slice(5))
    return `[...document.querySelectorAll('button,a,[role=button]')].find(e => (e.innerText||'').trim() === ${want}) ?? null`
  }
  const sel = JSON.stringify(target)
  return `document.querySelector(${sel})`
}

async function runStep(cdp, sessionId, step) {
  if (step.wait !== undefined) { await new Promise(r => setTimeout(r, step.wait)); return 'wait' }
  if (step.click !== undefined) {
    const ok = await evaluate(cdp, sessionId, `(() => { const el = ${finder(step.click)}; if (!el) return false; el.click(); return true })()`)
    if (ok !== true) throw new Error(`before.click 找不到元素：${step.click}`)
    return `click ${step.click}`
  }
  if (step.eval !== undefined) { await evaluate(cdp, sessionId, step.eval); return 'eval' }
  // 真打字（Input.insertText）——React 受控组件不吃 `el.value=`，必须走 Input 域。
  // 先按 `into`（缺省：当前聚焦元素）聚焦，再插入文本；`submit: true` 追加一次 Enter。
  if (step.type !== undefined) {
    if (step.into !== undefined) {
      const ok = await evaluate(cdp, sessionId, `(() => { const el = ${finder(step.into)}; if (!el) return false; el.focus(); return true })()`)
      if (ok !== true) throw new Error(`before.type 的 into 找不到元素：${step.into}`)
    }
    await cdp.send('Input.insertText', { text: step.type }, sessionId)
    if (step.submit === true) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }, sessionId)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, sessionId)
    }
    return `type ${step.type.length} 字${step.submit === true ? ' + Enter' : ''}`
  }
  // 单个按键（含修饰键组合），如 `{ "key": "Escape" }` / `{ "key": "Meta+a" }`。
  if (step.key !== undefined) {
    const parts = String(step.key).split('+')
    const main = parts.pop()
    const mods = { alt: parts.includes('Alt'), ctrl: parts.includes('Control'), meta: parts.includes('Meta'), shift: parts.includes('Shift') }
    const vk = main.length === 1 ? main.toUpperCase().charCodeAt(0) : (main === 'Enter' ? 13 : main === 'Escape' ? 27 : main === 'ArrowDown' ? 40 : main === 'ArrowUp' ? 38 : 0)
    const ev = { key: main, code: main.length === 1 ? `Key${main.toUpperCase()}` : main, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0) }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ev }, sessionId)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev }, sessionId)
    return `key ${step.key}`
  }
  // 视口（`{ "resize": { "width": 1100, "height": 620 } }`，`{ "resize": { "reset": true } }` 复原）：
  // 验证「内容超出上限才可滚」这类断言必须真的把视口压小，否则浮层自带 max-height
  // 吸满、永远不溢出 → 假绿。走 Emulation 域（Electron 的浏览器级 Browser.setWindowBounds
  // 在这条连接上不可用），vh 因此按模拟视口计算。
  if (step.resize !== undefined) {
    if (step.resize.reset === true) {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
      return 'resize 复原'
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: step.resize.width,
      height: step.resize.height,
      deviceScaleFactor: 0,
      mobile: false,
    }, sessionId)
    return `resize ${step.resize.width}x${step.resize.height}`
  }
  throw new Error(`未知 before 步骤：${JSON.stringify(step)}`)
}

async function runAssertion(cdp, sessionId, a) {
  const label = a.label ?? JSON.stringify({ ...a, label: undefined })
  if (a.screenshot !== undefined) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    mkdirSync(OUT, { recursive: true })
    const f = `${OUT}/${a.screenshot}.png`
    writeFileSync(f, Buffer.from(data, 'base64'))
    return { label, pass: true, detail: `截图 → ${f}` }
  }
  const sel = JSON.stringify(a.selector ?? 'body')
  if (a.exists !== undefined) {
    const n = await evaluate(cdp, sessionId, `document.querySelectorAll(${sel}).length`)
    return { label, pass: (n > 0) === a.exists, detail: `count=${n}（期望 exists=${a.exists}）` }
  }
  if (a.count !== undefined) {
    const n = await evaluate(cdp, sessionId, `document.querySelectorAll(${sel}).length`)
    return { label, pass: n === a.count, detail: `count=${n}（期望 ${a.count}）` }
  }
  if (a.textContains !== undefined || a.textEquals !== undefined) {
    const txt = await evaluate(cdp, sessionId, `(() => { const el = document.querySelector(${sel}); return el ? (el.innerText || '') : null })()`)
    if (txt === null) return { label, pass: false, detail: `选择器无匹配：${a.selector}` }
    if (a.textContains !== undefined) {
      return { label, pass: txt.includes(a.textContains), detail: a.textContains }
    }
    return { label, pass: txt.trim() === a.textEquals, detail: `实际=${JSON.stringify(txt.trim().slice(0, 80))}` }
  }
  if (a.style !== undefined) {
    const names = Object.keys(a.style)
    const got = await evaluate(cdp, sessionId, `(() => {
      const el = document.querySelector(${sel}); if (!el) return null
      const cs = getComputedStyle(el)
      const names = ${JSON.stringify(names)}
      const out = {}
      for (const n of names) out[n] = String(cs.getPropertyValue(n) || cs[n] || '').trim()
      return out
    })()`)
    if (got === null) return { label, pass: false, detail: `选择器无匹配：${a.selector}` }
    const bad = names.filter(n => String(got[n] ?? '').trim() !== String(a.style[n]).trim())
    return {
      label,
      pass: bad.length === 0,
      detail: bad.length === 0
        ? names.map(n => `${n}=${a.style[n]}`).join(' ')
        : bad.map(n => `${n}: 期望 ${a.style[n]} 实得 ${String(got[n]).trim()}`).join('; '),
    }
  }
  if (a.js !== undefined) {
    const got = await evaluate(cdp, sessionId, a.js)
    const ok = a.expect === undefined ? Boolean(got) : JSON.stringify(got) === JSON.stringify(a.expect)
    return {
      label,
      pass: ok,
      detail: `实得 ${JSON.stringify(got)}${a.expect === undefined ? '' : `（期望 ${JSON.stringify(a.expect)}）`}`,
    }
  }
  throw new Error(`未知断言：${JSON.stringify(a)}`)
}

async function main() {
  const specPath = process.argv[2]
  const spec = await loadSpec(specPath)
  const port = Number(spec.port ?? process.env.CDP_PORT ?? 9333)
  assertMainInstanceAllowed(port)
  const { cdp, sessionId } = await attach(port, spec.target ?? 'main', spec.pageUrlIncludes)
  const results = []
  try {
    for (const step of spec.before ?? []) await runStep(cdp, sessionId, step)
    for (const a of spec.assert ?? []) results.push(await runAssertion(cdp, sessionId, a))
  } finally {
    cdp.close()
  }
  const failed = results.filter(r => !r.pass)
  console.log(`\nui-verify · 端口 :${port} · 规格 ${specPath}`)
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  — ${r.detail}` : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length > 0 ? `  ❌ ${failed.length} 条失败` : '  ✅'}`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => { console.error(`ui-verify 错误：${e instanceof Error ? e.message : String(e)}`); process.exit(2) })
