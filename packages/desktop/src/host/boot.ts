/**
 * Desktop profile composition: boots an existing dsh profile (`web` by
 * default, override with `CORUM_DESKTOP_PROFILE`) with the desktop transport
 * overlay applied as the highest patch layer. Layer order mirrors the dsh
 * CLI: bundle layers, the profile's own cordis.patch.yml, the home-level
 * patch, the desktop overlay, then the telemetry switch.
 * @module corum-desktop/host/boot
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  composeEntries,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILES_DIR,
} from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'

const NAME = 'corum-desktop'

export { resolveDesktopHome } from './home.ts'
import { resolveDesktopHome } from './home.ts'
import { composeDesktopOverlays, pickOverrideRows } from './desktop-overlays.ts'
export { composeDesktopOverlays, pickOverrideRows } from './desktop-overlays.ts'
export type { ComboOverlayPatches, ComposedDesktopOverlays, DesktopOverlayLayers } from './desktop-overlays.ts'
import { publishRuntimeBundle } from './runtime-bundle.ts'
export { publishRuntimeBundle, extractInsertBlocks, RUNTIME_BUNDLE_NAME } from './runtime-bundle.ts'
export type { RuntimeBundleResult, RuntimeInsertRow } from './runtime-bundle.ts'
import { migrateKvStoreAtBoot } from '@corum/corum-agent'
import { loadExtensionEntries, extensionPatches } from '@corum/corum-extension-pack'
import { CorumPluginManager, DISABLED_FILENAME, isCorePluginEntry } from './plugin-manager.ts'
import { CorumExtensionManager } from './extension-manager.ts'
import { CorumFsService } from './corum-fs.ts'
import { CorumTerminalService } from './corum-terminal.ts'
import { CorumGitService } from './corum-git.ts'
import { CorumReviewService } from './corum-review.ts'
import {
  loadProfileWithSkip,
  writeBootDiagnostics,
  clearBootDiagnostics,
  SUPPORTED_PLUGIN_APIS,
  BOOT_DIAGNOSTICS_FILENAME,
} from './profile-precheck.ts'

export { BOOT_DIAGNOSTICS_FILENAME }

/**
 * Resolve the desktop UI mode. The shell injects `CORUM_DESKTOP_MODE` per
 * combo (combo.env, see src/electron/combos.ts) before spawning the host child,
 * so this process sees a single source. A malformed value is not a boot error —
 * it falls back to the default rather than stranding a launch.
 * @returns `ide` when the injected variable is `ide`, otherwise `minimal`.
 */
export function resolveDesktopMode(): DesktopMode {
  const value = process.env[DESKTOP_MODE_ENV]
  if (value === 'ide') return 'ide'
  return 'minimal'
}

// Relative anchors are written for the SHIPPED artifact (lib/bridge.js, one
// level under the package root); tsdown flattens each entry into
// lib/, so the source depth (src/host/) and the built depth (lib/)
// differ and the built location is the one that runs.
//
// ⚠️ 所以不能用 `new URL('../x', import.meta.url)`：`tsc` 的产物在
// `lib/types/host/boot.js`（比 tsdown 的 `lib/` 深两级），同一个相对量在两条
// 产物路径上指向不同地方；`lib/types/host/..` 下既没有 package.json 也没有
// patch 文件 ⇒ 以 tsc 产物为入口的进程（单测/诊断脚本）在解析 bundle 时就炸。
// 改成「从本模块目录向上找到本包 package.json」——src/ 与两种 lib 布局都落到
// 同一个包根，且错位会 fail loud 而不是静默指向错误目录。
/** 本包的 package.json 里的 name（向上查找的判据）。 */
const PACKAGE_NAME = 'corum-desktop'

/**
 * 从本模块所在目录向上找到本包根目录（含 `name === 'corum-desktop'` 的
 * package.json 的目录）。
 * @returns 包根绝对路径。
 * @throws 向上 8 层仍找不到本包 manifest 时（产物布局被改坏）。
 */
function resolvePackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name === PACKAGE_NAME) return dir
      } catch {
        // 坏 JSON 不是本包（本包 manifest 一定可解析），继续向上。
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`[corum-desktop] 无法从 ${fileURLToPath(import.meta.url)} 向上定位 ${PACKAGE_NAME} 的 package.json`)
}

/** 本包根目录（patch 文件与 manifest 的锚点）。 */
const PACKAGE_ROOT = resolvePackageRoot()

/** Absolute path of this package's manifest. */
export const INSTALL_ANCHOR = join(PACKAGE_ROOT, 'package.json')

/** The desktop transport overlay applied above every other patch layer. */
const DESKTOP_PATCH = join(PACKAGE_ROOT, 'cordis.patch.yml')

/** The IDE-mode overlay: applied only when the desktop mode resolves to `ide`. */
const IDE_PATCH = join(PACKAGE_ROOT, 'cordis.ide.patch.yml')

/**
 * The corum preset overlay: overrides the four official preset declarations'
 * `config.plugins` with corum delegation (three @corum/corum-tool-subagent
 * instances + corum providers) and inserts the corum-only `conductor` preset.
 * Applied as a patch layer above the bundle patches (which already contain the
 * official standard/ptc/minimal/cordis declarations from dsh-web-app's bundle).
 */
const PRESETS_PATCH = join(PACKAGE_ROOT, 'presets.patch.yml')

/** The environment variable the shell injects per combo to select the desktop mode. */
const DESKTOP_MODE_ENV = 'CORUM_DESKTOP_MODE'

/**
 * Combo 启动注入参数（壳层按所选 combo 设置，见 src/electron/combos.ts）：
 * - CORUM_COMBO_PLUGINS：逗号分隔的插件包名，作为 insert 行加入 composition
 *   （废弃的运行时 comboLoad 的启动时等价物——combo 的插件集在进程启动时定死）。
 * - CORUM_COMBO_PATCHES：逗号分隔的 patch 文件绝对路径，作为最高 patch 层叠加
 *   （combo 的覆盖规则）。
 */
const COMBO_PLUGINS_ENV = 'CORUM_COMBO_PLUGINS'
const COMBO_PATCHES_ENV = 'CORUM_COMBO_PATCHES'

/**
 * 解析壳层注入的 combo 覆盖规则（无 combo 注入时为空）。
 *
 * `files` 与 `patches` 是同一批 combo 规则文件：`patches` 是解析后的行（覆盖行
 * 留在 overlay 层），`files` 供运行期 bundle 抽取其中的 insert 块（行定义必须
 * 在 profile patch 之前建行，见 runtime-bundle.ts 头注释）。
 */
function resolveComboOverlays(): { rows: PatchOptions[]; patches: PatchOptions[]; files: string[] } {
  const pluginsRaw = process.env[COMBO_PLUGINS_ENV]
  const pluginNames = pluginsRaw === undefined || pluginsRaw.trim() === ''
    ? []
    : pluginsRaw.split(',').map(s => s.trim()).filter(s => s !== '')
  const rows: PatchOptions[] = pluginNames.length > 0
    ? [{ insert: pluginNames.map(name => ({ id: name, name })) }]
    : []
  const patchesRaw = process.env[COMBO_PATCHES_ENV]
  const files = patchesRaw === undefined || patchesRaw.trim() === ''
    ? []
    : patchesRaw.split(',').map(s => s.trim()).filter(s => s !== '')
  const patches = files.flatMap(f => loadOverlayPatches(NAME, f))
  return { rows, patches, files }
}

/** Desktop UI mode: `minimal` keeps the official three-column chat shell. */
export type DesktopMode = 'minimal' | 'ide'

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** 宿主应用版本（从安装锚点的 package.json 读，不手填）。 */
let cachedDesktopVersion: string | undefined
function desktopVersion(): string {
  if (cachedDesktopVersion === undefined) {
    try {
      cachedDesktopVersion = String((JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8')) as { version?: string }).version ?? '0.0.0')
    } catch {
      cachedDesktopVersion = '0.0.0'
    }
  }
  return cachedDesktopVersion
}

/** Root config filename inside a profile directory. */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** The profile this desktop shell boots; a custom installation overrides via env. */
function profileName(): string {
  return process.env.CORUM_DESKTOP_PROFILE ?? 'web'
}

/**
 * Resolve a package's root directory from an anchor WITHOUT depending on the
 * package exporting `./package.json`. This mirrors `dsh-app-boot`'s internal
 * `packageDirFromAnchor`, except it REALPATHS the anchor first.
 *
 * Why that matters: the official implementation calls
 * `createRequire(anchor).resolve.paths(packageName)`, and Node computes those
 * search paths from the anchor's LITERAL path — a symlink is NOT realpath-ed.
 * That is exactly right for the official monorepo (its `workspace:*` deps are
 * real directories), but it breaks the registry layout this distribution pins:
 * here `@deepseek-ai/dsh-base` under `packages/desktop/node_modules` is a
 * symlink into `node_modules/.pnpm/@deepseek-ai+dsh-base@.../`, and its own
 * dependencies (`dsh-agent`, `dsh-llm`, ...) resolve only through the SIBLING
 * symlinks inside `.pnpm` — which `resolve.paths` never lists when the anchor
 * stays on the symlink path. Realpath-ing the anchor restores Node's real
 * lookup order (`.../dsh-base/node_modules` → `.../@deepseek-ai/node_modules`
 * → `.pnpm/@deepseek-ai+dsh-base@.../node_modules` → `.pnpm/node_modules`),
 * where the isolated layout keeps every transitive dependency.
 */
function packageDirFromRealAnchor(anchor: string, packageName: string): string | undefined {
  const real = realpathSync(anchor)
  for (const searchPath of createRequire(real).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** Ensure `link` is a symlink to `target` (mirror of dsh's ensureSymlink). */
function ensureSymlink(link: string, target: string): void {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) throw new Error(`corum-desktop: ${link} exists and is not a symlink; remove it so the shell can manage the installation fallback`)
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  }
  try {
    symlinkSync(target, link, 'junction')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error
  }
}

/**
 * Registry-layout replacement for `healProfilesModuleFallback`: same contract
 * (maintain `$DSH_HOME/profiles/node_modules` with one symlink per package in
 * the installation's dependency closure), but resolves each dependency from a
 * REALPATH-ed anchor so the isolated `.pnpm` layout's sibling symlinks are
 * visible. Called INSTEAD of the official function; the official one cannot
 * see registry transitive deps from a symlinked anchor.
 */
function healProfilesModuleFallbackRegistry(installAnchor: string): void {
  const home = resolveDshHome()
  const modulesDir = join(join(home, PROFILES_DIR), 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const appManifest = JSON.parse(readFileSync(installAnchor, 'utf8'))
  const links = new Map<string, string>()
  if (appManifest.name !== undefined) links.set(appManifest.name, dirname(realpathSync(installAnchor)))
  const queue = [{ anchor: installAnchor, manifest: appManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const dep of [...Object.keys(next.manifest.dependencies ?? {}), ...Object.keys(next.manifest.peerDependencies ?? {})]) {
      if (links.has(dep)) continue
      const dir = packageDirFromRealAnchor(next.anchor, dep)
      if (dir === undefined) continue
      links.set(dep, dir)
      queue.push({
        anchor: join(dir, 'package.json'),
        manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
      })
    }
  }
  for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName)
    mkdirSync(dirname(link), { recursive: true })
    ensureSymlink(link, target)
  }
}

/** Resolve the telemetry opt-out switch into its boot patch (ANY non-empty value disables). */
function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * 插件中心的启停持久层：corum 每次启动重写根 cordis.yml、不做树写回，
 * 所以 entry.update 的持久化在重启后丢失。启停状态因此单独落在一个清单
 * 文件（$CORUM_HOME/plugins.disabled.json，由 pluginManager.setEnabled 维护），
 * boot 时把每条禁用记录折成一个 patch 行 {id, disabled:true} 作为最高层
 * 叠加——与 modeOverlays/comboOverlays 同一注入方式。
 */
function loadDisabledPatches(): PatchOptions[] {
  try {
    const file = join(resolveDesktopHome(), DISABLED_FILENAME)
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((id): id is string => typeof id === 'string' && id !== '')
      // corum 基础能力插件不可关闭：过滤清单中的残留记录（可能来自锁定
      // 机制生效前的手动停用），保证它们永远参与组合。
      .filter(id => !isCorePluginEntry(id))
      .map(id => ({ id, disabled: true }))
  } catch {
    return [] // 缺失/损坏 = 无禁用记录
  }
}

/**
 * 扩展包插件 insert 行持久层（P3a）。
 *
 * 扫描 <CORUM_HOME>/extension-packs/ 下的 entries.json，折成至多一条
 * `{ insert: rows }` patch，叠进 boot 层栈。见
 * corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2。
 *
 * 位置：comboOverlays.rows 之后、disabledPatches 之前（section 5.2.1）。
 * 与 loadDisabledPatches 不同，这里不 catch——entries.json 坏掉必须
 * fail loud（section 5.2.1.1）：脏数据让 boot 直接失败比静默丢失插件行
 * 更可诊断（loadDisabledPatches 静默返回空是它的历史包袱，
 * 扩展包这份故意不照抄）。
 */
function loadExtensionPatches(home: string): PatchOptions[] {
  const dir = join(home, 'extension-packs')
  try {
    const files = loadExtensionEntries(home)
    return extensionPatches(files)
  } catch (error) {
    // 包一层 banner：命名目录，让损坏的 entries.json 可诊断；保留 stack/reason。
    const reason = error instanceof Error ? error.stack ?? error.message : String(error)
    throw new Error(`[corum-desktop] 扩展包插件清单加载失败（目录 ${dir}）：\n${reason}`)
  }
}

/**
 * Boot the desktop surface: resolve the profile, stack its patch layers plus
 * the desktop overlay, mount the tree, and return the settled context.
 * @returns the settled root context with the desktop transport services.
 */
export async function bootDesktop(): Promise<Context> {
  // 启动分段计时（stderr，定位慢段用；Date.now 精度够用，不引入额外依赖）。
  const bootT0 = Date.now()
  const t = (label: string): void => { process.stderr.write(`[boot-perf] ${label}: +${Date.now() - bootT0}ms\n`) }
  resolveDesktopHome()
  t('resolveDesktopHome')
  const environment = loadLayeredEnv(NAME)
  t('loadLayeredEnv')
  installFailLoud(NAME, process)
  // Registry layout needs a realpath-aware heal (see healProfilesModuleFallbackRegistry);
  // the official healProfilesModuleFallback cannot see transitive deps through
  // the .pnpm isolated-layout symlinks from a symlinked anchor.
  healProfilesModuleFallbackRegistry(INSTALL_ANCHOR)
  t('healProfilesModuleFallbackRegistry')
  // 预检层（方案 §C.2.1）：官方 `loadProfile` 对坏 bundle **fail-hard**，而第三方
  // 插件装错一个包不该让整个应用起不来（实测：host exit 1、renderer 卡在启动页、
  // 零错误提示）。这里先筛：坏 bundle 记进 skipped[] 并从装载列表里剔除，其余照常。
  const loadOptions = (): Parameters<typeof loadProfileWithSkip>[0] => ({
    binName: NAME,
    profileName: profileName(),
    installAnchor: INSTALL_ANCHOR,
    hostVersion: desktopVersion(),
    supportedApis: SUPPORTED_PLUGIN_APIS,
  })
  let loaded = loadProfileWithSkip(loadOptions())
  // 干净启动必须清掉上一次留下的诊断，否则「旧错误」就一直是「当前错误」——
  // 启动页读的是这个文件，留着它就等于永远报同一条。
  if (loaded.skipped.length === 0) clearBootDiagnostics(resolveDshHome())
  if (loaded.skipped.length > 0) {
    // 诊断落盘必须在 boot() 之前：host 若仍死在这里，renderer 也还有东西可读。
    const path = writeBootDiagnostics(resolveDshHome(), {
      generatedAt: new Date().toISOString(),
      hostVersion: desktopVersion(),
      profileName: profileName(),
      supportedApis: SUPPORTED_PLUGIN_APIS,
      skipped: loaded.skipped,
      undeclared: loaded.undeclared,
    })
    process.stderr.write(
      `[corum-desktop] ⚠️ ${loaded.skipped.length} 个 profile bundle 被跳过（不兼容/装坏了），其余照常启动：\n` +
      loaded.skipped.map(item => `    · ${item.packageName} [${item.reason}] ${item.detail}`).join('\n') +
      (path === undefined ? '' : `\n    诊断：${path}`) + '\n',
    )
  }

  // Desktop UI mode: `ide` mounts the IDE-shell overlay (forked layout/theme/
  // workspace rows replacing the official three-column chat shell) as an
  // overlay layer; `minimal` (default) keeps the official surface
  // byte-for-byte.
  const mode = resolveDesktopMode()
  process.stderr.write(`[corum-desktop] desktop mode: ${mode}\n`)
  // Combo 覆盖规则：插件 insert 行与 patches 均作为附加层叠加（见
  // resolveComboOverlays）。combo 的插件集 / 覆盖规则在进程启动时定死，
  // 切换 combo = 壳层按新 combo 起新 host 进程。
  const comboOverlays = resolveComboOverlays()

  // ── 行定义（insert）进**运行期 bundle**，覆盖行（disabled/config）留在 overlay ──
  //
  // 为什么必须分家（rc3 根因，见 runtime-bundle.ts 头注释的两条 composeEntries 事实）：
  //   · insert 行只能出现一层（append 语义、不按 id 去重）；
  //   · 只带 id/config 的覆盖行**无法创建行**，目标行还不存在时会被丢弃。
  // 行定义留在 overlay（= profile patch 之后）会让设置中心写 corum 的任何 ns 都被
  // 官方守卫拒成 `Configuration for "…" is overridden by a home patch or
  // command-line overlay`；清空 profileContext.overlays 又会丢热重组的覆盖层。
  // bundle 层是唯一同时满足「在 profile patch 之前」且「readProfilePatches 同样读得到」
  // 的位置。
  const runtimeBundle = publishRuntimeBundle({
    home: resolveDshHome(),
    profileDir: loaded.profile.dir,
    version: desktopVersion(),
    layers: {
      patchFiles: [
        DESKTOP_PATCH,
        PRESETS_PATCH,
        ...(mode === 'ide' ? [IDE_PATCH] : []),
        ...comboOverlays.files,
      ],
      extraRows: comboOverlays.rows.flatMap(row => row.insert ?? []).flatMap(entry => (
        typeof entry.id === 'string' && typeof entry.name === 'string' ? [{ id: entry.id, name: entry.name }] : []
      )),
    },
  })
  process.stderr.write(`[corum-desktop] runtime bundle: ${runtimeBundle.rows} insert 行 / ${runtimeBundle.blocks} 块 → ${runtimeBundle.bundleDir}${runtimeBundle.changed ? '（已更新）' : ''}\n`)
  // bundle 首次登记（或内容变化）后必须重新装载：profile.layers 才是组合的 bundle 层。
  if (runtimeBundle.changed) loaded = loadProfileWithSkip(loadOptions())
  const profile = loaded.profile
  t('loadProfile')
  // The root is always rewritten: the whole composition is patch layers, and
  // the vendored Loader's tree write-back can bake composed rows into this
  // file — which would duplicate every bundle insert on the next boot.
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)

  const homePatches = loadOptionalPatches(NAME, join(resolveDshHome(), PROFILE_PATCH_FILENAME)) ?? []
  const overlays = loadOverlayPatches(NAME, DESKTOP_PATCH)
  // corum preset overrides: applied above the bundle patches (which already
  // carry the official standard/ptc/minimal/cordis declarations from
  // dsh-web-app's dsh.bundle.patch). This layer overrides those four rows'
  // config.plugins with corum delegation.
  const presetOverlays = loadOverlayPatches(NAME, PRESETS_PATCH)
  const modeOverlays = mode === 'ide' ? loadOverlayPatches(NAME, IDE_PATCH) : []
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  t('loadPatches')

  // 插件中心的禁用清单：折成 patch 行作为最高层叠加（见 loadDisabledPatches）。
  const disabledPatches = loadDisabledPatches()
  // 扩展包插件 insert 行（P3a）：扫描 extension-packs/<packId>/entries.json 折成
  // patch 行。位置在 comboOverlays.rows 之后、disabledPatches 之前（见
  // corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2.1）。
  // fail loud：entries.json 坏掉让 boot 直接失败，不静默跳过（section 5.2.1.1）。
  const extensionPackPatches = loadExtensionPatches(resolveDesktopHome())

  // 覆盖行（disabled / config）——insert 行已在运行期 bundle 里，这里必须剔掉：
  // 同一个 insert 块出现两层会插出两行同 id（append 语义、不去重）。
  const overlayRows = pickOverrideRows(overlays)
  const presetRows = pickOverrideRows(presetOverlays)
  const modeRows = pickOverrideRows(modeOverlays)
  const comboRows = pickOverrideRows(comboOverlays.patches)

  // P3b 热应用的 base：不含任何 extension insert 结果的层栈。
  // 见 section 5.2.1.1：insert 是 append 语义、不按 id 去重，所以热应用每次都
  // 必须从「不含 extension 行的 base」重算，否则重复 apply 会产生重复行。
  // 这份 base 与下面 composeEntries / composedOverlays 的层栈前缀一致：
  // bundle（含运行期 bundle 的 insert 行）→ profile → home → overlay 覆盖行。
  const basePatchesBeforeExtension: PatchOptions[] = [
    ...bundlePatches,
    ...profile.patches,
    ...homePatches,
    ...overlayRows,
    ...presetRows,
    ...modeRows,
    ...comboRows,
  ]

  // 扩展包热应用 Host 半（Typert Remote，service 名 extensionManager）：
  // 注册在 config-tree 挂载前的根 ctx 上（与 CorumPluginManager 同时机）。
  // watcher 启动推迟到 attach(ctx)——boot() 返回后 loader 才可用。
  // 在外层声明，prepare 回调里构造（需要 hostCtx），boot 返回后 attach。
  let extensionManager: CorumExtensionManager | undefined

  // 只打印行数（不打印 config：行里可能带凭据/路径，日志不该留副本）。
  if (extensionPackPatches.length > 0) {
    const count = extensionPackPatches.reduce((n, patch) => n + (patch.insert?.length ?? 0), 0)
    process.stderr.write(`[corum-desktop] extension plugins: ${count} 行（entries.json 折行）\n`)
  }
  t('combo+extension+disabled')

  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlayRows, presetRows, modeRows, extensionPackPatches, disabledPatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  // ⚠️ 为什么必须用 helper 一次产出两份：`profileContext.overlays` 是官方
  // `readProfilePatches()` 的唯一扩展入口，而 `dsh-config-editor.edit()`（设置
  // 中心写盘）与 `dsh-hmr.reconcileProfile()` 都用它重算整棵 profile 树。若
  // profileContext.overlays 为空，任何一次热重组都会把 desktop/IDE 覆盖层还原成
  // 基座默认（webserver 回落 3080、官方 plugin-manager/credentials 重新激活）。
  // 见 `desktop-overlays.ts` 的分层表与 AGENTS.md 红线 5（不得 filter disabled 行）。
  const { fixedOverlays: profileOverlays, bootOverlays: composedOverlays } = composeDesktopOverlays({
    overlays: overlayRows,
    presetOverlays: presetRows,
    modeOverlays: modeRows,
    comboOverlays: { patches: comboRows, rows: [] },
    extensionPackPatches,
    disabledPatches,
    telemetryPatch,
  })
  // 默认 preset 持久化由官方 settings 通道承担：`setDefaultPresetRemote` 调
  // `ctx.settings.update('agent-preset-registry', { selectedDefault })`，volatile 值
  // 持久化进 profile patch 且热生效（`write()` → `mergeLayers` → loader `_commitVolatile`）。
  // 重启后 schemastery 从 patch raw 解析 volatile `selectedDefault`，`defaultId` getter
  // 直接返回持久值，无需 boot 读文件或注入 overlay。
  t('composeEntries+overlays')

  // 全局 KV 的 JSON → SQLite 存量迁移（用户 2026-09-15 决定；只迁全局 storages/）。
  // ⚠️ **必须早于 boot()**：config-tree 一旦按 sqlite 挂载，workspace 等服务会在
  // 首次 open 域时读到**空** SQLite 并把它当成权威状态（空工作区列表），
  // 之后再补数据就晚了（运行期写入已覆盖）。故先在文件层搬完，再挂树。
  // 非阻断：失败只记日志（JSON 侧仍是权威，把 storage-domain 的 backend 改回
  // json 即完全回退）。
  await migrateKvStoreAtBoot()
  process.stderr.write(`[corum-desktop] boot 计时：profile 组合＋迁移完成 +${Date.now() - bootT0}ms\n`)
  t('migrateKvStore')

  const ctx = await boot(
    NAME,
    join(profile.dir, PROFILE_ROOT_FILENAME),
    structuredClone([...bundlePatches, ...profile.patches, ...homePatches, ...composedOverlays]),
    (hostCtx) => {
      // The official web transport rows (web-startup → webserver → web-runtime →
      // connection) inject `cmdlineArgs`/`appExit`, which the dsh CLI provides
      // before mounting the tree. The desktop boots the profile directly via
      // dsh-app-boot (no CLI), so provide them here: an EMPTY inner-argv lets
      // web-startup parse its defaults (openBrowser/host/port/trustedHosts);
      // in 0.2.1 trustedHosts moved from the web-runtime config row to
      // ctx.webStartup.trustedHosts, which web-startup populates from its parse.
      // This overlay's webserver/web-runtime configs then override with the
      // pinned loopback/ephemeral/no-open values. `appExit` is the bounded
      // exit request the web parse path would use on a usage error — wired to
      // process.exit so a malformed flag still terminates the host child.
      provideCmdline(hostCtx, {
        args: [],
        exit: (code) => { process.exit(code) },
      })
      // Provide profileContext (the dsh CLI normally does this; desktop boots
      // directly via dsh-app-boot with no CLI). Several official boot-time
      // services are gated on `disabled: !!js "!ctx.get('profileContext')"` —
      // notably `config-editor`, `settings` (dsh-settings/SettingsForms), and
      // the `agent-default-model` desktopPlatform guard. Without profileContext
      // they stay disabled, and plugins that inject `settings` (e.g.
      // corum-web-search: `inject: ['web','settings']`) stay pending forever,
      // blocking web boot. Build the ProfileContext from the already-loaded
      // profile + resolved home, matching the dsh CLI's shape.
      //
      // `overlays` 必须是**启动固定层**（见 desktop-overlays.ts 的分层表）：
      // 官方 `readProfilePatches()` 只组合
      // `bundle → profile patch → home patch → context.overlays (+ telemetry)`，
      // 而 `dsh-config-editor.edit()`（设置写盘）与 dsh-hmr 的 `reconcileProfile()`
      // 都经它 recompose 整棵树。这里给空数组 ⇒ 热重组把 desktop/IDE 覆盖层全部
      // 还原成基座默认（webserver 回落 3080、官方 plugin-manager/credentials 重新
      // 激活 → service 重复注册）。telemetry patch 不在这里重复：官方按下面的
      // `telemetryDisabledEnv` 自己生成。
      hostCtx.provide('profileContext', {
        name: profile.name,
        dir: profile.dir,
        patchPath: profile.patchPath,
        installAnchor: INSTALL_ANCHOR,
        cwd: process.cwd(),
        home: resolveDshHome(),
        startedBundles: profile.layers.map(l => l.packageName),
        overlays: profileOverlays,
        telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
      })
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable provenance snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      // 插件中心 Host 半（Typert Remote，service 名 pluginManager）：注册在
      // config-tree 挂载前的根 ctx 上，api-gateway 的 SRC 发现据此把
      // /api/pluginManager/* 挂进 /api 拦截器（与 pluginInventory 同理）。
      // P5c：保留引用以把 install(spec) 注入给 CorumExtensionManager.installLocal。
      const pluginManagerInstance = new CorumPluginManager(hostCtx)
      // 文件系统 Host 半（Typert Remote，service 名 corumFs）：IDE 资源管理器
      // 文件树的数据源（旧 corum.fs.list 的 0.1.2 重供），注册在 config-tree
      // 挂载前的根 ctx 上，api-gateway 的 SRC 发现把 /api/corumFs/list 挂进
      // /api 拦截器（与 pluginManager 同理）。
      new CorumFsService(hostCtx)
      // 真实终端 Host 半（Typert Remote，service 名 corumTerminal）：IDE 底部
      // 面板 xterm.js 的 node-pty 会话源（create/write/resize/poll/kill），
      // 与 corumFs 同一注册时机，api-gateway SRC 发现自动认领。
      new CorumTerminalService(hostCtx)
      // 工作区 git 侦测/初始化 Host 半（Typert Remote，service 名 corumGit）：
      // 新建工作区时侦测 git 仓库 + 按需初始化（子 Agent 编排隔离/verify/integrate
      // 的 git 依赖前置），同时注册 corum-workspace settings namespace（「新工作区
      // 始终初始化 git」通用开关的持久化面）。与 corumFs 同一注册时机。
      new CorumGitService(hostCtx)
      // 改动审查的影子 git 仓库 Host 半（Typert Remote，service 名 corumReview）：
      // Review 卡的数据源。只对「本轮被写过的路径」做 plumbing 提交（绝不 git add -A），
      // pre-image 在 session/event 的 tool/call 上同步读取（早于工具落盘）。与 corumFs
      // 同一注册时机；同时注册 corum-review settings namespace（保留天数）。
      new CorumReviewService(hostCtx)
      // 扩展包插件热应用 Host 半（Typert Remote，service 名 extensionManager）：
      // 见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2.2。
      // 注册在 config-tree 挂载前的根 ctx 上（与 pluginManager 同时机），
      // api-gateway SRC 发现把 /api/extensionManager/* 挂进 /api 拦截器。
      // watcher 启动推迟到 boot() 返回后的 attach(ctx)——那时 loader 才可用。
      // P5c：注入 pluginManagerInstance.install(spec) 作为 installLocal 的
      // 插件安装回调（跑 pnpm add + reconcile，返回 restartRequired）。
      // P4：注入 pluginManagerInstance.removePackPlugin(name) 作为 uninstall 的
      // 插件卸载回调（跑 pnpm remove + reconcile，绕过 PACK_OWNED 守卫）。
      extensionManager = new CorumExtensionManager(hostCtx, {
        home: resolveDesktopHome(),
        basePatches: basePatchesBeforeExtension,
        // 现读：插件中心的启停是运行期可变的，热应用不能拿 boot 时的快照。
        getDisabledPatches: () => loadDisabledPatches(),
        // P5c installLocal 的插件安装通道：调 pluginManager.install(spec)
        // 跑 pnpm add <spec> + reconcile（返回 { ok, restartRequired, log }）。
        installPlugin: (spec) => pluginManagerInstance.install(spec),
        // P4 uninstall 的插件卸载通道：调 pluginManager.removePackPlugin(name)
        // 跑 pnpm remove <name> + reconcile（绕过 PACK_OWNED，返回 { ok, restartRequired, log }）。
        uninstallPlugin: (name) => pluginManagerInstance.removePackPlugin(name),
      })
    },
  )
  process.stderr.write(`[corum-desktop] boot 计时：config-tree 挂载完成 +${Date.now() - bootT0}ms\n`)
  t('boot() config-tree')
  // boot() 返回 ctx 后启动 extension watcher（loader 这时才可用）。
  // 见 extension-manager.ts 的 attach 注释：watcher 不崩 host，失败只记 stderr。
  if (extensionManager !== undefined) extensionManager.attach(ctx)
  return ctx
}
