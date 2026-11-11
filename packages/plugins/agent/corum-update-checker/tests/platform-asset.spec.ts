/**
 * platform-asset 纯函数守卫（三平台纪律，红线 7）。
 *
 * ## 覆盖面
 *
 * 1. 三平台 × 正确架构的资产匹配（darwin/arm64、win32/x64、linux/x64）。
 * 2. 优先级：dmg > zip / exe > zip / AppImage > deb。
 * 3. 无匹配：错误架构（如 darwin/x64 当前无 arm64 以外的资产）。
 * 4. 文件名模板精确性（含版本号插值）。
 *
 * @module corum-update-checker/tests/platform-asset
 */
import { describe, expect, it } from 'vitest'
import { detectLinuxInstallForm, matchPlatformAsset, type ReleaseAsset } from '../src/platform-asset.ts'

/** 构造一份 release assets 列表（模拟 v0.4.0 的真实命名）。 */
function v040Assets(): ReleaseAsset[] {
  return [
    { name: 'Corum-0.4.0-arm64-mac.zip', browser_download_url: 'https://ex/mac.zip', size: 357362339 },
    { name: 'Corum-0.4.0-arm64-mac.zip.blockmap', browser_download_url: 'https://ex/mac.zip.blockmap', size: 371121 },
    { name: 'Corum-0.4.0-arm64.dmg', browser_download_url: 'https://ex/dmg', size: 364026116 },
    { name: 'Corum-0.4.0-arm64.dmg.blockmap', browser_download_url: 'https://ex/dmg.blockmap', size: 377903 },
    { name: 'Corum-0.4.0-win-x64.exe', browser_download_url: 'https://ex/exe', size: 283351826 },
    { name: 'Corum-0.4.0-win-x64.exe.blockmap', browser_download_url: 'https://ex/exe.blockmap', size: 281622 },
    { name: 'Corum-0.4.0-win-x64.zip', browser_download_url: 'https://ex/win.zip', size: 371933425 },
    { name: 'Corum-0.4.0.AppImage', browser_download_url: 'https://ex/appimage', size: 359688869 },
    { name: 'corum-desktop_0.4.0_amd64.deb', browser_download_url: 'https://ex/deb', size: 224885058 },
  ]
}

describe('matchPlatformAsset — darwin', () => {
  it('matches arm64 zip (first priority for auto-install)', () => {
    const hit = matchPlatformAsset(v040Assets(), 'darwin', 'arm64', '0.4.0')
    expect(hit).not.toBeNull()
    expect(hit!.filename).toBe('Corum-0.4.0-arm64-mac.zip')
    expect(hit!.downloadUrl).toBe('https://ex/mac.zip')
    expect(hit!.size).toBe(357362339)
    expect(hit!.platform).toBe('darwin')
    expect(hit!.arch).toBe('arm64')
  })

  it('falls back to dmg when zip absent', () => {
    const assets = v040Assets().filter(a => !a.name.endsWith('.zip'))
    const hit = matchPlatformAsset(assets, 'darwin', 'arm64', '0.4.0')
    expect(hit).not.toBeNull()
    expect(hit!.filename).toBe('Corum-0.4.0-arm64.dmg')
  })

  it('returns null for x64 (no intel build shipped)', () => {
    const hit = matchPlatformAsset(v040Assets(), 'darwin', 'x64', '0.4.0')
    expect(hit).toBeNull()
  })
})

describe('matchPlatformAsset — win32', () => {
  it('matches x64 exe (first priority)', () => {
    const hit = matchPlatformAsset(v040Assets(), 'win32', 'x64', '0.4.0')
    expect(hit).not.toBeNull()
    expect(hit!.filename).toBe('Corum-0.4.0-win-x64.exe')
    expect(hit!.downloadUrl).toBe('https://ex/exe')
    expect(hit!.platform).toBe('win32')
    expect(hit!.arch).toBe('x64')
  })

  it('falls back to win-x64.zip when exe absent', () => {
    const assets = v040Assets().filter(a => !a.name.endsWith('.exe'))
    const hit = matchPlatformAsset(assets, 'win32', 'x64', '0.4.0')
    expect(hit).not.toBeNull()
    expect(hit!.filename).toBe('Corum-0.4.0-win-x64.zip')
  })

  it('returns null for arm64 (no ARM windows build)', () => {
    const hit = matchPlatformAsset(v040Assets(), 'win32', 'arm64', '0.4.0')
    expect(hit).toBeNull()
  })
})

describe('matchPlatformAsset — linux', () => {
  it('matches x64 AppImage (first priority)', () => {
    const hit = matchPlatformAsset(v040Assets(), 'linux', 'x64', '0.4.0')
    expect(hit).not.toBeNull()
    expect(hit!.filename).toBe('Corum-0.4.0.AppImage')
    expect(hit!.downloadUrl).toBe('https://ex/appimage')
    expect(hit!.platform).toBe('linux')
    expect(hit!.arch).toBe('x64')
  })

  it('falls back to deb when AppImage absent', () => {
    const assets = v040Assets().filter(a => !a.name.endsWith('.AppImage'))
    const hit = matchPlatformAsset(assets, 'linux', 'x64', '0.4.0')
    expect(hit).not.toBeNull()
    expect(hit!.filename).toBe('corum-desktop_0.4.0_amd64.deb')
  })

  it('returns null for arm64 (no ARM linux build)', () => {
    const hit = matchPlatformAsset(v040Assets(), 'linux', 'arm64', '0.4.0')
    expect(hit).toBeNull()
  })
})

describe('matchPlatformAsset — version interpolation', () => {
  it('matches with a different version number', () => {
    const assets: ReleaseAsset[] = [
      { name: 'Corum-0.5.0-arm64.dmg', browser_download_url: 'https://ex/dmg', size: 100 },
    ]
    const hit = matchPlatformAsset(assets, 'darwin', 'arm64', '0.5.0')
    expect(hit).not.toBeNull()
    expect(hit!.filename).toBe('Corum-0.5.0-arm64.dmg')
  })

  it('returns null when version does not match asset version', () => {
    const assets: ReleaseAsset[] = [
      { name: 'Corum-0.5.0-arm64.dmg', browser_download_url: 'https://ex/dmg', size: 100 },
    ]
    const hit = matchPlatformAsset(assets, 'darwin', 'arm64', '0.4.0')
    expect(hit).toBeNull()
  })
})

describe('matchPlatformAsset — edge cases', () => {
  it('returns null for empty asset list', () => {
    expect(matchPlatformAsset([], 'darwin', 'arm64', '0.4.0')).toBeNull()
    expect(matchPlatformAsset([], 'win32', 'x64', '0.4.0')).toBeNull()
    expect(matchPlatformAsset([], 'linux', 'x64', '0.4.0')).toBeNull()
  })

  it('ignores blockmap files (exact name match, no suffix wildcard)', () => {
    const hit = matchPlatformAsset(v040Assets(), 'darwin', 'arm64', '0.4.0')
    expect(hit).not.toBeNull()
    // .blockmap 不会匹配（文件名是 `Corum-0.4.0-arm64.dmg` 而非
    // `Corum-0.4.0-arm64.dmg.blockmap`）。
    expect(hit!.filename.endsWith('.blockmap')).toBe(false)
  })
})

/* ── issue #151：资产选择必须看「安装形态」，不再恒选 AppImage ─────────────── */

describe('detectLinuxInstallForm — 从运行时事实推断安装形态', () => {
  it('APPIMAGE 环境变量非空 ⇒ AppImage（最可信：runtime 自己注入）', () => {
    expect(detectLinuxInstallForm('/opt/Corum/corum-desktop', '/home/u/Corum.AppImage')).toBe('appimage')
  })

  it('execPath 以 .AppImage 结尾 ⇒ AppImage', () => {
    expect(detectLinuxInstallForm('/home/u/Corum-0.8.0.AppImage', undefined)).toBe('appimage')
  })

  it('/opt 与 /usr/lib 下的可执行文件 ⇒ deb / 系统包形态', () => {
    expect(detectLinuxInstallForm('/opt/Corum/corum-desktop', undefined)).toBe('deb')
    expect(detectLinuxInstallForm('/usr/lib/corum/corum-desktop', undefined)).toBe('deb')
  })

  it('推断不出时不猜（dev 态 / 未知布局 ⇒ undefined，保持旧行为）', () => {
    expect(detectLinuxInstallForm('/Users/me/work/repo/node_modules/electron/dist/Electron', undefined)).toBeUndefined()
    expect(detectLinuxInstallForm(undefined, undefined)).toBeUndefined()
    expect(detectLinuxInstallForm('', '')).toBeUndefined()
  })
})

describe('matchPlatformAsset — linux 资产顺序随安装形态', () => {
  it('deb 形态 ⇒ 优先下发 .deb（用户要用包管理器装）', () => {
    const hit = matchPlatformAsset(v040Assets(), 'linux', 'x64', '0.4.0', 'deb')
    expect(hit?.filename).toBe('corum-desktop_0.4.0_amd64.deb')
  })

  it('AppImage 形态 ⇒ 仍优先 .AppImage（保持历史行为）', () => {
    const hit = matchPlatformAsset(v040Assets(), 'linux', 'x64', '0.4.0', 'appimage')
    expect(hit?.filename).toBe('Corum-0.4.0.AppImage')
  })

  it('形态未知（undefined）⇒ 保持旧顺序（AppImage 优先），不因未知而一个都不匹配', () => {
    const hit = matchPlatformAsset(v040Assets(), 'linux', 'x64', '0.4.0')
    expect(hit?.filename).toBe('Corum-0.4.0.AppImage')
  })

  it('deb 形态但 release 里没有 deb 资产 ⇒ 回落到 AppImage（仍有东西可下）', () => {
    const onlyAppImage = v040Assets().filter(a => !a.name.endsWith('.deb'))
    const hit = matchPlatformAsset(onlyAppImage, 'linux', 'x64', '0.4.0', 'deb')
    expect(hit?.filename).toBe('Corum-0.4.0.AppImage')
  })
})
