/**
 * TestStatusBar — the S0 placeholder for the corum.statusBar list slot: one
 * horizontal strip of placeholder segments (连接 · 项目 · 模型), proving a
 * bar-slot registration composes. Styles reference tokens only.
 */
import css from './TestStatusBar.module.css'

/** The placeholder status strip (see module doc). */
export function TestStatusBar() {
  return (
    <div className={css.strip} data-testid="corum-statusbar-placeholder">
      <span className={css.segment}>
        <span className={css.dot} />
        已连接（占位）
      </span>
      <span className={css.segment}>项目：corum-desktop（占位）</span>
      <span className={css.segment}>模型：kimi-k3-1（占位）</span>
      <span className={css.hint}>corum.statusBar · S0 占位 · S1 由 @corum/ide-statusbar 接管</span>
    </div>
  )
}
