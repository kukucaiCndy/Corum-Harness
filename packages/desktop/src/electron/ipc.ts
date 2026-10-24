/**
 * ipcMain registration for the desktop transport: relays the renderer's
 * unary/stream requests to the host bridge child process and pushes its
 * stream frames back to the renderer. Also owns the shell-level combo
 * management IPC (list / launch).
 *
 * The bridge is resolved through a getter: switching combo spawns a NEW host
 * bridge child, so the IPC handlers must always act on the current instance.
 * @module corum-desktop/electron/ipc
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, ipcMain, shell, BrowserWindow, Notification, type IpcMainInvokeEvent } from 'electron'
import type { HostBridgeClient } from './bridge-client.ts'
import { findCombo, loadAllCombos, touchCombo } from './combos.ts'
import { createInputHal, type InputHal } from './input-hal.ts'
import { getPlatformModule } from './platform/index.ts'
import { takeTrayResidentHint, type CorumTray } from './tray.ts'
import type { CorumDock } from './dock.ts'
import { readStartupAnimationEnabled, writeStartupAnimationEnabled, readEditorDisplayPrefs, writeEditorDisplayPrefs } from './startup-settings.ts'
import type { createStartupScreen } from './startup-screen.ts'
import { listStartupThemes, importStartupTheme, selectStartupTheme, deleteStartupTheme, resolveStartupTheme } from './startup-themes.ts'
import { performInstallUpdate } from './update-install.ts'
import { openStartupPreview } from './startup-preview.ts'
import { pinWindowTitle } from './window-title.ts'
import { homedir } from 'node:os'
import type { BootDiagnostics } from '../host/profile-precheck.ts'

/**
 * 读 `$CORUM_HOME/boot-diagnostics.json`。
 *
 * 为什么要单独一条通道：bundle 装坏时 **host 进程会死在装载阶段**，此时任何经 host
 * RPC 的面都不可用；而 renderer 与 main 进程都还活着。所以诊断必须是**文件**，
 * 由 main 进程读、经 IPC 交给启动页（方案 §C.3 的结论）。
 * @returns 解析后的诊断；文件不存在/为空/损坏一律返回 undefined（不抛）。
 */
function readBootDiagnostics(): BootDiagnostics | undefined {
  const configured = process.env.CORUM_HOME
  const home = configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.corum')
  const path = join(home, 'boot-diagnostics.json')
  try {
    const raw = readFileSync(path, 'utf8')
    if (raw.trim() === '') return undefined   // 干净启动会把文件清空
    const parsed = JSON.parse(raw) as BootDiagnostics
    return parsed.skipped.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the transport IPC handlers. Run once after app ready; the bridge
 * getter returns the CURRENT host child (a combo switch swaps the instance).
 * @param getBridge - returns the live host bridge child handle.
 * @param getWindow - returns the current main window (or null while closed).
 * @param options - optional hooks: unary observation (smoke handshake), combo
 * launch (main-process spawn orchestration), tray/dock accessors (menu-bar count +
 * Dock badge).
 */
export function registerIpc(
  getBridge: () => HostBridgeClient | null,
  getWindow: () => BrowserWindow | null,
  options?: {
    launchCombo?: (id: string) => Promise<{ ok: boolean; error?: string }>
    /** 当前托盘（未建/非 macOS 为 null）；未读数与常驻提示都经它落地。 */
    getTray?: () => CorumTray | null
    /** 当前 Dock 侧句柄（未建/非 macOS 为 null）；未读徽标走它。 */
    getDock?: () => CorumDock | null
    getStartupScreen?: () => ReturnType<typeof createStartupScreen> | null
    startupAssetsDir?: string
  },
): void {
  const startupCaller = (event: IpcMainInvokeEvent): BrowserWindow => {
    const win = getWindow()
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的启动主题请求')
    return win
  }
  const startupAssets = (): string => {
    if (!options?.startupAssetsDir) throw new Error('启动主题资源尚未就绪')
    return options.startupAssetsDir
  }
  const startupId = (id: unknown): string => { if (typeof id !== 'string') throw new Error('主题 ID 无效'); return id }
  ipcMain.handle('corum:startup-themes-list', event => { startupCaller(event); return listStartupThemes(startupAssets()) })
  ipcMain.handle('corum:startup-themes-import', async event => {
    const win = startupCaller(event)
    const picked = await dialog.showOpenDialog(win, { title: '导入启动主题', properties: ['openFile'], filters: [{ name: 'Corum 启动主题', extensions: ['zip'] }] })
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true }
    return { cancelled: false, theme: await importStartupTheme(picked.filePaths[0]) }
  })
  ipcMain.handle('corum:startup-themes-select', (event, id: unknown) => { startupCaller(event); return selectStartupTheme(startupId(id), startupAssets()) })
  ipcMain.handle('corum:startup-themes-delete', async (event, value: unknown) => {
    const win = startupCaller(event), id = startupId(value)
    const catalog = await listStartupThemes(startupAssets())
    const theme = catalog.themes.find(item => item.id === id)
    if (!theme || theme.builtin) throw new Error('该主题不存在或为内置主题')
    const result = await dialog.showMessageBox(win, { type: 'question', title: '删除启动主题', message: `删除“${theme.name}”？`, detail: catalog.selectedId === id ? '下次启动将使用内置主题。' : '可以重新导入主题包恢复。', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true })
    if (result.response !== 1) return { cancelled: true }
    await deleteStartupTheme(id)
    return { cancelled: false }
  })
  ipcMain.handle('corum:startup-themes-preview', async (event, value: unknown) => {
    const win = startupCaller(event), id = startupId(value)
    const theme = await resolveStartupTheme(startupAssets(), id)
    if (theme.info.id !== id) throw new Error('主题不存在或已损坏')
    openStartupPreview(win, theme)
  })
  // 启动诊断（host 侧的 profile 预检结果）。host 若死在装载阶段，renderer 仍活着，
  // 这条 IPC 是它唯一能拿到「哪个插件坏了、为什么」的通道 —— 读的是落在
  // $CORUM_HOME/boot-diagnostics.json 的文件，不依赖 host 存活。
  ipcMain.handle('corum:boot-diagnostics', () => readBootDiagnostics())
  ipcMain.handle('corum:startup-animation-get', () => readStartupAnimationEnabled())
  ipcMain.handle('corum:startup-animation-set', (event, enabled: unknown) => {
    if (event.sender.id !== getWindow()?.webContents.id || typeof enabled !== 'boolean') throw new Error('无效的启动设置请求')
    writeStartupAnimationEnabled(enabled)
    return enabled
  })
  ipcMain.handle('corum:startup-status-get', event => {
    const screen = options?.getStartupScreen?.()
    return screen?.senderId === event.sender.id ? screen.getStatus() : undefined
  })
  ipcMain.on('corum:startup-finish', event => {
    const screen = options?.getStartupScreen?.()
    if (screen?.senderId === event.sender.id) screen.finish()
  })
  ipcMain.on('corum:startup-retry', event => {
    const screen = options?.getStartupScreen?.()
    if (screen?.senderId === event.sender.id) screen.retry()
  })
  // Push a message to the MAIN window's webContents. A closed floating
  // window or a reloaded/crashed main frame leaves the render frame disposed
  // even when `isDestroyed()` hasn't flipped yet (an Electron race), so guard
  // with isDestroyed + isCrashed and swallow the "render frame disposed"
  // throw — a dropped message is harmless.
  const sendToMain = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return
    const wc = win.webContents
    if (wc.isDestroyed() || wc.isCrashed()) return
    try {
      wc.send(channel, payload)
    } catch {
      // Render frame disposed mid-send — drop the message.
    }
  }

  // Dev: hot-restart the host bridge child on renderer request (host-side
  // code changed). The window and page stay up; the renderer's own connection
  // loop reconnects to the fresh webserver.
  ipcMain.handle('corum:host-restart', async () => {
    await getBridge()?.restart()
    return { ok: true }
  })

  // ── 托盘常驻（macOS 菜单栏）────────────────────────────────────────────
  //
  // 未读数由**主窗 renderer**推送（通知账本在 renderer 的 store 里，主进程不复制
  // 一份状态）：renderer 侧 store 一变就 send 一次，主进程只做「显示」。
  // 用 `ipcMain.on` 而非 `handle`：这是纯通知、没有返回值，高频（每次通知增删）
  // 也不该让 renderer 等一个 round trip。
  ipcMain.on('corum:notifications-count', (_event, payload: { unread?: unknown; total?: unknown }) => {
    // 不可信输入的形状校验在这里做：常驻入口的文案不能出现 NaN / 负数。
    const count = {
      unread: typeof payload?.unread === 'number' ? payload.unread : 0,
      total: typeof payload?.total === 'number' ? payload.total : 0,
    }
    // 两个常驻入口**同源同值**扇出（菜单栏数字 + Dock 徽标）。各自内部的
    // 「值没变就跳过」去重仍在，所以重复推送不会造成额外重建。
    options?.getTray?.()?.setCount(count)
    options?.getDock?.()?.setCount(count)
  })

  // 常驻模式的**一次性**提示（详见 tray.ts 的 takeTrayResidentHint）：renderer 的
  // 托盘桥装好后拉一次，拿到 firstTime 就发一条应用内通知。用 invoke 而不是主进程
  // 主动推：renderer 的桥装好的时刻只有它自己知道，主动推会撞上「还没装好」。
  ipcMain.handle('corum:tray-hint', () => {
    return takeTrayResidentHint((options?.getTray?.() ?? null) !== null)
  })

  // ── 系统通知（macOS 优先；2026-09-10 用户定调「先做 macOS 系统通知」）──────
  //
  // 为什么放主进程而不是 renderer 的 Web Notification API：
  //   ① 主进程 `new Notification()` **无需权限握手**（应用自身通知），
  //      renderer 路线要先 setPermissionRequestHandler 且各平台行为不一；
  //   ② 点击回调在主进程直接可拿（`notification.on('click')`），
  //      能先唤醒/聚焦窗口再把点击转回 renderer 执行跳转；
  //   ③ 图标、静音等选项可控。
  //
  // 去重与降噪是**调用方（renderer）的责任**：renderer 已知道窗口是否聚焦
  // （`document.hasFocus()`），聚焦时不发系统通知（应用内 toast 已够）。
  // 主进程只做「发」与「点击回传」，保持无状态——避免两处各自判断焦点而打架。
  ipcMain.handle('corum:notify-native', async (_event, request: {
    title: string
    body?: string
    /** 静音（默认 true：通知栏已有应用内提示音语义，系统音重复会吵）。 */
    silent?: boolean
    /** 点击时回传给 renderer 的通知 id（renderer 据此执行既有 onOpen 动作）。 */
    notificationId?: string
  }) => {
    if (!Notification.isSupported()) return { ok: false, error: 'notifications unsupported' }
    const notification = new Notification({
      title: request.title,
      ...request.body === undefined || request.body === '' ? {} : { body: request.body },
      silent: request.silent !== false,
    })
    /**
     * ⚠️ macOS（Electron 42+）用 UNNotification API，**未签名应用的通知会静默失败**：
     * `isSupported()` 仍返回 true、`show()` 不抛错，只在 Notification 上 emit
     * `failed`（UNErrorDomain error 1 = UNErrorCodeNotificationsNotAllowed）。
     *
     * 开发态跑的是 `node_modules` 里那个 `adhoc, linker-signed` 的 Electron.app，
     * UNNotification **不接受** linker-signed 签名 → 通知不显示。
     * 于是这里必须订阅 `failed` 并把结果如实回传，否则调用方会以为发送成功
     * （实测踩到：`ok:true` 但屏幕上什么都没有）。
     * 要让开发态也能看到：给 Electron.app 做**真签名**（见 docs/ASSESSMENT-*.md）。
     */
    const outcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false
      const settle = (result: { ok: boolean; error?: string }): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      notification.on('show', () => { settle({ ok: true }) })
      notification.on('failed', (_event, error: string) => {
        settle({ ok: false, error: `notification failed: ${String(error)}` })
      })
      // 既没 show 也没 failed（极少数平台）→ 超时后按「已投递」处理，避免挂住调用方。
      setTimeout(() => { settle({ ok: true }) }, 1500)
      try {
        notification.show()
      } catch (error: unknown) {
        settle({ ok: false, error: String(error) })
      }
    })
    notification.on('click', () => {
      // 唤醒优先：窗口可能被隐藏/最小化/在别的 Space。
      const win = getWindow()
      if (win !== null && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        if (!win.isVisible()) win.show()
        win.focus()
        // 先渲染进程可见，再把点击转回去（否则前端可能还没法处理跳转）。
        if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return
        try {
          win.webContents.send('corum:native-notification-clicked', {
            notificationId: request.notificationId ?? null,
          })
        } catch {
          // Render frame disposed mid-send — drop.
        }
      }
    })
    return outcome
  })

  // Floating window: open one slot's content detached in its own
  // BrowserWindow, loading the same corumapp:// origin with ?floating=<slotKey>
  // so the renderer mounts ONLY that slot (wrapped in the Window Chrome)
  // instead of the four-column shell. One window per slot; re-opening focuses.
  // The MAIN window tracks which slots are detached (floating-state) so its
  // columns can collapse while detached and restore on close.
  const floatingWindows = new Map<string, BrowserWindow>()
  /**
   * 本壳自己开的窗口（主窗，或任意注册过的浮窗）——用于**窗口无关**的用户配置读写。
   *
   * 为什么不能只认主窗：显示偏好这类设置是**全局用户配置**，而同一个 bundle 在
   * 每个 Electron 窗口里都会加载（见 `client/window-role.ts` 的模块注释），编辑器
   * 槽位本身也能被拖成浮窗（`RegionCard` 的脱出没有白名单）。只比主窗的
   * `webContents.id` 会让浮窗里的 `getEditorDisplayPrefs` 抛错 → 回落默认值、
   * 且每次改设置都打一条 console.error（实测路径：`client/index.ts` 的
   * `.catch`），浮窗下的设置既不生效也不落盘。另外主窗被关掉但浮窗仍在时，
   * 原判据 `sender.id !== undefined` 恒真，读写同样全拒。
   *
   * 判据仍收得很紧：必须来自**本进程创建的**窗口，且是主 frame
   * （与 `startupCaller` 同口径，防 iframe/子 frame 冒用）。
   */
  const isOwnShellFrame = (event: IpcMainInvokeEvent): boolean => {
    const owners = [getWindow(), ...floatingWindows.values()].filter((win): win is BrowserWindow => win !== null && !win.isDestroyed())
    return owners.some(win => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)
  }
  // 编辑器显示偏好：**窗口无关**的用户配置（见 isOwnShellFrame 的注释），
  // 主窗与浮窗都可读写——浮窗里同样能打开编辑器并改这些开关。
  ipcMain.handle('corum:editor-display-get', event => {
    if (!isOwnShellFrame(event)) throw new Error('无效的编辑器设置请求')
    return readEditorDisplayPrefs()
  })
  ipcMain.handle('corum:editor-display-set', (event, prefs: unknown) => {
    if (!isOwnShellFrame(event) || typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) throw new Error('无效的编辑器设置请求')
    writeEditorDisplayPrefs(prefs)
  })
  const notifyFloating = (slotKey: string, detached: boolean): void => {
    sendToMain('corum:floating-change', { slotKey, detached })
  }
  // Input HAL 单例（懒加载，全局共享）：全局鼠标按键状态查询，供浮动窗
  // dock-on-release 判定。平台适配见 input-hal.ts；**能力显式化（P1）**：
  // capabilities.globalPointer=false（Linux Wayland 等）⇒ HAL 不可用，
  // 调用方退化为保守行为，不再靠 createInputHal 内部判平台返回 nullHal 去悟。
  let inputHal: InputHal | null = null
  const getInputHal = (): InputHal => {
    inputHal ??= createInputHal()
    return inputHal
  }
  ipcMain.handle('corum:open-floating', async (_event, request: { slotKey: string }) => {
    const key = request.slotKey
    const existing = floatingWindows.get(key)
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.focus()
      return { ok: true }
    }
    const win = new BrowserWindow({
      // design.pen i5ie6 的帧宽 900：会话顶栏卡片要容纳
      // 标题 + divider + 状态胶囊（`4 轮 · 31m · In x / Out y · 命中 z%`）
      // + 常驻 Agent 胶囊 + 轨迹按钮，560 宽会把标题压成几个字（实测 `并./`）。
      width: 900,
      height: 700,
      title: `corum · ${key}`,
      // design.pen i5ie6（会话拖出为独立窗口）：顶栏 = 系统红绿灯 + 会话顶栏卡片
      // 同一行。故这里用 'hiddenInset'（与主窗口一致：隐藏原生标题栏但保留左上角
      // 红绿灯，灯位内联进内容区），渲染层在这行左侧留 traffic-light-inset 让位、
      // 并让会话顶栏卡片承担整条拖窗。
      // 非会话槽（编辑器/终端/轨迹…）没有会话顶栏，渲染层仍画自绘 Window Chrome
      // 作为唯一顶栏——该情况下 titleBarStyle 仍是 hiddenInset，自绘 chrome 的
      // 左 padding(84px) 已为红绿灯让位，行为与改动前一致。
      // 平台选路收进 electron/platform/（P1：window-chrome 能力）：macOS 给
      // 'hiddenInset' + 红绿灯定位（与会话顶栏卡片中线对齐），其它平台系统标题栏。
      ...getPlatformModule().windowChromeOptions('floating'),
      webPreferences: {
        preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    // 浮窗同样要钉标题：页面 <title>（基座 dsh-web-frontend 的「DeepSeek Harness」）
    // 会覆盖 title: `corum · ${key}`，Dock/Alt-Tab 里就会显示错误品牌名。
    pinWindowTitle(win, `corum · ${key}`)
    floatingWindows.set(key, win)
    win.on('closed', () => {
      floatingWindows.delete(key)
      notifyFloating(key, false) // detached → restored: main window re-expands the column
    })
    // Dock-back with live preview: 拖动浮动窗经过主窗口时，把坐标实时推给主窗
    // （节流），主窗据此在网格里高亮预览要插入的位置；释放鼠标（窗口移动结束，
    // moved 事件）且落在主窗内才真正 dock（关浮动窗 + 插入）。移出主窗则清预览。
    let lastPush = 0
    const clearPreview = () => sendToMain('corum:floating-drag', { slotKey: key, dragging: false })
    const centerInsideMain = () => {
      const main = getWindow()
      if (main === null || main.isDestroyed() || win.isDestroyed()) return null
      const fb = win.getBounds()
      const mb = main.getBounds()
      const cx = fb.x + Math.floor(fb.width / 2)
      const cy = fb.y + Math.floor(fb.height / 2)
      const inside = cx >= mb.x && cx <= mb.x + mb.width && cy >= mb.y && cy <= mb.y + mb.height
      return { cx, cy, mb, inside }
    }
    // Dock 判定：macOS 系统拖拽（app-region:drag）期间渲染层收不到
    // mouseup/blur，时间判定（move 停止超时）也不可靠（move 间隙不稳定，
    // 长停顿会误吸附）。唯一可靠的「松手」信号是全局鼠标按键状态——但松手
    // 后不再有 move 事件，故不能挂在 move 上，改为独立轮询左键：检测到
    // 「按下 → 松开」跳变即拖拽结束，此刻中心在主窗内才吸附。
    //
    // 性能：轮询按需启动——只在「浮动窗被拖动且中心进入主窗区域」（可能
    // 吸附）时跑；移出主窗、吸附、关闭即停。空闲浮动窗不轮询。HAL 不可用
    // 时 isPrimaryButtonDown 恒为 null，永不吸附（保守：宁可靠关闭浮动窗
    // dock，不误吸附）。
    // capabilities.globalPointer=false ⇒ 平台无全局指针（Linux Wayland 等），
    // HAL 不可用，isPrimaryButtonDown 恒 null，永不吸附（保守）。
    const hal = getInputHal()
    let poll: NodeJS.Timeout | null = null
    let wasDown = false
    const stopPoll = (): void => {
      if (poll !== null) { clearInterval(poll); poll = null }
    }
    const startPoll = (): void => {
      if (poll !== null) return
      wasDown = hal.isPrimaryButtonDown() ?? false
      poll = setInterval(() => {
        if (win.isDestroyed()) { stopPoll(); return }
        const down = hal.isPrimaryButtonDown()
        if (down === null) { stopPoll(); return } // HAL 不可用：不吸附
        const released = wasDown && !down
        wasDown = down
        if (!released) return
        stopPoll()
        // 左键松开 = 拖拽结束。此刻中心在主窗内才 dock。
        const cur = centerInsideMain()
        clearPreview()
        if (cur !== null && cur.inside && !win.isDestroyed()) {
          notifyFloating(key, false) // 主窗恢复该槽位（挤入网格）
          win.close()
        }
      }, 60)
    }
    // 实时预览（节流 ~60ms）：拖动中把浮动窗中心相对主窗的坐标发给主窗。
    // 中心进入主窗区域 → 启动松手轮询；移出 → 停轮询（本次不再可能吸附）。
    win.on('move', () => {
      const r = centerInsideMain()
      if (r === null) return
      if (r.inside) {
        startPoll()
        if (Date.now() - lastPush > 60) {
          lastPush = Date.now()
          sendToMain('corum:floating-drag', { slotKey: key, dragging: true, x: r.cx - r.mb.x, y: r.cy - r.mb.y })
        }
      } else {
        stopPoll()
        clearPreview()
      }
    })
    win.on('closed', () => {
      stopPoll()
      clearPreview()
    })
    // 浮动窗加载同一个官方 dsh web 页（loopback HTTP），带 ?floating=<slotKey>
    // 让 renderer 只挂载该槽。复用当前 host 的 authenticatedUrl；无 host（combo
    // 未启动）则无法打开。
    const bridge = getBridge()
    const baseUrl = bridge?.readyPayload?.authenticatedUrl
    if (baseUrl === undefined) {
      win.close()
      return { ok: false, error: 'no host (combo not launched)' }
    }
    const floatingUrl = new URL(baseUrl)
    floatingUrl.searchParams.set('floating', key)
    // 官方 token 交换（dsh-client-connection authorizeIndex）：GET /?token=… →
    // 303 location:'/' 硬编码清掉整个 query——floating 参数随重定向丢失；带
    // token 且已持有效 cookie 时官方同样 303 清 query。因此去掉 token、纯
    // cookie 鉴权直达：主窗已完成 token→cookie 交换，session 共享的 dsh-auth
    // cookie 仍有效，GET /?floating=<key>（无 token）命中 isAuthenticated 直返
    // index.html，无重定向、floating 参数保留。（0.1.2 loopback 修复：此前沿用
    // authenticatedUrl 的 token 参数，浮动窗 303 后丢 ?floating → 整壳挂载。）
    floatingUrl.searchParams.delete('token')
    await win.loadURL(floatingUrl.toString())
    notifyFloating(key, true) // detached: main window collapses the column
    return { ok: true }
  })

  /**
   * Close a detached floating window (the counterpart of `corum:open-floating`).
   *
   * 为什么必须有：桥里原先只有 open —— 窗口一旦打开，程序化路径**没有任何办法关掉它**
   * （2026-09-12 验证时实测：探测完浮窗只能请用户手动关）。关闭走
   * `win.close()` → 既有 `closed` 钩子照常 `floatingWindows.delete` + 通知主窗
   * 「detached → restored」（主窗据此把被折叠的列恢复回来），所以这里不重复做状态清理。
   *
   * `slotKey` 缺省 = 关掉**所有**浮窗（退出/重置场景）；指定则只关那一个。
   * @returns `closed` = 实际关掉的数量（0 = 本来就没开，调用方无需当错误处理）。
   */
  ipcMain.handle('corum:close-floating', (_event, request?: { slotKey?: string }) => {
    const key = request?.slotKey
    const targets = key === undefined
      ? [...floatingWindows.entries()]
      : [...floatingWindows.entries()].filter(([slotKey]) => slotKey === key)
    let closed = 0
    for (const [, win] of targets) {
      if (win.isDestroyed()) continue
      win.close()
      closed += 1
    }
    return { ok: true, closed }
  })

  // ── Session archive: native save/open dialogs over the host's ZIP builder ──

  // Save one session's log: host builds the ZIP (in-process, reusing the
  // official downloads.sessionLog layout), the main process owns the native
  // save dialog and the file write — the desktop replacement for the web's
  // browser-download via GET /api/session.export (which the IPC transport
  // cannot stream).
  ipcMain.handle('corum:save-session-log', async (_event, request: { sessionId: string }) => {
    const win = getWindow()
    const bridge = getBridge()
    if (win === null || win.isDestroyed()) return { path: null, error: 'no window' }
    if (bridge === null) return { path: null, error: 'no host bridge (combo not launched)' }
    const safe = request.sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
    const picked = await dialog.showSaveDialog(win, {
      title: '保存会话日志',
      defaultPath: `dsh-session-${safe}.zip`,
      filters: [{ name: 'Session Log', extensions: ['zip'] }],
    })
    if (picked.canceled || picked.filePath === undefined) return { path: null }
    const result = await bridge.sessionExport(request.sessionId)
    if (!result.ok || result.zipBase64 === undefined) {
      return { path: null, error: result.error ?? 'export failed' }
    }
    try {
      await writeFile(picked.filePath, Buffer.from(result.zipBase64, 'base64'))
      return { path: picked.filePath }
    } catch (error) {
      return { path: null, error: String(error) }
    }
  })

  // Export several sessions' logs into ONE zip: host builds each member
  // (the same per-session archive `corum:save-session-log` writes) and
  // nests them under one outer zip; the main process owns the native save
  // dialog and the single file write. Ids the host could not build are
  // reported back so the caller can tell the user what was skipped.
  ipcMain.handle('corum:export-sessions-zip', async (_event, request: { sessionIds: string[] }) => {
    const win = getWindow()
    const bridge = getBridge()
    if (win === null || win.isDestroyed()) return { path: null, error: 'no window' }
    if (bridge === null) return { path: null, error: 'no host bridge (combo not launched)' }
    const ids = Array.isArray(request.sessionIds) ? request.sessionIds.filter(id => typeof id === 'string') : []
    if (ids.length === 0) return { path: null, error: 'no sessions selected' }
    const picked = await dialog.showSaveDialog(win, {
      title: '导出会话日志',
      defaultPath: 'dsh-sessions-export.zip',
      filters: [{ name: 'Session Log', extensions: ['zip'] }],
    })
    if (picked.canceled || picked.filePath === undefined) return { path: null }
    const result = await bridge.sessionExportBatch(ids)
    if (!result.ok || result.zipBase64 === undefined) {
      return { path: null, error: result.error ?? 'export failed' }
    }
    try {
      await writeFile(picked.filePath, Buffer.from(result.zipBase64, 'base64'))
      return { path: picked.filePath, failed: result.failed ?? [] }
    } catch (error) {
      return { path: null, error: String(error) }
    }
  })

  // Physically delete one session: native confirm dialog first (the host
  // removal is irreversible — artifact, workspace references, caches), then
  // the host-side delete. A running session is refused by the host.
  ipcMain.handle('corum:delete-session', async (_event, request: { sessionId: string }) => {
    const win = getWindow()
    const bridge = getBridge()
    if (win === null || win.isDestroyed()) return { deleted: false, error: 'no window' }
    if (bridge === null) return { deleted: false, error: 'no host bridge (combo not launched)' }
    const picked = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '删除会话',
      message: '确定删除该会话？此操作不可恢复。',
      detail: '会话日志文件将被从磁盘移除，且无法通过导入以外的任何方式找回。',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
    })
    if (picked.response !== 1) return { deleted: false, cancelled: true }
    const result = await bridge.sessionDelete(request.sessionId)
    if (!result.ok) return { deleted: false, error: result.error ?? 'delete failed' }
    return { deleted: result.deleted ?? false, wasLive: result.wasLive ?? false }
  })

  // Import session log ZIP(s): native open dialog → read each file → host
  // materializes its session artifacts into this home's store.
  ipcMain.handle('corum:import-session-log', async () => {
    const win = getWindow()
    const bridge = getBridge()
    if (win === null || win.isDestroyed()) return { imported: [], skipped: [], error: 'no window' }
    if (bridge === null) return { imported: [], skipped: [], error: 'no host bridge (combo not launched)' }
    const picked = await dialog.showOpenDialog(win, {
      title: '导入会话日志',
      defaultPath: app.getPath('downloads'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Session Log', extensions: ['zip'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { imported: [], skipped: [], cancelled: true }
    }
    const imported: string[] = []
    const skipped: string[] = []
    for (const filePath of picked.filePaths) {
      try {
        const bytes = await readFile(filePath)
        const result = await bridge.sessionImport(bytes.toString('base64'))
        if (result.ok) {
          imported.push(...(result.imported ?? []))
          skipped.push(...(result.skipped ?? []))
        } else {
          return { imported, skipped, error: `${basename(filePath)}: ${result.error ?? 'import failed'}` }
        }
      } catch (error) {
        return { imported, skipped, error: `${basename(filePath)}: ${String(error)}` }
      }
    }
    return { imported, skipped }
  })

  // Pick a working directory via a native open-directory dialog (project cwd).
  // Only existing directories are selectable — creating a new folder is left to
  // the OS dialog's own "New Folder" affordance (no createDirectory flag).
  ipcMain.handle('corum:pick-directory', async (_event, request: { title?: string; defaultPath?: string }) => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return { path: null, error: 'no window' }
    const picked = await dialog.showOpenDialog(win, {
      title: request.title ?? '选择工作目录',
      ...(request.defaultPath !== undefined && request.defaultPath !== '' ? { defaultPath: request.defaultPath } : {}),
      properties: ['openDirectory'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { path: null, cancelled: true }
    return { path: picked.filePaths[0] }
  })

  // Pick a single file via a native open-file dialog (P5b extension-pack ZIP import).
  // Mirrors pick-directory but selects files; optional filters constrain extensions.
  ipcMain.handle('corum:pick-file', async (_event, request: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return { path: null, error: 'no window' }
    const picked = await dialog.showOpenDialog(win, {
      title: request.title ?? '选择文件',
      ...(request.defaultPath !== undefined && request.defaultPath !== '' ? { defaultPath: request.defaultPath } : {}),
      properties: ['openFile'],
      ...(request.filters !== undefined && request.filters.length > 0 ? { filters: request.filters } : {}),
    })
    if (picked.canceled || picked.filePaths.length === 0) return { path: null, cancelled: true }
    return { path: picked.filePaths[0] }
  })

  // ── 应用信息 ──────────────────────────────────────────────────────────
  //
  // 版本号读本包的 package.json，不用 `app.getVersion()`：dev 态主进程由
  // `spawn(electronPath, [main.js])` 拉起（入口是 .js 文件而非 app 目录），
  // Electron 没有 app 包可读，`app.getVersion()` 会回落成 **Electron 自身的
  // bundle 版本**（实测 dev 显示 v43.4.1 而非 v0.1.0）。打包态两者一致，但
  // 统一读 package.json 更稳。preload 侧暴露成 `getAppVersion()`（invoke 而非
  // sendSync：同步 IPC 会卡住 renderer 的启动路径，版本号只在品牌行挂载时
  // 拉一次，异步完全够）。
  const appVersion: string = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
  ).version as string
  ipcMain.handle('corum:app-version', () => appVersion)

  /**
   * 构建渠道：`release` = 正式发布产物，`local` = 本地构建。
   *
   * 为什么需要它：本地打出来的包与线上发布的包**版本号完全相同**（都读
   * package.json），于是「我测的这个 bug 到底还在不在」无法自证 —— 2026-10-17
   * 用户明确要求区分。
   *
   * 判据用「有没有打包签名/更新源」而不是改版本号：版本号由 release.mjs 严格
   * 校验并写台账，任何构建期篡改都会污染发布事实（docs/VERSIONING.md）。
   *
   * 具体判据：正式包由 electron-builder 配置了 publish 源且带签名；
   * 本地 `pack:host` 走的是未签名的临时产物（实测 `skipped macOS application
   * code signing`）。这里用「是否打包态 + 是否有签名身份」两者结合，
   * 缺少任一即视为本地。
   */
  const buildChannel: 'release' | 'local' = ((): 'release' | 'local' => {
    // 非打包态（直接 node/electron 跑源码）必然是本地。
    if (!existsSync(join(process.resourcesPath, 'host', 'lib', 'bridge.js'))) return 'local'
    // 打包态：以「是否存在发布签名」为判据。开发机没有 Developer ID，
    // 本地打包会是未签名产物；正式发布在 CI 上签名后再分发。
    // macOS 下 app.isPackaged 为真且签名存在时，`process.execPath` 位于 .app 内。
    // 这里不深入验签（代价高且需要 codesign 子进程），改用构建期写入的渠道标记：
    const marker = join(process.resourcesPath, 'host', 'build-channel')
    try {
      const value = readFileSync(marker, 'utf8').trim()
      if (value === 'release' || value === 'local') return value
    } catch { /* 没有标记 = 老产物或本地构建 */ }
    return 'local'
  })()
  ipcMain.handle('corum:build-channel', () => buildChannel)

  /**
   * dsh 基座版本（用户 2026-10-03 定调：**侧栏只显示应用版本号，基座号只进诊断信息**）。
   *
   * 从**实际安装**的官方锚点包读，不从任何手写常量或依赖声明区间读 —— 声明区间是
   * `^0.1.5-rc.3` 这种范围，写进界面会撒谎；而 `.pnpm` 里可能同时存在多个版本
   * （实测同时有 0.1.3-alpha.1 与 0.1.5-rc.3），只有**解析后的**那一份才是真话。
   * 取不到就返回 undefined，调用方在诊断串里省略这一段，不编造。
   */
  const dshBaselineVersion: string | undefined = ((): string | undefined => {
    try {
      const pkgPath = join(
        dirname(fileURLToPath(import.meta.url)),
        '../node_modules/@deepseek-ai/dsh-base/package.json',
      )
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version as string
    } catch {
      return undefined
    }
  })()
  ipcMain.handle('corum:dsh-baseline-version', () => dshBaselineVersion)

  /**
   * 更新日志正文 + 文件绝对路径（应用内「检查更新」面板与编辑器视图共用）。
   *
   * 文件随安装包分发（`Resources/assets/CHANGELOG.md`，源 = 仓库根 CHANGELOG.md，
   * 经 `extraResources` 的 `assets` 一项目录搬运）。**不从 GitHub 拉**：历史上
   * 的版本信息必须离线可读——更新本身就需要联网，若日志也要联网，断网时用户
   * 连「这版改了什么」都看不到。
   *
   * 返回路径而不是只返回文本：渲染层要用 `corumEditor.openFile(absolutePath)`
   * 把这份文件在编辑器里打开（工作区外路径由 openExternalPreview 兜底成只读
   * 预览），路径必须由主进程给，渲染层无法自行拼装 resourcesPath。
   *
   * 读不到（老产物没有该文件）返回 null，调用方省略日志区而不是编造内容。
   */
  ipcMain.handle('corum:changelog', () => {
    try {
      const assetsDir = options?.startupAssetsDir
      if (assetsDir === undefined) return null
      const filePath = join(assetsDir, 'CHANGELOG.md')
      if (!existsSync(filePath)) return null
      return { path: filePath, content: readFileSync(filePath, 'utf8') }
    } catch {
      return null
    }
  })

  // ── 应用更新 · 重启安装 ────────────────────────────────────────────────
  //
  // 渲染层在「下载完成待重启」态点击「重启安装」时调用。@corum/corum-update-checker
  // 已把资产下载到 CORUM_UPDATES_DIR，渲染层经 RPC getUpdateState 拿到路径后，
  // 经此 IPC 让主进程执行平台相关的「spawn 安装脚本 → quit → 替换 → 重启」。
  // host 子进程无法直接退出 Electron 壳（它的父进程），故安装动作走主进程。
  ipcMain.handle('corum:update-install', (_event, request: { downloadedPath: string }) =>
    performInstallUpdate(request))

  // ── 壳层 combo 管理（纯壳页面使用；进程级切换，废弃旧的进程内 comboLoad）──

  // 读取所有已配置且可用的 combo（内置 + 用户自定义，壳层文件）。
  ipcMain.handle('corum:combos-list', () => loadAllCombos())

  // 按 combo 启动 dsh host：main 进程按 combo 注入 env/cwd/覆盖规则并
  // spawn 新的 host 子进程，成功后窗口切到 dsh client 页面。
  ipcMain.handle('corum:combo-launch', async (_event, request: { id: string }) => {
    if (options?.launchCombo === undefined) {
      return { ok: false, error: 'combo launch not wired' }
    }
    return options.launchCombo(request.id)
  })

  // 记录 combo 使用时间（combo 管理页/工作台可选调用）。
  ipcMain.handle('corum:combo-touch', (_event, request: { id: string }) => {
    return { ok: touchCombo(request.id) !== null, combo: findCombo(request.id) }
  })

  // ── 窗口控制（win32/linux 无原生标题栏，渲染层自绘按钮用）────────────────
  //
  // 这套 handler 只做主窗口的窗口操作（minimize / toggle-maximize / close），
  // 不涉及浮窗。macOS 因保留了系统红绿灯（`hiddenInset`），渲染层不调这套；
  // 但 handler 本身不按平台 gate——调用方（渲染层）自己判平台决定是否渲染按钮。
  // 用 `ipcMain.on`（非 handle）：这是纯动作、无返回值，不需要 renderer 等
  // round trip。`close` 走原生 `close` 事件 ⇒ 托盘常驻时被 main.ts 的 close
  // 处理器拦成 hide，否则触发 quit。
  ipcMain.on('corum:window-minimize', () => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return
    win.minimize()
  })
  ipcMain.on('corum:window-toggle-maximize', () => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('corum:window-close', () => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return
    win.close()
  })
  // 查询当前最大化态（自绘按钮初始化图标用）。
  ipcMain.handle('corum:window-is-maximized', () => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return false
    return win.isMaximized()
  })

  // ── 外链（渲染层要用系统默认浏览器打开）──────────────────────────────
  //
  // 只放行 http/https，其它 scheme 一律拒绝：这条 handler 是渲染层 → 主进程的
  // 任意 URL 通道，放行 `file:` / `javascript:` 之类等于把本机文件与脚本执行面
  // 开到渲染层（渲染层自身跑的是插件 bundle，不是可信边界）。
  ipcMain.handle('corum:open-external', async (_event, request: { url: string }) => {
    const url = String(request?.url ?? '')
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' }
    await shell.openExternal(url)
    return { ok: true }
  })
}
