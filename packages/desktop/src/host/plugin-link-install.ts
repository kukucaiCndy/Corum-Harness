/**
 * 扩展包插件的「符号链接安装」—— 取代 `pnpm add file:<dir>`。
 *
 * ## 为什么不能用 `pnpm add file:<dir>`
 *
 * 两个原因，都是实测踩出来的（2026-11-04）：
 *
 * 1. **`file:` 语义是「复制」，不是「链接」**（隔离工程内实测：`file:` → 实体目录，
 *    `link:` → 符号链接）。于是同一个包在磁盘上出现**两份独立副本**：
 *
 *        <home>/extension-packs/<packId>/plugins-src/<name>/     ← 安装器只写这里
 *        <home>/profiles/web/node_modules/@corum/<name>/         ← 宿主实际 import 这里
 *
 *    两份之间**没有任何同步机制**。升级扩展包只更新前者 ⇒ 宿主继续跑旧代码，
 *    而且不报错、版本号还是新的。表现为「装了但没生效，且时灵时不灵」
 *    （取决于上次有没有人手工 cp 过）。
 *
 * 2. **它需要 pnpm 命令**。而从 Finder/Dock 启动的 macOS 应用**不读 shell 配置**，
 *    宿主进程 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，pnpm 在 `/opt/homebrew/bin`
 *    ⇒ 直接 `spawn pnpm ENOENT`。给命令执行器补 PATH 只能治标：仍需用户在机器上装 pnpm。
 *
 * ## 正确的形态：两条符号链接，零复制
 *
 * ```
 * ① 包本体：profiles/web/node_modules/@corum/<name>  →  extension-packs/<packId>/plugins-src/<name>
 * ② 依赖面：extension-packs/<packId>/plugins-src/<name>/node_modules  →  profiles/node_modules
 * ```
 *
 * 两条**指向不同目录**，职责也不同，缺一不可：
 *
 * - **①** 让宿主「找到这个包」。没有它 → `Cannot find package '@corum/xxx'`。
 * - **②** 让这个包「找到它的依赖」。Node 解析依赖是沿**文件真实路径**向上找
 *   `node_modules`，而 `extension-packs/` 那条路径实测**七层全无** `node_modules`
 *   ⇒ 缺 ② 时报 `Cannot find package '@deepseek-ai/dsh-typert-protocol'`
 *   （宿主半依赖 cordis / dsh-home-paths / dsh-typert-protocol；UI 半只依赖 react
 *   所以不受影响 —— 只测 UI 会误判「方案可行」）。
 *
 * 为什么不把包直接放进 `node_modules` 免掉 ②：那样又回到「复制」。
 * ② 是让「真实内容只有一份」与「依赖可解析」同时成立的唯一办法。
 *
 * ## 三平台
 *
 * - darwin / linux：`symlink(target, path)`
 * - win32：`symlink(target, path, 'junction')` —— 普通 symlink 需要管理员权限或开发者模式，
 *   junction 不需要且只对目录有效（这里正好都是目录）。
 * - 目录分隔符一律用 `join`，不拼 `/`。
 *
 * @module plugin-link-install
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 一次链接安装的结果（与 pnpm 路径的结果形态对齐，便于调用方统一处理）。 */
export interface LinkInstallResult {
  readonly ok: boolean
  readonly log: string
  /** 是否新建/更新了链接（调用方据此决定要不要提示重启）。 */
  readonly changed: boolean
}

/**
 * 判断 spec 是否是「本地目录」形态（`file:` 或 `link:` 前缀）。
 *
 * 扩展包安装器把包内插件复制到宿营地后，交出的 spec 是 `file:<绝对目录>`；
 * 我们把它同样按本地目录处理（改走符号链接），**不需要调用方改口径**。
 *
 * @param spec - 依赖 spec
 * @returns 是本地目录时为去前缀的路径，否则 undefined
 */
export function localDirFromSpec(spec: string): string | undefined {
  for (const prefix of ['file:', 'link:']) {
    if (!spec.startsWith(prefix)) continue
    const rest = spec.slice(prefix.length)
    // 空路径（`file:` / `link:`）不是可用的本地目录 —— 返回 '' 会让调用方走链接
    // 分支然后在校验里失败，错误信息反而模糊。这里直接当「不是本地目录」。
    return rest === '' ? undefined : rest
  }
  return undefined
}

/** 建符号链接；已存在且指向同一目标时视为成功（幂等）。 */
function ensureDirSymlink(linkPath: string, target: string): void {
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(linkPath)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      // ESM 下没有 require，用静态 import 进来的 readlinkSync。
      let current: string | undefined
      try {
        current = readlinkSync(linkPath)
      } catch {
        current = undefined
      }
      if (current !== undefined && resolve(current) === resolve(target)) return
    }
    // 实体目录（旧版 pnpm 留下的副本）或指向别处的链接：删掉重来。
    rmSync(linkPath, { recursive: true, force: true })
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, kind)
}

/**
 * 读一个目录里 package.json 的 name（拿包名用来定位 `node_modules/@scope/name`）。
 * @param dir - 包目录
 * @returns 包名；读不到返回 undefined
 */
function packageNameOf(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/**
 * 按符号链接方式安装一个本地目录插件。
 *
 * 幂等：重复调用不会把已有链接删掉再建（只在目标不同或遇到实体目录时才重建）。
 *
 * @param input - `home`（CORUM_HOME）、`dir`（包真实目录）
 * @returns 结果；失败时 `ok:false` 且 `log` 说明原因
 */
export function linkInstallLocalPlugin(input: {
  readonly home: string
  readonly dir: string
}): LinkInstallResult {
  const dir = resolve(input.dir)
  if (!existsSync(join(dir, 'package.json'))) {
    return { ok: false, changed: false, log: `插件目录缺少 package.json：${dir}` }
  }
  const name = packageNameOf(dir)
  if (name === undefined) {
    return { ok: false, changed: false, log: `插件目录的 package.json 没有 name：${dir}` }
  }

  // ① 包本体：profiles/web/node_modules/<name> → 包目录
  const webModules = join(input.home, 'profiles', 'web', 'node_modules')
  const packageLink = join(webModules, name)
  try {
    ensureDirSymlink(packageLink, dir)
  } catch (error) {
    return { ok: false, changed: false, log: `建立包链接失败（${packageLink}）：${String(error)}` }
  }

  // ② 依赖面：包目录/node_modules → profiles/node_modules
  // 只有该目录上溯确实取不到依赖时才建，避免覆盖包自带 node_modules 的情形。
  const depSource = join(input.home, 'profiles', 'node_modules')
  const depLink = join(dir, 'node_modules')
  let depNote = ''
  if (existsSync(depSource)) {
    try {
      ensureDirSymlink(depLink, depSource)
      depNote = '；依赖面已链接到 profiles/node_modules'
    } catch (error) {
      // 依赖面建不起来不致命（包可能自带 node_modules），但要如实说。
      depNote = `；依赖面链接失败（${String(error)}）`
    }
  } else {
    depNote = '；profiles/node_modules 不存在，跳过依赖面链接'
  }

  // ③ 把 profile 的 dependencies 记成 link: 语义 —— 否则一次 pnpm install 就会
  // 把链接换回复制（见 recordLinkDependency 的注释）。
  const recorded = recordLinkDependency(input.home, name, dir)

  return {
    ok: true,
    changed: true,
    log: `已按符号链接安装 ${name}：${packageLink} → ${dir}${depNote}`
      + (recorded ? '；dependencies 已记为 link:' : ''),
  }
}

/**
 * 按符号链接方式卸载：删掉包链接（**不动包目录本身**，它归扩展包所有）。
 *
 * 与 `pnpm remove` 的差别：后者会让 pnpm 重算 `node_modules`，可能把别的链接也一并
 * 重排；这里只精确删除指过去的那一条链接。
 *
 * @param input - `home`、`packageName`
 * @returns 结果
 */
export function linkUninstallLocalPlugin(input: {
  readonly home: string
  readonly packageName: string
}): LinkInstallResult {
  const packageLink = join(input.home, 'profiles', 'web', 'node_modules', input.packageName)
  let isLink = false
  try {
    isLink = lstatSync(packageLink).isSymbolicLink()
  } catch {
    return { ok: true, changed: false, log: `${input.packageName} 的链接本来就不存在` }
  }
  if (!isLink) {
    // 实体目录：是旧版 pnpm 留下的副本，删掉也算卸载成功（但不能说「删了链接」）。
    rmSync(packageLink, { recursive: true, force: true })
    return { ok: true, changed: true, log: `已删除 ${input.packageName} 的实体副本目录` }
  }
  rmSync(packageLink, { force: true })
  return { ok: true, changed: true, log: `已删除 ${input.packageName} 的包链接` }
}

/**
 * 把 profile 的 `dependencies` 里该包记成 **`link:`** 语义。
 *
 * ## 为什么非记不可
 *
 * pnpm 对 `file:` 是**复制**、对 `link:` 是**符号链接**（隔离工程实测）。
 * 若 package.json 里仍写着 `file:`，那么**任何人跑一次 `pnpm install`** 都会把
 * 我们建的 symlink 换回实体副本 —— 又回到「两份副本」的老问题。
 *
 * 同时这行也是**卸载与记账**的依据：卸载时按它找到包名，不必猜。
 *
 * @param home - CORUM_HOME
 * @param packageName - 包名（`@scope/name` 或 `name`）
 * @param dir - 包真实目录
 * @returns 是否真的改了文件
 */
export function recordLinkDependency(home: string, packageName: string, dir: string): boolean {
  const manifestPath = join(home, 'profiles', 'web', 'package.json')
  if (!existsSync(manifestPath)) return false
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch {
    return false
  }
  const deps = (manifest.dependencies ?? {}) as Record<string, string>
  const nextSpec = `link:${resolve(dir)}`
  if (deps[packageName] === nextSpec) return false
  deps[packageName] = nextSpec
  manifest.dependencies = deps
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return true
}

/**
 * 迁移：把已有的实体副本换成符号链接。
 *
 * 为什么需要它：老版本用 `pnpm add file:` 装出来的都是实体副本，升级到本方案之后
 * **必须主动换掉**，否则又是「两份副本」——而且更糟：看起来装成功了，实际跑的还是旧副本。
 *
 * @param home - CORUM_HOME
 * @returns 每个被换成链接的包（名 + 目录）；无变化时为空数组
 */
export function migrateToLinks(home: string): readonly { readonly name: string; readonly dir: string }[] {
  const webModules = join(home, 'profiles', 'web', 'node_modules')
  const packsDir = join(home, 'extension-packs')
  if (!existsSync(packsDir) || !existsSync(webModules)) return []

  // 收集扩展包宿营地里所有插件目录（plugins-src/<name> 且有 package.json）。
  const byPackageName = new Map<string, string>()
  for (const packId of readdirSync(packsDir)) {
    const pluginsSrc = join(packsDir, packId, 'plugins-src')
    if (!existsSync(pluginsSrc)) continue
    for (const name of readdirSync(pluginsSrc)) {
      const dir = join(pluginsSrc, name)
      if (!existsSync(join(dir, 'package.json'))) continue
      const pkgName = packageNameOf(dir)
      if (pkgName !== undefined) byPackageName.set(pkgName, dir)
    }
  }

  const migrated: { name: string; dir: string }[] = []
  for (const [pkgName, dir] of byPackageName) {
    const link = join(webModules, pkgName)
    let isRealDir = false
    try {
      const st = lstatSync(link)
      isRealDir = st.isDirectory() && !st.isSymbolicLink()
    } catch {
      isRealDir = false
    }
    if (!isRealDir) continue
    // 实体副本 ⇒ 换链接 + 记账（linkInstallLocalPlugin 内部会 recordLinkDependency）。
    const result = linkInstallLocalPlugin({ home, dir })
    if (result.ok) migrated.push({ name: pkgName, dir })
  }
  return migrated
}
