/**
 * ipcMain registration for the desktop transport: relays the renderer's
 * unary/stream requests to the host bridge child process and pushes its
 * stream frames back to the renderer.
 * @module corum-shell/electron/ipc
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import type { HostBridgeClient } from './bridge-client.ts'

/**
 * Register the transport IPC handlers. Run once after the bridge child is
 * ready, with a window getter so frames always target the live window.
 * @param bridge - the host bridge child handle.
 * @param getWindow - returns the current main window (or null while closed).
 * @param onUnary - optional observation hook for renderer unary requests
 * (the smoke check uses it to detect the renderer connection handshake).
 */
export function registerIpc(
  bridge: HostBridgeClient,
  getWindow: () => BrowserWindow | null,
  onUnary?: (pathname: string) => void,
): void {
  const send = (message: unknown): void => {
    const win = getWindow()
    if (win !== null && !win.isDestroyed()) win.webContents.send('corum:stream-frame', message)
  }
  const sendHmr = (id: string, rev: string): void => {
    const win = getWindow()
    const deliverable = win !== null && !win.isDestroyed()
    process.stderr.write(`[corum-shell-hmr] main relay: ${id} (rev ${rev}) → window ${deliverable ? 'deliver' : 'UNAVAILABLE'}\n`)
    if (deliverable) win.webContents.send('corum:hmr-event', { id, rev })
  }

  // Dev HMR: relay the host child's bundle-rebuilt notices to the renderer's
  // hot-reload driver. Registered once; the listener survives restarts.
  bridge.onHmr(sendHmr)

  // Dev: hot-restart the host bridge child on renderer request (host-side
  // code changed). The window and page stay up.
  ipcMain.handle('corum:host-restart', async () => {
    await bridge.restart()
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
    const win = getWindow()
    if (win !== null && !win.isDestroyed()) win.webContents.send('corum:floating-change', { slotKey, detached })
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
    await win.loadURL(`corumapp://app/index.html?floating=${encodeURIComponent(key)}`)
    notifyFloating(key, true) // detached: main window collapses the column
    return { ok: true }
  })

  ipcMain.handle('corum:unary', async (_event, request: { pathname: string; body?: string }) => {
    onUnary?.(request.pathname)
    return bridge.unary(request.pathname, request.body)
  })

  ipcMain.handle('corum:respond', async (_event, request: { body?: string }) => {
    return bridge.unary('/api/respond', request.body)
  })

  ipcMain.on('corum:stream-open', (_event, payload: { id: string; kind: 'mux' | 'host' }) => {
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
    bridge.closeStream(payload.id)
  })

  // ── Session archive: native save/open dialogs over the host's ZIP builder ──

  // Save one session's log: host builds the ZIP (in-process, reusing the
  // official downloads.sessionLog layout), the main process owns the native
  // save dialog and the file write — the desktop replacement for the web's
  // browser-download via GET /api/session.export (which the IPC transport
  // cannot stream).
  ipcMain.handle('corum:save-session-log', async (_event, request: { sessionId: string }) => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return { path: null, error: 'no window' }
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
    if (win === null || win.isDestroyed()) return { deleted: false, error: 'no window' }
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
    if (win === null || win.isDestroyed()) return { imported: [], skipped: [], error: 'no window' }
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
}
