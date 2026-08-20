/**
 * Fold the extracted stylesheet into the client bundle.
 *
 * tsdown's CSS pipeline (via @tsdown/css) extracts every stylesheet this
 * plugin's components import into `lib/style.css`. The client bundle is CJS
 * and ships through `window.__ModuleLoader__.load`, so it cannot `import` a
 * CSS file and the desktop loader serves no separate CSS asset. This
 * post-build step reads that stylesheet and prepends a <style> inject to
 * `lib/client.js`, then removes the now-redundant CSS file.
 *
 * Idempotent: if the CSS file is absent it exits 0 without touching anything.
 * @module shell-base/scripts/inline-css
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const clientJs = join(root, 'lib', 'client.js')
const styleCss = join(root, 'lib', 'style.css')

if (!existsSync(styleCss) || !existsSync(clientJs)) {
  console.log('[inline-css] no stylesheet or client bundle; skipping')
  process.exit(0)
}

const cssText = readFileSync(styleCss, 'utf8')
const inject = [
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-plugin="@corum/shell-base"]')===null){`,
  `var s=document.createElement('style');`,
  `s.setAttribute('data-plugin','@corum/shell-base');`,
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

const client = readFileSync(clientJs, 'utf8')
if (!client.includes('data-plugin')) {
  writeFileSync(clientJs, inject + '\n' + client)
  console.log(`[inline-css] injected ${cssText.length} chars of CSS into client.js`)
} else {
  console.log('[inline-css] client.js already carries the stylesheet')
}
rmSync(styleCss, { force: true })
console.log('[inline-css] removed lib/style.css')
