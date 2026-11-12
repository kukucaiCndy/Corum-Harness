/**
 * 指挥模式（`conductor`）单测——2026-09-10 用户需求「把编排者固化为与标准模式同级的
 * 基准模式」。
 *
 * 覆盖：
 *   1. `isConductorMode` 判定（基准 preset / 旧 orchestrator profile / 其他模式不误伤）；
 *   2. `conductorExecutionDeny` 平台口径（pwsh 仅 win32——deny 未知名会让
 *      `tools.restrict()` fail-loud，见 docs/LESSONS.md §6.18）；
 *   3. 人格段写作纪律（不重复机制事实——隔离触发/模型锁/结果回传形态由 fork #10 的
 *      机制段单一事实源负责，见 docs/PROMPT-INVENTORY.md §1）；
 *   4. preset 数据面存在且与代码常量对账（id / 显示名 / 工具面与标准模式同款）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONDUCTOR_MODE_LABEL,
  CONDUCTOR_PERSONA,
  CONDUCTOR_PRESET_ID,
  CONDUCTOR_SECTION,
  CONDUCTOR_STALE_SECTIONS,
  conductorExecutionDeny,
  conductorModeOf,
  effectiveExecutionTools,
} from '../src/conductor.ts'
// 2026-09-20：子 Agent 角色契约已迁到 `@corum/corum-subagent` 的 child-roles.ts（它的
// 消费者是子 scope 的影子段，不再由 corum-agent 提供）。
import { CHILD_WORKER_ROLE, PERSONA_INJECTION_MAX_CHARS, RESEARCHER_ROLE } from '../../corum-subagent/src/child-roles.ts'
import { compilePreset } from '../src/compile.ts'

const PRESET_DIR = join(import.meta.dirname, '../../../../desktop/shipped-presets/official')

describe('conductorModeOf — 指挥模式判定', () => {
  it('基准 preset `conductor` → preset 形态（官方 preset 路径）', () => {
    expect(conductorModeOf(CONDUCTOR_PRESET_ID, true)).toBe('preset')
  })

  it('旧 orchestrator profile → profile 形态（兼容既有用户数据，人格由它自己的 preset 带）', () => {
    expect(conductorModeOf('deepseek-orchestrator', false, 'orchestrator')).toBe('profile')
  })

  it('其他官方模式 → off', () => {
    for (const id of ['standard', 'ptc', 'cordis', 'minimal']) {
      expect(conductorModeOf(id, true)).toBe('off')
    }
  })

  it('corum profile 缺省/full → off', () => {
    expect(conductorModeOf('frontend-engineer', false)).toBe('off')
    expect(conductorModeOf('frontend-engineer', false, 'full')).toBe('off')
  })

  it('同名 id 但非官方 preset → off（防止 user 目录同名 profile 误伤）', () => {
    expect(conductorModeOf(CONDUCTOR_PRESET_ID, false)).toBe('off')
  })
})

describe('CONDUCTOR_SECTION — 角色段不覆盖部署人格', () => {
  it('段名独立于 deployment:persona（基准模式必须保留部署事实）', () => {
    expect(CONDUCTOR_SECTION).toBe('corum:conductor')
    expect(CONDUCTOR_SECTION).not.toBe('deployment:persona')
  })
})

describe('conductorExecutionDeny — 执行工具平台口径', () => {
  it('macOS/Linux 不含 pwsh（未装载的名字会让 restrict fail-loud）', () => {
    if (process.platform === 'win32') return
    expect(conductorExecutionDeny()).not.toContain('pwsh')
    expect(conductorExecutionDeny()).toEqual(
      expect.arrayContaining(['str_replace_editor', 'write', 'edit']),
    )
  })

  it('deny 覆盖全部**写**入口（主 Agent 物理上无法亲手改代码）', () => {
    const deny = conductorExecutionDeny()
    for (const tool of ['str_replace_editor', 'write', 'edit']) {
      expect(deny).toContain(tool)
    }
  })

  it('**bash 不在 deny 里**（2026-09-20 用户定调：给它只读 shell，否则指挥模式太受限）', () => {
    // 用户原话：「这里应该要给其 bash 的只读权限，否则指挥模式有点受限」。
    // 只读性由**会话沙箱**保证（applyConductorMode 钉 read-only），而不是靠裁工具 ——
    // `tool-bash` 自身没有只读档，裁掉它等于指挥者连 ls / git log 都做不了。
    expect(conductorExecutionDeny()).not.toContain('bash')
  })
})

describe('CONDUCTOR_PERSONA — 人格段写作纪律', () => {
  it('声明「无写工具」与五个工作阶段（英文提示词）', () => {
    // 2026-09-19 重写：旧文本是 "Iron rule: you never write code, edit files, or run
    // commands yourself"。
    // 2026-09-20（任务 A）：从「cannot edit files **or run commands**」改为「cannot edit
    // files」——bash 已放开但只读，措辞必须跟着改，否则又是「指令与能力矛盾」。
    // 2026-09-20：阶段 1 由 "Investigate" 改名 "Frame"。
    expect(CONDUCTOR_PERSONA).toContain('you cannot edit files')
    for (const stage of ['1. Frame:', '2. Design:', '3. Delegate:', '4. Verify:', '5. Decide:']) {
      expect(CONDUCTOR_PERSONA).toContain(stage)
    }
    // 全英文：人格段不得含中日韩字符（2026-09-10 用户要求「提示词都以英文编写」）。
    expect(CONDUCTOR_PERSONA).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('要求主 Agent 亲自验收（2026-09-19 用户报障：退化成纯派活器）', () => {
    // 用户实测（会话 `corum-task-0b812630`）：20 次工具调用里 read/glob/grep **一次都没调**，
    // 全是 subagent/send_message 之类——主 Agent 不调查、不验收，只转述子报告。
    // 但 2026-09-20 用户又指出反方向的代价：自己全包调研 ⇒ 思维链冗余、上下文快速耗尽。
    // 故现在的口径是**分工**：点读与验收自己做，广域调研委派。两条断言都要在。
    expect(CONDUCTOR_PERSONA).toContain('A child agent\'s self-report is never proof')
    expect(CONDUCTOR_PERSONA).toContain('read the actual diff')
    // 2026-09-20（任务 A）：bash 已放开但只读，故不再有「只有 read-only tools」的说法；
    // 改为断言「点读自己做的能力面」仍在（read/glob/grep）。
    expect(CONDUCTOR_PERSONA).toMatch(/read \/ glob \/ grep/)
  })

  it('三阶段渐进式调研 + 可判定停止点（2026-09-20 用户定调）', () => {
    // 用户原话：「我希望调研的任务还是能多委派给 research 做，然后带上自己的思考这样会好一点
    // 如果自己完全调研 这个模式的思维链里冗余内容会比较长 上下文快速耗尽」+
    // 「思考者肯定要自己去看一下大概的，然后深入它就不做，交给 research 进行，
    // 最终收到报告后，做到心里有数即可」。
    //
    // 实测两次都证实**二分法无效**（db663875 自己 18 次 : 委派 2 次；36e24826 自己 38 次 :
    // 委派 1 次，上下文 225,621 字符），根因是**没有停止点** —— 模型总能说「再看一处」。
    expect(CONDUCTOR_PERSONA).toContain('investigate in three phases')
    for (const phase of ['1. **Orient', '2. **Go deep', '3. **Close']) {
      expect(CONDUCTOR_PERSONA).toContain(phase)
    }
    // 核心：可判定的停止点。
    expect(CONDUCTOR_PERSONA).toContain('once you can already write the brief, you are done reading')
    // 配套的漂移判据（实测里 grep 第 17-18 次已跑到无关话题）。
    expect(CONDUCTOR_PERSONA).toContain('Watch for drift')
    // 旧文本那句「绝不派子 Agent 去查你自己两次调用能查到的东西」是**过校正**，必须已删除。
    expect(CONDUCTOR_PERSONA).not.toContain('Never send a child to find out')
    // 旧二分法措辞已被三阶段取代（两套口径并存会互相打架）。
    expect(CONDUCTOR_PERSONA).not.toContain('Broad or exploratory investigation → delegate')
  })

  it('告诉它 worker 不能构建（否则 brief 会写「build 必须通过」把子 Agent 逼去自造工具链）', () => {
    // 实测（会话 corum-task-db663875 → wt-40e4d1 的 worker）：brief 写着
    // `pnpm --filter @corum/corum-ide-ui run build` 必须通过，而 worker 契约禁止构建
    // ⇒ 子 Agent 在自己的推理里明确记下「Hmm. Conflict」，然后花了 11 次调用找一个能用的
    // tsc，最后在 /tmp 手搓了一个 type-check harness —— 两边都没得到想要的结果。
    expect(CONDUCTOR_PERSONA).toMatch(/cannot build or install/)
    expect(CONDUCTOR_PERSONA).toMatch(/never put a build/)
    // 验收标准要写成「终态描述」而不是「构建命令」。
    expect(CONDUCTOR_PERSONA).toMatch(/end state|description of the correct end state/)
  })

  it('不重复机制事实（隔离触发/模型锁/验收门禁由机制段单一事实源负责）', () => {
    // 并发感知隔离、声明式验收、notice 回传形态——这些属于机制段，人格段不得复述。
    // 例外（2026-09-20）：允许提 worktree **一次**，且只为解释「为什么 worker 不能构建」
    // （构建产物不回主树）——那是 brief 作者必须知道的约束，不是复述隔离机制本身。
    expect(CONDUCTOR_PERSONA.match(/worktree/g)?.length ?? 0).toBeLessThanOrEqual(1)
    expect(CONDUCTOR_PERSONA).not.toContain('并发')
    expect(CONDUCTOR_PERSONA).not.toContain('notice')
    expect(CONDUCTOR_PERSONA).not.toContain('autoIntegrate')
  })

  it('点名两个只读/编排入口（模型可据此选择工具）', () => {
    expect(CONDUCTOR_PERSONA).toContain('subagent')
    expect(CONDUCTOR_PERSONA).toContain('subagent_research')
    expect(CONDUCTOR_PERSONA).toContain('orchestrate')
  })

  it('★ 单一事实源：形式表只在机制段，人格段只留索引式指向语（2026-09-27 用户要求统一）', () => {
    // 背景：`CONDUCTOR_PERSONA` 原先自带一张 5 条 bullet 的「形式选择表」，与
    // `corum-tool-subagent` 注入的 `corum:subagent-orchestration`（四模式共享、按工具可见性
    // 动态裁剪）重复 ⇒ 两处措辞各自漂移。现在规则表只保留在机制段，人格段留「点名入口 + 指向」
    // 的索引句：模型仍找得到入口，但不复述规则。
    //
    // ⚠️ 断言按**表形态**（bullet 前缀 + 映射箭头），不按关键词 —— 人格段别处会合法提到
    // `subagent_research` / `orchestrate`（三阶段调研、指向语），按关键词断言会误伤。
    expect(CONDUCTOR_PERSONA).not.toMatch(/^- (Read-only|One focused|Work you can keep|Several genuinely independent)/m)
    expect(CONDUCTOR_PERSONA).not.toMatch(/→\s*`(subagent|subagent_research|orchestrate)`/)
    expect(CONDUCTOR_PERSONA).not.toContain('Choose the right delegation form')
    // 指向语 + 保留的那条 todo/goal 事实（机制段不覆盖它，故必须留在人格段）
    expect(CONDUCTOR_PERSONA).toContain('specified in the subagent section of this prompt')
    expect(CONDUCTOR_PERSONA).toContain('Planning, notes and long-running objectives stay with your own todo / goal tools')
    // 单一事实源守卫：规则表确实在机制段源码里（四模式共享的唯一出处）。
    const sectionSrc = readFileSync(join(import.meta.dirname, '../../corum-tool-subagent/src/index.ts'), 'utf8')
    // 2026-09-27 重排：表头改为「SHORTEST PATH WINS — … Choose the form by the shape of the work:」。
    expect(sectionSrc).toContain('SHORTEST PATH WINS')
    expect(sectionSrc).toContain('Choose the form by the shape of the work')
    expect(sectionSrc).toContain('`subagent_fork`')
    expect(sectionSrc).toContain('`orchestrate`')
  })

  it('★ 层序守卫：conductor 编译产物的 delegation 组挂 corum worker 实例（否则机制段不注册，指向语悬空）', () => {
    // 指向语的前提是机制段真的会被注入：`corum:subagent-orchestration` 只由 corum worker 实例
    // 注册（`isWorkerInstance` + 工具可见）。若编译产物把 delegation 组挂成官方包，指向语就指向空。
    const text = JSON.stringify(compilePreset({
      id: 'conductor-layer-guard',
      nickname: '层序守卫',
      title: '层序守卫',
      dimension: '研发',
      baseMode: 'conductor',
      prompt: 'guard',
      model: { provider: 'localhost', model: 'deepseek-v4-pro' },
      skills: [],
      mcpServers: [],
      terminal: { mode: 'sandbox' },
      memoryPolicy: { scope: 'agent' },
      version: 1,
      trust: 'user',
    } as never))
    expect(text).toContain('id: delegation')
    expect(text).toContain('@corum/corum-tool-subagent')
    expect(text).toContain('tool-subagent-research')
    // 编译产物带的是**合并后**的人格段（指向语在位、形式表不在）——单一事实源在真链路成立。
    expect(text).toContain('specified in the subagent section of this prompt')
    expect(text).not.toContain('Choose the right delegation form')
  })
})

describe('CHILD_WORKER_ROLE — 执行者契约（2026-09-20 用户报障）', () => {
  // 用户原话：「对于子 Agent 需要一套强有力的约束 作为执行者 目前看思考和搜索的时间太多了，
  // 完全不是按照指令照做，而是从头再次核查」。
  //
  // 旧文本只讲身份（worker / 执行 brief / 不能继续委派），**没有任何行为约束**——
  // 没有「不许重做 brief 已给的调研」、没有范围纪律、没有停止条件。叠加「每个子 Agent
  // 都被注入完整 AGENTS.md(11KB) + runtime context」（那是给顶层 Agent 写的全局开发规范），
  // worker 就会从头重建认知。以下断言钉住六条硬约束，防止被回退成纯身份描述。
  it('声明执行者身份（子 Agent 是执行者，不是规划者）', () => {
    expect(CHILD_WORKER_ROLE).toContain('executor, not a planner')
    expect(CHILD_WORKER_ROLE).toContain('authoritative specification')
  })

  it('禁止重做 brief 已给的调研（本模式最大的时间浪费源）', () => {
    expect(CHILD_WORKER_ROLE).toContain('Do not redo reconnaissance the brief already answers')
    expect(CHILD_WORKER_ROLE).toContain('Do not re-plan it')
  })

  it('禁止扩大范围与顺手重构（越界必须改为报告）', () => {
    expect(CHILD_WORKER_ROLE).toContain('Stay inside the brief')
    expect(CHILD_WORKER_ROLE).toContain('report it in your reply — do not fix it unasked')
  })

  it('给出停止条件（达标即停，不追求「更彻底」）', () => {
    expect(CHILD_WORKER_ROLE).toContain('Stop when the brief is satisfied')
  })

  it('brief 有错时必须回报而不是自行发挥', () => {
    expect(CHILD_WORKER_ROLE).toContain('do not improvise')
    expect(CHILD_WORKER_ROLE).toContain('blocked report')
  })

  it('不许去找工具链 / 不许为 brief 里的构建验收自造替代（2026-09-20 实测回归门禁）', () => {
    // 实测（wt-40e4d1 的 worker）：worktree 没有 node_modules ⇒ tsc 必然报 module-not-found，
    // 而 worker 为了完成 brief 里「build 必须通过」的验收，花了 11 次调用找可用的 tsc，
    // 最后在 /tmp 手搓 type-check harness。用户定调（方案 A）：把这条指引**改成重读 diff**，
    // 并明确「找不到工具就停下报告」，不留自造的余地。
    expect(CHILD_WORKER_ROLE).toContain('Verify by re-reading your own diff')
    expect(CHILD_WORKER_ROLE).toContain('Do not go looking for a usable toolchain')
    expect(CHILD_WORKER_ROLE).toContain('do not attempt it')
    // 旧指引（"若存在便宜的语法检查就跑"）已被删除 —— 它正是那 11 次往返的诱因。
    expect(CHILD_WORKER_ROLE).not.toContain('If a cheap syntax-only check exists')
  })

  it('禁止构建与安装依赖（用户 2026-09-20 定调：worktree 上构建代价大且产物不回主树）', () => {
    // 实测代价（会话 c8e05318）：1517 秒 / 36 次 bash，其中 8 次是 install/build。
    expect(CHILD_WORKER_ROLE).toContain('Do NOT build')
    expect(CHILD_WORKER_ROLE).toContain('do NOT install dependencies')
    // 必须点明「为什么不」——给模型的理由而不只是命令（否则它会在别的名义下绕过）。
    expect(CHILD_WORKER_ROLE).toMatch(/never merged back|isolated worktree/)
    // 且**不写死具体检查命令**（用户明确：不同语言检查方式不同，不能定死）。
    expect(CHILD_WORKER_ROLE).not.toContain('tsc --noEmit')
    expect(CHILD_WORKER_ROLE).not.toContain('pnpm build')
  })

  it('保留「不能继续委派」（worker 不分层）', () => {
    expect(CHILD_WORKER_ROLE).toContain('You cannot delegate further')
  })

  it('全英文（提示词纪律）', () => {
    expect(CHILD_WORKER_ROLE).not.toMatch(/[\u4e00-\u9fff]/)
  })
})

describe('RESEARCHER_ROLE — 调查员契约（2026-09-20 用户定调）', () => {
  // 用户原话：「search_agent 要是一个全面的调查员」「允许 researcher 继续指派子 Agent
  // 深入调查」。取向与 worker **相反**：worker 要收敛，researcher 要发散——所以两者必须
  // 是两份独立文本，且各自有断言钉住取向，防止被合并或写反。
  it('声明调查员身份（delegating agent 的眼睛）', () => {
    expect(RESEARCHER_ROLE).toContain('thorough investigator')
    expect(RESEARCHER_ROLE).toContain("the delegating agent's eyes")
  })

  it('要求多角度覆盖与多证据源（不得凭单一来源下结论）', () => {
    expect(RESEARCHER_ROLE).toContain('more than one angle')
    expect(RESEARCHER_ROLE).toContain('at least one independent piece of evidence')
  })

  it('要求区分「查到的事实」与「推断」', () => {
    expect(RESEARCHER_ROLE).toContain('Separate what you found from what you infer')
    expect(RESEARCHER_ROLE).toMatch(/inference/)
  })

  it('要求追根因并给出文件+行号（不是听起来合理的故事）', () => {
    expect(RESEARCHER_ROLE).toContain('Chase the root cause')
    expect(RESEARCHER_ROLE).toContain('plausible story that you did not verify is not an answer')
  })

  it('允许继续派子 Agent 深入调查（用户 2026-09-20 定调），但不得借此逃避自己读', () => {
    expect(RESEARCHER_ROLE).toContain('subagent_research')
    expect(RESEARCHER_ROLE).toMatch(/never delegate to avoid doing your own reading/)
  })

  it('保持只读：报告问题而不动手修', () => {
    expect(RESEARCHER_ROLE).toContain('Do not fix anything')
  })

  it('与 worker 的取向相反（防被误合并成同一段）', () => {
    // worker 说「不许扩大搜索」，researcher 说「要更全面」——两者不得互相渗透。
    expect(RESEARCHER_ROLE).not.toContain('Do not redo reconnaissance')
    expect(CHILD_WORKER_ROLE).not.toContain('more than one angle')
  })

  it('全英文（提示词纪律）', () => {
    expect(RESEARCHER_ROLE).not.toMatch(/[\u4e00-\u9fff]/)
  })
})

describe('主 Agent 动态注入（personaHint）', () => {
  it('注入上限为 2000 字符（用户 2026-09-20 定调）', () => {
    expect(PERSONA_INJECTION_MAX_CHARS).toBe(2000)
  })
})

describe('preset 数据面与代码常量对账', () => {
  const presetYml = readFileSync(join(PRESET_DIR, CONDUCTOR_PRESET_ID, 'preset.yml'), 'utf8')
  const composition = readFileSync(join(PRESET_DIR, CONDUCTOR_PRESET_ID, 'agent.cordis.yml'), 'utf8')

  it('preset.yml 的 name 与 CONDUCTOR_MODE_LABEL 一致', () => {
    expect(presetYml).toContain(`name: ${CONDUCTOR_MODE_LABEL}`)
  })

  it('工具面 ⊇ 标准模式（除刻意保留的 tool-ralph 外逐行一致；裁剪只在运行时，preset 不裁行）', () => {
    const rows = (text: string): string => text.slice(text.indexOf('- id: '))
    // 2026-11-12 用户裁决：`tool-ralph` 从 standard 卸载、conductor 保留 ⇒ 两份不再逐字节
    // 相同。不变式仍是「conductor 不得比 standard 更窄」（preset 裁行会连子 Agent 一起裁掉），
    // 故把 conductor 的 ralph 块剥掉后与 standard 逐行对账。剥块口径与
    // scripts/verify-fork-drift.sh §17 同款：从 `- id: tool-ralph` 行起，到下一个 `- id:`
    // 行（或回到第 0 列的非空行）为止——ralph 块没有嵌套行，所以这条口径够用。
    const standardYml = readFileSync(join(PRESET_DIR, 'standard', 'agent.cordis.yml'), 'utf8')
    const ralphBlock = /^[ \t]*- id: tool-ralph[ \t]*\n(?:[ \t].*\n|\n)*(?=[ \t]*- id: |[^ \t\n])/m
    const conductorRows = rows(composition)
    expect(conductorRows).toMatch(ralphBlock)
    expect(conductorRows.replace(ralphBlock, '')).toBe(rows(standardYml))
    // standard 一侧明确不挂（防回潮：有人改回挂载会在这里红）。
    expect(standardYml).not.toMatch(/^[ \t]*- id: tool-ralph/m)
  })

  it('挂 corum 三实例 + 官方 workflow/ralph 经 corum provider 恢复（与标准模式同款）', () => {
    // 2026-09-10：worker + research + fork 三实例（fork 用 corum-fork provider）。
    expect(composition.match(/name: '@corum\/corum-tool-subagent'/g)?.length).toBe(3)
    expect(composition).toContain('readonlyResearch: true')
    expect(composition).toContain('provider: corum-fork')
    // 官方能力恢复：fork 实例 / workflow 引擎 / ralph 启用且走 corum provider；
    // workflow **工具行** 2026-09-10 起退役（语义并入 orchestrate script 模式）。
    for (const restored of ['tool-subagent-fork', 'workflow-worker-thread', 'tool-ralph']) {
      expect(composition).toMatch(new RegExp(`- id: ${restored}\\n(?![\\s\\S]{0,200}?disabled: true)`))
    }
    expect(composition).toMatch(/- id: tool-workflow[\s\S]{0,200}?disabled: true/)
    expect(composition).toContain('provider: corum-spawn')
    // ralph 子 Agent 走 corum-tracked（不隔离但计入并发信号，2026-09-10「ralph 一并纳入」）。
    expect(composition).toContain('subagentProvider: corum-tracked')
  })

  it('陈旧工具指引段名单覆盖 write/edit（裁工具后提示词不得仍教模型使用）', () => {
    expect([...CONDUCTOR_STALE_SECTIONS]).toEqual(['tool:write', 'tool:edit'])
  })
})


describe('effectiveExecutionTools — baseMode conductor 继承指挥语义', () => {
  it('baseMode conductor 且未声明 executionTools → orchestrator（继承指挥模式）', () => {
    expect(effectiveExecutionTools({ baseMode: 'conductor' })).toBe('orchestrator')
  })

  it('显式 executionTools 优先（作者可让 conductor 角色亲手执行）', () => {
    expect(effectiveExecutionTools({ baseMode: 'conductor', executionTools: 'full' })).toBe('full')
  })

  it('其他 baseMode 不受影响', () => {
    for (const baseMode of ['standard', 'ptc', 'minimal', 'cordis']) {
      expect(effectiveExecutionTools({ baseMode })).toBeUndefined()
    }
  })

  it('conductor 角色（baseMode conductor）经 conductorModeOf 走 profile 形态', () => {
    const profile = { baseMode: 'conductor', executionTools: undefined }
    expect(conductorModeOf('conductor-lead', false, effectiveExecutionTools(profile))).toBe('profile')
  })
})

/**
 * fork（corum）2026-09-27（用户实机反馈「指挥模式中并未发挥出非隔离子 Agent 的能力」）：
 * 指挥者人格段原先硬写「A worker runs in an isolated worktree and cannot build or install」
 * ⇒ conductor 认为 worker **恒隔离**，于是把「推送两个仓」派给了默认隔离子 Agent，而它被
 * 隔离守卫硬拒（提权也拒、不出卡），用户点了「同意」却什么都没发生。
 * 本用例把「人格段必须告诉指挥者 main 路由」钉死。
 */
describe('★ 指挥者人格段：必须说明 isolation: "main" 这条路由（2026-09-27）', () => {
  it('提到 isolation: "main" 及其适用场景（push / build / 另一仓）', () => {
    expect(CONDUCTOR_PERSONA).toContain('isolation: "main"')
    expect(CONDUCTOR_PERSONA).toContain('git push')
    expect(CONDUCTOR_PERSONA).toContain('main working tree')
  })

  it('不再声称 worker 恒在隔离 worktree（旧口径已过时）', () => {
    expect(CONDUCTOR_PERSONA).not.toContain('runs in an isolated worktree and **cannot build or install**')
    expect(CONDUCTOR_PERSONA).toContain('ISOLATED by default')
  })
})
