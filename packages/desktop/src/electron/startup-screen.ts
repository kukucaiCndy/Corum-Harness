import { BrowserWindow, WebContentsView } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StartupGate } from './startup-state.ts'
import { createStartupThemeSession, restrictStartupNavigation } from './startup-theme-protocol.ts'
import type { ResolvedStartupTheme } from './startup-themes.ts'

/**
 * 启动状态。`phase` 是粗粒度门禁（loading/ready/error），`stage` 是细粒度进度
 * （供动画切换阶段用），`progress` 是 0-100 的估值。
 *
 * 启动流程埋点（main.ts launchCombo）：
 * - 'env'      → 检查环境并唤醒 Agent（spawnHost 前 → host ready）
 *                （原 env 与 spawn 两段，2026-10-17 合并：环境检查几乎瞬时完成）
 * - 'plugins'  → 装配插件（host ready，开始加载主界面页面）
 * - 'mounting' → 基本就绪（页面已加载，等 React 挂载完成）
 * - ready      → 主界面就绪（gate.ready，动画可以收尾进入）
 */
export interface StartupStatus {
  phase: 'loading' | 'ready' | 'error'
  /** 细粒度阶段（仅 phase='loading' 时有意义；动画据此切换文字/进度）。 */
  stage?: 'env' | 'plugins' | 'mounting'
  /** 进度估值 0-100（动画据此推进进度条，但最终以 ready 为准）。 */
  progress?: number
  message?: string
}

/** 在主页面之上显示本地启动页；主页面加载期间不移除展示层。 */
export function createStartupScreen(win: BrowserWindow, animationEnabled: boolean, retry: () => void, theme: ResolvedStartupTheme) {
  const view = new WebContentsView({ webPreferences: {
    preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    session: createStartupThemeSession(theme, { theme: theme.info, animationEnabled, preview: false, platform: process.platform }),
  } })
  restrictStartupNavigation(view.webContents, theme)
  view.setBackgroundColor('#050403')
  let disposed = false
  let fallbackShown = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let status: StartupStatus = { phase: 'loading' }
  const resize = (): void => { if (!win.isDestroyed()) { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }) } }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearTimeout(watchdog)
    win.removeListener('resize', resize)
    win.removeListener('closed', dispose)
    if (!win.isDestroyed()) { win.contentView.removeChildView(view); win.webContents.focus() }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
  const gate = new StartupGate(dispose, animationEnabled)
  const fallback = (): void => {
    if (disposed || fallbackShown) return
    fallbackShown = true
    clearTimeout(watchdog)
    gate.finish()
    if (!disposed) void view.webContents.loadURL('corumapp://startup/loading.html').catch(error => {
      console.error('[corum-startup] 加载提示页无法显示', error)
    })
  }
  // 独立于 renderer 的保护：主题脚本卡住或播放器崩溃也不能挡住已就绪的主界面。
  if (animationEnabled && theme.info.type === 'html') watchdog = setTimeout(fallback, 45_000)
  view.webContents.on('render-process-gone', fallback)
  view.webContents.on('unresponsive', () => { if (!disposed) view.webContents.forcefullyCrashRenderer() })
  const publish = (next: StartupStatus): void => {
    status = next
    if (!disposed && !view.webContents.isDestroyed()) view.webContents.send('corum:startup-status', status)
  }
  win.contentView.addChildView(view)
  view.setVisible(true)
  resize()
  win.on('resize', resize)
  win.once('closed', dispose)
  void view.webContents.loadURL('corumapp://startup/index.html').then(() => {
    if (!disposed && !view.webContents.isDestroyed()) view.webContents.focus()
  }).catch(error => {
    console.error('[corum-startup] 启动页加载失败', error)
    gate.finish()
  })
  return {
    senderId: view.webContents.id,
    getStatus: () => status,
    finish: () => { clearTimeout(watchdog); gate.finish() },
    /** 发送细粒度阶段（供动画切换文字/进度）。不触发 gate，只是更新 UI。 */
    publishStage: (stage: NonNullable<StartupStatus['stage']>, progress: number) => {
      if (disposed || status.phase === 'error') return
      publish({ phase: 'loading', stage, progress })
    },
    ready: () => {
      if (disposed || status.phase === 'error') return
      publish({ phase: 'ready', progress: 100 })
      view.webContents.focus()
      gate.ready()
    },
    fail: (message: string) => { gate.fail(); publish({ phase: 'error', message }) },
    retry: () => { if (status.phase === 'error' && !disposed) { dispose(); retry() } },
    dispose,
  }
}
