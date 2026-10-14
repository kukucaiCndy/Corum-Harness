/**
 * corum-desktop 打包脚本（阶段 2b：物化便携版 Git 运行时）。
 *
 * corum 运行时依赖 git（工作区 git init/status/commit、dubious-ownership 等）。
 * 干净系统没装 git 时 spawn('git') 报 ENOENT。打包时把便携版 Git 打进
 * extraResources，host 启动时把它的 bin 加到 PATH。
 *
 * 来源：
 *   - win32：Git for Windows 的 PortableGit-{ver}-64-bit.7z.exe（自解压 7z）
 *     从 https://github.com/git-for-windows/git/releases/download/ 下载
 *   - darwin/linux：系统自带 git（Xcode CLT / apt），不需打包（跳过）
 *
 * 用法：node packages/desktop/scripts/fetch-git.mjs [--platform=win32] [--arch=x64]
 *
 * @module corum-desktop/scripts/fetch-git
 */

import { createWriteStream, existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, rename } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'

const DESKTOP_ROOT = resolve(import.meta.dirname, '..')
const GIT_DIR = join(DESKTOP_ROOT, 'build', 'git')

/** Git for Windows 版本（与官方 release 对齐）。 */
const GIT_VERSION = '2.50.1'

/**
 * 解析 --platform / --arch 参数。
 */
function parseArgs() {
  const platform = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1] ?? process.platform
  const arch = process.argv.find(a => a.startsWith('--arch='))?.split('=')[1] ?? process.arch
  return { platform, arch }
}

/**
 * 下载文件（支持重定向）。
 */
async function download(url, dest) {
  process.stderr.write(`[fetch-git] downloading ${url}\n`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const { writeFileSync } = await import('node:fs')
  writeFileSync(dest, buf)
  process.stderr.write(`[fetch-git] downloaded ${buf.length} bytes → ${dest}\n`)
}

async function main() {
  const { platform } = parseArgs()

  // 非 Windows：系统自带 git，跳过（不打包）
  if (platform !== 'win32') {
    process.stderr.write('[fetch-git] 非 win32 平台，系统自带 git，跳过\n')
    // 写一个空目录占位（extraResources 需要存在）
    await mkdir(GIT_DIR, { recursive: true })
    return
  }

  // 清理旧产物
  await rm(GIT_DIR, { recursive: true, force: true })
  await mkdir(GIT_DIR, { recursive: true })

  const archSuffix = '64-bit'
  const filename = `PortableGit-${GIT_VERSION}-${archSuffix}.7z.exe`
  // 优先 npmmirror 镜像（国内/CI 快），回退 GitHub 官方源。
  const GIT_MIRROR = process.env.GIT_MIRROR ?? 'https://registry.npmmirror.com/-/binary/git-for-windows'
  const url = `${GIT_MIRROR}/v${GIT_VERSION}.windows.1/${filename}`
  const archivePath = join(GIT_DIR, filename)

  // 下载
  await download(url, archivePath)

  // 7z 自解压：用 7z 解压（macOS 上用 7zz 或系统 7z）
  // PortableGit 的 .7z.exe 是自解压包，但跨平台不能直接运行 exe
  // 改用 7z 命令解压
  process.stderr.write('[fetch-git] extracting...\n')
  const sevenZip = (() => {
    for (const cmd of ['7zz', '7z', '/opt/homebrew/bin/7zz']) {
      const r = spawnSync(cmd, ['--help'], { stdio: 'ignore' })
      if (r.status === 0) return cmd
    }
    return null
  })()

  if (sevenZip !== null) {
    const result = spawnSync(sevenZip, ['x', archivePath, `-o${GIT_DIR}`, '-y'], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`7z extract failed (exit ${result.status})`)
  } else {
    // 没有 7z：尝试用 node 的 7z 库或直接用 tar（macOS tar 支持 7z？不行）
    // 备用：下载 7z for mac
    throw new Error('需要 7z 命令来解压 PortableGit（brew install p7zip）')
  }

  // 删除下载的归档
  await rm(archivePath, { force: true })

  // 验证：git.exe 在 Git/bin/ 或 cmd/
  const gitExe = join(GIT_DIR, 'bin', 'git.exe')
  const gitCmd = join(GIT_DIR, 'cmd', 'git.exe')
  if (!existsSync(gitExe) && !existsSync(gitCmd)) {
    // 看目录结构
    const entries = await readdirSync(GIT_DIR)
    throw new Error(`git.exe 未找到！目录内容: ${entries.join(', ')}`)
  }

  process.stderr.write(`[fetch-git] ✅ 便携版 Git ${GIT_VERSION} 物化到 ${GIT_DIR}\n`)
}

main().catch(error => {
  process.stderr.write(`[fetch-git] FATAL: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
