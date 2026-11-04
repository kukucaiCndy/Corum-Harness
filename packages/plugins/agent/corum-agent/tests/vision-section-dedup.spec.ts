/**
 * 视觉能力段在装配里**恰好一份**（2026-09-21 实机缺陷的回归）。
 *
 * ## 缺陷现场
 *
 * 用户会话 `corum-task-5b48662f` 的 system prompt 里
 * 「You can see images in this conversation…」**逐字节重复两遍**（`sys` 26589 字符）。
 *
 * 根因：`system-prompt/assemble` 是 cordis **waterfall** —— 每层 `await next()` 拿到的都是
 * **外层已完成**的装配。本包的 acceptor 原先**直接 append**，于是它被装两层时就写出两份
 * （装两层的原因：建会话装一层，切换 preset 走 fallback 分支又装一层）。
 *
 * ## 修法与它为什么不再是「防重复 append」的补丁
 *
 * 幂等性放在**装配层**：先剔除同名 `corum:vision` 段，再按需插入一份。于是无论 acceptor
 * 被装几层，最终都是恰好一份。**不碰 disposer / 监听生死**（我第一版那样改，动到了模型
 * 绑定的 waterfall 语义，已撤回）。
 *
 * ## 这个文件测什么
 *
 * 用**模拟 waterfall**（两层 acceptor 串联、每层调一次真实的 install）跑真实调用链，
 * 断言最终装配里视觉段**恰好一份**、并且把「是否支持视觉」两种取值都覆盖到。
 *
 * ⚠️ 为什么必须跑真装配而不能只查源码文本：这条缺陷是**运行期叠加**出来的
 * （单层永远看不出问题），而且修法涉及 `sections` 的类型/引用语义 —— 只读文本会把
 * 「一层里就重复」和「两层才重复」混为一谈。
 *
 * @module @corum/corum-agent/tests/vision-section-dedup
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installTaskModelSelection } from '../src/task-model-selection.ts'
import { VISION_CAPABILITY, VISION_SECTION } from '../src/vision.ts'

interface Assembly {
  sections: Array<{ name: string, text: string }>
  contexts: unknown[]
  tools: unknown[]
  variables: Record<string, unknown>
}

/**
 * 模拟一个 agentCtx 的 `system-prompt/assemble` waterfall。
 *
 * `on` 只收本事件；`llm` 提供视觉能力查询（本文件用它控制「是否注入视觉段」）。
 */
function makeCtx(inputModalities: string[]): {
  ctx: Context
  agent: Agent
  run: () => Promise<Assembly>
  installedLayers: () => number
} {
  const layers: Array<(a: unknown, c: unknown, next: () => Promise<Assembly>) => Promise<Assembly>> = []
  const agent = { session: { id: 's1' } } as unknown as Agent
  const ctx = {
    get: () => undefined,
    on: (event: string, handler: unknown) => {
      if (event === 'system-prompt/assemble') {
        layers.push(handler as (typeof layers)[number])
      }
      return () => {
        const i = layers.indexOf(handler as (typeof layers)[number])
        if (i >= 0) layers.splice(i, 1)
      }
    },
    llm: { resolveModelInfo: async () => ({ inputModalities }) },
    agent,
  } as unknown as Context

  const base: Assembly = { sections: [{ name: 'base', text: 'base text' }], contexts: [], tools: [], variables: {} }
  /** 按 cordis waterfall 语义跑：索引递增，最后一层返回 base。 */
  const run = async (): Promise<Assembly> => {
    let i = -1
    const next = async (): Promise<Assembly> => {
      i += 1
      const layer = layers[i]
      if (layer === undefined) return base
      return layer(undefined, undefined, next)
    }
    return next()
  }
  return { ctx, agent, run, installedLayers: () => layers.length }
}

const visionCount = (a: Assembly): number => a.sections.filter(s => s.name === VISION_SECTION).length

describe('视觉能力段：装配后恰好一份', () => {
  it('单层安装（基线）：恰好一份，且排在末尾', async () => {
    const { ctx, agent, run } = makeCtx(['text', 'image'])
    installTaskModelSelection(ctx, agent, { current: { provider: 'p', model: 'm' }, assembled: undefined })
    const a = await run()
    expect(visionCount(a)).toBe(1)
    expect(a.sections[a.sections.length - 1]?.name).toBe(VISION_SECTION)
    // 外层既有的段必须原样保留
    expect(a.sections.some(s => s.name === 'base')).toBe(true)
  })

  it('★ 两层安装（实机缺陷形态）：仍恰好一份', async () => {
    const { ctx, agent, run, installedLayers } = makeCtx(['text', 'image'])
    // 建会话装一层；切 preset 的 fallback 分支又装一层（同一 agentCtx）
    installTaskModelSelection(ctx, agent, { current: { provider: 'p', model: 'first' }, assembled: undefined })
    installTaskModelSelection(ctx, agent, { current: { provider: 'p', model: 'second' }, assembled: undefined })
    expect(installedLayers()).toBe(2)
    const a = await run()
    expect(visionCount(a), '恰好一份 —— 实机缺陷形态下这里会是 2').toBe(1)
  })

  it('★ 三层安装也一样（幂等是结构性的，不是「两层特例」）', async () => {
    const { ctx, agent, run } = makeCtx(['text', 'image'])
    for (const m of ['a', 'b', 'c']) {
      installTaskModelSelection(ctx, agent, { current: { provider: 'p', model: m }, assembled: undefined })
    }
    expect(visionCount(await run())).toBe(1)
  })

  it('模型不支持视觉 ⇒ 一份都不注入（去重不能把它变成「总有一份」）', async () => {
    const { ctx, agent, run } = makeCtx(['text'])
    installTaskModelSelection(ctx, agent, { current: { provider: 'p', model: 'm' }, assembled: undefined })
    installTaskModelSelection(ctx, agent, { current: { provider: 'p', model: 'm2' }, assembled: undefined })
    const a = await run()
    expect(visionCount(a)).toBe(0)
    /**
     * ⚠️ 这里实测出一条**真实语义**（我第一版断言写反了，实现没错）：
     * `variables.model` 最终是**外层（创建时那次）**的值 `m`，不是后装的 `m2`。
     *
     * 原因：cordis waterfall 是「外层先执行 → `await next()` 拿到内层结果 → **再覆盖**」，
     * 所以**最后落笔的是外层**。这正是本仓注释里那句
     * 「不能靠重装安装覆盖 —— 后装的监听会被创建时的外层监听盖回」的实证。
     *
     * ⇒ 连带的正确结论：**视觉段的注入与否，也应以本层自己的 `selected` 为准**（本实现如此），
     * 而「装配出的 model 变量」由外层决定；两者不一致是既有设计的结果，不是本改动的产物。
     * 请求侧真正生效的模型走 `agent/request` 的 `selection.assembled`，不依赖这里的 variables。
     */
    expect(a.variables).toMatchObject({ provider: 'p', model: 'm' })
  })

  it('★ 外层已带一份视觉段时，最终也只有一份（去重是结构性的，不只是防本层重复）', async () => {
    const { ctx, agent, run } = makeCtx(['text', 'image'])
    installTaskModelSelection(ctx, agent, { current: { provider: 'p', model: 'm' }, assembled: undefined })
    const a = await run()
    expect(visionCount(a)).toBe(1)
    // 再跑一次（模拟同一装配被复用/重入）不应累积
    const b = await run()
    expect(visionCount(b)).toBe(1)
  })

  it('视觉段文本用的仍是 vision.ts 的单一事实源', async () => {
    const { ctx, agent, run } = makeCtx(['text', 'image'])
    installTaskModelSelection(ctx, agent, { current: { provider: 'p', model: 'm' }, assembled: undefined })
    const a = await run()
    const sec = a.sections.find(s => s.name === VISION_SECTION)
    expect(sec?.text).toBe(VISION_CAPABILITY)
  })
})
