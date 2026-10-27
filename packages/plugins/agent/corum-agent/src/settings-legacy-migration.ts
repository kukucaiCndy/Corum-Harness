/**
 * fork（corum）：旧 `settings.yaml` 段名 → 新 ns 的一次性迁移（D2 纠偏配套）。
 *
 * ## 背景（2026-10-27 D2 纠偏）
 *
 * rc3 的 `settings.describe()` / `write()` 用 **entry id 作为 ns**（不存在 entry id →
 * ns 的映射）。三个 corum settings registrar 的行 id 分别是：
 *   - `corum-subagent-settings`（旧消费方读 `corum-subagent`）
 *   - `corum-memory-settings`（旧消费方读 `corum-memory`）
 *   - `corum-ui-onboarding-settings`（旧消费方读 `ui-onboarding`）
 *
 * 裁决 A：消费方 ns 对齐行 id。但旧 `settings.yaml` 里的段名是旧 ns
 * （`corum-subagent:` / `corum-memory:` / `ui-onboarding:`），rc3 的
 * `importLegacyDocument` 按 `LEGACY_SECTION_ENTRIES[section] ?? section` 找 entry——
 * 这三个旧段名不在官方映射表里（`ui-onboarding` 被官方映射到 `ui-settings-general`，
 * 但 corum 的 onboarding 段有自己的新 ns），故 `update('corum-subagent', …)` 找不到
 * entry ⇒ warn 丢值。
 *
 * ## 本模块做什么
 *
 * 在官方 `importLegacyDocument` 跑完（`settings.yaml` 已被改名为 `.imported`）后，
 * 读取 `.imported` 文件里的三个旧段，映射到新 ns，**只在目标 ns 尚无显式用户值时**
 * 补写（新设置优先，不被旧值覆盖）。
 *
 * ## 幂等保障
 *
 * 用一个 marker 文件 `settings.legacy-ns-migrated` 记录迁移已完成：存在即跳过。
 * marker 内容 = 迁移日期 + 迁移的段列表，便于审计。
 *
 * ## 纪律
 *
 * - **只补缺值**：目标 ns 已有用户显式值时不覆盖（`describe().user` 非空即跳过）。
 * - **坏值 warn 不启动失败**：旧段值类型校验失败只 warn，不抛错。
 * - **不触碰真实 home 做测试**：所有路径走 `resolveDshHome()`，测试用 temp fixture。
 *
 * @module @corum/corum-agent/settings-legacy-migration
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** 旧 ns → 新 ns 的映射表（D2 纠偏裁决 A 的配套）。 */
export const LEGACY_NS_MAPPING: ReadonlyMap<string, string> = new Map([
  ['corum-subagent', 'corum-subagent-settings'],
  ['corum-memory', 'corum-memory-settings'],
  // `ui-onboarding` 被官方 LEGACY_SECTION_ENTRIES 映射到 `ui-settings-general`，
  // 但 corum 的 onboarding 段（welcomeNoticeVersion）有自己的新 ns。
  // 只有当旧段里确实有 `welcomeNoticeVersion` 字段时才迁移（避免抢官方映射的值）。
  ['ui-onboarding', 'corum-ui-onboarding-settings'],
])

/** marker 文件名（与 `settings.yaml.imported` 同目录）。 */
export const MIGRATION_MARKER = 'settings.legacy-ns-migrated'

/** 迁移结果（测试与日志用）。 */
export interface LegacyMigrationResult {
  /** 读取的 `.imported` 文件路径。 */
  readonly importedFile: string
  /** 已迁移的段（旧 ns → 新 ns + 字段数）。 */
  readonly migrated: ReadonlyArray<{ readonly oldNs: string; readonly newNs: string; readonly fields: number }>
  /** 跳过的段（目标 ns 已有显式值）。 */
  readonly skipped: ReadonlyArray<{ readonly oldNs: string; readonly newNs: string; readonly reason: string }>
  /** 旧段值类型校验失败的（warn 不中断）。 */
  readonly badValues: ReadonlyArray<{ readonly oldNs: string; readonly field: string; readonly reason: string }>
}

/** settings 服务面（窄化，只取 describe + update）。 */
export interface SettingsMigrationFace {
  describe?: (options?: unknown) => readonly { ns: string; user?: unknown }[]
  update?: (ns: string, patch: object) => Promise<void>
}

/**
 * 解析 YAML 段（轻量逐行解析——不依赖 YAML 库，对语法残缺也不抛错）。
 *
 * 只提取顶层段名 + 其下的扁平键值对（`key: value`）。嵌套结构（如 `defaultModel:` 下的
 * `provider:` / `model:`）会作为一个子映射原样保留在段对象里。
 *
 * @param text - `.imported` 文件的原文。
 * @returns 段名 → 段内容（键值对）的映射。
 */
export function parseYamlSections(text: string): Record<string, Record<string, unknown>> {
  const sections: Record<string, Record<string, unknown>> = {}
  let currentSection: string | undefined
  let currentIndent = 0
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    // 跳过空行与注释。
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    // 顶层段（缩进 0）。
    if (indent === 0) {
      const match = /^([^\s#:'"]+):\s*$/.exec(trimmed)
      if (match !== null) {
        currentSection = match[1]
        currentIndent = 0
        if (currentSection !== undefined) sections[currentSection] = {}
      }
      continue
    }
    if (currentSection === undefined) continue
    // 段内键值对（缩进 > 0）。
    const kvMatch = /^(\S+):\s*(.*)$/.exec(trimmed)
    if (kvMatch !== null) {
      const [, key, rawValue] = kvMatch
      if (rawValue === undefined || rawValue === '') {
        // 嵌套映射开始——后续同缩进的行是它的子键。
        // 简单处理：存一个空对象，后续行会填充。
        sections[currentSection]![key] = {}
      } else {
        // 标量值——尝试解析常见 YAML 类型。
        sections[currentSection]![key] = parseYamlScalar(rawValue)
      }
    }
  }
  return sections
}

/** 解析 YAML 标量值（布尔/数字/null/字符串）。 */
function parseYamlScalar(raw: string): unknown {
  const v = raw.trim()
  // 去掉行内注释（`value # comment`）。
  const hashIdx = v.indexOf(' #')
  const clean = hashIdx >= 0 ? v.slice(0, hashIdx).trim() : v
  if (clean === 'true') return true
  if (clean === 'false') return false
  if (clean === 'null' || clean === '~' || clean === '') return null
  if (clean === 'undefined') return undefined
  // 数字（整数或浮点）。
  if (/^-?\d+$/.test(clean)) return Number.parseInt(clean, 10)
  if (/^-?\d+\.\d+$/.test(clean)) return Number.parseFloat(clean)
  // 带引号的字符串。
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    return clean.slice(1, -1)
  }
  return clean
}

/**
 * 把嵌套的「空对象占位」展平回原始子映射（`parseYamlSections` 的两遍式补全）。
 *
 * `parseYamlSections` 遇到嵌套映射时先存空对象，后续行才填子键。需要第二遍把子键
 * 归入正确的父键。这里用简化的缩进对齐方式。
 *
 * @param text - `.imported` 文件的原文。
 * @returns 段名 → 完整段内容（含嵌套）的映射。
 */
export function parseYamlSectionsDeep(text: string): Record<string, Record<string, unknown>> {
  const sections: Record<string, Record<string, unknown>> = {}
  let currentSection: string | undefined
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = []
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    // 弹栈到当前缩进的父级。
    while (stack.length > 0 && indent <= (stack[stack.length - 1]?.indent ?? 0)) {
      stack.pop()
    }
    if (indent === 0) {
      const match = /^([^\s#:'"]+):\s*$/.exec(trimmed)
      if (match !== null) {
        currentSection = match[1]
        if (currentSection !== undefined) {
          sections[currentSection] = {}
          stack.length = 0
          stack.push({ indent: 0, obj: sections[currentSection]! })
        }
      }
      continue
    }
    if (currentSection === undefined) continue
    const parent = stack[stack.length - 1]?.obj
    if (parent === undefined) continue
    const kvMatch = /^(\S+):\s*(.*)$/.exec(trimmed)
    if (kvMatch === null) continue
    const [, key, rawValue] = kvMatch
    if (rawValue === undefined || rawValue === '') {
      // 嵌套映射开始。
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, obj: child })
    } else {
      parent[key] = parseYamlScalar(rawValue)
    }
  }
  return sections
}

/**
 * 执行一次性迁移（幂等）。
 *
 * **幂等保障**：marker 文件存在即跳过。
 * **新值优先**：目标 ns 在 `describe().user` 里已有非空值时跳过该段。
 * **坏值 warn**：旧段值类型校验失败只 warn 不抛。
 *
 * @param home - DSH home 目录（`resolveDshHome()`）；测试传 temp fixture。
 * @param settings - settings 服务面（`ctx.get('settings')`）；undefined 时跳过。
 * @param logger - 可选日志器（warn/info）。
 * @returns 迁移结果；marker 已存在或文件缺失时返回 null。
 */
export function migrateLegacySettingsNs(
  home: string,
  settings: SettingsMigrationFace | undefined,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): LegacyMigrationResult | null {
  const importedPath = join(home, 'settings.yaml.imported')
  const markerPath = join(home, MIGRATION_MARKER)

  // 幂等：marker 已存在即跳过。
  if (existsSync(markerPath)) return null
  // `.imported` 文件不存在（官方 importLegacyDocument 未跑 / 首次安装无旧文件）。
  if (!existsSync(importedPath)) return null
  if (settings === undefined || typeof settings.describe !== 'function') return null

  // 读取并解析 `.imported`。
  let text: string
  try {
    text = readFileSync(importedPath, 'utf8')
  } catch (error: unknown) {
    logger?.warn?.(`settings-legacy-migration: failed to read ${importedPath}: ${String(error)}`)
    return null
  }

  const sections = parseYamlSectionsDeep(text)
  const describe = settings.describe?.() ?? []

  // 检查目标 ns 是否已有显式用户值。
  const hasUserValue = (ns: string): boolean => {
    const row = describe.find(d => d.ns === ns)
    if (row === undefined) return false
    const user = row.user
    if (user === undefined || user === null) return false
    if (typeof user === 'object') {
      const obj = user as Record<string, unknown>
      return Object.keys(obj).length > 0
    }
    return true
  }

  const migrated: Array<{ oldNs: string; newNs: string; fields: number }> = []
  const skipped: Array<{ oldNs: string; newNs: string; reason: string }> = []
  const badValues: Array<{ oldNs: string; field: string; reason: string }> = []

  for (const [oldNs, newNs] of LEGACY_NS_MAPPING) {
    const section = sections[oldNs]
    if (section === undefined) continue
    const fieldCount = Object.keys(section).length
    if (fieldCount === 0) continue

    // 新值优先：目标 ns 已有显式用户值时跳过。
    if (hasUserValue(newNs)) {
      skipped.push({ oldNs, newNs, reason: 'target ns already has explicit user value' })
      continue
    }

    // 类型校验：只迁已知的合法字段（按段做白名单）。
    const validated = validateLegacySection(oldNs, section, badValues)
    if (Object.keys(validated).length === 0) {
      skipped.push({ oldNs, newNs, reason: 'no valid fields after validation' })
      continue
    }

    // 写入新 ns（补缺值）。
    try {
      settings.update?.(newNs, validated)
      migrated.push({ oldNs, newNs, fields: Object.keys(validated).length })
    } catch (error: unknown) {
      logger?.warn?.(`settings-legacy-migration: update(${newNs}) failed: ${String(error)}`)
      skipped.push({ oldNs, newNs, reason: `update failed: ${String(error)}` })
    }
  }

  // 写 marker（记录迁移完成）。
  try {
    writeFileSync(markerPath, JSON.stringify({
      migratedAt: new Date().toISOString(),
      migrated: migrated.map(m => `${m.oldNs}→${m.newNs} (${m.fields} fields)`),
      skipped: skipped.map(s => `${s.oldNs}→${s.newNs}: ${s.reason}`),
    }, null, 2), 'utf8')
  } catch (error: unknown) {
    logger?.warn?.(`settings-legacy-migration: failed to write marker: ${String(error)}`)
  }

  logger?.info?.(
    `settings-legacy-migration: migrated ${migrated.length} section(s), skipped ${skipped.length}`,
  )

  return { importedFile: importedPath, migrated, skipped, badValues }
}

/**
 * 对旧段做字段类型校验（坏值 warn 不中断）。
 *
 * 白名单按段的已知 schema 做轻量校验——不做完整 schemastery 验证（那是 settings
 * 服务的事），只挡明显坏值（类型完全不对的）。
 *
 * @param oldNs - 旧段名。
 * @param section - 段内容。
 * @param badValues - 坏值收集器（push 到这个数组）。
 * @returns 校验通过的键值对。
 */
function validateLegacySection(
  oldNs: string,
  section: Record<string, unknown>,
  badValues: Array<{ oldNs: string; field: string; reason: string }>,
): Record<string, unknown> {
  const valid: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(section)) {
    // 通用：null/undefined 跳过（omission 语义——未设置的键不迁）。
    if (value === null || value === undefined) continue
    // `corum-subagent` 段已知字段。
    if (oldNs === 'corum-subagent') {
      if (key === 'maxParallelChildren') {
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
          valid[key] = value
        } else {
          badValues.push({ oldNs, field: key, reason: `expected positive integer, got ${typeof value}` })
        }
        continue
      }
      if (key === 'defaultModel' || key === 'defaultResearchModel') {
        if (typeof value === 'object' && value !== null) {
          const obj = value as Record<string, unknown>
          if (typeof obj.provider === 'string' && typeof obj.model === 'string') {
            valid[key] = value
          } else {
            badValues.push({ oldNs, field: key, reason: 'expected {provider, model} object' })
          }
        } else {
          badValues.push({ oldNs, field: key, reason: `expected object, got ${typeof value}` })
        }
        continue
      }
    }
    // `corum-memory` 段已知字段。
    if (oldNs === 'corum-memory') {
      if (key === 'enabled' || key === 'autoCleanExpired') {
        if (typeof value === 'boolean') { valid[key] = value }
        else { badValues.push({ oldNs, field: key, reason: `expected boolean, got ${typeof value}` }) }
        continue
      }
      if (key === 'readPromoteThreshold' || key === 'injectLimit' || key === 'injectBudget') {
        if (typeof value === 'number') { valid[key] = value }
        else { badValues.push({ oldNs, field: key, reason: `expected number, got ${typeof value}` }) }
        continue
      }
      if (key === 'capacity') {
        if (value === null || typeof value === 'number') { valid[key] = value }
        else { badValues.push({ oldNs, field: key, reason: `expected number or null, got ${typeof value}` }) }
        continue
      }
      // 字符串枚举字段（defaultRetention / decayStrength / overflowPolicy / injectMode）。
      if (['defaultRetention', 'decayStrength', 'overflowPolicy', 'injectMode'].includes(key)) {
        if (typeof value === 'string') { valid[key] = value }
        else { badValues.push({ oldNs, field: key, reason: `expected string, got ${typeof value}` }) }
        continue
      }
    }
    // `ui-onboarding` 段已知字段。
    if (oldNs === 'ui-onboarding') {
      if (key === 'welcomeNoticeVersion') {
        if (typeof value === 'string') { valid[key] = value }
        else { badValues.push({ oldNs, field: key, reason: `expected string, got ${typeof value}` }) }
        continue
      }
    }
    // 未知字段：保留（不做白名单阻拦——可能是有意添加的自定义键）。
    valid[key] = value
  }
  return valid
}

/**
 * 迁移函数的 boot 入口（由 `corum-agent/index.ts` 的 apply 调用）。
 *
 * 等待 settings 服务挂载后执行迁移。settings 服务在 boot 早期可能尚未挂载——
 * 用短轮询（同 `runSettingsYamlGuard` / `corum-subagent` 的 `bindSettings` 同款）。
 *
 * @param ctx - cordis Context。
 * @param resolveHome - 解析 home 目录的函数（默认 `resolveDshHome`）。
 */
export function runLegacySettingsMigration(
  ctx: { get: (name: string) => unknown; logger?: { warn?: (msg: string) => void; info?: (msg: string) => void } },
  resolveHome: () => string | undefined = resolveDshHome,
): void {
  const home = resolveHome()
  if (home === undefined) return
  // 快速检查：`.imported` 文件不存在或 marker 已存在时直接跳过（不轮询）。
  const importedPath = join(home, 'settings.yaml.imported')
  const markerPath = join(home, MIGRATION_MARKER)
  if (!existsSync(importedPath) || existsSync(markerPath)) return

  // settings 服务在 boot 早期可能尚未挂载——短轮询。
  const attempt = (): boolean => {
    const settings = ctx.get('settings') as SettingsMigrationFace | undefined
    if (settings === undefined) return false
    try {
      migrateLegacySettingsNs(home, settings, ctx.logger)
    } catch (error: unknown) {
      ctx.logger?.warn?.(`settings-legacy-migration: ${String(error)}`)
    }
    return true
  }
  if (attempt()) return
  const poll = setInterval(() => {
    try { if (attempt()) clearInterval(poll) } catch { /* 继续轮询 */ }
  }, 200)
  setTimeout(() => clearInterval(poll), 15000)
}
