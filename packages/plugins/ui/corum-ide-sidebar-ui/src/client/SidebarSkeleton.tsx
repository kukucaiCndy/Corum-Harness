/**
 * SidebarSkeleton — the IDE left column 骨架（design.pen ① 双模式侧栏的壳）。
 *
 * 骨架只做：品牌区 + 「项目/任务」模式切换 + 两个子槽渲染（corum.sidebar.sessions /
 * corum.sidebar.project）。内容（会话列表 / 项目模式）由子槽 occupant 提供——
 * 开源版只插 sessions 插件（project 槽空 → 「项目」tab 不显示，仅剩任务模式）。
 *
 * 集体脱出：子槽填充物随 corum.sidebar 这一个 grid leaf 的渲染树走，脱出时
 * 整列（含付费版才有项目段）一起进浮动窗，壳无需感知插件拆法。
 */
import { useState } from 'react'
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

/** The IDE left column skeleton (see module doc). */
export function SidebarSkeleton({ wide, renderSlot, useProjectOccupied }: SidebarSkeletonProps) {
  const [mode, setMode] = useState<SidebarMode>('task')
  // 项目槽占用（付费版项目插件插入后为 true）。hooks 室源已由 slots 绑定为选择器 Hook。
  const projectAvailable = useProjectOccupied(s => s)
  // 项目插件被卸载（付费→开源切换）时若正在项目模式，退回任务模式。
  const effectiveMode: SidebarMode = projectAvailable ? mode : 'task'

  return (
    <div className={css.sidebar} data-wide={wide || undefined}>
      {/* brand-row（pXl6H）：brand-logo + mode-switch「项目/任务」分段。
          侧边栏不可关闭（2026-08-25 设计：移除 region-actions）。 */}
      <header className={css.brandRow}>
        <span className={css.brand}>
          <img
            className={css.brandImg}
            src="corumapp://app/assets/brand_logo_light_crop.png"
            alt="矩道"
            draggable={false}
          />
          <img
            className={css.brandImgDark}
            src="corumapp://app/assets/brand_logo_dark_crop.png"
            alt="矩道"
            draggable={false}
          />
        </span>
        {projectAvailable && (
          <div className={css.modeSwitch} role="tablist" aria-label="侧栏模式">
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
          sessions 槽必填（开源版也有）；project 槽付费版才有 occupant。 */}
      <div className={css.pane} data-active={effectiveMode === 'task'}>
        {renderSlot('corum.sidebar.sessions', {})}
      </div>
      {projectAvailable && (
        <div className={css.pane} data-active={effectiveMode === 'project'}>
          {renderSlot('corum.sidebar.project', {})}
        </div>
      )}
    </div>
  )
}
