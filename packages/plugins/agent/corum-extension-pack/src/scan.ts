/**
 * 扩展包（Extension Pack）目录扫描（P2）。
 *
 * ## 为什么需要这一层（P1 已落地的纯格式校验还不够）
 *
 * P1 的 `validateExtension` 等校验器是**纯函数**（零 IO），只校验单份 JSON 的结构——
 * 它能告诉你「这份 extension.json 的字段类型对不对」，但回答不了：
 *   · 清单里声明了某个 preset/skill/mcp，**磁盘上那个实体到底在不在**？
 *   · `ui/xxx.json` 的 `plugin` 字段指向的插件名，在这个包里**真有**吗？
 *   · `importSkill` 引用的技能名，在 `contents.skills` 里**真有**吗？
 *
 * 这些都是**跨文件一致性**问题，必须扫整个包目录才能判断——这正是 P2 扫描层的职责。
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §4 的扫描职责定义。
 *
 * ## 设计纪律（改前先读）
 *
 * 1. **`scanExtensionPack` 绝不抛异常**：每一条问题都收进 `errors` 数组返回。
 *    导入向导要一次性把所有问题摆给用户（与 `validateManifest` / `validateExtension`
 *    同设计——「修一个报一个」会让用户来回试错）。
 * 2. **歧义结构 fail-loud 但不 throw**：`ambiguous`（同时有 extension.json 和
 *    module.json）写进 errors，让安装器在 `errors.length > 0` 时整体拒绝。
 * 3. **每个实体路径都用绝对路径**：`path` 字段是磁盘上的真实绝对路径，调用方
 *    （安装器）直接拿去用，不必再做 `join(dir, ...)`。
 * 4. **plugins/ui 做跨文件存在性校验**：`ui/xxx.json` 的 `plugin` 必须引用本包
 *    已声明的插件名；`replaces` 必须引用本包已声明的 UI 名。dangling ⇒ error。
 *    这是 P1 把「跨文件检查属于 P2」的 TODO 在此兑现。
 *
 * @module @corum/corum-extension-pack/scan
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { classifyPack } from './pack-kind.ts'
import { isSafeEntityName, validateExtension } from './extension-format.ts'
import { validatePluginDecl } from './plugin-decl.ts'
import { validateUiDecl } from './ui-decl.ts'
import {
  EXTENSION_MANIFEST_FILE,
  MODULE_MANIFEST_FILE,
  type ExtensionContents,
  type ExtensionManifest,
  type ExtensionValidationError,
} from './extension-format.ts'
import type { PackKind } from './pack-kind.ts'
import { validateMcpEntry } from '@corum/corum-preset-modules'

/**
 * 扫描到的某个内容实体的引用。
 *
 * `path` 是磁盘上的**绝对路径**——扫描器已 `resolve`，安装器直接拿去用，
 * 不必再做 `join(dir, name)`（避免调用方在不同根下重复拼接出错）。
 */
export interface ExtensionEntityRef {
  /** 实体名（清单 `contents.<class>` 里的那个名字）。 */
  readonly name: string
  /** 该实体在磁盘上的绝对路径。 */
  readonly path: string
}

/**
 * 扩展包目录扫描结果。
 *
 * `errors` 非空 ⇒ 这个包**不可安装**（安装器据此 fail-loud）。
 * `warnings` 非致命：清单与磁盘实况有小出入（如声明了 avatar 但文件不在），
 * 安装器可继续，但要透传给用户。
 */
export interface ExtensionPackScan {
  /** 被扫描的目录绝对路径。 */
  readonly dir: string
  /** 包根分类（extension / preset-module / ambiguous / empty）。 */
  readonly kind: PackKind
  /** 成功解析出的清单（errors 非空或清单缺失时为 undefined）。 */
  readonly manifest?: ExtensionManifest
  /** 各类内容实体的引用列表（已解析绝对路径；实体可能不存在——见 errors）。 */
  readonly presets: readonly ExtensionEntityRef[]
  readonly skills: readonly ExtensionEntityRef[]
  readonly mcp: readonly ExtensionEntityRef[]
  readonly plugins: readonly ExtensionEntityRef[]
  readonly themes: readonly ExtensionEntityRef[]
  readonly ui: readonly ExtensionEntityRef[]
  /** 致命错误列表（非空 ⇒ 不可安装）。 */
  readonly errors: readonly ExtensionValidationError[]
  /** 非致命提示。 */
  readonly warnings: readonly string[]
}

/**
 * 安全读 JSON 文本并 `JSON.parse`；失败返回 `{ ok: false, error }`。
 *
 * 扫描器不抛——JSON 解析失败也是一条 error 而非异常（与 `validateManifest` 同纪律）。
 */
function readJsonSafe(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, error: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 判断一个路径是否指向一个**目录**（不是文件、且存在）。
 *
 * skills/<name> 是目录（含 SKILL.md）；presets/plugins/mcp/themes/ui 各自是文件。
 * 这里只用于 skills 的目录判定——其它类的「存在」直接用 `existsSync` 即可
 * （即便误判成「文件存在」也只会让后续的 JSON 解析失败进 errors，不会假绿）。
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 扫描一个扩展包目录，收集**所有**问题（绝不抛异常）。
 *
 * 流程概览（每步都可能产生 errors/warnings，但互不阻断后续步骤——
 * 目标是「一次扫完所有问题」而不是「遇错即停」）：
 *   1. classifyPack 判别包根类型；ambiguous/empty ⇒ error。
 *   2. 读 + JSON.parse extension.json；解析失败 ⇒ error。
 *   3. validateExtension 校验清单结构；其 errors 全部并入。
 *   4. 对 contents 里每一类，按规则解析实体路径并校验存在性：
 *        presets   → presets/<name>/agent.json
 *        skills    → skills/<name>            （目录，含 SKILL.md）
 *        mcp       → mcp/<name>.json
 *        plugins   → plugins/<name>.json     （再校验 decl.name === 文件名）
 *        themes    → themes/<name>.zip
 *        ui        → ui/<name>.json           （再校验 decl.name === 文件名 + plugin 引用）
 *   5. presets/agent.json 做对象级形状校验（id/nickname/skills/mcpServers 类型）。
 *   6. mcp 条目跑 `validateMcpEntry`（前置依赖声明完整性）。
 *   7. importSkill / assistantProfile 必须引用包内已声明的实体。
 *
 * @param dir - 扩展包根目录（相对路径会被 resolve 成绝对路径）。
 * @returns 扫描结果（即使 errors 非空也返回结构化结果，不抛）。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §4。
 */
export function scanExtensionPack(dir: string): ExtensionPackScan {
  const rootDir = resolve(dir)
  const errors: ExtensionValidationError[] = []
  const warnings: string[] = []

  const hasExtensionJson = existsSync(join(rootDir, EXTENSION_MANIFEST_FILE))
  const hasModuleJson = existsSync(join(rootDir, MODULE_MANIFEST_FILE))
  const kind = classifyPack(hasExtensionJson, hasModuleJson)

  // ambiguous ⇒ 两个清单都在，包根结构混乱（一个根必须正好是一种）。
  if (kind === 'ambiguous') {
    errors.push({
      field: '(root)',
      message: `包根同时含 ${EXTENSION_MANIFEST_FILE} 与 ${MODULE_MANIFEST_FILE}：一个根必须正好是一种（扩展包或预设模块），不能两者都是`,
    })
  }
  // empty ⇒ 没有任何清单，不是扩展包。
  if (kind === 'empty') {
    errors.push({
      field: '(root)',
      message: `包根缺少 ${EXTENSION_MANIFEST_FILE}（也不是预设模块——没有 ${MODULE_MANIFEST_FILE}）`,
    })
  }
  // preset-module ⇒ 这是一个预设模块，不是扩展包；caller 应改走 installProfileModule。
  if (kind === 'preset-module') {
    errors.push({
      field: '(root)',
      message: `包根是预设模块（有 ${MODULE_MANIFEST_FILE}），不是扩展包（缺 ${EXTENSION_MANIFEST_FILE}）`,
    })
  }

  // 不是 extension 类型 ⇒ 直接返回空实体集合（errors 已记录原因）。
  if (kind !== 'extension') {
    return {
      dir: rootDir,
      kind,
      presets: [],
      skills: [],
      mcp: [],
      plugins: [],
      themes: [],
      ui: [],
      errors,
      warnings,
    }
  }

  // 读 + 解析 extension.json。
  const manifestPath = join(rootDir, EXTENSION_MANIFEST_FILE)
  const parsed = readJsonSafe(manifestPath)
  if (!parsed.ok) {
    errors.push({ field: EXTENSION_MANIFEST_FILE, message: parsed.error })
    return {
      dir: rootDir,
      kind,
      presets: [],
      skills: [],
      mcp: [],
      plugins: [],
      themes: [],
      ui: [],
      errors,
      warnings,
    }
  }

  // 校验清单结构。
  const manifestErrors = validateExtension(parsed.value)
  for (const e of manifestErrors) errors.push(e)

  // 即便结构有问题也尽量往下走（取得到什么取什么），让后续步骤能多报一些问题。
  // 但若根不是对象，contents 取不到，后续无法进行——直接返回。
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return {
      dir: rootDir,
      kind,
      presets: [],
      skills: [],
      mcp: [],
      plugins: [],
      themes: [],
      ui: [],
      errors,
      warnings,
    }
  }

  const rawManifest = parsed.value as Record<string, unknown>
  const contents = (rawManifest.contents ?? {}) as ExtensionContents
  const manifest: ExtensionManifest = rawManifest as unknown as ExtensionManifest

  // ── 各类实体的路径解析与存在性校验 ──────────────────────────────

  const presets = resolveEntities(rootDir, contents.presets, 'presets', errors, (name) => {
    // presets/<name>/agent.json
    const entityPath = join(rootDir, 'presets', name, 'agent.json')
    if (!existsSync(entityPath)) {
      errors.push({ field: `contents.presets.${name}`, message: `预设实体缺失：${entityPath}` })
    }
    return entityPath
  })

  const skills = resolveEntities(rootDir, contents.skills, 'skills', errors, (name) => {
    // skills/<name>（目录，含 SKILL.md）
    const entityPath = join(rootDir, 'skills', name)
    if (!isDirectory(entityPath)) {
      errors.push({ field: `contents.skills.${name}`, message: `技能实体目录缺失：${entityPath}` })
    } else if (!existsSync(join(entityPath, 'SKILL.md'))) {
      errors.push({ field: `contents.skills.${name}`, message: `技能目录缺少 SKILL.md：${join(entityPath, 'SKILL.md')}` })
    }
    return entityPath
  })

  const mcp = resolveEntities(rootDir, contents.mcp, 'mcp', errors, (name) => {
    // mcp/<name>.json
    const entityPath = join(rootDir, 'mcp', `${name}.json`)
    if (!existsSync(entityPath)) {
      errors.push({ field: `contents.mcp.${name}`, message: `MCP 条目文件缺失：${entityPath}` })
    }
    return entityPath
  })

  // plugins：除了存在性，还要校验 decl.name === 文件名 stem。
  const pluginNames = new Set<string>()
  const plugins = resolveEntities(rootDir, contents.plugins, 'plugins', errors, (name) => {
    const entityPath = join(rootDir, 'plugins', `${name}.json`)
    if (!existsSync(entityPath)) {
      errors.push({ field: `contents.plugins.${name}`, message: `插件声明文件缺失：${entityPath}` })
      return entityPath
    }
    const declParsed = readJsonSafe(entityPath)
    if (!declParsed.ok) {
      errors.push({ field: `contents.plugins.${name}`, message: `${entityPath} ${declParsed.error}` })
      return entityPath
    }
    const declErrors = validatePluginDecl(declParsed.value)
    for (const e of declErrors) {
      errors.push({ field: `contents.plugins.${name}.${e.field}`, message: e.message })
    }
    // decl.name 必须等于文件名 stem（否则安装时按文件名挂载会与声明对不上）。
    if (typeof declParsed.value === 'object' && declParsed.value !== null && !Array.isArray(declParsed.value)) {
      const declName = (declParsed.value as { name?: unknown }).name
      if (typeof declName === 'string' && declName !== name) {
        errors.push({
          field: `contents.plugins.${name}.name`,
          message: `插件声明 name "${declName}" 与文件名 stem "${name}" 不一致`,
        })
      }
      if (typeof declName === 'string') pluginNames.add(declName)
    }
    return entityPath
  })

  // themes：themes/<name>.zip（zip 解包是安装器的事，扫描器只校验文件在不在）。
  const themes = resolveEntities(rootDir, contents.themes, 'themes', errors, (name) => {
    const entityPath = join(rootDir, 'themes', `${name}.zip`)
    if (!existsSync(entityPath)) {
      errors.push({ field: `contents.themes.${name}`, message: `主题 zip 文件缺失：${entityPath}` })
    }
    return entityPath
  })

  // ui：decl.name === 文件名 stem；plugin 引用必须在本包 plugins 里存在；
  // replaces 引用必须在本包 ui 里存在（这两条是 P1 留给 P2 的跨文件校验 TODO）。
  const uiNames = new Set<string>()
  // 先收集所有 ui 名字（供 replaces 交叉引用校验）。
  for (const name of contents.ui ?? []) uiNames.add(name)

  const ui = resolveEntities(rootDir, contents.ui, 'ui', errors, (name) => {
    const entityPath = join(rootDir, 'ui', `${name}.json`)
    if (!existsSync(entityPath)) {
      errors.push({ field: `contents.ui.${name}`, message: `UI 声明文件缺失：${entityPath}` })
      return entityPath
    }
    const declParsed = readJsonSafe(entityPath)
    if (!declParsed.ok) {
      errors.push({ field: `contents.ui.${name}`, message: `${entityPath} ${declParsed.error}` })
      return entityPath
    }
    const declErrors = validateUiDecl(declParsed.value)
    for (const e of declErrors) {
      errors.push({ field: `contents.ui.${name}.${e.field}`, message: e.message })
    }
    if (typeof declParsed.value === 'object' && declParsed.value !== null && !Array.isArray(declParsed.value)) {
      const decl = declParsed.value as { name?: unknown; plugin?: unknown; replaces?: unknown }
      // decl.name 必须等于文件名 stem。
      if (typeof decl.name === 'string' && decl.name !== name) {
        errors.push({
          field: `contents.ui.${name}.name`,
          message: `UI 声明 name "${decl.name}" 与文件名 stem "${name}" 不一致`,
        })
      }
      // decl.plugin 必须引用本包已声明的插件名（dangling ⇒ error）。
      if (typeof decl.plugin === 'string' && !pluginNames.has(decl.plugin)) {
        errors.push({
          field: `contents.ui.${name}.plugin`,
          message: `UI "${name}" 的 plugin "${decl.plugin}" 不在本包 plugins 里（dangling 引用）`,
        })
      }
      // replaces 必须引用本包已声明的 ui 名（dangling ⇒ error）。
      if (Array.isArray(decl.replaces)) {
        for (const r of decl.replaces) {
          if (typeof r === 'string' && !uiNames.has(r)) {
            errors.push({
              field: `contents.ui.${name}.replaces`,
              message: `UI "${name}" 的 replaces "${r}" 不在本包 ui 里（dangling 引用）`,
            })
          }
        }
      }
    }
    return entityPath
  })

  // ── presets/agent.json 的对象级形状校验 ─────────────────────────
  // 不导入 profile schema 包（依赖方向不允许）；做务实的类型检查即可。
  for (const ref of presets) {
    const parsedProfile = readJsonSafe(ref.path)
    if (!parsedProfile.ok) {
      // agent.json 读不出来已在上面那条 preset 实体校验里报过缺失/解析失败；
      // 但若文件存在却 JSON 坏，这里补一条更精确的 error。
      errors.push({ field: `presets.${ref.name}`, message: `agent.json ${parsedProfile.error}` })
      continue
    }
    if (typeof parsedProfile.value !== 'object' || parsedProfile.value === null || Array.isArray(parsedProfile.value)) {
      errors.push({ field: `presets.${ref.name}`, message: 'agent.json 必须是一个 JSON 对象' })
      continue
    }
    const profile = parsedProfile.value as Record<string, unknown>
    // id 应是字符串（与 preset 名一致更佳，但不强求——profile.id 是运行期 id，preset 名是包内实体名）。
    if (profile.id !== undefined && typeof profile.id !== 'string') {
      errors.push({ field: `presets.${ref.name}.id`, message: `agent.json id 必须是字符串（发现 ${typeof profile.id}）` })
    }
    // nickname 应是字符串（UI 显示名）。
    if (profile.nickname !== undefined && typeof profile.nickname !== 'string') {
      errors.push({ field: `presets.${ref.name}.nickname`, message: `agent.json nickname 必须是字符串（发现 ${typeof profile.nickname}）` })
    }
    // skills 应是数组（每项是 { name, versionId }）。
    if (profile.skills !== undefined && !Array.isArray(profile.skills)) {
      errors.push({ field: `presets.${ref.name}.skills`, message: `agent.json skills 必须是数组` })
    }
    // mcpServers 应是字符串数组。
    if (profile.mcpServers !== undefined) {
      if (!Array.isArray(profile.mcpServers)) {
        errors.push({ field: `presets.${ref.name}.mcpServers`, message: `agent.json mcpServers 必须是数组` })
      } else if ((profile.mcpServers as unknown[]).some(s => typeof s !== 'string')) {
        errors.push({ field: `presets.${ref.name}.mcpServers`, message: 'agent.json mcpServers 的每项必须是字符串' })
      }
    }
  }

  // ── mcp 条目跑 validateMcpEntry（前置依赖声明完整性） ──────────
  for (const ref of mcp) {
    const parsedEntry = readJsonSafe(ref.path)
    if (!parsedEntry.ok) {
      // 文件缺失已在上面报过；JSON 坏在这里补一条带名字前缀的 error。
      errors.push({ field: `mcp.${ref.name}`, message: parsedEntry.error })
      continue
    }
    const entryErrors = validateMcpEntry(parsedEntry.value)
    for (const e of entryErrors) {
      errors.push({ field: `mcp.${ref.name}.${e.field}`, message: e.message })
    }
  }

  // ── importSkill / assistantProfile 必须引用包内已声明的实体 ────
  if (typeof manifest.importSkill === 'string') {
    if (!skills.some(s => s.name === manifest.importSkill)) {
      errors.push({
        field: 'importSkill',
        message: `importSkill "${manifest.importSkill}" 不在 contents.skills 里（必须引用本包已声明的技能）`,
      })
    }
  }
  if (typeof manifest.assistantProfile === 'string') {
    if (!presets.some(p => p.name === manifest.assistantProfile)) {
      errors.push({
        field: 'assistantProfile',
        message: `assistantProfile "${manifest.assistantProfile}" 不在 contents.presets 里（必须引用本包已声明的预设）`,
      })
    }
  }

  return {
    dir: rootDir,
    kind,
    manifest,
    presets,
    skills,
    mcp,
    plugins,
    themes,
    ui,
    errors,
    warnings,
  }
}

/**
 * 把 contents.<class> 的名字列表解析成 `ExtensionEntityRef[]`。
 *
 * `resolvePath` 回调负责：
 *   1. 拼出实体在该类下的预期路径；
 *   2. 校验存在性（不存在 ⇒ push 一条 error）；
 *   3. 返回那个绝对路径（即使不存在也返回——caller 可据 ref.path 继续操作或忽略）。
 *
 * 这样把「按类拼路径 + 存在性校验」收进一个回表，避免 6 类各自抄一遍。
 */
function resolveEntities(
  rootDir: string,
  names: readonly string[] | undefined,
  _kind: string,
  errors: ExtensionValidationError[],
  resolvePath: (name: string) => string,
): ExtensionEntityRef[] {
  if (names === undefined) return []
  const refs: ExtensionEntityRef[] = []
  for (const name of names) {
    // 不安全名字（`../evil`、绝对路径等）已由 validateExtension 报错；这里**不再拼路径**，
    // 否则 join 会把路径穿到包外、scan 会去读包外的文件（把校验错误变成一次越界读）。
    if (!isSafeEntityName(name)) continue
    const entityPath = resolvePath(name)
    refs.push({ name, path: entityPath })
  }
  return refs
}
