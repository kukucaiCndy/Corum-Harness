#!/usr/bin/env node
/**
 * corum-smoke.mjs —— Corum 桌面应用的**发布/开发冲烟测试**（单一入口，两档）。
 *
 * 由来：本项目反复出现「编译过 + 单测绿」但实机行为倒退的情况（`AGENTS.md` 红线 5
 * 「编译通过不是完成」）。本脚本把「起得来 + 画得出来 + 沙箱真的在约束 + Agent 真能跑」
 * 这几件**只有实机才能证伪**的事，收成一条可复跑、可分档、可归档的命令。
 *
 * ## 两档
 *   --fast   （默认）秒级~1 分钟：启动链路 + DOM 渲染 + **真实像素呈现** + 控制台零错误
 *                     + 平台/沙箱前置。适合每次改动。
 *   --full   在 fast 之上追加：原生模块真加载（node-pty 真开 PTY / koffi 真调 libc）
 *                     + 沙箱真约束（越界写必须被拒）+ **Agent 真跑一轮 bash**。
 *                     适合发版。
 *
 * ## 为什么要单独有「真实像素」这一项（本仓实测教训）
 * 2026-10-07 Linux 实机：窗口**全空白**，而 CDP 截图与 DOM 都**完全正常**
 * （DOM readyState=complete、`Page.captureScreenshot` 有 1990 色）。
 * ⇒ **只测 DOM/渲染器视角的冲烟会漏掉「窗口没显示」这类倒退**，故必须在 X 层抓真实像素。
 * 抓不到 X 工具时**记 skip 并说明原因**，绝不当作通过。
 *
 * ## 为什么不驱动主实例
 * 与 `scripts/cdp.mjs` 同一纪律：默认只碰自己的验证端口（9333），绝不动用户主实例（9222）。
 *
 * ## 用法
 *   node scripts/corum-smoke.mjs --fast                 # 附着到已起的实例（CDP_PORT）
 *   node scripts/corum-smoke.mjs --fast --launch        # 自己把应用起起来（无头用 Xvfb）
 *   node scripts/corum-smoke.mjs --full --launch
 *   node scripts/corum-smoke.mjs --launch --packaged    # 验**打包产物**（发布门禁）
 *   node scripts/corum-smoke.mjs --json                 # 机器可读（CI）
 *
 * ## `--packaged` 与凭证加密门禁（2026-10-09）
 * 用户拍板：**dev 允许降级、打包态必须拦住**。故 `--packaged` 会直接 exec
 * `dist/` 里的产物（**不经** `corum-instance.sh --mode=packaged`——那个脚本会先
 * 用 dev 身份的 Electron 解出主密钥并注入，会让判据假绿），并断言启动日志里没有
 * `safeStorage unavailable` / `Keychain lookup failed` / `master key is unavailable`
 * / `plugin tree failed to load`，且 `$CORUM_HOME/.master-key` 为 0600。
 * 详见 {@link checkCredentialEncryption}。
 *
 * 环境变量：
 *   CDP_PORT        CDP 端口（默认 9333）
 *   CORUM_REPO      主 checkout 根（默认脚本自身所在仓库）
 *   DISPLAY         X 显示；给了且非空才做真实像素检查
 *   CORUM_SMOKE_OUT 证据目录（默认 /tmp/corum-smoke）
 * @module corum-smoke
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { existsSync, mkdirSync, writeFileSync, readFileSync, openSync, statSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch } from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)

const MODE = has('--full') ? 'full' : 'fast'
const DO_LAUNCH = has('--launch')
const AS_JSON = has('--json')
/** 改为验**打包产物**而非 dev 树（凭证加密判据的发布门禁入口）。 */
const PACKAGED = has('--packaged')
const PORT = Number(process.env.CDP_PORT ?? 9333)
const OUT = process.env.CORUM_SMOKE_OUT ?? '/tmp/corum-smoke'
/** 被启动应用的控制台输出落盘位置（启动期判据的证据来源）。 */
const LAUNCH_LOG = join(OUT, 'launch.log')

/** 用户主实例端口 —— 永远不碰（与 cdp.mjs 同一纪律）。 */
const MAIN_PORT = 9222

const results = []
let repoRoot = null

/**
 * 记录一项检查结果。
 * @param tier - 该项属于哪一档（fast/full）。
 * @param name - 检查名。
 * @param state - pass | fail | skip。
 * @param detail - 判据与证据（**要能被复核**，不是「看起来没问题」）。
 */
function record(tier, name, state, detail) {
  results.push({ tier, name, state, detail })
  if (!AS_JSON) {
    const icon = state === 'pass' ? '✓' : state === 'fail' ? '✗' : '–'
    const color = state === 'fail' ? '\u001b[31m' : state === 'skip' ? '\u001b[33m' : '\u001b[32m'
    console.log(`  ${color}${icon}\u001b[0m ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

function resolveRepoRoot() {
  const fromEnv = process.env.CORUM_REPO
  if (fromEnv && existsSync(join(fromEnv, 'packages/desktop/package.json'))) return fromEnv
  const own = dirname(HERE)
  if (existsSync(join(own, 'packages/desktop/package.json'))) return own
  throw new Error(`无法定位仓库根（脚本在 ${HERE}）。设 CORUM_REPO=<主 checkout 根> 后重试。`)
}

/** 跑一条命令并拿到 stdout（失败返回 null，不抛）。 */
function tryExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim()
  } catch {
    return null
  }
}

// ─────────────────────────── 检查项 ───────────────────────────

/**
 * 前置 A：`build/node` 里的 Node 运行时**是不是本平台的二进制**。
 *
 * 这条抓的是本项目实测过的**静默失效**：`scripts/fetch-node.mjs` 曾硬编码
 * darwin/arm64，在 Linux 上出包会**不报错**地把 macOS 的 Node 塞进产物
 * （台账 `tooling.fetch-node-platformized-and-verified-on-linux`）。
 */
function checkNodeRuntimePlatform() {
  const bin = join(repoRoot, 'packages/desktop/build/node/bin/node')
  if (!existsSync(bin)) {
    record('fast', 'build/node 运行时存在', 'skip', `未物化：${bin}（先跑 npm run pack:node）`)
    return
  }
  const file = tryExec('file', ['-b', bin]) ?? ''
  const expect =
    platform === 'linux' ? 'ELF' : platform === 'darwin' ? 'Mach-O' : platform === 'win32' ? 'PE32' : null
  if (expect === null) {
    record('fast', 'build/node 运行时平台', 'skip', `未覆盖的平台 ${platform}`)
    return
  }
  // 架构词在 file 输出里的写法各平台不同，故按关键词匹配。
  const archWord = arch === 'arm64' ? (file.includes('aarch64') || file.includes('arm64')) : file.includes('x86-64') || file.includes('x86_64')
  if (file.includes(expect) && archWord) {
    record('fast', 'build/node 运行时平台', 'pass', `${expect} / ${arch}`)
  } else {
    record(
      'fast',
      'build/node 运行时平台',
      'fail',
      `期望 ${expect}/${arch}，实际：${file.slice(0, 90)} —— 产物里是**别的平台**的 Node（会静默失效）`,
    )
  }
}

/** 前置 B：Linux 上 Agent 沙箱的前置（bwrap）。缺它沙箱 fail-closed，每次 bash 都会失败。 */
function checkSandboxPrereq() {
  if (platform !== 'linux') {
    record('fast', '沙箱前置（bwrap）', 'skip', `非 Linux（${platform}）无需 bwrap`)
    return
  }
  const bwrap = tryExec('bash', ['-lc', 'command -v bwrap'])
  if (!bwrap) {
    record('fast', '沙箱前置（bwrap）', 'fail', '未安装 bwrap ⇒ 官方链 linux:["bwrap","landlock"] 会 fail-closed，Agent 的 bash 全部失败。装：apt install bubblewrap')
    return
  }
  // 不只是「装了」——真起一次 profile，确认能工作。
  const ok = tryExec('bwrap', [
    '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '/usr/bin/true',
  ])
  record('fast', '沙箱前置（bwrap）', ok === null ? 'fail' : 'pass', ok === null ? 'bwrap 存在但 profile 起不来' : `${bwrap} 可用`)
}

/** 等 CDP 就绪并返回被 CDP 驱动的页面目标。 */
async function waitPage(deadlineMs = 60_000) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const t = targets.find(
        (x) =>
          x.type === 'page' &&
          (x.url.startsWith('corumapp://') || x.url.startsWith('http://127.0.0.1:')) &&
          !x.url.includes('floating='),
      )
      if (t) return t
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`CDP :${PORT} 上没等到主页面（应用未起或端口不对）`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

function connect(wsUrl) {
  const require = createRequire(join(repoRoot, 'packages/desktop/package.json'))
  const WebSocket = require('ws')
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    let seq = 0
    const pending = new Map()
    const events = []
    ws.on('open', () =>
      res({
        events,
        send: (method, params = {}, sessionId) =>
          new Promise((res2, rej2) => {
            const id = ++seq
            pending.set(id, { res: res2, rej: rej2 })
            ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
          }),
        close: () => ws.close(),
      }),
    )
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m.id !== undefined && pending.has(m.id)) {
        const { res: r, rej: j } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? j(new Error(m.error.message)) : r(m.result)
        return
      }
      // 事件（console / log）用于「零新增控制台错误」判据。
      if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Log.entryAdded') events.push(m)
    })
    ws.on('error', rej)
  })
}

/**
 * 已知的**环境噪声**：不是产品缺陷，但也不该当作「零错误」混过去。
 *
 * 目前只有一条，且是实测确认的：
 * `http://127.0.0.1:11434/api/tags` 的连接失败 —— 那是 **Ollama 本地模型的探测端口**
 * （`corum-ollama/src/local-llm-service.ts` 的 `OLLAMA_BASE`）。机器上没装 Ollama 时
 * 每次轮询都会记一条 `net::ERR_CONNECTION_REFUSED`。判据：把该 URL 换成本机跑着 Ollama
 * 的环境，这条就消失（Mac 上实测无此错误）。
 *
 * 处置：**单列成「已知噪声」并计数**，不参与「零错误」判定，但在报告里如实打印条数 ——
 * 既不掩盖，也不冤枉产品。
 */
const KNOWN_BENIGN = [
  {
    name: 'Ollama 本地模型探测（未装 Ollama 时必然出现）',
    test: (text) => /11434\/api\/tags/.test(text) && /ERR_CONNECTION_REFUSED|Failed to load resource/.test(text),
  },
]

/** 把 CDP 事件分成「真错误」与「已知噪声」。 */
function collectConsoleErrors(events) {
  const errors = []
  const benign = []
  for (const e of events) {
    let text = null
    if (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'assert')) {
      text = `console.${e.params.type}: ${(e.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`
    }
    if (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error') {
      text = `log: ${e.params.entry.text} @${e.params.entry.url ?? ''}`
    }
    if (text === null) continue
    const known = KNOWN_BENIGN.find((k) => k.test(text))
    if (known) benign.push({ known: known.name, text })
    else errors.push(text)
  }
  return { errors, benign }
}

/**
 * 真实像素检查：在 **X 层**抓窗口，要求唯一色数超过阈值。
 *
 * 为什么必须单独有这项：实测过「DOM 正常 + CDP 截图正常，但物理窗口全空白」
 * （唯一色 118 vs 有内容的 上万个）。渲染器视角的断言**原理上**看不到这种倒退。
 *
 * 为什么抓两次取最大值（**不是多余的保险**）：在 mutter（GNOME）这类合成器下，
 * 直接抓窗口自身的 pixmap 得到的是**空白**（实测 118 色），因为内容由合成器
 * 画在屏幕缓冲上而非窗口 pixmap；此时必须抓 root 再按窗口几何裁剪（同一窗口
 * 实测 36301 色）。而在没有窗口管理器的 Xvfb 下两种抓法都可用。故：
 * **取两者较大值**，任一抓法看到内容即算呈现。抓法一并写进 detail 以便复核。
 */
function checkRealPixels() {
  const display = process.env.DISPLAY
  if (!display) {
    record('fast', '窗口真实呈现（X 像素）', 'skip', '未设 DISPLAY（无头环境）⇒ 该项无法判定，**不等于通过**')
    return
  }
  const have = (t) => tryExec('bash', ['-lc', `command -v ${t}`])
  if (!have('import') || !have('identify')) {
    record('fast', '窗口真实呈现（X 像素）', 'skip', '缺 import/identify（装 imagemagick）⇒ 无法判定')
    return
  }
  const wid = tryExec('bash', [
    '-lc',
    `xwininfo -root -children 2>/dev/null | grep -iE 'Corum|Harness' | awk '{print $1}' | head -1`,
  ])
  if (!wid) {
    record('fast', '窗口真实呈现（X 像素）', 'fail', `DISPLAY=${display} 上找不到应用窗口`)
    return
  }
  // 抬到最前，避免 root 裁剪抓到别的窗口（合成器下这一步直接影响判据可信度）。
  tryExec('bash', ['-lc', `xdotool windowactivate ${wid} 2>/dev/null; xdotool windowraise ${wid} 2>/dev/null; sleep 1`])

  const uniqOf = (path) => {
    if (!existsSync(path)) return -1
    const n = Number(tryExec('identify', ['-format', '%k', path]) ?? '-1')
    return Number.isFinite(n) ? n : -1
  }
  const force = (p) => {
    try {
      execFileSync('rm', ['-f', p])
    } catch {}
  }

  // 抓法 ①：窗口自身 pixmap（Xvfb/无合成器下可靠）
  const direct = join(OUT, 'window-direct.png')
  force(direct)
  tryExec('bash', ['-lc', `import -window ${wid} ${direct} 2>/dev/null || true`])
  const directN = uniqOf(direct)

  // 抓法 ②：整屏 + 按窗口几何裁剪（mutter 等合成器下必需）
  const geo = tryExec('xwininfo', ['-id', wid]) ?? ''
  const gx = Number(/(?:Absolute upper-left X):\s*(-?\d+)/.exec(geo)?.[1] ?? NaN)
  const gy = Number(/(?:Absolute upper-left Y):\s*(-?\d+)/.exec(geo)?.[1] ?? NaN)
  const gw = Number(/Width:\s*(\d+)/.exec(geo)?.[1] ?? NaN)
  const gh = Number(/Height:\s*(\d+)/.exec(geo)?.[1] ?? NaN)
  const root = join(OUT, 'screen.png')
  const crop = join(OUT, 'window-crop.png')
  force(root)
  force(crop)
  let cropN = -1
  if ([gx, gy, gw, gh].every(Number.isFinite) && gw > 0 && gh > 0) {
    tryExec('bash', ['-lc', `import -window root ${root} 2>/dev/null || true`])
    tryExec('bash', ['-lc', `convert ${root} -crop ${gw}x${gh}+${gx}+${gy} +repage ${crop} 2>/dev/null || true`])
    cropN = uniqOf(crop)
  }

  const best = Math.max(directN, cropN)
  const detail = `窗口 ${wid}（${gw}x${gh}+${gx}+${gy}）唯一色：直接抓=${directN}、屏幕裁剪=${cropN}`
  // 阈值 500：实测「空白窗口」118~188 色，「有内容」1959~36301 色。
  if (best >= 500) {
    record('fast', '窗口真实呈现（X 像素）', 'pass', `${detail} ⇒ 取最大值 ${best}`)
  } else {
    record('fast', '窗口真实呈现（X 像素）', 'fail', `${detail} ⇒ **窗口是空白的**（渲染器可能有内容但没显示出来）`)
  }
}

/** 全档：原生模块真加载（不是「文件在」）。 */
function checkNativeModules() {
  const desk = join(repoRoot, 'packages/desktop')
  const script = `
    const out = {};
    try {
      const pty = require('node-pty');
      out.pty = new Promise(r => {
        const p = pty.spawn('/bin/sh', ['-c', 'echo PTY_OK'], { name: 'xterm-color', cols: 80, rows: 24 });
        let buf = '';
        p.onData(d => { buf += d });
        p.onExit(() => r(buf.includes('PTY_OK') ? 'PTY_OK' : 'no-output:' + buf.slice(0,40)));
        setTimeout(() => r('timeout'), 5000);
      });
    } catch (e) { out.pty = Promise.resolve('load-failed: ' + e.message.slice(0,80)) }
    try { require('koffi'); out.koffi = 'loaded' } catch (e) { out.koffi = 'load-failed: ' + e.message.slice(0,80) }
    out;
  `
  const raw = tryExec('node', ['-e', script], { cwd: desk })
  if (!raw) {
    record('full', '原生模块加载（node-pty/koffi）', 'fail', '子进程无输出')
    return
  }
  try {
    const parsed = JSON.parse(raw.replace(/Promise \{.*?\}/g, '"pending"'))
    record('full', '原生模块加载（node-pty/koffi）', 'pass', `koffi=${parsed.koffi}；pty 异步检查见下项`)
  } catch {
    record('full', '原生模块加载（node-pty/koffi）', 'pass', raw.slice(0, 200))
  }
}

/** 全档：node-pty 真能开出 PTY（同步判定，避免异步 JSON 的麻烦）。 */
function checkPtySpawn() {
  const desk = join(repoRoot, 'packages/desktop')
  const one = `
    try {
      const pty = require('node-pty');
      const p = pty.spawn('/bin/sh', ['-c', 'echo PTY_OK'], { name: 'xterm-color', cols: 80, rows: 24 });
      let buf = '';
      p.onData(d => { buf += d });
      p.onExit(() => { console.log(buf.includes('PTY_OK') ? 'PASS' : 'FAIL:' + buf.slice(0,60)); process.exit(0) });
      setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 6000);
    } catch (e) { console.log('LOADFAIL:' + e.message.slice(0,100)); process.exit(1) }
  `
  const raw = tryExec('node', ['-e', one], { cwd: desk })
  if (raw === 'PASS') record('full', 'node-pty 真开 PTY', 'pass', '子进程输出 PTY_OK')
  else record('full', 'node-pty 真开 PTY', 'fail', `未开出 PTY：${raw ?? '(无输出)'} ⇒ Agent 的 bash 工具会失败`)
}

/**
 * 全档：沙箱**真的在约束**（不是「bwrap 能跑」就算）。
 *
 * 判据（内层 sh 的退出码，三态可区分）：
 *   0  = 工作区内写成功 **且** 区外写被拒 ⇒ 沙箱在约束（通过）
 *   10 = 工作区内都写不进去 ⇒ 沙箱过紧（失败）
 *   20 = 区外写成功了 ⇒ **沙箱没在约束**（失败，最严重）
 *
 * ⚠️ 「区外」路径**不能放在 OUT 里**：本仓的 bwrap profile 带 `--tmpfs /tmp`，
 * 而默认 OUT 就在 `/tmp` 下 ⇒ 把探测目标放 `/tmp` 里会落进可写的 tmpfs，
 * 于是「越界写成功」被判成没约束（本脚本第一版就踩了，实测 `exit=null`）。
 * 故探测目标取 `/etc` 下的临时名（容器内 `/` 是 `--ro-bind`，写入必然 EROFS）。
 */
function checkSandboxEnforcement() {
  if (platform !== 'linux') {
    record('full', '沙箱真约束（越界写被拒）', 'skip', `非 Linux（${platform}）`)
    return
  }
  const ws = join(OUT, 'sandbox-ws')
  mkdirSync(ws, { recursive: true })
  // 清掉上一轮痕迹，否则「区内写成功」会假绿。
  const insideFile = join(ws, 'written-inside')
  try {
    execFileSync('rm', ['-f', insideFile])
  } catch {}
  const outside = `/etc/corum-smoke-write-probe-${process.pid}`
  try {
    execFileSync('rm', ['-f', outside])
  } catch {}

  const inner = `echo ok > ${insideFile} || exit 10; echo bad > ${outside} 2>/dev/null && exit 20; exit 0`
  const probe =
    `set +e\n` +
    `bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent ` +
    `--tmpfs /tmp --bind ${ws} ${ws} /bin/sh -c '${inner}'\n` +
    `printf '%s' $?`
  const code = tryExec('bash', ['-lc', probe])

  const insideOk = existsSync(insideFile)
  const outsideLeaked = existsSync(outside)
  if (outsideLeaked) {
    try {
      execFileSync('rm', ['-f', outside])
    } catch {}
  }
  const ev = `内层退出码=${code}（0=符合预期 / 10=区内写不进 / 20=越界写成功）区内写文件=${insideOk} 越界文件泄漏=${outsideLeaked}`

  if (code === '0' && insideOk && !outsideLeaked) {
    record('full', '沙箱真约束（越界写被拒）', 'pass', `${ev} ⇒ 工作区内可写、区外被拒`)
  } else {
    record('full', '沙箱真约束（越界写被拒）', 'fail', ev)
  }
}

/**
 * 全档：Agent 真跑一轮（含一次 bash 工具调用）。
 *
 * 需要可用的 LLM 凭据；没有就**记 skip 并说明**，绝不假装通过。
 */
async function checkAgentRound(cdp, sessionId) {
  const cred = join(process.env.HOME ?? '/root', '.corum', '.credentials.yaml')
  const hasCred = existsSync(cred) && readFileSync(cred, 'utf8').trim().length > 0
  if (!hasCred) {
    record('full', 'Agent 真跑一轮 bash', 'skip', `无 LLM 凭据（${cred}）⇒ 需用户提供密钥或授权配置模型后才可判定`)
    return
  }
  record('full', 'Agent 真跑一轮 bash', 'skip', '凭据存在但本版尚未实现自动驱动（见台账登记）')
}

// ─────────────────────────── 编排 ───────────────────────────

/**
 * 凭证加密（safeStorage / 钥匙串）启动期判据 —— **发布门禁**。
 *
 * 由来（2026-10-09 实测事故）：`packages/desktop/package.json` 的 electron 是
 * `^43.4.0` 浮动 range，一次 `pnpm install` 把它从 43.4.1 解析到 43.7.9 ⇒ 二进制
 * cdhash 改变 ⇒ macOS 钥匙串条目 `corum-desktop Safe Storage` 的 ACL 失配 ⇒ 系统弹
 * 「输入登录密码」，而 `safeStorage.isEncryptionAvailable()` 在等授权时**阻塞**；
 * 用户取消后 `userCanceledErr` → 主密钥拿不到 → **整棵插件树拒绝加载、应用起不来**。
 *
 * 判据（用户 2026-10-09 拍板：**打包态必须拦住，dev 允许降级**）：
 * 1. 启动日志**不得**出现 `safeStorage unavailable` / `Keychain lookup failed` /
 *    `master key is unavailable` / `plugin tree failed to load` 任一 —— 这是「产物在这台
 *    机器上拿不到钥匙串」的直接证据，也正是用户看到的那个弹窗的后果。
 * 2. `$CORUM_HOME/.master-key` 存在且权限为 `0600`（钥匙串封装态落盘的事实）。
 * 3. 正向信号：日志出现 `host ready`（说明 host 子进程真的起来了，不是「没报错但也没起来」）。
 *
 * ⚠️ **只在 `--packaged` 时判 fail**：dev 态按用户裁定允许降级启动（策略
 * `degrade`），此时上述行会以 `warn` 形态出现，故记为 skip 并说明。
 * ⚠️ 不写真凭据、零副作用：只读启动日志与 `.master-key` 元数据。
 */
function checkCredentialEncryption() {
  if (!DO_LAUNCH) {
    record('fast', '凭证加密（safeStorage/钥匙串）', 'skip', '未自启动（无 --launch）⇒ 无启动日志可判')
    return
  }
  if (!existsSync(LAUNCH_LOG)) {
    record('fast', '凭证加密（safeStorage/钥匙串）', 'skip', `未捕获到启动日志（${LAUNCH_LOG}）`)
    return
  }
  const text = readFileSync(LAUNCH_LOG, 'utf8')
  const fatal = [
    'safeStorage unavailable',
    'Keychain lookup failed',
    'master key is unavailable',
    'plugin tree failed to load',
    'refusing to store a credential in plaintext',
  ].filter((s) => text.includes(s))
  const hostReady = text.includes('host ready')

  // dev 降级是**用户裁定允许**的路径，故只报告、不判失败。
  if (!PACKAGED) {
    const degraded = fatal.length > 0
    record(
      'fast',
      '凭证加密（safeStorage/钥匙串）',
      'skip',
      degraded
        ? `dev 态按裁定允许降级（未告警项以 warn 记）：命中 ${fatal.join('、')}`
        : `dev 态无降级迹象${hostReady ? '（host ready）' : ''}`,
    )
    return
  }

  const home = process.env.CORUM_HOME ?? join(process.env.HOME ?? '', '.corum')
  const keyFile = join(home, '.master-key')
  const details = []
  let ok = true
  if (fatal.length > 0) {
    ok = false
    details.push(`启动日志命中致命行：${fatal.join('、')}`)
  }
  if (!existsSync(keyFile)) {
    ok = false
    details.push(`${keyFile} 不存在（打包产物没能用钥匙串封装出主密钥）`)
  } else {
    // 0600 是凭据层「文件保护不被伪造」的基线（见 value-crypto 模块头）。
    const mode = (statSync(keyFile).mode & 0o777).toString(8)
    if (mode !== '600') {
      ok = false
      details.push(`${keyFile} 权限 ${mode} ≠ 600`)
    } else {
      details.push(`${keyFile} 0600`)
    }
  }
  if (!hostReady) {
    ok = false
    details.push('启动日志无 `host ready`（host 子进程未起来）')
  }
  record(
    'fast',
    '凭证加密（safeStorage/钥匙串）',
    ok ? 'pass' : 'fail',
    ok ? `打包产物自行取到钥匙串：${details.join('；')}；日志 ${LAUNCH_LOG}` : details.join('；'),
  )
}

/**
 * 打包产物的 **Electron 身份**是否等于 pin（`scripts/electron-pin.json`）。
 *
 * 为什么单列这一项（它和凭证判据是一条链的两端）：凭证判据断言「产物**这次**取到了
 * 钥匙串」；本项断言「产物里装的**正是那个被授权的二进制**」。二者互补——
 * 只看前者，一个碰巧被授权的错产物也能通过；只看后者，一个身份正确但授权失败的
 * 产物也会漏过。合起来才闭环：*这个字节的去运行过，且它这次真的取到了钥匙串*。
 *
 * 只在 `--packaged` 判 fail；dev 态由 `scripts/verify-electron-pin.mjs` 在打包前把关。
 */
function checkPackagedElectronIdentity() {
  if (!PACKAGED || !DO_LAUNCH) {
    record('fast', '打包产物 Electron 身份 = pin', 'skip', '仅 --packaged --launch 时判定')
    return
  }
  let exe
  try {
    exe = packagedExecutable()
  } catch (e) {
    record('fast', '打包产物 Electron 身份 = pin', 'fail', e.message)
    return
  }
  const pinPath = join(repoRoot, 'scripts/electron-pin.json')
  if (!existsSync(pinPath)) {
    record('fast', '打包产物 Electron 身份 = pin', 'fail', `缺 ${pinPath}（Electron 版本锁的唯一事实源）`)
    return
  }
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  const pinKey = `${platform}-${arch}`
  const recorded = pin.identities?.[pinKey]
  if (recorded === undefined) {
    record('fast', '打包产物 Electron 身份 = pin', 'fail', `pin 未记录 ${pinKey} 的二进制身份（先跑 --record 采集）`)
    return
  }
  const got = createHash('sha256').update(readFileSync(exe)).digest('hex')
  if (got !== recorded.sha256) {
    record(
      'fast',
      '打包产物 Electron 身份 = pin',
      'fail',
      `产物二进制 sha256 ≠ pin 记录：\n      期望 ${recorded.sha256}\n      实际 ${got}\n`
      + `      产物：${exe}`,
    )
    return
  }
  record('fast', '打包产物 Electron 身份 = pin', 'pass', `${pinKey} sha256=${got.slice(0, 16)}… 与 pin 一致`)
}

/**
 * 定位打包产物里的可执行文件（`--packaged` 用）。
 *
 * 平台差异：macOS 是 `dist/mac-<arch>/<product>.app/Contents/MacOS/<product>`；
 * Linux 是 `dist/linux-<arch>-unpacked/<product>`；Windows 是
 * `dist/win-<arch>-unpacked/<product>.exe`。
 * @returns 可执行文件绝对路径。
 */
function packagedExecutable() {
  const dist = join(repoRoot, 'packages/desktop/dist')
  const candidates = [
    join(dist, `mac-${arch}`, 'Corum.app/Contents/MacOS/Corum'),
    join(dist, `mac-${arch === 'arm64' ? 'arm64' : 'x64'}`, 'Corum.app/Contents/MacOS/Corum'),
    join(dist, `linux-${arch}-unpacked`, 'Corum'),
    join(dist, `win-${arch}-unpacked`, 'Corum.exe'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(
    `未找到打包产物可执行文件（先跑 npm run pack）。已找过：\n  ${candidates.join('\n  ')}`,
  )
}

/**
 * 启动被测应用，并把它的 stdout/stderr 落到 `OUT/launch.log`。
 *
 * 为什么必须收日志（2026-10-09）：凭证加密的失效**不在渲染层**
 * ——它发生在 host 子进程 boot 早期，表现为「`safeStorage unavailable` →
 * `master key is unavailable` → `plugin tree failed to load`」。旧实现用
 * `stdio:'ignore'` 把这些行**全丢掉**，于是「窗口起不来」只能看到超时，
 * 拿不到原因，更无法把「主密钥拿不到」这条判成发布门禁。改收日志后，
 * 判据可直接落在这些启动行上（见 checkCredentialEncryption）。
 *
 * ⚠️ `--packaged` **直接 exec 产物**，不经 `corum-instance.sh --mode=packaged`
 * ——后者会自动用 dev 身份的 Electron 解出并**注入** `CORUM_CREDENTIALS_MASTER_KEY`
 * （见该脚本 `resolve_master_key`）。那会让本项判据**必然通过**（假绿）：
 * 我们要验的正是「打包产物**自己在真实用户路径上**能不能拿到钥匙串」。
 *
 * ⚠️ **必须同时设 `CORUM_DEBUG_PORT` 环境变量**（2026-10-09 实测踩到）：
 * 应用的 user-data-dir 取自**env**（`main.ts` 的
 * `corum-desktop-ud-${CORUM_DESKTOP_MODE}-${CORUM_DEBUG_PORT ?? 'noport'}`），
 * 而单实例锁建立在 user-data-dir 上。原先只传 argv `--remote-debugging-port`
 * ⇒ env 里没有 ⇒ 所有冲烟实例都落到 `…-ud-minimal-noport` **同一个锁**上：
 * ① 有残留实例时，新实例打印 `another instance already owns the lock` 后
 * **静默退出**，表现为「窗口起不来」（假失败）；② 更危险的是，若那个残留实例
 * 恰好也在监听同一个 CDP 端口，本脚本会**附着到旧产物**上 ⇒ 验的是旧包却报告
 * 新包通过（**假绿**）。故这里显式设 env，让每个端口拿到自己的 user-data-dir 与锁。
 * @returns 子进程 pid。
 */
function launchApp() {
  const log = openSync(LAUNCH_LOG, 'w')
  let cmd
  let args
  let cwd
  if (PACKAGED) {
    cmd = packagedExecutable()
    cwd = dirname(cmd)
    args = [`--remote-debugging-port=${PORT}`]
    // root 下 Chromium 必须把该标志写进 argv（appendSwitch 来不及，见台账
    // bug.electron-root-requires-no-sandbox-flag-in-argv-not-appendSwitch）。
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
  } else {
    const desk = join(repoRoot, 'packages/desktop')
    const cli = join(desk, 'lib/cli.js')
    if (!existsSync(cli)) throw new Error(`未构建：${cli}（先 npm run build）`)
    cmd = process.execPath
    cwd = desk
    args = [cli, `--remote-debugging-port=${PORT}`]
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
  }
  // 不继承本进程的凭证相关注入：否则「产物能否自己拿到钥匙串」这条会被掩盖。
  const env = { ...process.env }
  delete env.CORUM_CREDENTIALS_MASTER_KEY
  delete env.CORUM_CREDENTIALS_KEY_UNAVAILABLE
  // 见上面的 ⚠️：env 里的端口决定 user-data-dir 与单实例锁，必须与 argv 一致。
  env.CORUM_DEBUG_PORT = String(PORT)
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', log, log], env })
  child.unref()
  return child.pid
}

/**
 * 启动前确认目标 CDP 端口空闲（防「附着到旧实例」这一类假绿）。
 *
 * 为什么必须有：本脚本的判据是「连上 :PORT 的主页面 + 读 launch.log」。若端口上
 * 已经有一个**别的**实例（上一次冲烟的残留、或用户自己起的），waitPage 会连上它、
 * launch.log 却来自刚起的新进程 ⇒ **两者可能不是同一个进程**，结论就不可信。
 * 宁可明确失败，也不要给出一个来源混杂的"通过"。
 *
 * ⚠️ **判定用 TCP 连接，不用 `lsof`**（红线 7：三平台）：Windows 默认没有 `lsof`，
 * 依赖它会让守卫在 Windows 上**静默失效（fail-open）**——正是最该拦住的情形却放行。
 * 故用 Node `net` 直连（三平台一致）；`lsof` 仅作**尽力而为**的附带信息（报告 pid），
 * 拿不到就不报，绝不影响「是否占用」这个判定本身。
 * @param port - 待检查端口。
 * @returns 占用该端口的 pid 列表（可能为空数组，但 occupied 仍可能为 true）。
 */
function portHolders(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    return out.split('\n').map((s) => s.trim()).filter((s) => s !== '')
  } catch {
    // lsof 不存在（Windows）或无占用 —— 都返回空；占用与否由下面的 TCP 探测决定。
    return []
  }
}

/**
 * 端口是否已被监听（三平台通用的判据：能否建立 TCP 连接）。
 * @param port - 待检查端口。
 * @returns 是否有进程在监听。
 */
function portInUse(port) {
  return new Promise((resolvePromise) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    const done = (inUse) => {
      socket.destroy()
      resolvePromise(inUse)
    }
    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function main() {
  repoRoot = resolveRepoRoot()
  mkdirSync(OUT, { recursive: true })
  if (PORT === MAIN_PORT) {
    // 这是**刻意的拒绝**，不是崩溃 —— 打一句干净的说明就退出，不要甩栈。
    console.error(
      `\n拒绝在 :${MAIN_PORT} 上跑冲烟 —— 那是用户主实例（会读到/扰动用户真实会话）。\n用 CDP_PORT=9333（或别的空闲端口）重试。\n`,
    )
    process.exit(2)
  }
  if (!AS_JSON) {
    console.log(`\ncorum 冲烟测试（${MODE === 'full' ? '全档' : '快档'}）  端口=:${PORT}  平台=${platform}/${arch}`)
    console.log(`仓库=${repoRoot}\n证据目录=${OUT}\n`)
  }

  // ── 静态前置（不需要应用在跑）
  checkNodeRuntimePlatform()
  checkSandboxPrereq()
  if (MODE === 'full') {
    checkPtySpawn()
    checkSandboxEnforcement()
  }

  // ── 启动/附着
  if (DO_LAUNCH) {
    // 端口必须空闲：否则可能「连上旧实例的 CDP、读新实例的 log」⇒ 结论来源混杂。
    // 这正是 2026-10-09 实际踩到的形态（残留实例占着 user-data 锁 + 端口）。
    // 判定用 TCP 连接（三平台通用）；lsof 仅用于附带报告 pid。
    if (await portInUse(PORT)) {
      const holders = portHolders(PORT)
      record(
        'fast',
        '应用自启动',
        'fail',
        `端口 :${PORT} 已被占用${holders.length > 0 ? `（pid ${holders.join(', ')}）` : ''} —— 拒绝启动。`
        + ' 否则可能附着到旧实例（验的是旧进程却报告新进程通过，假绿）。'
        + ` 处置：停掉它，或换 CDP_PORT 重跑（当前 ${PORT}）。`,
      )
      // 直接收尾：没有自启动就没有可信的判据，继续跑只会产出误导性结论。
      const failsEarly = results.filter((r) => r.state === 'fail')
      if (AS_JSON) process.stdout.write(`${JSON.stringify({ port: PORT, pass: 0, fail: failsEarly.length, skip: 0, results }, null, 2)}\n`)
      else {
        console.log(`\n结果：通过 0 / 失败 ${failsEarly.length} / 跳过 0`)
        console.log('中止：端口被占，未启动自己的实例（避免附着到旧实例）。')
      }
      process.exit(1)
    }
    try {
      const pid = launchApp()
      record('fast', '应用自启动', 'pass', `pid=${pid}（等待 CDP）`)
    } catch (e) {
      record('fast', '应用自启动', 'fail', e.message)
    }
  }

  let cdp = null
  let sessionId = null
  try {
    const page = await waitPage(DO_LAUNCH ? 90_000 : 15_000)
    cdp = await connect(page.webSocketDebuggerUrl)
    // 开域以便捕获控制台/日志错误；再做一次 reload，把**启动期**的错误也收进来。
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.enable')
    cdp.events.length = 0
    await cdp.send('Page.reload', { ignoreCache: false })
    await new Promise((r) => setTimeout(r, 6000))
    record('fast', 'CDP 连上主页面', 'pass', `url=${page.url.slice(0, 70)}`)
  } catch (e) {
    record('fast', 'CDP 连上主页面', 'fail', e.message)
  }

  if (cdp) {
    // DOM 渲染判据：标题 + 关键界面文案。
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){return JSON.stringify({
          title: document.title,
          rs: document.readyState,
          txt: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0,400),
          htmlLen: document.body ? document.body.innerHTML.length : 0
        })})()`,
        returnByValue: true,
      })
      const v = JSON.parse(r.result.value)
      const looksRendered = v.rs === 'complete' && v.htmlLen > 500
      record(
        'fast',
        'DOM 渲染（界面有内容）',
        looksRendered ? 'pass' : 'fail',
        `title="${v.title}" readyState=${v.rs} html=${v.htmlLen}B 文本="${v.txt.slice(0, 90)}"`,
      )
    } catch (e) {
      record('fast', 'DOM 渲染（界面有内容）', 'fail', e.message)
    }

    // 控制台零错误（reload 之后收集的启动期错误）。
    const { errors: errs, benign } = collectConsoleErrors(cdp.events)
    const benignNote = benign.length > 0 ? `；已知噪声 ${benign.length} 条（${benign[0].known}）` : ''
    if (errs.length === 0) {
      record('fast', '控制台零错误（reload 后）', 'pass', `捕获 ${cdp.events.length} 条事件，0 条真错误${benignNote}`)
    } else {
      record('fast', '控制台零错误（reload 后）', 'fail', `${errs.length} 条：\n      - ${errs.slice(0, 5).join('\n      - ')}`)
    }

    if (MODE === 'full') await checkAgentRound(cdp, sessionId)
  }

  // 凭证加密（发布门禁，用户 2026-10-09 拍板）：打包态必须自行取到钥匙串。
  checkCredentialEncryption()

  // 打包产物的 Electron 身份 = pin（与上一条互补，合成闭环）。
  checkPackagedElectronIdentity()

  // 真实像素（需 DISPLAY；X 层判据，能抓出「DOM 正常但窗口空白」）
  checkRealPixels()

  if (cdp) cdp.close()

  // ── 汇总
  const fails = results.filter((r) => r.state === 'fail')
  const skips = results.filter((r) => r.state === 'skip')
  const passes = results.filter((r) => r.state === 'pass')
  const summary = {
    mode: MODE,
    port: PORT,
    platform: `${platform}/${arch}`,
    repo: repoRoot,
    pass: passes.length,
    fail: fails.length,
    skip: skips.length,
    results,
  }
  writeFileSync(join(OUT, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`)

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    console.log(`\n结果：通过 ${passes.length} / 失败 ${fails.length} / 跳过 ${skips.length}`)
    if (skips.length > 0) {
      console.log('跳过项（**不等于通过**，逐条看原因）：')
      for (const s of skips) console.log(`  - ${s.name}：${s.detail.slice(0, 110)}`)
    }
    if (fails.length > 0) console.log('失败项：')
    for (const f of fails) console.log(`  ✗ ${f.name}：${f.detail.slice(0, 200)}`)
    console.log(`证据与机器可读结果：${OUT}/result.json`)
  }
  process.exit(fails.length > 0 ? 1 : 0)
}

await main().catch((e) => {
  if (AS_JSON) process.stdout.write(`${JSON.stringify({ error: String(e?.message ?? e) }, null, 2)}\n`)
  else console.error(`冲烟测试崩了：${e?.stack ?? e}`)
  process.exit(2)
})
