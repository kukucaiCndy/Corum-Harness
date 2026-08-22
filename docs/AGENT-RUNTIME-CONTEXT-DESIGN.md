# Agent 运行时与上下文流转设计讨论记录

> 本文记录「Agent 驱动的项目管理平台」地基差异化定制过程中的设计讨论，是 [AGENT-FOUNDATION-GAP-ANALYSIS.md](./AGENT-FOUNDATION-GAP-ANALYSIS.md) 的延续。
> 状态：讨论中，未定稿。聚焦**平级角色 Agent 之间的上下文流转**（父子 Agent 走官方默认委派，不在此范围）。
> 原则：纯增量叠加，不改官方 Agent 内核。

---

## 1. 核心架构：在官方 loop 之外加一层「Agent 运行时」

官方 `dsh-agent-loop` 的 `ReactLoopAgent` 已经是「待命阻塞（idle）+ 串行（`while (await turn()) {}`）+ inbox 队列 + 可撤销（`cancel`）」的执行引擎，但**全部限定在单个 Session 内**，且队列里排的是 `UserMessage` 而非「任务」。

我们要加的是官方 loop 之外的**一层**：

```
Agent 运行时（宿主侧常驻协调，跨会话）
  ├── 任务队列（领域级 task：转交 / BUG 关联 / 讨论组）
  │     入队 ← 监听领域事件
  │     出队 ← 串行取一个（一个 Agent 同一时刻只处理一件事）
  │     撤销 ← 任务级 cancel
  │
  └── 取到任务后 → 决策 session（new/old）→ 在那个 session 上 followup
                    ↓
              官方 ReactLoopAgent 干活（会话内，复用，不改）
```

对应伪代码结构：

```
for (task of taskList) {
  // use new / old session
  do {
    // 官方那一套（turn/step 循环）
  } while (taskDone)
}
```

**三个需要设计的增量点**：

1. **任务队列（领域级）**：官方 inbox 排消息，我们要排「任务」。
2. **`taskDone` 判定**：官方只知"inbox 空 → idle"，没有"任务完成"信号。候选：领域状态机兜底（task 状态到 `dev_done`/`completed`）+ Agent 显式声明（`complete_task` 工具/事件）。
3. **`new/old session` 路由决策**：什么任务新开 session、什么任务复用旧 session——「context 流转的精髓」。

**确认不影响构建**：Agent 是否指派子 Agent、是否在当前 session 等待，都发生在内层「官方那一套」的 step 内，保持官方原样，不介入外层 for 循环。

---

## 2. 关键事实澄清（讨论中达成的共识）

### 2.1 官方 Agent 现状

- Agent 与 Session 是 **1:1 硬绑定**：`Agent.id` 类型即 `SessionId`，`ReactLoopAgent` 构造时 `readonly session`。官方没有「跨会话的 Agent 实体」。
- inbox 里排的是 `UserMessage`，不是「任务」。
- 官方 loop 本身已具备：待命阻塞（idle）、串行（`while(turn())`）、队列（`next-turn`/`next-step`）、撤销（`cancel(cause, {keepInbox})`）。

### 2.2 任务触发与 schedule

- `dsh-schedule` 是三种：`after`（延时）/ `at`（绝对时刻）/ `every`（固定频率），**delivery 是 `session-local`**（仅会话 live 时准时，否则 overdue 到 resume）。
- schedule 与 followup/steer 都只投**当前 Agent 自己的会话**，不会跨会话。
- Agent **无法自主决策切换会话**，也感知不到其他会话；唯一跨会话动作是 `ctx.subagents` 委派子代（父子，非平级）。

### 2.3 平级协作与 authority 硬约束

- 官方协作图是严格父子树，平级 Agent 互为不可见（`core/agent/README.md` 明示）。
- `ctx.subagents.followup(parent, childId)` 的 parent 必须是 **exact live direct parent**；独立「调度器插件」无合法 authority 去 followup 角色 Agent。三条候选路线（项目根 Agent 中转 / 事件注入+自拉取 / 改造 authority 违反红线），**待拍板**。

### 2.4 角色能力位映射

- 官方 continuable child 的 composition 只有 `persona`(string) + `toolFilter`(ToolRestriction) + `agentOptions.model`。
- PRD §4.0.2 的 AgentProfile 有 6 项（`prompt/model/skills/mcpServers/terminal/memoryPolicy`）。
- 官方提供扩展点 `ctx.subagents.registerContinuableSetup((childCtx) => () => void)`，corum 可在创建窗口注入任意 child-scoped 能力。**全部不改内核。**

### 2.5 权限网关 role 反查

- `ToolExecution.agent` 由 agent loop 可信注入，模型无法自报（fused dispatcher 强制覆盖）。
- `ctx.agents.get(sessionId)` 可反查 live Agent。
- 因此 PRD §7.4 的「需改造 DSH 核心」顾虑**可撤销**，权限网关 `resolveCaller(sessionId)` 零改造实现。

---

## 3. 上下文流转的设计讨论（核心，进行中）

### 3.1 前提：平级流转是「共享黑板 + 领域事件」，非直接通信

平级 Agent 不直接发消息，而是「写共享实体 + 发领域事件」。因此平级 context 的**第一等形态是「领域事件（信号）+ 共享实体（事实）」的组合**。

### 3.2 context 的四种存在形式

| 形式 | 是什么 | 持久性 | 谁能读 |
|---|---|---|---|
| ① 共享实体 | `ctx.project` 里的 task/bug/requirement/discussion 数据 | 持久（落库随 git） | 所有 Agent（过权限网关） |
| ② 领域事件 | `task.transferred` / `bug.submitted` 等最小声明 | 持久（审计日志） | 订阅方（触发调度） |
| ③ 队列条目 | Agent 任务队列里的一条「待办」：实体引用 + 摘要 + 增量 | 持久（Agent 自身维护） | 仅该 Agent |
| ④ 注入 context | 新 session 的 seed / `systemPrompt.context` | 会话内 | 仅该 session 的模型 |

**核心原则**：平级流转时，③ 队列条目装的是「引用 + 摘要 + 增量」，不是全文拷贝；全文在 ① 共享实体，对方自己去读。

### 3.3 四个场景的 context 形态映射

**场景 1：A 转交任务给 B**
- ① 事实变更：task 的 `assignee` A→B，`transferHistory` 追加。
- ② 信号：发 `task.transferred`（最小 payload：taskId + from + to）。
- ③ B 队列新增：`{ taskRef, summary, transferNote }`，其中 `transferNote` 是 A 的**增量**（做到哪、卡在哪、下一步建议），非 task 全文。

**场景 2：A/B/C 讨论组**
- ① 共享流：`discussion` 实体是多方共享 append-only 消息流。
- ④ 每个 Agent 的视角：A 看到 = 主持人输入 + B/C 输出，**过滤掉自己的历史输出**。
- 讨论组「共享流」与「每个 Agent 自己的 session」是两个东西。

**场景 3：C 发现 BUG → 流转到 B → 新 session**
- 静态前缀（④ seed）：项目信息（技术栈/目录/角色）一次打进新 session。
- 动态实体（③→④）：BUG 详情 + 关联任务 + 涉及文件点位，作为队列条目引用，B 开 session 时按引用读。

**场景 4：用户直接对话**
- 普通 `user/message` 进某 Agent 的 inbox，无领域流转，context 即消息本身。

### 3.4 补充的三个 context 形式

1. **「摘要」是一等公民**：平级流转永远传「摘要 + 引用」，全文在共享实体。摘要是谁生成、何时生成、存不存，需单独设计。
2. **「讨论组议题」= 种子 context**：场景 2 的首轮议题，与场景 3 的项目信息 seed 是同一机制。
3. **「任务完成沉淀」= 反向流转**：B 干完的结论（根因/修复/验证）回流共享实体（BUG 关闭 + 评论 + 可能沉淀 PROJECT.md）。

### 3.5 待用户回答的问题

场景 1 和场景 3 里，B 的任务队列条目是：

- **自包含 context 包**（增量进队列即持久化，B 开 session 时作为 seed/context 注入）？
- 还是**轻量指针**（B 拿到 taskId 后自己去读 A 的 session 历史 / 共享实体）？

这决定「任务队列条目」是自包含 context 包，还是轻量指针。

---

## 4. 待办（未决，等用户逐步引导）

- [ ] 任务驱动调度器的 authority 路线（项目根 Agent 中转 / 事件注入+自拉取 / 改造 authority）
- [ ] `taskDone` 判定（状态机兜底 / Agent 声明 / 静默判定）
- [ ] `new/old session` 路由决策规则
- [ ] 角色映射落地形态（一 Agent 多帽子 / 每角色一个 continuable child）
- [ ] 队列条目的自包含 vs 轻量指针
- [ ] 项目上下文注入的静态 seed vs 动态 context 分层
