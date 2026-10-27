/**
 * fork（corum）：in-process FORK 后端的 corum 版——provider 默认名 'corum-fork'
 * （与官方 'fork' 并存于同一 registry，互不抢名），其余与官方逐行一致。
 *
 * 原始模块：`@deepseek-ai/dsh-subagent-fork-in-process`。**唯一实质差异**（与
 * `./spawn` 同款）：`startInProcessRun` 来自 corum 的 driver（`../driver/index.ts`），
 * 于是 fork 子会话同样走 fork #9 的 `cwd` 透传 + `assertChildCwd`——否则官方 provider
 * 会忽略 `request.cwd`，隔离 worktree 只在台账里存在、子 Agent 实际仍在主工作区（
 * 「台账说隔离、实际没隔离」的静默错位）。
 *
 * 官方语义（必须保持）：子会话以**父会话已完成的轮次**为种子（`turn/end` 之前的
 * 平衡前缀；进行中的那一轮不可重放），因此子 Agent 继承父对话上下文、模型路由与父
 * 一致时还能复用 KV cache。种子在创建时一次性快照：父会话之后的轮次不会进入子会话。
 * @module @deepseek-ai/dsh-subagent-fork-in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '../index.ts'
import { startInProcessRun } from '../driver/index.ts'

export const name = 'corum-subagent-fork-in-process'
// `tools` is deliberately NOT injected — same rationale as subagent-spawn-in-process: the
// per-run structured runtime gates its capture-tool registration on `tools`
// itself, so this backend's apply timing (and the delegation tool's position
// in the model-visible tool list) is unchanged by structured output.
export const inject = ['subagents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `corum-fork`). */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('corum-fork'),
})

/**
 * The balanced completed-turn prefix of `parent`'s log: every event up to and including the
 * last `turn/end`. The in-flight turn is excluded; before any completed turn the child starts
 * fresh. Because live sequence numbers equal array indexes, the result remains a valid seed
 * beginning at sequence zero.
 * @param parent - the agent whose session log to slice.
 * @returns the seed events, contiguous from seq 0; empty when no turn has completed.
 */
function completedTurnPrefix(parent: Agent): SessionEvent[] {
  const events = parent.session.snapshotEvents()
  const lastEnd = events.findLast(e => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  // seq === array index (the append contract), so slice up to and including it.
  return events.slice(0, lastEnd.seq + 1)
}

/**
 * The fork provider. Supports `depthLimit` and `outputSchema` (via the shared
 * in-process structured runtime), `agentOptions` (merged over the parent
 * route), and `toolFilter`/`persona` (scoped restrict() and a scoped shadowing
 * persona section).
 */
class ForkInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    agentPreset: false,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  // Context contract: a forked child IS seeded with the parent's completed-turn prefix.
  readonly inheritsParentContext = true

  constructor(readonly name: string) {}

  start(request: ResolvedSubagentStartRequest) {
    const seed = completedTurnPrefix(request.parent)
    return startInProcessRun(request, {
      // Only pass a seed when there's a completed turn to inherit; an empty seed
      // is equivalent to a fresh child, so omit it to keep the session unseeded.
      ...seed.length > 0 ? { seed } : {},
    })
  }

  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // The fork prefix is captured ONCE, at creation: it becomes part of the
    // child's own durable transcript, so a later cold resume replays that
    // prefix instead of re-forking the parent's newer history.
    const seed = completedTurnPrefix(request.parent)
    return Promise.resolve(seed.length > 0 ? { seed } : {})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new ForkInProcessProvider(config.providerName))
}
