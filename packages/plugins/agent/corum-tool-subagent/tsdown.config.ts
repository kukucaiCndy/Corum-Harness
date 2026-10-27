/**
 * @corum/corum-tool-subagent build: host-only library（无 client 半）。三入口：
 * lib/types/index.js（召唤工具本体 + 隔离层）、
 * lib/types/settings-registrar.js（`corum-subagent` settings ns 的 **boot 常驻注册行**，
 * 2026-09-18 新增——该 ns 是全局配置，不能只在按会话 apply 的工具实例里注册，否则冷启动
 * 进设置页读到空值、新建预设的模板预填失效；详见该文件头注释）。
 * model-selection-settings 是 host 内部 import（由 index.js 经相对路径带进产物），不单独设入口。
 * 官方 dsh 包全部 external——host 从真实安装解析，与官方 seam 同版本共存。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-tool-subagent',
  host: {
    entries: ['lib/types/index.js', 'lib/types/settings-registrar.js'],
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-util-values', '@deepseek-ai/schemastery', 'zod'],
  },
  client: false,
})
