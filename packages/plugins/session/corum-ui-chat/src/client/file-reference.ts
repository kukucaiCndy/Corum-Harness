/** 从文件引用中分离定位信息，不能把 Windows 盘符当作行号。 */
export function parseFileReference(value: string): { path: string; line?: number } | null {
  let path = value.trim()
  if (/^[a-z][\w+.-]*:\/\//i.test(path) || /[\n\r<>(){}=;|"`]/.test(path)) return null
  const location = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(path)
  let line: number | undefined
  if (location !== null) {
    line = Number(location[1] ?? location[2])
    if (!Number.isSafeInteger(line) || line < 1) return null
    path = path.slice(0, location.index)
  }
  if (!/(?:^|[\\/])[^\\/]+\.[a-z][a-z\d]{0,11}$/i.test(path) || path.includes('://')) return null
  return { path, ...(line === undefined ? {} : { line }) }
}
