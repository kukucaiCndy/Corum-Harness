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
/** Absolute path of this package's manifest. */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The desktop transport overlay applied above every other patch layer. */
const DESKTOP_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** The IDE-mode overlay: applied only when the desktop mode resolves to `ide`. */
const IDE_PATCH = fileURLToPath(new URL('../cordis.ide.patch.yml', import.meta.url))

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

/** 解析壳层注入的 combo 覆盖规则（无 combo 注入时为空）。 */
function resolveComboOverlays(): { rows: PatchOptions[]; patches: PatchOptions[] } {
  const pluginsRaw = process.env[COMBO_PLUGINS_ENV]
  const pluginNames = pluginsRaw === undefined || pluginsRaw.trim() === ''
    ? []
    : pluginsRaw.split(',').map(s => s.trim()).filter(s => s !== '')
  const rows: PatchOptions[] = pluginNames.length > 0
    ? [{ insert: pluginNames.map(name => ({ id: name, name })) }]
    : []
  const patchesRaw = process.env[COMBO_PATCHES_ENV]
  const patches = patchesRaw === undefined || patchesRaw.trim() === ''
    ? []
    : patchesRaw.split(',').map(s => s.trim()).filter(s => s !== '')
        .flatMap(f => loadOverlayPatches(NAME, f))
  return { rows, patches }
}

/** Desktop UI mode: `minimal` keeps the official three-column chat shell. */
export type DesktopMode = 'minimal' | 'ide'

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Shipped agent-preset roots the desktop roster supplies.
 *
 * The official CLI resolves the SHIPPED root beside its own config and patches
 * it into `agent-presets` during `composeProfile`; the desktop shell has no
 * equivalent step, so without this the roster only sees the user root
 * (`$DSH_HOME/.agent-presets`) and the picker comes up empty. We inject the
 * same roots here, both anchored beside the shipped runtime so the identical
 * relative paths hold in dev and inside the packaged app:
 *
 *   <runtime>/shipped-presets/corum       — this distribution's own .agent-presets
 *   <runtime>/shipped-presets/official  — the official apps/cli shipped set
 *
 * The pack step materializes both; in a source checkout the pack-macos script
 * (or a dev symlink) mirrors the repository's `.agent-presets` into
 * `shipped-presets/corum`.
 */
const CORUM_SHIPPED_PRESETS = fileURLToPath(new URL('../shipped-presets/corum/', import.meta.url))
const OFFICIAL_SHIPPED_PRESETS = fileURLToPath(new URL('../shipped-presets/official/', import.meta.url))
// Dev fallback: the repository's `.agent-presets` at the workspace root, used
// when the packaged `shipped-presets/corum` staging has not been materialized
// (a plain `node lib/cli.js` run before `pack`).
const CORUM_DEV_PRESETS = fileURLToPath(new URL('../../../.agent-presets/', import.meta.url))
// Dev fallback for the official shipped set: read it from a local dsh checkout
// (the same place the `link:` deps resolve from). `DSH_CHECKOUT` overrides the
// checkout root, mirroring the pack scripts.
//
// When `DSH_CHECKOUT` is unset the path is intentionally left undefined rather
// than defaulting to the author's own machine: `resolveAgentPresetRoots()` skips
// a missing root, so a checkout-less machine still boots on the packaged
// `shipped-presets/official` set. Baking in an absolute path would instead make
// every clone inherit one developer's directory layout.
const OFFICIAL_DEV_PRESETS = process.env.DSH_CHECKOUT === undefined
  ? undefined
  : join(process.env.DSH_CHECKOUT, 'apps', 'cli', 'config', 'agent-presets')

/**
 * Resolve the agent-preset roots the CLI would have injected during its own
 * `composeProfile` step, plus the distribution's own authored presets. Trust
 * follows provenance, not location:
 *
 *   - the OFFICIAL shipped set (standard / code / minimal / cordis) is `system`
 *     — it ships with the deployment;
 *   - the distribution's own `.agent-presets` (designer, frontend, and anything
 *     authored through 创造模式 / `agentPresets.copy`) is `user` — it was
 *     authored locally and carries the same trust as shell access, so it must
 *     NOT present itself as built-in.
 *
 * The official root is listed first so a shipped preset shadows a same-named
 * authored one; `writableRoot` (the first `user` root) then resolves to the
 * authored root, which is where `copy`/`delete` land.
 *
 * Missing directories are skipped so a source-only checkout without the
 * packaged official set still boots.
 */
function resolveAgentPresetRoots(): Array<{ path: string; trust: 'system' | 'user' }> {
  const roots: Array<{ path: string; trust: 'system' | 'user' }> = []
  const officialRoot = existsSync(OFFICIAL_SHIPPED_PRESETS) ? OFFICIAL_SHIPPED_PRESETS : OFFICIAL_DEV_PRESETS
  // `OFFICIAL_DEV_PRESETS` is undefined when no `DSH_CHECKOUT` is configured —
  // the packaged official set above is then the only source, which is the
  // normal case outside the author's machine.
  if (officialRoot !== undefined && existsSync(officialRoot)) roots.push({ path: officialRoot, trust: 'system' })
  const corumRoot = existsSync(CORUM_SHIPPED_PRESETS) ? CORUM_SHIPPED_PRESETS : CORUM_DEV_PRESETS
  if (existsSync(corumRoot)) roots.push({ path: corumRoot, trust: 'user' })
  return roots
}

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
  const loaded = loadProfileWithSkip({
    binName: NAME,
    profileName: profileName(),
    installAnchor: INSTALL_ANCHOR,
    hostVersion: desktopVersion(),
    supportedApis: SUPPORTED_PLUGIN_APIS,
  })
  const profile = loaded.profile
  // 干净启动必须清掉上一次留下的诊断，否则「旧错误」会一直是「当前错误」——
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
  t('loadProfile')
  // The root is always rewritten: the whole composition is patch layers, and
  // the vendored Loader's tree write-back can bake composed rows into this
  // file — which would duplicate every bundle insert on the next boot.
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)

  const homePatches = loadOptionalPatches(NAME, join(resolveDshHome(), PROFILE_PATCH_FILENAME)) ?? []
  const overlays = loadOverlayPatches(NAME, DESKTOP_PATCH)
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  t('loadPatches')

  // Desktop UI mode: `ide` mounts the IDE-shell overlay (forked layout/theme/
  // workspace rows replacing the official three-column chat shell) as the
  // highest patch layer; `minimal` (default) keeps the official surface
  // byte-for-byte.
  const mode = resolveDesktopMode()
  const modeOverlays = mode === 'ide' ? loadOverlayPatches(NAME, IDE_PATCH) : []
  process.stderr.write(`[corum-desktop] desktop mode: ${mode}\n`)

  // Combo 覆盖规则：插件 insert 行与 patches 均作为最高层叠加（见
  // resolveComboOverlays）。combo 的插件集 / 覆盖规则在进程启动时定死，
  // 切换 combo = 壳层按新 combo 起新 host 进程。
  const comboOverlays = resolveComboOverlays()

  // 插件中心的禁用清单：折成 patch 行作为最高层叠加（见 loadDisabledPatches）。
  const disabledPatches = loadDisabledPatches()
  // 扩展包插件 insert 行（P3a）：扫描 extension-packs/<packId>/entries.json 折成
  // patch 行。位置在 comboOverlays.rows 之后、disabledPatches 之前（见
  // corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2.1）。
  // fail loud：entries.json 坏掉让 boot 直接失败，不静默跳过（section 5.2.1.1）。
  const extensionPackPatches = loadExtensionPatches(resolveDesktopHome())

  // P3b 热应用的 base：不含任何 extension insert 结果的层栈。
  // 见 section 5.2.1.1：insert 是 append 语义、不按 id 去重，所以热应用每次都
  // 必须从「不含 extension 行的 base」重算，否则重复 apply 会产生重复行。
  // 这份 base 与下面 composeEntries / composedOverlays 的层栈前缀一致：bundle →
  // profile → home → overlay → mode → combo（patches + rows），不含 extension/disabled。
  const basePatchesBeforeExtension: PatchOptions[] = [
    ...bundlePatches,
    ...profile.patches,
    ...homePatches,
    ...overlays,
    ...modeOverlays,
    ...comboOverlays.patches,
    ...comboOverlays.rows,
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
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays, modeOverlays, comboOverlays.rows, extensionPackPatches, disabledPatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  // comboOverlays.rows（combo 的插件 insert 行）必须进入真正传给 boot() 的
  // patch 层栈——否则 CORUM_COMBO_PLUGINS 注入的插件（如 @corum/corum-agent）只
  // 被上面的 composeEntries 用于计算行索引，从未被插入 composition，插件
  // apply() 完全不会执行。顺序与上面 composeEntries 一致：modeOverlays 之后、
  // 扩展包行之后、disabledPatches 之前。
  const composedOverlays = [...overlays, ...modeOverlays, ...comboOverlays.patches, ...comboOverlays.rows, ...extensionPackPatches, ...disabledPatches]
  // Inject the agent-preset roots the CLI would have added during its own
  // compose step; the desktop shell skips that step, so the roster is empty
  // without this. Trust follows provenance: the official set is `system`,
  // the distribution's authored presets are `user` (see resolveAgentPresetRoots).
  //
  // fork（corum）：`includeShippedRoot: false` 是必需的——`agent-presets` 服务会把
  // **包内置**的 `presets/` 根无条件排在最前（"a shipped preset shadows any
  // directory that claimed its name"），于是本仓 `shipped-presets/official/` 里的
  // standard/ptc/cordis 副本被包内置版本遮蔽：改本仓副本对运行时**完全无效**
  // （2026-09-09 实机发现：换了 preset 里的 subagent 行，工具面却毫无变化）。
  // 关掉内置根后，权威来源就是本函数注入的 roots——官方四种模式来自
  // `shipped-presets/official/`（打包时随 host 闭包物化，见 pack-macos.mjs），
  // 与包内置内容保持同步由 docs/fork-delta.md §5 runbook + 守卫 §17 负责。
  if (rows.has('agent-presets')) {
    const presetRoots = resolveAgentPresetRoots()
    if (presetRoots.length > 0) {
      composedOverlays.push({
        id: 'agent-presets',
        config: {
          ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
          roots: presetRoots,
          includeShippedRoot: false,
        },
      })
    }
  }
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
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
      // web-startup parse its defaults (openBrowser/host/port/trustedHosts),
      // which this overlay's webserver/web-runtime configs then override with
      // the pinned loopback/ephemeral/no-open values. `appExit` is the bounded
      // exit request the web parse path would use on a usage error — wired to
      // process.exit so a malformed flag still terminates the host child.
      provideCmdline(hostCtx, {
        args: [],
        exit: (code) => { process.exit(code) },
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
