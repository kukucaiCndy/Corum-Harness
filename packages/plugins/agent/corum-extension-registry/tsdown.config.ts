/**
 * @corum/corum-extension-registry build：纯 fs + node path 中性小包。
 *
 * 无 @corum 依赖（必须保持无环：skill/mcp manager、extension-pack、desktop、
 * agent 都依赖它，反之不可——见 P5 设计文档 §5.2）。唯一依赖是官方
 * `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`（展开 `~` 前缀），external
 * 让 host 从真实安装解析（与 corum-preset-modules 同款）。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-extension-registry',
  host: {
    external: ['@deepseek-ai/dsh-home-paths'],
  },
  client: false,
})
