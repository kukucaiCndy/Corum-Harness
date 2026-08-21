/**
 * corum-shell/plugin-manager — 桌面插件中心 Host 半（Typert Remote）。
 *
 * 仿官方 PluginInventoryGateway（dsh/packages/host/plugin-inventory）的 SRC
 * 模式：TypertRemoteService + @Remote 装饰器，api-gateway 的 SRC 发现自动
 * 把 `pluginManager/*` 端点挂进 /api 拦截器（与 pluginInventory 同理，桌面
 * IPC 传输无需任何额外路由）。
 *
 * 方法面：
 *   list()                              全部非 group 条目（含 hasUi 判定）
 *   setEnabled(entryId, enabled)        loader entry.update({disabled}) 热启停
 *                                       + 禁用清单持久化（boot 时作 patch 层叠加）
 *   install(spec) / update(spec)        pnpm add/update（cwd=profile 目录）+ reconcile
 *   uninstall(entryId)                  pnpm remove + reconcile + 清禁用记录 + 停 fiber
 *   search(query)                       npm registry 搜索插件候选
 *
 * 安装/更新/卸载这一期不做免重启热载：包元数据缓存永不过期、组合在 boot 时
 * 定死，所以返回 restartRequired 提示，由 UI 引导重启（restartHost bridge）。
 * @module corum-shell/plugin-manager
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'
import { resolveDesktopHome } from './home.ts'

/** 禁用清单文件名（$CORUM_HOME/plugins.disabled.json），boot 时作 patch 层叠加。 */
export const DISABLED_FILENAME = 'plugins.disabled.json'

/** 一个非 group Loader 条目对插件中心的投影。 */
export interface PluginManagerEntry {
  readonly entryId: string
  /** Loader 条目 import 的模块名（包名）。 */
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  /** 包是否声明 dsh.client（有浏览器半 = 有 UI 的插件）。 */
  readonly hasUi: boolean
  /** 包版本（读 package.json；读不到为 undefined）。 */
  readonly version?: string
  /** 包描述（package.json description；读不到为 undefined）。 */
  readonly description?: string
  /** 包分类：`plugin`（用户可插拔的功能插件）/ `runtime`（cordis/dsh 运行时基元）。 */
  readonly kind: 'plugin' | 'runtime'
}

/** 详情页投影：包元数据 + 运行态 + 来源。 */
export interface PluginDetail {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginManagerEntry['fiberPhase']
  readonly hasUi: boolean
  readonly kind: 'plugin' | 'runtime'
  readonly version?: string
  readonly description?: string
  /** 发布者/作者（package.json author/publisher/maintainers 的第一个名字）。 */
  readonly publisher?: string
  /** 主页 / 仓库链接。 */
  readonly homepage?: string
  readonly repository?: string
  /** 来源：`official`（@deepseek-ai 官方）/ `corum`（本项目 workspace）/ `third-party`。 */
  readonly origin: 'official' | 'corum' | 'third-party'
  /** 安装来源描述（workspace 链接 / npm registry 版本范围 / file 路径）。 */
  readonly installedFrom?: string
  readonly license?: string
  /** 包的关键字标签。 */
  readonly keywords?: readonly string[]
}

/** 安装/更新/卸载的结果：这一期装后一律提示重启。 */
export interface PluginManagerMutationResult {
  readonly ok: boolean
  readonly restartRequired: boolean
  /** 失败时的 pnpm/校验输出摘要。 */
  readonly log?: string
}

/** npm registry 检索出的一条插件候选。 */
export interface PluginSearchResult {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly installed: boolean
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const

/** npm registry 搜索响应里我们关心的最小形状。 */
interface NpmSearchResponse {
  objects?: Array<{
    package?: { name?: string; version?: string; description?: string }
  }>
}

/**
 * 桌面插件管理 Remote：直接读/写 Loader 活树，启停持久化走禁用清单文件
 * （boot.ts 每次启动重写根 cordis.yml，树写回不可用——持久层因此是独立的
 * overlay patch 行 {id, disabled:true}，见 boot.ts 的注入点）。
 */
export class CorumPluginManager extends TypertRemoteService {
  // 不走 fiber 的 static inject：本服务由 boot 回调在根 ctx 直 new（非 fiber
  // 挂载），`this.ctx.loader` 的 fiber 注入校验会抛 "cannot get property
  // 'loader' without inject"。改为延迟直读 ctx.get('loader')（根 ctx 可及）。

  /** hasUi 判定的包解析锚（config-tree 根，与 modules.ts 同一锚点）。 */
  private readonly resolvePkgJson: ((spec: string) => string) | undefined

  constructor(ctx: Context) {
    super(ctx, 'pluginManager')
    this.resolvePkgJson = ctx.baseUrl === undefined
      ? undefined
      : createRequire(ctx.baseUrl).resolve
  }

  /** 延迟直读 Loader 服务（绕过 fiber inject 校验；见上注）。 */
  private loader(): Loader {
    const loader = this.ctx.get('loader') as Loader | undefined
    if (loader === undefined) throw new Error('pluginManager: loader service unavailable')
    return loader
  }

  /** 当前全部非 group 条目（每次调用直读 Loader，不做二级缓存）。 */
  @Remote('list')
  list(): { entries: PluginManagerEntry[]; dshVersion?: string } {
    const entries: PluginManagerEntry[] = []
    for (const entry of this.loader().entries()) {
      if (entry.options.group) continue
      const name = entry.options.name
      const ui = this.hasUi(name)
      const pkg = this.readPackageJson(name)
      entries.push({
        entryId: entry.id,
        moduleName: name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
        hasUi: ui,
        ...(typeof pkg?.version === 'string' ? { version: pkg.version } : {}),
        ...(typeof pkg?.description === 'string' ? { description: pkg.description } : {}),
        kind: this.kindOf(name, ui),
      })
    }
    const dshVersion = this.readPackageJson('@deepseek-ai/dsh-base')?.version
    return { entries, ...(typeof dshVersion === 'string' ? { dshVersion } : {}) }
  }

  /** 单个插件的详情（元数据 + 来源 + 运行态），详情页数据源。 */
  @Remote('detail')
  detail(entryId: string): { detail: PluginDetail } {
    const entry = this.loader().resolve(entryId)
    const name = entry.options.name
    const ui = this.hasUi(name)
    const pkg = this.readPackageJson(name)
    const detail: PluginDetail = {
      entryId: entry.id,
      moduleName: name,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      hasUi: ui,
      kind: this.kindOf(name, ui),
      origin: this.originOf(name),
      ...(typeof pkg?.version === 'string' ? { version: pkg.version } : {}),
      ...(typeof pkg?.description === 'string' ? { description: pkg.description } : {}),
      ...(typeof pkg?.homepage === 'string' ? { homepage: pkg.homepage } : {}),
      ...(typeof pkg?.license === 'string' ? { license: pkg.license } : {}),
      ...(pkg !== undefined ? ((): { publisher?: string; repository?: string } => {
        const publisher = this.publisherOf(pkg)
        const repository = this.repositoryOf(pkg)
        return {
          ...(publisher !== undefined ? { publisher } : {}),
          ...(repository !== undefined ? { repository } : {}),
        }
      })() : {}),
      ...(Array.isArray(pkg?.keywords) ? { keywords: (pkg.keywords as unknown[]).filter((k): k is string => typeof k === 'string') } : {}),
    }
    return { detail }
  }

  /**
   * 启停一个条目：entry.update({disabled}) 带持久化与回滚（loader 内建），
   * 再写禁用清单文件让状态跨重启保留。
   */
  @Remote('setEnabled')
  async setEnabled(entryId: string, enabled: boolean): Promise<{ ok: boolean }> {
    const entry = this.loader().resolve(entryId)
    await entry.update(enabled ? { disabled: null } : { disabled: true })
    this.persistDisabled(entryId, !enabled)
    return { ok: true }
  }

  /**
   * 安装一个插件包：pnpm add（cwd=profile 目录，参照 dsh apps/cli plugin.ts）
   * + dsh.profile.bundles reconcile。装后需重启 host 进程才进组合。
   */
  @Remote('install')
  async install(spec: string): Promise<PluginManagerMutationResult> {
    return this.runPnpm(['add', spec])
  }

  /**
   * 卸载：按 entryId 定位包名，pnpm remove + reconcile；清掉该条目的禁用
   * 记录，并停掉活 fiber（组合里的条目行是静态 patch 行，运行时摘除）。
   */
  @Remote('uninstall')
  async uninstall(entryId: string): Promise<PluginManagerMutationResult> {
    const entry = this.loader().resolve(entryId)
    const packageName = entry.options.name
    const result = await this.runPnpm(['remove', packageName])
    if (!result.ok) return result
    this.persistDisabled(entryId, false)
    if (entry.fiber !== undefined) {
      try {
        await entry.update({ disabled: true })
      } catch (error) {
        this.ctx.logger.warn('plugin-manager: failed to stop uninstalled entry fiber', error)
      }
    }
    return result
  }

  /** 更新一个插件包：pnpm update（+ reconcile），重启后生效。 */
  @Remote('update')
  async update(spec: string): Promise<PluginManagerMutationResult> {
    return this.runPnpm(['update', spec])
  }

  /** 检索 npm registry 的插件候选，标注已安装状态。 */
  @Remote('search')
  async search(query: string): Promise<{ results: PluginSearchResult[] }> {
    const trimmed = query.trim()
    if (trimmed === '') return { results: [] }
    const url = `https://registry.npmjs.org/-/v1/search?size=20&text=${encodeURIComponent(trimmed)}`
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`npm registry search failed: HTTP ${response.status}`)
    const body = await response.json() as NpmSearchResponse
    const installed = new Set<string>()
    for (const entry of this.loader().entries()) installed.add(entry.options.name)
    const results: PluginSearchResult[] = []
    for (const object of body.objects ?? []) {
      const pkg = object.package
      if (pkg?.name === undefined || pkg.version === undefined) continue
      results.push({
        name: pkg.name,
        version: pkg.version,
        ...(pkg.description !== undefined ? { description: pkg.description } : {}),
        installed: installed.has(pkg.name),
      })
    }
    return { results }
  }

  /** 包是否声明 dsh.client（= 有 UI）。判定同 modules.ts 的 dsh.client 扫描。 */
  private hasUi(packageName: string): boolean {
    const pkg = this.readPackageJson(packageName)
    if (pkg === undefined) return false
    const dsh = pkg.dsh
    return dsh !== null && typeof dsh === 'object'
      && (dsh as Record<string, unknown>).client !== undefined
  }

  /** 读包的 package.json（解析不到返回 undefined）。结果缓存（包内容运行期不变）。 */
  private pkgCache = new Map<string, Record<string, unknown> | undefined>()
  private readPackageJson(packageName: string): Record<string, unknown> | undefined {
    if (this.pkgCache.has(packageName)) return this.pkgCache.get(packageName)
    let pkg: Record<string, unknown> | undefined
    if (this.resolvePkgJson !== undefined) {
      try {
        pkg = JSON.parse(readFileSync(this.resolvePkgJson(`${packageName}/package.json`), 'utf8')) as Record<string, unknown>
      } catch {
        pkg = undefined
      }
    }
    this.pkgCache.set(packageName, pkg)
    return pkg
  }

  /** 包分类：cordis/dsh 运行时基元 vs 面向用户的功能插件（区域/功能面）。 */
  private kindOf(moduleName: string, hasUi: boolean): 'plugin' | 'runtime' {
    // corum-shell 自身及其 modules/connection 是壳运行时（非可插拔插件）。
    if (moduleName === 'corum-shell' || moduleName.startsWith('corum-shell/')) return 'runtime'
    // @corum/* 功能插件（ide-* / session-archive / ui-*-models/selection）。
    if (moduleName.startsWith('@corum/')) return 'plugin'
    // dsh-client-*/dsh-api-*/cordis-*/typert 等是运行时基元（模块加载/连接/
    // 主题/区域槽/RPC 注册机制），由壳拥有，非用户可插拔——即便有 client 半
    // 也算 runtime。session-log-export 是被桌面 session-archive 替换的旧下载面。
    if (/^(cordis|@deepseek-ai\/(dsh-client-|dsh-api-|dsh-cordis-|dsh-typert-|dsh-session-log-export))/.test(moduleName)) return 'runtime'
    // 其余 dsh host 工具/能力插件（dsh-tool-*/dsh-goal 等）：有 client 半的
    // 视为用户可感知的功能插件，无 client 半的纯 host 能力是运行时。
    return hasUi ? 'plugin' : 'runtime'
  }

  /** 来源判定：@deepseek-ai 官方 / @corum 本项目 / 其余第三方。 */
  private originOf(moduleName: string): PluginDetail['origin'] {
    if (moduleName.startsWith('@corum/') || moduleName.startsWith('corum-shell')) return 'corum'
    if (moduleName.startsWith('@deepseek-ai/') || moduleName.startsWith('cordis')) return 'official'
    return 'third-party'
  }

  /** 发布者名（author/publisher/maintainers 第一个可用名）。 */
  private publisherOf(pkg: Record<string, unknown>): string | undefined {
    const name = (v: unknown): string | undefined =>
      typeof v === 'string' ? v
        : v !== null && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string'
          ? (v as { name: string }).name
          : undefined
    const author = name(pkg.author)
    if (author !== undefined) return author
    const publisher = name(pkg.publisher)
    if (publisher !== undefined) return publisher
    const maintainers = pkg.maintainers
    if (Array.isArray(maintainers)) {
      for (const m of maintainers) { const n = name(m); if (n !== undefined) return n }
    }
    return undefined
  }

  /** 仓库 URL（repository 可是 string 或 {url}）。 */
  private repositoryOf(pkg: Record<string, unknown>): string | undefined {
    const repo = pkg.repository
    if (typeof repo === 'string') return repo
    if (repo !== null && typeof repo === 'object' && typeof (repo as { url?: unknown }).url === 'string') {
      return (repo as { url: string }).url
    }
    return undefined
  }

  /** 禁用清单文件路径（$CORUM_HOME/plugins.disabled.json）。 */
  private disabledFile(): string {
    return join(resolveDesktopHome(), DISABLED_FILENAME)
  }

  /** 读取禁用清单（缺失/损坏视为空）。 */
  private readDisabled(): string[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.disabledFile(), 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((id): id is string => typeof id === 'string')
    } catch {
      return []
    }
  }

  /** 增删一条禁用记录并落盘（不重复、不存在时移除是 no-op）。 */
  private persistDisabled(entryId: string, disabled: boolean): void {
    const ids = this.readDisabled()
    const at = ids.indexOf(entryId)
    if (disabled && at < 0) ids.push(entryId)
    if (!disabled && at >= 0) ids.splice(at, 1)
    const file = this.disabledFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(ids, null, 2)}\n`)
  }

  /**
   * 在 profile 目录跑一次 pnpm 子命令（安装/更新/卸载共用），成功后对
   * dsh.profile.bundles 做 reconcile（声明 dsh.bundle 的依赖加入层栈）。
   * 参照 dsh apps/cli/src/plugin.ts 的 runPlugin + reconcilePlugins。
   */
  private async runPnpm(args: string[]): Promise<PluginManagerMutationResult> {
    const dir = join(resolveDesktopHome(), PROFILES_DIR, process.env.CORUM_DESKTOP_PROFILE ?? 'web')
    if (!existsSync(join(dir, 'package.json'))) {
      return { ok: false, restartRequired: false, log: `profile directory missing: ${dir}` }
    }
    const beforeDeps = new Set(Object.keys(this.readProfileDeps(dir)))
    const ran = await this.spawnPnpm(dir, args)
    if (!ran.ok) return { ok: false, restartRequired: false, log: ran.log }
    this.reconcilePlugins(dir, beforeDeps)
    return { ok: true, restartRequired: true }
  }

  /** 读 profile manifest 的 dependencies 键集（reconcile 的 before 快照）。 */
  private readProfileDeps(profileDir: string): Record<string, string> {
    try {
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
      const deps = manifest.dependencies
      return deps !== null && typeof deps === 'object' ? deps as Record<string, string> : {}
    } catch {
      return {}
    }
  }

  /** 一个依赖是否声明 dsh.bundle（= 是 profile 层插件），解析锚为 profile 目录。 */
  private exportsPatch(packageName: string, profileDir: string): boolean {
    try {
      const require = createRequire(join(profileDir, 'package.json'))
      const pkgPath = require.resolve(`${packageName}/package.json`)
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
      const dsh = pkg.dsh
      return dsh !== null && typeof dsh === 'object'
        && (dsh as Record<string, unknown>).bundle !== undefined
    } catch {
      return false
    }
  }

  /**
   * reconcile dsh.profile.bundles：pnpm 已写真安装名，声明 dsh.bundle 的依赖
   * 加入层栈（依赖序追加）；不再声明/已移除的依赖离开层栈。模板自带 bundle
   * （非依赖）从不动。逐行参照 dsh apps/cli plugin.ts 的 reconcilePlugins。
   */
  private reconcilePlugins(profileDir: string, beforeDeps: ReadonlySet<string>): void {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } } & Record<string, unknown>
    } & Record<string, unknown>
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const dsh = (manifest.dsh ?? {}) as { profile?: { bundles?: string[] } } & Record<string, unknown>
    const profile = (dsh.profile ?? {}) as { bundles?: string[] } & Record<string, unknown>
    const bundles = profile.bundles ?? []
    let changed = false
    for (const packageName of dependencies) {
      if (this.exportsPatch(packageName, profileDir) && !bundles.includes(packageName)) {
        bundles.push(packageName)
        changed = true
      }
    }
    const dependencySet = new Set(dependencies)
    for (const packageName of [...bundles]) {
      const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
      const stillBundle = dependencySet.has(packageName) && this.exportsPatch(packageName, profileDir)
      if (wasDependency && !stillBundle) {
        bundles.splice(bundles.indexOf(packageName), 1)
        changed = true
      }
    }
    if (!changed) return
    manifest.dsh = { ...dsh, profile: { ...profile, bundles } }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  /** 异步跑 pnpm，收集输出（stdio 不能 inherit——bridge 的 stdout 是 JSON 协议线）。 */
  private spawnPnpm(cwd: string, args: string[]): Promise<{ ok: boolean; log: string }> {
    return new Promise((resolvePromise) => {
      // Windows resolves pnpm through its .cmd shim, which spawn() refuses
      // without a shell since the CVE-2024-27980 hardening.
      const child = spawn('pnpm', args, { cwd, shell: process.platform === 'win32' })
      let log = ''
      child.stdout.on('data', (chunk: Buffer) => { log += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString() })
      child.on('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code
        resolvePromise({
          ok: false,
          log: code === 'ENOENT' ? 'pnpm not found on PATH — install pnpm to manage profile plugins' : String(error),
        })
      })
      child.on('close', (status) => {
        resolvePromise({ ok: status === 0, log: log.slice(-4000) })
      })
    })
  }
}

export default CorumPluginManager
