/**
 * 端点身份解析 —— 这是「通用 CDP 扫描器」的判据所在。
 *
 * 本插件的目标是**任意 CDP 端点**（用户手起的 `chrome --remote-debugging-port=N`
 * 也算），所以「这端点是什么」必须判对：判错会让 UI 把 corum 特有的「基座版本」
 * 套到浏览器身上（显示「基座版本未知」—— 它根本没有基座）。
 *
 * ## 下面的 UA / Browser 都是**实机抓的**，不是编的
 *
 * 2026-11-03 在本机 `/Applications/Google Chrome.app` 起
 * `--headless=new --remote-debugging-port=19222` 后 `GET /json/version` 得：
 *
 * ```json
 * { "Browser": "Chrome/156.0.8078.80",
 *   "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
 *                  (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36" }
 * ```
 *
 * 旧实现只正则 UA 的 `\b(?:Chrome|Chromium)/`，在 `HeadlessChrome` 上匹配不到
 * （`s` 与 `C` 之间没有词边界），把这个真 Chrome 判成 `unknown`。第一组用例就是它。
 */

import { describe, expect, it } from 'vitest'

import { resolveEndpointIdentity } from '../src/discover.js'

/** 实测抓到的 Chrome 156（headless）两个字段。 */
const CHROME_HEADLESS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36'
const CHROME_BROWSER = 'Chrome/156.0.8078.80'

describe('resolveEndpointIdentity', () => {
  it('Chrome headless（实测样本）⇒ chrome，且从 Browser 字段取版本', () => {
    const id = resolveEndpointIdentity(CHROME_HEADLESS_UA, CHROME_BROWSER)
    expect(id.kind).toBe('chrome')
    expect(id.browserVersion).toBe('156.0.8078.80')
    expect(id.headless).toBe(true)
    // 绝不能被当成 corum：它没有基座。
    expect(id.electronVersion).toBeNull()
  })

  it('同一端点若只有 UA、没有 Browser 字段，仍判 chrome（UA 兜底）', () => {
    const id = resolveEndpointIdentity(CHROME_HEADLESS_UA, null)
    expect(id.kind).toBe('chrome')
    expect(id.browserVersion).toBe('156.0.0.0')
  })

  it('普通（非无头）Chrome ⇒ chrome 且 headless:false', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
    const id = resolveEndpointIdentity(ua, 'Chrome/156.0.8078.80')
    expect(id.kind).toBe('chrome')
    expect(id.headless).toBe(false)
  })

  it('corum ⇒ corum，Electron 版本取 corum-desktop 那个 token', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) corum-desktop/43.4.1 Chrome/134.0.0.0 Electron/43.4.1 Safari/537.36'
    const id = resolveEndpointIdentity(ua, 'Chrome/134.0.6998.205')
    expect(id.kind).toBe('corum')
    // corum-desktop/<ver> 里的 ver 是 Electron 版本，不是应用版本。
    expect(id.electronVersion).toBe('43.4.1')
    expect(id.appName).toBe('corum-desktop')
  })

  it('Electron 应用（无 corum token）⇒ electron', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) myapp-desktop/2.0.0 Chrome/134.0.0.0 Electron/43.4.1 Safari/537.36'
    const id = resolveEndpointIdentity(ua, null)
    expect(id.kind).toBe('electron')
    expect(id.electronVersion).toBe('43.4.1')
    expect(id.appName).toBe('myapp-desktop')
  })

  it('两个字段都空 ⇒ unknown（不猜，但调用方仍可当合法目标用）', () => {
    const id = resolveEndpointIdentity(null, null)
    expect(id.kind).toBe('unknown')
    expect(id.browserVersion).toBeNull()
    expect(id.electronVersion).toBeNull()
    expect(id.appName).toBeNull()
    expect(id.headless).toBe(false)
  })

  it('标准 vendor token 不进 appName（Mozilla/AppleWebKit/Safari/HeadlessChrome 等）', () => {
    const id = resolveEndpointIdentity(CHROME_HEADLESS_UA, CHROME_BROWSER)
    expect(id.appName).toBeNull()
  })
})
