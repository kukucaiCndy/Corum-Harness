/**
 * profile 装载的**预检层**（方案 §C.2.1–§C.2.3 的落地）。
 *
 * ## 为什么需要它（一个实测过的死法）
 *
 * 官方 `loadProfileDirectory` 对坏 bundle 是 **fail-hard**：包解析不到、没有
 * `dsh.bundle.patch`、patch 读不了 —— 任一条都在 boot 内部直接 `throw`。
 * 2026-10-20 实机验证（隔离 home 注入一个不存在的包名）：
 *
 * | 层 | 结果 |
 * |---|---|
 * | host 进程 | **exit 1，死** |
 * | renderer | 存活，停在「Corum · 正在启动」 |
 * | 用户可见 | 卡住的窗口，**零错误提示** |
 *
 * 这正是「第三方插件装错一个包 = 整个应用起不来、且应用内没有自救入口」的形态。
 *
 * ## 做法：在官方装载之前先筛，而不是 fork 官方
 *
 * 官方把 `readProfileManifest` / `resolveBundleDir` / `loadOverlayPatches` 都导出了，
 * 所以本模块**只需复刻 `loadProfileDirectory` 那 20 行**，并为每个 bundle 加 try/catch：
 * 坏的那个记进 `skipped[]`，好的照常叠层。**没有 skips 时直接调官方 `loadProfile`**
 * （连它的 shipped-profile 归一化逻辑一起保留，happy path 行为零变化）。
 *
 * ## 预检四关（方案 §C.2.2）
 *
 * 1. 包可解析（`resolveBundleDir`）
 * 2. 该包声明了 `dsh.bundle.patch`
 * 3. patch 文件存在且 YAML 可解析（`loadOverlayPatches` 会抛）
 * 4. `corum.plugin` 兼容：`api` ∈ 宿主支持集 **且** `semver.satisfies(host, decl.host)`
 *    - **无声明 ⇒ 放行 + 记一条 warn**（legacy 兼容，方案明确要求不能因此拒装）
 *
 * @module corum-desktop/host/profile-precheck
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  type Profile,
  type ProfileLayer,
} from '@deepseek-ai/dsh-app-boot'
import semver from 'semver'

/** 宿主支持的插件 API 大版本集合。删旧版本 = 宣布不再兼容（方案 §C.4）。 */
export const SUPPORTED_PLUGIN_APIS: readonly number[] = [1]

/** 被跳过的原因（诊断文件与启动页共用这套码）。 */
export type SkipReason = 'unresolved' | 'not-a-bundle' | 'bad-patch' | 'incompatible'

export interface SkippedBundle {
  /** 来自 profile manifest 的包名。 */
  packageName: string
  reason: SkipReason
  /** 人能读的一句话（启动页直接展示）。 */
  detail: string
  /** 该包声明的 `corum.plugin`（没有则 undefined）。 */
  declaration?: unknown
}

/** 通过预检的 bundle —— 连 patch 一起带上，避免重复 IO。 */
export interface AcceptedBundle {
  packageName: string
  packageDir: string
  /** 第一个 patch 文件路径（保留单数以兼容既有消费者）。 */
  patchPath: string
  /** 该 bundle 声明的所有 patch 文件路径（`dsh.bundle.patch` 可能是数组）。 */
  patchPaths: readonly string[]
  patches: ProfileLayer['patches']
}

export interface PrecheckOptions {
  /** 诊断前缀（官方同款）。 */
  binName: string
  /** profile 目录的绝对路径。 */
  profileDir: string
  /** 承载安装的 package.json 绝对路径（官方 `installAnchor` 同义）。 */
  installAnchor: string
  /** 宿主应用版本，用于 `corum.plugin.host` 的 range 判定。 */
  hostVersion: string
  /** 宿主支持的 api 集，缺省 {@link SUPPORTED_PLUGIN_APIS}。 */
  supportedApis?: readonly number[]
}

export interface PrecheckResult {
  accepted: AcceptedBundle[]
  skipped: SkippedBundle[]
  /** 无 `corum.plugin` 声明但被放行的包（legacy：放行 + 记一条）。 */
  undeclared: string[]
}

/**
 * 逐 bundle 跑四关。**不抛**：任何异常都折成 `skipped` 的一条记录。
 */
export function precheckProfileBundles(options: PrecheckOptions): PrecheckResult {
  const { binName, profileDir, installAnchor, hostVersion } = options
  const supportedApis = options.supportedApis ?? SUPPORTED_PLUGIN_APIS
  const accepted: AcceptedBundle[] = []
  const skipped: SkippedBundle[] = []
  const undeclared: string[] = []

  const manifest = readProfileManifest(binName, profileDir)
  const bundles = (manifest.dsh?.profile?.bundles ?? []) as string[]

  for (const packageName of bundles) {
    // 关 1：包可解析吗
    let packageDir: string
    try {
      packageDir = resolveBundleDir(binName, packageName, installAnchor, profileDir)
    } catch (error) {
      skipped.push({ packageName, reason: 'unresolved', detail: describe(error) })
      continue
    }

    // 关 2：声明了 dsh.bundle.patch 吗
    // 官方 `dsh.bundle.patch` 可以是单个 string 或 string[]（官方 bundlePatchFiles
    // 同时接受两种形态），这里必须与官方一致——否则官方 dsh-web-app（声明了 5 个
    // patch 文件的数组）会被误判为 not-a-bundle 跳过，导致 webServer/connection
    // 服务缺失、host exit 1。
    let pkg: Record<string, unknown>
    try {
      pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
    } catch (error) {
      skipped.push({ packageName, reason: 'not-a-bundle', detail: `读不到 package.json：${describe(error)}` })
      continue
    }
    const rawPatch = (pkg.dsh as { bundle?: { patch?: unknown } } | undefined)?.bundle?.patch
    let patchFiles: string[]
    if (typeof rawPatch === 'string' && rawPatch !== '') {
      patchFiles = [rawPatch]
    } else if (Array.isArray(rawPatch) && rawPatch.every(f => typeof f === 'string' && f !== '') && rawPatch.length > 0) {
      patchFiles = rawPatch as string[]
    } else {
      skipped.push({
        packageName,
        reason: 'not-a-bundle',
        detail: 'package.json 没有声明 dsh.bundle.patch（它不是可装载的 bundle）',
      })
      continue
    }
    const patchPaths = patchFiles.map(f => join(packageDir, f))

    // 关 4 先跑：不兼容就没必要读 patch（省 IO，也让错误更贴切）
    const declaration = (pkg.corum as { plugin?: unknown } | undefined)?.plugin
    if (declaration === undefined) {
      undeclared.push(packageName)
    } else {
      const verdict = checkCompat(declaration, { hostVersion, supportedApis })
      if (verdict !== undefined) {
        skipped.push({ packageName, reason: 'incompatible', detail: verdict, declaration })
        continue
      }
    }

    // 关 3：所有 patch 文件存在且能解析（逐文件加载再合并，与官方 readBundlePatches 同口径）
    try {
      const allPatches: ProfileLayer['patches'] = []
      for (const pp of patchPaths) {
        if (!existsSync(pp)) {
          throw new Error(`patch 文件不存在：${pp}`)
        }
        const layerPatches = loadOverlayPatches(binName, pp)
        allPatches.push(...layerPatches)
      }
      accepted.push({ packageName, packageDir, patchPath: patchPaths[0]!, patchPaths, patches: allPatches })
    } catch (error) {
      skipped.push({ packageName, reason: 'bad-patch', detail: `patch 解析失败：${describe(error)}`, declaration })
    }
  }

  return { accepted, skipped, undeclared }
}

/**
 * `corum.plugin` 兼容判定。返回 `undefined` = 兼容；否则返回人读的原因。
 */
export function checkCompat(
  declaration: unknown,
  context: { hostVersion: string; supportedApis: readonly number[] },
): string | undefined {
  if (declaration === null || typeof declaration !== 'object') return 'corum.plugin 不是对象'
  const decl = declaration as { api?: unknown; host?: unknown; kind?: unknown }
  if (typeof decl.api !== 'number' || !Number.isInteger(decl.api)) {
    return `corum.plugin.api 缺失或不是整数（声明值 ${JSON.stringify(decl.api)}）`
  }
  if (!context.supportedApis.includes(decl.api)) {
    return `插件要 api ${decl.api}，宿主只支持 ${context.supportedApis.join('/')}`
  }
  if (typeof decl.host !== 'string' || decl.host === '') {
    return 'corum.plugin.host 缺失（应为 semver range，如 ">=0.6.0 <0.7.0"）'
  }
  if (!semver.validRange(decl.host)) {
    return `corum.plugin.host 不是合法 semver range：${JSON.stringify(decl.host)}`
  }
  if (!semver.satisfies(context.hostVersion, decl.host)) {
    return `插件要求宿主 ${decl.host}，当前 ${context.hostVersion}`
  }
  if (decl.kind !== undefined && decl.kind !== 'bundle' && decl.kind !== 'builtin') {
    return `corum.plugin.kind 只能是 bundle / builtin，实际 ${JSON.stringify(decl.kind)}`
  }
  return undefined
}

export interface LoadProfileWithSkipOptions extends Omit<PrecheckOptions, 'profileDir'> {
  /** profile 名（官方 `loadProfile` 的第二个参数）。 */
  profileName: string
  /** 缺省 profile 目录的父目录（官方默认 `resolveDshHome()`）。 */
  home?: string
}

export interface LoadProfileWithSkipResult {
  profile: Profile
  skipped: SkippedBundle[]
  undeclared: string[]
  /** true = 走了「有坏 bundle，我们自建 layer 栈」的路径。 */
  filtered: boolean
}

/**
 * 带 skip 的 profile 装载。
 *
 * - **没有坏 bundle** ⇒ 完全交给官方 `loadProfile`（连 shipped-profile 归一化一起，
 *   happy path 行为零变化）；
 * - **有坏 bundle** ⇒ 复刻 `loadProfileDirectory` 的装载逻辑，只用通过预检的 bundle
 *   叠层，`skipped[]` 交给上层做诊断与呈现。
 */
export function loadProfileWithSkip(options: LoadProfileWithSkipOptions): LoadProfileWithSkipResult {
  const binName = options.binName
  const home = options.home

  // profile 尚未初始化时不能预检（没有 manifest）——直接交给官方初始化。
  const profileDir = resolveProfileDir(options.profileName, home)
  if (!existsSync(join(profileDir, 'package.json'))) {
    return {
      profile: loadProfile(binName, options.profileName, options.installAnchor, home, { userLayer: true }),
      skipped: [],
      undeclared: [],
      filtered: false,
    }
  }

  const precheck = precheckProfileBundles({ ...options, profileDir })
  if (precheck.skipped.length === 0) {
    return {
      profile: loadProfile(binName, options.profileName, options.installAnchor, home, { userLayer: true }),
      skipped: [],
      undeclared: precheck.undeclared,
      filtered: false,
    }
  }

  const manifest = readProfileManifest(binName, profileDir)
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME)
  const patches = existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : []

  return {
    profile: {
      name: basename(profileDir),
      dir: profileDir,
      layers: precheck.accepted.map(bundle => ({
        packageName: bundle.packageName,
        packageDir: bundle.packageDir,
        // rc3 ProfileLayer 用 patchPaths（readonly string[]），旧 corum 用 patchPath（单数）。
        // dsh.bundle.patch 可以是数组（如官方 dsh-web-app 声明 5 个 patch 文件），
        // 这里传完整列表以与官方 bundlePatchPaths 一致。
        patchPaths: bundle.patchPaths,
        patches: bundle.patches,
      })),
      patchPath,
      patches,
      // rc3 Profile 要求 skippedBundles（官方 SkippedBundle = { packageName, reason: string }）。
      // corum 的 SkippedBundle 更丰富（SkipReason + detail + declaration），这里投影到官方形。
      skippedBundles: precheck.skipped.map(s => ({ packageName: s.packageName, reason: `${s.reason}: ${s.detail}` })),
    } as Profile,
    skipped: precheck.skipped,
    undeclared: precheck.undeclared,
    filtered: true,
  }
}

/** 诊断文件的文件名（写在 `$DSH_HOME` 下，host 死之后 renderer 仍可读）。 */
export const BOOT_DIAGNOSTICS_FILENAME = 'boot-diagnostics.json'

export interface BootDiagnostics {
  generatedAt: string
  hostVersion: string
  profileName: string
  supportedApis: readonly number[]
  skipped: SkippedBundle[]
  undeclared: string[]
}

/**
 * 把预检结果落盘，**绝不抛**（诊断失败不能反过来弄死启动）。
 * @returns 写入的绝对路径；写入失败返回 undefined。
 */
export function writeBootDiagnostics(homeDir: string, diagnostics: BootDiagnostics): string | undefined {
  const path = join(homeDir, BOOT_DIAGNOSTICS_FILENAME)
  try {
    writeFileSync(path, `${JSON.stringify(diagnostics, undefined, 2)}\n`, { mode: 0o644 })
    return path
  } catch (error) {
    process.stderr.write(`[corum-desktop] 写启动诊断失败（忽略）：${describe(error)}\n`)
    return undefined
  }
}

/** 清掉上一次启动留下的诊断（启动干净时不该留旧错误）。 */
export function clearBootDiagnostics(homeDir: string): void {
  try {
    const path = join(homeDir, BOOT_DIAGNOSTICS_FILENAME)
    if (existsSync(path)) writeFileSync(path, '', { mode: 0o644 })
  } catch {
    /* 清不掉也不影响启动 */
  }
}

/**
 * 从 profile manifest 里摘掉一个 bundle（纯函数，便于测试）。
 *
 * 为什么不走 `loader.resolve(entryId)`：**被跳过的 bundle 根本没有 entryId** ——
 * 它从未进入 loader。方案 §C.2.3 因此把摘除通道定成「直接操作 manifest 的 bundles 数组」。
 * @returns 新的 manifest（不改入参）与是否真的摘掉了。
 */
export function removeBundleFromManifest(
  manifest: Record<string, unknown>,
  packageName: string,
): { manifest: Record<string, unknown>; removed: boolean } {
  const dsh = manifest.dsh as { profile?: { bundles?: unknown } } | undefined
  const bundles = dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(packageName)) {
    return { manifest, removed: false }
  }
  const next = structuredClone(manifest)
  const nextDsh = next.dsh as { profile: { bundles: string[] } }
  nextDsh.profile.bundles = (bundles as string[]).filter(name => name !== packageName)
  return { manifest: next, removed: true }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
