import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { saveSettledSubagentReport } from '../src/settled-report.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'corum-settled-report-'))
  roots.push(root)
  const directory = path.join(root, 'configured-store', 'encoded-project', 'parent-a')
  await mkdir(directory, { recursive: true })
  const log = path.join(directory, 'session.v3.jsonl')
  await writeFile(log, '{"id":"parent-a"}\n')
  const warnings: string[] = []
  return { root, directory, warnings,
    logger: { warn: (message: string) => { warnings.push(message) } },
    persistence: { resolveCurrentLog: async (id: string) => id === 'parent-a' ? log : undefined, flush: async () => {} },
  }
}

function ended(runId: string, report: string, id = 'child-a'): SubagentRunEndInfo {
  return { id: id as SubagentRunEndInfo['id'], runId: runId as SubagentRunEndInfo['runId'],
    provider: 'spawn', local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: report }],
  }
}

describe('后台与 continuable 的结束报告', () => {
  it('把完整文档保存到父会话真实目录，冷读仍包含长正文尾部', async () => {
    const app = await fixture()
    const report = `HEAD-${'文'.repeat(12000)}-TAIL`
    await saveSettledSubagentReport(app.persistence, 'parent-a', ended('run-1', report), app.logger)
    const saved = path.join(app.directory, 'subagent-reports', 'child-a--run-1.md')
    expect(existsSync(saved)).toBe(true)
    expect(await readFile(saved, 'utf8')).toBe(report)
    expect(app.warnings).toEqual([])
  })

  it('同一个 continuable 子会话的不同 run 保留各自结果，不互相覆盖', async () => {
    const app = await fixture()
    await saveSettledSubagentReport(app.persistence, 'parent-a', ended('run-1', '第一轮完整文档'), app.logger)
    await saveSettledSubagentReport(app.persistence, 'parent-a', ended('run-2', '第二轮完整文档'), app.logger)
    expect(await readFile(path.join(app.directory, 'subagent-reports', 'child-a--run-1.md'), 'utf8')).toBe('第一轮完整文档')
    expect(await readFile(path.join(app.directory, 'subagent-reports', 'child-a--run-2.md'), 'utf8')).toBe('第二轮完整文档')
  })

  it('id 中的路径分隔符保持为单个编码文件名', async () => {
    const app = await fixture()
    await saveSettledSubagentReport(app.persistence, 'parent-a', ended('../run', 'safe', '../child'), app.logger)
    expect(await readFile(path.join(app.directory, 'subagent-reports', '..%2Fchild--..%2Frun.md'), 'utf8')).toBe('safe')
  })

  it('无法定位或持久层抛错时只告警，不抛出结算错误', async () => {
    const app = await fixture()
    for (const resolveCurrentLog of [async () => undefined, async () => { throw new Error('disk unavailable') }]) {
      await expect(saveSettledSubagentReport({ resolveCurrentLog, flush: async () => {} },
        'parent-a', ended('run-1', '完整结果仍由结算传回'), app.logger)).resolves.toBeUndefined()
    }
    expect(app.warnings).toHaveLength(2)
    expect(app.warnings.every(message => message.includes('parent-a'))).toBe(true)
  })

  it('真实写盘失败仅告警，保留原结束消息且不影响结算', async () => {
    const app = await fixture()
    await writeFile(path.join(app.directory, 'subagent-reports'), 'this is a file')
    const info = ended('run-1', '完整文档不能因附加保存失败而丢失')
    await expect(saveSettledSubagentReport(app.persistence, 'parent-a', info, app.logger)).resolves.toBeUndefined()
    expect(info.lastAssistantMessage).toEqual([{ type: 'text', text: '完整文档不能因附加保存失败而丢失' }])
    expect(app.warnings).toHaveLength(1)
  })
})
