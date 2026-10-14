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
import { existsSync, readdirSync, lstatSync, rmSync, readlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..')

const steps = [
  // build = 全仓构建（`pnpm -r run build`，与根 package.json 的 build 脚本、
  // pr-gate 的 Build 步骤同口径），而不是只构建 desktop 自己：
  // - 全新 checkout 里各包的 lib/（gitignored）不存在，tsc 按 package.json
  //   exports 找各包 lib/*.d.ts ⇒ 依赖没构建就必 TS2307（CI 挂两次的真因）；
  // - 不能按「desktop 依赖闭包」裁剪：fork 有官方包顶替机制
  //   （`@deepseek-ai/dsh-tools → link:../corum-tools`，见 pnpm-lock
  //   importers），这种**解析边在包依赖图里不可见**——`corum-desktop...`
  //   选出 43 个，漏掉 corum-tools，orchestration 照挂；
  //   全量 45 个 = pr-gate 的 Scope，与门禁已验证的集合完全一致；
  // - 不用路径 filter（pnpm 11 Windows 下零匹配），`-r` 无 filter 全平台同语义；
  // - 继承下面的 CORUM_TARGET_PLATFORM/ARCH 做完整 build，
  //   烘入常量口径与后三步一致，故这一步之后不再单独跑 desktop build。
  ['build', 'pnpm', ['-r', 'run', 'build'], REPO_ROOT],
  ['pack:host', 'npm', ['run', `pack:host:${slug}`]],
  ['pack:node', 'npm', ['run', `pack:node:${slug}`]],
  ['pack:git', 'npm', ['run', `pack:git:${slug}`]],
  ['pack:app', 'npm', ['run', slug === 'mac' ? 'pack:app' : `pack:app:${slug}`]],
]

process.stderr.write(`[pack] target=${platform}/${arch} 五步：${steps.map(([name]) => name).join(' → ')}\n`)

// 前置：Electron 版本锁守卫（2026-10-09 事故的直接对策，见 scripts/electron-pin.json）。
// 放在**打包之前**是刻意的——一旦身份错配（同版本号但字节不同 / 声明漂移），
// 产物会带上一个钥匙串不认的二进制，用户侧表现是「启动弹密码框 + 应用起不来」。
// 宁可在这里 exit 1，也不要打出一个装不上/打不开的包。
{
  const guard = resolve(SCRIPT_DIR, '../../../scripts/verify-electron-pin.mjs')
  if (!existsSync(guard)) {
    fail(`找不到 Electron 版本锁守卫：${guard}（不可跳过——它是发布阻断级问题的唯一机制防线）`)
  }
  const check = spawnSync('node', [guard, `--platform=${platform}`, `--arch=${arch}`], { stdio: 'inherit' })
  if (check.status !== 0) {
    fail(`Electron 版本锁校验未通过（见上）。修 scripts/electron-pin.json / packages/desktop/package.json / `
      + 'pnpm-workspace.yaml 的 overrides 后重跑；升级 Electron 请按 electron-pin.json 的 upgrade 步骤走。')
  }
}

for (const [name, runner, args, cwd] of steps) {
  // pack:app 前清理：pnpm 虚拟 store 里的 workspace symlink（如 @corum/corum-tools
  // 和 fork 顶替的 @deepseek-ai/dsh-tools → corum-tools）会被 electron-builder 的
  // NodeModuleCopyHelper 遍历到，realpath 解析到 packages/plugins/ 下不在 app 目录
  // 内 ⇒ getRelativePath 报 "must be under"。这些 workspace link 不需要进 app.asar
  // （host 闭包已含实体），删掉 symlink 不影响打包（pack:app 后 pnpm install 重建）。
  if (name === 'pack:app') {
    const pnpmDir = resolve(REPO_ROOT, 'node_modules/.pnpm')
    if (existsSync(pnpmDir)) {
      for (const pkgDir of readdirSync(pnpmDir)) {
        const nmDir = join(pnpmDir, pkgDir, 'node_modules')
        if (!existsSync(nmDir)) continue
        // 递归找所有 symlink，删掉指向 packages/plugins/ 的（workspace link）
        const walkAndClean = (dir) => {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            try {
              const st = lstatSync(full)
              if (st.isSymbolicLink()) {
                const target = readlinkSync(full)
                // Windows 上 readlinkSync 返回的路径用反斜杠（packages\plugins\），
                // macOS/Linux 用正斜杠（packages/plugins/）——两种都要匹配，否则
                // win32 上清理失效 ⇒ electron-builder 报 "must be under" 打包失败。
                const norm = target.replace(/\\/g, '/')
                if (norm.includes('packages/plugins/') || norm.includes('packages/ui/') || norm.includes('packages/session/')) {
                  rmSync(full)
                }
              } else if (st.isDirectory()) {
                walkAndClean(full)
              }
            } catch { /* best-effort */ }
          }
        }
        walkAndClean(nmDir)
      }
    }
  }
  process.stderr.write(`[pack] ── ${name} ──\n`)
  // Windows 上 npm/pnpm 是 .cmd shim：不经 shell 中转会 ENOENT（与 pack-macos.mjs 的 run() 同理）。
  const result = spawnSync(runner, args, { cwd: cwd ?? process.cwd(), stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
  if (result.status !== 0) fail(`${name} 失败（exit ${result.status ?? 'signal'}），链终止。`)
}

process.stderr.write(`[pack] ✅ ${platform}/${arch} 四步完成。\n`)
