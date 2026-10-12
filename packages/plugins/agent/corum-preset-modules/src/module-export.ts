/**
 * Agent 预设**模块导出**：把一个本机预设连同它的技能、MCP 配置、头像收进一个自洽目录。
 *
 * ## 为什么需要这层
 *
 * 一个 Agent 预设的能力分散在三处（预设本体 / 技能 / MCP），同一个技能名在不同机器上
 * 可能是完全不同的内容。导出把它们**连同实体**收进一个目录，使「分享一个 Agent」成为
 * 一次原子操作——导入方拿到目录即自洽，不依赖导出方机器上的任何本地路径。
 *
 * ## 闸门：`requires` 强制（用户裁定「强制补全」）
 *
 * MCP 配置里的 `command` 可能是平台绝对路径或包管理器命令，在别的机器上可能不存在。
 * 导出时**不许**放过缺 `requires` 的 MCP 条目（用户原话「MCP 配置对应的实际运行程序
 * 和服务需要进行正确安装才可以使用」）——把它作为 `blocked` 项返回，由 UI 提示
 * 「让 Agent 补全」（见 `authorModuleRequires`）。`blocked` 非空 ⇒ **不产出任何文件**。
 *
 * ## 剥字段（`stripForModule`）
 *
 * 模型 / 信任 / 版本 / spec 基线一律不带（见 `module-format.ts` 的 `stripForModule` 头注）。
 *
 * @module @corum/corum-preset-modules/module-export
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveCorumHome } from './home.ts'
import { packModuleArchive } from './module-archive.ts'
import { readModuleRequires } from './requires-store.ts'
import {
  MODULE_ASSETS_DIR,
  MODULE_AVATAR_FILE,
  MODULE_FORMAT_VERSION,
  MODULE_MANIFEST_FILE,
  MODULE_MCP_DIR,
  MODULE_SKILLS_DIR,
  stripForModule,
  validateMcpEntry,
  type McpRequirement,
  type ModuleManifest,
  type ModuleMcpEntry,
  type ModuleValidationError,
} from './module-format.ts'

/** 导出输入（契约 §2.1，名字/签名冻结）。 */
export interface ExportModuleInput {
  readonly profileId: string
  /** CORUM_HOME（预设、技能、MCP 注册表、头像都从这里派生）。 */
  readonly home: string
  /** 模块输出目录；不存在则递归创建。 */
  readonly outDir: string
  readonly version?: string
  readonly name?: string
  readonly description?: string
  readonly author?: string
  /**
   * 是否同时产出 zip 归档（缺省 true）。
   *
   * true 时除了模块目录，还在同级产出 `<id>-<version>.zip`，便于分享（设计稿 P8：
   * 发布完成屏显示 `corum-dev-1.0.0.zip`）。false 时只产出目录。
   */
  readonly archive?: boolean
}

/** 导出结果（契约 §2.1，名字/签名冻结）。 */
export interface ExportModuleResult {
  readonly dir: string
  readonly manifest: ModuleManifest
  /** 导出的技能名（已复制实体）。 */
  readonly skills: readonly string[]
  /** 导出的 MCP 服务名。 */
  readonly mcp: readonly string[]
  /** 非致命问题（引用的技能不存在、MCP 未在注册表里等）。 */
  readonly warnings: readonly string[]
  /** **致命**：这些 MCP 缺合法 `requires` ⇒ 导出被拦。空数组 = 可导出。 */
  readonly blocked: readonly { readonly name: string; readonly reason: string }[]
  /** zip 归档路径（仅当 `input.archive !== false` 且导出成功时存在）。 */
  readonly archive?: string
}

/** dataURL 的前缀（用户上传头像就是这个形态：`readAsDataURL` → `data:image/png;base64,…`）。 */
const DATA_URL_PREFIX = 'data:'

/** `corumapp://` 是壳内置资产协议——不在 home 下，导出读不到（内置角色预设不是模块目标）。 */
const CORUM_APP_PROTOCOL = 'corumapp://'

/**
 * 解码 dataURL 为二进制 Buffer。
 *
 * 用户上传头像走 `FileReader.readAsDataURL`，agent.json 的 `avatar` 字段存的是
 * `data:image/png;base64,<base64>` 文本。模块里的头像约定为 `assets/avatar.png`
 * 二进制文件，故解码后落盘。非 dataURL 形态（`corumapp://` / http URL）不下载：
 * 前者在 home 下不存在（壳内置资产），后者下载会引入网络副作用与 flaky。
 *
 * @returns 解码后的二进制；非 dataURL 形态返回 null（调用方计 warning）。
 */
function decodeDataUrl(dataUrl: string): Buffer | null {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return null
  const meta = dataUrl.slice(0, commaIndex)
  // 只接受 base64 编码的 dataURL（readAsDataURL 产出即此形态）。
  if (!meta.includes(';base64')) return null
  const body = dataUrl.slice(commaIndex + 1)
  try {
    return Buffer.from(body, 'base64')
  } catch {
    return null
  }
}

/** 读 MCP 注册表（`{servers:[…]}`）。 */
function readMcpRegistry(home: string): { servers?: unknown[] } {
  const path = join(resolveCorumHome(home), 'mcp-servers.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { servers?: unknown[] }
  } catch {
    return {}
  }
}

/** 把校验错误列表收敛成一句人可读原因。 */
function describeValidationErrors(errors: readonly ModuleValidationError[]): string {
  return errors.map(e => `${e.field}: ${e.message}`).join('; ')
}

/**
 * 把一个本机预设导出成模块目录。
 *
 * 流程：读 agent.json → 剥字段 → 校验每个 MCP 的 `requires` → 复制技能/MCP/头像实体
 * → 写 module.json。`blocked` 非空 ⇒ **不产出任何文件**（连目录都不创建）。
 *
 * @param input - 见 {@link ExportModuleInput}。
 * @returns 见 {@link ExportModuleResult}。
 */
export function exportProfileModule(input: ExportModuleInput): ExportModuleResult {
  const homeRoot = resolveCorumHome(input.home)
  // 输出目录留空 ⇒ 用**默认导出位置**（见 defaultExportDir 的注释：这是"用户没填就必须能跑通"的兜底）。
  const outDir = input.outDir.trim() === '' ? defaultExportDir(homeRoot) : input.outDir
  const profileDir = join(homeRoot, '.agent-presets', input.profileId)
  const agentJsonPath = join(profileDir, 'agent.json')
  const warnings: string[] = []
  const blocked: { name: string; reason: string }[] = []

  // 1. 读预设本体。不存在 ⇒ fail-loud（导出一个不存在的预设没有意义）。
  if (!existsSync(agentJsonPath)) {
    throw new Error(`corum-preset-modules: 预设 "${input.profileId}" 不存在（${agentJsonPath}）`)
  }
  let rawProfile: Record<string, unknown>
  try {
    rawProfile = JSON.parse(readFileSync(agentJsonPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`corum-preset-modules: 读取预设 "${input.profileId}" 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 2. 剥字段（模型 / 信任 / 版本 / spec 基线一律不带）。
  const stripped = stripForModule(rawProfile)

  // 3. 收集技能实体。预设只按名字引用技能，模块要**连同实体**带走。
  const skillNames = Array.isArray(stripped.skills)
    ? (stripped.skills as unknown[]).filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    : []
  const skillNameStrings = skillNames
    .map(s => typeof s.name === 'string' ? s.name : '')
    .filter(n => n !== '')
  const skillsRoot = join(homeRoot, 'skills')
  const exportedSkills: string[] = []
  for (const name of skillNameStrings) {
    const skillDir = join(skillsRoot, name)
    if (!existsSync(skillDir)) {
      // 引用的技能不存在 ⇒ 非致命（模块仍可导出，导入方会看到技能缺失）。
      warnings.push(`技能 "${name}" 在 ${skillsRoot} 下不存在，未导出实体`)
      continue
    }
    exportedSkills.push(name)
  }

  // 4. 收集 MCP 条目。从注册表读，按预设引用的名字筛选。
  const mcpNames = Array.isArray(stripped.mcpServers)
    ? (stripped.mcpServers as unknown[]).filter((n): n is string => typeof n === 'string')
    : []
  const registry = readMcpRegistry(input.home)
  const servers = Array.isArray(registry.servers) ? registry.servers : []
  const serverByName = new Map<string, Record<string, unknown>>()
  for (const s of servers) {
    if (typeof s !== 'object' || s === null) continue
    const rec = s as Record<string, unknown>
    if (typeof rec.name === 'string') serverByName.set(rec.name, rec)
  }
  const exportedMcp: ModuleMcpEntry[] = []
  // 本机已写的安装说明（`<预设目录>/module-requires.json`，见 requires-store.ts 头注：
  // 它**不在注册表里**——注册表是裸 JSON.parse，不该也不能承载安装说明）。
  // 这是导出闸门能被打开的唯一来源：`authorModuleRequires` 或用户在发布对话框
  // 「订正」写的那些，都落在这里。
  const authored = readModuleRequires(input.home, input.profileId)
  for (const name of mcpNames) {
    const server = serverByName.get(name)
    if (server === undefined) {
      warnings.push(`MCP 服务 "${name}" 未在注册表里，未导出`)
      continue
    }
    // requires 的来源优先级：**本机安装说明 > 注册表里的同名字段**。
    // 后者只对「手改过 mcp-servers.json」的历史数据可能成立（正常路径永不写它），
    // 保留它纯粹是为了不把那种存量配置判死。
    const requires: McpRequirement | undefined = authored[name] ?? (server.requires as McpRequirement | undefined)
    // 校验 requires：缺合法 requires ⇒ 进 blocked，不产出文件。
    const errors = validateMcpEntry({ ...server, ...(requires !== undefined ? { requires } : {}) })
    if (errors.length > 0) {
      blocked.push({ name, reason: describeValidationErrors(errors) })
      continue
    }
    // 构造模块条目：配置本体 + requires（注册表里的 requires 原样带过去）。
    // exactOptionalPropertyTypes 下，条件展开 `...(cond ? { requires: val } : {})`
    // 会让 TS 推断出 `requires?: McpRequirement | undefined`，与 `ModuleMcpEntry` 的
    // `requires?: McpRequirement` 不兼容。故先构造为 Record 再断言。
    const entryRecord: Record<string, unknown> = {
      name: typeof server.name === 'string' ? server.name : name,
      transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      ...(typeof server.command === 'string' ? { command: server.command } : {}),
      ...(Array.isArray(server.args) ? { args: server.args as string[] } : {}),
      ...(typeof server.env === 'object' && server.env !== null ? { env: server.env as Record<string, string> } : {}),
      ...(typeof server.url === 'string' ? { url: server.url } : {}),
      ...(typeof server.headers === 'object' && server.headers !== null ? { headers: server.headers as Record<string, string> } : {}),
      ...(typeof server.description === 'string' ? { description: server.description } : {}),
      ...(typeof server.guidance === 'string' ? { guidance: server.guidance } : {}),
      ...(requires !== undefined ? { requires } : {}),
    }
    const entry = entryRecord as unknown as ModuleMcpEntry
    exportedMcp.push(entry)
  }

  // blocked 非空 ⇒ 不产出任何文件（用户原话「让 Agent 补全」，不是「导出半成品」）。
  if (blocked.length > 0) {
    return {
      dir: outDir,
      manifest: {
        formatVersion: MODULE_FORMAT_VERSION,
        id: input.profileId,
        version: input.version ?? '1.0.0',
        name: input.name ?? input.profileId,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.author !== undefined ? { author: input.author } : {}),
        contents: { skills: exportedSkills, mcp: exportedMcp.map(e => e.name), hasAvatar: false },
      },
      skills: exportedSkills,
      mcp: exportedMcp.map(e => e.name),
      warnings,
      blocked,
    }
  }

  // 5. 写盘：清空重建 outDir，复制技能 / MCP / 头像，写 module.json + agent.json。
  if (existsSync(outDir)) {
    // 清空重建：避免上次导出的残留文件（如删了某技能）混进新模块。
    rmSync(outDir, { recursive: true, force: true })
  }
  mkdirSync(outDir, { recursive: true })

  // 5a. 技能实体（整目录复制）。
  for (const name of exportedSkills) {
    const dest = join(outDir, MODULE_SKILLS_DIR, name)
    mkdirSync(dest, { recursive: true })
    copyDirRecursive(join(skillsRoot, name), dest)
  }

  // 5b. MCP 条目（每条一份 JSON，文件名 = 服务名）。
  for (const entry of exportedMcp) {
    const dest = join(outDir, MODULE_MCP_DIR, `${entry.name}.json`)
    mkdirSync(join(outDir, MODULE_MCP_DIR), { recursive: true })
    writeFileSync(dest, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  }

  // 5c. 头像：dataURL ⇒ 解码成 PNG；corumapp:// / http ⇒ 不带（计 warning）。
  let hasAvatar = false
  const avatarField = typeof stripped.avatar === 'string' ? stripped.avatar : undefined
  if (avatarField !== undefined && avatarField !== '') {
    if (avatarField.startsWith(DATA_URL_PREFIX)) {
      const png = decodeDataUrl(avatarField)
      if (png !== null) {
        mkdirSync(join(outDir, MODULE_ASSETS_DIR), { recursive: true })
        writeFileSync(join(outDir, MODULE_ASSETS_DIR, MODULE_AVATAR_FILE), png)
        hasAvatar = true
      } else {
        warnings.push('头像 dataURL 解码失败，未导出头像')
      }
    } else if (avatarField.startsWith(CORUM_APP_PROTOCOL)) {
      warnings.push('头像是壳内置资产（corumapp://），不在用户 home 下，未导出头像')
    } else {
      warnings.push('头像是远程 URL，导出时不下载，未导出头像')
    }
  }
  // 头像处理完后从 agent.json 副本里删掉 avatar 字段——导入时由安装路径重新写可渲染路径。
  delete stripped.avatar

  // 5d. 预设本体（剥字段后的 agent.json 副本）。
  writeFileSync(join(outDir, 'agent.json'), `${JSON.stringify(stripped, null, 2)}\n`, 'utf8')

  // 5e. 清单。
  const manifest: ModuleManifest = {
    formatVersion: MODULE_FORMAT_VERSION,
    id: input.profileId,
    version: input.version ?? '1.0.0',
    name: input.name ?? input.profileId,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.author !== undefined ? { author: input.author } : {}),
    contents: { skills: exportedSkills, mcp: exportedMcp.map(e => e.name), hasAvatar },
  }
  writeFileSync(join(outDir, MODULE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 5f. zip 归档（缺省 true）：在 outDir 同级产出 `<id>-<version>.zip`。
  // 设计稿 P8 的发布完成屏显示 `corum-dev-1.0.0.zip`——zip 是分享的载体。
  let archivePath: string | undefined
  if (input.archive !== false) {
    const zipName = `${manifest.id}-${manifest.version}.zip`
    const zipPath = join(outDir, '..', zipName)
    archivePath = packModuleArchive(outDir, zipPath)
  }

  return {
    dir: outDir,
    manifest,
    skills: exportedSkills,
    mcp: exportedMcp.map(e => e.name),
    warnings,
    blocked,
    ...(archivePath !== undefined ? { archive: archivePath } : {}),
  }
}

/**
 * 默认导出位置（`outDir` 留空时用）。
 *
 * 为什么必须有兜底（2026-10-11 实机发现）：发布对话框的「导出位置」初值是空串，
 * 一路传到 `mkdirSync('')` ⇒ ENOENT ⇒ 用户看到一句无信息量的失败，
 * 而**他并没有做错什么**（这一栏在 P7 设计稿里本来就没有，是我加的）。
 * 取「下载目录」是用户对这个动作的预期；下载目录不存在（精简系统/容器）时
 * 退到 `<CORUM_HOME>/module-exports/`——**永远可写**，不会因为一个目录判断把功能锁死。
 *
 * 三平台说明：`~/Downloads` 在 darwin/linux/win32 都是 Node `homedir()` 下的同名目录
 * （Windows 亦为 `%USERPROFILE%\Downloads`），故这里不需要平台分叉；
 * 只用 `existsSync` 做存在性判断，避免在无下载目录的机器上建出一个奇怪的 `~/Downloads`。
 *
 * @param home - 解析后的 CORUM_HOME。
 * @returns 绝对路径（目录可能尚不存在，写盘时创建）。
 */
function defaultExportDir(home: string): string {
  const downloads = join(homedir(), 'Downloads')
  return existsSync(downloads) ? join(downloads, 'corum-modules') : join(home, 'module-exports')
}

/** 递归复制目录（`cpSync` 是 Node 16.7+ 标准 API，shipped-skills.ts 同款用法）。 */
function copyDirRecursive(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true })
}
