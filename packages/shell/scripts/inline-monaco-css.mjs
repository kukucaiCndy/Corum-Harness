/**
 * Fold the extracted Monaco stylesheet into the client bundle.
 *
 * tsdown's CSS pipeline (via @tsdown/css) extracts every stylesheet Monaco's
 * ESM imports into `lib/style.css`. The corum-shell client bundle is CJS and
 * ships through `window.__ModuleLoader__.load`, so it cannot `import` a CSS
 * file and the desktop `corump://` loader serves no separate CSS asset. This
 * post-build step reads that stylesheet and prepends a <style> inject to
 * `lib/client.js`, then removes the now-redundant CSS file — the bundle becomes
 * self-contained again.
 *
 * Idempotent: if the CSS file is absent (no Monaco in this build) it exits 0
 * without touching anything.
 * @module corum-shell/scripts/inline-monaco-css
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const clientJs = join(root, 'lib', 'client.js')
const styleCss = join(root, 'lib', 'style.css')

if (!existsSync(styleCss) || !existsSync(clientJs)) {
  console.log('[inline-monaco-css] no stylesheet or client bundle; skipping')
  process.exit(0)
}

const cssText = readFileSync(styleCss, 'utf8')
const inject = [
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-corum-monaco]')===null){`,
  `var s=document.createElement('style');`,
  `s.setAttribute('data-corum-monaco','');`,
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

const client = readFileSync(clientJs, 'utf8')
if (!client.includes('data-corum-monaco')) {
  writeFileSync(clientJs, inject + '\n' + client)
  console.log(`[inline-monaco-css] injected ${cssText.length} chars of Monaco CSS into client.js`)
} else {
  console.log('[inline-monaco-css] client.js already carries the Monaco stylesheet')
}
rmSync(styleCss, { force: true })
console.log('[inline-monaco-css] removed lib/style.css')
