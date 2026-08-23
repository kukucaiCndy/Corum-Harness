/**
 * @corum-desktop — the desktop-surface bundle's runtime glue plugin plus the
 * bundle patch (`cordis.patch.yml`, declared by `dsh.bundle.patch`). The
 * plugin registers the desktop surface prompt sections and the shell-visible
 * `DSH_CORUM_DESKTOP` runtime variable. The transport rows (corum-desktop-modules,
 * corum-desktop-connection) and the Electron main process live in sibling subpath
 * entries of this package.
 * @module corum-desktop
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'corum-desktop-app'

/** This dsh installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Environment variable naming this desktop surface to the model's shell. */
const DSH_CORUM_DESKTOP = 'DSH_CORUM_DESKTOP' as const

/**
 * The minimal `webServer`-shaped shim the desktop composition mounts in place
 * of the HTTP server. Official transport rows — today only `ui-theme`'s node
 * half — inject `webServer` to register an index.html transform; the shim
 * collects those transforms (no listener) and replays them through the
 * `corumapp://` protocol handler, so the theme bootstrap keeps working with zero
 * HTTP. The route/upgrade registrars are no-ops because no desktop row calls
 * them.
 */
interface DesktopWebServerShim {
  tapIndex(transform: (html: string) => string): () => void
  applyIndexTaps(html: string): string
  register(route: unknown): () => void
  registerFallback(handler: unknown): () => void
  registerUpgrade(route: unknown): () => void
  readonly port: number
  readonly host: string
}

/** Collects the index transforms transport rows register. */
function createWebServerShim(): DesktopWebServerShim {
  const taps: Array<(html: string) => string> = []
  return {
    tapIndex(transform) {
      taps.push(transform)
      return () => {
        const at = taps.indexOf(transform)
        if (at !== -1) taps.splice(at, 1)
      }
    },
    applyIndexTaps(html) {
      let out = html
      for (const transform of taps) out = transform(out)
      return out
    },
    register() {
      return () => {}
    },
    registerFallback() {
      return () => {}
    },
    registerUpgrade() {
      return () => {}
    },
    port: 0,
    host: '127.0.0.1',
  }
}

/** Model-visible orientation for sessions created through the desktop app. */
function desktopSurfacePrompt(): string {
  return 'You are interacting with the user through the DeepSeek Harness desktop application. '
    + 'The application is a native window; there is no browser tab and no URL to reload. '
    + 'Files the user asks you to open or create land on the host machine through the same '
    + 'filesystem and approval stack as every other dsh surface.'
}

/**
 * Mount the desktop runtime glue: the webServer shim, surface prompt sections,
 * and the shell variable.
 * @param ctx - plugin context (no required services; prompt sections wait for
 * the systemPrompt service and the shell variable for shellEnv).
 */
export function apply(ctx: Context): void {
  // The shim must exist before any transport row that injects webServer
  // (ui-theme) resolves its inject; provide it eagerly on this plugin's ctx.
  ctx.provide('webServer', createWebServerShim() as unknown as import('@deepseek-ai/dsh-host-webserver').default)
  ctx.inject(['systemPrompt'], (promptCtx) => {
    addHarnessSourceSection(promptCtx, SOURCE_ROOT)
    promptCtx.systemPrompt.section({
      name: 'app:desktop-surface',
      order: -98,
      text: () => desktopSurfacePrompt(),
    })
  })
  ctx.inject(['shellEnv'], (runtimeCtx) => {
    runtimeCtx.shellEnv.register({
      name: 'corum-desktop-runtime',
      variables: {
        [DSH_CORUM_DESKTOP]: { description: 'Set to "1" when this session runs inside the DeepSeek Harness desktop application.' },
      },
      resolve: () => ({ [DSH_CORUM_DESKTOP]: '1' }),
    })
  })
}
