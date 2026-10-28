/**
 * corum-ui-trajectory build: standalone tsdown config mirroring the other corum
 * UI forks. The browser bundle is a closure-factory artifact — it calls
 * window.__ModuleLoader__.load({id, factory}) and resolves externals through the
 * loader module table. CSS Modules are compiled by tsdown's own css pipeline and
 * inlined into client.js (scripts/inline-css.mjs folds the extracted sheet in).
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-ui-trajectory',
  client: {
    extraExternals: [
      // 2026-10-29：轨迹的 tool 定义也产出 rc3 工具块（`name`/`args`），与 chat 同源读
      // `toolArguments`。该包在模块表里另有自己的行 ⇒ 必须 external（完整 specifier，
      // plugin-build 的 noExternal 是精确匹配），否则内联成第二份实现。
      '@corum/corum-ui-conversation/client',
      '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store',
    ],
  },
})
