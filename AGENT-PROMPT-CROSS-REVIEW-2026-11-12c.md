# 两条 prompt 交叉评审：语义不变精简方案 + MCP 注入机制确认

日期：2026-11-12（续 b 轮）
对象：standard / conductor 基准 preset 首轮 system prompt（逐字快照见 `docs/analysis/prompt-review-2026-11-12b/`）。
方法：corum-prose-standard 技能口径——保留全部命题（主体/动作/条件/时序/模态/负面保证/例外/所有权/副作用/失败/后果），只删重复、理据叙述与装饰；官方段受 fork-drift 字节守卫，不在可编辑范围。

## 0. 结论

1. **MCP 确认是直接注入，但大头不是 guidance**：每 server 三层成本——corum guidance 段（≤4KB，当前全部 server 合计仅 ~1KB）、官方 server instructions 段（≤32KB，当前 0）、**工具 schema（无上限，当前 2 个活跃 server ≈ 11KB 估算）**。全部从首轮就在，随 server 数线性增长；官方**没有**首轮 schema 懒加载机制（`deferLoading` 是会话中途新增工具的增量声明优化，不是这个）。你的担忧成立，且主要矛盾在工具描述。
2. **精简空间（语义不变）**：standard 23.6KB → ~20.5KB（**-13%**），conductor 30.2KB → ~25.9KB（**-14%**）。分两档：T1 纯去重（~1.5KB，零语义风险）+ T2 理据压缩（~1.7KB，逐条保全对照见 §B.4）+ conductor 人格段专项（~1.2KB）。**待你批准后实施**。

---

## A. MCP 注入机制（确认与量化）

### A.1 三层成本（每 server，全部首轮即在）

| 层 | 注册者 | 段名/位置 | 上限 | 当前实测 |
|---|---|---|---|---|
| corum guidance | `corum-mcp-manager/proxy.ts:340`（preset 代理行，按 profile 授权注入） | `corum:mcp-guidance:<server>`，order 960 | **4000 字符/server**（`mcp-guidance.ts:24`，超出截断） | cdp-router 931 字符 + pencil 140 字符 + 包装 ≈ **1.3KB** |
| 官方 server instructions | `dsh-mcp-client/lib/index.js:736`（`mcp:<server>` 段） | order 3100 | **32768 字节/server**（超出**拒连**，:656） | 0（两 server 均未提供 instructions） |
| 工具 schema | `dsh-mcp-client` 注册 `mcp__<server>__<tool>` → 请求 `tools` 数组 | 不在 system prompt 文本里，**但同样计输入 token** | **无上限** | 11 个工具 ≈ **11KB（估算）**：pencil `browser` 描述 ~3.4KB、`execute` ~1.1KB；cdp-router `cdp_run_script` ~2.2KB，其余 5 个 ~1KB |

- 注册表实测（`~/.corum/mcp-servers.json`，只读统计）：3 个 server（shared-mcp 无 guidance；pencil-mcp、cdp-router 活跃）。
- 本会话（2 个活跃 server）MCP 总增量 ≈ **12KB**，相对 standard 基线 23.6KB 约 **+50%**。
- 增长公式：`N server ≈ N×(guidance≤4KB + instructions≤32KB) + Σ工具schema`。**10 个 server 且各带十几工具时，首轮输入轻松 +50~100KB**——担忧成立。

### A.2 关键澄清：官方没有首轮懒加载

`deferLoading`（`dsh-system-prompt` 收集、`dsh-llm/lib/index.js:760-806` 消费）的真实语义：**会话中途新增**的工具以 developer message 增量声明一次，避免每轮重发整个 tools 数组（KV-cache 友好）。首轮就在的工具（MCP 全部如此）不走它；`dsh-mcp-client` 对 `deferLoading` 0 引用。**「工具用到才加载 schema」的机制目前不存在。**

### A.3 缓解选项（按成本排序）

1. **已有：按 profile 授权**——只有 `profile.mcpServers` 授权的 server 才注入（代理行粒度）。给不同角色配不同 MCP 子集是现成的控制面。
2. **server 侧瘦身工具描述**（零机制改动）：pencil `browser` 一个描述 3.4KB、cdp-router `cdp_run_script` 2.2KB——把 DSL 参考/示例移到 `read_skill` 类按需工具里，描述只留契约。cdp-router 是本仓技能自有服务，可直接改。
3. **guidance 已经很小且有 4KB 硬上限**，无需动作；注册表 guidance 为空则整段不注入（`mcp-guidance.ts:51`）。
4. **待实测**：research 子 Agent 的 MCP 工具被 deny（`compile.ts:642` mcpDenyNames），但 guidance 段注册在 preset scope——子 Agent 是否仍读到「用不了的 MCP」的 guidance？若是，属纯浪费，可在子组装侧门控。
5. **新机制（需设计，本轮不做）**：corum 侧「MCP schema 摘要 + 按需展开」或向上游提首轮懒加载。属产品决策。

---

## B. 交叉评审与精简方案

### B.1 段落清单（standard，23,629 字节；conductor = +人格段 -tool-policy -write/edit 段 = 30,169 字节）

| 段（prompt 行号） | 所有者 | ~字节 | 可精简 |
|---|---|---|---|
| harness-source (L1) / desktop-surface (L3) | desktop `index.ts` | 630 | 否（b 轮刚裁决保留） |
| persona 前缀 (L5) | preset 行（官方模板） | 60 | 否 |
| host-identity (L7-15) | corum-agent | 780 | 微（P1 矛盾是语义 bug，另案） |
| output-language (L17-22) | corum-agent | 1150 | **T2** |
| @ 路径引用 (L24) | 官方 file-reference | 380 | 否（fork-drift） |
| tool-policy (L26-44) | corum-agent | 1900 | **T2** |
| tool:bash exit-code (L46) | 官方 | 90 | 否 |
| execution-discipline (L49-64) | corum-orchestration | 4400 | **T2** |
| todo-discipline (L66-73) | corum-agent | 850 | **T2** |
| tool:read/write/edit/glob/grep/jobs/web/goal/ralph (L75-93) | 官方 | 2450 | 否 |
| subagent/fork/research 工具指导 (L95-107) | corum-tool-subagent | 1560 | **T1** |
| 编排机制段 (L109-158) | corum-tool-subagent | 7600 | **T1+T2** |
| 后台委派纪律 (L160-161) | corum-tool-subagent | 900 | **T1** |

conductor 另含 CONDUCTOR_PERSONA（conductor.ts，~7.9KB，order 1）——**T2 专项**。
注意：以上只是 section 文本；**工具 JSON schema 另计**（MCP 之外官方工具 schema 也有数 KB），不在本方案范围。

### B.2 冗余地图（交叉评审核心发现）

- **R1**：`subagent` 与 `subagent_fork` 的工具指导**逐字相同**（L95-99 = L101-105，~480B 纯重复）。
- **R2**：research 语义三处——工具指导 L107、最短路径 L112-116、隔离段 L133/L136。foreground-only/拒 background/read-only 沙箱说了两遍整。
- **R3**：background/foreground 语义三处——L95-99、L97-98、L160-161。「settlement notice」「foreground terminal」「send_message 只达 background」各重复。
- **R4**：conductor 人格「What a child can and cannot do」与机制段隔离 bullets（L131-138）重复隔离事实；人格段自己已声明「工具选择 follow 机制段」，却仍复述。
- **R5**：ralph 两处——官方 L93（不可动）+ corum L157-158，corum 侧可压缩到增量事实。
- **R6**：orchestrate「BLACK-BOX」(L146-149) 与「FINISHING AUTOMATIC」(L150-153) 互相重叠（closer 合并、ONE result 各说两遍）。

### B.3 T1：纯去重（~1.5KB，零语义风险——每条命题在相邻段仍有唯一全文）

**T1-1（R1）fork 工具指导** → 一行的默认 + 引用：
> Use subagent_fork in the background by default; its background/foreground and settlement semantics are identical to `subagent` above.

（原 5 行与 subagent 逐字同；命题由上方 6 行处的全文承担。）

**T1-2（R2）最短路径 research bullet** → 保留路由判据与示例，操作事实引用工具指导：
> - READ-ONLY work (research, search, fact-finding, summarization, judging by reading — checking an implementation against a spec, comparing output against expected values, or read-only commands like `git log` / `ls`) → `subagent_research` (semantics in its tool guidance above: foreground-only, read-only sandbox). One or two questions: call it directly. Several angles: send them in ONE message.

（L107 工具指导全文保留；L133/L136 的隔离段自有命题保留。）

**T1-3（R3）L160-161 合并** →
> A BACKGROUND subagent is NOT a job: there is no job id to poll and no `job_output` to read. Track it with `list_agents`, steer or follow up with `send_message`, ask it to stop with `interrupt_agent` (returns without waiting; its own children keep running), and act on its settlement notice when it arrives — keep doing useful work meanwhile. `send_message` reaches BACKGROUND (continuable) children only; a foreground one-shot child is terminal once it settles.

（「keep working」并入；list_agents/interrupt_agent 细节是增量，保留。）

**T1-4（R5）ralph corum 侧** →
> - Fresh-agent iteration toward ONE immutable objective → `ralph` (sequential, bounded rounds). Its children are created by their own engine: NO isolated worktrees, ledger entries or settlement notices, and nothing merges their work — use it for read-only audits or work that does not need merging; for parallel WRITES that need isolation + merge, use `orchestrate`.

**T1-5（R6）orchestrate 两 bullet 合并** →
> - **`orchestrate` is ONE BLACK-BOX CALL; FINISHING IS AUTOMATIC.** You start it; you get ONE final result: a closer node (dispatched by the mechanism, no parameter for it) collects every task output, does the finishing step, and reports back. The parallel children settle INTO THE MECHANISM, not to you: no per-child settlement notice, and you must NOT merge, integrate or finish their work while the call runs — wait for the call. What comes back: the closer's report plus one REFERENCE per task (index, label, ok/aborted, child session id, worktree/branch); full per-task outputs are NOT inlined — enter a child session for raw output. If any task ran in an isolated worktree, the closer merges those branches into your tree, runs the detected checks and commits; if every task ran in your main tree or was read-only research, it only summarizes (research becomes one consolidated report). You cannot opt out; you do not declare a verification command — the mechanism detects it from the repo. There is no `merge` parameter. NEVER delegate a main-tree write to an ISOLATED child and expect it to land: its writes stay in its worktree.

### B.4 T2：理据压缩（~1.7KB；每条删的都是叙述/理据，行为_clause_全留）

**T2-1 tool-policy（-450B）**：删「Why this matters here (not just style)」框架句与 re-read 两因的展开叙述，压缩为：
> Shell writes bypass the file-observation policy and reach change review as command-attributed changes; a per-file revert is only available when the write target was definitely parsed and the pre-image kept.
> When a dedicated tool rejects a call — "file has not been read" or "old_string was not found" — fix the call (read the file first, then retry with a more precise old_string); do not switch to the shell.
> After any successful edit, every anchor taken from before that edit is consumed: re-read the file before the next edit, and never resend an old_string a previous call already applied. "old_string was not found" means either the anchor never matched (wrong whitespace / stale text — re-read and use the exact text) or your own earlier edit consumed it (the common case with multiple edits to one file). If your intended new text is already present, the edit landed: stop, verify, move on.

保全对照：三工具映射+全部反例命令 ✓ bash 保留域 ✓ 审查后果+per-file revert 条件 ✓ 拒绝处理 ✓ 两因 ✓ 重读规则 ✓ landed 判据 ✓。删：框架句、「no matter how many times you retry」叙述。

**T2-2 execution-discipline 沙箱 child bullet（-150B）**：三结果/仓库拒/只读顶/隔离路径边界/终局性全留，删连接性叙述（「that refusal is not negotiable」「there is no card to wait for」等修辞），压缩为：
> - In a DELEGATED CHILD session the retry IS adjudicated, with exactly three outcomes: granted outright when it stays within what the delegating agent holds; otherwise put in front of the user; and **refused without any prompt** when the command targets the CURRENT repository (its other branches, worktrees, refs or shared `.git`) — a delegated child may READ that repository but never write outside its own worktree, and a session-wide "always allow" cannot lift that refusal. So retry with `sandbox_permissions` for anything OUTSIDE this repository (another repository, `/tmp`, a system path); for the current repository do not retry at all. Hard limits: a READ-ONLY scope can never widen (ceiling `read-only`); an ISOLATED scope may ask for a wider tier but its write boundary is by PATH — the parent tree, its other branches, worktrees, refs and shared `.git` stay read-only. A refusal is final for that command: report it as a conclusion in your final report instead of reworking around it or waiting for an approval that cannot come.

**T2-3 BUDGET bullet（-120B）**：删「That is the entire budget」与枚举框架，三件事+不可跑时的义务全留：
> - BUDGET YOUR OWN VERIFICATION. Self-checking means at most: (1) read your own diff, (2) run the repository guard ONCE in full **only if this session is allowed to build/test** (an isolated worker is not — that run belongs to the delegating agent), (3) at most 3 targeted checks on the riskiest points you touched. If your tools cannot run the guard (read-only shell, no shell, or a scope forbidding builds), you do not skip verification: check what you can read, and state plainly which checks you could not run and who owns them.

**T2-4 REPEATING bullet（-100B）**：
> - REPEATING A CHECK IS NOT VERIFICATION. Re-running the same check through another delegation from the same context reads the same code and produces no new evidence — spend the budget on your own diff and a few targeted checks. This is about re-running a check you already ran, not investigation: an independent `subagent_research` child reads the code in its own context and **is** valid evidence — broad investigation belongs with it.

**T2-5 todo-discipline（-180B）**：删尾部「Why: the list is the durable record…」整段（动机理据；L68-71 四条规则自身完整）。

**T2-6 output-language（-200B）**：L20 删「— the user must be able to read what you did without translating」；L21 删「(English is often stronger for some models)」；变量未设偏好回退值由整句复述改为「not specified」（规则已在 L18 全文）。⚠️ 回退值有单测断言言（output-language spec），实施时同步。

**T2-7 机制段 model-routing（-250B）**：删历史叙述「(a per-task model used to exist … deliberately removed)」，七 bullet 压成一段，全部禁令+三选项+读 notice 保留：
> - **Child model routing is NOT yours to choose.** Neither `subagent` nor `orchestrate` exposes a model parameter; in `orchestrate` SCRIPT mode the `agent()` options belong to the workflow engine — passing `provider`/`model` there is still routing a child, so do not. The child runs on the model the user configured for this Agent, or on your own route when unset. Never ask the user to pick a model; never route a child elsewhere. If a child's configured model is unavailable, the MECHANISM asks the user what to do (temporarily switch this session to your model, permanently change the child model, or stop delegating) and acts on the answer — you must not change any model or route yourself. Read the resulting notice: it tells you whether to re-issue the delegation or do the work yourself.

**T2-8 机制段 orchestrate 成本 bullets（-200B）**：N 成本与 ONE 收益全留，压成一句：
> - TWO OR MORE independent pieces of work → **ONE** `orchestrate` call, not N `subagent` calls: N delegations cost N tool calls, N settlement notices in your context, one isolation slot each (exceeding it FAILS the call), plus a manual `integrate` for writes; ONE orchestrate returns ONE final result and the mechanism merges, verifies and commits isolated work for you. Shortest path for: "split this into modules A/B/C"; "do these 4 migrations"; THREE OR MORE read-only angles at once (`research: true` tasks aggregate into a single result).

### B.5 conductor 人格段专项（-1.2KB）

**T2-9「What a child can and cannot do」（-700B）**：删两条「Observed in practice」事故叙述（规则本身保留）与交叉引用叙述，隔离事实不再复述机制段细节：
> ## What a child can and cannot do (write briefs that respect this)
> - **Worker** (`subagent`): ISOLATED by default and **cannot build or install** — no dependencies there, and build artifacts never merge back. Never put a build, a package install, or a whole-repo typecheck in a default brief as the acceptance bar: the child cannot satisfy it and will burn its budget or improvise. Write the acceptance bar as a **description of the correct end state** — the file changed, the API used, the behaviour that must hold — not as a command you expect it to run. **Landing and verifying is YOUR job** (or a main-tree child's): the integrator runs the verification you declare when you integrate.
> - **Route** — pass **`isolation: "main"`** (an `orchestrate` task takes the same value) when the child must act on your REAL workspace: `git push`, an install or a build, merging, another repository, or a path outside this project. It then runs directly in your main working tree; integration is not involved. A default worker is hard-denied those actions. Keep the default isolated route whenever writers may run concurrently; for a SINGLE delegation with a clean tree and no parallel work, prefer `isolation: "main"` (no node_modules in the worktree, plus a mandatory integrate round-trip), and switch back the moment a second concurrent writer exists.
> - **Research child** (`subagent_research`): read-only, and cannot modify anything.

保全对照：无构建验收禁令 ✓ 端态验收 ✓ landing 所有权 ✓ main 路由全部触发条件 ✓ hard-deny ✓ 并发规则 ✓ 单委派成本取舍 ✓ research 只读 ✓。删：两条事故叙述、成本维度框架重复。

**T2-10「Context」through-line 两句（-250B，borderline）**：删「Through-line: your own reading exists to frame…never to exhaust it」与「fifth file…brief two files ago」——命题已由三阶段规则（stop test / drift watch / 「working understanding, not a second investigation」）承担。**这是本方案唯一 borderline 项**：两句是具体触发器式修辞，若你判定它们有独立行为价值则保留。

### B.6 语义保全总清单

- 全部模态词（must/never/only/NOT）逐条保留；负面保证（拒 background、hard-deny、不可覆盖只读、终局拒绝）无 weakening。
- 全部条件/时序（注册时机、settlement、blank 限定、并发触发）保留。
- 删除物仅三类：逐字重复（R1-R6）、事故/历史叙述（Observed in practice / used to exist）、动机理据（Why 段、框架句）。
- **不动**：官方段（fork-drift 字节守卫）、host-identity P1 矛盾（语义 bug 另案）、b 轮刚裁决的桌面表面段、MCP guidance 包装（有语言守卫）。

### B.7 实施映射（批准后）

| 改动 | 源文件 | 受影响守卫/测试 |
|---|---|---|
| T1-1/2/3/4/5、T2-7/8 | `corum-tool-subagent/src/index.ts` | `prompt-discipline.spec.ts`、`tool-description-accuracy.spec.ts` |
| T2-1 | `corum-agent/src/tool-policy.ts` | tool-policy 相关 spec |
| T2-2/3/4 | `corum-orchestration/src/execution-discipline.ts` | execution-discipline spec |
| T2-5 | `corum-agent/src/todo-discipline.ts` | todo-discipline spec |
| T2-6 | `corum-agent/src/output-language.ts` | output-language spec（回退值断言同步） |
| T2-9/10 | `corum-agent/src/conductor.ts` | conductor spec |

流程：改源 → `build-all --changed` → 起 :9333 重跑 b 轮断言脚本（37 条）+ 新增「精简后关键 clause 仍在」断言 → 守卫 → 提交。预计 standard ~20.5KB / conductor ~25.9KB。

## C. 待批准

- **T1**（纯去重，~1.5KB）：建议直接做。
- **T2**（理据压缩，~1.7KB + conductor 1.2KB）：逐条保全对照已在 §B.4/B.5，建议做；T2-10 borderline 可单独剔除。
- **MCP**：A.3 选项 2（cdp-router 描述瘦身）可另开一轮；选项 4（research guidance 门控）待实测；选项 5 属产品决策。