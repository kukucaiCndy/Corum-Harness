# Agent 地基差距分析与补齐路线

> corum IDE「Agent 驱动项目管理平台」启动前的地基评估。
> 结论：DSH 的 Agent 设施比预期扎实，且 **PRD §7.4 担心的"权限身份注入需改造 DSH 核心"已由官方解决，可撤销**。真正的差异化定制集中在三块——领域事件词汇、任务驱动调度器、平级协作通道——且**全部可落在 `@corum/project-core` 插件内，不改官方内核**。
> 版本：v0.2 · 状态：待评审
> 依据：DSH 源码盘点（`/Users/kukucai/dsh`，rc.2）+ [PRD v0.6](../PRD-project-management.md)

---

## 0. 为什么先做这份分析

如果直接按 P0 砸数据层（`ctx.project`），做到一半会发现 DSH 现有 Agent 设施撑不起「**团队上下文如何流转、能否自动执行降低人工、不同角色处理任务的平级关系**」，被迫回头返工。**先把 Agent 地基摸清、补牢，才是真的地基。**

本文盘点了 DSH 现有 Agent 能力，定位三个关键缺口，并给出补齐路线。

---

## 1. DSH Agent 能力盘点（源码依据）

### 1.1 会话模型 —— ✅ 完全满足

- **Agent = 事件溯源 Session**：append-only 日志是唯一事实源，LLM 消息历史是派生物。
- **干活模型 = inbox 队列**：`AgentHandle.followup()`（排队并唤醒新 turn）/ `steer()`（下一步边界插入）/ `inject()`（非唤醒注入），三者均为 `AgentHandle` 方法（`packages/core/agent/src/runtime-types.ts`）。
- **生命周期**：`ctx.agents.create()/resume()` 创建与冷恢复（`packages/core/agent/src/index.ts`）；`ctx.sessions.fork(source, boundary?, childSessionId?)` 切前缀带子代 lineage（`packages/core/session/src/index.ts`）；`AgentHandle.cancel()/dispose()` 结束。
- **源码**：`packages/core/agent/src/{dispatch,inbox,types,runtime-types}.ts`、`packages/core/session/`、`packages/core/agent-loop/`。
- **对项目管理**：会话即 Agent 成员的工作台账，天然可持久化、可恢复、可审计。

### 1.2 子智能体（subagent）—— ✅ 基本满足（一个关键坑）

- **continuable child（持续子代）**：一个持久 Session + 至多一个进程内 Activation，inbox 唯一 FIFO，`followup()` 冷/热追加任务，结算自动向父代发 notice。**「一个 Agent 成员长期存活、持续接任务」正是它的设计目标。**
- **能力位（capability）**：`persona`（每子代人设）、`toolFilter`（工具收权）、`depthLimit`（委派深度上限，对应 `AgentOptions.subagentDepth` 声明 + 持久 `SessionHeader.delegationDepth` 单调只增）、`outputSchema`（结构化结果）。
- **委派边界**：子代权限钉死（sandbox override 快照 + approval 钉 `never`），见 `captureDelegatedPolicyOverrides` / `appendDelegatedPolicyOverrides`。
- **源码**：`packages/subagent/subagent/README.md`、`packages/subagent/subagent/src/`。
- **坑**：① Activation **进程内居住**（README "Process-local residency"），崩溃可能丢"已接受未落盘"消息；② followup **不能 steer 正在跑的 turn**（"Continuation messages never steer"）；③ **宿主用户无法直接给持续子代派任务**（官方 Known Limitation "No host-user continuation"：`followup()` 要求 exact live direct parent，仅 `interrupt()` 接受 durable parent-address user authority）——"PM Agent 常驻、人直接派活"需补适配层。

### 1.3 工具调用体系 —— ✅ 满足

- `ctx.tools.register()` 注册；执行管线 `tools/pre-execute`（waterfall）→ **guard 单调守卫**（`tools.guard()` 注册，`guardReason()` 在 pre-execute 后执行）→ `tools/execute`（around-dispatch）→ `tools/post-execute` → `tools/result`。
- **`ToolExecution.agent` 由 agent loop 注入可信身份**（同进程不可伪造），scope 路由键按 agent 精确过滤分发。
- 读写外部：内置 `tool-fs` / `tool-bash` / `tool-web` / `tool-lsp` / `tool-jobs`，MCP 可接任意系统。
- **源码**：`packages/core/tools/src/`、`packages/core/scope/`。
- **坑**：`tools.restrict()`（限制继承可见面）/ `tools.guard()`（单调守卫）是可见性组合而非安全边界（官方明示 "security and authority are non-goals"）。

### 1.4 Agent preset / persona —— ✅ 满足

- **preset** = 目录 + `agent.cordis.yml`，三层解析（agent → preset → global，经 `dsh-scope` parent chain）。**角色定制 = 一个 preset（persona 文案 + 工具集 + prompt sections），完全声明式。**
- **persona** 是 preset 里一行插件：`text` 模板遮蔽部署 persona，`complete:true` 可独占 system prompt（组装后恢复为该唯一段落）；rc.2 新增 `includeRuntimeContext: false`（此作用域上下文提供方不求值）。
- **源码**：`packages/preset/agent-presets/`、`packages/preset/persona/`、`packages/core/system-prompt/`。
- **坑**：官方提供 `ctx.agentPresets.recompose(agentCtx, id)` 重链 preset，但**"Valid only while the agent has produced nothing — the caller owns that check"**（仅 Agent 未产出内容时有效，且由调用者自行保证）；角色能力集创建时钉死，运行中扩权需重开会话。

### 1.5 上下文注入 —— ✅ 满足

- 装配管线是 `system-prompt/assemble` 事件（waterfall，`Scoped<SystemPrompt>`）：sections + tools + variables + 动态 runtime-context。
- 运行时通道：`agent.inject()`、工具结果 `deferContext()`、`agent/pre-step` waterfall。
- **结构化传递走 `user/message` 的 `source` 字段**（持久 provenance）或自定义 merge 进 `SessionEventMap`。
- **源码**：`packages/core/system-prompt/src/index.ts`、`packages/core/agent/src/inbox.ts`。

### 1.6 自动化与触发 —— ⚠️ 部分满足

- **`@deepseek-ai/dsh-schedule`**：会话内持久提醒（`after`/`at`/`every` 三种），到期 `agent.followup()` 唤醒 Agent——**现成的"定时自动执行"机制**。delivery 是 `session-local`：仅会话 live 时准时触发，否则 overdue 到下次 resume。
- 事件驱动面：`agent/*` / `session/event` / `subagent/start|end` / `goal/changed` 全是可订阅 cordis 事件。
- **坑**：① schedule 只挂 live root Agent（`ctx.agents.roots()`），冷 Agent 到期任务要等下次变活才补发；② **没有"新任务进队列就自动唤起对应角色 Agent"的领域触发器**；③ 无外部 webhook/队列入口。

### 1.7 多 Agent 协作 —— ⚠️ 部分满足（最大缺口）

- **原生只有层级委派**：父→子 `followup()` 派任务、子→父 `reportFrom()` 汇报、结算 notice、祖先 `interrupt()` 后代（均经 `ctx.subagents` seam，见 `packages/subagent/subagent/README.md`）。
- **官方明示缺口**（`packages/core/agent/README.md` "Known Limitations and Deferred Work"）："Inter-agent channels beyond delegation — shared state, streaming child output, and background/poll semantics remain outside the current synchronous `ctx.subagents` seam."。**平级 Agent 互为不可见节点。**

### 1.8 权限与身份 —— ⚠️ 部分满足

- 可信身份链：loop 在 `ToolExecution.agent` 注入 Agent 对象；scope 按 agent 精确过滤。
- "不同 Agent 不同权限"三条腿：preset 工具集隔离 + `toolFilter` 收权 + 子代 approval 钉 `never`。
- **坑**：① `identity/` 只有匿名遥测 id（`@deepseek-ai/dsh-anonymous-user-id`，per-harness-home 随机 UUID），**无认证账户体系**；② scope 是组合机制非安全边界，权限须在**创建时**钉死，运行中不可动态收权。

### 1.9 满足度总评 + 撤销 PRD §7.4 的"改造核心"顾虑

**PRD §7.4 曾担心**：权限网关要成立，role 必须由服务端从 sessionId 反查、严禁模型自报，这"要求 DSH 核心在 ToolExecution 管线可信注入调用者身份——属于对 DSH 核心的改造"。

**核对结论：该能力官方已完整提供，顾虑可撤销。** 证据链：

1. `ToolExecution.agent` 是 `readonly agent?: Agent`，注释明写 "set by the agent loop"（[`packages/core/tools/src/index.ts`](/Users/kukucai/dsh/packages/core/tools/src/index.ts)）。
2. 模型无法自报：`agentEvents` 的 fused dispatcher 用 `({ ...payload, agent })` 强制注入，payload 里即使带 `agent` 字段也被覆盖（"callers pass PayloadRest, so the `agent` field can never override the injected subject"）。
3. `ctx.agents.get(sessionId)` 反查 live Agent，`ctx.agents.roots()` 列 root，`agent.ctx` 是 agent-scoped context。

**因此 PRD 的权限网关 `resolveCaller(sessionId)` 可零改造实现**：写工具经 `tools/execute`（或 `tools/guard()`）拿到 `exec.agent` → 按 `agent.id`（即 sessionId）反查 RoleBinding → 判定角色。不再是悬案。

**逐项满足度对照（PRD 需求 → 官方能力）**：

| PRD 需求 | 官方能力 | 判定 |
|---|---|---|
| 角色 = preset（persona + 工具集） | `dsh-agent-presets` + `dsh-persona`（`complete`/`includeRuntimeContext`） | ✅ |
| 团队成员 = continuable child | `ctx.subagents.startContinuable()` + `followup` + `listChildren/listDescendants` | ✅（见 §1.2 坑） |
| 权限网关（role 反查） | `ToolExecution.agent` 可信注入 + `ctx.agents.get` | ✅ **PRD 低估了** |
| 工具收权 | `toolFilter` + `tools.restrict()`/`tools.guard()` | ✅ |
| 状态自动回流（任务驱动） | `agent/*`、`session/event` + `followup` | ⚠️ 缺"领域触发器" |
| 平级协作（Dev↔QA） | 只有父子树，`core/agent/README.md` 明示缺口 | ❌ **最大缺口** |

---

## 2. 三个关键缺口（用户提的核心问题）

### 缺口①：团队上下文如何流转？→ 可建，但缺"领域事件词汇"

- **地基在**：事件溯源 Session + `source` provenance + fork/report 通道，结构化流转的载体已存在。
- **缺口**：「任务卡 / 需求 / 验收 / BUG / 版本」这类**项目管理领域事件类型没有**，DSH 不认识它们。
- **要补**：一套**项目管理领域事件词汇**（declare-merge 进 `SessionEventMap`），让"需求提交、任务指派、状态流转、BUG 上报、验收"成为可被流转、订阅、审计的一等事件。

### 缺口②：能否自动执行、降低人工？→ 半可建，缺"任务驱动调度器"

- **底座在**：`@deepseek-ai/dsh-schedule` 定时唤醒 + `followup()` + 丰富事件订阅。
- **缺口**：**没有"新任务进队列就自动唤起对应角色 Agent"的领域触发器**；冷 Agent 无法被主动唤醒（要等它下次变活）。
- **要补**：一个**任务驱动的 Agent 唤起调度器**——监听项目数据变化（新任务/待裁决/待验收）→ 找到对应角色 Agent 成员 → `followup()` 唤起它干活。这是"降低人工"的核心：让 Agent 被任务驱动，而不是被人逐个喂。

### 缺口③：不同角色处理任务的平级关系能否保证？→ 最大缺口，需自建通道

- **现状**：协作图是严格**父子树**（父派任务、子汇报），**平级 Agent（研发 ↔ 测试）互为不可见节点**，无原生通信。
- **要补**：**平级协作通道**。两条可行路径——
  - **路径 A：共享黑板（推荐）**——以 Session 事件日志 + `ctx.project` 数据层为共享黑板，平级 Agent 通过"读写共享项目数据 + 订阅领域事件"间接协作（研发改任务状态 → 测试订阅到事件被唤起验收）。**这与 project-core 数据层天然统一，是主路径。**
  - **路径 B：项目根 Agent 中转**——造一个"项目"根 Agent 作为公共父代，所有角色 Agent 是它的子代，平级通信经根 Agent 中转。作为补充/兜底。

---

## 3. 关键坑（影响架构决策，必须知晓）

| 坑 | 影响 | 对策 |
|---|---|---|
| **Activation 进程内居住** | 崩溃丢"已接受未落盘"消息 | 持久化勤 flush；关键状态落盘后再确认 |
| **continuable followup 不能 steer 当前 turn** | 不能打断执行中的 Agent | 任务设计为可中断粒度；用 `interrupt()` 而非 steer |
| **preset 产内容后不可换**（官方 `recompose()` 仅未产出内容时有效） | 角色能力集创建时钉死 | 角色 preset 设计一次到位；运行中扩权重开会话 |
| **宿主用户无法直接派任务给持续子代** | "PM 常驻、人直接派活"受阻 | 补宿主适配层（人在看板/对话派活 → 平台转 followup） |
| **approval ask 在委派子代钉死 deny** | 子代无法向人发起确认 | 无人值守场景反而对；需确认的动作上抛父代 |
| **scope 非安全边界** | 权限可被运行中绕过 | 权限在创建时 toolFilter 钉死 + 服务端网关兜底 |

---

## 4. 补齐路线（在 `@corum/project-core` 中一并设计）

> 三个缺口正好就是"团队上下文流转"的核心。**它们不是独立插件，而是 `project-core` 数据层的有机组成**——补上它们，P0 数据层才有意义。

### 4.1 领域事件词汇（补缺口①）

- 在 `project-core` 定义项目管理领域事件（declare-merge `SessionEventMap` + 事件总线）：
  `requirement.submitted / task.created / task.assigned / task.status-changed / bug.reported / bug.status-changed / release.submitted / requirement.finished / …`
- 每个事件携带 `{ entityType, entityId, actor(memberId/role), at, payload }`，落审计日志，可被订阅。

### 4.2 任务驱动调度器（补缺口②）

> ⚠️ **细化阶段新发现（v0.2）**：本节原方案"调度器监听领域事件 → `followup()` 唤起角色 Agent"存在**官方 authority 硬约束**，需重新权衡，见下方。

- 一个 cordis 插件，监听 `project-core` 的领域事件 + `ctx.project` 数据变化：
  - 新任务创建/被指派 → 唤起对应角色 Agent（`followup`）
  - 任务进 `dev_done` → 唤起 PM Agent 裁决
  - BUG 进 `pending_verify` → 唤起 QA Agent 验收
  - 需求 `readyToFinish` → 唤起 PM Agent 判结束
- 处理冷 Agent：标记待办，Agent 下次激活时补发（复用 schedule 的补发语义）。
- 宿主派活适配层：人在看板/对话派任务 → 平台转为对对应 Agent 的 `followup()`。

**⚠ authority 硬约束（决定调度器形态，待用户拍板）**：

官方 `ctx.subagents.followup(parent, childId, ...)` 的 `parent` 必须是 **exact live direct parent**（`continuation.ts` 直接 `if (parentSession !== parent.id) throw UNAUTHORIZED`）；`reportFrom` 同理要求 exact live direct child；只有 `interrupt()` 接受 `{ kind: 'user', parentSessionId }` 的"人"authority，但 interrupt 只打断不派活。**一个独立的"调度器插件"既不是任何角色子代的 direct parent、也不是 user，没有合法 authority 去 followup 角色 Agent。**

三条候选路线（待评审）：

1. **项目根 Agent 中转（推荐倾向）**：引入常驻"项目根 Agent"作公共父代，所有角色 Agent 是它的 continuable child；调度逻辑内嵌根 Agent（或由其宿主适配层执行 followup）。完全符合官方 authority 模型，顺带解决缺口③平级协作；代价是引入常驻根 Agent 单点。
2. **事件注入 + 角色自拉取**：调度器不唤活，只把"新任务/待验收"写进共享待办队列，角色 Agent 靠 `dsh-schedule` 定时或轮询自己醒来拉取。纯插件、最简，但退化成定时轮询，弱化"任务驱动即时唤活"。
3. **改造 authority（违反红线）**：给 subagent seam 加"系统调度器"authority。官方 README 明示 deferred（"a future host adapter needs a concrete authenticated interaction before the seam gains a user delivery capability"），**需改官方内核，违背 corum 红线，不推荐**。

> 状态：待用户拍板，暂不定。

### 4.3 平级协作通道（补缺口③，走共享黑板）

- 主路径：**`ctx.project` 数据层即共享黑板**。平级 Agent 不直接通信，而是：
  - 研发 Agent 改任务/修 BUG（写 project 数据 + 发领域事件）
  - 测试 Agent 订阅领域事件被唤起，读共享数据验收
- 补路径：项目根 Agent 作为公共父代中转（P1，复杂协调场景）。
- 权限：平级写共享数据时仍过权限网关（§PRD 4.2），研发不能替测试关 BUG。

### 4.4 角色运行时（连接三层模型与 Agent 设施）

- AgentProfile（§PRD 4.0.2）→ 编译为 dsh preset（persona 文案 + toolFilter + prompt sections）。
- TeamMember（§PRD 4.0）→ spawn continuable child，绑定 profile 编译的 preset。
- 权限：role 经 toolFilter 在创建时钉死 + project-core 权限网关服务端兜底（呼应"role 不可模型自报"）。

---

## 4.5 细化阶段疑点澄清（v0.2 新增，待评审）

> 深入核对官方 subagent seam 后，澄清三个影响架构的关键事实，其中两个是**正面发现**（官方已提供扩展点），一个是**需要用户拍板的硬约束**。

### 疑点 1：角色能力位映射的缺口（正面发现，官方有扩展点）

官方 continuable child 的 composition（[`child-agent.ts`](/Users/kukucai/dsh/packages/subagent/subagent/src/child-agent.ts)）只有 **`persona`(string) + `toolFilter`(ToolRestriction)** 两个能力位，加上 `agentOptions.model`。而 PRD §4.0.2 的 AgentProfile 有 `prompt/model/skills/mcpServers/terminal/memoryPolicy` 六个。

**官方提供的正式扩展点**：`ctx.subagents.registerContinuableSetup(contribution: (childCtx) => () => void)`（[`activation-setup-registry.ts`](/Users/kukucai/dsh/packages/subagent/subagent/src/activation-setup-registry.ts)）——部署可在每个 continuable child 的 unpublished 创建窗口同步注入**任意 child-scoped 能力**，返回 disposer 随 child 生命周期回收。

**结论**：`persona` + `toolFilter` 由官方 `startContinuable` 直接提供；`skills`/`mcpServers`/`terminal`/`memoryPolicy` 由 corum 通过 `registerContinuableSetup` 注册一个贡献函数注入。**全部不改内核。** 这使"角色 = AgentProfile → continuable child"的映射可完整落地。

### 疑点 2：权限网关的 role 反查（正面发现，PRD 顾虑已撤销）

见 §1.9。`ToolExecution.agent` 可信注入 + `ctx.agents.get(sessionId)`，权限网关 `resolveCaller(sessionId)` 零改造实现。

### 疑点 3：任务驱动调度器的 authority 硬约束（需拍板）

见 §4.2。`followup` 仅限 exact live direct parent，独立调度器插件无合法 authority。三条路线待用户拍板（项目根 Agent 中转 / 事件注入+自拉取 / 改造 authority 违反红线）。

---

## 5. 修订后的推进顺序（替代原"先砸 P0 数据层"）

```
第 0 步：Agent 地基（本文）
  → 领域事件词汇 + 任务驱动调度器 + 平级协作通道(共享黑板) + 角色运行时
  → 都在 @corum/project-core 内设计
  ↓
第 1 步：数据层（ctx.project + schema + 存储 + 权限网关）
  → 与领域事件词汇一体成型
  ↓
第 2 步：Agent 工具 + 角色 Agent 接入
  → Agent 通过工具读写项目数据，调度器唤起角色 Agent
  ↓
第 3 步：UI（区域切换 + 看板视图）
  ↓
第 4 步：团队/角色管理界面（AgentProfile 编辑、团队成员管理）
```

**核心转变**：数据层（`ctx.project`）不再是孤立的第一步，而是与"领域事件词汇 + 共享黑板"**一体设计**——因为它既要存项目数据，又要当平级 Agent 的协作黑板，还要发领域事件驱动调度。三件事是同一块地基的三个面。

---

## 6. 结论

DSH 的 Agent 设施（会话/子智能体/工具/preset/上下文/可信身份注入）**地基扎实**，足以支撑项目管理平台。且 **PRD §7.4 担心的"权限身份注入需改造 DSH 核心"已被官方解决，可撤销**——`ToolExecution.agent` 由 agent loop 可信注入、模型无法自报，权限网关可零改造实现。

真正的缺口集中在三处——**领域事件词汇、任务驱动调度器、平级协作通道**——它们共同构成"团队上下文流转"的核心，且都应长在 `@corum/project-core` 数据层里一体设计。

**红线守得住**：三个缺口全部可落在 `@corum/project-core` 插件内（扩展 `SessionEventMap` + 纯 cordis 事件监听 + 共享黑板），**不 fork、不改官方 Agent 内核**——这与 corum"发行版只做用户空间"的定位一致。

**先补 Agent 地基，再建数据层，方向与你的判断一致。**
