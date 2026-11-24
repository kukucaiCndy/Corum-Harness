/**
 * macOS 自动更新：**安装脚本生成器**（纯函数，不 import electron）。
 *
 * ## 为什么单独成模块（2026-11-24 紧急发布）
 *
 * 这段脚本的两种失败形态都是用户级灾难，而它原先内联在 `installDarwin()` 里
 * —— 而那个文件 `import { app } from 'electron'`，在 node 测试环境里加载即失败，
 * 于是**只能靠真装一遍才发现问题**（0.8.2 就是这么漏出去的）。
 *
 * 1. **不清 quarantine** ⇒ 升级后弹「Corum 已损坏，无法打开」（本次事故）；
 * 2. **先删后拷**（而非先备份）⇒ `cp` 失败时旧 .app 已消失，用户失去应用。
 *
 * 抽成不依赖 electron 的纯函数后，这两条都能进单测（见
 * `tests/update-install-darwin-script.test.mjs`），与 `update-install-target.ts`
 * 的既有做法一致。
 *
 * @module corum-desktop/electron/darwin-install-script
 */

/**
 * 生成 macOS 自动更新的安装脚本（纯函数，便于单测）。
 *
 * 为什么抽出来：这段脚本里有两个**只有在真机装一遍才能发现**的性质，而它们都是
 * 事故换来的 ——
 *
 * 1. **必须先备份再替换**（否则 `cp` 失败时旧 .app 已被删，用户失去应用）；
 * 2. **必须清 quarantine**（2026-11-24 事故）：更新包从网络下载即带
 *    `com.apple.quarantine`，`unzip` 会把该属性复制到解压出的 .app 每个文件上
 *    （实测 0.8.2 有 28428 个）。本应用是 ad-hoc/linker-signed、无 Developer ID，
 *    Gatekeeper 验不了签名 ⇒ 首次启动弹「Corum 已损坏，无法打开」。
 *
 * 抽成纯函数后，这两条都能用字符串断言钉住，不必真装一遍才发现漏了。
 *
 * @param options - 路径与工作目录（全部显式传入，不读模块级状态）。
 * @returns 可直接交给 bash 执行的脚本文本。
 */
export function darwinInstallScript(options: {
  /** 当前正在运行的宿主可执行文件（用于等它退出）。 */
  execPath: string
  /** 解压用的临时目录。 */
  workDir: string
  /** 下载好的更新 zip 绝对路径。 */
  downloadedPath: string
  /** 当前 .app 包路径。 */
  currentAppBundle: string
  /** .app 的父目录（重启时用）。 */
  parentDir: string
  /** .app 的文件名。 */
  appName: string
}): string {
  const { execPath, workDir, downloadedPath, currentAppBundle, parentDir, appName } = options
  return `#!/bin/bash
# corum auto-update install script (darwin)
set -e
# 等待 app 退出（最长 60s）
for i in $(seq 1 120); do
  if ! pgrep -f "${execPath}" > /dev/null 2>&1; then break; fi
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
# 清 quarantine（2026-11-24 紧急修复，**必须在重启之前**）。
#
# 更新包从网络下载即带 com.apple.quarantine，unzip 会把该属性沿目录树复制到
# 解压出的 .app 的每个文件上（实测 0.8.2 有 28428 个）。本应用是
# ad-hoc/linker-signed、无 Developer ID，Gatekeeper 无法验证签名 ⇒ 首次启动
# 弹「Corum 已损坏，无法打开」。不签名的前提下这是唯一可行的清法。
#
# 失败不致命：|| true 让权限异常（如 .app 在只读卷）不至于把已成功的安装回滚。
xattr -cr "${currentAppBundle}" 2>/dev/null || true
# 重启
open "${parentDir}/${appName}"
`
}
