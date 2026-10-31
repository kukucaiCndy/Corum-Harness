import { describe, expect, it, vi } from 'vitest'

import {
  buildFinder,
  click,
  captureScreenshot,
  insertText,
  pressKey,
  resize,
  redactUrl,
  pickCorumPages,
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
      summary: () => ({ console: { count: 0, errors: [] }, network: { count: 0, failed: [] } }),
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

  it('reset=true → Emulation.clearDeviceMetricsOverride', async () => {
    const mock = makeMockSession()
    await resize(mock, { reset: true })

    expect(mock.sends).toHaveLength(1)
    expect(mock.sends[0]!.method).toBe('Emulation.clearDeviceMetricsOverride')
  })
})
