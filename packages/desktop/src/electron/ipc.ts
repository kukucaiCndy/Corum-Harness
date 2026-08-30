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

import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import type { HostBridgeClient } from './bridge-client.ts'
import { findCombo, loadAllCombos, touchCombo } from './combos.ts'
import { createInputHal, type InputHal } from './input-hal.ts'

/**
 * Register the transport IPC handlers. Run once after app ready; the bridge
 * getter returns the CURRENT host child (a combo switch swaps the instance).
 * @param getBridge - returns the live host bridge child handle.
 * @param getWindow - returns the current main window (or null while closed).
 * @param options - optional hooks: unary observation (smoke handshake), combo
 * launch (main-process spawn orchestration).
 */
export function registerIpc(
  getBridge: () => HostBridgeClient | null,
  getWindow: () => BrowserWindow | null,
  options?: {
    launchCombo?: (id: string) => Promise<{ ok: boolean; error?: string }>
  },
): void {
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

  // Floating window: open one slot's content detached in its own
  // BrowserWindow, loading the same corumapp:// origin with ?floating=<slotKey>
  // so the renderer mounts ONLY that slot (wrapped in the Window Chrome)
  // instead of the four-column shell. One window per slot; re-opening focuses.
  // The MAIN window tracks which slots are detached (floating-state) so its
  // columns can collapse while detached and restore on close.
  const floatingWindows = new Map<string, BrowserWindow>()
  const notifyFloating = (slotKey: string, detached: boolean): void => {
    sendToMain('corum:floating-change', { slotKey, detached })
  }
  // Input HAL 单例（懒加载，全局共享）：全局鼠标按键状态查询，供浮动窗
  // dock-on-release 判定。平台适配见 input-hal.ts。
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
      width: 560,
      height: 640,
      title: `corum · ${key}`,
      // 无边框：完全去掉 macOS 原生标题栏，由 Window Chrome（圆点+槽位名+
      // dock-back）充当唯一顶栏，避免「系统标题栏 + 自绘 Chrome」双层。
      // Window Chrome 已带 -webkit-app-region:drag，窗口可拖。
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
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
}
