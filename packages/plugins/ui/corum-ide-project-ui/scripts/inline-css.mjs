/**
 * Fold the extracted stylesheet into the client bundle. Idempotent.
 * @module ide-project/scripts/inline-css
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
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
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-plugin="@corum/corum-ide-project-ui"]')===null){`,
  `var s=document.createElement('style');`,
  `s.setAttribute('data-plugin','@corum/corum-ide-project-ui');`,
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

const client = readFileSync(clientJs, 'utf8')
if (!client.includes('data-plugin')) {
  writeFileSync(clientJs, inject + '\n' + client)
}
