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

const NAME = 'corum-shell'

/**
 * The desktop app's own harness home, fully separate from the CLI's `~/.dsh`
 * so the two surfaces never share sessions, settings, presets, or profiles.
 * Resolves `CORUM_HOME` when set, otherwise `~/.corum-shell`.
 */
const DEFAULT_DESKTOP_HOME = '~/.corum-shell'

/**
 * Point this process's `DSH_HOME` at the desktop home BEFORE any boot step.
 * Every harness-home resolver (`resolveDshHome`, `loadLayeredEnv`,
 * `healProfilesModuleFallback`, `loadProfile`) reads `process.env.DSH_HOME`,
 * so setting it once isolates the whole tree from the web surface — including
 * a launch (`open .app`) that inherits no environment at all.
 * @returns the resolved desktop home path.
 */
export function resolveDesktopHome(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : DEFAULT_DESKTOP_HOME
  const home = resolveDshHome(configured)
  process.env.DSH_HOME = home
  return home
}

/**
 * Resolve the desktop UI mode. The Electron main normalizes the `--ide`
 * launch flag into `CORUM_DESKTOP_MODE=ide` before spawning the host child, so
 * this process sees a single normalized source. A malformed value is not a
 * boot error — it falls back to the default rather than stranding a launch.
 * @returns `ide` when the normalized variable is `ide`, otherwise `minimal`.
 */
export function resolveDesktopMode(): DesktopMode {
  const value = process.env[DESKTOP_MODE_ENV]
  return value === 'ide' ? 'ide' : 'minimal'
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

/** The environment variable the Electron main normalizes `--ide` into. */
const DESKTOP_MODE_ENV = 'CORUM_DESKTOP_MODE'

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
  // highest patch layer; `minimal` (default) keeps the official surface
  // byte-for-byte. The overlay is a REQUIRED layer (it ships beside the
  // desktop patch), so its file must always resolve — see copyDesktopArtifacts.
  const mode = resolveDesktopMode()
  const modeOverlays = mode === 'ide' ? loadOverlayPatches(NAME, IDE_PATCH) : []
  process.stderr.write(`[corum-shell] desktop mode: ${mode}\n`)

  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays, modeOverlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  const composedOverlays = [...overlays, ...modeOverlays]
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
    },
  )
  return ctx
}
