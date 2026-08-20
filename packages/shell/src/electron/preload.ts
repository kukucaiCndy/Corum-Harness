/**
 * corum-shell preload: exposes the `window.corumDesktop` IPC bridge to the
 * page. Sandboxed (CJS), so only ipcRenderer/contextBridge are reachable; the
 * renderer never touches Electron APIs directly.
 * @module corum-shell/electron/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

/** One pushed stream message (open ack or a full ServerRequest frame). */
interface StreamFrameMessage {
  id: string
  open?: boolean
  frame?: unknown
}

const listeners = new Set<(message: StreamFrameMessage) => void>()
const hmrListeners = new Set<(id: string, rev: string) => void>()
const floatingListeners = new Set<(slotKey: string, detached: boolean) => void>()
const floatingDragListeners = new Set<(payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => void>()

ipcRenderer.on('corum:stream-frame', (_event, message: StreamFrameMessage) => {
  for (const listener of [...listeners]) listener(message)
})

ipcRenderer.on('corum:hmr-event', (_event, payload: { id: string; rev: string }) => {
  for (const listener of [...hmrListeners]) listener(payload.id, payload.rev)
})

ipcRenderer.on('corum:floating-change', (_event, payload: { slotKey: string; detached: boolean }) => {
  for (const listener of [...floatingListeners]) listener(payload.slotKey, payload.detached)
})

ipcRenderer.on('corum:floating-drag', (_event, payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => {
  for (const listener of [...floatingDragListeners]) listener(payload)
})

contextBridge.exposeInMainWorld('corumDesktop', {
  unary: (pathname: string, body?: string): Promise<{ status: number; body: string }> =>
    ipcRenderer.invoke('corum:unary', { pathname, body }),
  respond: (body?: string): Promise<{ status: number; body: string }> =>
    ipcRenderer.invoke('corum:respond', { body }),
  openStream: (kind: 'mux' | 'host'): string => {
    const id = crypto.randomUUID()
    ipcRenderer.send('corum:stream-open', { id, kind })
    return id
  },
  closeStream: (id: string): void => {
    ipcRenderer.send('corum:stream-close', { id })
  },
  onStreamFrame: (callback: (message: StreamFrameMessage) => void): (() => void) => {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  },
  /** Dev HMR: subscribe to client-bundle rebuild notices (id + new rev). */
  onHmrEvent: (callback: (id: string, rev: string) => void): (() => void) => {
    hmrListeners.add(callback)
    return () => {
      hmrListeners.delete(callback)
    }
  },
  /** Dev: hot-restart the host bridge child (host-side code changed). */
  restartHost: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('corum:host-restart'),

  /** Open one slot's content in a detached floating window (?floating=<slotKey>). */
  openFloating: (slotKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:open-floating', { slotKey }),
  /** Main window: subscribe to slot detach/restore (floating open/close). */
  onFloatingChange: (callback: (slotKey: string, detached: boolean) => void): (() => void) => {
    floatingListeners.add(callback)
    return () => {
      floatingListeners.delete(callback)
    }
  },
  /** Main window: subscribe to floating-window drag coordinates (live dock preview). */
  onFloatingDrag: (callback: (payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => void): (() => void) => {
    floatingDragListeners.add(callback)
    return () => {
      floatingDragListeners.delete(callback)
    }
  },

  /** Save one session's log ZIP via a native save dialog; resolves the saved path or null when cancelled. */
  saveSessionLog: (sessionId: string): Promise<{ path: string | null; error?: string }> =>
    ipcRenderer.invoke('corum:save-session-log', { sessionId }),
  /** Import session log ZIP(s) via a native open dialog; resolves the import outcome. */
  importSessionLog: (): Promise<{ imported: string[]; skipped: string[]; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:import-session-log'),
  /** Physically delete one session after a native confirm dialog; running sessions are refused. */
  deleteSession: (sessionId: string): Promise<{ deleted: boolean; wasLive?: boolean; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:delete-session', { sessionId }),
  /** 壳层 combo 管理页：读取所有已配置且可用的 combo。 */
  listCombos: (): Promise<unknown[]> =>
    ipcRenderer.invoke('corum:combos-list'),
  /** 壳层 combo 管理页：按 combo 注入 env/cwd/覆盖规则并启动 dsh host。 */
  launchCombo: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:combo-launch', { id }),
  /** 记录 combo 使用时间。 */
  touchCombo: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('corum:combo-touch', { id }),
})
