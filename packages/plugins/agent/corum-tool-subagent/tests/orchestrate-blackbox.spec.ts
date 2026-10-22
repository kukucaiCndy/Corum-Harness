/**
 * fork（corum）2026-10：**编排工作流黑盒化**在工具层的机器化对账（用户定稿五点落地）。
 *
 * 为什么用「源码扫描式」对账（本仓先例：`prompt-discipline.spec.ts` / `model-policy.spec.ts`）：
 * 这几条约束住在**模型读到的文本面**（工具 description + 系统提示词段）与**工具 schema 面**里，
 * 一旦被悄悄改回去（例如有人「顺手」把 `merge` 加回来、或把各任务正文拼回结果），只有实机
 * 重启并读工具描述才看得出来。本 spec 把它们变成断言，回潮即红。
 *
 * 覆盖的四条：
 *   ① **门槛**：`tasks.length < 2` 报错并引导单任务走 `subagent`（机制层，不是靠提示词劝阻）；
 *   ② **取消 `merge` 字段**：schema 里没有它，收尾由机制按隔离实况自动判定（三态）；
 *   ③ **黑盒化**：编排运行期间，**本次编排派出的**子 Agent 的 settle 通知收拢到机制，
 *      不注入父会话；且**只压制登记过的**（别误伤单发委派 / 更早派出的后台子 Agent）；
 *   ④ **结果模型**：`results[]` 只带任务级引用，正文只给 closer（#100 截断根因）。
 *
 * 覆盖边界：本 spec 只做**文本/schema/接线面**断言，不改任何机制语义；端到端行为由实机取证。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

/** 取一段源码：从 `from` 到其后第一个 `to`（不含）。顺序即语义锚点。 */
function between(from: string, to: string, source: string = SRC): string {
  const start = source.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(to, start + from.length)
  expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('① 门槛：orchestrate 至少 2 个任务（tasks 形态）', () => {
  it('★ 机制在派发前拒绝 `tasks.length < 2`，并把出路写进错误', () => {
    // 取样到 throw 之后的收尾 `}`（`between` 遇第一个 `}` 会截在模板串之前）。
    const block = between('if (tasks === undefined || tasks.length < 2) {', 'const parentTreeTasks: Array<')
    expect(block).toContain('at least 2 tasks')
    // 错误文案必须引导到 subagent / subagent_research（模型读到的就是它）。
    expect(block).toContain('`subagent`')
    expect(block).toContain('`subagent_research`')
    // 旧口径（0 个才拦）不得回潮。
    expect(SRC).not.toContain("tasks.length === 0) throw new Error('orchestrate requires either `tasks` (1 or more)")
  })

  it('schema 的 tasks 描述改成「2 or more」（描述与机制同口径）', () => {
    expect(SRC).toContain('DECLARATIVE mode: the list of tasks to run (2 or more — fewer is rejected)')
    expect(SRC).not.toContain('the list of tasks to run (1 or more)')
  })

  it('工具描述写明单任务会被拒绝 + 该走哪个工具', () => {
    expect(SRC).toContain('MINIMUM 2 TASKS')
    expect(SRC).toContain('REJECTS fewer')
  })
})

describe('② 取消 `merge` 字段：收尾由机制自动判定', () => {
  it('★ schema 里不再有 `merge` 参数（模型物理上无法声明收尾方式）', () => {
    // ⚠️ 取样面必须是 **orchestrate 自己**的 parameters 段（从它的 name 起）——直接用
    // `parameters: {` 会从 subagent 工具的段开始，把它的 `integrate`/`verify` 一起算进来。
    const params = between("            name: 'orchestrate',", '            output: {')
    expect(params).not.toMatch(/\bmerge:\s*\{/)
    // 参数表里也不该再有 `verify`（verify 改由机制探测）。
    expect(params).not.toMatch(/\bverify:\s*\{/)
  })

  it('★ 三态判定只看隔离实况与 research 声明（不看模型传什么）', () => {
    const fn = between('const closerScenarioOf =', '\n              /**')
    expect(fn).toContain("pendingCount > 0 ? 'merge'")
    expect(fn).toContain("allResearch ? 'research'")
    expect(fn).toContain("'summarize'")
    // 「全 research」看任务**声明**，不能因为失败就当成写任务。
    expect(SRC).toContain('const allResearch = tasks.every(task => task.research === true)')
  })

  it('★ verify 改由机制探测（原 merge.verify 的来源）', () => {
    const fn = between('const runCloser = async (', '\n              // fork（corum）2026-10-22：**SCRIPTED 模式已移除**')
    expect(fn).toContain("scenario === 'merge' ? corumDetectIntegrateChecks(")
  })

  it('★★ merge 场景必须走 `integrate: true`（机制真值门禁不得随字段一起取消）', () => {
    // 用户定稿「复用现有集成者 persona/派发逻辑」。取消的只是**模型的声明权**，不是门禁：
    // 集成者自称已合并 ≠ 分支真进了 HEAD（2026-09-09 事故），台账翻转/现场回收/解卡也都在
    // 那条路上。`merge` 场景若退化成普通主树 spawn，这三件事会静默消失。
    const fn = between('const runCloser = async (', '\n              // fork（corum）2026-10-22：**SCRIPTED 模式已移除**')
    expect(fn).toContain("...scenario === 'merge' ? { integrate: true } : { isolation: 'main' as const }")
    // 非 merge 场景不该传 integrate（没有待集成分支 ⇒ 会被「no isolated worktrees」拒绝）。
    expect(fn).toContain('no isolated worktrees to integrate')
  })

  it('工具描述写明收尾是自动的、冲突预判是发起者的责任', () => {
    expect(SRC).toContain('FINISHING IS AUTOMATIC — there is no `merge` parameter any more')
    expect(SRC).toContain('CONFLICT PRE-FLIGHT IS YOURS')
  })

  it('系统提示词段同口径（不得残留「Declare merge.verify」这类教模型用已删参数的句子）', () => {
    expect(SRC).not.toContain('- **Declare `merge.verify` for `orchestrate`**')
    expect(SRC).not.toContain("INTEGRATION IS THE MECHANISM'S when you declare `merge`")
    expect(SRC).toContain('FINISHING IS AUTOMATIC — there is no `merge` parameter any more')
  })
})

describe('③ 黑盒化：编排期间子 Agent 的 settle 通知收拢到机制', () => {
  const hook = (): string => between('ctx.on(\'subagent/end\' as never', '}) as never, { global: true })')

  it('★ 待集成通知：编排派出的子 Agent 走 capture，未登记的照常投递', () => {
    const body = hook()
    expect(body).toContain('orchestration.orchestrationChildIndexBySlug(sessionId, entry.slug)')
    expect(body).toContain('orchestration.captureOrchestrationNote(')
    // 关键：**只压制登记过的**（`foreign` 那一路必须继续 corumNotifyPendingIntegration）。
    expect(body).toContain('if (foreign.length > 0) {')
    expect(body).toContain('corumNotifyPendingIntegration(parent, String(info.id), foreign.map(entry => entry.branch), ctx.logger)')
  })

  it('★ 收口提交失败：同样按 slug 分流（own 收拢 / foreign 通知）', () => {
    const body = hook()
    expect(body).toContain('orchestration.orchestrationChildIndexBySlug(sessionId, failure.slug)')
    expect(body).toContain('corumNotifySettleCommitFailures(parent, String(info.id), foreign, ctx.logger)')
  })

  it('★ 登记发生在 spawn 那一刻（不是 settle 之后）——前台子 Agent 在 settle 前就 end 了', () => {
    // spawnOne 必须有 `onChildStarted` 钩子，且三条 spawn 路径（前台/continuable/后台 job）都调它。
    expect(SRC).toContain('onChildStarted?: (childId: string) => void')
    const calls = SRC.match(/args\.onChildStarted\?\.\(/gu) ?? []
    expect(calls.length, 'onChildStarted 必须在每条 spawn 路径上都被调用').toBeGreaterThanOrEqual(3)
    // orchestrate 的任务派发把它接到登记表上。
    expect(SRC).toContain('orchestration.registerOrchestrationChild(parent.session.id, childId, index)')
    // closer 也登记（-1 号）。
    expect(SRC).toContain('orchestration.registerOrchestrationChild(sessionId, childId, -1)')
  })

  it('★ 整个执行体包在 begin/end 之间（引用计数，且 finally 保证收尾）', () => {
    expect(SRC).toContain('orchestration.beginOrchestration(orchestrationSessionId)')
    expect(SRC).toContain('orchestration.endOrchestration(orchestrationSessionId)')
    // 取样面覆盖整个 try/finally（`between` 到 return 就停，那时 finally 还没出现）。
    const wrap = between('orchestration.beginOrchestration(orchestrationSessionId)', 'orchestration.endOrchestration(orchestrationSessionId)')
    expect(wrap).toContain('try {')
    expect(wrap).toContain('finally {')
  })

  it('★ 单发委派不受影响：subagent 工具不登记、通知照旧（判据是「有没有登记」而非「有没有父会话」）', () => {
    // `notifyParent` 只关掉**本工具**的 settlement notice；settle 钩子里的压制只看登记表。
    // 故 orchestrate 的压制与单发路径的可见性互不影响。
    expect(SRC).toContain('notifyParent: false')
    const hookBody = hook()
    expect(hookBody).not.toContain('notifyParent')
  })
})

describe('④ 结果模型：closer 报告 + 任务级引用（不再堆 N 份正文）', () => {
  it('★ 返回的 results 只带引用；自由文本正文只在声明 schema 时透传', () => {
    // fork（corum）2026-10-22：`mode: 'tasks'` 已移除，锚点改用 results。
    const block = between('return {\n                // fork（corum）2026-10-22：`mode` 字段移除', 'orchestration.beginOrchestration')
    expect(block).toContain('childSessionId: receipt.childSessionId')
    expect(block).toContain('worktreeSlug: receipt.worktreeSlug')
    expect(block).toContain('branch: receipt.branch')
    // 关键一行：正文的透传被 `structured` 门禁卡住（#100 的根因就在这一行）。
    expect(block).toContain('receipt.structured !== true || receipt.output === undefined ? {} : { output: receipt.output }')
    expect(block).toContain('closer,')
  })

  it('★ 完整正文进了 closer 的入参（那是它存在的理由）', () => {
    const refs = between('const refs: CorumCloserTaskRef[] = results.map', '// closer 自己的 settle')
    expect(refs).toContain('...receipt.output === undefined ? {} : { output: receipt.output }')
  })

  it('schema 声明 closer 的结果字段（少一个就是 INVALID_TOOL_OUTPUT 整块吞结果）', () => {
    // fork（corum）2026-10-22：`script: {` 锚点已移除，改用 integration。
    const schema = between("closer: {\n                    type: 'object'", 'integration: {')
    for (const field of ['scenario', 'childSessionId', 'report', 'reportPath', 'reportWritten', 'internalNotes', 'error']) {
      expect(schema, `closer schema 缺少 ${field}`).toContain(`${field}:`)
    }
    expect(schema).toContain("enum: ['merge', 'summarize', 'research']")
  })

  it('render 投影把 closer 全量透出（模型/卡片读得到）', () => {
    const render = between('structured.closer = {', 'structured.integration = {')
    for (const field of ['scenario', 'childSessionId', 'report', 'reportPath', 'reportWritten', 'internalNotes', 'error']) {
      expect(render, `render 没有透出 closer.${field}`).toContain(`out.closer.${field}`)
    }
  })

  // fork（corum）2026-10-22：script 模式已移除，以下断言不再适用。
  // it('★ script 模式的 value 也有体积上限（模型自己聚合的结果同样会撞 pruner 阈值）', () => {
  //   expect(SRC).toContain('const CORUM_ORCHESTRATE_SCRIPT_VALUE_LIMIT = ')
  //   expect(SRC).toContain('scriptValueText.length > CORUM_ORCHESTRATE_SCRIPT_VALUE_LIMIT')
  //   expect(SRC).toContain('…(truncated: ${scriptValueText.length} chars total — see the closer report)')
  // })

  it('报告写 CORUM_HOME 临时路径（阅后即焚的过程产物，不归档进项目）', () => {
    expect(SRC).toContain('corumOrchestrateReportPath(String(exec.callId))')
    expect(SRC).toContain('corumWriteOrchestrateReport(reportPath, report)')
  })

  /**
   * 修复①（2026-10）：**closer 不再自己落盘**（提权弹窗的根因）。
   *
   * persona 此前写 `Write the report to <path> … AND return the same report text as your
   * final answer`，closer（workspace-write 沙箱）照做就去写 `~/.corum/orchestrate-reports/…`
   * ⇒ 每次编排弹一次提权卡；而机制本来就在 `runCloser` 里兜底落盘。现在机制是**唯一**
   * 落盘点，`corumWriteOrchestrateReport` 在工具层只应出现在这一处。
   */
  it('★ 修复①：机制是唯一落盘点（closer persona 不再被要求写文件）', () => {
    const calls = SRC.match(/corumWriteOrchestrateReport\(/gu) ?? []
    expect(calls.length, 'corumWriteOrchestrateReport 在工具层只应有一处调用（机制落盘）').toBe(1)
    // 旧口径的措辞不得回潮（persona 里那句「写盘 + 回同一份正文」）。
    expect(SRC).not.toContain('Write the report to ${options.reportPath}')
  })

  it('closer 失败不吞 results（Bug B 的反向形态不得回潮）', () => {
    const fn = between('const runCloser = async (', '\n              // fork（corum）2026-10-22：**SCRIPTED 模式已移除**')
    // closer 的错误进 `closer.error`，不 throw 顶替整个结果。
    expect(fn).toContain('error: error instanceof Error ? error.message : String(error)')
    expect(fn).not.toMatch(/throw error/)
  })
})

/**
 * 修复②（2026-10 实机）：**internalNotes 的矛盾作废**。
 *
 * 病根：`drainOrchestrationNotes()` 在 closer 派发**之前**取值 ⇒ 拿到的是**合并前**快照；
 * closer 合并成功后没人作废那条「N isolated branch(es) are NOT merged …」说明，于是结果里
 * 同时出现「已集成」与「没合并」两条互斥结论（卡片「机制内部说明」区照样渲染）。
 *
 * 剔除判据刻意落在**台账实况**上（已翻成 integrated 的分支），不是「merge 场景 + 无 error
 * 就全剔」——后者会把「closer 自称成功、台账却没翻」这类漂移一起抹掉。
 */
describe('修复②：closer 成功后的 internalNotes 按台账实况对账', () => {
  it('★ 成功分支返回的是**对账后**的说明，不是合并前快照', () => {
    const fn = between('const runCloser = async (', '\n              // fork（corum）2026-10-22：**SCRIPTED 模式已移除**')
    // 成功返回处必须用 corumReconciledNotes()，不能原样回 internalNotes。
    expect(fn).toContain('internalNotes: corumReconciledNotes()')
    // 失败路径（catch / 非 foreground）**保留**原始说明——那是真未解决。
    expect(fn).toContain('reportWritten: false, internalNotes, error:')
  })

  it('★ 剔除判据是台账里 status === \'integrated\' 的分支（事实，不是场景）', () => {
    const fn = between('const runCloser = async (', '\n              // fork（corum）2026-10-22：**SCRIPTED 模式已移除**')
    expect(fn).toContain("entry.status === 'integrated'")
    // 重新读台账（entriesOf 会先按 git 实况对账）——不是复用 pending 入参。
    expect(fn).toContain('orchestration.entriesOf(sessionId)')
    // 重写 pending 说明时复用捕获侧的同一份生成器（措辞不得漂移）。
    expect(fn).toContain('corumPendingIntegrationNoticeText,')
  })
})

describe('⑤ 提示词：黑盒语义写清（主 Agent 只发起等结果、内部不可见）', () => {
  it('★ 工具描述点明「一次黑盒调用 / 内部 settle 到机制」', () => {
    expect(SRC).toContain('It is ONE BLACK-BOX CALL')
    expect(SRC).toContain('settle INTO THE MECHANISM')
    expect(SRC).toContain('must not try to finish their work yourself')
  })

  it('★ 系统提示词段同口径（含 closer 的存在与「别自己收尾」）', () => {
    expect(SRC).toContain('**`orchestrate` is ONE BLACK-BOX CALL.**')
    expect(SRC).toContain('A closer node')
    expect(SRC).toContain('must NOT try to merge, integrate or finish their work while the call runs')
  })

  it('★ 返回形态写进提示词（报告 + 引用，正文不内联）', () => {
    expect(SRC).toContain('WHAT YOU GET BACK: the closer')
  })

  it('★ 冲突预判写进提示词（机制无法在改动发生前判定冲突）', () => {
    expect(SRC).toContain('CONFLICT PRE-FLIGHT IS YOURS')
    expect(SRC).toContain('Two tasks editing one file will collide at merge time')
  })
})
