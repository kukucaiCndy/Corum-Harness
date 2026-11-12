/**
 * fork（corum）：**执行纪律**两块文本的单一事实源（2026-09-27 从 corum-tool-subagent 下沉到此）。
 *
 * 为什么放本包：`corum-agent`（root scope 注册者）、`corum-tool-subagent`、`corum-subagent` 三方
 * 都已依赖 `@corum/corum-orchestration` ⇒ 不需要新的包间依赖，也不需要反向依赖。
 *
 * 投送（2026-09-27 用户要求「要注入」）：
 * · standard / ptc / cordis / conductor 与**所有子会话**：`corum-agent` 在 **root scope** 注册
 *   `corum:execution-discipline` 段（所有 corum 会话继承）；
 * · **minimal**：preset 是 `complete`（system-prompt 只渲染 persona 段）⇒ 段进不去，改由
 *   `compile.ts` 把这两块**追加进编译出的人格段**（同一对 builder）。
 */

/**
 * fork（corum）：bash / 委派效率纪律（机制段条目，**单一事实源**）。
 *
 * 抽成导出纯函数的原因（2026-09-14 委派正确性轮）：这段文本此前以字面量内联在
 * `systemPrompt.section` 回调里，只有「实机重启后读工具描述」才能验证它是否还
 * 与机制事实一致。抽出来后单测能直接断言内容与措辞纪律（`prompt-discipline.spec.ts`），
 * 提示词漂移变成可执行断言。
 *
 * 措辞纪律（用户 2026-09-14 定调）：只写**通用规则 + 机制理由**，英文、祈使、
 * 一句话说清「什么时候用、怎么用、什么时候不能用」；不写实测数字、不写具体
 * 端口/脚本名/会话、不假设某种使用模式；量化只允许机制常量（默认超时、上限、
 * 每次调用新 shell、stdin 忽略、后台句柄等）。
 * @returns 机制段的效率纪律行（含前置空行）。
 */
/** 段名（root scope 注册者与守卫共用；改名要同步 `prompt-discipline.spec.ts`）。 */
export const CORUM_EXECUTION_DISCIPLINE_SECTION = 'corum:execution-discipline'

/**
 * fork（corum）2026-09-27（对抗审查员 C 报：投送对了、**内容写错了工具面**）：
 * **极简模式专用**的执行纪律。
 *
 * 背景：极简模式的 preset 被裁到 `persona / tool-bash / filesystem / tool-fs` 四行
 * （`compile.ts` 的 minimal 分支），**没有** `grep`/`glob`（tool-fs-search）、**没有**
 * `job_output`/`job_kill`（tool-jobs），也没有任何子 Agent 工具。直接注入通用两块会把
 * 「不存在的工具」写进提示词 —— 指令与能力矛盾，本仓反复交手的那类病。
 *
 * 做法：沙箱块**整段复用**（工具无关）；效率块按**工具面**挑句，共享句子逐字复用，
 * 只有「读文件」那条需要一版不提 `grep`/`glob` 的改写。
 */
/**
 * fork（corum）2026-09-27（对抗审查员 C 报 4.3-9/10/11）：**纪律段按读者能力自适应**。
 *
 * 通用两块里有两处假定读者有全套工具：
 *   · 「Create and edit files with the `write`/`edit` tools」—— 指挥者（写工具被裁、`tool:write`/
 *     `tool:edit` 段在同一轮 apply 里被清空）与只读 researcher（write/edit 被 deny）都没有它们；
 *   · 裸工具名 —— PTC 读者的工具只能从 `run_code` 里调，需要与编排段同源的前缀。
 *
 * 做成纯函数（可单测）由注册处按 `context.scope` 的实际工具面求值 —— 不按模式硬编码。
 *
 * @param options.hasWriteTools - 该 scope 是否有 `write`/`edit`。
 * @param options.ptcPrefix - 与编排段同源的 PTC 前缀（无 `run_code` 时为空串）。
 * @returns 该读者该读到的完整纪律文本。
 */
export function corumExecutionDisciplineText(options: { readonly ptcPrefix: string }): string {
  // 2026-09-27：改为**文本层条件句**（不再读 ctx.tools）——运行时读工具面会在未声明 inject 的
  // 插件上下文里抛 `cannot get property "tools" without inject`（实机抓到过一次，红线 #4）。
  // 条件句达到同样目的：没有 write/edit 的读者（指挥者、只读 researcher）不会被要求用不存在的工具。
  return options.ptcPrefix + [...corumEfficiencyDisciplineLines(), ...corumSandboxEscalationLines()].join('\n')
}

export function corumMinimalDisciplineLines(): string[] {
  const keep = (line: string): boolean =>
    line === 'EFFICIENCY DISCIPLINE:'
    || line.startsWith('- KNOW YOUR SHELL')
    || line.startsWith('- KEEP EACH COMMAND ON ONE LINE')
    || line.startsWith('- EVERY CALL GETS A FRESH SHELL')
    || line.startsWith('- REPORT SCOPE')
  const readRule = '- READ FILES WITH `read`, NOT THE SHELL. Open a file with `read` (the whole file, or an offset/limit window) — never `cat` / `head` / `tail` / `sed -n` / `awk`. This includes logs and PID files. The shell is for a live stream you must follow (`tail -f`) or for text you pipe.'
  return [
    '',
    ...corumEfficiencyDisciplineLines().flatMap(
      line => line === 'EFFICIENCY DISCIPLINE:' ? [line, readRule] : keep(line) ? [line] : [],
    ),
    ...corumSandboxEscalationLines(),
  ]
}

export function corumEfficiencyDisciplineLines(): string[] {
  return [
    '',
    'EFFICIENCY DISCIPLINE:',
    '- MERGE SMALL QUERIES. Batch the searches you need into as few calls as possible — one `grep` over a whole directory beats one call per file, and `glob` finds files without reading them: every extra call costs a full model round-trip.',
    // 2026-09-27 跨块一致性修复（用户发现子 Agent 用 grep 当读）：旧文案把 `grep`/`sed`/`nl`/`awk`/`head`
    // 的「提取」打包成一种省轮次的读法，与 root scope 的 `corum:tool-policy`（"Read files with `read` —
    // not `cat` / `head` / `tail` / `sed -n` / `less`"）**极性相反** ⇒ 子 Agent 拿两个块，选省轮次的那个。
    // 现在口径唯一：`grep` 定位、`read` 解释。
    // 2026-09-27 P9 去重：读法规则（read vs shell）**唯一家 = corum:tool-policy**（root scope），
    // 此处不再复述；指挥者会清空那一层，故它的**人格段**自带同口径（见 conductor.ts）；
    // minimal 是 complete（读不到 tool-policy），故其变体保留自己那条（见 corumMinimalDisciplineLines）。
    '- KNOW YOUR SHELL. The bash tool runs one command per call, non-interactively with stdin ignored, so a bare `grep foo` returns immediately instead of waiting for input. Commands are time-boxed — 60s by default; pass `timeoutMs` (up to 600000) for longer runs. If this session has the `write`/`edit` tools, create and edit files with them rather than shell redirection or in-place editors: they keep quoting under control and land in the change-review trail.',
    '- KEEP EACH COMMAND ON ONE LINE, statements joined with `;` or `&&`, so that a loosely delimited fragment cannot do something other than what you intended.',
    '- EVERY CALL GETS A FRESH SHELL. No cwd, variable or function persists between calls, so never rely on a `cd` from an earlier call: chain `cd <dir> && <cmd>` inside one call, or pass `workdir`.',
    '- PUT LONG-RUNNING OR NOT-YET-NEEDED COMMANDS IN THE BACKGROUND. A server, a watcher, a long build or a long test suite belongs behind `run_in_background: true`, so the call returns a handle at once and the conversation is not blocked; read or stop that handle with the job tools. Never replace that handle with "wait a moment, then look again". Do not background a command whose result you need before the next step; do not background an operation that would stop or restart the runtime this session depends on; do not start a background process whose output cannot be retrieved.',
    // fork（corum）2026-09-20 修正（用户报障，见 docs/PENDING-conductor-...md §D1/D2）：
    //
    // 本段**同时注入主会话与子会话**（preset scope 共享），但原文两处假设了「读者能跑构建」：
    //   D1 「run the repo guard ONCE in full」—— 指挥模式的主 Agent **被裁掉了写工具、
    //       shell 也只读**，它物理上跑不了仓库守卫；实测该指令与人格段「you cannot edit
    //       files」直接矛盾（指令与能力不符，与 worker 那次「你没有写工具 vs 工具表里有
    //       write」是同一类病）。
    //   D2 「a child ... cannot produce independent evidence」—— 对**重复同一个校验**成立，
    //       但对 `subagent_research` 不成立：它有独立上下文、自己读代码，**能**产生独立
    //       证据。原措辞会抵消「把广域调研委派出去」的引导（用户 2026-09-20 定的三阶段）。
    //
    // 修法：D1 改为**按能力表述**（能跑命令的读者才跑守卫；跑不了的读者读报告 + 点读 diff，
    // 验证归委派方），D2 收窄到「重复同一校验」并明确 research 的独立调查**是**有效证据。
    '- BUDGET YOUR OWN VERIFICATION. Self-checking means at most: (1) read your own diff, (2) run the repository guard ONCE in full **only if this session is allowed to build/test** (an isolated worker is not — that run belongs to the delegating agent), (3) at most 3 targeted checks on the riskiest points you touched. If your tools cannot run the guard (read-only shell, no shell, or a scope forbidding builds), you do not skip verification: check what you can read, and state plainly which checks you could not run and who owns them.',
    '- REPEATING A CHECK IS NOT VERIFICATION. Re-running the same check through another delegation from the same context reads the same code and produces no new evidence — spend the budget on your own diff and a few targeted checks. This is about re-running a check you already ran, not investigation: an independent `subagent_research` child reads the code in its own context and **is** valid evidence — broad investigation belongs with it.',
    '- REPORT SCOPE. State how many steps and how many tool calls the run took, so the cost and the progress of the work are legible to whoever reads the result.',
  ]
}

/**
 * fork（corum）：沙箱拒绝 → 一次升级 → 由用户裁决（机制段条目，单一事实源）。
 *
 * 这段文本同时注入主会话与子会话（preset scope 共享，子 Agent 经
 * `agentPresets.composeFrom` 继承父的 preset scope 段），所以弹窗承诺必须双分岔：
 * 主会话的审批策略是 `ask`（弹窗真实存在），子会话的审批策略钉死为 `never`
 * （`corum-subagent/src/child-agent.ts` 的 `captureDelegatedPolicyOverrides`）。
 *
 * ⚠️ 2026-09-27 更正：早期文本说子会话的 `approvalPolicy` 钉死为 `'never'`、「拿不到可审批通路」——
 * 那条依据已过时：2026-09-26 为放行提权通路，子会话改为按父策略播种（`'ask'`），并配了升级应答器。
 * 现在的三种结局是：落在委派方所持范围内 ⇒ 直接批准；否则 ⇒ 交给用户；**目标为本仓库 ⇒ 直接拒、不出卡**。
 * 措辞纪律同 {@link corumEfficiencyDisciplineLines}。
 * @returns 机制段的沙箱升级行（含前置空行）。
 */
export function corumSandboxEscalationLines(): string[] {
  return [
    '',
    'SANDBOX DENIALS AND ESCALATION:',
    '- A blocked file operation reports a `[sandbox: file access denied under <mode> mode]` marker. That is a policy decision, not a failure of the command: read the marker instead of assuming the denial.',
    '- When a wider mode would let the command succeed, retry the exact same command once, in the same turn, with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. In a session whose approval policy is `ask` that retry raises the approval prompt, and the user\'s answer to it is the consent — do not detour through chat to ask first.',
    // 2026-11-12c T2-2：三结果 / 仓库拒 / 只读顶 / 隔离路径边界 / 终局性全留，删连接性叙述
    //（「that refusal is not negotiable」「there is no card to wait for」等修辞）。
    '- In a DELEGATED CHILD session the retry IS adjudicated, with exactly three outcomes: granted outright when it stays within what the delegating agent holds; otherwise put in front of the user; and **refused without any prompt** when the command targets the CURRENT repository (its other branches, worktrees, refs or shared `.git`) — a delegated child may READ that repository but never write outside its own worktree, and a session-wide "always allow" cannot lift that refusal. So retry with `sandbox_permissions` for anything OUTSIDE this repository (another repository, `/tmp`, a system path); for the current repository do not retry at all. Hard limits: a READ-ONLY scope can never widen (ceiling `read-only`); an ISOLATED scope may ask for a wider tier but its write boundary is by PATH — the parent tree, its other branches, worktrees, refs and shared `.git` stay read-only. A refusal is final for that command: report it as a conclusion in your final report instead of reworking around it or waiting for an approval that cannot come.',
    '- Escalate only from a real denial, never speculatively. If the session states that approval prompts are disabled, a denial is final: do not set `sandbox_permissions`.',
    '- A rejected escalation is final for that command: stop and explain it instead of working around it. It does not forbid attempting or escalating other commands later.',
  ]
}
