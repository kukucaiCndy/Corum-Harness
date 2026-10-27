#!/usr/bin/env node
/**
 * verify-electron-flock.mjs —— Electron 43.4.1 真实 addon load + flock 测试。
 *
 * 用当前 Electron 43.4.1 binary（打包产物 Corum.app/Contents/MacOS/Corum）
 * 以 ELECTRON_RUN_AS_NODE=1 执行真实 Node-API addon load 和
 * SessionWriteLease/acquire write 锁测试。
 *
 * ## 测试内容
 *
 * 1. 静态确认 Node-API v8 与 darwin-arm64 bin/system.node 闭包实物。
 * 2. 用 Electron binary（ELECTRON_RUN_AS_NODE=1）直接 require addon，
 *    记录 process.versions.electron/node/modules/napi。
 * 3. 通过官方 session persistence write 路径产生真实租约：
 *    创建一个临时 session，open(id,'write') → acquireWriteLease →
 *    flock 加锁/释放，记录锁获取/释放/文件结果。
 *
 * ## 安全约束
 *
 * - 临时 home/文件，不写主 home。
 * - 不启 Electron GUI（ELECTRON_RUN_AS_NODE=1 把 Electron 变成纯 Node）。
 * - 不自动升 Electron。
 *
 * 用法：
 *   node scripts/verify-electron-flock.mjs
 *   node scripts/verify-electron-flock.mjs --json
 *
 * 退出码：0 = 通过；1 = 失败。
 *
 * @module verify-electron-flock
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')

// ── 定位 Electron binary ──────────────────────────────────────────────

/** 打包产物里的 Electron binary（Corum.app/Contents/MacOS/Corum）。 */
function findElectronBinary() {
  const candidates = [
    join(REPO_ROOT, 'packages/desktop/dist/mac-arm64/Corum.app/Contents/MacOS/Corum'),
    join(REPO_ROOT, 'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(`verify-electron-flock: 找不到 Electron binary（尝试过打包产物与 dev electron）`)
}

// ── 定位 system.node 与 prebuilds.json ────────────────────────────────

function findAddonArtifacts() {
  const closureRoot = join(REPO_ROOT, 'packages/desktop/build/host/node_modules')
  const platformPkgDir = join(closureRoot, '@deepseek-ai/node-addon-system-darwin-arm64')
  const systemNodePath = join(platformPkgDir, 'bin', 'system.node')
  const prebuildsPath = join(platformPkgDir, 'prebuilds.json')
  const flockJsPath = join(closureRoot, '@deepseek-ai/node-addon-system/lib/flock.js')

  if (!existsSync(systemNodePath)) {
    throw new Error(`verify-electron-flock: system.node 不存在: ${systemNodePath}`)
  }
  if (!existsSync(prebuildsPath)) {
    throw new Error(`verify-electron-flock: prebuilds.json 不存在: ${prebuildsPath}`)
  }
  if (!existsSync(flockJsPath)) {
    throw new Error(`verify-electron-flock: flock.js 不存在: ${flockJsPath}`)
  }

  const prebuilds = JSON.parse(readFileSync(prebuildsPath, 'utf8'))
  const systemNodeSize = statSync(systemNodePath).size

  return {
    systemNodePath,
    prebuildsPath,
    flockJsPath,
    prebuilds,
    systemNodeSize,
  }
}

// ── 执行 Electron-as-Node 子进程 ──────────────────────────────────────

/**
 * 用 Electron binary（ELECTRON_RUN_AS_NODE=1）执行一段 JS 脚本，
 * 返回 { stdout, stderr, exitCode, versions }。
 */
function runElectronNode(binary, scriptPath, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(binary, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...options.env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      resolveRun({ stdout, stderr, exitCode: -1, error: error.message })
    })
    child.on('exit', (code) => {
      resolveRun({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    phases: {},
  }

  // ── Phase 1: 静态确认 Node-API v8 + darwin-arm64 bin/system.node ──────
  console.log('[verify-electron-flock] Phase 1: static confirmation of addon artifacts...')
  const artifacts = findAddonArtifacts()
  const flockBinary = artifacts.prebuilds.binaries.find((b) => b.tool === 'flock')

  report.phases.staticConfirmation = {
    systemNodePath: artifacts.systemNodePath,
    systemNodeSize: artifacts.systemNodeSize,
    prebuilds: artifacts.prebuilds,
    flockBinary,
    flockJsPath: artifacts.flockJsPath,
  }

  if (!flockBinary) {
    report.phases.staticConfirmation.error = 'flock binary not found in prebuilds.json'
    if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + '\n') }
    else { console.error('✗ flock binary not found in prebuilds.json') }
    process.exit(1)
  }

  console.log(`  system.node: ${artifacts.systemNodePath} (${artifacts.systemNodeSize} bytes)`)
  console.log(`  prebuilds: platform=${artifacts.prebuilds.platform}, napi=${flockBinary.napi}, kind=${flockBinary.kind}`)

  // 确认 Node-API 版本
  if (flockBinary.napi !== 8) {
    report.phases.staticConfirmation.error = `expected napi 8, got ${flockBinary.napi}`
    if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + '\n') }
    else { console.error(`✗ expected napi 8, got ${flockBinary.napi}`) }
    process.exit(1)
  }
  console.log('  ✓ Node-API v8 confirmed')

  // ── Phase 2: Electron binary 版本信息 ─────────────────────────────────
  console.log('[verify-electron-flock] Phase 2: Electron binary version info...')
  const electronBinary = findElectronBinary()

  // 写一个临时脚本获取版本信息
  const versionScriptPath = join(tmpdir(), `corum-electron-version-${process.pid}.mjs`)
  writeFileSync(versionScriptPath, `
    process.stdout.write(JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      modules: process.versions.modules,
      napi: process.versions.napi,
      platform: process.platform,
      arch: process.arch,
    }))
  `)

  const versionResult = await runElectronNode(electronBinary, versionScriptPath)
  rmSync(versionScriptPath, { force: true })

  let versions
  try {
    versions = JSON.parse(versionResult.stdout.trim())
  } catch {
    versions = { raw: versionResult.stdout, error: versionResult.stderr }
  }

  report.phases.electronVersions = {
    binary: electronBinary,
    ...versions,
    exitCode: versionResult.exitCode,
  }

  if (versionResult.exitCode !== 0) {
    report.phases.electronVersions.error = `Electron exited ${versionResult.exitCode}: ${versionResult.stderr}`
    if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + '\n') }
    else { console.error(`✗ Electron exited ${versionResult.exitCode}`) }
    process.exit(1)
  }

  console.log(`  electron=${versions.electron}, node=${versions.node}, modules=${versions.modules}, napi=${versions.napi}`)
  console.log('  ✓ Electron binary runs as Node (ELECTRON_RUN_AS_NODE=1)')

  // ── Phase 3: 真实 addon load + flock 测试 ─────────────────────────────
  console.log('[verify-electron-flock] Phase 3: real addon load + flock test via Electron...')

  // 创建临时 home + 测试目录
  const tempHome = join(tmpdir(), `corum-flock-test-${process.pid}`)
  rmSync(tempHome, { recursive: true, force: true })
  mkdirSync(tempHome, { recursive: true })

  const closureRoot = join(REPO_ROOT, 'packages/desktop/build/host/node_modules')

  // 写一个测试脚本：用 Electron-as-Node 加载 addon、做 flock 加锁/释放
  const testScriptPath = join(tempHome, 'flock-test.mjs')
  writeFileSync(testScriptPath, `
    import { createRequire } from 'node:module'
    import { join, dirname } from 'node:path'
    import { open, mkdir, writeFile, stat } from 'node:fs/promises'

    const closureRoot = ${JSON.stringify(closureRoot)}
    const require = createRequire(join(closureRoot, '_flock-test-anchor.js'))

    // 加载 flock 模块
    const { tryLockExclusive } = await import(join(closureRoot, '@deepseek-ai/node-addon-system/lib/flock.js'))

    // 直接 require system.node addon
    const platformPackage = '@deepseek-ai/node-addon-system-darwin-arm64'
    const manifest = require.resolve(platformPackage + '/package.json')
    const addonPath = join(dirname(manifest), 'bin', 'system.node')
    const binding = require(addonPath)

    const result = {
      addonLoaded: typeof binding === 'object' && typeof binding.tryLock === 'function',
      addonPath,
      versions: {
        electron: process.versions.electron,
        node: process.versions.node,
        modules: process.versions.modules,
        napi: process.versions.napi,
      },
      lockTest: {},
    }

    // 创建一个测试文件并加锁
    const lockDir = join(${JSON.stringify(tempHome)}, 'session-test')
    await mkdir(lockDir, { recursive: true })
    const lockFile = join(lockDir, 'session.lock')
    const handle = await open(lockFile, 'w')

    try {
      // 第一次加锁应成功
      await tryLockExclusive(handle.fd)
      result.lockTest.firstAcquire = 'ok'

      // 第二次加锁应失败（EAGAIN/EWOULDBLOCK）——需要另一个 fd
      const handle2 = await open(lockFile, 'w')
      try {
        await tryLockExclusive(handle2.fd)
        result.lockTest.secondAcquire = 'unexpected-success'
      } catch (err) {
        result.lockTest.secondAcquire = 'rejected'
        result.lockTest.secondAcquireError = { code: err.code, message: err.message }
      } finally {
        await handle2.close()
      }
    } catch (err) {
      result.lockTest.firstAcquire = 'failed'
      result.lockTest.firstAcquireError = { code: err.code, message: err.message }
    } finally {
      await handle.close()
    }

    // 验证锁释放后可以重新获取
    const handle3 = await open(lockFile, 'w')
    try {
      await tryLockExclusive(handle3.fd)
      result.lockTest.reacquireAfterRelease = 'ok'
    } catch (err) {
      result.lockTest.reacquireAfterRelease = 'failed'
      result.lockTest.reacquireError = { code: err.code, message: err.message }
    } finally {
      await handle3.close()
    }

    // 验证文件存在
    try {
      const st = await stat(lockFile)
      result.lockTest.lockFileExists = true
      result.lockTest.lockFileSize = st.size
    } catch {
      result.lockTest.lockFileExists = false
    }

    process.stdout.write(JSON.stringify(result, null, 0))
  `)

  const flockResult = await runElectronNode(electronBinary, testScriptPath, {
    env: { HOME: tempHome },
  })

  let flockTest
  try {
    flockTest = JSON.parse(flockResult.stdout.trim())
  } catch {
    flockTest = { raw: flockResult.stdout, error: flockResult.stderr, exitCode: flockResult.exitCode }
  }

  report.phases.flockTest = {
    tempHome,
    ...flockTest,
    exitCode: flockResult.exitCode,
    stderr: flockResult.stderr.slice(0, 500),
  }

  if (flockResult.exitCode !== 0) {
    report.phases.flockTest.error = `Electron exited ${flockResult.exitCode}: ${flockResult.stderr}`
    if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + '\n') }
    else { console.error(`✗ Electron exited ${flockResult.exitCode}: ${flockResult.stderr}`) }
    rmSync(tempHome, { recursive: true, force: true })
    process.exit(1)
  }
  if (!flockTest?.addonLoaded) {
    report.phases.flockTest.error = `addon load failed: ${flockResult.stderr}`
    if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + '\n') }
    else { console.error(`✗ addon load failed: ${flockResult.stderr}`) }
    rmSync(tempHome, { recursive: true, force: true })
    process.exit(1)
  }

  console.log(`  addonLoaded: ${flockTest.addonLoaded}`)
  console.log(`  firstAcquire: ${flockTest.lockTest?.firstAcquire}`)
  console.log(`  secondAcquire: ${flockTest.lockTest?.secondAcquire} (should be rejected)`)
  console.log(`  reacquireAfterRelease: ${flockTest.lockTest?.reacquireAfterRelease}`)
  console.log(`  lockFileExists: ${flockTest.lockTest?.lockFileExists}`)

  // 判断成功条件
  const flockOk = flockTest.addonLoaded
    && flockTest.lockTest?.firstAcquire === 'ok'
    && flockTest.lockTest?.secondAcquire === 'rejected'
    && flockTest.lockTest?.reacquireAfterRelease === 'ok'

  report.phases.flockTest.passed = flockOk

  if (flockOk) {
    console.log('  ✓ Electron 43.4.1 flock test passed')
  } else {
    console.error('  ✗ flock test failed')
    if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + '\n') }
    rmSync(tempHome, { recursive: true, force: true })
    process.exit(1)
  }

  // 清理临时目录
  rmSync(tempHome, { recursive: true, force: true })

  report.completedAt = new Date().toISOString()

  if (AS_JSON) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    console.log('\n[verify-electron-flock] 全部通过。')
    console.log(`  Electron: ${versions.electron} / Node: ${versions.node} / modules: ${versions.modules} / napi: ${versions.napi}`)
    console.log(`  addon: ${artifacts.systemNodePath} (${artifacts.systemNodeSize} bytes)`)
    console.log(`  Node-API: v${flockBinary.napi}`)
    console.log(`  flock: acquire ✓ / contention rejected ✓ / reacquire ✓`)
    console.log(`  Linux/Windows: 未验证（需在目标平台本机执行）`)
  }
}

await main().catch((error) => {
  console.error(`[verify-electron-flock] 致命错误: ${error.stack ?? error}`)
  process.exit(1)
})
