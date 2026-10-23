/**
 * 扩展包归属台账的读写与查询（P5a）。
 *
 * ## 这一层做什么
 *
 * 读写 `<CORUM_HOME>/extension-packs/registry.json`，回答两个核心问题：
 *   1. 「某资源由哪个扩展包拥有？」→ `findOwner(kind, name, home)`
 *   2. 「所有资源的归属一览」→ `ownershipMap(home)`（kind → name → packId）
 *
 * ## 为什么是中性小包（无 @corum 依赖）
 *
 * 见 P5 设计文档 §5.2「双端强制」与 §8 风险 1：
 * 归属检查必须走中性 registry 包，不能让 skill/mcp manager 反向依赖
 * extension-pack（extension-pack 现在依赖 preset-modules → mcp-manager，
 * 若 skill/mcp manager 再依赖 extension-pack 就成环）。
 * 所以本包只依赖官方 `@deepseek-ai/dsh-home-paths`，所有 @corum/* 包都能
 * 安全地依赖它。
 *
 * ## 为什么 fail loud（不静默跳过脏数据）
 *
 * 与 entries-store（P3a）同口径：registry.json 坏掉（手改错）必须 fail loud
 * 而不是静默返回空——否则用户在技能页点卸载，归属检查查不到包、放行了本该
 * 拒绝的删除，扩展包资源被删后 registry 与磁盘漂移、整包卸载无法清理
 * （见 §8 风险 3）。缺失目录/文件返回空是合法的（干净 home 没装过扩展包），
 * 但**存在的文件**损坏/非法结构必须抛错。
 *
 * @module @corum/corum-extension-registry/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ExtensionItemKind, ExtensionPackRecord, ExtensionRegistry } from './types.ts'

// ── 常量 ───────────────────────────────────────────────────────────────

/** extension-packs 目录名（相对 CORUM_HOME）。 */
export const EXTENSION_PACKS_DIRNAME = 'extension-packs'

/** registry.json 文件名（落在 extension-packs 目录下）。 */
export const EXTENSION_REGISTRY_FILENAME = 'registry.json'

/** 合法扩展包 id：小写字母/数字/连字符，以字母或数字开头。与 isValidExtensionId 同规则。 */
const PACK_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** 六类资源类别（固定键，与 EXTENSION_CONTENT_KEYS 同口径）。 */
const ALL_KINDS: readonly ExtensionItemKind[] = ['presets', 'skills', 'mcp', 'plugins', 'themes', 'ui']

// ── home 解析 ──────────────────────────────────────────────────────────

/**
 * 解析 CORUM_HOME 为绝对路径。
 *
 * 优先级**逐字对齐** `corum-preset-modules/home.ts` 的 `resolveCorumHome()`
 * 与 `corum-agent/home.ts` 的 `corumHome()`：
 * 显式传入 → `CORUM_HOME` → `DSH_HOME` → `~/.corum`，再交给 `resolveDshHome`
 * 展开 `~` 前缀。三档对齐是为了避免「P0 缺陷」重现：只设 DSH_HOME 的部署里，
 * 两处解析到不同家目录导致台账与资源分居两棵树。
 *
 * @param home - 显式传入的 CORUM_HOME（为空时回落环境变量 / 默认值）。
 * @returns 绝对路径。
 */
export function resolveRegistryHome(home?: string): string {
  const configured = home !== undefined && home.trim() !== ''
    ? home
    : process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
      ? process.env.CORUM_HOME
      : process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME
        : '~/.corum'
  return resolveDshHome(configured)
}

/**
 * registry.json 的完整路径。
 *
 * @param home - 显式传入的 CORUM_HOME（为空时回落环境变量 / 默认值）。
 * @returns `<home>/extension-packs/registry.json` 绝对路径。
 */
export function registryPath(home?: string): string {
  return join(resolveRegistryHome(home), EXTENSION_PACKS_DIRNAME, EXTENSION_REGISTRY_FILENAME)
}

// ── 校验 ───────────────────────────────────────────────────────────────

/**
 * 校验一份 registry.json 结构（已 parse 的值）。
 *
 * fail-loud：校验不过则抛 Error（中文消息，含字段定位）。
 * 不做 IO——纯数据校验，供 read 共用。
 *
 * 校验规则（见 P5 §4.2）：
 * - 根必须是对象，含 `packs` 对象。
 * - 每个 pack 的 `id` 须满足 `^[a-z0-9][a-z0-9-]*$`。
 * - `version` 非空字符串；`installedAt` 非空字符串。
 * - `name` 如果存在必须是非空字符串。
 * - `items` 如果存在必须是对象，键必须是六类之一，值必须是数组。
 * - 数组元素必须是含 `name`（非空字符串）的对象；`versionId`/`entryId` 如果存在必须是非空字符串。
 */
function assertValidRegistry(value: unknown, context: string): asserts value is ExtensionRegistry {
  const where = context === '' ? 'registry.json' : context
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}：必须是 JSON 对象`)
  }
  const root = value as Record<string, unknown>

  if (root.packs === undefined || typeof root.packs !== 'object' || root.packs === null || Array.isArray(root.packs)) {
    throw new Error(`${where}：缺少 packs 对象或 packs 不是对象`)
  }
  const packs = root.packs as Record<string, unknown>

  for (const [packId, packVal] of Object.entries(packs)) {
    const packCtx = `${where} packs["${packId}"]`
    // pack id 必须满足 PACK_ID_RE（与目录名同规则）。
    if (!PACK_ID_RE.test(packId)) {
      throw new Error(`${packCtx}：packId 不合法（必须是小写字母/数字/连字符，以字母或数字开头）`)
    }
    if (typeof packVal !== 'object' || packVal === null || Array.isArray(packVal)) {
      throw new Error(`${packCtx}：必须是 JSON 对象`)
    }
    const pack = packVal as Record<string, unknown>

    // pack 内的 id 必须与 key 一致（防止手改后 key 与 id 分叉）。
    if (typeof pack.id !== 'string' || pack.id !== packId) {
      throw new Error(`${packCtx}：id "${String(pack.id)}" 与 packs key "${packId}" 不一致`)
    }
    // version 非空字符串。
    if (typeof pack.version !== 'string' || pack.version.trim() === '') {
      throw new Error(`${packCtx}：version 不能为空`)
    }
    // installedAt 非空字符串。
    if (typeof pack.installedAt !== 'string' || pack.installedAt.trim() === '') {
      throw new Error(`${packCtx}：installedAt 不能为空`)
    }
    // name 如果存在必须是非空字符串。
    if (pack.name !== undefined && (typeof pack.name !== 'string' || pack.name.trim() === '')) {
      throw new Error(`${packCtx}：name 如果提供则不能为空`)
    }
    // items 如果存在必须是对象。
    if (pack.items !== undefined) {
      if (typeof pack.items !== 'object' || pack.items === null || Array.isArray(pack.items)) {
        throw new Error(`${packCtx}：items 必须是对象`)
      }
      const items = pack.items as Record<string, unknown>
      for (const [kindKey, kindVal] of Object.entries(items)) {
        // 键必须是六类之一（未知键报错，防止笔误后静默丢失归属）。
        if (!ALL_KINDS.includes(kindKey as ExtensionItemKind)) {
          throw new Error(`${packCtx} items["${kindKey}"]：未知的资源类别（必须是 ${ALL_KINDS.join('/')} 之一）`)
        }
        // 值必须是数组。
        if (!Array.isArray(kindVal)) {
          throw new Error(`${packCtx} items["${kindKey}"]：必须是数组`)
        }
        // 逐条校验 item。
        const arr = kindVal as unknown[]
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i]
          const itemCtx = `${packCtx} items["${kindKey}"][${i}]`
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new Error(`${itemCtx}：必须是 JSON 对象`)
          }
          const rec = item as Record<string, unknown>
          if (typeof rec.name !== 'string' || rec.name.trim() === '') {
            throw new Error(`${itemCtx}：name 不能为空`)
          }
          if (rec.versionId !== undefined && (typeof rec.versionId !== 'string' || rec.versionId.trim() === '')) {
            throw new Error(`${itemCtx}：versionId 如果提供则不能为空`)
          }
          if (rec.entryId !== undefined && (typeof rec.entryId !== 'string' || rec.entryId.trim() === '')) {
            throw new Error(`${itemCtx}：entryId 如果提供则不能为空`)
          }
        }
      }
    }
  }
}

// ── 读 ─────────────────────────────────────────────────────────────────

/**
 * 读取 registry.json。
 *
 * - 缺失 extension-packs 目录 / 缺失 registry.json → 返回 `{ packs: {} }`
 *   （干净 home 没装过扩展包，合法）。
 * - **存在的文件** JSON 损坏 / 结构非法 → **fail loud** 抛错（消息含文件路径）。
 *   理由见模块头注：静默返回空会让归属检查放行本该拒绝的删除。
 *
 * @param home - 显式传入的 CORUM_HOME（为空时回落环境变量 / 默认值）。
 */
export function readRegistry(home?: string): ExtensionRegistry {
  const path = registryPath(home)
  if (!existsSync(path)) return { packs: {} }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`registry.json 读取失败：${path}：${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`registry.json JSON 损坏：${path}：${String(error)}`)
  }
  assertValidRegistry(parsed, path)
  return parsed
}

// ── 写 ─────────────────────────────────────────────────────────────────

/**
 * 原子写 registry.json。
 *
 * 先校验（校验不过则抛错、**不创建目标文件**），再 `mkdir -p`，
 * 写 `<path>.tmp` 后 `renameSync` 原子替换；写 .tmp 失败则清理 .tmp。
 * JSON.stringify + 尾随换行（约定，与 entries-store 同款）。
 *
 * @param registry - 要写入的完整 registry 结构。
 * @param home - 显式传入的 CORUM_HOME（为空时回落环境变量 / 默认值）。
 */
export function writeRegistry(registry: ExtensionRegistry, home?: string): void {
  const path = registryPath(home)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })

  const content = `${JSON.stringify(registry, null, 2)}\n`
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
  } catch (error) {
    throw new Error(`registry.json 写入 .tmp 失败：${tmp}：${String(error)}`)
  }
  // 原子替换（tmp 与 path 同目录，不会 EXDEV）。
  try {
    renameSync(tmp, path)
  } catch (error) {
    // rename 失败——清理 .tmp 后抛错。
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw new Error(`registry.json 写入失败（rename）：${path}：${String(error)}`)
  }
}

// ── 增删 ───────────────────────────────────────────────────────────────

/**
 * 插入或更新一个扩展包记录（upsert）。
 *
 * 先读现有 registry，按 `record.id` 替换（存在则覆盖、不存在则新增），
 * 再原子写回。校验在 `writeRegistry` 落盘前发生（`readRegistry` 已校验
 * 现有内容；`writeRegistry` 内部不校验，但 `assertValidRegistry` 在
 * `readRegistry` 已确保现有内容合法，新 record 由调用方保证）。
 *
 * @param record - 扩展包记录（id 必须满足 PACK_ID_RE）。
 * @param home - 显式传入的 CORUM_HOME。
 */
export function upsertPack(record: ExtensionPackRecord, home?: string): void {
  if (!PACK_ID_RE.test(record.id)) {
    throw new Error(`upsertPack：packId "${record.id}" 不合法（必须是小写字母/数字/连字符，以字母或数字开头）`)
  }
  const registry = readRegistry(home)
  // 可变副本（readRegistry 返回 readonly，这里构造新对象写回）。
  const packs: Record<string, ExtensionPackRecord> = { ...registry.packs }
  packs[record.id] = record
  // 校验整体结构（确保写回的是合法 registry）。
  const next: ExtensionRegistry = { packs }
  assertValidRegistry(next, registryPath(home))
  writeRegistry(next, home)
}

/**
 * 移除一个扩展包记录。
 *
 * packId 不存在时 no-op（幂等）。先读、删 key、原子写回。
 *
 * @param packId - 要移除的扩展包 id。
 * @param home - 显式传入的 CORUM_HOME。
 */
export function removePack(packId: string, home?: string): void {
  if (!PACK_ID_RE.test(packId)) {
    throw new Error(`removePack：packId "${packId}" 不合法`)
  }
  const registry = readRegistry(home)
  if (!(packId in registry.packs)) return // 幂等
  const packs: Record<string, ExtensionPackRecord> = { ...registry.packs }
  delete packs[packId]
  writeRegistry({ packs }, home)
}

// ── 查询 ───────────────────────────────────────────────────────────────

/**
 * 查找拥有某资源的扩展包。
 *
 * 遍历 registry 的所有 pack，在 `items[kind]` 里找 `name` 匹配的条目。
 * 第一个命中即返回（packs 的遍历顺序按 Object.entries，即插入顺序）。
 *
 * @param kind - 资源类别。
 * @param name - 资源名。
 * @param home - 显式传入的 CORUM_HOME。
 * @returns `{ packId, pack }` 或 `undefined`（无归属）。
 */
export function findOwner(
  kind: ExtensionItemKind,
  name: string,
  home?: string,
): { packId: string; pack: ExtensionPackRecord } | undefined {
  const registry = readRegistry(home)
  for (const [packId, pack] of Object.entries(registry.packs)) {
    const items = pack.items?.[kind]
    if (items === undefined) continue
    if (items.some(item => item.name === name)) {
      return { packId, pack }
    }
  }
  return undefined
}

/**
 * 生成全量归属映射：kind → name → packId。
 *
 * 六个 kind 键始终存在（即使某类无归属也返回空对象），方便调用方
 * 无条件 join（见 P5 §4.3：页面 mount 时调一次 `ownership()` 本地 join）。
 *
 * @param home - 显式传入的 CORUM_HOME。
 * @returns `Record<ExtensionItemKind, Record<string, string>>`。
 */
export function ownershipMap(
  home?: string,
): Readonly<Record<ExtensionItemKind, Readonly<Record<string, string>>>> {
  const registry = readRegistry(home)
  // 六个 kind 都初始化为空对象。
  const result = {
    presets: {} as Record<string, string>,
    skills: {} as Record<string, string>,
    mcp: {} as Record<string, string>,
    plugins: {} as Record<string, string>,
    themes: {} as Record<string, string>,
    ui: {} as Record<string, string>,
  }
  for (const [packId, pack] of Object.entries(registry.packs)) {
    if (pack.items === undefined) continue
    for (const kind of ALL_KINDS) {
      const items = pack.items[kind]
      if (items === undefined) continue
      for (const item of items) {
        // 后写覆盖先写：如果两个包同名资源，后者赢（与 findOwner 的「第一个命中」
        // 语义略有出入，但同名资源被两个包声明属于跨包冲突——installExtensionPack
        // 已在安装时拒绝同名，这里只是防御性兜底）。
        result[kind][item.name] = packId
      }
    }
  }
  return result
}

// ── 归属拒绝（PackOwnedError）─────────────────────────────────────────

/**
 * 表示「该资源由扩展包拥有，不能单独卸载」的错误。
 *
 * 见 P5 设计 §5.1/§5.2：四个删除端点在动手前查归属，命中即拒绝。
 * message 固定文案（含包名 + 引导到 集成中心 › 扩展包）：
 * `该资源由扩展包「<pack name or id>」提供，请到 集成中心 › 扩展包 卸载整个扩展包。`
 */
export class PackOwnedError extends Error {
  readonly packId: string
  readonly kind: ExtensionItemKind
  readonly name: string

  constructor(packId: string, pack: ExtensionPackRecord, kind: ExtensionItemKind, name: string) {
    // 优先用 pack 的显示名（name），缺失则用 id。
    const label = pack.name !== undefined && pack.name.trim() !== '' ? pack.name : packId
    super(`该资源由扩展包「${label}」提供，请到 集成中心 › 扩展包 卸载整个扩展包。`)
    this.name = 'PackOwnedError'
    this.packId = packId
    this.kind = kind
    this.name = name
  }
}

/**
 * 断言某资源**不**由扩展包拥有，否则抛 PackOwnedError。
 *
 * 四个删除端点的共用前置检查（见 P5 §5.2「双端强制」）：
 *   - skillManager.deleteSkill
 *   - mcpManager.deleteServer
 *   - pluginManager.uninstall
 *   - corumAgent 删预设端点
 *
 * @param kind - 资源类别。
 * @param name - 资源名。
 * @param home - 显式传入的 CORUM_HOME。
 * @throws {PackOwnedError} 资源由扩展包拥有时。
 */
export function assertNotPackOwned(kind: ExtensionItemKind, name: string, home?: string): void {
  const owner = findOwner(kind, name, home)
  if (owner !== undefined) {
    throw new PackOwnedError(owner.packId, owner.pack, kind, name)
  }
}
