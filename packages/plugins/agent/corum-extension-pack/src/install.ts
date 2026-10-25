/**
 * 扩展包（Extension Pack）安装（P2）。
 *
 * ## 落点（与 corum-preset-modules 的模块安装对齐）
 *
 * 扩展包把「一套能力」收进一个容器，安装就是把它**整体落进用户根**：
 *   · 预设 → `<home>/.agent-presets/<preset-name>/agent.json`（复用 `installProfileModule`）；
 *   · 技能 → `<home>/skills/<name>/`；
 *   · MCP  → `<home>/mcp-servers.json`（走 `saveServer`，绝不写 `requires` 进注册表）；
 *   · 插件 / 主题 / UI → **本轮不安装**，登记成 `deferred` 返回（P3/P4 才落地）。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §4 的安装顺序与冲突策略。
 *
 * ## 顺序纪律（skills → mcp → presets）
 *
 * 预设的 agent.json 是按**名字**引用技能/MCP 的。故必须先把技能/MCP 装进 home，
 * 再装预设本体——否则预设装好后名字解析不到（虽然名字解析是运行期的事，但顺序
 * 固定后语义清晰：安装完成后立即可用）。
 *
 * ## 为什么预设要投影成临时 PresetModule 再装
 *
 * `installProfileModule` 已封装了「预设落盘 + moduleSource 来源标记 + 版本自增 +
 * rename/skip 冲突策略」的全部逻辑。扩展包的每个 preset 在包根下是
 * `presets/<name>/agent.json`（不是模块格式），投影成临时模块（module.json + agent.json）
 * 后就能**直接复用**这套逻辑，不必重写一份。这是「复用而非重造」的纪律。
 *
 * ## 编译不由本函数触发
 *
 * 与 `installProfileModule` 同口径：`agent.cordis.yml` 的编译需要 `compilePreset`
 * （在 corum-agent 里，依赖方向不允许本包反向 import）。调用方（后续的 extension-pack
 * RPC 端点）在装完后对每个 preset 走一次 `loadProfile` → `writeAgentDir` 触发编译；
 * 本函数只负责把文件落到正确位置。
 *
 * @module @corum/corum-extension-pack/install
 */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { scanExtensionPack, type ExtensionPackScan } from './scan.ts'
import type { ExtensionManifest } from './extension-format.ts'
import {
  unpackModuleArchive,
  installProfileModule,
  validateMcpEntry,
  resolveCorumHome,
  type ModuleMcpEntry,
} from '@corum/corum-preset-modules'
import { getServer, saveServer } from '@corum/corum-mcp-manager'
import type { McpServerConfig } from '@corum/corum-mcp-manager'

/**
 * 安装时的冲突策略（per-item，与 `InstallModuleInput.conflict` 同构）。
 *
 * - `skills[name]`：同名技能已存在时，`skip` 保留现有（默认）、`overwrite` 覆盖。
 * - `mcp[name]`：同名 MCP 服务已在注册表时，`keep` 保留现有（默认）、`overwrite` 覆盖。
 * - `profile`：同名预设已存在时，`skip` 跳过（默认）、`overwrite` 覆盖、`rename` 改名。
 */
export interface ExtensionInstallConflict {
  readonly skills?: Readonly<Record<string, 'skip' | 'overwrite'>>
  readonly mcp?: Readonly<Record<string, 'keep' | 'overwrite'>>
  readonly profile?: 'skip' | 'overwrite' | 'rename'
}

/** 安装输入。`sourceDir` 可以是目录或 `.zip` 文件。 */
export interface ExtensionInstallInput {
  /** 扩展包来源（目录或 .zip 文件路径）。 */
  readonly sourceDir: string
  /** 目标 CORUM_HOME。 */
  readonly home: string
  readonly conflict?: ExtensionInstallConflict
}

/** 单个预设的安装结果。 */
export interface ExtensionInstallPresetResult {
  /** 包内 preset 名（= 投影模块的 id）。 */
  readonly id: string
  /** 落盘后的预设 id（rename 策略下可能与 id 不同）。 */
  readonly profileId: string
  /** 是否因 skip 策略跳过。 */
  readonly skipped: boolean
}

/**
 * 被推迟安装的内容类（P3/P4 才落地）。
 *
 * 本轮只登记不安装——安装器必须明确告诉用户「这些没装、为什么」，
 * 否则用户以为整个包都装好了，实际插件/主题/UI 都没生效。
 */
export interface ExtensionDeferredClass {
  /** 推迟的类：plugins / themes / ui。 */
  readonly kind: 'plugins' | 'themes' | 'ui'
  /** 该类下被推迟的实体名列表。 */
  readonly names: readonly string[]
  /** 推迟原因（给人看）。 */
  readonly reason: string
}

/** 扩展包安装结果。 */
export interface ExtensionInstallResult {
  /** 扩展包 id（取自 manifest.id）。 */
  readonly packId: string
  /** 技能安装情况：已装 / 已跳过。 */
  readonly skills: { readonly installed: readonly string[]; readonly skipped: readonly string[] }
  /** MCP 安装情况：已写入注册表 / 已保留现有。 */
  readonly mcp: { readonly applied: readonly string[]; readonly kept: readonly string[] }
  /** 各预设的安装结果。 */
  readonly presets: readonly ExtensionInstallPresetResult[]
  /** 被推迟的类（plugins/themes/ui）。 */
  readonly deferred: readonly ExtensionDeferredClass[]
  /** 非致命提示（透传自扫描）。 */
  readonly warnings: readonly string[]
}

/** 判断路径是否是 `.zip`（大小写不敏感，与 module-install 同款判据）。 */
function isZipPath(path: string): boolean {
  return path.toLowerCase().endsWith('.zip')
}

/**
 * 从扫描结果里取某个 mcp 条目文件的内容（已 JSON.parse）。
 *
 * 失败返回 undefined——扫描阶段已把读不到的进 errors，这里读到的一定是合法的。
 */
function readMcpEntry(scan: ExtensionPackScan, name: string): ModuleMcpEntry | undefined {
  const ref = scan.mcp.find(m => m.name === name)
  if (ref === undefined) return undefined
  try {
    return JSON.parse(readFileSync(ref.path, 'utf8')) as ModuleMcpEntry
  } catch {
    return undefined
  }
}

/**
 * 从模块条目构造注册表需要的 `McpServerConfig`。
 *
 * **绝不带 `requires`**（与 `corum-preset-modules/module-install.ts` 的 `buildMcpServerConfig`
 * 同源理由）：注册表的 `listServers` 是裸 `JSON.parse` 无校验，把 `requires` 写进去会
 * 永久留在盘上，而它只是模块内的安装声明，不属于运行时配置。
 *
 * exactOptionalPropertyTypes 下条件展开会让 TS 推断出可选属性含 `undefined`，
 * 与 `McpServerConfig` 不兼容；故先构造为 Record 再断言（同 module-install 的写法）。
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

/**
 * 把一个扩展包安装进用户根。
 *
 * 顺序：解包 → 扫描（fail-loud on errors）→ 技能 → MCP → 预设 → 登记 deferred。
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §4（安装顺序与冲突策略）。
 *
 * ⚠️ 本轮**不做部分失败回滚**：扫描失败会在落任何盘之前抛错（无残留），但若预设 #2
 * 在 `installProfileModule` 里抛错，已装的技能/MCP/前置预设会留在用户根。回滚路径属
 * 方案 P4（归属台账 + 卸载分档）；在那之前调用方应把安装当作「要么全装、要么手动清理」。
 *
 * @param input - 见 {@link ExtensionInstallInput}。
 * @returns 见 {@link ExtensionInstallResult}。
 * @throws 当扫描有 errors 时（不部分安装一个坏包）。
 */
export function installExtensionPack(input: ExtensionInstallInput): ExtensionInstallResult {
  // 目标根先按 CORUM_HOME 同一口径解析（`~` 展开、空串回落到环境变量 / 默认值）。
  // 不解析会把 `~/x` 当字面目录名，技能与注册表会落到相对路径下（与 P0 同类的分根缺陷）。
  const homeRoot = resolveCorumHome(input.home)

  // ── 1. 解析来源：目录或 .zip ──────────────────────────────────
  const tmpUnzipDir = isZipPath(input.sourceDir)
    ? mkdtempSync(join(tmpdir(), 'corum-extension-unzip-'))
    : undefined
  try {
    let effectiveDir = input.sourceDir
    if (tmpUnzipDir !== undefined) {
      // .zip ⇒ 解到临时目录（unpackModuleArchive 返回解包后的目录绝对路径）。
      effectiveDir = unpackModuleArchive(input.sourceDir, tmpUnzipDir)
      // 解包根若没有 extension.json 但恰好有一个子目录有 ⇒ 下降进那个子目录
      // （zip 打包时常见的「外层多一层根目录」形态）。
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

    // ── 2. 扫描；有 errors ⇒ fail-loud（不部分安装） ────────────
    const scan = scanExtensionPack(effectiveDir)
    if (scan.errors.length > 0) {
      const msg = scan.errors.map(e => `[${e.field}] ${e.message}`).join('; ')
      throw new Error(`corum-extension-pack: 扩展包扫描失败，拒绝安装（${scan.errors.length} 个错误）：${msg}`)
    }

    const manifest = scan.manifest as ExtensionManifest
    const packId = manifest.id

    // ── 3. 技能：整目录复制到 <home>/skills/<name> ──────────────
    const skillsRoot = join(homeRoot, 'skills')
    const installedSkills: string[] = []
    const skippedSkills: string[] = []
    for (const ref of scan.skills) {
      const dest = join(skillsRoot, ref.name)
      if (existsSync(dest)) {
        // per-item：取不到默认 'skip'（向后兼容——caller 不传 conflict 即全部跳过）。
        const strategy = input.conflict?.skills?.[ref.name] ?? 'skip'
        if (strategy === 'skip') {
          skippedSkills.push(ref.name)
          continue
        }
        // overwrite ⇒ 删旧的再复制（避免残留文件）。
        rmSync(dest, { recursive: true, force: true })
      }
      mkdirSync(skillsRoot, { recursive: true })
      cpSync(ref.path, dest, { recursive: true })
      installedSkills.push(ref.name)
    }

    // ── 4. MCP：走 saveServer，绝不写 requires 进注册表 ─────────
    const mcpApplied: string[] = []
    const mcpKept: string[] = []
    for (const ref of scan.mcp) {
      const entry = readMcpEntry(scan, ref.name)
      if (entry === undefined) {
        // 扫描阶段已校验过存在性 + validateMcpEntry，读不到说明竞态删除——跳过并继续。
        continue
      }
      // 再次跑 validateMcpEntry（防御性；扫描已跑过，但 zip 解包后到此刻之间若有人手改，
      // 这里是最后一道闸）。
      if (validateMcpEntry(entry).length > 0) continue

      // per-item：取不到默认 'keep'（与 module-install 同语义）。
      const strategy = input.conflict?.mcp?.[ref.name] ?? 'keep'
      if (getServer(ref.name, homeRoot) !== undefined && strategy === 'keep') {
        mcpKept.push(ref.name)
        continue
      }
      // 落点一致性：saveServer 第二参传解析后的 homeRoot，保证与 skills/presets 同根
      // （P0 缺陷的修法——绝不只靠 CORUM_HOME 环境变量）。
      saveServer(buildMcpServerConfig(entry), homeRoot)
      mcpApplied.push(ref.name)
    }

    // ── 5. 预设：投影成临时 PresetModule 再走 installProfileModule ─
    const presetResults: ExtensionInstallPresetResult[] = []
    const profileStrategy = input.conflict?.profile ?? 'skip'
    for (const ref of scan.presets) {
      const tempModuleDir = mkdtempSync(join(tmpdir(), 'corum-extension-preset-'))
      try {
        // agent.json：字节复制包里的 presets/<name>/agent.json（保留原始引用名）。
        const agentJsonBytes = readFileSync(ref.path)
        writeFileSync(join(tempModuleDir, 'agent.json'), agentJsonBytes)

        // 头像相对路径只认预设自己的 agent.json，且必须落在扩展包根内。
        // 复制到临时模块后由 installProfileModule 统一转成 dataURL。
        const avatarSource = resolvePresetAvatarSource(effectiveDir, agentJsonBytes)
        const hasAvatar = avatarSource !== undefined
        if (avatarSource !== undefined) {
          mkdirSync(join(tempModuleDir, 'assets'), { recursive: true })
          cpSync(avatarSource, join(tempModuleDir, 'assets', 'avatar.png'))
        }

        // module.json：把包内 preset 投影成一份合法的 PresetModule。
        // contents.skills/mcp 都置空——技能/MCP 已在步骤 3/4 装好，agent.json 仍按名字引用它们。
        const moduleManifest = {
          formatVersion: 1,
          id: ref.name,
          version: manifest.version,
          name: readPresetNickname(ref.path) ?? ref.name,
          contents: { skills: [], mcp: [], hasAvatar },
        }
        writeFileSync(join(tempModuleDir, 'module.json'), `${JSON.stringify(moduleManifest, null, 2)}\n`, 'utf8')

        const result = installProfileModule({
          sourceDir: tempModuleDir,
          home: homeRoot,
          conflict: {
            profile: profileStrategy,
            skills: {},
            mcp: {},
          },
        })
        presetResults.push({
          id: ref.name,
          profileId: result.profileId,
          skipped: result.skipped,
        })
      } finally {
        rmSync(tempModuleDir, { recursive: true, force: true })
      }
    }

    // ── 6. deferred：plugins/themes/ui 本轮只登记不安装 ─────────
    const deferred: ExtensionDeferredClass[] = []
    if (scan.plugins.length > 0) {
      deferred.push({
        kind: 'plugins',
        names: scan.plugins.map(p => p.name),
        reason: 'P3/P4 未实现：插件挂载（entries.json + boot 折行）尚未落地；本轮只登记不安装',
      })
    }
    if (scan.themes.length > 0) {
      deferred.push({
        kind: 'themes',
        names: scan.themes.map(t => t.name),
        reason: 'P3/P4 未实现：主题跨进程导入未做；本轮只登记不安装',
      })
    }
    if (scan.ui.length > 0) {
      deferred.push({
        kind: 'ui',
        names: scan.ui.map(u => u.name),
        reason: 'P3/P4 未实现：UI 依赖插件挂载，插件未装故 UI 亦推迟；本轮只登记不安装',
      })
    }

    return {
      packId,
      skills: { installed: installedSkills, skipped: skippedSkills },
      mcp: { applied: mcpApplied, kept: mcpKept },
      presets: presetResults,
      deferred,
      warnings: scan.warnings,
    }
  } finally {
    // 清理解包临时目录（目录来源不需要清理）。
    if (tmpUnzipDir !== undefined) {
      rmSync(tmpUnzipDir, { recursive: true, force: true })
    }
  }
}

/**
 * 从预设 agent.json 解析包内头像文件。
 *
 * 字段缺失、不是非空字符串、文件不存在、路径越界（含符号链接越界）时均返回
 * undefined，保持原来的无头像安装行为。不能用 extension.json 顶层 avatar 推断。
 */
function resolvePresetAvatarSource(packRoot: string, agentJsonBytes: Buffer): string | undefined {
  try {
    const profile = JSON.parse(agentJsonBytes.toString('utf8')) as { avatar?: unknown }
    if (typeof profile.avatar !== 'string' || profile.avatar === '') return undefined

    const candidate = resolve(packRoot, profile.avatar)
    const rel = relative(packRoot, candidate)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined

    const rootReal = realpathSync(packRoot)
    const avatarReal = realpathSync(candidate)
    const realRel = relative(rootReal, avatarReal)
    if (realRel === '' || realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return undefined
    if (!statSync(avatarReal).isFile()) return undefined
    return avatarReal
  } catch {
    return undefined
  }
}

/**
 * 读 presets/<name>/agent.json 里的 nickname（用于投影模块的显示名）。
 *
 * 读不到或不是字符串 ⇒ 返回 undefined（调用方用 preset 名兜底）。
 */
function readPresetNickname(agentJsonPath: string): string | undefined {
  try {
    const profile = JSON.parse(readFileSync(agentJsonPath, 'utf8')) as { nickname?: unknown }
    if (typeof profile.nickname === 'string' && profile.nickname !== '') return profile.nickname
    return undefined
  } catch {
    return undefined
  }
}
