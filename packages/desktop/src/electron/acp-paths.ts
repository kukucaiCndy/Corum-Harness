/**
 * ACP (out-of-process agent) path resolution helpers.
 *
 * Extracted from `main.ts` for testability: the packaged vs dev path logic
 * can be unit-tested without spinning up Electron.
 *
 * @module electron/acp-paths
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the Node binary path for the ACP child process.
 * - **packaged**: `Resources/node/bin/node` (POSIX) or `Resources/node/node.exe` (Windows)
 * - **dev**: `process.execPath` (the Electron launcher's Node)
 *
 * @param packaged - whether the app is running from a packaged .app/.asar
 * @param resourcesPath - `process.resourcesPath` (packaged only)
 * @param platform - `process.platform`
 * @returns absolute path to the Node binary
 */
export function resolveHostNode(packaged: boolean, resourcesPath: string, platform: NodeJS.Platform): string {
  if (packaged) {
    if (platform === 'win32') return join(resourcesPath, 'node', 'node.exe')
    return join(resourcesPath, 'node', 'bin', 'node')
  }
  return process.execPath
}

/**
 * Resolve the official `dsh` CLI entry path for the ACP child process.
 *
 * - **packaged**: `Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js`
 * - **dev**: `dirname(main.js)/../node_modules/@deepseek-ai/dsh/lib/bin.js`
 *
 * @param packaged - whether the app is running from a packaged .app/.asar
 * @param resourcesPath - `process.resourcesPath` (packaged only)
 * @param mainFileUrl - `import.meta.url` of the calling main module
 * @returns absolute path to `dsh/lib/bin.js`
 */
export function resolveAcpCliPath(packaged: boolean, resourcesPath: string, mainFileUrl: string): string {
  if (packaged) {
    return join(resourcesPath, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }
  return join(dirname(fileURLToPath(mainFileUrl)), '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}
