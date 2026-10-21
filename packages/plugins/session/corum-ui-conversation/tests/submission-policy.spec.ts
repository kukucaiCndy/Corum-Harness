/**
 * ComposerSubmissionPolicy 守卫 —— 「忙碌时按 Enter 会发生什么」的唯一裁决点。
 *
 * 这条策略是**用户可感知的语义**：Agent 正在跑的时候按 Enter，消息是排队
 * （queue）还是插话（steer）。三条不变式是全部要点：
 *
 * 1. **不忙或传输不支持插话 ⇒ 恒 queue**。这一条优先于用户偏好 —— 偏好只在
 *    "能插话"的场景下有含义，否则等于给用户一个静默失效的开关。
 * 2. **普通 Enter 用偏好值**，**加速 Enter（Cmd/Ctrl）是偏好的反值**。也就是说
 *    用户永远有一个"临时反悔"的快捷键，不需要先去设置里改。
 * 3. **持久化 scope 是唯一事实源**：scope 上出现新值 ⇒ 采用它；但采用时
 *    **不得写回**（否则会把别的窗口写下的值再广播一遍，形成回环）。
 *
 * 第 3 条用假 SettingsScope 直接驱动，测的是"订阅真的被调用了"与"没有回写"，
 * 这两点都没有实机可观测的等价物。
 */
import { describe, expect, it, vi } from 'vitest'
import { ComposerSubmissionPolicy } from '../src/client/input/submission-policy.ts'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConversationSettings } from '../src/submission-settings.ts'
import type { BusyEnterBehavior } from '../src/submission-settings.ts'

/**
 * 一个最小 SettingsScope：可主动推送新段值、记录 set 调用。
 * 只实现被测代码真正触碰的面（getSnapshot / subscribe / set）。
 */
function fakeScope(initial?: Partial<ConversationSettings>) {
  let value = initial === undefined ? undefined : { busyEnter: 'queue', ...initial } as ConversationSettings
  const listeners = new Set<() => void>()
  const setCalls: { field: string; value: unknown }[] = []
  const scope = {
    getSnapshot: () => ({ value }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field: string, next: unknown) => {
      setCalls.push({ field, value: next })
    },
  } as unknown as SettingsScope<ConversationSettings>
  return {
    scope,
    setCalls,
    /** 模拟"别的窗口/别的写入者"发布了一个新段值。 */
    publish(next: Partial<ConversationSettings>) {
      value = { busyEnter: 'queue', ...next } as ConversationSettings
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
}

describe('ComposerSubmissionPolicy · 分辨率', () => {
  it('不忙 ⇒ queue（与偏好、与手势无关）', () => {
    const policy = new ComposerSubmissionPolicy()
    policy.setBusyEnter('steer')
    expect(policy.resolve(false, 'enter', true)).toBe('queue')
    expect(policy.resolve(false, 'accelerated', true)).toBe('queue')
  })

  it('传输不支持插话 ⇒ queue（偏好静默失效而不是报错）', () => {
    const policy = new ComposerSubmissionPolicy()
    policy.setBusyEnter('steer')
    expect(policy.resolve(true, 'enter', false)).toBe('queue')
    expect(policy.resolve(true, 'accelerated', false)).toBe('queue')
  })

  it('忙 + 可插话 + 普通 Enter ⇒ 偏好值', () => {
    const policy = new ComposerSubmissionPolicy()
    expect(policy.resolve(true, 'enter', true)).toBe('queue')
    policy.setBusyEnter('steer')
    expect(policy.resolve(true, 'enter', true)).toBe('steer')
  })

  it('忙 + 可插话 + 加速 Enter ⇒ 偏好的**反值**（临时反悔快捷键）', () => {
    const policy = new ComposerSubmissionPolicy()
    expect(policy.resolve(true, 'accelerated', true)).toBe('steer')
    policy.setBusyEnter('steer')
    expect(policy.resolve(true, 'accelerated', true)).toBe('queue')
  })

  it('默认偏好是 queue', () => {
    expect(new ComposerSubmissionPolicy().busyEnter.getSnapshot()).toBe('queue')
  })
})

describe('ComposerSubmissionPolicy · 本地状态与持久化', () => {
  it('setBusyEnter 立刻发布到 live store', () => {
    const policy = new ComposerSubmissionPolicy()
    const seen: BusyEnterBehavior[] = []
    policy.busyEnter.subscribe(() => { seen.push(policy.busyEnter.getSnapshot()) })
    policy.setBusyEnter('steer')
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
    expect(seen).toEqual(['steer'])
  })

  it('设为同值 ⇒ 不发布、不写回（去抖）', () => {
    const fake = fakeScope({ busyEnter: 'queue' })
    const policy = new ComposerSubmissionPolicy(fake.scope)
    const listener = vi.fn()
    policy.busyEnter.subscribe(listener)
    const before = fake.setCalls.length
    policy.setBusyEnter('queue')
    expect(listener).not.toHaveBeenCalled()
    expect(fake.setCalls.length).toBe(before)
  })

  it('无 scope（进程内组合）⇒ 只改本地，不抛错', () => {
    const policy = new ComposerSubmissionPolicy()
    expect(() => policy.setBusyEnter('steer')).not.toThrow()
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
  })

  it('setBusyEnter 把字段名写进 scope.set（字段名与 schema 一致）', () => {
    const fake = fakeScope()
    const policy = new ComposerSubmissionPolicy(fake.scope)
    policy.setBusyEnter('steer')
    expect(fake.setCalls).toEqual([{ field: 'busyEnter', value: 'steer' }])
  })
})

describe('ComposerSubmissionPolicy · 采用外部写入', () => {
  it('构造时采用 scope 已有值（不靠默认值起跑）', () => {
    const fake = fakeScope({ busyEnter: 'steer' })
    const policy = new ComposerSubmissionPolicy(fake.scope)
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
  })

  it('构造时采用**不**写回 scope（避免回环广播）', () => {
    const fake = fakeScope({ busyEnter: 'steer' })
    new ComposerSubmissionPolicy(fake.scope)
    expect(fake.setCalls).toEqual([])
  })

  it('scope 后续发布新值 ⇒ 被采用', () => {
    const fake = fakeScope({ busyEnter: 'queue' })
    const policy = new ComposerSubmissionPolicy(fake.scope)
    fake.publish({ busyEnter: 'steer' })
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
  })

  it('scope 发布与当前相同的值 ⇒ 不重复发布', () => {
    const fake = fakeScope({ busyEnter: 'steer' })
    const policy = new ComposerSubmissionPolicy(fake.scope)
    const listener = vi.fn()
    policy.busyEnter.subscribe(listener)
    fake.publish({ busyEnter: 'steer' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('scope 的段值为 undefined（未落盘）⇒ 保留当前值', () => {
    const policy = new ComposerSubmissionPolicy()
    policy.setBusyEnter('steer')
    const fake = fakeScope()
    // 新建一个带空 scope 的策略不会影响已有实例；这里验证空段不覆盖。
    const adopted = new ComposerSubmissionPolicy(fake.scope)
    expect(adopted.busyEnter.getSnapshot()).toBe('queue')
  })

  it('每次都采用 -> 订阅只挂一次（不随发布增长）', () => {
    const fake = fakeScope({ busyEnter: 'queue' })
    new ComposerSubmissionPolicy(fake.scope)
    expect(fake.listenerCount()).toBe(1)
    fake.publish({ busyEnter: 'steer' })
    expect(fake.listenerCount()).toBe(1)
  })
})
