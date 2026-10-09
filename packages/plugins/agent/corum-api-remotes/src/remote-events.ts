/**
 * The one home of this application's forwarded-Host-event allowlist. Both
 * compiler faces list this file, so the Host forwarding loop and the consumer
 * `ctx.remote.$on` key face read one declaration instead of two copies that
 * could drift; `./types.ts` derives the type projection from it and stays
 * type-only.
 */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'
import type { TypertForwardableEventEntry } from '@deepseek-ai/dsh-typert-protocol'
// fork（corum）：拉入 corum 领域事件的 cordis Events 声明（自包含，不 import
// host-only 的 corum-agent），让下方数组追加的 corum 条目过 `satisfies
// TypertForwardableEventEntry[]` 的编译期校验。
import type {} from './corum-events.ts'

/**
 * Host events this application forwards without renaming. The explicit mode is
 * both the Host dispatch strategy and the legal key set of `ctx.remote.$on`.
 */
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  { event: 'api-session/activity', mode: 'emit' },
  { event: 'api-session/added', mode: 'emit' },
  { event: 'api-session/error', mode: 'emit' },
  { event: 'api-session/removed', mode: 'emit' },
  { event: 'api-session/status', mode: 'emit' },
  { event: 'commands/change', mode: 'emit' },
  { event: 'credentials/reference-updated', mode: 'emit' },
  { event: 'cordis/request-run', mode: 'emit' },
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  { event: 'cordis/dynamic-package', mode: 'emit' },
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  { event: 'cordis/inspect-query', mode: 'emit' },
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  { event: 'llm/adapters-updated', mode: 'emit' },
  { event: 'settings/document-updated', mode: 'emit' },
  { event: 'user-questions/request', mode: 'waterfall' },
  { event: 'goal/activation-changed', mode: 'emit' },
  // ── fork（corum）：统一事件中心一期——corum 领域事件并入转发（官方 17 行零改动）──
  { event: 'corum/task/assigned', mode: 'emit' },
  { event: 'corum/task/started', mode: 'emit' },
  { event: 'corum/task/completed', mode: 'emit' },
  { event: 'corum/task/deferred', mode: 'emit' },
  { event: 'corum/task/evicted', mode: 'emit' },
  { event: 'corum/task/blocked', mode: 'emit' },
  { event: 'corum/task/unblocked', mode: 'emit' },
  { event: 'corum/task/stalled', mode: 'emit' },
  { event: 'corum/task/steered', mode: 'emit' },
  { event: 'corum/task/cancelled', mode: 'emit' },
  { event: 'corum/group/member-added', mode: 'emit' },
  { event: 'corum/group/member-removed', mode: 'emit' },
  { event: 'corum/terminal/output', mode: 'emit' },
  // ── fork（corum）：统一事件中心二期——文件 watch 变更推送并入转发 ──
  { event: 'corum/file/changed', mode: 'emit' },
  // ── fork（corum）：统一事件中心三期——子 Agent 进度增量推送并入转发 ──
  { event: 'corum/subagent/progress', mode: 'emit' },
  // 子 Agent spawn 精确父子映射（fork #10 发射；SubagentCard 运行中即可跳子会话）
  { event: 'corum/subagent/child', mode: 'emit' },
  // 「子 Agent 半途失去运行」的发现点广播（宿主 RPC 首次判出时发一次；通知栏承载）
  { event: 'corum/subagent/interrupted', mode: 'emit' },
  // 子 Agent 隔离台账快照（fork #10 发射；「并行工作区」chip 订阅源）
  { event: 'corum/worktree-ledger', mode: 'emit' },
  // P2-7：下载进度事件化（取代设置页 500ms 轮询）。
  { event: 'corum/artgen/download-progress', mode: 'emit' },
  { event: 'corum/ollama/download-progress', mode: 'emit' },
  { event: 'corum/artgen/job-progress', mode: 'emit' },
  // 子 Agent 模型不可用 ⇒ 机制问用户（独立通路，不经 userQuestions）
  { event: 'corum/model-ask/request', mode: 'waterfall' },
  // fork（corum）2026-09-26：子 Agent 提权三档询问（第 2 档「总是允许」借 corum 自有
  // waterfall 携带自己的答案词汇表——官方 approval/request 的 outcome 在服务内部就被归一化了）。
  { event: 'corum/escalation/ask', mode: 'waterfall' },
  // turn-stopping 阻塞式提交卡片（fork corum 2026-10-08）：turn 将关时出卡片展示 diff 摘要，
  // LLM 自己分笔提交。waterfall（卡片无按钮，回传立即解析，阻塞由机制保证）。
  { event: 'corum/commit-card/request', mode: 'waterfall' },
  // 提交卡片状态更新（emit 通道：pending → progress → done/stashed）
  { event: 'corum/commit-card/update', mode: 'emit' },
] as const satisfies readonly TypertForwardableEventEntry[]
