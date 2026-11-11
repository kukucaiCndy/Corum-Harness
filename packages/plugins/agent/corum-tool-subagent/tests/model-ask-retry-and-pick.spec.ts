/**
 * issue #166（可做子集）的回归网：**「重试」档**与**「临时档指定模型」**。
 *
 * ## 为什么这两件事必须同时落地
 *
 * 旧面板只有「临时用主模型 / 永久跟随 / 永久改指定模型 / 不重试」四档，于是：
 *
 * 1. **瞬时故障被当成配置损坏**：限流、超时、网关抖动都会弹出这个面板，而面板里**没有**
 *    「什么都不改，就照原样再试一次」的按钮。用户只能选一个带副作用的档位（临时/永久换
 *    模型）或放弃——一次抖动被迫写成配置变更。故新增 `retry` 档：不写任何状态，拿原路由
 *    重派。
 * 2. **临时档不能指定模型**：它的实现恒取父路由，而 UI 的 `modelAskNeedsRoute` 又只在
 *    「永久改指定模型」时展开模型选择——「这次用 A 模型试一下」在产品上根本表达不出来。
 *    故 `temporary` 现在可以携带指定路由，但**只用于本次任务**，且 host 必须先确认这条
 *    路由真的存在于可用模型清单里。
 *
 * ## 断言什么
 *
 * ① `retry`：不写会话覆盖、不写预设，重派用的仍是**用户原来那条**路由；
 * ② `temporary` + 指定路由：本次生效，且会话级覆盖**不留痕**（下一次派发恢复原样）；
 * ③ `temporary` + 非法（或无法确认）路由：退回父路由，且**结果里能看出回落**（不静默）；
 * ④ `permanent-follow` 仍写 `'follow-main'` 哨兵（防回归）；
 * ⑤ `decline` 不动委派能力（2026-09-19 用户实测纠正的语义，防回归）。
 *
 * 用的是**真服务**（`new CorumOrchestration(new Context())`）+ **真转发工厂** +
 * **真询问核**，只把「提问通路」「父 Agent」「预设写入面」「模型清单」换成桩——
 * 第②③条的「不留痕 / 有回落」分别住在真服务与真询问核里，用假覆盖面验不出来。
 *
 * @module @corum/corum-tool-subagent/tests/model-ask-retry-and-pick
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CorumOrchestration } from '../src/index.ts'
import {
  FOLLOW_MAIN,
  corumAskAboutModelUnlessStale,
  corumDelegationPolicyStateFrom,
  corumModelRouteIsAvailable,
  corumResetModelAskLocks,
  type CorumModelAskOutcome,
  type CorumModelCatalog,
  type CorumProfileWriteFace,
  type CorumRoute,
} from '../src/model-ask-run.ts'
import {
  corumModelAskOptions,
  corumResolveModelAskDecision,
  type CorumModelFailureFacts,
} from '../src/model-ask.ts'

afterEach(() => {
  corumResetModelAskLocks()
})

const SESSION = 'corum-task-issue166'
/** 用户为该角色配置的模型（= 失败的那个，也就是「原路由」）。 */
const CONFIGURED = { provider: 'p-configured', model: 'm-configured' }
/** 父 Agent 的真实路由（= 机制的 fallback）。 */
const PARENT_ROUTE = { provider: 'p-main', model: 'm-main' }
/** 用户在面板里挑的另一条模型（真实存在于清单里）。 */
const PICKED = { provider: 'p-alt', model: 'm-alt' }

/** 一份可用模型清单（`temporary` 的指定路由在此校验）。 */
const CATALOG_ENTRIES = [
  { provider: 'p-main', label: 'Main', models: [{ model: 'm-main', label: 'Main' }] },
  { provider: 'p-alt', label: 'Alt', models: [{ model: 'm-alt', label: 'Alt' }] },
]

/** 造父 Agent 桩（本核只需要 `session.id`）。 */
function makeParent(sessionId: string = SESSION): Agent {
  return { session: { id: sessionId }, ctx: {} } as unknown as Agent
}

/** 造失败事实（配置路由已失败，机制手上有父路由）。 */
function makeFacts(role: 'worker' | 'research' = 'worker'): CorumModelFailureFacts {
  return {
    label: '模型卡片纵向布局',
    role,
    configured: { ...CONFIGURED },
    fallback: { ...PARENT_ROUTE },
    cause: 'rate limited (429)',
  }
}

/** 预设写入面的记账桩（`permanent-follow` 必须写 `'follow-main'`，`retry`/`temporary` 一个字都不许写）。 */
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

/**
 * 可列举的模型清单桩（= host 下发给 client 的同一份）。
 *
 * ⚠️ 参数**刻意不给默认值**：`undefined` 在这里是「清单列举失败」的有效取值，而 JS 的
 * 默认参数会把显式传入的 `undefined` 换回默认值 ⇒ 这条用例会静默变成「清单可用」（本文件
 * 第一版就踩了，表现是「无法确认」分支怎么跑都不回落）。
 */
function makeCatalog(entries: typeof CATALOG_ENTRIES | undefined): CorumModelCatalog {
  return {
    listRoutes: async () => {
      if (entries === undefined) throw new Error('model listing unavailable')
      return entries
    },
  }
}

/**
 * 跑一次真链路：陈旧闸门 → 至多一次询问 → 解析 → 落地。
 *
 * @param answer - client 回传的档位（协议键 + 可选路由）。
 * @param options - 覆盖项：`catalogEntries: undefined` = 清单列举失败（无法确认路由是否存在）。
 */
async function ask(
  answer: { kind: string, route?: CorumRoute },
  options: { catalogEntries?: typeof CATALOG_ENTRIES | undefined } = {},
): Promise<{
  outcome: CorumModelAskOutcome
  svc: CorumOrchestration
  writes: { sessionId: string, role: 'worker' | 'research', route: CorumRoute | typeof FOLLOW_MAIN | undefined }[]
}> {
  const svc = new CorumOrchestration(new Context())
  const { profile, writes } = makeProfile()
  const outcome = await corumAskAboutModelUnlessStale(
    {
      state: corumDelegationPolicyStateFrom(svc),
      channel: { call: async () => answer as never },
      profile,
      catalog: makeCatalog('catalogEntries' in options ? options.catalogEntries : CATALOG_ENTRIES),
    },
    makeParent(),
    makeFacts(),
    new AbortController().signal,
    { warn: () => {}, info: () => {} },
  )
  return { outcome, svc, writes }
}

describe('① retry 档 —— 原路由重派，不写任何覆盖、不记忆', () => {
  it('★ 重派用的是**用户原来那条**路由（不是主 Agent 路由），且状态面一个字都没写', async () => {
    const { outcome, svc, writes } = await ask({ kind: 'retry' })

    expect(outcome.decision.kind).toBe('retry')
    // 「原路由」= 当初为他配置的那条。若这里变成 PARENT_ROUTE，就把一次限流做成了配置变更。
    expect(outcome.override, '重试必须拿原路由重派，而不是悄悄换成主 Agent 的模型').toEqual(CONFIGURED)
    // 会话级覆盖不留痕 ⇒ 后续新派发仍按他的配置（失败就再问一次，这是既有语义）。
    expect(svc.modelOverrideOf(SESSION, 'worker')).toBeUndefined()
    expect(svc.modelOverrideOf(SESSION, 'research')).toBeUndefined()
    // 预设一个字都没写。
    expect(writes, 'retry 不许写预设').toEqual([])
    expect(outcome.persisted).toBe(false)
    // 文案不许暗示配置变了。
    expect(outcome.summary).not.toMatch(/permanently/i)
    expect(outcome.summary).toContain(`${CONFIGURED.provider}/${CONFIGURED.model}`)
  })

  it('★ client 即便捎带一条 route，retry 也不采信（重试=不换模型）', () => {
    expect(corumResolveModelAskDecision('retry', PARENT_ROUTE, PICKED)).toEqual({ kind: 'retry' })
  })

  it('机制词汇表里有 retry 档（面板由此渲染出显式按钮）', () => {
    const retry = corumModelAskOptions().find(option => option.kind === 'retry')
    expect(retry, 'retry 档不在机制词汇表里 ⇒ 面板不会渲染该按钮').toBeDefined()
    expect(retry?.label).toContain('再试一次')
    // 最保守的一档排最前（不写任何状态）。
    expect(corumModelAskOptions()[0]?.kind).toBe('retry')
  })
})

describe('② temporary + 指定路由 —— 本次生效，结束后恢复', () => {
  it('★ 用户挑的模型就是本次重跑的路由，且不写会话覆盖 / 不写哨兵 / 不写预设', async () => {
    const { outcome, svc, writes } = await ask({ kind: 'temporary', route: PICKED })

    expect(outcome.decision.kind).toBe('temporary')
    expect(outcome.override, '临时档现在应当采纳用户指定且合法的路由').toEqual(PICKED)
    // 「仅本次任务」：状态面必须干净 —— 覆盖一旦写下去，后续每一次派发都被污染。
    expect(svc.modelOverrideOf(SESSION, 'worker')).toBeUndefined()
    expect(svc.modelOverrideOf(SESSION, 'worker')).not.toBe(FOLLOW_MAIN)
    expect(writes).toEqual([])
    expect(outcome.persisted).toBe(false)
    // 文案仍点明 one-shot。
    expect(outcome.summary).toContain('one-shot')
  })

  it('research 角色同样只作用于本次（角色键都不许留下痕迹）', async () => {
    const svc = new CorumOrchestration(new Context())
    const { profile, writes } = makeProfile()
    const outcome = await corumAskAboutModelUnlessStale(
      {
        state: corumDelegationPolicyStateFrom(svc),
        channel: { call: async () => ({ kind: 'temporary', route: PICKED }) as never },
        profile,
        catalog: makeCatalog(CATALOG_ENTRIES),
      },
      makeParent(),
      makeFacts('research'),
      new AbortController().signal,
      { warn: () => {}, info: () => {} },
    )
    expect(outcome.override).toEqual(PICKED)
    expect(svc.modelOverrideOf(SESSION, 'research')).toBeUndefined()
    expect(writes).toEqual([])
  })

  it('没带路由 = 用主 Agent 模型（临时档的原始语义，不许因新增能力而变）', async () => {
    const { outcome } = await ask({ kind: 'temporary' })
    expect(outcome.override).toEqual(PARENT_ROUTE)
    expect(outcome.decision).toEqual({ kind: 'temporary', route: PARENT_ROUTE })
  })
})

describe('③ temporary + 非法/无法确认的路由 —— 退回 fallback 并如实告知', () => {
  it('★ 清单里没有这条 provider/model ⇒ 退回父路由，且 route 与文案都写明回落', async () => {
    const ghost = { provider: 'p-ghost', model: 'm-ghost' }
    const { outcome, svc, writes } = await ask({ kind: 'temporary', route: ghost })

    expect(outcome.override, '非法路由不许拿去重跑（会再吃一次「模型不可用」）').toEqual(PARENT_ROUTE)
    expect(outcome.decision).toEqual({ kind: 'temporary', route: PARENT_ROUTE, fellBackFrom: ghost })
    // 「如实告知」：通知文本必须能读出「你要的没用上、实际跑的是哪条」。
    expect(outcome.summary).toContain(`${ghost.provider}/${ghost.model}`)
    expect(outcome.summary).toContain(`${PARENT_ROUTE.provider}/${PARENT_ROUTE.model}`)
    expect(outcome.summary).toMatch(/not in the available model list/)
    // 回落也只作用于本次：不留任何状态。
    expect(svc.modelOverrideOf(SESSION, 'worker')).toBeUndefined()
    expect(writes).toEqual([])
  })

  it('★ 清单列举失败（无法确认）⇒ 同样退回父路由并告知，不冒险跑一条没验过的路由', async () => {
    const { outcome } = await ask({ kind: 'temporary', route: PICKED }, { catalogEntries: undefined })
    expect(outcome.override).toEqual(PARENT_ROUTE)
    expect(outcome.decision).toEqual({ kind: 'temporary', route: PARENT_ROUTE, fellBackFrom: PICKED })
    expect(outcome.summary).toMatch(/could not be confirmed/)
  })

  it('纯判定：provider 命中但 model 不在清单里 ⇒ 也算不可用', () => {
    expect(corumModelRouteIsAvailable(CATALOG_ENTRIES, PICKED)).toBe(true)
    expect(corumModelRouteIsAvailable(CATALOG_ENTRIES, { provider: 'p-alt', model: 'm-nope' })).toBe(false)
    expect(corumModelRouteIsAvailable([], PICKED)).toBe(false)
  })
})

describe('④ permanent-follow 仍写哨兵（防回归）', () => {
  it('★ 写的是 FOLLOW_MAIN 而不是 undefined，并补齐会话级覆盖让本进程立即生效', async () => {
    const { outcome, svc, writes } = await ask({ kind: 'permanent-follow' })

    expect(outcome.decision.kind).toBe('permanent-follow')
    expect(writes, '「永久跟随主 Agent」必须写哨兵；写 undefined 会被全局档接管').toEqual([
      { sessionId: SESSION, role: 'worker', route: FOLLOW_MAIN },
    ])
    expect(outcome.persisted).toBe(true)
    // 当前进程必须立即生效（预设只对新会话有效）。
    expect(svc.modelOverrideOf(SESSION, 'worker')).toEqual(PARENT_ROUTE)
    expect(outcome.override).toEqual(PARENT_ROUTE)
  })
})

describe('⑤ decline 不动委派能力（防回归）', () => {
  it('★ 只表示「本次不重试」：不写预设、不重跑，且状态面上没有「禁用委派」这种东西', async () => {
    const { outcome, svc, writes } = await ask({ kind: 'decline' })

    expect(outcome.decision.kind).toBe('decline')
    // 不重跑：调用方按 `asked.route === undefined` 把失败原样交回。
    expect(outcome.override).toBeUndefined()
    expect(writes, 'decline 不许改用户配置').toEqual([])
    // 会话级临时决定作废（既有语义），委派能力本身不受影响。
    expect(svc.modelOverrideOf(SESSION, 'worker')).toBeUndefined()
    expect(Object.keys(svc)).not.toContain('disableDelegation')
    // 文案必须明说能力不变（2026-09-19 用户实测纠正：说不清会让主 Agent 自己全干了）。
    expect(outcome.summary).toMatch(/UNCHANGED/)
    expect(outcome.summary).toMatch(/may still delegate/)
  })
})