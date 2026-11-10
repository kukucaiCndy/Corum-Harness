/**
 * corum-ui-chat build: standalone tsdown config mirroring
 * corum-ui-conversation / corum-ui-model-selection. The browser bundle is a
 * closure-factory artifact — it calls window.__ModuleLoader__.load({id,
 * factory}) and resolves externals through the loader module table. CSS
 * Modules are compiled by tsdown's own css pipeline and inlined into
 * client.js (scripts/inline-css.mjs folds the extracted sheet into the
 * bundle).
 *
 * 2026-10-29：chat 现在对 `@corum/corum-ui-conversation/client` 有**运行时**值引用
 * （`toolArguments` 等 rc3 工具块参数视图，见 tool-args.ts），故必须列进
 * extraExternals：该包在模块表里**另有自己的行**（`@corum/corum-ui-conversation/client`），
 * 内联会得到第二份实现（AGENTS 红线 1 的同源问题），external 才是单一实例。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-ui-chat',
  client: {
    extraExternals: [
      // 必须写**完整 specifier**：plugin-build 的 noExternal 谓词是精确匹配
      // （`externals.includes(id)`），只写包名会把 `/client` 子路径内联成第二份实现。
      '@corum/corum-ui-conversation/client',
      '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-settings',
    ],
    pinConditionNames: true,
  },
})
