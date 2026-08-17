/**
 * corum-shell macOS 打包脚本（阶段 1：物化宿主运行时闭包）。
 *
 * 产出 build/host/ —— 一个自包含、可 boot 的宿主子进程运行时目录：
 *   - 用 `pnpm deploy --legacy` 从 desktop-host 这个 dependency-only deploy 根
 *     物化 registry 版 host 闭包（跟随官方底座 0.1.0-rc.6），再叠加 corum-shell
 *     自己的 lib/cordis.patch.yml/package.json。
 *   - 物化遗留符号链接（deploy 产物里顶层包是指向 .pnpm 的 symlink）
 *   - 校验产物能被真 Node boot（输出 ready 即通过）
 *
 * 之后 electron-builder 把 build/host/ 作为 extraResources 打进 .app，
 * 附带一个 Node 运行时（fetch-node.mjs 下载）解压到 build/node/。
 *
 * 用法：node packages/shell/scripts/pack-macos.mjs
 * @module corum-shell/scripts/pack-macos
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..', '..')

/** 宿主运行时的 staging 目录 */
const HOST_DIR = join(root, 'packages', 'shell', 'build', 'host')
/** corum-shell 自身产物源（bridge.js 等已由 pnpm run build 产出） */
const DESKTOP_LIB = join(root, 'packages', 'shell', 'lib')
const DESKTOP_ROOT = join(root, 'packages', 'shell')
/** 前端 dist 源（@deepseek-ai/dsh-web-frontend 的构建产物；registry 依赖落在 shell 包 node_modules） */
const WEB_DIST = join(DESKTOP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
/** 前端 dist 在打包 staging 里的目标 */
const DIST_DIR = join(root, 'packages', 'shell', 'build', 'dist')
/**
 * dependency-only deploy 根：pnpm deploy 从这里物化 host 闭包。其依赖清单
 * = 官方 desktop-host 的 36 个 host 服务包 + preset 引用的 30 个包（agent.cordis.yml
 * 里 name: 的 @deepseek-ai/* 全量）+ designer preset 的 mcp-client + 3 个 fork 插件。
 * 全部 registry 版，跟随官方底座。
 */
const DEPLOY_ROOT = join(DESKTOP_ROOT, 'desktop-host')
/** 本仓库的 shipped agent-presets（开发态直接读此目录）。 */
const CORUM_PRESETS = join(root, '.agent-presets')
/** 官方 shipped agent-presets（已固化进本仓库，registry 无此包）。 */
const OFFICIAL_PRESETS = join(DESKTOP_ROOT, 'shipped-presets', 'official')
/** host 运行时里 shipped-presets 的 staging 目标。 */
const SHIPPED_PRESETS_DIR = join(HOST_DIR, 'shipped-presets')

async function run(label, command, args) {
  console.log(`[pack-macos] ${label}`)
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolveRun()
      else reject(new Error(`${label} exited ${code}`))
    })
  })
}

/** 递归查找 node_modules 下第一个符号链接 */
async function findSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const meta = await lstat(path)
    if (meta.isSymbolicLink()) return path
    if (meta.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** 把遗留符号链接物化为真实文件（照官方 build-exe-for-python-sdk 逻辑） */
async function materializeSymlinks(nodeModules) {
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const source = await realpath(remaining)
    const nested = join(source, 'node_modules')
    await rm(remaining, { recursive: true, force: true })
    await cp(source, remaining, {
      recursive: true,
      dereference: true,
      filter: path => path !== nested && !path.startsWith(nested + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

async function deployHost() {
  await rm(HOST_DIR, { recursive: true, force: true })
  await mkdir(HOST_DIR, { recursive: true })
  if (!existsSync(join(DEPLOY_ROOT, 'package.json'))) {
    throw new Error(`pack-macos: desktop-host deploy root missing at ${DEPLOY_ROOT} — it is a dependency-only deploy root`)
  }
  // pnpm deploy 物化 desktop-host 的完整 registry 闭包到一个临时目录，再把
  // 它的 node_modules 抄进 host 运行时。
  //
  // 官方 desktop 同款 flags 是正确性的关键：`--config.node-linker=hoisted` 让
  // deploy 把整个闭包（含 peer 依赖）平铺到顶层 node_modules（真实目录，只剩
  // .bin 的 symlink）。这正是 healProfilesModuleFallback 的 BFS 需要的布局——
  // 它用 createRequire(host/package.json).resolve.paths() 逐级向上解析裸插件名，
  // 缺 hoisted 时是 .pnpm 隔离布局，peer 依赖（如 dsh-llm 的 peer dsh-timeout）
  // 只藏在 .pnpm 嵌套目录里，profile 里的裸插件名会解析失败。
  const deployTmp = join(root, 'packages', 'shell', 'build', '.deploy-tmp')
  await rm(deployTmp, { recursive: true, force: true })
  await run('pnpm deploy desktop-host (hoisted registry closure)', 'pnpm', [
    '--filter', 'corum-desktop-host', 'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    deployTmp,
  ])
  if (!existsSync(join(deployTmp, 'node_modules'))) {
    throw new Error(`pack-macos: pnpm deploy produced no node_modules at ${deployTmp}`)
  }
  // pnpm deploy 会在 .pnpm/node_modules 里留下指向 workspace 的 self-link
  // symlink（corum-desktop-host、@corum/*、corum-shell 等），这些在独立 deploy 产物
  // 里是断链的，cp(dereference) 会 stat 失败。复制前清理掉它们。
  await cleanupBrokenSymlinks(join(deployTmp, 'node_modules'))
  await cp(join(deployTmp, 'node_modules'), join(HOST_DIR, 'node_modules'), { recursive: true, dereference: true })
  await rm(deployTmp, { recursive: true, force: true })
  console.log('[pack-macos] host closure materialized from registry')
}

/** 删除 node_modules 下所有断链 symlink（指向不存在的目标）。 */
async function cleanupBrokenSymlinks(dir) {
  let count = 0
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isSymbolicLink()) {
        try {
          await realpath(p)
        } catch {
          await rm(p, { force: true })
          count += 1
        }
      } else if (entry.isDirectory()) {
        await walk(p)
      }
    }
  }
  await walk(dir)
  if (count > 0) console.log(`[pack-macos] cleaned ${count} broken symlinks from deploy output`)
}

/**
 * 生成 host 运行时的 package.json（HOST manifest），每次 pack 时从两个事实源
 * 现场合成，绝无静态文件可漂移：
 *   - corum-shell 的身份 + `exports`：healProfilesModuleFallback 会把 app 名
 *     (`corum-shell`) 自链到 host 目录，plugin loader 再经 `exports` 解析
 *     `corum-shell/modules` / `corum-shell/connection` 子路径到 lib/；`dsh.client`
 *     声明也让其浏览器半体进入 __DSH_BOOT__ 图。
 *   - desktop-host 的 `dependencies`：heal 的 BFS 只遍历 host 闭包里真实存在的
 *     host 侧包（registry 0.1.0-rc.6），而不会遍历住在前端 dist 里的 client UI
 *     包（shell 自己的 dependencies 含 25 个 client UI 包，不能直接用）。
 */
async function writeHostManifest() {
  const shell = JSON.parse(await readFile(join(DESKTOP_ROOT, 'package.json'), 'utf8'))
  const deployRoot = JSON.parse(await readFile(join(DEPLOY_ROOT, 'package.json'), 'utf8'))
  const manifest = {
    name: shell.name,
    description: shell.description,
    version: shell.version,
    type: shell.type,
    private: shell.private,
    author: shell.author,
    main: shell.main,
    dsh: shell.dsh,
    exports: shell.exports,
    dependencies: deployRoot.dependencies,
  }
  await writeFile(join(HOST_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

/** 把 corum-shell 自身的运行产物复制进 host 目录 */
async function copyDesktopArtifacts() {
  const destLib = join(HOST_DIR, 'lib')
  await cp(DESKTOP_LIB, destLib, { recursive: true, dereference: true })
  await cp(join(DESKTOP_ROOT, 'cordis.patch.yml'), join(HOST_DIR, 'cordis.patch.yml'), { dereference: true })
  // IDE-mode overlay: a REQUIRED patch layer when the desktop mode resolves to
  // `ide` — its absence in the packaged layout would fail a `--ide` launch
  // (loadOverlayPatches throws on a missing file). Ship it beside the desktop patch.
  await cp(join(DESKTOP_ROOT, 'cordis.ide.patch.yml'), join(HOST_DIR, 'cordis.ide.patch.yml'), { dereference: true })
  await writeHostManifest()
  // Shipped agent-presets: stage both roots beside the host runtime so the
  // boot-time resolver finds them by the same relative anchors in the app.
  await rm(SHIPPED_PRESETS_DIR, { recursive: true, force: true })
  await mkdir(SHIPPED_PRESETS_DIR, { recursive: true })
  if (existsSync(CORUM_PRESETS)) {
    await cp(CORUM_PRESETS, join(SHIPPED_PRESETS_DIR, 'corum'), { recursive: true, dereference: true })
  }
  if (existsSync(OFFICIAL_PRESETS)) {
    await cp(OFFICIAL_PRESETS, join(SHIPPED_PRESETS_DIR, 'official'), { recursive: true, dereference: true })
  }
  // 前端 dist 独立 staging（electron-builder extraResources 用），不进 host。
  await rm(DIST_DIR, { recursive: true, force: true })
  await cp(WEB_DIST, DIST_DIR, { recursive: true, dereference: true })
  // Monaco language workers: stage the bundled iife scripts into the dist's
  // `monaco/` subdir so `corumapp://app/monaco/<name>.worker.js` resolves from the
  // same protocol handler that serves the rest of the frontend.
  const monacoWorkers = join(DESKTOP_ROOT, 'lib', 'workers')
  if (existsSync(monacoWorkers)) {
    await cp(monacoWorkers, join(DIST_DIR, 'monaco'), { recursive: true, dereference: true })
  }
}

/** 冒烟：用真 Node 跑 bridge，等它输出 ready 即通过 */
async function smokeBridge() {
  const bridge = join(HOST_DIR, 'lib', 'bridge.js')
  if (!existsSync(bridge)) throw new Error(`pack-macos: ${bridge} missing — run the corum-desktop build first`)
  const smokeHome = join(root, 'packages', 'shell', 'build', '.smoke-home')
  try {
    await new Promise((resolveSmoke, reject) => {
    // Redirect the harness home into the build staging tree (OUTSIDE host/ so
    // electron-builder does not bundle it into the .app): the real default
    // (~/.corum-shell) may be outside the sandbox's writable area, and the smoke
    // only needs to prove the closure boots — it must not touch the developer's
    // real desktop-home.
    const smokeHome = join(root, 'packages', 'shell', 'build', '.smoke-home')
      const child = spawn(process.execPath, [bridge], {
        cwd: HOST_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DSH_TELEMETRY_DISABLED: '1',
          CORUM_HOME: smokeHome,
          DSH_HOME: smokeHome,
        },
      })
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error('pack-macos: host bridge did not emit ready within 60s'))
      }, 60_000)
      let buf = ''
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString()
        if (!settled && buf.includes('"type":"ready"')) {
          settled = true
          clearTimeout(timer)
          child.kill()
          console.log('[pack-macos] host bridge boots OK (ready emitted)')
          resolveSmoke()
        }
      })
      child.stderr.on('data', (chunk) => process.stderr.write(chunk))
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        if (!settled && code !== 0) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`pack-macos: host bridge exited ${code} before ready`))
        }
      })
    })
  } finally {
    // The smoke boot materializes profile scaffolding (profiles/node_modules
    // symlinks) under the redirected home; drop it so it never leaks into the
    // host extraResource that electron-builder bundles.
    await rm(smokeHome, { recursive: true, force: true })
  }
}

async function main() {
  await deployHost()
  await copyDesktopArtifacts()
  await materializeSymlinks(join(HOST_DIR, 'node_modules'))
  await smokeBridge()
  console.log('[pack-macos] host runtime staged at', HOST_DIR)
}

await main().catch((error) => {
  console.error(error)
  process.exit(1)
})
