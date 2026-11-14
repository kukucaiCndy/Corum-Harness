import { describe, expect, it, vi } from 'vitest'

import {
  buildFinder,
  click,
  captureScreenshot,
  contextMenu,
  drag,
  ensureRealViewport,
  hover,
  insertText,
  pressKey,
  resize,
  readViewport,
  redactUrl,
  pickCorumPages,
  listPages,
  visibleElementBox,
  type CdpSession,
  type CdpParams,
} from '../src/cdp-client.js'

// ─────────────────────────────────────────────────────────────────────────────
// 假 session：记录所有 send 的 method+params（顺序敏感），按预设返回值。
// ─────────────────────────────────────────────────────────────────────────────

interface MockSend {
  method: string
  params: CdpParams
}

function makeMockSession(overrides: Partial<CdpSession> = {}): CdpSession & {
  sends: MockSend[]
  evaluateCalls: string[]
  setEvalResult: (val: unknown) => void
} {
  const sends: MockSend[] = []
  const evaluateCalls: string[] = []
  let evalResult: unknown = null

  const session: CdpSession = {
    pageId: 'fake-page-1',
    pageUrl: 'http://127.0.0.1:9350/?token=<hidden>',
    evaluate: async (expression: string) => {
      evaluateCalls.push(expression)
      return evalResult
    },
    send: async (method: string, params: CdpParams = {}) => {
      sends.push({ method, params })
      return {}
    },
    close: () => {},
    evidence: {
      console: [],
      network: [],
      failed: [],
      markStart: () => {},
      summary: () => ({
        console: { count: 0, errors: [], preExisting: 0, windowStartMs: null },
        network: { count: 0, failed: [] },
      }),
    },
    ...overrides,
  }

  return Object.assign(session, {
    sends,
    evaluateCalls,
    setEvalResult: (val: unknown) => { evalResult = val },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// redactUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('redactUrl', () => {
  it('抹掉 token 参数', () => {
    expect(redactUrl('http://127.0.0.1:9350/?token=secret123')).toBe('http://127.0.0.1:9350/?token=<hidden>')
  })
  it('抹掉 access_token 参数', () => {
    expect(redactUrl('http://127.0.0.1:9350/?access_token=abc&foo=bar')).toBe('http://127.0.0.1:9350/?access_token=<hidden>&foo=bar')
  })
  it('无 token 时原样返回', () => {
    expect(redactUrl('http://127.0.0.1:9350/')).toBe('http://127.0.0.1:9350/')
  })
})

describe('listPages 目标地址', () => {
  it('默认仍连本机', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    try { await listPages(9333); expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9333/json/list') }
    finally { fetchMock.mockRestore() }
  })
  it('远程 IPv4 与 IPv6 使用 target.ip，不改写页面 URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('[]'))
    try {
      await listPages(9333, 2000, '10.0.0.5')
      await listPages(9333, 2000, '::1')
      expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['http://10.0.0.5:9333/json/list', 'http://[::1]:9333/json/list'])
    } finally { fetchMock.mockRestore() }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// pickCorumPages
// ─────────────────────────────────────────────────────────────────────────────

describe('pickCorumPages', () => {
  it('只选 type=page 且 loopback http 的', () => {
    const targets = [
      { id: '1', type: 'page', url: 'http://127.0.0.1:9350/?token=x', webSocketDebuggerUrl: 'ws://1' },
      { id: '2', type: 'page', url: 'corumapp://startup/', webSocketDebuggerUrl: 'ws://2' },
      { id: '3', type: 'worker', url: 'http://127.0.0.1:9350/', webSocketDebuggerUrl: 'ws://3' },
      { id: '4', type: 'page', url: 'http://127.0.0.1:9350/floating=a', webSocketDebuggerUrl: 'ws://4' },
    ]
    const pages = pickCorumPages(targets)
    expect(pages).toHaveLength(2)
    expect(pages[0]!.id).toBe('1')
    expect(pages[1]!.id).toBe('4')
  })
  it('safeUrl 已脱敏', () => {
    const pages = pickCorumPages([
      { id: '1', type: 'page', url: 'http://127.0.0.1:9350/?token=secret', webSocketDebuggerUrl: 'ws://1' },
    ])
    expect(pages[0]!.safeUrl).toBe('http://127.0.0.1:9350/?token=<hidden>')
    expect(pages[0]!.rawUrl).toBe('http://127.0.0.1:9350/?token=secret')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildFinder
// ─────────────────────────────────────────────────────────────────────────────

describe('buildFinder', () => {
  it('CSS 选择器 → document.querySelector', () => {
    const expr = buildFinder('.my-button')
    expect(expr).toContain('document.querySelector')
    expect(expr).toContain('.my-button')
  })
  it('text: 前缀 → 在 button/a/[role=button] 里找 innerText 匹配', () => {
    const expr = buildFinder('text:提交')
    expect(expr).toContain('button')
    expect(expr).toContain('提交')
    expect(expr).toContain('innerText')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// click
// ─────────────────────────────────────────────────────────────────────────────

describe('click', () => {
  it('真实鼠标：evaluate 取中心坐标 → Input.dispatchMouseEvent pressed+released', async () => {
    const mock = makeMockSession()
    mock.setEvalResult({ x: 100, y: 200, w: 40, h: 30 })

    const result = await click(mock, '.btn')

    expect(result.ok).toBe(true)
    expect(result.x).toBe(100)
    expect(result.y).toBe(200)
    // 两次 dispatchMouseEvent：pressed + released
    expect(mock.sends).toHaveLength(2)
    expect(mock.sends[0]!.method).toBe('Input.dispatchMouseEvent')
    expect(mock.sends[0]!.params).toMatchObject({ type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 })
    expect(mock.sends[1]!.params).toMatchObject({ type: 'mouseReleased', x: 100, y: 200 })
  })

  it('clickJs=true → 走 el.click() 合成点击，不发 Input 事件', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(true)

    const result = await click(mock, '.btn', { clickJs: true })

    expect(result.ok).toBe(true)
    expect(mock.sends).toHaveLength(0) // 没有 Input.dispatchMouseEvent
    expect(mock.evaluateCalls[0]).toContain('el.click()')
  })

  it('元素不存在 → 抛 CdpError', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(null)

    await expect(click(mock, '.missing')).rejects.toThrow(/找不到元素/)
  })

  it('元素宽高为 0 → 抛 CdpError（不可见）', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(null) // box 为 null（width=height=0 的分支返回 null）

    await expect(click(mock, '.hidden')).rejects.toThrow(/找不到元素/)
  })

  it('text: 选择器 → evaluate 用 button/a/[role=button] finder', async () => {
    const mock = makeMockSession()
    mock.setEvalResult({ x: 50, y: 50, w: 10, h: 10 })

    await click(mock, 'text:确定')
    expect(mock.evaluateCalls[0]).toContain('button')
    expect(mock.evaluateCalls[0]).toContain('确定')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// insertText
// ─────────────────────────────────────────────────────────────────────────────

describe('insertText', () => {
  it('into 给了 → 先 focus → Input.insertText → 无 submit 无 expectValue', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(true) // focus 成功

    const result = await insertText(mock, 'hello', { into: '#input' })

    expect(result.ok).toBe(true)
    // 一次 evaluate（focus）+ 一次 send（insertText）
    expect(mock.evaluateCalls).toHaveLength(1)
    expect(mock.evaluateCalls[0]).toContain('focus()')
    expect(mock.sends).toHaveLength(1)
    expect(mock.sends[0]!.method).toBe('Input.insertText')
    expect(mock.sends[0]!.params).toMatchObject({ text: 'hello' })
  })

  it('submit=true → insertText 后追加 Enter keyDown+keyUp', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(true)

    await insertText(mock, 'hi', { into: '#input', submit: true })

    // 1 insertText + 2 keyEvent (down + up)
    expect(mock.sends).toHaveLength(3)
    expect(mock.sends[0]!.method).toBe('Input.insertText')
    expect(mock.sends[1]!.method).toBe('Input.dispatchKeyEvent')
    expect(mock.sends[1]!.params).toMatchObject({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 })
    expect(mock.sends[2]!.params).toMatchObject({ type: 'keyUp', key: 'Enter' })
  })

  it('expectValue 匹配 → matched=true', async () => {
    const mock = makeMockSession()
    // 第一次 evaluate: focus → true；第二次 evaluate: 读回 value → 'hello'
    let callCount = 0
    mock.evaluate = async () => {
      callCount++
      if (callCount === 1) return true // focus
      return 'hello' // value readback
    }

    const result = await insertText(mock, 'hello', { into: '#input', expectValue: 'hello' })

    expect(result.ok).toBe(true)
    expect(result.matched).toBe(true)
    expect(result.observed).toBe('hello')
  })

  it('expectValue 不匹配 → matched=false 但 ok=true', async () => {
    const mock = makeMockSession()
    let callCount = 0
    mock.evaluate = async () => {
      callCount++
      if (callCount === 1) return true
      return 'wrong'
    }

    const result = await insertText(mock, 'hello', { into: '#input', expectValue: 'hello' })

    expect(result.matched).toBe(false)
    expect(result.observed).toBe('wrong')
  })

  it('into 找不到元素 → 抛 CdpError', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(false) // focus 失败

    await expect(insertText(mock, 'hi', { into: '#missing' })).rejects.toThrow(/找不到元素/)
  })

  it('没给 into 且无聚焦输入元素 → 抛 CdpError', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(null) // focused 为 null

    await expect(insertText(mock, 'hi')).rejects.toThrow(/没有聚焦/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// pressKey
// ─────────────────────────────────────────────────────────────────────────────

describe('pressKey', () => {
  it('单字符 → keyDown+keyUp，code=KeyX', async () => {
    const mock = makeMockSession()
    await pressKey(mock, 'a')

    expect(mock.sends).toHaveLength(2)
    expect(mock.sends[0]!.method).toBe('Input.dispatchKeyEvent')
    expect(mock.sends[0]!.params).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 })
    expect(mock.sends[1]!.params).toMatchObject({ type: 'keyUp', key: 'a' })
  })

  it('Enter → vk=13', async () => {
    const mock = makeMockSession()
    await pressKey(mock, 'Enter')

    expect(mock.sends[0]!.params).toMatchObject({ key: 'Enter', windowsVirtualKeyCode: 13 })
  })

  it('Escape → vk=27', async () => {
    const mock = makeMockSession()
    await pressKey(mock, 'Escape')
    expect(mock.sends[0]!.params).toMatchObject({ key: 'Escape', windowsVirtualKeyCode: 27 })
  })

  it('Meta+a → modifiers=4（meta 位）', async () => {
    const mock = makeMockSession()
    await pressKey(mock, 'Meta+a')

    expect(mock.sends[0]!.params).toMatchObject({ key: 'a', modifiers: 4 })
  })

  it('Control+Shift+s → modifiers=10（ctrl=2 + shift=8）', async () => {
    const mock = makeMockSession()
    await pressKey(mock, 'Control+Shift+s')

    expect(mock.sends[0]!.params).toMatchObject({ key: 's', modifiers: 10 })
  })

  it('ArrowDown → vk=40', async () => {
    const mock = makeMockSession()
    await pressKey(mock, 'ArrowDown')
    expect(mock.sends[0]!.params).toMatchObject({ key: 'ArrowDown', windowsVirtualKeyCode: 40 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// captureScreenshot
// ─────────────────────────────────────────────────────────────────────────────

describe('captureScreenshot', () => {
  it('返回 base64 + size', async () => {
    const mock = makeMockSession()
    mock.send = async () => ({ data: 'iVBORw0KGgo=', metadata: { deviceWidth: 800, deviceHeight: 600 } })

    const result = await captureScreenshot(mock)

    expect(result.base64).toBe('iVBORw0KGgo=')
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
    expect(result.size).toBeGreaterThan(0)
  })

  it('空数据 → 抛 CdpError', async () => {
    const mock = makeMockSession()
    mock.send = async () => ({ data: '' })

    await expect(captureScreenshot(mock)).rejects.toThrow(/空数据/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resize
// ─────────────────────────────────────────────────────────────────────────────

describe('resize', () => {
  it('设置尺寸 → Emulation.setDeviceMetricsOverride', async () => {
    const mock = makeMockSession()
    await resize(mock, { width: 1100, height: 620 })

    expect(mock.sends).toHaveLength(1)
    expect(mock.sends[0]!.method).toBe('Emulation.setDeviceMetricsOverride')
    expect(mock.sends[0]!.params).toMatchObject({ width: 1100, height: 620, deviceScaleFactor: 0, mobile: false })
  })

  it('reset=true 且复核恢复真实 → 只发 clear，不抛', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })

    await resize(mock, { reset: true })

    expect(mock.sends).toHaveLength(1)
    expect(mock.sends[0]!.method).toBe('Emulation.clearDeviceMetricsOverride')
  })

  // ── 2026-11-07 事故：clear 的应答不等于复原 ─────────────────────────────

  it('reset=true 但复核仍 emulated → 先重载页面再复核；救不回才抛 cdp/viewport-not-restored', async () => {
    const mock = makeMockSession()
    // 实机复现：clear 返回 {}、重载也没救回来（视口始终 1219x427）
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1219, innerHeight: 427, outerWidth: 1280, outerHeight: 860 })

    await expect(resize(mock, { reset: true })).rejects.toMatchObject({
      name: 'CdpError',
      code: 'cdp/viewport-not-restored',
    })
    // 仍然真的发过 clear（不是嘴上说要清）
    expect(mock.sends.filter(m => m.method === 'Emulation.clearDeviceMetricsOverride').length).toBeGreaterThanOrEqual(1)
    // 而且**试过重载**（2026-11-07「一条用例毒死整轮」的补救动作）
    expect(mock.sends.filter(m => m.method === 'Page.reload')).toHaveLength(1)
  })

  // 2026-11-07 rc3 实测：残留 override 新会话清不掉，但 Page.reload() 能救回来。
  // 救得回来时 reset 必须**算成功**（否则一条 resize 用例会毒死同一轮后续所有用例）。
  it('reset=true 复核仍 emulated、但重载后视口真实 → 算成功，不再抛错', async () => {
    const mock = makeMockSession()
    let n = 0
    mock.evaluate = async (expression: string) => {
      // 前 4 次（clear 后的 3 次复核 + 轮询就绪）仍 emulated；重载后转 real
      n += 1
      const reloaded = mock.sends.some(m => m.method === 'Page.reload')
      if (expression.includes('readyState')) return reloaded ? true : false
      return JSON.stringify(reloaded
        ? { innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 }
        : { innerWidth: 1219, innerHeight: 427, outerWidth: 1280, outerHeight: 860 })
    }

    await expect(resize(mock, { reset: true })).resolves.toBeUndefined()
    expect(mock.sends.filter(m => m.method === 'Page.reload')).toHaveLength(1)
    expect(n).toBeGreaterThan(1)
  })

  it('reset=true 但量不出外框（unmeasurable）→ 仍重载一次（判据失明时宁可多刷一页）', async () => {
    const mock = makeMockSession()
    // outer 量不出来：既不能判「被覆盖」，也不能判「已复原」——只靠 clear 会留下看不见的假视口
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1219, innerHeight: 427, outerWidth: 0, outerHeight: 0 })

    await expect(resize(mock, { reset: true })).resolves.toBeUndefined()
    expect(mock.sends.filter(m => m.method === 'Emulation.clearDeviceMetricsOverride').length).toBeGreaterThanOrEqual(1)
    expect(mock.sends.filter(m => m.method === 'Page.reload')).toHaveLength(1)
  })

  it('reset=true 且量不出外框（unmeasurable）→ 不抛（无头下不能判残留）', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 0, outerHeight: 0 })

    await expect(resize(mock, { reset: true })).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ensureRealViewport：残留 override 的自愈与复核（2026-11-07 事故）
// ─────────────────────────────────────────────────────────────────────────────

describe('ensureRealViewport', () => {
  it('视口本来真实 → 不发 clear，cleared=false / restored=true', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })

    const outcome = await ensureRealViewport(mock)

    expect(outcome.cleared).toBe(false)
    expect(outcome.restored).toBe(true)
    expect(mock.sends).toHaveLength(0)
  })

  it('残留 override + clear 生效 → cleared=true / restored=true（自愈）', async () => {
    const mock = makeMockSession()
    let calls = 0
    mock.evaluate = async () => {
      calls += 1
      return calls === 1
        ? JSON.stringify({ innerWidth: 1219, innerHeight: 427, outerWidth: 1280, outerHeight: 860 })
        : JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })
    }

    const outcome = await ensureRealViewport(mock, { delayMs: 0 })

    expect(outcome.cleared).toBe(true)
    expect(outcome.restored).toBe(true)
    expect(mock.sends.map(m => m.method)).toEqual(['Emulation.clearDeviceMetricsOverride'])
  })

  it('残留 override + clear 是 no-op → restored=false（连续复测仍 emulated）', async () => {
    const mock = makeMockSession()
    let reads = 0
    mock.evaluate = async () => {
      reads += 1
      return JSON.stringify({ innerWidth: 1219, innerHeight: 427, outerWidth: 1280, outerHeight: 860 })
    }

    const outcome = await ensureRealViewport(mock, { delayMs: 0, attempts: 2 })

    expect(outcome.cleared).toBe(true)
    expect(outcome.restored).toBe(false)
    expect(outcome.viewport.geometry).toBe('emulated')
    // 首测 1 次 + 复核 attempts 次（不信应答，只信实测）
    expect(reads).toBe(3)
  })

  it('force=true → 即使当前视口真实也先发 clear，再复核', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })

    const outcome = await ensureRealViewport(mock, { force: true, delayMs: 0 })

    expect(outcome.cleared).toBe(true)
    expect(outcome.restored).toBe(true)
    expect(mock.sends.map(m => m.method)).toEqual(['Emulation.clearDeviceMetricsOverride'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// readViewport（2026-11-02 假视口事故修复）
// ─────────────────────────────────────────────────────────────────────────────

describe('readViewport', () => {
  it('真实窗口（inner===outer）→ geometry=real / emulated=false', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })

    const vp = await readViewport(mock)

    expect(vp).toEqual({
      innerWidth: 1280,
      innerHeight: 860,
      outerWidth: 1280,
      outerHeight: 860,
      emulated: false,
      geometry: 'real',
    })
  })

  it('inner!==outer（override 残留）→ emulated=true', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 620, outerWidth: 1280, outerHeight: 500 })

    const vp = await readViewport(mock)

    expect(vp.emulated).toBe(true)
    expect(vp.geometry).toBe('emulated')
  })

  it('仅宽度不等也判 emulated=true', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1100, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })

    expect((await readViewport(mock)).emulated).toBe(true)
  })

  // ── T1：外框量不到时不得假装「真实」也不得假装「模拟」 ────────────────────

  it('outer=0（无头/隐藏窗口）→ geometry=unmeasurable 且 emulated=false', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 0, outerHeight: 0 })

    const vp = await readViewport(mock)

    expect(vp.geometry).toBe('unmeasurable')
    // 「量不出来」不等于「模拟视口」——不把 emulated 当 true。
    expect(vp.emulated).toBe(false)
  })

  it('outer 非有限（NaN）→ unmeasurable', async () => {
    const mock = makeMockSession()
    // JSON 不能表示 NaN，直接给字符串 'x' 走 Number.isFinite 的 false 分支
    mock.evaluate = async () => '{"innerWidth":1280,"innerHeight":860,"outerWidth":"x","outerHeight":null}'

    const vp = await readViewport(mock)

    expect(vp.geometry).toBe('unmeasurable')
    expect(vp.emulated).toBe(false)
  })

  it('已知 override 生效 → 优先判 emulated（即使 outer=0 或 inner===outer）', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1280, outerHeight: 860 })

    const vp = await readViewport(mock, { overrideActive: true })

    expect(vp.geometry).toBe('emulated')
    expect(vp.emulated).toBe(true)
  })

  it('已知 override 生效 + outer=0 → 仍判 emulated（override 的确定性高于测量）', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 800, innerHeight: 600, outerWidth: 0, outerHeight: 0 })

    const vp = await readViewport(mock, { overrideActive: true })

    expect(vp.geometry).toBe('emulated')
    expect(vp.emulated).toBe(true)
  })

  // ── 平台边框容差（2026-11-14 远程 Windows 真机：inner!==outer 是原生边框，不是 override）──

  it('win32 真实窗口（实测 1280x860 / 1296x868，边框差 16x8）→ real', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1296, outerHeight: 868, platform: 'win32' })

    const vp = await readViewport(mock)

    expect(vp.geometry).toBe('real')
    expect(vp.emulated).toBe(false)
  })

  it('win32 override 残留（900x600 / 1296x868，差远超边框）→ emulated', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 900, innerHeight: 600, outerWidth: 1296, outerHeight: 868, platform: 'win32' })

    expect((await readViewport(mock)).geometry).toBe('emulated')
  })

  it('win32 上 2026-11-02 事故形态（高度差 240）仍被拦下（容差不吞事故）', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 620, outerWidth: 1280, outerHeight: 860, platform: 'win32' })

    expect((await readViewport(mock)).geometry).toBe('emulated')
  })

  it('linux WM 装饰（高度差 48 ≤ 128）→ real', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 820, outerWidth: 1296, outerHeight: 868, platform: 'linux' })

    expect((await readViewport(mock)).geometry).toBe('real')
  })

  it('darwin 保持严格判据：inner!==outer → emulated（无容差）', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 852, outerWidth: 1280, outerHeight: 860, platform: 'darwin' })

    expect((await readViewport(mock)).geometry).toBe('emulated')
  })

  it('平台读不到（旧基座无桥）→ 保持严格判据（向后兼容，不猜平台）', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1280, innerHeight: 860, outerWidth: 1296, outerHeight: 868, platform: null })

    expect((await readViewport(mock)).geometry).toBe('emulated')
  })

  it('win32 inner>outer（边框只增不减，此形态必是异常）→ emulated', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1400, innerHeight: 900, outerWidth: 1296, outerHeight: 868, platform: 'win32' })

    expect((await readViewport(mock)).geometry).toBe('emulated')
  })

  it('win32 容差内但已知 override 生效 → 仍 emulated（确定性高于测量）', async () => {
    const mock = makeMockSession()
    mock.evaluate = async () => JSON.stringify({ innerWidth: 1272, innerHeight: 856, outerWidth: 1296, outerHeight: 868, platform: 'win32' })

    expect((await readViewport(mock, { overrideActive: true })).geometry).toBe('emulated')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 真实输入原语：hover / contextmenu / drag（2026-11-07）
//
// 这三条的共同纪律：**只用 `Input.dispatchMouseEvent`**（真实事件），
// 且派发前必须先证明元素可见、中心点在视口内（不可命中就 fail-closed，不发半套事件）。
// 下面的断言全部盯着 `send` 的**顺序与参数**，因为「事件顺序错了」在页面上
// 表现为「什么都没发生」，而不是报错。
// ─────────────────────────────────────────────────────────────────────────────

/** 元素中心的典型返回值（视口坐标 + 尺寸）。 */
const BOX = { x: 100, y: 200, width: 40, height: 30 }

describe('visibleElementBox', () => {
  it('可命中的元素 → 中心坐标 + 尺寸', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(BOX)

    expect(await visibleElementBox(mock, '.btn')).toEqual(BOX)
  })

  it('不可见 / 找不到 → null（不抛：判据由调用方决定）', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(null)

    expect(await visibleElementBox(mock, '.missing')).toBeNull()
  })

  it('求值表达式覆盖可见性口径：display/visibility/opacity + 中心点落在视口内', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(BOX)

    await visibleElementBox(mock, '.btn')

    const expr = mock.evaluateCalls[0]!
    expect(expr).toContain('getBoundingClientRect')
    expect(expr).toContain("cs.display === 'none'")
    expect(expr).toContain("cs.visibility === 'hidden'")
    expect(expr).toContain('Number(cs.opacity) === 0')
    expect(expr).toContain('window.innerWidth')
    expect(expr).toContain('window.innerHeight')
  })
})

describe('hover', () => {
  it('只发一次 mouseMoved（button:none, buttons:0）——绝不带 mousePressed', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(BOX)

    const result = await hover(mock, '.tip')

    expect(result).toEqual({ ok: true, ...BOX })
    expect(mock.sends).toHaveLength(1)
    expect(mock.sends[0]!.method).toBe('Input.dispatchMouseEvent')
    expect(mock.sends[0]!.params).toMatchObject({ type: 'mouseMoved', x: 100, y: 200, button: 'none', buttons: 0 })
    // 「悬停变成点击」是这条原语最危险的退化，单独钉死
    expect(mock.sends.some(s => s.params.type === 'mousePressed' || s.params.type === 'mouseReleased')).toBe(false)
  })

  it('元素不可见 → fail-closed：抛错且一个 Input 都不发', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(null)

    await expect(hover(mock, '.gone')).rejects.toThrow(/不可见/)
    expect(mock.sends).toHaveLength(0)
  })

  it('text: 选择器走同一套 finder', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(BOX)

    await hover(mock, 'text:悬停我')

    expect(mock.evaluateCalls[0]).toContain('button')
    expect(mock.evaluateCalls[0]).toContain('悬停我')
    expect(mock.sends).toHaveLength(1)
  })
})

describe('contextMenu', () => {
  it('真实右键：mousePressed → mouseReleased，button:right + clickCount:1', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(BOX)

    const result = await contextMenu(mock, '.row')

    expect(result).toEqual({ ok: true, ...BOX })
    expect(mock.sends.map(s => s.method)).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'])
    expect(mock.sends[0]!.params).toMatchObject({
      type: 'mousePressed', x: 100, y: 200, button: 'right', buttons: 2, clickCount: 1,
    })
    expect(mock.sends[1]!.params).toMatchObject({
      type: 'mouseReleased', x: 100, y: 200, button: 'right', buttons: 0, clickCount: 1,
    })
    // 不允许退化成左键（左键打开的是选中态，不是菜单）
    expect(mock.sends.some(s => s.params.button === 'left')).toBe(false)
  })

  it('不可见 → fail-closed：抛错且不发 Input', async () => {
    const mock = makeMockSession()
    mock.setEvalResult(null)

    await expect(contextMenu(mock, '.gone')).rejects.toThrow(/不可见/)
    expect(mock.sends).toHaveLength(0)
  })
})

describe('drag', () => {
  /** 依次返回源元素 box、目标元素 box 的 evaluate。 */
  function twoBoxes(source: unknown, target: unknown): ReturnType<typeof makeMockSession> {
    const mock = makeMockSession()
    let n = 0
    mock.evaluate = async (expression: string) => {
      mock.evaluateCalls.push(expression)
      n += 1
      return n === 1 ? source : target
    }
    return mock
  }

  it('toSelector：mouseMoved(源) → pressed(left) → 多步 move → 末次 move → released(left)', async () => {
    const mock = twoBoxes({ x: 100, y: 200, width: 40, height: 30 }, { x: 300, y: 400, width: 20, height: 20 })

    const result = await drag(mock, '.card', { toSelector: '.zone' })

    expect(result.from).toEqual({ x: 100, y: 200 })
    expect(result.to).toEqual({ x: 300, y: 400 })
    expect(result.moves).toBe(4)
    // 1(源 move) + 1(press) + 4(中间 move) + 1(末次 move) + 1(release)
    expect(mock.sends).toHaveLength(8)
    expect(mock.sends.map(s => s.params.type)).toEqual([
      'mouseMoved', 'mousePressed',
      'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved',
      'mouseMoved', 'mouseReleased',
    ])
    // 按下是左键；中间移动全程 buttons=1（按住状态）；抬起后 buttons=0
    expect(mock.sends[1]!.params).toMatchObject({ x: 100, y: 200, button: 'left', buttons: 1, clickCount: 1 })
    for (const move of mock.sends.slice(2, 7)) {
      expect(move.params).toMatchObject({ button: 'none', buttons: 1 })
    }
    expect(mock.sends.at(-1)!.params).toMatchObject({ type: 'mouseReleased', x: 300, y: 400, button: 'left', buttons: 0 })
    // 中间位置必须**单调推进**（不是原地重复，也不是一步瞬移）
    const xs = mock.sends.slice(2, 7).map(s => Number(s.params.x))
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(new Set(xs).size).toBeGreaterThan(3)
  })

  it('to{x,y}：不再读第二个元素（显式坐标就是终点）', async () => {
    const mock = makeMockSession()
    mock.setEvalResult({ x: 100, y: 200, width: 40, height: 30 })

    const result = await drag(mock, '.card', { to: { x: 500, y: 250 } })

    expect(result.to).toEqual({ x: 500, y: 250 })
    // ①源元素几何 ②draggable 事实（第二元素确实没被读）
    expect(mock.evaluateCalls).toHaveLength(2)
    expect(mock.evaluateCalls[0]).toContain('getBoundingClientRect')
    expect(mock.evaluateCalls[1]).toContain('draggable')
    expect(mock.sends.at(-1)!.params).toMatchObject({ type: 'mouseReleased', x: 500, y: 250 })
  })

  it('dragMoves 可调（1 步 ⇒ 共 5 次 dispatch）', async () => {
    const mock = makeMockSession()
    mock.setEvalResult({ x: 0, y: 0, width: 10, height: 10 })

    await drag(mock, '.card', { to: { x: 10, y: 10 }, moves: 1 })

    expect(mock.sends).toHaveLength(5)
  })

  it('moves 非有限（NaN / Infinity）退回默认 4 步，不是 0 步假拖拽', async () => {
    for (const moves of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const mock = makeMockSession()
      mock.setEvalResult({ x: 0, y: 0, width: 10, height: 10 })

      const result = await drag(mock, '.card', { to: { x: 10, y: 10 }, moves })

      // 「move(源) + press + 4 步插值 + move(终点) + release」= 8 次 dispatch
      expect(mock.sends, String(moves)).toHaveLength(8)
      expect(result.moves, String(moves)).toBe(4)
      const interpolated = mock.sends.filter(s => (s.params as { buttons?: number }).buttons === 1 && s.params.type === 'mouseMoved')
      expect(interpolated, `${String(moves)} 应产生 5 次真实移动`).toHaveLength(5)
    }
  })

  it('源不可见 → fail-closed（cdp/drag-source-not-visible），不发 Input', async () => {
    const mock = twoBoxes(null, { x: 1, y: 1, width: 1, height: 1 })

    await expect(drag(mock, '.gone', { toSelector: '.zone' })).rejects.toThrow(/拖拽源/)
    expect(mock.sends).toHaveLength(0)
  })

  it('目标不可见 → fail-closed（cdp/drag-target-not-visible），只读了两次几何、不发 Input', async () => {
    const mock = twoBoxes({ x: 100, y: 200, width: 40, height: 30 }, null)

    await expect(drag(mock, '.card', { toSelector: '.gone' })).rejects.toThrow(/拖拽目标/)
    expect(mock.evaluateCalls).toHaveLength(2)
    expect(mock.sends).toHaveLength(0)
  })

  it('既没 toSelector 也没 to → 报缺终点；to 非有限数字 → 报坐标非法（都不发 Input）', async () => {
    const mock = makeMockSession()
    mock.setEvalResult({ x: 100, y: 200, width: 40, height: 30 })

    await expect(drag(mock, '.card', {})).rejects.toThrow(/toSelector 或 to/)
    await expect(drag(mock, '.card', { to: { x: Number.NaN, y: 1 } })).rejects.toThrow(/有限数字/)
    expect(mock.sends).toHaveLength(0)
  })

  it('绝不使用页内合成 MouseEvent：Input 域只发 mouse/drag 事件，页内求值只读几何与 draggable', async () => {
    const mock = makeMockSession()
    mock.setEvalResult({ x: 10, y: 20, width: 30, height: 40 })

    await drag(mock, '.card', { to: { x: 50, y: 60 } })

    for (const send of mock.sends) {
      expect(['Input.dispatchMouseEvent', 'Input.dispatchDragEvent']).toContain(send.method)
    }
    // 两次页内求值：①读几何 ②读 draggable 事实；都不许自己 dispatchEvent
    expect(mock.evaluateCalls).toHaveLength(2)
    for (const expr of mock.evaluateCalls) {
      expect(expr).not.toContain('dispatchEvent')
      expect(expr).not.toContain('new MouseEvent')
    }
  })

  /**
   * 原生 HTML5 拖放（2026-11-07 实测）：合成 mouse 事件在 Chromium 里**起不了**原生
   * drag session（每步加 20–50ms、窗口 front、`Input.setInterceptDrags` 都不行，拦截数 0），
   * 而 `Input.dispatchDragEvent` 能让页面收到 `isTrusted:true` 的 dragenter/dragover/drop。
   * 这一组钉住「补发这条通路」以及补发条件。
   */
  it('源元素 draggable ⇒ 补发 dragEnter/dragOver/drop（release 之前，带 text/plain 载荷）', async () => {
    const mock = makeMockSession()
    let n = 0
    mock.evaluate = async (expression: string) => {
      mock.evaluateCalls.push(expression)
      n += 1
      if (n === 1) return { x: 100, y: 200, width: 40, height: 30 }
      return { draggable: true, text: '可拖拽卡片' }
    }
    const result = await drag(mock, '.card', { to: { x: 300, y: 400 }, moves: 1 })

    const dragEvents = mock.sends.filter(s => s.method === 'Input.dispatchDragEvent')
    expect(dragEvents.map(s => s.params.type)).toEqual(['dragEnter', 'dragOver', 'drop'])
    for (const event of dragEvents) expect(event.params).toMatchObject({ x: 300, y: 400 })
    expect(dragEvents[2]!.params.data).toMatchObject({
      items: [{ mimeType: 'text/plain', data: '可拖拽卡片' }],
      dragOperationsMask: 1,
    })
    // 原生事件必须在鼠标仍按下时派发：最后一条是 release，且在所有 drag 事件之后
    expect(mock.sends.at(-1)!.params.type).toBe('mouseReleased')
    expect(result.nativeDrag).toBe(true)
  })

  it('源元素不是 draggable（含读不到）⇒ 不补发，nativeDrag=false 如实回报', async () => {
    for (const facts of [{ draggable: false, text: '' }, null, { x: 1, y: 2 }]) {
      const mock = makeMockSession()
      let n = 0
      mock.evaluate = async (expression: string) => {
        mock.evaluateCalls.push(expression)
        n += 1
        return n === 1 ? { x: 10, y: 20, width: 30, height: 40 } : facts
      }
      const result = await drag(mock, '.card', { to: { x: 50, y: 60 } })

      expect(mock.sends.some(s => s.method === 'Input.dispatchDragEvent'), JSON.stringify(facts)).toBe(false)
      expect(result.nativeDrag, JSON.stringify(facts)).toBe(false)
    }
  })

  it('native:false ⇒ 完全不补发，也不去读 draggable', async () => {
    const mock = makeMockSession()
    let n = 0
    mock.evaluate = async (expression: string) => {
      mock.evaluateCalls.push(expression)
      n += 1
      return n === 1 ? { x: 10, y: 20, width: 30, height: 40 } : { draggable: true, text: 'x' }
    }
    const result = await drag(mock, '.card', { to: { x: 50, y: 60 }, native: false })

    expect(mock.sends.some(s => s.method === 'Input.dispatchDragEvent')).toBe(false)
    expect(result.nativeDrag).toBe(false)
    expect(mock.evaluateCalls).toHaveLength(1)
  })

  it('draggable 但读不到文本 ⇒ 载荷退回选择器（dataTransfer 的 data 不能为空串）', async () => {
    const mock = makeMockSession()
    let n = 0
    mock.evaluate = async (expression: string) => {
      mock.evaluateCalls.push(expression)
      n += 1
      return n === 1 ? { x: 10, y: 20, width: 30, height: 40 } : { draggable: true, text: '' }
    }
    await drag(mock, '.card', { to: { x: 50, y: 60 } })

    const drop = mock.sends.filter(s => s.method === 'Input.dispatchDragEvent').at(-1)!
    expect(drop.params.data).toMatchObject({ items: [{ mimeType: 'text/plain', data: '.card' }] })
  })
})
