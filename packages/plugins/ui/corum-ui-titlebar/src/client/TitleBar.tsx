/** 全局窗口标题栏；会话标题和统计由对话区自己的 header 承载。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Columns2, Copy, FolderTree, Minus, PanelLeftClose, PanelLeftOpen, Square, Terminal, X } from 'lucide-react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChromeState } from '@corum/corum-ide-ui/client'
import { resolveTrafficLightInset } from './traffic-light-inset.ts'
import css from './TitleBar.module.css'

interface TitleBarDesktopBridge {
  getPlatform?: () => 'darwin' | 'linux' | 'win32'
  minimizeWindow?: () => void
  toggleMaximizeWindow?: () => void
  closeWindow?: () => void
  isMaximized?: () => Promise<boolean>
  onMaximizeChange?: (callback: (maximized: boolean) => void) => () => void
}
export interface ObservableSource<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}
export interface TitleBarInjected {
  hooks: { chrome: ObservableSource<ChromeState> }
  toggleSidebarCollapsed: () => void
  toggleRegion: (slot: string) => void
  toggleExplorer: () => void
  closeSession: () => void
}
export type TitleBarProps = PropsRuntime<'corum.titlebar'> & InjectFace<TitleBarInjected>
function IconButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return <button type="button" className={css.iconBtn} title={label} aria-label={label} onClick={onClick}>{icon}</button>
}
export function TitleBar({ variant, useChrome, useSessions, toggleSidebarCollapsed, toggleRegion, toggleExplorer, closeSession }: TitleBarProps) {
  const sidebarCollapsed = useChrome(c => c.sidebarCollapsed)
  const cwd = useSessions(s => s.current === undefined ? undefined : s.byId[s.current]?.cwd)
  const project = cwd?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)
  const floating = variant === 'floating'
  const desktop = typeof window === 'undefined' ? undefined : (window as unknown as { corumDesktop?: TitleBarDesktopBridge }).corumDesktop
  const platform = desktop?.getPlatform?.()
  const showWindowControls = !floating && (platform === 'win32' || platform === 'linux')
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!showWindowControls) return
    void desktop?.isMaximized?.().then(setMaximized)
    const off = desktop?.onMaximizeChange?.(value => { setMaximized(value) })
    return () => { off?.() }
  }, [showWindowControls, desktop])
  // data-session-band 是 Electron 启动页既有的主界面就绪标记。
  return (
    <div className={css.band} data-variant={variant} data-session-band="window">
      <div className={css.dragInset} style={{ width: resolveTrafficLightInset(floating) }} aria-hidden="true" />
      <div className={css.brand}>
        <button type="button" className={css.brandButton} disabled={floating} aria-label={floating ? undefined : '返回首页'} title={floating ? undefined : '返回首页（保留会话）'} onClick={closeSession}>
          <img src="corumapp://app/assets/icon.png" alt="" draggable={false} />
          <strong>Corum Harness</strong>
        </button>
        {project && <span className={css.project} title={cwd}>{project}</span>}
      </div>
      <div className={css.dragSpacer} data-drag-band={variant + ':spacer'} aria-hidden="true" />
      {!floating && <div className={css.controls}>
        <IconButton icon={sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />} label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'} onClick={toggleSidebarCollapsed} />
        <IconButton icon={<Columns2 size={18} />} label="显示/隐藏 编辑器" onClick={() => { toggleRegion('corum.editor') }} />
        <IconButton icon={<FolderTree size={18} />} label="显示/隐藏 资源管理器" onClick={toggleExplorer} />
        <IconButton icon={<Terminal size={18} />} label="显示/隐藏 终端" onClick={() => { toggleRegion('corum.panel') }} />
      </div>}
      {showWindowControls && <div className={css.windowControls} data-drag-band="main:window-controls">
        <button type="button" className={css.winBtn} aria-label="最小化" title="最小化" onClick={() => { desktop?.minimizeWindow?.() }}><Minus size={16} /></button>
        <button type="button" className={css.winBtn} aria-label={maximized ? '向下还原' : '最大化'} title={maximized ? '向下还原' : '最大化'} onClick={() => { desktop?.toggleMaximizeWindow?.() }}>{maximized ? <Copy size={14} /> : <Square size={14} />}</button>
        <button type="button" className={css.winBtn + ' ' + css.winBtnClose} aria-label="关闭" title="关闭" onClick={() => { desktop?.closeWindow?.() }}><X size={16} /></button>
      </div>}
    </div>
  )
}
