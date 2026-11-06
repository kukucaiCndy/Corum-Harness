#!/usr/bin/env node
/**
 * 打包链入口包装器（P0）：**一开始就明确打包方向**（用户方案原话），把
 * `CORUM_TARGET_PLATFORM`（+ `CORUM_TARGET_ARCH`）注入环境后跑完整四步：
 *
 *   build → pack:node:<plat> → pack:git:<plat> → pack:host:<plat>
 *   （pack:host 内部完成「暂存 host 闭包 + electron-builder 出包」，故没有单独的 pack:app 步）
 *
 * ⚠️ `pack:node` **必须早于** `pack:host`（0.7.0 发版实测）：它顺带暂存 Windows 的
 * VC++ 安装包，而 pack:host 会先断言其存在（详见下方 steps 注释）。
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
import { existsSync, readdirSync, lstatSync, rmSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORM_TO_SLUG = { darwin: 'mac', linux: 'linux', win32: 'win' }
const DEFAULT_ARCH = { darwin: 'arm64', linux: 'x64', win32: 'x64' }

/** pack:app 前删掉的 workspace 软链（路径 → 原相对目标）。声明在最前面是因为
 * `fail()` 可能在任何一步触发，而它必须先把软链接回去再退出。 */
const removedLinks = []

function fail(message) {
  process.stderr.write(`[pack] FATAL: ${message}\n`)
  restoreWorkspaceLinks()
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
// `npm run pack:*` 这些 scripts 定义在 packages/desktop/package.json 里，
// 必须在该包目录下执行。原先四步没有显式 cwd ⇒ 继承调用者的 cwd ⇒ 从仓库根
// 调用时 `npm run pack:node:mac` 直接 "Missing script"（已在根目录踩过一次）。
// 显式钉死，让 `node packages/desktop/scripts/pack.mjs darwin` 在任意 cwd 下等价。
const DESKTOP_DIR = resolve(SCRIPT_DIR, '..')

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
  // ⚠️ 顺序有**硬依赖**，不是随意排列（2026-10-23 发布实测：v0.7.0 的 win32 job 2 分钟即红）：
  // `pack-node` 顺带暂存 Windows 的 VC++ 安装包（`fetchVcRedist()`，见 fetch-node.mjs），
  // 而 `pack-host` 的 `assertVcRedistStaged()` 会**先断言**它存在。原先 pack:host 在
  // pack:node 之前 ⇒ 只要有缓存的机器（开发者本机）能过，全新 runner 必红。故 pack:node 提前。
  // 两步互不依赖（fetch-node 只动 build/node 与 build/vcredist，不碰 build/host），提前安全。
  ['pack:node', 'npm', ['run', `pack:node:${slug}`], DESKTOP_DIR],
  // `pack:git` 必须先于 `pack:host`：host 步现在**自己就出包**（见下），
  // `build/git` 是 extraResources 的一项，晚到就等于包里没有 git。
  ['pack:git', 'npm', ['run', `pack:git:${slug}`], DESKTOP_DIR],
  // `pack:host` = 暂存 host 闭包 + 调 electron-builder 出 .app/.dmg/.zip（一步到底）。
  // **不再有独立的 `pack:app` 步**：那是 electron-builder 已经搬进 pack-macos.mjs
  // 之后留下的重复调用，且它作为独立进程拿不到 pack:host 内部算出的
  // `CORUM_BUILD_SUFFIX` ⇒ `artifactName` 里的 `${env.CORUM_BUILD_SUFFIX}` 展开失败，
  // 整条链在最后一步必红（2026-11-06 实测，CI 同链同样会红）。
  ['pack:host', 'npm', ['run', `pack:host:${slug}`], DESKTOP_DIR],
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

/**
 * 把 pack:app 清掉的 workspace 软链原样接回去。
 *
 * 为什么必须自己做（2026-11-04 实测，代价 = dev 实例起不来）：
 * 原注释写着「pack:app 后 pnpm install 重建」，**这句是错的**。实测
 * `pnpm install` 与 `pnpm install --force` 都只打印 "Already up to date"，
 * 一条软链都没回来（软链不是 install 的 delta，只有 lockfile 变化才触发重链）。
 * 于是打包之后 dev 宿主启动即报
 * `Cannot find package '@deepseek-ai/dsh-tools' imported from …/dsh-cordis-host-runner`，
 * 插件树加载失败 ⇒ 实例起不来（verify 实例已复现）。
 * 这里在删除时记录 (路径 → 相对目标)，链式结束后无条件复原；失败退出同样复原，
 * 保证仓库的 node_modules 永远不会停在「打包成功、开发环境坏了」的状态。
 */
function restoreWorkspaceLinks() {
  let failed = 0
  for (const [linkPath, target] of removedLinks) {
    if (existsSync(linkPath)) continue
    try {
      symlinkSync(target, linkPath, 'dir')
    } catch {
      failed += 1
    }
  }
  if (removedLinks.length > 0) {
    process.stderr.write(
      `[pack] workspace 软链复原：${removedLinks.length - failed}/${removedLinks.length}`
      + `${failed > 0 ? `（${failed} 条失败，请手工 pnpm install --force 检查）` : ''}\n`,
    )
  }
  removedLinks.length = 0
}

for (const [name, runner, args, cwd] of steps) {
  // pack:host 前清理：pnpm 虚拟 store 里的 workspace symlink（如 @corum/corum-tools
  // 和 fork 顶替的 @deepseek-ai/dsh-tools → corum-tools）会被 electron-builder 的
  // NodeModuleCopyHelper 遍历到，realpath 解析到 packages/plugins/ 下不在 app 目录
  // 内 ⇒ getRelativePath 报 "must be under"。这些 workspace link 不需要进 app.asar
  // （host 闭包已含实体），删掉不影响打包产物；但**工作区自己还需要它们**——
  // 删了就 dev 实例起不来（见 restoreWorkspaceLinks 的注释），所以逐条记录、收尾复原。
  if (name === 'pack:host') {
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
                  // 先记录再删：收尾由 restoreWorkspaceLinks() 原样接回。
                  removedLinks.push([full, target])
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

restoreWorkspaceLinks()
process.stderr.write(`[pack] ✅ ${platform}/${arch} ${steps.length} 步完成。\n`)
