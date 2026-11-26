/**
 * `agent/pre-step` 注入决策的回归网（2026-11-26）。
 *
 * ## 被钉住的不变式
 *
 * **操作只有在「确实进入某一步」后才算已投递。**
 *
 * 旧实现是「先清空待投递列表，再 `await next()`」。下游一旦 `{kind:'reject'}`
 * （goal 轮冲突、被别的监听器拦下）或抛错，这条操作既没进任何 step、也从队列里
 * 消失了：用户以为告诉了 Agent，实际没有，而且没有任何日志体现。这类丢失不像崩溃
 * 那样显眼，只会表现为「Agent 莫名其妙不知道我刚提交过」。
 *
 * 现实现把决策拆成纯函数（`shouldInject` / `injectMessageSpec`），由调用方保证
 * 「先放行、放行成功才注入并清空」；这里钉住纯函数这一半，实机再验另一半。
 */
import { describe, expect, it } from 'vitest'
import {
  INJECT_HEADER,
  buildInjectMessage,
  hasFreshUserMessage,
  injectMessageSpec,
  shouldInject,
} from '../src/pre-step.ts'

/** 造一条带 source 的用户消息。 */
function userMsg(kind?: string): { role: string; source?: { kind: string } } {
  return kind === undefined ? { role: 'user' } : { role: 'user', source: { kind } }
}

describe('hasFreshUserMessage（只认用户新发起的一轮）', () => {
  it('source.kind === user 才算', () => {
    expect(hasFreshUserMessage([userMsg('user')])).toBe(true)
  })

  it('无 source 的历史消息不算（否则每个 step 都会再注入一次）', () => {
    expect(hasFreshUserMessage([userMsg()])).toBe(false)
  })

  it('本插件自己注入的消息不算（防自激）', () => {
    expect(hasFreshUserMessage([userMsg('git-panel')])).toBe(false)
  })

  it('goal 轮 / 子 Agent 轮的源不算', () => {
    expect(hasFreshUserMessage([userMsg('goal-round'), userMsg('subagent')])).toBe(false)
  })

  it('非 user 角色的消息不算', () => {
    expect(hasFreshUserMessage([{ role: 'assistant', source: { kind: 'user' } }])).toBe(false)
  })
})

describe('shouldInject', () => {
  it('无待投递 ⇒ 不注入（「看过不注入」）', () => {
    expect(shouldInject(undefined, [userMsg('user')])).toBe(false)
    expect(shouldInject([], [userMsg('user')])).toBe(false)
  })

  it('有待投递但本步不是用户新轮 ⇒ 不注入（保留到下一轮）', () => {
    expect(shouldInject(['提交：abc'], [userMsg()])).toBe(false)
    expect(shouldInject(['提交：abc'], [userMsg('goal-round')])).toBe(false)
  })

  it('有待投递且是用户新轮 ⇒ 注入', () => {
    expect(shouldInject(['提交：abc'], [userMsg('user')])).toBe(true)
  })
})

describe('注入文本与消息规格', () => {
  it('开头与 UI 预览共用同一句', () => {
    expect(INJECT_HEADER).toBe('[git] 用户在对话外操作了 git，请据此更新认知：')
    expect(buildInjectMessage(['提交：abc']).startsWith(INJECT_HEADER)).toBe(true)
  })

  it('每条操作一行，末尾带「请勿重复」', () => {
    expect(buildInjectMessage(['切换：main → feat/x（成功）', '提交：abc feat(x): y'])).toBe([
      INJECT_HEADER,
      '  · 切换：main → feat/x（成功）',
      '  · 提交：abc feat(x): y',
      '；请勿重复这些操作',
    ].join('\n'))
  })

  it('来源标记是 git-panel（渲染侧据此归为「上下文注入」而不是用户发言）', () => {
    const spec = injectMessageSpec(['提交：abc'])
    expect(spec.source).toEqual({ kind: 'git-panel' })
    expect(spec.content[0].type).toBe('text')
    expect(spec.content[0].text).toContain('提交：abc')
  })
})
