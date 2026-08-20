/**
 * corum-shell Electron main entry: the shell (combo manager).
 *
 * 纯壳不携带 DSH_HOME 和 dsh 内容（cli.ts 已净化环境）：启动后先显示壳自
 * 带的 combo 管理页（corumapp://combo/index.html），用户选择 combo 后，壳
 * 按该 combo 注入环境变量 / 工作目录 / 覆盖规则（CORUM_COMBO_PLUGINS /
 * CORUM_COMBO_PATCHES），spawn 一个独立的 dsh host 子进程（SYSTEM Node，
 * lib/bridge.js），再把窗口切到 dsh client 页面（?combo=<id>）。切换 combo
 * = 换 host 进程。
 *
 * `--smoke` 跳过 combo 页：以无 combo 的 web profile 启动 host，等待渲染端
 * 连接握手（host.describe unary 到达）后退出 0。
 * `--combo=<id>` 跳过 combo 页直接进入指定 combo（开发快捷方式）。
 * @module corum-shell/electron/main
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { registerSchemes, registerProtocols } from './protocol.ts'
import { registerIpc } from './ipc.ts'
import { HostBridgeClient, type BridgeReady } from './bridge-client.ts'
import { findCombo, touchCombo, type Combo } from './combos.ts'

/**
 * Whether this launch runs from a packaged bundle: the bundled host runtime
 * lives at `Resources/host` only in a packaged app (extraResource). More
 * reliable than `app.isPackaged`, which reports false when the binary is run
 * directly (`.app/Contents/MacOS/<name>`).
 */
function isPackaged(): boolean {
  return existsSync(join(process.resourcesPath, 'host', 'lib', 'bridge.js'))
}

/**
 * Dist location. Packaged: `Resources/dist/index.html` (extraResource); dev:
 * resolved through the frontend package exports.
 */
function resolveDistIndex(): string {
  if (isPackaged()) return join(process.resourcesPath, 'dist', 'index.html')
  const require = createRequire(import.meta.url)
  return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
}

/**
 * The Node binary that runs the host child. Packaged: the bundled official
 * Node at `Resources/node/bin/node`; dev: the CLI launcher's process.execPath.
 */
function hostNode(): string {
  if (isPackaged()) return join(process.resourcesPath, 'node', 'bin', 'node')
  return process.env.CORUM_HOST_NODE ?? 'node'
}

/** Absolute path of the host bridge entry (packaged: inside Resources/host). */
function bridgePath(): string {
  if (isPackaged()) return join(process.resourcesPath, 'host', 'lib', 'bridge.js')
  return join(dirname(fileURLToPath(import.meta.url)), 'bridge.js')
}

/** Absolute directory of the bundled Monaco language workers. */
function monacoWorkersPath(): string {
  if (isPackaged()) return join(process.resourcesPath, 'host', 'lib', 'workers')
  return join(dirname(fileURLToPath(import.meta.url)), 'workers')
}

/** Absolute directory of the shell-owned static images (brand logo / ambient). */
function shellAssetsPath(): string {
  if (isPackaged()) return join(process.resourcesPath, 'assets')
  // dev: lib/main.js → packages/shell/assets（源码静态资源目录）。
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
}

/** Whether this launch is the keyless smoke check. */
const SMOKE = process.argv.includes('--smoke')

/** `--combo=<id>` 的值（如有）。兼容 `--combo=coding` 与 `--combo coding` 两种写法。 */
function comboArg(): string | null {
  for (const arg of process.argv) {
    if (arg.startsWith('--combo=')) {
      const value = arg.slice('--combo='.length)
      return value === '' ? null : value
    }
  }
  const idx = process.argv.indexOf('--combo')
  const value = idx >= 0 ? process.argv[idx + 1] : undefined
  return value !== undefined && value !== '' ? value : null
}

/**
 * 跳过 combo 页直接进入的初始 combo（开发快捷方式）：`--combo=<id>` 显式指定。
 * 默认（无参数）停在壳的 combo 启动器页——IDE（coding）等只是 combo 之一，
 * 通过启动器点击进入，不设特殊 flag。
 */
const INITIAL_COMBO_ID = comboArg()

/**
 * Dev mode (HMR enabled): forward the renderer console to stderr so hot-swap
 * logs (`corum-shell-hmr: hot-swapped ...`) and renderer errors stay visible in
 * the terminal that launched the shell. The smoke check always forwards.
 */
const DEV = process.env.CORUM_DEV_HMR !== undefined && process.env.CORUM_DEV_HMR !== ''

let mainWindow: BrowserWindow | null = null
let quitting = false
/** 当前 host bridge（combo 切换时整体替换）。 */
let bridge: HostBridgeClient | null = null
/** 当前协议集（首次 spawn 后注册；热重启时 update）。 */
let protocols: ReturnType<typeof registerProtocols> | null = null

/** Smoke completion: resolved once the renderer's first unary arrives. */
let settleSmoke: ((ok: boolean) => void) | undefined

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'DeepSeek Harness',
    show: !SMOKE,
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // 主窗关闭 = 退出整个 app（连带所有脱出的浮动窗）。浮动窗没有独立存活
    // 意义——它渲染的是主窗会话的内容，主窗没了它就成了孤儿。走 app.quit()
    // 触发 before-quit 的会话 flush，再退出。
    app.quit()
  })
  if (SMOKE || DEV) {
    mainWindow.webContents.on('console-message', (details, ...rest) => {
      // Electron ≥ 30: first arg is an Event<WebContentsConsoleMessageEventParams>
      // (object carrying `message`/`level`); the legacy positional args follow.
      const message = typeof details === 'object' && details !== null
        ? (details as { message?: unknown }).message ?? rest[1]
        : details
      const level = typeof details === 'object' && details !== null
        ? (details as { level?: unknown }).level ?? rest[0]
        : rest[0]
      process.stderr.write(`[renderer:${String(level)}] ${String(message)}\n`)
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      process.stderr.write(`[smoke] renderer failed to load: ${code} ${description}\n`)
      app.exit(1)
    })
  }
}

/**
 * 按 combo 构造 host 子进程的环境：纯壳环境（cli.ts 已净化，不含 DSH_HOME
 * 等 dsh 内容）+ combo 声明的环境变量 + 插件集 / 覆盖规则的注入。
 * @param combo - null 表示无 combo（smoke）：不注入任何 dsh 派生参数。
 */
function buildHostEnv(combo: Combo | null): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  if (combo === null) return env
  for (const [key, value] of Object.entries(combo.env)) env[key] = value
  if (combo.plugins.length > 0) env.CORUM_COMBO_PLUGINS = combo.plugins.join(',')
  if (combo.patches.length > 0) env.CORUM_COMBO_PATCHES = combo.patches.join(',')
  return env
}

/** Dev HMR：把 host 子进程的 bundle-rebuilt 通知转发给当前窗口。 */
function sendHmr(id: string, rev: string): void {
  const win = mainWindow
  const deliverable = win !== null && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
  process.stderr.write(`[corum-shell-hmr] main relay: ${id} (rev ${rev}) → window ${deliverable ? 'deliver' : 'UNAVAILABLE'}\n`)
  if (deliverable) win.webContents.send('corum:hmr-event', { id, rev })
}

/**
 * 按 combo（或 null）spawn host 子进程。替换旧实例（combo 切换 = 换进程）；
 * 首次 spawn 注册协议集，之后 update；热重启（同实例 restart）只 update。
 * @returns 新 host 的 ready 负载。
 */
async function spawnHost(combo: Combo | null): Promise<BridgeReady> {
  if (bridge !== null) bridge.dispose()
  const next = new HostBridgeClient(hostNode(), bridgePath(), buildHostEnv(combo), combo?.cwd)
  bridge = next
  next.onHmr(sendHmr)
  const ready = await next.ready()
  protocols?.update(ready.graph, ready.clientPaths)
  next.onReady((nextReady) => {
    if (nextReady === ready) return // skip the initial spawn's handshake
    protocols?.update(nextReady.graph, nextReady.clientPaths)
    process.stderr.write(`[corum-shell] host child restarted (${nextReady.graph.entries.length} client entries)\n`)
  })
  return ready
}

/** 壳层 combo 启动：按 combo 注入并 spawn host，成功后窗口切到 dsh client。 */
async function launchCombo(id: string): Promise<{ ok: boolean; error?: string }> {
  const combo = findCombo(id)
  if (combo === null) return { ok: false, error: `unknown combo: ${id}` }
  touchCombo(id)
  try {
    const ready = await spawnHost(combo)
    process.stderr.write(`[corum-shell] combo "${combo.id}" host ready (${ready.graph.entries.length} client entries)\n`)
    const win = mainWindow
    if (win === null || win.isDestroyed()) return { ok: false, error: 'no window' }
    await win.loadURL(`corumapp://app/index.html?combo=${encodeURIComponent(combo.id)}`)
    return { ok: true }
  } catch (error) {
    process.stderr.write(`[corum-shell] combo "${combo.id}" launch failed: ${String(error)}\n`)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function main(): Promise<void> {
  // 多实例隔离：默认所有 corum-shell 实例会挤在同一个 user-data-dir
  // （~/Library/Application Support/Electron），共享 Chromium profile/锁/
  // 网络服务进程——一个实例（如 IDE 测试窗口）的渲染/网络崩溃会传染另一个
  // （如正在对话的窗口）。给每个实例独立的 user-data-dir：按 CORUM_HOME
  // （dev home）+ 调试端口区分，互不干扰。CORUM_USER_DATA_DIR 可显式覆盖。
  const userDataDir = process.env.CORUM_USER_DATA_DIR
    ?? join(os.tmpdir(), `corum-shell-ud-${process.env.CORUM_DESKTOP_MODE ?? 'minimal'}-${process.env.CORUM_DEBUG_PORT ?? 'noport'}`)
  app.setPath('userData', userDataDir)

  // Disable the Chromium sandbox unconditionally: the renderer loads only
  // this app's own trusted code (dist + our client bundles), and on unsigned
  // local builds macOS refuses sandbox initialization, which leaves the
  // window blank. This mirrors every local-dev Electron tool. Must run before
  // app.whenReady().
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  // CDP walkthrough (scripts/walkthrough-s4-shot.mjs): an opt-in remote-debugging
  // port so geometry/theme assertions and screenshots can run against the
  // live window. Off by default; zero effect on normal launches.
  const debugPort = process.env.CORUM_DEBUG_PORT
  if (debugPort !== undefined && debugPort !== '') {
    app.commandLine.appendSwitch('remote-debugging-port', debugPort)
    app.commandLine.appendSwitch('remote-allow-origins', '*')
  }
  registerSchemes()
  await app.whenReady()
  // 协议提前注册（无需 host）：combo 管理页（corumapp://combo/…）在纯壳阶段
  // 就能加载；boot graph 由后续 spawnHost 的 update() 注入。
  protocols = registerProtocols(undefined, {}, resolveDistIndex(), (html) => html, monacoWorkersPath(), shellAssetsPath())
  // 壳层 IPC 一次性注册：bridge 通过 getter 解析（combo 切换换实例）。
  registerIpc(() => bridge, () => mainWindow, {
    onUnary: (pathname) => {
      if (pathname === '/api/host.describe') settleSmoke?.(true)
    },
    launchCombo,
  })
  createWindow()
  process.stderr.write('[corum-shell] window created (combo launcher)\n')

  if (SMOKE) {
    // 无 combo 的 web profile 启动（等价旧 minimal boot），等渲染端握手。
    // settleSmoke 必须先挂载再 loadURL：渲染端 client JS 在 did-finish-load
    // 之前执行，握手 unary 可能在 loadURL 的 await 期间就到达——若此时
    // settleSmoke 尚未赋值，握手会被静默吞掉导致误报超时。
    await spawnHost(null)
    const outcome = new Promise<boolean>((resolve) => {
      settleSmoke = resolve
      setTimeout(() => resolve(false), 20_000)
    })
    await mainWindow?.loadURL('corumapp://app/index.html')
    if (await outcome) {
      process.stdout.write('corum-shell smoke: host child + IPC relay + renderer connection handshake OK\n')
      app.quit()
    } else {
      process.stderr.write('corum-shell smoke failed: renderer connection handshake timed out\n')
      app.exit(1)
    }
  } else if (INITIAL_COMBO_ID !== null) {
    const combo = findCombo(INITIAL_COMBO_ID)
    if (combo === null) {
      process.stderr.write(`[corum-shell] unknown initial combo: ${INITIAL_COMBO_ID}; staying on the launcher\n`)
      await mainWindow?.loadURL('corumapp://combo/index.html')
    } else {
      await launchCombo(combo.id)
    }
  } else {
    // 纯壳：显示 combo 管理页（壳自带静态页，零 dsh 依赖）。
    await mainWindow?.loadURL('corumapp://combo/index.html')
  }
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  // Durable-flush every live session's buffered log BEFORE the host child is
  // killed: the append-only log flushes at turn/idle boundaries, so a Cmd+Q /
  // window close otherwise strands the un-flushed tail (the torn frame the
  // repair pass then has to recover). Wait for the drain, then exit.
  void (async () => {
    try {
      if (bridge !== null) {
        const result = await bridge.sessionFlush()
        process.stderr.write(`[corum-shell] quit flush: ${result.ok ? `${result.flushed ?? 0} session(s) flushed` : `failed: ${result.error ?? '?'}`}\n`)
      }
    } catch (error) {
      process.stderr.write(`[corum-shell] quit flush error: ${String(error)}\n`)
    } finally {
      // The host child is killed when its parent exits; nothing else to dispose.
      app.exit(0)
    }
  })()
})

void main().catch((error) => {
  console.error('corum-shell fatal:', error instanceof Error ? error.stack ?? error.message : String(error))
  app.exit(1)
})
