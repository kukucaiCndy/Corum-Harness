/**
 * corum-shell Electron main entry: the UI shell. It spawns the host bridge
 * child (SYSTEM Node — the vendored Cordis loader's internal-ESM resolution
 * does not work inside Electron's embedded Node), registers the custom
 * protocols and the IPC relay, and opens the app window. `--smoke` boots
 * headlessly, waits for the renderer's connection handshake (a host.describe
 * unary arriving over IPC proves page load → shell boot → graph load → client
 * carrier → IPC → child → ApiProxy), then quits 0.
 * @module corum-shell/electron/main
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { registerSchemes, registerProtocols } from './protocol.ts'
import { registerIpc } from './ipc.ts'
import { HostBridgeClient } from './bridge-client.ts'

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

/** Whether this launch is the keyless smoke check. */
const SMOKE = process.argv.includes('--smoke')

/**
 * Normalize the `--ide` launch flag into the single environment variable the
 * host child reads to resolve the desktop mode. The CLI passes every argv
 * entry straight through to Electron (`...process.argv.slice(2)`), and the
 * host bridge inherits `process.env`, so setting it here BEFORE the child
 * spawns is the one source of truth for this launch's mode.
 */
if (process.argv.includes('--ide')) process.env.CORUM_DESKTOP_MODE = 'ide'

/**
 * Dev mode (HMR enabled): forward the renderer console to stderr so hot-swap
 * logs (`corum-shell-hmr: hot-swapped ...`) and renderer errors stay visible in
 * the terminal that launched the shell. The smoke check always forwards.
 */
const DEV = process.env.CORUM_DEV_HMR !== undefined && process.env.CORUM_DEV_HMR !== ''

let mainWindow: BrowserWindow | null = null
let quitting = false
/** The host bridge, set in main() so the quit hook can flush session logs. */
let hostBridge: HostBridgeClient | null = null

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
  void mainWindow.loadURL('corumapp://app/index.html')
}

async function main(): Promise<void> {
  // Disable the Chromium sandbox unconditionally: the renderer loads only
  // this app's own trusted code (dist + our client bundles), and on unsigned
  // local builds macOS refuses sandbox initialization, which leaves the
  // window blank. This mirrors every local-dev Electron tool. Must run before
  // app.whenReady().
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  // CDP walkthrough (scripts/walkthrough-ide.mjs): an opt-in remote-debugging
  // port so geometry/theme assertions and screenshots can run against the
  // live window. Off by default; zero effect on normal launches.
  const debugPort = process.env.CORUM_DEBUG_PORT
  if (debugPort !== undefined && debugPort !== '') {
    app.commandLine.appendSwitch('remote-debugging-port', debugPort)
    app.commandLine.appendSwitch('remote-allow-origins', '*')
  }
  registerSchemes()
  await app.whenReady()
  process.stderr.write('[corum-shell] spawning host child...\n')
  const bridge = new HostBridgeClient(hostNode(), bridgePath())
  hostBridge = bridge
  const ready = await bridge.ready()
  process.stderr.write(`[corum-shell] host child ready (${ready.graph.entries.length} client entries)\n`)
  const protocols = registerProtocols(ready.graph, ready.clientPaths, resolveDistIndex(), (html) => html, monacoWorkersPath())
  registerIpc(bridge, () => mainWindow, (pathname) => {
    if (pathname === '/api/host.describe') settleSmoke?.(true)
  })
  // Hot-restart: swap the served boot manifest to the new generation. The
  // window/page persist; the renderer reconnects and the next reload (or a
  // manual one) picks up rebuilt bundle revs.
  bridge.onReady((next) => {
    if (next === ready) return // skip the initial spawn's handshake
    protocols.update(next.graph, next.clientPaths)
    process.stderr.write(`[corum-shell] host child restarted (${next.graph.entries.length} client entries)\n`)
  })
  createWindow()
  process.stderr.write('[corum-shell] window created\n')
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  if (SMOKE) {
    const outcome = await new Promise<boolean>((resolve) => {
      settleSmoke = resolve
      setTimeout(() => resolve(false), 20_000)
    })
    if (outcome) {
      process.stdout.write('corum-shell smoke: host child + IPC relay + renderer connection handshake OK\n')
      app.quit()
    } else {
      process.stderr.write('corum-shell smoke failed: renderer connection handshake timed out\n')
      app.exit(1)
    }
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
      if (hostBridge !== null) {
        const result = await hostBridge.sessionFlush()
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
