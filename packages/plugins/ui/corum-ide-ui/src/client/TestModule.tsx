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
  /** Live facts to print (owner share / session id / sizes). */
  facts?: string[]
}

/** Whether this window is a detached floating window (the ?floating= mount). */
function isFloatingWindow(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('floating')
}

/** One test card (see module doc). */
export function TestModule({ slot, caption, accent = 'plain', action, facts = [] }: TestModuleProps) {
  const floating = isFloatingWindow()
  return (
    <div className={css.card} data-accent={accent} data-testid={`corum-test-${slot.replace(/\./g, '-')}`}>
      {/* 浮动窗里隐藏 head——Window Chrome 已标识槽位，不再叠一层。 */}
      {!floating && (
        <div className={css.head}>
          <span className={css.slot}>{slot}</span>
          <span className={css.badge}>S0 测试模块</span>
        </div>
      )}
      <div className={css.caption}>{caption}</div>
      {facts.length > 0 && (
        <ul className={css.facts}>
          {facts.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
      {action && (
        <div className={css.actions}>
          <button type="button" className={css.action} onClick={action.onClick}>
            {action.label}
          </button>
        </div>
      )}
    </div>
  )
}
