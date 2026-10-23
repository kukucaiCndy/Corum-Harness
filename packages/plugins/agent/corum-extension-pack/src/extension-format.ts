/**
 * 扩展包（Extension Pack）清单格式定义与校验（P1）。
 *
 * ## 为什么需要「扩展包」这一层
 *
 * 现状（P0 已落地）：`corum-preset-modules` 定义了「模块」——把一个 Agent 预设
 * （`agent.json` + skills + mcp + avatar）收进一个自洽目录，使「分享一个 Agent」
 * 成为一次原子操作。但用户需要的远不止分享一个 Agent：他们要分享的是**一整套
 * 能力组合**——多个预设、多个技能、MCP 配置、插件、主题、UI 槽位扩展等。
 *
 * 扩展包把这六类内容收进一个更大的容器，使「分享一套能力」成为一次原子操作。
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3。
 *
 * ## 设计要点（每条都有理由，改前先读）
 *
 * 1. **格式版本 `formatVersion = 1`**：与 `MODULE_FORMAT_VERSION` 对齐，将来改格式
 *    时用它做兼容判断。`validateExtension` 严格要求 `=== 1`（number 严格相等，
 *    不接受字符串 `"1"`——JSON 里 `1` 和 `"1"` 是不同的东西）。
 * 2. **`contents` 用六类固定键**：`presets / skills / mcp / plugins / themes / ui`。
 *    未知键报错（`未知的内容类型`）——防止用户笔误后静默丢失内容。
 * 3. **实体名安全检查 `isSafeEntityName`**：presets/skills/mcp/plugins/themes/ui
 *    的每个条目名都不允许路径穿越（`../`、`/`、`\`、`.`、`..`）。因为这些名字
 *    会成为安装时的目录名或文件名——`../evil` 逃逸安装根是 zip slip 的同类问题。
 * 4. **`avatar` 只校验安全性不要求文件存在**：因为 P1 是纯函数（零 IO），
 *    文件存在性检查属于 P2 的磁盘扫描职责。这里只确保它是**安全的相对路径**
 *    （不以 `/` 开头、不含 `..` 段、不含 `\`）。
 * 5. **`importSkill` / `assistantProfile`**：扩展包级可选字段，指向包内某个技能/
 *    预设实体名（须满足 `isSafeEntityName`）。`importSkill` 是扩展包安装后
 *    自动导入的主技能；`assistantProfile` 是关联的主预设。
 *
 * @module @corum/corum-extension-pack/extension-format
 */

/** 扩展包格式版本（将来改格式时用它做兼容判断）。 */
export const EXTENSION_FORMAT_VERSION = 1

/** 扩展包清单文件名（包根下一份）。 */
export const EXTENSION_MANIFEST_FILE = 'extension.json'

/** 模块清单文件名（与 corum-preset-modules 对齐，用于 classifyPack 判别）。 */
export const MODULE_MANIFEST_FILE = 'module.json'

/**
 * 扩展包内容清单的六类固定键。
 *
 * 每个键对应一个内容目录（包根下的子目录名），值是该目录下的实体名列表。
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3 的内容清单定义。
 */
export const EXTENSION_CONTENT_KEYS = ['presets', 'skills', 'mcp', 'plugins', 'themes', 'ui'] as const

/** 扩展包内容清单的键类型（六类之一）。 */
export type ExtensionContentKey = typeof EXTENSION_CONTENT_KEYS[number]

/**
 * 校验失败的原因（fail-loud，不用 undefined 表示）。
 *
 * 与 `ModuleValidationError` 同形状，使导入向导的错误渲染逻辑可复用。
 */
export interface ExtensionValidationError {
  readonly field: string
  readonly message: string
}

/**
 * 扩展包内容清单（`extension.json` 的 `contents` 字段）。
 *
 * 每个键是六类内容之一，值是该类下的实体名列表。缺失的键表示该类无内容——
 * 一个只带 skills 的扩展包可以只写 `{ "skills": ["my-skill"] }`。
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3。
 */
export interface ExtensionContents {
  readonly presets?: readonly string[]
  readonly skills?: readonly string[]
  readonly mcp?: readonly string[]
  readonly plugins?: readonly string[]
  readonly themes?: readonly string[]
  readonly ui?: readonly string[]
}

/**
 * 扩展包清单（`extension.json`）。
 *
 * @see corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3
 */
export interface ExtensionManifest {
  /** 格式版本（见 {@link EXTENSION_FORMAT_VERSION}）。 */
  readonly formatVersion: number
  /** 扩展包 id（须满足 {@link isValidExtensionId}）。 */
  readonly id: string
  /** 扩展包自身版本（如 `1.0.0`），供升级判断。 */
  readonly version: string
  /** 显示名。 */
  readonly name: string
  readonly description?: string
  readonly author?: string
  /** 头像相对路径（应指向 `assets/` 下，只校验安全性不要求文件存在——P1 零 IO）。 */
  readonly avatar?: string
  /** 内容清单（六类内容的实体名列表）。 */
  readonly contents: ExtensionContents
  /** 安装后自动导入的主技能实体名（须满足 {@link isSafeEntityName}）。 */
  readonly importSkill?: string
  /** 关联的主预设实体名（须满足 {@link isSafeEntityName}）。 */
  readonly assistantProfile?: string
}

/**
 * 合法扩展包 id：小写字母/数字/连字符，以字母或数字开头。
 *
 * 与 `isValidModuleId` / `isValidProfileId` 同规则——id 会成为安装后的目录名，
 * 必须是安全的文件系统名（不含 `/` `\` `..`，不以 `-` 开头避免与命令行选项混淆）。
 */
export function isValidExtensionId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/**
 * 判断一个字符串是否是安全的实体名（presets/skills/mcp/plugins/themes/ui 条目名）。
 *
 * 安全 = 非空、不以 `.` 开头、不含路径分隔符（`/` `\`）、不含控制字符、不以点/空格结尾、
 * 不是 Windows 保留设备名。这些名字会成为安装时的目录名或文件名：
 * `../evil` 会逃逸安装根（zip slip 同类问题），`CON`/`NUL` 在 Windows 上会落成设备而不是文件，
 * 尾点/尾空格会被 Windows 静默截断（两个不同名字落成同一个目录）。
 *
 * 注意：名字可以含 `-`、`_` 和中间的点（如 `my-cool-skill`、`v1.2-notes`）。
 */
export function isSafeEntityName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  // 不以 `.` 开头：`.` / `..` 是特殊目录，`.hidden` 会变成隐藏文件（便于藏改）。
  if (name.startsWith('.')) return false
  // 不含路径分隔符。
  if (name.includes('/') || name.includes('\\')) return false
  // 不含控制字符（含 NUL——C 字符串截断）。
  if (/[\u0000-\u001f\u007f]/.test(name)) return false
  // Windows 会去掉尾部的点与空格：`foo.` 与 `foo` 会落成同一个目录。
  if (name.endsWith('.') || name.endsWith(' ')) return false
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9；带扩展名的 `CON.txt` 同样保留）。
  const stem = name.split('.')[0]!.toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return false
  return true
}

/**
 * 判断一个路径是否是安全的相对路径（用于 avatar 字段）。
 *
 * 安全 = 非空、不以 `/` 开头（绝对路径）、不含 `\`（Windows 分隔符）、
 * 不含 `..` 段（路径穿越）。不要求文件存在——P1 零 IO。
 */
function isSafeRelativePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false
  // 不以 / 开头（绝对路径会逃逸安装根）。
  if (path.startsWith('/')) return false
  // 不含反斜杠（Windows 路径分隔符——统一用 / 后再校验）。
  if (path.includes('\\')) return false
  // 不含 `..` 段（路径穿越）。
  const segments = path.split('/')
  if (segments.some(seg => seg === '..')) return false
  return true
}

/**
 * 校验一份扩展包清单。
 *
 * @param value - 已 `JSON.parse` 的原始值。
 * @returns 错误列表（空数组 = 合法）。**不抛异常**：导入向导要一次性把所有问题
 *   展示给用户，而不是修一个报一个（与 `validateManifest` 同设计）。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3 的格式规范。
 */
export function validateExtension(value: unknown): ExtensionValidationError[] {
  const errors: ExtensionValidationError[] = []

  // 根必须是纯 JSON 对象。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '(root)', message: '扩展包清单必须是一个 JSON 对象' }]
  }

  const m = value as Record<string, unknown>

  // formatVersion 必须严格 === 1（number）。不接受字符串 "1"。
  if (m.formatVersion !== EXTENSION_FORMAT_VERSION) {
    errors.push({
      field: 'formatVersion',
      message: `不支持的格式版本 ${String(m.formatVersion)}（本机支持 ${EXTENSION_FORMAT_VERSION}）`,
    })
  }

  // id 必须满足 isValidExtensionId。
  if (typeof m.id !== 'string' || !isValidExtensionId(m.id)) {
    errors.push({ field: 'id', message: `id "${String(m.id)}" 不合法：必须是小写字母/数字/连字符，且以字母或数字开头` })
  }

  // version 非空字符串。
  if (typeof m.version !== 'string' || m.version.trim() === '') {
    errors.push({ field: 'version', message: 'version 不能为空' })
  }

  // name 非空字符串。
  if (typeof m.name !== 'string' || m.name.trim() === '') {
    errors.push({ field: 'name', message: 'name 不能为空' })
  }

  // description 如果存在必须是非空字符串。
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.trim() === '')) {
    errors.push({ field: 'description', message: 'description 如果提供则不能为空' })
  }

  // author 如果存在必须是非空字符串。
  if (m.author !== undefined && (typeof m.author !== 'string' || m.author.trim() === '')) {
    errors.push({ field: 'author', message: 'author 如果提供则不能为空' })
  }

  // avatar 如果存在必须是安全的相对路径（应指向 assets/ 下，但只校验安全性不要求文件存在）。
  if (m.avatar !== undefined) {
    if (typeof m.avatar !== 'string' || !isSafeRelativePath(m.avatar)) {
      errors.push({ field: 'avatar', message: `avatar "${String(m.avatar)}" 不是安全的相对路径（须非空、不以 / 开头、不含 .. 段和反斜杠）` })
    }
  }

  // assistantProfile 如果存在必须满足 isSafeEntityName。
  if (m.assistantProfile !== undefined) {
    if (typeof m.assistantProfile !== 'string' || !isSafeEntityName(m.assistantProfile)) {
      errors.push({ field: 'assistantProfile', message: `assistantProfile "${String(m.assistantProfile)}" 不是安全的实体名（不含 / \\ .. .）` })
    }
  }

  // importSkill 如果存在必须满足 isSafeEntityName。
  if (m.importSkill !== undefined) {
    if (typeof m.importSkill !== 'string' || !isSafeEntityName(m.importSkill)) {
      errors.push({ field: 'importSkill', message: `importSkill "${String(m.importSkill)}" 不是安全的实体名（不含 / \\ .. .）` })
    }
  }

  // contents 必须是对象。
  const contents = m.contents
  if (typeof contents !== 'object' || contents === null || Array.isArray(contents)) {
    errors.push({ field: 'contents', message: '缺少 contents 清单或不是对象' })
  } else {
    const c = contents as Record<string, unknown>
    const knownKeys = new Set<string>(EXTENSION_CONTENT_KEYS)

    // 未知键报错（防止笔误后静默丢失内容）。
    for (const key of Object.keys(c)) {
      if (!knownKeys.has(key)) {
        errors.push({ field: `contents.${key}`, message: '未知的内容类型' })
      }
    }

    // 已知键如果存在必须是字符串数组，每个条目须满足 isSafeEntityName，且无重复。
    for (const key of EXTENSION_CONTENT_KEYS) {
      const val = c[key]
      if (val === undefined) continue // 缺失的键 OK（该类无内容）。
      if (!Array.isArray(val)) {
        errors.push({ field: `contents.${key}`, message: `contents.${key} 必须是字符串数组` })
        continue
      }
      // 每个条目必须是字符串。
      const entries = val as unknown[]
      let hasNonString = false
      for (const entry of entries) {
        if (typeof entry !== 'string') {
          hasNonString = true
          break
        }
      }
      if (hasNonString) {
        errors.push({ field: `contents.${key}`, message: `contents.${key} 的每个条目必须是字符串` })
        continue
      }
      // 每个条目必须是安全实体名。
      for (const entry of entries) {
        const name = entry as string
        if (!isSafeEntityName(name)) {
          errors.push({ field: `contents.${key}`, message: `条目 "${name}" 不是安全的实体名（不含 / \\ .. .，非空）` })
        }
      }
      // 重复条目报错。
      const seen = new Set<string>()
      for (const entry of entries) {
        const name = entry as string
        if (seen.has(name)) {
          errors.push({ field: `contents.${key}`, message: `条目 "${name}" 在 contents.${key} 中重复` })
        }
        seen.add(name)
      }
    }
  }

  return errors
}
