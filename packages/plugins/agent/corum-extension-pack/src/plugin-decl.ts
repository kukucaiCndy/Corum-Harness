/**
 * 扩展包内的插件声明（`plugins/` 下每个 `*.json`）格式与校验（P1）。
 *
 * ## 为什么需要插件声明
 *
 * 扩展包除了携带预设/技能/MCP 外，还可以携带**插件**——cordis 插件包。
 * 插件声告诉诉安装器：这个插件叫什么、它的 spec 是什么、它是常驻还是懒加载、
 * 它的入口在哪、它需要什么前置依赖、它的完整性校验信息。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3 的插件声明格式。
 *
 * ## 设计要点
 *
 * 1. **`bundle` 或 `entry` 至少有一个**：插件要么是预打包的 bundle（`bundle: true`，
 *    插件产物已构建好），要么有入口文件（`entry` 指向源入口）。两者都没有的声明
 *    是残缺的——安装器无从知道要加载什么。
 * 2. **`requires` 镜像 McpRequirement**：插件与 MCP 一样可能有外部依赖
 *    （app/command/service），复用同一套判别联合与校验逻辑。
 * 3. **`integrity` 完整性校验**：sha256 是 64 字符小写十六进制，files/bytes 是正整数。
 *    用于安装后验证插件产物未被篡改。
 *
 * @module @corum/corum-extension-pack/plugin-decl
 */

import type { ExtensionValidationError } from './extension-format.ts'
import { isSafeEntityName } from './extension-format.ts'

/**
 * 插件的前置依赖声明——镜像 {@link McpRequirement} 判别联合。
 *
 * 按依赖性质分三类（与 MCP 的 requires 完全同构，复用同一套语义）：
 *   · `app`      需要某个宿主程序（如 Pen.app）⇒ 具体路径按平台不同；
 *   · `command`  需要一个 PATH 上的命令（如 npx）⇒ 需 Node/网络；
 *   · `service`  需要一个已在跑的服务（streamable-http 端点）。
 *
 * @see packages/plugins/agent/corum-preset-modules/src/module-format.ts 的 McpRequirement
 */
export type ExtensionRequirement =
  | {
    readonly kind: 'app'
    /** 按平台给出可执行文件路径。键是 `process.platform` 的值（darwin/win32/linux）。 */
    readonly platforms?: Readonly<Record<string, string>>
    /** 给人看的说明。 */
    readonly hint: string
    /** 去哪装（下载页）。 */
    readonly url?: string
  }
  | {
    readonly kind: 'command'
    /** 需要在 PATH 上可解析的命令名（如 `npx`）。 */
    readonly command: string
    readonly hint: string
    readonly url?: string
  }
  | {
    readonly kind: 'service'
    /** 期望可达的 URL。 */
    readonly url: string
    readonly hint: string
  }

/**
 * 扩展包内的一个插件声明。
 *
 * @see corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3
 */
export interface ExtensionPluginDecl {
  /** 插件名（须满足 {@link isSafeEntityName}）。 */
  readonly name: string
  /** 显示名（可选）。 */
  readonly label?: string
  /** 插件 spec（spec id，非空字符串）。 */
  readonly spec: string
  /** 加载模式：`permanent` 常驻 / `lazy` 懒加载。 */
  readonly mode: 'permanent' | 'lazy'
  /** 是否预打包 bundle。 */
  readonly bundle?: boolean
  /** 入口文件相对路径（与 bundle 二选一）。 */
  readonly entry?: string
  /** 前置依赖声明（可选）。 */
  readonly requires?: ExtensionRequirement
  /** 安装/更新后是否需要重启。 */
  readonly restartRequired?: boolean
  /** 关联的 UI 实体名（须满足 {@link isSafeEntityName}）。 */
  readonly ui?: string
  /** 完整性校验信息（sha256 + 文件数 + 字节数）。 */
  readonly integrity?: {
    readonly sha256: string
    readonly files: number
    readonly bytes: number
  }
}

/**
 * 校验一个插件声明。
 *
 * @param value - 已 `JSON.parse` 的原始值。
 * @returns 错误列表（空数组 = 合法）。**不抛异常**。
 *
 * 详见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §3 的插件声明校验规则。
 */
export function validatePluginDecl(value: unknown): ExtensionValidationError[] {
  const errors: ExtensionValidationError[] = []

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '(root)', message: '插件声明必须是一个 JSON 对象' }]
  }

  const p = value as Record<string, unknown>

  // name 必须是安全实体名。
  if (typeof p.name !== 'string' || !isSafeEntityName(p.name)) {
    errors.push({ field: 'name', message: `name "${String(p.name)}" 不是安全的实体名（不含 / \\ .. .，非空）` })
  }

  // spec 非空字符串。
  if (typeof p.spec !== 'string' || p.spec.trim() === '') {
    errors.push({ field: 'spec', message: 'spec 不能为空' })
  }

  // mode 必须是 permanent 或 lazy。
  if (p.mode !== 'permanent' && p.mode !== 'lazy') {
    errors.push({ field: 'mode', message: `mode "${String(p.mode)}" 不合法：必须是 permanent 或 lazy` })
  }

  // bundle === true 或非空 entry 至少有一个。
  const hasBundle = p.bundle === true
  const hasEntry = typeof p.entry === 'string' && p.entry.trim() !== ''
  if (!hasBundle && !hasEntry) {
    errors.push({
      field: 'entry',
      message: '插件必须提供 bundle: true 或非空 entry（二者至少有一个，否则安装器无从知道加载什么）',
    })
  }

  // requires 如果存在必须校验。
  if (p.requires !== undefined) {
    const reqErrors = validateRequirement(p.requires)
    for (const e of reqErrors) {
      errors.push({ field: `requires.${e.field}`, message: e.message })
    }
  }

  // ui 如果存在必须是安全实体名。
  if (p.ui !== undefined) {
    if (typeof p.ui !== 'string' || !isSafeEntityName(p.ui)) {
      errors.push({ field: 'ui', message: `ui "${String(p.ui)}" 不是安全的实体名（不含 / \\ .. .，非空）` })
    }
  }

  // integrity 如果存在必须校验。
  if (p.integrity !== undefined) {
    if (typeof p.integrity !== 'object' || p.integrity === null || Array.isArray(p.integrity)) {
      errors.push({ field: 'integrity', message: 'integrity 必须是一个 JSON 对象' })
    } else {
      const i = p.integrity as Record<string, unknown>
      // sha256 必须是 64 字符小写十六进制。
      if (typeof i.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(i.sha256)) {
        errors.push({ field: 'integrity.sha256', message: `sha256 "${String(i.sha256)}" 不合法：必须是 64 字符小写十六进制` })
      }
      // files 必须是正整数。
      if (typeof i.files !== 'number' || !Number.isInteger(i.files) || i.files <= 0) {
        errors.push({ field: 'integrity.files', message: `files "${String(i.files)}" 不合法：必须是正整数` })
      }
      // bytes 必须是正整数。
      if (typeof i.bytes !== 'number' || !Number.isInteger(i.bytes) || i.bytes <= 0) {
        errors.push({ field: 'integrity.bytes', message: `bytes "${String(i.bytes)}" 不合法：必须是正整数` })
      }
    }
  }

  return errors
}

/**
 * 校验一个 ExtensionRequirement（插件/MCP 共用的前置依赖声明）。
 *
 * 内部使用，返回的错误 field 不带 `requires.` 前缀（由调用方拼接）。
 */
function validateRequirement(value: unknown): ExtensionValidationError[] {
  const errors: ExtensionValidationError[] = []

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '(root)', message: 'requires 必须是一个 JSON 对象' }]
  }

  const r = value as Record<string, unknown>

  // kind 必须是 app / command / service。
  if (r.kind !== 'app' && r.kind !== 'command' && r.kind !== 'service') {
    errors.push({ field: 'kind', message: `kind "${String(r.kind)}" 不合法：必须是 app / command / service` })
    return errors
  }

  // hint 必须非空（给人看的安装指引）。
  if (typeof r.hint !== 'string' || r.hint.trim() === '') {
    errors.push({ field: 'hint', message: 'hint 不能为空（给人看的安装指引）' })
  }

  // 按 kind 校验：
  // app ⇒ 必须有非空 platforms（至少一个平台键）；
  // command ⇒ 必须有非空 command；
  // service ⇒ 必须有非空 url。
  // 平台分叉纪律（规范 §16）：app 类型按平台声明可执行路径，否则换系统静默失效。
  if (r.kind === 'app') {
    const platforms = r.platforms
    if (typeof platforms !== 'object' || platforms === null || Array.isArray(platforms)
      || Object.keys(platforms).length === 0) {
      errors.push({ field: 'platforms', message: 'app 类型必须有非空 platforms（至少 1 个平台键）' })
    }
  }
  if (r.kind === 'command') {
    if (typeof r.command !== 'string' || r.command.trim() === '') {
      errors.push({ field: 'command', message: 'command 类型必须有非空 command' })
    }
  }
  if (r.kind === 'service') {
    if (typeof r.url !== 'string' || r.url.trim() === '') {
      errors.push({ field: 'url', message: 'service 类型必须有非空 url' })
    }
  }

  return errors
}
