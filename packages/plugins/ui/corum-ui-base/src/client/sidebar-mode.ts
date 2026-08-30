/**
 * 侧栏模式（任务/项目）共享运行时源 —— shell-base。
 *
 * 模式状态由侧栏骨架（SidebarSkeleton）持有，但会话区空态（hero）等其它区域
 * 也需要按模式渲染不同内容（2026-08-30 空态设计稿：任务模式显示「新建任务/
 * 打开目录」，项目模式显示「新建工程/打开工程」）。
 *
 * 关键（2026-08-30 实测）：本文件被各插件 bundle **各自内联打包**（tsdown
 * noExternal 强制内联 corum 包）——每个 bundle 是独立的模块实例，模块级
 * currentMode 互不通（侧栏 set 的是侧栏实例、会话区 get 的是会话实例）。
 * 故运行时状态挂 **window 全局单例**（__corumSidebarMode），跨 bundle 共享；
 * 模块只导出访问器（每个 bundle 的访问器操作同一全局）。
 */

/** 侧栏模式（design mode-switch：任务=默认 / 项目）。 */
export type SidebarMode = 'task' | 'project'

/** window 全局单例的形态（跨 bundle 共享）。 */
interface SidebarModeGlobal {
  mode: SidebarMode
  listeners: Set<() => void>
}

/** 取/初始化全局单例（幂等——多 bundle 各自调用只建一次）。 */
function globalRef(): SidebarModeGlobal {
  const w = window as unknown as { __corumSidebarMode?: SidebarModeGlobal }
  w.__corumSidebarMode ??= { mode: 'task', listeners: new Set() }
  return w.__corumSidebarMode
}

/** 写方：更新侧栏模式并广播（侧栏骨架在模式切换时调用）。 */
export function setSidebarMode(mode: SidebarMode): void {
  const g = globalRef()
  if (g.mode === mode) return
  g.mode = mode
  for (const listener of [...g.listeners]) listener()
}

/** uSES subscribe：模式变化时通知。 */
export function subscribeSidebarMode(listener: () => void): () => void {
  const g = globalRef()
  g.listeners.add(listener)
  return () => { g.listeners.delete(listener) }
}

/** uSES getSnapshot：当前模式（全局单值，引用稳定）。 */
export function getSidebarModeSnapshot(): SidebarMode {
  return globalRef().mode
}

