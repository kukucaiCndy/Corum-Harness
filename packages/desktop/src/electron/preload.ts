/**
 * corum-desktop preload: exposes the `window.corumDesktop` IPC bridge to the
 * page. Sandboxed (CJS), so only ipcRenderer/contextBridge are reachable; the
 * renderer never touches Electron APIs directly.
 * @module corum-desktop/electron/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

const floatingListeners = new Set<(slotKey: string, detached: boolean) => void>()
const floatingDragListeners = new Set<(payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => void>()
const nativeNotificationClickListeners = new Set<(payload: { notificationId: string | null }) => void>()
const notificationCenterListeners = new Set<() => void>()

ipcRenderer.on('corum:floating-change', (_event, payload: { slotKey: string; detached: boolean }) => {
  for (const listener of [...floatingListeners]) listener(payload.slotKey, payload.detached)
})

ipcRenderer.on('corum:floating-drag', (_event, payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => {
  for (const listener of [...floatingDragListeners]) listener(payload)
})

// 系统通知被点击：主进程已唤醒/聚焦窗口，这里把 id 交给 renderer 执行跳转。
ipcRenderer.on('corum:native-notification-clicked', (_event, payload: { notificationId: string | null }) => {
  for (const listener of [...nativeNotificationClickListeners]) listener(payload)
})

// 托盘菜单点了「通知中心」：主进程已显示窗口，这里让 renderer 展开自己的通知面板。
ipcRenderer.on('corum:open-notification-center', () => {
  for (const listener of [...notificationCenterListeners]) listener()
})

/**
 * `window.corumDesktop` 的形状（桥的权威声明）。AGENTS.md 红线 1 的合法 window
 * 挂载例外：只写一次、只读；消费侧按红线 3 用**本地能力接口**收窄自己用到的那
 * 几个方法（tray-bridge / session-archive 的既有形态），不 import 本文件。
 */
export interface CorumDesktopBridge {
  /**
   * 实际运行平台（'darwin' | 'linux' | 'win32'）——渲染层的**平台行为事实源**
   * （docs/PLAN-2026-10-07 §3③：渲染层经 preload 同步查平台；合法 window 挂载，
   * 「写一次、只读」，与 `__DSH_BOOT__` 同类）。同步而非 Promise：平台是启动期
   * 常量，异步拉取会迫使所有消费面变异步。**行为决策只跟随它**（= host 侧
   * `getPlatform()` 的同一事实）；「这份产物是为谁打的」（烘入目标）仅供
   * 诊断，经 `getBakedTargetPlatform` 取，**禁止用于选实现**。
   */
  getPlatform: () => 'darwin' | 'linux' | 'win32'
  /** 烘入的目标平台（诊断用；dev 态为 undefined）。禁止用于选实现。 */
  getBakedTargetPlatform: () => 'darwin' | 'linux' | 'win32' | undefined
  /** 应用版本号（读 `packages/desktop/package.json`）：品牌行的版本小字用。 */
  getAppVersion: () => Promise<string>
  /** dsh 基座版本号（实际安装的官方锚点包）：只进「复制诊断信息」，不在界面单独展示。 */
  getDshBaselineVersion: () => Promise<string | undefined>
  /** Dev: hot-restart the host bridge child (host-side code changed). */
  restartHost: () => Promise<{ ok: boolean }>
  /** Open one slot's content in a detached floating window (?floating=<slotKey>). */
  openFloating: (slotKey: string) => Promise<{ ok: boolean; error?: string }>
  /** Close a detached floating window; omitted slotKey closes them all. */
  closeFloating: (slotKey?: string) => Promise<{ ok: boolean; closed: number }>
  /** 发一条系统通知（见实现处的完整说明）。 */
  notifyNative: (request: {
    title: string
    body?: string
    silent?: boolean
    notificationId?: string
  }) => Promise<{ ok: boolean; error?: string }>
  /** 订阅系统通知点击。 */
  onNativeNotificationClick: (callback: (payload: { notificationId: string | null }) => void) => () => void
  /** 把未读数推给主进程（菜单栏标题上的数字）。 */
  setNotificationCount: (count: { unread: number; total: number }) => void
  /** 取「常驻模式」一次性提示的展示资格。 */
  getTrayHint: () => Promise<{ resident: boolean; firstTime: boolean }>
  /** 主进程托盘菜单点了「通知中心」→ 展开渲染层的通知面板。 */
  onOpenNotificationCenter: (callback: () => void) => () => void
  /** Main window: subscribe to slot detach/restore (floating open/close). */
  onFloatingChange: (callback: (slotKey: string, detached: boolean) => void) => () => void
  /** Main window: subscribe to floating-window drag coordinates (live dock preview). */
  onFloatingDrag: (callback: (payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => void) => () => void
  /** Save one session's log ZIP via a native save dialog. */
  saveSessionLog: (sessionId: string) => Promise<{ path: string | null; error?: string }>
  /** Import session log ZIP(s) via a native open dialog. */
  importSessionLog: () => Promise<{ imported: string[]; skipped: string[]; cancelled?: boolean; error?: string }>
  /** Physically delete one session after a native confirm dialog. */
  deleteSession: (sessionId: string) => Promise<{ deleted: boolean; wasLive?: boolean; cancelled?: boolean; error?: string }>
  /** Pick a working directory via a native open-directory dialog (project cwd). */
  pickDirectory: (options?: { title?: string; defaultPath?: string }) => Promise<{ path: string | null; cancelled?: boolean; error?: string }>
  /** 壳层 combo 管理页：读取所有已配置且可用的 combo。 */
  listCombos: () => Promise<unknown[]>
  /** 壳层 combo 管理页：按 combo 注入 env/cwd/覆盖规则并启动 dsh host。 */
  launchCombo: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** 记录 combo 使用时间。 */
  touchCombo: (id: string) => Promise<{ ok: boolean }>
}

/**
 * 打包链 tsdown `define` 烘入的目标平台（preload 与 main 同一条打包链注入）。
 * dev 态未烘入时标识符不存在，读取走 typeof 守卫。仅供诊断，禁止用于选实现。
 */
declare const __CORUM_TARGET_PLATFORM__: string | undefined

const RUNTIME_PLATFORM = process.platform as 'darwin' | 'linux' | 'win32'
const BAKED_TARGET_PLATFORM: 'darwin' | 'linux' | 'win32' | undefined =
  typeof __CORUM_TARGET_PLATFORM__ === 'undefined'
    ? undefined
    : __CORUM_TARGET_PLATFORM__ as 'darwin' | 'linux' | 'win32'

contextBridge.exposeInMainWorld('corumDesktop', {
  /**
   * 实际运行平台（process.platform，写一次只读的模块常量）。同步返回：
   * 平台是启动期常量，不值得为它走 IPC（异步会迫使消费面全变异步）。
   */
  getPlatform: (): 'darwin' | 'linux' | 'win32' => RUNTIME_PLATFORM,

  /** 烘入的目标平台（诊断用；dev 态 undefined）。禁止用于选实现。 */
  getBakedTargetPlatform: (): 'darwin' | 'linux' | 'win32' | undefined => BAKED_TARGET_PLATFORM,

  /**
   * 应用版本号（主进程 `app.getVersion()`）。IPC 而不是 sendSync：同步 IPC 会
   * 阻塞 renderer，而版本号只在品牌行挂载时拉一次，异步足够（调用方缓存进
   * React state）。取不到时调用方静默不显示版本——桥不该为「拿不到一个字串」抛。
   */
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('corum:app-version'),

  getDshBaselineVersion: (): Promise<string | undefined> =>
    ipcRenderer.invoke('corum:dsh-baseline-version'),

  /** Dev: hot-restart the host bridge child (host-side code changed). */
  restartHost: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('corum:host-restart'),

  /** Open one slot's content in a detached floating window (?floating=<slotKey>). */
  openFloating: (slotKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:open-floating', { slotKey }),

  /**
   * Close a detached floating window. `slotKey` 缺省 = 关掉所有浮窗。
   * @returns `closed` = 实际关掉的数量（0 = 本来没开）。
   */
  closeFloating: (slotKey?: string): Promise<{ ok: boolean; closed: number }> =>
    ipcRenderer.invoke('corum:close-floating', slotKey === undefined ? {} : { slotKey }),

  /**
   * 发一条**系统通知**（macOS 通知中心）。返回 ok:false 表示平台不支持或失败，
   * 调用方应静默降级（应用内 toast 仍然在）。
   */
  notifyNative: (request: {
    title: string
    body?: string
    silent?: boolean
    notificationId?: string
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:notify-native', request),
  /** 订阅系统通知点击（主进程已唤醒窗口；这里执行跳转）。 */
  onNativeNotificationClick: (callback: (payload: { notificationId: string | null }) => void): (() => void) => {
    nativeNotificationClickListeners.add(callback)
    return () => {
      nativeNotificationClickListeners.delete(callback)
    }
  },

  // ── 托盘常驻（macOS 菜单栏）──────────────────────────────────────────

  /**
   * 把未读数推给主进程（菜单栏标题上的数字）。
   *
   * 单向 `send`（无返回值）：这是**显示**同步，renderer 不需要等待；主进程侧对
   * 形状做钳制（`ipc.ts`）。
   */
  setNotificationCount: (count: { unread: number; total: number }): void => {
    ipcRenderer.send('corum:notifications-count', count)
  },

  /**
   * 取「常驻模式」一次性提示的展示资格（renderer 的托盘桥装好后主动拉一次）。
   * @returns resident=当前是否托盘常驻；firstTime=这次该不该提示（拉取即落盘去重）。
   */
  getTrayHint: (): Promise<{ resident: boolean; firstTime: boolean }> =>
    ipcRenderer.invoke('corum:tray-hint'),
  /** 主进程托盘菜单点了「通知中心」→ 展开渲染层的通知面板。 */
  onOpenNotificationCenter: (callback: () => void): (() => void) => {
    notificationCenterListeners.add(callback)
    return () => {
      notificationCenterListeners.delete(callback)
    }
  },
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
  /** Pick a working directory via a native open-directory dialog (project cwd). */
  pickDirectory: (options?: { title?: string; defaultPath?: string }): Promise<{ path: string | null; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:pick-directory', options ?? {}),
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
