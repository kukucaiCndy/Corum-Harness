import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { delegationReportPath, sessionReportDirectory } from '../src/session-report-directory.ts'

describe('父会话报告目录', () => {
  it('普通子任务的文档也归父会话，文件名不接受路径穿越', () => {
    const dir = path.resolve('sessions', 'parent-a')
    expect(delegationReportPath(dir, '../child/one')).toBe(path.join(dir, 'subagent-reports', '..%2Fchild%2Fone.md'))
    expect(delegationReportPath(dir, 'child-a')).toBe(path.join(dir, 'subagent-reports', 'child-a.md'))
  })
  it('使用持久层实际路径，保留配置的非默认 root 和项目编码', async () => {
    const dir = path.resolve('configured-store', 'encoded-project', 'parent-a')
    const resolveCurrentLog = vi.fn(async (id: string) => id === 'parent-a' ? path.join(dir, 'session.v3.jsonl.zstd') : undefined)
    const flush = vi.fn(async () => {})
    expect(await sessionReportDirectory({ resolveCurrentLog, flush }, 'parent-a')).toBe(dir)
    expect(resolveCurrentLog).toHaveBeenCalledWith('parent-a')
    expect(flush).not.toHaveBeenCalled()
  })

  it('延迟落盘的父会话先 flush，再定位报告目录', async () => {
    const dir = path.resolve('sessions', 'parent-b')
    let materialized = false
    const persistence = {
      resolveCurrentLog: async () => materialized ? path.join(dir, 'session.v3.jsonl') : undefined,
      flush: async () => { materialized = true },
    }
    expect(await sessionReportDirectory(persistence, 'parent-b')).toBe(dir)
    expect(materialized).toBe(true)
  })

  it('无法定位时返回无目录，让调用方保留已完成结果而非中断结算', async () => {
    await expect(sessionReportDirectory({ resolveCurrentLog: async () => undefined, flush: async () => {} }, 'missing'))
      .resolves.toBeUndefined()
  })

  it('持久层发生错误也不替换已完成的子任务结果', async () => {
    await expect(sessionReportDirectory({ resolveCurrentLog: async () => { throw new Error('disk unavailable') }, flush: async () => {} }, 'parent-a'))
      .resolves.toBeUndefined()
  })
})
