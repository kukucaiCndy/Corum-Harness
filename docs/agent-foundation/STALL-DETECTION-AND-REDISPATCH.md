# 卡住感知与重新调度设计

> 真实工作暴露的问题（2026-08-25 实测）：Agent 执行任务时可能陷入低效循环
>（如自测阶段与本地进程环境纠缠几十分钟），任务不死不活、用户无感知、无法干预。
> 本文定义「卡住感知 → 用户经 PM 重新调度」的完整机制。
> 状态：定稿（v0.1）· 已实现
> 依据：[DESIGN §3.14](./AGENT-RUNTIME-CONTEXT-DESIGN.md) 调度语义 + 官方 Agent steer/cancel 能力。

---

## 1. 问题定义

- **卡住 ≠ 死亡**：Agent 的 session 事件仍在增长（在思考、在调工具），但长时间不收敛、
  偏离任务目标（例：自测时排查本地环境 20+ 分钟，代码早已写完）。
- **用户无感知**：`runLoop` 派发后阻塞等 `complete_task`，期间无任何进度信号；
  用户只能看到「执行中」，看不到「执行了多久、最后活动在什么时候、是否健康」。
- **无法干预**：没有 steer（引导收敛）/ cancel（中止重派）/ reassign（改派他人）的通道。

## 2. 设计原则

1. **感知是调度器职责**：卡住判定不依赖 Agent 自报（它正忙着跑偏），由调度器
   用「session 最后活动时间」客观度量，发领域事件。
2. **干预权威在人与 PM**：用户是最终权威；PM 是用户入口（DESIGN §3.9/§3.11）。
   用户可对 PM 说「dev 卡住了，重新调度」，PM 用协调工具执行；用户也可直接在
   UI 操作（同一套 RPC，能力等价）。
3. **干预分级**：先轻后重——`steer`（不打断，引导收敛）→ `cancel`（中止当前 turn，
   任务回队重派）→ `reassign`（中止并改派其他成员）。
4. **干预即事实**：所有干预行为落领域事件（可审计、fold 可恢复）。

## 3. 卡住感知

### 3.1 判定

调度器周期（60s）扫描所有「执行中」任务：

```
lastActivityAt = 该任务占用泳道会话的最后事件时间
idleMs = now - lastActivityAt
若 idleMs > STALL_THRESHOLD_MS（默认 3 分钟）且本任务尚未报告过 → 发 corum/task/stalled
```

- 阈值 3 分钟是经验起点（真实 LLM 单步思考可能 1-2 分钟）；后续可做自适应。
- 同一任务只报告一次（避免刷屏）；活动恢复后再次停滞可再报。
- `stalled` 是**信息事件**（不改变任务状态），供 UI 高亮与 PM 感知。

### 3.2 感知出口

- **领域事件**：`corum/task/stalled {task, idleSec}`（事件 tab 实时可见）。
- **listTasks RPC**：每个 profile 带 `currentStartedAt / lastActivityAt / stalled`，
  UI 展示「执行时长 + 最后活动 xx 秒前」，stalled 红色高亮。
- **list_team_tasks 工具**（PM 感知）：执行中任务带「已执行 X 分钟 · 最后活动 Y 秒前」，
  stalled 标注 ⚠——PM 能据此主动判断并向用户上报。

## 4. 重新调度（三级干预）

### 4.1 steer_task —— 引导收敛（最轻）

- **语义**：不打断当前 turn，在下一步边界插入一句引导（官方 `agent.steer()`）。
- **场景**：方向对但节奏拖（如自测过重），提示「编译通过即可，不必起服务，直接 complete_task」。
- **事实**：`corum/task/steered {task, note, by}`（by = 'pm' | 'user'）。

### 4.2 cancel_task —— 中止重派（中等）

- **语义**：`agent.cancel('user')` 中止当前 turn；任务回队首（保留 summary/上下文），
  泳道会话保留（历史在，重派时 resume 续跑）。
- **场景**：明显跑偏/死循环，需要重新来过。
- **事实**：`corum/task/cancelled {task, reason, fate: 'requeue'|'evicted', by}`。
  - `fate='requeue'`（默认）：任务回队首重派；fold 规则 = current 清除 + 任务回队。
  - `fate='evicted'`：任务废弃；fold 规则 = 移除。
- **关键实现点**：cancel 后 runLoop 仍阻塞在 `wakeDone`——cancel 路径必须
  显式唤醒循环（与 complete_task 同通道），任务按 fate 处置。

### 4.3 reassign_task —— 改派他人（最重）

- **语义** = cancel_task(fate='evicted') + 把任务 summary/上下文入队给另一成员
  （assigned 事件 actor=操作者，causedBy 回指 cancelled 事件）。
- **场景**：卡住原因是能力不足/方向不对，换人或换泳道。
- **事实**：`corum/task/cancelled(fate='reassigned')` + `corum/task/assigned`（causedBy 挂边）。

### 4.4 工具与权限

| 工具 | 谁能用 | 说明 |
|---|---|---|
| `steer_task / cancel_task / reassign_task` | **仅 PM**（项目组 role='pm' 成员的会话才装配） | 协调工具是 PM 的应用层特权（DESIGN §3.9），普通成员无 |
| RPC `steerTask / cancelTask / reassignTask` | 用户（UI） | 与 PM 工具同一实现，用户直接干预 |
| `complete_task / report_blocked / assign_task / list_team_tasks` | 全体成员 | 不变 |

## 5. 事件词汇（新增）

| type | payload | 触发时机 |
|---|---|---|
| `corum/task/stalled` | `{task, idleSec}` | 调度器检测到执行中任务超过阈值无活动（信息事件） |
| `corum/task/steered` | `{task, note, by}` | PM/用户对执行中任务插入引导 |
| `corum/task/cancelled` | `{task, reason, fate, by}` | PM/用户中止执行中任务（fate=requeue/evicted/reassigned） |

fold 规则：
- `stalled` / `steered` → 无状态影响（信息）。
- `cancelled(fate='requeue')` → current 清除，任务回队首。
- `cancelled(fate='evicted'|'reassigned')` → 任务移除（reassigned 场景新 assigned 另行入队）。

## 6. UI 呈现

- **任务运行时面板**：执行中任务显示「已执行 X 分 Y 秒 · 最后活动 Z 秒前」，
  stalled 红色高亮 + ⚠；提供「引导 / 中止 / 改派」按钮（调 RPC）。
- **事件 tab**：stalled（黄）/ steered（蓝）/ cancelled（红）类型徽标。

## 7. 与阻塞挂起的关系

- `report_blocked` 是 **Agent 主动**的健康挂起（缺信息，等依赖），走 §3.14。
- 本机制是 **外部权威**对异常任务的干预，两者正交：被 steer/cancel 的可以是
  执行中任务，也可以是挂起任务（cancel suspended → 直接 evicted，无需唤醒循环）。

## 8. 非目标

- 不做自动 cancel/reassign（机器不替人做中断决策，感知≠自动处置）。
- 不做卡住原因诊断（那是 PM/用户看图后的判断）。
- 超时自动批准类自动化留待后续（对齐 DESIGN §3.10 审批挂起语义）。
