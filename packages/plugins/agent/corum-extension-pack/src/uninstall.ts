/**
 * 扩展包卸载编排（P4）。
 *
 * ## 这一层做什么
 *
 * 把一个已安装的扩展包从用户根**整包卸载**，按 registry.json 的归属逐项处理，
 * 最后删 entries.json、pack 目录、registry 记录，触发热应用。
 *
 * 见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §9（卸载分档）与
 * P5-EXTENSION-CENTER-DESIGN.md §5.4（整包卸载语义）。
 *
 * ## 卸载分档（plan §9）
 *
 * | 情况 | 动作 |
 * |---|---|
 * | 资源未改过、未被其它包引用 | 删除 |
 * | 用户改过 | 保留，提示「已转为你的资源」 |
 * | 与别的包同名共用 | 保留，只摘掉本包引用 |
 *
 * ## 依赖注入（与 install-local 同模式）
 *
 * 资源删除（skill 目录 / MCP 注册表项 / 预设目录 / 插件 pnpm remove）的
 * 具体执行器以回调注入，让本函数**可单测**（不启 app、不跑 pnpm）。
 * 桌面壳里把这些回调接到真实实现（skillManager / mcpManager / pluginManager）。
 *
 * ## 部分失败策略
 *
 * 单个资源删除抛错不阻断其余——收集进 warnings，继续处理下一个。
 * entries.json / pack 目录 / registry 记录只在 entries/plugins 清理成功后删，
 * 否则返回 `ok:false` 让 UI 提示用户重试（见 plan §9 第 8 条）。
 *
 * @module @corum/corum-extension-pack/uninstall
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { resolveCorumHome } from '@corum/corum-preset-modules'
import { deleteServer } from '@corum/corum-mcp-manager'
import {
  readRegistry,
  removePack,
  type ExtensionItemKind,
  type ExtensionPackRecord,
} from '@corum/corum-extension-registry'
import { extensionPacksDir, packEntriesPath } from './entries-store.ts'

// ── 类型 ─────────────────────────────────────────────────────────────────

/** 卸载输入。 */
export interface UninstallPackInput {
  /** 要卸载的扩展包 id。 */
  readonly packId: string
  /** 目标 CORUM_HOME。 */
  readonly home: string
  /**
   * 插件卸载回调（依赖注入）。
   *
   * 收到插件名（npm 包名）和 entryId，调 pluginManager 的卸载路径
   * （**绕过 PACK_OWNED 守卫**——整包卸载时归属检查是多余的，因为
   * registry 记录会被同时删除）。
   *
   * 返回 `{ ok, restartRequired?, log? }`。
   */
  readonly uninstallPlugin?: (
    name: string,
    entryId: string,
  ) => Promise<{ ok: boolean; restartRequired?: boolean; log?: string }>
  /**
   * 技能修改检测回调（依赖注入）。
   *
   * 返回该技能的版本数与当前版本 id（用于判定是否被用户改过）。
   * 缺省实现读 `<home>/skills/<name>/skill-versions.json`。
   */
  readonly getSkillFacts?: (name: string) => { versionCount: number; latestVersionId?: string }
  /**
   * 预设修改检测回调（依赖注入）。
   *
   * 宿主按 agent.json mtime 与 installedAt 比较后传入；缺省视为未改
   * （包拥有的预设随整包删除）。
   */
  readonly presetFacts?: (name: string) => { modified: boolean }
}

/** 卸载计划（纯函数，不碰 IO）。 */
export interface UninstallPlan {
  /** 要删除的资源。 */
  readonly toDelete: Array<{ kind: ExtensionItemKind; name: string }>
  /** 要保留的资源。 */
  readonly toKeep: Array<{ kind: ExtensionItemKind; name: string; reason: string }>
}

/** 卸载结果。 */
export interface UninstallPackResult {
  readonly ok: boolean
  readonly packId: string
  readonly removed: {
    readonly presets: readonly string[]
    readonly skills: readonly string[]
    readonly mcp: readonly string[]
    readonly plugins: readonly string[]
    readonly themes: readonly string[]
    readonly ui: readonly string[]
  }
  readonly kept: ReadonlyArray<{ kind: ExtensionItemKind; name: string; reason: string }>
  readonly warnings: readonly string[]
  readonly restartRequired: boolean
  /** ok:false 时的错误信息。 */
  readonly error?: string
}

// ── 纯函数：计划卸载动作 ────────────────────────────────────────────────

/**
 * 计算一个扩展包的卸载动作列表（纯函数，不碰 IO）。
 *
 * 遍历本包 registry record 的六类 items，对每条资源判定 delete / keep / shared：
 *
 * - **delete**：只有本包拥有、且（技能）未改过 → 删。
 * - **shared**：别的包也拥有同名资源 → 保留，只摘引用。
 * - **keep**：用户改过（home 最新版本 id ≠ 安装时记的基线 versionId；
 *   旧台账无 versionId 时退回 versionCount > 1 的保守判据）→ 保留并提示。
 *
 * themes/ui 本轮只摘引用（不删文件）——见 plan §9 第 5 条。
 * presets 本轮保留并 warn（无安全删除 API）——见 plan 约束第 6 条。
 *
 * @param record - 要卸载的包的 registry 记录。
 * @param otherRecords - 其它所有包的 registry 记录（用于判定 shared）。
 * @param resourceFacts - 资源事实查询器（技能版本数等）。
 * @returns 卸载计划。
 */
export function planUninstall(
  record: ExtensionPackRecord,
  otherRecords: readonly ExtensionPackRecord[],
  resourceFacts: {
    /** 技能版本数 + 当前版本 id（用于判定是否被用户改过）。 */
    skillFacts?: (name: string) => { versionCount: number; latestVersionId?: string }
    /** 预设是否被用户改过（缺省视为未改，按包拥有删除）。 */
    presetFacts?: (name: string) => { modified: boolean }
  } = {},
): UninstallPlan {
  const toDelete: Array<{ kind: ExtensionItemKind; name: string }> = []
  const toKeep: Array<{ kind: ExtensionItemKind; name: string; reason: string }> = []

  /** 判断某个 (kind, name) 是否被其它包也拥有。 */
  const isShared = (kind: ExtensionItemKind, name: string): boolean =>
    otherRecords.some(other =>
      other.items?.[kind]?.some(item => item.name === name) === true,
    )

  /** 判断技能是否被用户改过。 */
  const isSkillModified = (name: string, versionId?: string): boolean => {
    const facts = resourceFacts.skillFacts?.(name)
    if (facts === undefined) {
      // 无法判定 → 保守保留（plan §9：如果无法证明未改，keep + warn）。
      return true
    }
    // registry 记录了基线 versionId → 判据 = 当前最新版本 id ≠ 基线。
    // （扩展包技能可自带多个历史版本快照，versionCount>1 不等于用户改过；
    // 只有「安装后出现了基线之外的新版本」才算用户改过。）
    if (versionId !== undefined && facts.latestVersionId !== undefined) {
      return versionId !== facts.latestVersionId
    }
    // registry 无 versionId（旧台账）→ 保持保守行为：versionCount > 1 判改。
    if (facts.versionCount > 1) return true
    // registry 无 versionId（旧台账）且 versionCount ≤ 1 → 无法证明改过 → 算未改。
    // （安装时不写 versionId 是合法的——技能可能没有版本文件。）
    return false
  }

  const kinds: ExtensionItemKind[] = ['presets', 'skills', 'mcp', 'plugins', 'themes', 'ui']

  for (const kind of kinds) {
    const items = record.items?.[kind]
    if (items === undefined) continue

    for (const item of items) {
      const shared = isShared(kind, item.name)

      if (shared) {
        // 被别的包也引用 → 保留，只摘引用。
        toKeep.push({ kind, name: item.name, reason: '与其它扩展包共享，只摘除引用' })
        continue
      }

      // 按类别分档处理。
      if (kind === 'skills') {
        const modified = isSkillModified(item.name, item.versionId)
        if (modified) {
          toKeep.push({ kind, name: item.name, reason: '用户已修改，保留为你的资源' })
        } else {
          toDelete.push({ kind, name: item.name })
        }
      } else if (kind === 'mcp') {
        // MCP 无修改概念——只在 solely owned 时删除。
        toDelete.push({ kind, name: item.name })
      } else if (kind === 'plugins') {
        // 插件：删 entries.json 行 → 热应用 → pnpm remove。
        toDelete.push({ kind, name: item.name })
      } else if (kind === 'presets') {
        // 预设落盘在 <home>/.agent-presets/<id>/；归属本包且未被改过就整目录删。
        // 改过（宿主按 agent.json mtime 判定）⇒ 保留，提示已转为用户资源。
        const modified = resourceFacts.presetFacts?.(item.name)?.modified === true
        if (modified) {
          toKeep.push({ kind, name: item.name, reason: '预设已被修改，保留为你的资源' })
        } else {
          toDelete.push({ kind, name: item.name })
        }
      } else {
        // themes / ui：本轮只摘引用（plan §9 第 5 条）。
        toKeep.push({ kind, name: item.name, reason: '主题/UI 卸载本轮未实现，只摘除引用' })
      }
    }
  }

  return { toDelete, toKeep }
}

// ── 核心：执行卸载 ──────────────────────────────────────────────────────

/**
 * 卸载一个已安装的扩展包（端到端）。
 *
 * 顺序（plan §9）：
 *   1. 读 registry，取本包 record + 其它包 records。
 *   2. planUninstall 计算动作。
 *   3. 先删 entries.json（让 loader 不再 compose 本包的插件行）。
 *   4. 逐项执行删除（skills/mcp/plugins），部分失败收集 warnings 继续。
 *   5. 调 uninstallPlugin 卸载插件（绕过 PACK_OWNED）。
 *   6. 删 pack 目录。
 *   7. 删 registry 记录。
 *   8. 返回结果。
 *
 * 热应用由调用方（extension-manager.ts）在卸载后触发——与 installLocal 同模式。
 *
 * @param input - 见 {@link UninstallPackInput}。
 * @returns 见 {@link UninstallPackResult}。
 */
export async function uninstallExtensionPack(input: UninstallPackInput): Promise<UninstallPackResult> {
  const homeRoot = resolveCorumHome(input.home)

  // 读 registry（fail loud——损坏抛错）。
  const registry = readRegistry(homeRoot)
  const record = registry.packs[input.packId]
  if (record === undefined) {
    return {
      ok: false,
      packId: input.packId,
      removed: { presets: [], skills: [], mcp: [], plugins: [], themes: [], ui: [] },
      kept: [],
      warnings: [`扩展包 "${input.packId}" 不在 registry 中`],
      restartRequired: false,
      error: `扩展包 "${input.packId}" 不在 registry 中`,
    }
  }

  // 其它包的 records（用于判定 shared）。
  const otherRecords = Object.values(registry.packs).filter(p => p.id !== input.packId)

  // 计划。
  const skillFacts = input.getSkillFacts ?? ((name: string) => readSkillFacts(homeRoot, name))
  const plan = planUninstall(record, otherRecords, {
    skillFacts,
    ...(input.presetFacts !== undefined ? { presetFacts: input.presetFacts } : {}),
  })

  const removedPresets: string[] = []
  const removedSkills: string[] = []
  const removedMcp: string[] = []
  const removedPlugins: string[] = []
  const removedThemes: string[] = []
  const removedUi: string[] = []
  const warnings: string[] = []
  let restartRequired = false

  // ── 1. 先删 entries.json（让 loader 不再 compose 本包的插件行） ──
  const entriesPath = packEntriesPath(homeRoot, input.packId)
  let entriesDeleted = false
  if (existsSync(entriesPath)) {
    try {
      rmSync(entriesPath, { force: true })
      entriesDeleted = true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      warnings.push(`删除 entries.json 失败：${msg}`)
    }
  } else {
    entriesDeleted = true // 本来就没有
  }

  // ── 2. 逐项执行删除 ──────────────────────────────────────────────
  for (const action of plan.toDelete) {
    try {
      if (action.kind === 'skills') {
        const skillDir = join(homeRoot, 'skills', action.name)
        if (existsSync(skillDir)) {
          rmSync(skillDir, { recursive: true, force: true })
        }
        removedSkills.push(action.name)
      } else if (action.kind === 'mcp') {
        deleteServer(action.name, homeRoot)
        removedMcp.push(action.name)
      } else if (action.kind === 'presets') {
        // 预设 = <home>/.agent-presets/<id>/（installProfileModule 的落点）。
        const presetDir = join(homeRoot, '.agent-presets', action.name)
        if (existsSync(presetDir)) {
          rmSync(presetDir, { recursive: true, force: true })
        }
        removedPresets.push(action.name)
      } else if (action.kind === 'plugins') {
        // 插件卸载：调注入的 uninstallPlugin 回调（绕过 PACK_OWNED）。
        const pluginItem = record.items.plugins?.find(p => p.name === action.name)
        const entryId = pluginItem?.entryId ?? `ext:${input.packId}:${action.name}`
        if (input.uninstallPlugin !== undefined) {
          const result = await input.uninstallPlugin(action.name, entryId)
          if (result.ok) {
            removedPlugins.push(action.name)
            if (result.restartRequired === true) restartRequired = true
          } else {
            const log = result.log !== undefined ? `：${result.log}` : ''
            warnings.push(`插件 "${action.name}" 卸载失败${log}`)
          }
        } else {
          // 无 uninstallPlugin 回调 → 无法卸载，保留并 warn。
          warnings.push(`插件 "${action.name}" 卸载回调未注入，无法卸载`)
        }
      }
      // presets/themes/ui 不在 toDelete（plan 把它们放 toKeep）。
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      warnings.push(`删除 ${action.kind} "${action.name}" 失败：${msg}`)
    }
  }

  // ── 3. 删 pack 目录（只在 entries 已删时） ────────────────────────
  const packDir = join(extensionPacksDir(homeRoot), input.packId)
  if (entriesDeleted) {
    if (existsSync(packDir)) {
      try {
        rmSync(packDir, { recursive: true, force: true })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        warnings.push(`删除 pack 目录失败：${msg}`)
      }
    }

    // ── 4. 删 registry 记录 ────────────────────────────────────────
    try {
      removePack(input.packId, homeRoot)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      warnings.push(`删除 registry 记录失败：${msg}`)
    }
  } else {
    // entries 没删掉 → 不删 pack 目录 / registry（plan §9 第 8 条：
    // 否则返回 ok:false 让 UI 可重试）。
    warnings.push('entries.json 未删除，保留 registry 记录与 pack 目录以便重试')
    return {
      ok: false,
      packId: input.packId,
      removed: {
        presets: removedPresets,
        skills: removedSkills,
        mcp: removedMcp,
        plugins: removedPlugins,
        themes: removedThemes,
        ui: removedUi,
      },
      kept: plan.toKeep,
      warnings,
      restartRequired,
      error: 'entries.json 未删除，卸载不完整',
    }
  }

  return {
    ok: true,
    packId: input.packId,
    removed: {
      presets: removedPresets,
      skills: removedSkills,
      mcp: removedMcp,
      plugins: removedPlugins,
      themes: removedThemes,
      ui: removedUi,
    },
    kept: plan.toKeep,
    warnings,
    restartRequired,
  }
}

// ── 辅助 ────────────────────────────────────────────────────────────────

/**
 * 读技能事实：版本数 + 当前版本 id。
 *
 * 与 skill-manager-service 的 readVersions 同口径：读
 * `<home>/skills/<name>/skill-versions.json` 的 `versions[]`。
 * versionCount = versions.length；latestVersionId = 最后一条的 id。
 *
 * 本包不依赖 @corum/corum-skill-manager（避免循环依赖），
 * 故就地读 skill-versions.json 而非调用 skill-manager 的内部函数。
 */
function readSkillFacts(home: string, name: string): { versionCount: number; latestVersionId?: string } {
  const versionsFile = join(home, 'skills', name, 'skill-versions.json')
  if (!existsSync(versionsFile)) {
    // 无版本文件 → 0 版本。无法证明未改 → planUninstall 会 keep。
    return { versionCount: 0 }
  }
  try {
    const raw = readFileSync(versionsFile, 'utf8')
    const parsed = JSON.parse(raw) as { versions?: Array<{ id?: string }> }
    const versions = parsed.versions ?? []
    const latest = versions.length > 0 ? versions[versions.length - 1] : undefined
    return {
      versionCount: versions.length,
      ...(latest?.id !== undefined ? { latestVersionId: latest.id } : {}),
    }
  } catch {
    return { versionCount: 0 }
  }
}
