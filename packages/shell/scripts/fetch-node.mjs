/**
 * corum-shell macOS 打包脚本（阶段 2：物化 Node 运行时）。
 *
 * 宿主子进程需要真 Node（Electron 内嵌 Node 无法 boot 宿主树），
 * 打包时把它作为 extraResources 打进 .app 的 Resources/node。
 *
 * 来源：从 nodejs.org 官方源（或 NODE_MIRROR 覆盖的镜像）下载
 *   node-v{ver}-darwin-arm64.tar.gz 解压。
 *
 * 用法：node packages/shell/scripts/fetch-node.mjs [node-version]
 * 环境变量：
 *   NODE_MIRROR   node 下载镜像根（如 https://registry.npmmirror.com/-/binary/node）
 * @module corum-shell/scripts/fetch-node
 */

import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..', '..', '..')
const NODE_DIR = join(root, 'packages', 'shell', 'build', 'node')

const DEFAULT_VERSION = 'v26.4.0'
const ARCH = 'arm64'
const PLATFORM = 'darwin'

async function run(label, command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${label} exited ${code}`))))
  })
}

async function main() {
  const version = process.argv[2] ?? DEFAULT_VERSION

  await rm(NODE_DIR, { recursive: true, force: true })
  await mkdir(join(root, 'packages', 'shell', 'build'), { recursive: true })

  const name = `node-${version}-${PLATFORM}-${ARCH}`
  const mirror = (process.env.NODE_MIRROR ?? 'https://nodejs.org/dist').replace(/\/$/, '')
  const url = `${mirror}/${version}/${name}.tar.gz`
  const tarGz = join(root, 'packages', 'shell', 'build', `${name}.tar.gz`)

  if (!existsSync(tarGz)) {
    console.log(`[fetch-node] downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch-node: HTTP ${response.status} for ${url}`)
    await pipeline(response.body, createWriteStream(tarGz))
  } else {
    console.log(`[fetch-node] using cached ${tarGz}`)
  }

  await run('extract node', 'tar', ['-xzf', tarGz, '-C', join(root, 'packages', 'shell', 'build')])
  await run('rename node dir', 'mv', [join(root, 'packages', 'shell', 'build', name), NODE_DIR])
  console.log('[fetch-node] node runtime staged at', NODE_DIR)
}

await main().catch((error) => {
  console.error(error)
  process.exit(1)
})
