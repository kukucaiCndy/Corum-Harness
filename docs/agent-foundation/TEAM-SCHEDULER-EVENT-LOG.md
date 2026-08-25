# 团队调度事件日志设计

> corum「Agent 驱动项目管理平台」的地基组件：**团队层调度事件日志**（Team Scheduler Event Log）。
> 定位：与单 Agent 的 session 日志（官方事件溯源）**并列**的上层抽象——session 日志记录「一个 Agent 干了什么」，本日志记录「一个项目里团队如何调度、任务如何流转」。
> 状态：定稿（v0.1），待实现。
> 依据：[GAP 分析](./AGENT-FOUNDATION-GAP-ANALYSIS.md) §4.1 领域事件词汇 + [运行时上下文设计](./AGENT-RUNTIME-CONTEXT-DESIGN.md) §3 + PRD §3 状态机。
> 原则：纯自研（可参考官方 `experimental/agent-team`，但**不引用其代码**，维护自主性优先）；纯增量叠加，不改官方内核。

---

## 1. 设计基调（已拍板，不可推翻）

1. **半自主调度**：host（或人）是调度权威，Agent 不自主 claim。这是与官方 agent-team「去中心化拉取」的本质分歧，差异化保留。事件日志记录的是「host 调度决策 + Agent 上报结果」的事实，不是 Agent 自主协作的过程。
2. **自研持久化、自研恢复**：不依赖官方 session 事件语义、不依赖官方 `agents.resume()` 回放本层事件。本层独立持久化、独立 fold 恢复。
3. **双层持久化架构**：
   - **Agent 层**：单 Agent 会话事件走官方 session 日志（事件溯源，官方负责）。
   - **团队层**：任务调度事件走本日志（自研事件溯源），与 Agent 层通过**引用挂接**（见 §6），可下钻回溯。
4. **团队属项目**：团队 = 角色模板（profile 集合），项目 = 实例化边界。一个团队可同时服务多个项目，但每个项目**独立实例化**一套 Agent 实例 + 一份事件日志 + 一套调度状态，彼此隔离。**回放永远以项目为单位。**
5. **存储形态 A**：单文件 append-only JSONL + `causedBy` 逻辑 DAG。物理线性、逻辑分叉。现阶段**事件是唯一事实源、全量 fold 恢复**，物化快照作为已知性能优化后门，留待后续研究，本期不做。

---

## 2. 为什么不是官方方案

官方 `experimental/agent-team` 把全部协调状态压进**单一 Lead session 日志**，本质是**单线历史**。团队调度的本质是 **DAG / 分叉历史**：

- 多角色 Agent **并行**干活（dev 在写、test 在验、PM 在审），事件交错，无全局线性序；
- 任务**分叉/转交**（A 转 B、B 阻塞派生 C、C 完成唤醒 B），因果链是网不是链；
- 官方 fold/resume 只认「单条日志」，无法表达「跨多 Agent、多分叉」的团队级历史。

因此本层**借用官方 append-only 哲学，但 DAG 结构自研**，不套用官方单 Lead 日志模型。

---

## 3. 存储形态

### 3.1 落点（多项目）

```
$CORUM_HOME/projects/<projectId>/scheduler-events.jsonl
```

每项目一份独立日志。`<projectId>` 即 PRD `Project.id`。项目删除时该日志随项目归档/软删（审计断链防护见 PRD §历史数据归属）。

### 3.2 物理格式：append-only JSONL

每行一个事件（一条 JSON）。**只追加、不改写、不删除**——抗崩溃（写一半的行在 fold 时截断忽略）、与官方持久化哲学同构（未来对接成本低）。

```jsonl
{"seq":0,"id":"evt-...","type":"task.created","projectId":"proj-1","causedBy":[],"payload":{...},"at":1718000000000,"version":1}
{"seq":1,"id":"evt-...","type":"task.assigned","projectId":"proj-1","causedBy":["evt-..."],"payload":{...},"at":1718000001000,"version":1}
{"seq":2,"id":"evt-...","type":"task.blocked","projectId":"proj-1","causedBy":["evt-..."],"payload":{...},"at":1718000002000,"version":1}
```

### 3.3 逻辑结构：DAG

- **点 = 事件**：任务/需求/BUG/审批 的生命周期事实。
- **边 = 依赖触发（因果）关系**：`causedBy: [eventId...]` 指向「导致本事件发生」的父事件。绝大多数事件单父（链），少数多父（如「多依赖全部解除后唤醒」——但按 DESIGN §3.14 单阻塞链原则，正常情况是单父）。

**物理线性（`seq` 全局时间线）+ 逻辑 DAG（`causedBy` 因果分叉）**，二者都保留：
- `seq` 给团队一个**全局时间线**——回溯「团队整体按时间发生了什么」；
- `causedBy` 表达**分叉因果**——回溯「这个任务/状态是怎么来的」。

### 3.4 崩溃一致性

- 写入：单行 JSON + `\n`，`fs.appendFileSync`（或 write-behind 缓冲 + flush 屏障，对齐官方 `dsh-session-persistence` 的写后屏障语义）。**关键状态落盘后才确认**（呼应 GAP §3「持久化勤 flush」）。
- 读入（fold）：顺序扫描，**尾行不完整（无 `\n` 结尾或 JSON 解析失败）则截断忽略**——视为崩溃残留，不计入。
- 一致性校验：fold 时校验 `seq` 从 0 连续递增；发现空洞/乱序 → 拒绝恢复并报错（宁可拒载，不静默错读，对齐官方 unknown-event 哲学）。

---

## 4. 事件 Schema

### 4.1 事件信封（Envelope）

```ts
interface SchedulerEvent {
  /** 本日志内全局单调递增序号（物理时间线）。fold 校验从 0 连续。 */
  seq: number
  /** 事件唯一 id（uuid）。causedBy 引用它。 */
  id: string
  /** 事件类型判别字段（见 §4.3 词汇表）。 */
  type: SchedulerEventType
  /** 所属项目（团队属项目，恒等于日志落点的 projectId；冗余存储便于跨项目聚合/迁移）。 */
  projectId: string
  /** 因果父事件 id 列表（DAG 边）。空数组 = 根事件（如项目内首个 task.created）。 */
  causedBy: string[]
  /** 事件载荷（随 type 不同，见 §4.3）。 */
  payload: SchedulerEventPayload
  /** Unix epoch ms。 */
  at: number
  /** payload schema 版本（演化用，见 §7）。 */
  version: 1
}
```

> 设计说明：`seq` 与 `id` 并存——`seq` 是 fold/时间线索引（紧凑、连续），`id` 是因果引用（稳定、抗 fold 中插入）。`causedBy` 用 `id` 而非 `seq`，因为因果是语义关系，不应依赖物理位置。

### 4.2 因果边语义（`causedBy`）

| 场景 | 本事件 | `causedBy` 指向 |
|---|---|---|
| 创建任务 | `task.created` | 根（`[]`），或指向触发它的 `requirement.submitted` / 上级任务 |
| 指派 | `task.assigned` | 对应 `task.created` |
| 转交 | `task.transferred` | 该任务的 `task.created`（或上一次 assigned/transferred） |
| 阻塞 | `task.blocked` | 被阻塞任务的 `task.assigned` |
| 派生解除阻塞任务 | `task.created`(C) | `task.blocked`(B)——C 因 B 阻塞而生 |
| 依赖解除唤醒 | `task.unblocked`(B) | `task.completed`(C)——B 因 C 完成而解锁 |
| 完成任务 | `task.completed` | 该任务的 `task.assigned` / `task.unblocked` |
| 上报 BUG | `bug.reported` | 触发它的 `task.completed`（验收不通过）或根 |

---

## 5. 事件词汇表（v1）

对齐 PRD §3 状态机 + DESIGN §3 场景。**最小可用集**（先落地 task 主线 + bug 主线），requirement/review 词汇预留 schema 但本期可不实现写入。

> **命名拍板（2026-08-25 对齐实现）**：事件 type 统一用 `corum/<域>/<动作>` 斜杠格式
>（与 cordis `Events` 合并键、官方 `session/event` 等命名风格一致，防命名空间冲突），
> 替代本文早期草稿的点号格式（`task.assigned` → `corum/task/assigned`）。
> 事实源定义见 `packages/plugins/agent/corum-agent-dev/src/events.ts`（CorumDomainEventMap）。

### 5.1 任务主线（✅ 已落地 4 + 1 个；载荷以 events.ts 为准）

| type | payload | 触发时机 |
|---|---|---|
| `corum/task/assigned` ✅ | `{task: TaskRef, actor, queueLength}`（TaskRef = `{id, projectId, profileId, entityType, entityId?, label, type, requirementId?, summary, transferNote?, source, priority?}`；created 与 assigned 合并——入队即创建事实） | 任务入队到「项目 × 角色」队列（host/PM/成员 assign_task） |
| `corum/task/started` ✅ | `{task: TaskRef, sessionId, fromSeq}` | 调度器把任务 followup 进泳道会话（fromSeq = 占用区间的下钻起点） |
| `corum/task/completed` ✅ | `{task: TaskRef, resultRef: {sessionId, fromSeq, toSeq}, result}` | Agent 调 complete_task 上报 |
| `corum/task/deferred` ✅ | `{task: TaskRef, reason}` | 派发失败（泳道会话创建失败），任务回队首重试 |
| `corum/task/evicted` ✅ | `{task: TaskRef, reason}` | 任务未执行即被逐出队列（成员被移出项目组等） |
| `task.transferred` ⏳ | `{taskId, fromRole, toRole, transferNote, increment}` | A 转交给 B（schema 预留，本期未写入） |
| `corum/task/blocked` ✅ | `{task: TaskRef, reason, blockedByTaskId}` | 遇阻塞即停挂起（§3.14 单阻塞链）；派生的解除阻塞任务 assigned 落盘时 `causedBy` 回指本事件 |
| `corum/task/unblocked` ✅ | `{task: TaskRef, unblockedByTaskId}` | 依赖任务 completed → 调度器反查推导唤醒（方案 A）；`causedBy` 指向该 completed 事件 |

### 5.1.1 项目组主线（✅ 已落地）

| type | payload | 触发时机 |
|---|---|---|
| `corum/group/member-added` ✅ | `{projectId, member: {profileId, role, fromTeam?}}` | 成员加入项目组（项目创建带 PM = 该日志 seq 0） |
| `corum/group/member-removed` ✅ | `{projectId, profileId}` | 成员被移出项目组（调度器据此回收其运行时） |

### 5.2 BUG 主线

| type | payload | 触发时机 |
|---|---|---|
| `bug.reported` | `{bugId, title, severity, requirementId, relatedTaskId?, reporterProfileId, increment}` | 验收/测试发现 BUG |
| `bug.statusChanged` | `{bugId, from, to, by}` | BUG 状态机流转（对齐 PRD `open\|processing\|fixed\|rejected\|pending_verify\|closed\|reopened`） |

### 5.3 需求 / 审批（预留，本期可不写入）

| type | payload | 触发时机 |
|---|---|---|
| `requirement.submitted` | `{requirementId, planId, title, ownerId}` | PD 提交需求 |
| `requirement.finished` | `{requirementId, by}` | PM 裁决结束需求 |
| `review.requested` | `{reviewId, entityType, entityId, payload}` | Agent 提交待审批事项 |
| `review.decided` | `{reviewId, approved, by, comment?}` | 用户审批（对齐 PRD `pending\|approved\|rejected`） |

> 词汇演化规则：新增事件 type 只在日志尾部追加，回放器对**不认识的 type 默认跳过并记 warning**（不像官方那么严，因为我们是自己唯一的读写者）；但**认识的 type 若 payload version 不支持则拒绝 fold**（宁可拒载不静默错读）。

---

## 6. 与 Agent session 的引用挂接

团队层**不复制** Agent 对话内容，只记**引用**，回溯时可下钻到 Agent 层。

```ts
/** 指向某 Agent session 日志里的一段工作成果。 */
interface SessionResultRef {
  /** Agent 的 sessionId（官方 session 日志身份）。 */
  sessionId: string
  /** 该任务占用该 session 的 seq 区间 [fromSeq, toSeq]。 */
  fromSeq: number
  toSeq?: number   // 任务进行时可缺省，completed 时补齐
}
```

- `task.started` 记 `agentSessionId`（该角色 Agent 在哪个 session 干活）；
- `task.completed` 记 `resultRef`（成果落在该 session 的哪段）；
- 回溯路径：团队日志 `task.completed.resultRef` → 官方 session 日志 `readFrom(sessionId, fromSeq)` → 看该 Agent 当时的完整思考/工具调用。

> 这要求角色 Agent 的 sessionId **稳定且可关联**——当前 `agent-service.createAgent` 每次生成随机 UUID sessionId，后续需配套改造，否则 `resultRef` 断链。**这是实现期的一个依赖项，记入 §9 待办。**

### 6.1 sessionId 语义化格式（已拍板方向）

sessionId 不只是稳定标识，还要**承载任务语义、可直接追溯**。背后的设计哲学：**一个 session 聚焦一类工作，避免跨业务分散 Agent 注意力**——UI 类工作集中一个 session、某核心模块的开发一个 session、核心业务 debug 又一个 session。这与 DESIGN §3.6「标签 = 需求ID + 类型」的 session 路由思想一致。

**目标格式**：

```
corum-<projectId>-<profileId>-<tag>-<random>
```

| 段 | 含义 |
|---|---|
| `projectId` | 项目隔离边界 |
| `profileId` | 哪个角色 Agent |
| `tag` | 工作聚合标签（如 `req-42-ui` / `req-42-core` / `req-42-debug`，需求ID + 类型），对应 session 路由的标签池 |
| `random` | 后缀随机，保证唯一 + 防碰撞 |

看 sessionId 即可直接读出「哪个项目、哪个角色、处理哪类工作」。`tag` 的生成规则（从任务算出标签）由调度器在 ensureAgent 时决策，与未来的 session 池路由（DESIGN §3.6/§3.7）是同一模块。

**分期落地**：
- **本期最小闭环**：先用简化稳定格式 `corum-<projectId>-<profileId>-<random>`（保证 `resultRef` 不断链即可），`tag` 语义化**后置**——等 session 池路由模块（DESIGN §3.6/§3.7）开发时一并上，避免最小闭环背过多前置。
- **后续**：接入标签池后，sessionId 升级为完整语义化格式。

---

## 7. fold 恢复语义（重启重建调度状态）

host 重启时，对 `scheduler-events.jsonl` 全量 fold，**推导**出当前调度状态（不持久化调度状态本身——事件是唯一事实源，状态是派生物）。

```ts
interface SchedulerState {
  /** 每角色（profile）的任务队列 + 当前任务。 */
  runtimes: Map<profileId, {
    queue: TaskQueueEntry[]      // 待处理（含 increment）
    current?: { taskId, startedAt, agentSessionId }
  }>
  /** 任务实体当前态（fold 推导）。 */
  tasks: Map<taskId, {
    status: 'pending' | 'running' | 'blocked' | 'done'
    assigneeProfileId?: string
    blockedByTaskId?: string
    requirementId?: string
  }>
  /** 依赖反查索引：taskId → 被它阻塞的 taskId 列表（C 完成时查谁该被唤醒）。 */
  blockedOn: Map<blockerTaskId, blockedTaskId[]>
}
```

**fold 规则**（逐事件应用，幂等）：
- `task.created` → `tasks[id] = {status:'pending', ...}`
- `task.assigned` → 入对应角色 `queue`，`tasks[id].assigneeProfileId=...`
- `task.started` → 出队 → `current`，`status='running'`
- `task.blocked` → `status='blocked'`，登记 `blockedOn[blockedByTaskId]`
- `task.completed` → `status='done'`，**反查 `blockedOn[id]` → 对每个被阻塞者生成 `task.unblocked` 的等价推导**（被阻塞任务回 queue 待唤醒）
- `task.unblocked` → `status='pending'`，回对应角色 queue
- `task.transferred` → 从 fromRole queue 移除，入 toRole queue

> 注意：`unblocked` 既可由显式事件产生，也可由 fold 在 `task.completed` 时**推导**产生。DESIGN §3.14 方案 A（靠依赖反查唤醒）走的是**推导**路径——C 正常完成即可，调度器 fold 时自动发现 B 该被唤醒，C 无需知道 B。显式 `task.unblocked` 事件用于审计可读性（可选记录，非必需）。

**恢复后动作**：fold 得到 `SchedulerState` → 调度器对每个有 pending 任务的角色，按现有 `runLoop` 逻辑继续调度（ensureAgent → followup → 等 complete_task）。**正在 running 但未 completed 的任务**：其 Agent 会话在官方层可 resume，本层 fold 后视为「恢复 running」，调度器重新阻塞等它的 complete_task。

---

## 7.1 监控 hook 接入点（预留）

未来需要一个**团队工作状态监控页面/面板**（Agent 忙闲、各 Agent 工作情况统计、任务流转可视化、队列深度等）。事件日志 + fold 状态天然是这个面板的唯一数据源，需预留**外部可订阅/可读取**的 hook 接入点，方便后续监控插件开发，且不让监控反向耦合进调度内核。

**三类接入点**（由内到外，监控插件按需取用）：

1. **实时事件流**：调度器每次 append 事件后，同步 emit 一个 cordis 事件（如 `corum.scheduler/changed`），携带刚落盘的事件。监控插件 `ctx.on(...)` 订阅即可拿到实时流，无需轮询文件。
2. **fold 状态快照只读接口**：调度器暴露 `getSchedulerState(projectId): SchedulerState`（只读投影），监控插件可随时拉一份当前调度状态（每角色忙闲、队列、任务状态、依赖关系）。
3. **历史回溯接口**：`readEvents(projectId, fromSeq?)` / `foldAt(projectId, seq)`（fold 到某个历史时点的状态），供监控面板做时间轴回放、统计聚合（如某时段各 Agent 完成了多少任务）。

**设计约束**：
- 监控**只读**，绝不提供写事件的接口给监控插件——事件写入只走调度器（半自主基调，监控不改变调度）。
- 事件流与 fold 状态都**按 projectId 隔离**，监控插件按项目订阅。
- 统计类数据（Agent 工作量、任务周期时长、忙闲占比）由监控插件**自行 fold/聚合**得出，调度内核不预计算——保持内核精简，统计是消费方职责。

> 接入点 1（实时流）+ 2（状态快照）是**本期随最小闭环一并预留**（成本极低，就是在 append 处多 emit 一次 + 暴露一个只读 getter）；接入点 3（历史回溯）随监控插件实际需要时再实现。

---

## 8. 与现有 `corum-agent-dev` runtime 的关系（迁移路径）

当前 `runtime.ts`（`corumRuntime`）是**纯内存**的演进验证版。本设计落地时按以下路径演进，**不重写、平滑叠加**：

1. **Task schema 升级**：现有 `{id, profileId, summary, transferNote, status}` → 对齐 §5 的 `task.assigned.increment`（引用 + 摘要 + 增量）。
2. **写入钩子**：`enqueue()` → 追加 `task.created` + `task.assigned`；`onTaskDone()` → 追加 `task.completed`；新增阻塞/转交路径 → 追加对应事件。
3. **启动恢复**：`AgentRuntime` 构造后先 `fold(projectId)` 重建 `SchedulerState`，再启动各角色 `runLoop`。
4. **写后屏障**：关键事件 append 后 flush 落盘再确认（对齐官方 journal 的 append→flush→notify 顺序）。

**本期最小闭环**（先跑通，再扩展）：只做 `task.created / assigned / started / completed` 四个事件 + 全量 fold 恢复队列 + 预留监控 hook（§7.1 接入点 1、2），验证「重启不丢任务队列」。`blocked/unblocked/transferred` 词汇 schema 先定义但本期可不写入。

---

## 9. 待办 / 依赖项

- [ ] **稳定 sessionId（简化格式先行）**：角色 Agent 的 sessionId 从「每次随机 UUID」改为「项目内稳定可关联」——本期先用简化格式 `corum-<projectId>-<profileId>-<random>` 保证 `resultRef` 不断链，并关联 `agents.resume()` 冷恢复。**`tag` 语义化后置**，随 session 池路由（DESIGN §3.6/§3.7）一并升级为 `corum-<projectId>-<profileId>-<tag>-<random>`（见 §6.1）。
- [ ] **projectId 来源**：当前 runtime 无「项目」概念，需引入 projectId（最小可先 hardcode 一个 dev 项目 id，后续接 `ctx.project` 数据层）。
- [ ] **多项目并行**：当前 runtime 是单例全局协调器，多项目需改为「按 projectId 分实例」或「实例内按 projectId 分区」。
- [ ] **监控 hook 接入点 1+2**（本期随最小闭环预留）：append 后 emit 实时事件流 + `getSchedulerState` 只读快照接口（§7.1）。
- [ ] **物化快照**（性能优化后门，本期不做）：事件量大后，定期把 fold 结果落盘为可丢弃快照，重启从最近快照 + 增量 fold 恢复。**快照必须可随时删除重 fold 验证**（事件仍是唯一事实源）。
- [x] **崩溃半行恢复**：fold 时尾行不完整截断（§3.4，readSchedulerEvents 已实现截断忽略）。
- [ ] **requirement/review 词汇写入**（本期仅 schema 预留）。
- [ ] **监控 hook 接入点 3（历史回溯）**：随监控插件实际需要时实现（§7.1）。

---

## 10. 非目标（Non-goals）

- **不做 Agent 自主 claim / 拉取式协作**（半自主基调，host 是调度权威）。
- **不复制 Agent 对话内容**进团队日志（引用挂接，不下钻全文）。
- **不做跨项目团队调度**（团队属项目，多项目 = 多实例隔离）。
- **不做实时查询索引**（本期全量 fold，索引/物化是后续优化）。
- **不改官方内核 / 不引用官方 experimental/agent-team 代码**（自主维护）。

---

## 11. 与官方的双层关系总结

```
团队层（本设计，自研）        Agent 层（官方）
─────────────────────────     ─────────────────────────
scheduler-events.jsonl        session 日志（每 Agent 一份）
任务调度 DAG 事件              单 Agent 会话事件（官方溯源）
自研 fold → 调度状态           官方 resume → 会话状态
        │                              ▲
        └──── resultRef 引用挂接 ──────┘
             （团队事件可下钻到 Agent 工作现场）
```

两层各自事件溯源、各自恢复，**通过 `resultRef` 单向引用挂接**，构成「团队调度可回溯 + 单 Agent 工作可下钻」的完整回溯能力。
