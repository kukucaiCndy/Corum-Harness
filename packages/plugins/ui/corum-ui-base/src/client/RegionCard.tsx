/**
 * RegionCard —— 区域的标准卡片基座。
 *
 * 所有区域（子壳自行定义的槽位）都通过这个基座渲染，保证统一的卡片外观
 * 与区域级操作：
 *   - 卡片背景/描边走 token 兜底（--corum-glass-1 → --dsw-alias-bg-layer-1），
 *     shell-base 的极简主题下落到官方 token；子壳（如 ide-shell）可用自己的
 *     主题变量覆盖成玻璃质感
 *   - 内容区非交互处按下并拖出窗口 → 触发拖出（组件交互/文字选择不受影响）
 */
import { forwardRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import css from './RegionCard.module.css'

/** RegionCard 的 props。 */
export interface RegionCardProps {
  /** 区域内容（slot 渲染结果）。 */
  children: ReactNode
  /** 拖出为浮动窗（区域内非交互处长按左键拖拽出窗口时触发；缺省禁用拖出）。 */
  onPopOut?: (() => void) | undefined
  /** 透传给卡片根的 data-slot（用于 grid 定位/调试）。 */
  slotKey?: string | undefined
  /** 内容区附加 className（区域自定义内容布局）。 */
  bodyClassName?: string | undefined
  /** 透明变体：不画整卡背景/描边（子壳内容子卡独立、间隙透出背景时启用）。 */
  transparent?: boolean | undefined
}

/**
 * 交互元素判定清单（拖拽让位）：这些内容上的按下/拖拽交给组件自身交互或
 * 文字选择，不触发区域拖拽/网格重排。GridView 的 dragstart 让位与本文件的
 * mousedown 让位共用此常量，避免两处清单漂移。
 *
 * 覆盖（2026-08-30 补全）：原生交互控件（button/a/input/textarea/select/img/
 * summary/label/audio/video）+ 内容编辑（contenteditable）+ Monaco
 * （[data-monaco-editor] 宿主 + .monaco-editor 内核类——宿主可能因空态未挂载，
 * 内核类兜底已挂载场景）+ 常见 ARIA 交互角色（button/textbox/link/checkbox/
 * radio/slider/spinbutton/combobox/listbox/option/menuitem 系/tab/switch/
 * searchbox/treeitem/scrollbar）+ 显式标记 data-interactive。
 * 故意不含 [draggable="true"]——GridView 整叶根本身 draggable，含它会让每次
 * dragstart 命中整叶根被 preventDefault、整叶永远拖不动（见 GridView 注释）。
 */
export const INTERACTIVE_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'img',
  'summary',
  'label',
  'audio',
  'video',
  '[contenteditable="true"]',
  '[data-monaco-editor]',
  '.monaco-editor',
  '[data-interactive]',
  '[role="button"]',
  '[role="textbox"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="searchbox"]',
  '[role="treeitem"]',
  '[role="scrollbar"]',
].join(', ')

/**
 * 卡片容器清单（2026-08-30 用户定调：卡片整体不可拖——卡片上按下拖动 = 选中
 * 文字或无反应，不触发区域拖拽/网格重排）。命中：消息气泡 / 工具聚合卡 /
 * 审批卡 / Review 卡 / 子 Agent 卡 / 会话行 / 文件树行 / 项目行等。CSS
 * Modules 哈希前缀稳定（如 _9Q52kG_sr / LRfKSG_bubble），用语义子串的
 * 属性前缀选择器匹配（[class*="_sr"] 等）。GridView 的 dragstart 让位与
 * 本文件的 mousedown 让位共用。
 */
export const CARD_SELECTOR = [
  // 会话区消息卡（corum-ui-chat / corum-ui-approval 各卡片根）。
  '[class*="_bubble"]',
  '[class*="_reviewCard"]',
  '[class*="_approvalCard"]',
  '[class*="_subagentCard"]',
  '[class*="_turnProcess"]',
  '[class*="_toolCard"]',
  // 侧栏会话行 / 组行 / 历史行 / 团队行 / 管理行。
  '[class*="_sr"]',
  '[class*="_groupRow"]',
  '[class*="_historyRow"]',
  '[class*="_teamSr"]',
  '[class*="_manageRow"]',
  // 文件树行 / 项目行。
  '[class*="_treeRow"]',
  '[class*="_projectRow"]',
].join(', ')

/** 交互元素判定：这些内容上的按下不触发区域拖拽（交给组件自身交互/文字选择）。 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest(INTERACTIVE_SELECTOR) !== null
}

/** 卡片容器判定：卡片上的按下不触发区域拖拽（用户定调：卡片整体不可拖）。 */
export function isCardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest(CARD_SELECTOR) !== null
}

/**
 * 标准区域卡片基座。forwardRef 暴露卡片根（GridView 需要 ref 测量 drop zone）。
 */
export const RegionCard = forwardRef<HTMLDivElement, RegionCardProps>(function RegionCard(props, ref) {
  const { children, onPopOut, slotKey, bodyClassName, transparent } = props

  // 非交互处按下并拖拽 → 脱出为浮动窗。拖出窗口可视区（坐标越界）触发 onPopOut；
  // 窗口内释放 / 位移太小（当作文字选择或偶然拖动）则取消，不移动内容。
  const onBodyMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !onPopOut) return
    if (isInteractiveTarget(e.target) || isCardTarget(e.target)) return
    const selection = window.getSelection()
    if (selection !== null && !selection.isCollapsed) return // 用户在选文字，让位
    const startX = e.clientX
    const startY = e.clientY
    let armed = false // 是否已超过拖拽阈值（避免点击/选文字被误判成拖拽）
    const DRAG_THRESHOLD = 6
    const style = document.createElement('style')
    const arm = () => {
      if (armed) return
      armed = true
      style.textContent = `* { cursor: grabbing !important; user-select: none !important; -webkit-user-select: none !important; }`
      document.head.appendChild(style)
    }
    const onMove = (ev: MouseEvent) => {
      if (!armed && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
      arm()
      ev.preventDefault()
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      style.remove()
      if (!armed) return // 未达阈值：当作普通点击/选择，不脱出
      const outX = ev.clientX <= 0 || ev.clientX >= window.innerWidth
      const outY = ev.clientY <= 0 || ev.clientY >= window.innerHeight
      if (outX || outY) onPopOut()
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
  }, [onPopOut])

  return (
    <div ref={ref} className={`${css.card}${transparent ? ` ${css.cardTransparent}` : ''}`} data-slot={slotKey}>
      {/* 内容区：非交互处按下并拖出窗口 → 拖出为浮动窗。 */}
      <div className={bodyClassName ? `${css.body} ${bodyClassName}` : css.body} onMouseDown={onBodyMouseDown}>
        {children}
      </div>
    </div>
  )
})
