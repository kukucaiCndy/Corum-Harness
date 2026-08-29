/**
 * Custom-protocol handlers for the desktop surface. One scheme remains:
 * `corumapp://` serves ONLY the shell-owned pages — the combo launcher page
 * and shell static assets (brand logo / ambient background, Monaco language
 * workers). The dsh surface itself is served by the host's official webserver
 * over loopback HTTP (dist + /plugins bundles + the injected __DSH_BOOT__
 * graph), so the renderer loads it via `loadURL(authenticatedUrl)` rather than
 * a custom scheme. The `corump://` plugin-bundle scheme is retired with the
 * old IPC transport.
 * @module corum-desktop/electron/protocol
 */

import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { protocol } from 'electron'
import { renderComboPageHtml } from './combo-page.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/** Image extensions the shell's /assets/ route serves. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'])

/**
 * Register the privileged scheme. Must run before app ready. Only `corumapp`
 * remains (the dsh surface uses loopback HTTP); `corump` is retired.
 */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'corumapp', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

/**
 * Register the shell protocol handler. Run after app ready, before any host
 * child is spawned: the combo launcher page (corumapp://combo/…) is served
 * without a host. The dsh page no longer transits this scheme.
 * @param monacoWorkersDir - directory of the bundled Monaco language workers.
 * @param assetsDir - directory of the shell-owned static images (brand logo /
 * ambient background). Served at `corumapp://app/assets/<name>`.
 */
export function registerProtocols(
  monacoWorkersDir?: string,
  assetsDir?: string,
): Record<string, never> {
  protocol.handle('corumapp', async (request) => {
    const url = new URL(request.url)
    // 壳的 combo 管理页：`corumapp://combo/index.html`，零 dsh 依赖的静态页。
    // 独立 origin，与 dsh client 页面（loopback HTTP）互不干扰。
    if (url.host === 'combo') {
      return new Response(renderComboPageHtml(), {
        headers: { 'content-type': MIME['.html'] ?? 'text/html; charset=utf-8' },
      })
    }
    const pathname = decodeURIComponent(url.pathname === '' ? '/' : url.pathname)
    // Monaco language workers: served from the shell's own lib/workers dir
    // (bundled iife scripts), NOT the frontend dist (the loopback webserver
    // serves the dist; the workers are a shell-bundled runtime artifact).
    if (monacoWorkersDir !== undefined && pathname.startsWith('/monaco/')) {
      const workerName = pathname.slice('/monaco/'.length)
      const workerPath = resolve(normalize(join(monacoWorkersDir, workerName)))
      if (!workerPath.startsWith(monacoWorkersDir + sep) && workerPath !== monacoWorkersDir) {
        return new Response('forbidden', { status: 403 })
      }
      try {
        const body = await readFile(workerPath)
        return new Response(body, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-cache',
          },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    }
    // Shell-owned static images: brand logo / ambient background served from
    // the assets dir (dev: packages/desktop/assets; packaged: Resources/assets).
    if (assetsDir !== undefined && pathname.startsWith('/assets/') && IMAGE_EXTENSIONS.has(extname(pathname))) {
      const assetName = pathname.slice('/assets/'.length)
      const assetPath = resolve(normalize(join(assetsDir, assetName)))
      if (!assetPath.startsWith(assetsDir + sep) && assetPath !== assetsDir) {
        return new Response('forbidden', { status: 403 })
      }
      try {
        const body = await readFile(assetPath)
        return new Response(body, {
          headers: { 'content-type': MIME[extname(assetPath)] ?? 'application/octet-stream' },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    }
    return new Response('not found', { status: 404 })
  })

  return {}
}
