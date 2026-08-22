# Agent 地基差距分析与补齐路线

> corum IDE「Agent 驱动项目管理平台」启动前的地基评估。
> 结论：DSH 的 Agent 设施比预期扎实，但有三个关键缺口必须在 P0 数据层之前先设计补齐——它们正是"团队上下文流转"的核心。
> 版本：v0.1 · 状态：待评审
> 依据：DSH 源码盘点（`/Users/kukucai/dsh`）+ [PRD v0.6](./PRD-project-management.md)

---

## 0. 为什么先做这份分析

如果直接按 P0 砸数据层（`ctx.project`），做到一半会发现 DSH 现有 Agent 设施撑不起「**团队上下文如何流转、能否自动执行降低人工、不同角色处理任务的平级关系**」，被迫回头返工。**先把 Agent 地基摸清、补牢，才是真的地基。**

本文盘点了 DSH 现有 Agent 能力，定位三个关键缺口，并给出补齐路线。

---

## 1. DSH Agent 能力盘点（源码依据）

### 1.1 会话模型 —— ✅ 完全满足

- **Agent = 事件溯源 Session**：append-only 日志是唯一事实源，LLM 消息历史是派生物。
- **干活模型 = inbox 队列**：`followup()`（排队并唤醒新 turn）/ `steer()`（下一步边界插入）/ `inject()`（非唤醒注入）。
- **生命周期**：`ctx.agents.create()/resume()` 创建与冷恢复；`fork()` 切前缀带子代 lineage；`cancel()/dispose()` 结束。
- **源码**：`packages/core/agent/src/{dispatch,inbox,types}.ts`、`packages/core/session/`、`packages/core/agent-loop/`。
- **对项目管理**：会话即 Agent 成员的工作台账，天然可持久化、可恢复、可审计。

### 1.2 子智能体（subagent）—— ✅ 基本满足（一个关键坑）

- **continuable child（持续子代）**：一个持久 Session + 至多一个进程内 Activation，inbox 唯一 FIFO，`followup()` 冷/热追加任务，结算自动向父代发 notice。**「一个 Agent 成员长期存活、持续接任务」正是它的设计目标。**
- **能力位**：`persona`（每子代人设）、`toolFilter`（工具收权）、`maxDepth`（单调只增）、`outputSchema`。
- **委派边界**：子代权限钉死（sandbox override 快照 + approval 钉 `never`）。
- **源码**：`packages/subagent/subagent/README.md`。
- **坑**：① Activation **进程内居住**，崩溃可能丢"已接受未落盘"消息；② followup **不能 steer 正在跑的 turn**；③ **宿主用户无法直接给持续子代派任务**（"No host-user continuation"）——"PM Agent 常驻、人直接派活"需补适配层。

### 1.3 工具调用体系 —— ✅ 满足

- `ctx.tools.register()` 注册；执行管线 `pre-execute → guard → execute → post-execute → result`。
- **`ToolExecution.agent` 由 agent loop 注入可信身份**（同进程不可伪造），scope 路由键按 agent 精确过滤分发。
- 读写外部：内置 `tool-fs` / `tool-bash` / `tool-web` / `tool-lsp` / `tool-jobs`，MCP 可接任意系统。
- **源码**：`packages/core/tools/src/`、`packages/core/scope/`。
- **坑**：restrict/guard 是可见性组合而非安全边界（官方明示 "security and authority are non-goals"）。

### 1.4 Agent preset / persona —— ✅ 满足

- **preset** = 目录 + `agent.cordis.yml`，三层解析（agent → preset → global）。**角色定制 = 一个 preset（persona 文案 + 工具集 + prompt sections），完全声明式。**
- **persona** 是 preset 里一行插件：`text` 模板遮蔽部署 persona，`complete:true` 可独占 system prompt。
- **源码**：`packages/preset/agent-presets/`、`packages/preset/persona/`、`packages/core/system-prompt/`。
- **坑**：preset 一旦会话产出内容**不可切换**；角色能力集创建时钉死，运行中扩权需重开会话。

### 1.5 上下文注入 —— ✅ 满足

- 装配管线 `ctx.systemPrompt.assemble()`：sections + tools + variables + 动态 runtime-context。
- 运行时通道：`agent.inject()`、工具结果 `deferContext()`、`agent/pre-step` waterfall。
- **结构化传递走 `user/message` 的 `source` 字段**（持久 provenance）或自定义 merge 进 `SessionEventMap`。
- **源码**：`packages/core/system-prompt/`、`packages/core/agent/src/inbox.ts`。

### 1.6 自动化与触发 —— ⚠️ 部分满足

- **`dsh-schedule`**：会话内持久提醒，到期 `agent.followup()` 唤醒 Agent——**现成的"定时自动执行"机制**。
- 事件驱动面：`agent/*` / `session/event` / `subagent/start|end` / `goal/changed` 全是可订阅 cordis 事件。
- **坑**：① schedule 只挂 live root Agent，冷 Agent 到期任务要等下次变活才补发；② **没有"新任务进队列就自动唤起对应角色 Agent"的领域触发器**；③ 无外部 webhook/队列入口。

### 1.7 多 Agent 协作 —— ⚠️ 部分满足（最大缺口）

- **原生只有层级委派**：父→子 `followup()` 派任务、子→父 `reportFrom()` 汇报、结算 notice、祖先 `interrupt()` 后代。
- **官方明示缺口**："Inter-agent channels beyond delegation — shared state, streaming child output, background/poll semantics remain outside the current synchronous `ctx.subagents` seam"。**平级 Agent 互为不可见节点。**

### 1.8 权限与身份 —— ⚠️ 部分满足

- 可信身份链：loop 在 `ToolExecution.agent` 注入 Agent 对象；scope 按 agent 精确过滤。
- "不同 Agent 不同权限"三条腿：preset 工具集隔离 + `toolFilter` 收权 + 子代 approval 钉 `never`。
- **坑**：① `identity/` 只有匿名遥测 id，**无认证账户体系**；② scope 是组合机制非安全边界，权限须在**创建时**钉死，运行中不可动态收权。

---

## 2. 三个关键缺口（用户提的核心问题）

### 缺口①：团队上下文如何流转？→ 可建，但缺"领域事件词汇"

- **地基在**：事件溯源 Session + `source` provenance + fork/report 通道，结构化流转的载体已存在。
- **缺口**：「任务卡 / 需求 / 验收 / BUG / 版本」这类**项目管理领域事件类型没有**，DSH 不认识它们。
- **要补**：一套**项目管理领域事件词汇**（declare-merge 进 `SessionEventMap`），让"需求提交、任务指派、状态流转、BUG 上报、验收"成为可被流转、订阅、审计的一等事件。

### 缺口②：能否自动执行、降低人工？→ 半可建，缺"任务驱动调度器"

- **底座在**：`dsh-schedule` 定时唤醒 + `followup()` + 丰富事件订阅。
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
| **preset 产内容后不可换** | 角色能力集创建时钉死 | 角色 preset 设计一次到位；运行中扩权重开会话 |
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

- 一个 cordis 插件，监听 `project-core` 的领域事件 + `ctx.project` 数据变化：
  - 新任务创建/被指派 → 唤起对应角色 Agent（`followup`）
  - 任务进 `dev_done` → 唤起 PM Agent 裁决
  - BUG 进 `pending_verify` → 唤起 QA Agent 验收
  - 需求 `readyToFinish` → 唤起 PM Agent 判结束
- 处理冷 Agent：标记待办，Agent 下次激活时补发（复用 schedule 的补发语义）。
- 宿主派活适配层：人在看板/对话派任务 → 平台转为对对应 Agent 的 `followup()`。

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

DSH 的 Agent 设施（会话/子智能体/工具/preset/上下文）**地基扎实**，足以支撑项目管理平台。真正的缺口集中在三处——**领域事件词汇、任务驱动调度器、平级协作通道**——它们共同构成"团队上下文流转"的核心，且都应长在 `@corum/project-core` 数据层里一体设计。

**先补 Agent 地基，再建数据层，方向与你的判断一致。**
