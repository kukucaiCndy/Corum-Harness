/**
 * @corum/ide-test-panel client half — the S0 composition probe for the shell's
 * bottom panel. It registers ONE placeholder (terminal-tab placeholder + a
 * "收起面板" button driving ctx.layout.togglePanel) into the `corum.panel`
 * slot, proving a bar-slot registration composes AND that the IDE extension
 * of the ctx.layout panel-action face is live across the shell/plugin
 * boundary. S1 replaces this probe with @corum/ide-panel-bottom (terminal /
 * todos / queue).
 *
 * The slot is declared only by @corum/ide-shell (IDE mode); the type-only
 * import of the shell's client module pulls the SlotMap row and the
 * ctx.layout Context merge so the register call and the layout consumption
 * type-check, while the runtime registration rides the slots service.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@corum/ide-shell/client'
import { TestPanel } from './TestPanel.tsx'

/** Required services: the slots registry + the shell's layout face + theme. */
export const inject = ['slots', 'layout', 'theme']

/**
 * Client plugin body: register the placeholder panel into corum.panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Deferred registration: runs once the shell has declared the slot (see
  // ide-test-sidebar for the rationale).
  ctx.effect(
    () => ctx.slots.inject('corum.panel', () => ctx.slots.register(
      {
        name: 'corum.panel',
        inject: () => ({ onTogglePanel: () => ctx.layout.togglePanel() }),
      },
      TestPanel,
    )),
    'ide-test-panel: corum.panel placeholder',
  )

  // S0 walkthrough surface: the bottom panel starts collapsed (its slot only
  // mounts once open), so the CDP walkthrough cannot reach the placeholder's
  // own button to perform the FIRST open. Expose the cross-plugin toggle on
  // a deliberately-ugly global for exactly that assertion (test plugin only —
  // real plugins never publish cordis services on window).
  ctx.effect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__corumTestTogglePanel = () => ctx.layout.togglePanel()
    w.__corumTestSetTheme = (id: string) => ctx.theme.setTheme(id)
    return () => {
      delete w.__corumTestTogglePanel
      delete w.__corumTestSetTheme
    }
  }, 'ide-test-panel: walkthrough toggle surface')
}
