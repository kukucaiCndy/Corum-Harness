/**
 * @corum/corum-subagent build: host-only library（无 client 半）。五入口：
 * lib/types/index.js（seam 服务本体 + cwd 透传）、lib/types/spawn/index.js
 * （corum-spawn provider）、lib/types/fork/index.js（corum-fork provider，2026-09-10）、lib/types/isolated/index.js（corum-isolated provider，2026-09-10）、
 * lib/types/acp/index.js（corum-acp provider wrapper，阶段 5 ACP 子进程隔离）。
 * 官方 dsh 包全部 external——host 从真实安装解析，与官方 seam 同版本共存。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-subagent',
  host: {
    entries: ['lib/types/index.js', 'lib/types/spawn/index.js', 'lib/types/fork/index.js', 'lib/types/isolated/index.js', 'lib/types/acp/index.js'],
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session-projection-cache', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-subagent-acp', '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-util-time', '@deepseek-ai/dsh-util-values', '@deepseek-ai/schemastery', 'zod'],
  },
  client: false,
})
