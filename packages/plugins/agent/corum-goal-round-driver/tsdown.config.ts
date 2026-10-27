/**
 * @corum/corum-goal-round-driver build（host-only library）。
 *
 * fork 自官方 `@deepseek-ai/dsh-goal-round-driver`（fork #17，2026-09-27）：唯一增量是
 * 「**该 Agent 名下尚有在飞 subagent run 时不自动开新轮**」，并在 `subagent/end` 时重新评估
 * （见 src/index.ts 的 corum fork delta）。官方 dsh 包全部 external——host 从真实安装解析，
 * 与官方同版本共存。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-goal-round-driver',
  host: {
    entries: ['lib/types/index.js'],
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session'],
  },
  client: false,
})
