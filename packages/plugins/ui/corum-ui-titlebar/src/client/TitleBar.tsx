/**
 * TitleBar — 窗口顶部 40px 带子的**唯一 owner**（拖拽不变式见 TitleBar.module.css）。
 *
 * 按界面状态组合（「接收不同的界面事件来展示」）：
 *   - `variant='main'`：`[红绿灯让位 76][窗口控制按钮][侧栏上空拖拽填充][会话段]`；
 *   - `variant='floating'`（浮窗自带顶栏）：让位收成 66，无窗口控制按钮，只剩会话段。
 * 侧栏折叠（chrome.sidebarCollapsed）时只留「展开」按钮，其余按钮随侧栏一起隐藏
 * ——与 design.pen 状态③ 一致。
 *
 * 会话段（`corum.titlebar.session`）：由 `@corum/corum-ui-conversation`（fork）占位，
 * 内容 = 面包屑 + 状态胶囊 + 轨迹按钮（原先渲染在对话区 leaf 内的会话顶栏卡片，
 * 2026-09-30 并入本带子）。**只在会话域绑定的 key 存在时 renderSlot**：该子槽是
 * session 严格域，无绑定时渲染会抛 `SlotAssemblyError`（见 index.ts 的 sessionBand
 * 注释：判据取槽机制自己用的那份绑定，不用会话列表选择态近似）。
 *
 * 会话段的**本体 drag**（这条带子在对话区上方必须能拖窗，含空态/无会话态），
 * 交互内容全部在 occupant 侧的显式 no-drag 后代里（corum-ui-conversation 的
 * `.header button` 规则）——「同一子树内 drag + no-drag 后代」是已验证形态。
 *
 * 写法纪律：折叠/区域显隐都经 `ctx.layout`（跨 bundle 单例），本组件不持状态。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Columns2, Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, Terminal, X } from 'lucide-react'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChromeState } from '@corum/corum-ide-ui/client'
import { resolveTrafficLightInset } from './traffic-light-inset.ts'
import css from './TitleBar.module.css'

/**
 * 本组件用到的桌面桥能力（红线 3 局部窄化，不 declare global 扩展 window：
 * `corumDesktop` 的全局 `declare global` 已被 corum-ui-base/platform-paths.ts 与
 * corum-session-archive/bridge.ts 各自声明，TS 要求多份声明同型 ⇒ 不能再在此
 * 加第二份不同形状的全局声明。这里按 traffic-light-inset.ts 的同款局部窄化）。
 */
interface TitleBarDesktopBridge {
  getPlatform?: () => 'darwin' | 'linux' | 'win32'
  minimizeWindow?: () => void
  toggleMaximizeWindow?: () => void
  closeWindow?: () => void
  isMaximized?: () => Promise<boolean>
  onMaximizeChange?: (callback: (maximized: boolean) => void) => () => void
}

/** 从 window 读桥（SSR/非桌面返回 undefined）。 */
function readDesktopBridge(): TitleBarDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { corumDesktop?: TitleBarDesktopBridge }).corumDesktop
}

/**
 * 注入面收到的观察源（结构窄化，红线 3）：只声明本组件用到的两个方法，
 * 不 import 官方服务包的实现类型。
 */
export interface ObservableSource<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

/** 会话域绑定（`ctx.uiSession.adapter.current`）：key = 当前主视图会话 id。 */
export interface SessionBandBinding {
  readonly key: string | undefined
}

/** 本插件 client 半在 register 的 inject 工厂里下发的注入面。 */
export interface TitleBarInjected {
  hooks: {
    /** 窗口 chrome 源（`ctx.layout.chromeSnapshot()` 投影，uSES 契约）。 */
    chrome: ObservableSource<ChromeState>
    /**
     * 会话域绑定源（= 槽机制自己那份 `session` scope 绑定）。会话段据此判断
     * 「现在能不能渲染 session 严格域子槽」——不用别的近似信号，理由见模块头。
     */
    sessionBand: ObservableSource<SessionBandBinding>
  }
  /** 折叠 ⟷ 展开侧栏（直通 `ctx.layout.toggleSidebarCollapsed`）。 */
  toggleSidebarCollapsed: () => void
  /** 区域显隐切换（直通 `ctx.layout.toggleRegion`；面板=corum.editor、终端=corum.panel）。 */
  toggleRegion: (slot: string) => void
}

/** Composed props: 壳 renderSlot 下发的 owner 面 + 标准面 + 本插件注入面。 */
export type TitleBarProps =
  PropsRuntime<'corum.titlebar'>
  & PropsRenderSlots<'corum.titlebar.session'>
  & InjectFace<TitleBarInjected>

/** 标题栏小图标按钮（design.pen titlebar-icon-btn CXMkA）：28×28 圆角 8、icon 18。 */
function IconButton({ icon, label, onClick }: {
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={css.iconBtn}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

/** The unified titlebar band (see module doc). */
export function TitleBar({
  variant, bandWidth, controlsWidth, useChrome, useSessionBand, renderSlot,
  toggleSidebarCollapsed, toggleRegion,
}: TitleBarProps) {
  const sidebarCollapsed = useChrome(c => c.sidebarCollapsed)
  const hasSession = useSessionBand(b => b.key !== undefined)
  const floating = variant === 'floating'
  const insetWidth = resolveTrafficLightInset(floating)

  // 控件层的**自然宽**：会话段必须严格自 controlsWidth 起（与对话区格左缘对齐），
  // 而在它之前只有控件层，故中间那段拖拽填充的宽度只能由「控件层量出来的宽」反推。
  const controlsRef = useRef<HTMLDivElement | null>(null)
  const [controlsNatural, setControlsNatural] = useState(0)
  const showControls = !floating
  useEffect(() => {
    const el = controlsRef.current
    if (el === null) { setControlsNatural(0); return undefined }
    const measure = (): void => { setControlsNatural(el.getBoundingClientRect().width) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [showControls, sidebarCollapsed])

  // ── 窗口控制按钮（仅 win32/linux：无原生标题栏，右上角自绘三个按钮）──────
  // macOS 保留系统红绿灯（hiddenInset），不渲染这套。平台判据与红绿灯让位
  // 同源：以 preload 桥的 getPlatform() 为权威。
  const desktop = readDesktopBridge()
  const platform = desktop?.getPlatform?.()
  const showWindowControls = !floating && (platform === 'win32' || platform === 'linux')
  // 左列保留宽：darwin = 红绿灯让位（inset，drag 区）；win32/linux = 76 复用为
  // 「活动栏让位列」——活动栏内容顶到 y=0，在这 76px 列内渲染，titlebar 的
  // 这 76px 让出命中（app-region:none，见 .dragInsetNoTrafficLight），不挡活动栏。
  // 两者数值同 76，但 win/linux 的语义是「给活动栏让位 + 不截获命中」，不是「红绿灯让位 + drag」。
  const hasTrafficLight = platform === 'darwin' || platform === undefined
  const leftColumnReserve = hasTrafficLight ? insetWidth : (floating ? 0 : 76)
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!showWindowControls) return
    // 初始化：拉一次当前态
    void desktop?.isMaximized?.().then(setMaximized)
    // 订阅变化
    const off = desktop?.onMaximizeChange?.((m: boolean) => { setMaximized(m) })
    return () => { off?.() }
  }, [showWindowControls, desktop])

  const spacerWidth = floating ? 0 : Math.max(0, controlsWidth - leftColumnReserve - controlsNatural)
  // 会话段 = 自 controlsWidth 起铺到带子右缘（对话区格右缘）；带子变窄时收缩到 0。
  // win32/linux 上右上角有自绘窗口控制按钮（固定 138px = 3 按钮 × 46），
  // 会话段需让出这段，否则拖拽带会盖到按钮下。
  const windowControlsW = showWindowControls ? 138 : 0
  const sessionWidth = Math.max(0, bandWidth - (floating ? leftColumnReserve : controlsWidth) - windowControlsW)

  return (
    <div className={css.band} data-variant={variant}>
      {/* 左列保留带：darwin=红绿灯让位（drag）；win/linux=活动栏让位（none，让活动栏
          内容穿透命中顶到 y=0）。纯命中区，不放控件——见 CSS 的不变式。 */}
      <div
        className={`${css.dragInset} ${hasTrafficLight ? '' : css.dragInsetNoTrafficLight}`}
        style={{ width: leftColumnReserve }}
        data-drag-band={`${variant}:left-inset`}
        data-traffic-light={hasTrafficLight ? 'present' : 'absent'}
        aria-hidden="true"
      />
      {showControls && (
        /* 控件层：夹在两条拖拽带之间，显式 no-drag。 */
        <div className={css.controls} ref={controlsRef}>
          <IconButton
            icon={sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={toggleSidebarCollapsed}
          />
          {!sidebarCollapsed && (
            <div className={css.actions}>
              <IconButton
                icon={<Columns2 size={18} />}
                label="显示/隐藏 编辑器+资源管理器"
                onClick={() => { toggleRegion('corum.editor') }}
              />
              <IconButton
                icon={<Terminal size={18} />}
                label="显示/隐藏 终端"
                onClick={() => { toggleRegion('corum.panel') }}
              />
            </div>
          )}
        </div>
      )}
      {/* 侧栏上空那一段（控件层自然宽 → 会话段左缘）：纯拖拽，别让窗口在这里拖不动。 */}
      {spacerWidth > 0 && (
        <div
          className={css.dragSpacer}
          style={{ width: spacerWidth }}
          data-drag-band={`${variant}:spacer`}
          aria-hidden="true"
        />
      )}
      {/* 会话段：本体 drag（含空态/无会话态——这条带子在对话区上方必须能拖窗），
          交互内容由 occupant 侧显式 no-drag；底部 1px 光边＝与对话区内容的分界。 */}
      <div
        className={css.session}
        style={{ width: sessionWidth }}
        data-drag-band={`${variant}:session`}
        data-session-band={hasSession ? 'active' : 'empty'}
      >
        {/* session 严格域：无绑定时渲染会抛 SlotAssemblyError，故先判 key。 */}
        {hasSession && renderSlot('corum.titlebar.session', {})}
      </div>
      {showWindowControls && (
        /* 窗口控制按钮组（右上角）：仅 win32/linux。显式 no-drag，与 .controls
           同款规则（不变式 ②）。三个按钮等宽铺到带子右缘。 */
        <div className={css.windowControls} data-drag-band="main:window-controls">
          <button
            type="button"
            className={css.winBtn}
            aria-label="最小化"
            title="最小化"
            onClick={() => { desktop?.minimizeWindow?.() }}
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            className={css.winBtn}
            aria-label={maximized ? '向下还原' : '最大化'}
            title={maximized ? '向下还原' : '最大化'}
            onClick={() => { desktop?.toggleMaximizeWindow?.() }}
          >
            {maximized ? <Copy size={14} /> : <Square size={14} />}
          </button>
          <button
            type="button"
            className={`${css.winBtn} ${css.winBtnClose}`}
            aria-label="关闭"
            title="关闭"
            onClick={() => { desktop?.closeWindow?.() }}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  )
}