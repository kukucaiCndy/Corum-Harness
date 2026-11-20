/**
 * Public exports for consumers that need to render scoped slot content outside
 * the normal tree flow (e.g. an embedded second-session view in a split pane).
 *
 * `SessionScopeOverride` overrides the session scope binding for a subtree —
 * it mirrors the internal `scopeAreaProvider` (scoped-slots.tsx:502–525) but
 * exposes the mechanism so a caller can pin a specific sessionId. Unlike
 * `scopeAreaProvider` (which resolves the binding through `props.session`
 * inherited from the standard-kit flow), this component pins an explicit
 * sessionId by retaining a **session reference** via the Session Controller
 * (`sessions.retain(id, {source:'splitPane'})`) and passing that reference to
 * `adapter.bindingSource(reference)` — the exact contract `bindingSource`
 * expects (a reference object with `.binding` + `.sessionId`, not a raw string).
 *
 * `SlotView` renders one declared slot outlet by key, reading the current
 * scope binding (inherited or overridden). It is the public twin of the
 * internal `SlotOutlet` — same contract, minus the per-entry `declaredInline`
 * plumbing that only bound renderSlot/renderSlotChain callers set.
 */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type {
  ChainRenderOpts, HostObservable, RenderOpts, SlotScopeAdapter, StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  ScopeBindingProvider,
  useHost,
  useScopeBinding,
} from './bindings.tsx'
import { SlotOutlet } from './scoped-slots.tsx'

// Re-export useScopeBinding so consumers can read the current scope binding
// (e.g. to extract the main session id) without duplicating the context.
export { useScopeBinding } from './bindings.tsx'

/**
 * Minimal session-reference shape: the parts `adapter.bindingSource` and the
 * release lifecycle need. Defined locally (red line 3) to avoid coupling this
 * package to `@deepseek-ai/dsh-api-session-controller` (not a direct dep).
 */
interface SessionReferenceLike {
  /** Session id this reference pins. */
  readonly sessionId: string
  /**
   * The live session binding (owner). `adapter.bindingSource` reads this as
   * `reference.binding` and validates it against `sessions.binding(sessionId)`.
   */
  readonly binding: unknown
  /** Release the retain; called on unmount. */
  release(): void
}

/**
 * Narrow capability interface for the Session Controller's `sessions` service
 * (red line 3: don't couple to the implementation package's full type face).
 *
 * `SessionScopeOverride` needs `retain` to obtain a `SessionReference` (the
 * object `adapter.bindingSource` expects) and the reference's `release` to
 * free the retain on unmount. This is the minimal slice of `ISessions` used.
 *
 * The `source` parameter is typed as `string` (cast at the call site) because
 * the `'splitPane'` source is declared via declaration merging in
 * `corum-ui-navigation`, which this package does not import — but the runtime
 * value is accepted by the Session Controller regardless of compile-time type.
 */
export interface SessionRetainCapability {
  /** Retain a session reference; `retain(target, opts)` returns a live reference. */
  retain(target: string, options: { source: string }): SessionReferenceLike
}

/**
 * Module-level ref holding a function that resolves the `sessions` retain
 * capability on demand.
 *
 * Set by `apply()` at activation time (capturing `ctx`). Read by
 * {@link SessionScopeOverride} at render time — React rendering always happens
 * after ALL plugins have activated (the web boot kernel waits for full
 * activation before mounting), so `ctx.sessions` is guaranteed non-null when
 * the ref is called.
 *
 * Using a resolver function (not the value itself) defers the `ctx.sessions`
 * read to render time: the renderer activates BEFORE the session controller,
 * so `ctx.sessions` is `undefined` during `apply()`. By the time React renders,
 * the session controller has activated and `ctx.sessions` is live.
 *
 * Same-bundle module singleton is legal (red line 1 applies to cross-bundle
 * state; this ref is only read within the renderer bundle's React tree).
 */
export const sessionRetainResolver: { current: (() => SessionRetainCapability | null) | null } = { current: null }

/**
 * Stable absent binding for when no session scope adapter is installed.
 * Mirrors the internal `STABLE_ABSENT_BINDING` (bindings.tsx:194): key=undefined,
 * no hook seats. `useSyncExternalStore` must be called unconditionally, so
 * this source stands in when `host.scope('session')` returns undefined.
 */
const ABSENT_BINDING: StandardSourceBinding = {
  key: undefined,
  hooks: {},
  keyedHooks: {},
  props: {},
}

const ABSENT_BINDING_SOURCE: HostObservable<StandardSourceBinding> = {
  getSnapshot: () => ABSENT_BINDING,
  subscribe: () => () => {},
}

/**
 * Override the session scope binding for a subtree.
 *
 * Resolves the live session scope adapter (`host.scope('session')`) and uses
 * `adapter.bindingSource(reference)` to obtain the binding observable — the
 * same path the internal `scopeAreaProvider` takes (scoped-slots.tsx:515).
 *
 * **Critical**: `adapter.bindingSource` expects a **session reference** object
 * (with `.binding` and `.sessionId`), NOT a raw session-id string. The official
 * `UiSession.bindingSource` (dsh-client-ui-session client.js:837) reads
 * `reference.binding` (the session owner) and validates it against
 * `sessions.binding(reference.sessionId)`. Passing a raw string makes
 * `reference.binding` evaluate to `undefined`, and the downstream descriptor
 * resolver (`BUILTIN_SOURCE.resolve(binding)` at client.js:759) reads
 * `binding.session` on the resulting `undefined` owner →
 * `TypeError: Cannot read properties of undefined (reading 'session')`.
 *
 * To produce a valid reference, this component retains the session via
 * `sessions.retain(sessionId, {source:'splitPane'})` (the `splitPane` source is
 * declared in `corum-ui-navigation`'s `SessionReferenceSourceMap` augmentation).
 * The retain is synchronous (`retainScope` creates the scope record immediately),
 * so `reference.binding` is available right away. The reference is released on
 * unmount via `useEffect` cleanup.
 *
 * @param props.sessionId - the session to pin for this subtree.
 * @param props.children - subtree that inherits the overridden binding.
 * @returns the scoped provider.
 */
export function SessionScopeOverride(props: {
  sessionId: string
  children: ReactNode
}): ReactNode {
  const host = useHost()
  const adapter = host.scope('session') as SlotScopeAdapter | undefined
  // Resolve the sessions retain capability at render time (not apply time):
  // the renderer activates before the session controller, so ctx.sessions is
  // undefined during apply(). By render time (after full boot), it is live.
  const retainCap = sessionRetainResolver.current?.() ?? null

  // Retain a session reference for this subtree's lifetime. useMemo pins the
  // reference across re-renders for the same sessionId (retain creates a new
  // scope record only on the first call; subsequent calls for the same id bump
  // the refcount and return a new reference object pointing at the same scope).
  // The reference is released on unmount or when sessionId changes via the
  // useEffect cleanup. `useSyncExternalStore` must be called unconditionally,
  // so the absent source stands in when the adapter or retain capability is
  // unavailable or the retain fails (session not found / controller disposed).
  const reference = useMemo<SessionReferenceLike | undefined>(() => {
    if (adapter === undefined || retainCap === null) return undefined
    try {
      return retainCap.retain(props.sessionId, { source: 'splitPane' })
    } catch {
      return undefined
    }
  }, [adapter, retainCap, props.sessionId])

  // Release the reference on unmount or when sessionId changes (useMemo
  // recreates the reference → the old one is released by this cleanup).
  useEffect(() => {
    return () => { reference?.release() }
  }, [reference])

  const source = adapter === undefined || reference === undefined
    ? ABSENT_BINDING_SOURCE
    : adapter.bindingSource(reference as unknown as Parameters<typeof adapter.bindingSource>[0])
  const binding = useSyncExternalStore(
    listener => source.subscribe(listener),
    () => source.getSnapshot(),
    () => source.getSnapshot(),
  )
  return (
    <ScopeBindingProvider binding={binding}>
      {props.children}
    </ScopeBindingProvider>
  )
}

/**
 * Render one declared slot outlet by key.
 *
 * Public twin of the internal `SlotOutlet`. Reads the current scope binding
 * (inherited from `ScopeProvider` / overridden by `SessionScopeOverride`),
 * subscribes to the slot's version, and renders its registered occupant(s).
 *
 * @param props.slotKey - the SlotMap key to render.
 * @param props.ownerProps - owner share passed to the occupant (defaults to {}).
 * @param props.opts - optional render options (chain routing, hook context).
 * @returns the slot outlet's rendered content.
 */
export function SlotView(props: {
  slotKey: string
  ownerProps?: object
  opts?: (RenderOpts & ChainRenderOpts) | undefined
}): ReactNode {
  // Touch the scope binding so this component re-renders when the binding
  // changes (the internal SlotOutlet does the same). The actual binding is
  // consumed inside SlotOutlet via useScopeBinding; this call keeps the hook
  // order consistent and ensures the override is active.
  useScopeBinding()
  return (
    <SlotOutlet
      slotKey={props.slotKey}
      ownerProps={props.ownerProps ?? {}}
      opts={props.opts}
      declaredInline={false}
    />
  )
}
