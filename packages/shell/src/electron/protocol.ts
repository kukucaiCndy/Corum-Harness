/**
 * Custom-protocol handlers for the desktop surface. Two schemes:
 * `corumapp://` serves the built frontend dist (index.html with the injected
 * __DSH_BOOT__ graph, assets, SPA fallback) and `corump://` serves plugin
 * bundles by entry id. The dist uses absolute asset paths, so a custom
 * standard scheme is required — plain file:// would break them.
 * @module corum-shell/electron/protocol
 */

import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { protocol } from 'electron'
import { injectBootManifest } from '@deepseek-ai/dsh-client-modules'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

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

/**
 * Register the privileged schemes. Must run before app ready.
 */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'corumapp', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'corump', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

/**
 * Reconstruct the logical path of a corumapp:// request. The page loads at
 * `corumapp://app/index.html`, so the fixed `app` host is the origin and the
 * real path is the pathname (`/index.html`, `/assets/x.js`, ...).
 * @param url - the parsed request URL.
 * @returns the logical path starting with `/`.
 */
function appPath(url: URL): string {
  if (url.host !== 'app') return '/'
  return url.pathname === '' || url.pathname === '/' ? '/index.html' : url.pathname
}

/**
 * Register the two protocol handlers. Run after app ready, once the boot
 * graph and dist anchor are known.
 * @param graph - the composed __DSH_BOOT__ graph from the host child.
 * @param clientPaths - entry id → absolute client bundle path (from the child).
 * @param distIndex - absolute path of the built frontend's index.html.
 * @param applyIndexTaps - replays the index transforms transport rows
 * (ui-theme's theme bootstrap) registered against the webServer shim, applied
 * before the boot manifest injection.
 */
export function registerProtocols(
  graph: WebBootGraph,
  clientPaths: Record<string, string>,
  distIndex: string,
  applyIndexTaps: (html: string) => string,
  monacoWorkersDir?: string,
): { update(next: WebBootGraph, nextPaths: Record<string, string>): void } {
  const distRoot = dirname(distIndex)
  // Mutable graph/paths: a host-bridge restart swaps in the new generation's
  // boot manifest (rebuilt revs, added/removed rows) without re-registering
  // the protocol handlers or reloading the window.
  let currentGraph = graph
  let currentPaths = clientPaths
  const update = (next: WebBootGraph, nextPaths: Record<string, string>): void => {
    currentGraph = next
    currentPaths = nextPaths
  }

  protocol.handle('corumapp', async (request) => {
    const pathname = decodeURIComponent(appPath(new URL(request.url)))
    // Monaco language workers: served from the shell's own lib/workers dir
    // (bundled iife scripts), NOT the frontend dist. Both dev and packaged
    // layouts anchor this to the shipped runtime's worker staging.
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
    const target = resolve(normalize(join(distRoot, pathname)))
    // Traversal rejection: the target must be the dist root or stay under it.
    if (target !== distRoot && !target.startsWith(distRoot + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    if (target !== distIndex) {
      try {
        const body = await readFile(target)
        return new Response(body, {
          headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
        })
      } catch {
        // Miss (ENOENT/EISDIR) falls back to index.html (SPA routing).
      }
    }
    const raw = await readFile(distIndex, 'utf8')
    const html = injectBootManifest(applyIndexTaps(raw), currentGraph)
    return new Response(html, {
      headers: { 'content-type': MIME['.html'] ?? 'text/html; charset=utf-8' },
    })
  })

  protocol.handle('corump', async (request) => {
    const url = new URL(request.url)
    // The bundle path rides the host segment: `corump://plugins/<id>/client.js`.
    if (url.host !== 'plugins') return new Response('not found', { status: 404 })
    const pathname = decodeURIComponent(url.pathname)
    const prefix = '/'
    const mapSuffix = '/client.js.map'
    const bundleSuffix = '/client.js'
    const isSourceMap = pathname.startsWith(prefix) && pathname.endsWith(mapSuffix)
    const suffix = isSourceMap ? mapSuffix : bundleSuffix
    // The id may contain a scope slash; anything else under the host is unknown.
    const id = pathname.startsWith(prefix) && pathname.endsWith(suffix)
      ? pathname.slice(prefix.length, -suffix.length)
      : undefined
    const clientPath = id === undefined ? undefined : currentPaths[id]
    const file = clientPath === undefined ? undefined : isSourceMap ? `${clientPath}.map` : clientPath
    if (file === undefined) return new Response('not found', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(body, {
        headers: {
          'content-type': isSourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        },
      })
    } catch {
      // Registered but unreadable (bundle not built yet): loud 404.
      return new Response('not found', { status: 404 })
    }
  })

  return { update }
}
