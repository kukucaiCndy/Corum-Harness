/**
 * `gitPanel` 字典的回归网（2026-11-26）。
 *
 * 判据只有两条，但两条都会静默失效：
 *   ① 中英键集必须完全一致 —— 少一个键时 `t()` 回落到键名，界面上出现 `gitPanel.commit`
 *      这种字样，而不报错；
 *   ② 命名空间必须与槽注册用的一致 —— 注册了 `gitPanel` 却在槽上写别的 ns，
 *      字典永远不会被查到（同 2026-09-16 的 `preview.document` 事故形态）。
 */
import { describe, expect, it } from 'vitest'
import { NS, en, zh } from '../src/client/locales.ts'

describe('gitPanel 字典', () => {
  it('中英键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('NS 与两份字典自报的 ns 一致', () => {
    expect(NS).toBe('gitPanel')
    expect(zh.ns).toBe(NS)
    expect(en.ns).toBe(NS)
  })

  it('没有空值（空串会让界面出现空白标签）', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), `zh.${key}`).not.toBe('')
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `en.${key}`).not.toBe('')
    }
  })

  it('面板必需文案齐全（标题/分支/更改/提交/忙碌/预览）', () => {
    for (const key of ['title', 'branch', 'changes', 'commit', 'cancel', 'close', 'commitMessage', 'selectAll', 'idle', 'busy', 'injectPreview'] as const) {
      expect(zh[key], `zh.${key}`).toBeTruthy()
      expect(en[key], `en.${key}`).toBeTruthy()
    }
  })
})
