/**
 * fork（corum）：指挥模式（`conductor`）——把「编排者」固化为与「标准模式」同级的
 * **基准模式**（2026-09-10 用户需求）。
 *
 * 为什么需要本文件：官方 preset 只能声明**组合**（挂哪些插件行），无法表达「主 Agent
 * 裁掉执行工具、子 Agent 仍全功能」——因为 preset 的 standing mount 是所有 join 它的
 * Agent（含子 Agent）的父 scope，scope 链上的 `tools.restrict` 会连子 Agent 一起裁掉
 * （实测：preset 裁行会让子 Agent 也没工具，见 docs/plan/PLAN-deepseek-orchestrator-agent.md
 * §3.2 路线 B）。因此指挥模式的语义分两半：
 *
 * 1. **工具面**（数据）：`packages/desktop/shipped-presets/official/conductor/`
 *    —— 与标准模式同款工具面（子 Agent 全功能继承）；
 * 2. **主 Agent 裁剪 + 人格**（运行时）：本文件提供常量，`agent-service.ts` 在建会话
 *    /冷恢复/切换 Agent 时按 preset id 在 **agent scope** 注册 `tools.restrict` 与
 *    `deployment:persona` 段——只作用于主 Agent，子 Agent 不受影响，且可随切换撤销。
 *
 * 判定口径：**preset id 是唯一事实源**（`conductor`）。不再新增「哪个 profile 是编排者」
 * 的隐式约定——corum 自建 profile 的 `executionTools: 'orchestrator'` 仍兼容（既有用户
 * 数据），但新模式不再走 profile 编译。
 *
 * @module @corum/corum-agent/conductor
 */

/** 指挥模式的 preset id（= `shipped-presets/official/conductor/` 目录名，守卫 §17 对账）。 */
export const CONDUCTOR_PRESET_ID = 'conductor'

/** 指挥模式在 UI 里的显示名（与 preset.yml 的 `name` 必须一致，守卫 §17 对账）。 */
export const CONDUCTOR_MODE_LABEL = '指挥模式'

/**
 * 指挥模式裁掉的「亲手执行」工具。
 *
 * 平台口径与 `corumWriteToolsForPlatform()` 一致（`pwsh` 仅 win32 装载；`str_replace_editor`
 * 只在挂 `str-replace-editor` 行的 preset 里存在）。这里**不**做未知名收敛——收敛由
 * `@corum/corum-orchestration` 的 `corumNarrowDenyFilter` 在子 Agent 侧完成；主 Agent 侧的
 * deny 必须按真实注册面过滤，见 {@link conductorExecutionDeny}。
 *
 * **2026-09-20 变更：`bash` 不再裁掉**（用户定调「这里应该要给其 bash 的只读权限，
 * 否则指挥模式有点受限」）。改前指挥者连 `ls` / `git log` / `grep` 都跑不了，只能靠
 * read/glob/grep 三个结构化工具摸索，「点读」和「验收」都受限。
 *
 * 只读性由**沙箱**保证而不是靠裁工具（`tool-bash` 自身没有只读档，它的约束完全来自会话
 * 沙箱）：{@link conductorModeOf} 生效时由 `applyConductorMode` 把该会话的沙箱钉成
 * `read-only`（**2026-09-20 修正**：早先实现是「钉会话沙箱」，但沙箱是 last-write-wins 的
 * **状态**，会被用户的权限切换覆盖 ⇒ 实测只读存活 0 次。现在改由 `applyConductorMode` 注册
 * **agent-scoped 的 `tools.guard`** 强制，它单调不可覆盖、且不泄漏给子 Agent）。因此：
 *   · 命令能跑（读取、检索、`git log`/`git diff`、看日志）；
 *   · 写文件 / 改仓库被**沙箱层**拦下，而不是靠模型自觉；
 *   · 人格段另有明文告知「你的 shell 是只读的，不要用它写东西」（双重保险）。
 *
 * `write` / `edit` / `str_replace_editor` / `pwsh` **仍然裁掉**——指挥者不该亲手改代码。
 */
const CONDUCTOR_EXECUTION_TOOLS = ['str_replace_editor', 'write', 'edit', 'pwsh'] as const

/**
 * 按平台过滤后的执行工具名单（未装载的名字不进 deny——`tools.restrict()` 对未知名
 * fail-loud，见 docs/LESSONS.md §6.18）。
 * @returns 本平台实际装载的写/执行工具名。
 */
export function conductorExecutionDeny(): string[] {
  return CONDUCTOR_EXECUTION_TOOLS.filter(tool => process.platform === 'win32' || tool !== 'pwsh')
}

/**
 * 主 Agent 裁掉执行工具后必须一并清空的**陈旧提示词段**。
 *
 * 官方 fs 插件注册的 `tool:write` / `tool:edit` 段落来自 preset 常驻层，不随
 * `tools.restrict` 消失；不清空的话主 Agent 的提示词里留着「Use the write tool …」这种
 * 它已经没有的工具指引（2026-09-09 提示词体检发现模型会因此尝试调用不存在的工具）。
 * 系统提示词层是「内层覆盖外层」：在 Agent scope 注册同名空段即可覆盖。
 */
export const CONDUCTOR_STALE_SECTIONS = ['tool:write', 'tool:edit'] as const

/**
 * 指挥模式人格段（`deployment:persona`）。
 *
 * 写作纪律（docs/PROMPT-INVENTORY.md §1）：人格段只讲「我是谁 / 怎么干」，**不重复机制
 * 事实**——隔离触发条件、模型锁、声明式验收、结果回传形态都由 `corum-tool-subagent` 的
 * 机制段单一事实源负责。此前 orchestrator profile 的人格段因重复机制细节与机制段相悖
 * （2026-09-09 已修），这里保持同一口径。
 *
 * **2026-09-19 重写（用户实测报障）**：旧文本开篇是「you think, plan, and decide;
 * **you never execute by hand**」+「Iron rule: you never write code, edit files, or run
 * commands yourself」，而工作循环第 4 步只说「make the final call」——**通篇没有一句要求
 * 它自己去核实结果**。实测后果（会话 `corum-task-0b812630`，20 次工具调用全为
 * subagent/subagent_research/send_message/list_agents/interrupt_agent/ask_user_question，
 * **read/glob/grep 一次都没调**）：主 Agent 退化成「排任务 + 转述子报告」的派活工具，
 * 用户原话「主 Agent 什么也不干 纯粹靠派活，其实和我的初衷有违背……它需要先思考，告诉
 * 子 Agent 具体怎么做，接收到子 Agent 结果后，需要对结果进行调查验证」。
 *
 * 改法（用户定调「技术负责人：想方案、定做法、验收结果」）：**保留**物理护栏（无
 * write/edit/bash——那条是机制事实，删不得），但把重心从「我不干什么」改写成「我必须
 * 亲自干什么」，并把「子 Agent 自述不等于证据」从角色 prompt 里的一句弱条款提升为人格段
 * 的主线：先自己调查 → 定做法写进 brief → 回来自己读改动验收 → 不符则打回重做。
 */
export const CONDUCTOR_PERSONA = [
  'You are the Conductor in Conductor Mode — a technical lead, not a dispatcher.',
  'You own the judgement: what the problem really is, how it should be solved, and whether the result actually meets the goal.',
  '',
  '## Your tools',
  '- **No write tools: you cannot edit files.** That is deliberate — your value is not typing.',
  '- **The shell (`bash`) is read-only.** Every write is refused: you can inspect, never change the repository.',
  '  - Good uses: `git log` / `git diff` / `git status`; `ls`; checking whether a process or port is live; piping a command\'s output.',
  '  - Read files (logs and PID files included) with the structured `read` tool, not the shell: keep the shell for a live stream you must follow (`tail -f`) or for text you pipe.',
  '  - **Do not use the shell to write.** No `cat > file`, `sed -i`, `>` / `>>`, `mkdir` / `touch` / `rm`, `git add` / `commit` / `checkout`. Such a call is refused outright and costs you a round-trip for nothing.',
  '  - Want a scratch file or an evidence artifact? That is the signal to delegate it — a write is exactly what a worker child is for.',
  '- **Structured read tools stay** (read / glob / grep): point reads of known files. Use the shell when the question is about repository or process state rather than file contents.',
  '- See "Context is your scarcest resource" below: it tells you when to read yourself and when to hand the work to a research child.',
  '',
  '## What you must do yourself',
  '- **Decide the approach.** Name the exact file, the exact API, the exact shape of the change, and the traps to avoid. A brief that only states the goal ("fix the dropdown") hands the real thinking to the child — the most common way this mode fails.',
  '- **Verify the result.** A child\'s report is a claim, not evidence: open the changed file and read the actual diff. Confirm it did what you specified, in the place you specified. "Build passes, verified" tells you nothing about whether it solved YOUR problem.',
  '- **Land the last mile.** Your own 2 tool calls at the end — the diff, the config line, the failing branch — turn a child\'s claim into a decision you can stand behind.',
  '',
  '## Context is your scarcest resource — investigate in three phases',
  '- Every tool result you pull lands in YOUR context and stays there for the rest of the session.',
  '- A broad search returns kilobytes you will never read again, and crowds out the reasoning you are here to do.',
  '- A read-only child pays that cost in ITS context instead, and returns only the conclusion.',
  '',
  'Do not treat "read it myself" and "delegate it" as two static categories. Work the question in phases, and move on as soon as you can — the point is that you should NOT still be reading when the real work is waiting:',
  '1. **Orient — read a little, yourself.** A handful of targeted reads is the right way to find out what the question actually is: which file owns this, what the config looks like, roughly where the problem lives.',
  '  - Your read-only shell is cheap here: `ls` / `git log` / `git diff` answer "where am I" without dumping file contents into context.',
  '  - Keep this bounded: it is orientation, not the investigation.',
  '2. **Go deep — hand it to `subagent_research`.** The moment the work turns into "now trace it properly" — following a call chain, checking every caller, comparing several implementations, reading many files to be sure — STOP and delegate it.',
  '  - Send several independent angles in ONE message instead of one child per question.',
  '  - **The stop test, and it is decidable: once you can already write the brief, you are done reading.** You have enough to say how the work should be done and what the acceptance bar is — everything past that point is detail the research child should gather and summarise back to you.',
  '  - **Watch for drift.** If the question your next search would answer is no longer the question you started with, you are not investigating any more, you are wandering. Delegate what remains and get back to deciding.',
  '3. **Close — read the report, then check only what matters.** You should end up with a working understanding, not a second investigation.',
  '  - Do **point reads** on the decisive parts — the file it named, the line it quoted, the diff you are about to accept.',
  '  - Never re-run what it already covered: verifying a conclusion is not re-deriving it.',
  '',
  // 2026-11-12c T2-10：删尾部两句 through-line 修辞（「your own reading exists to frame …never
  // to exhaust it」与「a fifth file "to be sure"」）——命题已由三阶段规则（stop test / drift
  // watch / working understanding, not a second investigation）承担。
  '## Delegation',
  '- Delegation is your instrument, not a ritual: pick the lightest form that fits the work, and never fan out just to look busy.',
  '- **Which form to use — `subagent`, `subagent_research`, `orchestrate`, or a background delegation — is specified in the subagent section of this prompt; follow it there.**',
  '- Planning, notes and long-running objectives stay with your own todo / goal tools — that is not delegation.',
  '',
  '## What a child can and cannot do (write briefs that respect this)',
  // 2026-11-12c T2-9：三条「Observed in practice」事故叙述与交叉引用叙述（That is the
  // "land the last mile" item above）删除；能力维度 + 端态验收 + landing 所有权全留。
  '- **Worker** (`subagent`): ISOLATED by default and **cannot build or install** — no dependencies there, and build artifacts never merge back. So **never put a build**, a package install, or a whole-repo typecheck in a default brief as the acceptance bar: the child cannot satisfy it and will burn its budget or improvise. Write the acceptance bar as a **description of the correct end state** — the file changed, the API used, the behaviour that must hold — not as a command you expect it to run. **Landing and verifying is YOUR job** (or a main-tree child\'s): the integrator runs the verification you declare when you integrate.',
  '- **Route** — pass **`isolation: "main"`** (an `orchestrate` task takes the same value) when the child must act on your REAL workspace: `git push`, an install or a build, merging, another repository, or a path outside this project. It then runs directly in your main working tree; integration is not involved. A default worker is hard-denied those actions. Keep the default isolated route whenever writers may run concurrently; for a SINGLE delegation with a clean tree and no parallel work, prefer `isolation: "main"` (no node_modules in the worktree, plus a mandatory integrate round-trip), and switch back the moment a second concurrent writer exists.',
  '- **Research child** (`subagent_research`): read-only, and cannot modify anything.',
  '',
  '## Work loop',
  '1. Frame: orient with a few targeted reads (and your read-only shell), then hand the deep investigation to research the moment you can already write the brief.',
  '2. Design: decide the approach and write it down before delegating. Name the file, the mechanism, the expected change, and the risks.',
  '3. Delegate: give each child a brief that carries your design — the deliverable, the approach, and the acceptance bar as an end state (never as a build command). It is self-contained (a child cannot see this conversation).',
  '4. Verify: when a child reports back, read the actual result with your own tools. Compare it against what you specified and against the original goal. Integrate only what you have checked.',
  '5. Decide: on any mismatch, name precisely what is wrong — wrong file, wrong approach, missing case, unverified claim — and delegate a corrective round. Sending the same request again is not a corrective round.',
  '',
  '## Acceptance',
  '- A child agent\'s self-report is never proof. "Done", "tests pass", "verified" are claims until you have looked.',
  '- Your own read-only inspection is the acceptance signal you control, so apply it to every deliverable.',
  '- If you cannot verify something yourself, say so explicitly instead of implying it is confirmed.',
  '- Model routing is locked by the mechanism; you neither need to nor can choose models for child agents.',
].join('\n')

/**
 * 指挥模式的三种生效形态。
 *
 * - `preset`：基准模式 `conductor`（官方 preset 目录，无 corum profile 实体）——主 Agent
 *   裁执行工具 + 追加指挥者角色段；**保留**部署人格（「你通过 Corum 桌面应用与用户交互」
 *   等信息是部署事实，基准模式不该抹掉）。
 * - `profile`：corum 自建 profile 的 `executionTools: 'orchestrator'`（2026-09-09 的旧
 *   入口，兼容既有用户数据）——主 Agent 裁执行工具；人格由该 profile 编译出的 preset
 *   自带（persona 行已替换部署人格），故这里**不**再追加角色段（否则两段人格重复）。
 * - `off`：普通模式。
 */
export type ConductorMode = 'off' | 'profile' | 'preset'

/**
 * 该 profile / preset 应按哪种指挥模式形态生效。
 * @param profileId - 本次会话的 profile / preset id。
 * @param isOfficialPreset - 该 id 是否为官方 preset（`loadProfile` 未命中）。
 * @param executionTools - corum profile 的执行工具策略（官方 preset 恒 undefined）。
 * @returns 生效形态（见 {@link ConductorMode}）。
 */
export function conductorModeOf(
  profileId: string,
  isOfficialPreset: boolean,
  executionTools?: 'full' | 'orchestrator',
): ConductorMode {
  if (executionTools === 'orchestrator') return 'profile'
  if (isOfficialPreset && profileId === CONDUCTOR_PRESET_ID) return 'preset'
  return 'off'
}

/**
 * 一个 corum profile 的**有效**执行工具策略——`baseMode: 'conductor'` 的角色的
 * 默认值就是 `orchestrator`（「继承指挥模式」= 工具面 + 指挥语义一起继承）。
 *
 * 显式声明优先：`executionTools: 'full'` 的角色即使 baseMode 是 conductor 也可亲手
 * 执行（工具面相同，语义由作者选择）；缺省时按 baseMode 推导。
 * @param profile - 只取 baseMode / executionTools 两个字段（避免与 AgentProfile 循环依赖）。
 * @returns 有效执行工具策略（`undefined` = 普通模式）。
 */
export function effectiveExecutionTools(
  profile: { baseMode: string; executionTools?: 'full' | 'orchestrator' },
): 'full' | 'orchestrator' | undefined {
  if (profile.executionTools !== undefined) return profile.executionTools
  return profile.baseMode === 'conductor' ? 'orchestrator' : undefined
}

/**
 * 指挥者角色段的段名（基准模式用：**追加**在部署人格之后，不覆盖部署人格）。
 *
 * 与 `deployment:persona` 分开是有意的：`deployment:persona` 承载部署事实（桌面应用交互
 * 方式、checkout 位置、模型/工作目录模板），基准模式必须保留；指挥者身份是**叠加的角色**。
 */
export const CONDUCTOR_SECTION = 'corum:conductor'
