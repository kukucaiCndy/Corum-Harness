/**
 * 三个小投影模块的守卫：上下文占用率、活动视图解析、附件文案。
 *
 * 它们小到容易被当成"不值得测"，但各自的边界恰好都是**产品可见的错**：
 *
 * - `contextOccupancy`：分子/分母是**独立更新**的两个字段，任一方缺失都必须
 *   返回 null（渲染成"未知"），而不是渲染成 0% 或 NaN%。分母为 0 会出 Infinity。
 * - `resolveActiveView`：只回落到 chat，**绝不**回落到"第一个注册的视图"——
 *   后者会让一次视图注册顺序变化静默改变用户默认落在哪个页面。
 * - `imageSizeText` / `attachmentErrorText`：字节→人类可读的取整规则，以及
 *   "哪些拒绝理由能告诉用户限制、哪些只能折叠成失败"的分档。
 */
import { describe, expect, it } from 'vitest'
import { contextOccupancy } from '../src/client/context-occupancy.ts'
import { resolveActiveView } from '../src/client/view-selection.ts'
import { imageSizeText } from '../src/client/image-labels.ts'

describe('contextOccupancy', () => {
  it('未提供 pressure ⇒ null（不渲染 0%）', () => {
    expect(contextOccupancy(undefined)).toBeNull()
  })

  it('缺 contextWindow ⇒ null（分母未知）', () => {
    expect(contextOccupancy({ pressureTokens: 100 } as never)).toBeNull()
  })

  it('缺分子（两者都没有）⇒ null', () => {
    expect(contextOccupancy({ contextWindow: 1000 } as never)).toBeNull()
  })

  it('projectedTokens 优先于 pressureTokens', () => {
    expect(contextOccupancy({ projectedTokens: 300, pressureTokens: 900, contextWindow: 1000 } as never))
      .toEqual({ percent: 30, usedTokens: 300, contextWindow: 1000 })
  })

  it('无 projectedTokens 时回落到 pressureTokens', () => {
    expect(contextOccupancy({ pressureTokens: 900, contextWindow: 1000 } as never))
      .toEqual({ percent: 90, usedTokens: 900, contextWindow: 1000 })
  })

  it('百分比四舍五入到整数', () => {
    expect(contextOccupancy({ pressureTokens: 1, contextWindow: 3 } as never)?.percent).toBe(33)
    expect(contextOccupancy({ pressureTokens: 2, contextWindow: 3 } as never)?.percent).toBe(67)
  })

  it('百分比封顶 100（超窗不显示 120%）', () => {
    expect(contextOccupancy({ pressureTokens: 1200, contextWindow: 1000 } as never)?.percent).toBe(100)
  })

  it('usedTokens 保留原值，不被封顶值替换', () => {
    const occupancy = contextOccupancy({ pressureTokens: 1200, contextWindow: 1000 } as never)
    expect(occupancy?.usedTokens).toBe(1200)
  })

  it('0 分子是有效值（不是"缺失"）', () => {
    expect(contextOccupancy({ pressureTokens: 0, contextWindow: 1000 } as never))
      .toEqual({ percent: 0, usedTokens: 0, contextWindow: 1000 })
  })
})

describe('resolveActiveView', () => {
  const chat = { id: 'chat', label: 'Chat' }
  const ide = { id: 'ide', label: 'IDE' }

  it('选中的视图已注册 ⇒ 直接用它', () => {
    expect(resolveActiveView([ide, chat], 'ide')).toBe(ide)
  })

  it('选中的视图未注册 ⇒ 回落到 chat', () => {
    expect(resolveActiveView([ide, chat], 'gone')).toBe(chat)
  })

  it('未选中（null）⇒ chat', () => {
    expect(resolveActiveView([ide, chat], null)).toBe(chat)
  })

  it('chat 未注册且选中项不可用 ⇒ undefined（**不**回落到第一个视图）', () => {
    expect(resolveActiveView([ide], null)).toBeUndefined()
    expect(resolveActiveView([ide], 'gone')).toBeUndefined()
  })

  it('空视图表 ⇒ undefined', () => {
    expect(resolveActiveView([], null)).toBeUndefined()
  })

  it('选中的视图优先于 chat（顺序无关）', () => {
    expect(resolveActiveView([chat, ide], 'ide')).toBe(ide)
    expect(resolveActiveView([ide, chat], 'ide')).toBe(ide)
  })
})

describe('imageSizeText', () => {
  it('整兆字节不带小数', () => {
    expect(imageSizeText(10 * 1024 * 1024)).toBe('10MB')
  })

  it('非整兆保留一位小数', () => {
    expect(imageSizeText(2.5 * 1024 * 1024)).toBe('2.5MB')
  })

  it('小于 1MB 也按 MB 显示（当前口径）', () => {
    expect(imageSizeText(512 * 1024)).toBe('0.5MB')
  })

  it('0 字节 ⇒ 0MB', () => {
    expect(imageSizeText(0)).toBe('0MB')
  })

  it('取整到一位小数（不显示三位）', () => {
    expect(imageSizeText(1.234 * 1024 * 1024)).toBe('1.2MB')
  })
})
