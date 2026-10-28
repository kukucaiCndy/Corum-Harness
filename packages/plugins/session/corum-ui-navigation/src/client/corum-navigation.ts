/**
 * corum session navigation service — holds the MainSelection state and manages
 * retain/release reference lifecycle, replacing the official `UiWorkspaceService`
 * navigation layer that is disabled in the IDE patch (`cordis.ide.patch.yml:27`).
 *
 * **Why this exists**: rc3 `ISessions` has no `open`/`clear`/`list.current` —
 * navigation is the view owner's job, and the official owner is `uiWorkspace`,
 * which corum disables. This service is the corum-side owner: a cordis Service
 * (singleton across bundles via `reflect.store`), holding a `MainSelection`
 * equivalent and a retained `SessionReference` whose lifecycle mirrors the
 * official `replaceMain`/`clearMain` pattern.
 *
 * **Why this is a separate package** (2026-10-31 circular-dependency fix):
 * Originally this service was provided inside `@corum/corum-ui-conversation`'s
 * `apply()` (as `applyCorumSessionNavigation(ctx)`). But conversation hard-injects
 * `layout` (for user-action/newTaskForm), and `@corum/corum-ide-ui` hard-injects
 * `corumNavigation` (for the shell's session bar). This created a service
 * activation cycle: conversation needs layout (provided by ide-shell) →
 * ide-shell needs corumNavigation (provided by conversation) → neither activates
 * → 23 plugins stuck pending, blocking web boot. Extracting navigation into a
 * package that only injects `sessions` breaks the cycle: navigation activates
 * first (sessions is always available), then ide-shell (gets corumNavigation),
 * then conversation (gets layout from ide-shell + corumNavigation from here).
 *
 * Reference lifecycle (mirrors official navigation.ts:507–530):
 * - `openSession(target)` → `retain(target, {source:'mainView'})`, release the
 *   previous `mainReference`, store the new one, update selection store.
 * - `clearSelection()` → release `mainReference`, clear selection store.
 * - Service `dispose` → release any held reference.
 * - Rapid switching is safe: the previous reference is released synchronously
 *   before the new one is stored, so only one `mainView` reference is live at a
 *   time (no leak).
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ISessions,
  SessionReference,
  SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only import for the SessionReferenceSourceMap augmentation: the official
// dsh-client-ui-session package declares `mainView` as a valid SessionReferenceSource
// (used in sessions.retain(target, { source: 'mainView' })). Without this import,
// TypeScript resolves SessionReferenceSource to only 'controllerOperation' | 'gateway'
// and rejects 'mainView'. The import is erased at runtime (type-only).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Equivalent to the official `MainSelection` (navigation.ts:33–36). */
export interface CorumMainSelection {
  readonly sessionId?: SessionId
}

/** corum-side session navigation and selection owner. */
export interface CorumSessionNavigation {
  /** The current main selection observable; `sessionId` is undefined when nothing is selected. */
  readonly selection: ObservableSnapshot<CorumMainSelection>
  /**
   * Select a Session and retain its reference as the main view, releasing the
   * previously retained reference. Fire-and-forget: returns immediately.
   * @param target - Session id to display.
   */
  openSession(target: SessionTarget): void
  /**
   * Clear the current selection and release the retained main reference.
   * Used by "new session" / close-session / archive-current flows.
   */
  clearSelection(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum session navigation owner (replaces disabled uiWorkspace navigation). */
    corumNavigation: CorumSessionNavigation
  }
}

/**
 * Implements corum session navigation as a cordis Service.
 *
 * Singleton across bundles is guaranteed by the root context `reflect.store`
 * (proven in `.dbg/cordis-singleton-probe.md`): `ctx.plugin(CorumSessionNavigationService)`
 * registers one instance under the name `corumNavigation`, and every consumer's
 * `inject(['corumNavigation'])` gets the same instance.
 */
class CorumSessionNavigationServiceImpl extends Service implements CorumSessionNavigation {
  private readonly store = createSnapshotStore<CorumMainSelection>({})
  private mainReference: SessionReference | undefined

  constructor(ctx: Context, private readonly sessions: ISessions) {
    super(ctx, 'corumNavigation')
    // Release the main reference when the service is disposed (fiber teardown).
    ctx.effect(() => () => {
      const ref = this.mainReference
      this.mainReference = undefined
      ref?.release()
    }, 'corum-navigation: main reference lifecycle')
  }

  get selection(): ObservableSnapshot<CorumMainSelection> {
    return this.store
  }

  openSession(target: SessionTarget): void {
    const reference = this.sessions.retain(target, { source: 'mainView' })
    // If retain resolved a different generation (e.g. target was a subagent
    // address), use the reference's sessionId for selection.
    this.store.set({ sessionId: reference.sessionId })
    // Release the previous reference AFTER storing the new one — ensures no
    // gap where selection is empty mid-switch (official replaceMain pattern).
    const previous = this.mainReference
    this.mainReference = reference
    previous?.release()
  }

  clearSelection(): void {
    const previous = this.mainReference
    this.mainReference = undefined
    this.store.set({})
    previous?.release()
  }
}

/** Provide the corum session navigation service. */
export function applyCorumSessionNavigation(ctx: Context): void {
  ctx.plugin(CorumSessionNavigationServiceImpl, ctx.sessions)
}
