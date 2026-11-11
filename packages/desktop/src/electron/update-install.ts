/**
 * 应用更新安装（Electron 主进程侧，三平台）。
 *
 * ## 职责
 *
 * 渲染层在「下载完成待重启」态点击「重启安装」后，经 IPC 调本模块：
 *   1. 生成平台相关的安装脚本（等待 app 退出 → 替换 → 重启）；
 *   2. 以 **detached** 子进程 spawn 该脚本（不随 app 退出而死）；
 *   3. `app.quit()`，脚本接管：等进程消失 → 替换文件 → 重启新版本。
 *
 * ## 三平台实现（三平台纪律，红线 7）
 *
 * - **darwin**：下载的是 zip（含 Corum-*.app）。解压 → 替换当前 .app → 重启。
 *   macOS 允许替换运行中的 .app bundle（运行态持有旧 inode，删除/替换不影响）。
 * - **win32**：下载的是 NSIS exe。以 `/S`（静默安装）+ `--restart` 启动；
 *   NSIS 的 runAfterFinish 会重启。我们退出，让安装器接管。
 * - **linux**：下载的是 AppImage。替换原 AppImage 文件 + chmod +x → 重启。
 *
 * ## 不做的事
 *
 * - 不做 Squirrel.Mac / electron-updater 的差量更新（太重）；全量替换。
 * - 不验证签名（release 资产来自 GitHub，信任链 = 仓库本身的 release 权限）。
 *
 * @module corum-desktop/electron/update-install
 */

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
// issue #151：安装前判定（纯函数，可单测；不 import electron）。
import { linuxInstallBlocker } from './update-install-target.ts'

/** 安装请求（渲染层经 IPC 传入）。 */
export interface InstallUpdateRequest {
  /** 已下载的更新文件路径。 */
  readonly downloadedPath: string
}

/** 安装结果。 */
export interface InstallUpdateResult {
  readonly ok: boolean
  readonly error?: string
}

/**
 * 执行「重启安装」。spawn 一个 detached 脚本，然后 quit app。
 * 脚本会等 app 退出后替换文件、重启。
 *
 * @param request - 安装请求（含已下载文件路径）。
 * @returns 安装结果（脚本 spawn 成功即 ok=true，后续由脚本接管）。
 */
export function performInstallUpdate(request: InstallUpdateRequest): InstallUpdateResult {
  const { downloadedPath } = request
  if (!downloadedPath || !existsSync(downloadedPath)) {
    return { ok: false, error: `downloaded file not found: ${downloadedPath}` }
  }
  try {
    switch (process.platform) {
      case 'darwin':
        return installDarwin(downloadedPath)
      case 'win32':
        return installWin32(downloadedPath)
      case 'linux':
        return installLinux(downloadedPath)
      default:
        return { ok: false, error: `unsupported platform: ${process.platform}` }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

/**
 * 当前 app 可执行入口路径（用于重启）。
 *
 * 三种打包形态的事实来源就是 `process.execPath` 本身：
 * · macOS：`.app/Contents/MacOS/<name>`；
 * · Windows：`Corum.exe`；
 * · Linux AppImage：AppImage 文件本体（`APPIMAGE` 环境变量指向同一物）；
 * · Linux deb：`/opt/Corum/corum-desktop`（**属主 root、目录不可写**）。
 *
 * 最后一种**不能**原地替换 —— 判定与拒绝文案在 `linuxInstallBlocker()`（issue #151）。
 * dev 态这里指向 Electron 二进制，本就不该走自动安装。
 */
function currentAppPath(): string {
  return process.execPath
}

/**
 * macOS 安装：zip 解压 → 替换 .app → 重启。
 *
 * 下载的 zip 解压后含 `Corum-<ver>.app`。当前 .app 的父目录 = `dirname(dirname(dirname(execPath)))`
 * （execPath = .app/Contents/MacOS/name → 上三层到 .app）。
 */
function installDarwin(downloadedPath: string): InstallUpdateResult {
  if (!downloadedPath.endsWith('.zip')) {
    return { ok: false, error: `darwin auto-install requires a .zip asset, got: ${downloadedPath}` }
  }
  // **安装前先验包**：坏 zip 一旦进入脚本，应用就必须先退出才有机会失败，
  // 那时用户看到的是「应用不见了」而不是「更新没装上」。在这里用 `unzip -t`
  // 做一次完整性检查，失败就返回 ok:false，让调用方正常启动旧版。
  // 这一步很便宜（只读校验，不做替换），却把最坏情况从「失去应用」降级为
  // 「这次没更新」。
  // `unzip -t` 在包损坏时**非零退出**（execFileSync 会抛），所以必须 try/catch
  // 而不是只看输出内容 —— 否则这里抛出的异常会让整个启动流程崩掉，
  // 恰好制造出它本来要防止的那种「应用起不来」。
  //
  // ⚠️ `maxBuffer` 必须放大：`unzip -t` 会为**每个文件**打印一行测试结果，
  // 300MB 的包轻松超过 1MB 默认上限，导致 `ENOBUFS` 以状态码 80 失败。
  // 实测（2026-10-17）：默认 buffer 下这个「完整性校验」对**完好的包**也报失败，
  // 于是每个更新都会被拒绝 —— 比不做校验更糟。
  try {
    const integrity = execFileSync('unzip', ['-t', downloadedPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 256 * 1024 * 1024,
    })
    if (!integrity.includes('No errors detected')) {
      return { ok: false, error: 'downloaded zip failed integrity check' }
    }
  } catch {
    return { ok: false, error: 'downloaded zip failed integrity check' }
  }
  const workDir = mkdtempSync(join(tmpdir(), 'corum-update-'))
  // 脚本：等 app 退出 → 解压 → 替换 → 重启 → 清理。
  // 解压到临时目录取 .app，rm -rf 旧 .app，cp -R 新 .app 到旧位置。
  const execPath = currentAppPath()
  // .app 路径 = Contents/MacOS/name → 上两层 Contents → 再上一层 .app
  const currentAppBundle = dirname(dirname(dirname(execPath)))
  const parentDir = dirname(currentAppBundle)
  const appName = currentAppBundle.split('/').pop() ?? 'Corum.app'
  const script = `#!/bin/bash
# corum auto-update install script (darwin)
set -e
# 等待 app 退出（最长 60s）
for i in $(seq 1 120); do
  if ! pgrep -f "${process.execPath}" > /dev/null 2>&1; then break; fi
  sleep 0.5
done
sleep 1
# 解压到临时目录
UNZIP_DIR="${workDir}"
unzip -o -q "${downloadedPath}" -d "$UNZIP_DIR"
# 找解压出的 .app。**不限定深度**：electron-builder 默认把 Corum.app 放在归档
# 根目录，但中间层目录会多出一层。原先的 -maxdepth 1 遇到多一层就静默失败
# （"no .app found"），而用户只会看到应用消失。
# 取路径最短的那个 —— 防止误取 .app 内部的嵌套 bundle（如 Helper.app）。
NEW_APP=$(find "$UNZIP_DIR" -name "*.app" -type d | awk '{ print length, $0 }' | sort -n | cut -d' ' -f2- | head -1)
if [ -z "$NEW_APP" ]; then
  echo "no .app found in zip" >&2
  rm -rf "$UNZIP_DIR"
  exit 1
fi
# 替换：**先备份再替换**，失败即回滚。
#
# 原实现是 rm -rf 旧.app 之后 cp -R 新.app。在 set -e 下，一旦 cp 失败
# （磁盘满、权限、新包损坏），脚本中止且**旧 .app 已经被删掉** —— 用户下次点
# 图标会发现应用根本不存在，且没有任何自动恢复路径。
# 改为：把旧 .app 移到备份名 → 复制新的到位 → 成功后删备份；任何一步失败都把
# 备份移回来，保证「最坏情况仍是旧版本可用」。
BACKUP="${currentAppBundle}.old-$$"
mv "${currentAppBundle}" "$BACKUP"
if ! cp -R "$NEW_APP" "${currentAppBundle}"; then
  echo "copy failed, rolling back" >&2
  rm -rf "${currentAppBundle}"
  mv "$BACKUP" "${currentAppBundle}"
  rm -rf "$UNZIP_DIR"
  exit 1
fi
# 复制成功：删备份 + 清理临时目录与下载文件
rm -rf "$BACKUP"
rm -rf "$UNZIP_DIR"
rm -f "${downloadedPath}"
# 重启
open "${parentDir}/${appName}"
`
  return runDetachedScript(script, workDir, '.sh')
}

/**
 * Windows 安装：NSIS exe 静默安装 + 重启。
 * electron-builder 的 NSIS 安装器支持 `/S`（静默）与 runAfterFinish。
 */
function installWin32(downloadedPath: string): InstallUpdateResult {
  if (!downloadedPath.endsWith('.exe')) {
    return { ok: false, error: `win32 auto-install requires a .exe asset, got: ${downloadedPath}` }
  }
  // 直接 spawn 安装器（detached），它会在 app 退出后接管。
  // NSIS 安装器检测到旧版本在跑会等退出；/S 静默安装；--restart 重启。
  try {
    const child = spawn(downloadedPath, ['/S', '--restart'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => { /* 脚本接管，忽略 */ })
    child.unref()
    // 给安装器一秒初始化，然后退出 app。
    setTimeout(() => { app.quit() }, 1000)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `failed to spawn installer: ${msg}` }
  }
}

/**
 * Linux 安装：AppImage 替换 + 重启。
 */
function installLinux(downloadedPath: string): InstallUpdateResult {
  const execPath = currentAppPath()
  // issue #151：**在起替换脚本之前**判定能不能装。
  //
  // 旧实现在这里只查资产后缀，然后无条件起脚本；脚本里 `setTimeout(app.quit)` 已经把应用
  // 退掉了，于是 deb 形态（`/opt/Corum`，属主 root）的真实结果是：应用消失、`cp` 撞 EACCES、
  // 回滚 `exit 1`、版本没变、**零提示**。判定前置后，失败路径连应用都不退出。
  let dirWritable = false
  try {
    accessSync(dirname(execPath), constants.W_OK)
    dirWritable = true
  } catch {
    dirWritable = false
  }
  const blocked = linuxInstallBlocker({
    downloadedPath,
    execPath,
    dirWritable,
    appImageEnv: process.env.APPIMAGE,
  })
  if (blocked !== undefined) return { ok: false, error: blocked }
  const workDir = mkdtempSync(join(tmpdir(), 'corum-update-'))
  const script = `#!/bin/bash
# corum auto-update install script (linux)
set -e
# 等待 app 退出
for i in $(seq 1 120); do
  if ! pgrep -f "${execPath}" > /dev/null 2>&1; then break; fi
  sleep 0.5
done
sleep 1
# 替换 AppImage：先备份再替换，失败即回滚（与 darwin 同款理由 —— 直接 cp 覆盖
# 一旦失败，用户就没有可运行的二进制了）。
BACKUP="${execPath}.old-$$"
cp -f "${execPath}" "$BACKUP"
if ! cp -f "${downloadedPath}" "${execPath}"; then
  echo "replace failed, rolling back" >&2
  cp -f "$BACKUP" "${execPath}"
  rm -f "$BACKUP"
  exit 1
fi
chmod +x "${execPath}"
rm -f "$BACKUP"
# 清理下载文件
rm -f "${downloadedPath}"
# 重启
nohup "${execPath}" > /dev/null 2>&1 &
`
  return runDetachedScript(script, workDir, '.sh')
}

/**
 * 写脚本到临时文件 → chmod +x → detached spawn → unref → 延迟 quit。
 */
function runDetachedScript(script: string, workDir: string, ext: string): InstallUpdateResult {
  const scriptPath = join(workDir, `corum-update-install${ext}`)
  writeFileSync(scriptPath, script, { mode: 0o755 })
  try {
    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => { /* 脚本接管，忽略 */ })
    child.unref()
    // 给脚本一秒初始化，然后退出 app（脚本会等 app 退出再替换）。
    setTimeout(() => { app.quit() }, 1000)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* noop */ }
    return { ok: false, error: `failed to spawn install script: ${msg}` }
  }
}
