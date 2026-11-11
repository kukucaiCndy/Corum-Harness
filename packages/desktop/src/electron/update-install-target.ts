/**
 * Linux 自动更新：**安装前判定**（纯函数，不 import electron）。
 *
 * ## 为什么需要它（issue #151 的第一个缺陷）
 *
 * 旧实现只在 `installLinux()` 里检查「资产是不是 .AppImage」，然后无条件起一个
 * detached 脚本：脚本先等 app 退出（`setTimeout(() => app.quit(), 1000)` 已经在
 * `runDetachedScript` 里排好），再 `cp -f` 覆盖 `${execPath}`。于是 deb 安装形态
 * （`/opt/Corum/...`，属主 root）上的真实剧本是：
 *
 * 1. 用户点「重启安装」→ 应用**先退出**；
 * 2. 脚本 `cp` 撞 EACCES → 回滚 `exit 1`；
 * 3. 应用已经没了、版本没变、不重启、**没有任何提示**（脚本 `stdio: 'ignore'`，
 *    渲染层也不看返回值）。
 *
 * 用户看到的就是「点了自动更新，应用消失了」。补文案没用 —— 必须在**起脚本之前**
 * 判定能不能装，判不了就返回可读原因、**不退出应用**。
 *
 * ## 判定表（每条都有对应的实测形态）
 *
 * | 条件 | 结果 |
 * | --- | --- |
 * | 下载物不是 `.AppImage`（例如 deb 资产） | 拒绝：请用系统包管理器升级 |
 * | 当前可执行文件不是 AppImage（`/opt/…` 的系统包安装） | 拒绝：应用内更新只支持 AppImage |
 * | 可执行文件所在目录**不可写**（root 属主 / `/opt`） | 拒绝：给出目录与「需要什么权限」 |
 * | 以上都不命中 | 放行（`undefined`） |
 *
 * @module corum-desktop/ubuntu-update-target
 */

/** `linuxInstallBlocker` 的输入（全部显式传入，便于单测；不读全局）。 */
export interface LinuxInstallCheck {
  /** 已下载的资产绝对路径（来自更新检查器）。 */
  readonly downloadedPath: string
  /** 当前应用可执行文件路径（`process.execPath`；AppImage 形态下即 .AppImage 本体）。 */
  readonly execPath: string
  /** `dirname(execPath)` 是否可写（调用方用 `accessSync(dir, W_OK)` 探）。 */
  readonly dirWritable: boolean
  /** AppImage 运行时注入的 `APPIMAGE` 环境变量（非空即「就是 AppImage 形态」）。 */
  readonly appImageEnv?: string | undefined
}

/**
 * 判定本次 Linux 自动安装是否**不允许**进行。
 *
 * @param input - 判定输入（见 {@link LinuxInstallCheck}）。
 * @returns 面向用户的拒绝原因；`undefined` = 可以继续走替换脚本。
 */
export function linuxInstallBlocker(input: LinuxInstallCheck): string | undefined {
  const { downloadedPath, execPath, dirWritable } = input
  if (!downloadedPath.endsWith('.AppImage')) {
    const ext = downloadedPath.slice(downloadedPath.lastIndexOf('.')) || '（未知格式）'
    return `下载到的是 ${ext} 资产，应用内自动更新只支持 AppImage。`
      + 'deb 安装形态请用系统包管理器升级（sudo dpkg -i <新的 .deb> 或 sudo apt upgrade），'
      + '或点「下载」后手动安装；本次没有改动任何文件。'
  }
  const appImageForm = (input.appImageEnv ?? '') !== '' || execPath.endsWith('.AppImage')
  if (!appImageForm) {
    return `当前是系统包安装形态（${execPath}），应用内自动更新只支持 AppImage。`
      + '请用系统包管理器升级（sudo apt upgrade / sudo dpkg -i）；本次没有改动任何文件。'
  }
  if (!dirWritable) {
    const dir = execPath.slice(0, Math.max(1, execPath.lastIndexOf('/')))
    return `没有写入 ${dir} 的权限（该目录通常属 root），无法原地替换 AppImage。`
      + '请把它放到用户可写的目录，或以系统包形态用包管理器升级；本次没有改动任何文件。'
  }
  return undefined
}