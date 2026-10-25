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

import { existsSync, mkdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { ExtensionHotApply, installLocalExtensionPack, uninstallExtensionPack, type InstallLocalPackResult, type UninstallPackResult, type HotApplyLoaderLike } from '@corum/corum-extension-pack'
import type { ExtensionPluginDecl } from '@corum/corum-extension-pack'
import { readRegistry, ownershipMap, type ExtensionItemKind, type ExtensionPackRecord } from '@corum/corum-extension-registry'
import { resolveDesktopHome } from './home.ts'

/** extension-packs 目录名（相对 CORUM_HOME）。 */
const EXTENSION_PACKS_DIRNAME = 'extension-packs'

/** 六类资源类别（与 registry 的 ExtensionItemKind 同口径，P5 §4.2）。 */
const ALL_KINDS: readonly ExtensionItemKind[] = ['presets', 'skills', 'mcp', 'plugins', 'themes', 'ui']

/** 六类计数归零模板（list() 用，避免缺键）。 */
const EMPTY_COUNTS: Record<ExtensionItemKind, number> = {
  presets: 0, skills: 0, mcp: 0, plugins: 0, themes: 0, ui: 0,
}

/** watcher debounce（ms）：macOS fs.watch 会在一次写入里发多个 event，合并成一次 apply。 */
const WATCH_DEBOUNCE_MS = 300

/** fs.watch 不可用时的轮询兜底间隔（ms）。见 section 10 约束。 */
const POLL_FALLBACK_MS = 1000

/**
 * 扩展包插件热应用 Remote 服务。
 *
 * 构造时只存依赖（home/basePatches/getDisabledPatches/installPlugin），不碰 loader——loader 由
 * `attach(ctx)` 在 boot 完成后延迟解析。watcher 也在 attach 时启动。
 *
 * @Remote 方法：
 *   apply()         手动触发一次热应用（status / 调试用），返回 { ok, rows, error? }。
 *   status()        返回 { rows, watching }。
 *   installLocal()  端到端安装本地扩展包（P5c）：scan → skills/mcp/presets → 插件 →
 *                   entries.json → registry.json → hot apply → result。
 *   uninstall()     端到端卸载扩展包（P4）：registry 分档 → 删 entries → 逐项删除 →
 *                   删 pack 目录/registry → hot apply → result。
 */
export class CorumExtensionManager extends TypertRemoteService {
  private readonly home: string
  private readonly basePatches: readonly PatchOptions[]
  private readonly getDisabledPatches: () => readonly PatchOptions[]
  /**
   * 插件安装回调（来自 boot 注入的 CorumPluginManager.install）。
   *
   * P5c 的 installLocal 需要调 pluginManager.install(spec) 跑 pnpm add + reconcile。
   * 但本服务不直接依赖 CorumPluginManager（它是 boot 回调里 new 的兄弟服务），
   * 故 boot 把 `(spec) => pluginManagerInstance.install(spec)` 作为函数传入——
   * 这也是「依赖注入」让 installLocal 可测（测试传 stub）。
   */
  private readonly installPlugin?: (spec: string) => Promise<{ ok: boolean; restartRequired?: boolean; log?: string }>
  /**
   * 插件卸载回调（来自 boot 注入的 CorumPluginManager.removePackPlugin）。
   *
   * P4 的 uninstall 需要调 pluginManager 的卸载路径跑 pnpm remove + reconcile，
   * 但**必须绕过 PACK_OWNED 守卫**（整包卸载时 registry 记录正在被删除，
   * 归属检查是多余的）。故 boot 注入 `removePackPlugin(packageName)` 而非
   * `uninstall(entryId)`——前者按包名直跑 pnpm remove，不做归属检查。
   */
  private readonly uninstallPlugin?: (packageName: string) => Promise<{ ok: boolean; restartRequired?: boolean; log?: string }>
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
      /**
       * 插件安装回调（来自 CorumPluginManager.install）。
       * installLocal 用它跑 pnpm add <spec> + reconcile。
       */
      readonly installPlugin?: (spec: string) => Promise<{ ok: boolean; restartRequired?: boolean; log?: string }>
      /**
       * 插件卸载回调（来自 CorumPluginManager.removePackPlugin）。
       * uninstall 用它跑 pnpm remove <packageName> + reconcile（绕过 PACK_OWNED）。
       */
      readonly uninstallPlugin?: (packageName: string) => Promise<{ ok: boolean; restartRequired?: boolean; log?: string }>
    },
  ) {
    super(ctx, 'extensionManager')
    this.home = deps.home
    this.basePatches = deps.basePatches
    this.getDisabledPatches = deps.getDisabledPatches
    // exactOptionalPropertyTypes 下条件赋值：undefined 不直接赋给可选字段。
    if (deps.installPlugin !== undefined) this.installPlugin = deps.installPlugin
    if (deps.uninstallPlugin !== undefined) this.uninstallPlugin = deps.uninstallPlugin
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

  // ── 归属台账 RPC（P5a：list / detail / ownership）─────────────────

  /**
   * 列出所有已安装扩展包的摘要（registry + 状态）。
   *
   * 读 registry.json 的 packs，逐包补 extension.json 的 name/description
   * （容错：parse 失败/缺失不阻塞列表）、目录路径、六类计数。
   * 不走 scanExtensionPack——那会做重校验，列表页只需读 manifest 的展示字段。
   *
   * 见 P5 设计 §6.1 的 `list` RPC 与 §2.1 的包卡片字段。
   */
  @Remote('list')
  list(): {
    packs: Array<{
      readonly id: string
      readonly version: string
      readonly name?: string
      readonly installedAt: string
      readonly counts: Record<ExtensionItemKind, number>
      readonly dir: string
      readonly hasManifest: boolean
    }>
  } {
    // readRegistry 缺失返回 { packs: {} }（干净 home 合法）；损坏 fail loud。
    const registry = readRegistry(this.home)
    const packs = Object.values(registry.packs).map((pack): {
      id: string
      version: string
      name?: string
      installedAt: string
      counts: Record<ExtensionItemKind, number>
      dir: string
      hasManifest: boolean
    } => {
      const dir = join(this.home, EXTENSION_PACKS_DIRNAME, pack.id)
      const manifestPath = join(dir, 'extension.json')
      const hasManifest = existsSync(manifestPath)
      // 读 manifest 的 name/description（容错：parse 失败/缺失就用 registry 里的 name）。
      let manifestName: string | undefined
      if (hasManifest) {
        try {
          const raw = readFileSync(manifestPath, 'utf8')
          const parsed = JSON.parse(raw) as { name?: unknown }
          if (typeof parsed.name === 'string' && parsed.name.trim() !== '') manifestName = parsed.name
        } catch { /* 容错：manifest 坏了不阻塞列表，用 registry 的 name */ }
      }
      // 六类计数：registry items 各类数组长度。
      const counts = { ...EMPTY_COUNTS }
      if (pack.items !== undefined) {
        for (const kind of ALL_KINDS) {
          const items = pack.items[kind]
          if (items !== undefined) counts[kind] = items.length
        }
      }
      return {
        id: pack.id,
        version: pack.version,
        ...(manifestName !== undefined ? { name: manifestName } : pack.name !== undefined ? { name: pack.name } : {}),
        installedAt: pack.installedAt,
        counts,
        dir,
        hasManifest,
      }
    })
    return { packs }
  }

  /**
   * 一个扩展包的详情：registry 记录 + 目录 + manifest（容错）。
   *
   * 见 P5 设计 §6.1 的 `detail` RPC 与 §2.1 的详情展开。
   *
   * @param packId - 扩展包 id。
   * @returns `{ pack, dir, manifest?, error? }`；packId 不在 registry 时 error 提示。
   */
  @Remote('detail')
  detail(packId: string): {
    pack?: ExtensionPackRecord
    dir: string
    manifest?: unknown
    error?: string
  } {
    const registry = readRegistry(this.home)
    const pack = registry.packs[packId]
    const dir = join(this.home, EXTENSION_PACKS_DIRNAME, packId)
    if (pack === undefined) {
      return { dir, error: `扩展包 "${packId}" 不在 registry 中` }
    }
    const manifestPath = join(dir, 'extension.json')
    if (!existsSync(manifestPath)) {
      return { pack, dir }
    }
    try {
      const raw = readFileSync(manifestPath, 'utf8')
      const manifest: unknown = JSON.parse(raw)
      return { pack, dir, manifest }
    } catch (error) {
      // manifest 坏了不抛——详情页展示 error 让用户知道，但不阻塞 registry 数据。
      const msg = error instanceof Error ? error.message : String(error)
      return { pack, dir, error: `extension.json 解析失败：${msg}` }
    }
  }

  /**
   * 全量归属映射：kind → name → packId（六个 kind 键都在）。
   *
   * 见 P5 设计 §4.3：四个资源页 mount 时调一次 `ownership()` 本地 join，
   * 标注「来自 XX 扩展包」、禁用卸载按钮。bulk 调用避免逐资源发 RPC。
   */
  @Remote('ownership')
  ownership(): ReturnType<typeof ownershipMap> {
    return ownershipMap(this.home)
  }

  // ── 本地安装 RPC（P5c）────────────────────────────────────────────

  /**
   * 端到端安装本地扩展包（P5c）。
   *
   * 见 P5 设计文档 §3「开发者导入流程」与 §6.1 的 `installLocal` RPC。
   * 内部调 `installLocalExtensionPack` 串起 scan → skills/mcp/presets →
   * 插件包（pnpm add via installPlugin 注入）→ entries.json → registry.json，
   * 成功后触发一次热应用让 host 插件立即生效。
   *
   * 热应用失败不 crash：把 error 放进返回的 warnings，让 UI 告诉用户
   * 「已装但需重启」而不是整个安装回滚（文件已落盘，回滚无意义）。
   *
   * @param sourcePath - 目录或 .zip；与 conflict 都是 RPC args 的平铺字段。
   * @returns 成功返回 `InstallLocalPackResult`；失败返回 `{ ok: false, error }`。
   */
  @Remote('installLocal')
  async installLocal(
    sourcePath: string,
    conflict?: import('@corum/corum-extension-pack').ExtensionInstallConflict,
  ): Promise<InstallLocalPackResult | { ok: false; error: string }> {
    // Typert 网关把每个形参映射成 args 的平铺字段；不能用 input 对象包一层。
    try {
      // exactOptionalPropertyTypes 下条件展开可选字段：undefined 不能直接赋给可选属性。
      // 用条件构造对象而非赋值——避免 readonly + exactOptionalPropertyTypes 冲突。
      const result = await installLocalExtensionPack(
        this.installPlugin !== undefined
          ? {
            sourceDir: sourcePath,
            home: this.home,
            ...(conflict !== undefined ? { conflict: conflict } : {}),
            // P5c：把 pluginManager.install(spec) 适配成 installLocal 的回调签名。
            // 回调收到已解析 spec 的 decl（file:<永久路径> 或 registry spec），调 install(spec)。
            installPlugin: (decl: ExtensionPluginDecl) => this.installPlugin!(decl.spec),
          }
          : {
            sourceDir: sourcePath,
            home: this.home,
            ...(conflict !== undefined ? { conflict: conflict } : {}),
          },
      )

      // 成功后触发热应用：让 host 插件立即挂进活着的 Loader（P3b）。
      // 热应用失败不 crash——文件已落盘（entries.json + registry.json），
      // 回滚无意义；把 error 放进 warnings 让 UI 引导用户手动重启。
      if (this.hotApply !== undefined) {
        try {
          const applyResult = await this.hotApply.apply()
          process.stderr.write(
            `[corum-desktop] extension-manager installLocal: hot-apply ${applyResult.rows} 行\n`,
          )
        } catch (applyError) {
          const applyMsg = applyError instanceof Error ? applyError.message : String(applyError)
          process.stderr.write(
            `[corum-desktop] extension-manager installLocal: 热应用失败（需重启）：${applyMsg}\n`,
          )
          // 热应用失败：仍返回成功结果，但追加一条 warning。
          return {
            ...result,
            warnings: [...result.warnings, `热应用失败（需重启）：${applyMsg}`],
          }
        }
      }
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, error: msg }
    }
  }

  // ── 卸载 RPC（P4）────────────────────────────────────────────────────

  /**
   * 端到端卸载一个扩展包（P4）。
   *
   * 见 EXTENSION-PACK-PLAN.md §9（卸载分档）与 P5-EXTENSION-CENTER-DESIGN.md §5.4。
   *
   * 内部调 `uninstallExtensionPack`：读 registry → planUninstall → 删 entries.json
   * → 逐项删除（skills/mcp/plugins）→ 删 pack 目录 → 删 registry 记录。
   *
   * 插件卸载走注入的 `uninstallPlugin` 回调（= pluginManager.removePackPlugin），
   * **绕过 PACK_OWNED 守卫**——整包卸载时归属检查是多余的（registry 记录同时被删）。
   *
   * 卸载后触发一次热应用让 Loader 摘掉本包的插件行（与 installLocal 对称）。
   * 热应用失败不 crash——文件已清理，把 error 放进 warnings 让 UI 引导重启。
   *
   * ⚠️ Typert 网关要求形参是**扁平的唯一标识符**（不能解构/默认/rest），
   * 故参数是 `packId: string` 而非 `input: { packId }`。
   *
   * @param packId - 要卸载的扩展包 id。
   * @returns `UninstallPackResult` 或 `{ ok:false, error }`。
   */
  @Remote('uninstall')
  async uninstall(packId: string): Promise<UninstallPackResult | { ok: false; error: string }> {
    try {
      const record = readRegistry(this.home).packs[packId]
      const presetFacts = (name: string): { modified: boolean } => {
        try {
          const mtime = statSync(join(this.home, '.agent-presets', name, 'agent.json')).mtimeMs
          const installedAt = record !== undefined ? Date.parse(record.installedAt) : 0
          return { modified: mtime > installedAt + 60_000 }
        } catch {
          return { modified: false }
        }
      }
      const result = await uninstallExtensionPack(
        this.uninstallPlugin !== undefined
          ? {
            packId,
            home: this.home,
            uninstallPlugin: (name: string, _entryId: string) => this.uninstallPlugin!(name),
            presetFacts,
          }
          : {
            packId,
            home: this.home,
            presetFacts,
          },
      )

      // 卸载后触发热应用：让 Loader 摘掉本包的插件行（与 installLocal 对称）。
      // 热应用失败不 crash——文件已清理，把 error 放进 warnings。
      if (result.ok && this.hotApply !== undefined) {
        try {
          const applyResult = await this.hotApply.apply()
          process.stderr.write(
            `[corum-desktop] extension-manager uninstall: hot-apply ${applyResult.rows} 行\n`,
          )
        } catch (applyError) {
          const applyMsg = applyError instanceof Error ? applyError.message : String(applyError)
          process.stderr.write(
            `[corum-desktop] extension-manager uninstall: 热应用失败（需重启）：${applyMsg}\n`,
          )
          return {
            ...result,
            warnings: [...result.warnings, `热应用失败（需重启）：${applyMsg}`],
            restartRequired: true,
          }
        }
      }
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, error: msg }
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
