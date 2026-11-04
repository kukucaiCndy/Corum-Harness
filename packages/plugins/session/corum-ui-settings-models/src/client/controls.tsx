/**
 * corum 玻璃控件：模型页跳页四态共用的基础元件（图标盒 / 状态胶囊 /
 * 文本字段 / 下拉 / 开关 / 模型 chip / 步进器）。全部消费 --corum-glass-*
 * 与 --dsw-alias-* 设计 token，零硬编码 hex。
 *
 * 数值来源：design.pen 模型页复刻基准稿（P0 ib28i / P1 D19Y6d / P2 FhPLe /
 * P4 nmPaK）提取表 —— iconbox 34×34 r9、status 胶囊 r6 pad[3,9]、字段框
 * 180/260 glass-2 r10 pad[7,10]、chip r7 pad[4,9]、开关 36×20。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'

/* ── lucide 图标（内联 SVG，避免新增依赖；语义名对齐设计稿） ── */

function Svg({ size, children, strokeWidth = 1.8 }: { size: number; children: ReactNode; strokeWidth?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

export function IconCpu({ size = 17 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M15 2v2M15 20v2M9 2v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2" />
    </Svg>
  )
}

export function IconPencil({ size = 14 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </Svg>
  )
}

export function IconTrash({ size = 14 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  )
}

export function IconPlus({ size = 14 }: { size?: number }): ReactNode {
  return <Svg size={size}><path d="M12 5v14M5 12h14" /></Svg>
}

export function IconChevronDown({ size = 14 }: { size?: number }): ReactNode {
  return <Svg size={size}><path d="m6 9 6 6 6-6" /></Svg>
}

export function IconChevronLeft({ size = 14 }: { size?: number }): ReactNode {
  return <Svg size={size}><path d="m15 18-6-6 6-6" /></Svg>
}

export function IconChevronRight({ size = 11 }: { size?: number }): ReactNode {
  return <Svg size={size}><path d="m9 18 6-6-6-6" /></Svg>
}

export function IconZap({ size = 12 }: { size?: number }): ReactNode {
  return <Svg size={size}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></Svg>
}

export function IconCheck({ size = 11 }: { size?: number }): ReactNode {
  return <Svg size={size}><path d="M20 6 9 17l-5-5" /></Svg>
}

export function IconX({ size = 14 }: { size?: number }): ReactNode {
  return <Svg size={size}><path d="M18 6 6 18M6 6l12 12" /></Svg>
}

export function IconRotateCcw({ size = 12 }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  )
}

export function IconMinus({ size = 12 }: { size?: number }): ReactNode {
  return <Svg size={size}><path d="M5 12h14" /></Svg>
}

/* ── 图标盒（34×34 r9 glass-2，provider/模型卡头） ── */

export function IconBox(): ReactNode {
  return (
    <span className={styles['iconBox']}>
      <IconCpu size={17} />
    </span>
  )
}

/* ── 状态胶囊（dot + 文字；r6 pad[3,9]） ── */

export function StatusPill({ tone, label }: { tone: 'success' | 'dim' | 'error'; label: string }): ReactNode {
  return (
    <span className={styles['statusPill']}>
      <span className={`${styles['statusDot']} ${styles[`statusDot_${tone}`]}`} />
      <span className={styles['statusText']}>{label}</span>
    </span>
  )
}

/* ── 卡头（iconbox + 名称/描述 ‖ 右侧） ── */

export function CardHead({ name, desc, right }: { name: string; desc: string; right?: ReactNode }): ReactNode {
  return (
    <div className={styles['cardHead']}>
      <span className={styles['cardHeadLeft']}>
        <IconBox />
        <span className={styles['cardHeadTitle']}>
          <span className={styles['cardName']}>{name}</span>
          <span className={styles['cardDesc']}>{desc}</span>
        </span>
      </span>
      {right === undefined ? null : <span className={styles['cardHeadRight']}>{right}</span>}
    </div>
  )
}

/* ── 模型 chip（文字 + ›，可点跳详情） ── */

export function ModelChip({ id, onOpen }: { id: string; onOpen?: () => void }): ReactNode {
  return (
    <button type="button" className={styles['chip']} onClick={onOpen} aria-label={id}>
      <span className={styles['chipText']}>{id}</span>
      <span className={styles['chipGo']}><IconChevronRight size={11} /></span>
    </button>
  )
}

/* ── 文本字段（label + 输入框；180/260） ── */

export function Field({ label, desc, wide, type, value, placeholder, disabled, password, onChange, autoFocus }: {
  label: string
  desc?: string
  wide?: boolean
  type?: string
  value: string
  placeholder?: string
  disabled?: boolean
  password?: boolean
  autoFocus?: boolean
  onChange: (v: string) => void
}): ReactNode {
  return (
    <div className={styles['fieldRow']}>
      <span className={styles['fieldMeta']}>
        <span className={styles['fieldLabel']}>{label}</span>
        {desc === undefined ? null : <span className={styles['fieldDesc']}>{desc}</span>}
      </span>
      <input
        className={`${styles['textField']} ${wide === true ? styles['textFieldWide'] as string : ''}`}
        type={password === true ? 'password' : (type ?? 'text')}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        autoFocus={autoFocus}
        onChange={e => { onChange(e.target.value) }}
      />
    </div>
  )
}

/* ── 下拉（180，portal 浮动面板） ── */

export interface SelectOption { id: string; label: string }

export function SelectField({ value, options, onChange, disabled, ariaLabel }: {
  value: string
  options: readonly SelectOption[]
  onChange: (id: string) => void
  disabled?: boolean
  ariaLabel?: string
}): ReactNode {
  return (
    <span className={styles['selectWrap']}>
      <select
        className={styles['selectField']}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={e => { onChange(e.target.value) }}
      >
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <span className={styles['selectChevron']}><IconChevronDown size={14} /></span>
    </span>
  )
}

/* ── 开关（36×20） ── */

export function Switch({ on, onChange, disabled, ariaLabel }: {
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${styles['switch']} ${on ? styles['switchOn'] as string : ''}`}
      onClick={() => { onChange(!on) }}
    >
      <span className={styles['switchKnob']} />
    </button>
  )
}

/* ── 玻璃按钮（primary / ghost / outline） ── */

export function GlassButton({ kind = 'outline', icon, children, onClick, disabled, danger, autoFocus }: {
  kind?: 'primary' | 'outline' | 'ghost'
  icon?: ReactNode
  children?: ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  autoFocus?: boolean
}): ReactNode {
  const cls = kind === 'primary'
    ? styles['btnPrimary']
    : kind === 'ghost'
      ? styles['btnGhost']
      : styles['btnOutline']
  return (
    <button
      type="button"
      className={`${styles['btn']} ${cls} ${danger === true ? styles['btnDanger'] as string : ''}`}
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
    >
      {icon}
      {children}
    </button>
  )
}

/* ── 设置分组卡（gt 标题 + 行） ── */

export function SettingGroup({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className={styles['settingGroup']}>
      <div className={styles['settingGroupTitle']}>{title}</div>
      {children}
    </section>
  )
}

/* ── 返回行（跳页子视图顶部） ── */

export function BackRow({ onBack, label = '返回模型列表' }: { onBack: () => void; label?: string }): ReactNode {
  return (
    <button type="button" className={styles['back']} onClick={onBack}>
      <IconChevronLeft size={14} />
      {label}
    </button>
  )
}

/* ── 连通性测试结果胶囊 ── */

export interface ConnTestResultLike {
  kind: 'idle' | 'busy' | 'ok' | 'catalog' | 'error'
  ms?: number
  count?: number
  message?: string
}

export function ConnResult({ conn, inline }: { conn: { result: ConnTestResultLike }; inline?: boolean }): ReactNode {
  const r = conn.result
  if (r.kind === 'idle') return null
  if (r.kind === 'busy') return <span className={styles['resultPill']}>测试中…</span>
  if (r.kind === 'ok') {
    return (
      <span className={`${styles['resultPill']} ${styles['resultPill_ok']}`}>
        <IconCheck size={11} />
        连接正常 · {r.ms}ms
      </span>
    )
  }
  if (r.kind === 'catalog') {
    return (
      <span className={`${styles['resultPill']} ${styles['resultPill_ok']}`}>
        <IconCheck size={11} />
        {r.count !== undefined && r.count >= 0 ? `内置目录 · ${r.count} 个模型` : '内置目录路由 · 无需网络探测'}
      </span>
    )
  }
  return <span className={`${styles['resultPill']} ${styles['resultPill_err']}`}>{r.message}</span>
}

/* ── 设置行（meta + 控件，行间分隔） ── */

export function SettingRow({ label, desc, control, divider, stacked }: {
  label: string
  desc?: string
  control: ReactNode
  divider?: boolean | undefined
  /** true = label/desc 在上、控件整宽在下（内容多的行，如模型目录 chips）。 */
  stacked?: boolean | undefined
}): ReactNode {
  return (
    <>
      <div className={`${styles['settingRow']} ${stacked === true ? styles['settingRowStacked'] as string : ''}`}>
        <span className={styles['fieldMeta']}>
          <span className={styles['fieldLabel']}>{label}</span>
          {desc === undefined ? null : <span className={styles['fieldDesc']}>{desc}</span>}
        </span>
        <span className={`${styles['settingControl']} ${stacked === true ? styles['settingControlStacked'] as string : ''}`}>{control}</span>
      </div>
      {divider === false ? null : <div className={styles['settingDivider']} />}
    </>
  )
}

/* ── 容量输入（文本框 + 快捷选择 chips） ── */

/**
 * 快捷容量选项。点击即填入文本框，省去手打 K/M 后缀。
 * 覆盖常见模型的输出能力档位。
 */
const CAPACITY_PRESETS: readonly string[] = ['32K', '64K', '128K', '256K', '384K', '512K']

/**
 * 文本输入框 + 下方一排快捷容量 chips。点击 chip 把该值填入输入框。
 * @param value - 当前文本（如 "128K" 或空串）。
 * @param placeholder - 空值占位提示。
 * @param disabled - 是否禁用。
 * @param onChange - 文本变更回调。
 */
export function CapacityInput({ value, placeholder, disabled, onChange }: {
  value: string
  placeholder?: string
  disabled?: boolean
  onChange: (v: string) => void
}): ReactNode {
  // track focus to only show the preset chips while the field is active,
  // keeping the row compact when the user is not editing it.
  const [focused, setFocused] = useState(false)
  const activePreset = CAPACITY_PRESETS.find(p => p === value)
  return (
    <span className={styles['capacityWrap']}>
      <input
        className={styles['textField']}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={e => { onChange(e.target.value) }}
        onFocus={() => { setFocused(true) }}
        onBlur={() => { setFocused(false) }}
      />
      {(focused || activePreset !== undefined) ? (
        <span className={styles['capacityPresets']}>
          {CAPACITY_PRESETS.map(p => (
            <button
              key={p}
              type="button"
              disabled={disabled}
              className={`${styles['levelChip']} ${p === value ? styles['levelChipOn'] as string : ''}`}
              onMouseDown={e => { e.preventDefault(); onChange(p === value ? '' : p) }}
            >
              {p}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  )
}
