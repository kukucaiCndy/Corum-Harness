/**
 * SidebarSkeleton — the IDE left column 骨架（design.pen ① 双模式侧栏的壳）。
 *
 * 骨架只做：品牌区 + 「项目/任务」模式切换 + 两个子槽渲染（corum.sidebar.sessions /
 * corum.sidebar.project）。内容（会话列表 / 项目模式）由子槽 occupant 提供——
 * 开源版只插 sessions 插件（project 槽空 → 「项目」tab 不显示，仅剩任务模式）。
 *
 * 集体脱出：子槽填充物随 corum.sidebar 这一个 grid leaf 的渲染树走，脱出时
 * 整列（含付费版才有项目段）一起进浮动窗，壳无需感知插件拆法。
 *
 * 模式切换反转动画（DESIGN §7.10）：mode 是目标（tab 态即时跟随点击），restMode
 * 是当前静止面板；两者不一致 = 反转进行中——旧面板 data-flipping="out"（rotateY
 * 0→90° + 淡出 120ms easeIn，绝对定位覆盖在新内容上），新面板 data-flipping="in"
 * （rotateY -90°→0° + 淡入 200ms easeOutExpo，延迟 40ms 起跳 = 与退出重叠 80ms），
 * 总时长后 restMode 对齐 mode。双面板常驻挂载（仅切可见性）保住组件态的语义不变。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarSkeletonInjected } from './index.ts'
import css from '@corum/corum-ide-ui/sidebar.module.css'

/** Composed props: 壳的 owner 面 + 子槽渲染面 + 骨架 inject 面（hooks 室绑定为 use* 选择器 Hook）。 */
export type SidebarSkeletonProps =
  & PropsRuntime<'corum.sidebar'>
  & PropsRenderSlots<'corum.sidebar.sessions' | 'corum.sidebar.project'>
  & InjectFace<SidebarSkeletonInjected>

/** 侧栏模式（design mode-switch：任务=默认 / 项目）。 */
type SidebarMode = 'task' | 'project'

/** 反转动画总时长：出 120ms + 入 200ms − 重叠 80ms（DESIGN §7.10；reduced-motion 下 CSS 降级为 150ms 纯透明度，仍被覆盖）。 */
const FLIP_TOTAL_MS = 240

/** The IDE left column skeleton (see module doc). */
export function SidebarSkeleton({ wide, renderSlot, useProjectOccupied }: SidebarSkeletonProps) {
  // 目标模式：tab 激活态与 aria-selected 即时跟随点击。
  const [mode, setMode] = useState<SidebarMode>('task')
  // 落定模式：当前静止展示的面板；反转动画播完后对齐 mode。
  const [restMode, setRestMode] = useState<SidebarMode>('task')
  // 项目槽占用（付费版项目插件插入后为 true）。hooks 室源已由 slots 绑定为选择器 Hook。
  const projectAvailable = useProjectOccupied(s => s)
  // 项目插件被卸载（付费→开源切换）时若正在项目模式，退回任务模式。
  const effectiveMode: SidebarMode = projectAvailable ? mode : 'task'
  const flipping = effectiveMode !== restMode

  // 反转收尾：总时长到点后把落定面板对齐目标模式（摘掉 data-flipping、可见性交还 data-active）。
  // 快速往返点击时清理重排：mode 回到 restMode 即刻静止，无残影。
  useEffect(() => {
    if (!flipping) return
    const timer = window.setTimeout(() => { setRestMode(effectiveMode) }, FLIP_TOTAL_MS)
    return () => { window.clearTimeout(timer) }
  }, [flipping, effectiveMode])

  /** 一个面板的 data-flipping：静止时无值；反转中 = 自己是旧面（out）还是新面（in）。 */
  const flipStateOf = (paneMode: SidebarMode): 'out' | 'in' | undefined =>
    flipping ? (paneMode === restMode ? 'out' : 'in') : undefined

  return (
    <div className={css.sidebar} data-wide={wide || undefined}>
      {/* brand-row（design W7RwT1 2026-08-28 定稿 v7）：矩道品牌卡（134×54 r10，
          鲸鱼+矩道+Corum Harness+Powered by DSH 一体卡，深/浅主题同一张）+
          mode-switch「项目/任务」（110×36，行高 54 垂直居中）。
          侧边栏不可关闭（2026-08-25 设计：移除 region-actions）。 */}
      <header className={css.brandRow}>
        <span className={css.brand}>
          <img
            className={css.brandImg}
            src="corumapp://app/assets/brand_card.png"
            alt="矩道 Corum Harness"
            draggable={false}
          />
        </span>
        {projectAvailable && (
          <div className={css.modeSwitch} role="tablist" aria-label="侧栏模式" data-mode={effectiveMode}>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === 'project'}
              className={`${css.modeSeg}${effectiveMode === 'project' ? ` ${css.modeSegActive}` : ''}`}
              onClick={() => setMode('project')}
            >
              项目
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === 'task'}
              className={`${css.modeSeg}${effectiveMode === 'task' ? ` ${css.modeSegActive}` : ''}`}
              onClick={() => setMode('task')}
            >
              任务
            </button>
          </div>
        )}
      </header>
      <div className={css.brandDivider} />

      {/* 内容区：两个子槽常驻挂载、仅按模式切可见性——切模式不丢组件态
          （项目详情的 activeProject 等），对齐旧单体侧栏的状态存活语义。
          sessions 槽必填（开源版也有）；project 槽付费版才有 occupant。
          sidebarBody 提供反转动画的透视与覆盖定位上下文（DESIGN §7.10）。 */}
      <div className={css.sidebarBody}>
        <div
          className={css.pane}
          data-active={restMode === 'task'}
          data-flipping={flipStateOf('task')}
        >
          {renderSlot('corum.sidebar.sessions', {})}
        </div>
        {projectAvailable && (
          <div
            className={css.pane}
            data-active={restMode === 'project'}
            data-flipping={flipStateOf('project')}
          >
            {renderSlot('corum.sidebar.project', {})}
          </div>
        )}
      </div>
    </div>
  )
}
