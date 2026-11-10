/** Internal React bindings for renderer hosts and standard-source scopes. */
import { createContext, useContext, type ReactNode } from 'react'
import type {
  HostObservable,
  KeyedStandardSource,
  MaybeSnapshotSelectorHook,
  SlotRendererHost,
  SnapshotSelectorHook,
  SlotScopeAdapter,
  StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from './bind.ts'
import { SlotAssemblyError } from './errors.ts'

/** In-package renderer host context. */
export const HostContext = createContext<SlotRendererHost | null>(null)

/**
 * Read the installed renderer host.
 * @returns the host API.
 */
export function useHost(): SlotRendererHost {
  const host = useContext(HostContext)
  if (host === null) throw new SlotAssemblyError('slot machinery rendered outside the installed renderer tree')
  return host
}

const RootBindingContext = createContext<StandardSourceBinding | null>(null)
const ScopeBindingContext = createContext<StandardSourceBinding | null>(null)

/**
 * Read the root standard-source binding.
 * @returns the current root binding.
 */
export function useRootBinding(): StandardSourceBinding {
  const binding = useContext(RootBindingContext)
  if (binding === null) throw new SlotAssemblyError('slot rendered outside the root standard-source provider')
  return binding
}

/**
 * Read the current-session-optional binding.
 * @returns a binding whose key is absent when no Session is selected.
 */
export function useScopeBinding(): StandardSourceBinding {
  const binding = useContext(ScopeBindingContext)
  if (binding === null) throw new SlotAssemblyError('scoped slot rendered outside its scope provider')
  return binding
}

/**
 * Publish one resolved scope binding to a renderer subtree.
 * @param props - provider inputs.
 * @param props.binding - binding exposed to scoped entries.
 * @param props.children - subtree that inherits the binding.
 * @returns the scoped React provider.
 */
export function ScopeBindingProvider({ binding, children }: {
  binding: StandardSourceBinding
  children: ReactNode
}): ReactNode {
  return <ScopeBindingContext.Provider value={binding}>{children}</ScopeBindingContext.Provider>
}

/**
 * Bind one observable source to an identity-stable selector Hook.
 * @param source - observable source.
 * @returns cached selector Hook.
 */
export function observableHook<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  let hook = hookCache.get(source)
  if (hook === undefined) {
    hook = bindSnapshotSelector(source)
    hookCache.set(source, hook)
  }
  return hook as SnapshotSelectorHook<T>
}

const hookCache = new WeakMap<object, unknown>()
const absentSource: HostObservable<undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}

/**
 * Bind an optional source without changing Hook call order.
 * @param source - current source, or absence.
 * @returns selector Hook returning `undefined` while absent.
 */
export function maybeObservableHook<T>(
  source: HostObservable<T> | undefined,
): MaybeSnapshotSelectorHook<T> {
  if (source !== undefined) return observableHook(source)
  return useAbsentSnapshot
}

function useAbsentSnapshot<S>(
  _selector: (snapshot: never) => S,
  _equal?: (left: S, right: S) => boolean,
): S | undefined {
  observableHook(absentSource)(() => undefined)
  return undefined
}

/**
 * Erased open-key selector Hook synthesized from one keyed source family.
 * A string second argument names a member: the Hook reads the source the
 * resolver returns for `(key, member)` without a selector.
 */
export type KeyedSnapshotHook = (
  keyOrSelector: string | ((value: unknown) => unknown),
  memberOrSelectorOrEqual?: string | ((value: unknown) => unknown) | ((left: unknown, right: unknown) => boolean),
  equal?: (left: unknown, right: unknown) => boolean,
) => unknown

interface KeyedHookCall {
  readonly key: string | undefined
  readonly member: string | undefined
  readonly selector: ((value: unknown) => unknown) | undefined
  readonly equal: ((left: unknown, right: unknown) => boolean) | undefined
}

/** Read the `(key, member)`, `(key, selector?, equal?)`, or `(selector, equal?)` call forms. */
function keyedHookCall(
  defaultKey: string | undefined,
  keyOrSelector: Parameters<KeyedSnapshotHook>[0],
  second: Parameters<KeyedSnapshotHook>[1],
  equal: Parameters<KeyedSnapshotHook>[2],
): KeyedHookCall {
  if (typeof keyOrSelector !== 'string') {
    return {
      key: defaultKey,
      member: undefined,
      selector: keyOrSelector,
      equal: second as ((left: unknown, right: unknown) => boolean) | undefined,
    }
  }
  if (typeof second === 'string') return { key: keyOrSelector, member: second, selector: undefined, equal: undefined }
  return { key: keyOrSelector, member: undefined, selector: second as ((value: unknown) => unknown) | undefined, equal }
}

/**
 * Bind an open-key source family.
 * @param source - keyed resolver, or absence for an optional scope.
 * @returns cached keyed selector Hook.
 */
export function keyedObservableHook(
  source: KeyedStandardSource | undefined,
  defaultKey?: string,
): KeyedSnapshotHook {
  if (source === undefined) return absentKeyedHook
  let hooks = keyedHookCache.get(source)
  if (hooks === undefined) {
    hooks = new Map()
    keyedHookCache.set(source, hooks)
  }
  const cacheKey = defaultKey ?? NO_DEFAULT_KEY
  let hook = hooks.get(cacheKey)
  if (hook === undefined) {
    hook = (keyOrSelector, second, equal) => {
      const call = keyedHookCall(defaultKey, keyOrSelector, second, equal)
      const resolved = call.key === undefined
        ? undefined
        : call.member === undefined ? source(call.key) : source(call.key, call.member)
      const useValue = observableHook(resolved ?? absentSource)
      return useValue(call.selector ?? identity, call.equal)
    }
    hooks.set(cacheKey, hook)
  }
  return hook
}

const NO_DEFAULT_KEY = Symbol('no default key')
const keyedHookCache = new WeakMap<KeyedStandardSource, Map<string | symbol, KeyedSnapshotHook>>()
const identity = (value: unknown): unknown => value
const absentKeyedHook: KeyedSnapshotHook = (keyOrSelector, second, equal) => {
  const call = keyedHookCall(undefined, keyOrSelector, second, equal)
  return observableHook(absentSource)(call.selector ?? identity, call.equal)
}

/** Subscribe the tree to the atomically assembled root standard-source roster. */
export function RootStandardProvider({ children }: { children: ReactNode }) {
  const host = useHost()
  const binding = observableHook(host.root)(value => value)
  return <RootBindingContext.Provider value={binding}>{children}</RootBindingContext.Provider>
}

/**
 * Stable binding for an optional scope that has NEVER had an adapter: absent
 * key, no hook seats. Entries materialize it in optional mode, so every
 * declared hook stays present (call order stable) and reads `undefined`; an
 * entry that dereferences it crashes inside its OWN boundary, never the tree.
 */
const STABLE_ABSENT_BINDING: StandardSourceBinding = {
  key: undefined,
  hooks: {},
  keyedHooks: {},
  props: {},
}

const stableAbsentSource: HostObservable<StandardSourceBinding> = {
  getSnapshot: () => STABLE_ABSENT_BINDING,
  subscribe: () => () => {},
}

/**
 * Last adapter each host published per scope. A detached (unloaded / HMR)
 * adapter is the only party that knows the absent PROJECTION of its scope —
 * the live roster already dropped it — so the provider keeps this bounded
 * tombstone (≤ 2 entries per host, keyed by the host object, no refcount and
 * no timers) and renders the projection instead of throwing.
 */
const detachedAdapters = new WeakMap<SlotRendererHost, Map<ScopedScopeName, SlotScopeAdapter>>()

/** One absent projection source per adapter (the contract promises it is stable). */
const absentProjectionCache = new WeakMap<SlotScopeAdapter, HostObservable<StandardSourceBinding>>()

type ScopedScopeName = 'session' | 'session-maybe'

/** Remember the live adapter for one scope; bounded by the scope names in use. */
function rememberScopeAdapter(host: SlotRendererHost, scope: ScopedScopeName, adapter: SlotScopeAdapter): void {
  let perHost = detachedAdapters.get(host)
  if (perHost === undefined) {
    perHost = new Map()
    detachedAdapters.set(host, perHost)
  }
  perHost.set(scope, adapter)
}

/**
 * Absent projection of a detached adapter. The renderer must survive an
 * adapter that is gone mid-flight, so a throwing projection degrades to the
 * stable empty binding instead of re-raising during render.
 */
function absentProjectionOf(adapter: SlotScopeAdapter): HostObservable<StandardSourceBinding> {
  const cached = absentProjectionCache.get(adapter)
  if (cached !== undefined) return cached
  let source: HostObservable<StandardSourceBinding>
  try {
    source = adapter.bindingSource(undefined)
  } catch (error) {
    console.error('scope absent projection failed; rendering the empty binding:', error)
    source = stableAbsentSource
  }
  absentProjectionCache.set(adapter, source)
  return source
}

/**
 * Resolve the binding source one scope provider subscribes to.
 *
 * `session-maybe` is a LEGAL optional scope: its adapter may be absent while
 * the session-owning plugin is unloaded (HMR, boot order, a disabled plugin),
 * and that is a state the tree must render, not an assembly failure. Absent
 * resolves to the detached adapter's absent projection when one ever existed,
 * otherwise to the stable empty binding. The strict `session` scope keeps its
 * loud failure: rendering it without an adapter is a miswired composition.
 */
function scopeSource(
  host: SlotRendererHost,
  scope: ScopedScopeName,
): HostObservable<StandardSourceBinding> {
  const live = host.scope(scope)
  if (live !== undefined) {
    rememberScopeAdapter(host, scope, live)
    return live.current
  }
  if (scope === 'session') {
    throw new SlotAssemblyError(`scope '${scope}' rendered without an installed adapter`)
  }
  const detached = detachedAdapters.get(host)?.get(scope)
  return detached === undefined ? stableAbsentSource : absentProjectionOf(detached)
}

/**
 * Subscribe to the scope roster before resolving and binding its source.
 * Exactly one roster hook plus one selector hook on every path — an absent
 * optional scope does not change the Hook call order of mounted outlets.
 *
 * The provider element is keyed by the binding SHAPE: until the first adapter
 * ever appears the scope has no member seats at all (nothing to keep present),
 * so a component that would call one is unrenderable — it fails in its own
 * boundary. The first arrival therefore remounts this subtree ONCE, giving
 * those entries a fresh mount with stable seats instead of a dead cell. Once an
 * adapter has existed the detached projection (members present, sources
 * undefined) holds the shape forever, so no later unload can trigger this.
 */
export function ScopeProvider({
  scope,
  children,
}: {
  scope: ScopedScopeName
  children: ReactNode
}) {
  const host = useHost()
  observableHook(host.scopeRevision)(value => value)
  const source = scopeSource(host, scope)
  const binding = observableHook(source)(value => value)
  const shape = source === stableAbsentSource ? 'absent' : 'bound'
  return (
    <ScopeBindingContext.Provider key={shape} value={binding}>
      {children}
    </ScopeBindingContext.Provider>
  )
}
