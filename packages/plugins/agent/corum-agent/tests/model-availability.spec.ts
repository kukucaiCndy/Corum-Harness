/**
 * fork（corum）2026-09-26：**预设引用了已被删除的模型 ⇒ 回落全局默认 + 显式告知**。
 *
 * ## 由来（用户报障 + 定调）
 *
 * 用户手动删除了 `kimi-k3-1` 模型（原话：「这个模型是我手动删除了」），但 conductor-lead
 * 预设里存的仍是它 ⇒ 每个新指挥会话第一句就 `UNKNOWN_MODEL` 硬失败（实测
 * `corum-task-b36de140`，整轮什么都没干成）。用户定调：
 *
 * > 「预设的 Agent 应该同步回落到全局设置。而不是继续用一个不存在的模型。」
 * > 「我 9 月 18 日的功能主要是在**运行过程中发生的非用户删除因素**，是两个不同的概念。」
 *
 * ## 本文件钉住的判据
 *
 * ① **配置缺失 vs 运行期失败**是两个概念：本模块只处理前者（事前、确定性）；后者仍走
 *    用户 2026-09-18 拍板的「问用户」通路（那些断言在 `corum-tool-subagent` 的
 *    `model-policy.spec.ts` / `prompt-mechanism-agreement.spec.ts`，本文件不重复）。
 * ② **回落目标恒为全局默认**（`agentDefaultModel`），不是硬编码某一档。
 * ③ **可用时不回落**（绝不因为「全局默认更保险」改掉用户的选择）。
 * ④ `llm` 缺席 ⇒ 不校验、原样透传（不猜着改用户配置）。
 * ⑤ 回落**不改用户配置**（文案里不得承诺「已永久修改预设」——措辞纪律）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { makeHarness } from './harness.ts'
import type { ProfileModel } from '../src/profile.ts'
import {
  deliverModelFallbackNotice,
  effectiveProfileModel,
  globalDefaultModel,
  modelFallbackNotice,
  resolveUsableModel,
} from '../src/model-availability.ts'

/** 建一个带 `llm` / `agentDefaultModel` 的最小上下文。 */
function makeCtx(options: {
  defaultModel: ProfileModel
  available?: readonly string[]
  provider?: string
}): { ctx: Context, notices: unknown[] } {
  const available = new Set(options.available ?? [])
  const provider = options.provider ?? 'localhost'
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    get(name: string) {
      if (name === 'llm') {
        return {
          resolveModelInfo: (p: string, m: string) => {
            if (p === provider && available.has(m)) return Promise.resolve({ provider: p, id: m, name: m })
            return Promise.reject(new Error(`pi-ai provider "${p}" has no configured model "${m}"`))
          },
        }
      }
      return undefined
    },
    agentDefaultModel: { currentSelection: () => ({ ...options.defaultModel }) },
  } as unknown as Context
  return { ctx, notices: [] }
}

describe('resolveUsableModel — 预设模型已删除时回落全局默认', () => {
  it('★ 配置的模型已不存在 ⇒ 回落到全局默认，并给出回落事实', async () => {
    // 现场复刻：预设写 kimi-k3-1（已删），全局默认是 kimi-k3。
    const { ctx } = makeCtx({ defaultModel: { provider: 'localhost', model: 'kimi-k3', reasoningEffort: 'max' }, available: ['kimi-k3'] })
    const resolved = await resolveUsableModel(ctx, { provider: 'localhost', model: 'kimi-k3-1', reasoningEffort: 'high' })
    expect(resolved.model).toEqual({ provider: 'localhost', model: 'kimi-k3', reasoningEffort: 'max' })
    expect(resolved.fallback).toBeDefined()
    expect(resolved.fallback?.configured).toEqual({ provider: 'localhost', model: 'kimi-k3-1', reasoningEffort: 'high' })
    expect(resolved.fallback?.effective).toEqual({ provider: 'localhost', model: 'kimi-k3', reasoningEffort: 'max' })
    expect(resolved.fallback?.reason).toContain('has no configured model')
  })

  it('★ 配置的模型可用 ⇒ 原样返回、**不回落**、无事实', async () => {
    // 判据③：绝不因为「全局默认更保险」改掉用户的选择。
    const { ctx } = makeCtx({ defaultModel: { provider: 'localhost', model: 'kimi-k3' }, available: ['kimi-k3', 'glm-5.3-flash'] })
    const resolved = await resolveUsableModel(ctx, { provider: 'localhost', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    expect(resolved.model).toEqual({ provider: 'localhost', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    expect(resolved.fallback).toBeUndefined()
  })

  it('★ 配置的就是全局默认且它也不可用 ⇒ 无更优目标，原样返回 + 事实（不掩盖真实错误）', async () => {
    const { ctx } = makeCtx({ defaultModel: { provider: 'localhost', model: 'gone' }, available: [] })
    const resolved = await resolveUsableModel(ctx, { provider: 'localhost', model: 'gone' })
    expect(resolved.model).toEqual({ provider: 'localhost', model: 'gone' })
    expect(resolved.fallback).toBeDefined()
  })

  it('★ `llm` 缺席 ⇒ 不校验、原样透传（不猜着改用户配置）', async () => {
    const ctx = { logger: { warn: () => {} }, get: () => undefined, agentDefaultModel: { currentSelection: () => ({ provider: 'x', model: 'y' }) } } as unknown as Context
    const resolved = await resolveUsableModel(ctx, { provider: 'localhost', model: 'whatever' })
    expect(resolved.model).toEqual({ provider: 'localhost', model: 'whatever' })
    expect(resolved.fallback).toBeUndefined()
  })

  it('provider 存在但 model 被删（同一网关下换模型）同样回落', async () => {
    const { ctx } = makeCtx({ defaultModel: { provider: 'localhost', model: 'deepseek-v4.1-flash' }, available: ['deepseek-v4.1-flash'] })
    const resolved = await resolveUsableModel(ctx, { provider: 'localhost', model: 'deepseek-v4-flash' })
    expect(resolved.model.model).toBe('deepseek-v4.1-flash')
    expect(resolved.fallback).toBeDefined()
  })
})

describe('globalDefaultModel — 回落目标的单一事实源', () => {
  it('读数直接来自 agentDefaultModel.currentSelection()', () => {
    const { ctx } = makeCtx({ defaultModel: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    expect(globalDefaultModel(ctx)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
})

/**
 * 2026-11-03 实机事故：扩展包装进来的预设（如 corum-dev）的 agent.json 不带 model 字段。
 * `loadProfile` 不做 schema 校验 ⇒ `profile.model === undefined` 进入运行期。
 * 创建路径直接读 `profile.model.provider` ⇒ `Cannot read properties of undefined
 * (reading 'provider')`（实测报障：安装 corum-dev-preset 扩展包后选内置 Agent 预设即崩）。
 * `effectiveProfileModel` 是所有创建/切换/resume 路径的统一回填点。
 */
describe('effectiveProfileModel — profile.model 缺失时回填全局默认', () => {
  it('★ model 缺失（undefined）⇒ 回填全局默认，不崩', () => {
    const { ctx } = makeCtx({ defaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    const effective = effectiveProfileModel(ctx, undefined)
    expect(effective).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('★ model 存在 ⇒ 原样返回（不覆盖用户配置）', () => {
    const { ctx } = makeCtx({ defaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    const configured = { provider: 'localhost', model: 'kimi-k3', reasoningEffort: 'high' }
    expect(effectiveProfileModel(ctx, configured)).toEqual(configured)
  })

  it('★ 回填值与 globalDefaultModel 一致（单一事实源）', () => {
    const { ctx } = makeCtx({ defaultModel: { provider: 'p', model: 'm', reasoningEffort: 'max' } })
    expect(effectiveProfileModel(ctx, undefined)).toEqual(globalDefaultModel(ctx))
  })
})

describe('modelFallbackNotice — 用户可见文案', () => {
  const fallback = {
    configured: { provider: 'localhost', model: 'kimi-k3-1' },
    effective: { provider: 'localhost', model: 'kimi-k3' },
    reason: 'pi-ai provider "localhost" has no configured model "kimi-k3-1"',
  }

  it('摘要含「已不可用」与生效模型', () => {
    const notice = modelFallbackNotice(fallback, '新建任务（conductor-lead）')
    expect(notice.summary).toContain('kimi-k3-1')
    expect(notice.summary).toContain('全局默认')
    expect(notice.text).toContain('localhost/kimi-k3-1')
    expect(notice.text).toContain('localhost/kimi-k3')
  })

  it('★ 措辞纪律：**不得**承诺改动了用户的配置（本机制不改配置）', () => {
    // 2026-09-16 `process.prompt.promise-vs-mechanism` 的教训：只说已发生的事实。
    const text = modelFallbackNotice(fallback, '新建任务（conductor-lead）').text
    expect(text).toContain('你的预设配置没有被改动')
    expect(text).not.toMatch(/已(永久)?(修改|更新|改好)(了)?你的?(预设|配置)/)
  })

  it('告知下一步该去哪改（可操作，不是只报错）', () => {
    expect(modelFallbackNotice(fallback, '新建任务').text).toContain('设置 → 智能体')
  })
})

describe('deliverModelFallbackNotice — 投递走 inject（不开 turn）', () => {
  it('★ 用 inject 而非 followup/steer：否则会把 blank 泳道变成非 blank', () => {
    // `findBlankTaskLane` 判 blank 的判据是「无 turn/start」（lane-registry.ts）。
    // followup 会开 turn ⇒ 破坏泳道复用。这里断言只调 inject。
    const calls: string[] = []
    const agent = {
      inject: () => { calls.push('inject') },
      followup: () => { calls.push('followup') },
      steer: () => { calls.push('steer') },
    }
    deliverModelFallbackNotice(agent, {
      configured: { provider: 'a', model: 'b' },
      effective: { provider: 'c', model: 'd' },
      reason: 'gone',
    }, '新建任务', { warn: () => {} })
    expect(calls).toEqual(['inject'])
  })

  it('投递失败只告警，不抛（可见性是增强，不是建会话的前置）', () => {
    const warned: string[] = []
    const agent = { inject: () => { throw new Error('inbox closed') } }
    expect(() => deliverModelFallbackNotice(agent, {
      configured: { provider: 'a', model: 'b' },
      effective: { provider: 'c', model: 'd' },
      reason: 'gone',
    }, '新建任务', { warn: m => warned.push(m) })).not.toThrow()
    expect(warned).toHaveLength(1)
  })

  it('消息来源种类是本包自己的 kind（不是共享 catch-all plugin）', () => {
    const seen: { source?: { kind?: string, form?: string, summary?: string } }[] = []
    const agent = { inject: (m: unknown) => { seen.push(m as { source?: { kind?: string } }) } }
    deliverModelFallbackNotice(agent, {
      configured: { provider: 'a', model: 'b' },
      effective: { provider: 'c', model: 'd' },
      reason: 'gone',
    }, '新建任务（conductor-lead）', { warn: () => {} })
    expect(seen[0]?.source?.kind).toBe('corum-model-fallback')
    expect(seen[0]?.source?.form).toBe('notice')
    // 摘要按官方上限截断（CONTEXT_SUMMARY_MAX_CHARS = 120）
    expect((seen[0]?.source?.summary ?? '').length).toBeLessThanOrEqual(120)
  })
})

/**
 * 去重（2026-09-26 实机发现）：回落告知走 `inject`（不开 turn）⇒ 泳道仍是 blank ⇒ 用户
 * 「连点新建任务」会**复用同一泳道**。实测 `corum-task-5d1fe37e`：两次创建各注入一条完全相同
 * 的告知，用户第一句话前会连着看到两条。故按「会话 + 失效路由」去重。
 */
describe('notifyModelFallbackOnce — 同一会话同一失效路由只说一次', () => {
  function callOnce(h: ReturnType<typeof makeHarness>, sessionId: string, configured: ProfileModel, injected: unknown[]): void {
    const service = h.service as unknown as {
      notifyModelFallbackOnce: (
        sid: string,
        agent: { inject: (m: unknown) => void },
        fallback: { configured: ProfileModel, effective: ProfileModel, reason: string },
        origin: string,
      ) => void
    }
    service.notifyModelFallbackOnce(
      sessionId,
      { inject: m => injected.push(m) },
      { configured, effective: { provider: 'g', model: 'default' }, reason: 'gone' },
      '新建任务（conductor-lead）',
    )
  }

  it('★ 同一会话 + 同一失效路由：第二次不再注入（空白泳道复用会连投两条）', () => {
    const h = makeHarness()
    try {
      const injected: unknown[] = []
      callOnce(h, 'corum-task-x', { provider: 'localhost', model: 'kimi-k3-1' }, injected)
      callOnce(h, 'corum-task-x', { provider: 'localhost', model: 'kimi-k3-1' }, injected)
      expect(injected).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  it('★ 换了一个**不同**的失效模型 ⇒ 是新事实，应当再告知一次', () => {
    const h = makeHarness()
    try {
      const injected: unknown[] = []
      callOnce(h, 'corum-task-x', { provider: 'localhost', model: 'kimi-k3-1' }, injected)
      callOnce(h, 'corum-task-x', { provider: 'localhost', model: 'another-gone-model' }, injected)
      expect(injected).toHaveLength(2)
    } finally {
      h.cleanup()
    }
  })

  it('★ 不同会话互不影响（去重键含 sessionId）', () => {
    const h = makeHarness()
    try {
      const injected: unknown[] = []
      callOnce(h, 'corum-task-a', { provider: 'localhost', model: 'kimi-k3-1' }, injected)
      callOnce(h, 'corum-task-b', { provider: 'localhost', model: 'kimi-k3-1' }, injected)
      expect(injected).toHaveLength(2)
    } finally {
      h.cleanup()
    }
  })
})
