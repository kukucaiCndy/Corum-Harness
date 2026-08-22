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
  // use new / old session（路由 key = 需求ID + 类型）
  do {
    // 官方那一套（turn/step 循环）
  } while (taskDone)
}
```

> 澄清：`taskDone` 指「单个任务（如单个 BUG）完成」，与「session 生命周期耗尽」是**两个不同事件**。一个 session 承载「需求+类型」下的多个任务，任务逐个完成，session 在归档时才结束（见 §3.7）。

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

### 2.3 平级协作与 authority

- 官方协作图是严格父子树，平级 Agent 互为不可见（`core/agent/README.md` 明示）。
- **调度 authority 无硬约束**（重要澄清）：协调器用 `Agent.followup(message)`（Agent 句柄方法，无 authority 限制），**不是** `ctx.subagents.followup(parent, childId)`（subagent 委派 seam，才要求 exact live direct parent）。角色 Agent 是独立 root Agent，协调器经 `ctx.agents.get/roots()` 拿句柄直接派活，不改内核。详见 GAP §4.2。

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

**场景 4：用户对话（仅对 PM）**
- 用户当前只与 PM 对话下达决策指令，普通 `user/message` 进 PM 的 inbox（PM 的人机交互入口），无领域流转，context 即消息本身。A/B/C 暂不开放与人交流。

### 3.4 补充的三个 context 形式

1. **「摘要」是一等公民**：平级流转永远传「摘要 + 引用」，全文在共享实体。摘要是谁生成、何时生成、存不存，需单独设计。
2. **「讨论组议题」= 种子 context**：场景 2 的首轮议题，与场景 3 的项目信息 seed 是同一机制。
3. **「任务完成沉淀」= 反向流转**：B 干完的结论（根因/修复/验证）回流共享实体（BUG 关闭 + 评论 + 可能沉淀 PROJECT.md）。

### 3.5 任务队列条目：轻量指针 + 增量 context（已定）

场景 1 / 3 里，B 的队列条目 = **引用 + 摘要 + 增量**，不是自包含全量包。全文在共享实体（①），B 拿到 taskRef 后按需读。增量（转交说明 / BUG 描述）是 A/C 的推理结论，非全文拷贝。

### 3.6 session 路由决策（已定，Y 方案：需求 + 类型，标签即 session 池）

`标签 = 需求ID + BUG类型`。**同一标签下是一个「session 池」**，而非唯一 session。同需求 + 同类型 BUG → 归入该标签的 session 池；同需求不同类型 → 不同标签池；跨需求 → 必然不同标签池。

- **类型枚举按表象收敛**：UI 卡顿归 UI，功能有问题归功能，拿不准兜底归功能/其他。封闭枚举，上报时必选其一。
- **确定路由规则**（非 LLM 实时判断）：

```
派发 BUG 给 Agent
  └── 查该 BUG 的标签(需求ID, 类型)
        ├── 该标签下有「闲置」session → 复用（followup 进闲置 session）
        ├── 该标签下 session 全「占用」→ 读标签 context 快照 → 新开 session（注入快照 + BUG 增量）
        └── 该标签下无 session → 新开 session（注入：静态项目上下文 + 需求上下文 + BUG 增量）
```

- **「闲置 / 占用」状态**：闲置 = 当前无任务占用、可接新任务；占用 = 正在处理某任务（含挂起冻结）。同一时刻 Agent 只在一个 session 中工作，因此**不存在并发活跃 session**——占用/闲置是串行时间线上的标记。

### 3.7 session 生命周期：标签 context 快照 + 挂起/回收（已定）

**核心：session 池内通过「标签 context 快照」实现跨 session 的乙延续，而非 fork / 共享 session。**

- **快照生成时机**：session 因任务挂起而冻结时，提炼该 session 关键信息（摸清的项目事实 + 需求上下文 + 当前进展 + 阻塞点），生成/覆盖「标签 context 快照」，打上该标签。
- **快照使用**：仅在**新 session 启用时使用一次**（注入为新 session 的上下文前缀）。之后不再复用，除非再次挂起则重新生成（重新生成的代价与聚合相当，直接重新生成即可）。
- **快照唯一性**：同一标签**始终只有一份最新快照**，且必然由「最后一个挂起的 session」生成——因为挂起是串行的，最后一个挂起者一定知晓前面挂起了哪些任务。
- **挂起 session 回收时的回写**：挂起 session 依赖解除、完成其任务后回收时，**回写 context 快照**，把该挂起任务的摘要从「挂起中」改为「已完成」，保持快照是最新事实。
- **挂起恢复**：依赖解除信号到达 → 向 Agent 任务队列添加「继续之前挂起任务」的任务 → Agent 恢复该挂起 session 的完整上下文（含该任务的完整推理）→ 完成后回收 session。
- **回收**：任务完成后 session 直接回收，避免 session 池碎片化（同一标签最多只剩"闲置 session" + 若干"挂起 session"）。

**与 dsh 压缩的关系**：正常流程靠「快照 + 回收」主动管理生命周期，不依赖 dsh compaction（有损 + 断层）。dsh 压缩仅作异常兜底（单个任务异常超长、突然 overflow 报错），防崩溃。

### 3.8 归档分层与审核（已定）

- **Agent 专属经验** → 自己沉淀，无需审核。
- **项目级沉淀**（能进 PROJECT.md 的）→ 提交 **PM 统筹 Agent** 审核，PM 上报用户决策。

### 3.9 统筹 Agent = PM（已定，重要修正）

- **PM 即统筹 Agent**，是「项目」与「人（用户）」之间的**交互入口**——人的代理，协助人统筹管理项目：汇总信息、跟踪进度、上报风险、审核项目级沉淀。
- **PM 不是官方 subagent 树的 root**：调度 authority 不来自 `followup()` 父子委派（否则就退回官方会话级委派，Agent Loop 无意义）。调度 authority 来自**宿主侧任务队列协调器（cordis 插件）**。

```
角色 Agent A 要转交任务给 B
  └── 调框架工具 transfer_task(任务详情 + 增量 context)
        ├── 工具实现 = 写共享实体(ctx.project) + 发领域事件(task.transferred)
        └── 宿主侧协调器监听事件 → 写入 B 的任务队列
              └── 协调器串行调度 B：取一个任务 → 决策 session → 在那 session followup
```

- PM 与 A/B/C 在调度上是**平级**的，都靠宿主侧协调器 + 任务队列被驱动。PM 的"高权限"是**应用层特权**（审核沉淀、对接用户、上报风险），不是官方树的 root authority。

### 3.10 用户审批形态（已定，方案乙：审批表是框架一环，事件驱动）

- **审批表是项目管理框架的一环**，走**事件驱动**（领域事件：`review.requested` / `review.approved` / `review.rejected`），本质在项目管理框架内部流转，不是 PM 私有的"对话审批"。
- PM 生成结构化「待审批事项」写入共享实体（`review.requested`），用户在前端**审批表**统一查看并「同意/驳回」，结果经领域事件回流给 PM。
- **PM 对话是审批表的"呈现/引导"入口，不是替代品**：PM 可把未决策内容从审批表读出来给用户、提问、引导，但最终审批动作仍是审批表事件。用户也可**直接进审批表页面批量审批**——两者不冲突。
- **用户不在时默认挂起**。
- 后续演进（暂不做）：超时自动批准/否决、打通飞书等社交软件远程审批。

### 3.11 PM 的输入模型与人机交互入口（已定）

- **PM 复用与 A/B/C 完全同一套机制**（任务队列 + session 路由 + 归档），唯一差异：**多一个"人机交互入口"作为输入源**。
- **其余 Agent（A/B/C）默认只接受调度，暂不开放与人交流。**

```
PM 的输入
├── 来源 1：调度（与 A/B/C 完全一致）
│     宿主侧协调器监听领域事件 → 入 PM 任务队列
│     （如：A/B/C 提交项目级沉淀待审 → review.requested 事件 → 入 PM 队列）
│
└── 来源 2：人机交互入口（PM 独有）
      用户直接对 PM 下达决策指令（汇总信息 / 跟踪进度 / 上报风险 / 审批引导）
```

- **用户当前只与 PM 对话下达决策指令，由 PM 分配**；是否开放其他 Agent 的直接对话，留待实际体验后再定。

---

## 4. 待办（未决，等用户逐步引导）

- [x] 任务驱动调度器的 authority 路线（→ 宿主侧协调器，非 followup 委派）
- [x] `new/old session` 路由决策（→ Y 方案：需求 + 类型，标签即 session 池）
- [x] 队列条目的自包含 vs 轻量指针（→ 轻量指针 + 增量）
- [x] 统筹 Agent 角色定位（→ PM，用户桥梁 + 应用层特权）
- [x] 用户审批形态（→ 结构化审批表 + 挂起）
- [x] `taskDone` 判定（→ Agent 专用上报工具 `complete_task` + 自主核对验收标准；idle 仅作卡住超时兜底，不作完成判定）
- [x] 阻塞/挂起语义（→ 任务带「阻塞」可恢复中间态；阻塞转交派生依赖任务；依赖解除经领域事件被动唤醒）
- [x] session 池机制（→ 标签 context 快照 + 挂起/回收，非 fork）
- [ ] 角色映射落地形态（一 Agent 多帽子 / 每角色一个 continuable child）
- [ ] 项目上下文注入的静态 seed vs 动态 context 分层
- [ ] 任务队列条目的具体 schema（实体引用 / 摘要 / 增量的字段结构）
- [ ] 讨论组共享流与 Agent 视角投影的具体机制
- [ ] 标签 context 快照的具体 schema（项目事实 / 需求上下文 / 进展 / 阻塞点 / 已完成任务摘要）
- [ ] 阻塞依赖关系与「依赖解除自动唤醒」的落地（任务依赖图？领域事件 `blocker.resolved`？）
