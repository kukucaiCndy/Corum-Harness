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
import { createCorumTray, type CorumTray } from './tray.ts'
import { createCorumDock, type CorumDock } from './dock.ts'
import type { ShellMenuHost } from './shell-menu.ts'
import { HostBridgeClient, type BridgeReady } from './bridge-client.ts'
import { findCombo, loadAllCombos, sanitizeComboEnv, touchCombo, type Combo } from './combos.ts'
import { resolveMasterKeyB64, MASTER_KEY_ENV } from './credentials-key.ts'

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
 * Node staged by `fetch-node.mjs` under `Resources/node`; dev: the CLI
 * launcher's process.execPath.
 *
 * **The layout differs per platform** (2026-10-08): the POSIX archives
 * (`node-v…-{darwin,linux}-….tar.gz`) put the binary at `bin/node`, but the
 * Windows archive (`node-v…-win-x64.zip`) extracts a **root-level `node.exe`**
 * — there is no `bin/` directory. Hardcoding `bin/node` (as this did) yields a
 * nonexistent path on Windows, so `spawn` fails and the host never boots.
 */
function hostNode(): string {
  if (isPackaged()) {
    if (process.platform === 'win32') return join(process.resourcesPath, 'node', 'node.exe')
    return join(process.resourcesPath, 'node', 'bin', 'node')
  }
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
 * 本次启动要进入的 combo。
 *
 * corum 已收敛为**单一编程 Agent 应用**（`BUILTIN_COMBOS` 只剩 `coding` 一个），
 * 「选工作流」这一步因此变成**只有一个选项的额外点击**——用户 2026-10-07 明确要求
 * 直接进主界面。故规则改为：
 *   · `--combo=<id>` 显式指定 ⇒ 进它（缺省即开发/自动化快捷方式）；
 *   · 否则若**只存在一个 combo** ⇒ 直接进它（当前即 IDE）；
 *   · 否则（0 个或多个，例如用户自建了额外 combo）⇒ 停在壳的启动器页由用户选。
 * 保留了启动器页与 `combo` 切换链路，多 combo 场景不受影响。
 */
function initialComboId(): string | null {
  const explicit = comboArg()
  if (explicit !== null) return explicit
  const all = loadAllCombos()
  return all.length === 1 ? all[0].id : null
}

const INITIAL_COMBO_ID = initialComboId()

/**
 * Dev mode (HMR enabled): forward the renderer console to stderr so hot-swap
 * logs (`corum-desktop-hmr: hot-swapped ...`) and renderer errors stay visible in
 * the terminal that launched the shell. The smoke check always forwards.
 */
const DEV = process.env.CORUM_DEV_HMR !== undefined && process.env.CORUM_DEV_HMR !== ''

let mainWindow: BrowserWindow | null = null
let quitting = false
/** macOS 菜单栏托盘（常驻入口）；非 macOS 或创建失败时为 null。 */
let tray: CorumTray | null = null
/** macOS Dock 侧常驻能力（未读徽标 / 右键菜单 / 图标显隐）；同上。 */
let dock: CorumDock | null = null
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
  /**
   * 关窗语义（2026-09-10 用户定调「托盘常驻要做」）。
   *
   * 有托盘时：点红点 / ⌘W **不再退出**，而是把窗口藏起来 —— 后台的会话轮次、
   * 子 Agent、编排批次继续跑，用户经菜单栏图标随时回来（这正是「常驻」的意义；
   * 否则托盘图标会随关窗一起消失，等于没有）。
   *
   * 真正的退出只有两条路：托盘菜单「退出 矩道 Corum」与 ⌘Q —— 二者都走
   * `app.quit()`，`before-quit` 会把 `quitting` 置位并先 flush 会话日志。
   * 所以这里必须检查 `quitting`，否则退出流程会被自己的 preventDefault 卡住。
   *
   * 没有托盘（非 macOS / 托盘创建失败）时保持原语义（关窗即退出）：宁可少一个
   * 功能，也不能让用户关掉窗口后再也找不回应用。
   */
  mainWindow.on('close', (event) => {
    if (DEV) {
      process.stderr.write(`[corum-shell] main window close requested (tray=${tray === null ? 'null' : 'ready'}, quitting=${String(quitting)})\n`)
    }
    if (quitting || tray === null) return
    event.preventDefault()
    // 常驻模式下这条日志是「窗口为什么没关掉」的唯一线索，不随 DEV 关掉。
    process.stderr.write('[corum-shell] close intercepted → hide (tray resident)\n')
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => {
    if (DEV) process.stderr.write('[corum-shell] main window closed → app.quit()\n')
    mainWindow = null
    // 主窗关闭 = 退出整个 app（连带所有脱出的浮动窗）。浮动窗没有独立存活
    // 意义——它渲染的是主窗会话的内容，主窗没了它就成了孤儿。走 app.quit()
    // 触发 before-quit 的会话 flush，再退出。
    //
    // 注意：常驻模式下这条路只在**真正退出**时才走到（关窗已被上面的 close
    // 处理器拦成 hide）。
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
 * 把应用图标设到 Dock（dev 态默认是 electron.icns；打包态由 electron-builder 的
 * `mac.icon` 写进 Info.plist）。
 *
 * **幂等，且必须在每次 Dock 显隐变更后重放**：`dock.hide()/show()` 会切换激活策略，
 * Dock 会重新取图标，自定义图标随之丢失（回退成 bundle 图标 = dev 态的 Electron 默认
 * 图标）。这类「设置过又被系统重置」的状态必须有一个可重放的入口，否则就是
 * 「用户看到图标莫名其妙变回默认」这类只有肉眼能发现的 bug。
 */
function applyDockIcon(): void {
  if (process.platform !== 'darwin') return
  const icon = nativeImage.createFromPath(join(dirname(fileURLToPath(import.meta.url)), '../assets/icon.png'))
  if (icon.isEmpty()) {
    process.stderr.write('[corum-desktop] dock icon asset missing (assets/icon.png)\n')
    return
  }
  app.dock?.setIcon(icon)
}

/**
 * 显示并聚焦主窗口（托盘菜单「显示主窗口」与 macOS dock 点击共用一条路径）。
 *
 * 隐藏（`hide()`）与最小化（`minimize()`）都算「不在眼前」，必须都处理：
 * 只 show 不 restore 会让窗口以图标形态停在 Dock 里，看起来像没反应。
 */
function showMainWindow(): void {
  if (DEV) process.stderr.write('[corum-shell] show main window\n')
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 显示主窗口并让渲染层展开通知中心（托盘菜单第二项）。 */
function openNotificationCenter(): void {
  showMainWindow()
  const contents = mainWindow?.webContents
  if (contents === undefined || contents.isDestroyed()) return
  try {
    contents.send('corum:open-notification-center')
  } catch {
    // render frame 已 dispose（重载/崩溃竞态）：丢一条打开指令无害。
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
  // API Key 主密钥注入（safeStorage 封装，见 credentials-key.ts）：host 侧
  // corum-credentials-local 据此对凭证值 AES-256-GCM 加密落盘。smoke（combo
  // 为 null）同样注入——smoke 路径也走 credentials 服务。safeStorage 不可用时
  // resolveMasterKeyB64 返回 undefined，host 侧进入「拒绝写密文」降级。
  const masterKey = resolveMasterKeyB64()
  if (masterKey !== undefined) env[MASTER_KEY_ENV] = masterKey
  // 父进程 PID：host 侧据此定期探活（stdin EOF 在「管道的写端被其它 Electron
  // 子进程继承」时不触发——实测打包版 kill -9 主进程后 host 仍活着）。
  env.CORUM_PARENT_PID = String(process.pid)
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
  /**
   * 统一应用身份 —— **必须在任何 safeStorage 调用之前**（2026-09-26 修）。
   *
   * 为什么必需：macOS 上 `safeStorage` 用**应用名**选 Keychain 条目
   * （`<app.getName()> Safe Storage`）。dev 态直接跑 Electron 二进制时身份是
   * `Electron`，而打包态是 `corum-desktop`（= package.json 的 name）——两者是
   * **两个不同的 Keychain 条目**，于是同一个 home 里的 `$CORUM_HOME/.master-key`
   * 谁建的、另一方就解不开：
   *
   *   `credentials-local(encrypted): a stored credential is encrypted but the
   *    master key is unavailable`  ⇒ **整棵插件树加载失败，应用起不来**。
   *
   * 实测（4 组对照，2026-09-26）：不 setName 时 dev 解不开打包态建的密钥；
   * `app.setName('corum-desktop')` 后两边互通。故显式固定这一个名字，使
   * dev / 打包态 / 各调试端口实例**共用同一 Keychain 条目**。
   *
   * 注意：名字来源于 package.json 的 `name`（`corum-desktop`），而 showName 用的
   * `productName`（`Corum`）只影响 Dock/菜单显示 —— 改名会**换 Keychain 条目**，
   * 使既有 `.master-key` 解不开，因此这里的字面量必须与 package.json 的 `name` 保持一致。
   */
  app.setName('corum-desktop')

  // 多实例隔离：默认所有 corum-desktop 实例会挤在同一个 user-data-dir
  // （~/Library/Application Support/Electron），共享 Chromium profile/锁/
  // 网络服务进程——一个实例（如 IDE 测试窗口）的渲染/网络崩溃会传染另一个
  // （如正在对话的窗口）。给每个实例独立的 user-data-dir：按 CORUM_HOME
  // （dev home）+ 调试端口区分，互不干扰。CORUM_USER_DATA_DIR 可显式覆盖。
  const userDataDir = process.env.CORUM_USER_DATA_DIR
    ?? join(os.tmpdir(), `corum-desktop-ud-${process.env.CORUM_DESKTOP_MODE ?? 'minimal'}-${process.env.CORUM_DEBUG_PORT ?? 'noport'}`)
  app.setPath('userData', userDataDir)

  /**
   * 单实例锁（2026-09-10 加，随托盘常驻一起来的必需项）。
   *
   * 为什么在托盘这一轮必须加：托盘图标是**每个进程一个 status item**，而「开机自启 +
   * 手动再点一次」是极容易发生的事 —— 两个进程就是菜单栏上两个一模一样的图标，
   * 用户点哪个都只说对一半（各自有自己的未读数与窗口）。锁在 `userData` 上（见上
   * 一段：按 mode + 调试端口隔离），所以不同 combo / 不同调试端口的实例仍可并存，
   * 只有「同一个实例再启动一次」会被合并到已有实例。
   *
   * 第二个实例不自己建窗口/托盘，而是把已有实例的主窗口请到前台后退出 —— 这也正好
   * 是用户点 Dock 图标或再次双击应用时的预期行为。
   */
  if (!app.requestSingleInstanceLock()) {
    process.stderr.write('[corum-desktop] another instance already owns the lock; handing over and exiting\n')
    app.quit()
    return
  }
  app.on('second-instance', () => { showMainWindow() })

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
  // Linux 的 safeStorage 后端必须**显式**指定：Chromium 在 Linux 上不像 macOS 那样
  // 自动选中密钥环后端，默认落到「无可用后端」⇒ `safeStorage.isEncryptionAvailable()`
  // 返回 false ⇒ 主密钥无法封装、凭证加密整层降级（用户可见症状是
  // 「暂时无法保存确认状态，请重试」）。
  //
  // 2026-10-07 在 Ubuntu 24.04 上实测（三组对照，同一台机、同一用户、keyring 正常）：
  //   默认                     ⇒ ❌ 不可用
  //   --password-store=gnome-libsecret ⇒ ✅ 可用
  //   --password-store=basic           ⇒ ❌ 不可用
  // 故 Linux 上显式选 gnome-libsecret（`basic` 是 Chromium 的明文兜底，不能用于
  // 真正要保护的主密钥，故不作为后备）。可用 CORUM_LINUX_PASSWORD_STORE 覆盖
  // （例如无 GNOME 的桌面环境改用 kwallet 等）。
  // Must run before app.whenReady().
  if (process.platform === 'linux') {
    const store = process.env.CORUM_LINUX_PASSWORD_STORE ?? 'gnome-libsecret'
    if (store !== '') app.commandLine.appendSwitch('password-store', store)
  }
  // GPU 合成：默认开启。历史上这里无条件 appendSwitch('disable-gpu')，让整个渲染
  // 走软件光栅——corum 的「液态玻璃」皮肤到处是 backdrop-filter，代价变成每帧全屏
  // 重算模糊：设置面板打开（整屏 mask blur 8px + 面板 blur 16px）时若背后内容在动
  // （串流对话/动画），实测整机从 44 FPS 掉到 7 FPS（2026-09-09 用户报障，CDP 实测
  // 复现：只去掉两层 backdrop-filter 立刻回到 42 FPS）。开启 GPU 后这些模糊交给合成
  // 器，代价可忽略。需要回退到软件渲染时设 CORUM_DISABLE_GPU=1。
  // Must run before app.whenReady().
  const disableGpuEnv = process.env.CORUM_DISABLE_GPU
  const disableGpu = disableGpuEnv !== undefined && disableGpuEnv !== ''
    && disableGpuEnv !== '0' && disableGpuEnv.toLowerCase() !== 'false'
  if (disableGpu) {
    app.commandLine.appendSwitch('disable-gpu')
  }
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
  //
  // ⚠️ 必须能被**重复调用**：`app.dock.setIcon()` 设的是 `NSApp.applicationIconImage`，
  // 而任何**切激活策略**的动作（`dock.hide()` / `dock.show()`）都会让 Dock 重新取图标，
  // 自定义图标随之丢失、回退到 bundle 图标（dev 态 = Electron 默认图标）——用户看到的
  // 就是「图标变回默认了」（2026-09-10 实测踩到，见 dock.ts 的 reapplyDockIcon）。
  applyDockIcon()
  // 协议提前注册（无需 host）：combo 管理页（corumapp://combo/…）在纯壳阶段
  // 就能加载。dsh 页面走官方 webserver（dist + bundle + boot graph 注入全由
  // 官方 web-runtime/modules 行负责），壳协议只保留 combo 页与 shell 静态资源。
  protocols = registerProtocols(monacoWorkersPath(), shellAssetsPath())
  // 壳层 IPC 一次性注册：bridge 通过 getter 解析（combo 切换换实例）；托盘同理
  // 走 getter（托盘在 createWindow 之后才建，但 IPC 可能更早被调用）。
  registerIpc(() => bridge, () => mainWindow, { launchCombo, getTray: () => tray, getDock: () => dock })
  createWindow()
  // macOS 的两个常驻入口（2026-09-10 用户定调「托盘常驻要做」+「下面的 dock 栏也做一下」）：
  //   - 菜单栏托盘（status item）：未读数字是**被遮挡时**仍可见的主载体；
  //   - Dock（下方 Dock 栏）：未读徽标 + 右键菜单。
  // 两者共用同一份菜单模板（`shell-menu.ts`）与同一份未读推送（`ipc.ts` 扇出），
  // 避免「同一功能两个入口给了两套功能树 / 两个不一样的数字」。
  // 建在 createWindow 之后：菜单第一项要能显示主窗口；且 `tray !== null` 是关窗语义
  // 从「退出」降级为「藏起来」的开关（见 createWindow 的 close 处理器）。
  // smoke 不建：那条路径要的是可预期的「起→握手→退」，多一个常驻入口会吊住进程。
  if (!SMOKE) {
    const menuHost: ShellMenuHost = {
      showMainWindow,
      openNotificationCenter,
      quit: () => { app.quit() },
      isDockHidden: () => dock?.isHidden() ?? false,
      setDockHidden: (hidden) => {
        dock?.setHidden(hidden)
        // 两份菜单实例各自持有勾选态：改完必须都重建，否则另一个入口显示的是旧状态。
        tray?.refresh()
        dock?.refresh()
      },
    }
    dock = createCorumDock({
      ...menuHost,
      // 显隐切换会重置 Dock 图标（见 applyDockIcon 的注释）：让 dock 模块在每次
      // 变更后把它重放回去。
      reapplyDockIcon: applyDockIcon,
      // 遮挡判定：窗口不存在 / 已隐藏 / 未聚焦 —— 三者的共同语义是「用户看不到主窗」，
      // 此时新通知才值得让 Dock 图标跳一下（窗口在前台时系统也会让 bounce 返回 -1）。
      shouldAttractAttention: () => {
        const win = mainWindow
        if (win === null || win.isDestroyed()) return true
        return !win.isVisible() || win.isMinimized() || !win.isFocused()
      },
    })
    tray = createCorumTray({ ...menuHost, assetsDir: shellAssetsPath() })
    process.stderr.write(`[corum-desktop] tray: ${tray === null ? 'unavailable (non-darwin or failed)' : 'ready'}\n`)
    process.stderr.write(`[corum-desktop] dock: ${dock === null ? 'unavailable (non-darwin or failed)' : 'ready'}\n`)
  }
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
      // 只有「显式 --combo=<不存在的 id>」才会走到这里（单 combo 的自动选择必然是
      // 存在的），故退回启动器页并如实说明，而不是静默进错应用。
      process.stderr.write(`[corum-desktop] unknown combo: ${INITIAL_COMBO_ID}; falling back to the launcher\n`)
      await mainWindow?.loadURL('corumapp://combo/index.html')
    } else {
      await launchCombo(combo.id)
    }
  } else {
    // 0 个或多个 combo：显示 combo 管理页由用户选（壳自带静态页，零 dsh 依赖）。
    await mainWindow?.loadURL('corumapp://combo/index.html')
  }
}

// macOS：点 Dock 图标（或在无窗口时被激活）= 把常驻隐藏的主窗口请回来。
// 没有这一段，用户关窗后用 Dock 唤起会「什么都没发生」。
app.on('activate', (_event, hasVisibleWindows) => {
  if (DEV) process.stderr.write(`[corum-shell] activate (hasVisibleWindows=${String(hasVisibleWindows)})\n`)
  if (mainWindow === null || mainWindow.isDestroyed()) return
  showMainWindow()
})

app.on('window-all-closed', () => {
  if (DEV) process.stderr.write('[corum-shell] window-all-closed → app.quit()\n')
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
      // 必须显式杀掉 host 子进程：它是独立 OS 进程，`app.exit()` 不会连带杀死它。
      // 此前这里写着「The host child is killed when its parent exits」——是错的：
      // 子进程的 webserver 句柄会把它永远吊着，于是每次退出都留下一个**孤儿 host**，
      // 继续攥着打开过的 session.lock，下一次启动就读不到那些会话
      // （2026-09-09 用户报「模型选择失败」；PROGRESS 第 60 轮）。
      bridge?.dispose()
      app.exit(0)
    }
  })()
})

void main().catch((error) => {
  console.error('corum-desktop fatal:', error instanceof Error ? error.stack ?? error.message : String(error))
  app.exit(1)
})
