/**
 * 扩展包归属台账的类型定义（P5a）。
 *
 * 见 P5 设计文档 §4.2「单一事实源：registry.json」：
 * `<CORUM_HOME>/extension-packs/registry.json` 是「哪个扩展包拥有哪些资源」
 * 的权威台账。本包只读写这张表，不碰各资源页自己的存储（skill 目录 / MCP
 * 注册表 / preset 目录 / 插件 package.json——见 §5.3「为什么不写进资源自身」）。
 *
 * @module @corum/corum-extension-registry/types
 */

/**
 * 扩展包资源类别（六类之一）。
 *
 * 与 `EXTENSION_CONTENT_KEYS`（corum-extension-pack/extension-format.ts）同口径：
 * presets / skills / mcp / plugins / themes / ui。归属台账按这六类组织 items。
 *
 * `themes` 与 `ui` 本轮（P5a）只登记归属、不落地卸载（见 P5 设计 §5.4：
 * 「主题/UI 本轮未实现，登记 deferred」），但归属记录必须能存——否则来源
 * 判据（§4.1）在 themes/ui 上无事实源。
 */
export type ExtensionItemKind = 'presets' | 'skills' | 'mcp' | 'plugins' | 'themes' | 'ui'

/**
 * 一条归属记录（registry.json 的 items[kind] 数组元素）。
 *
 * - `name`：资源名（skill 名 / MCP 服务名 / preset id / 插件包名 / 主题名 / UI 名）。
 * - `versionId`：可选，技能版本 id（仅 skills 类有意义，见 EXTENSION-PACK-PLAN §4.2 示例）。
 * - `entryId`：可选，插件 entry id（仅 plugins 类有意义，形如 `ext:<packId>:<pluginName>`）。
 */
export interface ExtensionItemRecord {
  readonly name: string
  readonly versionId?: string
  readonly entryId?: string
}

/**
 * 一个扩展包的台账记录（registry.json 的 packs[packId] 值）。
 *
 * 见 P5 设计 §4.2 的示例结构。
 *
 * - `id`：扩展包 id（须满足 `^[a-z0-9][a-z0-9-]*$`，与目录名一致）。
 * - `version`：扩展包自身版本（如 `1.3.0`），非空字符串。
 * - `name`：可选显示名（来自 extension.json，可能缺失）。
 * - `installedAt`：安装时间（ISO 字符串）。
 * - `items`：六类资源归属，按 kind 组织；缺失的 kind 表示该类无内容。
 */
export interface ExtensionPackRecord {
  readonly id: string
  readonly version: string
  readonly name?: string
  readonly installedAt: string
  readonly items: Partial<Record<ExtensionItemKind, readonly ExtensionItemRecord[]>>
}

/**
 * registry.json 的整体结构。
 *
 * - `packs`：packId → ExtensionPackRecord。
 *
 * 缺失目录 / 缺失文件时 `readRegistry` 返回 `{ packs: {} }`（干净 home 合法）；
 * 损坏 JSON 或非法结构时 `readRegistry` **fail loud** 抛错（消息含文件路径）。
 */
export interface ExtensionRegistry {
  readonly packs: Readonly<Record<string, ExtensionPackRecord>>
}
