/**
 * ipcMain registration for the desktop transport: relays the renderer's
 * unary/stream requests to the host bridge child process and pushes its
 * stream frames back to the renderer. Also owns the shell-level combo
 * management IPC (list / launch).
 *
 * The bridge is resolved through a getter: switching combo spawns a NEW host
 * bridge child, so the IPC handlers must always act on the current instance.
 * @module corum-shell/electron/ipc
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import type { HostBridgeClient } from './bridge-client.ts'
import { findCombo, loadAllCombos, touchCombo } from './combos.ts'

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
    onUnary?: (pathname: string) => void
    launchCombo?: (id: string) => Promise<{ ok: boolean; error?: string }>
  },
): void {
  // Stream frames push to the MAIN window's webContents. A closed floating
  // window or a reloaded/crashed main frame leaves the render frame disposed
  // even when `isDestroyed()` hasn't flipped yet (an Electron race), so guard
  // with isDestroyed + isCrashed and swallow the "render frame disposed"
  // throw — a dropped frame is harmless; the next live frame (or the
  // reconnect) resynchronizes.
  const sendToMain = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return
    const wc = win.webContents
    if (wc.isDestroyed() || wc.isCrashed()) return
    try {
      wc.send(channel, payload)
    } catch {
      // Render frame disposed mid-send — drop the frame.
    }
  }
  const send = (message: unknown): void => {
    sendToMain('corum:stream-frame', message)
  }

  // Dev: hot-restart the host bridge child on renderer request (host-side
  // code changed). The window and page stay up.
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
    // （节流），主窗据此在网格里高亮预览要插入的位置；停止移动且落在主窗内
    // 才真正 dock（关浮动窗 + 插入）。移出主窗则清预览。
    let dockTimer: NodeJS.Timeout | null = null
    let lastPush = 0
    const clearPreview = () => sendToMain('corum:floating-drag', { slotKey: key, dragging: false })
    win.on('move', () => {
      const main = getWindow()
      if (main === null || main.isDestroyed() || win.isDestroyed()) return
      const fb = win.getBounds()
      const mb = main.getBounds()
      const cx = fb.x + Math.floor(fb.width / 2)
      const cy = fb.y + Math.floor(fb.height / 2)
      const inside = cx >= mb.x && cx <= mb.x + mb.width && cy >= mb.y && cy <= mb.y + mb.height
      // 实时预览（节流 ~60ms）：把浮动窗中心相对主窗的坐标发给主窗。
      const now = Date.now()
      if (inside && now - lastPush > 60) {
        lastPush = now
        sendToMain('corum:floating-drag', { slotKey: key, dragging: true, x: cx - mb.x, y: cy - mb.y })
      } else if (!inside) {
        clearPreview()
      }
      // Dock 判定：停稳（debounce）且落在主窗内才吸附。
      if (dockTimer !== null) clearTimeout(dockTimer)
      dockTimer = setTimeout(() => {
        if (win.isDestroyed() || main.isDestroyed()) return
        const fb2 = win.getBounds()
        const mb2 = main.getBounds()
        const cx2 = fb2.x + Math.floor(fb2.width / 2)
        const cy2 = fb2.y + Math.floor(fb2.height / 2)
        const insideNow = cx2 >= mb2.x && cx2 <= mb2.x + mb2.width && cy2 >= mb2.y && cy2 <= mb2.y + mb2.height
        if (insideNow && !win.isDestroyed()) {
          notifyFloating(key, false) // 主窗恢复该槽位（挤入网格）
          win.close()
        } else {
          clearPreview()
        }
      }, 350)
    })
    win.on('closed', clearPreview)
    await win.loadURL(`corumapp://app/index.html?floating=${encodeURIComponent(key)}`)
    notifyFloating(key, true) // detached: main window collapses the column
    return { ok: true }
  })

  ipcMain.handle('corum:unary', async (_event, request: { pathname: string; body?: string }) => {
    options?.onUnary?.(request.pathname)
    const bridge = getBridge()
    if (bridge === null) return { status: 503, body: 'no host bridge (combo not launched)' }
    return bridge.unary(request.pathname, request.body)
  })

  ipcMain.handle('corum:respond', async (_event, request: { body?: string }) => {
    const bridge = getBridge()
    if (bridge === null) return { status: 503, body: 'no host bridge (combo not launched)' }
    return bridge.unary('/api/respond', request.body)
  })

  ipcMain.on('corum:stream-open', (_event, payload: { id: string; kind: 'mux' | 'host' }) => {
    const bridge = getBridge()
    if (bridge === null) return
    // Subscribe before opening: the child's first frame (or an explicit open
    // marker) must not race the listener registration.
    bridge.onStreamFrame(payload.id, (frame) => {
      send({ id: payload.id, frame })
    })
    // The open ack precedes any frame: the renderer's readiness handshake
    // waits on it exactly as it waited on SSE headers.
    send({ id: payload.id, open: true })
    bridge.openStream(payload.id, payload.kind)
  })

  ipcMain.on('corum:stream-close', (_event, payload: { id: string }) => {
    getBridge()?.closeStream(payload.id)
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
