/**
 * 配额/限流失败识别（issue #230）：分类码优先、供应商措辞兜底；
 * 上下文溢出与其他失败**不得**误识别（否则把结构性错误伪装成「稍候重试」）。
 */
import { describe, expect, it } from 'vitest'
import { failureKind } from '../src/client/chat/failure-kind.ts'

describe('failureKind：配额/限流识别（issue #230）', () => {
  it('★ 基座分类码：QUOTA/ACCOUNT_QUOTA → quota；RATE_LIMIT → rateLimit', () => {
    expect(failureKind('QUOTA', '')).toBe('quota')
    expect(failureKind('ACCOUNT_QUOTA', '')).toBe('quota')
    expect(failureKind('RATE_LIMIT', '')).toBe('rateLimit')
  })

  it('★ 阿里云 TPM 限流实测形态（#230 原文）：码缺失/原始码都识别为 quota', () => {
    const real = '429: {"message":"Allocated quota exceeded, please increase your quota limit.","type":"insufficient_quota","code":"insufficient_quota"}'
    expect(failureKind(undefined, real)).toBe('quota')
    expect(failureKind('insufficient_quota', 'Allocated quota exceeded')).toBe('quota')
  })

  it('限流措辞（无配额词）→ rateLimit', () => {
    expect(failureKind(undefined, 'Requests rate limit exceeded, please try again later.')).toBe('rateLimit')
    expect(failureKind(undefined, '429 Too Many Requests')).toBe('rateLimit')
    expect(failureKind(undefined, 'Throttling.RateQuota')).toBe('rateLimit')
  })

  it('★ 上下文溢出不是配额/限流（不得给「稍候重试」的假指引）', () => {
    expect(failureKind('CONTEXT_WINDOW_EXCEEDED', 'Range of input length should be [1, 129024]')).toBeUndefined()
    expect(failureKind(undefined, 'input too long for this model')).toBeUndefined()
    expect(failureKind(undefined, 'maximum context length exceeded')).toBeUndefined()
  })

  it('其他失败 → undefined（AUTH / 网关无正文 / 普通错误）', () => {
    expect(failureKind('AUTH', '')).toBeUndefined()
    expect(failureKind(undefined, '400 status code (no body)')).toBeUndefined()
    expect(failureKind(undefined, 'Connection reset by peer')).toBeUndefined()
  })
})