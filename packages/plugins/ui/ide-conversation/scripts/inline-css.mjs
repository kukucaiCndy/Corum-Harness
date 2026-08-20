/**
 * Fold the extracted stylesheet into the client bundle. Idempotent.
 * @module ide-conversation/scripts/inline-css
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
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-plugin="@corum/ide-conversation"]')===null){`,
  `var s=document.createElement('style');`,
  `s.setAttribute('data-plugin','@corum/ide-conversation');`,
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
