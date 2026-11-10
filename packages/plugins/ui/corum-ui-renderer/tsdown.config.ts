/**
 * 渲染器 fork 的 bundle 配置（与官方 `@deepseek-ai/dsh-client-ui-renderer`
 * 的 `clientBundle()` preset 同一份装载契约）：
 *   · 宿主半 `lib/index.js`（ESM / node，`apply()` 空实现，只为满足 loader 行）；
 *   · 客户端半 `lib/client.js`（`window.__ModuleLoader__.load({id, factory})` 闭包）。
 *
 * `id` 必须是**本包名**：client-modules 用「`__ModuleLoader__.load` 的 id」与
 * 「行名解析到的 package.json name」对齐（`packages/client/modules/src/index.ts`
 * 的 `locatePkgJson` / `system.ts`），两者不一致 ⇒ 该行的 client 半不被登记。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-ui-renderer',
  client: { entry: 'src/client/index.ts' },
})
