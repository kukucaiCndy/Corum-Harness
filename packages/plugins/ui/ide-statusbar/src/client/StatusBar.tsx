/**
 * StatusBar — the IDE status bar (design.pen ⑦, 34px). Structure follows the
 * design frame: conn-dot (7px $state-success) + "Connected" + project name +
 * flex spacer + model name (11px Inter). Connection state rides the shell's
 * host-description source (present = connected); project/model fall back to
 * the design's defaults until the host reports real values.
 */
import { useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CorumHostDescriptionSource } from './types.ts'
import css from './StatusBar.module.css'

/** Injected live state (see client/index.ts apply). */
export interface StatusBarInjected {
  /** The shell's host-description source (present value = connected). */
  hostDescription: CorumHostDescriptionSource
}

/** Composed props: the shell's owner share + this plugin's injected face. */
export type StatusBarProps = PropsRuntime<'corum.statusBar'> & StatusBarInjected

/** Project label: the host's cwd basename when described, else the design default. */
function projectLabel(description: unknown): string {
  const value = (description as { value?: unknown } | undefined)?.value
  const cwd = (value as { cwd?: unknown } | undefined)?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const base = cwd.split(/[\\/]/).filter(Boolean).pop()
    if (base !== undefined && base !== '') return base
  }
  return 'kkc-desktop'
}

/** Model label: the host's model id when described, else the design default. */
function modelLabel(description: unknown): string {
  const value = (description as { value?: unknown } | undefined)?.value
  const model = (value as { model?: unknown } | undefined)?.model
  if (typeof model === 'string' && model !== '') return model
  return 'Claude Sonnet 4.5'
}

/** The IDE status bar (see module doc). */
export function StatusBar({ hostDescription }: StatusBarProps) {
  const snapshot = useSyncExternalStore(hostDescription.subscribe, hostDescription.getSnapshot)
  const connected = snapshot !== undefined
  return (
    <div className={css.strip}>
      <span className={css.dot} data-connected={connected || undefined} />
      <span className={css.seg}>{connected ? 'Connected' : 'Connecting…'}</span>
      <span className={css.seg}>{projectLabel(snapshot)}</span>
      <span className={css.spacer} />
      <span className={css.model}>{modelLabel(snapshot)}</span>
    </div>
  )
}
