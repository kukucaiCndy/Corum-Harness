/**
 * corum-desktop Electron main entry: the shell (combo manager).
 *
 * 纯壳不携带 DSH_HOME 和 dsh 内容（cli.ts 已净化环境）：启动后先显示壳自
 * 带的 combo 管理页（corumapp://combo/index.html），用户选择 combo 后，壳
 * 按该 combo 注入环境变量 / 工作目录 / 覆盖规则（CORUM_COMBO_PLUGINS /
 * CORUM_COMBO_PATCHES），spawn 一个独立的 dsh host 子进程（SYSTEM Node，
 * lib/bridge.js），再把窗口切到 dsh client 页面（?combo=<id>）。切换 combo
 * = 换 host 进程。
 *
 * `--smoke` 跳过 combo 页：以无 combo 的 web profile 启动 host，等待渲染端
 * 连接握手（api-gateway 的 generation source 发出 `$events/result` unary 或
 * 打开 `$events` 流）后退出 0。
 * `--combo=<id>` 跳过 combo 页直接进入指定 combo（开发快捷方式）。
 * @module corum-desktop/electron/main
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, nativeImage, session } from 'electron'
import { registerSchemes, registerProtocols } from './protocol.ts'
import { registerIpc } from './ipc.ts'
import { HostBridgeClient, type BridgeReady } from './bridge-client.ts'
import { findCombo, sanitizeComboEnv, touchCombo, type Combo } from './combos.ts'

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
  // dev: lib/main.js → packages/desktop/assets（源码静态资源目录）。
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
 * logs (`corum-desktop-hmr: hot-swapped ...`) and renderer errors stay visible in
 * the terminal that launched the shell. The smoke check always forwards.
 */
const DEV = process.env.CORUM_DEV_HMR !== undefined && process.env.CORUM_DEV_HMR !== ''

let mainWindow: BrowserWindow | null = null
let quitting = false
/** 当前 host bridge（combo 切换时整体替换）。 */
let bridge: HostBridgeClient | null = null
/** 当前协议集（只服务 combo 壳页 + shell 静态资源；dsh 页走官方 webserver）。 */
let protocols: ReturnType<typeof registerProtocols> | null = null

function createWindow(): void {
  // 窗口最小尺寸（2026-08-27 用户定调 + col-nav 调整 + 主窗口边距改 0 后重算）：
  // 以 IDE 布局声明的区域最小几何为硬下限，保证左侧导航栏 / 中间对话区 / 顶部
  // 标题栏在非全屏缩窗时完整显示，右侧编辑器/终端/资源管理器等压缩区不被压垮。
  // 主窗口边距已改 0（无 frame padding），推导（与 ide-layout.ts registerSlot 同源）：
  //   宽 = root row 三列最小宽之和 = sidebar 300 + convo 509 + right-col
  //        (max(editor 205 + explorer 205 = 410, panel 200 兜底) = 410) = 1219
  //   高 = max(left-col 需 标题栏40+内容200=240, right-col 需 row-top 200 + 终端227
  //        = 427) = 427（titlebar-row 在 left-col 全高内不额外占窗口高，右侧是瓶颈）
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1219,
    minHeight: 427,
    // 窗口标题（2026-08-28 改名）：中文「矩道」、英文「Corum」，按系统语言选。
    title: app.getLocale().startsWith('zh') ? '矩道' : 'Corum',
    show: !SMOKE,
    // macOS：隐藏原生标题栏但保留左上角红绿灯（hiddenInset 让灯位内联到
    // 内容区），顶部自定义栏由渲染层绘制（设置等按钮 + 整行 drag）。
    // Windows/Linux 此值表现为 hidden（无灯位），渲染层同样自绘顶栏。
    titleBarStyle: 'hiddenInset',
    // 红绿灯定位（2026-08-28）：与标题栏图标中线对齐。标题栏行高 40 → 图标
    // 中线 y=20；实测定标 y=13（y=14 偏低 2px、y=12 偏高 1px）。x=12 保持
    // 系统标准 inset。
    trafficLightPosition: { x: 12, y: 13 },
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  // 自检：上报实际生效的窗口最小尺寸（验证 minWidth/minHeight 是否被 Electron 采纳）。
  if (DEV) {
    const [mw, mh] = mainWindow.getMinimumSize()
    console.log(`[corum-shell] window min size effective: ${mw}x${mh}`)
  }
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
  // combo.env 先过黑名单（NODE_OPTIONS / DYLD_* / ELECTRON_RUN_AS_NODE 等解释器/
  // 链接器接管类 key 一律剔除并告警），再合并进子进程环境。
  for (const [key, value] of Object.entries(sanitizeComboEnv(combo.env))) env[key] = value
  if (combo.plugins.length > 0) env.CORUM_COMBO_PLUGINS = combo.plugins.join(',')
  if (combo.patches.length > 0) env.CORUM_COMBO_PATCHES = combo.patches.join(',')
  return env
}

/**
 * 按 combo（或 null）spawn host 子进程。替换旧实例（combo 切换 = 换进程）；
 * 热重启（同实例 restart）只换 ready 负载。dsh 页面走官方 webserver，协议集
 * 无需随 host 更新。
 * @returns 新 host 的 ready 负载（authenticatedUrl）。
 */
async function spawnHost(combo: Combo | null): Promise<BridgeReady> {
  if (bridge !== null) bridge.dispose()
  const next = new HostBridgeClient(hostNode(), bridgePath(), buildHostEnv(combo), combo?.cwd)
  bridge = next
  const ready = await next.ready()
  next.onReady((nextReady) => {
    if (nextReady === ready) return // skip the initial spawn's handshake
    process.stderr.write('[corum-desktop] host child restarted\n')
  })
  return ready
}

/** 壳层 combo 启动：按 combo 注入并 spawn host，成功后窗口切到官方 dsh web 页。 */
async function launchCombo(id: string): Promise<{ ok: boolean; error?: string }> {
  const combo = findCombo(id)
  if (combo === null) return { ok: false, error: `unknown combo: ${id}` }
  touchCombo(id)
  try {
    const ready = await spawnHost(combo)
    process.stderr.write(`[corum-desktop] combo "${combo.id}" host ready (${ready.authenticatedUrl})\n`)
    const win = mainWindow
    if (win === null || win.isDestroyed()) return { ok: false, error: 'no window' }
    await win.loadURL(ready.authenticatedUrl)
    return { ok: true }
  } catch (error) {
    process.stderr.write(`[corum-desktop] combo "${combo.id}" launch failed: ${String(error)}\n`)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function main(): Promise<void> {
  // 多实例隔离：默认所有 corum-desktop 实例会挤在同一个 user-data-dir
  // （~/Library/Application Support/Electron），共享 Chromium profile/锁/
  // 网络服务进程——一个实例（如 IDE 测试窗口）的渲染/网络崩溃会传染另一个
  // （如正在对话的窗口）。给每个实例独立的 user-data-dir：按 CORUM_HOME
  // （dev home）+ 调试端口区分，互不干扰。CORUM_USER_DATA_DIR 可显式覆盖。
  const userDataDir = process.env.CORUM_USER_DATA_DIR
    ?? join(os.tmpdir(), `corum-desktop-ud-${process.env.CORUM_DESKTOP_MODE ?? 'minimal'}-${process.env.CORUM_DEBUG_PORT ?? 'noport'}`)
  app.setPath('userData', userDataDir)

  // 收敛 no-sandbox：仅「未签名 dev 构建」才禁用 Chromium 沙盒。dev（未打包）
  // 态 macOS 对未签名二进制拒绝沙盒初始化，窗口会空白，故追加 no-sandbox；
  // 打包签名版（isPackaged()=true，经 electron-builder 签名/notarize）恢复
  // Chromium 沙盒（不再追加）。CORUM_NO_SANDBOX=0/1 可显式覆盖自动判定
  // （排查沙盒兼容性时手动切换）。Must run before app.whenReady().
  const noSandboxEnv = process.env.CORUM_NO_SANDBOX
  const noSandbox = noSandboxEnv !== undefined && noSandboxEnv !== ''
    ? noSandboxEnv !== '0' && noSandboxEnv.toLowerCase() !== 'false' // 显式覆盖
    : !isPackaged() // 自动判定：dev 未打包禁用，打包签名版恢复沙盒
  if (noSandbox) {
    app.commandLine.appendSwitch('no-sandbox')
  }
  app.commandLine.appendSwitch('disable-gpu')
  // CDP walkthrough (scripts/walkthrough-s4-shot.mjs): an opt-in remote-debugging
  // port so geometry/theme assertions and screenshots can run against the
  // live window. Off by default; zero effect on normal launches.
  const debugPort = process.env.CORUM_DEBUG_PORT
  if (debugPort !== undefined && debugPort !== '') {
    app.commandLine.appendSwitch('remote-debugging-port', debugPort)
    // remote-allow-origins '*' 仅为 walkthrough 脚本（scripts/walkthrough-*.mjs）
    // 从 ws 升级握手的 origin 校验兜底；allow-origins 的收窄由下面的
    // remote-debugging-address 绑回环兜底（本机任意进程之外的连接根本到不了
    // 端口）。若未来需要跨机调试，应显式收窄/枚举 origin，而不是放开地址绑定。
    app.commandLine.appendSwitch('remote-allow-origins', '*')
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  }
  registerSchemes()
  await app.whenReady()
  // 清理历史 dsh-auth-* 认证 cookie：官方 dsh-client-connection 的
  // browser-auth 用 sha256(host:port) 当 cookie 名（每端口一个），Electron 复用
  // 单 user-data-dir 时所有 ephemeral 端口的 cookie 全挤在同一个 cookie 库，
  // 日积月累把请求头撑爆 → 长 /plugins combo URL 触发 Node maxHeaderSize 上限
  // 返回 431（曾误判为 404，见 PROGRESS.md 2026-08-30）。这些 cookie 是 HttpOnly、
  // Path=/、Max-Age=30 天，启动时清掉全部（当前实例的会在 loadURL 时重新种）。
  // 只清 loopback 域，不误伤其它站点。
  try {
    const ses = session.defaultSession
    if (ses !== null && ses !== undefined) {
      const all = await ses.cookies.get({})
      const stale = all.filter(c =>
        c.name.startsWith('dsh-auth-')
        && (c.domain === '127.0.0.1' || c.domain === 'localhost'
          || c.domain === '.127.0.0.1' || c.domain === '.localhost'))
      for (const c of stale) {
        const scheme = c.secure ? 'https' : 'http'
        const domain = (c.domain ?? '').replace(/^\./, '')
        await ses.cookies.remove(`${scheme}://${domain}`, c.name)
      }
      if (stale.length > 0) {
        process.stderr.write(`[corum-desktop] purged ${stale.length} stale dsh-auth-* cookie(s)\n`)
      }
    }
  } catch (error) {
    process.stderr.write(`[corum-desktop] dsh-auth cookie purge failed: ${String(error)}\n`)
  }
  // macOS dock 图标（dev 态默认 electron.icns，这里显式换成 corum logo；打包态由
  // electron-builder 的 mac.icon 写进 Info.plist）。assets/icon.png = 新鲸鱼图标。
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(join(dirname(fileURLToPath(import.meta.url)), '../assets/icon.png'))
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  // 协议提前注册（无需 host）：combo 管理页（corumapp://combo/…）在纯壳阶段
  // 就能加载。dsh 页面走官方 webserver（dist + bundle + boot graph 注入全由
  // 官方 web-runtime/modules 行负责），壳协议只保留 combo 页与 shell 静态资源。
  protocols = registerProtocols(monacoWorkersPath(), shellAssetsPath())
  // 壳层 IPC 一次性注册：bridge 通过 getter 解析（combo 切换换实例）。
  registerIpc(() => bridge, () => mainWindow, { launchCombo })
  createWindow()
  process.stderr.write('[corum-desktop] window created (combo launcher)\n')

  if (SMOKE) {
    // 无 combo 的 web profile 启动（等价旧 minimal boot）。直连方案的就绪信号
    // 是 authenticatedUrl 上报 + webserver 可达：fetch 一次首页验证 HTTP 起。
    const ready = await spawnHost(null)
    process.stderr.write(`[corum-desktop smoke] authenticatedUrl: ${ready.authenticatedUrl}\n`)
    const outcome = await (async (): Promise<boolean> => {
      // Readiness = the webserver accepted the launch token: the first GET `/`
      // with `?token=<launchToken>` answers 303 (token → signed-cookie exchange,
      // redirect to `/`), NOT 200. A bare fetch must not follow the redirect —
      // the real Electron loadURL completes the cookie exchange through
      // Chromium's cookie jar. 401 would mean the token was rejected (a real
      // failure); 303 proves the full chain (bind → /api route → auth) is up.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const response = await fetch(ready.authenticatedUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(5_000),
          })
          process.stderr.write(`[corum-desktop smoke] attempt ${attempt}: HTTP ${response.status}\n`)
          if (response.status === 303) return true
          if (response.status === 401) return false // token rejected — no point retrying
        } catch (error) {
          process.stderr.write(`[corum-desktop smoke] attempt ${attempt}: ${String(error)}\n`)
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      return false
    })()
    if (outcome) {
      process.stdout.write('corum-desktop smoke: host child + webserver + authenticatedUrl OK\n')
      app.quit()
    } else {
      process.stderr.write('corum-desktop smoke failed: webserver unreachable at reported authenticatedUrl\n')
      app.exit(1)
    }
  } else if (INITIAL_COMBO_ID !== null) {
    const combo = findCombo(INITIAL_COMBO_ID)
    if (combo === null) {
      process.stderr.write(`[corum-desktop] unknown initial combo: ${INITIAL_COMBO_ID}; staying on the launcher\n`)
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
        process.stderr.write(`[corum-desktop] quit flush: ${result.ok ? `${result.flushed ?? 0} session(s) flushed` : `failed: ${result.error ?? '?'}`}\n`)
      }
    } catch (error) {
      process.stderr.write(`[corum-desktop] quit flush error: ${String(error)}\n`)
    } finally {
      // The host child is killed when its parent exits; nothing else to dispose.
      app.exit(0)
    }
  })()
})

void main().catch((error) => {
  console.error('corum-desktop fatal:', error instanceof Error ? error.stack ?? error.message : String(error))
  app.exit(1)
})
