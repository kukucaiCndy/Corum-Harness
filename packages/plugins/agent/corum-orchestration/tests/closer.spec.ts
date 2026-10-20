/**
 * fork（corum）2026-10：**编排工作流黑盒化**的机制面单测。
 *
 * 用户定稿（五点落地）里属于 `@corum/corum-orchestration` 的两块：
 *   ① **收尾节点（closer）的 persona**——机制拼装、按场景三态（merge / summarize / research）；
 *   ② **收尾报告落盘**——写 CORUM_HOME 临时路径（`<CORUM_HOME>/orchestrate-reports/<callId>.md`），
 *      阅后即焚的过程产物，不归档进项目；
 *   ③ **编排黑盒化的登记表**——编排运行期间「本次编排派出的子 Agent」的 settle 通知收拢到机制，
 *      而不是注入父会话（`beginOrchestration` / `registerOrchestrationChild` /
 *      `orchestrationChildIndex(BySlug)` / `captureOrchestrationNote` / `drainOrchestrationNotes`）。
 *
 * 覆盖边界：本 spec 只测**纯函数与 service 的登记表语义**；真正的 settle 压制路径在
 * `corum-tool-subagent` 的 `subagent/end` 钩子里（由该包的 `blackbox.spec.ts` 做源码面断言），
 * 端到端行为由实机取证。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CorumOrchestration,
  corumCloserPersona,
  corumDropResolvedIntegrationNotes,
  corumOrchestrateReportPath,
  corumPendingBranchesOf,
  corumResearchReportPath,
  corumWriteOrchestrateReport,
} from '../src/orchestration.ts'

const TASKS = [
  { index: 0, label: 'split a', ok: true, output: 'A 改好了', childSessionId: 'corum-task-a', worktreeSlug: 'wt-aaaaaa', branch: 'wt/wt-aaaaaa' },
  { index: 1, label: 'split b', ok: false, aborted: true, error: 'user aborted', childSessionId: 'corum-task-b' },
  { index: 2, label: '调研', ok: true, output: '结论：没有死代码', research: true },
]

describe('corumCloserPersona — 三态（机制自动判定，模型不再传 merge）', () => {
  it('★ merge：必然合并 + 跑探测式 verify + 汇总各任务', () => {
    const persona = corumCloserPersona('merge', TASKS, {
      reportPath: '/tmp/x/report.md',
      checks: ['pnpm -r typecheck', 'pnpm test'],
      branches: ['wt/wt-aaaaaa', 'wt/wt-bbbbbb'],
    })
    expect(persona).toContain('CLOSER')
    // ① 合并是**必然**动作（用户定稿：出现 worktree ⇒ 收尾节点必然带 merge）。
    expect(persona).toContain('must be merged back into the main working tree')
    expect(persona).toContain('wt/wt-aaaaaa, wt/wt-bbbbbb')
    // ② verify 命令来自机制探测（原 `merge.verify`，取消 merge 后改探测式默认）。
    expect(persona).toContain('- pnpm -r typecheck')
    expect(persona).toContain('- pnpm test')
    // ③ 合并纪律（先 --no-commit 合、验完再提交；未结清合并必须收尾；禁止破坏性 git）。
    expect(persona).toContain('git merge --no-commit')
    expect(persona).toContain('MERGE_HEAD')
    expect(persona).toContain('git reset --hard')
    // ④ 汇总职责（在集成者之上新增的那一半）。
    expect(persona).toContain('Integration')
    expect(persona).toContain('Needs your attention')
  })

  it('★ summarize：全 main worker ⇒ **不合并**，只汇总各任务改动', () => {
    const persona = corumCloserPersona('summarize', TASKS, { reportPath: '/tmp/x/report.md' })
    expect(persona).toContain('nothing to merge')
    expect(persona).toContain('Do NOT merge, cherry-pick or commit anything')
    expect(persona).toContain('Changes')
    // 不该出现合并纪律（那是 merge 态的事，写进来会让它以为要合）。
    expect(persona).not.toContain('git merge --no-commit')
  })

  it('★ research：全 research ⇒ 核查报告，且写明「不要改仓库」', () => {
    const persona = corumCloserPersona('research', TASKS, { reportPath: '/tmp/x/report.md' })
    expect(persona).toContain('Do NOT modify the repository')
    expect(persona).toContain('Do NOT merge, cherry-pick or commit anything')
    expect(persona).toContain('Findings')
    // 每条结论必须可追溯（用户定调「每条结论详实、必要时落盘关联引用」）。
    expect(persona).toContain('cite the file path / command / session')
  })

  it('任务回执逐条进 persona（含失败/终止状态与子会话引用）', () => {
    const persona = corumCloserPersona('summarize', TASKS, { reportPath: '/tmp/x/report.md' })
    expect(persona).toContain('[task 0 · split a] DONE')
    expect(persona).toContain('child session corum-task-a')
    expect(persona).toContain('worktree wt-aaaaaa')
    expect(persona).toContain('[task 1 · split b] ABORTED')
    expect(persona).toContain('no output: user aborted')
    // 完整正文只喂 closer（这就是它存在的理由）。
    expect(persona).toContain('A 改好了')
  })

  it('★ 报告落盘路径与「返回正文」的契约写进 persona', () => {
    const persona = corumCloserPersona('research', TASKS, { reportPath: '/tmp/x/report.md' })
    // 路径仍写进 persona——但只是**告知去向**（closer 知道报告会落到哪，可在正文里引用）。
    expect(persona).toContain('/tmp/x/report.md')
    // 正文必须作为最终答复返回（主 Agent 读答复；机制把这份正文落盘）。
    expect(persona).toContain('Return the FULL report text as your final answer')
    expect(persona).toContain('The mechanism saves this report to /tmp/x/report.md on your behalf')
  })

  /**
   * 修复①（2026-10）：**closer 不再自己落盘**。
   *
   * 旧 persona 写的是 `Write the report to <path> (create parent directories as needed) AND
   * return the same report text as your final answer`——closer 是 workspace-write 沙箱，
   * 照着去写 `~/.corum/orchestrate-reports/…` 就触发提权弹窗（每次编排一次打扰），
   * 而机制本来就在 `runCloser` 里兜底落盘 ⇒ 纯冗余。这条断言钉住「别再教它写文件」。
   */
  it('★ 修复①：persona 不再要求 closer 自己写文件（落盘归机制）', () => {
    for (const scenario of ['merge', 'summarize', 'research'] as const) {
      const persona = corumCloserPersona(scenario, TASKS, { reportPath: '/tmp/x/report.md' })
      // 旧指令不得回潮（两种形态都断言：写盘动作 + 「同一个正文」的旧措辞）。
      expect(persona, scenario).not.toContain('Write the report to')
      expect(persona, scenario).not.toContain('create parent directories as needed')
      expect(persona, scenario).not.toContain('return the same report text as your final answer')
      // 取而代之的是明确的「不要写任何文件」。
      expect(persona, scenario).toContain('do NOT write any file yourself')
    }
  })
})

describe('corumOrchestrateReportPath — 报告写 CORUM_HOME 临时路径（阅后即焚）', () => {
  it('CORUM_HOME 优先（env > DSH_HOME > ~/.corum）', () => {
    expect(corumOrchestrateReportPath('call-1', { CORUM_HOME: '/tmp/home' } as NodeJS.ProcessEnv, '/home/u'))
      .toBe(join('/tmp/home', 'orchestrate-reports', 'call-1.md'))
    expect(corumOrchestrateReportPath('call-1', { DSH_HOME: '/tmp/dsh' } as NodeJS.ProcessEnv, '/home/u'))
      .toBe(join('/tmp/dsh', 'orchestrate-reports', 'call-1.md'))
    expect(corumOrchestrateReportPath('call-1', {} as NodeJS.ProcessEnv, '/home/u'))
      .toBe(join('/home/u', '.corum', 'orchestrate-reports', 'call-1.md'))
  })

  it('★ callId 里的路径分隔符不得让报告跑出 CORUM_HOME（收敛成安全文件名）', () => {
    const escaped = corumOrchestrateReportPath('../../etc/passwd', { CORUM_HOME: '/tmp/home' } as NodeJS.ProcessEnv, '/home/u')
    // 用 sep 拼尾部分隔符：Windows 上 join 产出 `\`，硬编码 '/' 会假红（2026-10-21 首跑）。
    expect(escaped.startsWith(join('/tmp/home', 'orchestrate-reports') + sep)).toBe(true)
    expect(escaped).not.toContain('..')
  })

  it('空 callId 也有确定的文件名（不产生 `.md` 这种隐藏文件）', () => {
    expect(corumOrchestrateReportPath('', { CORUM_HOME: '/tmp/home' } as NodeJS.ProcessEnv, '/home/u'))
      .toBe(join('/tmp/home', 'orchestrate-reports', 'orchestrate.md'))
  })
})

describe('corumWriteOrchestrateReport — 落盘失败不抛（正文仍会返回主 Agent）', () => {
  const created: string[] = []
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('自动建父目录并写入正文', () => {
    const dir = join(tmpdir(), `corum-closer-spec-${process.pid}-${Date.now()}`)
    created.push(dir)
    const target = join(dir, 'orchestrate-reports', 'call-9.md')
    expect(corumWriteOrchestrateReport(target, '# 报告\n\n正文')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('# 报告\n\n正文')
  })

  it('★ 不可写路径 → false（不抛）', () => {
    // 不用 `/dev/null/never/x.md`：那是 POSIX 专属形态，Windows 上没有 `/dev/null`，
    // mkdir 会真的把 `\dev\null\never` 建出来 ⇒ 返回 true，断言假红（2026-10-21 首跑）。
    // 改用平台无关的「父级是个普通文件」形态：mkdir 必然 ENOTDIR/EEXIST 失败。
    const dir = join(tmpdir(), `corum-closer-spec-ro-${process.pid}-${Date.now()}`)
    created.push(dir)
    mkdirSync(dir, { recursive: true })
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    expect(corumWriteOrchestrateReport(join(blocker, 'x.md'), 'body')).toBe(false)
  })
})

/**
 * 修复②（2026-10）：**internalNotes 矛盾作废**。
 *
 * 实机病根：`drainOrchestrationNotes()` 在 closer 派发**之前**取值（合并前快照），
 * closer 已成功合并、却没人作废那条「N isolated branch(es) are NOT merged …」说明 ⇒
 * 结果里同时出现「已集成」与「没合并」两条互斥结论。
 *
 * 剔除判据是**台账实况**（已翻成 integrated 的分支名），不是「merge 场景 + 无 error」——
 * 后者会把「closer 自称成功、台账却没翻」这类漂移一起抹掉。
 */
describe('corumDropResolvedIntegrationNotes — 已解决的分支不再出现在内部说明里（修复②）', () => {
  /** 与 `corum-tool-subagent` 的 `corumPendingIntegrationNoticeText` 同形态（真实措辞）。 */
  const pending = (branches: readonly string[]): string =>
    `[corum] ${branches.length} isolated branch(es) are NOT merged into the main tree: ${branches.join(', ')}. `
    + 'Their commits are the only copy of that work — nobody sees them otherwise. '
    + 'Finish it yourself with `subagent { integrate: true }` (merge + verify + commit), or discard them explicitly.'
  const rebuild = (branches: readonly string[]): string => pending(branches)

  it('★ 分支已 integrated ⇒ 那条 pending 说明整条剔除（矛盾消失）', () => {
    const notes = [pending(['wt/aaa111', 'wt/bbb222'])]
    const kept = corumDropResolvedIntegrationNotes(notes, new Set(['wt/aaa111', 'wt/bbb222']), rebuild)
    expect(kept).toEqual([])
  })

  it('★★ verify 失败 / 未合并 ⇒ 说明**保留**（那是真未解决）', () => {
    const notes = [pending(['wt/aaa111'])]
    // 台账没翻 ⇒ resolved 集合里没有它。
    expect(corumDropResolvedIntegrationNotes(notes, new Set(['wt/other']), rebuild)).toEqual(notes)
    // 空集合（closer 失败 / 非 merge 场景）⇒ 原样返回。
    expect(corumDropResolvedIntegrationNotes(notes, new Set(), rebuild)).toEqual(notes)
  })

  it('★ 部分分支落地 ⇒ 重写成剩余分支（不能整条丢掉，否则漏报）', () => {
    const notes = [pending(['wt/aaa111', 'wt/bbb222'])]
    const kept = corumDropResolvedIntegrationNotes(notes, new Set(['wt/aaa111']), rebuild)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toContain('wt/bbb222')
    expect(kept[0]).not.toContain('wt/aaa111')
    // 重写必须走同一份生成器（措辞不得漂移）。
    expect(kept[0]).toBe(pending(['wt/bbb222']))
  })

  it('非 pending 形态的说明原样保留（收口提交失败等）', () => {
    const other = 'settle auto-commit failed for 1 orchestrated worktree(s): wt-ccc333: hooks rejected'
    expect(corumDropResolvedIntegrationNotes([other], new Set(['wt/aaa111']), rebuild)).toEqual([other])
    // 混合形态：只有 pending 那条被处理。
    const kept = corumDropResolvedIntegrationNotes([pending(['wt/aaa111']), other], new Set(['wt/aaa111']), rebuild)
    expect(kept).toEqual([other])
  })

  it('分支名识别：只认「are NOT merged into the main tree:」标记短语后的列表', () => {
    expect(corumPendingBranchesOf(pending(['wt/aaa111', 'wt/bbb222']))).toEqual(['wt/aaa111', 'wt/bbb222'])
    expect(corumPendingBranchesOf('unrelated note')).toBeUndefined()
    // 单分支（措辞为 branch(es)，条数会变，标记短语不变）。
    expect(corumPendingBranchesOf(pending(['wt/only']))).toEqual(['wt/only'])
  })
})

describe('corumResearchReportPath — 单个 research 报告写 CORUM_HOME（修复③）', () => {
  it('CORUM_HOME 优先（env > DSH_HOME > ~/.corum），落在 research-reports/<childSessionId>.md', () => {
    expect(corumResearchReportPath('corum-task-abc', { CORUM_HOME: '/tmp/home' } as NodeJS.ProcessEnv, '/home/u'))
      .toBe(join('/tmp/home', 'research-reports', 'corum-task-abc.md'))
    expect(corumResearchReportPath('corum-task-abc', { DSH_HOME: '/tmp/dsh' } as NodeJS.ProcessEnv, '/home/u'))
      .toBe(join('/tmp/dsh', 'research-reports', 'corum-task-abc.md'))
    expect(corumResearchReportPath('corum-task-abc', {} as NodeJS.ProcessEnv, '/home/u'))
      .toBe(join('/home/u', '.corum', 'research-reports', 'corum-task-abc.md'))
  })

  it('★ 会话 id 里的路径分隔符不得让报告跑出 CORUM_HOME', () => {
    const escaped = corumResearchReportPath('../../etc/passwd', { CORUM_HOME: '/tmp/home' } as NodeJS.ProcessEnv, '/home/u')
    expect(escaped.startsWith(join('/tmp/home', 'research-reports') + sep)).toBe(true)
    expect(escaped).not.toContain('..')
  })
})

/**
 * 编排黑盒化的登记表（`CorumOrchestration` 实例字段）。
 *
 * 单测直接造 service：`storageDomain` 缺席 ⇒ 回落纯内存（与本包其它 spec 同款）。
 */
describe('CorumOrchestration — 编排登记表（settle 收拢到机制）', () => {
  // 构造范式与 `session-state.spec.ts` / `isolation.spec.ts` 一致：真 `Context`，
  // `storageDomain` 缺席 ⇒ 本服务回落纯内存。
  const makeService = (): CorumOrchestration => new CorumOrchestration(new Context())
  /** 造一条台账条目（登记表按 slug 反查 runId/childSessionId，需要台账在场）。 */
  const seedEntry = (svc: CorumOrchestration, sessionId: string, slug: string, childSessionId: string): void => {
    svc.addActiveEntry(sessionId, '/tmp/repo', {
      slug,
      branch: `wt/${slug}`,
      path: `/tmp/repo/.corum-worktrees/${slug}`,
      runId: childSessionId,
      childSessionId,
    } as never)
  }

  it('未开始编排 ⇒ 任何子 Agent 都不命中（单发委派不受影响）', () => {
    const svc = makeService()
    expect(svc.orchestrationChildIndex('s1', 'child-a')).toBeUndefined()
  })

  it('登记过的子 Agent 命中，返回任务序号；closer 记 -1', () => {
    const svc = makeService()
    svc.beginOrchestration('s1')
    svc.registerOrchestrationChild('s1', 'child-a', 0)
    svc.registerOrchestrationChild('s1', 'child-b', 2)
    svc.registerOrchestrationChild('s1', 'closer', -1)
    expect(svc.orchestrationChildIndex('s1', 'child-a')).toBe(0)
    expect(svc.orchestrationChildIndex('s1', 'child-b')).toBe(2)
    expect(svc.orchestrationChildIndex('s1', 'closer')).toBe(-1)
    // 未登记的（例如更早派出的后台子 Agent）不命中 ⇒ 通知照常投递。
    expect(svc.orchestrationChildIndex('s1', 'child-other')).toBeUndefined()
  })

  it('★ 按 slug 归属（收口提交失败的形状没有 runId）', () => {
    const svc = makeService()
    seedEntry(svc, 's1', 'wt-aaaaaa', 'child-a')
    seedEntry(svc, 's1', 'wt-bbbbbb', 'child-b')
    svc.beginOrchestration('s1')
    svc.registerOrchestrationChild('s1', 'child-a', 0)
    expect(svc.orchestrationChildIndexBySlug('s1', 'wt-aaaaaa')).toBe(0)
    // 台账里有、但不在本次编排登记表里的条目 ⇒ undefined（通知照常投递给父会话）。
    expect(svc.orchestrationChildIndexBySlug('s1', 'wt-bbbbbb')).toBeUndefined()
    // 台账里根本没有的 slug ⇒ undefined。
    expect(svc.orchestrationChildIndexBySlug('s1', 'wt-nope')).toBeUndefined()
  })

  it('说明收拢：capture → drain 取出即清（closer 只消化一次）', () => {
    const svc = makeService()
    svc.beginOrchestration('s1')
    svc.captureOrchestrationNote('s1', 'note 1')
    svc.captureOrchestrationNote('s1', 'note 2')
    expect([...svc.drainOrchestrationNotes('s1')]).toEqual(['note 1', 'note 2'])
    expect([...svc.drainOrchestrationNotes('s1')]).toEqual([])
  })

  it('★ 引用计数：同一父会话并发两次编排，先结束的那个不得清掉另一个的登记', () => {
    const svc = makeService()
    svc.beginOrchestration('s1')
    svc.beginOrchestration('s1')
    svc.registerOrchestrationChild('s1', 'child-a', 0)
    svc.endOrchestration('s1')
    // 还有一次在跑 ⇒ 登记仍在。
    expect(svc.orchestrationChildIndex('s1', 'child-a')).toBe(0)
    svc.endOrchestration('s1')
    // 全部结束 ⇒ 清账（不再压制任何通知）。
    expect(svc.orchestrationChildIndex('s1', 'child-a')).toBeUndefined()
  })

  it('end 多调用一次不会把计数压成负数（幂等兜底）', () => {
    const svc = makeService()
    svc.beginOrchestration('s1')
    svc.endOrchestration('s1')
    svc.endOrchestration('s1')
    expect(svc.orchestrationChildIndex('s1', 'child-a')).toBeUndefined()
    // 再开一次仍然正常（没有被压成负数的 depth 卡住）。
    svc.beginOrchestration('s1')
    svc.registerOrchestrationChild('s1', 'child-a', 1)
    expect(svc.orchestrationChildIndex('s1', 'child-a')).toBe(1)
  })
})
