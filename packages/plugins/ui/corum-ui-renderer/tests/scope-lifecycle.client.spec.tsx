// @vitest-environment jsdom
/**
 * T-A7：scope adapter 的安装/卸载/重挂语义（**真实 SlotRegistry + 真实 cordis fiber**）。
 *
 * ## 为什么要单独钉住（白屏 P0 的第二条链路）
 *
 * `installScope` 是「单 live owner」契约，但卸载与重挂之间没有任何状态机：
 *   · 旧实现只有 `_scopes.get(scope) === adapter` 的**身份断言**，一旦某次 cleanup 与新的
 *     install 交错（HMR 的旧 fiber 晚一步拆），它就可能删掉**后来者**的 adapter；
 *   · `_scopes` 一旦留下 detached 记录，同一 scope 重新挂载会被判成 Duplicate —— 于是
 *     卸载 → 重挂的循环里一次都挂不回来，渲染器只剩 absent（更坏的情况是整树抛掉）。
 *
 * 现在：cleanup 带 **generation** 守卫（只删自己那一代），detached 记录**可被重装替换**，
 * `_scopes` 由 scope 名数上界（本仓只有 `session` 一个键），无延迟、无 refcount。
 *
 * ⚠️ 不试图构造「cleanup 晚于新 install」的乱序（cordis effect 是同步的，公开 API 无法让它
 * 发生）；那条路径由 generation 守卫兜住，这里钉的是它的**可观测前提**：重复 install 拒绝、
 * detached 可替换、有界。
 * @module @corum/corum-ui-renderer/tests/scope-lifecycle
 */
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostObservable,
  PropsRenderSlots,
  SlotScopeAdapter,
  StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '../src/client/registry.ts'
import { apply as rendererApply, inject as rendererInject } from '../src/client/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'lifecycle.maybe': { kind: 'single'; scope: 'session-maybe'; owner: Record<string, never> }
  }
}

interface ScopeDouble {
  readonly adapter: SlotScopeAdapter
  readonly name: string
}

/** Stand-in owning Context: strict session entries key their generation by it. */
const SESSION_CTX = {}

function scopeDouble(name: string): ScopeDouble {
  const binding = {
    key: name,
    hooks: { session: { getSnapshot: () => name, subscribe: () => () => {} } },
    keyedHooks: {},
    props: {},
    ctx: SESSION_CTX,
  } as StandardSourceBinding
  const absent: StandardSourceBinding = {
    key: undefined,
    hooks: { session: undefined },
    keyedHooks: {},
    props: {},
  }
  const current: HostObservable<StandardSourceBinding> = {
    getSnapshot: () => binding,
    subscribe: () => () => {},
  }
  const absentSource: HostObservable<StandardSourceBinding> = {
    getSnapshot: () => absent,
    subscribe: () => () => {},
  }
  return {
    name,
    adapter: {
      current,
      bindingSource: () => absentSource,
      renderArea: (_binding, props) => props.children ?? null,
    },
  }
}

/** Private-axis view used ONLY to assert the map stays bounded (no production API for tests). */
interface ScopesInternals {
  readonly _scopes: Map<string, { readonly adapter: SlotScopeAdapter; readonly generation: number }>
}

function internalsOf(slots: SlotRegistry): ScopesInternals {
  return slots as unknown as ScopesInternals
}

async function bench(): Promise<{ ctx: Context; slots: SlotRegistry }> {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: [...rendererInject], apply: rendererApply })
  await fiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

/** Install through a disposable plugin fiber (the only real way to trigger the unload cleanup). */
async function installFromFiber(ctx: Context, adapter: SlotScopeAdapter): Promise<{ dispose(): Promise<void> }> {
  const fiber = ctx.plugin({
    inject: ['slots'],
    apply(child: Context) { child.slots.installScope('session', adapter) },
  })
  await fiber.await()
  return { async dispose() { await fiber.dispose() } }
}

function MaybeProbe(props: Record<string, unknown>): ReactNode {
  // Standard-kit seats are SELECTOR hooks (uSES): the selector is mandatory.
  const read = props['useSession'] as ((selector: (value: unknown) => unknown) => unknown) | undefined
  const id = read === undefined ? undefined : read(value => value) as string | undefined
  return (
    <div data-probe="maybe" {...(id === undefined ? { 'data-scope-absent': '' } : { 'data-session': id })}>
      {id ?? 'absent'}
    </div>
  )
}

type LifecycleSlots = PropsRenderSlots<'lifecycle.maybe'>

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('T-A7 scope adapter lifecycle', () => {
  it('rejects a second LIVE owner but accepts a re-install after the previous one detached', async () => {
    const { ctx, slots } = await bench()
    const first = scopeDouble('first')
    const installed = await installFromFiber(ctx, first.adapter)
    expect(internalsOf(slots)._scopes.size).toBe(1)

    // Live duplicate: still a loud composition error.
    expect(() => { slots.installScope('session', scopeDouble('intruder').adapter) }).toThrow(/already has an adapter/)

    // Detach (fiber unload) → the record is gone, so the scope accepts a fresh adapter.
    await act(async () => { await installed.dispose() })
    expect(internalsOf(slots)._scopes.size).toBe(0)

    const second = scopeDouble('second')
    const reinstalled = await installFromFiber(ctx, second.adapter)
    expect(internalsOf(slots)._scopes.get('session')?.adapter).toBe(second.adapter)
    await act(async () => { await reinstalled.dispose() })
  })

  it('keeps _scopes bounded across unload → re-mount cycles (no accumulating tombstones)', async () => {
    const { ctx, slots } = await bench()
    for (let i = 0; i < 20; i += 1) {
      const scope = scopeDouble(`cycle-${i}`)
      const installed = await installFromFiber(ctx, scope.adapter)
      expect(internalsOf(slots)._scopes.size).toBe(1)
      expect(internalsOf(slots)._scopes.get('session')?.adapter).toBe(scope.adapter)
      await act(async () => { await installed.dispose() })
      expect(internalsOf(slots)._scopes.size).toBe(0)
    }
    // Generations advance (each install is its own record) but nothing accumulates.
    expect(internalsOf(slots)._scopes.size).toBeLessThanOrEqual(1)
  })

  it('unload → re-mount of the scope does not blank the mounted application tree', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root', children: { 'lifecycle.maybe': { kind: 'single', scope: 'session-maybe' } } },
      (props: LifecycleSlots) => <>{props.renderSlot('lifecycle.maybe', {})}</>)
    slots.register({ name: 'lifecycle.maybe' }, MaybeProbe)

    const first = scopeDouble('first')
    const installed = await installFromFiber(ctx, first.adapter)

    const view = render(<>{slots.renderSlot('root', {})}</>)
    await act(async () => { await Promise.resolve() })
    expect(view.container.querySelector('[data-session="first"]')).toBeTruthy()

    // HMR-shaped teardown: the session owner's fiber unloads.
    await act(async () => { await installed.dispose() })
    await act(async () => { await Promise.resolve() })
    expect(view.container.querySelector('[data-probe="maybe"]')).toBeTruthy()
    expect(view.container.querySelector('[data-scope-absent]')).toBeTruthy()
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(view.container.firstElementChild).not.toBeNull()

    // Re-mount: the tree recovers on the new adapter.
    const second = scopeDouble('second')
    const reinstalled = await installFromFiber(ctx, second.adapter)
    await act(async () => { await Promise.resolve() })
    expect(view.container.querySelector('[data-session="second"]')).toBeTruthy()
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { await reinstalled.dispose() })
  })
})
