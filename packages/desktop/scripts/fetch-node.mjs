/**
 * corum-desktop 打包脚本（阶段 2：物化 Node 运行时）。
 *
 * 宿主子进程需要真 Node（Electron 内嵌 Node 无法 boot 宿主树），
 * 打包时把它作为 extraResources 打进应用包的 Resources/node。
 *
 * 来源：从 nodejs.org 官方源（或 NODE_MIRROR 覆盖的镜像）下载并解压。
 *   - darwin/linux：node-v{ver}-{platform}-{arch}.tar.gz / .tar.xz
 *   - win32：node-v{ver}-win-{arch}.zip（nodejs 不提供 win 的 tar.gz）
 *
 * 平台与架构默认取自**当前运行环境**（`process.platform` / `process.arch`），
 * 可用 `CORUM_NODE_PLATFORM` / `CORUM_NODE_ARCH` 显式覆盖（交叉物化时用；
 * 注意跨平台物化只在「产物与运行环境同平台」时才有意义）。
 *
 * 用法：node packages/desktop/scripts/fetch-node.mjs [node-version] [--platform=win32] [--arch=x64]
 * 环境变量：
 *   NODE_MIRROR          node 下载镜像根（如 https://registry.npmmirror.com/-/binary/node）
 *   CORUM_NODE_PLATFORM  覆盖平台（darwin|linux|win32）
 *   CORUM_NODE_ARCH      覆盖架构（arm64|x64）
 *
 * **交叉物化必须显式指定平台**：默认取**运行环境**的 `process.platform`，所以在 Mac 上
 * 跑 Windows/Linux 的打包链会静默取到 darwin 的 Node 塞进包里（实测：`pack:win` 在
 * macOS 上产出的包里 `resources/node/bin/node` 是 Mach-O）。各平台的 `pack:*` 脚本因此
 * 都显式传 `--platform`；用 flag 而不是 `VAR=… cmd` 前缀，因为后者是 bash 语法、
 * 在 Windows `cmd` 下不生效（而这些脚本正是 Windows 主机要跑的）。
 * @module corum-desktop/scripts/fetch-node
 */

import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..', '..', '..')
/** desktop 包根（脚本位置推导——2026-09 重命名后 packages/shell 已不存在）。 */
const DESKTOP_ROOT = resolve(import.meta.dirname, '..')
const NODE_DIR = join(DESKTOP_ROOT, 'build', 'node')

const DEFAULT_VERSION = 'v26.4.0'

/**
 * nodejs.org 的归档命名把「平台」写成 `win`（而非 `win32`），且 Windows 只有 zip。
 * @param platform - `process.platform` 取值。
 * @returns nodejs.org 归档名里的平台段与归档扩展名。
 */
function nodeArchiveKind(platform) {
  if (platform === 'win32') return { slug: 'win', ext: 'zip' }
  if (platform === 'darwin') return { slug: 'darwin', ext: 'tar.gz' }
  if (platform === 'linux') return { slug: 'linux', ext: 'tar.gz' }
  throw new Error(`fetch-node: 不支持的平台 ${platform}（darwin|linux|win32）`)
}

async function run(label, command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${label} exited ${code}`))))
  })
}

/** 用系统 tar 解压（tar.gz）；zip 走 unzip。两者各平台都有对应实现。 */
async function extract(archive, ext, into) {
  if (ext === 'zip') {
    await run('extract node', 'unzip', ['-q', '-o', archive, '-d', into])
    return
  }
  await run('extract node', 'tar', ['-xzf', archive, '-C', into])
}

/**
 * Parse `--platform=` / `--arch=` flags and the optional positional version.
 *
 * Flags exist alongside the env vars because the packaging scripts must pin the
 * target platform *portably*: `CORUM_NODE_PLATFORM=win32 node …` is bash syntax
 * and does not work under Windows `cmd`, while these scripts are the ones a
 * Windows host runs.
 * @param argv - `process.argv.slice(2)`.
 * @returns The resolved version, platform, and arch.
 */
function parseArgs(argv) {
  let version = DEFAULT_VERSION
  let platform = process.env.CORUM_NODE_PLATFORM ?? ''
  let arch = process.env.CORUM_NODE_ARCH ?? ''
  for (const arg of argv) {
    if (arg.startsWith('--platform=')) platform = arg.slice('--platform='.length)
    else if (arg.startsWith('--arch=')) arch = arg.slice('--arch='.length)
    else if (!arg.startsWith('--')) version = arg
  }
  return {
    version,
    platform: platform === '' ? process.platform : platform,
    arch: arch === '' ? process.arch : arch,
  }
}

async function main() {
  const { version, platform, arch } = parseArgs(process.argv.slice(2))
  const { slug, ext } = nodeArchiveKind(platform)

  await rm(NODE_DIR, { recursive: true, force: true })
  await mkdir(join(DESKTOP_ROOT, 'build'), { recursive: true })

  const name = `node-${version}-${slug}-${arch}`
  const mirror = (process.env.NODE_MIRROR ?? 'https://nodejs.org/dist').replace(/\/$/, '')
  const url = `${mirror}/${version}/${name}.${ext}`
  const archive = join(DESKTOP_ROOT, 'build', `${name}.${ext}`)

  if (!existsSync(archive)) {
    console.log(`[fetch-node] downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch-node: HTTP ${response.status} for ${url}`)
    await pipeline(response.body, createWriteStream(archive))
  } else {
    console.log(`[fetch-node] using cached ${archive}`)
  }

  await extract(archive, ext, join(DESKTOP_ROOT, 'build'))
  // 用 fs.rename 而不是 `mv`：Windows 上没有 POSIX `mv`，且同盘重命名是原子的。
  await rename(join(DESKTOP_ROOT, 'build', name), NODE_DIR)
  console.log(`[fetch-node] node runtime staged at ${NODE_DIR} (${slug}-${arch})`)
}

await main().catch((error) => {
  console.error(error)
  process.exit(1)
})
