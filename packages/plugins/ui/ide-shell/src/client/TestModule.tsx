/**
 * Shell-owned S0 test modules: one self-identifying glass card per slot, so
 * the whole IDE frame is filled with *test* surfaces (not real features).
 * Each card names its slot, its geometry budget, and — where a control is
 * available — a button that exercises the cross-plugin panel-action face
 * (ctx.layout). Token-only styles; no business content.
 */
import css from './TestModule.module.css'

/** The visual signature per test card (slot name + what it proves). */
export interface TestModuleProps {
  /** The slot this card occupies. */
  slot: string
  /** One line: what this slot's geometry/composition proves. */
  caption: string
  /** Optional accent (border-active glow) to distinguish the card. */
  accent?: 'brand' | 'accent' | 'plain'
  /** Optional button: label + handler (e.g. a ctx.layout toggle). */
  action?: { label: string; onClick: () => void }
  /** Detach this slot into a floating window (the Electron open-floating bridge). */
  onPopOut?: () => void
  /** Live facts to print (owner share / session id / sizes). */
  facts?: string[]
}

/** One test card (see module doc). */
export function TestModule({ slot, caption, accent = 'plain', action, onPopOut, facts = [] }: TestModuleProps) {
  return (
    <div className={css.card} data-accent={accent} data-testid={`corum-test-${slot.replace(/\./g, '-')}`}>
      <div className={css.head}>
        <span className={css.slot}>{slot}</span>
        <span className={css.badge}>S0 测试模块</span>
      </div>
      <div className={css.caption}>{caption}</div>
      {facts.length > 0 && (
        <ul className={css.facts}>
          {facts.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
      <div className={css.actions}>
        {action && (
          <button type="button" className={css.action} onClick={action.onClick}>
            {action.label}
          </button>
        )}
        {onPopOut && (
          <button type="button" className={css.popout} onClick={onPopOut} title="脱出为独立浮动窗口">
            ⇱ 脱出
          </button>
        )}
      </div>
    </div>
  )
}
