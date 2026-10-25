/**
 * shipped-skills — 随包分发的「内置技能集」：路径解析、导入策略、落盘。
 *
 * ## 为什么存在
 *
 * 官方技能集此前只活在本机 dev home 的托管库（`packages/desktop/.corum-dev-home/skills/`，
 * 该目录被 .gitignore 忽略）——换机器或装打包版就没有。本模块把它变成随产品分发的能力：
 * 技能实体在 `packages/desktop/shipped-skills/<skill-name>/**`（与 `shipped-presets/`
 * 同款），用户在「设置 → 技能」点「导入内置技能」时才写进 `<CORUM_HOME>/skills/`。
 *
 * **不在应用启动期写用户 home**：启动期写入既会和用户既有技能抢占目录、又难以回滚
 * （用户改了哪份、我们覆盖了哪份，事后分不清）。导入是显式动作，且必须是幂等 + 不破坏的。
 *
 * ## 版本/更新策略（三条互斥规则）
 *
 * 1. 目标目录已有同名技能 → 一律**不覆盖**（用户可能改过），计入 `skipped`。
 * 2. 该名字被 tombstone 记过（用户删过这个内置技能）→ **不复活**，计入 `tombstoned`。
 *    tombstone 优先于 skipped 判定：两者同时成立时（用户删掉后又手动导入回来），
 *    「你拒收过它」是更准确的信息，报 skipped 会让人误以为是我们装的。
 * 3. 其余 → 安装，计入 `installed`。
 *
 * 判定核心是纯函数 {@link planShippedImport}（无 fs，可脱离磁盘测），
 * {@link importShippedSkills} 只负责把计划落到磁盘。
 *
 * ## 可独立执行
 *
 * 本模块只依赖 node 内置模块，编译产物 `lib/types/shipped-skills.js` 可被
 * `scripts/check-shipped-skills.mjs` 直接 import，用临时目录夹具断言三种情形
 * （该包本机没有本地 vitest，见脚本头部说明）。
 *
 * @module @corum/corum-skill-manager/shipped-skills
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseSkillFrontmatter, isValidSkillName } from './skill-format.ts'

/** 覆盖随包技能目录的环境变量（自检脚本与自定义打包用；未设时按布局探测）。 */
export const SHIPPED_SKILLS_ENV = 'CORUM_SHIPPED_SKILLS_DIR'

/** tombstone 文件名（位于 `<CORUM_HOME>/` 下，不在 skills/ 内——不给官方 skill 加载器制造意外条目）。 */
export const TOMBSTONE_FILE_NAME = 'skills.tombstones.json'

/**
 * 探测随包技能目录。
 *
 * 两种布局的锚点深度不同，所以按「自模块目录逐级上溯」探测，而不是写死相对跳数：
 *   - 打包态：`<runtime>/node_modules/@corum/corum-skill-manager/lib/index.js`
 *     → 上溯到 `<runtime>/` 命中 `<runtime>/shipped-skills/`（pack-macos 与
 *       shipped-presets 同款 staging）。
 *   - 源码态：`packages/plugins/agent/corum-skill-manager/lib/index.js`
 *     → 上溯到 `packages/` 命中 `packages/desktop/shipped-skills/`。
 *
 * `CORUM_SHIPPED_SKILLS_DIR` 存在时直接采信（不做存在性校验，让调用方拿到明确的
 * 「配错了」而不是静默回退到别的目录）。
 *
 * @returns 随包技能目录绝对路径；两种布局都没命中时 undefined。
 */
export function resolveShippedSkillsRoot(): string | undefined {
  const override = process.env[SHIPPED_SKILLS_ENV]
  if (override !== undefined && override.trim() !== '') return override

  const markers = ['shipped-skills', join('desktop', 'shipped-skills')]
  let dir = import.meta.dirname
  for (let depth = 0; depth < 8; depth += 1) {
    for (const marker of markers) {
      const candidate = join(dir, marker)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 随包目录里识别到的一个内置技能。 */
export interface ShippedSkill {
  /** 技能名（= 随包目录名 = 安装后的 `<CORUM_HOME>/skills/<name>` 目录名）。 */
  name: string
  /** 随包目录里的绝对路径。 */
  sourcePath: string
  /** 技能描述（取自 SKILL.md frontmatter）。 */
  description: string
}

/**
 * 扫描随包技能目录：认「一层子目录 + 其中含带合法 frontmatter 的 SKILL.md」，
 * 目录根下的散文件（如 PROVENANCE.md）自然被忽略。
 *
 * **两处并集**（2026-10-11 corum-dev 模块化后）：随包技能既可能落在
 * `<shippedRoot>/<name>/`（经典 shipped-skills 布局），也可能落在
 * `<shippedRoot>/../shipped-modules/<module>/skills/<name>/`（随预设模块走的布局）。
 * 这里把两处都扫到并取**名字去重并集**——同一个技能名在两处都出现时，
 * 以先扫到的为准（经典布局优先，保持与既有「随包目录里只有一份」语义对齐的遮蔽规则）。
 *
 * 保留模块布局扫描以兼容历史上的随预设模块分发；当前经典目录只收录
 * 通用开发技能。Corum/dsh 项目专属技能由 `corum-dev-preset` 扩展包维护，
 * 不再随应用内置。
 *
 * @param root - 随包技能目录（{@link resolveShippedSkillsRoot} 的结果）。
 * @returns 按名字升序去重后的技能列表；目录不存在或不可读时返回空数组。
 */
export function scanShippedSkills(root: string): ShippedSkill[] {
  const seen = new Set<string>()
  const skills: ShippedSkill[] = []
  // 先扫经典布局（root 直接子目录），后扫模块布局；同名以先扫到的为准。
  collectSkillsInDir(root, skills, seen)
  collectSkillsInShippedModules(root, skills, seen)
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 扫描单个目录的直接子技能（一层子目录 + 含合法 frontmatter 的 SKILL.md）。
 * 写入传入的 `out` 与 `seen`；已在 `seen` 里的名字跳过（遮蔽：先到者为准）。
 *
 * @param dir - 随包技能目录。
 * @param out - 累积结果列表。
 * @param seen - 已收集的名字集合（去重 + 遮蔽用）。
 */
function collectSkillsInDir(dir: string, out: ShippedSkill[], seen: Set<string>): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!isValidSkillName(entry)) continue
    if (seen.has(entry)) continue
    const skillDir = join(dir, entry)
    const skillMdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    let parsed: ReturnType<typeof parseSkillFrontmatter>
    try {
      parsed = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf8'))
    } catch {
      parsed = undefined
    }
    if (parsed === undefined) continue
    seen.add(entry)
    out.push({ name: entry, sourcePath: skillDir, description: parsed.description })
  }
}

/**
 * 扫描随包模块目录下的技能：`<root>/../shipped-modules/<module>/skills/<name>/`。
 *
 * 模块布局比经典布局多两层（模块名 + skills/），这里**逐模块**枚举再进 skills/，
 * 而不是写死 `corum-dev`——将来加新模块时这里无需改动，只要新模块按
 * `<module>/skills/<name>/` 布局放技能就会自动被发现。
 *
 * @param root - 随包技能目录（经典布局的根；用于推算兄弟的 shipped-modules/）。
 * @param out - 累积结果列表。
 * @param seen - 已收集的名字集合（去重 + 遮蔽用）。
 */
function collectSkillsInShippedModules(root: string, out: ShippedSkill[], seen: Set<string>): void {
  const modulesRoot = join(root, '..', 'shipped-modules')
  let modules: string[]
  try {
    modules = readdirSync(modulesRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && isValidSkillName(d.name))
      .map(d => d.name)
  } catch {
    return
  }
  for (const moduleName of modules) {
    const skillsDir = join(modulesRoot, moduleName, 'skills')
    collectSkillsInDir(skillsDir, out, seen)
  }
}

/** 导入策略的判定结果：三组互相排斥的技能名。 */
export interface ShippedImportPlan {
  /** 首次导入，需要落盘安装。 */
  installed: string[]
  /** 目标已有同名技能，不覆盖。 */
  skipped: string[]
  /** 用户删除过，不复活。 */
  tombstoned: string[]
}

/** {@link planShippedImport} 的输入：三份名字集合（全部由调用方从磁盘读出）。 */
export interface ShippedImportInput {
  /** 随包目录里可安装的技能名。 */
  available: readonly string[]
  /** `<CORUM_HOME>/skills/` 下已存在的技能名。 */
  existing: readonly string[]
  /** 被 tombstone 记过的技能名。 */
  tombstoned: readonly string[]
}

/**
 * 导入策略的**纯判定核心**：给定三份名字集合，算出谁装、谁跳过、谁不复活。
 * 不碰文件系统、不看时钟——同样的输入永远得到同样的输出。
 *
 * @param input - 可安装 / 已存在 / 已 tombstone 三份名字集合。
 * @returns 按 `available` 的给定顺序分桶的结果（同名字不会出现在两个桶里）。
 */
export function planShippedImport(input: ShippedImportInput): ShippedImportPlan {
  const existing = new Set(input.existing)
  const tombstoned = new Set(input.tombstoned)
  const plan: ShippedImportPlan = { installed: [], skipped: [], tombstoned: [] }
  const seen = new Set<string>()
  for (const name of input.available) {
    if (seen.has(name)) continue
    seen.add(name)
    if (tombstoned.has(name)) plan.tombstoned.push(name)
    else if (existing.has(name)) plan.skipped.push(name)
    else plan.installed.push(name)
  }
  return plan
}

/** tombstone 台账里的一条记录。 */
export interface SkillTombstone {
  /** 被用户删除的技能名。 */
  name: string
  /** 删除时间（ISO 字符串，仅供排查，不参与判定）。 */
  deletedAt: string
}

/** tombstone 台账文件结构。 */
export interface SkillTombstoneFile {
  /** 台账结构版本（后续加字段时用于迁移）。 */
  version: number
  /** 已记录的用户删除。 */
  tombstones: SkillTombstone[]
}

/** 台账结构版本。 */
const TOMBSTONE_VERSION = 1

/**
 * 读取 tombstone 台账。
 * 文件缺失、JSON 坏掉、结构不符时一律返回空列表——台账是「优化信息」而非正确性前提，
 * 读不出来最多退化成「可能会复活一个被删的技能」，不该让导入整体失败。
 *
 * @param file - 台账文件绝对路径。
 * @returns 已记录的被删技能名（升序去重）。
 */
export function readTombstones(file: string): string[] {
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const list = (parsed as { tombstones?: unknown }).tombstones
  if (!Array.isArray(list)) return []
  const names = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const name = (item as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') names.add(name)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * 记录一条 tombstone（幂等：同名重复删除只更新时间）。
 *
 * @param file - 台账文件绝对路径（父目录自动创建）。
 * @param name - 被删除的技能名。
 * @param deletedAt - 删除时间；缺省取当前时间。
 */
export function writeTombstone(file: string, name: string, deletedAt?: string): void {
  const existing = readTombstoneFile(file)
  const rest = existing.tombstones.filter(t => t.name !== name)
  rest.push({ name, deletedAt: deletedAt ?? new Date().toISOString() })
  rest.sort((a, b) => a.name.localeCompare(b.name))
  mkdirSync(dirname(file), { recursive: true })
  const next: SkillTombstoneFile = { version: TOMBSTONE_VERSION, tombstones: rest }
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

/**
 * 撤销一条 tombstone（显式导入同名技能时调用：用户主动要回来 = 撤回拒收）。
 *
 * @param file - 台账文件绝对路径。
 * @param name - 要撤销的技能名。
 * @returns 确实撤销掉了一条时 true。
 */
export function clearTombstone(file: string, name: string): boolean {
  const current = readTombstoneFile(file)
  const rest = current.tombstones.filter(t => t.name !== name)
  if (rest.length === current.tombstones.length) return false
  const next: SkillTombstoneFile = { version: TOMBSTONE_VERSION, tombstones: rest }
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return true
}

/** 读台账原始结构（写路径用；读路径统一走 {@link readTombstones} 的容错）。 */
function readTombstoneFile(file: string): SkillTombstoneFile {
  if (!existsSync(file)) return { version: TOMBSTONE_VERSION, tombstones: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SkillTombstoneFile>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : TOMBSTONE_VERSION,
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones.filter(isTombstone) : [],
    }
  } catch {
    return { version: TOMBSTONE_VERSION, tombstones: [] }
  }
}

function isTombstone(value: unknown): value is SkillTombstone {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { name?: unknown; deletedAt?: unknown }
  return typeof record.name === 'string' && record.name !== '' && typeof record.deletedAt === 'string'
}

/**
 * 导入随包技能集的结构化摘要。
 * 三个数组恒存在（即使 ok=false 也是空数组），UI 可以无条件渲染。
 */
export interface BuiltinSkillImportResult {
  /** 本次导入是否正常跑完（false 时看 error，三个数组仍可读）。 */
  ok: boolean
  /** 失败原因（随包目录缺失 / 读取失败）。 */
  error?: string
  /** 本次解析到的随包技能目录绝对路径（排查用）。 */
  shippedRoot?: string
  /** 本次新装上的技能名。 */
  installed: string[]
  /** 因同名已存在而原样保留的技能名。 */
  skipped: string[]
  /** 因用户删除过而不复活的技能名。 */
  tombstoned: string[]
}

/** {@link importShippedSkills} 的入参。 */
export interface ImportShippedSkillsOptions {
  /** 随包技能目录（{@link resolveShippedSkillsRoot} 的结果或显式路径）。 */
  shippedRoot: string
  /** 目标技能库 `<CORUM_HOME>/skills/`。 */
  skillsRoot: string
  /** tombstone 台账文件绝对路径。 */
  tombstoneFile: string
}

/**
 * 把随包技能集导入技能库：扫描 → 判定（{@link planShippedImport}）→ 只复制 `installed`。
 *
 * 复制时逐目录 `cpSync(recursive)`，覆盖的是「目标不存在」的新目录，所以不存在
 * 半覆盖写入；单个技能复制失败会被记进 `error` 并中止（已复制的保留，
 * 下次导入按 skipped 处理，天然幂等）。
 *
 * 调用方（SkillManagerService）在返回后对 `installed` 逐个补版本快照，
 * 让内置技能和手动导入的技能在「版本历史」面前形态一致。
 *
 * @param options - 随包目录 + 目标技能库 + 台账路径。
 * @returns 结构化摘要（installed / skipped / tombstoned）。
 */
export function importShippedSkills(options: ImportShippedSkillsOptions): BuiltinSkillImportResult {
  const { shippedRoot, skillsRoot, tombstoneFile } = options
  const base: BuiltinSkillImportResult = { ok: true, shippedRoot, installed: [], skipped: [], tombstoned: [] }
  if (!existsSync(shippedRoot)) {
    return { ...base, ok: false, error: `内置技能目录不存在：${shippedRoot}` }
  }

  const available = scanShippedSkills(shippedRoot)
  const existing = existsSync(skillsRoot) ? listSkillDirs(skillsRoot) : []
  const tombstoned = readTombstones(tombstoneFile)
  const plan = planShippedImport({
    available: available.map(s => s.name),
    existing,
    tombstoned,
  })

  const byName = new Map(available.map(s => [s.name, s]))
  mkdirSync(skillsRoot, { recursive: true })
  for (const name of plan.installed) {
    const source = byName.get(name)
    if (source === undefined) continue
    try {
      cpSync(source.sourcePath, join(skillsRoot, name), { recursive: true })
    } catch (error) {
      return {
        ...base,
        ok: false,
        error: `安装内置技能「${name}」失败：${error instanceof Error ? error.message : String(error)}`,
        installed: plan.installed.slice(0, plan.installed.indexOf(name)),
        skipped: plan.skipped,
        tombstoned: plan.tombstoned,
      }
    }
  }
  return { ...base, installed: plan.installed, skipped: plan.skipped, tombstoned: plan.tombstoned }
}

/** 列出技能库下的技能目录名（跳过隐藏项与非目录）。 */
function listSkillDirs(skillsRoot: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isValidSkillName(entry.name)) continue
    names.push(entry.name)
  }
  return names
}
