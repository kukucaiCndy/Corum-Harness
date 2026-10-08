/**
 * 平台相关的路径工具（P2：渲染层消费面收口的**唯一共享面**）。
 *
 * 事实源：渲染层经 preload 的 `window.corumDesktop.getPlatform()`（合法 window
 * 挂载，写一次只读，红线 1 例外）拿到**实际运行平台**的路径分隔符；桥缺席
 * （非桌面壳，如纯 web）时按 POSIX 处理。渲染层**拿不到 `process.platform`**
 * （方案 §4.4：plugins 各包 src 里零命中），也**绝不硬编码 `/`**——Windows 的
 * cwd 用 `\`，硬拼 `/` 永不匹配。
 *
 * 各消费点（file-tool-card / SubagentChanges / EmptyStateHero / FileExplorer）
 * 从这里取，不各自 import 整份桥声明（红线 3：本模块即那份窄接口）。
 * @module corum-ui-base/client/platform-paths
 */

declare global {
  interface Window {
    /** 桌面 preload 暴露的桥（本模块只用到 getPlatform 这一个方法）。 */
    corumDesktop?: { getPlatform?: () => 'darwin' | 'linux' | 'win32' }
  }
}

/** 当前平台的路径分隔符（'\\' = win32，'/' = 其余/桥缺席）。 */
export function pathSep(): '/' | '\\' {
  if (typeof window === 'undefined') return '/'
  return window.corumDesktop?.getPlatform?.() === 'win32' ? '\\' : '/'
}

/**
 * 拼一段路径（`parent` + `name`），分隔符按当前平台。
 * `parent` 已以分隔符结尾（含根 '/' 或盘符根 'C:\\'）时不重复加。
 */
export function joinPath(parent: string, name: string): string {
  if (parent === '') return name
  if (parent.endsWith('/') || parent.endsWith('\\')) return `${parent}${name}`
  return `${parent}${pathSep()}${name}`
}

/**
 * 取路径末段（basename），同时认 `/` 与 `\`——输入可能来自任一端
 * （host 给的路径用平台分隔符，快照里的相对路径常用 `/`），只认一种会在
 * 跨平台数据流上漏判。
 */
export function basenameOf(path: string): string {
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] ?? path
}

/**
 * cwd 相对化（官方 `relativizeToCwd` 同语义）：`path` 在 `cwd` 之下时返回相对段。
 * 分隔符按当前平台匹配（Windows 的 cwd 用 `\`，硬拼 `/` 永不匹配）。
 */
export function shortenPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const prefix = `${cwd}${pathSep()}`
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  return path
}
