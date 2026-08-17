/**
 * Typed face of the desktop native bridges this plugin consumes. The preload
 * exposes them on `window.corumDesktop`; outside the desktop shell the bridge is
 * absent and every contribution degrades to a disabled state.
 * @module session-archive/client/bridge
 */

/** Native bridges this plugin calls (a subset of the shell's CorumDesktopBridge). */
export interface SessionArchiveBridge {
  /**
   * Save one session's log ZIP via a native save dialog.
   * @param sessionId - Session whose archive is written.
   * @returns the saved path, `null` when the user cancelled, and an optional error.
   */
  saveSessionLog(sessionId: string): Promise<{ path: string | null; error?: string }>
  /**
   * Import session log ZIP(s) via a native open dialog.
   * @returns the import outcome: landed session ids, skipped ids, cancel flag, optional error.
   */
  importSessionLog(): Promise<{ imported: string[]; skipped: string[]; cancelled?: boolean; error?: string }>
  /**
   * Physically delete one session via a native confirm dialog (irreversible;
   * running sessions are refused by the host).
   * @param sessionId - Session to delete.
   * @returns the delete outcome: artifact-removed flag, live flag, cancel flag, optional error.
   */
  deleteSession(sessionId: string): Promise<{ deleted: boolean; wasLive?: boolean; cancelled?: boolean; error?: string }>
}

declare global {
  interface Window {
    /** Provided by the desktop preload; absent outside the desktop shell. */
    corumDesktop?: SessionArchiveBridge
  }
}

/**
 * Read the desktop bridge, or `undefined` when the bundle runs outside the desktop shell.
 * @returns the preload bridge when present.
 */
export function desktopBridge(): SessionArchiveBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.corumDesktop
}
