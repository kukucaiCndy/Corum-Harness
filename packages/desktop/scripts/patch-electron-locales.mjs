/**
 * Patch the vendored Electron.app Info.plist so macOS treats the app as
 * supporting Chinese — without `CFBundleLocalizations`, macOS assumes an
 * English-only app and, on window focus, falls back to the default (ABC)
 * input source instead of remembering the user's Chinese IME (per-app input
 * source memory). Adding `zh-Hans` + `CFBundleAllowMixedLocalizations` lets
 * the OS record and restore the Chinese input method per app.
 *
 * Runs against node_modules — re-run after any Electron reinstall/upgrade
 * (wired into the dev launchers). Idempotent.
 * @module corum-desktop/scripts/patch-electron-locales
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let electronPath
try {
  // electron package exports the .app path via its index.js
  electronPath = require('electron')
} catch {
  console.error('[patch-locales] cannot resolve electron binary path')
  process.exit(0)
}
// electronPath is .../dist/Electron.app/Contents/MacOS/Electron
const appContents = dirname(dirname(electronPath))
const plist = join(appContents, 'Info.plist')
if (!existsSync(plist)) {
  console.error(`[patch-locales] Info.plist not found at ${plist}`)
  process.exit(0)
}

const read = (key) => {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

if (read('CFBundleLocalizations') !== null) {
  console.log('[patch-locales] CFBundleLocalizations already present; skipping')
  process.exit(0)
}

execFileSync('plutil', ['-insert', 'CFBundleLocalizations', '-json', JSON.stringify(['en', 'zh-Hans']), plist])
if (read('CFBundleAllowMixedLocalizations') === null) {
  execFileSync('plutil', ['-insert', 'CFBundleAllowMixedLocalizations', '-bool', 'true', plist])
}
console.log('[patch-locales] added CFBundleLocalizations=[en, zh-Hans] + CFBundleAllowMixedLocalizations to Electron.app Info.plist')
console.log('[patch-locales] restart the app for macOS to re-read the bundle')
