/**
 * 工具描述**准确性**门禁（2026-09-27 用户要求「看一下各个工具的描述是否准确」）。
 *
 * 审计结论（主张 → 机制证据 → 判定）与逐条核对见台账
 * `audit.orchestration-tool-descriptions-accuracy`；本文件只钉住**当时修掉的**两处
 * 不一致，防止回潮：
 *
 *  ① 只读实例（`subagent_research`）原先照搬写向描述头（"A write-capable delegation is
 *     ISOLATED by default … Pass `isolation: "main"` …"）——它的 schema 里**没有**
 *     `isolation` 参数 ⇒ 等于教模型用一个不存在的参数（指令与能力矛盾，本仓明令禁止）。
 *  ② 只读实例的 schema 里**仍然暴露** `integrate`/`verify`（它们写在
 *     `corumReadonlyResearch` 条件之外）⇒ 只读子 Agent 被允许走「主树合并+验证+提交」的
 *     整合者路径，与"只读"能力面矛盾。
 *
 * 手法：读源码做**结构断言**（与 `model-policy.spec.ts` / `prompt-mechanism-agreement.spec.ts`
 * 同款）。参数面是条件展开的对象字面量，用"唯一出现 + 位置在条件块之后"来钉，而不是
 * 靠脆弱的长正则。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compilePreset } from '../../corum-agent/src/compile.ts'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
/** 只读实例与写实例共用的"非只读"条件块起始位置。 */
const NON_READONLY_BLOCK = SRC.indexOf('...corumReadonlyResearch ? {} : {')
/** 从条件块之后找第一次出现（用于确认参数确实在块内）。 */
const after = (needle: string): number => SRC.indexOf(needle, NON_READONLY_BLOCK)

/**
 * 取某 baseMode 编译产物的 persona 行 config（编译产物里读，不读源码文本）。
 *
 * `compilePreset` 的返回结构若变化，本 helper 会 fail-loud（抛错而不是静默返回空对象）。
 * @param mode - 基础模式 id。
 * @returns persona 行的 config。
 */
function personaRowOfMode(mode: string): Record<string, unknown> {
  const { cordisYml } = compilePreset({
    id: `probe-${mode}`,
    nickname: `探针-${mode}`,
    title: '',
    dimension: '研发',
    baseMode: mode,
    prompt: '',
    model: { provider: 'localhost', model: 'deepseek-v4-pro' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
  } as never)
  const lines = cordisYml.split('\n')
  const i = lines.findIndex(l => /^- id: persona\s*$/.test(l))
  if (i < 0) throw new Error(`compilePreset(${mode}) 产物里没有 persona 行`)
  const out: Record<string, unknown> = {}
  let key: string | null = null
  let buf: string[] = []
  const flush = (): void => {
    if (key === null) return
    out[key] = buf.join('\n').trim()
    key = null
    buf = []
  }
  for (let k = i + 1; k < lines.length; k += 1) {
    const l = lines[k]
    if (/^- id: /.test(l)) break
    const kv = /^\s{4}([a-zA-Z]+):\s*(.*)$/.exec(l)
    if (kv !== null) {
      flush()
      key = kv[1]
      const raw = kv[2].trim()
      // 折叠/字面块（>- / |- / > / |）表示后面还有缩进内容
      if (/^[>|][-+]?$/.test(raw)) { buf = []; continue }
      // YAML 字符串会被渲染成带引号的形式（`renderRows` 的行为）⇒ 断言前先剥引号，
      // 否则 `prefix: "You are …"` 与期望的裸文本对不上（实测踩过）。
      const unquoted = /^"(.*)"$/.test(raw) ? raw.slice(1, -1) : raw
      out[key] = unquoted === 'true' ? true : unquoted === 'false' ? false : unquoted
      key = null
      continue
    }
    if (key !== null && /^\s{6,}\S/.test(l)) buf.push(l.trim())
  }
  flush()
  return out
}

describe('工具描述准确性：只读实例（subagent_research）不得继承写向能力面', () => {
  it('描述头按能力面分档：只读实例有自己的只读文案', () => {
    expect(NON_READONLY_BLOCK).toBeGreaterThan(-1)
    expect(SRC).toContain("? 'This tool delegates a READ-ONLY research task")
    expect(SRC).toContain('there is no worktree, no branch, and nothing to merge')
    // 写向头不再无条件拼接（原先它就是 `description: 'A write-capable …' + wording.description`）。
    expect(SRC).not.toMatch(/description: 'A write-capable delegation is ISOLATED by default/)
  })

  it('★ schema：isolation / integrate / verify 的**首次**出现都在非只读块之内（条件块之前不得有它们）', () => {
    // 判据说明：这三个键是**条件展开**的 —— 只要它们没出现在 `...corumReadonlyResearch
    // ? {} : {` **之前**，只读实例的 schema 就不会带上它们。因此断言"首次出现位于块内"，
    // 而不是"全文件唯一"：`orchestrate` 的 `tasks[].isolation` 与 `merge.verify` 是另
    // 一套合法 schema（各出现一次，位置在块之后）。
    for (const needle of ['isolation: {', 'integrate: {', 'verify: {']) {
      const first = SRC.indexOf(needle)
      expect(first, `${needle} 未找到`).toBeGreaterThan(-1)
      expect(first, `${needle} 在非只读条件块之前出现 ⇒ 只读实例也会拿到它`).toBe(after(needle))
    }
  })

  it('写向参数仍完整保留给写实例（不得为了修只读而删掉能力面）', () => {
    expect(SRC).toContain('Set true to merge all isolated worktree branches of this session back into the main working tree')
    expect(SRC).toContain('Do NOT combine with `integrate: true`')
    expect(SRC).toContain('How to build, run, and verify this repository after merging')
  })
})

describe('工具描述准确性：机制主张与实现对齐', () => {
  it('隔离枚举与解析器一致（schema/描述不得出现第五个取值）', () => {
    expect(SRC).toContain('isolation must be one of "worktree" (default), "main", "always", "write-tasks"')
    expect(SRC).toContain("enum: ['worktree', 'main', 'always', 'write-tasks']")
  })

  it('★ 模型路由锁定：脚本模式的 agent() 选项也被明令禁止（引擎支持 provider/model）', () => {
    // 引擎面：workflow-ptc 的 SUPPORTED_AGENT_OPTIONS 含 provider/model ⇒ 若提示词只说
    // 「工具 schema 没有 model 参数」，脚本模式仍可路由子 Agent ⇒ 描述必须额外禁掉它。
    expect(SRC).toContain('passing `provider`/`model` there is still routing a child')
  })

  it('interrupt_agent 的语义按官方原文（请求停止、不等待、其后代继续跑）', () => {
    expect(SRC).toContain('ask it to stop with `interrupt_agent` (a request that returns without waiting; its own children keep running)')
  })
})

/**
 * 编排段重排（2026-09-27 用户要求「整段重新编排」）的结构门禁。
 *
 * 归属划分（重排后）：`tool:subagent`（order 2800，`corumSchedulingSectionText`）只讲**本工具的
 * 调度与生命周期**；跨工具的**形式选择 + 成本判据**全部归 `corum:subagent-orchestration`（2801），
 * 且**最短路径原则置顶**。三条不变式：① 归属不回流；② 同一判据不重复；③ 原则在机制段之前。
 */
describe('编排段重排：归属 / 去重 / 顺序', () => {
  const schedStart = SRC.indexOf('export function corumSchedulingSectionText')
  const schedEnd = SRC.indexOf('\n/**', schedStart)
  const schedBody = schedStart === -1 ? '' : SRC.slice(schedStart, schedEnd)
  const orchestrationStart = SRC.indexOf("name: 'corum:subagent-orchestration'")
  const orchestrationBody = SRC.slice(orchestrationStart)

  it('★ 归属：2800 段（本工具调度）不得再谈别的委派工具', () => {
    expect(schedStart).toBeGreaterThan(-1)
    expect(schedEnd).toBeGreaterThan(schedStart)
    // 正面：本工具的调度事实仍在
    expect(schedBody).toContain('ALWAYS runs in the FOREGROUND')
    expect(schedBody).toContain('Use ${toolName} in the background by default')
    expect(schedBody).toContain('TERMINAL when it settles')
    // 反面：跨工具选择已搬走（旧文案里的这句是重排前唯一的"选 orchestrate"出处）
    expect(schedBody).not.toContain('orchestrate')
    expect(schedBody).not.toContain('final integrator')
  })

  it('★ 最短路径原则置顶，且在机制段之前', () => {
    const principle = orchestrationBody.indexOf('SHORTEST PATH WINS')
    const mechanism = orchestrationBody.indexOf('How the mechanism works')
    expect(principle).toBeGreaterThan(-1)
    expect(mechanism).toBeGreaterThan(principle)
    expect(orchestrationBody).toContain('pick the fewest calls that solve the task')
  })

  it('★ 去重：只读与"一个自洽实现"在工作形态表里各只出现一次', () => {
    // 重排前 `- READ-ONLY work (research, search, fact-finding…` 与 `ONE focused, self-contained`
    // 各出现两遍（无条件清单 + hasResearch/hasOrchestrate 分支）。
    expect((SRC.match(/- READ-ONLY work \(research, search, fact-finding/g) ?? []).length).toBe(1)
    expect((SRC.match(/ONE focused, self-contained/g) ?? []).length).toBe(1)
    // 旧的弱版比较句（把对手设成"串行"）不得回潮——真实对手是 N 个后台并发委派。
    expect(SRC).not.toContain('far better than several sequential')
  })

  it('★ 成本判据完整：工具调用数/通知数/隔离额度/手动集成 四要素 + 选长路的三种例外', () => {
    for (const phrase of [
      'N tool calls',
      'N settlement notices landing in your context',
      'exceeding it FAILS the call',
      'a manual `integrate` afterwards',
    ]) expect(orchestrationBody).toContain(phrase)
    // 2026-09-27 结构化：由一整句改为「表头 + 三条子项」，断言随之按结构拆开。
    expect(orchestrationBody).toContain('Keep N separate `subagent` calls ONLY when:')
    expect(orchestrationBody).toContain('the pieces are genuinely NOT independent')
    expect(orchestrationBody).toContain('steer one mid-flight')
    expect(orchestrationBody).toContain('partial results arriving as they settle')
  })
})

/**
 * 投送门禁（2026-09-27 用户要求「要注入」后的架构）。
 *
 * 两块执行纪律（效率 / 沙箱升级）的读者不只是「能委派的 Agent」：子会话正是沙箱升级纪律的读者
 * （块里写着 "In a DELEGATED CHILD session …"）。故投送路径改为两条：
 *   ① standard / ptc / cordis / conductor 与所有子会话：`corum-agent` 在 **root scope** 注册
 *      `corum:execution-discipline`（所有 corum 会话继承）；
 *   ② minimal：preset 是 `complete`（system-prompt 只渲染 persona）⇒ 段进不去，由 `compile.ts`
 *      把它追加进编译出的人格段。
 * 本组把「不再挂在会被连坐清空的位置」与「minimal 真拿得到」都钉住（后者是**编译级**断言）。
 */
describe('投送：执行纪律段的两条注入路径', () => {
  const SERVICE = readFileSync(join(import.meta.dirname, '../../corum-agent/src/agent-service.ts'), 'utf8')
  const COMPILE = readFileSync(join(import.meta.dirname, '../../corum-agent/src/compile.ts'), 'utf8')

  it('① root scope 段：静态文本、不因缺委派工具而清空（2026-09-27 收敛后）', () => {
    const i = SERVICE.indexOf('name: CORUM_EXECUTION_DISCIPLINE_SECTION,')
    expect(i).toBeGreaterThan(-1)
    const body = SERVICE.slice(i, i + 600)
    // 不得因缺少**委派**工具就整段清空（那正是子会话读不到纪律的老病）。
    expect(body).not.toContain('mounted ===')
    expect(body).not.toContain("return ''")
    // 纪律文本现在是**静态**的（写工具差异由文本条件句承担，不读 ctx.tools ⇒ 不会踩 inject 红线）。
    expect(body).toContain("corumExecutionDisciplineText({ ptcPrefix: '' })")
    // 只否**代码形态**（注释里会提到 ctx.tools 这个名字）。
    expect(body).not.toContain('ctx.tools.get(')
  })

  // 2026-09-29 用户裁决：「minimal 保持官方原汁原味，我们的 Agent 预设不再允许继承此模式，
  // 只内置一个继承此模式的极简助手」。⇒ minimal 下**不再**把 corum 纪律/输出语言拼进人格段
  // （旧断言 `personaTextWithDiscipline` 已随该裁决删除）。本条改为断言**新契约**：
  // ① 编译明确区分 minimal 分支；② minimal 的 persona 行只给官方原文 + complete，
  // 不给 suffix、不拼任何 corum 内容。
  it('② minimal：persona 保持官方原文（不再拼 corum 纪律/输出语言 —— 2026-09-29 用户裁决）', () => {
    expect(COMPILE).toContain('isComplete')
    // minimal 分支给出官方原文
    expect(COMPILE).toContain('You are a helpful software engineer assistant.')
    // 旧的通路（把纪律拼进 persona）不得复活
    expect(COMPILE).not.toContain('personaTextWithDiscipline')
    expect(personaRowOfMode('minimal')).toMatchObject({
      prefix: 'You are a helpful software engineer assistant.',
      suffix: '',
      complete: true,
      includeRuntimeContext: false,
    })
  })

  // 2026-09-29 用户裁决（本文档上一条已说明）：minimal **保持官方原汁原味** ⇒
  // 不再把 corum 纪律/输出语言拼进人格段、suffix 为空。本条保留原来的**约束价值**：
  // ① minimal 的 persona 行必须是官方原文 + complete；
  // ② minimal 的提示词**不得点名它没有的工具**（指令与能力矛盾，2026-09-27 审查员 C 报）；
  // ③ 反过来断言"corum 纪律/输出语言不再出现"（旧行为的防复活断言）。
  it('★ minimal：persona 恒为官方原文、不含 corum 纪律/输出语言，且不点名不存在的工具', () => {
    const compiled = compilePreset({
      id: 'minimal-discipline-probe',
      nickname: '极简纪律探针',
      title: '探针',
      dimension: '研发',
      baseMode: 'minimal',
      prompt: 'probe',
      model: { provider: 'localhost', model: 'deepseek-v4-pro' },
      skills: [],
      mcpServers: [],
      terminal: { mode: 'sandbox' },
      memoryPolicy: { scope: 'agent' },
      version: 1,
      trust: 'user',
    } as never)
    const text = JSON.stringify(compiled)

    // ① persona 行 = 官方原文 + complete（用户裁决）
    expect(personaRowOfMode('minimal')).toMatchObject({
      prefix: 'You are a helpful software engineer assistant.',
      suffix: '',
      complete: true,
      includeRuntimeContext: false,
    })

    // ② 不点名 minimal 没有的工具（保留 2026-09-27 审查员 C 的约束）
    for (const absent of ['`grep`', '`glob`', '`job_output`', '`job_kill`', 'subagent', 'orchestrate']) {
      expect(text, `minimal 提示词点名了不存在的工具：${absent}`).not.toContain(absent)
    }

    // ③ 防复活：corum 纪律与输出语言**不得**再出现在 minimal 的编译产物里
    //    （它们的静态源仍在 corum-orchestration，供其它模式使用 —— 那是别的模式的通路）。
    for (const gone of ['EFFICIENCY DISCIPLINE', 'SANDBOX DENIALS AND ESCALATION', 'OUTPUT LANGUAGE']) {
      expect(text, `minimal 又注入了 corum 内容：${gone}`).not.toContain(gone)
    }
  })

  it('子会话继承前提可审计（preset 生成 join）', () => {
    const childSrc = readFileSync(join(import.meta.dirname, '../../corum-subagent/src/child-agent.ts'), 'utf8')
    expect(childSrc).toContain("'agentPresets')?.composeFrom(childCtx, parent.ctx)")
  })
})

/**
 * P3–P8 防回潮门禁（2026-09-27 「按住未整改」清单 B 组落地）。
 *
 * 来源 = 对抗审查员 B 的主张对照表；每条都给了机制/实现依据，改的是模型可见文本。
 * 登记册：`docs/PENDING-prompt-consistency-followups.md`。
 */
describe('B 组文本级修正（P3–P8）', () => {
  const POLICY = readFileSync(join(import.meta.dirname, '../../corum-agent/src/tool-policy.ts'), 'utf8')

  it('P3：不得再声称 orchestrate 有「更宽的并发上限」（实际上限同为 4，第 5 个并发 fatal）', () => {
    expect(SRC).not.toContain('wider limit')
    // fork（corum）2026-10：断言强度不变（「一次调用、结果集中」），措辞随黑盒化改写——
    // 现在是「一次调用只回一份最终结果」（旧句里的 `merge.verify` 已随字段取消）。
    expect(SRC).toContain('a single call; ONE final result comes back')
  })

  it('P4：bash 改动「不进审查卡」的说法必须消失（corum-review 会解析命令串 + 轮末并集兜底）', () => {
    expect(POLICY).not.toContain('never appear in the change-review card')
    expect(POLICY).not.toContain('bypasses the file-observation policy and the change-review capture')
    expect(POLICY).toContain('Shell writes are still reviewed')
    // 依据锚点：真正负责捕获的实现（防有人删了实现却留着新文案）。
    const review = readFileSync(join(import.meta.dirname, '../../../../desktop/src/host/corum-review.ts'), 'utf8')
    expect(review).toContain('SHELL_TOOL_NAMES')
    expect(review).toContain('porcelain')
  })

  it('P5：orchestrate 的 per-task background 必须写明当前不支持（否则模型会用它换来一次失败）', () => {
    expect(SRC).toContain('NOT SUPPORTED in `orchestrate` yet')
  })

  // fork（corum）2026-10-22：script 模式已移除，P6 断言不再适用。
  // it('P6：script 模式的 opts 必须列出 schema（引擎支持结构化输出）', () => {
  //   expect(SRC).toContain('{ label, phase, schema }')
  // })

  it('P7：research 实例无 MCP 工具必须写进描述（否则主 Agent 白跑一轮）', () => {
    expect(SRC).toContain('**It also has no MCP tools**')
  })

  it('P8：隔离边界标记只随前台结果回来，措辞不得再无条件承诺', () => {
    expect(SRC).toContain('A FOREGROUND result tells you which route ran')
    expect(SRC).not.toContain("The result tells you which route ran, so you never have to guess")
  })
})
