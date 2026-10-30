import { describe, expect, it } from 'vitest'

import {
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
      summary: () => ({
        console: {
          count: consoleEntries.length,
          errors: consoleEntries.filter(e => e.kind === 'error' || e.kind === 'exception').map(e => e.text),
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

  it('resize reset → ok=true', async () => {
    const mock = makeFakeSession()
    const screenshots: { name: string; base64: string; size: number }[] = []

    const result = await runStep(mock, { action: 'resize', resize: { reset: true } }, 0, screenshots)

    expect(result.ok).toBe(true)
    expect(mock.sends[0]!.method).toBe('Emulation.clearDeviceMetricsOverride')
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
