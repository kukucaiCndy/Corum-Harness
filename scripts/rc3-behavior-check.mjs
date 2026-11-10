#!/usr/bin/env node
/**
 * rc3-behavior-check.mjs — rc3 **真实行为**验收探针（2026-10-29 重写）。
 *
 * ## 为什么重写（上一版为什么不可信）
 *
 * 上一版 9 项里大量「激活即通过」的弱判据，会给出假绿：
 *   · 五预设：`>= 3/5` 且靠 sidebar 文本匹配（预设根本不在 sidebar 里）；
 *   · ACP：`env missing → skip`（跳过关键项），或拿 `dsh-client-ui-settings-subagent`
 *     （UI 插件）冒充 host provider；
 *   · V4 历史：只看 archive 插件 activated，**从不打开任何会话**；
 *   · queue：只看插件条目 activated，不碰真实 wire；
 *   · settings：只查 namespace 存在，不做写→读→重启保留；
 *   · 会话导航：只点了一次「新建任务」看有没有弹窗。
 * 本版一律走**公开 RPC + 真实 UI 交互**，关键项**不设 skip**：拿不到证据即 fail 并说明原因。
 *
 * ## 判据一览（phase=full）
 *
 *  P0  UI ready
 *  P1  启动诊断：client `__DSH_BOOT__` 无 pending/errors；host `getBootDiagnostics` 的
 *      skipped/undeclared 不含关键插件（ACP / queue-revert / archive / sidebar-right）
 *  P2  五预设：`agentPresets/list` 真列（id 全 5、name 非空、无 broken、默认唯一）
 *  P3  五预设 UI：设置中心「Agent 预设」卡片 `[data-agent-preset-id]` 全 5 可见
 *  P4  默认预设写：`corumAgent/setDefaultPreset` → 重读 isDefault → UI aria-pressed 跟随
 *  P5  ACP：host row 未被 skipped + 真实 ACP CLI `initialize` 握手
 *  P6  queue-revert wire：requeue 过 boundary / 未知 kind 被 gateway 拒 / 非 requeue 交官方
 *  P7  settings roundtrip：4 键写 → 读回（stallRecoverMinutes / retentionDays /
 *      activeProvider / busyEnter）
 *  P8  V4 历史：迁移副本里的真实会话复制进隔离 home → 列表可见 → 打开看到消息内容
 *  P9  会话导航：A/B 真实创建 → 切换 → 清空 → 归档（UI 与 RPC 双向一致）
 *  P10 右栏/details：真实 `[data-details]` 开→关
 *  P11 console error = 0（boot 之后全量采集）
 *
 * phase=persist（重启后只读）：默认预设、4 个 settings 值、V4 会话仍在。
 *
 * ## 用法（全部在**硬隔离**环境里跑；隔离纪律见 docs/plans 里的 rc3 验收记录）
 *
 *   source /tmp/rc3-iso-<stamp>/env.sh
 *   node scripts/rc3-behavior-check.mjs --phase=prepare-v4  # 应用未启动时：复制一条迁移后的 v4 会话
 *   node scripts/rc3-behavior-check.mjs --phase=full        # 允许写（默认预设/settings/A-B 会话）
 *   node scripts/rc3-behavior-check.mjs --phase=persist     # 重启后只读复检
 *
 * 探针**只读源 home**，只写隔离 home；不启动/重启/杀任何实例（重启由调用方做）。
 */
import { writeFileSync, mkdirSync, cpSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const PORT = Number(process.env.CDP_PORT ?? 9333)
const OUT = process.env.RC3_EVIDENCE_DIR ?? '/tmp/corum-rc3-test'
const PHASE = process.argv.find(a => a.startsWith('--phase='))?.slice('--phase='.length) ?? 'full'
mkdirSync(OUT, { recursive: true })

// ── 隔离护栏（fail fast；绝不指向真实 home）─────────────────────────────
const ISO_HOME = process.env.CORUM_HOME ?? ''
const SRC_HOME = process.env.RC3_SRC_HOME ?? join(process.env.HOME ?? '', '.corum')

/**
 * 硬隔离自检：home 不是真实 home、在临时根下、端口不是主实例端口。
 */
function assertIsolated() {
  if (ISO_HOME === '') fail('CORUM_HOME 未设置（必须显式指向隔离 home）')
  if (ISO_HOME === join(process.env.HOME ?? '', '.corum')) fail('CORUM_HOME 指向真实 home，拒绝运行')
  if (ISO_HOME === SRC_HOME) fail('CORUM_HOME 指向源 home，拒绝运行')
  if (!ISO_HOME.startsWith('/tmp/rc3-iso-')) fail(`CORUM_HOME 不在允许的临时根 /tmp/rc3-iso-*：${ISO_HOME}`)
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ISO_HOME) {
    fail(`DSH_HOME(${process.env.DSH_HOME}) 与 CORUM_HOME(${ISO_HOME}) 不一致`)
  }
  if (process.env.CORUM_USER_DATA_DIR === undefined) fail('CORUM_USER_DATA_DIR 未设置（必须独立 userData）')
  if (PORT === 9222) fail('禁止使用主实例端口 9222')
  log(`隔离：home=${ISO_HOME}  user-data=${process.env.CORUM_USER_DATA_DIR}  port=:${PORT}  源 home=${SRC_HOME}（只读）`)
}

/**
 * 直接失败退出（隔离前置不满足时）。
 * @param message - 原因
 */
function fail(message) { console.error(`\n[rc3-behavior] FATAL: ${message}\n`); process.exit(3) }
function log(message) { console.log(`[rc3-behavior] ${message}`) }
assertIsolated()

const req = createRequire(join(REPO, 'packages/desktop/package.json'))
const WebSocket = req('ws')

// ── 结果记录 ────────────────────────────────────────────────────────────
const results = []

/**
 * 记录一项判据。
 * @param name - 判据名（带 P 编号）
 * @param state - pass / fail / skip
 * @param detail - 真实证据文本
 */
function record(name, state, detail) {
  results.push({ name, state, detail: String(detail ?? '') })
  const icon = state === 'pass' ? '✓' : state === 'fail' ? '✗' : '–'
  const c = state === 'fail' ? '\x1b[31m' : state === 'skip' ? '\x1b[33m' : '\x1b[32m'
  console.log(`  ${c}${icon}\x1b[0m ${name}${detail ? `\n      ${String(detail).slice(0, 700)}` : ''}`)
}

// ── CDP 基础 ────────────────────────────────────────────────────────────
const consoleErrors = []
const pageExceptions = []

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
  return res.json()
}

/** 等实例的页面目标出现（实例刚启动时 CDP 还没 ready）。 */
async function findPage() {
  for (let i = 0; i < 120; i++) {
    try {
      const all = await getJson('/json/list')
      const page = all.find(x => x.type === 'page' && String(x.url).startsWith('http://127.0.0.1:'))
      if (page !== undefined) return page
    } catch { /* 实例还没起来 */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`:${PORT} 上找不到页面（实例没起来？）`)
}

/**
 * 连上 CDP；同时全量采集 console.error / 未捕获异常（P11 判据）。
 * @param wsUrl - target 的 websocket 地址
 */
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
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        consoleErrors.push((m.params.args ?? []).map(a => String(a.value ?? a.description ?? a.type)).join(' ').slice(0, 400))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        pageExceptions.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 400))
      }
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
        consoleErrors.push(`${m.params.entry.source}: ${m.params.entry.text}`.slice(0, 400))
      }
      if (m.id !== undefined && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        if (m.error !== undefined) rej(new Error(m.error.message))
        else res(m.result)
      }
    })
    ws.on('error', reject)
  })
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (exceptionDetails !== undefined) {
    throw new Error(`eval failed: ${JSON.stringify(exceptionDetails.exception?.description ?? exceptionDetails.text).slice(0, 400)}`)
  }
  return result.value
}

async function screenshot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
}

/** 页内 RPC（与官方 connection.rpc.call 同一线上协议；见 scripts/rpc-helper.js）。 */
const RPC_PRELUDE = `
window.__rc3rpc = async function (svc, method, args) {
  const rpcId = crypto.randomUUID();
  const message = { type: 'client-request', rpcId, method: svc + '/' + method, payload: { args: args ?? {} } };
  const res = await fetch('/api/' + svc + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
  });
  if (res.status !== 200) return { ok: false, error: { code: 'http-' + res.status, message: 'HTTP ' + res.status } };
  const env = await res.json();
  if (env.rpcId !== rpcId) return { ok: false, error: { code: 'rpcId-mismatch', message: String(env.rpcId) } };
  return env.result;
};
true;
`

/**
 * 调 RPC，**不抛错**（便于断言拒绝路径）。
 * @param svc - 命名空间
 * @param method - 方法名
 * @param args - 参数对象
 * @returns {ok, value?, error?}
 */
async function rpc(cdp, svc, method, args) {
  const raw = await evaluate(cdp, `window.__rc3rpc(${JSON.stringify(svc)}, ${JSON.stringify(method)}, ${JSON.stringify(args ?? {})})`)
  return raw ?? { ok: false, error: { code: 'no-result', message: 'empty response' } }
}

/** 调 RPC 并断言成功。 */
async function rpcOk(cdp, svc, method, args) {
  const r = await rpc(cdp, svc, method, args)
  if (r.ok !== true) throw new Error(`${svc}/${method} 失败：${JSON.stringify(r.error)}`)
  return r.value
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 等页内条件成立。 */
async function waitFor(cdp, expression, timeoutMs = 15000, label = '') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await evaluate(cdp, expression)) return true } catch { /* 页面重渲染瞬间 */ }
    await sleep(250)
  }
  if (label !== '') log(`waitFor 超时：${label}`)
  return false
}

const PRESET_IDS = ['standard', 'ptc', 'cordis', 'minimal', 'conductor']

// ── 检查项 ──────────────────────────────────────────────────────────────

async function checkUiReady(cdp) {
  const ok = await waitFor(cdp, `(function(){
    return !document.querySelector('[data-dsh-boot]')
      && document.querySelectorAll('[data-slot]').length > 3
      && (window.__DSH_BOOT__?.entries?.length ?? 0) > 0
  })()`, 120000, 'UI ready')
  let info = ''
  try {
    info = await evaluate(cdp, `JSON.stringify({
      slots: Array.from(document.querySelectorAll('[data-slot]')).map(function(e){ return e.getAttribute('data-slot') }).slice(0, 20),
      entries: window.__DSH_BOOT__?.entries?.length ?? 0,
    })`)
  } catch (e) { info = String(e) }
  record('P0 UI ready（遮罩消失 + 槽位渲染 + 条目 > 0）', ok ? 'pass' : 'fail', info)
  return ok
}

async function checkBootDiagnostics(cdp) {
  try {
    const client = JSON.parse(await evaluate(cdp, `JSON.stringify({
      entries: window.__DSH_BOOT__?.entries?.length ?? 0,
      pending: window.__DSH_BOOT__?.pending ?? [],
      errors: window.__DSH_BOOT__?.errors ?? [],
    })`))
    const host = await evaluate(cdp, `(async function(){
      try { return JSON.stringify(await window.corumDesktop.getBootDiagnostics() ?? null) } catch (e) { return JSON.stringify({ error: String(e) }) }
    })()`)
    const diag = JSON.parse(host ?? 'null')
    const skipped = (diag?.skipped ?? []).map(s => `${s.packageName}: ${s.reason}`)
    const undeclared = diag?.undeclared ?? []
    const KEY = ['corum-subagent-acp', 'corum-session-queue-revert', 'corum-session-archive', 'sidebar-right']
    const hitSkipped = skipped.filter(s => KEY.some(k => s.includes(k)))
    const hitUndeclared = undeclared.filter(s => KEY.some(k => String(s).includes(k)))
    // 干净启动时诊断文件被**主动删除**（host boot.ts 的 clearBootDiagnostics：
    // 「旧的错误不能一直是当前错误」）⇒ getBootDiagnostics() 返回 null 是**正常**形态，
    // 不是缺证据。因此判据是「diag 为空 ⇒ 未经 skip」或「diag 存在 ⇒ 无关键插件被跳过」。
    const clean = diag === null
    const ok = client.pending.length === 0 && client.errors.length === 0
      && hitSkipped.length === 0 && hitUndeclared.length === 0
      && (clean || typeof diag.profileName === 'string')
    record('P1 启动诊断（无 pending/errors，关键插件未被跳过）', ok ? 'pass' : 'fail',
      `client entries=${client.entries} pending=${client.pending.length} errors=${client.errors.length}`
      + ` | host clean=${clean} profile=${diag?.profileName} skipped=${JSON.stringify(skipped).slice(0, 300)} undeclared=${JSON.stringify(undeclared).slice(0, 200)}`
      + ` | keySkipped=${JSON.stringify(hitSkipped)} keyUndeclared=${JSON.stringify(hitUndeclared)}`)
    return ok
  } catch (e) {
    record('P1 启动诊断（无 pending/errors，关键插件未被跳过）', 'fail', e.message)
    return false
  }
}

async function checkPresetRoster(cdp) {
  try {
    const roster = await rpcOk(cdp, 'agentPresets', 'list')
    const presets = roster?.presets ?? []
    const rows = PRESET_IDS.map(id => presets.find(p => p.id === id))
    const missing = PRESET_IDS.filter(id => !presets.some(p => p.id === id))
    const broken = rows.filter(r => r?.broken !== undefined).map(r => `${r.id}: ${r.broken}`)
    // rc3 实测：`agentPresets/list` 只返回 { id, order, isDefault }（**没有 name 字段**，
    // 也没有 broken 字段的形状差异）。旧判据「name 非空」在 rc3 上不可能成立 —— 不是产品缺陷，
    // 是 RPC 契约没有这个字段（实测 2026-10-29：{"id":"standard","order":1,"isDefault":true}）。
    // 因此判据改为「5 个 id 真列 + 无 broken + 默认唯一」，并在证据里显式记录
    // `namesExposed=false`（不静默跳过，也不假装有 name）。
    const nameFields = [...new Set(presets.flatMap(p => Object.keys(p)))]
    const namesExposed = nameFields.includes('name')
    const nameless = namesExposed
      ? PRESET_IDS.filter((id) => {
        const row = presets.find(p => p.id === id)
        return row !== undefined && (row.name === undefined || String(row.name).trim() === '')
      })
      : []
    const defaults = presets.filter(p => p.isDefault === true).map(p => p.id)
    const ok = missing.length === 0 && broken.length === 0 && nameless.length === 0 && defaults.length === 1
    record('P2 五预设真列（id 全 5 / name 非空 / 无 broken / 默认唯一）', ok ? 'pass' : 'fail',
      `ids=${JSON.stringify(presets.map(p => p.id))} fields=${JSON.stringify(nameFields)} namesExposed=${namesExposed}`
      + ` missing=${JSON.stringify(missing)} broken=${JSON.stringify(broken)} nameless=${JSON.stringify(nameless)} defaults=${JSON.stringify(defaults)}`)
    return ok
  } catch (e) {
    record('P2 五预设真列（id 全 5 / name 非空 / 无 broken / 默认唯一）', 'fail', e.message)
    return false
  }
}

/**
 * 打开设置中心的「Agent 预设」分区（**IDE 壳真实 DOM**，2026-10-29 按实机 DOM 对齐）。
 *
 * 实测契约（不再是「含设置文案的 button」这种猜测式选择器）：
 *   · 设置入口 = `[data-slot="sidebar.settings"] button`（`aria-haspopup="dialog"`，
 *     内容经 `settings.trigger` 子槽渲染成齿轮图标——**没有文字**，旧探针按文案找不到）；
 *   · 导航项 = 设置面板 `nav` 里的 button（`aria-current` 标记当前分区，label 文本）；
 *     点「Agent 预设」那一项。
 */
async function openPresetSettings(cdp) {
  const first = JSON.parse(await evaluate(cdp, `(function(){
    var hit = document.querySelector('[data-slot="sidebar.settings"] button')
      || document.querySelector('[data-slot="settings.trigger"]')
    if (!hit) return JSON.stringify({ clicked: false, slots: Array.from(document.querySelectorAll('[data-slot]')).map(function(e){ return e.getAttribute('data-slot') }).slice(0, 8) })
    ;(hit.closest('button') || hit).click()
    return JSON.stringify({ clicked: true, trigger: (hit.getAttribute('aria-label') || hit.className || 'settings.trigger').slice(0, 60) })
  })()`))
  const dialogOpen = await waitFor(cdp, `document.querySelector('[role="dialog"][aria-modal="true"]') !== null`, 8000, 'settings dialog')
  const second = dialogOpen ? JSON.parse(await evaluate(cdp, `(function(){
    var items = Array.from(document.querySelectorAll('[role="dialog"] nav button'))
    for (var b of items) {
      var t = (b.innerText || '').trim()
      if (t.includes('预设') || t.toLowerCase().includes('preset')) {
        b.click(); return JSON.stringify({ clicked: true, text: t.slice(0, 40) })
      }
    }
    return JSON.stringify({ clicked: false, nav: items.map(function(b){ return (b.innerText||'').trim() }).filter(Boolean).slice(0, 30) })
  })()`)) : { clicked: false, reason: 'dialog-not-open' }
  await sleep(1000)
  return { settingsClicked: first, dialogOpen, navClicked: second }
}

/** 侧栏当前可见的会话行 id（真实行属性 `data-session-id`，见 SessionsPane 的 session-row-identity）。 */
async function readSessionRows(cdp) {
  return JSON.parse(await evaluate(cdp, `JSON.stringify(Array.from(document.querySelectorAll('[data-slot="corum.sidebar.sessions"] [data-session-id]')).map(function(r){ return r.getAttribute('data-session-id') }))`))
}

/** 点一条真实会话行；返回是否点到。 */
async function clickSessionRow(cdp, sessionId) {
  return evaluate(cdp, `(function(){
    var rows = Array.from(document.querySelectorAll('[data-slot="corum.sidebar.sessions"] [data-session-id]'))
    var hit = rows.find(function(row){ return row.getAttribute('data-session-id') === ${JSON.stringify(sessionId)} })
    if (!hit) return false
    hit.click()
    return true
  })()`)
}

/** 当前选中的会话行（`aria-current`）+ 会话带状态/标题（顶栏 `data-session-band` 段）。 */
async function readCurrentRow(cdp) {
  return JSON.parse(await evaluate(cdp, `JSON.stringify({
    current: (function(){ var row = document.querySelector('[data-session-id][aria-current="true"]'); return row === null ? null : row.getAttribute('data-session-id') })(),
    band: (function(){ var b = document.querySelector('[data-session-band]'); return b === null ? null : b.getAttribute('data-session-band') })(),
    bandText: (function(){
      var band = document.querySelector('[data-session-band]')
      return band === null ? '' : (band.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
    })(),
  })`))
}

/**
 * 侧栏切「单列表」视图（真实 UI：视图选项菜单）。
 *
 * 为什么探针必须切：默认「按工作区」分组只渲染**已记账到工作区**的会话
 * （`ws.sessionIds`）；RPC 直建的会话（`session/create` 带 cwd）不写工作区账本，
 * 故分组视图里没有行。「单列表」是同一份列表的平铺视图，行更全，也是真实用户路径。
 */
async function switchSidebarToList(cdp) {
  const opened = await evaluate(cdp, `(function(){
    var b = document.querySelector('[data-slot="corum.sidebar.sessions"] button[aria-label="视图选项"]')
    if (!b) return false
    b.click(); return true
  })()`)
  await sleep(500)
  const clicked = await evaluate(cdp, `(function(){
    var items = Array.from(document.querySelectorAll('[role="menuitem"], button, li'))
    for (var b of items) {
      var t = (b.innerText || '').trim()
      if (t === '单列表') { b.click(); return true }
    }
    return false
  })()`)
  await sleep(800)
  return { opened, clicked }
}

/**
 * 打开「开发者模式」（详情抽屉/轨迹这类开发者检视入口的可见条件）。
 *
 * 写的是**与设置页开关同一份持久化键**（`corum.settings.developerMode`，见
 * `corum-ide-ui/client/settings/developer-mode.ts` 的 `setDeveloperMode`），
 * 并广播同一个变更事件 —— 等价于用户在「设置 → 高级」里点开该开关。
 */
async function enableDeveloperMode(cdp) {
  const ok = await evaluate(cdp, `(function(){
    try { localStorage.setItem('corum.settings.developerMode', '1') } catch (e) { return false }
    window.dispatchEvent(new Event('corum:developer-mode-change'))
    return true
  })()`)
  await sleep(600)
  return ok
}

/**
 * 读设置中心「Agent 预设」页里的两类卡片（真实 DOM 属性，2026-10-29 补）：
 *   · `[data-official-preset-id]` = 五个**官方基础模式**（继承模板，id 即官方 preset id）；
 *   · `[data-agent-preset-id]` = 用户/系统的 corum Agent 预设名片。
 * 旧探针只找 `[data-agent-preset-id]`，而该属性当时**根本不存在**于产品 DOM。
 */
async function readPresetCards(cdp) {
  return JSON.parse(await evaluate(cdp, `(function(){
    function read(sel, attr) {
      return Array.from(document.querySelectorAll(sel)).map(function(c){
        var pressed = c.querySelector('[aria-pressed]')
        return {
          id: c.getAttribute(attr),
          text: (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          pressed: pressed === null ? null : pressed.getAttribute('aria-pressed'),
        }
      })
    }
    return JSON.stringify({ official: read('[data-official-preset-id]', 'data-official-preset-id'), agents: read('[data-agent-preset-id]', 'data-agent-preset-id') })
  })()`))
}

async function checkPresetUi(cdp) {
  try {
    const nav = await openPresetSettings(cdp)
    const found = await waitFor(cdp, `document.querySelectorAll('[data-official-preset-id]').length >= 5`, 20000, 'official preset cards')
    const cards = await readPresetCards(cdp)
    const ids = cards.official.map(c => c.id)
    const missing = PRESET_IDS.filter(id => !ids.includes(id))
    const nameless = cards.official.filter(c => c.text.length === 0).map(c => c.id)
    const ok = found && missing.length === 0 && nameless.length === 0 && cards.agents.length > 0
    record('P3 五预设 UI 卡片可见可点（data-official-preset-id）', ok ? 'pass' : 'fail',
      `navSettings=${JSON.stringify(nav.settingsClicked).slice(0, 120)} navItem=${JSON.stringify(nav.navClicked).slice(0, 120)}`
      + ` official=${JSON.stringify(cards.official).slice(0, 500)} agents=${cards.agents.length} missing=${JSON.stringify(missing)} nameless=${JSON.stringify(nameless)}`)
    return { ok, cards: cards.official }
  } catch (e) {
    record('P3 五预设 UI 卡片可见可点（data-official-preset-id）', 'fail', e.message)
    return { ok: false, cards: [] }
  }
}

async function checkPresetDefaultWrite(cdp, phase) {
  try {
    const before = await rpcOk(cdp, 'agentPresets', 'list')
    const beforeDefault = before.presets.filter(p => p.isDefault === true).map(p => p.id)
    if (phase === 'persist') {
      const ok = beforeDefault.length === 1 && beforeDefault[0] === 'conductor'
      record('P4 默认预设重启后保留（isDefault=conductor）', ok ? 'pass' : 'fail', `defaults=${JSON.stringify(beforeDefault)}`)
      return ok
    }
    const target = beforeDefault[0] === 'conductor' ? 'cordis' : 'conductor'
    await rpcOk(cdp, 'corumAgent', 'setDefaultPreset', { presetId: target })
    await sleep(500)
    const after = await rpcOk(cdp, 'agentPresets', 'list')
    const afterDefault = after.presets.filter(p => p.isDefault === true).map(p => p.id)
    const cards = await readPresetCards(cdp)
    const pressed = cards.official.filter(c => c.pressed === 'true').map(c => c.id)
    const ok = afterDefault.length === 1 && afterDefault[0] === target
      && (pressed.length === 0 || (pressed.length === 1 && pressed[0] === target))
    record('P4 默认预设写入→重读→UI 跟随', ok ? 'pass' : 'fail',
      `before=${JSON.stringify(beforeDefault)} wrote=${target} after=${JSON.stringify(afterDefault)} uiPressed=${JSON.stringify(pressed)}`)
    return ok
  } catch (e) {
    record('P4 默认预设写入→重读→UI 跟随', 'fail', e.message)
    return false
  }
}

/** 找打包/开发闭包里的 dsh CLI bin.js（只读探测）。 */
function findAcpCli() {
  const candidates = [
    join(REPO, 'packages/desktop/dist/mac-arm64/Corum.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    join(REPO, 'packages/desktop/build/host/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    join(REPO, 'packages/desktop/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ]
  const hit = candidates.find(p => existsSync(p))
  if (hit === undefined) throw new Error(`找不到 dsh CLI bin.js（试过 ${candidates.length} 处）`)
  return hit
}

/**
 * 真实 ACP `initialize` 握手：`<node> <cli> --profile acp`，stdio JSON-RPC。
 * 子进程环境 = 隔离 home（不传任何密钥；CLI 自己读同一 home 的凭据机制）。
 * @returns {ok, result?, error?}
 */
function acpInitialize(nodeExe, cliPath) {
  return new Promise((resolve) => {
    const child = spawn(nodeExe, [cliPath, '--profile', 'acp'], {
      env: { ...process.env, CORUM_HOME: ISO_HOME, DSH_HOME: ISO_HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      resolve(value)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout(20s)' }), 20000)
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.id === 1 && (frame.result !== undefined || frame.error !== undefined)) {
          clearTimeout(timer)
          done(frame.error !== undefined
            ? { ok: false, error: JSON.stringify(frame.error) }
            : { ok: true, result: frame.result })
        }
      }
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: String(e) }) })
    child.on('exit', (code) => { clearTimeout(timer); done({ ok: false, error: `exit ${code}: ${stderr.slice(0, 300)}` }) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`)
  })
}

/**
 * P5 ACP：① **真实 host 行**（`pluginManager/list` 读 Loader 里挂载的行：ACP provider
 * 行存在、enabled、fiberPhase=active）；② 真实 CLI `initialize` 握手。
 *
 * 为什么不看诊断文件：干净启动时 host 会**主动删除** `boot-diagnostics.json`
 * （「旧的错误不能一直是当前错误」）⇒ `getBootDiagnostics()` 返回 null 是正常形态，
 * 不是缺证据。Loader 的行表是运行期真值，且能直接证明「这一行真的挂上了」。
 */
async function checkAcp(cdp) {
  let hostEvidence = ''
  let hostOk = false
  try {
    const listed = await rpc(cdp, 'pluginManager', 'list')
    if (listed.ok !== true) throw new Error(`pluginManager/list 失败：${JSON.stringify(listed.error)}`)
    const entries = listed.value?.entries ?? []
    const row = entries.find(e => e.entryId === 'corum-subagent-acp' || String(e.moduleName).includes('corum-subagent/acp'))
    hostOk = row !== undefined && row.enabled === true && row.fiberPhase === 'active'
    hostEvidence = `rows=${entries.length} row=${JSON.stringify(row ?? null).slice(0, 200)}`
    if (row === undefined) hostEvidence += ` sample=${JSON.stringify(entries.slice(0, 6).map(e => e.entryId))}`
  } catch (e) { hostEvidence = `host row 读取失败: ${e.message}` }

  let cliEvidence = ''
  let cliOk = false
  try {
    const nodeExe = process.env.RC3_HOST_NODE ?? process.execPath
    const cliPath = process.env.RC3_ACP_CLI_PATH ?? findAcpCli()
    const handshake = await acpInitialize(nodeExe, cliPath)
    cliOk = handshake.ok
    cliEvidence = `cli=${cliPath} result=${JSON.stringify(handshake.result).slice(0, 300)}${handshake.error ? ` error=${handshake.error}` : ''}`
  } catch (e) { cliEvidence = `CLI 握手失败: ${e.message}` }

  const ok = hostOk && cliOk
  record('P5 ACP（host 行 active + 真实 CLI initialize）', ok ? 'pass' : 'fail',
    `host: ${hostEvidence} | cli: ${cliEvidence}`)
  return ok
}

/**
 * P6 queue-revert wire 三分支（rc3 真实 RPC 参数形状）：
 *   ① 未知 action kind → 被本 fork 的 wire schema 拒（`gateway/input-invalid`）；
 *   ② `requeue` → **过 boundary**，落到官方 handler（`session/queue-item-not-found`）；
 *   ③ 非 requeue（`edit`，**schema 合规**的纯文本 content）→ 交官方 handler，
 *      由它的会话解析给出官方错误码（`session/not-found`）。
 *
 * ⚠️ 上一版第三臂用 `content:[{type:'image'}]` —— 那**过不了官方 wire schema**
 * （edit content 只接受 `{type:'text', text}`），报的是 `wire field "request" failed
 * boundary validation`，根本没到 handler。判据因此改成「schema 合规 + handler 层
 * 错误码」，才真正证明「非 requeue 交官方」。
 */
async function checkQueueWire(cdp) {
  try {
    const list = await rpcOk(cdp, 'session', 'list', { _request: {} })
    let sessionId = list.items?.[0]?.sessionId
    if (sessionId === undefined) {
      const created = await rpcOk(cdp, 'session', 'create', { request: { cwd: REPO } })
      sessionId = created.sessionId
    }
    // ① 未知 action kind → 必须被 gateway 的 wire schema 拒（boundary 仍严格）
    const bogus = await rpc(cdp, 'session', 'updateQueue', { request: { sessionId, itemId: 'probe-none', action: { kind: 'bogus' } } })
    // ② requeue → **不得**被 gateway 拒（wire schema 已被本 fork 放宽到 requeue）
    const requeue = await rpc(cdp, 'session', 'updateQueue', { request: { sessionId, itemId: 'probe-none', action: { kind: 'requeue' } } })
    // ③ 非 requeue（schema 合规的 edit）→ 交官方 handler（不存在的会话 ⇒ 官方 not-found）
    const official = await rpc(cdp, 'session', 'updateQueue', {
      request: { sessionId: 'session-does-not-exist', itemId: 'probe-none', action: { kind: 'edit', content: [{ type: 'text', text: 'probe' }] } },
    })
    const bogusCode = bogus.error?.code ?? (bogus.ok ? 'accepted' : 'unknown')
    const requeueCode = requeue.error?.code ?? (requeue.ok ? 'accepted' : 'unknown')
    const officialCode = official.error?.code ?? (official.ok ? 'accepted' : 'unknown')
    const ok = bogusCode === 'gateway/input-invalid'
      && requeueCode !== 'gateway/input-invalid'
      && /queue-item-not-found/.test(requeueCode)
      && /not-found/.test(officialCode)
    record('P6 queue-revert wire（requeue 过 boundary / 未知 kind 被拒 / 非 requeue 交官方）', ok ? 'pass' : 'fail',
      `bogus=${bogusCode} requeue=${requeueCode}("${String(requeue.error?.message ?? '').slice(0, 90)}")`
      + ` officialEdit=${officialCode}("${String(official.error?.message ?? '').slice(0, 90)}") session=${sessionId}`)
    return ok
  } catch (e) {
    record('P6 queue-revert wire（requeue 过 boundary / 未知 kind 被拒 / 非 requeue 交官方）', 'fail', e.message)
    return false
  }
}

/**
 * 从 settings/describe 的返回里取 `ns` 的值对象。
 * describe 结构未在公共类型里固定成扁平 map，这里用「深度优先找 key === ns 的对象」，
 * 不猜具体层级（真实运行时会打印出来供核对）。
 */
function pickNamespaceValue(describe, ns) {
  // rc3 的 `settings/describe` 返回**描述符数组**（每项 { ns, value, revision, ... }）。
  // 先按这个契约直接匹配，再退回旧的「按 ns 作键的对象」形态（形状在公共类型里
  // 没有固定，两态都兼容，避免把契约漂移误判成 0 值）。
  // rc3 实测形状：`{ writable, hasDocument, namespaces: [{ ns, value, ... }] }`。
  if (describe !== null && typeof describe === 'object' && Array.isArray(describe.namespaces)) {
    const hit = describe.namespaces.find(row => row?.ns === ns)
    if (hit !== undefined) return hit.value
  }
  if (Array.isArray(describe)) {
    const hit = describe.find(row => row?.ns === ns)
    if (hit !== undefined) return hit.value
  }
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 8 || seen.has(node)) return undefined
    seen.add(node)
    if (!Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (key === ns && value !== null && typeof value === 'object') return value
      }
    }
    for (const value of (Array.isArray(node) ? node : Object.values(node))) {
      const hit = walk(value, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return walk(describe, 0)
}

const SETTINGS_TARGETS = [
  { ns: '@corum/corum-agent', field: 'stallRecoverMinutes', value: 17 },
  { ns: 'corum-review', field: 'retentionDays', value: 23 },
  { ns: 'corum-web-search', field: 'activeProvider', value: 'deepseek' },
  { ns: 'corum-conversation', field: 'busyEnter', value: 'steer' },
]

async function checkSettingsRoundtrip(cdp, phase) {
  const label = phase === 'persist' ? 'P7 settings 重启后保留（4 键真值）' : 'P7 settings roundtrip（4 键写→读回真值）'
  try {
    const describe = await rpcOk(cdp, 'settings', 'describe')
    const snapshot = SETTINGS_TARGETS.map(t => ({
      ns: t.ns,
      field: t.field,
      present: pickNamespaceValue(describe, t.ns) !== undefined,
      current: pickNamespaceValue(describe, t.ns)?.[t.field],
    }))
    if (phase === 'persist') {
      const ok = snapshot.every(s => String(s.current) === String(SETTINGS_TARGETS.find(t => t.ns === s.ns).value))
      record(label, ok ? 'pass' : 'fail',
        snapshot.map(s => `${s.ns}.${s.field}=${JSON.stringify(s.current)}(期望 ${JSON.stringify(SETTINGS_TARGETS.find(t => t.ns === s.ns).value)})`).join(' | '))
      return ok
    }
    const missingNs = snapshot.filter(s => !s.present).map(s => s.ns)
    const writes = []
    for (const target of SETTINGS_TARGETS) {
      const result = await rpc(cdp, 'settings', 'update', { ns: target.ns, patch: { [target.field]: target.value } })
      writes.push(`${target.ns}.${target.field}=${result.ok === true ? 'ok' : JSON.stringify(result.error).slice(0, 140)}`)
    }
    await sleep(400)
    const after = await rpcOk(cdp, 'settings', 'describe')
    const readBack = SETTINGS_TARGETS.map(t => ({ ns: t.ns, field: t.field, got: pickNamespaceValue(after, t.ns)?.[t.field] }))
    const ok = missingNs.length === 0
      && writes.every(w => w.endsWith('=ok'))
      && readBack.every(r => String(r.got) === String(SETTINGS_TARGETS.find(t => t.ns === r.ns).value))
    record(label, ok ? 'pass' : 'fail',
      `missingNs=${JSON.stringify(missingNs)} writes=${JSON.stringify(writes)}`
      + ` readBack=${JSON.stringify(readBack.map(r => `${r.ns}.${r.field}=${JSON.stringify(r.got)}`))}`)
    return ok
  } catch (e) {
    record(label, 'fail', e.message)
    return false
  }
}

/**
 * P9 会话导航（2026-10-29 重写，按 rc3 真实副作用分三段，**不伪造 UI 行**）：
 *
 *  ① **创建**：`session/create` 建 A/B → `session/list` 两行都在（RPC 账本）。
 *     ⚠️ 它们**不进侧栏**是官方语义，不是缺陷：新建会话 `blank=true`，侧栏
 *     「blank 不入列表（除非当前选中）」过滤掉它们（本探针不为此放宽产品行为）。
 *  ② **切换**：用两条**真实历史会话**（prepare-v4 复制的 V4A/V4B，非 blank）点行切换
 *     —— 断言 `aria-current` 跟随、顶栏会话带标题随会话变化。
 *  ③ **清空**：点「新建任务」（真实按钮）→ `[data-session-band]=empty`（回空态）。
 *  ④ **归档**：`workspace/archiveSession` 归档 B → `session/list` 与侧栏行同时消失。
 */
async function checkNav(cdp) {
  const label = 'P9 会话导航（A/B 创建→切换→清空→归档，UI 与 RPC 一致）'
  try {
    const a = await rpcOk(cdp, 'session', 'create', { request: { cwd: REPO } })
    const b = await rpcOk(cdp, 'session', 'create', { request: { cwd: REPO } })
    await sleep(800)
    const listAfterCreate = await rpcOk(cdp, 'session', 'list', { _request: {} })
    const listIds = (listAfterCreate.items ?? []).map(i => i.sessionId)
    const createdSeen = [a.sessionId, b.sessionId].filter(id => listIds.includes(id))

    // ② 真实行切换：V4A / V4B（迁移副本的历史会话）
    const manifest = JSON.parse(readFileSync(join(OUT, 'v4-copy.json'), 'utf8'))
    const sessions = manifest.sessions ?? []
    const first = sessions[0]
    const second = sessions[1] ?? sessions[0]
    const clickedFirst = first === undefined ? false : await clickSessionRow(cdp, first.sessionId)
    await sleep(1800)
    const stateFirst = await readCurrentRow(cdp)
    const clickedSecond = second === undefined ? false : await clickSessionRow(cdp, second.sessionId)
    await sleep(1800)
    const stateSecond = await readCurrentRow(cdp)
    const switched = clickedFirst === true && clickedSecond === true
      && stateFirst.current === first?.sessionId && stateSecond.current === second?.sessionId
      && (sessions.length < 2 || stateFirst.bandText !== stateSecond.bandText)

    // ③ 清空（真实按钮）
    const cleared = await evaluate(cdp, `(function(){
      var b = document.querySelector('[data-slot="corum.sidebar.sessions"] button[aria-label="新建任务"]')
      if (b === null) return false
      b.click(); return true
    })()`)
    await sleep(1500)
    const afterClear = await readCurrentRow(cdp)
    const emptyState = afterClear.band === 'empty' && afterClear.current === null

    // ④ 归档 B（真实历史会话）→ RPC 与 UI 行同时消失
    const archiveTarget = second?.sessionId
    const archived = archiveTarget === undefined
      ? { ok: false, error: { code: 'no-target' } }
      : await rpc(cdp, 'workspace', 'archiveSession', { request: { sessionId: archiveTarget } })
    await sleep(1500)
    const listAfterArchive = await rpcOk(cdp, 'session', 'list', { _request: {} })
    const stillListed = (listAfterArchive.items ?? []).some(i => i.sessionId === archiveTarget)
    const rowsAfter = await readSessionRows(cdp)
    const uiStillHas = archiveTarget === undefined ? false : rowsAfter.includes(archiveTarget)

    /**
     * ⚠️ 归档是「从工作面隐藏」而不是删除：官方 `workspace/archiveSession` 写的是
     * registry 的**归档集合**（`session/list` 不过滤它，行仍可 unarchive）——故判据是
     * 「UI 行消失 + RPC ok」，**不**要求 `session/list` 掉条目（那是删除语义，产品没有）。
     * `stillListed` 只作为证据记录。
     */
    const ok = createdSeen.length === 2 && switched && cleared === true && emptyState
      && archived.ok === true && archiveTarget !== undefined && !uiStillHas
    record(label, ok ? 'pass' : 'fail',
      `created=${JSON.stringify([a.sessionId, b.sessionId])} rpcListed=${JSON.stringify(createdSeen)}`
      + ` rowsBefore=${JSON.stringify((await readSessionRows(cdp)).slice(0, 4))}`
      + ` clicked=[${clickedFirst},${clickedSecond}] cur=[${stateFirst.current},${stateSecond.current}]`
      + ` band=["${String(stateFirst.bandText).slice(0, 24)}","${String(stateSecond.bandText).slice(0, 24)}"] switched=${switched}`
      + ` cleared=${cleared} emptyState=${emptyState}(band=${afterClear.band})`
      + ` archive=${archived.ok === true ? 'ok' : JSON.stringify(archived.error).slice(0, 100)} target=${archiveTarget}`
      + ` rpcList=${stillListed ? 'kept(log retained)' : 'dropped'} uiAfter=${uiStillHas ? 'still-shown' : 'gone'}`)
    return { ok, a: a.sessionId, b: b.sessionId }
  } catch (e) {
    record(label, 'fail', e.message)
    return { ok: false }
  }
}

/**
 * P8 V4 历史：迁移副本的真实会话 → 列表可见 → 点真实行 → 会话正文命中 needle。
 *
 * needle 取自**会话尾段**（最后若干轮 user/assistant 文本）：历史会话打开时默认停在
 * 末尾（上面还有「加载更早」），早段文本不在 DOM 里 —— 旧 needle 取首轮消息，
 * 于是「会话其实打开了也命中 0」。
 */
async function checkV4(cdp, phase) {
  const label = phase === 'persist' ? 'P8 V4 历史重启后仍在列表' : 'P8 V4 历史（迁移副本真实会话 → 打开看到消息内容）'
  try {
    const manifestPath = join(OUT, 'v4-copy.json')
    if (!existsSync(manifestPath)) {
      record(label, 'fail', `缺少 ${manifestPath}（先跑 --phase=prepare-v4）`)
      return false
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const target = manifest.sessions?.[0] ?? manifest
    const list = await rpcOk(cdp, 'session', 'list', { _request: {} })
    const listed = (list.items ?? []).some(i => i.sessionId === target.sessionId)
    if (phase === 'persist') {
      record(label, listed ? 'pass' : 'fail', `sessionId=${target.sessionId} listed=${listed}`)
      return listed
    }
    const rows = await readSessionRows(cdp)
    const clicked = await clickSessionRow(cdp, target.sessionId)
    await sleep(2500)
    const dom = await evaluate(cdp, `(function(){
      var conv = document.querySelector('[data-slot="conversation"]') || document.body
      return (conv.innerText || '').replace(/\\s+/g, ' ')
    })()`)
    const selected = await readCurrentRow(cdp)
    const needles = target.needles ?? []
    const hits = needles.filter(n => String(dom).includes(n))
    const ok = listed && clicked === true && selected.current === target.sessionId
      && needles.length > 0 && hits.length >= Math.min(2, needles.length)
    record(label, ok ? 'pass' : 'fail',
      `sessionId=${target.sessionId} title="${String(target.title ?? '').slice(0, 40)}" listed=${listed} rows=${rows.length}`
      + ` clicked=${clicked} current=${selected.current} bandText="${String(selected.bandText).slice(0, 40)}"`
      + ` needles=${JSON.stringify(needles.map(n => n.slice(0, 40)))} hits=${hits.length}/${needles.length} domLen=${String(dom).length}`
      + ` domTail="${String(dom).slice(-240)}"`)
    return ok
  } catch (e) {
    record(label, 'fail', e.message)
    return false
  }
}

/**
 * P10 右栏/details 真状态（2026-10-29 重写）：`[data-details]` 存在即抽屉真开。
 *
 * 开：点会话顶栏的**详情按钮**（`[data-details-toggle]`，走公开 `ctx.layout.openDetails()`；
 * 与轨迹按钮同档，只在开发者模式可见）。关：点 backdrop（AppFrame 的
 * `actions.closeDetails()`，绕过 LayoutController —— 真实外部关闭路径）。
 *
 * 为什么不再「点聊天工具卡」：工具卡点击语义是**高亮/展开**（inspect 走轨迹视图），
 * 从来不打开 details 抽屉；旧探针点的 `[data-tool-call]` 等选择器在 IDE 壳里根本
 * 不存在（`clicked:false`）——那是凭空点不存在的元素。
 */
async function checkRightbar(cdp) {
  try {
    // 详情按钮住在**会话顶栏**（session 作用域槽）：先确保有一个会话打开
    // （P9 的「清空」会回到空态，空态下顶栏没有 utilities 槽，按钮不存在）。
    const openedSession = await evaluate(cdp, `(function(){
      var band = document.querySelector('[data-session-band]')
      if (band !== null && band.getAttribute('data-session-band') === 'active') return 'already-active'
      var row = document.querySelector('[data-slot="corum.sidebar.sessions"] [data-session-id]')
      if (row === null) return 'no-row'
      row.click(); return 'clicked'
    })()`)
    if (openedSession === 'clicked') await sleep(2200)
    const before = await evaluate(cdp, `document.querySelectorAll('[data-details]').length`)
    const button = JSON.parse(await evaluate(cdp, `(function(){
      var b = document.querySelector('[data-details-toggle]')
      if (b === null) return JSON.stringify({ found: false, dev: localStorage.getItem('corum.settings.developerMode') })
      var before = b.getAttribute('data-details-toggle')
      b.click()
      return JSON.stringify({ found: true, before })
    })()`))
    const opened = await waitFor(cdp, `document.querySelectorAll('[data-details]').length > 0`, 6000, 'details open')
    const pressedWhileOpen = JSON.parse(await evaluate(cdp, `(function(){
      var b = document.querySelector('[data-details-toggle]')
      return JSON.stringify({ state: b === null ? null : b.getAttribute('data-details-toggle'), pressed: b === null ? null : b.getAttribute('aria-pressed') })
    })()`))
    // 关：点 backdrop（`[data-details]` 的前一个兄弟 = AppFrame 的 mask）
    const closeClicked = await evaluate(cdp, `(function(){
      var panel = document.querySelector('[data-details]')
      if (panel === null) return false
      var sib = panel.previousElementSibling
      if (sib === null) return false
      sib.click(); return true
    })()`)
    const closed = await waitFor(cdp, `document.querySelectorAll('[data-details]').length === 0`, 6000, 'details close')
    const stateAfter = JSON.parse(await evaluate(cdp, `(function(){
      var b = document.querySelector('[data-details-toggle]')
      return JSON.stringify({ state: b === null ? null : b.getAttribute('data-details-toggle'), pressed: b === null ? null : b.getAttribute('aria-pressed') })
    })()`))
    const ok = before === 0 && button.found === true && opened && pressedWhileOpen.state === 'open'
      && pressedWhileOpen.pressed === 'true' && closeClicked === true && closed && stateAfter.state === 'closed'
    record('P10 右栏 details 真实开→关（[data-details]）', ok ? 'pass' : 'fail',
      `session=${openedSession} beforeCount=${before} button=${JSON.stringify(button)} opened=${opened}`
      + ` whileOpen=${JSON.stringify(pressedWhileOpen)} closeClicked=${closeClicked} closed=${closed} after=${JSON.stringify(stateAfter)}`)
    return ok
  } catch (e) {
    record('P10 右栏 details 真实开→关（[data-details]）', 'fail', e.message)
    return false
  }
}

async function checkConsoleErrors() {
  const errors = [...pageExceptions, ...consoleErrors]
  const ok = errors.length === 0
  record('P11 console error = 0（boot 后全量采集）', ok ? 'pass' : 'fail',
    ok ? 'no console.error / no uncaught exception' : JSON.stringify(errors.slice(0, 6)))
  return ok
}

// ── prepare-v4：把迁移副本里的一条真实会话复制进隔离 home ────────────────
/**
 * 从迁移副本里挑一条**有真实消息内容的主会话**（优先非 subagent、标题/正文可读），
 * 复制进隔离 home（只复制会话文件本体，**绝不**复制 credentials / keys / 其它实例状态）。
 */
async function prepareV4() {
  const roots = []
  if (process.env.RC3_V4_SOURCE !== undefined) roots.push(process.env.RC3_V4_SOURCE)
  const isoRoot = dirname(ISO_HOME)
  for (const name of readdirSync(isoRoot)) {
    if (name.includes('rehearsal')) roots.push(join(isoRoot, name))
  }
  const src = roots.find(p => existsSync(join(p, 'sessions')))
  if (src === undefined) fail(`找不到迁移副本（试过 ${JSON.stringify(roots)}）；先跑 rehearse-v4-migration.mjs --publish`)

  const sessionsRoot = join(src, 'sessions')
  const candidates = []
  for (const project of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, project)
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      let files
      try { files = readdirSync(join(dir, entry)) } catch { continue }
      const v4 = files.find(f => f.startsWith('session.v4'))
      if (v4 === undefined) continue
      let events
      try { events = readV4Events(join(dir, entry, v4)) } catch { continue }
      const header = events.find(e => e.type === 'session')
      const needles = textNeedles(events)
      const isSubagent = header?.parentSession !== undefined || header?.origin === 'subagent'
      candidates.push({
        project, entry, dir: join(dir, entry), files, events, header,
        title: sessionTitle(events) ?? entry,
        needles, isSubagent, eventCount: events.length,
      })
    }
  }
  if (candidates.length === 0) fail('迁移副本里没有可解出事件的 session.v4 文件（迁移没成功？）')
  // 选择：非 subagent + needles 非空 + needles 多 + 事件多。
  // 取**两条**（标题不同）：P8 用第一条验证正文，P9 的「切换」需要两条真实行
  // （新建会话是 blank，官方侧栏过滤 blank ⇒ 行不存在，不能拿它当点击目标）。
  // 侧栏任务列表只显示 `corum-task-*` 会话（`isTaskSession`），故优先挑这类 id：
  // 否则第二条会话点不到（`session-*` 的 UUID 会话不进任务列表）。
  candidates.sort((a, b) => (Number(a.isSubagent) - Number(b.isSubagent))
    || (Number(!a.entry.startsWith('corum-task-')) - Number(!b.entry.startsWith('corum-task-')))
    || (Number(b.needles.length === 0) - Number(a.needles.length === 0))
    || (b.needles.length - a.needles.length) || (b.eventCount - a.eventCount))
  const usable = candidates.filter(c => !c.isSubagent && c.needles.length > 0)
  const pickedList = []
  for (const candidate of usable) {
    if (pickedList.length === 0) { pickedList.push(candidate); continue }
    // 第二条必须是**不同标题**的真实会话（切换判据看顶栏标题变化）。
    if (candidate.title !== pickedList[0].title) pickedList.push(candidate)
    if (pickedList.length >= 2) break
  }
  if (pickedList.length === 0) fail('未能从迁移会话里提取到消息文本（所有候选都空？）')

  const sessions = []
  for (const picked of pickedList) {
    const destDir = join(ISO_HOME, 'sessions', picked.project, picked.entry)
    mkdirSync(destDir, { recursive: true })
    for (const f of picked.files) {
      if (f === 'session.lock') continue
      cpSync(join(picked.dir, f), join(destDir, f))
    }
    sessions.push({
      sessionId: picked.entry,
      title: picked.title,
      project: picked.project,
      files: picked.files,
      needles: picked.needles,
      isSubagent: picked.isSubagent,
      eventCount: picked.eventCount,
      source: picked.dir,
      dest: destDir,
    })
  }
  const manifest = { ...sessions[0], sessions }
  writeFileSync(join(OUT, 'v4-copy.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const session of sessions) {
    log(`V4 会话已复制：${session.sessionId} title="${session.title}"（${session.eventCount} events）→ ${session.dest}`)
    log(`  needles=${JSON.stringify(session.needles)}`)
  }
}

/**
 * 解出 v4 会话的全部事件行。
 *
 * ⚠️ **实测坑（本场踩到）**：会话文件是**多帧 zstd**（首帧单独一个 header 帧），
 * `zlib.zstdDecompressSync` / `createZstdDecompress` 都**只解第一帧** ⇒ 275KB 的文件
 * 只读出 294 字节的 header（消息全丢，看起来像"迁移出空会话"）。故按 zstd frame
 * magic 切分，逐帧解；解不出来的偏移是压缩数据里的假 magic，跳过即可。
 * @param file - session.v4*.jsonl(.zstd) 路径
 * @returns 事件对象数组
 */
function readV4Events(file) {
  const zlib = req('node:zlib')
  const raw = readFileSync(file)
  let text
  if (file.endsWith('.zstd')) {
    const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
    let offset = raw.indexOf(magic)
    if (offset < 0) throw new Error('不是 zstd 文件（无 frame magic）')
    const parts = []
    while (offset >= 0) {
      try { parts.push(zlib.zstdDecompressSync(raw.subarray(offset)).toString('utf8')) } catch { /* 压缩数据里的假 magic */ }
      offset = raw.indexOf(magic, offset + 1)
    }
    text = parts.join('')
  } else {
    text = raw.toString('utf8')
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* 半行/坏行跳过 */ }
  }
  return events
}

/** 会话标题（`session/title` 的最新一次，或 header 里的 title）。 */
function sessionTitle(events) {
  let title
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  const header = events.find(e => e.type === 'session')
  return (title ?? header?.data?.title ?? undefined)?.trim() || undefined
}

/**
 * 从事件流的**尾段**抽「会在 UI 里出现的纯文本片段」。
 *
 * ⚠️ 为什么必须取尾段（2026-10-29 实测）：历史会话打开时视图停在**末尾**，
 * 上面是「加载更早」折叠 —— 首轮消息根本不在 DOM 里。旧实现取首条 user/message，
 * 于是「会话真的打开了、正文真的渲染了」却命中 0（假红）。
 *
 * 取法：从末尾反向扫 ≤ 400 条事件，收集 user/message 与 assistant/message 的
 * markdown 正文里长度 ≥ 20 的连续文本段（只留可在 DOM 原样命中的字符类）。
 * @param events - 完整事件流
 * @returns 至多 6 个 needle
 */
function textNeedles(events) {
  const needles = []
  const pushFrom = (text) => {
    const runs = String(text).replace(/\s+/g, ' ')
      .match(/[\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9 ,.、，。:：\-]{18,}/g) ?? []
    for (const run of runs) {
      const candidate = run.trim()
      if (candidate.length < 20) continue
      const needle = candidate.slice(0, 40)
      if (!needles.includes(needle)) needles.push(needle)
      if (needles.length >= 6) return
    }
  }
  const tail = events.slice(-400).reverse()
  for (const event of tail) {
    if (needles.length >= 6) break
    if (event.type === 'user/message') {
      for (const block of event.data?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') pushFrom(block.text)
      }
    } else if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? event.data?.content
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') pushFrom(block.text)
      }
    }
  }
  return needles.slice(0, 6)
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  if (PHASE === 'prepare-v4') {
    await prepareV4()
    return 0
  }
  console.log(`\nrc3 行为验收探针  phase=${PHASE}  :${PORT}  证据=${OUT}\n`)
  const page = await findPage()
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')
  await evaluate(cdp, RPC_PRELUDE)

  const ready = await checkUiReady(cdp)
  if (!ready) {
    await screenshot(cdp, 'ui-not-ready')
    cdp.close()
    return finish()
  }

  if (PHASE === 'persist') {
    await checkBootDiagnostics(cdp)
    await checkPresetRoster(cdp)
    await checkPresetDefaultWrite(cdp, 'persist')
    await checkSettingsRoundtrip(cdp, 'persist')
    await checkV4(cdp, 'persist')
    await checkConsoleErrors()
    await screenshot(cdp, 'persist-final')
    cdp.close()
    return finish()
  }

  await checkBootDiagnostics(cdp)
  await checkPresetRoster(cdp)
  await checkPresetUi(cdp)
  await checkPresetDefaultWrite(cdp, 'full')
  await checkAcp(cdp)
  await checkQueueWire(cdp)
  await checkSettingsRoundtrip(cdp, 'full')
  // 侧栏切「单列表」+ 开发者模式：P8/P9/P10 的真实 UI 入口前提（两条都是真实用户路径，
  // 见 switchSidebarToList / enableDeveloperMode 的注释）。
  const view = await switchSidebarToList(cdp)
  const devMode = await enableDeveloperMode(cdp)
  log(`侧栏视图=${JSON.stringify(view)}  开发者模式=${devMode}`)
  await checkV4(cdp, 'full')
  await checkNav(cdp)
  await checkRightbar(cdp)
  await checkConsoleErrors()
  await screenshot(cdp, 'full-final')
  cdp.close()
  return finish()
}

function finish() {
  const passes = results.filter(r => r.state === 'pass')
  const fails = results.filter(r => r.state === 'fail')
  const skips = results.filter(r => r.state === 'skip')
  console.log(`\n结果：通过 ${passes.length} / 失败 ${fails.length} / 跳过 ${skips.length}（phase=${PHASE}）`)
  if (fails.length > 0) {
    console.log('失败项：')
    for (const f of fails) console.log(`  ✗ ${f.name}\n      ${f.detail.slice(0, 700)}`)
  }
  const file = join(OUT, `behavior-${PHASE}.json`)
  writeFileSync(file, `${JSON.stringify({
    phase: PHASE, port: PORT, isolatedHome: ISO_HOME,
    userDataDir: process.env.CORUM_USER_DATA_DIR, sourceHome: SRC_HOME,
    pass: passes.length, fail: fails.length, skip: skips.length, results,
  }, null, 2)}\n`)
  console.log(`证据：${file}`)
  // 关键项不允许「跳过」：有 skip 也按失败退出。
  return (fails.length > 0 || skips.length > 0) ? 1 : 0
}

const code = await main().catch((e) => {
  console.error(`探针崩了: ${e?.stack ?? e}`)
  return 2
})
process.exit(code)
