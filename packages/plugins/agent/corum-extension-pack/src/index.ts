/**
 * @corum/corum-extension-pack — 扩展包格式定义、校验、扫描与安装（P1+P2）。
 *
 * 定义扩展包清单格式、校验器、插件/UI 声明、包根分类（P1）；
 * 扫描一个包目录收集所有跨文件一致性问题（P2 scan）；
 * 把扩展包整体落进用户根，plugins/themes/ui 登记成 deferred（P2 install）。
 * 不注册 cordis 服务、不做 `apply(ctx)`；不做 pnpm add / entries.json / boot 折行（P3/P4）。
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

// 扫描（P2）：把一个包目录扫成结构化结果，收集所有跨文件一致性问题。
export { scanExtensionPack } from './scan.ts'
export type {
  ExtensionEntityRef,
  ExtensionPackScan,
} from './scan.ts'

// 安装（P2）：把扩展包整体落进用户根（skills → mcp → presets），
// plugins/themes/ui 登记成 deferred 返回（P3/P4 才落地）。
export { installExtensionPack } from './install.ts'
export type {
  ExtensionInstallConflict,
  ExtensionInstallInput,
  ExtensionInstallPresetResult,
  ExtensionDeferredClass,
  ExtensionInstallResult,
} from './install.ts'

// 插件 insert 行持久层（P3a）：把每包的 plugin 行持久化在
// <CORUM_HOME>/extension-packs/<packId>/entries.json，boot 时折成层栈。
// 见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2。
export {
  EXTENSION_ENTRY_ID_PREFIX,
  entryIdFor,
  extensionPacksDir,
  packEntriesPath,
  readPackEntries,
  writePackEntries,
  listExtensionPackIds,
  loadExtensionEntries,
  extensionPatches,
} from './entries-store.ts'
export type {
  ExtensionEntry,
  ExtensionEntriesFile,
} from './entries-store.ts'

// patch 列表合成（P3b 纯函数）：把 base + extension + disabled 合成完整有序列表。
export { composeExtensionPatchList } from './patch-compose.ts'

// 热应用（P3b）：不重启地把 entries.json 折出的 plugin 行挂进活着的 Loader。
// 见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md section 5.2.2。
export { ExtensionHotApply } from './hot-apply.ts'
export type {
  HotApplyLoaderLike,
  HotApplyDeps,
  HotApplyResult,
} from './hot-apply.ts'

// 本地端到端安装（P5c）：scan → skills/mcp/presets → 插件包 → entries.json
// → registry.json →（caller 触发 hot apply）→ result。
// 插件安装以 installPlugin 回调注入（可单测、不依赖桌面壳）。
export { installLocalExtensionPack } from './install-local.ts'
export type {
  InstallLocalPackInput,
  InstallLocalPluginResult,
  InstallLocalPackResult,
} from './install-local.ts'

// 卸载（P4）：按 registry 归属逐项处理，删 entries.json + pack 目录 + registry 记录。
// 纯函数 planUninstall 可单测；uninstallExtensionPack 以回调注入执行器。
// 见 corum-dev-preset 仓 docs/EXTENSION-PACK-PLAN.md §9。
export { planUninstall, uninstallExtensionPack } from './uninstall.ts'
export type {
  UninstallPackInput,
  UninstallPlan,
  UninstallPackResult,
} from './uninstall.ts'
