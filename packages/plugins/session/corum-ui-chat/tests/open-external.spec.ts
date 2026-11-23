/**
 * 助手正文外链打开的契约（回归网）。
 *
 * 用户报障（2026-11）：「Agent 最终总结的内容，如文档等会有链接可点击，原则上是可以
 * 点击后自动打开右侧编辑器预览的，但是目前是不行的，点击无作用」。
 *
 * 根因：`conversation.view`（chat fork）从来没有包 `MarkdownDelegateProvider`。
 * 官方 `MarkdownText` 的 `MarkdownAnchor` 只在 delegate 提供 `openExternalLink` 时
 * `preventDefault + open(href)`；否则走原生锚点，而本壳 webContents 没挂
 * `setWindowOpenHandler` ⇒ `target="_blank"` 的原生导航被静默丢弃。
 *
 * 本测试钉住通道与拒绝面：http/https 走壳桥；非 http(s) 一律不交出去；
 * 桥缺席（纯浏览器）才是 `window.open`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from '../src/client/open-external.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('openExternalUrl', () => {
  it('http/https 交给壳桥（系统默认浏览器）', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true })
    const openWindow = vi.fn()
    const handled = openExternalUrl('https://example.com/a', { bridge: { openExternal }, openWindow })

    expect(handled).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a')
    expect(openWindow).not.toHaveBeenCalled()
    await Promise.resolve()
  })

  it('桥缺席时才回落 window.open（纯浏览器运行时）', () => {
    const openWindow = vi.fn()
    const handled = openExternalUrl('https://example.com/b', { openWindow })

    expect(handled).toBe(true)
    expect(openWindow).toHaveBeenCalledWith('https://example.com/b')
  })

  it('非 http(s) scheme 不交给任何通道', () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true })
    const openWindow = vi.fn()
    const warn = vi.fn()

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'corumapp://app/x', 'mailto:a@b.c']) {
      expect(openExternalUrl(url, { bridge: { openExternal }, openWindow, warn })).toBe(false)
    }
    expect(openExternal).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('桥返回 ok=false 时如实告知用户（不静默）', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: false, error: 'invalid url' })
    const report = vi.fn()

    openExternalUrl('https://example.com/c', { bridge: { openExternal }, report })
    for (let i = 0; i < 8; i++) await Promise.resolve()

    expect(report).toHaveBeenCalledWith('无法打开链接', 'invalid url')
  })

  it('桥抛错时同样如实告知，不把异常吞成静默失败', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('bridge gone'))
    const report = vi.fn()

    openExternalUrl('https://example.com/d', { bridge: { openExternal }, report })
    for (let i = 0; i < 8; i++) await Promise.resolve()

    expect(report).toHaveBeenCalledWith('无法打开链接', 'bridge gone')
  })
})
