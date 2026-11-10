/**
 * corum fork provider 单测（`@corum/corum-subagent/fork`，2026-09-10）。
 *
 * 官方 `@deepseek-ai/dsh-subagent-fork-in-process` 的 spec 依赖 dsh monorepo 相对路径
 * 的测试工具链（mock adapter / agent-loop testkit），移植成本高且收益有限——本 spec 只
 * 锁定**必须保持不变的两条官方语义 + 一条 corum 增量**：
 *   1. 种子 = 父会话**已完成轮次**的平衡前缀（到最后一个 `turn/end` 为止，进行中的
 *      那一轮不可重放）；
 *   2. `inheritsParentContext = true`（子会话继承父对话上下文）；
 *   3. provider 默认名 `corum-fork`（不与官方 `fork` 抢名）。
 * 端到端（真实种子生效）由 dev 实例实机验证覆盖：主 Agent 记口令 → fork 子 Agent 复述。
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/fork/index.ts'

/** 最小 subagents registry 桩：捕获 registerProvider 的实例。 */
function mountForkProvider(providerName?: string): SubagentProvider {
  const ctx = new Context()
  let captured: SubagentProvider | undefined
  ctx.provide('subagents', {
    registerProvider: (provider: SubagentProvider) => { captured = provider },
  } as never)
  const config = providerName === undefined
    ? (Config({} as never) as { providerName: string })
    : { providerName }
  apply(ctx, config)
  if (captured === undefined) throw new Error('fork provider was not registered')
  return captured
}

/** 伪造父 Agent：只提供 fork 种子需要的 `session.snapshotEvents()`。 */
function parentAgent(events: readonly Partial<SessionEvent>[]): Agent {
  return {
    session: {
      snapshotEvents: () => events.map((event, seq) => ({ seq, ...event })),
    },
  } as unknown as Agent
}

describe('corum fork provider — 官方 seed 语义', () => {
  it('默认 provider 名 corum-fork（与官方 fork 并存不抢名）', () => {
    expect(Config({} as never).providerName).toBe('corum-fork')
    expect(mountForkProvider().name).toBe('corum-fork')
  })

  it('声明 inheritsParentContext = true（子会话继承父对话上下文）', () => {
    expect(mountForkProvider().inheritsParentContext).toBe(true)
  })

  it('能力声明与官方一致（agentOptions/outputSchema/depthLimit/toolFilter/persona）', () => {
    expect(mountForkProvider().capabilities).toEqual({
      agentOptions: true,
      agentPreset: false,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    })
  })

  it('continuable 种子 = 到最后一个 turn/end 为止（进行中的轮次不进种子）', async () => {
    const provider = mountForkProvider()
    const parent = parentAgent([
      { type: 'user/message' },
      { type: 'assistant/message' },
      { type: 'turn/end' },
      // 进行中的一轮：没有收尾的 turn/end，不能被重放为合法子会话。
      { type: 'user/message' },
    ])
    const spec = await provider.prepareContinuable({ parent } as never)
    expect(spec.seed?.map(event => event.seq)).toEqual([0, 1, 2])
  })

  it('没有任何已完成轮次 → 无种子（等价 fresh child）', async () => {
    const provider = mountForkProvider()
    const spec = await provider.prepareContinuable({ parent: parentAgent([{ type: 'user/message' }]) } as never)
    expect(spec.seed).toBeUndefined()
  })
})
