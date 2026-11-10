/**
 * SettingRow — 设置行容器（1:1 复刻 design.pen row frame）。
 *
 * 设计稿 row frame：
 * - width: fill_container, gap: 12, padding: [10,2]
 * - justifyContent: space_between, alignItems: center
 * - children: meta(label+desc) + control(select/switch/btn/kbd/chips)
 *
 * @module corum-ide-ui/client/settings/SettingRow
 */
import type { ReactNode } from 'react'
import css from './SettingRow.module.css'

interface SettingRowProps {
  /** 行标题（设计稿 label: Inter 13px 600, label-primary）。 */
  label: string
  /** 行描述（设计稿 desc: Inter 11px normal, label-tertiary）。 */
  desc?: string
  /** 右侧控件（select/switch/button 等）。 */
  children?: ReactNode
  /** 可选徽标（modified/restart badge，渲染在 label 右侧）。 */
  badge?: ReactNode
  /** 是否显示底部分割线（默认 true）。 */
  divider?: boolean
}

/**
 * Render a settings row with label/desc on the left and control on the right.
 * @param props - label, desc, control, badge, divider.
 * @returns the row element with optional divider.
 */
export function SettingRow({ label, desc, children, badge, divider = true }: SettingRowProps) {
  // `data-setting` = 行标题的**稳定语义锚点**（黑盒自测定位用）。
  // 为什么需要它：设置行此前只能靠 CSS Modules 哈希类名（`_xxx_row`）或 `text:` 裸文案
  // 定位，前者两端不同且每次构建变化，后者随文案微调即碎。行标题是这行唯一稳定的语义
  // （同一分区内不重复），故以它作锚点。**只加属性，不改行为/样式/结构。**
  return (
    <>
      <div className={css.row} data-setting={label}>
        <div className={css.meta}>
          <div className={css.labelRow}>
            <span className={css.label}>{label}</span>
            {badge}
          </div>
          {desc && <span className={css.desc}>{desc}</span>}
        </div>
        {children}
      </div>
      {divider && <div className={css.divider} />}
    </>
  )
}
