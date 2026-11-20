/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createElement, useLayoutEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import { createSlotRenderer } from './scoped-slots.tsx'
import { buildRenderApp } from './app.tsx'
import { SlotRegistry } from './registry.ts'
import { SessionScopeOverride, SlotView, useScopeBinding, sessionRetainResolver, type SessionRetainCapability } from './public-exports.tsx'
import type { StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'

export { SlotRegistry } from './registry.ts'
export type { RootOwnerProps } from './registry.ts'

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SnapshotSelectorHook, SlotRenderer,
  ScopedStandardSourceBinding, SlotRendererHost, SlotScopeAdapter,
  StandardSourceBinding, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Scoped-slot component capability — the renderer's React context bound into
 * callable component/hook references.
 *
 * These symbols carry the renderer's React context closures (HostContext,
 * ScopeBindingContext etc.). Exposing them through the cordis service lets
 * **other bundles** render scoped slot content without a runtime `@corum/*`
 * import — which would inline a second copy of the renderer source into the
 * consumer bundle and trigger duplicate factory registration (red line 1).
 *
 * Consumers receive these references via `inject('uiRenderer')` and render
 * them with `createElement` inside the renderer's React tree (slot occupants
 * already live in that tree, so the context providers are above them).
 */
export interface ScopedSlotComponents {
  /**
   * Override the session scope binding for a subtree.
   * Component: `(props: { sessionId: string; children: ReactNode }) => ReactNode`.
   */
  readonly SessionScopeOverride: (props: { sessionId: string; children: ReactNode }) => ReactNode
  /**
   * Render one declared slot outlet by key.
   * Component: `(props: { slotKey: string; ownerProps?: object; opts?: object }) => ReactNode`.
   */
  readonly SlotView: (props: {
    slotKey: string
    ownerProps?: object
    opts?: object | undefined
  }) => ReactNode
  /**
   * Read the current scope binding (React hook — must be called inside a
   * component rendered within the renderer's React tree).
   */
  readonly useScopeBinding: () => StandardSourceBinding
}

/** Mount operation + scoped-slot component capability exposed to the boot kernel and other bundles. */
export interface UiRendererService extends ScopedSlotComponents {
  /**
   * Mount the assembled application into the supplied element.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An ordinary Slot declaration or entry registration set changed. Factory
     * definitions publish through `subscribeFactory()` instead.
     * @mode emit
     * @param key - mutated SlotMap key.
     */
    'slots/changed'(key: string): void
  }
  interface Context {
    /** Renderer-owned UI composition registry. */
    slots: SlotRegistry
    /** Mount face provided after the UI renderer activates. */
    uiRenderer: UiRendererService
  }
}

/**
 * Services required before application assembly.
 *
 * `sessions` is injected so SessionScopeOverride can access the Session
 * Controller's retain() API at render time. The Session Controller
 * (@deepseek-ai/dsh-api-session-controller) injects only connection/remote
 * (not `slots`), so this is a linear chain: controller → renderer →
 * ui-session-adapter — no activation cycle.
 */
export const inject: string[] = ['sessions']

interface BootSnapshot {
  className: string
  html: string
}

/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props: { app: () => ReactNode; boot: BootSnapshot }): ReactNode {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { setReady(true) }, [])
  if (ready) return props.app()
  return createElement('div', {
    className: props.boot.className,
    'data-dsh-boot': '',
    dangerouslySetInnerHTML: { __html: props.boot.html },
  })
}

/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container: HTMLElement, app: () => ReactNode): Root {
  const boot = container.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
  if (boot !== null) {
    return hydrateRoot(container, createElement(BootHandoff, {
      app,
      boot: { className: boot.className, html: boot.innerHTML },
    }))
  }
  const root = createRoot(container)
  flushSync(() => { root.render(app()) })
  return root
}

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const slots = new SlotRegistry(ctx)
  slots.install(createSlotRenderer())
  // Wire a deferred sessions-retain resolver into SessionScopeOverride
  // (same-bundle module ref, legal under red line 1). `sessions` is in the
  // inject array, so ctx.sessions is resolved before apply() runs.
  // SessionScopeOverride uses sessions.retain() to obtain the SessionReference
  // that adapter.bindingSource expects (a reference object with .binding +
  // .sessionId, NOT a raw string). Without this, bindingSource receives a raw
  // string and crashes in the descriptor resolver
  // (TypeError: Cannot read properties of undefined (reading 'session')).
  sessionRetainResolver.current = () => {
    const sessions = (ctx as unknown as { sessions?: SessionRetainCapability }).sessions
    return sessions ?? null
  }
  ctx.reflect.provide('uiRenderer', {
    mount: (container: HTMLElement): (() => void) => {
      const root = mountApp(container, buildRenderApp({ ctx }))
      return () => { root.unmount() }
    },
    // Expose the renderer's scoped-slot components through the service so other
    // bundles can render them without a runtime @corum/* import (red line 1:
    // cross-bundle shared capability via cordis service, not module import).
    // These references carry the renderer's React context closures — consumers
    // render them inside the renderer's React tree (slot occupants already do).
    SessionScopeOverride,
    SlotView,
    useScopeBinding,
  })
}
