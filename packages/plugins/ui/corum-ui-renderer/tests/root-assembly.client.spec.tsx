// @vitest-environment jsdom
/**
 * 渲染器白屏 P0 的行为回归（**真实 React render + 真实 SlotCore**）。
 *
 * ## 缺陷形态（rc3 主窗白屏，2026-11-05 台账 ENV-1）
 *
 * 观测：`#root.children === 0`、`[data-slot]` 为 0、整页只剩 Issue 浮动条，而 host RPC 仍健康
 * ⇒ renderer 侧整树卸载。上游 renderer 的两条路径会**把整棵树抛掉**，且都在所有 entry 边界之外：
 *
 *   ① `ScopeProvider`：session scope 的 adapter 缺席（boot 顺序 / HMR 卸载）直接
 *      `throw new SlotAssemblyError`，而它包着**整个应用树**；
 *   ② `RootOutlet` / `renderSlot('root')` 的上游装配错误（`SlotAssemblyError`）被每个
 *      entry 的 `SlotErrorBoundary` **明确 rethrow**（这是有意的：miswired shell 必须响亮失败）
 *      ⇒ 一路冒到 React root，整树卸载、页面留白。
 *
 * ## 这里钉住的 7 条（T-A1..A7）
 *
 * | 用例 | 判据 |
 * |---|---|
 * | T-A1 | session-maybe **可选**：adapter 从未安装时 entry 照常渲染（absent 态），adapter 出现后渲染真实值 |
 * | T-A2 | 卸载 → 重挂：detach 后用「曾装过的 adapter 的 absent 投影」，DOM 不空、无 crash 面；重装后恢复 |
 * | T-A3 | 持续缺失：反复 bump roster 仍稳定停在 `data-scope-absent`，不出 `role=alert`、不出 `[data-slot-error]` |
 * | T-A4 | strict session 缺失：**可见错误**（role=alert + error.message）**且 root 不空**（不是白屏） |
 * | T-A5 | 普通 entry 崩溃**不连坐兄弟**（同胞照常渲染，crash 只在自身 cell） |
 * | T-A6 | revision 抖动：自动重试有界（同 revision 有上限），DOM 始终不空 |
 * | T-A7 | 见 scope-lifecycle spec：live duplicate 拒绝 / detached 可替换 / `_scopes` 不增长 |
 *
 * ⚠️ 这是**渲染层行为**验证，不是「白屏已实机消失」的判据：实机复现与验证需另起实例。
 * @module @corum/corum-ui-renderer/tests/root-assembly
 */
import type { ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SlotCore,
  type HostObservable,
  type PropsRenderSlots,
  type SlotRendererHost,
  type SlotScopeAdapter,
  type StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '../src/client/scoped-slots.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 可选 scope 的探针槽：session-maybe（adapter 缺席是合法状态）。 */
    'probe.maybe': { kind: 'single'; scope: 'session-maybe'; owner: Record<string, never> }
    /** strict session 探针槽：缺 scope binding 时必须响亮失败。 */
    'probe.strict': { kind: 'single'; scope: 'session'; owner: Record<string, never> }
    /** 普通 root scope 的 list 槽：用来验证兄弟不连坐。 */
    'probe.list': { kind: 'list'; scope: 'root'; owner: Record<string, never> }
  }
}

type ProbeKey = 'probe.maybe' | 'probe.strict' | 'probe.list'
type FrameSlots = PropsRenderSlots<ProbeKey>
type InjectedProps = Record<string, unknown>

/** Binding with NO member seats at all — the never-installed optional scope. */
const EMPTY_BINDING: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }

/**
 * Absent projection of a real adapter: member seats PRESENT with absent
 * sources (the ui-slots contract for optional slots — Hook call order stays
 * stable across undefined → id).
 */
const ABSENT_PROJECTION: StandardSourceBinding = {
  key: undefined,
  hooks: { session: undefined },
  keyedHooks: {},
  props: {},
}

/** Stand-in owning Context: strict session entries key their generation by it. */
const SESSION_CTX = {}

function bindingOf(id: string | undefined): StandardSourceBinding {
  return {
    key: id,
    hooks: { session: { getSnapshot: () => id, subscribe: () => () => {} } },
    keyedHooks: {},
    props: {},
    ctx: SESSION_CTX,
  } as StandardSourceBinding
}

interface ScopeDouble {
  readonly adapter: SlotScopeAdapter
  /** Move the scope selection (undefined = no session selected). */
  set(id: string | undefined): void
}

/** Minimal session scope adapter: current binding + absent projection, both observable. */
function scopeDouble(initial?: string): ScopeDouble {
  let binding = bindingOf(initial)
  const listeners = new Set<() => void>()
  const current: HostObservable<StandardSourceBinding> = {
    getSnapshot: () => binding,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  const absent: HostObservable<StandardSourceBinding> = {
    getSnapshot: () => ABSENT_PROJECTION,
    subscribe: () => () => {},
  }
  return {
    adapter: {
      current,
      bindingSource: () => absent,
      // Entries declaring a session child receive `SessionProvider` from the
      // area renderer; the double renders the area body unchanged.
      renderArea: (_binding, props) => props.children ?? null,
    },
    set(id) {
      binding = bindingOf(id)
      for (const fn of [...listeners]) fn()
    },
  }
}

interface HostDouble {
  readonly host: SlotRendererHost
  /** Install (or replace) the live session adapter and announce a roster change. */
  install(adapter: SlotScopeAdapter): void
  /** Unload the adapter (detached; the roster no longer answers) and announce it. */
  detach(): void
  /** Announce a roster change without touching the adapter map. */
  bump(): void
  /** Re-notify subscribers at the SAME revision (duplicate emit / storm attempt). */
  notifyOnly(): void
  revision(): number
}

/** Passthrough host over the real core, with a driveable scope roster. */
function hostOver(core: SlotCore): HostDouble {
  let adapter: SlotScopeAdapter | undefined
  let revision = 0
  const listeners = new Set<() => void>()
  const revisionSource: HostObservable<number> = {
    getSnapshot: () => revision,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  const publish = (): void => {
    revision += 1
    for (const fn of [...listeners]) fn()
  }
  const rootSource: HostObservable<StandardSourceBinding> = {
    getSnapshot: () => EMPTY_BINDING,
    subscribe: () => () => {},
  }
  const host: SlotRendererHost = {
    subscribe: (key, fn) => core.subscribe(key, fn),
    getVersion: key => core.getVersion(key),
    entriesOf: key => core.entries(key),
    entriesOfSlot: key => core.entriesOfSlot(key),
    reportEntryError: (key, entry, error, info) => { core.reportEntryError(key, entry, error, info) },
    reportFactoryError: (name, definition, error) => { core.reportFactoryError(name, definition, error) },
    specOf: key => core.specDynamic(key),
    isLive: entry => core.isLive(entry),
    storeOf: () => undefined,
    factoryStoreOf: () => undefined,
    retainFactoryOccurrence: () => () => {},
    subscribeFactory: (name, fn) => core.subscribeFactory(name, fn),
    getFactoryVersion: name => core.factoryVersion(name),
    factoryOf: name => core.factory(name),
    isFactoryLive: definition => core.isFactoryLive(definition),
    root: rootSource,
    scopeRevision: revisionSource,
    scope: () => adapter,
  }
  return {
    host,
    install(next) { adapter = next; publish() },
    detach() { adapter = undefined; publish() },
    bump() { publish() },
    notifyOnly() { for (const fn of [...listeners]) fn() },
    revision: () => revision,
  }
}

/** Optional-scope probe: tolerates the seat's absence (no seat before the first adapter ever). */
function MaybeProbe(props: InjectedProps): ReactNode {
  // Standard-kit seats are SELECTOR hooks (uSES): the selector is mandatory.
  const read = props['useSession'] as ((selector: (value: unknown) => unknown) => unknown) | undefined
  const id = read === undefined ? undefined : read(value => value) as string | undefined
  return (
    <div data-probe="maybe" {...(id === undefined ? { 'data-scope-absent': '' } : { 'data-session': id })}>
      {id ?? 'absent'}
    </div>
  )
}

function OkProbe(): ReactNode {
  return <div data-probe="ok" />
}

function BoomProbe(): ReactNode {
  throw new TypeError('probe entry exploded')
}

/** Root frame: renders the probe slots it declares. */
function frame(body: (renderSlot: FrameSlots['renderSlot']) => ReactNode) {
  return function RootFrame(props: FrameSlots): ReactNode {
    return <>{body(props.renderSlot)}</>
  }
}

/**
 * Child declarations are per-case on PURPOSE: an entry that declares a STRICT
 * session child requires the session adapter (loud assembly error), while an
 * optional-only child set must render while the adapter is absent — so the
 * two cases cannot share one declaration table.
 */
const CHILD_SPECS = {
  'probe.maybe': { kind: 'single' as const, scope: 'session-maybe' as const },
  'probe.strict': { kind: 'single' as const, scope: 'session' as const },
  'probe.list': { kind: 'list' as const, scope: 'root' as const },
}

function mountFrame(
  core: SlotCore,
  host: HostDouble,
  children: Partial<typeof CHILD_SPECS>,
  body: (renderSlot: FrameSlots['renderSlot']) => ReactNode,
  setup: () => void = () => {},
): HTMLElement {
  // The root entry declares the probe slots; child entries can only register
  // against a declaration, so setup runs between the two.
  core.register({ name: 'root', children }, frame(body))
  setup()
  const view = render(<>{createSlotRenderer().renderRoot(host.host, {})}</>)
  return view.container
}

/** Flush React work plus the core's microtask-batched notifications. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('T-A1/A3 session-maybe is a legal optional scope', () => {
  it('T-A1 renders a session-maybe entry while no adapter was ever installed, then adopts the adapter', async () => {
    const core = new SlotCore()
    const host = hostOver(core)
    const container = mountFrame(
      core,
      host,
      { 'probe.maybe': CHILD_SPECS['probe.maybe'] },
      renderSlot => <>{renderSlot('probe.maybe', {})}</>,
      () => { core.register({ name: 'probe.maybe' }, MaybeProbe) },
    )

    // No adapter ever: absent, and NOT a crash face / not an assembly alert.
    expect(container.querySelector('[data-probe="maybe"]')).toBeTruthy()
    expect(container.querySelector('[data-scope-absent]')).toBeTruthy()
    expect(container.querySelector('[data-slot-error]')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()

    const scope = scopeDouble('session-1')
    await act(async () => { host.install(scope.adapter) })
    await settle()

    expect(container.querySelector('[data-session="session-1"]')).toBeTruthy()
    expect(container.querySelector('[data-scope-absent]')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('T-A3 stays on the absent roster while the adapter keeps missing (repeated roster churn)', async () => {
    const core = new SlotCore()
    const host = hostOver(core)
    const container = mountFrame(
      core,
      host,
      { 'probe.maybe': CHILD_SPECS['probe.maybe'] },
      renderSlot => <>{renderSlot('probe.maybe', {})}</>,
      () => { core.register({ name: 'probe.maybe' }, MaybeProbe) },
    )

    for (let i = 0; i < 5; i += 1) {
      await act(async () => { host.bump() })
      await settle()
      expect(container.querySelector('[data-scope-absent]')).toBeTruthy()
      expect(container.querySelector('[data-slot-error]')).toBeNull()
      expect(container.querySelector('[role="alert"]')).toBeNull()
    }
    expect(container.textContent).toContain('absent')
  })
})

describe('T-A2 detach → re-attach keeps the tree rendered', () => {
  it('renders the detached absent projection, then recovers when a new adapter installs', async () => {
    const core = new SlotCore()
    const host = hostOver(core)
    const first = scopeDouble('session-1')
    host.install(first.adapter)
    const container = mountFrame(
      core,
      host,
      { 'probe.maybe': CHILD_SPECS['probe.maybe'] },
      renderSlot => <>{renderSlot('probe.maybe', {})}</>,
      () => { core.register({ name: 'probe.maybe' }, MaybeProbe) },
    )

    expect(container.querySelector('[data-session="session-1"]')).toBeTruthy()

    // Unload the adapter (HMR teardown / plugin disabled).
    await act(async () => { host.detach() })
    await settle()
    expect(container.querySelector('[data-probe="maybe"]')).toBeTruthy()
    expect(container.querySelector('[data-scope-absent]')).toBeTruthy()
    expect(container.querySelector('[data-slot-error]')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()

    // Re-mount a fresh adapter: the entry must come back, not stay dead.
    const second = scopeDouble('session-2')
    await act(async () => { host.install(second.adapter) })
    await settle()
    expect(container.querySelector('[data-session="session-2"]')).toBeTruthy()
    expect(container.querySelector('[data-scope-absent]')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('T-A4 strict session failure is visible and the root stays non-empty', () => {
  it('shows role=alert with the real assembly message, then recovers on the roster change', async () => {
    const core = new SlotCore()
    const host = hostOver(core)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A strict session child with NO adapter at all: a miswired composition,
    // which must be loud — and visible, not a blank document.
    const container = mountFrame(
      core,
      host,
      { 'probe.strict': CHILD_SPECS['probe.strict'] },
      renderSlot => <>{renderSlot('probe.strict', {})}</>,
      () => { core.register({ name: 'probe.strict' }, OkProbe) },
    )
    await settle()

    const detailOf = (): string => container.querySelector('[data-root-assembly-detail]')?.textContent ?? ''

    expect(container.querySelector('[role="alert"]')).toBeTruthy()
    expect(container.querySelector('[data-root-assembly-error]')).toBeTruthy()
    // Root is NOT empty — the failure surface is the visible content.
    expect(container.firstElementChild).not.toBeNull()
    expect((container.textContent ?? '').length).toBeGreaterThan(0)
    // The message is the real error message, not a generic placeholder.
    expect(detailOf()).toContain("session child without an installed 'session' scope adapter")
    // Manual retry is offered (no location.reload anywhere).
    expect(container.querySelector('[data-root-assembly-retry]')).toBeTruthy()

    // Adapter arrives but the scope has NO session selected: still a strict
    // failure, now reported by the outlet itself — and the roster change
    // retries automatically, so the message updates without a click.
    const scope = scopeDouble(undefined)
    await act(async () => { host.install(scope.adapter) })
    await settle()
    expect(container.querySelector('[role="alert"]')).toBeTruthy()
    expect(detailOf()).toContain("strict session slot 'probe.strict' rendered without a scope binding")

    // A session appears. While the tree is torn down only the roster revision is
    // observable (the providers below are unmounted), so the manual retry is the
    // channel for a binding-only change — and it brings the tree back.
    await act(async () => { scope.set('session-1') })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-root-assembly-retry]')?.click()
    })
    await settle()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[data-probe="ok"]')).toBeTruthy()
    consoleError.mockRestore()
  })
})

describe('T-A5 an ordinary entry crash does not take down its siblings', () => {
  it('renders the healthy sibling while the crashed cell keeps the crash face', async () => {
    const core = new SlotCore()
    const host = hostOver(core)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = mountFrame(
      core,
      host,
      { 'probe.list': CHILD_SPECS['probe.list'] },
      renderSlot => <>{renderSlot('probe.list', {})}</>,
      () => {
        core.register({ name: 'probe.list', id: 'ok' }, OkProbe)
        core.register({ name: 'probe.list', id: 'boom' }, BoomProbe)
      },
    )
    await settle()

    expect(container.querySelector('[data-probe="ok"]')).toBeTruthy()
    expect(container.querySelector('[data-slot-error="probe.list"]')).toBeTruthy()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    consoleError.mockRestore()
  })
})

describe('T-A6 revision churn retries are bounded', () => {
  it('keeps one visible failure surface and a bounded attempt count under flapping', async () => {
    const core = new SlotCore()
    const host = hostOver(core)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = mountFrame(
      core,
      host,
      { 'probe.strict': CHILD_SPECS['probe.strict'] },
      renderSlot => <>{renderSlot('probe.strict', {})}</>,
      () => { core.register({ name: 'probe.strict' }, OkProbe) },
    )
    await settle()
    expect(container.querySelector('[role="alert"]')).toBeTruthy()

    const attemptsOf = (): number => Number(container.querySelector('[data-root-assembly-error]')?.getAttribute('data-root-assembly-attempts') ?? '0')

    for (let i = 0; i < 10; i += 1) {
      await act(async () => { host.bump() })
      await settle()
      expect(container.querySelector('[role="alert"]')).toBeTruthy()
      expect(container.firstElementChild).not.toBeNull()
    }
    const afterChurn = attemptsOf()
    // One attempt per roster generation, never a growing render storm.
    expect(afterChurn).toBeGreaterThan(0)
    expect(afterChurn).toBeLessThanOrEqual(10 + 3)

    // Duplicate notifications at the SAME revision must not keep re-rendering.
    for (let i = 0; i < 20; i += 1) {
      await act(async () => { host.notifyOnly() })
    }
    await settle()
    expect(attemptsOf()).toBeLessThanOrEqual(afterChurn + 3)

    // Manual retry is always available and still bounded.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-root-assembly-retry]')?.click()
    })
    await settle()
    expect(container.querySelector('[role="alert"]')).toBeTruthy()
    expect(attemptsOf()).toBeLessThanOrEqual(4)
    consoleError.mockRestore()
  })
})
