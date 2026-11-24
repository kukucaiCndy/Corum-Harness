/**
 * `describeNonJsonPath` 的回归网（2026-11-22）。
 *
 * ## 为什么需要这个定位器
 *
 * 2026-11-22 事故：`corum/subagent/progress` 有一帧被判为不可序列化，宿主因此 exit 1
 * 卡死近 3.5 小时。`assertJsonArgs` 只说「argument 0 不合格」——整帧十几层嵌套，
 * 不知道是哪一层。我为此把 `todos`／`turn`·`step`／`changeSummary` 各字段／
 * `stopReason` 逐个静态排除，全部落空，真凶至今未定位。
 *
 * `describeNonJsonPath` 就是补这条诊断：复现时 host.log 会直接指出
 * `arg[0] → arg.changeSummary.files[0].removed: undefined` 这样的路径。
 *
 * ## 断言什么
 *
 * ① 每个让官方 `isJsonValue` 判 false 的形态，本定位器都必须**指出正确路径与类型**；
 * ② 合格的值返回 undefined（不误报，否则会把正常帧的日志噪音化）；
 * ③ 与官方判据**同源**：逐条对齐 `walkJsonValue` 返回 undefined 的分支
 *    （undefined / 非有限数 / -0 / symbol·function·bigint / 循环 / 非 plain 原型 /
 *    稀疏数组·带额外键的数组 / 超深）。
 * ④ 永不抛（它在 catch 里跑，再抛就会把丢弃语义变成杀宿主）。
 */
import { describe, expect, it } from 'vitest'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { describeNonJsonPath } from '../src/index.ts'

/** 断言：官方判不合格 + 定位器给出期望路径。 */
function expectLocated(value: unknown, expected: RegExp): void {
  expect(isJsonValue(value)).toBe(false)
  const found = describeNonJsonPath(value)
  expect(found).toBeDefined()
  expect(found).toMatch(expected)
}

describe('describeNonJsonPath — 指出坏在哪一层', () => {
  it('★ 事故形态：嵌套对象里一个 undefined 字段（本轮最可能的那一类）', () => {
    expectLocated({
      sessionId: 's',
      turn: 1,
      done: true,
      changeSummary: { filesChanged: 1, files: [{ path: 'a.ts', added: 1, removed: undefined }] },
    }, /^arg\.changeSummary\.files\[0\]\.removed: undefined$/)
  })

  it('顶层的 undefined 字段', () => {
    expectLocated({ a: 1, b: undefined }, /^arg\.b: undefined$/)
  })

  it('NaN / Infinity / -0 报出具体数值形态', () => {
    expectLocated({ n: Number.NaN }, /^arg\.n: number\(NaN\)$/)
    expectLocated({ n: Number.POSITIVE_INFINITY }, /^arg\.n: number\(Infinity\)$/)
    expectLocated({ n: -0 }, /^arg\.n: number\(-0\)$/)
  })

  it('数组元素内部', () => {
    expectLocated({ todos: [{ content: 'x', status: undefined }] }, /^arg\.todos\[0\]\.status: undefined$/)
  })

  it('非 plain 原型对象（类实例 / Map / Date）点名原型', () => {
    expectLocated({ at: new Date() }, /^arg\.at: object\(Date proto\)$/)
    expectLocated({ m: new Map() }, /^arg\.m: object\(Map proto\)$/)
  })

  it('循环引用', () => {
    const cycle: Record<string, unknown> = { a: 1 }
    cycle.self = cycle
    expectLocated(cycle, /^arg\.self: circular$/)
  })

  it('symbol / function / bigint 这类非 JSON 原始类型', () => {
    expectLocated({ s: Symbol('x') }, /^arg\.s: symbol$/)
    expectLocated({ f: () => {} }, /^arg\.f: function$/)
    expectLocated({ b: 1n }, /^arg\.b: bigint$/)
  })

  it('稀疏数组（与官方判据同源）', () => {
    // eslint-disable-next-line no-sparse-arrays
    expectLocated({ a: [1, , 3] }, /^arg\.a: sparse array$/)
  })

  it('带额外自有键的数组（与官方判据同源）', () => {
    const arr = [1, 2] as number[] & { extra?: number }
    arr.extra = 3
    expectLocated({ a: arr }, /^arg\.a: sparse array$/)
  })

  it('合格值返回 undefined（不误报，否则正常帧会被噪音化）', () => {
    const ok = {
      sessionId: 's', turn: 1, step: 2, done: true, lastActive: Date.now(),
      currentAction: 'bash', stopReason: 'completed',
      todos: [{ content: 'x', status: 'pending' }],
      changeSummary: { filesChanged: 1, files: [{ path: 'a.ts', added: 1, removed: 0 }] },
    }
    expect(isJsonValue(ok)).toBe(true)
    expect(describeNonJsonPath(ok)).toBeUndefined()
  })

  it('★ 永不抛：它在 catch 里跑，再抛会把「丢弃该帧」变成「杀死宿主」', () => {
    const evil = new Proxy({}, {
      ownKeys() { throw new Error('boom') },
      getPrototypeOf() { throw new Error('boom') },
    })
    expect(() => describeNonJsonPath(evil)).not.toThrow()
  })

  it('超深嵌套被截断而不是栈溢出', () => {
    let deep: Record<string, unknown> = {}
    let cursor = deep
    for (let i = 0; i < 50; i += 1) {
      const next: Record<string, unknown> = {}
      cursor.child = next
      cursor = next
    }
    cursor.child = undefined
    const found = describeNonJsonPath(deep)
    expect(found).toBeDefined()
    // 要么定位到最深处的 undefined，要么被 MAX_DEPTH 截断——两者都可接受。
    expect(found).toMatch(/undefined$|<depth>/)
  })
})
