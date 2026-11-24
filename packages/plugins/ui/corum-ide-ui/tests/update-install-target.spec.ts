/**
 * 「能否应用内自动安装」的判据（2026-11-24 用户报障的回归网）。
 *
 * ## 事故形态
 *
 * macOS 用户下载完 v0.8.1 后，更新面板显示：
 *
 *     这一形态（系统包 / deb）不能应用内安装：请用系统包管理器安装下载好的包
 *     [需用包管理器安装]（按钮禁用）
 *
 * 而实测下载到的是 `Corum-0.8.1-arm64-mac.zip`（398 MB），macOS 该走
 * `installDarwin()`（解压 → 替换 `.app` → 重启），**宿主侧一直是完整的**。
 *
 * 根因是一行**平台无关**的判定：
 *
 *     const installInPlace = downloadedPath.endsWith('.AppImage')   // 只认 Linux 的资产
 *
 * macOS 下载 `.zip` ⇒ 恒 false；Windows 下载 `.exe` ⇒ 同样恒 false。
 * 于是 macOS 与 Windows 的自动安装被整条挡死，还配上 Linux 专属的 deb 文案。
 *
 * ## 本 spec 钉住
 *
 * ① 三平台各自认自己的资产形态（`.zip` / `.exe` / `.AppImage`）都能装；
 * ② Linux 的 `.deb` **不能**装（/opt 属 root，原地替换不了）—— 这是真限制，不能放宽；
 * ③ 未知平台 / 未知扩展名 ⇒ 不能装（fail-closed，不猜）；
 * ④ 引导文案必须**给出包路径**，Linux 还要给出可照抄的命令
 *    （旧文案「请用系统包管理器安装下载好的包」没说文件在哪，用户当场卡住）。
 */
import { describe, expect, it } from 'vitest'
import { canInstallInPlace, manualInstallHint, INSTALLABLE_ASSET_EXT } from '../src/client/update/update-api.ts'

describe('canInstallInPlace — 三平台各自的资产形态', () => {
  it('macOS 下载 .zip ⇒ 可应用内安装（本次报障的核心）', () => {
    expect(canInstallInPlace('darwin', '/Users/u/.corum/updates/Corum-0.8.1-arm64-mac.zip')).toBe(true)
  })

  it('Windows 下载 .exe ⇒ 可应用内安装', () => {
    expect(canInstallInPlace('win32', 'C:\\Users\\u\\.corum\\updates\\Corum-0.8.1-win-x64.exe')).toBe(true)
  })

  it('Linux 下载 .AppImage ⇒ 可应用内安装', () => {
    expect(canInstallInPlace('linux', '/home/u/.corum/updates/Corum-0.8.1.AppImage')).toBe(true)
  })

  it('Linux 下载 .deb ⇒ **不能**（/opt 属 root，原地替换不了；这是真限制）', () => {
    expect(canInstallInPlace('linux', '/home/u/.corum/updates/corum-desktop_0.8.1_amd64.deb')).toBe(false)
  })

  it('平台与扩展名错配 ⇒ 不能装（fail-closed，不按扩展名猜平台）', () => {
    expect(canInstallInPlace('darwin', '/x/Corum-0.8.1.AppImage')).toBe(false)
    expect(canInstallInPlace('win32', '/x/Corum-0.8.1-arm64-mac.zip')).toBe(false)
  })

  it('未知平台 / 未知扩展名 ⇒ 不能装', () => {
    expect(canInstallInPlace('freebsd', '/x/foo.tar.gz')).toBe(false)
    expect(canInstallInPlace(null, '/x/foo.bin')).toBe(false)
  })

  it('还没下载（path 为 null）⇒ 视为可安装（按钮要能点下去发起下载后的安装）', () => {
    expect(canInstallInPlace(null, null)).toBe(true)
    expect(canInstallInPlace('darwin', null)).toBe(true)
  })

  it('扩展名表覆盖三平台且与宿主实现一一对应', () => {
    expect(INSTALLABLE_ASSET_EXT).toEqual({ darwin: '.zip', win32: '.exe', linux: '.AppImage' })
  })
})

describe('manualInstallHint — 不能装时必须给出可照做的下一步', () => {
  it('文案必须包含已下载包的**绝对路径**（旧文案没说文件在哪）', () => {
    const path = '/home/u/.corum/updates/corum-desktop_0.8.1_amd64.deb'
    expect(manualInstallHint('linux', path)).toContain(path)
  })

  it('Linux 给出可照抄的 dpkg / apt 命令', () => {
    const hint = manualInstallHint('linux', '/tmp/x.deb')
    expect(hint).toMatch(/sudo apt install --reinstall/)
    expect(hint).toMatch(/sudo dpkg -i/)
    // 命令里要带真实路径，而不是占位符（否则等于没说）
    expect(hint).toContain('/tmp/x.deb')
  })

  it('非 Linux 的不可装形态：指出位置 + 引导用「打开所在目录」', () => {
    const hint = manualInstallHint('unknown', '/tmp/x.bin')
    expect(hint).toContain('/tmp/x.bin')
    expect(hint).toContain('打开所在目录')
  })

  it('路径未知时也不崩，并仍然给出可操作指引', () => {
    const hint = manualInstallHint('linux', null)
    expect(hint).toContain('打开所在目录')
    expect(hint).toMatch(/sudo dpkg -i|sudo apt install/)
  })
})
