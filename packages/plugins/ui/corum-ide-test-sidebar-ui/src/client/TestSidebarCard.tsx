/**
 * TestSidebarCard — the S0 placeholder for the corum.sidebar slot: a glass
 * card + one line of text ("会话列表槽") + the owner-share facts the shell
 * hands down (wide/width), proving the owner contract crosses the shell/plugin
 * boundary. Styles reference tokens only — no hard-coded hex.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TestSidebarCard.module.css'

/** Composed props: the runtime share carries the shell's CorumSidebarOwnerProps. */
export type TestSidebarCardProps = PropsRuntime<'corum.sidebar'>

/** The placeholder card (see module doc). */
export function TestSidebarCard({ wide, width }: TestSidebarCardProps) {
  return (
    <div className={css.card} data-testid="corum-sidebar-placeholder">
      <div className={css.title}>会话列表槽</div>
      <div className={css.meta}>corum.sidebar · S0 占位</div>
      <div className={css.meta}>owner: wide={String(wide)} width={Math.round(width)}px</div>
      <div className={css.meta}>S1 由 @corum/corum-ide-sidebar-ui 接管</div>
    </div>
  )
}
