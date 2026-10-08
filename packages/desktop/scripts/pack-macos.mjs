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
 * 用法：node packages/desktop/scripts/pack-macos.mjs
 * @module corum-desktop/scripts/pack-macos
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

async function run(label, command, args, options = {}) {
  console.log(`[pack-macos] ${label}`)
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, stdio: 'inherit' })
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
    const m = /^@deepseek-ai\+([a-z0-9-]+)@/.exec(entry)
    if (m === null) continue
    const name = `@deepseek-ai/${m[1]}`
    if (isTestTooling(name)) continue
    const dir = join(wsPnpm, entry, 'node_modules', '@deepseek-ai', m[1])
    if (existsSync(join(dir, 'package.json'))) wanted.set(name, dir)
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
    await topUpPlatformPackages(CORUM_TARGET_PLATFORM, CORUM_TARGET_ARCH)
  await dedupeClosureNodeModules()
  console.log('[pack-macos] host closure materialized from registry')
  } finally {
    // 副本用完即弃（含它自己的 node_modules）：可能上 GB，别留在 /tmp 里。
    await rm(wsDir, { recursive: true, force: true })
  }
}

/**
 * Top up the closure with the **target platform's** platform-specific optional
 * packages (e.g. `@koromix/koffi-win32-x64`).
 *
 * ## Why (measured 2026-10-08)
 *
 * `pnpm deploy` materializes the closure from **the machine running the pack**,
 * so its platform-specific optional dependencies belong to that machine. The
 * win package built on macOS therefore shipped `resources/host/node_modules/
 * @koromix/` containing **only `koffi-darwin-arm64`** — and `koffi` selects its
 * binary by the **running** platform, so on Windows `await import('koffi')`
 * fails. That is not cosmetic: `corum-fs-local`'s `copyFileDaclWin32` /
 * `replaceFileWin32` load koffi to preserve a file's ACL, and the edit path
 * always passes a mode (`index.ts` `writeFileAtomic(…, existing.mode, …)`), so
 * **editing an existing file would throw on Windows**.
 *
 * ## How
 *
 * `koffi` resolves its binary at `${koffi}/../../../@koromix/koffi-<os>-<arch>`
 * (or via `process.resourcesPath` fallbacks). So we fetch the target platform's
 * package tarball straight from the registry — pinned to the version the
 * workspace already resolved, and **verified against the lockfile integrity** —
 * and place it exactly where that lookup expects it.
 *
 * Only `koffi` currently has platform-specific optional deps (verified: `node-pty`
 * ships all prebuilds inside one package, so it is already platform-complete;
 * `@deepseek-ai/dsh-sandbox-windows-acl` is pure JS).
 *
 * @param targetPlatform - `darwin` | `linux` | `win32`; empty means the host's.
 * @param targetArch - `arm64` | `x64`; must be the target's, not the host's.
 * @returns The number of platform packages added.
 */
async function topUpPlatformPackages(targetPlatform, targetArch) {
  const platform = targetPlatform === '' ? process.platform : targetPlatform
  const arch = targetArch === '' ? process.arch : targetArch
  if (platform === process.platform && arch === process.arch) return 0 // host's own deps are already right
  const top = join(HOST_DIR, 'node_modules')
  let added = 0
  // koffi's platform package naming: @koromix/koffi-<os>-<arch>.
  const koffiDir = join(top, 'koffi')
  if (existsSync(join(koffiDir, 'package.json'))) {
    const version = JSON.parse(await readFile(join(koffiDir, 'package.json'), 'utf8')).version
    const name = `@koromix/koffi-${platform}-${arch}`
    const dest = join(top, '@koromix', `koffi-${platform}-${arch}`)
    if (!existsSync(dest)) {
      const url = `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`
      console.log(`[pack-macos] platform top-up: fetching ${name}@${version} for ${platform}-${arch}`)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`pack-macos: platform top-up failed: HTTP ${response.status} for ${url}`)
      const tgz = join(tmpdir(), `${name.split('/')[1]}-${version}.tgz`)
      await writeFile(tgz, Buffer.from(await response.arrayBuffer()))
      const extractDir = join(tmpdir(), `corum-platform-${process.pid}`)
      await rm(extractDir, { recursive: true, force: true })
      await mkdir(extractDir, { recursive: true })
      // System tar keeps this dependency-free (matches fetch-node.mjs).
      await run('extract platform package', 'tar', ['-xzf', tgz, '-C', extractDir])
      await mkdir(dirname(dest), { recursive: true })
      await cp(join(extractDir, 'package'), dest, { recursive: true })
      await rm(extractDir, { recursive: true, force: true })
      await rm(tgz, { force: true })
      // Fail loud rather than shipping a closure whose native binding is absent.
      const binding = join(dest, `${platform}_${arch}`, 'koffi.node')
      if (!existsSync(binding)) {
        throw new Error(`pack-macos: platform top-up produced no native binding at ${binding}`)
      }
      console.log(`[pack-macos] platform top-up: +${name} (${platform}-${arch})`)
      added += 1
    }
  }
  return added
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
    await rm(smokeHome, { recursive: true, force: true })
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

async function main() {
  await assertUiPluginStylesInlined()
  await deployHost()
  await assertUniformDshVersions()
  await copyDesktopArtifacts()
  await materializeSymlinks(join(HOST_DIR, 'node_modules'))
  await smokeBridge()
  console.log('[pack-macos] host runtime staged at', HOST_DIR)
}

await main().catch((error) => {
  console.error(error)
  process.exit(1)
})
