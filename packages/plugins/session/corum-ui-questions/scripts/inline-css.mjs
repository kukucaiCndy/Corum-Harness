/**
 * Fold the extracted stylesheet into the client bundle (same mechanism as
 * the other corum forks): tsdown's css pipeline extracts stylesheets into
 * lib/style.css; the client bundle is CJS and ships through
 * window.__ModuleLoader__.load, so it cannot import a CSS file.
 *
 * 用法：
 *   node scripts/inline-css.mjs           注入（build 的一步，紧跟 tsdown）
 *   node scripts/inline-css.mjs --check   只校验 client.js 已含本插件样式（CI/门禁用，
 *                                         缺样式时非零退出——防「只跑 tsdown 漏 inline」）
 *
 * 红线：改样式/代码后必须跑完整 `pnpm build`（含本脚本），不能只跑 `tsdown`——
 * tsdown 会重建干净的 client.js + 独立 lib/style.css，把已注入的样式冲掉，导致
 * combo bundle 无本插件样式、界面「没样式」。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PLUGIN_ID = '@corum/corum-ui-questions'
const root = resolve(import.meta.dirname, '..')
const clientJs = join(root, 'lib', 'client.js')
const styleCss = join(root, 'lib', 'style.css')
const checkOnly = process.argv.includes('--check')

if (!existsSync(clientJs)) {
  console.error('[inline-css] lib/client.js missing — run tsdown first')
  process.exit(1)
}

const client = readFileSync(clientJs, 'utf8')
// 幂等判定要看**本插件专属的 style 注入标记**，不能看泛 'data-plugin'——业务源码
// 里可能出现该字符串而误判「已注入」。
const marker = `s.setAttribute('data-plugin','${PLUGIN_ID}')`
const alreadyInjected = client.includes(marker)

if (checkOnly) {
  if (alreadyInjected) {
    console.log(`[inline-css] OK: client.js carries ${PLUGIN_ID} stylesheet`)
    process.exit(0)
  }
  console.error('[inline-css] FAIL: client.js has NO inlined stylesheet — run `pnpm build` (tsdown alone is not enough)')
  process.exit(1)
}

if (!existsSync(styleCss)) {
  if (alreadyInjected) {
    console.log('[inline-css] no stylesheet; client.js already carries the stylesheet')
    process.exit(0)
  }
  console.log('[inline-css] no stylesheet or client bundle; skipping')
  process.exit(0)
}

if (alreadyInjected) {
  rmSync(styleCss, { force: true })
  console.log('[inline-css] client.js already carries the stylesheet; removed lib/style.css')
  process.exit(0)
}

const cssText = readFileSync(styleCss, 'utf8')
const inject = [
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-plugin="${PLUGIN_ID}"]')===null){`,
  `var s=document.createElement('style');`,
  marker + ';',
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

writeFileSync(clientJs, inject + '\n' + client)
console.log(`[inline-css] injected ${cssText.length} chars of CSS into client.js`)
rmSync(styleCss, { force: true })
console.log('[inline-css] removed lib/style.css')
