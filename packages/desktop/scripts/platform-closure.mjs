/**
 * 宿主闭包的**平台校正纯逻辑**：枚举 → 规划 → 执行（执行那步的 I/O 由调用方注入）。
 *
 * 从 `pack-macos.mjs` 里拆出来的唯一理由是**可测**：这段逻辑的失败形态全是
 * **静默**的（补错版本的绑定、补到别人解析不到的位置、把某个副本漏掉），
 * 而真实验证它原来只有「打一个交叉包、拿到目标平台上试」一条路 —— 一轮几十分钟，
 * 且远程机器不在手边时根本做不了。拆成纯逻辑后，`tests/platform-closure.test.mjs`
 * 用临时夹具目录 + 注入的假安装器就能钉住它。
 *
 * ## 为什么是「递归」而不是「扫顶层」（2026-11-14 判定）
 *
 * 旧实现只 `readdir(HOST_DIR/node_modules)`（顶层），把每个包的 `optionalDependencies`
 * 收进一个按**包名**去重的 Map。可闭包里 koffi 有 **三份**：
 *
 *   - `<闭包>/node_modules/koffi`                                   3.1.1（顶层）
 *   - `<闭包>/node_modules/@corum/corum-fs-local/node_modules/koffi`     3.3.8（嵌套）
 *   - `<闭包>/node_modules/@deepseek-ai/dsh-fs-local/node_modules/koffi` 3.3.3（嵌套）
 *
 * koffi 的 loader 用**裸别名** `require('@koromix/koffi-win32-x64')` 取原生绑定，
 * 于是「哪一份 koffi 拿到哪一份绑定」由 Node 的向上查找决定：嵌套副本先看自己
 * 的 `node_modules`，再逐级上溯 —— 上溯到顶层就只剩 3.1.1 那份。版本不等时
 * koffi 直接抛 `Mismatched native Koffi modules`（Windows 实测：edit/覆写全挂，
 * 新建走 `linkFile` 不需要 koffi 故表现为「新建 OK、改文件失败」）。
 *
 * ⇒ 判据不是「顶层有目标平台的绑定」，而是**「每个副本都能解析到自己那个版本的绑定」**。
 * 该判据就是 {@link unresolvedPlatformBindings}，出包前的断言与单测用的是同一条。
 *
 * @module corum-desktop/scripts/platform-closure
 */

import { existsSync, readFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 平台标识：npm 的 `<os>` 取值 → 该平台上 `process.platform` 的名字。
 * 两者**大多数**同名，但 npm 侧有个别拼写不同，故显式成表而不是字符串拼接。
 */
export const NPM_OS_TO_PROCESS_PLATFORM = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'win32',
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  android: 'android',
}
/** npm 的 `<arch>` 取值 → 该平台上 `process.arch` 的名字。 */
export const NPM_CPU_TO_PROCESS_ARCH = { x64: 'x64', arm64: 'arm64', ia32: 'ia32', arm: 'arm' }

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
export function parsePlatformPackageName(name) {
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

/** 读一个包目录的 `package.json`；读不到/不是包时返回 `undefined`（闭包里混着非包目录）。 */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** npm 声明里的 `os`/`cpu` 可能是字符串或数组，取第一个值即可（两处校验口径一致）。 */
function firstOf(value) {
  return Array.isArray(value) ? value[0] : value
}

/**
 * 从依赖声明里取出**可 pin 的版本号**。
 *
 * 取 `^3.3.8` 里的 `3.3.8`、`>=3.1.1` 里的 `3.1.1`（闭包由
 * `pnpm deploy --frozen-lockfile` 物化，主包声明的就是锁文件钉住的版本）；
 * 取不到具体版本（`*`、`latest`、git/workspace 引用）时返回 `undefined` ——
 * **不猜**，猜出来的版本会在目标平台上装出与宿主不同的二进制（静默行为漂移）。
 *
 * @param spec - `optionalDependencies` 里的值。
 * @returns 具体版本号或 `undefined`。
 */
export function normalizeVersionSpec(spec) {
  if (typeof spec !== 'string') return undefined
  const matched = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(spec)
  return matched === null ? undefined : matched[1]
}

/** 一个 `node_modules` 目录下的包目录（展开一层 scope），跳过 `.bin` 等非包条目。 */
async function listPackageDirs(nodeModulesDir) {
  let entries
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = []
  for (const entry of entries) {
    // 只跟真实目录：软链（`.bin/*`）与文件（`.modules.yaml`）都不进闭包拓扑。
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      let scoped
      try {
        scoped = await readdir(join(nodeModulesDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const inner of scoped) {
        if (!inner.isDirectory() || inner.name.startsWith('.')) continue
        dirs.push({ name: `${entry.name}/${inner.name}`, dir: join(nodeModulesDir, entry.name, inner.name) })
      }
      continue
    }
    dirs.push({ name: entry.name, dir: join(nodeModulesDir, entry.name) })
  }
  return dirs
}

/** 递归深度上限：正常闭包嵌套不超过 4 层，超过说明布局异常（只记录，不无限下钻）。 */
const MAX_WALK_DEPTH = 8

/**
 * 只遍历、不做任何改动的产物，供 {@link planPlatformClosure} 消费。
 * @typedef {object} ClosureInventory
 * @property {Array<{ name: string, dir: string, isTopLevel: boolean, optionalDependencies: Record<string, string> }>} dependents
 *   闭包里**所有**声明了 `optionalDependencies` 的包（顶层与嵌套都在内）。
 * @property {Array<{ name: string, dir: string, isTopLevel: boolean, version?: string, os?: string, cpu?: string }>} present
 *   闭包里**已经存在**的平台专属包副本（按包名形态解析出来的），带它自己 manifest 里的 `os`/`cpu`。
 */

/**
 * 递归盘点闭包：谁声明了平台专属依赖、哪些平台专属包已经在（含嵌套副本）。
 *
 * @param hostDir - 闭包根（里面有 `node_modules`）。
 * @returns {@link ClosureInventory}
 */
export async function enumeratePlatformClosure(hostDir) {
  const dependents = []
  const present = []
  const walk = async (nodeModulesDir, depth) => {
    if (depth > MAX_WALK_DEPTH) return
    for (const { name, dir } of await listPackageDirs(nodeModulesDir)) {
      const manifest = readManifest(dir)
      if (parsePlatformPackageName(name) !== undefined) {
        present.push({
          name,
          dir,
          isTopLevel: depth === 0,
          version: manifest?.version,
          os: firstOf(manifest?.os),
          cpu: firstOf(manifest?.cpu),
        })
      }
      const optionalDependencies = manifest?.optionalDependencies
      if (optionalDependencies !== undefined && typeof optionalDependencies === 'object') {
        dependents.push({ name, dir, isTopLevel: depth === 0, optionalDependencies })
      }
      await walk(join(dir, 'node_modules'), depth + 1)
    }
  }
  await walk(join(hostDir, 'node_modules'), 0)
  return { dependents, present }
}

/**
 * @typedef {object} PlatformInstall
 * @property {string} name - 平台专属包名（如 `@koromix/koffi-win32-x64`）。
 * @property {string} version - 要装的版本（取自**声明它的那个副本**）。
 * @property {string} destDir - 落盘目录：必须是该副本自己能解析到的位置。
 * @property {string} ownerName - 声明它的包（日志用，定位是哪个副本缺绑定）。
 * @property {boolean} hoisted - `true` = 顶层副本补的 hoisted 槽位；`false` = 嵌套副本自己的 `node_modules`。
 */

/**
 * 把「盘点结果」折算成「要补什么、要删什么」——**纯函数**，不碰磁盘。
 *
 * ## 三条规则
 *
 * 1. **按每个副本自己的版本补**：`koffi@3.1.1` 要 `@koromix/koffi-win32-x64@3.1.1`，
 *    `koffi@3.3.8` 要 `…@3.3.8`。同名不同版本**各补一份**，去重键是
 *    `落盘路径 + 包名`，不是包名 —— 旧实现按包名去重、只留先见版本，正是 2026-11-14
 *    那次「嵌套副本拿到顶层版本的绑定」故障的直接原因。
 * 2. **补到该副本自己可解析到的位置**：顶层副本补 hoisted 槽位
 *    （`<闭包>/node_modules/<平台包>`，保持既有行为）；**嵌套副本补它自己的
 *    `node_modules`**（`<副本目录>/node_modules/<平台包>`）。后者既是 Node 向上查找的
 *    第一站（最精确、不可能被别的版本抢走），也与 pnpm 在闭包里留下的布局一致
 *    （顶层 koffi 的 darwin 绑定就落在 `koffi/node_modules/@koromix/`）。
 *    两种落点都不重复装：顶层副本从上溯到 hoisted 槽位，嵌套副本从自己那儿命中。
 *
 * ## 删除（prune）
 *
 * 目标平台不是宿主平台时，闭包里宿主的平台专属副本是纯死重（koffi 一份绑定约 9MB）。
 * 只删**同时满足**三个条件的目录，误删面因此接近零：
 * ① 包名形态解析成功；② 该包名确实被某个副本的 `optionalDependencies` 声明过
 * （纯 JS 包里长得像平台包的名字不会被碰）；③ 它**自己的 manifest** 声明了 `os` 且
 * 与目标平台不符（名字像 ≠ 真的平台专属）。
 * `arch` 不参与删除判据（沿用既有口径）：同 os 不同 arch 的绑定留在原处不会误导 loader，
 * 而删掉它只会让「本来就没补上的 arch」更难看懂。
 *
 * @param {object} input
 * @param {ClosureInventory['dependents']} input.dependents - 盘点出的依赖方。
 * @param {ClosureInventory['present']} input.present - 盘点出的现存平台包副本。
 * @param {string} input.platform - 目标平台（`process.platform` 口径）。
 * @param {string} input.arch - 目标架构（`process.arch` 口径）。
 * @param {string} input.topNodeModulesDir - 闭包的顶层 `node_modules`（hoisted 槽位落在这里）。
 * @returns {{ installs: PlatformInstall[], prunes: Array<{name:string,dir:string,ownerName:string,platform:string,arch:string|undefined}>, warnings: string[] }}
 */
export function planPlatformClosure({ dependents, present, platform, arch, topNodeModulesDir }) {
  /** @type {Map<string, PlatformInstall>} key = `落盘目录\0包名`（同名不同版本可以并存）。 */
  const installs = new Map()
  const declaredNames = new Set()
  const warnings = []
  const addInstall = (destDir, ownerName, name, version, hoisted) => {
    const key = `${destDir}\u0000${name}`
    const existing = installs.get(key)
    if (existing !== undefined) {
      // 同一个落盘位置被两个副本以不同版本要求：闭包布局病态，说清楚而不是静默挑一个。
      if (existing.version !== version) {
        warnings.push(`${name} 在 ${destDir} 被两个版本同时要求（${existing.version} ← ${existing.ownerName} / ${version} ← ${ownerName}），保留先见者`)
      }
      return
    }
    installs.set(key, { name, version, destDir, ownerName, hoisted })
  }
  for (const dependent of dependents) {
    for (const [depName, depSpec] of Object.entries(dependent.optionalDependencies)) {
      const parsed = parsePlatformPackageName(depName)
      if (parsed === undefined) continue
      declaredNames.add(depName)
      // 只补目标平台那一份；其余平台的由 prune 分支处理（或原样留着）。
      if (parsed.os !== platform || parsed.arch !== arch) continue
      const version = normalizeVersionSpec(depSpec)
      if (version === undefined) {
        warnings.push(`${dependent.name} 声明 ${depName}@"${depSpec}" 取不到具体版本，跳过（不猜版本）`)
        continue
      }
      // 顶层副本 → hoisted 槽位（既有行为，闭包断言按顶层目录判定）；
      // 嵌套副本 → 它自己的 node_modules（它向上查找的第一站，别的版本抢不走）。
      addInstall(
        dependent.isTopLevel
          ? join(topNodeModulesDir, depName)
          : join(dependent.dir, 'node_modules', depName),
        dependent.name,
        depName,
        version,
        dependent.isTopLevel,
      )
    }
  }
  const prunes = []
  for (const copy of present) {
    if (!declaredNames.has(copy.name)) continue
    if (copy.os === undefined || copy.os === platform) continue
    prunes.push({ name: copy.name, dir: copy.dir, ownerName: copy.name, platform: copy.os, arch: copy.cpu })
  }
  return { installs: [...installs.values()], prunes, warnings }
}

/**
 * 从某个包目录出发，按 Node 的向上查找规则找一个平台专属包能解析到的位置。
 *
 * 判据只用「逐级 `node_modules`」这一层语义：对 `fromDir` 依次试
 * `<dir>/node_modules/<name>`，再上溯到父目录，直到根。
 *
 * @param fromDir - 发起解析的包目录（不是文件）。
 * @param name - 平台专属包名。
 * @returns `{ dir, version }`；解析不到时 `undefined`。
 */
export function resolvePlatformBinding(fromDir, name) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) {
      return { dir: candidate, version: readManifest(candidate)?.version }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 闭包平台校正的**唯一判据**：有没有副本拿不到「自己那个版本」的绑定。
 *
 * 返回空数组 = 每一份 koffi/sharp/ripgrep 副本都能解析到版本相符的原生绑定。
 * 这是出包前断言（`assertPlatformClosure`）与单测共用的同一条判据 ——
 * 「补了哪些包」不是判据，「每一份副本都解析到自己那个版本」才是。
 *
 * @param {object} input
 * @param {ClosureInventory['dependents']} input.dependents - 盘点出的依赖方。
 * @param {string} input.platform - 目标平台。
 * @param {string} input.arch - 目标架构。
 * @returns {Array<{ owner: string, dir: string, name: string, want: string|undefined, found?: string, reason: string }>}
 *   `dir` 是**副本目录**：同名包可能有多份（koffi 三份），只报包名会让报错无法定位是哪一份。
 */
export function unresolvedPlatformBindings({ dependents, platform, arch }) {
  const missing = []
  for (const dependent of dependents) {
    for (const [depName, depSpec] of Object.entries(dependent.optionalDependencies)) {
      const parsed = parsePlatformPackageName(depName)
      if (parsed === undefined || parsed.os !== platform || parsed.arch !== arch) continue
      const want = normalizeVersionSpec(depSpec)
      const found = resolvePlatformBinding(dependent.dir, depName)
      if (found === undefined) {
        missing.push({ owner: dependent.name, dir: dependent.dir, name: depName, want, reason: '解析不到（副本旁没有该平台绑定）' })
        continue
      }
      if (want !== undefined && found.version !== want) {
        missing.push({ owner: dependent.name, dir: dependent.dir, name: depName, want, found: found.version, reason: '版本不符' })
      }
    }
  }
  return missing
}

/**
 * 执行平台校正：盘点 → 规划 → 删死重 → 补齐。
 *
 * 落盘动作由 `install` 注入，本函数因此**可单测**（夹具 + 假安装器），
 * 也能在交叉打包时复用（真安装器见 `pack-macos.mjs` 的 `installPlatformPackage`）。
 *
 * 幂等：已存在**且版本相符**的落盘位置直接跳过；已存在但版本不符时**替换**
 * ——「那个位置已经有一个错的版本」正是 2026-11-14 的故障形态，不能静默放过。
 *
 * @param {object} input
 * @param {string} input.hostDir - 闭包根（`build/host`）。
 * @param {string} input.platform - 目标平台。
 * @param {string} input.arch - 目标架构。
 * @param {(name: string, version: string, destDir: string) => Promise<boolean>} input.install
 *   把一个平台包装到 `destDir`；返回 `true` 表示确实写入。
 * @param {(message: string) => void} [input.log] - 日志出口（默认丢弃）。
 * @returns {Promise<{ added: number, removed: number, installs: number, prunes: number }>}
 */
export async function topUpPlatformClosure({ hostDir, platform, arch, install, log = () => {} }) {
  const topNodeModulesDir = join(hostDir, 'node_modules')
  const { dependents, present } = await enumeratePlatformClosure(hostDir)
  const plan = planPlatformClosure({ dependents, present, platform, arch, topNodeModulesDir })
  for (const warning of plan.warnings) log(`platform top-up: ${warning}`)

  let removed = 0
  for (const prune of plan.prunes) {
    await rm(prune.dir, { recursive: true, force: true })
    removed += 1
    log(`platform prune: -${prune.name} (${prune.platform}-${prune.arch ?? '?'}, target is ${platform}-${arch})`)
  }

  let added = 0
  for (const want of plan.installs) {
    if (existsSync(join(want.destDir, 'package.json'))) {
      const current = readManifest(want.destDir)?.version
      if (current === want.version) continue
      log(`platform top-up: 替换 ${want.name}@${current ?? '?'} → ${want.version}（${want.ownerName}）`)
      await rm(want.destDir, { recursive: true, force: true })
    }
    if (await install(want.name, want.version, want.destDir)) {
      added += 1
      log(`platform top-up: +${want.name}@${want.version}（for ${want.ownerName}${want.hoisted ? '，hoisted' : ''} → ${want.destDir}）`)
    }
  }
  return { added, removed, installs: plan.installs.length, prunes: plan.prunes.length }
}
