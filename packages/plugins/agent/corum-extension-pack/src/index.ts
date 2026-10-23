/**
 * @corum/corum-extension-pack — 扩展包格式定义与校验（纯函数库，P1）。
 *
 * 定义扩展包清单格式、校验器、插件/UI 声明、包根分类。
 * 不注册 cordis 服务、不做 `apply(ctx)`；不做磁盘扫描/安装逻辑（那是 P2）。
 *
 * @module @corum/corum-extension-pack
 */

// 扩展包清单格式与校验。
export {
  EXTENSION_FORMAT_VERSION,
  EXTENSION_MANIFEST_FILE,
  MODULE_MANIFEST_FILE,
  EXTENSION_CONTENT_KEYS,
  isValidExtensionId,
  isSafeEntityName,
  validateExtension,
} from './extension-format.ts'
export type {
  ExtensionContentKey,
  ExtensionValidationError,
  ExtensionContents,
  ExtensionManifest,
} from './extension-format.ts'

// 插件声明与校验。
export { validatePluginDecl } from './plugin-decl.ts'
export type { ExtensionRequirement, ExtensionPluginDecl } from './plugin-decl.ts'

// UI 声明与校验。
export { validateUiDecl } from './ui-decl.ts'
export type { ExtensionUiDecl } from './ui-decl.ts'

// 包根分类。
export { classifyPack } from './pack-kind.ts'
export type { PackKind } from './pack-kind.ts'
