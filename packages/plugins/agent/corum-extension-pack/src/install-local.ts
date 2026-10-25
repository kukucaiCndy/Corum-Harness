/**
 * 本地扩展包端到端安装编排（P5c）。
 *
 * ## 这一层做什么
 *
 * 把一个本地来源（目录或 .zip）的扩展包**端到端**装进用户根，串起 P2 的
 * skills/mcp/presets 安装 + 插件包安装 + P3a 的 entries.json 持久层 + P5a 的
 * registry.json 归属台账，最后由调用方触发热应用（P3b）。
 *
 * 顺序（见 P5 设计文档 §3「开发者导入流程」第 ④ 步）：
 *   scan → skills/mcp/presets → 插件包 → entries.json → registry.json
 *         →（caller 触发 hot apply）→ result
 *
 * ## 为什么插件安装是依赖注入的（不直接 pnpm add）
 *
 * 本包是纯函数库（不注册 cordis 服务、不依赖桌面壳）。真正的 pnpm add +
 * reconcile 跑在 `corum-desktop/plugin-manager.ts` 里（依赖 Loader / profile
 * 目录 / pnpm 子进程）。为了让本函数**可单测**（不启 app、不跑 pnpm），
 * 插件安装以 `installPlugin` 回调注入：测试里传一个记录调用的 stub，
 * 桌面壳里传 `pluginManager.install(spec)`。
 *
 * ## 为什么 file: spec 要先复制到永久目录
 *
 * 见 EXTENSION-PACK-PLAN.md §5.3.2：`pnpm add file:./plugins-src/foo` 解析
 * 的是**相对 cwd 的路径**，而 cwd 是 profile 目录，不是扩展包来源目录。
 * 若直接用来源目录的相对路径，pnpm 会找不到（或找到错误的位置）。故必须
 * 先把插件源复制到 `<home>/extension-packs/<packId>/plugins-src/<name>/`
 * 这个**永久**目录，再用 `file:<绝对路径>` 作为 pnpm spec。复制还有一个
 * 作用：来源目录（尤其 .zip 解出的临时目录）会在 finally 里被清理，若
 * pnpm 指向临时目录，重启后 link 就断了。
 *
 * ## 为什么插件失败要整体 abort（不写部分 registry）
 *
 * registry.json 是归属台账（P5a §4.2），若写了部分插件就返回，用户看到的
 * 包列表会与实际安装的插件不一致——registry 说装了 2 个插件，磁盘上只有
 * 1 个。故任一插件安装失败即 abort 整个安装，并 best-effort 清理已复制的
 * pack 目录，让用户回到安装前的干净状态。
 *
 * @module @corum/corum-extension-pack/install-local
 */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute, relative } from 'node:path'

import { scanExtensionPack, type ExtensionPackScan } from './scan.ts'
import type { ExtensionManifest } from './extension-format.ts'
import { validatePluginDecl } from './plugin-decl.ts'
import type { ExtensionPluginDecl } from './plugin-decl.ts'
import {
  installExtensionPack,
  type ExtensionInstallConflict,
  type ExtensionInstallPresetResult,
  type ExtensionDeferredClass,
} from './install.ts'
import {
  unpackModuleArchive,
  resolveCorumHome,
} from '@corum/corum-preset-modules'
import { writePackEntries, entryIdFor, extensionPacksDir, type ExtensionEntry } from './entries-store.ts'
import { upsertPack, readRegistry, type ExtensionPackRecord, type ExtensionItemRecord } from '@corum/corum-extension-registry'

// ── 类型 ─────────────────────────────────────────────────────────────────

/**
 * 安装输入。
 *
 * - `sourceDir`：来源，可以是目录或 `.zip` 文件路径。
 * - `home`：目标 CORUM_HOME（与 installExtensionPack 同口径）。
 * - `conflict`：per-item 冲突策略（透传给 installExtensionPack）。
 * - `installPlugin`：插件安装回调（依赖注入，见模块头注）。传 undefined 时
 *   插件不安装（只登记 deferred）——但那样就退化成 P2 的 installExtensionPack，
 *   P5c 的意义就在于装插件，所以调用方应当传。
 */
export interface InstallLocalPackInput {
  /** 扩展包来源（目录或 .zip 文件路径）。 */
  readonly sourceDir: string
  /** 目标 CORUM_HOME。 */
  readonly home: string
  readonly conflict?: ExtensionInstallConflict
  /**
   * 插件安装回调（依赖注入）。
   *
   * 收到**已解析 spec 的** decl（`{...decl, spec: resolvedSpec}`）——
   * resolvedSpec 对 file: 来源是 `file:<永久绝对路径>`，对 registry 来源
   * 是原始 spec。调用方据此跑 `pnpm add <resolvedSpec>`。
   *
   * 返回 `{ ok, restartRequired?, log? }`；ok:false 或抛错 ⇒ 整体 abort。
   */
  readonly installPlugin?: (
    decl: ExtensionPluginDecl,
    ctx: { packId: string; sourceDir: string },
  ) => Promise<{ ok: boolean; restartRequired?: boolean; log?: string }>
}

/** 单个插件的安装结果。 */
export interface InstallLocalPluginResult {
  /** 插件名（来自 decl.name）。 */
  readonly name: string
  /** entry id（`ext:<packId>:<npmName>`）。 */
  readonly entryId: string
  /** 是否成功。 */
  readonly ok: boolean
  /** 是否需要重启（来自 installPlugin 回调）。 */
  readonly restartRequired: boolean
  /** 日志（来自 installPlugin 回调）。 */
  readonly log?: string
}

/**
 * 本地扩展包端到端安装结果。
 *
 * 与 `ExtensionInstallResult` 的区别：多了 `plugins`（已装插件列表）、
 * `restartRequired`（任一插件需重启则 true）、`version`/`name`（来自 manifest）。
 * themes/ui 仍在 `deferred` 里（P4/P7 未实现）。
 */
export interface InstallLocalPackResult {
  readonly packId: string
  readonly version: string
  readonly name?: string
  readonly skills: { readonly installed: readonly string[]; readonly skipped: readonly string[] }
  readonly mcp: { readonly applied: readonly string[]; readonly kept: readonly string[] }
  readonly presets: readonly ExtensionInstallPresetResult[]
  readonly plugins: readonly InstallLocalPluginResult[]
  readonly deferred: readonly ExtensionDeferredClass[]
  readonly restartRequired: boolean
  readonly warnings: readonly string[]
}

// ── 工具 ─────────────────────────────────────────────────────────────────

/** 判断路径是否是 `.zip`（与 install.ts 同款判据）。 */
function isZipPath(path: string): boolean {
  return path.toLowerCase().endsWith('.zip')
}

/**
 * 判断 spec 是否指向包内（需要复制到永久目录）。
 *
 * `file:` / `./` / `../` / 绝对路径都表示来源在包内，需要先复制再改 spec。
 * 其余（如 `@scope/pkg@1.2.3`、`pkg@^2`）是 registry 引用，直接用。
 */
function isLocalSpec(spec: string): boolean {
  return spec.startsWith('file:')
    || spec.startsWith('./')
    || spec.startsWith('../')
    || isAbsolute(spec)
}

/**
 * 从 spec 里去掉 `file:` 前缀，得到包内的相对/绝对路径。
 *
 * `file:./plugins-src/foo` → `./plugins-src/foo`
 * `file:/abs/path` → `/abs/path`
 */
function stripFilePrefix(spec: string): string {
  return spec.startsWith('file:') ? spec.slice('file:'.length) : spec
}

/**
 * 从 file: spec 解析出 npm 包名：读复制后目录的 package.json name 字段。
 *
 * 读不到时回退到 decl.name（保证有值——entries.json 的 name 字段不能空）。
 */
function readPackageNameFromDir(dir: string, fallback: string): string {
  try {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return fallback
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown }
    if (typeof pkg.name === 'string' && pkg.name.trim() !== '') return pkg.name
    return fallback
  } catch {
    return fallback
  }
}

/**
 * 从 registry spec（如 `@scope/pkg@1.2.3`、`pkg@^2`）里提取 npm 包名。
 *
 * `@scope/pkg@1.2.3` → `@scope/pkg`
 * `pkg@^2` → `pkg`
 * `pkg` → `pkg`
 *
 * 规则：去掉最后一个 `@` 及其后的版本范围。`@scope` 开头的 `@` 不算。
 */
function npmNameFromSpec(spec: string, fallback: string): string {
  // 去掉 file: 前缀（理论上 registry spec 不会有，防御性）。
  const clean = spec.startsWith('file:') ? spec.slice('file:'.length) : spec
  // @scope/pkg@1.2.3 → 找第二个 @（第一个是 scope 前缀）。
  // 非 scoped 的 pkg@^2 → 找第一个 @。
  const at = clean.startsWith('@') ? clean.indexOf('@', 1) : clean.indexOf('@')
  if (at <= 0) {
    // 没有 @ 或只有 scope 前缀的 @（如 @scope/pkg 无版本）→ 整串就是包名。
    return clean.trim() === '' ? fallback : clean
  }
  return clean.slice(0, at)
}

// ── 核心 ─────────────────────────────────────────────────────────────────

/**
 * 把一个本地扩展包端到端装进用户根。
 *
 * 详见模块头注的顺序与设计理由。抛错 = 安装失败（不写部分 registry）。
 *
 * @param input - 见 {@link InstallLocalPackInput}。
 * @returns 见 {@link InstallLocalPackResult}。
 * @throws 扫描有 errors 时；插件安装回调返回 ok:false 或抛错时。
 */
export async function installLocalExtensionPack(input: InstallLocalPackInput): Promise<InstallLocalPackResult> {
  // 解析目标根（与 installExtensionPack 同口径：~ 展开、空串回落环境变量）。
  const homeRoot = resolveCorumHome(input.home)

  // ── 1. 解析来源：目录或 .zip ──────────────────────────────────────
  // .zip → 解到临时目录（与 install.ts 同模式：mkdtemp + finally 清理）。
  const tmpUnzipDir = isZipPath(input.sourceDir)
    ? mkdtempSync(join(tmpdir(), 'corum-extension-local-unzip-'))
    : undefined
  try {
    let effectiveDir = input.sourceDir
    if (tmpUnzipDir !== undefined) {
      effectiveDir = unpackModuleArchive(input.sourceDir, tmpUnzipDir)
      // zip 打包时可能外层多一层根目录——下降进那个含 extension.json 的子目录。
      if (!existsSync(join(effectiveDir, 'extension.json'))) {
        const subdirs = readdirSync(effectiveDir)
          .filter(entry => {
            try {
              return existsSync(join(effectiveDir, entry, 'extension.json'))
            } catch {
              return false
            }
          })
        if (subdirs.length === 1) {
          effectiveDir = join(effectiveDir, subdirs[0]!)
        }
      }
    }

    // ── 2. 扫描；有 errors ⇒ fail-loud（不落盘） ────────────────────
    const scan = scanExtensionPack(effectiveDir)
    if (scan.errors.length > 0) {
      const msg = scan.errors.map(e => `[${e.field}] ${e.message}`).join('; ')
      throw new Error(`corum-extension-pack: 扩展包扫描失败，拒绝安装（${scan.errors.length} 个错误）：${msg}`)
    }

    const manifest = scan.manifest as ExtensionManifest
    const packId = manifest.id
    const packRoot = effectiveDir

    // ── 3. skills/mcp/presets：复用 P2 的 installExtensionPack ──────
    // installExtensionPack 的 deferred 里的 plugins/themes/ui 不是最终答案——
    // 我们在步骤 6 自己处理 plugins（真装），themes/ui 仍保持 deferred。
    // exactOptionalPropertyTypes 下冲突策略不能传 undefined，需条件展开。
    const installResult = installExtensionPack(
      input.conflict !== undefined
        ? { sourceDir: effectiveDir, home: homeRoot, conflict: input.conflict }
        : { sourceDir: effectiveDir, home: homeRoot },
    )

    // ── 4. pack 目录只做 mkdir：清单副本与 entries 都等插件全部成功后再写 ──
    // 失败时不留「半套清单」——否则页面会看到一个其实没装成的包。
    const packDir = join(extensionPacksDir(homeRoot), packId)
    mkdirSync(packDir, { recursive: true })
    // 记录本次新建的 plugins-src 目录：插件失败时只清这些，不整目录删
    // （重装场景下旧 pack 目录里还有上一版清单/插件源，不能连坐）。
    const copiedPluginDirs: string[] = []
    // 重装时的旧归属：conflict=skip/keep 的资源如果本来就是这个包的，不能因为
    // 「这次被跳过」就丢掉归属（否则重装一次，包内资源就变成可被单独卸载）。
    const previousRecord = readRegistry(homeRoot).packs[packId]
    const ownedBefore = (kind: 'presets' | 'skills' | 'mcp', name: string): boolean =>
      previousRecord?.items?.[kind]?.some(item => item.name === name) === true

    // ── 5. 插件：逐个解析 spec → 复制 file: 源 → 调 installPlugin ───
    const pluginResults: InstallLocalPluginResult[] = []
    const pluginEntries: ExtensionEntry[] = []
    const pluginRegistryItems: ExtensionItemRecord[] = []
    let restartRequired = false

    for (const ref of scan.plugins) {
      // 防御性再读 + 校验（scan 已校验过，但 zip 解包后到此刻之间可能被手改）。
      const declParsed = readJsonSafe(ref.path)
      if (declParsed === undefined) {
        throw new Error(`corum-extension-pack: 插件声明读取失败：${ref.path}`)
      }
      const declErrors = validatePluginDecl(declParsed)
      if (declErrors.length > 0) {
        const msg = declErrors.map(e => `[${e.field}] ${e.message}`).join('; ')
        throw new Error(`corum-extension-pack: 插件 "${ref.name}" 声明校验失败：${msg}`)
      }
      const decl = declParsed as ExtensionPluginDecl

      // 解析 install spec。
      let resolvedSpec: string
      let npmName: string

      if (isLocalSpec(decl.spec)) {
        // 包内来源：复制到 <home>/extension-packs/<packId>/plugins-src/<name>/
        const relPath = stripFilePrefix(decl.spec)
        const srcDir = resolve(packRoot, relPath)
        // 安全边界：包内 file: 源必须落在包目录内。否则恶意包可以声明
        // `file:/etc` / `file:../../Documents`，把宿主机任意目录复制进 install 产物。
        const rel = relative(packRoot, srcDir)
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(`corum-extension-pack: 插件 "${decl.name}" 的 spec 指向包外路径（${decl.spec}），拒绝安装`)
        }
        const destDir = join(packDir, 'plugins-src', decl.name)
        // rm 旧的（reinstall 时替换）。
        if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
        mkdirSync(destDir, { recursive: true })
        cpSync(srcDir, destDir, { recursive: true })
        copiedPluginDirs.push(destDir)
        // pnpm spec 用永久绝对路径（见模块头注）。
        resolvedSpec = `file:${destDir}`
        npmName = readPackageNameFromDir(destDir, decl.name)
      } else {
        // registry 引用：spec 原样用。
        resolvedSpec = decl.spec
        npmName = npmNameFromSpec(decl.spec, decl.name)
      }

      // 调注入的 installPlugin（传已解析 spec 的 decl）。
      if (input.installPlugin === undefined) {
        throw new Error(`corum-extension-pack: 插件 "${decl.name}" 需要 installPlugin 回调（未提供）`)
      }
      const augmentedDecl: ExtensionPluginDecl = { ...decl, spec: resolvedSpec }
      let pluginResult: { ok: boolean; restartRequired?: boolean; log?: string }
      try {
        pluginResult = await input.installPlugin(augmentedDecl, { packId, sourceDir: effectiveDir })
      } catch (error) {
        // 回调抛错 = 安装失败 → abort（best-effort 清理 pack 目录副本）。
        cleanupDirs(copiedPluginDirs)
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(`corum-extension-pack: 插件 "${decl.name}" 安装失败：${msg}`)
      }
      if (!pluginResult.ok) {
        // ok:false = 安装失败 → abort（best-effort 清理 pack 目录副本）。
        cleanupDirs(copiedPluginDirs)
        const log = pluginResult.log !== undefined ? `：${pluginResult.log}` : ''
        throw new Error(`corum-extension-pack: 插件 "${decl.name}" 安装失败${log}`)
      }

      const entryId = entryIdFor(packId, npmName)
      pluginResults.push({
        name: npmName,
        entryId,
        ok: true,
        restartRequired: pluginResult.restartRequired === true,
        ...(pluginResult.log !== undefined ? { log: pluginResult.log } : {}),
      })
      pluginEntries.push({ id: entryId, name: npmName })
      pluginRegistryItems.push({ name: npmName, entryId })
      if (pluginResult.restartRequired === true) restartRequired = true
    }

    // 插件全部成功后才落清单副本：失败不留「半套清单」，避免页面显示一个没装成的包。
    cpSync(join(packRoot, 'extension.json'), join(packDir, 'extension.json'))

    // ── 6. 写 entries.json（空插件也写空列表，reinstall 时清旧行） ──
    writePackEntries(homeRoot, packId, {
      packId,
      version: manifest.version,
      entries: pluginEntries,
    })

    // ── 7. 写 registry.json（归属台账，P5a §4.2） ───────────────────
    // 只登记**本包实际提供**的资源：
    // - 新装（installed/applied/created）⇒ 登记；
    // - 因冲突被跳过（skipped/kept）⇒ 只有当它本来就是这个包的（重装/升级）才登记。
    //   否则会把用户自己的同名技能/MCP 抢成本包所有——用户就再也删不掉自己的东西了。
    const items: ExtensionPackRecord['items'] = {}
    const presetsOwned = installResult.presets
      .filter(p => !p.skipped || ownedBefore('presets', p.profileId))
      .map(p => ({ name: p.profileId }))
    if (presetsOwned.length > 0) {
      items.presets = presetsOwned
    }
    const skillsOwned = [
      ...installResult.skills.installed,
      ...installResult.skills.skipped.filter(name => ownedBefore('skills', name)),
    ]
    if (skillsOwned.length > 0) {
      // 为每个拥有的技能记录基线 versionId（安装后 home 里最新版本 id）：
      // 卸载时 isSkillModified 据此判定「是否出现过基线之外的新版本」——
      // 包内自带的多历史版本快照（.versions）不再被误判为「用户已修改」。
      // 技能没有版本文件时不记（保持现状，卸载走旧台账的保守判据）。
      items.skills = skillsOwned.map(name => {
        const versionId = readSkillLatestVersionId(homeRoot, name)
        return versionId !== undefined ? { name, versionId } : { name }
      })
    }
    const mcpOwned = [
      ...installResult.mcp.applied,
      ...installResult.mcp.kept.filter(name => ownedBefore('mcp', name)),
    ]
    if (mcpOwned.length > 0) {
      items.mcp = mcpOwned.map(name => ({ name }))
    }
    if (pluginRegistryItems.length > 0) {
      items.plugins = pluginRegistryItems
    }
    // themes/ui：从 scan 取（deferred 里有，但直接从 scan 更可靠）。
    if (scan.themes.length > 0) {
      items.themes = scan.themes.map(t => ({ name: t.name }))
    }
    if (scan.ui.length > 0) {
      items.ui = scan.ui.map(u => ({ name: u.name }))
    }

    const record: ExtensionPackRecord = {
      id: packId,
      version: manifest.version,
      ...(manifest.name !== undefined && manifest.name.trim() !== '' ? { name: manifest.name } : {}),
      installedAt: new Date().toISOString(),
      items,
    }
    upsertPack(record, homeRoot)

    // ── 8. 构造 deferred（themes/ui 本轮不安装） ────────────────────
    const deferred: ExtensionDeferredClass[] = []
    if (scan.themes.length > 0) {
      deferred.push({
        kind: 'themes',
        names: scan.themes.map(t => t.name),
        reason: 'P4/P7 未实现：主题跨进程导入未做；本轮只登记不安装',
      })
    }
    if (scan.ui.length > 0) {
      deferred.push({
        kind: 'ui',
        names: scan.ui.map(u => u.name),
        reason: 'P4/P7 未实现：UI 依赖插件挂载；本轮只登记不安装',
      })
    }

    return {
      packId,
      version: manifest.version,
      ...(manifest.name !== undefined && manifest.name.trim() !== '' ? { name: manifest.name } : {}),
      skills: installResult.skills,
      mcp: installResult.mcp,
      presets: installResult.presets,
      plugins: pluginResults,
      deferred,
      restartRequired,
      warnings: scan.warnings,
    }
  } finally {
    // 清理 zip 解包临时目录（目录来源不需要清理）。
    if (tmpUnzipDir !== undefined) {
      rmSync(tmpUnzipDir, { recursive: true, force: true })
    }
    // 注意：**不删** <home>/extension-packs/<packId>/——那是安装产物。
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────

/** 安全读 JSON 并 parse；失败返回 undefined。 */
function readJsonSafe(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 读安装后技能在 home 里的最新版本 id（写 registry 基线用）。
 *
 * 与 uninstall.ts 的 readSkillFacts 同口径：读
 * `<home>/skills/<name>/skill-versions.json` 的 `versions[]` 最后一条 id。
 * 技能没有版本文件 / 文件损坏时返回 undefined（不记基线，卸载走保守判据）。
 */
function readSkillLatestVersionId(home: string, name: string): string | undefined {
  const versionsFile = join(home, 'skills', name, 'skill-versions.json')
  const parsed = readJsonSafe(versionsFile) as { versions?: Array<{ id?: unknown }> } | undefined
  const versions = parsed?.versions ?? []
  const latest = versions.length > 0 ? versions[versions.length - 1] : undefined
  return typeof latest?.id === 'string' && latest.id.trim() !== '' ? latest.id : undefined
}

/**
 * best-effort 清理本次新建的 plugins-src 目录（插件失败时调用）。
 *
 * 只删本次复制出来的目录，**不**删整个 pack 目录：重装场景下旧的清单/插件源
 * 还在里面，整目录删会把上一版也带走。
 */
function cleanupDirs(dirs: readonly string[]): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort：清理失败不阻断错误抛出。
    }
  }
}
