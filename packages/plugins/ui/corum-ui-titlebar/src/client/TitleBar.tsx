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
import { Columns2, PanelLeftClose, PanelLeftOpen, Terminal } from 'lucide-react'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChromeState } from '@corum/corum-ide-ui/client'
import css from './TitleBar.module.css'

declare global {
  interface Window {
    /** 桌面 preload 暴露的桥（本组件只用 getPlatform 判红绿灯让位，红线 3 窄接口）。 */
    corumDesktop?: { getPlatform?: () => 'darwin' | 'linux' | 'win32' }
  }
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

/** 红绿灯让位宽（主窗）：76 = 活动栏宽（两列上下对齐）。**仅 macOS**（红绿灯
 *  是 mac 专属；其它平台系统标题栏，无灯可让）。 */
const MAIN_INSET = 76
/** 浮窗自带顶栏的让位（浮窗红绿灯位更靠左）。**仅 macOS**。 */
const FLOATING_INSET = 66

/**
 * 红绿灯让位宽（按平台）。macOS 有红绿灯要内联让位；Windows/Linux 是系统
 * 标题栏（windowChromeOptions 返回 {}，无 hiddenInset），**没有灯 ⇒ 让位 0**，
 * 否则顶上留一块无主的 76px 空白（§4.2 隐式假设「macOS 交通灯 76px 内边距」，
 * 在非 darwin 上不报错、只走样）。
 */
function trafficLightInset(floating: boolean): number {
  if (typeof window === 'undefined') return floating ? FLOATING_INSET : MAIN_INSET
  const isMac = window.corumDesktop?.getPlatform?.() === 'darwin'
  if (!isMac) return 0
  return floating ? FLOATING_INSET : MAIN_INSET
}

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
  const insetWidth = trafficLightInset(floating)

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

  const spacerWidth = floating ? 0 : Math.max(0, controlsWidth - insetWidth - controlsNatural)
  // 会话段 = 自 controlsWidth 起铺到带子右缘（对话区格右缘）；带子变窄时收缩到 0。
  const sessionWidth = Math.max(0, bandWidth - (floating ? insetWidth : controlsWidth))

  return (
    <div className={css.band} data-variant={variant}>
      {/* 左拖拽带（红绿灯让位区）：纯命中区，不放控件——见 CSS 的不变式。 */}
      <div
        className={css.dragInset}
        style={{ width: insetWidth }}
        data-drag-band={`${variant}:left-inset`}
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
    </div>
  )
}