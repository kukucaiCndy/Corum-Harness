#!/usr/bin/env node
/**
 * assert-packaged-boot.mjs —— **产物级宿主启动断言**（三平台通用，无 GUI 依赖）。
 *
 * ## 它解决什么问题（2026-10-12 白屏事故的直接对策）
 *
 * 那天交叉打出的 Windows 包在真机上**白屏、应用完全起不来**，而打包链**全程绿灯**：
 *
 *   - `pack-macos.mjs` 的 `smokeBridge()` 用**宿主**的 Node 去 boot 闭包 ⇒ 交叉时验的是
 *     宿主平台，打印了 `host bridge boots OK` —— **假绿**；
 *   - `corum-smoke.mjs` 的 `checkNodeRuntimePlatform()` 只看 `build/node` **一个**二进制，
 *     扫不到闭包内平台专属依赖的缺失；
 *   - `verify-electron-pin.mjs` 交叉定向时**明确跳过**二进制身份校验。
 *
 * 三道守卫在交叉路径上都不设防。而真因其实**极易观测**：把产物里的宿主桥**直接跑一次**，
 * 它当场 exit 1 并打印 `plugin tree failed to load` + 三条缺失包名。本脚本就是把
 * 「手工做的这一下」固化成一条可复跑、可进 CI 的断言。
 *
 * ## 判据（为什么是这三条而不是「能起窗口」）
 *
 *   ① 宿主桥进程 **exit 0**；
 *   ② stdout 出现 **`{"type":"ready"`**（宿主真正挂完插件树才发这个信号）；
 *   ③ stderr **不含**已知的致命启动行（`plugin tree failed to load` 等）。
 *
 * 这三条**不依赖 GUI / 显示器 / 沙箱**，所以在无头的 CI runner 上也能跑——这正是它比
 * `--packaged --launch` 更该进每次出包的原因。2026-10-12 的三类缺陷（sharp /
 * node-addon-require-builtin / ripgrep）**任意一个残留都会让它失败**（已实测）。
 *
 * ## 为什么用「产物自带的 Node」而不是 `process.execPath`
 *
 * 用宿主的 Node 会重演 `smokeBridge()` 的假绿。本脚本优先用产物内的
 * `resources/node/(node|node.exe)`；**取不到就 fail（不是 skip）**——因为取不到本身
 * 就意味着产物残缺（`pack:node` 没跑或跑错平台）。
 *
 * ## 用法
 *
 *   node scripts/assert-packaged-boot.mjs                      # 自动探测产物（当前平台）
 *   node scripts/assert-packaged-boot.mjs --platform=win32 --arch=x64
 *   node scripts/assert-packaged-boot.mjs --dir=<解包后的 resources 目录>
 *   node scripts/assert-packaged-boot.mjs --json
 *
 * 退出码：0 = 通过；1 = 断言失败（含原因）；2 = 用法/环境错误（找不到产物）。
 *
 * @module assert-packaged-boot
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const AS_JSON = argv.includes('--json')
const TARGET_PLATFORM = arg('platform', process.platform)
const TARGET_ARCH = arg('arch', process.arch)

/** 已知的致命启动行：出现任意一条即判失败（源自主机 2026-10-12 实测的错误原文）。 */
const FATAL_LINES = [
  'plugin tree failed to load',
  'loader entries failed to apply',
  'Could not load the "sharp" module',
  'Cannot find package', // 覆盖 `Cannot find package 'corum-desktop'`
  'No usable native binding found', // 覆盖 node-addon-require-builtin
  'master key is unavailable',
  'safeStorage unavailable',
]

function fail(message) {
  report({ ok: false, reason: message })
  process.exit(1)
}
function usageError(message) {
  report({ ok: false, reason: message })
  process.exit(2)
}
function report(payload) {
  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  if (payload.ok) {
    console.log(`✓ 产物宿主启动断言通过（${payload.platform}-${payload.arch}）`)
    console.log(`    产物 Node：${payload.node}`)
    console.log(`    宿主桥：   ${payload.bridge}`)
    console.log(`    ready 信号：${payload.readyUrl ?? '(已出现 "type":"ready"'}`)
    return
  }
  console.error('✗ 产物宿主启动断言失败')
  console.error(`    ${payload.reason}`)
  for (const line of payload.fatalLines ?? []) console.error(`    [致命行] ${line}`)
  if (payload.tail !== undefined && payload.tail !== '') {
    console.error('    ── 进程输出（尾部） ──')
    for (const line of String(payload.tail).split('\n').slice(-25)) console.error(`    ${line}`)
  }
}

/**
 * 定位「解包后的 resources 目录」，各平台布局不同。
 *
 * ⚠️ 目录名**不是**统一的「平台-架构-unpacked」形态（2026-10-12 从打包日志核实）：
 *   - macOS：`dist/mac-<arch>/Corum.app/Contents/Resources`（**带 arch**）
 *   - Windows：`dist/win-unpacked/resources`（**不带 arch**）
 *   - Linux：`dist/linux-unpacked/resources`（不带 arch；electron-builder 默认）
 * 故先试实测确认过的名字，再退回带-arch 变体，最后兜底扫 dist。
 * 也接受直接指向解包目录或 resources 目录的 `--dir`。
 * @returns resources 目录绝对路径。
 */
function findResourcesDir() {
  const explicit = arg('dir', undefined)
  if (explicit !== undefined) {
    const d = resolve(explicit)
    // 允许传：resources 本身 / 解包根 / .app 的 Contents
    for (const c of [d, join(d, 'resources'), join(d, 'Contents/Resources')]) {
      if (existsSync(join(c, 'host', 'lib', 'bridge.js'))) return c
    }
    usageError(`--dir 下找不到 host/lib/bridge.js：${d}`)
  }
  const dist = join(REPO_ROOT, 'packages/desktop/dist')
  const candidates = [
    // 实测确认过的真实名字（见上面注释）。
    join(dist, `mac-${TARGET_ARCH}`, 'Corum.app/Contents/Resources'),
    join(dist, 'win-unpacked', 'resources'),
    join(dist, 'linux-unpacked', 'resources'),
    // 兼容带 arch 的变体（electron-builder 在部分配置/版本下会带上）。
    join(dist, `win-${TARGET_ARCH}-unpacked`, 'resources'),
    join(dist, `linux-${TARGET_ARCH}-unpacked`, 'resources'),
  ]
  for (const c of candidates) if (existsSync(join(c, 'host', 'lib', 'bridge.js'))) return c
  // 兜底：扫 dist 下所有 */resources 与 *.app/Contents/Resources。
  if (existsSync(dist)) {
    for (const entry of readdirSync(dist)) {
      for (const c of [
        join(dist, entry, 'resources'),
        join(dist, entry, 'Corum.app', 'Contents', 'Resources'),
      ]) {
        if (existsSync(join(c, 'host', 'lib', 'bridge.js'))) return c
      }
    }
  }
  usageError(
    '找不到解包后的产物（先跑 pack.mjs 的 pack:app 步）。已找过：\n  '
    + candidates.join('\n  '),
  )
}

/** 产物**自带**的 Node 运行时路径（三平台布局不同）。 */
function findBundledNode(resourcesDir) {
  const candidates = [
    join(resourcesDir, 'node', 'node.exe'), // Windows
    join(resourcesDir, 'node', 'bin', 'node'), // macOS / Linux
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return undefined
}

const resources = findResourcesDir()
const bridge = join(resources, 'host', 'lib', 'bridge.js')
const node = findBundledNode(resources)
if (node === undefined) {
  // 取不到 = 产物残缺（pack:node 没跑或跑了别的平台），不是「跳过」。
  fail(
    `产物内没有自带 Node 运行时（找过 resources/node/node.exe 与 resources/node/bin/node）。`
    + `这本身就是产物残缺——pack:node 步没跑，或跑了别的平台。resources=${resources}`,
  )
}

// 用产物自己的 Node 跑产物自己的桥：**目标平台语义**下的真验证。
//
// ⚠️ 用异步 spawn + 「收到 ready 就主动结束」，**不要**用 spawnSync：
// 宿主桥只在 **stdin EOF** 时才自己退出（`parent gone (stdin EOF) — flushing and exiting`），
// 而它发出 ready 之后仍会继续服务。spawnSync 会一直等到它退出 ⇒ 在 CI 上会把
// 120s 超时耗满并误判失败（2026-10-12 实测踩到）。这里收 ready 即 kill。
//
// HOME 重定向到临时目录，绝不碰 CI/开发者真实的 .corum（桥 boot 会写 profiles 骨架）。
const smokeHome = join(tmpdir(), `corum-boot-assert-${process.pid}`)
try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* 上次残留，忽略 */ }
mkdirSync(smokeHome, { recursive: true })

const started = Date.now()
const run = await new Promise((resolveRun) => {
  const child = spawn(node, [bridge], {
    cwd: join(resources, 'host'),
    // stdin 置 ignore（= 立刻 EOF）：桥会正常 boot 并发出 ready，随后自行退出；
    // 我们在拿到 ready 时就结束，不等它。
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_TELEMETRY_DISABLED: '1',
      CORUM_HOME: smokeHome,
      DSH_HOME: smokeHome,
      // 显式清空平台一致性断言的放行口（我们要它生效，不要被外部环境放行）。
      CORUM_PLATFORM_ASSERT: '',
    },
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (payload) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    // 收到 ready 时进程通常还在跑（见上），主动结束，避免白等到超时。
    try { child.kill() } catch { /* 已退出 */ }
    resolveRun(payload)
  }
  const timer = setTimeout(() => finish({ kind: 'timeout', stdout, stderr }), 120_000)
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
    if (stdout.includes('"type":"ready"')) finish({ kind: 'ready', stdout, stderr })
  })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  child.on('error', (error) => finish({ kind: 'error', error, stdout, stderr }))
  child.on('exit', (code) => finish({ kind: 'exit', code, stdout, stderr }))
})

// 清理这次 boot 写出的 profiles 骨架（Windows 上偶发 EBUSY，重试几次）。
for (let attempt = 0; attempt < 10; attempt += 1) {
  try { rmSync(smokeHome, { recursive: true, force: true }); break } catch (error) {
    const code = error?.code
    if (attempt >= 9 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY')) break
    await new Promise((r) => setTimeout(r, 300))
  }
}

const combined = `${run.stdout}\n${run.stderr}`
const fatalLines = FATAL_LINES.filter((needle) => combined.includes(needle))
const ctx = { platform: TARGET_PLATFORM, arch: TARGET_ARCH }

if (run.kind === 'error') {
  fail(`无法启动产物 Node（${node}）：${run.error?.message ?? run.error}`)
}
if (fatalLines.length > 0) {
  report({
    ok: false,
    reason: `启动输出含已知致命行（${fatalLines.length} 条）——宿主插件树未加载成功。`,
    fatalLines,
    tail: combined,
    ...ctx,
  })
  process.exit(1)
}
if (run.kind === 'timeout') {
  report({
    ok: false,
    reason: '120s 内既没有 ready、也没有退出——产物启动卡死（或缺依赖导致 boot 挂起）。',
    tail: combined,
    ...ctx,
  })
  process.exit(1)
}
if (run.kind === 'exit' && run.code !== 0) {
  report({
    ok: false,
    reason: `宿主桥退出码 ${run.code}（期望 0），且在退出前没有发出 ready。`,
    tail: combined,
    ...ctx,
  })
  process.exit(1)
}
if (!run.stdout.includes('"type":"ready"')) {
  report({
    ok: false,
    reason: '宿主桥结束了，但 stdout 没有出现 {"type":"ready" —— 没发 ready 就不算挂载成功。',
    tail: combined,
    ...ctx,
  })
  process.exit(1)
}
const readyUrl = run.stdout.match(/"authenticatedUrl":"([^"]+)"/)?.[1]
report({ ok: true, node, bridge, readyUrl, elapsedMs: Date.now() - started, ...ctx })
