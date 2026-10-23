/**
 * @corum/corum-extension-registry — 扩展包归属台账（P5a）。
 *
 * 纯 fs + node path 的中性小包，读写 `<CORUM_HOME>/extension-packs/registry.json`，
 * 回答「某资源由哪个扩展包拥有」。无 @corum 依赖（必须保持无环：
 * skill/mcp manager、extension-pack、desktop、agent 都依赖它，反之不可）。
 *
 * 见 P5 设计文档 §4.2（单一事实源）、§5.2（双端强制）、§8 风险 1（循环依赖）。
 *
 * @module @corum/corum-extension-registry
 */

// 类型定义。
export type {
  ExtensionItemKind,
  ExtensionItemRecord,
  ExtensionPackRecord,
  ExtensionRegistry,
} from './types.ts'

// 常量、读写、查询、归属拒绝。
export {
  EXTENSION_PACKS_DIRNAME,
  EXTENSION_REGISTRY_FILENAME,
  resolveRegistryHome,
  registryPath,
  readRegistry,
  writeRegistry,
  upsertPack,
  removePack,
  findOwner,
  ownershipMap,
  PackOwnedError,
  assertNotPackOwned,
} from './store.ts'
