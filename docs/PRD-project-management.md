# corum IDE 项目管理平台 PRD

> Agent 驱动的轻量化项目管理 · 产品需求文档
> 版本：v0.3（定稿，以需求为核心 + 角色生产者权责 + BUG 生命周期 + 主线流程） · 状态：待评审
> 共创：产品经理 / 项目管理 / PDT 经理 / 研发 / 测试（多角色子 Agent 多轮对焦收敛）

---

## 1. 定位与价值主张

**定位**：内嵌于 corum IDE 的、由 Agent 驱动执行的轻量项目管理层。它不是独立的 PM 工具，而是「会话 + 代码」之上的**项目上下文结构化载体**。

**一句话价值主张**：让 Agent 不只写代码，还能以"项目经理 + 团队成员"身份，围绕**计划 / 任务 / 时间 / 文档 / 问题**五维，自动规划、执行、追踪整个项目。

**护城河**：数据上下文独占。代码、会话、终端、git 历史都在 IDE 内，Agent 能自动感知"哪个任务被哪段会话/代码推进"——这是 Jira / 飞书项目等外部工具永远缺失的实时上下文。我们不做另一个看板工具，而是补交付闭环的"最后一公里"。

---

## 2. 目标用户与核心场景

**目标用户**：1–10 人小团队 / 独立开发者，重度使用 AI Agent 开发，无专职 PM，嫌 Jira 太重。

**核心场景**：

1. **一句话立项**：用户说"两周内做出 X 功能"，Agent 生成计划 → 拆解为任务 → 排入时间线，用户确认即立项。
2. **Agent 驱动执行**：用户说"开始做任务 T3"，Agent 绑定任务上下文（关联文件/验收标准）编码，完成后自动更新状态并请求验收。
3. **会话沉淀为文档**：架构讨论/方案评审会话一键（或 Agent 主动）归档为项目文档，关联到对应任务。
4. **风险自动上报**：Agent 执行受阻（API 不明、依赖缺失、排期滞后）自动建 Issue 并提醒决策，不静默失败。
5. **每日站会**：Agent 基于五维数据生成日报：昨日完成、今日计划、阻塞项、里程碑进度。

---

## 3. 领域模型（以「需求」为心脏）

> 用户的五维（计划/任务/时间/文档/问题）在领域模型中落地为一组相互关联的实体。其中**需求 Requirement 是贯穿整个主线的心脏**：PD 提交需求 → Dev 关联需求 → QA 据需求写用例 → 需求下功能完成且 BUG 清理才结束。因此**需求独立成实体**（用户拍板）。

### 3.1 实体总览

| 实体 | 归属维度 | 生产者（边界内直写） | 一句话定义 |
|---|---|---|---|
| **计划 Plan** | 计划 | 产品 PD | 项目交付计划，含阶段（里程碑）划分 |
| **需求 Requirement** | 计划（心脏） | 产品 PD | 一个可交付的需求，关联计划阶段，下挂功能任务与 BUG |
| **任务 Task** | 任务 | 技术经理 TL / 研发 Dev | 据计划/需求拆解的开发单元，关联需求 |
| **测试用例 TestCase** | 任务/问题 | 测试 QA | 据需求编写的用例，执行结果可一键转 BUG |
| **缺陷 BUG** | 问题 | 测试 QA 创建 / 研发 Dev 处理 | 测试发现的缺陷，关联需求，含转交链 |
| **文档 Doc** | 文档 | 各角色（P1） | 项目知识沉淀（PRD/方案/纪要），文档即工作区文件 |
| **时间事件 TimeEvent** | 时间 | 各角色（P1） | 里程碑/评审/发布等时间承载 |

### 3.2 实体关系

```
Plan 1—N PlanStage(阶段/里程碑)
Plan 1—N Requirement 1—N Task
Requirement 1—N TestCase
Requirement 1—N BUG（Task 可选关联 BUG）
TimeEvent 挂在 Plan/PlanStage 上（P1）
```

### 3.3 各实体状态机（标注写入归属）

> 写入归属两类：**【角色直写】**= 生产该实体的角色在自己边界内直接写；**【PM 裁决】**= 跨角色的关键状态流转，归口 PM 统一生效（PM 是这类状态的唯一写入者与唯一问责者）。

**计划阶段 PlanStage**：`pending → in_progress → done`（全部 **【PM 裁决】**，PM 盯里程碑、推进阶段）。

**需求 Requirement**（主线心脏）：
```
submitted(PD 直写) → in_dev(系统派生) → dev_done(系统聚合) → verifying(系统聚合) → finished(【PM 裁决】)
```
除 `finished` 外全部由系统派生，无人工直写。需求结束条件见 §3.5。

**任务 Task**：`todo ↔ doing → dev_done`（**【角色直写】** Dev）；`dev_done → completed`（**【PM 裁决】**，任务完成归口 PM）。

**测试用例 TestCase**：`未执行 → 通过 / 失败 / 阻塞`（**【角色直写】** QA 按版本回写执行结果）；失败/阻塞可一键转 BUG。

**缺陷 BUG**（QA 创建、Dev 处理、QA 验收、关闭受控）：
```
open(QA 直写) → processing(Dev 认领 直写)
  → fixed(Dev 直写，须附 commit/版本)
  → rejected(Dev 直写，须填理由，QA 可申诉重开)
  → transferred(Dev 直写转交，落回 processing，链留痕)
fixed → pending_verify(QA 拉入回归 直写)
  → closed(QA 验收通过 关闭，★仅 QA，PM/Dev 均不可绕过)
  → reopened(QA 回归失败 直写，重新计入未关闭统计)
```

**缺陷关闭裁决（主 PM 裁定，解决研发 vs 测试分歧）**：用户明确"**BUG 只有测试验收后才能关闭**"，故 **BUG 关闭权归 QA**（验收通过才关），PM 与 Dev 均不可绕过 QA 关闭；Dev 只能 `fixed/rejected/transferred`，永远不能 `closed`。

### 3.4 缺陷严重度与「需求结束」约束

| 严重度 | 含义 | 对需求结束的约束 |
|---|---|---|
| **阻断 blocker** | 核心流程不可用 | 必须全部关闭 |
| **严重 critical** | 主功能错误（有绕行） | 必须全部关闭 |
| **一般 major / 轻微 minor** | 非关键问题 | 可遗留，PM 关需求时需显式确认遗留清单并可带入下阶段 |

### 3.5 需求结束判定（系统自动检测 + PM 手动确认）

**派生聚合视图**（单源事实，不冗余存计数，实时计算）：

```ts
interface RequirementReadiness {
  requirementId: string
  featureTotal: number        // 需求下 isFeature 的任务总数
  featureCompleted: number    // 已完成任务数
  openBlockers: number        // severity∈{blocker,critical} 且 status≠closed 的 BUG 数
  readyToFinish: boolean      // featureTotal===featureCompleted && openBlockers===0
}
```

`readyToFinish` 变 true 时推送 `requirement.ready` 事件提示 PM；PM 点「结束需求」时**服务端重算校验**（任务完成率 100%、未关闭阻断/严重 BUG 列表为空、遗留一般/轻微 BUG 需逐项勾选确认），通过才落 `finished` 并可推进 PlanStage 进入下一阶段。**判定逻辑必须服务端校验，不只前端拦截。**

---

## 4. 角色与角色管理（权责修正版 · 用户拍板）

> **核心权责模型（用户定调）**：计划是团队定的，**PM 负责盯里程碑、把控节奏、裁决跨角色的关键状态流转**（任务完成 / 需求结束 / 阶段推进 / 项目关闭），是这类关键状态的**唯一写入者与唯一问责者**。而**各角色是自己边界内业务数据的生产者**，对其拥有完整 CRUD 写权限——数据由生产者直写，关键状态归 PM 裁决。

### 4.1 角色清单与生产边界

| 角色 | 一句话职责 | 生产（边界内直写） |
|---|---|---|
| **项目经理 PM**（Agent） | 盯里程碑、把控进度节奏、裁决关键状态流转、汇总汇报 | 不生产业务实体，只裁决与推进 |
| **产品 PD**（Agent） | 定计划、定 PRD 交付计划、提交需求 | 计划 Plan、需求 Requirement |
| **技术经理 TL**（Agent） | 技术方案、据计划拆更细开发计划并关联需求、评审 | 开发计划 / 任务 Task（与 Dev 共建） |
| **研发 Dev**（Agent） | 写码、提交版本、处理 BUG | 任务执行、版本、BUG 处理（fixed/rejected/转交） |
| **测试 QA**（Agent） | 据需求写用例、下载版本测试、上报/创建 BUG、验收 BUG | 测试用例 TestCase、缺陷 BUG、BUG 验收关闭 |
| **人 / 用户 Human** | 需求来源与最终裁决者，最高权限 | 一切；验收/关闭终审权永远留给人 |

### 4.2 权限矩阵（按实体 × 动作）

图例：**直写** = 边界内可直接落库 / **裁决** = 归 PM 统一生效 / **申请** = 提交请求待裁决 / **读** = 只读 / **—** = 无权限

| 实体 · 动作 | PD | TL | Dev | QA | PM |
|---|---|---|---|---|---|
| Plan 创建/编辑/阶段定义 | **直写** | 读 | 读 | 读 | 读 + 推进 |
| PlanStage 阶段推进 | — | — | — | — | **裁决** |
| Requirement 创建/编辑 | **直写** | 读 | 读 | 读 | 读 |
| Requirement → finished | — | — | — | — | **裁决**（系统核验 §3.5） |
| Task 创建/拆细/关联需求 | — | **直写** | **直写** | 读 | 读 |
| Task → dev_done | — | — | **直写** | — | — |
| Task → completed | — | — | 申请 | — | **裁决** |
| TestCase 创建/编辑/执行回写 | — | 读 | 读 | **直写** | 读 |
| BUG 创建/编辑 | — | 读 | 评论 | **直写** | 读 |
| BUG → processing / fixed / rejected | — | — | **直写** | — | — |
| BUG 转交（留痕） | — | — | **直写**（免确认） | — | — |
| BUG → pending_verify 验收 | — | — | — | **直写** | — |
| **BUG → closed** | — | — | — | **直写（验收后）** | —（不可绕过 QA） |

**三条铁律**：
1. **各角色是自己实体的生产者**，边界内 CRUD 直写，无需审批——数据生产不下放审批成本。
2. **跨角色关键状态归 PM 裁决**：任务完成、需求结束、阶段推进、项目关闭。PM 是这类状态的唯一写入者与唯一问责者（避免状态撕裂、保证单一事实源、审计可归责）。
3. **BUG 关闭权归 QA**（用户明确"BUG 只有测试验收后才能关闭"）：PM/Dev 均不可绕过 QA 关闭 BUG；Dev 只能 `fixed/rejected/转交`，永远不能 `closed`。**任何 Agent 不得自干自验。**

### 4.3 主线流程（端到端）

```
① PD 创建计划 + 定义 PRD 交付计划（阶段划分）→ 提交需求 Requirement(submitted)
② TL/Dev 据计划拆更细开发计划 → 关联对应需求 → 拆为任务 Task
③ QA 访问计划内需求 → 据需求编写测试用例 TestCase
④ Dev 执行任务（todo→doing→dev_done）→ 提交版本
⑤ QA 下载版本测试 → 执行用例 → 发现缺陷创建 BUG(open)
⑥ Dev 查看 BUG → 处理：fixed（附 commit/版本）/ rejected（填理由）/ 转交责任人（前端转后端，留痕）
⑦ QA 回归验收 BUG → 通过则 closed / 失败则 reopened 重新统计
⑧ PM 裁决任务完成（dev_done→completed）
⑨ 需求下所有功能标记完成 且 阻断/严重 BUG 全部关闭（一般/轻微可遗留）
   → 系统检测 readyToFinish → PM 判需求结束(finished) → 推进 PlanStage 进入下一阶段
```

### 4.4 越权与升级机制

1. **拦截**：所有写操作过统一权限网关 `assertWrite(role, entity, action)`，越权直接拒绝并记录审计。
2. **直写 vs 裁决**：边界内实体动作为直写；关键状态流转（§4.2 标注"裁决"）一律落 `TransitionRequest`，PM approve 后才改状态。
3. **PM 裁决**：常规请求 PM 独立判断（如 Dev 申请任务完成 + QA 全绿 → 批准）。
4. **升级给人**：涉及验收/关闭、排期变更超阈值、PM 与申请方连续两轮分歧、高风险任务 → 升级挂起等人裁决，不允许 Agent 自动继续。

### 4.5 角色与 Agent 的映射（MVP 简化）

- 角色是"帽子"，权责跟着帽子走，与 Agent 实体解耦。
- **PM Agent 必须独立存在**（关键状态唯一写入者 + 审计锚点）；TL/Dev/QA/PD 可由一个通用执行 Agent **兼任**，但每次调用须显式声明当前角色，权限网关按声明角色校验。
- 演进路径：先"一 Agent 多帽子 + 强权限约束"，流程稳定后再拆独立子智能体，避免 MVP 陷入多 Agent 协调复杂度。

### 4.6 角色管理产品形态（MVP 克制）

- 内置角色模板，权限规则平台硬编码；**MVP 不开放自定义角色、不做权限编辑器**。
- 绑定：启动 Agent 会话/子智能体时选择角色，或 PM 分派任务时指定执行者角色；角色写入会话上下文与任务执行者字段。人默认存在无需绑定。
- 界面：项目设置内一张「成员与角色」表（会话 ↔ 角色 ↔ 负责范围），仅支持改绑/解绑。
- **最小闭环**：定义角色（静态配置含权限表）→ 指派（项目级角色-执行者映射）→ 权限校验（统一网关）→ 越权拦截 → 审计归责（申请人/批准人/时间/证据）。MVP 必做：定义/指派/校验/审计四环。
- **明确不做**：跨项目角色继承、字段级细粒度权限、运行时权限热更新、可视化审计界面（P1+）。

### 4.7 与信任模型的关系（两层正交叠加）

1. **角色层（Agent vs Agent）**：决定"能否发起/直写"，越权直接拦截。
2. **信任层（Agent vs 人）**：决定"是否需人确认"。Agent 的写操作在低信任等级下仍需人点确认；人的操作直达。

示例：Dev 提交"任务完成申请" → 角色层放行 → PM 裁决落库；PM 修改计划或判需求结束时若项目信任等级为低，仍弹出人确认。

---

## 5. 信任模型（贯穿全产品的根本原则）

> **把"记录"和"计算"交给 Agent，把"决策"留给人。**

- Agent 可自动**创建/更新**，但**计划立项、任务验收、风险关闭**需人确认（半自动信任模型）。
- 所有写操作**留痕可回滚**。
- 关键决策（排期调整、砍需求）永远由人拍板，Agent 只建议。
- 信息单向自动流动（执行 → 状态），决策点人工把关。
- **状态流转归口 PM**（见 §4）：PM 是唯一写入者，验收/关闭终审权永远留给人。

---

## 5. 与 IDE 现有能力的集成点

| 能力 | 集成方式 |
|---|---|
| **会话** | 任务 ↔ 会话双向绑定；会话内 `/任务` 唤起上下文；会话归档为文档 |
| **编辑器** | 任务声明关联文件，打开任务自动聚焦；Doc 即工作区文件，无独立文档编辑器 |
| **终端** | Agent 命令失败可归因任务并生成 Issue（P1） |
| **子智能体** | 任务可指派给子智能体并行执行，结果回写（P1+） |
| **左侧栏** | 替换当前"管理"段假数据脚手架，接真实五维计数与列表 |

---

## 6. MVP 范围（P0）与分期

**MVP 必须打透的一条主线**：

> 一句话想法 → Agent 拆解成任务清单 → 人确认 → Agent 执行 → 状态自动回流 → 人验收关闭 的端到端闭环。
> 全程零手工录入，人只在两个节点决策（确认计划、验收结果）。

**Aha 时刻**：用户说完一句模糊需求，看着 Agent 拆出的任务卡片逐张翻转状态（进行中→待验收），进度自己走完，全程没碰项目管理界面——**第一次"哇"出现在状态第一次自动跳变时。** 这是 P0 一切取舍的试金石：不服务于这个瞬间的功能一律让路。

| 分期 | 范围 |
|---|---|
| **P0（MVP）** | **一条需求走完全程的最小闭环**：Plan（单阶段）→ Requirement → Task → BUG（含转交链、QA 关闭门禁）+ 角色/权限网关 + TransitionRequest 归口 + Readiness 聚合。任务-会话绑定、左侧栏真实数据。存储放工作区 `.corum/project` 随 git。验证「角色写自己实体、PM 裁决关键状态、BUG 仅 QA 关闭」的权责模型。 |
| **P1** | TestCase 用例库（失败一键转 BUG）、多阶段推进、文档归档（会话→Doc）、里程碑+简单时间线、Agent 日报、任务关联 commit/分支、任务指派子智能体、软删回收站、自动 schema 迁移 |
| **P2** | 多项目管理、看板/甘特视图、燃起图/关键路径/分派建议、数据导出、多人协同与权限（开启商业化） |

**明确不做（守住轻量）**：复杂甘特图、资源负载/工时填报、多级审批流、自定义工作流引擎、多项目组合管理、权限矩阵（仅 owner/成员两级）、EVM 挣值。任何"录入成本 > 管理收益"的字段都砍。

---

## 7. 数据模型与技术架构（研发定稿）

### 7.1 实体 Schema（以需求为核心，含角色与归口）

```ts
// 时间统一 epoch ms；ID 用 nanoid
type RoleKey = 'pm' | 'pd' | 'techLead' | 'dev' | 'qa' | 'human'
type Severity = 'blocker' | 'critical' | 'major' | 'minor'  // 阻断/严重/一般/轻微

// ── 计划（PD 生产）──
interface Plan {
  id: string
  name: string
  goal?: string
  stages: PlanStage[]          // 阶段划分 = PRD 交付计划
  currentStageId?: string      // 当前阶段（PM 推进）
  ownerId: string              // PD
  status: 'active' | 'closed'
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number
}
interface PlanStage {
  id: string
  name: string
  order: number
  status: 'pending' | 'in_progress' | 'done'  // 全部 PM 裁决
}

// ── 需求（主线心脏，PD 生产）──
interface Requirement {
  id: string
  planId: string
  stageId?: string             // 关联计划阶段（可改挂下阶段）
  title: string
  description?: string
  ownerId: string              // PD
  status: 'submitted' | 'in_dev' | 'dev_done' | 'verifying' | 'finished'
  // finished 仅 PM 裁决；其余由系统派生（见 §3.5 Readiness）
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number
}

// ── 任务（TL/Dev 生产）──
interface Task {
  id: string
  planId: string
  requirementId: string        // ★ 必须关联需求
  parentTaskId?: string        // 子任务限两级
  title: string
  desc?: string
  isFeature: boolean           // 是否功能单元（参与需求完成度聚合）
  status: 'todo' | 'doing' | 'dev_done' | 'completed'  // completed 仅 PM 裁决
  priority: 0 | 1 | 2 | 3
  assigneeId: string
  assigneeRole?: RoleKey
  sessionId?: string           // 关联会话（MVP 唯一关联）
  acceptance?: string
  estimateMin?: number
  dueAt?: number
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number
}

// ── 测试用例（QA 生产，P1；P0 可降级）──
interface TestCase {
  id: string
  requirementId: string        // ★ 据需求编写
  title: string
  preconditions?: string
  steps: string
  expected: string
  priority: 0 | 1 | 2
  ownerId: string              // QA
  // 执行结果按版本维度记录于 TestRun（同用例可跨版本多次执行）
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number
}
interface TestRun {            // 一次用例执行
  id: string
  testCaseId: string
  versionId?: string           // 关联 Dev 提交的版本
  result: 'pass' | 'fail' | 'blocked'
  bugId?: string               // 失败一键转 BUG 后回链
  runBy: string
  at: number
}

// ── 缺陷（QA 创建、Dev 处理、QA 验收关闭）──
interface Bug {
  id: string
  requirementId: string        // ★ 关联需求
  taskId?: string
  testCaseId?: string          // 由用例失败一键转入时回链
  title: string
  description?: string
  reproSteps?: string
  severity: Severity
  reporterId: string           // QA
  assigneeId: string           // 当前处理人（转交即改）
  status: 'open' | 'processing' | 'fixed' | 'rejected' | 'pending_verify' | 'closed' | 'reopened'
  // fixed 须附 fixCommit/fixVersion；closed 仅 QA 验收后（PM/Dev 不可绕过）
  fixCommit?: string
  fixVersion?: string
  rejectReason?: string
  transferHistory: TransferRecord[]  // 追加只写，转交链
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number
}
interface TransferRecord {
  fromUserId: string
  toUserId: string
  reason?: string
  at: number
}

// ── 状态变更请求（关键状态归口 PM 裁决）──
interface TransitionRequest {
  id: string
  entityType: 'task' | 'bug' | 'requirement' | 'planStage'
  entityId: string
  toStatus: string
  evidence?: string            // 提交哈希 / 测试报告 / 说明
  reason?: string
  requesterId: string
  requesterRole: RoleKey
  status: 'pending' | 'approved' | 'rejected'
  decidedBy?: string
  decidedAt?: number
}

// ── 项目级角色指派表 ──
interface RoleBinding {
  projectId: string
  userId: string               // 或 sessionId（Agent）
  role: RoleKey
  sessionId?: string
  scope?: string
}

// P1 预留：TimeEvent / Doc（文档即工作区 .md 文件，实体表只存索引）
```

> **P0 切片（研发+测试对焦）**：P0 最小闭环 = Plan（单阶段即可）→ Requirement → Task → BUG（含转交链、QA 关闭门禁）+ TransitionRequest/RoleBinding + 权限网关 + Readiness 聚合。**TestCase 降级 P1**（P0 阶段 BUG 可不关联用例直接上报，QA 核心价值"上报+验收"不依赖用例库）。这样 P0 即可验证「角色写自己实体、PM 裁决关键状态、BUG 仅 QA 关闭」的核心权责模型。

### 7.2 存储

- **位置**：`<workspaceRoot>/.corum/project/{plans,tasks}.json`（P1 加 `events/issues.json`、`docs/*.md`）。
- **随 git 版本化**：项目数据与代码同源，可 diff、可 code review、可回滚；允许用户 `.gitignore`。这是"留痕可回滚"信任模型的地基。
- **写策略**：内存 store 为唯一事实源 → 写操作「先 zod 校验 → 内存改 → debounce 300ms 原子写盘（tmp + rename）」。
- **启动**：加载 + zod 全量校验；schemaVersion 不匹配**显式失败拒绝加载**（P0 不做自动迁移，P1 补迁移脚本）；坏文件备份 `.bak-<ts>`。
- **fs watcher**：监听 git HEAD / 外部改动，分支跳变时安全重载（P0 检测+只读提示，高级冲突处理 P1）。

### 7.3 架构（cordis 双包，照现有插件模式）

- **`@corum/project-core`（host 半端）**：`ctx.project` 数据服务（对齐 `ctx.sessions` 形态），CRUD + zod 校验 + 状态机 + 事件总线 + 审计日志；向 Agent 注册工具；remotes 面 `project`（`list/create/update/remove` + `subscribe`）。
- **`@corum/ui-project`（client 半端）**：接管左侧栏管理段计数 + 主区任务/计划视图（MVP 只做列表，看板 P1）。`useSyncExternalStore` 订阅快照，与 ModelSelect/sidebar 同模式。
- **并发**：Host 单进程串行写 + 乐观锁 `version`；同 version 双写，后者收明确冲突错误。

### 7.4 Agent 工具（内置 tool，不走 MCP）

> 权限模型对应 §4.2：**各角色对自己实体 CRUD 直写；关键状态流转归 PM 裁决；BUG 关闭归 QA。**

- 读：`list_plans / list_requirements / list_tasks(filter) / get_task / list_bugs / get_readiness(requirementId)`
- 写（PD）：`create_plan / update_plan / create_requirement / update_requirement`
- 写（TL/Dev）：`create_task / update_task / submit_task_done`（→dev_done 直写）/ `fix_bug(commit,version)` / `reject_bug(reason)` / `transfer_bug(toUserId,reason)`
- 写（QA）：`create_bug / verify_bug(pass)`（验收→closed / 失败→reopened）
- 写（PM，裁决）：`complete_task / finish_requirement / advance_stage`（经 TransitionRequest 裁决后生效）
- （P1）`create_testcase / run_testcase / log_issue / add_time_event / write_doc / assign_task_to_agent`
- **权限网关**：每个写工具调用携带调用者 `role` + `sessionId`，网关按 §4.2 校验——边界内直写，越权（如 Dev 调 `verify_bug`/`complete_task`）直接拦截并记审计。角色由 §4.5 指派表解析。
- **防脏数据**：所有写工具参数过 zod（枚举状态/严重度、必填 title、fixed 必填 commit+version、长度上限）；状态机在服务层强制校验（非法流转如 Dev 关 BUG、跳态必拒）；写工具返回"实际落库结果"让模型自检；证据引用须指向系统内真实对象（commit 在仓库、版本在发布列表）；验收人与修复人不得同一 Agent 身份（职责分离）；破坏性操作软删。
- **上下文成本**：按需求/任务粒度按需注入，摘要而非全文，避免挤占 token。

---

## 8. 质量门禁（测试定稿）

**P0 安全底线（不过不上线）**：

1. 写路径必经 zod 校验，非法载荷 100% 拒绝（含对抗样本：缺字段/多字段/错枚举）。
2. schemaVersion 不匹配显式失败，不静默加载。
3. **审计日志（轻量版，P0 必做）**：append-only JSONL，记录 `actor(user/agent) / diff / 时间戳 / 来源会话ID`，覆盖 100% 写操作；查询 UI/轮转放 P1。
4. 删除 = tombstone 软删；**单操作 undo** 可从审计 diff 回滚（多级历史栈 P1）。
5. 写入 = tmp + rename 原子写；**kill -9 后启动校验通过，数据不损不截断**（P0 必测）。
6. 乐观锁冲突测试通过：同 version 双写，后者被拒且先写数据完好。
7. **权限网关测试（P0 必测）**：越权直写被拦截并记审计——Dev 调 `verify_bug`/`complete_task`/`finish_requirement` 必拒；关键状态（任务完成/需求结束/阶段推进）经 PM 裁决后才生效。
8. **BUG 生命周期测试（P0 必测）**：非法流转拒绝（Dev 关 BUG、跳态、fixed 缺 commit/version）；转交链留痕完整不可篡改；QA 验收才 closed、失败 reopened 重新计入未关闭统计。
9. **需求结束误判防护（P0 必测）**：存在未关闭阻断/严重 BUG 或功能未全完成时，`finish_requirement` 服务端必拒。
10. 契约测试框架接入 CI，含最少 4 条样本（合法/缺字段/多字段/错枚举）；对抗样本库规模化放 P1。

**测试类型**：单元（实体/状态机穷举/关联约束/权限网关）、集成（RPC 全链路/崩溃恢复/并发写）、契约测试（录制 Agent 输出 + 对抗样本）、E2E（主线旅程）、故障注入（断电/磁盘满/外部改文件）。

**明确放 P1**：自动 schema 迁移、审计查询 UI、多级 undo、复杂并发拓扑/压测、对抗样本 fuzz。

---

## 9. 验收标准与成功指标

> 原则（用户拍板）：**MVP 阶段不定硬指标，以跑通主线 + 内部试用反馈为准。** 以下为方向性目标，非上线门禁。

**方向性目标**（供内部试用校准，非 KPI）：

- 用户手动录入操作相比传统 PM 工具**显著减少**（目标感受"项目管理消失了"）。
- Agent 写操作采纳率高、误操作可快速撤销。
- 单人从创建项目到首个迭代跑通**足够快**（目标 ~15 分钟内）。

**P0 验收（功能正确性，必须满足）**：

1. Agent 把计划拆成任务后，任务列表实时刷新且字段完整（标题/状态/所属 Plan）。
2. 用户在 UI 手动改任务状态走同一状态机，非法跳转被拒并给可读中文提示。
3. Agent 输出含幻觉字段时写入被拒、用户可见告警、数据未污染。
4. 写入中途强杀进程，重启后数据回退到最近一致点，无半条记录。
5. 误删任务可从审计日志查 diff 并一键恢复。

---

## 10. 落地风险与对策

| 风险 | 对策 |
|---|---|
| **定位漂移**（做成又一个看板工具） | Agent 自动化优先于人肉录入，UI 够用即可；P0 只打透一条主线 |
| **信任风险**（Agent 改错状态摧毁信任） | 关键节点人确认、所有变更留痕可回滚、审计日志 P0 兜底 |
| **上下文成本**（五维数据挤占 token） | 按任务粒度按需注入、摘要而非全文 |
| **Agent 幻觉写脏数据** | zod 入口校验 + 状态机服务层强制 + 写返回实际落库结果自检 |
| **git 共存**（分支切换数据跳变） | fs watcher 检测 + 分支 namespace 隔离 + 冲突安全重载 |
| **采纳风险**（用户已有 Jira） | 定位"开发侧最后一公里"，主打零录入，与主流 PM 工具同步而非对抗（P3） |

---

## 11. P0 工作量粗估（研发）

| 模块 | 估时 |
|---|---|
| schema + 存储层（zod / 原子写 / 迁移钩子 / 审计 / 六实体） | 2.5 人日 |
| `ctx.project` 服务 + remotes + 状态机 + 乐观锁 + **权限网关** | 3 人日 |
| **角色模型 + Readiness 聚合 + 需求结束判定** | 2 人日 |
| Agent 工具（按角色 CRUD + 裁决类）+ 校验 + 职责分离 | 2 人日 |
| 左侧栏真实计数 + 需求/任务/BUG 列表 UI + 成员角色表 | 2.5 人日 |
| 联调 + 契约测试 + 权限网关/BUG 生命周期/需求误判测试 + 崩溃恢复 | 2 人日 |
| **合计** | **约 14 人日** |

---

## 12. 决策记录（本轮对焦收敛结论）

| 分歧 | 裁决 | 理由 |
|---|---|---|
| 存储位置 | **工作区 `.corum/project` 随 git** | 数据与代码同源是"留痕可回滚"地基，可 diff/review/追溯；放 home 则成个人黑盒 |
| 任务关联代码 | **MVP 只关联会话，commit 关联放 P1** | 会话关联零成本；commit 启发式匹配准确率低反损信任，依赖 watcher 易拖入 git 边界泥潭 |
| Agent 自动化深度 | **P0 只做零录入状态同步 + 任务拆解** | 关键路径/燃起图/分派建议冷启动样本少必不准，错了摧毁可信；把"状态自动流动"一个魔法做扎实 |
| 审计日志是否进 P0 | **P0 做轻量版**（用户拍板） | 它是"留痕可回滚"唯一证据链，append-only JSONL 成本低；查询 UI 放 P1 |
| 成功指标 | **方向认可，MVP 不定硬指标**（用户拍板） | 以跑通主线 + 内部试用反馈为准，量化指标留待校准 |
| **写入权边界**（用户拍板） | **实体各角色直写，关键状态归 PM 裁决** | 各角色是自己数据的生产者，边界内 CRUD 免审批；任务完成/需求结束/阶段推进等跨角色关键状态归 PM 统一裁决，保单一问责点 |
| **需求是否独立实体**（用户拍板） | **新增「需求 Requirement」独立实体** | 需求是贯穿主线的心脏：PD 提交→Dev 关联→QA 据其写用例→功能完成且 BUG 清理才结束，独立于计划/任务存在 |
| **BUG 关闭权**（用户定调 + 主 PM 裁定） | **归 QA（验收后关闭），PM/Dev 不可绕过** | 用户明确"BUG 只有测试验收后才能关闭"；研发方案曾归 PM，测试方案归 QA，按用户原话裁定为 QA；Dev 只能 fixed/rejected/转交 |
| **BUG 清理阈值**（用户拍板） | **按严重度清零** | 阻断/严重必须全部关闭，一般/轻微可遗留（PM 关需求时确认遗留清单并带入下阶段），避免全清零拖慢节奏 |
| **BUG 转交**（用户拍板） | **研发可转交，免确认但留痕** | 前端转后端等转交由研发直写，transferHistory 追加只写记录转交链，扯皮时 PM 介入 |
| 角色映射 | **PM 独立，其余一 Agent 多帽子 + 强权限约束** | 角色是"帽子"与 Agent 解耦；MVP 不拆独立子智能体，避免多 Agent 协调复杂度 |
| 验收/关闭终审 | **永远留给人** | 人不能被 Agent 替代的问责底线；PM 初审、人终审 |
| TestCase 切片 | **P0 降级到 P1** | P0 先跑通「一条需求全程」：Plan→Requirement→Task→BUG；BUG 可不关联用例直接上报，不被用例库拖慢 |

---

*本 PRD 为 v0.3 定稿（权责修正：以需求为核心的领域模型 + 角色生产者权责 + BUG 生命周期 + 主线流程），待用户评审确认后进入 P0 开发。*
