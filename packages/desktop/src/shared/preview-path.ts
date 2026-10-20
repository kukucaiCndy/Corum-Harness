/** 外部文件预览使用临时文件标识，与工作区相对路径分开。 */
export const EXTERNAL_PREVIEW_PREFIX = '/.corum-preview/'

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
