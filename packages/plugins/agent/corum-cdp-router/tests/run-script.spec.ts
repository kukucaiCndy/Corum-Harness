import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CdpError,
  CdpRouterService,
  runStep,
  type CdpSession,
  type ScriptStep,
  type StepResult,
  type RunScriptOutput,
} from '../src/index.js'
import type { ConsoleEntry, NetworkEntry, NetworkFailure } from '../src/cdp-client.js'

// ─────────────────────────────────────────────────────────────────────────────
// 假 session：记录 send 调用，按预设返回值。
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeSession(overrides: Partial<CdpSession> = {}): CdpSession & {
  sends: { method: string; params: Record<string, unknown> }[]
  evalResults: unknown[]
  evalCalls: string[]
  pushEval: (val: unknown) => void
} {
  const sends: { method: string; params: Record<string, unknown> }[] = []
  const evalResults: unknown[] = []
  const evalCalls: string[] = []

  const consoleEntries: ConsoleEntry[] = []
  const networkEntries: NetworkEntry[] = []
  const failedEntries: NetworkFailure[] = []

  const session: CdpSession = {
    pageId: 'fake-page-1',
    pageUrl: 'http://127.0.0.1:9350/?token=<hidden>',
    evaluate: async (expression: string) => {
      evalCalls.push(expression)
      return evalResults.shift() ?? null
    },
    send: async (method: string, params: Record<string, unknown> = {}) => {
      sends.push({ method, params })
      return {}
    },
    close: () => {},
    evidence: {
      get console() { return consoleEntries },
      get network() { return networkEntries },
      get failed() { return failedEntries },
      markStart: () => {},
      summary: () => ({
        console: {
          count: consoleEntries.length,
          errors: consoleEntries.filter(e => e.kind === 'error' || e.kind === 'exception').map(e => e.text),
          preExisting: 0,
          windowStartMs: null,
        },
        network: {
          count: networkEntries.length,
          failed: [...failedEntries],
        },
      }),
    },
    ...overrides,
  }

  return Object.assign(session, {
    sends,
    evalResults,
    evalCalls,
    pushEval: (val: unknown) => { evalResults.push(val) },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// click → assert pass/fail
// ─────────────────────────────────────────────────────────────────────────────

describe('runStep: click → assert pass', () => {
  it('click 成功后 assert exists:true 通过', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    // click: evaluate 返回中心坐标
    mock.pushEval({ x: 10, y: 20, w: 30, h: 40 })
    // assert exists: evaluate 返回 count=1
    mock.pushEval(1)

    const clickResult = await runStep(mock, { action: 'click', selector: '.btn', label: '点按钮' }, 0, screenshots)
    const assertResult = await runStep(mock, { action: 'assert', selector: '.btn', exists: true, label: '按钮存在' }, 1, screenshots)

    expect(clickResult.ok).toBe(true)
    expect(assertResult.ok).toBe(true)
    expect(assertResult.observed).toContain('count=1')
    expect(assertResult.observed).toContain('exists=true')
  })
})

describe('runStep: assert fail', () => {
  it('assert exists:true 但 count=0 → ok=false', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(0) // count=0

    const result = await runStep(mock, { action: 'assert', selector: '.missing', exists: true }, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.observed).toContain('count=0')
  })

  it('assert textContains 不匹配 → ok=false', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval('Hello World')

    const result = await runStep(mock, { action: 'assert', selector: '.el', textContains: 'Goodbye' }, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.observed).toBe('Goodbye')
  })

  it('assert textEquals 匹配 → ok=true', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval('  Done  ')

    const result = await runStep(mock, { action: 'assert', selector: '.el', textEquals: 'Done' }, 0, screenshots)

    expect(result.ok).toBe(true)
  })

  it('assert count 匹配 → ok=true', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(3)

    const result = await runStep(mock, { action: 'assert', selector: '.item', count: 3 }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(result.observed).toContain('count=3')
  })

  it('assert style 全匹配 → ok=true', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval({ color: 'rgb(255, 0, 0)', 'font-size': '14px' })

    const result = await runStep(mock, {
      action: 'assert',
      selector: '.el',
      style: { color: 'rgb(255, 0, 0)', 'font-size': '14px' },
    }, 0, screenshots)

    expect(result.ok).toBe(true)
  })

  it('assert style 部分不匹配 → ok=false 且 observed 列出差异', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval({ color: 'rgb(0, 0, 255)', 'font-size': '14px' })

    const result = await runStep(mock, {
      action: 'assert',
      selector: '.el',
      style: { color: 'rgb(255, 0, 0)', 'font-size': '14px' },
    }, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.observed).toContain('color')
    expect(result.observed).toContain('rgb(255, 0, 0)') // 期望
    expect(result.observed).toContain('rgb(0, 0, 255)') // 实得
  })

  it('assert js + expect 匹配 → ok=true', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(42)

    const result = await runStep(mock, {
      action: 'assert',
      js: 'document.querySelectorAll(".item").length',
      expect: 42,
    }, 0, screenshots)

    expect(result.ok).toBe(true)
  })

  it('assert js 无 expect 且 truthy → ok=true', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval('some truthy string')

    const result = await runStep(mock, { action: 'assert', js: 'document.title' }, 0, screenshots)

    expect(result.ok).toBe(true)
  })

  it('assert js 无 expect 且 falsy → ok=false', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(0)

    const result = await runStep(mock, { action: 'assert', js: 'document.foo' }, 0, screenshots)

    expect(result.ok).toBe(false)
  })

  it('assert textEquals 选择器无匹配 → ok=false 且 observed 提示', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(null)

    const result = await runStep(mock, { action: 'assert', selector: '.nope', textEquals: 'x' }, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.observed).toContain('无匹配')
  })

  it('assert 无子字段 → ok=false 且 error 含 unknown-assert', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'assert' }, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('unknown-assert')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// screenshot action 生效
// ─────────────────────────────────────────────────────────────────────────────

describe('runStep: screenshot', () => {
  it('screenshot action → 截图推入 screenshots 数组', async () => {
    const mock = makeFakeSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 800, innerHeight: 600, outerWidth: 800, outerHeight: 600 })
    mock.send = async () => ({ data: 'iVBORw0KGgo=', metadata: { deviceWidth: 800, deviceHeight: 600 } })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'screenshot', screenshot: 'after-click' }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(result.screenshot).toBe('after-click')
    expect(screenshots).toHaveLength(1)
    expect(screenshots[0]!.name).toBe('after-click')
    expect(screenshots[0]!.base64).toBe('iVBORw0KGgo=')
    expect(screenshots[0]!.size).toBeGreaterThan(0)
  })

  it('assert + screenshot 字段 → ok=true 且 screenshot 带名', async () => {
    const mock = makeFakeSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 100, innerHeight: 100, outerWidth: 100, outerHeight: 100 })
    mock.send = async () => ({ data: 'base64data', metadata: { deviceWidth: 100, deviceHeight: 100 } })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'assert', screenshot: 'evidence' }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(result.screenshot).toBe('evidence')
    expect(screenshots).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 未知 action 报 run-script/unknown-action
// ─────────────────────────────────────────────────────────────────────────────

describe('runStep: unknown action', () => {
  it('未知 action → ok=false 且 error 含 run-script/unknown-action', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    // 用 as 绕过类型检查，模拟外部传入的非法 step
    const result = await runStep(mock, { action: 'scroll' } as unknown as ScriptStep, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('run-script/unknown-action')
    expect(result.error).toContain('scroll')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 其它 step 类型
// ─────────────────────────────────────────────────────────────────────────────

describe('runStep: wait', () => {
  it('wait → ok=true', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'wait', wait: 1 }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(result.action).toBe('wait')
  })
})

describe('runStep: eval', () => {
  it('eval → ok=true 且 observed 是 JSON', async () => {
    const mock = makeFakeSession()
    mock.pushEval({ count: 5 })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'eval', eval: 'document.title' }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(result.observed).toContain('count')
    expect(result.observed).toContain('5')
  })

  it('eval 空 → ok=false', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'eval', eval: '' }, 0, screenshots)

    expect(result.ok).toBe(false)
  })
})

describe('runStep: type with expectValue mismatch', () => {
  it('expectValue 不符 → ok=false 且 error 含不符', async () => {
    const mock = makeFakeSession()
    // focus → true, value readback → 'wrong'
    mock.pushEval(true)
    mock.pushEval('wrong')
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, {
      action: 'type',
      text: 'hello',
      into: '#input',
      expectValue: 'hello',
    }, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('不符')
    expect(result.observed).toBe('wrong')
  })
})

describe('runStep: resize', () => {
  it('resize 设置尺寸 → ok=true', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'resize', resize: { width: 800, height: 600 } }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(mock.sends[0]!.method).toBe('Emulation.setDeviceMetricsOverride')
  })

  it('resize reset → ok=true（复核恢复真实）', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    // reset 会 clear + **复核**视口（2026-11-07）：假 session 得先能报实测值
    mock.pushEval(JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 }))

    const result = await runStep(mock, { action: 'resize', resize: { reset: true } }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(mock.sends[0]!.method).toBe('Emulation.clearDeviceMetricsOverride')
  })

  it('resize reset 但复核仍 emulated → 抛具名 cdp/viewport-not-restored（runScript 会记成该步失败）', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []
    // 实机形态：clear 返回 {} 但视口一动不动（前一会话残留的 override），
    // 且**重载之后仍然不真实**（所以预算给足：clear 后复核 ×3 + 重载后复核 ×3 + 就绪轮询）
    for (let i = 0; i < 12; i++) {
      mock.pushEval(JSON.stringify({ innerWidth: 1219, innerHeight: 427, outerWidth: 1280, outerHeight: 860 }))
    }

    await expect(runStep(mock, { action: 'resize', resize: { reset: true } }, 0, screenshots))
      .rejects.toMatchObject({ code: 'cdp/viewport-not-restored' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 截图前的视口真实性校验（2026-11-02 假视口事故修复）
// ─────────────────────────────────────────────────────────────────────────────

/** 给假 session 预置视口（readViewport 走 evaluate，返回 JSON 字符串）。 */
function setViewport(mock: ReturnType<typeof makeFakeSession>, vp: Record<string, number>): void {
  mock.evaluate = async () => JSON.stringify(vp)
}

describe('runStep: screenshot 视口校验', () => {
  it('真实视口（inner===outer）→ 截图成功', async () => {
    const mock = makeFakeSession()
    setViewport(mock, { innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
    mock.send = async () => ({ data: 'iVBORw0KGgo=', metadata: { deviceWidth: 1280, deviceHeight: 860 } })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'screenshot', screenshot: 'probe' }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(screenshots).toHaveLength(1)
    expect(screenshots[0]!.name).toBe('probe')
    expect(result.observed).toContain('视口 1280x860')
  })

  it('假视口（inner!==outer）→ ok=false，不出截图，error 说明视口非真实', async () => {
    const mock = makeFakeSession()
    setViewport(mock, { innerWidth: 1280, innerHeight: 620, outerWidth: 1280, outerHeight: 500 })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'screenshot', screenshot: 'probe' }, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('视口非真实')
    expect(result.error).toContain('inner=1280x620')
    expect(result.error).toContain('outer=1280x500')
    expect(screenshots).toHaveLength(0)
  })

  it('假视口 + emulatedViewportOk:true → 放行，截图名标注 -emulated', async () => {
    const mock = makeFakeSession()
    setViewport(mock, { innerWidth: 1100, innerHeight: 620, outerWidth: 1280, outerHeight: 860 })
    mock.send = async () => ({ data: 'iVBORw0KGgo=', metadata: { deviceWidth: 1100, deviceHeight: 620 } })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, {
      action: 'screenshot',
      screenshot: 'layout',
      emulatedViewportOk: true,
    }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(result.screenshot).toBe('layout-emulated')
    expect(screenshots[0]!.name).toBe('layout-emulated')
  })

  it('assert + screenshot 同样被假视口拦下 → ok=false', async () => {
    const mock = makeFakeSession()
    setViewport(mock, { innerWidth: 1280, innerHeight: 620, outerWidth: 1280, outerHeight: 500 })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'assert', screenshot: 'evidence' }, 0, screenshots)

    expect(result.ok).toBe(false)
    expect(result.observed).toContain('视口非真实')
    expect(screenshots).toHaveLength(0)
  })

  it('assert + screenshot 真实视口 → ok=true 且 observed 附视口尺寸', async () => {
    const mock = makeFakeSession()
    setViewport(mock, { innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
    mock.send = async () => ({ data: 'base64data', metadata: { deviceWidth: 1280, deviceHeight: 860 } })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'assert', screenshot: 'evidence' }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(result.screenshot).toBe('evidence')
    expect(result.observed).toContain('视口 1280x860')
  })

  // ── T1：量不出窗口外框时，截图可以继续，但必须标 unverified ──────────────

  it('outer=0（无头/隐藏窗口）→ 截图继续但名字带 -unverified，且明说不可作真实证据', async () => {
    const mock = makeFakeSession()
    setViewport(mock, { innerWidth: 1280, innerHeight: 860, outerWidth: 0, outerHeight: 0 })
    mock.send = async () => ({ data: 'iVBORw0KGgo=', metadata: { deviceWidth: 1280, deviceHeight: 860 } })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'screenshot', screenshot: 'probe' }, 0, screenshots)

    expect(result.ok).toBe(true) // 不因校验装置故障吞证据
    expect(result.screenshot).toBe('probe-unverified')
    expect(screenshots[0]!.name).toBe('probe-unverified')
    expect(result.observed).toContain('不可测量')
    expect(result.observed).toContain('不可作为真实窗口证据')
  })

  it('视口读不出 → 截图继续但名字带 -unverified', async () => {
    const mock = makeFakeSession()
    mock.evaluate = async () => { throw new Error('evaluate 挂了') }
    mock.send = async () => ({ data: 'iVBORw0KGgo=', metadata: { deviceWidth: 800, deviceHeight: 600 } })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'screenshot', screenshot: 'probe' }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(result.screenshot).toBe('probe-unverified')
    expect(result.observed).toContain('不可作为真实窗口证据')
  })

  it('上下文报 overrideActive（已知 override 未复原）→ 截图判 emulated 并被拦下', async () => {
    const mock = makeFakeSession()
    // 即便测量结果看起来「内外相等」，已知 override 也必须优先判 emulated。
    setViewport(mock, { innerWidth: 1100, innerHeight: 620, outerWidth: 1100, outerHeight: 620 })
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(
      mock,
      { action: 'screenshot', screenshot: 'probe' },
      0,
      screenshots,
      { overrideActive: true },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('视口非真实')
    expect(screenshots).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 多步序列（模拟 runScript 的步骤编排）
// ─────────────────────────────────────────────────────────────────────────────

describe('runStep sequence: click → type → assert', () => {
  it('完整序列 pass', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    // 1. click: evaluate 取坐标
    mock.pushEval({ x: 50, y: 50, w: 20, h: 20 })
    // 2. type into: focus → true, expectValue readback → 'hello'
    mock.pushEval(true)
    mock.pushEval('hello')
    // 3. assert textContains
    mock.pushEval('hello world')

    const results: StepResult[] = []
    results.push(await runStep(mock, { action: 'click', selector: '#input' }, 0, screenshots))
    results.push(await runStep(mock, { action: 'type', text: 'hello', into: '#input', expectValue: 'hello' }, 1, screenshots))
    results.push(await runStep(mock, { action: 'assert', selector: '#input', textContains: 'hello' }, 2, screenshots))

    expect(results.every(r => r.ok)).toBe(true)
  })

  it('序列中 assert 失败不阻断后续（由调用方控制 failFast）', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    // 1. assert fail: count=0
    mock.pushEval(0)
    // 2. assert pass: count=1
    mock.pushEval(1)

    const r1 = await runStep(mock, { action: 'assert', selector: '.a', exists: true }, 0, screenshots)
    const r2 = await runStep(mock, { action: 'assert', selector: '.b', exists: true }, 1, screenshots)

    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// console 证据收集（通过 fake session 的 evidence）
// ─────────────────────────────────────────────────────────────────────────────

describe('evidence collection', () => {
  it('fake session 的 evidence.summary 能汇总 console + network', () => {
    const mock = makeFakeSession()
    // evidence 是 readonly 的空数组（fake session 初始）
    const summary = mock.evidence.summary()
    expect(summary.console.count).toBe(0)
    expect(summary.network.count).toBe(0)
    expect(summary.network.failed).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// runScriptRemote: targetId 空拒
// ─────────────────────────────────────────────────────────────────────────────

describe('runScriptRemote: targetId 空拒', () => {
  /**
   * runScriptRemote 在 targetId === '' 时直接返回 error，不触及 this.requireTarget
   * （不需要构造真实 cordis Context）。用 Object.create 绕过构造函数。
   */
  it('targetId 为空 → ok=false 且 error.code=run-script/empty-target', async () => {
    // 绕过 TypertRemoteService 构造函数（需要真实 Context）。
    // targetId 为空时 runScriptRemote 在到达 this.* 之前就返回。
    const service = Object.create(CdpRouterService.prototype) as CdpRouterService
    const out = await service.runScriptRemote({ targetId: '' })

    expect(out.ok).toBe(false)
    expect(out.targetId).toBe('')
    expect(out.results).toEqual([])
    expect(out.error?.code).toBe('run-script/empty-target')
    expect(out.screenshots).toEqual([])
    expect(out.identity).toBeNull()
  })

  it('targetId 未提供（undefined）→ 同样空拒', async () => {
    const service = Object.create(CdpRouterService.prototype) as CdpRouterService
    const out = await service.runScriptRemote(undefined)

    expect(out.ok).toBe(false)
    expect(out.error?.code).toBe('run-script/empty-target')
  })

  it('targetId 非空但不存在 → ok=false 且 error.code=cdp-router/unknown-target', async () => {
    // requireTarget 会读配置文件：用 CORUM_HOME 指向空目录，targets 为空。
    const service = Object.create(CdpRouterService.prototype) as CdpRouterService
    const out = await service.runScriptRemote({ targetId: 'nonexistent', steps: [] })

    expect(out.ok).toBe(false)
    expect(out.error?.code).toBe('cdp-router/unknown-target')
  })
})

interface FakeSessionHandle extends CdpSession {
  readonly sends: { method: string; params: Record<string, unknown> }[]
  /** 页面内求值的表达式（顺序），用于断言「没在假视口下查 DOM」。 */
  readonly evalCalls: string[]
  closed: boolean
}

/**
 * 假 session 的行为注入（T1/T7 测试用）：不注入时走默认（视口 1280x860、截图有数据）。
 *
 * - `evaluate` —— 控制页内求值（截图前的视口读取、assert 的查询都走它）；
 * - `onSend` —— 按 CDP 方法注入应答或抛错（如让 `Emulation.setDeviceMetricsOverride`
 *   抛错，验证 finally 仍会 clear）。
 */
interface ScriptBehavior {
  evaluate?: (expression: string) => unknown
  onSend?: (method: string, params: Record<string, unknown>) => unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// runScriptRemote：resize 覆盖的作用域收尾（2026-11-02 事故修复）
//
// runScriptRemote 需要真实 connectSession（WebSocket），单测里无法直连。这里用
// vi.mock 把 connectSession 换成假 session 工厂，只验证行为契约。requireTarget
// 走 MockableService 注入的假实现。
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/cdp-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cdp-client.js')>()
  const closedSessions: FakeSessionHandle[] = []
  let behavior: ScriptBehavior = {}
  /** 一个假 session：send 记录、evaluate 可注入视口。 */
  function makeScriptSession(): FakeSessionHandle {
    const sends: { method: string; params: Record<string, unknown> }[] = []
    const evalCalls: string[] = []
    const handle: FakeSessionHandle = {
      sends,
      evalCalls,
      closed: false,
      pageId: 'mock-page',
      pageUrl: 'http://127.0.0.1:9350/?token=<hidden>',
      evaluate: async (expression: string) => {
        evalCalls.push(expression)
        if (behavior.evaluate !== undefined) return behavior.evaluate(expression)
        return JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
      },
      send: async (method: string, params: Record<string, unknown> = {}) => {
        sends.push({ method, params })
        if (behavior.onSend !== undefined) {
          const out = behavior.onSend(method, params)
          if (out !== undefined) return out
        }
        if (method === 'Page.captureScreenshot') {
          return { data: 'iVBORw0KGgo=', metadata: { deviceWidth: 1280, deviceHeight: 860 } }
        }
        return {}
      },
      close: () => { handle.closed = true },
      evidence: {
        console: [], network: [], failed: [],
        // 屏障调用也记进 sends（合成名 `__markStart`），便于断言「enable 之后、动作之前」。
        markStart: () => { sends.push({ method: '__markStart', params: {} }) },
        summary: () => ({
          console: { count: 0, errors: [], preExisting: 0, windowStartMs: null },
          network: { count: 0, failed: [] },
        }),
      },
    }
    return handle
  }
  return {
    ...actual,
    connectSession: async () => {
      const handle = makeScriptSession()
      closedSessions.push(handle)
      return handle
    },
    /** 测试侧读取本批假 session（按创建顺序）。 */
    __closedSessions: closedSessions,
    /** 注入/清空假 session 行为（每个用例开始前调一次）。 */
    __setBehavior: (next: ScriptBehavior | undefined) => { behavior = next ?? {} },
  }
})

describe('runScriptRemote: resize 作用域收尾（mock connectSession）', () => {
  it('跑过非 reset 的 resize → finally 里发 clearDeviceMetricsOverride，再 close', async () => {
    const { __closedSessions } = await import('../src/cdp-client.js') as unknown as { __closedSessions: FakeSessionHandle[] }
    const service = new MockableService()
    const out = await service.runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'resize', resize: { width: 1100, height: 620 } },
        { action: 'eval', eval: '1' },
      ],
    })

    expect(out.ok).toBe(true)
    expect(out.viewport).toEqual({
      innerWidth: 1280,
      innerHeight: 860,
      outerWidth: 1280,
      outerHeight: 860,
      emulated: false,
      geometry: 'real',
    })
    expect(out.viewportRestored).toBe(true)
    const s = __closedSessions.at(-1)!
    const clearIdx = s.sends.findIndex(m => m.method === 'Emulation.clearDeviceMetricsOverride')
    expect(clearIdx).toBeGreaterThan(-1)
    expect(s.closed).toBe(true)
  })

  it('没跑 resize → finally 不发 clear', async () => {
    const { __closedSessions } = await import('../src/cdp-client.js') as unknown as { __closedSessions: FakeSessionHandle[] }
    const service = new MockableService()
    await service.runScriptRemote({ targetId: 't1', steps: [{ action: 'eval', eval: '1' }] })

    const s = __closedSessions.at(-1)!
    expect(s.sends.some(m => m.method === 'Emulation.clearDeviceMetricsOverride')).toBe(false)
  })

  it('跑过 resize + reset → 不再补 clear（reset 已复原）', async () => {
    const { __closedSessions } = await import('../src/cdp-client.js') as unknown as { __closedSessions: FakeSessionHandle[] }
    const service = new MockableService()
    await service.runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'resize', resize: { width: 1100, height: 620 } },
        { action: 'resize', resize: { reset: true } },
      ],
    })

    const s = __closedSessions.at(-1)!
    // reset 那次发的 clear 就是唯一的 clear
    expect(s.sends.filter(m => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(1)
  })
})

/** 取 mock 模块的测试钩子（`__closedSessions` / `__setBehavior`）。 */
async function cdpClientMock(): Promise<{
  __closedSessions: FakeSessionHandle[]
  __setBehavior: (next: ScriptBehavior | undefined) => void
}> {
  return await import('../src/cdp-client.js') as unknown as {
    __closedSessions: FakeSessionHandle[]
    __setBehavior: (next: ScriptBehavior | undefined) => void
  }
}

/**
 * 视口模拟（inner !== outer）⇒ 截图步必然判失败；其余求值返回 1（断言通过）。
 *
 * 注意：2026-11-07 起 runScript 会**开局预检视口**（残留 override 自愈/失败关闭），
 * 所以这个行为让「开局那一测」是真实视口，从第二次视口读取起才算模拟视口 ——
 * 否则整个案例会被 fail-closed 挡在开局（那是另一组用例专门覆盖的行为）。
 *
 * @param opts.healOnClear - clear 之后视口恢复真实（reset 步骤的复核要用）
 */
function emulatedViewportBehavior(opts: { healOnClear?: boolean } = {}): ScriptBehavior {
  let viewportReads = 0
  let healed = false
  return {
    evaluate: (expression) => {
      if (!expression.includes('outerWidth')) return 1
      viewportReads += 1
      const emulated = !healed && viewportReads >= 2
      return emulated
        ? JSON.stringify({ innerWidth: 1100, innerHeight: 620, outerWidth: 1280, outerHeight: 860 })
        : JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
    },
    onSend: (method) => {
      if (method === 'Emulation.clearDeviceMetricsOverride' && opts.healOnClear === true) healed = true
      return undefined
    },
  }
}

/** 开局即模拟视口、且 clear 治不好（前一会话残留 override 的实机形态）。 */
const STUCK_VIEWPORT_BEHAVIOR: ScriptBehavior = {
  evaluate: (expression) => expression.includes('outerWidth')
    ? JSON.stringify({ innerWidth: 1219, innerHeight: 427, outerWidth: 1280, outerHeight: 860 })
    : 1,
}

// ─────────────────────────────────────────────────────────────────────────────
// T1：视口 override 的作用域收尾（set 抛错也要 clear；复原结果如实回传）
// ─────────────────────────────────────────────────────────────────────────────

describe('runScriptRemote: T1 视口复原', () => {
  beforeEach(async () => { (await cdpClientMock()).__setBehavior(undefined) })

  it('set 抛错（override 可能已生效）→ finally 仍尝试 clear，viewportRestored=true', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({
      onSend: (method) => {
        if (method === 'Emulation.setDeviceMetricsOverride') throw new Error('set 失败')
        return undefined
      },
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [{ action: 'resize', resize: { width: 1100, height: 620 } }],
    })

    expect(out.ok).toBe(false) // set 失败 ⇒ 该步失败
    const s = api.__closedSessions.at(-1)!
    expect(s.sends.filter(m => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(1)
    expect(out.viewportRestored).toBe(true)
  })

  it('后续行为失败（failFast 中断）→ 仍恢复视口', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({
      evaluate: (expression) => expression.includes('querySelectorAll')
        ? 0 // assert exists:true 失败
        : JSON.stringify({ innerWidth: 1100, innerHeight: 620, outerWidth: 1100, outerHeight: 620 }),
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'resize', resize: { width: 1100, height: 620 } },
        { action: 'assert', selector: '.missing', exists: true },
        { action: 'eval', eval: '1' },
      ],
    })

    expect(out.ok).toBe(false)
    expect(out.results).toHaveLength(2) // 失败即停：第三步没跑
    const s = api.__closedSessions.at(-1)!
    expect(s.sends.filter(m => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(1)
    expect(out.viewportRestored).toBe(true)
  })

  it('clear 失败 → viewportRestored=false + clearError 如实回传，视口判 emulated', async () => {
    const api = await cdpClientMock()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      api.__setBehavior({
        onSend: (method) => {
          if (method === 'Emulation.clearDeviceMetricsOverride') throw new Error('clear 失败')
          return undefined
        },
      })

      const out = await new MockableService().runScriptRemote({
        targetId: 't1',
        steps: [{ action: 'resize', resize: { width: 1100, height: 620 } }],
      })

      expect(out.viewportRestored).toBe(false)
      expect(out.clearError).toContain('clear 失败')
      // 残留 override 时不得把视口说成真实（已知 overrideActive 优先判 emulated）
      expect(out.viewport?.geometry).toBe('emulated')
      expect(out.viewport?.emulated).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 视口残留守卫（2026-11-07 事故：A3 的 resize 没复原 ⇒ 从 A4 起 305 张截图作废，
// 批次还继续往下跑）。这里锁死三条语义：
// 1. 开局复核仍 emulated ⇒ fail-closed 具名错误，一个步骤都不执行；
// 2. 开局残留但 clear 能治好 ⇒ 自愈并照常跑（证据里带 viewportSelfHealed）；
// 3. reset 步骤 / 收尾 clear 的应答都不算成功 —— 只有复核实测才说话。
// ─────────────────────────────────────────────────────────────────────────────

describe('runScriptRemote: 视口残留守卫（2026-11-07）', () => {
  beforeEach(async () => { (await cdpClientMock()).__setBehavior(undefined) })

  it('开局即残留且 clear 是 no-op → fail-closed：不执行任何步骤 + 具名 cdp/viewport-not-restored', async () => {
    const api = await cdpClientMock()
    api.__setBehavior(STUCK_VIEWPORT_BEHAVIOR)

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'click', selector: '.btn' },
        { action: 'screenshot', screenshot: 'evidence' },
        { action: 'assert', selector: '.x', exists: true },
      ],
    })

    expect(out.ok).toBe(false)
    expect(out.error?.code).toBe('cdp/viewport-not-restored')
    expect(out.results).toEqual([]) // 一步都没跑
    expect(out.screenshots).toEqual([])
    expect(out.viewport?.geometry).toBe('emulated')
    expect(out.viewportRestored).toBe(false)
    expect(out.clearError).toContain('cdp/viewport-not-restored')

    const s = api.__closedSessions.at(-1)!
    // 真的尝试过 clear（不是嘴上说说）
    expect(s.sends.some(m => m.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true)
    // 但绝不允许在假视口下继续点/截图/断言
    expect(s.sends.some(m => m.method === 'Page.captureScreenshot')).toBe(false)
    expect(s.sends.some(m => m.method === 'Input.dispatchMouseEvent')).toBe(false)
    expect(s.evalCalls.some(e => e.includes('querySelectorAll'))).toBe(false)
    expect(s.closed).toBe(true)
  })

  it('开局残留但 clear 能治好 → 自愈（viewportSelfHealed）并照常执行，clear 早于首个动作', async () => {
    const api = await cdpClientMock()
    let viewportReads = 0
    api.__setBehavior({
      evaluate: (expression) => {
        if (!expression.includes('outerWidth')) return 1
        viewportReads += 1
        return viewportReads === 1
          ? JSON.stringify({ innerWidth: 1219, innerHeight: 427, outerWidth: 1280, outerHeight: 860 })
          : JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
      },
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [{ action: 'eval', eval: '1' }],
    })

    expect(out.ok).toBe(true)
    expect(out.viewportSelfHealed).toBe(true)
    expect(out.results).toHaveLength(1)
    expect(out.viewport?.geometry).toBe('real')

    const s = api.__closedSessions.at(-1)!
    const clearIdx = s.sends.findIndex(m => m.method === 'Emulation.clearDeviceMetricsOverride')
    const markIdx = s.sends.findIndex(m => m.method === '__markStart')
    expect(clearIdx).toBeGreaterThan(markIdx) // 屏障之后才做开局预检
  })

  it('outer 量不出来（hidden/无头）→ 视口判 unmeasurable，且不伪写 viewportRestored=true', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({
      evaluate: (expression) => expression.includes('outerWidth')
        ? JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 0, outerHeight: 0 })
        : 1,
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'resize', resize: { width: 1100, height: 620 } },
        { action: 'eval', eval: '1' },
      ],
    })

    expect(out.viewport?.geometry).toBe('unmeasurable')
    expect(out.viewport?.emulated).toBe(false)
    // 清过 override，但**没法证明**恢复了 ⇒ 字段缺省（未验证），不是 true
    expect(out.viewportRestored).toBeUndefined()
    expect(out.clearError).toBeUndefined()
    const s = api.__closedSessions.at(-1)!
    expect(s.sends.filter(m => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(1)
  })

  it('reset 步骤复核仍 emulated → 该步 ok:false（具名错误），后续步骤不执行', async () => {
    const api = await cdpClientMock()
    // 开局真实；set 之后进入模拟视口，clear 治不好
    let viewportReads = 0
    let overridden = false
    api.__setBehavior({
      evaluate: (expression) => {
        if (!expression.includes('outerWidth')) return 1
        viewportReads += 1
        return overridden || viewportReads >= 2
          ? JSON.stringify({ innerWidth: 1100, innerHeight: 620, outerWidth: 1280, outerHeight: 860 })
          : JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
      },
      onSend: (method) => {
        if (method === 'Emulation.setDeviceMetricsOverride') overridden = true
        return undefined
      },
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'resize', resize: { width: 1100, height: 620 } },
        { action: 'resize', resize: { reset: true } },
        { action: 'click', selector: '.after' },
      ],
    })

    expect(out.ok).toBe(false)
    expect(out.results).toHaveLength(2) // 第三步没跑
    expect(out.results[1]!.ok).toBe(false)
    expect(out.results[1]!.error).toContain('cdp/viewport-not-restored')
    const s = api.__closedSessions.at(-1)!
    expect(s.sends.some(m => m.method === 'Input.dispatchMouseEvent')).toBe(false)
    // 收尾仍会再尝试一次 clear（自己设的层自己清）
    expect(out.viewportRestored).toBe(false)
  })

  it('收尾 clear 成功但复核仍 emulated → viewportRestored=false（不许再报 true）', async () => {
    const api = await cdpClientMock()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let viewportReads = 0
      api.__setBehavior({
        evaluate: (expression) => {
          if (!expression.includes('outerWidth')) return 1
          viewportReads += 1
          return viewportReads === 1
            ? JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
            : JSON.stringify({ innerWidth: 1100, innerHeight: 620, outerWidth: 1280, outerHeight: 860 })
        },
      })

      const out = await new MockableService().runScriptRemote({
        targetId: 't1',
        steps: [
          { action: 'resize', resize: { width: 1100, height: 620 } },
          { action: 'eval', eval: '1' },
        ],
      })

      expect(out.ok).toBe(true) // 步骤本身都跑成功了
      expect(out.viewportRestored).toBe(false) // 但视口没复原，必须如实报
      expect(out.clearError).toContain('cdp/viewport-not-restored')
    } finally {
      errSpy.mockRestore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T7：单步 nonBlocking 放行（绝不放行全局 failFast）
// ─────────────────────────────────────────────────────────────────────────────

describe('runScriptRemote: T7 nonBlocking', () => {
  beforeEach(async () => { (await cdpClientMock()).__setBehavior(undefined) })

  it('screenshot 标 nonBlocking 且失败 → 后续 assert 仍执行，顶层仍 ok:false', async () => {
    const api = await cdpClientMock()
    api.__setBehavior(emulatedViewportBehavior())

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'screenshot', screenshot: 'evidence', nonBlocking: true },
        { action: 'assert', selector: '.x', exists: true },
      ],
    })

    expect(out.results).toHaveLength(2)
    expect(out.results[0]!.ok).toBe(false)
    expect(out.results[0]!.nonBlocking).toBe(true)
    expect(out.results[1]!.ok).toBe(true)
    expect(out.ok).toBe(false) // 失败没有被吞掉
    expect(api.__closedSessions.at(-1)!.closed).toBe(true)
  })

  it('普通 assert 失败 → 后续危险步骤不执行（默认 failFast 仍生效）', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({ evaluate: () => 0 })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'assert', selector: '.x', exists: true },
        { action: 'click', selector: '.danger' },
      ],
    })

    expect(out.results).toHaveLength(1)
    expect(out.ok).toBe(false)
    const s = api.__closedSessions.at(-1)!
    expect(s.sends.some(m => m.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('tail reset 步骤在 nonBlocking 失败之后仍可执行', async () => {
    const api = await cdpClientMock()
    api.__setBehavior(emulatedViewportBehavior({ healOnClear: true }))

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'screenshot', screenshot: 'evidence', nonBlocking: true },
        { action: 'resize', resize: { reset: true } },
      ],
    })

    expect(out.results).toHaveLength(2)
    expect(out.results[0]!.ok).toBe(false)
    expect(out.results[1]!.ok).toBe(true)
    const s = api.__closedSessions.at(-1)!
    // 只有 reset 那一次 clear；没走过非 reset 的 resize ⇒ finally 不再补 clear
    expect(s.sends.filter(m => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(1)
    expect(out.viewportRestored).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3：证据屏障的时机（enable 之后、任何动作之前）
// ─────────────────────────────────────────────────────────────────────────────

describe('runScriptRemote: T3 证据屏障时机', () => {
  beforeEach(async () => { (await cdpClientMock()).__setBehavior(undefined) })

  it('markStart 在 enable 之后、首个动作之前', async () => {
    const api = await cdpClientMock()

    await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [{ action: 'resize', resize: { width: 800, height: 600 } }],
    })

    const s = api.__closedSessions.at(-1)!
    const logIdx = s.sends.findIndex(m => m.method === 'Log.enable')
    const markIdx = s.sends.findIndex(m => m.method === '__markStart')
    const actionIdx = s.sends.findIndex(m => m.method === 'Emulation.setDeviceMetricsOverride')
    expect(logIdx).toBeGreaterThan(-1)
    expect(markIdx).toBeGreaterThan(logIdx)
    // 屏障紧跟在 enable 块之后（Page.enable 的下一条），且早于任何步骤动作。
    expect(s.sends[markIdx - 1]!.method).toBe('Page.enable')
    expect(actionIdx).toBeGreaterThan(markIdx)
  })
})

/** 绕过构造函数的 service 替身（配置走 CORUM_CDP_TARGETS 临时文件）。 */
class MockableService {
  private readonly inner = Object.create(CdpRouterService.prototype) as {
    runScriptRemote: (input: Record<string, unknown>) => Promise<RunScriptOutput>
    requireTarget: (targetId: string) => unknown
  }

  constructor() {
    this.inner.requireTarget = () => ({ id: 't1', ip: '127.0.0.1', port: 9350 })
  }

  runScriptRemote(input: Record<string, unknown>): Promise<RunScriptOutput> {
    return this.inner.runScriptRemote(input)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// when 条件步（2026-11-07）：只有 click/key 接受；truthy 才发真实 Input；
// falsy 记 skip（ok:true，绝不发 Input）；求值抛错/超时 ⇒ 本步 fail（fail closed）。
// ─────────────────────────────────────────────────────────────────────────────

describe('runStep: when 条件步（click/key）', () => {
  it('click + when truthy → 照旧派发真实鼠标事件，且不带 skip 标记', async () => {
    const mock = makeFakeSession()
    const shots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(true) // when
    mock.pushEval({ x: 10, y: 20, w: 30, h: 40 }) // click 取中心坐标

    const result = await runStep(mock, { action: 'click', selector: '.btn', when: '!!document.querySelector(".btn")' }, 0, shots)

    expect(result.ok).toBe(true)
    expect(result.skipped).toBeUndefined()
    // when 求值必须走页内 Boolean(await(...)) 归一（awaitPromise 语义）
    expect(mock.evalCalls[0]).toContain('Boolean(await')
    expect(mock.sends.filter(s => s.method === 'Input.dispatchMouseEvent')).toHaveLength(2)
  })

  it('click + when falsy → 跳过：ok:true、无任何 Input、证据带 skipped', async () => {
    const mock = makeFakeSession()
    const shots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(false)

    const result = await runStep(mock, { action: 'click', selector: '.btn', when: '!!document.querySelector(".btn")' }, 3, shots)

    expect(result.ok).toBe(true)
    expect(result.index).toBe(3)
    expect(result.skipped).toEqual({ skipped: true, reason: 'when-false', when: '!!document.querySelector(".btn")' })
    // observed 是 JSON 证据（下游不必依赖结构化字段也能读出 skip）
    expect(JSON.parse(String(result.observed))).toEqual({ skipped: true, reason: 'when-false', when: '!!document.querySelector(".btn")' })
    // 只求值了 when 一次：没有取坐标、没有鼠标事件
    expect(mock.evalCalls).toHaveLength(1)
    expect(mock.sends).toHaveLength(0)
  })

  it('key + when truthy → 派发 keyDown/keyUp', async () => {
    const mock = makeFakeSession()
    const shots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(true)

    const result = await runStep(mock, { action: 'key', key: 'Escape', when: 'true' }, 0, shots)

    expect(result.ok).toBe(true)
    expect(result.skipped).toBeUndefined()
    expect(mock.sends.filter(s => s.method === 'Input.dispatchKeyEvent')).toHaveLength(2)
  })

  it('key + when falsy → 跳过，且一个按键事件都不发', async () => {
    const mock = makeFakeSession()
    const shots: { name: string; base64: string; size: number }[] = []
    mock.pushEval(false)

    const result = await runStep(mock, { action: 'key', key: 'Escape', when: 'window.__hasDialog === true' }, 1, shots)

    expect(result.ok).toBe(true)
    expect(result.skipped?.reason).toBe('when-false')
    expect(mock.sends).toHaveLength(0)
  })

  it('when 求值抛错（CdpError）→ 本步 fail（when-threw），不跳过、不发 Input', async () => {
    const mock = makeFakeSession()
    mock.evaluate = async () => { throw new CdpError('cdp/evaluate-timeout', '求值超时（15000ms）', 'timeout') }
    const shots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'click', selector: '.btn', when: 'window.__neverReady' }, 0, shots)

    expect(result.ok).toBe(false)
    expect(result.skipped).toBeUndefined()
    expect(result.error).toContain('run-script/when-threw')
    expect(result.error).toContain('cdp/evaluate-timeout')
    expect(mock.sends).toHaveLength(0)
  })

  it('普通 Error 抛错同样 fail closed（不静默跳过）', async () => {
    const mock = makeFakeSession()
    mock.evaluate = async () => { throw new Error('SyntaxError: Unexpected token') }
    const shots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'key', key: 'Enter', when: '!!!' }, 0, shots)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('run-script/when-threw')
    expect(mock.sends).toHaveLength(0)
  })

  it('非布尔 when 结果按真值归一：0/""/null/undefined ⇒ skip，1/"yes"/{} ⇒ 执行', async () => {
    const falsy = [0, '', null, undefined] as unknown[]
    for (const value of falsy) {
      const mock = makeFakeSession()
      mock.pushEval(value)
      const result = await runStep(mock, { action: 'key', key: 'Escape', when: 'someExpr' }, 0, [])
      expect(result.ok).toBe(true)
      expect(result.skipped?.reason).toBe('when-false')
      expect(mock.sends).toHaveLength(0)
    }
    const truthy = [1, 'yes', {}, []] as unknown[]
    for (const value of truthy) {
      const mock = makeFakeSession()
      mock.pushEval(value)
      const result = await runStep(mock, { action: 'key', key: 'Escape', when: 'someExpr' }, 0, [])
      expect(result.ok).toBe(true)
      expect(result.skipped).toBeUndefined()
      expect(mock.sends.filter(s => s.method === 'Input.dispatchKeyEvent')).toHaveLength(2)
    }
  })

  it('when 写在 assert/type/eval 上 → 拒绝（when-unsupported），且不求值、不产生副作用', async () => {
    for (const step of [
      { action: 'assert', selector: '.x', exists: true, when: 'true' },
      { action: 'type', text: 'hi', into: '#i', when: 'true' },
      { action: 'eval', eval: '1', when: 'true' },
      { action: 'wait', wait: 1, when: 'true' },
    ] as unknown as ScriptStep[]) {
      const mock = makeFakeSession()
      const result = await runStep(mock, step, 0, [])
      expect(result.ok).toBe(false)
      expect(result.error).toContain('run-script/when-unsupported')
      expect(result.skipped).toBeUndefined()
      expect(mock.evalCalls).toHaveLength(0)
      expect(mock.sends).toHaveLength(0)
    }
  })

  it('when 是空串/非字符串 → 报 when-empty（不当作条件求值）', async () => {
    const mock = makeFakeSession()
    const shots: { name: string; base64: string; size: number }[] = []
    const blank = await runStep(mock, { action: 'key', key: 'Escape', when: '   ' }, 0, shots)
    expect(blank.ok).toBe(false)
    expect(blank.error).toContain('run-script/when-empty')
    const badType = await runStep(mock, { action: 'key', key: 'Escape', when: 1 as unknown as string }, 0, shots)
    expect(badType.ok).toBe(false)
    expect(badType.error).toContain('run-script/when-empty')
    expect(mock.sends).toHaveLength(0)
  })
})

describe('runScriptRemote: when 跳过不污染证据，后续步骤继续', () => {
  beforeEach(async () => { (await cdpClientMock()).__setBehavior(undefined) })

  it('key when false → 后续 assert 照常执行，顶层 ok:true 且无 console error', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({
      evaluate: (expression: string) => expression.includes('Boolean(await') ? false : 1,
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'key', key: 'Escape', when: 'window.__dialogOpen === true' },
        { action: 'assert', selector: '.x', exists: true },
      ],
    })

    expect(out.ok).toBe(true)
    expect(out.results).toHaveLength(2)
    expect(out.results[0]!.ok).toBe(true)
    expect(out.results[0]!.skipped?.reason).toBe('when-false')
    expect(out.results[1]!.ok).toBe(true)
    // 跳过 = 一个按键都没按
    const s = api.__closedSessions.at(-1)!
    expect(s.sends.some(m => m.method === 'Input.dispatchKeyEvent')).toBe(false)
    expect(out.console.errors).toHaveLength(0)
    expect(out.console.count).toBe(0)
  })

  it('全部步骤都 skip 时顶层仍 ok:true（跳步不是失败）', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({ evaluate: () => false })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'click', selector: '.a', when: 'false' },
        { action: 'key', key: 'Tab', when: 'false' },
      ],
    })

    expect(out.ok).toBe(true)
    expect(out.results.every(r => r.ok && r.skipped !== undefined)).toBe(true)
    const s = api.__closedSessions.at(-1)!
    expect(s.sends.some(m => m.method === 'Input.dispatchMouseEvent' || m.method === 'Input.dispatchKeyEvent')).toBe(false)
  })

  it('when 求值抛错 → 顶层 ok:false 且默认 failFast 不再往下跑', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({
      evaluate: (expression: string) => {
        if (expression.includes('Boolean(await')) throw new Error('boom')
        return 1
      },
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'key', key: 'Escape', when: 'window.__boom()' },
        { action: 'assert', selector: '.x', exists: true },
      ],
    })

    expect(out.ok).toBe(false)
    expect(out.results).toHaveLength(1)
    expect(out.results[0]!.ok).toBe(false)
    expect(out.results[0]!.error).toContain('run-script/when-threw')
    const s = api.__closedSessions.at(-1)!
    expect(s.sends.some(m => m.method === 'Input.dispatchKeyEvent')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// runScriptRemote: pageUrl（2026-11-07 裁决 5）
//
// 「脚本到底跑在哪一页」必须由 router 给**实际会话的 URL**，不能靠调用方事后
// evaluate 一次默认页猜。这里锁死三条出口：正常 / fail-closed / 建连失败。
// ─────────────────────────────────────────────────────────────────────────────

describe('runScriptRemote: pageUrl 回传实际会话页（裁决 5）', () => {
  beforeEach(async () => { (await cdpClientMock()).__setBehavior(undefined) })

  it('正常路径：pageUrl = 会话的 safeUrl（脱敏后），且与脚本跑在同一会话', async () => {
    const api = await cdpClientMock()
    const before = api.__closedSessions.length
    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [{ action: 'eval', eval: '1' }],
    })

    expect(out.ok).toBe(true)
    expect(out.pageUrl).toBe('http://127.0.0.1:9350/?token=<hidden>')
    // 不是「事后另开一次默认页」：整个调用只建了**一个**会话，且 pageUrl 就是它的
    expect(api.__closedSessions.length - before).toBe(1)
    expect(out.pageUrl).toBe(api.__closedSessions.at(-1)!.pageUrl)
  })

  it('fail-closed（开局视口残留）：仍然回传 pageUrl —— 要能回答「在哪一页发现视口坏了」', async () => {
    const api = await cdpClientMock()
    api.__setBehavior(STUCK_VIEWPORT_BEHAVIOR)

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [{ action: 'screenshot', screenshot: 'evidence' }],
    })

    expect(out.ok).toBe(false)
    expect(out.error?.code).toBe('cdp/viewport-not-restored')
    expect(out.pageUrl).toBe('http://127.0.0.1:9350/?token=<hidden>')
  })

  it('空 targetId：pageUrl 为 null（没有会话就不编造）', async () => {
    const empty = await new MockableService().runScriptRemote({ targetId: '' })
    expect(empty.pageUrl).toBeNull()
    expect(empty.error?.code).toBe('run-script/empty-target')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 真实输入步：hover / contextmenu / drag（2026-11-07）
//
// 三条纪律（与 click/key 一致，一个不落）：
//  1. **真实 Input**：只用 `Input.dispatchMouseEvent`，绝不用页内合成事件；
//  2. **可见性 fail-closed**：拿不到可命中的几何就 `ok:false`，一个 Input 都不发；
//  3. **证据含几何**：observed 里有派发坐标与元素尺寸（不读元素文本等敏感内容）。
// ─────────────────────────────────────────────────────────────────────────────

/** 可命中的元素几何（视口坐标 + 尺寸）。 */
const STEP_BOX = { x: 120, y: 240, width: 60, height: 24 }

describe('runStep: hover / contextmenu / drag', () => {
  it('hover → 一次真实 mouseMoved，observed 带坐标与几何', async () => {
    const mock = makeFakeSession()
    mock.pushEval(STEP_BOX)

    const result = await runStep(mock, { action: 'hover', selector: '.tip' }, 0, [])

    expect(result.ok).toBe(true)
    expect(result.action).toBe('hover')
    expect(result.observed).toContain('120,240')
    expect(result.observed).toContain('60x24')
    expect(mock.sends).toHaveLength(1)
    expect(mock.sends[0]!.params).toMatchObject({ type: 'mouseMoved', x: 120, y: 240, button: 'none', buttons: 0 })
    // 悬停不得带任何按下/抬起
    expect(mock.sends.some(s => s.params.type !== 'mouseMoved')).toBe(false)
  })

  it('contextmenu → 真实右键 pressed+released（button:right, clickCount:1）', async () => {
    const mock = makeFakeSession()
    mock.pushEval(STEP_BOX)

    const result = await runStep(mock, { action: 'contextmenu', selector: '.row' }, 0, [])

    expect(result.ok).toBe(true)
    expect(result.observed).toContain('120,240')
    expect(mock.sends.map(s => s.params.type)).toEqual(['mousePressed', 'mouseReleased'])
    expect(mock.sends[0]!.params).toMatchObject({ button: 'right', clickCount: 1 })
    expect(mock.sends[1]!.params).toMatchObject({ button: 'right', clickCount: 1 })
  })

  it('drag（toSelector）→ 多步 move，observed 写清终点与中间步数', async () => {
    const mock = makeFakeSession()
    mock.pushEval(STEP_BOX)
    mock.pushEval({ x: 400, y: 500, width: 80, height: 40 })

    const result = await runStep(mock, { action: 'drag', selector: '.card', toSelector: '.zone' }, 0, [])

    expect(result.ok).toBe(true)
    expect(result.observed).toContain('120,240')
    expect(result.observed).toContain('400,500')
    expect(result.observed).toContain('4 步')
    const moves = mock.sends.filter(s => s.params.type === 'mouseMoved')
    expect(moves.length).toBeGreaterThanOrEqual(3)
    expect(mock.sends.filter(s => s.params.type === 'mousePressed')).toHaveLength(1)
    expect(mock.sends.filter(s => s.params.type === 'mouseReleased')).toHaveLength(1)
  })

  it('drag（显式 to 坐标 + dragMoves）→ 读一次几何 + 一次 draggable 探针，非 draggable 不补发原生事件', async () => {
    const mock = makeFakeSession()
    mock.pushEval(STEP_BOX)
    mock.pushEval({ draggable: false, text: '' })

    const result = await runStep(mock, {
      action: 'drag',
      selector: '.card',
      to: { x: 300, y: 300 },
      dragMoves: 2,
    }, 0, [])

    expect(result.ok).toBe(true)
    expect(result.observed).toContain('300,300')
    expect(result.observed).toContain('未补发原生 DnD 事件')
    expect(mock.evalCalls).toHaveLength(2)
    // 1 move + press + 2 中间 move + 末次 move + release
    expect(mock.sends).toHaveLength(6)
  })

  it('drag 源元素 draggable ⇒ 补发原生事件，observed 如实写明（步骤 ok ≠ 拖成功）', async () => {
    const mock = makeFakeSession()
    mock.pushEval(STEP_BOX)
    mock.pushEval({ draggable: true, text: '卡片' })

    const result = await runStep(mock, {
      action: 'drag',
      selector: '.card',
      to: { x: 300, y: 300 },
      dragMoves: 2,
    }, 0, [])

    expect(result.ok).toBe(true)
    expect(result.observed).toContain('原生 dragEnter/dragOver/drop')
    expect(mock.sends.filter(s => s.method === 'Input.dispatchDragEvent')).toHaveLength(3)
  })

  it('dragNative:false ⇒ 不补发、也不读 draggable（指针驱动库场景显式关掉）', async () => {
    const mock = makeFakeSession()
    mock.pushEval(STEP_BOX)
    mock.pushEval({ x: 300, y: 300, w: 20, h: 20 })

    const result = await runStep(mock, {
      action: 'drag',
      selector: '.card',
      toSelector: '.zone',
      dragNative: false,
    }, 0, [])

    expect(result.ok).toBe(true)
    expect(mock.sends.some(s => s.method === 'Input.dispatchDragEvent')).toBe(false)
    // 只有两次几何（源 + 目标），没有第三次 draggable 探针
    expect(mock.evalCalls).toHaveLength(2)
    for (const expr of mock.evalCalls) expect(expr).not.toContain('draggable')
  })

  it('selector 缺失 → 每种动作各自报错（不猜、不静默跳过）', async () => {
    const cases: [ScriptStep, RegExp][] = [
      [{ action: 'hover' }, /hover 需要 selector/],
      [{ action: 'contextmenu' }, /contextmenu 需要 selector/],
      [{ action: 'drag' }, /drag 需要 selector/],
      [{ action: 'drag', selector: '.card' }, /toSelector 或 to/],
    ]
    for (const [step, pattern] of cases) {
      const mock = makeFakeSession()
      const result = await runStep(mock, step, 0, [])
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(pattern)
      expect(mock.sends).toHaveLength(0)
    }
  })

  it('元素不可见 → 原语抛具名错误（与 click 一致，由 runScriptRemote 折成本步 fail），不发任何 Input', async () => {
    const mock = makeFakeSession()
    mock.pushEval(null)

    await expect(runStep(mock, { action: 'hover', selector: '.gone' }, 0, []))
      .rejects.toThrow(/cdp\/hover-not-visible|不可见/)
    expect(mock.sends).toHaveLength(0)
  })
})

describe('runStep: when 作用于新真实输入步（truthy / falsy / 抛错）', () => {
  it('truthy ⇒ 派发真实 Input（三个动作各验一次）', async () => {
    // hover
    const hoverMock = makeFakeSession()
    hoverMock.pushEval(true) // when
    hoverMock.pushEval(STEP_BOX) // 几何
    const h = await runStep(hoverMock, { action: 'hover', selector: '.x', when: 'hasTip' }, 0, [])
    expect(h.ok).toBe(true)
    expect(h.skipped).toBeUndefined()
    expect(hoverMock.sends).toHaveLength(1)

    // contextmenu
    const ctxMock = makeFakeSession()
    ctxMock.pushEval(true)
    ctxMock.pushEval(STEP_BOX)
    const c = await runStep(ctxMock, { action: 'contextmenu', selector: '.x', when: 'hasMenu' }, 0, [])
    expect(c.ok).toBe(true)
    expect(c.skipped).toBeUndefined()
    expect(ctxMock.sends).toHaveLength(2)

    // drag
    const dragMock = makeFakeSession()
    dragMock.pushEval(true)
    dragMock.pushEval(STEP_BOX)
    const d = await runStep(dragMock, { action: 'drag', selector: '.x', to: { x: 1, y: 2 }, when: 'canDrag' }, 0, [])
    expect(d.ok).toBe(true)
    expect(d.skipped).toBeUndefined()
    expect(dragMock.sends.length).toBeGreaterThan(2)
  })

  it('falsy ⇒ ok:true + skipped（没有任何 Input，也没有读几何）', async () => {
    for (const step of [
      { action: 'hover', selector: '.x', when: 'false' },
      { action: 'contextmenu', selector: '.x', when: "''" },
      { action: 'drag', selector: '.x', toSelector: '.y', when: '0' },
    ] as unknown as ScriptStep[]) {
      const mock = makeFakeSession()
      mock.pushEval(false) // when 判假
      const result = await runStep(mock, step, 0, [])
      expect(result.ok).toBe(true)
      expect(result.skipped).toEqual({ skipped: true, reason: 'when-false', when: step.when })
      expect(result.observed).toContain('when-false')
      expect(mock.sends).toHaveLength(0)
      // 只求值了一次 when，没去读元素几何
      expect(mock.evalCalls).toHaveLength(1)
      expect(mock.evalCalls[0]).toContain('Boolean')
    }
  })

  it('when 求值抛错 ⇒ 本步 fail（fail-closed），不发 Input', async () => {
    const mock = makeFakeSession()
    mock.evaluate = async (expression: string) => {
      mock.evalCalls.push(expression)
      if (expression.includes('Boolean(await')) throw new CdpError('cdp/evaluate-threw', 'boom', 'evaluate')
      return STEP_BOX
    }

    const result = await runStep(mock, { action: 'drag', selector: '.x', toSelector: '.y', when: 'boom()' }, 0, [])

    expect(result.ok).toBe(false)
    expect(result.error).toContain('run-script/when-threw')
    expect(mock.sends).toHaveLength(0)
  })

  it('when 写在判据步上仍被拒（新增输入步不放宽这条边界）', async () => {
    const mock = makeFakeSession()
    const result = await runStep(mock, { action: 'assert', selector: '.x', exists: true, when: 'true' }, 0, [])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('run-script/when-unsupported')
    expect(mock.evalCalls).toHaveLength(0)
  })
})

describe('runScriptRemote: 新输入步不改变既有通路（pageUrl / 证据 / failFast）', () => {
  beforeEach(async () => { (await cdpClientMock()).__setBehavior(undefined) })

  it('hover/contextmenu/drag 串起来跑完：pageUrl 仍是会话真值，observed 有几何', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({
      evaluate: (expression: string) => {
        // 只对「读几何」的表达式回元素盒；其它（视口读取等）回真实视口
        if (expression.includes('getBoundingClientRect')) return STEP_BOX
        return JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
      },
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'hover', selector: '.tip' },
        { action: 'contextmenu', selector: '.row' },
        { action: 'drag', selector: '.card', to: { x: 300, y: 300 }, dragMoves: 2 },
      ],
    })

    expect(out.ok).toBe(true)
    expect(out.pageUrl).toBe('http://127.0.0.1:9350/?token=<hidden>')
    expect(out.results).toHaveLength(3)
    expect(out.results.map(r => r.action)).toEqual(['hover', 'contextmenu', 'drag'])
    for (const r of out.results) expect(r.observed).toContain('120,240')
  })

  it('新输入步不可见 ⇒ 该步 fail（failFast 生效，后续步不跑）', async () => {
    const api = await cdpClientMock()
    api.__setBehavior({
      evaluate: (expression: string) => {
        if (expression.includes('getBoundingClientRect')) return null
        return JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
      },
    })

    const out = await new MockableService().runScriptRemote({
      targetId: 't1',
      steps: [
        { action: 'hover', selector: '.gone' },
        { action: 'eval', eval: '1' },
      ],
    })

    expect(out.ok).toBe(false)
    expect(out.results).toHaveLength(1)
    expect(out.results[0]!.error).toContain('cdp/hover-not-visible')
  })
})
