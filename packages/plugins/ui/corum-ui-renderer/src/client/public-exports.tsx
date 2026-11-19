/**
 * Public exports for consumers that need to render scoped slot content outside
 * the normal tree flow (e.g. an embedded second-session view in a split pane).
 *
 * `SessionScopeOverride` overrides the session scope binding for a subtree —
 * it mirrors the internal `scopeAreaProvider` (scoped-slots.tsx:502–525) but
 * exposes the mechanism so a caller can pin a specific sessionId.
 *
 * `SlotView` renders one declared slot outlet by key, reading the current
 * scope binding (inherited or overridden). It is the public twin of the
 * internal `SlotOutlet` — same contract, minus the per-entry `declaredInline`
 * plumbing that only bound renderSlot/renderSlotChain callers set.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import type {
  ChainRenderOpts, HostObservable, RenderOpts, SlotScopeAdapter, StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  ScopeBindingProvider,
  useHost,
  useScopeBinding,
} from './bindings.tsx'
import { SlotOutlet } from './scoped-slots.tsx'

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
 * `adapter.bindingSource(sessionId)` to obtain the binding observable — the
 * same path the internal `scopeAreaProvider` takes. The resolved binding is
 * published via `ScopeBindingProvider` so every scoped descendant (strict
 * `session` or `session-maybe`) sees the pinned sessionId.
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
  // Bind a stable absent source when no session adapter is installed yet —
  // useSyncExternalStore must be called unconditionally (hooks rules). The
  // absent source returns a binding with key=undefined, so scoped descendants
  // render their empty/loading state instead of crashing.
  const source = adapter === undefined
    ? ABSENT_BINDING_SOURCE
    : adapter.bindingSource(props.sessionId)
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
