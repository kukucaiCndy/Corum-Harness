/**
 * 扩展包内的 UI 声明（`ui/` 下每个 `*.json`）格式与校验（P1）。
 *
 * ## 为什么需要 UI 声明
 *
 * 扩展包可以携带 UI 扩展——往桌面应用的某个 slot 里插入自定义 UI 片段。
 * UI 声明告诉安装器：这个 UI 片段叫什么、它挂在哪个插件上、它插到哪个 slot、
 * 它的优先级、它替换哪些已有片段。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3 的 UI 声明格式。
 *
 * ## 设计要点
 *
 * 1. **跨文件检查属于 P2**：`plugin` 字段引用的插件名、`replaces` 引用的
 *    UI 实体名是否真实存在，需要扫描整个扩展包目录才能判断——P1 是纯函数
 *    （零 IO），只做单文件级格式校验。跨文件一致性校验留给 P2。
 * 2. **`plugin` / `name` / `label` 必须是安全实体名**：这些名字会成为安装后
 *    的目录/文件名，不能含路径穿越字符（与 extension-format 的 isSafeEntityName 同规则）。
 * 3. **`slot` 非空字符串**：slot 是 UI 注册表里的标识，空字符串无意义。
 * 4. **`priority` 有限数**：用于排序 UI 片段，`NaN`/`Infinity` 无意义。
 *    `Number.isFinite` 精确排除 `NaN`/`Infinity`/`-Infinity`。
 *
 * @module @corum/corum-extension-pack/ui-decl
 */

import type { ExtensionValidationError } from './extension-format.ts'
import { isSafeEntityName } from './extension-format.ts'

/**
 * 扩展包内的一个 UI 声明。
 *
 * @see corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3
 */
export interface ExtensionUiDecl {
  /** UI 片段名（须满足 {@link isSafeEntityName}）。 */
  readonly name: string
  /** 显示名（可选，须满足 {@link isSafeEntityName}）。 */
  readonly label?: string
  /** 关联的插件实体名（须满足 {@link isSafeEntityName}；跨文件存在性检查属于 P2）。 */
  readonly plugin: string
  /** 目标 slot 名（非空字符串）。 */
  readonly slot: string
  /** 排序优先级（可选，有限数）。 */
  readonly priority?: number
  /** 要替换的已有 UI 片段名列表（可选，每项非空字符串；跨文件存在性检查属于 P2）。 */
  readonly replaces?: readonly string[]
}

/**
 * 校验一个 UI 声明。
 *
 * @param value - 已 `JSON.parse` 的原始值。
 * @returns 错误列表（空数组 = 合法）。**不抛异常**。
 *
 * 注意：`plugin` 引用的插件名和 `replaces` 引用的 UI 名是否真实存在，
 * 需要扫描整个扩展包目录才能判断——那是 P2 的职责，P1 只做单文件格式校验。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3 的 UI 声明校验规则。
 */
export function validateUiDecl(value: unknown): ExtensionValidationError[] {
  const errors: ExtensionValidationError[] = []

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '(root)', message: 'UI 声明必须是一个 JSON 对象' }]
  }

  const u = value as Record<string, unknown>

  // name 必须是安全实体名。
  if (typeof u.name !== 'string' || !isSafeEntityName(u.name)) {
    errors.push({ field: 'name', message: `name "${String(u.name)}" 不是安全的实体名（不含 / \\ .. .，非空）` })
  }

  // label 如果存在必须是安全实体名。
  if (u.label !== undefined) {
    if (typeof u.label !== 'string' || !isSafeEntityName(u.label)) {
      errors.push({ field: 'label', message: `label "${String(u.label)}" 不是安全的实体名（不含 / \\ .. .，非空）` })
    }
  }

  // plugin 必须是安全实体名（跨文件存在性检查属于 P2）。
  if (typeof u.plugin !== 'string' || !isSafeEntityName(u.plugin)) {
    errors.push({ field: 'plugin', message: `plugin "${String(u.plugin)}" 不是安全的实体名（不含 / \\ .. .，非空）` })
  }

  // slot 非空字符串。
  if (typeof u.slot !== 'string' || u.slot.trim() === '') {
    errors.push({ field: 'slot', message: 'slot 不能为空' })
  }

  // priority 如果存在必须是有限数（排除 NaN / Infinity / -Infinity）。
  if (u.priority !== undefined) {
    if (typeof u.priority !== 'number' || !Number.isFinite(u.priority)) {
      errors.push({ field: 'priority', message: `priority "${String(u.priority)}" 不合法：必须是有限数` })
    }
  }

  // replaces 如果存在必须是非空字符串数组。
  if (u.replaces !== undefined) {
    if (!Array.isArray(u.replaces)) {
      errors.push({ field: 'replaces', message: 'replaces 必须是字符串数组' })
    } else {
      for (const item of u.replaces) {
        if (typeof item !== 'string' || item.trim() === '') {
          errors.push({ field: 'replaces', message: `replaces 的每个条目必须是非空字符串（发现 "${String(item)}"）` })
          break // 一个就够报了，不重复
        }
      }
    }
  }

  return errors
}
