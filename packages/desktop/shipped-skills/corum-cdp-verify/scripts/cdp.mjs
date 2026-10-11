/**
 * corum 桌面应用 CDP 驱动脚本（连 CORUM_DEBUG_PORT 主窗口）。
 *
 * 用法：
 *   node cdp.mjs eval '<js表达式>'        # Runtime.evaluate（returnByValue + awaitPromise）
 *   node cdp.mjs evalfile <path.js>       # 从文件读 JS 执行（推荐：避免 shell 转义地狱）
 *   node cdp.mjs shot <name>              # 截图到 ${CDP_OUT:-/tmp/corum-cdp/shots}/<name>.png
 *   node cdp.mjs evalshot '<js>' <name>   # eval + 截图
 *
 * 环境变量：
 *   CDP_PORT  CDP 端口（默认 9222，需与启动应用的 CORUM_DEBUG_PORT 一致）
 *   CDP_OUT   截图输出目录（默认 /tmp/corum-cdp/shots）
 *
 * 注意：访问 127.0.0.1:9222 在沙箱内会被拦截（Operation not permitted），
 * 需要提升权限（require_escalated）运行本脚本。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 主 checkout 解析（与 verify-instance.sh 同口径，2026-09-12 用户定调「脚本与技能原文
 * 打包进 CORUM_HOME 技能路径，不存在无法使用的问题」）：本脚本有两个部署位置
 * （仓库 `scripts/` 与技能包 `$CORUM_HOME/skills/corum-cdp-verify/scripts/`），
 * 也可能从隔离 worktree 的 cwd 调用——三处都要能定位到同一份主 checkout。
 * 优先级：CORUM_DESKTOP_PKG > CORUM_REPO > 脚本自身所在仓库 > cwd 的 git 主仓。
 * @returns 主 checkout 绝对路径；解析失败返回 undefined（调用方给出可执行下一步）。
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

// ws 从桌面应用包的 node_modules 解析（kkc-desktop/packages/desktop 下有 ws 依赖）。
const REPO_ROOT = resolveRepoRoot()
const DESKTOP_PKG = process.env.CORUM_DESKTOP_PKG
  ?? (REPO_ROOT === undefined ? undefined : join(REPO_ROOT, 'packages/desktop/package.json'))
if (DESKTOP_PKG === undefined || !existsSync(DESKTOP_PKG)) {
  process.stderr.write('[cdp] 找不到主 checkout 的 packages/desktop/package.json；'
    + '设 CORUM_REPO=<主 checkout 根> 或 CORUM_DESKTOP_PKG=<desktop/package.json> 后重试。'
    + '（隔离 worktree 里没有依赖，验证一律回主 checkout 跑。）\n')
  process.exit(2)
}
const require = createRequire(DESKTOP_PKG)
const WebSocket = require('ws')

// 默认端口 = **验证实例 :9333**（不是用户主实例 :9222）。2026-09-12 实测事故：子 Agent
// 跑 cdp.mjs 时没设 CDP_PORT → 默认 9222 → 驱动了**用户主实例**、读到用户真实会话，
// 并据此误判「:9333 宿主就是我」，差一步就去重启用户的应用。技能口径是「主实例永远
// 不要碰」，工具默认值就不该指向它。
const PORT = Number(process.env.CDP_PORT ?? 9333)
// 显式要打主实例时必须有意识：CORUM_ALLOW_MAIN=1（用户授权的一次性动作，例如派发任务）。
if (PORT === 9222 && process.env.CORUM_ALLOW_MAIN !== '1') {
  process.stderr.write('[cdp] 拒绝操作 :9222（用户主实例）。技能纪律：主实例永远不要碰——'
    + '验证一律打你自己的验证实例 :9333（CDP_PORT=9333 或省略即默认 9333）。'
    + '确实需要（例如用户当场授权派发/取证）时显式加 CORUM_ALLOW_MAIN=1。\n')
  process.exit(2)
}
const OUT = process.env.CDP_OUT ?? '/tmp/corum-cdp/shots'
mkdirSync(OUT, { recursive: true })

async function getJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`)
  if (!res.ok) throw new Error(`CDP http ${res.status}`)
  return res.json()
}
async function waitPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      // 主页面：旧 corumapp:// 自定义协议，或 0.1.2 起的官方 loopback webserver
      // （http://127.0.0.1:<ephemeral>/）。floating 窗排除。
      const t = (await getJson('/json/list')).find(x => x.type === 'page'
        && (x.url.startsWith('corumapp://') || x.url.startsWith('http://127.0.0.1:'))
        && !x.url.includes('floating='))
      if (t) return t
    } catch {}
    if (Date.now() > deadline) throw new Error('no main page (应用未启动或 CDP 端口不对)')
    await new Promise(r => setTimeout(r, 500))
  }
}
function connect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    let seq = 0
    const pending = new Map()
    ws.on('open', () => resolveConn({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { res, rej })
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
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
    ws.on('error', rejectConn)
  })
}

const page = await waitPage()
const version = await getJson('/json/version')
const cdp = await connect(version.webSocketDebuggerUrl)
const att = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
const sessionId = att.sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(exceptionDetails.exception?.description ?? exceptionDetails.text))
  return result.value
}
async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const f = `${OUT}/${name}.png`
  writeFileSync(f, Buffer.from(data, 'base64'))
  return f
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'eval') {
    console.log(JSON.stringify(await evaluate(rest[0]), null, 2))
  } else if (cmd === 'evalfile') {
    console.log(JSON.stringify(await evaluate(readFileSync(rest[0], 'utf8')), null, 2))
  } else if (cmd === 'shot') {
    console.log(await shot(rest[0]))
  } else if (cmd === 'evalshot') {
    console.log(JSON.stringify(await evaluate(rest[0]), null, 2))
    console.log(await shot(rest[1]))
  } else {
    console.error('usage: eval|evalfile|shot|evalshot')
    process.exit(2)
  }
} finally {
  cdp.close()
}
