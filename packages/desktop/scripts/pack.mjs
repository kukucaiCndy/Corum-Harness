#!/usr/bin/env node
/**
 * 打包链入口包装器（P0）：**一开始就明确打包方向**（用户方案原话），把
 * `CORUM_TARGET_PLATFORM`（+ `CORUM_TARGET_ARCH`）注入环境后跑完整四步：
 *
 *   build → pack:host:<plat> → pack:node:<plat> → pack:app:<plat>
 *
 * 为什么必须有它（方案 §2.1）：目标平台是**唯一输入，且必须驱动全部消费者**
 * —— tsdown define 的烘入常量（build 步）、fetch-node.mjs 取的 Node 归档
 * （pack:node 步）、electron-builder 的 target（pack:app 步）。原来三步靠
 * `--platform=` flag 逐脚本传参，而 **build 完全不知道目标平台** ⇒ 烘入常量
 * 无处来。npm scripts 的 `VAR=… cmd` 前缀写法在 Windows cmd 下不生效
 * （2026-10-08 已拍板用 flag 而非环境前缀），跨平台唯一可靠的形态就是
 * Node 包装器自己设 `process.env` 再 spawn 子命令。
 *
 * 用法（在 packages/desktop 下）：
 *   node scripts/pack.mjs darwin [--arch=arm64]
 *   node scripts/pack.mjs linux  [--arch=x64]
 *   node scripts/pack.mjs win32  [--arch=x64]
 *
 * npm scripts `pack` / `pack:linux` / `pack:win` 只是它的薄别名。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORM_TO_SLUG = { darwin: 'mac', linux: 'linux', win32: 'win' }
const DEFAULT_ARCH = { darwin: 'arm64', linux: 'x64', win32: 'x64' }

function fail(message) {
  process.stderr.write(`[pack] FATAL: ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const platform = args.find((a) => !a.startsWith('--'))
const archArg = args.find((a) => a.startsWith('--arch='))?.slice('--arch='.length)

if (platform === undefined || !(platform in PLATFORM_TO_SLUG)) {
  fail(`必须显式指定目标平台（darwin | linux | win32）；收到：${args.join(' ') || '(无)'}。
       绝不从构建机 process.platform 推断（方案 §2.1：回落会让烘入常量 / Node 归档 /
       electron-builder target 三者口径分裂，制造内部混装的静默缺陷）。`)
}
const arch = archArg ?? DEFAULT_ARCH[platform]
const slug = PLATFORM_TO_SLUG[platform]

// 唯一注入点：两个事实进环境，四步的全部子进程继承。
// CORUM_TARGET_PLATFORM 同时被 pack-macos.mjs 的 resolveTargetPlatform() 消费
// （与它的 --platform flag 同值，双通道一致）。
process.env.CORUM_TARGET_PLATFORM = platform
process.env.CORUM_TARGET_ARCH = arch

const steps = [
  ['build', ['run', 'build']],
  ['pack:host', ['run', `pack:host:${slug}`]],
  ['pack:node', ['run', `pack:node:${slug}`]],
  ['pack:app', ['run', slug === 'mac' ? 'pack:app' : `pack:app:${slug}`]],
]

process.stderr.write(`[pack] target=${platform}/${arch} 四步：${steps.map(([name]) => name).join(' → ')}\n`)

// 前置：Electron 版本锁守卫（2026-10-09 事故的直接对策，见 scripts/electron-pin.json）。
// 放在**打包之前**是刻意的——一旦身份错配（同版本号但字节不同 / 声明漂移），
// 产物会带上一个钥匙串不认的二进制，用户侧表现是「启动弹密码框 + 应用起不来」。
// 宁可在这里 exit 1，也不要打出一个装不上/打不开的包。
{
  const guard = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/verify-electron-pin.mjs')
  if (!existsSync(guard)) {
    fail(`找不到 Electron 版本锁守卫：${guard}（不可跳过——它是发布阻断级问题的唯一机制防线）`)
  }
  const check = spawnSync('node', [guard, `--platform=${platform}`, `--arch=${arch}`], { stdio: 'inherit' })
  if (check.status !== 0) {
    fail(`Electron 版本锁校验未通过（见上）。修 scripts/electron-pin.json / packages/desktop/package.json / `
      + 'pnpm-workspace.yaml 的 overrides 后重跑；升级 Electron 请按 electron-pin.json 的 upgrade 步骤走。')
  }
}

for (const [name, cmd] of steps) {
  process.stderr.write(`[pack] ── ${name} ──\n`)
  const result = spawnSync('npm', cmd, { stdio: 'inherit', env: process.env })
  if (result.status !== 0) fail(`${name} 失败（exit ${result.status ?? 'signal'}），链终止。`)
}

process.stderr.write(`[pack] ✅ ${platform}/${arch} 四步完成。\n`)
