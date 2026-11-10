import { describe, expect, it } from 'vitest'

import { createMutableEvidence, normalizeEpochMs, pushEvidence } from '../src/cdp-client.js'

/**
 * console 真增量（T3）与网络时间口径的回归网。
 *
 * 这组断言对着**已发生的错误判据**写：
 * `Runtime.enable` / `Log.enable` 会把目标页历史 console **回放**一遍，而旧实现
 * 拿「会话构造时刻」当起点、且用 `params.timestamp`（命中不到时取 `Date.now()`）过滤。
 * 结果是：① 回放的历史错误被算成本次脚本的错误（同 fixture 连跑越跑越脏）；
 * ② `Log.entryAdded` 自带的 `entry.timestamp` 被忽略；③ 秒/毫秒混用；
 * ④ 网络请求拿**单调**时间戳去比 **epoch** 起点，判据恒假。
 */

/** 造一条 Log.entryAdded（error 级）事件。 */
function logError(text: string, timestampMs: unknown): [string, Record<string, unknown>] {
  return ['Log.entryAdded', { entry: { level: 'error', text, timestamp: timestampMs } }]
}

/** 造一条 Runtime.consoleAPICalled（error 级）事件。 */
function runtimeError(text: string, timestampMs: unknown): [string, Record<string, unknown>] {
  return ['Runtime.consoleAPICalled', { type: 'error', timestamp: timestampMs, args: [{ value: text }] }]
}

const T0 = 1_700_000_000_000 // 固定 epoch 毫秒（2023-11-14T22:13:20Z）

describe('normalizeEpochMs：秒/毫秒归一', () => {
  it('毫秒原样保留', () => {
    expect(normalizeEpochMs(T0)).toBe(T0)
  })
  it('秒 ×1000 归一为毫秒', () => {
    expect(normalizeEpochMs(T0 / 1000)).toBe(T0)
  })
  it('非法/缺失返回 null（不臆造）', () => {
    expect(normalizeEpochMs(undefined)).toBeNull()
    expect(normalizeEpochMs(null)).toBeNull()
    expect(normalizeEpochMs(0)).toBeNull()
    expect(normalizeEpochMs(-1)).toBeNull()
    expect(normalizeEpochMs(Number.NaN)).toBeNull()
    expect(normalizeEpochMs('1700000000000')).toBeNull()
  })
})

describe('console 屏障（markStart）', () => {
  it('屏障前回放的历史条目只计 preExisting，不进 count/errors', () => {
    const ev = createMutableEvidence()
    // enable 回放的启动期错误（比屏障早 10 秒）
    pushEvidence(ev, ...logError('boot boom', T0 - 10_000))
    pushEvidence(ev, ...runtimeError('boot console.error', T0 - 9_000))

    ev.markStart(T0)
    const s = ev.summary()

    expect(s.console.count).toBe(0)
    expect(s.console.errors).toEqual([])
    expect(s.console.preExisting).toBe(2)
    expect(s.console.windowStartMs).toBe(T0)
    expect(ev.console).toHaveLength(0)
  })

  it('屏障后到达但**时间戳是旧的**（乱序/回放）→ 仍只计 preExisting', () => {
    const ev = createMutableEvidence()
    ev.markStart(T0)

    pushEvidence(ev, 'Log.entryAdded', { entry: { level: 'error', text: 'late replay', timestamp: T0 - 1 } })

    const s = ev.summary()
    expect(s.console.count).toBe(0)
    expect(s.console.errors).toEqual([])
    expect(s.console.preExisting).toBe(1)
  })

  it('混合序列：历史回放 → 屏障 → 本次 live error 不吞', () => {
    const ev = createMutableEvidence()
    pushEvidence(ev, 'Log.entryAdded', { entry: { level: 'error', text: 'old-1', timestamp: T0 - 5_000 } })
    pushEvidence(ev, 'Log.entryAdded', { entry: { level: 'error', text: 'old-2', timestamp: T0 - 4_000 } })

    ev.markStart(T0)
    pushEvidence(ev, 'Runtime.consoleAPICalled', {
      type: 'error',
      timestamp: T0 + 10,
      args: [{ value: 'live boom' }],
    })

    const s = ev.summary()
    expect(s.console.preExisting).toBe(2)
    expect(s.console.count).toBe(1)
    expect(s.console.errors).toHaveLength(1)
    expect(s.console.errors[0]).toContain('live boom')
  })

  it('Log.entryAdded 的秒级 entry.timestamp 被归一后再判窗口', () => {
    const ev = createMutableEvidence()
    ev.markStart(T0)
    // entry.timestamp 给的是秒（T0/1000 + 1 秒）
    pushEvidence(ev, 'Log.entryAdded', { entry: { level: 'error', text: 'sec-unit', timestamp: T0 / 1000 + 1 } })

    expect(ev.summary().console.count).toBe(1)
    expect(ev.summary().console.preExisting).toBe(0)
  })

  it('entry.timestamp 优先于事件级 timestamp', () => {
    const ev = createMutableEvidence()
    ev.markStart(T0)
    // 条目自带旧墙钟（屏障前），事件级 timestamp 是新的 —— 以条目自带的为准
    pushEvidence(ev, 'Log.entryAdded', {
      timestamp: T0 + 1_000,
      entry: { level: 'error', text: 'entry-old', timestamp: T0 - 1_000 },
    })

    expect(ev.summary().console.preExisting).toBe(1)
    expect(ev.summary().console.count).toBe(0)
  })

  it('同一 fixture 连跑两轮不累积：每轮独立收集器只含本轮增量', () => {
    // 第一轮：历史错误 + 屏障 + 一次 live error
    const run1 = createMutableEvidence()
    pushEvidence(run1, 'Log.entryAdded', { entry: { level: 'error', text: 'old', timestamp: T0 - 5_000 } })
    run1.markStart(T0)
    pushEvidence(run1, 'Log.entryAdded', { entry: { level: 'error', text: 'run1', timestamp: T0 + 10 } })

    // 第二轮（同一 fixture，新会话 ⇒ 新收集器）：只有历史错误，没有 live error
    const run2 = createMutableEvidence()
    pushEvidence(run2, 'Log.entryAdded', { entry: { level: 'error', text: 'old', timestamp: T0 - 5_000 } })
    run2.markStart(T0 + 60_000)

    expect(run1.summary().console.errors).toEqual(['run1'])
    expect(run2.summary().console.errors).toEqual([])
    expect(run2.summary().console.count).toBe(0)
    expect(run2.summary().console.preExisting).toBe(1)
  })

  it('没打屏障时条目一律算存量（偏保守，不会假报本次错误）', () => {
    const ev = createMutableEvidence()
    pushEvidence(ev, 'Runtime.consoleAPICalled', {
      type: 'error',
      timestamp: T0,
      args: [{ value: 'no-barrier' }],
    })

    const s = ev.summary()
    expect(s.console.count).toBe(0)
    expect(s.console.errors).toEqual([])
    expect(s.console.preExisting).toBe(1)
    expect(s.console.windowStartMs).toBeNull()
  })
})

describe('network 时间口径（wallTime）', () => {
  it('用 params.wallTime（秒）×1000 作为墙钟；不使用单调 timestamp', () => {
    const ev = createMutableEvidence()
    ev.markStart(T0)
    pushEvidence(ev, 'Network.requestWillBeSent', {
      requestId: 'r1',
      timestamp: 1234.5, // 单调秒（原点在浏览器启动）—— 不是 epoch
      wallTime: T0 / 1000 + 1, // epoch 秒
      request: { url: 'http://127.0.0.1:1/api', method: 'POST' },
    })

    const [entry] = ev.network
    expect(ev.network).toHaveLength(1)
    expect(entry!.timeSource).toBe('wallTime')
    expect(entry!.wallTimeMs).toBe(T0 + 1_000)
  })

  it('屏障前的请求（墙钟可判）被丢弃', () => {
    const ev = createMutableEvidence()
    ev.markStart(T0)
    pushEvidence(ev, 'Network.requestWillBeSent', {
      requestId: 'old',
      wallTime: T0 / 1000 - 5,
      request: { url: 'http://old', method: 'GET' },
    })

    expect(ev.network).toHaveLength(0)
    expect(ev.summary().network.count).toBe(0)
  })

  it('屏障**之前**收进来、墙钟在窗口前的请求，打屏障时被剔除', () => {
    const ev = createMutableEvidence()
    pushEvidence(ev, 'Network.requestWillBeSent', {
      requestId: 'early',
      wallTime: T0 / 1000 - 5,
      request: { url: 'http://early', method: 'GET' },
    })
    expect(ev.network).toHaveLength(1)
    ev.markStart(T0)
    expect(ev.network).toHaveLength(0)
  })

  it('没有 wallTime（只有单调 timestamp 或什么都没有）→ timeSource=unknown，保留且不声称在窗口内', () => {
    const ev = createMutableEvidence()
    ev.markStart(T0)

    pushEvidence(ev, 'Network.requestWillBeSent', {
      requestId: 'mono',
      timestamp: 1234.5, // 单调秒
      request: { url: 'http://mono', method: 'GET' },
    })
    pushEvidence(ev, 'Network.requestWillBeSent', {
      requestId: 'nothing',
      request: { url: 'http://nothing', method: 'GET' },
    })

    expect(ev.network).toHaveLength(2)
    expect(ev.network.every(e => e.timeSource === 'unknown')).toBe(true)
    expect(ev.network.every(e => e.wallTimeMs === undefined)).toBe(true)
  })
})

describe('pushEvidence：其它域不误伤', () => {
  it('Network.responseReceived 补 status、loadingFailed 记 failed（带 url）', () => {
    const ev = createMutableEvidence()
    ev.markStart(T0)
    pushEvidence(ev, 'Network.requestWillBeSent', {
      requestId: 'r1',
      wallTime: T0 / 1000 + 1,
      request: { url: 'http://127.0.0.1:1/api', method: 'GET' },
    })
    pushEvidence(ev, 'Network.responseReceived', { requestId: 'r1', response: { status: 500 } })
    pushEvidence(ev, 'Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_FAILED', canceled: false })

    const s = ev.summary()
    expect(ev.network[0]!.status).toBe(500)
    expect(s.network.failed).toEqual([{ url: 'http://127.0.0.1:1/api', errorText: 'net::ERR_FAILED', canceled: false }])
  })

  it('Runtime.exceptionThrown 计为 exception（live 异常不被吞）', () => {
    const ev = createMutableEvidence()
    ev.markStart(T0)
    pushEvidence(ev, 'Runtime.exceptionThrown', {
      timestamp: T0 + 5,
      exceptionDetails: { exception: { description: 'TypeError: x is undefined' } },
    })

    const s = ev.summary()
    expect(s.console.count).toBe(1)
    expect(s.console.errors).toHaveLength(1)
    expect(s.console.errors[0]).toContain('TypeError')
  })
})
