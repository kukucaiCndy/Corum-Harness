/**
 * Desktop harness-home resolution, shared by the boot path and every Host
 * service that anchors files under the desktop home (plugin-manager's
 * disabled list, …). Kept in its own module so services never import the
 * boot module (which pulls the whole composition stack).
 * @module corum-shell/host/home
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

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
