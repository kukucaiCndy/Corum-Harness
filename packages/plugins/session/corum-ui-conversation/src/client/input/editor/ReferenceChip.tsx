/**
 * Visual body of one inline reference chip: the DecoratorNode's React
 * face. Pure display — identity, invalidation, and lifecycle live on the
 * ReferenceChipNode; this component renders whatever the node carries.
 */
import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { CodeSelection } from '../code-selection.ts'
import { ReferenceIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReferenceIconKind } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ReferenceChip.module.css'

/** Display inputs of one chip (the node's cached owner projections). */
export interface ReferenceChipProps {
  readonly label: string
  /** Domain glyph; absent renders the trigger marker instead of an icon. */
  readonly appearance?: ReferenceIconKind | undefined
  /** Owner-resolution failure styling bit. */
  readonly invalid: boolean
  selection?: CodeSelection | null | undefined
  onOpen?: (() => void) | undefined
  onRemove?: (() => void) | undefined
}

/**
 * Render one inline reference chip.
 * @param props - label, optional domain glyph, and the invalid bit.
 * @returns the chip body (icon + truncating label).
 */
export function ReferenceChip({ label, appearance, invalid, selection, onOpen, onRemove }: ReferenceChipProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<CSSProperties>({})
  useLayoutEffect(() => {
    if (!expanded) return
    const update = (): void => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const above = rect.top > 300
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(420, window.innerWidth * 0.65) - 8)),
        ...(above ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        maxHeight: Math.max(100, (above ? rect.top : window.innerHeight - rect.bottom) - 16) })
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); document.removeEventListener('scroll', update, true) }
  }, [expanded])
  return (
    <span ref={anchor} className={css.anchor} onMouseDown={event => { if (selection) event.preventDefault() }}>
    <span className={clsx(css.chip, invalid && css.invalid)} title={selection?.path ?? label}>
      {appearance === undefined
        ? <span className={css.marker} aria-hidden>@</span>
        : <ReferenceIcon kind={appearance} size={14} className={css.icon} />}
      {selection ? <button type="button" className={css.labelButton} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{label}</button> : <span className={css.label}>{label}</span>}
      {selection && <button type="button" className={css.remove} aria-label="移除代码引用" onClick={onRemove}><X size={12} /></button>}
    </span>
    {expanded && selection && createPortal(<div className={css.preview} style={position} role="dialog" aria-label="代码引用预览">
      <span className={css.previewPath}>{selection.path}:{selection.startLine}–{selection.endLine}</span>
      <pre>{selection.text}</pre>
      <span className={css.previewActions}>
        {onOpen && <button type="button" onClick={() => { onOpen(); setExpanded(false) }}>在编辑器中打开</button>}
        <button type="button" onClick={() => setExpanded(false)}>收起</button>
      </span>
    </div>, document.body)}
    </span>
  )
}
