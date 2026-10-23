/**
 * 扩展包插件热应用（P3b）。
 *
 * ## 这一层做什么
 *
 * 在 host 已 boot、config-tree 已挂载后，把 `<CORUM_HOME>/extension-packs/<packId>/entries.json`
 * 折出来的 plugin 行**不重启地**挂进活着的 Loader：重算完整 patch 列表、喂给
 * 根 `include` entry 的 `update({ config: { ..., patches } })`、等 `loader.await()`。
 *
 * ## 为什么走 `include.update` 而不是 `reconcileProfilePatches`
 *
 * 见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2.2：
 * 官方 `reconcileProfilePatches(ctx, patches, binName, requiredIds)` 只吃 ctx、
 * 不吃 hmr——理论上 corum 可以直接用它热应用。但**在 pinned 基线 0.1.5-rc.3
 * 上它没被导出**（只在 dsh 0.2.x 才有），所以本基线走 spike 验证过的等价路径：
 *
 *   const include = loader.resolve('include')
 *   await include.update({ config: { ...include.options.config, patches: fullList } })
 *   await loader.await()
 *
 * 两者都把「完整有序 patch 列表」喂给同一个根 Include entry 的 `patches` 配置项；
 * Include 的 apply 跑 `applyEntryPatches([], patches, warn)` 重算行表后挂载。
 *
 * ## 为什么每次都从 base 重算（见 section 5.2.1.1）
 *
 * `applyEntryPatches` 的 `insert` 是 append 语义、不按 id 去重。若拿 Loader
 * 当前状态当输入，重复 apply 会出现重复行。所以每次热应用都用**不含任何
 * extension insert 结果的 base**（boot.ts 启动时算好的层栈）重新追加 extension +
 * disabled，自然幂等。base 由 boot.ts 在启动时算好、传给本类构造器。
 *
 * ## 为什么 entry id 不能含 ':'
 *
 * `EntryTree.sep = ':'`，`resolve(id)` 按 `:` 分段解析嵌套 id。所以扩展包 entry
 * id 虽然形式上是 `ext:<packId>:<pluginName>`，但它们**不是 Loader 顶层 entry id**——
 * 它们是 `include` entry **子树**里的 insert 行 id（Include 自己解析它的 YAML/patch
 * 方言，不分段）。所以热应用**绝不能** `loader.create({ id: 'ext:pack:name' })`——
 * 那会让 Loader 按 `:` 段去 resolve 一个不存在的嵌套 entry（"cannot resolve entry"）。
 * include-patch 路线是本基线上唯一可行的：entry id 含 ':' 只在 Include 的 patch 方言
 * 里被当成普通字符串 id，不触发 Loader 的分段。
 *
 * ## 串行化与回滚
 *
 * 并发 apply 由一条 promise 队列串行（等价官方 `hmr.runExclusive`）：
 * 同一时刻只允许一次热应用、不嵌套。一次失败不能毒化后续调用——失败的 promise
 * 仍要 settle，让队列的下一个 `.then` 接得上。
 *
 * 失败回滚：记住上一次成功的完整列表 `lastGood`，apply 抛错时把它喂回 include
 * （best-effort，回滚本身失败也只记日志不抛），再 rethrow 一个带上下文的 Error。
 *
 * **绝不写 entries.json**——热应用只读 entries.json 折行、只写 Loader 内存。
 * entries.json 的写入是安装器（P2 install）/归属台账（P4 registry）的职责。
 *
 * @module @corum/corum-extension-pack/hot-apply
 */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { extensionPatches, loadExtensionEntries, type ExtensionEntriesFile } from './entries-store.ts'
import { composeExtensionPatchList } from './patch-compose.ts'

// 重新导出纯函数辅助，让消费方从本模块一处取热应用相关的全部 API。
export { composeExtensionPatchList } from './patch-compose.ts'

/**
 * 热应用需要的 Loader 形状（局部能力接口，不耦合 cordis-plugin-loader 的完整类型）。
 *
 * 见红线 3：跨包类型面可能不匹配时，用局部能力接口收窄。这里只暴露热应用用到的
 * `resolve('include')` / `await()` 两个面，测试用 fake loader 实现它即可。
 */
export interface HotApplyLoaderLike {
  /**
   * 解析根 include entry。返回的 entry 的 `options.config` 形如
   * `{ path: string; patches?: PatchOptions[] }`（Include.Config）。
   */
  resolve(id: string): {
    readonly options: {
      readonly config?: {
        readonly path?: string
        readonly patches?: readonly unknown[]
      }
    }
    update(options: unknown): Promise<void>
  }
  /** 等待 Loader 的 import / 生命周期任务排空（含 fiber 失败抛错）。 */
  await(): Promise<void>
}

/**
 * 热应用的依赖注入面（构造器收 deps，便于测试注入 fake）。
 *
 * - `home`：CORUM_HOME，读 `extension-packs/<packId>/entries.json`。
 * - `basePatches`：boot.ts 启动时算好的层栈（不含 extension/disabled 折行）。
 *   热应用每次都用同一份 base 重新追加（见上文「为什么每次都从 base 重算」）。
 * - `getDisabledPatches`：每次 apply **现读**`plugins.disabled.json` 折出的
 *   `{ id, disabled: true }` 行，而不是用 boot 时的快照——否则运行期在插件中心
 *   停用一个插件后，下一次热应用会用旧快照把它重新打开。
 *   与 extension 行同层叠加、顺序在 extension 之后（与 boot.ts 的 composedOverlays 同款）。
 * - `getLoader`：延迟取 Loader（boot 完成后才可用——见 boot.ts 的 manager.attach(ctx)）。
 * - `loadEntries`：可注入的 entries 加载器（默认 `loadExtensionEntries`，测试可注入 fake）。
 */
export interface HotApplyDeps {
  readonly home: string
  readonly basePatches: readonly PatchOptions[]
  readonly getDisabledPatches: () => readonly PatchOptions[]
  readonly getLoader: () => HotApplyLoaderLike
  readonly loadEntries?: (home: string) => readonly ExtensionEntriesFile[]
}

/** apply 的结果。 */
export interface HotApplyResult {
  /** 折出的 extension 行数（不含 base/disabled）。 */
  readonly rows: number
}

/**
 * 扩展包插件热应用器。
 *
 * 串行化：`apply()` 的并发调用按到达顺序排队（一条 promise chain），
 * 同一时刻只跑一个；失败不毒化后续。
 *
 * 回滚：记住上一次成功的完整 patch 列表；apply 抛错时 best-effort 把它喂回 include，
 * 再 rethrow 带 context 的 Error。
 *
 * 状态：`rows()` 返回上一次成功 apply 折出的 extension 行数（首次成功前为 0）。
 */
export class ExtensionHotApply {
  private readonly deps: HotApplyDeps
  /** 串行队列：每个 apply 接在上一个 promise 的 `.then` 后，失败也 settle。 */
  private queue: Promise<HotApplyResult> = Promise.resolve({ rows: 0 })
  /** 上一次成功 apply 的完整 patch 列表（用于失败回滚）。 */
  private lastGood: PatchOptions[] | undefined
  /** 上一次成功 apply 折出的 extension 行数。 */
  private lastRows = 0

  constructor(deps: HotApplyDeps) {
    this.deps = deps
  }

  /**
   * 热应用一次：读 entries → 折 extension 行 → 合成完整列表 → 喂 include.update → await。
   *
   * 串行：并发调用排队。失败：若存在 lastGood 则 best-effort 回滚到它，再 rethrow。
   *
   * @returns 折出的 extension 行数。
   */
  apply(): Promise<HotApplyResult> {
    // 把本次 run 接在队列尾。关键：失败不毒化队列——runOnce 的 rejection
    // 被 `.then(undefined, identity)` 吞成 fulfilled，让下一个 .then 仍能接上。
    // 真正的 rejection 通过返回值 `run`（不经过 queue）传给调用方。
    //
    // 注意类型：queue 声明为 Promise<HotApplyResult>，但回滚/吞错后赋的是
    // Promise<undefined>。这里用两条独立链——run 是给调用方的（带 rejection），
    // queue 是内部串行锁（永远 fulfilled）。强转为 HotApplyResult 让 TS 不纠结
    // 队列链上 undefined 的传播（运行时 runOnce resolve 的就是 HotApplyResult）。
    const run = this.queue.then(() => this.runOnce())
    // queue 永远 fulfilled：runOnce 抛错时用 .catch 捕获，返回一个标记值，
    // 让队列本身继续。调用方拿到的 `run`（同源 promise）才会 reject。
    this.queue = run.then(
      () => undefined,
      () => undefined, // 吞掉 rejection，防止毒化队列
    ) as unknown as Promise<HotApplyResult>
    return run
  }

  /** 上一次成功 apply 折出的 extension 行数（首次成功前为 0）。 */
  rows(): number {
    return this.lastRows
  }

  /** 单次 apply 的实现（不做串行化——由 apply() 的队列包好）。 */
  private async runOnce(): Promise<HotApplyResult> {
    const { home, basePatches, getDisabledPatches, getLoader, loadEntries } = this.deps
    // 读 entries：默认走真实的 loadExtensionEntries（fail loud——脏 entries.json 抛错）；
    // 测试可注入 loadEntries。
    const files = (loadEntries ?? loadExtensionEntries)(home)
    const extension = extensionPatches(files)
    // 每次现读 disabled：插件中心的启停是运行期可变的，不能拿 boot 快照。
    const full = composeExtensionPatchList(basePatches, extension, getDisabledPatches())

    const loader = getLoader()
    const include = loader.resolve('include')
    // 捕获 include 当前的 config（除了 patches 之外的字段，如 path，必须保留）。
    const prevConfig = include.options.config ?? {}
    const prevPatches = prevConfig.patches ?? []

    try {
      // 喂完整列表给 include 的 patches 配置项。structuredClone 与 boot.ts 同款：
      // 防止 Loader 把我们传入的 patch 对象烘焙进它自己的状态（之后我们再改
      // basePatches 引用会误伤 Loader）。
      await include.update({ config: { ...prevConfig, patches: structuredClone(full) } })
      await loader.await()
    } catch (error) {
      // 回滚：把 lastGood（上一次成功的完整列表）喂回 include。best-effort：
      // 回滚本身失败只记 stderr，不掩盖原始错误。若 lastGood 不存在（首次就失败），
      // 退回 prevPatches（include 原本的 patches，至少不比 apply 前更糟）。
      const restore: PatchOptions[] = this.lastGood ?? [...(prevPatches as readonly PatchOptions[])]
      try {
        await include.update({ config: { ...prevConfig, patches: structuredClone(restore) } })
        await loader.await()
      } catch (rollbackError) {
        process.stderr.write(
          `[corum-extension-pack] 热应用回滚失败：${String((rollbackError as Error)?.stack ?? rollbackError)}\n`,
        )
      }
      const reason = error instanceof Error ? error.stack ?? error.message : String(error)
      throw new Error(`[corum-extension-pack] 扩展包插件热应用失败：\n${reason}`)
    }

    // 成功：记住这次的完整列表与行数，供下次回滚 / status 用。
    this.lastGood = full
    this.lastRows = extension.reduce((n, patch) => n + (patch.insert?.length ?? 0), 0)
    return { rows: this.lastRows }
  }
}
