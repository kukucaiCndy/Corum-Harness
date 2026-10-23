/**
 * 扩展包插件热应用测试（P3b）。
 *
 * 覆盖：
 *   1. 首次 apply 合成 base+extension+disabled 顺序、调 await 一次。
 *   2. entries 变更后第二次 apply 不重复行、替换列表（从 base 重算）。
 *   3. update 抛错 ⇒ 用 lastGood 回滚 + rethrow。
 *   4. 并发 apply 串行（max in-flight = 1）。
 *   5. 失败后队列继续（后续 apply 仍能成功）。
 *   6. rows() 在首次成功前为 0、成功后返回行数。
 *   7. patch-compose 纯函数顺序正确。
 *
 * 所有夹具在内存里（fake loader + 注入 loadEntries），不碰磁盘 / 真实 Loader。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2 / 5.2.1.1 / 5.2.2。
 */
import { describe, it, expect } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  composeExtensionPatchList,
  ExtensionHotApply,
  type HotApplyLoaderLike,
  type HotApplyDeps,
} from '../src/hot-apply.ts'
import type { ExtensionEntriesFile } from '../src/entries-store.ts'

// ── fake loader ────────────────────────────────────────────────────────

/**
 * fake loader：记录 update / await 调用，可控制 update 是否抛错。
 *
 * include entry 的 config 初始为 { path: '/root', patches: [] }，
 * 每次 update 把传入的 config.patches 存进 currentConfig.patches（记录全部 update 历史）。
 */
interface FakeLoaderOpts {
  /** 第 N 次 update（0-based）抛错；undefined 表示永不抛。 */
  failOnUpdate?: number
}

function makeFakeLoader(opts: FakeLoaderOpts = {}): HotApplyLoaderLike & {
  updates: { config?: { patches?: unknown[] } }[]
  awaitCalls: number
  currentPatches: unknown[]
  updateCount: number
} {
  let config: { path: string; patches: unknown[] } = { path: '/root', patches: [] }
  const updates: { config?: { patches?: unknown[] } }[] = []
  let awaitCalls = 0
  let updateCount = 0
  const loader: HotApplyLoaderLike & {
    updates: { config?: { patches?: unknown[] } }[]
    awaitCalls: number
    currentPatches: unknown[]
    updateCount: number
  } = {
    resolve(_id: string) {
      return {
        get options() {
          return { config }
        },
        async update(options: unknown) {
          const idx = updateCount++
          updates.push(options as { config?: { patches?: unknown[] } })
          if (opts.failOnUpdate === idx) {
            throw new Error('fake update boom')
          }
          const o = options as { config?: { path?: string; patches?: unknown[] } }
          if (o.config !== undefined) {
            config = {
              path: typeof o.config.path === 'string' ? o.config.path : config.path,
              patches: Array.isArray(o.config.patches) ? [...o.config.patches] : config.patches,
            }
          }
        },
        async await() {
          awaitCalls++
        },
      }
    },
    async await() {
      awaitCalls++
    },
    get updates() { return updates },
    get awaitCalls() { return awaitCalls },
    get currentPatches() { return config.patches },
    get updateCount() { return updateCount },
  }
  return loader
}

// ── 辅助：造一份单条 entry 的 entries 文件 ─────────────────────────────

function makeEntries(packId: string, pluginName: string): ExtensionEntriesFile {
  return {
    packId,
    version: '1.0.0',
    entries: [{ id: `ext:${packId}:${pluginName}`, name: pluginName }],
  }
}

function makeDeps(loader: HotApplyLoaderLike, files: ExtensionEntriesFile[]): HotApplyDeps {
  return {
    home: '/fake-home',
    basePatches: [{ id: 'base-row', name: 'base-plugin' }] as readonly PatchOptions[],
    getDisabledPatches: () => [{ id: 'disabled-row', disabled: true }] as readonly PatchOptions[],
    getLoader: () => loader,
    loadEntries: () => files,
  }
}

// ── patch-compose 纯函数 ───────────────────────────────────────────────

describe('composeExtensionPatchList', () => {
  it('合成顺序为 base → extension → disabled', () => {
    const base: PatchOptions[] = [{ id: 'b1', name: 'b' }]
    const ext: PatchOptions[] = [{ insert: [{ id: 'ext:p:a', name: 'a' }] }]
    const dis: PatchOptions[] = [{ id: 'd1', disabled: true }]
    const result = composeExtensionPatchList(base, ext, dis)
    expect(result).toEqual([base[0], ext[0], dis[0]])
  })

  it('不改入参（返回新数组）', () => {
    const base: PatchOptions[] = [{ id: 'b', name: 'b' }]
    const result = composeExtensionPatchList(base, [], [])
    expect(result).not.toBe(base)
    expect(base).toEqual([{ id: 'b', name: 'b' }])
  })

  it('空输入返回空数组', () => {
    expect(composeExtensionPatchList([], [], [])).toEqual([])
  })
})

// ── ExtensionHotApply ──────────────────────────────────────────────────

describe('ExtensionHotApply', () => {
  it('首次 apply 合成 base+extension+disabled 顺序、调 await 一次、rows 正确', async () => {
    const loader = makeFakeLoader()
    const files = [makeEntries('test-pack', 'corum-ext-probe')]
    const ha = new ExtensionHotApply(makeDeps(loader, files))

    expect(ha.rows()).toBe(0)
    const result = await ha.apply()

    expect(result.rows).toBe(1)
    expect(ha.rows()).toBe(1)
    // 只 update 一次（include.update）。
    expect(loader.updateCount).toBe(1)
    // await 调过一次。
    expect(loader.awaitCalls).toBeGreaterThanOrEqual(1)
    // include 收到的 patches = [base, extension insert, disabled]。
    expect(loader.currentPatches).toEqual([
      { id: 'base-row', name: 'base-plugin' },
      { insert: [{ id: 'ext:test-pack:corum-ext-probe', name: 'corum-ext-probe' }] },
      { id: 'disabled-row', disabled: true },
    ])
  })

  it('每次 apply 现读 disabled：运行期启停变化会被反映，不用 boot 快照', async () => {
    const loader = makeFakeLoader()
    let disabled: readonly PatchOptions[] = []
    const deps: HotApplyDeps = {
      home: '/fake-home',
      basePatches: [] as readonly PatchOptions[],
      getDisabledPatches: () => disabled,
      getLoader: () => loader,
      loadEntries: () => [makeEntries('test-pack', 'corum-ext-probe')],
    }
    const ha = new ExtensionHotApply(deps)

    await ha.apply()
    // 第一次：disabled 为空，只有 extension 行。
    expect(loader.currentPatches).toHaveLength(1)

    // 运行期在插件中心停用了某插件 ⇒ disabled 列表变了。
    disabled = [{ id: 'disabled-row', disabled: true }] as readonly PatchOptions[]
    await ha.apply()
    // 第二次：新 disabled 行必须出现在 extension 行之后。
    expect(loader.currentPatches).toEqual([
      { insert: [{ id: 'ext:test-pack:corum-ext-probe', name: 'corum-ext-probe' }] },
      { id: 'disabled-row', disabled: true },
    ])
  })

  it('entries 变更后第二次 apply 不重复行、替换列表（从 base 重算）', async () => {
    const loader = makeFakeLoader()
    // 第一次：一个 plugin。
    let files = [makeEntries('test-pack', 'corum-ext-probe')]
    // 用闭包让 loadEntries 返回当前 files（模拟文件变更）。
    const deps: HotApplyDeps = {
      home: '/fake-home',
      basePatches: [{ id: 'base-row', name: 'base-plugin' }] as readonly PatchOptions[],
      getDisabledPatches: () => [] as readonly PatchOptions[],
      getLoader: () => loader,
      loadEntries: () => files,
    }
    const ha = new ExtensionHotApply(deps)

    await ha.apply()
    expect(loader.currentPatches).toEqual([
      { id: 'base-row', name: 'base-plugin' },
      { insert: [{ id: 'ext:test-pack:corum-ext-probe', name: 'corum-ext-probe' }] },
    ])

    // 第二次：entries 改成两个 plugin（模拟文件变更）。
    files = [
      makeEntries('test-pack', 'corum-ext-probe'),
      makeEntries('test-pack', 'corum-ext-probe-2'),
    ]
    const result = await ha.apply()

    expect(result.rows).toBe(2)
    // 仍只有 base + 两个 extension 行，**没有重复**（从 base 重算）。
    expect(loader.currentPatches).toEqual([
      { id: 'base-row', name: 'base-plugin' },
      { insert: [
        { id: 'ext:test-pack:corum-ext-probe', name: 'corum-ext-probe' },
        { id: 'ext:test-pack:corum-ext-probe-2', name: 'corum-ext-probe-2' },
      ] },
    ])
  })

  it('第二次 entries 相同内容 ⇒ 不重复行（幂等：从 base 重算）', async () => {
    const loader = makeFakeLoader()
    const files = [makeEntries('test-pack', 'corum-ext-probe')]
    const ha = new ExtensionHotApply(makeDeps(loader, files))

    await ha.apply()
    const result = await ha.apply()

    expect(result.rows).toBe(1)
    expect(loader.currentPatches).toEqual([
      { id: 'base-row', name: 'base-plugin' },
      { insert: [{ id: 'ext:test-pack:corum-ext-probe', name: 'corum-ext-probe' }] },
      { id: 'disabled-row', disabled: true },
    ])
    // 两次 update（每次 apply 一次）。
    expect(loader.updateCount).toBe(2)
  })

  it('update 抛错 ⇒ 用 lastGood 回滚 + rethrow', async () => {
    // 第一次成功（failOnUpdate = undefined），第二次失败（failOnUpdate = 1）。
    // 但同一 loader 不能动态切 failOnUpdate，所以用计数器 fake。
    let updateCount = 0
    let config: { path: string; patches: unknown[] } = { path: '/root', patches: [] }
    const updates: { config?: { patches?: unknown[] } }[] = []
    let awaitCalls = 0
    const loader: HotApplyLoaderLike = {
      resolve() {
        return {
          get options() { return { config } },
          async update(options: unknown) {
            const idx = updateCount++
            updates.push(options as { config?: { patches?: unknown[] } })
            if (idx === 1) throw new Error('fake boom on second update')
            const o = options as { config?: { path?: string; patches?: unknown[] } }
            if (o.config !== undefined) {
              config = {
                path: typeof o.config.path === 'string' ? o.config.path : config.path,
                patches: Array.isArray(o.config.patches) ? [...o.config.patches] : config.patches,
              }
            }
          },
          async await() { awaitCalls++ },
        }
      },
      async await() { awaitCalls++ },
    }
    const files = [makeEntries('test-pack', 'corum-ext-probe')]
    const ha = new ExtensionHotApply(makeDeps(loader, files))

    // 第一次成功。
    const first = await ha.apply()
    expect(first.rows).toBe(1)

    // 第二次：loadEntries 仍返回同一份（所以 full list 不变），
    // 但 update 在 idx=1 抛错。应回滚到 lastGood。
    await expect(ha.apply()).rejects.toThrow(/扩展包插件热应用失败/)

    // 回滚：update 被调了 3 次（apply[idx=1 抛错] + rollback[idx=2]），
    // 加上第一次成功 apply[idx=0]。
    expect(updateCount).toBe(3)
    // 回滚后 include 的 patches 应等于第一次成功的 full list（base + extension + disabled）。
    expect(config.patches).toEqual([
      { id: 'base-row', name: 'base-plugin' },
      { insert: [{ id: 'ext:test-pack:corum-ext-probe', name: 'corum-ext-probe' }] },
      { id: 'disabled-row', disabled: true },
    ])
  })

  it('首次就失败（无 lastGood）⇒ 退回 prevPatches、rethrow', async () => {
    const loader = makeFakeLoader({ failOnUpdate: 0 })
    const files = [makeEntries('test-pack', 'corum-ext-probe')]
    const ha = new ExtensionHotApply(makeDeps(loader, files))

    await expect(ha.apply()).rejects.toThrow(/扩展包插件热应用失败/)
    // 无 lastGood：回滚退回 prevPatches（include 原本的 patches = []）。
    expect(loader.currentPatches).toEqual([])
  })

  it('并发 apply 串行（max in-flight = 1）', async () => {
    const loader = makeFakeLoader()
    const files = [makeEntries('test-pack', 'corum-ext-probe')]
    const ha = new ExtensionHotApply(makeDeps(loader, files))

    // 让 update 变成真正的 async（加一个微任务延迟），这样并发调用会真的重叠
    // 如果串行化没生效的话。用一个 gate 跟踪「同时有几个 runOnce 在跑」。
    let inFlight = 0
    let maxInFlight = 0
    const origResolve = loader.resolve
    const wrappedLoader: HotApplyLoaderLike = {
      resolve(id: string) {
        const entry = origResolve.call(loader, id)
        return {
          get options() { return entry.options },
          async update(options: unknown) {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await Promise.resolve() // 让出一轮微任务
            try {
              await entry.update(options)
            } finally {
              inFlight--
            }
          },
        }
      },
      async await() { await loader.await() },
    }
    const ha2 = new ExtensionHotApply({
      home: '/fake-home',
      basePatches: [{ id: 'base', name: 'b' }] as readonly PatchOptions[],
      getDisabledPatches: () => [] as readonly PatchOptions[],
      getLoader: () => wrappedLoader,
      loadEntries: () => files,
    })

    // 并发发 3 个 apply。
    const results = await Promise.all([ha2.apply(), ha2.apply(), ha2.apply()])
    // 全部成功。
    expect(results.every(r => r.rows === 1)).toBe(true)
    // max in-flight = 1（串行化生效）。
    expect(maxInFlight).toBe(1)
  })

  it('失败后队列继续（后续 apply 仍能成功）', async () => {
    // 第一次失败（failOnUpdate=0），第二次成功。
    // 用一个会动态恢复的 fake。
    let updateCount = 0
    let config: { path: string; patches: unknown[] } = { path: '/root', patches: [] }
    const loader: HotApplyLoaderLike = {
      resolve() {
        return {
          get options() { return { config } },
          async update(options: unknown) {
            const idx = updateCount++
            if (idx === 0) throw new Error('first boom')
            const o = options as { config?: { path?: string; patches?: unknown[] } }
            if (o.config !== undefined) {
              config = {
                path: typeof o.config.path === 'string' ? o.config.path : config.path,
                patches: Array.isArray(o.config.patches) ? [...o.config.patches] : config.patches,
              }
            }
          },
          async await() {},
        }
      },
      async await() {},
    }
    const files = [makeEntries('test-pack', 'corum-ext-probe')]
    const ha = new ExtensionHotApply(makeDeps(loader, files))

    // 第一次失败。
    await expect(ha.apply()).rejects.toThrow(/热应用失败/)
    // 第二次成功（队列没被毒化）。
    const result = await ha.apply()
    expect(result.rows).toBe(1)
    expect(ha.rows()).toBe(1)
  })

  it('空 entries ⇒ 0 行、仍 update include（把 base+disabled 喂进去）', async () => {
    const loader = makeFakeLoader()
    const ha = new ExtensionHotApply(makeDeps(loader, []))

    const result = await ha.apply()
    expect(result.rows).toBe(0)
    expect(ha.rows()).toBe(0)
    // extension 为空，但 base + disabled 仍合成喂进 include。
    expect(loader.currentPatches).toEqual([
      { id: 'base-row', name: 'base-plugin' },
      { id: 'disabled-row', disabled: true },
    ])
  })
})
