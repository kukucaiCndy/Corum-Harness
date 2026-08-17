/**
 * TestPanel — the S0 placeholder for the corum.panel slot: a fake tab strip
 * (终端 / 待办 / 队列) + one body line + a 收起面板 button wired to
 * ctx.layout.togglePanel (via the registration inject factory), proving the
 * panel-action face crosses the shell/plugin boundary. Token-only styles.
 */
import css from './TestPanel.module.css'

/** Injected share from the registration's inject factory. */
export interface TestPanelProps {
  /** Collapse the bottom panel (ctx.layout.togglePanel). */
  onTogglePanel: () => void
}

/** The placeholder panel (see module doc). */
export function TestPanel({ onTogglePanel }: TestPanelProps) {
  return (
    <div className={css.panel} data-testid="corum-panel-placeholder">
      <div className={css.tabRow}>
        <span className={css.tab} data-active>终端</span>
        <span className={css.tab}>待办</span>
        <span className={css.tab}>队列</span>
        <button type="button" className={css.collapse} onClick={onTogglePanel}>
          收起面板（togglePanel）
        </button>
      </div>
      <div className={css.body}>
        corum.panel · S0 占位（终端 tab 占位）· S1 由 @corum/ide-panel-bottom 接管
        <button
          type="button"
          className={css.popout}
          onClick={() => {
            const bridge = (window as unknown as { corumDesktop?: { openFloating?: (k: string) => Promise<unknown> } }).corumDesktop
            void bridge?.openFloating?.('corum.panel')
          }}
        >
          ⇱ 脱出
        </button>
      </div>
    </div>
  )
}
