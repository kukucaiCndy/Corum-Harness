/**
 * fork（corum）提示词纪律的机器化对账（2026-09-14 委派正确性 + 效率合并轮）。
 *
 * 为什么需要「源码扫描式」对账（本仓先例：`corum-agent/tests/builtin-roles.spec.ts`
 * 用 `indexOf` 切片钉住规则顺序）：机制段的文本是**模型唯一读到的规则面**，它一旦
 * 被悄悄改写或漂移，只有实机重启后读工具描述才看得出来。本 spec 把两件事变成断言：
 *
 *   1. **决策点分工**：只读调研必须路由到只读研究工具、写任务才用写能力工具，
 *      且「无修改就不召唤写能力子 Agent」这条负向规则必须同时出现在
 *      （a）工具 description 的决策点文本、（b）机制段；
 *   2. **写作纪律**：机制段条目里不得出现实测数字/监督调试框架/项目专属特例
 *      ——这是用户 2026-09-14 定调的通用性要求，靠人工复核容易回潮，落成断言。
 *
 * 覆盖边界：本 spec 只做**文本面**断言，不改任何机制语义；实机装配仍由 CDP 取证。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  corumEfficiencyDisciplineLines,
  corumExecutionDisciplineText,
  corumSandboxEscalationLines,
} from '@corum/corum-orchestration'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

/** 取出一段源码文本：从 `from` 到 `to`（不含）——顺序即语义锚点。 */
function between(from: string, to: string): string {
  const start = SRC.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0)
  const end = SRC.indexOf(to, start + from.length)
  expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('决策点分工 — 只读调研不走写能力子 Agent（源码扫描对账单测）', () => {
  it('工具 description 的决策点文本：按「需不需要执行」分流，且写明两边工具面边界', () => {
    // 2026-09-14 修正后的契约（用户点名「主 Agent 派 research 去验收」）：
    // 旧文案把 `verification by inspection`（验收）整类划给只读工具 ⇒ 执行型验收被派给
    // 没有 write 的子会话 ⇒ 派单里「不许改文件」与「必须造 fixture」并存（实证 6364e3ea）。
    // 现在按 **EXECUTE 还是 JUDGE** 分流，并把工具面边界写在决策点上。
    const anchor = 'Choose by whether the subtask must EXECUTE or only JUDGE'
    const start = SRC.indexOf(anchor)
    expect(start, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0)
    const block = SRC.slice(start, SRC.indexOf('parameters:', start))
    expect(block).not.toBe('')

    // ① 只读工具的能力边界必须写清（这是旧文案缺失、导致误派的部分）。
    expect(block).toContain('`subagent_research` is read-only')
    expect(block).toContain('write/edit are denied')
    expect(block).toContain('pinned to `read-only`')
    // ② **执行型验收**必须走写能力工具（本次修的核心）。
    expect(block).toContain('executable verification')
    expect(block).toContain('Running a verification is not the same as inspecting one')
    // ③ 「不许改文件」与「必须造 fixture」不可并存，必须显式点明。
    expect(block).toContain('cannot both hold')
    // ④ 负向规则保留：没有修改就不该召唤写能力子 Agent。
    expect(block).toContain('A subtask that changes nothing must not be given a write-capable child')
    // ⑤ 决策点文本必须**排在**参数表之前（模型先读到分工，再看到参数）。
    expect(start).toBeLessThan(SRC.indexOf('parameters: {', start))
  })

  it('机制段：最短路径原则置顶，只读/写/执行型验收三条并列在选择清单最前', () => {
    // 2026-09-27 重排：原则句置顶（`SHORTEST PATH WINS`），三条并列在最前；
    // 旧的 `- ONE focused, self-contained subtask …` 条目已并入"改文件"那条（去重）。
    const block = between('SHORTEST PATH WINS', 'if (hasOrchestrate)')
    const principleAt = block.indexOf('SHORTEST PATH WINS')
    const readAt = block.indexOf('- READ-ONLY work')
    const writeAt = block.indexOf('- Work that CHANGES files')
    const verifyAt = block.indexOf('- EXECUTABLE verification')
    expect(principleAt).toBe(0)
    expect(readAt).toBeGreaterThan(principleAt)
    expect(writeAt).toBeGreaterThan(readAt)
    expect(verifyAt).toBeGreaterThan(writeAt)
    // 条目统一为 `→ \`工具名\`` 风格（重排时去掉了冗余的 "call" 一词）。
    expect(block).toContain('→ `subagent_research`')
    expect(block).toContain('one call, one result')
  })

  it('机制段：隔离是「改动」的属性，只读委派不消耗隔离面', () => {
    expect(SRC).toContain('Isolation is a property of CHANGE, not of delegation')
    expect(SRC).toContain('never call the write-capable `subagent` for a task that changes nothing')
  })
})

describe('H 写作纪律 — 机制段提示词不得夹带实测数字 / 监督调试框架 / 项目特例', () => {
  const lines = [...corumEfficiencyDisciplineLines(), ...corumSandboxEscalationLines()]

  it('纪律文本唯一事实源 + 能力自适应（2026-09-27 审查员 C 4.3 后）', () => {
    // 句子定义在 corum-orchestration/src/execution-discipline.ts；组装两档：
    //   · corumExecutionDisciplineText({ptcPrefix}) —— root scope 段（写工具指引是文本条件句）
    //   · corumMinimalDisciplineLines() —— minimal 的 complete persona（只保留它真有的工具）
    //   · compile.ts 用后者，agent-service.ts 用前者。
    const definitions = readFileSync(
      join(import.meta.dirname, '../../corum-orchestration/src/execution-discipline.ts'), 'utf8')
    for (const fn of ['corumEfficiencyDisciplineLines', 'corumSandboxEscalationLines',
      'corumExecutionDisciplineText', 'corumMinimalDisciplineLines']) {
      expect((definitions.match(new RegExp(`export function ${fn}\\(`, 'g')) ?? []).length, fn).toBe(1)
    }
    const service = readFileSync(join(import.meta.dirname, '../../corum-agent/src/agent-service.ts'), 'utf8')
    expect(service).toContain('corumExecutionDisciplineText({')
    // ★ 防回归：这里**不得**读 ctx.tools —— agent-service 的 inject 里没有 tools，实机抛过
    // `cannot get property "tools" without inject`（红线 #4）；工具面差异改由文本条件句承担。
    // 断言**该段注册处**是静态文本（agent-service 别处有既存的 ctx.tools 用法，不能全局否定）。
    expect(service).toContain("text: () => corumExecutionDisciplineText({ ptcPrefix: '' })")
    const compileSrc = readFileSync(join(import.meta.dirname, '../../corum-agent/src/compile.ts'), 'utf8')
    expect(compileSrc).toContain('corumMinimalDisciplineLines()')
    expect(SRC).not.toContain("name: 'corum:execution-discipline'")
    // 出现 2 次 = import + 注册（注册只有一处；旧的每实例注册已删除，同层重名会硬抛）。
    expect((service.match(/CORUM_EXECUTION_DISCIPLINE_SECTION,/g) ?? []).length).toBe(2)
    expect((service.match(/name: CORUM_EXECUTION_DISCIPLINE_SECTION,/g) ?? []).length).toBe(1)
  })

  it('★ 写工具指引是**条件句**（无写工具的读者不会被要求用不存在的工具；审查员 C 4.3-9/10）', () => {
    // 2026-09-27：从「运行时读工具面自适应」改为**文本层条件句** —— 前者会在未声明 inject 的
    // 上下文里抛 cannot get property "tools" without inject（实机抓到过），后者同样达到目的。
    const text = corumExecutionDisciplineText({ ptcPrefix: '' })
    expect(text).toContain('If this session has the `write`/`edit` tools, create and edit files with them')
    expect(text).toContain('KNOW YOUR SHELL')
    expect(text).toContain('SANDBOX DENIALS AND ESCALATION')
    expect(corumExecutionDisciplineText({ ptcPrefix: 'PTC: ' })).toMatch(/^PTC: /)
  })

  it('★ 跨块一致性：读文件口径唯一（唯一家 = tool-policy；两条盲区各自覆盖）', () => {
    // 2026-09-27 P9 去重：规则从纪律块搬到唯一家 `corum:tool-policy`（root scope）。
    // 两条"读者会失明"的盲区必须由别处覆盖：① 指挥者清空 tool-policy ⇒ 人格段自带；
    // ② minimal 是 complete（读不到 tool-policy）⇒ 极简变体保留自己那条。
    const definitionSrc = readFileSync(
      join(import.meta.dirname, '../../corum-orchestration/src/execution-discipline.ts'), 'utf8')
    const discipline = lines.join('\n')
    expect(discipline).not.toContain('READ CODE WITH `read`')
    expect(discipline).not.toContain('Batch every `grep`/`sed`')
    const policy = readFileSync(join(import.meta.dirname, '../../corum-agent/src/tool-policy.ts'), 'utf8')
    expect(policy).toContain('Read files with `read` — not `cat` / `head` / `tail` / `sed -n` / `less`')
    expect(policy).toContain('keep the shell for a live stream you must follow (`tail -f`)')
    const persona = readFileSync(join(import.meta.dirname, '../../corum-agent/src/conductor.ts'), 'utf8')
    expect(persona).toContain('Read files (logs and PID files included) with the structured `read` tool, not the shell')
    expect(definitionSrc).toContain('READ FILES WITH `read`, NOT THE SHELL')
    const childRoles = readFileSync(join(import.meta.dirname, '../../corum-subagent/src/child-roles.ts'), 'utf8')
    expect(childRoles).toContain('`grep` locates, `read` explains')
    expect(childRoles).toContain('never edit from grep output alone')
  })

  it('不得出现实测数字（墙钟分钟 / 缺陷数 / 百分比 / 工具调用计数）', () => {
    const text = lines.join('\n')
    for (const banned of [/\b7m40s\b/, /\b111\b/, /\b91\b/, /\b26%\b/, /minutes? of wall clock/, /ZERO new defects/i]) {
      expect(text, `banned measured figure: ${String(banned)}`).not.toMatch(banned)
    }
  })

  it('不得出现监督 / 调试模式专属框架', () => {
    const text = lines.join('\n')
    for (const banned of [/supervisor/i, /verifier OUTSIDE this session/i, /next round can compare/i, /verified on device/i, /measured on real delegations/i]) {
      expect(text, `banned framing: ${String(banned)}`).not.toMatch(banned)
    }
  })

  it('不得夹带项目专属特例（脚本名 / 端口 / 角色归属举例）', () => {
    const text = lines.join('\n')
    for (const banned of [/verify-fork-drift/, /corum-cdp-verify/, /:9222/, /:9333/, /\bcdp\.mjs\b/, /approval\/asked/]) {
      expect(text, `banned project-specific example: ${String(banned)}`).not.toMatch(banned)
    }
  })

  it('允许的量化只有机制常量（默认超时 / 上限 / 同回合一次）', () => {
    const text = lines.join('\n')
    // 2026-09-27（对抗审查员 C 更正）：真值来源是**运行时行 config** ——
    // `node_modules/.pnpm/@deepseek-ai+dsh-base@0.1.3-alpha.1.../cordis.patch.yml:221-224`
    // 的 `bash-sandbox` 行写死 `timeoutMs: 60000`，`LocalBashExecutor.resolve()` 用
    // `request.timeoutMs ?? rowConfig.timeoutMs` ⇒ 不传 per-call 就是 **60s**。
    // 我先前拿 `/Users/kukucai/dsh`（现在是 dsh-v0.1.7-rc.2 ✗ 非运行时）里 bash-local 的
    // **库默认 120_000** 当依据，把对的改成错的 —— 教训见 docs/LESSONS.md §4.36。
    expect(text).toContain('60s by default')
    expect(text).not.toContain('120s by default')
    expect(text).toContain('600000')
    expect(text).toContain('retry the exact same command once')
  })
})

describe('F 后台任务纪律 — 范畴与禁忌（照官方口径恢复）', () => {
  const background = corumEfficiencyDisciplineLines().find(l => l.includes('PUT LONG-RUNNING')) ?? ''

  it('范畴：长时/暂不需要结果的命令放后台，返回句柄，用收集/终止工具处理', () => {
    expect(background).toContain('run_in_background: true')
    // 2026-09-27 P9 去重：具体工具名归官方 `tool:jobs` 段（唯一家），此处只要求它**指向**作业工具。
    expect(background).toContain('the job tools')
    expect(background).toContain('A server, a watcher, a long build or a long test suite')
  })

  it('禁用轮询替代后台等待', () => {
    expect(background).toContain('Never replace that handle with "wait a moment, then look again"')
  })

  it('三条禁忌齐备：结果依赖 / 影响本会话运行环境 / 输出不可取回', () => {
    expect(background).toContain('Do not background a command whose result you need before the next step')
    expect(background).toContain('would stop or restart the runtime this session depends on')
    expect(background).toContain('whose output cannot be retrieved')
  })
})

describe('I 沙箱升级 — 被拒 → 同回合升级一次 → 由用户裁决', () => {
  const text = corumSandboxEscalationLines().join('\n')

  it('拒绝标记是策略决定，不是命令失败', () => {
    expect(text).toContain('[sandbox: file access denied under <mode> mode]')
    expect(text).toContain('policy decision, not a failure of the command')
  })

  it('同回合重试同一条命令一次，带最窄够用档 + 一句 justification，主会话审批弹窗即同意', () => {
    expect(text).toContain('retry the exact same command once, in the same turn')
    expect(text).toContain('sandbox_permissions')
    expect(text).toContain('narrowest wider mode that suffices')
    expect(text).toContain('justification')
    expect(text).toContain('approval policy is `ask`')
  })

  it('两条边界：不得预先猜测式升级；被拒即终结（但不影响后续其它命令）', () => {
    expect(text).toContain('never speculatively')
    expect(text).toContain('a denial is final')
    expect(text).toContain('A rejected escalation is final for that command')
    expect(text).toContain('does not forbid attempting or escalating other commands later')
  })

  it('措辞纪律：不写具体端口 / 脚本 / 会话', () => {
    for (const banned of [/:9222/, /:9333/, /verify-instance/, /danger-full-access/]) {
      expect(text, `banned concrete example: ${String(banned)}`).not.toMatch(banned)
    }
  })
})

/**
 * fork（corum）2026-09-20：机制段的**能力感知**（用户报障，见待办登记册 §D1/D2）。
 *
 * 本段同时注入主会话与子会话。原文两处假设读者「能跑构建」，实测与指挥模式的工具面矛盾：
 *
 *   D1 「run the repo guard ONCE in full」—— 指挥模式的主 Agent 被裁掉写工具、shell 只读，
 *      物理上跑不了仓库守卫；该指令与人格段「you cannot edit files」直接冲突
 *      （与 worker 那次「你没有写工具 vs 工具表里有 write」是同一类病）。
 *   D2 「a child ... cannot produce independent evidence」—— 对**重复同一校验**成立，但对
 *      `subagent_research` 不成立（它有独立上下文、自己读代码）。原措辞会抵消用户定的
 *      「广域调研交给 research」三阶段引导。
 */
describe('机制段能力感知（2026-09-20 D1/D2 修复）', () => {
  // 2026-09-27：这两块已下沉到 @corum/corum-orchestration 的 execution-discipline.ts。
  const source = readFileSync(
    join(import.meta.dirname, '../../corum-orchestration/src/execution-discipline.ts'),
    'utf8',
  )

  it('D1：守卫命令按能力表述，不再假定读者能跑构建', () => {
    // 2026-09-27 修 F1（对抗审查员 A 报）：旧判据「if you can run commands」对 worker 为真，
    // 而 worker 契约无条件禁构建 ⇒ 两块相反。改为「**only if this session is allowed to build/test**」。
    expect(source).toContain('run the repository guard ONCE in full **only if this session is allowed to build/test**')
    expect(source).toContain('an isolated worker is not')
    // 跑不了的人**不许跳过验证**，但要说明谁负责。
    // 2026-11-12c T2-3 精简：原句「you do not get to skip verification」压成
    // 「you do not skip verification」——义务本身不变，断言随措辞迁移（强度等价的否定式）。
    expect(source).toContain('you do not skip verification')
    expect(source).toContain('state plainly which checks you could not run and who owns them')
    // 旧的无条件措辞必须已消失。
    expect(source).not.toContain('run the repo guard ONCE in full, (3)')
  })

  it('D2：断言收窄到「重复同一校验」，并明确 research 的独立调查是有效证据', () => {
    expect(source).toContain('REPEATING A CHECK IS NOT VERIFICATION')
    // 2026-11-12c T2-4 精简：断言随措辞迁移（「not about investigation」→「not investigation」、
    // 去掉强调记号本身不是语义变化）；「同一校验 ≠ 调查」这条收窄仍是断言的落点。
    expect(source).toContain('This is about re-running a check you already ran, not investigation')
    expect(source).toContain('an independent `subagent_research` child reads the code in its own context and **is** valid evidence')
    // 旧的过强措辞必须已消失（它会抵消三阶段引导）。
    expect(source).not.toContain('DELEGATION IS NOT VERIFICATION')
  })
})
