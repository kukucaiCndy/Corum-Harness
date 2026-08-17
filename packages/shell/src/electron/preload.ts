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

ipcRenderer.on('corum:stream-frame', (_event, message: StreamFrameMessage) => {
  for (const listener of [...listeners]) listener(message)
})

ipcRenderer.on('corum:hmr-event', (_event, payload: { id: string; rev: string }) => {
  for (const listener of [...hmrListeners]) listener(payload.id, payload.rev)
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

  /** Save one session's log ZIP via a native save dialog; resolves the saved path or null when cancelled. */
  saveSessionLog: (sessionId: string): Promise<{ path: string | null; error?: string }> =>
    ipcRenderer.invoke('corum:save-session-log', { sessionId }),
  /** Import session log ZIP(s) via a native open dialog; resolves the import outcome. */
  importSessionLog: (): Promise<{ imported: string[]; skipped: string[]; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:import-session-log'),
  /** Physically delete one session after a native confirm dialog; running sessions are refused. */
  deleteSession: (sessionId: string): Promise<{ deleted: boolean; wasLive?: boolean; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:delete-session', { sessionId }),
})
