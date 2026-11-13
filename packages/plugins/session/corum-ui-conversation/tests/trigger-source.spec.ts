/**
 * 唤醒消息归因（`source.kind`）的单一判据。
 *
 * ## 为什么单独钉
 *
 * 同一条运行时通知要经过三个消费面：durable 投影（chat 的 message 节点）、pending 插话
 * （chat 的 `PendingSteeringBubble`）、pending 排队（本包的 `QueueDock`）。判据原先只长在
 * chat 的 `TurnTriggerCard` 里 ⇒ 两个 pending 面都不看 `source`，于是子 Agent 的结算账单
 * 在阻塞期间被画成「You 说的话」，阻塞解除后才变回通知行。
 *
 * 判据已下沉到 `trigger-source.ts`（依赖方向 chat → conversation），本文件把**词汇表边界**
 * 钉死：官方 `MessageSourceMap` 的哪些 kind 算唤醒消息，`user` / 未知 / 缺失一律不算
 * （后者必须继续走用户气泡，否则用户自己敲的话会被误判成通知）。
 *
 * @module @corum/corum-ui-conversation/tests/trigger-source
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { TRIGGER_KINDS, triggerSourceOf } from '../src/client/trigger-source.ts'

const INDEX = readFileSync(join(import.meta.dirname, '../src/client/index.ts'), 'utf8')

/** 官方词汇表里全部「不是用户自己敲的」家族。 */
const TRIGGERS = [
  'agent-message',
  'subagent-settled',
  'goal',
  'team-message',
  'schedule',
  'webhook',
  'tool-jobs',
  'cordis-host-runner',
  'request',
] as const

describe('triggerSourceOf — 只认持久化归因', () => {
  it('★ 子 Agent 结算 / Agent 间消息 / 目标推进 都判为唤醒消息', () => {
    expect(triggerSourceOf({ kind: 'subagent-settled' })?.kind).toBe('subagent-settled')
    expect(triggerSourceOf({ kind: 'agent-message' })?.kind).toBe('agent-message')
    expect(triggerSourceOf({ kind: 'goal' })?.kind).toBe('goal')
  })

  it('词汇表其余家族同样被认出（定时 / 外部事件 / 后台任务 / 插件）', () => {
    for (const kind of TRIGGERS) {
      expect(triggerSourceOf({ kind })?.kind).toBe(kind)
      expect(TRIGGER_KINDS.has(kind)).toBe(true)
    }
  })

  it('★ 用户自己的提交（kind: user）不是唤醒消息', () => {
    expect(triggerSourceOf({ kind: 'user', rpcId: 'r1' })).toBeUndefined()
  })

  it('缺失 / 未知 kind / 非对象 / 假值 一律不算（保持用户气泡）', () => {
    expect(triggerSourceOf(undefined)).toBeUndefined()
    expect(triggerSourceOf(null)).toBeUndefined()
    expect(triggerSourceOf({})).toBeUndefined()
    expect(triggerSourceOf({ kind: 'something-new' })).toBeUndefined()
    expect(triggerSourceOf({ kind: 42 })).toBeUndefined()
    expect(triggerSourceOf('text')).toBeUndefined()
    expect(triggerSourceOf(0)).toBeUndefined()
  })

  it('只搬走已知字段，非字符串一律忽略（不让脏 source 冒充归因）', () => {
    expect(triggerSourceOf({ kind: 'subagent-settled', senderSessionId: 's1', summary: 'completed', provider: 'github' }))
      .toMatchObject({ kind: 'subagent-settled', senderSessionId: 's1', summary: 'completed', provider: 'github' })
    expect(triggerSourceOf({ kind: 'subagent-settled', senderSessionId: 7, summary: null }))
      .toStrictEqual({ kind: 'subagent-settled' })
  })
})

describe('导出面', () => {
  it('★ 经包 client 导出面导出（chat 反着引用的唯一通道）', () => {
    expect(INDEX).toContain("export { TRIGGER_KINDS, triggerSourceOf } from './trigger-source.ts'")
    expect(INDEX).toContain("export type { TurnTriggerKind, TurnTriggerSource } from './trigger-source.ts'")
  })

  it('conversation 不许反向依赖 chat（依赖方向单向）', () => {
    const SOURCE = readFileSync(join(import.meta.dirname, '../src/client/trigger-source.ts'), 'utf8')
    expect(SOURCE).not.toContain('corum-ui-chat')
  })
})
