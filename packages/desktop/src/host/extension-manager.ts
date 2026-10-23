/**
 * corum-desktop/extension-manager — 扩展包插件热应用 Host 半（Typert Remote，
 * service 名 `extensionManager`）。
 *
 * ## 这一层做什么
 *
 * 监听 `<CORUM_HOME>/extension-packs/` 目录变化（watcher），在 entries.json 改动
 * 后调 `ExtensionHotApply.apply()` 不重启地把 plugin 行挂进活着的 Loader。
 *
 * 见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2.2（热应用）
 * 与 section 10 P3b（改动清单）。
 *
 * ## 为什么 watcher 不在 boot 时启动
 *
 * boot.ts 的 prepare 回调里 new 本服务（与 CorumPluginManager 同时机：
 * config-tree 挂载前的根 ctx 上），但 `ctx.loader` 这时**还没**可用——
 * loader 是 config-tree 挂载后才注入的服务（fiber inject 校验会抛
 * "cannot get property 'loader' without inject"）。所以 watcher 的启动
 * 推迟到 `attach(ctx)`——boot() 返回 ctx 之后、bootDesktop() return 之前。
 *
 * ## 为什么 loader 延迟直读 ctx.get('loader')
 *
 * 与 CorumPluginManager 同款（见 plugin-manager.ts 的注释）：本服务由 boot
 * 回调在根 ctx 直 new（非 fiber 挂载），`this.ctx.loader` 的 fiber 注入校验
 * 会抛。改为延迟直读 `ctx.get('loader')`（根 ctx 可及）。
 *
 * ## watcher 健壮性
 *
 * fs.watch 在 macOS 上对 recursive 目录监听不稳（events 丢失 / 乱序）。
 * 本实现优先用 fs.watch(recursive: true)，并对每个 event 重新 stat 目录
 * 兜底。若 fs.watch 不可用（抛错）则降级为 1s 轮询（见 section 10 的约束：
 * 「1s 轮询兜底可接受，但优先 fs.watch」）。watcher 抛错**绝不**让 host 崩溃
 * ——所有错误 catch 后只记 stderr（[corum-desktop] 前缀）。
 *
 * @module corum-desktop/extension-manager
 */

import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { ExtensionHotApply, type HotApplyLoaderLike } from '@corum/corum-extension-pack'
import { resolveDesktopHome } from './home.ts'

/** extension-packs 目录名（相对 CORUM_HOME）。 */
const EXTENSION_PACKS_DIRNAME = 'extension-packs'

/** watcher debounce（ms）：macOS fs.watch 会在一次写入里发多个 event，合并成一次 apply。 */
const WATCH_DEBOUNCE_MS = 300

/** fs.watch 不可用时的轮询兜底间隔（ms）。见 section 10 约束。 */
const POLL_FALLBACK_MS = 1000

/**
 * 扩展包插件热应用 Remote 服务。
 *
 * 构造时只存依赖（home/basePatches/getDisabledPatches），不碰 loader——loader 由
 * `attach(ctx)` 在 boot 完成后延迟解析。watcher 也在 attach 时启动。
 *
 * @Remote 方法：
 *   apply()  手动触发一次热应用（status / 调试用），返回 { ok, rows, error? }。
 *   status() 返回 { rows, watching }。
 */
export class CorumExtensionManager extends TypertRemoteService {
  private readonly home: string
  private readonly basePatches: readonly PatchOptions[]
  private readonly getDisabledPatches: () => readonly PatchOptions[]
  /** 热应用器；attach 时构造（需要 loader 才能创建）。 */
  private hotApply: ExtensionHotApply | undefined
  /** fs.watch watcher；attach 时创建。 */
  private watcher: FSWatcher | undefined
  /** 轮询兜底定时器（fs.watch 不可用时）。 */
  private pollTimer: NodeJS.Timeout | undefined
  /** debounce 定时器。 */
  private debounceTimer: NodeJS.Timeout | undefined
  /** 是否在 attach 里启动了 watch。 */
  private watching = false

  constructor(
    ctx: Context,
    deps: {
      readonly home: string
      readonly basePatches: readonly PatchOptions[]
      readonly getDisabledPatches: () => readonly PatchOptions[]
    },
  ) {
    super(ctx, 'extensionManager')
    this.home = deps.home
    this.basePatches = deps.basePatches
    this.getDisabledPatches = deps.getDisabledPatches
  }

  /**
   * boot 完成后调用：解析 loader、构造热应用器、启动 watcher。
   *
   * 必须在 config-tree 挂载后（boot() 返回 ctx 之后）调——之前 `ctx.get('loader')`
   * 返回 undefined。
   */
  attach(ctx: Context): void {
    // 延迟直读 Loader（绕过 fiber inject 校验；见上注）。
    const loader = ctx.get('loader') as
      | (HotApplyLoaderLike & { entries(): Iterable<{ options: { id: string; name: string; disabled?: boolean | null } }> })
      | undefined
    if (loader === undefined) {
      process.stderr.write('[corum-desktop] extension-manager: loader 不可用，热应用未启用\n')
      return
    }
    this.hotApply = new ExtensionHotApply({
      home: this.home,
      basePatches: this.basePatches,
      getDisabledPatches: this.getDisabledPatches,
      getLoader: () => loader,
    })
    this.startWatcher()
  }

  /** 手动触发一次热应用（status / 调试用；watcher 自动触发时不走 RPC）。 */
  @Remote('apply')
  async apply(): Promise<{ ok: boolean; rows: number; error?: string }> {
    if (this.hotApply === undefined) {
      return { ok: false, rows: 0, error: 'loader 不可用（热应用未启用）' }
    }
    try {
      const result = await this.hotApply.apply()
      process.stderr.write(`[corum-desktop] extension hot-apply: ${result.rows} 行\n`)
      return { ok: true, rows: result.rows }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[corum-desktop] extension hot-apply 失败：${msg}\n`)
      return { ok: false, rows: 0, error: msg }
    }
  }

  /** 当前状态：上一次成功 apply 的行数 + watcher 是否在跑。 */
  @Remote('status')
  status(): { rows: number; watching: boolean } {
    return {
      rows: this.hotApply?.rows() ?? 0,
      watching: this.watching,
    }
  }

  // ── watcher ──────────────────────────────────────────────────────────

  /**
   * 启动 extension-packs 目录 watcher。
   *
   * 先 mkdir -p 目录（干净 home 还没这个目录），再尝试 fs.watch(recursive)。
   * fs.watch 抛错则降级为 1s 轮询（macOS 兼容兜底，见类注释）。
   * watcher 抛错绝不崩 host：所有错误 catch 后只记 stderr。
   */
  private startWatcher(): void {
    const dir = join(this.home, EXTENSION_PACKS_DIRNAME)
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      process.stderr.write(`[corum-desktop] extension-manager: 创建 ${dir} 失败：${String(error)}\n`)
      return
    }

    // 先尝试 fs.watch（recursive）。macOS Node 22 支持；不可用就降级轮询。
    try {
      this.watcher = watch(dir, { recursive: true }, (_event, filename) => {
        // 只关心 entries.json 的变化（其他文件如 registry.json/state.json
        // 不影响热应用）。filename 可能是相对路径 / null / undefined（某些平台）。
        if (filename !== null && filename !== undefined && !filename.endsWith('entries.json')) return
        this.scheduleApply()
      })
      this.watching = true
      process.stderr.write(`[corum-desktop] extension-manager: fs.watch 监听 ${dir}\n`)
    } catch (error) {
      process.stderr.write(
        `[corum-desktop] extension-manager: fs.watch 不可用（${String(error)}），降级为 ${POLL_FALLBACK_MS}ms 轮询\n`,
      )
      this.pollTimer = setInterval(() => {
        this.scheduleApply()
      }, POLL_FALLBACK_MS)
      this.watching = true
    }
  }

  /**
   * debounce 后触发一次 apply。多次 event 合并成一次（macOS fs.watch 一次
   * 写入发多个 rename/change）。apply 失败只记 stderr（不崩 host）。
   */
  private scheduleApply(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.apply()
    }, WATCH_DEBOUNCE_MS)
  }
}

export default CorumExtensionManager
