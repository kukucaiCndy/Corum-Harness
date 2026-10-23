/**
 * Agent 预设**模块安装**：把模块目录落进用户根，使其成为一份可用的预设。
 *
 * ## 落点（契约 §2.2，用户裁定 Q1 = 装进用户根）
 *
 * - 预设 → `<home>/.agent-presets/<id>/agent.json`（与 `saveProfile` 同处），
 *   并写 `moduleSource: { kind:'module', id, version, installedAt }` 来源标记。
 * - 技能 → `<home>/skills/<name>/`。
 * - MCP → `<home>/mcp-servers.json`，**用 mcp-manager 的 `saveServer`**，
 *   **绝不**把 `requires` 写进注册表（见 §4 硬事实：`listServers` 裸 `JSON.parse` 无校验，
 *   写进去会永久留在盘上）。
 * - 头像 → 解码成 dataURL 写进 agent.json 的 `avatar` 字段（与用户上传头像同形态：
 *   `<img src>` 直接渲染；`readAsDataURL` 产出的就是 dataURL）。
 * - 编译（`agent.cordis.yml` + `preset.yml`）**不由本纯函数触发**——它需要 `compilePreset`
 *   （在 corum-agent 里，依赖方向不允许 preset-modules 反向 import）。RPC 层在调完
 *   本函数后，自行 `loadProfile(id)` → `writeAgentDir(profile, dir)` 触发编译。
 *
 * ## 无副作用？不——安装就是写盘
 *
 * 与 `probeRequirement`（无副作用）不同，安装**必然写盘**。但它的写盘是幂等的：
 * 重复安装同一模块不会累积垃圾（MCP 走 `saveServer` 的整体替换语义；技能按 conflict 策略）。
 *
 * @module @corum/corum-preset-modules/module-install
 */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { resolveCorumHome } from './home.ts'
import { unpackModuleArchive } from './module-archive.ts'
import { diffText, type FileDiffResult } from './diff.ts'
import { getServer, saveServer } from '@corum/corum-mcp-manager'
import type { McpServerConfig } from '@corum/corum-mcp-manager'
import {
  MODULE_ASSETS_DIR,
  MODULE_AVATAR_FILE,
  MODULE_MANIFEST_FILE,
  MODULE_MCP_DIR,
  MODULE_SKILLS_DIR,
  MODULE_SOURCE_KIND,
  validateManifest,
  validateMcpEntry,
  type ModuleManifest,
  type ModuleMcpEntry,
  type ModuleSource,
} from './module-format.ts'
import { probeRequirement, type RequirementStatus } from './mcp-requirements.ts'

/** 安装检查结果（契约 §2.1，名字/签名冻结）。 */
export interface ModuleInspection {
  readonly dir: string
  readonly manifest: ModuleManifest
  /**
   * 模块要装的预设（第 ② 步预览用）。
   *
   * `exists` 是**必须的**（2026-10-11 实机补漏）：没有它，向导就无从知道「同名预设已存在」，
   * 第 ④ 步的预设冲突组**永远不渲染**，于是用户只会看到技能/MCP 两组冲突，
   * 而 `conflict.profile` 的默认值被blind 应用——那正好是最危险的路径
   * （默认若不是 skip，就会静默覆盖用户已有的同名预设，即设计稿用「跳过这个预设」防的那件事）。
   * 另外带上现有那份的昵称，供「覆盖会替换…」的差异说明用。
   */
  readonly profile: {
    readonly id: string
    readonly name: string
    readonly persona?: string
    /** 人格**预设** id（模块常只带 preset 而不带自由文本 persona）。 */
    readonly personaPreset?: string
    readonly duties?: string
    /** 本机 `<home>/.agent-presets/<id>/agent.json` 是否已存在（= 同名预设冲突）。 */
    readonly exists: boolean
    /** 已存在时那份的昵称（给人看的差异说明；不存在则无）。 */
    readonly existingNickname?: string
  }
  /**
   * 技能冲突项。
   *
   * `diff` 只在 `exists===true` 时有值（逐文件 `FileDiffResult[]`，对比现有技能目录
   * vs 模块技能目录下的每个文件）；不存在时 `undefined`，UI 不渲染 diff 入口。
   * 这是导入向导第④步「逐文件 diff split 视图」的数据源。
   */
  readonly skills: readonly { readonly name: string; readonly exists: boolean; readonly diff?: readonly FileDiffResult[] }[]
  /**
   * MCP 冲突项。
   *
   * `diff` 只在 `exists===true` 时有值（单个 `FileDiffResult`，对比注册表里该服务条目
   * vs 模块里的 `mcp/<name>.json` 序列化文本）；不存在时 `undefined`。
   */
  readonly mcp: readonly { readonly name: string; readonly exists: boolean; readonly status: RequirementStatus; readonly diff?: FileDiffResult }[]
  readonly hasAvatar: boolean
  /** 清单 `contents` 与磁盘实况不一致时的逐条差异（导入时必须报出来）。 */
  readonly warnings: readonly string[]
}

/** 安装输入（契约 §2.1，名字/签名冻结）。 */
export interface InstallModuleInput {
  readonly sourceDir: string
  readonly home: string
  /**
   * 冲突策略。
   *
   * `profile` 仍全局一档（同名预设只有一个）。`skills`/`mcp` 是 **per-item**：
   * key=技能名/MCP 服务名，值是该项的策略。取不到时安装函数按默认
   * （skills→'skip'，mcp→'keep'）处理，故空对象 `{}` 即「全部默认」，
   * 向后兼容旧的「全局一档」调用方（若它给空对象则与旧默认行为一致）。
   *
   * per-item 让用户可以「保留这个技能、覆盖那个」——配合第④步 diff 详情面板，
   * 用户看 diff 后逐项选。这是本轮（diff split-view + per-item）的收口形态。
   */
  readonly conflict: {
    readonly profile: 'overwrite' | 'skip' | 'rename'
    readonly skills: Record<string, 'skip' | 'overwrite'>
    readonly mcp: Record<string, 'keep' | 'overwrite'>
  }
}

/** 安装结果（契约 §2.1，名字/签名冻结）。 */
export interface InstallModuleResult {
  readonly profileId: string
  readonly skipped: boolean
  readonly installedSkills: readonly string[]
  readonly skippedSkills: readonly string[]
  readonly mcpApplied: readonly string[]
  readonly mcpKept: readonly string[]
  readonly warnings: readonly string[]
}

/** 读并校验模块清单；不合法 ⇒ fail-loud（不安装一个坏模块）。 */
function loadManifest(sourceDir: string): ModuleManifest {
  const manifestPath = join(sourceDir, MODULE_MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    throw new Error(`corum-preset-modules: 模块清单不存在（${manifestPath}）`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`corum-preset-modules: 模块清单 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const errors = validateManifest(raw)
  if (errors.length > 0) {
    throw new Error(`corum-preset-modules: 模块清单校验失败：${errors.map(e => `${e.field}: ${e.message}`).join('; ')}`)
  }
  return raw as ModuleManifest
}

/**
 * 判断路径是否指向 `.zip` 文件（大小写不敏感）。
 *
 * 导入向导第①步的来源可能是「从文件导入」，文件就是 `.zip`。inspect/install
 * 内部要先解到临时目录再走原逻辑——判定只看扩展名，不读文件头（简单可靠）。
 */
function isZipPath(path: string): boolean {
  return path.toLowerCase().endsWith('.zip')
}

/**
 * 若 sourcePath 是 `.zip`，解到临时目录并返回 [实际模块目录, 临时目录]。
 * 否则返回 [sourcePath, undefined]（无需临时目录）。
 *
 * 调用方用 try/finally 在结束后清掉临时目录（别留垃圾）。
 *
 * @returns [effectiveDir, tmpDir?] —— effectiveDir 传给后续逻辑；tmpDir 用于清理。
 */
function resolveSourceDir(sourcePath: string): { dir: string; tmpDir?: string } {
  if (!isZipPath(sourcePath)) return { dir: sourcePath }
  const tmpDir = mkdtempSync(join(tmpdir(), 'corum-module-unzip-'))
  const dir = unpackModuleArchive(sourcePath, tmpDir)
  return { dir, tmpDir }
}

/** 读模块内的预设本体（agent.json 副本）。 */
function loadModuleProfile(sourceDir: string): Record<string, unknown> {
  const path = join(sourceDir, 'agent.json')
  if (!existsSync(path)) {
    throw new Error(`corum-preset-modules: 模块缺少 agent.json（${path}）`)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`corum-preset-modules: 模块 agent.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 读模块内一个 MCP 条目文件。 */
function loadMcpEntry(sourceDir: string, name: string): ModuleMcpEntry | undefined {
  const path = join(sourceDir, MODULE_MCP_DIR, `${name}.json`)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ModuleMcpEntry
  } catch {
    return undefined
  }
}

/** 读模块内头像 PNG，编码成 dataURL（与用户上传头像同形态，`<img src>` 直接渲染）。 */
function readAvatarAsDataUrl(sourceDir: string): string | undefined {
  const path = join(sourceDir, MODULE_ASSETS_DIR, MODULE_AVATAR_FILE)
  if (!existsSync(path)) return undefined
  try {
    const buf = readFileSync(path)
    // dataURL 形态与 `FileReader.readAsDataURL` 产出一致——浏览器 <img src> 直接渲染。
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

/**
 * 检查一个模块：清单 + 第①层探测 + 磁盘实况差异。
 *
 * 这是导入向导第②③④步的数据源：UI 据此展示「这个模块装什么、缺什么、装不装得上」。
 *
 * @param sourceDir - 模块目录。
 * @param home - CORUM_HOME（探测技能/MCP 是否已存在于此根）。
 * @returns 见 {@link ModuleInspection}。
 */
export function inspectProfileModule(sourceDir: string, home: string): ModuleInspection {
  // `.zip` 来源：先解到临时目录再走原逻辑（调用方 = RPC 层不关心临时目录）。
  const { dir: effectiveDir, tmpDir } = resolveSourceDir(sourceDir)
  try {
    const inspection = inspectProfileModuleImpl(effectiveDir, home)
    // `inspection.dir` 返回**原始 sourcePath**（可能是 .zip 路径），而非临时解压目录——
    // 临时目录在 finally 块里会被删掉，若 dir 指向它，后续 installProfileModule
    // 拿这个 dir 当 sourceDir 会找不到 module.json（2026-10-14 zip 导入实测事故）。
    // install 时 resolveSourceDir 会对 .zip 重新解压，对目录路径直接用。
    return { ...inspection, dir: sourceDir }
  } finally {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * 递归收集一个目录下所有**文件**的相对路径（相对该目录，POSIX 风格）。
 *
 * 用于技能 diff：技能目录是树形（`SKILL.md` + `scripts/*.sh` + `agents/*.yaml`），
 * 要逐文件对比，故需先扁平化出文件列表。目录本身不计入，符号链接跳过（`statSync`
 * 而非 `lstatSync`——技能目录里不该有链接，有就走不到这里）。
 *
 * @param root - 目录绝对路径。
 * @returns 相对路径数组（如 `['SKILL.md', 'scripts/run.sh']`），空目录返回空数组。
 */
function collectFilesRecursive(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (st.isFile()) {
        // `relative` 在 win32 用 `\`，技能文件路径用 POSIX 风格（与导出时一致）。
        out.push(relative(root, full).split(/[\\/]/).join('/'))
      }
    }
  }
  walk(root)
  return out
}

/**
 * 对比现有技能目录 vs 模块技能目录，逐文件产出 `FileDiffResult[]`。
 *
 * 策略：
 * - 收集两侧所有文件的**并集**（相对路径，POSIX 风格）。
 * - 每个文件：两侧都有 ⇒ 行级 diff；仅现有侧有 ⇒ 全删（hunk 含 N 条 `del`）；
 *   仅模块侧有 ⇒ 全增（hunk 含 N 条 `add`）。
 * - 读文件失败（非 utf8 文本） ⇒ 跳过该文件（不产出 diff 项），避免二进制文件搞坏 diff。
 *
 * `path` 字段用相对路径（如 `SKILL.md`、`scripts/run.sh`），是 UI split 视图里
 * 每个对照面板的标题。
 *
 * @param existingDir - 现有技能目录（`<home>/skills/<name>`）。
 * @param moduleDir - 模块技能目录（`<sourceDir>/skills/<name>`）。
 * @returns 逐文件 diff（两侧都无文件时返回空数组；正常情况下至少有 SKILL.md）。
 */
function computeSkillDiff(existingDir: string, moduleDir: string): FileDiffResult[] {
  const existingFiles = new Set(collectFilesRecursive(existingDir))
  const moduleFiles = new Set(collectFilesRecursive(moduleDir))
  const allFiles = new Set<string>([...existingFiles, ...moduleFiles])
  const results: FileDiffResult[] = []
  // 排序保证输出稳定（SKILL.md 常排前）。
  const sorted = Array.from(allFiles).sort()
  for (const rel of sorted) {
    const leftPath = join(existingDir, ...rel.split('/'))
    const rightPath = join(moduleDir, ...rel.split('/'))
    const left = existingFiles.has(rel) ? readTextSafe(leftPath) : undefined
    const right = moduleFiles.has(rel) ? readTextSafe(rightPath) : undefined
    // 两侧都读不出来（二进制/权限）⇒ 跳过，diff 不产出该项。
    if (left === undefined && right === undefined) continue
    const leftText = left ?? ''
    const rightText = right ?? ''
    const r = diffText(leftText, rightText)
    results.push({ path: rel, hunks: r.hunks, added: r.added, removed: r.removed })
  }
  return results
}

/**
 * 安全读 utf8 文本文件：失败返回 `undefined`（不抛异常）。
 *
 * 技能/MCP 内容应全是文本；遇到二进制（PNG 等）或权限问题 ⇒ 返回 undefined，
 * 让调用方跳过该文件的 diff，避免一个坏文件搞垮整个检查。
 */
function readTextSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 对比注册表里某个 MCP 服务条目 vs 模块里的 `mcp/<name>.json`，产出单个 `FileDiffResult`。
 *
 * MCP 是单个 JSON 配置，故 diff 整个 JSON 序列化文本（2-space 缩进，与 `saveServer` 落盘
 * 形态一致）。`path` 字段用服务名（UI 据此标对照面板）。
 *
 * 现有侧从注册表里按 `name` 找出那一条，序列化成文本；模块侧直接读条目文件文本。
 * 找不到现有条目（理论上 `exists===true` 时不会发生）⇒ 现有侧为空，diff 全增。
 *
 * @param homeRoot - CORUM_HOME 根（`mcp-servers.json` 所在）。
 * @param moduleEntryPath - 模块里 `mcp/<name>.json` 的绝对路径。
 * @param name - MCP 服务名（diff.path 用）。
 * @returns 文件 diff 结果。
 */
function computeMcpDiff(homeRoot: string, moduleEntryPath: string, name: string): FileDiffResult {
  // 现有侧：从注册表里找出同名条目，序列化成文本。
  let leftText = ''
  const registryPath = join(homeRoot, 'mcp-servers.json')
  if (existsSync(registryPath)) {
    try {
      const reg = JSON.parse(readFileSync(registryPath, 'utf8')) as { servers?: unknown[] }
      if (Array.isArray(reg.servers)) {
        const found = reg.servers.find((s): s is Record<string, unknown> =>
          typeof s === 'object' && s !== null && (s as { name?: unknown }).name === name)
        if (found !== undefined) {
          leftText = `${JSON.stringify(found, null, 2)}\n`
        }
      }
    } catch {
      // 注册表坏掉 ⇒ 现有侧为空（diff 全增）。
    }
  }
  // 模块侧：直接读条目文件文本（保持原始格式，不做重序列化）。
  const rightText = readTextSafe(moduleEntryPath) ?? ''
  const r = diffText(leftText, rightText)
  return { path: name, hunks: r.hunks, added: r.added, removed: r.removed }
}

/** inspect 的实际实现（effectiveDir 已是解包后的目录或原始目录）。 */
function inspectProfileModuleImpl(sourceDir: string, home: string): ModuleInspection {
  const manifest = loadManifest(sourceDir)
  const homeRoot = resolveCorumHome(home)
  const warnings: string[] = []

  // 预设本体摘要。
  const rawProfile = loadModuleProfile(sourceDir)
  // 同名预设是否已存在 + 那份的昵称（第 ④ 步预设冲突组的判据，见 ModuleInspection.profile 注释）。
  const existingAgentJson = join(homeRoot, '.agent-presets', manifest.id, 'agent.json')
  const profileExists = existsSync(existingAgentJson)
  let existingNickname: string | undefined
  if (profileExists) {
    try {
      const existing = JSON.parse(readFileSync(existingAgentJson, 'utf8')) as { nickname?: unknown; title?: unknown }
      if (typeof existing.nickname === 'string' && existing.nickname !== '') existingNickname = existing.nickname
      else if (typeof existing.title === 'string' && existing.title !== '') existingNickname = existing.title
    } catch {
      // 现有那份读不出来也不阻断检查：exists=true 已经足够让向导把冲突组渲染出来。
    }
  }
  const profile = {
    id: manifest.id,
    name: typeof rawProfile.nickname === 'string' ? rawProfile.nickname
      : typeof rawProfile.title === 'string' ? rawProfile.title
        : manifest.name,
    ...(typeof rawProfile.persona === 'string' ? { persona: rawProfile.persona } : {}),
    ...(typeof rawProfile.personaPreset === 'string' ? { personaPreset: rawProfile.personaPreset } : {}),
    ...(typeof rawProfile.prompt === 'string' ? { duties: rawProfile.prompt } : {}),
    exists: profileExists,
    ...(existingNickname !== undefined ? { existingNickname } : {}),
  }

  // 技能：清单声明的 vs 磁盘实况。当 exists=true 时附带逐文件 diff（第④步 split 视图数据源）。
  const skillsRoot = join(homeRoot, 'skills')
  const skills = manifest.contents.skills.map(name => {
    const existingSkillDir = join(skillsRoot, name)
    const exists = existsSync(existingSkillDir)
    // 清单声明了技能但模块目录里没有实体 ⇒ 逐条差异。
    const moduleSkillDir = join(sourceDir, MODULE_SKILLS_DIR, name)
    if (!existsSync(moduleSkillDir)) {
      warnings.push(`清单声明技能 "${name}" 但模块目录里没有实体`)
    }
    // 仅当同名已存在（冲突）时才算 diff；否则 undefined，UI 不渲染 diff 入口。
    let diff: readonly FileDiffResult[] | undefined
    if (exists && existsSync(moduleSkillDir)) {
      diff = computeSkillDiff(existingSkillDir, moduleSkillDir)
    }
    return { name, exists, ...(diff !== undefined ? { diff } : {}) }
  })

  // MCP：第①层探测 + 磁盘实况（注册表里是否已有同名服务）。当 exists=true 时附带 diff。
  const mcpEntries: { name: string; exists: boolean; status: RequirementStatus; diff?: FileDiffResult }[] = []
  for (const name of manifest.contents.mcp) {
    const entry = loadMcpEntry(sourceDir, name)
    if (entry === undefined) {
      warnings.push(`清单声明 MCP "${name}" 但模块目录里没有条目文件`)
      mcpEntries.push({
        name,
        exists: false,
        status: { name, ok: false, kind: 'none', detail: '模块目录缺少该 MCP 条目文件' },
      })
      continue
    }
    // 第①层探测：用条目里的 requires 探测本机前置条件。
    const status = probeRequirement({
      name: entry.name,
      ...(entry.requires !== undefined ? { requires: entry.requires } : {}),
    })
    // 磁盘实况：注册表里是否已有同名服务（决定 keep vs overwrite 提示）。
    const registryPath = join(homeRoot, 'mcp-servers.json')
    let registryExists = false
    if (existsSync(registryPath)) {
      try {
        const reg = JSON.parse(readFileSync(registryPath, 'utf8')) as { servers?: { name?: unknown }[] }
        registryExists = Array.isArray(reg.servers) && reg.servers.some(s => s?.name === name)
      } catch {
        // 注册表坏掉不阻断检查（导入时按「不存在」处理，导入会新建）。
      }
    }
    // 仅当同名已存在（冲突）时才算 diff；否则 undefined。
    let diff: FileDiffResult | undefined
    if (registryExists) {
      const moduleEntryPath = join(sourceDir, MODULE_MCP_DIR, `${name}.json`)
      diff = computeMcpDiff(homeRoot, moduleEntryPath, name)
    }
    mcpEntries.push({ name, exists: registryExists, status, ...(diff !== undefined ? { diff } : {}) })
  }

  // 头像。
  const avatarPath = join(sourceDir, MODULE_ASSETS_DIR, MODULE_AVATAR_FILE)
  const hasAvatar = existsSync(avatarPath)
  if (manifest.contents.hasAvatar && !hasAvatar) {
    warnings.push('清单声明 hasAvatar=true 但模块目录缺少头像文件')
  }

  return {
    dir: sourceDir,
    manifest,
    profile,
    skills,
    mcp: mcpEntries,
    hasAvatar,
    warnings,
  }
}

/**
 * 把一个模块落进用户根。
 *
 * 流程：读清单+预设 → 处理冲突(rename/overwrite/skip) → 复制技能 → 写 MCP(走 saveServer，
 * 绝不写 requires) → 写头像(dataURL) → 写 agent.json(含 moduleSource)。
 *
 * **不触发 compilePreset**——依赖方向不允许本包 import corum-agent 的编译器。
 * RPC 层（`@Remote('installProfileModule')`）在调完本函数后自行触发编译。
 *
 * @param input - 见 {@link InstallModuleInput}。
 * @returns 见 {@link InstallModuleResult}。
 */
export function installProfileModule(input: InstallModuleInput): InstallModuleResult {
  // `.zip` 来源：先解到临时目录再走原逻辑。
  const { dir: effectiveDir, tmpDir } = resolveSourceDir(input.sourceDir)
  try {
    return installProfileModuleImpl({ ...input, sourceDir: effectiveDir })
  } finally {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** install 的实际实现（sourceDir 已是解包后的目录或原始目录）。 */
function installProfileModuleImpl(input: InstallModuleInput): InstallModuleResult {
  const manifest = loadManifest(input.sourceDir)
  const homeRoot = resolveCorumHome(input.home)
  const warnings: string[] = []

  // 1. 预设冲突处理。
  let profileId = manifest.id
  const profileDir = join(homeRoot, '.agent-presets', manifest.id)
  const agentJsonPath = join(profileDir, 'agent.json')
  let skipped = false
  if (existsSync(agentJsonPath)) {
    if (input.conflict.profile === 'skip') {
      return {
        profileId: manifest.id,
        skipped: true,
        installedSkills: [],
        skippedSkills: [],
        mcpApplied: [],
        mcpKept: [],
        warnings: ['预设已存在，按 skip 策略跳过'],
      }
    }
    if (input.conflict.profile === 'rename') {
      // rename ⇒ <id>-2（若 -2 也存在则 -3，以此类推）。
      let n = 2
      while (existsSync(join(homeRoot, '.agent-presets', `${manifest.id}-${n}`, 'agent.json'))) {
        n += 1
      }
      profileId = `${manifest.id}-${n}`
    }
    // overwrite ⇒ 直接往下写（agent.json 会被覆盖）。
  }

  // 2. 技能实体（整目录复制）。
  const skillsRoot = join(homeRoot, 'skills')
  const moduleSkillsDir = join(input.sourceDir, MODULE_SKILLS_DIR)
  const installedSkills: string[] = []
  const skippedSkills: string[] = []
  for (const name of manifest.contents.skills) {
    const src = join(moduleSkillsDir, name)
    if (!existsSync(src)) {
      warnings.push(`技能 "${name}" 在模块目录里没有实体，跳过`)
      skippedSkills.push(name)
      continue
    }
    const dest = join(skillsRoot, name)
    if (existsSync(dest)) {
      // per-item：取不到默认 'skip'（向后兼容——旧的全局一档调用方给空对象
      // {} 时，每项都走默认 skip，与旧行为一致）。
      const skillStrategy = input.conflict.skills[name] ?? 'skip'
      if (skillStrategy === 'skip') {
        skippedSkills.push(name)
        continue
      }
      // overwrite ⇒ 删旧的再复制（避免残留文件）。
      rmSync(dest, { recursive: true, force: true })
    }
    mkdirSync(skillsRoot, { recursive: true })
    cpSync(src, dest, { recursive: true })
    installedSkills.push(name)
  }

  // 3. MCP 条目 → 走 saveServer（整体替换语义；绝不写 requires 进注册表）。
  const moduleMcpDir = join(input.sourceDir, MODULE_MCP_DIR)
  const mcpApplied: string[] = []
  const mcpKept: string[] = []
  for (const name of manifest.contents.mcp) {
    const entry = loadMcpEntry(input.sourceDir, name)
    if (entry === undefined) {
      warnings.push(`MCP "${name}" 在模块目录里没有条目文件，跳过`)
      continue
    }
    // 磁盘已有同名服务 + keep 策略 ⇒ 不覆盖（现有那份可能是本机真实路径）。
    // 走 mcp-manager 的 `getServer(name, homeRoot)`：读与写同一个函数、同一个 home，
    // 不再内联一份 JSON 解析（P0 的修法就是让注册表读写认 home；内联解析会绕过它）。
    const registryHas = getServer(name, homeRoot) !== undefined
    // per-item：取不到默认 'keep'（向后兼容——旧的全局一档调用方给空对象 {}
    // 时，每项都走默认 keep，与旧行为一致）。
    const mcpStrategy = input.conflict.mcp[name] ?? 'keep'
    if (registryHas && mcpStrategy === 'keep') {
      mcpKept.push(name)
      continue
    }
    // 构造 McpServerConfig：只带注册表需要的字段，**绝不带 requires**（§4 硬事实：
    // listServers 裸 JSON.parse 无校验，写进去永久留在盘上）。
    const config = buildMcpServerConfig(entry)
    // 落点一致性（P0 缺陷）：必须把 homeRoot 透传给 saveServer，否则注册表写进
    // process.env.CORUM_HOME 指向的根——与技能/预设（已走 homeRoot）拆成两棵树，
    // input.home 与 CORUM_HOME 不同时安装不一致。上面的注册表预读已用 homeRoot，
    // 这里写也用同一个，读写才不会分根。
    saveServer(config, homeRoot)
    mcpApplied.push(name)
  }

  // 4. 头像 → dataURL 写进 agent.json 的 avatar 字段。
  const avatarDataUrl = readAvatarAsDataUrl(input.sourceDir)

  // 5. 写 agent.json（剥字段后的副本 + moduleSource + avatar dataURL + trust=user）。
  const rawProfile = loadModuleProfile(input.sourceDir)
  const moduleSource: ModuleSource = {
    kind: MODULE_SOURCE_KIND,
    id: manifest.id,
    version: manifest.version,
    installedAt: new Date().toISOString(),
  }
  // 覆盖时保留存量 version+1（与 saveProfile 的 version 自增语义一致）。
  let nextVersion = 1
  if (profileId === manifest.id && existsSync(agentJsonPath)) {
    try {
      const existing = JSON.parse(readFileSync(agentJsonPath, 'utf8')) as { version?: number }
      if (typeof existing.version === 'number') nextVersion = existing.version + 1
    } catch {
      // 存量坏掉 ⇒ 按 1 起算。
    }
  }
  const profileObj: Record<string, unknown> = {
    ...rawProfile,
    id: profileId,
    version: nextVersion,
    trust: 'user', // 从文件装 ⇒ user（契约 §1：导入时按来源定 trust）。
    moduleSource,
    ...(avatarDataUrl !== undefined ? { avatar: avatarDataUrl } : {}),
  }
  mkdirSync(profileDir, { recursive: true })
  // profileId 可能是 rename 出来的，目录要跟着改。
  const finalDir = join(homeRoot, '.agent-presets', profileId)
  mkdirSync(finalDir, { recursive: true })
  writeFileSync(join(finalDir, 'agent.json'), `${JSON.stringify(profileObj, null, 2)}\n`, 'utf8')

  return {
    profileId,
    skipped,
    installedSkills,
    skippedSkills,
    mcpApplied,
    mcpKept,
    warnings,
  }
}

/**
 * 从模块条目构造注册表需要的 `McpServerConfig`。
 *
 * **绝不带 `requires`**：注册表的 `listServers` 是裸 `JSON.parse` 无校验（§4 硬事实），
 * 把 `requires` 写进去会永久留在盘上，而它只是模块内的安装声明，不属于运行时配置。
 *
 * exactOptionalPropertyTypes 下，条件展开会让 TS 推断出可选属性含 `undefined`，
 * 与 `McpServerConfig` 不兼容；故先构造为 Record 再断言。
 */
function buildMcpServerConfig(entry: ModuleMcpEntry): McpServerConfig {
  if (entry.transport === 'streamable-http') {
    const config: Record<string, unknown> = {
      name: entry.name,
      transport: 'streamable-http',
      ...(entry.url !== undefined ? { url: entry.url } : {}),
      ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.guidance !== undefined ? { guidance: entry.guidance } : {}),
    }
    return config as unknown as McpServerConfig
  }
  const config: Record<string, unknown> = {
    name: entry.name,
    transport: 'stdio',
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...(entry.env !== undefined ? { env: entry.env } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.guidance !== undefined ? { guidance: entry.guidance } : {}),
  }
  return config as unknown as McpServerConfig
}
