/**
 * 扩展包插件 insert 行持久层（P3a）。
 *
 * ## 这一层做什么
 *
 * 把每个扩展包要插入的 plugin 行持久化在
 * `<CORUM_HOME>/extension-packs/<packId>/entries.json`，boot 时扫描所有包的
 * entries.json、折成**至多一条** `{ insert: rows }` patch，叠进 boot 层栈。
 *
 * ## 为什么这样做（不改用户的 patch 文件）
 *
 * 见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2：
 * 用户的 `cordis.patch.yml` 只读——扩展包机制独占 `extension-packs/` 目录，
 * 产物只落在这里。这套范式照抄 corum 已验证的 `loadDisabledPatches()`：
 * 读一份 JSON 清单、在 boot 时折成 patch 行、作为最高层叠加。
 *
 * ## 为什么必须 fail loud（不静默跳过）
 *
 * 见 section 5.2.1.1：`entries.json` 坏掉（手改错）必须 **fail loud** 而不是
 * 静默跳过——与官方 `loadOptionalPatches` 的口径一致（"a present patch file
 * that cannot apply is a misconfiguration and must fail loud at boot"）。
 * `loadDisabledPatches` 现在 `catch { return [] }` 静默返回空是它的历史包袱；
 * 扩展包这份**故意不照抄这一点**——脏数据让 boot 直接失败比静默丢失插件行更可诊断。
 *
 * @module @corum/corum-extension-pack/entries-store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { isValidExtensionId } from './extension-format.ts'

// ── 常量与类型 ──────────────────────────────────────────────────────────

/** entry id 前缀：`ext:<packId>:<pluginName>`。 */
export const EXTENSION_ENTRY_ID_PREFIX = 'ext:'

/**
 * 一条插件 insert 行（entries.json 的 entries 数组元素）。
 *
 * - `id`：稳定标识，`ext:<packId>:<pluginName>`（幂等靠它）。
 * - `name`：插件包名（加载器按它解析 npm 包）。
 * - `config`：可选，传给插件 apply 的配置。
 * - `disabled`：可选，`true` 表示该行存在但先不跑（lazy 型）。
 * - `order`：可选，同层内排序键（小者靠前）。
 */
export interface ExtensionEntry {
  readonly id: string
  readonly name: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly disabled?: boolean
  readonly order?: number
}

/**
 * entries.json 的整体结构。
 *
 * @see corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2.1
 */
export interface ExtensionEntriesFile {
  readonly packId: string
  readonly version: string
  readonly entries: readonly ExtensionEntry[]
}

// ── 路径与 id 工具 ──────────────────────────────────────────────────────

/**
 * 构造 entry id：`ext:<packId>:<pluginName>`。
 *
 * 幂等靠它——重复导入同一包的同名插件覆盖同一行（见 section 5.2.1.1）。
 */
export function entryIdFor(packId: string, pluginName: string): string {
  return `${EXTENSION_ENTRY_ID_PREFIX}${packId}:${pluginName}`
}

/** 扩展包根目录：`<home>/extension-packs`。 */
export function extensionPacksDir(home: string): string {
  return join(home, 'extension-packs')
}

/** 单个扩展包的 entries.json 路径：`<home>/extension-packs/<packId>/entries.json`。 */
export function packEntriesPath(home: string, packId: string): string {
  return join(extensionPacksDir(home), packId, 'entries.json')
}

// ── 校验 ────────────────────────────────────────────────────────────────

/**
 * 校验一份 entries.json 结构（已 parse 的值）。
 *
 * fail-loud：校验不过则抛 Error（中文消息，含字段定位）。
 * 不做 IO——纯数据校验，供 read/write 共用。
 */
function assertValidEntriesFile(value: unknown, context: string): asserts value is ExtensionEntriesFile {
  const where = context === '' ? 'entries.json' : context
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}：必须是 JSON 对象`)
  }
  const m = value as Record<string, unknown>

  // packId 必须满足 isValidExtensionId（与扩展包 id 同规则）。
  if (typeof m.packId !== 'string' || !isValidExtensionId(m.packId)) {
    throw new Error(`${where}：packId "${String(m.packId)}" 不合法（必须是小写字母/数字/连字符，以字母或数字开头）`)
  }

  // version 非空字符串。
  if (typeof m.version !== 'string' || m.version.trim() === '') {
    throw new Error(`${where}：version 不能为空`)
  }

  // entries 必须是数组。
  if (!Array.isArray(m.entries)) {
    throw new Error(`${where}：entries 必须是数组`)
  }

  // 逐条校验 entry。
  const entries = m.entries as unknown[]
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const entryCtx = `${where} entries[${i}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${entryCtx}：必须是 JSON 对象`)
    }
    const e = entry as Record<string, unknown>

    // id 必须等于 entryIdFor(packId, name)。
    if (typeof e.id !== 'string') {
      throw new Error(`${entryCtx}：id 必须是字符串`)
    }
    if (typeof e.name !== 'string' || e.name.trim() === '') {
      throw new Error(`${entryCtx}：name 不能为空`)
    }
    const expectedId = entryIdFor(m.packId, e.name)
    if (e.id !== expectedId) {
      throw new Error(`${entryCtx}：id "${e.id}" 与 packId/name 不匹配（期望 "${expectedId}"）`)
    }

    // order 如果存在必须是有限数。
    if (e.order !== undefined) {
      if (typeof e.order !== 'number' || !Number.isFinite(e.order)) {
        throw new Error(`${entryCtx}：order 如果提供必须是有限数字`)
      }
    }

    // disabled 如果存在必须是布尔。
    if (e.disabled !== undefined) {
      if (typeof e.disabled !== 'boolean') {
        throw new Error(`${entryCtx}：disabled 如果提供必须是布尔值`)
      }
    }

    // config 如果存在必须是纯对象。
    if (e.config !== undefined) {
      if (typeof e.config !== 'object' || e.config === null || Array.isArray(e.config)) {
        throw new Error(`${entryCtx}：config 如果提供必须是纯对象`)
      }
    }
  }

  // 包内 entry id 不能重复（同名插件声明两次）。
  const seenIds = new Set<string>()
  for (const entry of m.entries as unknown[]) {
    const e = entry as Record<string, unknown>
    const id = e.id as string
    if (seenIds.has(id)) {
      throw new Error(`${where}：entry id "${id}" 在包内重复（同名的插件声明了两次）`)
    }
    seenIds.add(id)
  }
}

// ── 读写 ────────────────────────────────────────────────────────────────

/**
 * 读取一个扩展包的 entries.json。
 *
 * fail-loud：文件缺失 / JSON 损坏 / 校验不过 → 抛 Error（消息含文件路径 + 原因）。
 * **绝不修改文件**——只读。
 */
export function readPackEntries(home: string, packId: string): ExtensionEntriesFile {
  const path = packEntriesPath(home, packId)
  if (!existsSync(path)) {
    throw new Error(`entries.json 缺失：${path}`)
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`entries.json 读取失败：${path}：${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`entries.json JSON 损坏：${path}：${String(error)}`)
  }
  assertValidEntriesFile(parsed, path)
  // 文件内的 packId 必须与目录名一致（与 writePackEntries 对称）：不一致说明文件被
  // 手改过或放错了目录，按 fail-loud 处理——否则 entry id 前缀、跨包去重、归属台账
  // 三处会各按不同来源判定「这是哪个包」。
  const file = parsed as ExtensionEntriesFile
  if (file.packId !== packId) {
    throw new Error(`entries.json 的 packId "${file.packId}" 与目录名 "${packId}" 不一致：${path}`)
  }
  return file
}

/**
 * 写入一个扩展包的 entries.json（原子写）。
 *
 * 先校验（校验不过则抛错、**不创建目标文件**），再 `mkdir -p`，
 * 写 `<path>.tmp` 后 `renameSync` 原子替换；写 .tmp 失败则清理 .tmp。
 */
export function writePackEntries(home: string, packId: string, file: ExtensionEntriesFile): void {
  // 先校验——校验不过绝不碰磁盘。
  assertValidEntriesFile(file, `entries.json (packId=${packId})`)

  // packId 还得再验一次（assertValidEntriesFile 验的是 file.packId，这里验的是参数）。
  if (!isValidExtensionId(packId)) {
    throw new Error(`packId "${packId}" 不合法（必须是小写字母/数字/连字符，以字母或数字开头）`)
  }
  // file.packId 必须与参数一致。
  if (file.packId !== packId) {
    throw new Error(`entries.json 的 packId "${file.packId}" 与参数 "${packId}" 不一致`)
  }

  const path = packEntriesPath(home, packId)
  const dir = join(extensionPacksDir(home), packId)
  mkdirSync(dir, { recursive: true })

  const tmp = `${path}.tmp`
  // JSON.stringify + 尾随换行（约定）。
  const content = `${JSON.stringify(file, null, 2)}\n`
  try {
    writeFileSync(tmp, content, 'utf8')
  } catch (error) {
    throw new Error(`entries.json 写入 .tmp 失败：${tmp}：${String(error)}`)
  }
  // 原子替换（tmp 与 path 同目录，不会 EXDEV）。
  try {
    renameSync(tmp, path)
  } catch (error) {
    // rename 失败——清理 .tmp 后抛错。
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw new Error(`entries.json 写入失败（rename）：${path}：${String(error)}`)
  }
}

// ── 扫描 ────────────────────────────────────────────────────────────────

/**
 * 列出 home 下所有已安装的扩展包 id（子目录且含 entries.json，排序）。
 *
 * 缺失 extension-packs 目录 → 返回 `[]`（不是错——一个干净 home 没装过扩展包）。
 */
export function listExtensionPackIds(home: string): readonly string[] {
  const dir = extensionPacksDir(home)
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of names) {
    // 只认合法扩展包 id 的目录：`extension-packs/` 里可能有手建的临时目录/备份目录，
    // 它们的 entries.json 不该参与 boot 折行（名字本身还会成为 entry id 前缀）。
    if (!isValidExtensionId(name)) continue
    if (existsSync(join(dir, name, 'entries.json'))) {
      ids.push(name)
    }
  }
  ids.sort()
  return ids
}

/**
 * 加载 home 下所有扩展包的 entries.json。
 *
 * - 缺失 extension-packs 目录 → `[]`（干净 home，合法）。
 * - **任何一个** entries.json 损坏/校验不过 → **抛错**（fail loud，故意不像
 *   `loadDisabledPatches` 那样 `catch { return [] }`）。
 * - 跨包**同名插件包**（不同 packId 的 entry.name 相同）→ 抛错（命名两个 pack id）。
 *   理由：加载器会挂载同一个包两次，cordis 会以 `service-already-registered` 失败。
 *   （跨包重复 entry id 不可能：id 含 packId，且 readPackEntries 已强制文件 packId =
 *   目录名、每条 id = entryIdFor(packId, name)。）
 *
 * 返回值按 packId 排序（确定性）。
 */
export function loadExtensionEntries(home: string): readonly ExtensionEntriesFile[] {
  const ids = listExtensionPackIds(home)
  const files: ExtensionEntriesFile[] = []
  for (const id of ids) {
    // readPackEntries 自身 fail-loud（缺文件/坏 JSON/校验不过）。
    files.push(readPackEntries(home, id))
  }

  // 跨包一致性检查：**同名插件包**被不同包声明。这一条是真实风险——
  // 加载器会把同一个包挂两次，cordis 以 `service-already-registered` 失败。
  //
  // 跨包「重复 entry id」不需要单独查：id 由 `ext:<packId>:<name>` 构造，而
  // readPackEntries 已强制 `file.packId === 目录名` 且每条的 id === entryIdFor(packId, name)，
  // 所以不同包的 id 必然不同；同一个包内的重复由 assertValidEntriesFile 拦。
  const nameToDirs = new Map<string, string>() // plugin name → 第一个出现的 packId
  for (const f of files) {
    for (const entry of f.entries) {
      const nameDir = nameToDirs.get(entry.name)
      if (nameDir !== undefined && nameDir !== f.packId) {
        throw new Error(`插件包名 "${entry.name}" 被扩展包 ${nameDir} 与 ${f.packId} 同时声明（会导致 service-already-registered）`)
      }
      if (nameDir === undefined) nameToDirs.set(entry.name, f.packId)
    }
  }

  return files
}

// ── 折成 patch ──────────────────────────────────────────────────────────

/**
 * 把加载到的 entries.json 列表折成 boot 层栈用的 patch 列表。
 *
 * 返回**至多一条** `{ insert: rows }` patch：rows 按 (order asc, id asc) 排序，
 * 每条 row 为 `{ id, name, ...(config ? { config } : {}), ...(disabled ? { disabled: true } : {}) }`。
 *
 * 空输入 → `[]`（不插任何行）。
 *
 * 见 section 5.2.1：`insert` 是 append 语义、不按 id 去重，所以每条 entry 恰好
 * 产生一行、由 `loadExtensionEntries` 保证无重复。
 */
export function extensionPatches(files: readonly ExtensionEntriesFile[]): PatchOptions[] {
  if (files.length === 0) return []

  // 收集所有 entry，附上来源 packId（排序时 id 已含 packId，天然稳定）。
  const rows: ExtensionEntry[] = []
  for (const f of files) {
    for (const entry of f.entries) {
      rows.push(entry)
    }
  }
  if (rows.length === 0) return []

  // 排序：order asc（undefined 视为 +∞，排在最后），然后 id asc。
  rows.sort((a, b) => {
    const oa = a.order ?? Number.POSITIVE_INFINITY
    const ob = b.order ?? Number.POSITIVE_INFINITY
    if (oa !== ob) return oa - ob
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  // 折成 insert 行：只含有的字段才出现（exactOptionalPropertyTypes 友好）。
  const insert: EntryOptions[] = rows.map((entry): EntryOptions => {
    const row: EntryOptions = { id: entry.id, name: entry.name }
    if (entry.config !== undefined) row.config = entry.config
    if (entry.disabled === true) row.disabled = true
    return row
  })

  return [{ insert }]
}
