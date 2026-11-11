/**
 * 平台 → 资产名映射纯函数（三平台纪律，红线 7）。
 * @module corum-update-checker/platform-asset
 */

export type UpdatePlatform = 'darwin' | 'linux' | 'win32'
export type UpdateArch = 'arm64' | 'x64' | string

/**
 * Linux 的**安装形态**（issue #151 缺陷一的根因面）。
 *
 * 资产候选名原先恒把 AppImage 排第一、且完全不看安装形态 ⇒ deb 用户永远被下发一个
 * AppImage，随后 `installLinux()` 在 root 属主的 `/opt/Corum` 上 `cp` 失败并静默回滚
 * （应用已退出、版本没变、无提示）。这里把「装的是哪一形态」变成显式输入。
 */
export type LinuxInstallForm = 'appimage' | 'deb'

/**
 * 从运行时事实推断 Linux 安装形态（纯函数，便于单测）。
 *
 * 判据（按可信度从高到低）：
 * 1. `APPIMAGE` 环境变量非空 ⇒ AppImage（AppImage runtime 自己注入，最可信）；
 * 2. `execPath` 以 `.AppImage` 结尾 ⇒ AppImage；
 * 3. `execPath` 在 `/opt/` 或 `/usr/lib/` 下 ⇒ deb / 系统包（electron-builder 的 deb
 *    默认装到 `/opt/<productName>`）；
 * 4. 其余（dev 态、未知布局）⇒ `undefined`（不猜，保持旧行为）。
 *
 * @param execPath - `process.execPath`（可缺省：非 Linux 或拿不到时）。
 * @param appImageEnv - `process.env.APPIMAGE`（同样可缺省）。
 * @returns 安装形态；推断不出时为 `undefined`。
 */
export function detectLinuxInstallForm(
  execPath: string | undefined,
  appImageEnv: string | undefined,
): LinuxInstallForm | undefined {
  if ((appImageEnv ?? '') !== '') return 'appimage'
  if (execPath === undefined || execPath === '') return undefined
  if (execPath.endsWith('.AppImage')) return 'appimage'
  if (execPath.startsWith('/opt/') || execPath.startsWith('/usr/lib/')) return 'deb'
  return undefined
}

export interface DownloadAsset {
  readonly platform: UpdatePlatform
  readonly arch: string
  readonly filename: string
  readonly downloadUrl: string
  readonly size: number
}

function candidateFilenames(
  platform: UpdatePlatform,
  arch: UpdateArch,
  version: string,
  installForm?: LinuxInstallForm,
): readonly string[] {
  switch (platform) {
    case 'darwin':
      if (arch !== 'arm64') return []
      return [`Corum-${version}-arm64-mac.zip`, `Corum-${version}-arm64.dmg`]
    case 'win32':
      if (arch !== 'x64') return []
      return [`Corum-${version}-win-x64.exe`, `Corum-${version}-win-x64.zip`]
    case 'linux': {
      if (arch !== 'x64') return []
      const appimage = `Corum-${version}.AppImage`
      const deb = `corum-desktop_${version}_amd64.deb`
      // 已知是 deb 形态 ⇒ 先给 deb（用户要用包管理器装）；其余保持历史顺序（AppImage 优先）。
      // 未知形态时两条都留：宁可多一个候选，也不要「一个都没匹配」。
      return installForm === 'deb' ? [deb, appimage] : [appimage, deb]
    }
    default:
      return []
  }
}

export interface ReleaseAsset {
  readonly name: string
  readonly browser_download_url: string
  readonly size: number
}

export function matchPlatformAsset(
  assets: readonly ReleaseAsset[],
  platform: UpdatePlatform,
  arch: UpdateArch,
  version: string,
  installForm?: LinuxInstallForm,
): DownloadAsset | null {
  const candidates = candidateFilenames(platform, arch, version, installForm)
  for (const filename of candidates) {
    const hit = assets.find(a => a.name === filename)
    if (hit !== undefined) {
      return { platform, arch, filename: hit.name, downloadUrl: hit.browser_download_url, size: hit.size }
    }
  }
  return null
}
