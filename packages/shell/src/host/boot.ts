/**
 * Desktop profile composition: boots an existing dsh profile (`web` by
 * default, override with `CORUM_DESKTOP_PROFILE`) with the desktop transport
 * overlay applied as the highest patch layer. Layer order mirrors the dsh
 * CLI: bundle layers, the profile's own cordis.patch.yml, the home-level
 * patch, the desktop overlay, then the telemetry switch.
 * @module corum-shell/host/boot
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
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

const NAME = 'corum-shell'

/** ui-onboarding 持久化命名空间（与 corum-ui-settings-models 的 onboarding-copy 一致）。 */
const ONBOARDING_NAMESPACE = 'ui-onboarding'
/** Onboarding 命名空间 schema（welcomeNoticeVersion 一个字段）。 */
const OnboardingSettingsSchema = z.object({ welcomeNoticeVersion: z.string() })

export { resolveDesktopHome } from './home.ts'
import { resolveDesktopHome } from './home.ts'
import { CorumPluginManager, DISABLED_FILENAME, isCorePluginEntry } from './plugin-manager.ts'

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
  if (value === 'dev-agent') return 'dev-agent'
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

/** The dev-agent-mode overlay: applied only when the desktop mode resolves to `dev-agent`. */
const DEV_AGENT_PATCH = fileURLToPath(new URL('../cordis.dev-agent.patch.yml', import.meta.url))

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
export type DesktopMode = 'minimal' | 'ide' | 'dev-agent'

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
// Dev fallback for the official shipped set: read it from the local dsh
// checkout (the same place the `link:` deps resolve from). `DSH_CHECKOUT`
// overrides the checkout root, mirroring the pack scripts.
const OFFICIAL_DEV_PRESETS = join(
  process.env.DSH_CHECKOUT ?? '/Users/kukucai/dsh',
  'apps', 'cli', 'config', 'agent-presets',
)

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
  if (existsSync(officialRoot)) roots.push({ path: officialRoot, trust: 'system' })
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
 * here `@deepseek-ai/dsh-base` under `packages/shell/node_modules` is a
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
    if (!stat.isSymbolicLink()) throw new Error(`corum-shell: ${link} exists and is not a symlink; remove it so the shell can manage the installation fallback`)
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
 * Boot the desktop surface: resolve the profile, stack its patch layers plus
 * the desktop overlay, mount the tree, and return the settled context.
 * @returns the settled root context with the desktop transport services.
 */
export async function bootDesktop(): Promise<Context> {
  resolveDesktopHome()
  const environment = loadLayeredEnv(NAME)
  installFailLoud(NAME, process)
  // Registry layout needs a realpath-aware heal (see healProfilesModuleFallbackRegistry);
  // the official healProfilesModuleFallback cannot see transitive deps through
  // the .pnpm isolated-layout symlinks from a symlinked anchor.
  healProfilesModuleFallbackRegistry(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, profileName(), INSTALL_ANCHOR, undefined, { userLayer: true })
  // The root is always rewritten: the whole composition is patch layers, and
  // the vendored Loader's tree write-back can bake composed rows into this
  // file — which would duplicate every bundle insert on the next boot.
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)

  const homePatches = loadOptionalPatches(NAME, join(resolveDshHome(), PROFILE_PATCH_FILENAME)) ?? []
  const overlays = loadOverlayPatches(NAME, DESKTOP_PATCH)
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)

  // Desktop UI mode: `ide` mounts the IDE-shell overlay (forked layout/theme/
  // workspace rows replacing the official three-column chat shell) as the
  // highest patch layer; `dev-agent` mounts the dev-agent-shell overlay
  // (Agent development verification UI); `minimal` (default) keeps the official
  // surface byte-for-byte.
  const mode = resolveDesktopMode()
  const modeOverlays =
    mode === 'ide' ? loadOverlayPatches(NAME, IDE_PATCH) :
    mode === 'dev-agent' ? loadOverlayPatches(NAME, DEV_AGENT_PATCH) :
    []
  process.stderr.write(`[corum-shell] desktop mode: ${mode}\n`)

  // Combo 覆盖规则：插件 insert 行与 patches 均作为最高层叠加（见
  // resolveComboOverlays）。combo 的插件集 / 覆盖规则在进程启动时定死，
  // 切换 combo = 壳层按新 combo 起新 host 进程。
  const comboOverlays = resolveComboOverlays()

  // 插件中心的禁用清单：折成 patch 行作为最高层叠加（见 loadDisabledPatches）。
  const disabledPatches = loadDisabledPatches()

  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays, modeOverlays, comboOverlays.rows, disabledPatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  // comboOverlays.rows（combo 的插件 insert 行）必须进入真正传给 boot() 的
  // patch 层栈——否则 CORUM_COMBO_PLUGINS 注入的插件（如 @corum/dev-agent）只
  // 被上面的 composeEntries 用于计算行索引，从未被插入 composition，插件
  // apply() 完全不会执行。顺序与上面 composeEntries 一致：modeOverlays 之后、
  // disabledPatches 之前。
  const composedOverlays = [...overlays, ...modeOverlays, ...comboOverlays.patches, ...comboOverlays.rows, ...disabledPatches]
  // Inject the agent-preset roots the CLI would have added during its own
  // compose step; the desktop shell skips that step, so the roster is empty
  // without this. Trust follows provenance: the official set is `system`,
  // the distribution's authored presets are `user` (see resolveAgentPresetRoots).
  if (rows.has('agent-presets')) {
    const presetRoots = resolveAgentPresetRoots()
    if (presetRoots.length > 0) {
      composedOverlays.push({
        id: 'agent-presets',
        config: {
          ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
          roots: presetRoots,
        },
      })
    }
  }
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)

  const ctx = await boot(
    NAME,
    join(profile.dir, PROFILE_ROOT_FILENAME),
    structuredClone([...bundlePatches, ...profile.patches, ...homePatches, ...composedOverlays]),
    (hostCtx) => {
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable provenance snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      // 插件中心 Host 半（Typert Remote，service 名 pluginManager）：注册在
      // config-tree 挂载前的根 ctx 上，api-gateway 的 SRC 发现据此把
      // /api/pluginManager/* 挂进 /api 拦截器（与 pluginInventory 同理）。
      new CorumPluginManager(hostCtx)
      // ui-onboarding 命名空间注册：官方 ui-settings-general 的 host 半负责本
      // 注册，IDE overlay 禁用它后无人注册 → settings.describe 找不到 →
      // WelcomeNotice（内测声明）load/acknowledge 失败，弹窗卡「暂时无法保存
      // 确认状态」。在根 ctx 注入（settings 服务就绪时触发）补上注册。
      // 仅 IDE 模式需要（minimal 模式官方 ui-settings-general 自己注册）。
      if (mode === 'ide') {
        // 直接读 settings 服务注册（不经 inject 的异步回调——实测该回调在
        // 根 ctx 上不触发）。settings 服务此时尚未挂载，故短轮询直到可用。
        const registerOnboarding = (): void => {
          const settings = hostCtx.get('settings') as {
            register: (ns: unknown, schema: unknown) => void
          } | undefined
          if (settings === undefined) return
          settings.register(settingsNamespace(ONBOARDING_NAMESPACE), OnboardingSettingsSchema)
          process.stderr.write('[corum-shell] ui-onboarding namespace registered\n')
        }
        const poll = setInterval(() => {
          if (hostCtx.get('settings') !== undefined) {
            clearInterval(poll)
            try { registerOnboarding() } catch (error) {
              process.stderr.write(`[corum-shell] ui-onboarding register failed: ${String(error)}\n`)
            }
          }
        }, 100)
        setTimeout(() => clearInterval(poll), 15000)
      }
    },
  )
  return ctx
}
