/**
 * Desktop client-HMR driver (browser half): hot-swaps a rebuilt client entry
 * in place. Transport-independent port of the official `@deepseek-ai/dsh-client-hmr`
 * browser half — identical reload algorithm (invalidate → prefetch →
 * registry-first fiber teardown → re-materialize → style swap), but the
 * rebuilt notices arrive over the desktop IPC bridge (`window.corumDesktop`)
 * instead of an `EventSource` SSE channel (the desktop surface has no HTTP).
 *
 * Why a port and not the official package: the official browser half
 * hard-codes `new EventSource('/plugins/events')`, and its node half injects
 * `clientModules` + `webServer` — both disabled by the desktop overlay. The
 * reload algorithm is the reusable part; the event channel is desktop-native
 * (host poll → stdio → Electron main → preload IPC → here).
 * @module corum-desktop/client/hmr
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry, Loader } from '@deepseek-ai/cordis-plugin-loader'
// Type-only: pulls the `ctx.loader` Context merge (declared by the vendored Loader).
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: pulls the `ctx.modules` Context merge (declared by client-modules).
import type {} from '@deepseek-ai/dsh-client-modules/client'
import { requireBridge } from './ipc-bridge.ts'

/** Cordis plugin name. */
export const name = 'corum-desktop-hmr'

/** Required services: the client module system (kernel seed) and the vendored Loader. */
export const inject = ['modules', 'loader']

/** Find the loader entry whose module specifier is `id` (the package name lives in `options.name`). */
function findEntry(loader: Loader, id: string): Entry | undefined {
  for (const entry of loader.entries()) {
    if (entry.options.name === id) return entry
  }
  return undefined
}

/** Remove every `<style data-plugin>` tag owned by `id` (attribute compared verbatim). */
function removeOwnedStyles(id: string): void {
  for (const el of document.querySelectorAll('style[data-plugin]')) {
    if (el.getAttribute('data-plugin') === id) el.remove()
  }
}

/**
 * Mount the desktop HMR driver: subscribe to rebuilt notices and hot-swap
 * entries. No rollback on failure — an import failure leaves the entry
 * fiberless (the next rebuilt notice retries); an apply failure leaves a
 * FAILED fiber for the shell's status projection. Both log loudly.
 * @param ctx - client cordis context with `modules` and `loader`.
 */
/**
 * Entries that PROVIDE services other entries inject (the wire root's
 * `connection`, the kernel-seeded module system, the app-shell assembly).
 * Fiber-swapping one of these re-runs the dependency cascade, and the
 * downstream providers (notably appShell) do not reliably re-materialize —
 * the boot audit then throws `appShell service missing after settled`. For
 * these, a PAGE RELOAD is the correct reload: the host child keeps running
 * (session state persists under CORUM_HOME), only the renderer page re-boots
 * against the fresh bundle. Leaf UI plugins (the common iteration target) use
 * the zero-refresh fiber swap below.
 */
const RELOAD_VIA_PAGE = new Set(['corum-desktop', '@deepseek-ai/dsh-client-modules'])

export function apply(ctx: Context): void {
  const modLoader = ctx.modules
  const loader: Loader = ctx.loader

  async function reload(id: string): Promise<void> {
    // Core service providers: reload the page instead of fiber-swapping, so
    // the whole client tree re-boots cleanly against the rebuilt bundle. The
    // host child (and its session loop) is untouched — this is a renderer
    // refresh, not a task interruption.
    if (RELOAD_VIA_PAGE.has(id)) {
      ctx.logger.info(`corum-desktop-hmr: "${id}" is a core provider — reloading the page to pick up the rebuilt bundle`)
      // Invalidate so the fresh page fetches (not the cached factory).
      modLoader.invalidate(id)
      window.location.reload()
      return
    }
    const entry = findEntry(loader, id)
    if (entry === undefined) {
      ctx.logger.warn(`corum-desktop-hmr: rebuilt notice for unknown entry "${id}" (not in the loader tree)`)
      return
    }
    // Invalidate first (drop stale factory + record — a live factory makes
    // prefetch a no-op), then prefetch while the old fiber still serves.
    modLoader.invalidate(id)
    await modLoader.prefetch(id)

    const oldFiber = entry.fiber
    if (oldFiber !== undefined) {
      // Registry-first teardown: the runtime record must be gone before the
      // fiber's disposer emits internal/plugin, or the Loader flags the entry
      // disabled permanently.
      const runtime = oldFiber.runtime
      if (runtime !== null) entry.ctx.registry.delete(runtime.callback)
      // Drain the unload before the new bundle executes.
      while (oldFiber.inertia !== undefined) await oldFiber.inertia
      delete entry.fiber
    }
    removeOwnedStyles(id)
    // Fiber cleared above: refresh() re-imports (materializing the prefetched
    // factory) and re-plugins under the entry context.
    await entry.refresh()
    await entry.fiber?.await()
    ctx.logger.info(`corum-desktop-hmr: hot-swapped "${id}" (zero refresh)`)
  }

  // Serialize reloads: notices can arrive faster than a swap completes.
  let queue: Promise<void> = Promise.resolve()
  ctx.effect(() => {
    // Loud mount marker: confirms the driver actually activated (its services
    // resolved) — without it a silent inject-wait looks identical to a dead
    // event channel when diagnosing the chain.
    console.info('[corum-desktop-hmr] driver mounted — listening for bundle rebuilds')
    return requireBridge().onHmrEvent((id, rev) => {
      console.info(`[corum-desktop-hmr] rebuilt notice received: ${id} (rev ${rev})`)
      queue = queue.then(() => reload(id)).catch((error: unknown) => {
        ctx.logger.error(`corum-desktop-hmr: reload of "${id}" failed`)
        ctx.logger.error(error)
        // Surface the hard failure as a framework notification (design.pen「row-通知框」):
        // a zero-refresh swap that threw leaves the UI possibly stale — offer a
        // one-click page reload (the user picks; we never auto-reload and lose
        // their unsaved UI state).
        ctx.notifications.notify({
          tone: 'warn',
          title: `热更新失败 · ${id}`,
          message: '热替换未完成，界面可能不是最新版本。',
          actions: [
            { label: '立即刷新', kind: 'primary', onClick: () => { window.location.reload() } },
            { label: '忽略', kind: 'secondary', onClick: () => { /* dismiss */ } },
          ],
        })
      })
    })
  }, 'corum-desktop-hmr: hmr event subscription')
}
