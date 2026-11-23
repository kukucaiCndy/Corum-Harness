/**
 * 助手正文外链的打开路径。
 *
 * **为什么需要这一层**（用户报障 2026-11「Agent 总结里的链接点了没作用」）：助手
 * 正文的链接是 Markdown `<a>`。官方 `MarkdownText` 只有在 `MarkdownDelegateProvider`
 * 提供了 `openExternalLink` 时才接管点击（`MarkdownAnchor` 的 `onClick` 走 delegate），
 * 否则走**原生锚点**——而本壳的 webContents 没挂 `setWindowOpenHandler`，
 * `target="_blank"` 的原生导航等于静默丢弃（既不跳转也不报错）。
 *
 * 所以外链只有一条可用通道：`window.corumDesktop.openExternal`（主进程只放行
 * http/https，其余 scheme 直接拒）。非桌面壳（纯浏览器运行）回落 `window.open`。
 *
 * @module corum-ui-chat/client/open-external
 */

/** 桥面（preload 的 `corum:open-external`；老 preload 可能缺席）。 */
export interface OpenExternalBridge {
  openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>
}

/** 失败反馈（由调用方注入，避免本模块依赖通知桥）。 */
export type OpenExternalReporter = (title: string, detail?: string | undefined) => void

/**
 * 用系统默认浏览器打开外链。
 *
 * 只处理 http/https：其它 scheme 到主进程也会被拒，提前拦下省一次 IPC 往返，
 * 且不会把 `file:` / `javascript:` 之类交给系统。
 *
 * @param url - 目标地址（来自 Markdown href，属不可信输入）。
 * @param options.bridge - `window.corumDesktop`（缺省时回落 `window.open`）。
 * @param options.openWindow - 浏览器回落面（注入以便测试）。
 * @param options.report - 失败反馈。
 * @param options.warn - 诊断输出（注入以便测试）。
 * @returns 是否已交给某条通道（false = scheme 不合法，直接放弃）。
 */
export function openExternalUrl(
  url: string,
  options: {
    bridge?: OpenExternalBridge | undefined
    openWindow?: ((href: string) => void) | undefined
    report?: OpenExternalReporter | undefined
    warn?: ((message: string, detail?: unknown) => void) | undefined
  } = {},
): boolean {
  const { bridge, openWindow, report, warn } = options
  if (!/^https?:\/\//i.test(url)) {
    warn?.('[ui-chat] openExternal refused a non-http(s) link', { url })
    return false
  }
  if (bridge?.openExternal === undefined) {
    // 纯浏览器运行时这是正常路径（没有壳）；桌面壳里不该走到这里。
    openWindow?.(url)
    return true
  }
  void bridge.openExternal(url).then((result) => {
    if (result.ok) return
    warn?.('[ui-chat] openExternal failed:', result.error)
    report?.('无法打开链接', result.error)
  }).catch((error: unknown) => {
    warn?.('[ui-chat] openExternal threw:', error)
    report?.('无法打开链接', error instanceof Error ? error.message : String(error))
  })
  return true
}
