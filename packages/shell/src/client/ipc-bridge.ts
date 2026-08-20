/**
 * The `window.corumDesktop` bridge: the typed face the preload exposes to the
 * page. The CorumElectronApiClient and the stream pump talk only to this interface,
 * so the renderer never touches ipcRenderer directly.
 * @module corum-shell/client/ipc-bridge
 */

/** One frame pushed from the main process for a stream. */
export interface CorumStreamFrameMessage {
  /** Stream id minted by the renderer when it opened the stream. */
  id: string
  /** Stream-established acknowledgement (sent before any frame). */
  open?: boolean
  /** One full ServerRequest frame (method = frame type). */
  frame?: unknown
}

/** The preload-exposed desktop IPC surface. */
export interface CorumDesktopBridge {
  /** Run one unary request (path like `/api/session.list`); returns status + body text. */
  unary(pathname: string, body?: string): Promise<{ status: number; body: string }>
  /** Answer one server-initiated request (path `/api/respond`). */
  respond(body?: string): Promise<{ status: number; body: string }>
  /** Open one logical event stream; returns the stream id frames arrive under. */
  openStream(kind: 'mux' | 'host'): string
  /** Close one logical event stream. */
  closeStream(id: string): void
  /** Subscribe to stream frames; returns the unsubscriber. */
  onStreamFrame(callback: (message: CorumStreamFrameMessage) => void): () => void
  /** Dev HMR: subscribe to client-bundle rebuild notices (id + new rev). */
  onHmrEvent(callback: (id: string, rev: string) => void): () => void
  /** Dev: hot-restart the host bridge child (host-side code changed). */
  restartHost(): Promise<{ ok: boolean }>
  /** Open one slot's content detached in a floating window (?floating=<slotKey>). */
  openFloating(slotKey: string): Promise<{ ok: boolean; error?: string }>
  /** Main window: subscribe to slot detach/restore (floating open/close). */
  onFloatingChange(callback: (slotKey: string, detached: boolean) => void): () => void
  /** Main window: subscribe to floating-window drag coordinates (live dock preview). */
  onFloatingDrag(callback: (payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => void): () => void
  /** Save one session's log ZIP via a native save dialog; resolves the saved path or null when cancelled. */
  saveSessionLog(sessionId: string): Promise<{ path: string | null; error?: string }>
  /** Import session log ZIP(s) via a native open dialog; resolves the import outcome. */
  importSessionLog(): Promise<{ imported: string[]; skipped: string[]; cancelled?: boolean; error?: string }>
  /** Physically delete one session (artifact + workspace references + caches)
   * after a native confirm dialog. The host refuses a running session; a
   * cancelled dialog resolves `{ deleted: false, cancelled: true }`. */
  deleteSession(sessionId: string): Promise<{ deleted: boolean; wasLive?: boolean; cancelled?: boolean; error?: string }>
}

declare global {
  interface Window {
    /** Provided by the desktop preload; absent outside the desktop shell. */
    corumDesktop?: CorumDesktopBridge
  }
}

/**
 * Read the bridge, failing loud when this bundle runs outside the desktop
 * shell.
 * @returns the preload bridge.
 */
export function requireBridge(): CorumDesktopBridge {
  const bridge = typeof window === 'undefined' ? undefined : window.corumDesktop
  if (bridge === undefined) {
    throw new Error('corum-shell: the corumDesktop bridge is missing — this client bundle only runs inside the desktop shell')
  }
  return bridge
}
