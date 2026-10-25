/**
 * corum-desktop macOS 打包脚本（阶段 1：物化宿主运行时闭包）。
 *
 * 产出 build/host/ —— 一个自包含、可 boot 的宿主子进程运行时目录：
 *   - 用 `pnpm deploy --legacy` 从 desktop-host 这个 dependency-only deploy 根
 *     物化 registry 版 host 闭包（跟随官方底座 0.1.0-rc.6），再叠加 corum-desktop
 *     自己的 lib/cordis.patch.yml/package.json。
 *   - 物化遗留符号链接（deploy 产物里顶层包是指向 .pnpm 的 symlink）
 *   - 校验产物能被真 Node boot（输出 ready 即通过）
 *
 * 之后 electron-builder 把 build/host/ 作为 extraResources 打进 .app，
 * 附带一个 Node 运行时（fetch-node.mjs 下载）解压到 build/node/。
 *
 * ---
 *
 * ## ⚠️ 装了产物之后**不要重签名**（2026-10-25 实测事故）
 *
 * 把 `.app` 拷到 `/Applications` 后再跑 `codesign --force --deep --sign -`，
 * 会**换掉 cdhash**，而这台机器上的 safeStorage 钥匙串条目 ACL 绑定的正是
 * 原 cdhash ⇒ `safeStorage.isEncryptionAvailable()` 失效 ⇒ 主密钥拿不到 ⇒
 * fork 的 credentials 插件拒绝加载 ⇒ host **exit 1**，界面只剩「后台启动失败：
 * 进程提前退出（code 1）」。症状与「钥匙串坏了」一模一样，但**根因是我们自己
 * 重签造成的**，不是系统问题（实测对照：重签前 Identifier=Electron /
 * flags=adhoc,linker-signed / cdhash=7f6315c1…；重签后 Identifier 变
 * com.corum.agentos / flags=adhoc / cdhash=f690a5bb…）。
 *
 * 安装只需要两步，**都不要碰签名**：
 *
 *     ditto packages/desktop/dist/mac-arm64/Corum.app /Applications/Corum.app
 *     xattr -cr /Applications/Corum.app        # 仅清 quarantine
 *
 * `spctl` 对未签名包报 `code has no resources but signature indicates they
 * must be present` 是**预期现象**（电子构建产物只有 linker-signed 的链接签名），
 * 不代表需要重签。判据：`codesign -dvvv` 的 `CandidateCDHash` 必须与打包产物
 * 逐字一致；一旦不一致，删掉重装，不要修签名。
 * 相关守卫：`scripts/verify-electron-pin.mjs`（锁版本号 + 二进制身份）。
 *
 * ## ⚠️ host 闭包会**静默缺包**（2026-10-25 实测事故）
 *
 * `topUpCorumPackagesFromWorkspace()` 只补 **`desktop-host/package.json` 声明过**
 * 的 `@corum/*`。所以「`packages/desktop/package.json` 里加了新包、但
 * `desktop-host/package.json` 没加」的包**不会进闭包，也不会触发缺包断言**
 * （它根本不在 declared 列表里，`missing` 自然是空的）。
 *
 * 实测：`@corum/corum-extension-pack` 只在 desktop 声明、不在 desktop-host 声明
 * ⇒ 装出来的包启动即
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@corum/corum-extension-pack'
 *  imported from …/Resources/host/lib/bridge.js` ⇒ exit 1。
 *
 * **加新 @corum 包时要同时改两处**：`packages/desktop/package.json`（壳依赖）
 * 与 `packages/desktop/desktop-host/package.json`（host 闭包来源）。
 * 只改前者，打包能过、`.app` 能生成，但**装上去才炸**。
 *
 * 用法：node packages/desktop/scripts/pack-macos.mjs
 * @module corum-desktop/scripts/pack-macos
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..', '..', '..')
/** desktop 包根（脚本位置推导——2026-09 全局重命名后 packages/shell 已不存在）。 */
const DESKTOP_ROOT = resolve(import.meta.dirname, '..')

/**
 * The platform this build targets — `darwin` | `linux` | `win32`.
 *
 * **Must be passed explicitly** (`--platform=<p>`, or `CORUM_TARGET_PLATFORM`),
 * never inferred from the build host. The closure and the staged Node runtime are
 * platform-specific, so inferring means a Windows package assembled on macOS
 * silently carries macOS native binaries — measured on 2026-10-08:
 * `@koromix/koffi-darwin-arm64` inside a win package (which broke file editing
 * on Windows, since `koffi` picks its binary by the *running* platform).
 *
 * A missing value is a **hard error** (user decision): the alternative failure
 * mode is invisible, and this project has already paid for it twice.
 * The `--flag` form exists alongside the env var because `VAR=… cmd` is bash
 * syntax and does not work under Windows `cmd` — the very host that runs this
 * script for `pack:win`.
 * @returns The target platform string.
 */
function resolveTargetPlatform() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--platform=')) {
      const value = arg.slice('--platform='.length)
      if (value !== '') return value
    }
  }
  const fromEnv = process.env.CORUM_TARGET_PLATFORM
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  throw new Error(
    'pack-macos: 必须显式指定目标平台（--platform=darwin|linux|win32，或 CORUM_TARGET_PLATFORM）。'
    + '不要从构建机推断：闭包与 Node 运行时都是平台专属的，推断会让 Windows 包里混进 macOS 的二进制。',
  )
}

/**
 * The **target** CPU architecture, resolved the same way as the platform.
 *
 * Must not fall back to `process.arch`: on Apple Silicon that is `arm64`, while
 * the Windows/Linux desktop targets are `x64`. Using the host arch here fetched
 * `@koromix/koffi-win32-arm64` for a `--win --x64` build (measured 2026-10-08) —
 * the closure then held a native binding the target can never load.
 * @returns `arm64` or `x64`.
 */
function resolveTargetArch() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--arch=')) {
      const value = arg.slice('--arch='.length)
      if (value !== '') return value
    }
  }
  const fromEnv = process.env.CORUM_TARGET_ARCH
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return process.arch
}

const CORUM_TARGET_PLATFORM = resolveTargetPlatform()
const CORUM_TARGET_ARCH = resolveTargetArch()

/** 宿主运行时的 staging 目录 */
const HOST_DIR = join(DESKTOP_ROOT, 'build', 'host')
/** corum-desktop 自身产物源（bridge.js 等已由 pnpm run build 产出） */
const DESKTOP_LIB = join(DESKTOP_ROOT, 'lib')
/** 前端 dist 源（@deepseek-ai/dsh-web-frontend 的构建产物；registry 依赖落在 shell 包 node_modules） */
const WEB_DIST = join(DESKTOP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
/** 前端 dist 在打包 staging 里的目标 */
const DIST_DIR = join(DESKTOP_ROOT, 'build', 'dist')
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
/** 随包分发的官方技能集（仓库内实体；开发态由插件按源码布局直接解析）。 */
const SHIPPED_SKILLS = join(DESKTOP_ROOT, 'shipped-skills')
/** host 运行时里 shipped-skills 的 staging 目标（与 shipped-presets 同级，锚点同款）。 */
const SHIPPED_SKILLS_DIR = join(HOST_DIR, 'shipped-skills')
/**
 * 随包分发的「内置 Agent 预设模块」集（仓库内实体）。
 *
 * 为什么与 shipped-skills 分开、且**两处都要 stage**：模块是比技能高一层分发单位
 * （把预设的人格/提示词、技能实体、MCP 配置与安装说明收进一个自洽目录，见
 * `@corum/corum-preset-modules`）。corum 自研的那 4 个技能现在**实体在模块里**
 * （`shipped-modules/corum-dev/skills/`），而 skill-manager 是按「shipped-skills 与
 * shipped-modules 下各模块的 skills」并集扫描的 ⇒ 少 stage 任一处都会得到半截状态
 * （技能在、模块不在 ⇒ 导入向导的「从内置模块库」为空；模块在、技能不在 ⇒
 * 随包技能集少 4 个）。
 */
const SHIPPED_MODULES = join(DESKTOP_ROOT, 'shipped-modules')
/** host 运行时里 shipped-modules 的 staging 目标（与 shipped-skills 同级，锚点同款）。 */
const SHIPPED_MODULES_DIR = join(HOST_DIR, 'shipped-modules')

async function run(label, command, args, options = {}) {
  console.log(`[pack-macos] ${label}`)
  await new Promise((resolveRun, reject) => {
    // Windows 上 pnpm/npm 是 .cmd shim，spawn 直接找 .exe 会 ENOENT ⇒ 经 cmd.exe 中转；
    // 非 win32 保持原样（shell 中转会改变信号/引用语义）。
    const child = spawn(command, args, { cwd: options.cwd ?? root, stdio: 'inherit', shell: process.platform === 'win32' })
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

/**
 * 物化一份**工作区副本**，供 `pnpm deploy` 使用（用户 2026-09-18 定调方案 c）。
 *
 * 为什么必须有副本：`pnpm deploy --prod --filter corum-desktop-host` 会在**工作区里**做一次
 * 按 desktop-host 生产依赖收敛的安装 —— 它会重写各 workspace 包的 `node_modules`，把别的包
 * 需要的依赖剪掉。实测（2026-09-18）：打包前 `packages/plugins/agent/corum-agent/node_modules/
 * @deepseek-ai/schemastery` 在，**每次打包跑完就没了**；而紧随其后的 host 冒烟启动会经
 * **工作区路径**加载 `@corum/corum-agent`（冒烟期 profile scaffolding 的软链指向仓库里的插件
 * 包）⇒ `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery` ⇒ `host bridge exited 1 before ready`。
 * 把 deploy 移进副本后，收敛只落在副本里，真工作区**一字不动**，冒烟启动自然能解析。
 *
 * 副本内容 = 根元数据（workspace 声明 + 锁文件）+ `packages/**`（**排除** node_modules /
 * build / dist：前者正是要被 deploy 冲刷的东西，后两者是产物、与 deploy 无关且体积大）。
 * @returns 副本根目录。
 */
async function materializeDeployWorkspace() {
  // ⚠️ 副本**不能**放在 `packages/` 里（cp 会拒绝「复制到自身的子目录」EINVAL），
  // 也刻意不放在仓库内：它是上 GB 的临时物，放系统临时目录用完即删。
  const wsDir = join(tmpdir(), `corum-pack-ws-${process.pid}`)
  await rm(wsDir, { recursive: true, force: true })
  await mkdir(wsDir, { recursive: true })
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc']) {
    const from = join(root, name)
    if (existsSync(from)) await cp(from, join(wsDir, name), { recursive: true })
  }
  const skip = new Set(['node_modules', 'build', 'dist'])
  await cp(join(root, 'packages'), join(wsDir, 'packages'), {
    recursive: true,
    dereference: true,
    filter: (source) => !source.split(sep).some(segment => skip.has(segment)),
  })
  return wsDir
}

/**
 * 闭包减重：删掉运行时永远不会被加载的文件（安装包体积与 NSIS 释放速度的直接决定项）。
 *
 * ## 为什么必须做（2026-10-12 实测）
 *
 * host 闭包（`pnpm deploy` 产物）里过半文件是死重：上游包把源码/声明/maps/文档
 * 一起发布（`@deepseek-ai/*` 甚至有意 export `./src/*`），deploy 照单全收。
 * mac 实测 522MB / 3.5 万文件中：.ts 60MB + .map 112MB + .d.ts 43MB + .md 9MB
 * ≈ 185MB / 2 万文件。NSIS 释放是逐文件开销＋Defender 逐文件扫描，3.5 万小文件
 * 在 Windows 上释放 10 分钟以上；砍掉死重后文件数减半、体积 -35%。
 *
 * ## 安全边界（删错会直接导致打包版起不来，故逐条论证）
 *
 * - `.ts/.mts/.tsx/.cts`（含 `.d.*`）：Node 运行时只解析 `.js/.mjs/.cjs/.json`
 *   （ESM 要求写全扩展名，CJS 不试 `.ts`），且全仓 grep 证明没有任何 `…/src/…`
 *   运行时导入；host 也没有 ts-node。删。
 * - `.map`：只有 `node --enable-source-maps` 才读（且缺失只降级堆栈，不崩）；
 *   host 启动参数里没有它。删。
 * - `.md`：只删 `node_modules` 下的（README/CHANGELOG）；shipped-skills 等
 *   业务目录不动（SKILL.md 是运行时读的）。
 * - 保留：`.js/.mjs/.cjs/.json/.node`（运行时）＋其他一切扩展名
 *   （`.css/.wasm`/二进制等——宁可多留，不错杀）。
 *
 * @returns 删掉的文件数与字节数（打日志用）。
 */
async function pruneClosureDeadWeight() {
  const PRUNE_EXT = new Set(['.ts', '.mts', '.tsx', '.cts', '.map'])
  let files = 0
  let bytes = 0
  async function walk(dir, inNodeModules) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const meta = await lstat(path)
      if (meta.isSymbolicLink()) continue // 软链由 materializeSymlinks 专管，这里不跟不删
      if (meta.isDirectory()) {
        await walk(path, inNodeModules || entry.name === 'node_modules')
        continue
      }
      if (!meta.isFile()) continue
      const dot = entry.name.lastIndexOf('.')
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : ''
      const pruneMd = inNodeModules && ext === '.md'
      if (!PRUNE_EXT.has(ext) && !pruneMd) continue
      const size = (await stat(path)).size
      await rm(path, { force: true })
      files += 1
      bytes += size
    }
  }
  await walk(HOST_DIR, false)
  console.log(`[pack-macos] 闭包减重：删 ${files} 个死重文件（${(bytes / 1048576).toFixed(0)}MB：源码/声明/maps/文档，运行时不加载）`)
  return { files, bytes }
}

/**
 * 闭包去重：删掉「与顶层同版本的嵌套副本」，并断言不留同版本重复实例。
 *
 * ## 为什么必须做（2026-09-18 实测，打包版 agent 起不来的根因）
 *
 * cordis 的 scope 机制、`dsh-scope` 的注册表、schemastery 的 schema 身份**都靠模块实例唯一**。
 * 而 `pnpm deploy --config.node-linker=hoisted` 并不能保证全局只有一份：实测闭包里出现
 * **14 个同版本重复实例**（`cordis` ×3、`dsh-scope` ×2、`schemastery` ×3 …），副本藏在某些包的
 * 嵌套 `node_modules` 下。后果是打包态 **`agentPresets.mount(agentCtx)` 抛
 * 「refusing to compose an unscoped context」** —— 建 scope 用的是一份 `dsh-scope`，查 scope 用的是
 * 另一份，注册表对不上；同一根因还表现为「prompt section 已注册」这类重复注册错误。
 * dev 态不出现，因为工作区里 pnpm 把它们 dedupe 成一份。
 *
 * ## 判据与安全边界
 *
 * 只删**版本相同**的嵌套副本（删掉后 Node 向上解析到顶层那份，语义等价）；版本不同的一律保留
 * （那是真实的多版本共存，不能动）。删除后若仍有同版本重复，**打包失败**——宁可不出包，也不出
 * 一个「跑起来行为诡异」的包。
 *
 * @returns 删除的副本数。
 */
async function dedupeClosureNodeModules() {
  const top = join(HOST_DIR, 'node_modules')
  const versionOf = (dir) => {
    try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version } catch { return undefined }
  }
  let removed = 0
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false
    const nested = []
    for (const entry of await readdir(top)) {
      if (entry.startsWith('.')) continue
      const scoped = entry.startsWith('@')
      const owners = scoped
        ? (await readdir(join(top, entry))).map(n => join(top, entry, n))
        : [join(top, entry)]
      for (const owner of owners) {
        const inner = join(owner, 'node_modules')
        if (!existsSync(inner)) continue
        for (const innerEntry of await readdir(inner)) {
          if (innerEntry.startsWith('.')) continue
          const names = innerEntry.startsWith('@')
            ? (await readdir(join(inner, innerEntry))).map(n => `${innerEntry}/${n}`)
            : [innerEntry]
          for (const name of names) nested.push({ dir: join(inner, name), name })
        }
      }
    }
    for (const { dir, name } of nested) {
      const topDir = join(top, name)
      if (!existsSync(topDir) || dir === topDir) continue
      const [a, b] = [versionOf(dir), versionOf(topDir)]
      if (a === undefined || a !== b) continue
      await rm(dir, { recursive: true, force: true })
      removed += 1
      changed = true
    }
    if (!changed) break
  }
  // 断言：不允许再有任何同版本重复实例
  const seen = new Map()
  const stillDup = []
  for (const entry of await readdir(top)) {
    if (entry.startsWith('.')) continue
    const owners = entry.startsWith('@')
      ? (await readdir(join(top, entry))).map(n => ({ dir: join(top, entry, n), name: `${entry}/${n}` }))
      : [{ dir: join(top, entry), name: entry }]
    for (const { dir, name } of owners) {
      const inner = join(dir, 'node_modules')
      if (!existsSync(inner)) continue
      for (const innerEntry of await readdir(inner)) {
        if (innerEntry.startsWith('.')) continue
        const innerNames = innerEntry.startsWith('@')
          ? (await readdir(join(inner, innerEntry))).map(n => `${innerEntry}/${n}`)
          : [innerEntry]
        for (const n of innerNames) {
          const nestedDir = join(inner, n)
          const topDir = join(top, n)
          if (!existsSync(topDir) || nestedDir === topDir) continue
          if (versionOf(nestedDir) === versionOf(topDir)) stillDup.push(`${n}（嵌套于 ${name}）`)
        }
      }
    }
    seen.set(entry, true)
  }
  if (stillDup.length > 0) {
    throw new Error(`pack-macos: 闭包仍有同版本重复实例（cordis/scope 注册表会被切开，agent 挂载会失败）：${stillDup.slice(0, 10).join(', ')}`)
  }
  if (removed > 0) console.log(`[pack-macos] closure dedupe: removed ${removed} nested same-version duplicate(s)`)
  return removed
}

/**
 * 用**工作区实际安装的官方包**补齐闭包，并断言「闭包 ⊇ 工作区官方包集合」。
 *
 * ## 为什么（2026-09-18 实测：打包版 agent 起不来的真正根因）
 *
 * `deploy --legacy` 物化出的闭包**系统性缺官方包**：实测 208 个工作区官方 dsh 包里缺 **35 个**
 * （`dsh-agent-loop`（`createScope` 所在！）、`dsh-tool-bash`、`dsh-mcp-client`、`dsh-subagent` …）。
 * 这些包在官方侧多为 **peerDependency 或 devDependency**（例如 `dsh-agent-loop` 到处都是 devDep），
 * 而 deploy 用的是 `--config.auto-install-peers=false --prod` ⇒ 谁都不是谁的「生产依赖」⇒ 不装。
 * 后果分两种环境：
 *   - **开发机**：`.app` 在仓库里，Node 逐级向上把缺的包从**工作区**解析到 ⇒ 能跑，但**两棵树的模块
 *     实例混用**（agent-loop 用工作区那份 `dsh-scope`，agent-presets 用闭包那份）⇒ symbol 不同 ⇒
 *     `agent-presets: refusing to compose an unscoped context`（实测；也就是「MCP 每秒重启」风暴的因）。
 *   - **干净机器**：直接 `Cannot find package`，agent 根本起不来。
 *
 * ## 规则
 *
 * 「**dev 能解析到什么，闭包就带什么**」——以工作区已安装的 `@deepseek-ai/*`（dsh 运行面 + cordis +
 * schemastery）为准，缺什么从工作区拷什么（同版本、解引用、剔除内层 node_modules 避免再引入副本）。
 * 补完仍然缺 ⇒ 打包失败（宁可不出包）。
 *
 * @returns 补齐的包数。
 */
async function topUpOfficialPackagesFromWorkspace() {
  const wsPnpm = join(root, 'node_modules', '.pnpm')
  if (!existsSync(wsPnpm)) throw new Error('pack-macos: 工作区未安装（缺 node_modules/.pnpm），无法据实补齐闭包')
  const top = join(HOST_DIR, 'node_modules')
  // ① 工作区已安装的官方包（名字 → 包目录）
  const wanted = new Map()
  // 排除**测试工具包**：它们只服务工作区开发，不进发行闭包（`dsh-agent-loop-testkit` 实测在
  // workspace 里是 alpha.2、与闭包的 alpha.1 不一致，会撞 assertUniformDshVersions；与其为测试
  // 工具钉版，不如不让它上船）。
  const isTestTooling = (name) => /-testkit$/.test(name)
  for (const entry of await readdir(wsPnpm)) {
    if (!entry.startsWith('@deepseek-ai+')) continue
    // 実名一律读 manifest，不解析目录名：pnpm 11 会把超长条目截断成
    // `@deepseek-ai+<name>_<hash>`（无 @version 段、名本身都可能被截断，
    // 2026-10-10 Windows 实机 measured：`@deepseek-ai+dsh-session-qu_b7ff…`），
    // 按名解析的正则会静默漏掉它们 ⇒ 闭包缺包而断言还全绿（fail-open）。
    // 条目自有包 vs 依赖：node_modules 下依赖是软链（另有自己的 entry），
    // 自有包是实体目录 —— 只收实体目录，且名以 manifest 的 name 为准。
    const scopeDir = join(wsPnpm, entry, 'node_modules', '@deepseek-ai')
    if (!existsSync(scopeDir)) continue
    for (const child of await readdir(scopeDir)) {
      const childPath = join(scopeDir, child)
      if ((await lstat(childPath)).isSymbolicLink()) continue
      const manifestPath = join(childPath, 'package.json')
      if (!existsSync(manifestPath)) continue
      const name = JSON.parse(await readFile(manifestPath, 'utf8')).name
      if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
      if (isTestTooling(name)) continue
      wanted.set(name, childPath)
    }
  }
  // ② 缺什么补什么
  let added = 0
  for (const [name, src] of wanted) {
    const dest = join(top, name)
    if (existsSync(dest)) continue
    await mkdir(dirname(dest), { recursive: true })
    // ⚠️ 不能给 cp 传「按 node_modules 段过滤」的 filter：Node 的 filter 对**目标路径**同样生效，
    // 而目标路径本身含 `node_modules` 段 ⇒ 会把整棵复制过滤掉（实测：37 个包一个都没进去、断言随即报缺）。
    // 内层副本由随后的 dedupeClosureNodeModules() 负责清理（同版本嵌套副本一律删）。
    await cp(src, dest, { recursive: true, dereference: true })
    added += 1
  }
  if (added > 0) console.log(`[pack-macos] closure top-up: +${added} official package(s) from the workspace install`)
  // ③ 断言：闭包必须覆盖工作区官方包集合
  const have = new Set()
  for (const entry of await readdir(top)) {
    if (entry !== '@deepseek-ai') continue
    for (const n of await readdir(join(top, entry))) have.add(`@deepseek-ai/${n}`)
  }
  const missing = [...wanted.keys()].filter(n => !have.has(n))
  if (missing.length > 0) {
    throw new Error(`pack-macos: 闭包仍缺 ${missing.length} 个官方包（打包版会有「从别处解析」的隐患）：${missing.slice(0, 10).join(', ')}`)
  }
  return added
}

/**
 * 用 **desktop-host 声明的 `@corum/*` 工作区包**补齐闭包，并断言「闭包 ⊇ desktop-host 的
 * `@corum/*` 生产依赖集合」。
 *
 * ## 为什么（2026-09-19 实测：打包宿主 boot 时模块解析被劫持到工作区旧版）
 *
 * `pnpm deploy --prod` 对 `workspace:*` 依赖的物化**不可靠**：desktop-host 声明的 33 个
 * `@corum/*` 包里，实测只有 25 个被物化进闭包，另外 10 个（`corum-agent`、`corum-ui-chat`
 * 等）整条缺失。后果在 boot 时爆发：app-boot 的 `healProfilesModuleFallback` 会按 host
 * `package.json` 的依赖声明 BFS，把 profile `node_modules` 里每个包软链到「它第一次解析到的
 * 目录」——闭包缺的 `@corum/corum-ui-chat` 就顺着 `workspace:*` 声明解析到**仓库里的插件
 * 源码目录**，于是 `dsh-commands` 这类官方包被软链到 `corum-ui-chat/node_modules` 下的
 * **registry 旧编译**（无 `registerFileReceiptResolver`、无 `settingsNamespace` …），把闭包里
 * 正确的官方源码版整个劫持掉，boot 即 `ctx.commands.registerFileReceiptResolver is not a
 * function` / `does not provide an export named 'settingsNamespace'`。
 *
 * ## 规则
 *
 * 与官方包补齐同一判据：「dev 能解析到什么，闭包就带什么」。desktop-host `package.json` 里
 * 声明为 `workspace:*` 的 `@corum/*` 包，缺什么从工作区拷什么（解引用、剔除内层
 * `node_modules`——闭包已含全部官方包，嵌套副本只会再制造「两份模块实例」）。补完仍缺 ⇒
 * 打包失败（宁可不出包）。
 *
 * @returns 补齐的包数。
 */
async function topUpCorumPackagesFromWorkspace() {
  const hostPkgPath = join(DEPLOY_ROOT, 'package.json')
  const hostPkg = JSON.parse(await readFile(hostPkgPath, 'utf8'))
  const declared = Object.entries({
    ...hostPkg.dependencies,
    ...hostPkg.devDependencies,
  }).filter(([name, spec]) => name.startsWith('@corum/') && typeof spec === 'string' && spec.startsWith('workspace:'))
  const top = join(HOST_DIR, 'node_modules')
  let added = 0
  const missing = []
  for (const [name] of declared) {
    const dest = join(top, name)
    if (existsSync(dest)) continue
    // 从 desktop-host 自己的安装目录解析（它是 workspace 链接，dereference 物化）。
    const src = join(DEPLOY_ROOT, 'node_modules', name)
    if (!existsSync(join(src, 'package.json'))) {
      missing.push(`${name}（desktop-host 未安装；先 pnpm install --filter corum-desktop-host）`)
      continue
    }
    // 与官方包补齐同理：不能给 cp 传「按 node_modules 段过滤」的 filter（目标路径也含该段）。
    // 但 @corum 包的 node_modules 全是官方包（闭包已齐），整棵带进去只会再产嵌套副本 ⇒
    // 这里按「顶层目录逐项、跳过 node_modules」复制。
    await mkdir(dest, { recursive: true })
    for (const entry of await readdir(src)) {
      if (entry === 'node_modules') continue
      await cp(join(src, entry), join(dest, entry), { recursive: true, dereference: true })
    }
    added += 1
  }
  if (added > 0) console.log(`[pack-macos] closure top-up: +${added} @corum package(s) from the workspace install`)
  if (missing.length > 0) {
    throw new Error(`pack-macos: 闭包仍缺 ${missing.length} 个 @corum 包（boot 时模块解析会被劫持到工作区）：${missing.slice(0, 10).join(', ')}`)
  }
  return added
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
  const deployTmp = join(DESKTOP_ROOT, 'build', '.deploy-tmp')
  await rm(deployTmp, { recursive: true, force: true })
  // ★ 在**副本**里 deploy（见 materializeDeployWorkspace 的由来）。
  const wsDir = await materializeDeployWorkspace()
  try {
    await run('pnpm install (deploy workspace copy)', 'pnpm', [
      'install', '--frozen-lockfile', '--ignore-scripts',
    ], { cwd: wsDir })
    await run('pnpm deploy desktop-host (hoisted registry closure, in a workspace copy)', 'pnpm', [
      '--filter', 'corum-desktop-host', 'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      deployTmp,
    ], { cwd: wsDir })
    if (!existsSync(join(deployTmp, 'node_modules'))) {
      throw new Error(`pack-macos: pnpm deploy produced no node_modules at ${deployTmp}`)
    }
    // pnpm deploy 会在 .pnpm/node_modules 里留下指向 workspace 的 self-link
    // symlink（corum-desktop-host、@corum/*、corum-desktop 等），这些在独立 deploy 产物
    // 里是断链的，cp(dereference) 会 stat 失败。复制前清理掉它们。
    //
    // ⚠️ 副本必须**活到这一步之后**：deploy 产物里指向 workspace 的软链指向的是**副本**，
    // 副本一删它们立刻成断链、会被上面这行当垃圾清掉（实测：`@deepseek-ai/dsh-fs-local`
    // 就是这么整条消失的）。所以副本在 finally 里、实体化（dereference）完成之后才删。
    await cleanupBrokenSymlinks(join(deployTmp, 'node_modules'))
    await cp(join(deployTmp, 'node_modules'), join(HOST_DIR, 'node_modules'), { recursive: true, dereference: true })
    await rm(deployTmp, { recursive: true, force: true })
    await topUpOfficialPackagesFromWorkspace()
    await topUpCorumPackagesFromWorkspace()
    const platformSync = await topUpPlatformPackages(CORUM_TARGET_PLATFORM, CORUM_TARGET_ARCH)
    if (platformSync.added > 0 || platformSync.removed > 0) {
      console.log(`[pack-macos] 闭包平台校正：+${platformSync.added} 目标平台包 / -${platformSync.removed} 宿主平台包`)
    }
  await dedupeClosureNodeModules()
  // 闭包减重放在断言**之前**：它按扩展名删文件、同样会改动目录集合，
  // 而下面那条断言的意义正是「校验最终产物」（与 dedupe 同理，见其注释）。
  await pruneClosureDeadWeight()
  // 断言放在 dedupe **之后**：dedupe 会删嵌套的同版本副本，若先断言再 dedupe，
  // 断言看到的目录集合与最终产物不一致（可能在断言后被改动）。
  await assertPlatformClosure(CORUM_TARGET_PLATFORM, CORUM_TARGET_ARCH)
  console.log('[pack-macos] host closure materialized from registry')
  } finally {
    // 副本用完即弃（含它自己的 node_modules）：可能上 GB，别留在 /tmp 里。
    await rm(wsDir, { recursive: true, force: true })
  }
}

/**
 * 平台标识：npm 的 `<os>` 取值 → 该平台上 `process.platform` 的名字。
 * 两者**大多数**同名，但 npm 侧有个别拼写不同，故显式成表而不是字符串拼接。
 */
const NPM_OS_TO_PROCESS_PLATFORM = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'win32',
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  android: 'android',
}
/** npm 的 `<arch>` 取值 → 该平台上 `process.arch` 的名字。 */
const NPM_CPU_TO_PROCESS_ARCH = { x64: 'x64', arm64: 'arm64', ia32: 'ia32', arm: 'arm' }

/**
 * 判断一个 npm 包名是否是「平台专属包」形态 `<scope?>/<name>-<os>-<arch>[-<abi>]`，
 * 并在是的情况下解出 `{ os, arch, abi }`（转成 `process.platform`/`process.arch` 口径）。
 *
 * ## 为什么必须是「解析法」而不是「包名白名单」（本条是 2026-10-12 事故的直接对策）
 *
 * 旧实现只硬编码补齐 `@koromix/koffi` 一个包，并在注释里断言
 * *"Only `koffi` currently has platform-specific optional deps"*。
 * 那句话**已经不成立**：交叉打出的 win32 产物里，除了 koffi（被补上了），
 * 还有 **三个**平台专属包只带了宿主（darwin）那份、缺目标（win32）那份：
 *
 *   - `@img/sharp-win32-x64`            ← `sharp`（`dsh-attachment-local` 顶层 `import sharp`）
 *   - `node-addon-require-builtin-win32-x64-msvc` ← cordis loader 取 Node internal ESM loader
 *   - `@vscode/ripgrep-win32-x64`       ← `dsh-tool-fs-search`（Agent 文件搜索）
 *
 * 后果不是「某个功能降级」，而是**宿主插件树整体加载失败 ⇒ 应用白屏起不来**
 * （2026-10-12 在 Windows 11 真机实测坐实）。⇒ 结论：**逐个补包名的写法已经漏了三个，
 * 不能再靠维护一张白名单**；改为按命名规律枚举，才不会再漏第四个。
 *
 * 结尾的 `-<abi>` 段是可选的：`node-addon-require-builtin-win32-x64-msvc` 就带 `msvc`，
 * 而 `@img/sharp-win32-x64` 不带。解析取「最右能构成 os/arch 的那一段」。
 *
 * @param name - npm 包名（可带 scope）。
 * @returns 解出的平台信息；不是平台包时返回 `undefined`。
 */
function parsePlatformPackageName(name) {
  const bare = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  const parts = bare.split('-')
  // 从右往左找第一组 (os, arch)：允许 os 前面还有别的横线段（如 `sharp-libvips`、`ripgrep`）。
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const os = NPM_OS_TO_PROCESS_PLATFORM[parts[i]]
    const arch = NPM_CPU_TO_PROCESS_ARCH[parts[i + 1]]
    if (os === undefined || arch === undefined) continue
    // `-<abi>` 后缀（msvc/gnu/musl…）是允许的，且它必须位于 arch 之后且只剩一段。
    const rest = parts.slice(i + 2)
    if (rest.length > 1) continue
    return { os, arch, abi: rest[0] ?? '', prefix: parts.slice(0, i).join('-'), scoped: name.startsWith('@') }
  }
  return undefined
}

/**
 * 从 registry 取一个平台专属包，解压到闭包的 `node_modules/<name>`。
 * 版本**由调用方 pin 死**（取自主包声明的那份，不猜），并在落盘后按 `expectOs`/`expectArch`
 * 校验其 `package.json` 的 `os`/`cpu` 字段——**下载成功 ≠ 拿对了平台**。
 *
 * @returns `true` 表示新装入，`false` 表示目标已存在（幂等）。
 */
async function fetchPlatformPackage(name, version) {
  const top = join(HOST_DIR, 'node_modules')
  const dest = join(top, name)
  if (existsSync(join(dest, 'package.json'))) return false
  const shortName = name.split('/').pop()
  const url = `https://registry.npmjs.org/${name}/-/${shortName}-${version}.tgz`
  console.log(`[pack-macos] platform top-up: fetching ${name}@${version}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`pack-macos: platform top-up failed: HTTP ${response.status} for ${url}`)
  const tgz = join(tmpdir(), `${shortName}-${version}-${process.pid}.tgz`)
  await writeFile(tgz, Buffer.from(await response.arrayBuffer()))
  const extractDir = join(tmpdir(), `corum-platform-${process.pid}-${shortName}`)
  await rm(extractDir, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })
  try {
    // 系统 tar 保持零依赖（与 fetch-node.mjs 一致；Windows 10+ 亦自带 tar）。
    await run('extract platform package', 'tar', ['-xzf', tgz, '-C', extractDir])
    await mkdir(dirname(dest), { recursive: true })
    await cp(join(extractDir, 'package'), dest, { recursive: true })
  } finally {
    await rm(extractDir, { recursive: true, force: true })
    await rm(tgz, { force: true })
  }
  return true
}

/**
 * 把宿主闭包**整体校正到目标平台**：目标平台该有的平台专属包补齐，宿主平台多余的删掉。
 *
 * ## 为什么不是「只补 koffi」（2026-10-12 事故）
 *
 * 见 {@link parsePlatformPackageName} 的说明：白名单漏了三个包，导致 Windows 产物白屏。
 * 本函数改为**枚举闭包内所有包的 `optionalDependencies`**，凡是解析成平台专属包形态的，
 * 都按目标平台对齐。
 *
 * ## 三个刻意的设计决定
 *
 * 1. **版本取自「主包声明的那份」**，不是 `latest`：闭包是 `pnpm deploy --frozen-lockfile`
 *    物化出来的，主包声明的版本就是锁文件钉住的版本。取 `latest` 会在目标平台上装出与
 *    宿主不同小版本的二进制（静默的行为漂移）。
 * 2. **只在 `目标 ≠ 宿主` 时动手**：本机打包时闭包本来就是对的，**不动**它——避免把 macOS
 *    既有正确行为改坏（P0 的删除分支尤其危险，必须收紧到交叉路径）。
 * 3. **下载后校验 `os`/`cpu` 字段**：HTTP 200 只证明取到了文件，不证明取对了平台。
 *
 * ## 豁免（不要「顺手修」，它们不是缺陷）
 *
 * - `@deepseek-ai/node-addon-system`：**上游就没有 win32 包**（只有 darwin/linux），
 *   且解析不到时 `lib/index.js` **返回 `undefined`**（优雅降级）；`lib/flock.js` 对
 *   非 linux/darwin 显式抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM` = 正确的能力拒绝。
 * - `node-pty`：**单包内含全平台 prebuilds**，运行期按平台自选，本就不需要平台专属包。
 * - `@deepseek-ai/dsh-win32-process`：**纯 JS**，名字自带 win32 但不是平台专属二进制包。
 *
 * ⇒ 判据是「**按 `process.platform` 硬解析的包，其目标平台那份必须能解析到**」，
 * **不是**「产物里不许出现 darwin 字样」——后者会把上面三项与 `node-pty` 全平台 prebuild
 * 一起误报。
 *
 * @param targetPlatform - `darwin` | `linux` | `win32`；空串表示宿主。
 * @param targetArch - `arm64` | `x64`；必须是**目标**的，不是宿主的。
 * @returns `{ added, removed }` 计数。
 */
async function topUpPlatformPackages(targetPlatform, targetArch) {
  const platform = targetPlatform === '' ? process.platform : targetPlatform
  const arch = targetArch === '' ? process.arch : targetArch
  const top = join(HOST_DIR, 'node_modules')
  const result = { added: 0, removed: 0 }
  // 本机打包：闭包天然正确，一个字都不动（见设计决定 ②）。
  if (platform === process.platform && arch === process.arch) return result

  // ── 枚举：扫闭包内每个包的 optionalDependencies，收集平台专属包 → 其主包与 pin 版本。
  // 用 Map 去重（同一个平台包可能被多个主包声明，版本应一致；不一致时保留先见者并告警）。
  const wanted = new Map()
  for (const entry of await readdir(top, { withFileTypes: true })) {
    const owners = entry.name.startsWith('@') && entry.isDirectory()
      ? (await readdir(join(top, entry.name), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => `${entry.name}/${e.name}`)
      : (entry.isDirectory() ? [entry.name] : [])
    for (const owner of owners) {
      let manifest
      try {
        manifest = JSON.parse(await readFile(join(top, owner, 'package.json'), 'utf8'))
      } catch {
        continue // 非包目录 / 无 manifest，跳过
      }
      for (const [depName, depSpec] of Object.entries(manifest.optionalDependencies ?? {})) {
        const parsed = parsePlatformPackageName(depName)
        if (parsed === undefined) continue
        const version = typeof depSpec === 'string' ? depSpec.replace(/^[\^~>=<\s]*/, '') : undefined
        if (version === undefined || version === '') continue
        if (!wanted.has(depName)) wanted.set(depName, { parsed, version, owner })
      }
    }
  }

  // ── 补齐：目标平台的留下/取回；宿主平台的（非目标）删掉。
  for (const [name, { parsed, version, owner }] of wanted) {
    const matchesTarget = parsed.os === platform && parsed.arch === arch
    const dest = join(top, name)
    const present = existsSync(join(dest, 'package.json'))
    if (matchesTarget) {
      if (!present) {
        if (await fetchPlatformPackage(name, version)) {
          result.added += 1
          // 校验：文件在 ≠ 平台对（HTTP 200 也可能是别的架构）。
          // `os`/`cpu` 字段在 npm 包里可能是字符串或单元素数组，两种都接。
          const got = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'))
          const gotCpu = Array.isArray(got.cpu) ? got.cpu[0] : got.cpu
          const gotOs = Array.isArray(got.os) ? got.os[0] : got.os
          if (gotCpu !== undefined && gotCpu !== arch) {
            throw new Error(`pack-macos: ${name}@${version} declares cpu=${gotCpu}, expected ${arch}`)
          }
          if (gotOs !== undefined && gotOs !== platform) {
            throw new Error(`pack-macos: ${name}@${version} declares os=${gotOs}, expected ${platform}`)
          }
          console.log(`[pack-macos] platform top-up: +${name} (for ${owner})`)
        }
      }
      continue
    }
    // 非目标平台：只删「确实是别的平台专属」的那份，且仅在它是平台专属包时（解析已保证）。
    if (present && parsed.os !== platform) {
      await rm(dest, { recursive: true, force: true })
      result.removed += 1
      console.log(`[pack-macos] platform prune: -${name} (host-only, target is ${platform}-${arch})`)
    }
  }
  return result
}

/**
 * 闭包平台完整性**硬断言**（P0 的第二道闸）：出包前证明「目标平台该有的原生绑定都在、
 * 宿主独有的已清」。这是 2026-10-12 白屏事故的直接对策——当时**没有任何守卫**覆盖这一层：
 *
 * - `checkNodeRuntimePlatform()`（corum-smoke）只看 `build/node` 一个二进制；
 * - `verify-electron-pin.mjs` 交叉定向时**明确跳过**二进制身份校验；
 * - `smokeBridge()` 在交叉时 boot 的是宿主闭包（**假绿**，见该函数注释）。
 *
 * 判据**不做**「不许出现 darwin 字样」这种字符串扫描（会误报 `node-addon-system`、
 * `node-pty` 全平台 prebuilds、`getMachineId-darwin.js` 等合法内容）；而是**按解析**：
 * 对闭包里每个能解析成平台专属包的目录，断言其 `os`/`cpu` 与目标一致。
 *
 * @param targetPlatform - 目标平台；空串表示宿主。
 * @param targetArch - 目标架构。
 */
async function assertPlatformClosure(targetPlatform, targetArch) {
  const platform = targetPlatform === '' ? process.platform : targetPlatform
  const arch = targetArch === '' ? process.arch : targetArch
  const top = join(HOST_DIR, 'node_modules')
  const wrong = []
  let checked = 0
  const scan = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (prefix === '' && entry.name.startsWith('@')) {
        await scan(join(dir, entry.name), entry.name)
        continue
      }
      const parsed = parsePlatformPackageName(name)
      if (parsed === undefined) continue
      // 只检查顶层 `node_modules/<name>`（嵌套副本由 dedupe 收拾，不在这里判）。
      checked += 1
      if (parsed.os !== platform || parsed.arch !== arch) {
        wrong.push(`${name} (is ${parsed.os}-${parsed.arch}, want ${platform}-${arch})`)
      }
    }
  }
  await scan(top, '')
  if (wrong.length > 0) {
    throw new Error(
      `pack-macos: 闭包平台校正未完成 —— ${wrong.length} 个平台专属包不属于目标 ${platform}-${arch}：\n`
      + wrong.map((w) => `  - ${w}`).join('\n')
      + '\n这类包只能加载「运行平台」的那一份，混装会让宿主插件树在目标平台上加载失败（应用白屏）。',
    )
  }
  if (checked === 0 && platform !== process.platform) {
    throw new Error(
      `pack-macos: 交叉出包（${process.platform}-${process.arch} → ${platform}-${arch}）却**一个平台专属包都没扫到** —— `
      + '这几乎一定是枚举逻辑失效（例如闭包布局变化），不是「目标平台不需要任何原生绑定」。拒绝静默出包。',
    )
  }
  console.log(`[pack-macos] platform closure assertion OK：${checked} 个平台专属包全部属于 ${platform}-${arch}`)
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
 *   - corum-desktop 的身份 + `exports`：healProfilesModuleFallback 会把 app 名
 *     (`corum-desktop`) 自链到 host 目录，plugin loader 再经 `exports` 解析
 *     `corum-desktop/modules` / `corum-desktop/connection` 子路径到 lib/；`dsh.client`
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

/** 把 corum-desktop 自身的运行产物复制进 host 目录 */
async function copyDesktopArtifacts() {
  const destLib = join(HOST_DIR, 'lib')
  await cp(DESKTOP_LIB, destLib, { recursive: true, dereference: true })
  await cp(join(DESKTOP_ROOT, 'cordis.patch.yml'), join(HOST_DIR, 'cordis.patch.yml'), { dereference: true })
  // IDE-mode overlay: a REQUIRED patch layer when the desktop mode resolves to
  // `ide` — its absence in the packaged layout would fail a `--ide` launch
  // (loadOverlayPatches throws on a missing file). Ship it beside the desktop patch.
  await cp(join(DESKTOP_ROOT, 'cordis.ide.patch.yml'), join(HOST_DIR, 'cordis.ide.patch.yml'), { dereference: true })
  await writeHostManifest()
  // fork #14（@corum/corum-fs-local）在闭包里必须带上：官方 `dsh-fs-sandbox`（桌面 base
  // 真正的 ctx.fs provider）是它的子类，靠 pnpm-workspace.yaml 的
  // `'@deepseek-ai/dsh-fs-local': link:...` 生效。deploy 产物里那条是**指向工作区的软链**，
  // 由上面的 cp(dereference) 实体化 —— 但若工作区里 fork 没构建（lib 缺）或那条 override
  // 被改回版本钉，闭包会静默少掉它，用户那侧表现为 edit 失败提示退化（甚至 provider 加载失败）。
  // 打包期报出来，别留给用户发现。
  const stagedFsLocal = join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh-fs-local')
  const forkIndex = join(stagedFsLocal, 'lib', 'index.js')
  if (!existsSync(forkIndex)) {
    throw new Error(`pack-macos: @deepseek-ai/dsh-fs-local missing from the host closure at ${forkIndex} — build @corum/corum-fs-local and keep the pnpm-workspace.yaml link: override`)
  }
  const forkSource = readFileSync(forkIndex, 'utf8')
  if (!forkSource.includes('Closest places in the file')) {
    throw new Error('pack-macos: the host closure resolved dsh-fs-local to the OFFICIAL package, not @corum/corum-fs-local — check pnpm-workspace.yaml overrides (link:) and rebuild the fork')
  }
  // fork #16（@corum/corum-tools）在闭包里必须带上：官方 `errorMessage`/`toolErrorResult` 是模块
  // 私有、不可装饰，fork 靠 `'@deepseek-ai/dsh-tools': link:...` 生效。闭包退回官方会让工具失败
  // 的「无 message 对象」又退化成 [object Object]——打包期报出来，别留给用户发现。
  const stagedTools = join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh-tools')
  const toolsIndex = join(stagedTools, 'lib', 'index.js')
  if (!existsSync(toolsIndex)) {
    throw new Error(`pack-macos: @deepseek-ai/dsh-tools missing from the host closure at ${toolsIndex} — build @corum/corum-tools and keep the pnpm-workspace.yaml link: override`)
  }
  const toolsSource = readFileSync(toolsIndex, 'utf8')
  if (!toolsSource.includes('JSON.stringify(error)')) {
    throw new Error('pack-macos: the host closure resolved dsh-tools to the OFFICIAL package, not @corum/corum-tools — check pnpm-workspace.yaml overrides (link:) and rebuild the fork')
  }
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
  // Shipped official skill set: staged beside the host runtime so
  // `@corum/corum-skill-manager`'s resolveShippedSkillsRoot() finds
  // `<runtime>/shipped-skills/` by the same up-walk anchor in the app, and the
  // repo layout `packages/desktop/shipped-skills/` in a source checkout.
  await rm(SHIPPED_SKILLS_DIR, { recursive: true, force: true })
  if (existsSync(SHIPPED_SKILLS)) {
    await cp(SHIPPED_SKILLS, SHIPPED_SKILLS_DIR, { recursive: true, dereference: true })
  } else {
    // 缺了它，「设置 → 技能 → 导入内置技能」会在真机上退化成
    // ok:false「未找到内置技能目录」——打包期就报出来，不要留给用户发现。
    throw new Error(`pack-macos: shipped-skills missing at ${SHIPPED_SKILLS}`)
  }
  // Shipped Agent-preset module set: staged beside shipped-skills for the same
  // reason (`@corum/corum-preset-modules`'s resolveShippedModulesRoot() up-walks to
  // `<runtime>/shipped-modules/` in the app and `packages/desktop/shipped-modules/`
  // in a source checkout). 2026-10-14: corum-dev 已移到独立仓库，shipped-modules
  // 可能为空——没有随包模块时跳过 staging。
  await rm(SHIPPED_MODULES_DIR, { recursive: true, force: true })
  if (existsSync(SHIPPED_MODULES)) {
    await cp(SHIPPED_MODULES, SHIPPED_MODULES_DIR, { recursive: true, dereference: true })
  } else {
    console.log('[pack-macos] shipped-modules 不存在，跳过（corum-dev 已移到独立仓库）')
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

  // ── 交叉定向时的**假绿护栏**（2026-10-12 事故教训，必读） ────────────────────
  //
  // 本函数用 `process.execPath`（**宿主**的 Node）去 boot 闭包。本机打包时这就是目标平台
  // 的运行时，判据为真；但**交叉打包时它 boot 的是「宿主平台视角下」的闭包**——
  // `process.platform` 仍是宿主，于是 `require('@vscode/ripgrep')` 去取 `ripgrep-darwin-arm64`
  // （**在**）⇒ 通过。同一份闭包拿到 Windows 上才暴露 `ripgrep-win32-x64` 缺失。
  //
  // 实证：2026-10-12 用 `pack.mjs win32` 在 macOS 上打包，本函数照样打印了
  // `host bridge boots OK (ready emitted)`，而那个包在 Windows 真机上**白屏起不来**。
  // ⇒ **在错误平台语义下做的自检证明不了目标平台的可用性**，必须显式拦住，
  // 否则它比「没有自检」更糟（给出虚假信心）。
  const targetPlatform = CORUM_TARGET_PLATFORM === '' ? process.platform : CORUM_TARGET_PLATFORM
  const targetArch = CORUM_TARGET_ARCH === '' ? process.arch : CORUM_TARGET_ARCH
  if (targetPlatform !== process.platform || targetArch !== process.arch) {
    console.warn(
      `[pack-macos] ⚠️  跳过宿主闭包自检：本次是**交叉出包**（宿主 ${process.platform}-${process.arch}`
      + ` → 目标 ${targetPlatform}-${targetArch}），而自检只能用宿主的 Node 跑宿主的闭包，`
      + `对目标平台**无判别力**。\n`
      + `            目标平台的启动验证必须在该平台本机进行（CI 的三平台矩阵各自出包，或真机）。\n`
      + `            本步已判定的内容仍有效：闭包平台断言（assertPlatformClosure）已证明`
      + ` ${targetPlatform}-${targetArch} 的平台专属包齐备且无宿主残留。`,
    )
    return
  }

  const smokeHome = join(DESKTOP_ROOT, 'build', '.smoke-home')
  try {
    await new Promise((resolveSmoke, reject) => {
    // Redirect the harness home into the build staging tree (OUTSIDE host/ so
    // electron-builder does not bundle it into the .app): the real default
    // (~/.corum-desktop) may be outside the sandbox's writable area, and the smoke
    // only needs to prove the closure boots — it must not touch the developer's
    // real desktop-home.
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
    // 带退避重试：Windows 上刚 kill 的子进程可能还占着 sqlite WAL 句柄，
    // 立刻 rm 会 EBUSY（2026-10-10 Windows 实机 measured）。POSIX 上 unlink
    // 打开文件合法、重试一次即过，故全平台同一路径无行为差异。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(smokeHome, { recursive: true, force: true })
        break
      } catch (error) {
        const code = error?.code
        if (attempt >= 9 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY')) throw error
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
}

/**
 * UI 插件「样式内联」断言（2026-09-20 新增，防复发）。
 *
 * ## 为什么
 *
 * 每个 client UI 插件的构建链是 `tsc -b && tsdown && node scripts/inline-css.mjs`：
 * tsdown 会重建干净的 lib/client.js 并把样式抽到 lib/style.css，最后一步必须把样式
 * 内联回 client.js（client bundle 是 CJS、经 window.__ModuleLoader__.load 注入，
 * 不能 import CSS 文件）。只跑到 tsdown 的「中间态」= client.js 无内联标记 +
 * 孤儿 lib/style.css，打包态对应插件面板整体无样式（2026-09-20 实测
 * @corum/corum-ui-questions 提问面板选项全裸）。
 *
 * ## 口径
 *
 * 与各包 scripts/inline-css.mjs 的幂等判定一致：lib/client.js 必须含**本插件专属**
 * 标记 `s.setAttribute('data-plugin','<PLUGIN_ID>')`（不能看泛 'data-plugin'——
 * 业务源码可能出现该字符串，corum-ide-plugin-manager-ui 就因此被误判过；引号形态
 * 单引号/双引号——trajectory 脚本用 JSON.stringify——都要认），且
 * lib/style.css 不允许残留（孤儿样式 = tsdown 过、inline-css 未过的中间态）。
 *
 * 扫描范围：packages/plugins 下所有含 scripts/inline-css.mjs 的包（client UI 插件
 * 全集；哪怕暂时不在 desktop-host 闭包里也要过——下次把它补进闭包时不能再踩同一坑）。
 * 在打包物化之前跑，任一不满足即 fail loud，绝不把无样式 UI 打进 .app。
 */
async function assertUiPluginStylesInlined() {
  const failures = []
  const pluginsRoot = join(root, 'packages', 'plugins')
  for (const group of await readdir(pluginsRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(pluginsRoot, group.name)
    for (const pkg of await readdir(groupDir, { withFileTypes: true })) {
      const pkgDir = join(groupDir, pkg.name)
      if (!pkg.isDirectory() || !existsSync(join(pkgDir, 'scripts', 'inline-css.mjs'))) continue
      const name = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')).name
      const clientJs = join(pkgDir, 'lib', 'client.js')
      const styleCss = join(pkgDir, 'lib', 'style.css')
      if (!existsSync(clientJs)) {
        failures.push(`${name}：lib/client.js 缺失 — 先跑 pnpm --filter ${name} run build`)
        continue
      }
      const client = readFileSync(clientJs, 'utf8')
      // 注入产物里 setAttribute 的引号形态有两种：多数脚本是字面单引号
      // `s.setAttribute('data-plugin','<id>')`，corum-ui-trajectory 的脚本用
      // JSON.stringify(pluginId) 生成双引号形态——两种都要认，别把已注入误判成未注入。
      const marker = `s.setAttribute('data-plugin','${name}')`
      const markerDouble = `s.setAttribute('data-plugin',"${name}")`
      if (!client.includes(marker) && !client.includes(markerDouble)) {
        failures.push(`${name}：lib/client.js 无内联样式标记（data-plugin）— 先跑 pnpm --filter ${name} run build`)
      }
      if (existsSync(styleCss)) {
        failures.push(`${name}：lib/style.css 残留（孤儿样式 = tsdown 过、inline-css 未过）— 先跑 pnpm --filter ${name} run build`)
      }
    }
  }
  if (failures.length > 0) {
    for (const line of failures) console.error(`[pack-macos] ✗ ${line}`)
    throw new Error(`pack-macos: ${failures.length} 个 UI 插件包未过完整构建（样式未内联，详见上一行）— 逐个先跑 pnpm --filter <pkg> run build 后重打包`)
  }
  console.log('[pack-macos] UI 插件样式内联断言通过（client.js 含 data-plugin 标记、无孤儿 lib/style.css）')
}

/**
 * 闭包版本一致性硬断言：`pnpm deploy --legacy` 忽略 lockfile 重新解析，
 * `^0.1.3-alpha.1` 会漂到 registry 上的 alpha.2 —— 2026-09-09 实测正式包闭包里
 * 131 个 dsh 包是 alpha.2 而 session 核心是 alpha.1，冷读历史日志直接报
 * 「failed to observe session ... events is not iterable」（用户可见：会话打不开）。
 * 这里在打包时逐个读 package.json，任何 dsh 包与 deploy 根的钉定版本不一致就
 * fail loud，绝不把混版闭包打进 .app。
 *
 * fork 替身（2026-09-13 修正）：判定口径是「**官方** dsh 包版本一致」，因此按
 * manifest.name 是否在 `@deepseek-ai/` 作用域过滤，而不是按目录名。我们的 fork 经
 * `pnpm-workspace.yaml` 的 `link:` override **顶在官方目录名下**
 * （`node_modules/@deepseek-ai/dsh-fs-local` 里是 `@corum/corum-fs-local`，版本自带
 * `0.1.0`）—— 旧口径把这种**有意的替身**误判成版本混装，`pack:host` 直接失败
 * （fork #14 落地后打包一直是坏的，直到 2026-09-13 重打才暴露）。替身既不静默放行、
 * 也不误报：单独一行列出「哪些官方包被 fork 顶替」，闭包内 fork 内容的真伪由
 * `copyDesktopArtifacts()` 里的 fork #14 闭包断言负责。
 */
async function assertUniformDshVersions() {
  const deployRoot = JSON.parse(await readFile(join(DEPLOY_ROOT, 'package.json'), 'utf8'))
  const pinned = deployRoot.dependencies?.['@deepseek-ai/dsh-session']
  if (typeof pinned !== 'string' || !/^\d/.test(pinned)) {
    throw new Error('pack-macos: desktop-host must pin @deepseek-ai/dsh-session to an exact version')
  }
  const scopeDir = join(HOST_DIR, 'node_modules', '@deepseek-ai')
  const versions = new Map()
  /** 被 fork 顶替的官方包：目录名（官方名）→ 替身的 manifest.name@version。 */
  const substitutions = []
  for (const entry of await readdir(scopeDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('dsh-') || !entry.isDirectory()) continue
    const manifestPath = join(scopeDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    // fork 替身：目录是官方名、内容不是官方包 —— 不算版本混装，但必须显式可见。
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/')) {
      substitutions.push(`@deepseek-ai/${entry.name} ← ${manifest.name}@${manifest.version}`)
      continue
    }
    const list = versions.get(manifest.version) ?? []
    list.push(manifest.name)
    versions.set(manifest.version, list)
  }
  const skew = [...versions.entries()].filter(([version]) => version !== pinned)
  if (skew.length > 0) {
    const detail = skew.map(([version, names]) => `${version}: ${names.length} 个（如 ${names.slice(0, 3).join(', ')}）`).join('; ')
    throw new Error(`pack-macos: host closure has mixed dsh versions (expected ${pinned}) — ${detail}。`
      + ' 修 pnpm-workspace.yaml 的 overrides（pnpm 11 不支持 glob，需逐个钉）后重跑。')
  }
  if (substitutions.length > 0) {
    console.log(`[pack-macos] 闭包含 ${substitutions.length} 个 fork 替身（版本断言按官方包口径，替身内容另由 fork 断言把守）：`)
    for (const line of substitutions) console.log(`  - ${line}`)
  }
  console.log(`[pack-macos] dsh closure uniform at ${pinned} (${versions.get(pinned)?.length ?? 0} packages)`)
}

/** 独立检查入口（不打包）：node packages/desktop/scripts/pack-macos.mjs --check-ui-styles */
if (process.argv.includes('--check-ui-styles')) {
  await assertUiPluginStylesInlined().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
  process.exit(0)
}

/**
 * Windows 目标下断言「随包 VC++ 安装包」已暂存（2026-10-22 用户定调：
 * 「把 VC++ 内置到安装包，检测没有就启动安装」）。
 *
 * 为什么是**硬断言**而不是「缺了就跳过」：`electron-builder` 的 extraResources
 * 指向不存在的目录会直接让打包失败，但报错只指向 `build/vcredist` 这个路径，
 * 看不出「该跑哪条命令」。这里先拦一次并指名 `pack:node:win`，把失败点前移到
 * 能看懂的地方；同时也防止「不小心用 macOS 那份没带 vcredist 的 build/ 打 win 包」。
 */
async function assertVcRedistStaged() {
  const targetPlatform = CORUM_TARGET_PLATFORM === '' ? process.platform : CORUM_TARGET_PLATFORM
  if (targetPlatform !== 'win32') return
  const dir = join(root, 'packages', 'desktop', 'build', 'vcredist')
  const exe = join(dir, 'vc_redist.x64.exe')
  if (!existsSync(exe)) {
    throw new Error(
      `Windows 包必须先暂存 VC++ 运行库安装包：${exe}\n`
      + '  原因：目标机可能没装 VC++ Redistributable ⇒ 所有 MSVC 编译的 *.node 原生模块\n'
      + '        会以「ERR_DLOPEN_FAILED: The specified module could not be found」失败\n'
      + '        （文件其实存在，缺的是它依赖的 CRT DLL）。\n'
      + '  处置：先跑 `pnpm --filter corum-desktop run pack:node:win`（会下载并暂存安装包）。',
    )
  }
  const size = statSync(exe).size
  if (size < 8 * 1024 * 1024) {
    throw new Error(`VC++ 安装包尺寸异常（${size} 字节，疑似错误页）：${exe}`)
  }
  console.log(`[pack-macos] VC++ redistributable staged (${Math.round(size / 1024 / 1024)}MB) → 随包内置`)
}

async function main() {
  await assertVcRedistStaged()
  await assertUiPluginStylesInlined()
  await deployHost()
  await assertUniformDshVersions()
  await copyDesktopArtifacts()
  await materializeSymlinks(join(HOST_DIR, 'node_modules'))

  /**
   * 写构建渠道标记，供主进程判断「这是正式发布产物还是本地构建」。
   *
   * 为什么要它：本地包与线上包**版本号完全相同**（都读 package.json，而版本号由
   * release.mjs 严格校验并写台账，不能为构建期区分而篡改）。没有这个标记，界面上
   * 就分不出手上这个包是哪来的 —— 2026-10-17 用户明确要求区分。
   *
   * 判据取自「谁来跑这个脚本」：
   *   - CI（GitHub Actions）里带 `CI=true` 且由 release.yml 触发 ⇒ release
   *   - 本地 `pack:host` / `corum-instance.sh update` ⇒ local
   * 也可用 `CORUM_BUILD_CHANNEL` 显式覆盖（发布流水线若换环境仍然可控）。
   */
  const channel = process.env.CORUM_BUILD_CHANNEL?.trim()
    || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? 'release' : 'local')
  // 写进 host/ 内部：`build/host` 被 electron-builder 整体映射为 Resources/host，
  // 所以这个文件最终落在 Resources/host/build-channel，主进程从那里读。
  await writeFile(join(HOST_DIR, 'build-channel'), `${channel}\n`)
  console.log(`[pack-macos] build channel = ${channel}`)
  await smokeBridge()
  console.log('[pack-macos] host runtime staged at', HOST_DIR)
  await buildApp()
}

/**
 * 调 electron-builder 把 build/host/ 打进 .app。
 *
 * ## 为什么临时清空 `dependencies`（2026-10-15 根治 link override 兼容问题）
 *
 * electron-builder 25.x 的 `NodeModuleCopyHelper.collectNodeModules` **无条件**
 * 扫描 `package.json` 的 `dependencies`，跟踪每个依赖的 node_modules 软链。
 * corum 的 `dsh-tools` / `dsh-fs-local` 靠 `pnpm-workspace.yaml` 的 `link:`
 * override 指向**工作区源码目录**（`packages/plugins/agent/corum-tools`），
 * 该目录不在任何 `.pnpm` 条目下 ⇒ electron-builder 报
 * `corum-tools must be under .pnpm/@deepseek-ai+dsh-base@…/`。
 *
 * app 本体（`lib/main.js` 等）只 import Electron API，**不 import dependencies
 * 里的任何包**——host 运行时全在 `build/host/`（extraResources）。故 dependencies
 * 可以在打包时安全清空：electron-builder 不再扫描 node_modules，.app 不含 node_modules，
 * 运行时靠 extraResources 里的 host 闭包自解析。
 *
 * `electron` 在 `devDependencies`（不在 dependencies），`checkDependencies` 检查的是
 * devDependencies，故清空 dependencies 不影响 electron 检测。
 *
 * 做法：备份 package.json → 写一份 dependencies={} 的临时 package.json →
 * 调 electron-builder → 无论成功失败恢复原 package.json。
 */
async function buildApp() {
  const pkgPath = join(DESKTOP_ROOT, 'package.json')
  const original = await readFile(pkgPath, 'utf8')
  const pkg = JSON.parse(original)
  const savedDeps = pkg.dependencies
  pkg.dependencies = {}
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  const platform = resolveTargetPlatform()
  const arch = resolveTargetArch()
  const ebPlatform = platform === 'darwin' ? '--mac' : platform === 'win32' ? '--win' : '--linux'
  const ebArch = arch === 'arm64' ? '--arm64' : '--x64'
  console.log(`[pack-macos] electron-builder: dependencies temporarily emptied, target ${platform}-${arch}`)
  try {
    await run('electron-builder', join(DESKTOP_ROOT, 'node_modules', '.bin', 'electron-builder'), [
      ebPlatform, ebArch,
    ], { cwd: DESKTOP_ROOT })
  } finally {
    await writeFile(pkgPath, original)
    console.log('[pack-macos] package.json restored')
  }
}

await main().catch((error) => {
  console.error(error)
  process.exit(1)
})
