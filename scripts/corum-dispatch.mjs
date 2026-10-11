#!/usr/bin/env node
/**
 * corum-dispatch.mjs —— 往 :9222（或任意实例）**新建一个会话并派一条单行任务**。
 *
 * 由来（2026-09-14 夜间）：监督方需要反复派活（P0-4 → P0-5 → 任务 1 → 功能轮），
 * 而 UI 逐点点选要 8-10 次 CDP 往返、且坐标随布局漂移。本脚本把整套流程做成一跳：
 *   新会话 → 新建任务卡片 → 选工作区 → 选 Agent → 选权限 → 开始 → 聚焦 composer
 *   → 插入单行任务 → Enter → 用「sessions 目录前后差集」回报**新建会话 id**。
 *
 * 两个「不新建会话」的模式（都只作用于**当前打开的**会话）：
 *   `--send`   把文本发进当前会话的 composer 并回车。**若会话正在跑回合，这只是排队**：
 *              消息要等当前回合结束或回合边界才会被模型读到。
 *   `--steer`  在 `--send` 之后，再点 UI 的「**插话发送**」把排队项**插进正在跑的回合**
 *              （steering，立即在下一个 step 生效），并断言插话气泡出现。
 *              2026-09-14 用户纠正：此前两次纠偏都是**用户手动点**的 —— 「发出去」≠「插进去」，
 *              所以监督侧纠偏一律用 `--steer`。
 *
 * 用法：
 *   node scripts/corum-dispatch.mjs --brief-file .corum-scratch/p0-5.txt \
 *        [--port 9222] [--home packages/desktop/.corum-dev-home] \
 *        [--workspace kkc-desktop] [--agent 指挥模式] [--permission 工作区读写] \
 *        [--brief "..."] [--dry-run]
 *   node scripts/corum-dispatch.mjs --send  --brief-file <path>     # 排队
 *   node scripts/corum-dispatch.mjs --steer --brief-file <path>     # 插进正在跑的回合
 *
 * 纪律：
 *   · **任务文本必须单行**（composer 会把换行折叠/提前发送）——脚本会强制折叠并告警。
 *   · 点击一律走 CDP `Input.dispatchMouseEvent`（本仓实测：合成事件会被 React 忽略）。
 *   · 每一步都带断言；失败即退出码 1 并打印当时可见的候选元素，便于定位。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(REPO, 'packages', 'desktop', 'package.json'))
const WebSocket = require('ws')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const PORT = String(flag('port', process.env.CORUM_DISPATCH_PORT ?? '9222'))
const HOME = resolve(REPO, String(flag('home', 'packages/desktop/.corum-dev-home')))
const WORKSPACE = String(flag('workspace', 'kkc-desktop'))
const AGENT = String(flag('agent', '指挥模式'))
const PERMISSION = String(flag('permission', '工作区读写'))
const DRY = argv.includes('--dry-run')

let brief = ''
if (flag('brief-file', false)) brief = readFileSync(resolve(REPO, String(flag('brief-file'))), 'utf8')
else brief = String(flag('brief', ''))
brief = brief.trim().replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ')
if (!brief) {
  console.error('缺少任务文本：用 --brief "…" 或 --brief-file <path>')
  process.exit(2)
}
if (/[\r\n]/.test(brief)) console.error('⚠️ 任务文本含换行，已折叠为单行')

// 派单前的路径体检（2026-09-14 教训）：我两次在派单里写错/漏写文件路径
// （如把 corum-editor.ts 写成 packages/desktop/src/host/，实际在 src/client/editor/），
// worker 会照着找一个不存在的文件、白花一次工具调用再自己纠正。
// 这里只做**非致命告警**：把 brief 里看起来像仓库内路径的 token 抽出来验存在性。
{
  const tokens = new Set()
  for (const m of brief.matchAll(/(?:^|[\s`(（【])((?:packages|docs|scripts|skills|\.corum-scratch)\/[A-Za-z0-9._/@-]+)/g)) tokens.add(m[1].replace(/[.,;:)`）」】]+$/, ''))
  // 第二根：**官方 dsh checkout**（派单里常引用官方包的路径，如 packages/core/agent/src/inbox.ts）。
  // 用 CORUM_OFFICIAL_DSH 指定；**未设置则不启用该根**（不预置机器专属路径），
  // 此时只在仓库根下校验路径存在性。
  const officialRoot = process.env.CORUM_OFFICIAL_DSH
  const existsUnder = (root, rel) => {
    try { statSync(join(root, rel)); return true } catch { return false }
  }
  const missing = []
  for (const t of tokens) {
    if (/[*?]/.test(t)) continue
    if (existsUnder(REPO, t)) continue
    if (officialRoot !== undefined && officialRoot !== REPO && existsUnder(officialRoot, t)) continue
    missing.push(t)
  }
  if (tokens.size > 0) {
    const roots = officialRoot === undefined ? '本仓（未设 CORUM_OFFICIAL_DSH，未含官方检出）' : `本仓 + 官方 ${officialRoot}`
    console.log(`[dispatch] 路径体检：抽出 ${tokens.size} 个路径（${roots}），其中 ${missing.length} 个不存在`)
  }
  for (const m of missing) console.log(`[dispatch]   ⚠️ 不存在（可能是错路径，也可能是本轮要新建的文件）：${m}`)
}
console.log(`[dispatch] port=${PORT} home=${HOME} ws=${WORKSPACE} agent=${AGENT} perm=${PERMISSION} brief=${brief.length} 字`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.find((t) => t.type === 'page')
if (!pg) {
  console.error(`[dispatch] :${PORT} 上没有 page 目标（CDP 不可达？）`)
  process.exit(2)
}
const ws = new WebSocket(pg.webSocketDebuggerUrl, { handshakeTimeout: 8000 })
let id = 0
const pending = new Map()
const send = (method, params) =>
  new Promise((res, rej) => {
    const myId = ++id
    pending.set(myId, { res, rej })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
ws.on('message', (m) => {
  const msg = JSON.parse(String(m))
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
})
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`页面求值异常：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  return r.result?.value
}

/** 可信点击：量矩形中心 → **命中测试**（elementFromPoint 必须落回目标或其子节点）→ 发 mouse 事件。
 *  2026-09-14 教训：只量一次矩形就点，在「对话框刚打开/有过渡动画」时会点空（实测复位步骤连续两次
 *  点不到 footer 的「取消」）。这里最多重试 3 次，并在每次点击前重新测量 + 命中校验。 */
async function clickExpr(expr, label) {
  let last = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const probe = await evaluate(`(() => {
      const el = ${expr};
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return null;
      const x = Math.round(b.x + b.width/2), y = Math.round(b.y + b.height/2);
      const hit = document.elementFromPoint(x, y);
      const ok = hit ? (hit === el || el.contains(hit)) : false;
      // 命中失败时把**实际接住这一点的元素**一并带回（2026-10-10）：缺这条信息时，
      // 只能看到「没命中」，不知道是谁挡的 —— 本次事故就是靠手工探 DOM 才看出
      // 「Agent 下拉面板盖住了取消按钮」。这里让报错自带答案。
      const blocker = ok || hit === null ? null : {
        tag: hit.tagName,
        cls: (hit.className || '').toString().slice(0, 48),
        role: hit.getAttribute('role'),
        text: ((hit.getAttribute('aria-label') || hit.innerText || '')).replace(/\\s+/g, ' ').trim().slice(0, 40),
        // 遮挡物是否落在**浮层容器内部**（而不只是它自己带 role）：面板里的条目是
        // role="menuitemradio"，容器才是 role="menu" —— 只看 hit 自身 role 会漏判
        // （2026-10-10 实测：初次实现就漏了，hint 没打出来）。
        insideMenu: hit.closest('[role="menu"],[role="dialog"]') !== null,
      };
      return { x, y, w: Math.round(b.width), h: Math.round(b.height), hit: ok, hitTag: hit ? hit.tagName : null, blocker };
    })()`)
    if (probe === null) throw new Error(`找不到可点元素：${label}`)
    last = probe
    if (probe.hit) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.x, y: probe.y, button: 'none', clickCount: 0 })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.x, y: probe.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(60)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.x, y: probe.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(400)
      return probe
    }
    // 命中不到目标（动画中/被遮挡）→ 等一下重测
    await sleep(300)
  }
  // 报错自带「谁挡住了」+ 处置建议（2026-10-10）：只报「没命中」的话，排查要手工探 DOM。
  const b = last?.blocker
  const blockedBy = b
    ? `；落点被 ${b.tag}${b.role ? `[role=${b.role}]` : ''}${b.text ? `「${b.text}」` : ''} 接住`
    : ''
  const hint = b?.insideMenu === true
    ? '｜处置：有一个下拉/菜单还展开着并盖住了目标 —— 先按 Escape 关闭浮层再重试（本脚本在点「取消」/「开始」前已自动做这件事）'
    : ''
  throw new Error(`点击落点未命中目标（重试 3 次）：${label}${blockedBy}｜最后一次探测：${JSON.stringify(last)}${hint}`)
}

async function waitFor(expr, label, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    const v = await evaluate(expr)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
    await sleep(400)
  }
}

/**
 * 页面上是否还有**展开的浮层面板**（下拉/菜单/对话框）。
 *
 * 判据用 `role` 而不是 `aria-expanded`：本仓实测（2026-10-10）`aria-expanded="true"`
 * 有**假阳性** —— 侧栏工作区分组行（`XloQSW_groupRow`）是带 aria-expanded 的 DIV，
 * 常驻为 true，与浮层无关。而三层选择器的浮层都带显式 role：
 *   · `AgentTwoLevelSelect` → `role="menu"`；`EmptyStateHero` 工作区下拉 → `role="menu"`；
 *   · `ModelSelectWithEffort` → `role="menu"`；`ContextMeter` → `role="dialog"`。
 * 故「存在可见的 [role=menu] / [role=dialog]」才是浮层展开的可靠判据。
 *
 * @returns 展开中的浮层数量。
 */
const openMenuCount = () => evaluate(
  `[...document.querySelectorAll('[role="menu"],[role="dialog"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).length`,
)

/**
 * 关闭所有展开的浮层（下拉/菜单/对话框），使底部按钮重新可点。
 *
 * ## 为什么必须有（2026-10-10 实测事故）
 * 「新建任务」表单里 Agent 是三层选择器：点开后面板**盖在 footer 的「取消」按钮上**，
 * 于是「取消」矩形的中心点命中的是面板里的 Agent 条目（实测读到「前端工程师-前端软件工程师」）。
 * 原脚本的复位步骤假设「表单一关就没有遮挡」，直接用可信点击点「取消」⇒ 连续 3 次
 * 命中测试失败，报「点击落点未命中目标（重试 3 次）：footer 取消按钮」并终止整个派发。
 * 更隐蔽的是：该失败只发生在「上一次运行把某个下拉留在展开态」时，是**残留状态相关**的
 * 间歇失败，重跑一次往往就好了 —— 这种「重跑即好」的假象正是它长期没被修掉的原因。
 *
 * ## 为什么用 Escape（而不是点 trigger 或点外部）
 * 三种关闭方式实测对比（2026-10-10，9222 打包态）：
 *   · **Escape**：1 次即关（`role=menu` 1→0），且**无浮层时连按 3 次对表单无副作用**
 *     （表单仍开着）—— 安全幂等，故选它。
 *   · 点 trigger：需要先知道**哪个** trigger 是开的（工作区/Agent/模型各一个），要遍历+
 *     各自命中测试，脆弱且多轮往返。
 *   · 点面板外部：落点本身就要选一个「不被任何浮层覆盖」的坐标，而在遮挡已经发生、
 *     布局未定时这个前提不一定成立 —— 用它解遮挡是循环依赖。
 *
 * Escape 有个已知前提：焦点不在输入框里时才能被面板的 keydown 监听收到。面板打开时
 * 会主动 focus 面板内搜索框（`AgentTwoLevelSelect` 打开即聚焦），所以正常情况成立；
 * 若某个面板不聚焦，下面的兜底（点 trigger 关闭）会接住。
 *
 * @param label - 日志用的上下文标签。
 * @returns 关闭前探测到的浮层数量。
 */
async function closeOpenMenus(label) {
  let count = await openMenuCount()
  if (count === 0) return 0
  for (let i = 0; i < 3 && count > 0; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(250)
    count = await openMenuCount()
  }
  if (count > 0) {
    // 兜底：Escape 没关掉（面板未聚焦等情况）→ 逐个点掉 aria-haspopup 触发器。
    // 只在 Escape 失效时走，避免平时多做无用点击。
    for (const sel of ['agentSelTrigger', 'wsTrigger']) {
      const stillOpen = await evaluate(`document.querySelector('[class*="${sel}"]')?.getAttribute('aria-expanded') === 'true'`)
      if (stillOpen) {
        await clickExpr(`document.querySelector('[class*="${sel}"]')`, `${sel}（兜底关闭）`).catch(() => {})
        await sleep(300)
      }
    }
    count = await openMenuCount()
  }
  console.log(`[dispatch] 已关闭展开的浮层（${label}）`)
  return count
}

const btn = (text) => `[...document.querySelectorAll('button')].find(b => ((b.getAttribute('aria-label')||b.innerText||'').trim() === ${JSON.stringify(text)}))`
const btnStarts = (text) => `[...document.querySelectorAll('button')].find(b => ((b.innerText||'').trim().startsWith(${JSON.stringify(text)})))`
const withText = (cls, text) => `[...document.querySelectorAll('[class*="${cls}"]')].find(e => (e.innerText||'').includes(${JSON.stringify(text)}))`

try {
  // `--send`：不新建会话，只把文本发进**当前打开的**会话（用于中途纠偏/补充约束）。
  // `--steer` 是它的升级形态（发完再点「插话发送」把消息插进正在跑的回合）。
  // 2026-09-14 事故：`--steer` 起初没进这个分支 → 直接走了「新建会话」流程，
  // 白建了一个 corum-task-5aac3958 并把它当成一个新任务派出去。两个 flag 都要走这里。
  if (argv.includes('--send') || argv.includes('--steer')) {
    // 前提：**当前页面必须是会话视图**（有 composer）。2026-09-14 实测：若上一次操作把界面留在
    // 空态页/表单页，这里只会超时报「composer」，看不出该怎么办 —— 现在给出可执行的下一步。
    if (!(await evaluate(`!!document.querySelector('[contenteditable="true"]')`))) {
      console.error('[dispatch] ❌ 当前页面不是会话视图（没有 composer），无法 --send。')
      console.error('[dispatch]    处置：先在左侧会话列表 / 空态页的「最近」里点开目标会话，再重跑本命令。')
      process.exit(1)
    }
    await clickExpr(`document.querySelector('[contenteditable="true"]')`, 'composer')
    await send('Input.insertText', { text: brief })
    await sleep(300)
    const t = await evaluate(`(document.querySelector('[contenteditable="true"]')||{}).innerText || ''`)
    if (t.trim().length < Math.min(20, brief.length)) throw new Error(`文本未进入 composer（读到 ${t.length} 字）`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    // 若目标会话正在跑 turn，消息会进队列；顺便报告队列现状，提示可用「插话发送」提前注入
    await sleep(800)
    const queued = await evaluate(`[...document.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label')||'') === '插话发送').length`)
    console.log(`[dispatch] ✅ 已发送（--send）｜brief ${brief.length} 字｜队列中的待插话项 ${queued}（>0 时可用 UI 的「插话发送」提前到下一个 step）`)

    // `--steer`（2026-09-14 用户纠正）：Enter 只是**排队**——消息要等当前回合/回合边界才会被读到，
    // 落到「插话发送」按钮上才是**插进正在跑的回合**（steering）。此前两次纠偏都是**用户手动点的**，
    // 说明「发出去」≠「插进去」。这里把该动作自动化：找到「插话发送」→ 可信点击 → 断言插话气泡出现。
    if (argv.includes('--steer')) {
      if (queued === 0) {
        console.log('[dispatch] ℹ️ --steer：没有待插话项（会话空闲或已被消费）→ 本条已按普通回合发送，无需插队')
        process.exit(0)
      }
      const before = await evaluate(`document.querySelectorAll('[data-pending-steering]').length`)
      await clickExpr(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === '插话发送')`, '插话发送按钮')
      await sleep(900)
      const after = await evaluate(`document.querySelectorAll('[data-pending-steering]').length`)
      const left = await evaluate(`[...document.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label')||'') === '插话发送').length`)
      // 成功判据（2026-09-14 实测修正）：**待插话项被消费**（left < queued）是主判据；
      // 插话气泡数变化只是辅证 —— 卡片可能已经被交付进回合（气泡不再是 pending），
      // 也可能渲染在别的属性上，所以不能拿它当唯一判据（首次实测就误报失败）。
      if (left < queued || after > before) {
        console.log(`[dispatch] ✅ 已插队（--steer）｜待插话项 ${queued} → ${left}｜插话气泡 ${before} → ${after}`)
        process.exit(0)
      }
      console.error(`[dispatch] ⚠️ --steer：点击后既没消费待插话项（${queued} → ${left}）也没多出插话气泡（${before} → ${after}）——请人工确认`)
      process.exit(1)
    }
    process.exit(0)
  }

  // 0) 复位：上一次若留下了打开的表单，先关掉（否则空态页的「新建任务」卡片不存在）
  if (await evaluate(`!!document.querySelector('[class*="wsTrigger"]')`)) {
    console.log('[dispatch] 检测到已打开的表单，先关闭')
    // ⚠️ 顺序不能反（2026-10-10 实测事故）：**必须先关浮层，再点「取消」**。
    // 表单里的 Agent/工作区/模型三层选择器一旦处于展开态，面板会盖住 footer 的
    // 「取消」按钮 —— 此时点「取消」的矩形中心命中的是面板里的条目（实测读到
    // 「前端工程师-前端软件工程师」），可信点击连续 3 次命中测试失败，整个派发终止。
    // 该失败与「上一次运行留下的下拉展开态」相关，属间歇性，重跑一次常能过 —— 也正是
    // 它长期没被发现的原因。closeOpenMenus 的判据与 Escape 语义见其函数头注释。
    await closeOpenMenus('复位前置：清掉残留下拉')
    // 实测（2026-09-14）：Escape **无效**；按 aria-label 匹配会先命中右上角 ×（`取消新建任务`）
    // 也**无效**；真正有效的是**精确文本为「取消」的 footer 按钮**。按它来。
    await clickExpr(`[...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '取消')`, 'footer 取消按钮')
    await sleep(400)
    if (await evaluate(`!!document.querySelector('[class*="wsTrigger"]')`)) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await sleep(400)
    }
    await waitFor(`!document.querySelector('[class*="wsTrigger"]')`, '表单关闭', 8000)
  }

  // 1) 新会话。**两种可能**：进入空态页（需要再点「新建任务」卡片）**或**直接打开新建任务表单
  //    —— 取决于当前 UI 状态。2026-09-14 实测：漏了这条分支时，每次都变成「找不到新建任务卡片」，
  //    而现场快照其实是一个**全新默认值**的表单（就是这一步开出来的）。
  await clickExpr(btn('新会话'), '新会话按钮')
  await sleep(600)
  if (!(await evaluate(`!!document.querySelector('[class*="wsTrigger"]')`))) {
    await waitFor(`!!document.querySelector('[class*="wsCard"], [class*="card"]')`, '空态页', 8000)
    await clickExpr(btnStarts('新建任务'), '新建任务卡片')
  }
  await waitFor(`!!document.querySelector('[class*="wsTrigger"]')`, '新建任务表单')

  // 3) 工作区
  const wsNow = await evaluate(`(document.querySelector('[class*="wsTriggerTx"]')||{}).innerText || ''`)
  if (!wsNow.includes(WORKSPACE)) {
    await clickExpr(`document.querySelector('[class*="wsTrigger"]')`, '工作区下拉')
    await waitFor(`!!${withText('wsOpt', WORKSPACE)}`, '工作区选项')
    await clickExpr(withText('wsOpt', WORKSPACE), `工作区选项 ${WORKSPACE}`)
  }
  const wsAfter = await evaluate(`(document.querySelector('[class*="wsTriggerTx"]')||{}).innerText || ''`)
  if (!wsAfter.includes(WORKSPACE)) throw new Error(`工作区未选中：现在是 ${wsAfter.replace(/\s+/g, ' ')}`)

  // 4) Agent（列表可滚动；先滚到可见再点）
  const agentNow = await evaluate(`(document.querySelector('[class*="agentSelTriggerName"]')||{}).innerText || ''`)
  if (!agentNow.includes(AGENT)) {
    await clickExpr(`document.querySelector('[class*="agentSelTrigger"]')`, 'Agent 下拉')
    await waitFor(`!!${withText('agentSelItem', AGENT)}`, `Agent 选项 ${AGENT}`)
    const scrolled = await evaluate(`(() => { const el = ${withText('agentSelItem', AGENT)}; let sc = el.parentElement; while (sc && sc.scrollHeight <= sc.clientHeight + 4) sc = sc.parentElement; if (sc) sc.scrollTop = Math.max(0, el.offsetTop - Math.round(sc.clientHeight/2)); return true })()`)
    if (!scrolled) throw new Error('Agent 列表滚动失败')
    await sleep(300)
    await clickExpr(withText('agentSelItem', AGENT), `Agent 选项 ${AGENT}`)
  }
  const agentAfter = await evaluate(`(document.querySelector('[class*="agentSelTriggerName"]')||{}).innerText || ''`)
  if (!agentAfter.includes(AGENT)) throw new Error(`Agent 未选中：现在是 ${agentAfter}`)
  const modelNow = await evaluate(`([...document.querySelectorAll('*')].find(e => /^Kimi|^DeepSeek|^GLM/.test((e.innerText||'').trim()) && (e.innerText||'').length < 40)||{}).innerText || ''`)
  console.log(`[dispatch] 已选：工作区 ${wsAfter.replace(/\s+/g, ' ').slice(0, 24)}｜Agent ${agentAfter}｜模型 ${modelNow.replace(/\s+/g, ' ').slice(0, 30)}`)

  // 5) 权限
  await clickExpr(withText('permOpt', PERMISSION), `权限 ${PERMISSION}`)

  if (DRY) {
    // 干跑要**自己收尾**：把刚打开的表单取消掉，否则留下残局会让下一次运行的第一步就撞车。
    // 同样必须先清浮层（见步骤 0 的事故注释）——干跑路径一样会点「取消」。
    await closeOpenMenus('干跑收尾：清浮层')
    await clickExpr(`[...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '取消')`, 'footer 取消按钮（干跑收尾）')
    await waitFor(`!document.querySelector('[class*="wsTrigger"]')`, '表单关闭（干跑收尾）', 8000)
    console.log('[dispatch] --dry-run：选择器与路径体检均通过，已取消表单（未创建会话）')
    process.exit(0)
  }

  // 6) 记录创建前的会话目录快照，然后点「开始」
  // 注意：项目目录名是 `--<路径里 / 换成 - >--`（**不要**再多加一个连字符 —— 2026-09-14 踩过，
  // 于是改成「全量快照差集」，既不怕命名规则变化，也不怕并发新建）。
  const snapshotSessions = () => {
    const root = join(HOME, 'sessions')
    const out = new Set()
    for (const proj of readdirSync(root)) {
      const p = join(root, proj)
      if (!statSync(p).isDirectory()) continue
      for (const sid of readdirSync(p)) if (statSync(join(p, sid)).isDirectory()) out.add(`${proj}/${sid}`)
    }
    return out
  }
  const before = snapshotSessions()
  // 「开始」是**唯一真正创建会话**的按钮，最不能因遮挡而失败：点之前先收干净浮层
  // （选完 Agent / 权限后，若某个下拉仍开着，它会盖住 footer 的「开始」）。
  await closeOpenMenus('点「开始」前：确保 footer 可点')
  await clickExpr(`document.querySelector('button[class*="primaryBtn"]')`, '开始按钮')

  // 7) 等 composer，插入任务并发送
  await waitFor(`!!document.querySelector('[contenteditable="true"]')`, '会话 composer', 30000)
  await clickExpr(`document.querySelector('[contenteditable="true"]')`, 'composer')
  await send('Input.insertText', { text: brief })
  await sleep(300)
  const typed = await evaluate(`(document.querySelector('[contenteditable="true"]')||{}).innerText || ''`)
  if (typed.trim().length < Math.min(20, brief.length)) throw new Error(`任务文本未进入 composer（读到 ${typed.length} 字）`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })

  // 8) 用快照差集确认新建的会话 id
  let sessionId = '(未检出新增目录)'
  for (let i = 0; i < 25; i++) {
    const added = [...snapshotSessions()].filter((k) => !before.has(k))
    if (added.length > 0) { sessionId = added[0].split('/')[1]; break }
    await sleep(400)
  }
  console.log(`[dispatch] ✅ 已派发｜新会话 ${sessionId}｜brief ${brief.length} 字`)
  console.log(JSON.stringify({ port: PORT, workspace: WORKSPACE, agent: agentAfter, sessionId }))
} catch (error) {
  console.error(`[dispatch] ❌ ${error.message}`)
  try {
    const snapshot = await evaluate(`JSON.stringify({ bodyTail: document.body.innerText.replace(/\\s+/g,' ').slice(-300), buttons: [...document.querySelectorAll('button')].map(b=>(b.getAttribute('aria-label')||b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20)).filter(Boolean).slice(0,25) })`)
    console.error(`[dispatch] 现场：${snapshot}`)
  } catch {}
  process.exitCode = 1
} finally {
  ws.close()
}
