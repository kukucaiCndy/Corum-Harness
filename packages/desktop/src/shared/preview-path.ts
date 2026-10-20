/**
 * 外部文件预览使用不可盘的 scheme 标识，与工作区相对路径彻底分开。
 *
 * 曾用 `/.corum-preview/` 前缀：它落在**工作区相对路径空间**里，仓库里真有同名
 * 目录时（`list` 过滤点开头目录 ⇒ 界面上看不见）`read` 会被当成令牌报
 * "external preview is unavailable"、写入会被 `assertWritablePath` 误拒 —— 静默失败。
 * 改成 scheme 后任何真实路径都不可能与令牌撞名（先例：编辑器 diff tab 的 `diff://`）。
 */
export const EXTERNAL_PREVIEW_PREFIX = 'corum-preview://'

export function isExternalPreviewPath(path: string): boolean {
  return path.startsWith(EXTERNAL_PREVIEW_PREFIX)
}

/** 浏览器侧路径换算：按目录边界匹配，兼容 Windows 分隔符与大小写。 */
export function workspaceRelativePath(root: string | null, absolute: string): string | null {
  if (root === null || root === '') return null
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = absolute.replace(/\\/g, '/')
  const windows = /^[a-z]:/i.test(base) || base.startsWith('//')
  const comparedBase = windows ? base.toLowerCase() : base
  const comparedPath = windows ? path.toLowerCase() : path
  if (comparedPath === comparedBase) return '/'
  return comparedPath.startsWith(comparedBase + '/') ? path.slice(base.length) : null
}
