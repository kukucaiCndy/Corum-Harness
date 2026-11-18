/**
 * @corum/corum-memory build: host library + browser client bundle.
 *
 * Host 三个入口：
 *   · `lib/types/index.js` —— 服务本体（MemoryService）。
 *   · `lib/types/settings-registrar.js` —— `corum-memory` settings ns 的 **boot
 *     常驻注册行**（该 ns 不在 boot 注册则冷启动读不到已存参数，见该文件头注释）。
 *   · `lib/types/memory-tool.js` —— 模型工具工厂（createMemoryRecallTool），
 *     供 corum-agent 在 agent scope ctx.tools.register。
 * Browser 入口：`src/client/index.tsx`（设置中心两个 section 的产品页）。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-memory',
  host: {
    entries: ['lib/types/index.js', 'lib/types/settings-registrar.js', 'lib/types/memory-tool.js'],
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery', 'zod'],
  },
  client: {
    entry: 'src/client/index.tsx',
    extraExternals: ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-connection'],
  },
})
