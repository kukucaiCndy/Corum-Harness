/**
 * ★ 2026-11-18 实机事故（会话 `corum-task-f5d3b522`）的回归网：**询问的等待必须真正
 * 被取消/超时信号兜住**，绝不永久挂起父会话。
 *
 * ## 事故形态
 *
 * 指挥模式会话派出 `subagent_research`，子会话 429 限流 6 次后 `turn/end error`。
 * 「模型不可用 ⇒ 问用户」的面板从未出现，父会话的前台工具调用**永久挂起**
 * （journal 自委派起零事件，45+ 分钟未返回）。排查发现两处死代码级缺口：
 *
 * 1. `corumAskAboutModelFailure` 的 `signal` 参数**只被声明、从未被消费**——
 *    `CORUM_ASK_TIMEOUT_MS` 包出来的 `AbortSignal.timeout` 传进去后没有任何 race；
 * 2. 前台路径只传 `exec.signal`（用户不点停止就永不 abort），连那个死超时都没有。
 *
 * 于是「面板没渲染 / 用户不作答」两种形态都落成整轮永久挂起，与 approval #171
 * （988 秒挂起事故）同族。修法：执行核用 `corumModelAskRaceAbort` 真正 race；
 * `corumAskAboutModel` 对所有路径合并「调用方信号 + 时限」。
 *
 * ## 这里钉住什么
 *
 * ① 通道永不作答 + 信号 abort ⇒ dismissed + 诚实 summary + 零状态写入（真链路）；
 * ② 信号已 abort ⇒ 连通道都不派发（不制造无人认领的 pending）；
 * ③ 通道先作答、信号后 abort ⇒ 决定照常落地（正向控制：race 不许误伤正常路径）；
 * ④ `corumModelAskRaceAbort` 纯函数四格：work 赢 / abort 赢 / 预先 abort /
 *    输掉 race 的 work 晚到 reject 不变成 unhandled rejection。
 *
 * 负向控制：①② 在旧实现（signal 不消费）下会**永久挂住**——用例带 2s 超时上限，
 * 回退即红，而不是把整条测试队列拖死。
 *
 * @module @corum/corum-tool-subagent/tests/model-ask-abort
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CorumOrchestration } from '../src/index.ts'
import {
  corumAskAboutModelUnlessStale,
  corumDelegationPolicyStateFrom,
  corumModelAskRaceAbort,
  corumResetModelAskLocks,
  type CorumModelAskChannel,
  type CorumProfileWriteFace,
  type CorumRoute,
  type FOLLOW_MAIN,
} from '../src/model-ask-run.ts'
import type { CorumModelFailureFacts } from '../src/model-ask.ts'

afterEach(() => {
  corumResetModelAskLocks()
})

const SESSION = 'corum-task-f5d3b522-shape'
const CONFIGURED = { provider: 'localhost', model: 'glm-5.3-flashx' }
const PARENT_ROUTE = { provider: 'p-main', model: 'm-main' }

function makeParent(): Agent {
  return { session: { id: SESSION }, ctx: {} } as unknown as Agent
}

function makeFacts(): CorumModelFailureFacts {
  return {
    label: '定位 runPrompt 路径错误',
    role: 'research',
    configured: { ...CONFIGURED },
    fallback: { ...PARENT_ROUTE },
    cause: '429 rate limited',
  }
}

/** 预设写入面的记账桩（abort 路径一个字都不许写）。 */
function makeProfile(): {
  profile: CorumProfileWriteFace
  writes: { sessionId: string, role: 'worker' | 'research', route: CorumRoute | typeof FOLLOW_MAIN | undefined }[]
} {
  const writes: { sessionId: string, role: 'worker' | 'research', route: CorumRoute | typeof FOLLOW_MAIN | undefined }[] = []
  return {
    writes,
    profile: {
      applySubagentModelForSession: (sessionId, role, route) => {
        writes.push({ sessionId, role, route })
        return { presetId: 'conductor-lead', applied: route }
      },
    },
  }
}

/** 可控通道：作答时机由测试决定（永不作答 = 面板没渲染/用户不作答的事故形态）。 */
function makeChannel(): {
  channel: CorumModelAskChannel
  calls: number
  answer: (kind: string) => void
} {
  let settle!: (value: { kind: string }) => void
  const gate = new Promise<{ kind: string }>(resolve => { settle = resolve })
  const probe = {
    calls: 0,
    answer: (kind: string) => { settle({ kind }) },
    channel: {
      call: async () => {
        probe.calls += 1
        return await gate as never
      },
    } as CorumModelAskChannel,
  }
  return probe
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('① 真链路：通道永不作答时，信号必须把询问收口', () => {
  it('★ abort ⇒ dismissed + 诚实 summary + 零状态写入（旧实现会永久挂住）', async () => {
    const svc = new CorumOrchestration(new Context())
    const { profile, writes } = makeProfile()
    const { channel } = makeChannel() // 永不 answer
    const abort = new AbortController()
    const asking = corumAskAboutModelUnlessStale(
      { state: corumDelegationPolicyStateFrom(svc), channel, profile },
      makeParent(),
      makeFacts(),
      abort.signal,
      { warn: () => {}, info: () => {} },
    )
    await delay(10)
    abort.abort(new Error('parent turn stopped'))
    const outcome = await asking

    expect(outcome.decision.kind).toBe('dismissed')
    expect(outcome.override).toBeUndefined()
    expect(outcome.persisted).toBe(false)
    // 诚实：必须说清「没问到、什么都没改」，而不是假装用户选了某档。
    expect(outcome.summary).toContain('could not ask')
    expect(outcome.summary).toContain('nothing was changed')
    // 零状态写入：会话覆盖与预设都不许动。
    expect(svc.modelOverrideOf(SESSION, 'research')).toBeUndefined()
    expect(svc.modelOverrideOf(SESSION, 'worker')).toBeUndefined()
    expect(writes).toEqual([])
  }, 2000)

  it('★ 信号已 abort ⇒ 连通道都不派发（不制造无人认领的 pending）', async () => {
    const svc = new CorumOrchestration(new Context())
    const { channel, calls } = makeChannel()
    const abort = new AbortController()
    abort.abort(new Error('already gone'))
    const outcome = await corumAskAboutModelUnlessStale(
      { state: corumDelegationPolicyStateFrom(svc), channel },
      makeParent(),
      makeFacts(),
      abort.signal,
      { warn: () => {}, info: () => {} },
    )
    expect(outcome.decision.kind).toBe('dismissed')
    expect(outcome.summary).toContain('could not ask')
    expect(calls).toBe(0)
  }, 2000)

  it('★ 正向控制：通道先作答、信号后 abort ⇒ 决定照常落地（race 不误伤正常路径）', async () => {
    const svc = new CorumOrchestration(new Context())
    const { profile, writes } = makeProfile()
    const { channel, answer } = makeChannel()
    const abort = new AbortController()
    const asking = corumAskAboutModelUnlessStale(
      { state: corumDelegationPolicyStateFrom(svc), channel, profile },
      makeParent(),
      makeFacts(),
      abort.signal,
      { warn: () => {}, info: () => {} },
    )
    await delay(10)
    answer('retry')
    const outcome = await asking
    abort.abort(new Error('too late'))

    expect(outcome.decision.kind).toBe('retry')
    expect(outcome.override).toEqual(CONFIGURED)
    expect(writes).toEqual([])
  }, 2000)
})

describe('② corumModelAskRaceAbort 纯函数四格', () => {
  it('work 先落地 ⇒ 正常返回（并解绑监听）', async () => {
    const abort = new AbortController()
    const work = delay(5).then(() => 'done')
    await expect(corumModelAskRaceAbort(work, abort.signal)).resolves.toBe('done')
    abort.abort() // 不应产生任何副作用
  })

  it('★ abort 先发生 ⇒ 以 signal.reason 拒绝（即使 work 永不落地）', async () => {
    const abort = new AbortController()
    const never = new Promise<string>(() => {})
    const race = corumModelAskRaceAbort(never, abort.signal)
    const reason = new Error('timeout')
    abort.abort(reason)
    await expect(race).rejects.toBe(reason)
  }, 2000)

  it('预先 abort ⇒ 立即拒绝', async () => {
    const abort = new AbortController()
    const reason = new Error('pre-aborted')
    abort.abort(reason)
    await expect(corumModelAskRaceAbort(Promise.resolve('x'), abort.signal)).rejects.toBe(reason)
  })

  it('★ 输掉 race 的 work 晚到 reject ⇒ 不变成 unhandled rejection', async () => {
    const abort = new AbortController()
    let failWork!: (error: Error) => void
    const work = new Promise<string>((_, reject) => { failWork = reject })
    const race = corumModelAskRaceAbort(work, abort.signal)
    abort.abort(new Error('abort wins'))
    await expect(race).rejects.toThrow('abort wins')
    // work 在 race 已收口后才 reject：必须已被 race 的 then 消费，不炸进程。
    failWork(new Error('late failure'))
    await delay(10)
  }, 2000)
})