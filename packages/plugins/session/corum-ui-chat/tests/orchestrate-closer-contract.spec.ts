/**
 * 回归测试：编排卡对**编排黑盒化新契约**的解析（2026-10）。
 *
 * 背景：机制侧取消了 `merge` 字段、新增 closer 收尾节点、结果改成任务级引用
 * （`results[]` 只带 childSessionId / worktreeSlug / branch，自由文本 output 不再回）。
 * UI 侧若继续读旧字段，会静默退化成「无结尾节点 / 无跳转入口 / 无报告」——都不会报错，
 * 只是卡片变成有头无尾。故这里把**新契约的每个字段**与**历史回放的旧形态**都钉成断言。
 *
 * 判据来源（机制侧已定，见 `corum-tool-subagent/src/index.ts` 的 output.schema）：
 * ```
 * { mode, results:[{index,label,ok,aborted,childSessionId,worktreeSlug,branch,output?}],
 *   closer:{scenario,childSessionId,report,reportPath,reportWritten,internalNotes,error},
 *   parentTreeTasks, integration? }
 * ```
 */
import { describe, expect, it } from 'vitest'
import {
  parseCloser, parseOutcomes, parseTaskRefs, parseWorktreeSlugs, summarize,
} from '../src/client/contract/orchestrate.ts'
import type { OrchestrateChatData } from '../src/client/contract/orchestrate.ts'

/** 造一张最小的折叠结果（只填 summarize 用得到的字段）。 */
function dataWith(closer?: OrchestrateChatData['closer']): OrchestrateChatData {
  return {
    tasks: [{ index: 0, label: 'a' }, { index: 1, label: 'b' }],
    mode: 'tasks',
    hasMerge: false,
    callId: 'call-1',
    anchorSeq: 1,
    time: 0,
    outcomes: new Map(),
    settled: closer !== undefined,
    errored: false,
    ...closer === undefined ? {} : { closer },
  }
}

/** 新契约的一次成功编排结果（closer = merge 场景）。 */
const NEW_MERGE_RESULT = JSON.stringify({
  mode: 'tasks',
  results: [
    { index: 0, label: 'a', ok: true, childSessionId: 'child-a', worktreeSlug: 'wt-aaa111', branch: 'wt/aaa111' },
    { index: 1, label: 'b', ok: false, error: 'boom', childSessionId: 'child-b' },
  ],
  closer: {
    scenario: 'merge',
    childSessionId: 'closer-1',
    report: '# 收尾报告\n\n任务 a 已完成。\n任务 b 失败。',
    reportPath: '/tmp/corum/orchestrate-reports/call-1.md',
    reportWritten: true,
    internalNotes: ['branch wt/aaa111 pending integration'],
  },
}, null, 2)

describe('① closer 解析（三场景 + 失败 + 缺省）', () => {
  it('★ merge 场景的七个字段全部解析出来', () => {
    const closer = parseCloser(NEW_MERGE_RESULT)
    expect(closer).toBeDefined()
    expect(closer?.scenario).toBe('merge')
    expect(closer?.childSessionId).toBe('closer-1')
    expect(closer?.report).toContain('收尾报告')
    expect(closer?.reportPath).toBe('/tmp/corum/orchestrate-reports/call-1.md')
    expect(closer?.reportWritten).toBe(true)
    expect(closer?.internalNotes).toEqual(['branch wt/aaa111 pending integration'])
    expect(closer?.error).toBeUndefined()
  })

  it('★ summarize / research 场景都能解析（三态渲染的前提）', () => {
    for (const scenario of ['summarize', 'research'] as const) {
      const closer = parseCloser(JSON.stringify({ mode: 'tasks', results: [], closer: { scenario, report: 'r' } }))
      expect(closer?.scenario, scenario).toBe(scenario)
    }
  })

  it('★ closer.error 在场 = 收尾失败（report 可能缺省）', () => {
    const closer = parseCloser(JSON.stringify({
      mode: 'tasks',
      results: [{ index: 0, ok: true }],
      closer: { scenario: 'merge', error: 'the closer returned no report' },
    }))
    expect(closer?.error).toBe('the closer returned no report')
    expect(closer?.report).toBeUndefined()
  })

  it('非法 / 缺省的 scenario 整体不解析（不编一个场景出来）', () => {
    expect(parseCloser(JSON.stringify({ mode: 'tasks', closer: { scenario: 'merge-ish' } }))).toBeUndefined()
    expect(parseCloser(JSON.stringify({ mode: 'tasks', closer: {} }))).toBeUndefined()
    expect(parseCloser(JSON.stringify({ mode: 'tasks' }))).toBeUndefined()
    // 历史会话的旧投影格式（非 JSON）没有 closer。
    expect(parseCloser('[task 0 · a] done')).toBeUndefined()
  })
})

describe('② 任务级引用（results[] 的 durable 字段）', () => {
  it('★ childSessionId / worktreeSlug / branch 按下标取到', () => {
    const refs = parseTaskRefs(NEW_MERGE_RESULT)
    expect(refs.childSessionIds.get(0)).toBe('child-a')
    expect(refs.childSessionIds.get(1)).toBe('child-b')
    expect(refs.worktreeSlugs.get(0)).toBe('wt-aaa111')
    expect(refs.branches.get(0)).toBe('wt/aaa111')
    // 没有隔离的任务不产生 slug / branch（不是空串）。
    expect(refs.worktreeSlugs.has(1)).toBe(false)
    expect(refs.branches.has(1)).toBe(false)
  })

  it('★ parseWorktreeSlugs 优先读 results[].worktreeSlug（不再依赖 output 路径文本）', () => {
    const slugs = parseWorktreeSlugs(NEW_MERGE_RESULT)
    expect(slugs.get(0)).toBe('wt-aaa111')
  })

  it('旧形态兜底仍可用：results[].output 里的 worktree 路径', () => {
    const legacy = JSON.stringify({
      mode: 'tasks',
      results: [{ index: 2, ok: true, output: 'wrote /repo/.corum-worktrees/wt-legacy1/src/a.ts' }],
    })
    expect(parseWorktreeSlugs(legacy).get(2)).toBe('wt-legacy1')
    // 但新契约路径没有 output 时不能凭空造一个。
    expect(parseTaskRefs(legacy).worktreeSlugs.size).toBe(0)
  })

  it('历史会话（文本投影）没有任何 durable 引用 → 空 Map，调用方走旧兜底', () => {
    const refs = parseTaskRefs('[task 0 · a] done\n[corum integration] merged + committed into the main tree')
    expect(refs.childSessionIds.size).toBe(0)
    expect(refs.worktreeSlugs.size).toBe(0)
    expect(refs.branches.size).toBe(0)
  })
})

describe('③ 终态解析在新契约下不变', () => {
  it('★ ok / aborted / failed 三态仍从 results[] 读', () => {
    const outcomes = parseOutcomes(NEW_MERGE_RESULT)
    expect(outcomes.get(0)).toEqual({ kind: 'done' })
    expect(outcomes.get(1)).toEqual({ kind: 'failed', error: 'boom' })
  })

  it('aborted 优先于 ok（宿主两者可能同时在场）', () => {
    const outcomes = parseOutcomes(JSON.stringify({ results: [{ index: 3, ok: false, aborted: true }] }))
    expect(outcomes.get(3)).toEqual({ kind: 'aborted' })
  })
})

describe('④ 标题不带场景后缀（2026-10-20 用户定调）', () => {
  it('★ 无论 closer 的 scenario 是什么，标题都只有「N 任务并行」', () => {
    // 原先 closer 回包后标题会拼 ` · merge/· summarize/· research`，与设计稿不符；
    // 场景改由结尾节点的 chip（已集成/已汇总/已核查）回答，标题不再重复。
    expect(summarize(dataWith({ scenario: 'merge' })).title).toBe('编排工作流 · 2 任务并行')
    expect(summarize(dataWith({ scenario: 'summarize' })).title).toBe('编排工作流 · 2 任务并行')
    expect(summarize(dataWith({ scenario: 'research' })).title).toBe('编排工作流 · 2 任务并行')
    expect(summarize(dataWith()).title).toBe('编排工作流 · 2 任务并行')
  })

  it('标题里不得再出现场景词（防回归）', () => {
    for (const scenario of ['merge', 'summarize', 'research'] as const) {
      const title = summarize(dataWith({ scenario })).title
      expect(title).not.toContain(`· ${scenario}`)
    }
  })
})

describe('⑤ 卡片侧渲染门与迁移点（源码扫描）', () => {
  it('★ 结尾节点不再由 hasMerge/integration 决定，而是并行编排恒渲染 + 读 closer', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(import.meta.dirname, '../src/client/chat/OrchestrateCard.tsx'), 'utf8')
    // 旧门（恒假的根因）必须消失。
    expect(src).not.toContain('const showMergeStage = data.hasMerge || data.integration !== undefined')
    // 新门：并行编排（tasks ≥ 2）恒渲染。
    expect(src).toMatch(/showCloseStage = data\.tasks\.length >= 2/)
    // 三场景文案都在场（merge / summarize / research 各一句）。
    expect(src).toContain("scenario === 'summarize'")
    expect(src).toContain("scenario === 'research'")
    expect(src).toContain("t('orchestrate.close.doneMerge')")
    // closer 子会话 label 是 'closer'（不是 'integrate'），两者都要命中。
    expect(src).toContain("entry.label === 'closer' || entry.label === 'integrate'")
    // 收尾报告正文来自 closer.report。
    expect(src).toContain('closer?.report')
  })
})
