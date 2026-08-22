# corum IDE 项目管理平台 PRD

> Agent 驱动的轻量化项目管理 · 产品需求文档
> 版本：v0.5（定稿，五方内部评审收敛） · 状态：待评审
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
submitted(PD 直写) → in_dev(系统派生) → dev_done(系统派生) → verifying(系统派生) → finished(【PM 裁决】)
```
**派生规则（P0 明确定义，服务端据此计算，不落库为独立事实源）**：
- `submitted → in_dev`：需求下出现第一个 `doing` 或 `dev_done` 的任务。
- `in_dev → dev_done`：需求下所有 `isFeature=true` 的任务都达到 `dev_done` 或 `completed`（注意：Dev 自报 dev_done 即计入，PM 裁决 completed 是更终态，二者都算"功能已做完"）。
- `dev_done → verifying`：需求下存在 BUG 活动（QA 已开始针对该需求测试，即出现过该需求关联的 BUG 或 QA 开始验收）。
- `verifying → finished`：**【PM 裁决】**，前提是 §3.5 Readiness 校验通过。
- 派生态**不写入 statusHistory**（避免任务回退导致 in_dev↔dev_done 抖动刷指标）；派生态变更不产生独立审计，仅 finished 落审计。
- **前置约束**：需求必须**挂一份生效 PRD 文档**（type=prd, status=effective）才能从 submitted 进入 in_dev（服务端在首个任务创建时校验，见 §7.4）。

**任务 Task**：`todo ↔ doing → dev_done`（**【角色直写】** Dev）；`dev_done → completed`（**【PM 裁决】**）；PM 驳回裁决时 `completed → doing`（退回 Dev 返工，记审计）。

**测试用例 TestCase（P1）**：`未执行 → 通过 / 失败 / 阻塞`（**【角色直写】** QA 按版本回写执行结果）；失败/阻塞可一键转 BUG。**P0 降级**：QA 无用例库，做探索式测试后直接建 BUG（主线③④走降级路径）。

**缺陷 BUG**（QA 创建、Dev 处理、QA 验收、关闭受控）：
```
open(QA 直写) → processing(Dev 认领 直写)
  → fixed(Dev 直写，须附 fixReleaseId)
  → rejected(Dev 直写，须填理由)
  → transferred(Dev 直写转交，落回 processing，链留痕，非独立终态)
fixed → pending_verify(QA 拉入回归 直写)
  → closed(QA 验收通过 关闭，★仅 QA，PM/Dev 均不可绕过)
  → reopened(QA 回归失败 直写，重新计入未关闭统计，回到 processing 待 Dev 再处理)
rejected → (QA 申诉) reopened(回 processing) / (QA 接受驳回) closed(QA 关闭)
```

**缺陷关闭裁决（主 PM 裁定）**：用户明确"**BUG 只有测试验收后才能关闭**"，故 **BUG 关闭权归 QA**（验收通过才关，或 QA 接受 Dev 驳回理由后关），PM 与 Dev 均不可绕过 QA 关闭；Dev 只能 `fixed/rejected/transferred`，永远不能 `closed`。**争议升级**：`rejected ↔ 申诉重开` 第二轮即自动挂起，升级 PM 仲裁；PM 与 QA 仍分歧则升级人终裁。

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
  featureTotal: number        // 需求下 isFeature=true 的任务总数
  featureCompleted: number    // 其中达 dev_done/completed 的任务数
  openBlockers: number        // severity∈{blocker,critical} 且 status∉{closed} 的 BUG 数
                            // （rejected 未关闭仍计入 openBlockers，除非 QA 已接受驳回 closed）
  readyToFinish: boolean      // featureTotal>0 && featureTotal===featureCompleted && openBlockers===0
}
```

**前置约束（防秒关漏洞）**：`featureTotal > 0`——需求下必须至少有一个功能任务，否则 `readyToFinish` 恒为 false，杜绝空需求被秒 finish。

`readyToFinish` 变 true 时推送 `requirement.ready` 事件提示 PM；PM 点「结束需求」时**服务端重算校验**（featureTotal>0、任务完成率 100%、未关闭阻断/严重 BUG 列表为空、遗留一般/轻微 BUG 需逐项勾选确认），通过才落 `finished` 并可推进 PlanStage 进入下一阶段。**判定逻辑必须服务端校验，不只前端拦截。**

---

## 3.6 文档治理（唯一性 · 集中管理 · 评审可追溯 · 用户指定新增）

> **核心诉求（用户定调）**：项目公共文档（PRD、技术方案、关键决策 ADR、项目记忆）必须保证**唯一性、杜绝碎片化、集中维护管理**；文档的产出/更新/修改要有**评审决策可追溯**。此前 Agent 各自维护同主题文档导致版本打架，必须根治。

### 3.6.1 文档分类与唯一性定义

| 类别 | 文档 | 唯一性约束 |
|---|---|---|
| **SSOT 文档（强制唯一）** | PRD、技术方案、ADR 目录、项目记忆 | **同一项目 + 同一类型 + 同一主题键下，全项目仅一份"当前生效"文档**，后续一律就地更新，禁止另起新文件 |
| 多份文档（自由） | 调研草稿、会议记录、个人笔记 | 仅放草稿区，无唯一性约束，**不被主线当权威引用** |

ADR 特殊：单个决策一份（追加式），"ADR 目录索引"唯一；同主题决策被推翻时旧 ADR 置 `superseded` 并指向新 ADR，而非改内容。

### 3.6.2 防碎片化机制（写入入口拦截，非事后清理）

- **文档注册表 `documents`**：`{ doc_id, type, subject_key, status, path, version, linked_entities, owner_role, updated_by, updated_at }`。
- **唯一键强校验**：`(project_id, type, subject_key, status=生效)` 唯一，重复写入直接拒绝并返回既有文档 ID。
- **先查后写协议（Agent 硬约束）**：产出 SSOT 文档前必须先 `doc.resolve(type, subject)`——存在生效文档则只能 `update`（就地改，状态回"评审中"）；不存在才允许 `create`（系统按规范发号注册）。**Agent 不得自造路径/自搜文件**。
- **命名即唯一键物化**：`docs/{prd,design,adr,memory}/<类型前缀>-<编号>-<slug>.md`，编号注册表发号；草稿区 `docs/drafts/` 不注册。

### 3.6.3 文档生命周期与关联

- **状态机**：`草稿 → 评审中 → 已生效 → 已废弃/已被取代`。只有 `已生效` 版本可被需求/任务/BUG 引用、被其他 Agent 当权威读取。
- **生效确认制（轻量，不开评审会）**：PRD 需 **PD+PM 双确认**生效；技术方案需 TL 确认；ADR 提议者 + PM 确认生效后**锁定**；项目记忆生产者直写即生效、TL 定期固化。确认动作落 changelog（`op=confirm`），即"评审记录"本身。
- **与主线关联**：PRD↔需求（需求确认前须挂生效 PRD）；技术方案↔需求/阶段（任务派生时自动注入）；ADR 可被任意实体挂载（解释"为什么这么定"）；项目记忆全项目唯一、所有 Agent 会话默认注入（摘要版）。
- **项目记忆 PROJECT.md**：项目级长期上下文（技术选型/历史踩坑/规范/不可重做决策），任务完结时 Agent 输出"记忆候选"沉淀，启动任务时注入生效部分——跨会话的集体记忆。

### 3.6.4 评审决策可追溯（内容 hash 锚定 · changelog 管"谁/为何/依据"）

- **变更日志 `doc-changelog.jsonl`（append-only，复用审计设施）**：每次产出/更新/修改落一条
  `{ docId, seq, contentHash, op: create|revise|deprecate|confirm, actor, role, at, basis, summary, sessionId }`。
- **锚点用"写入序号 + 内容 hash"，不用 git rev**：平台只管写文件、不管 git commit——写入时该改动的 git rev 根本不存在，锚 git rev 会永远锚到上一个无关 commit（研发评审指出的硬伤）。内容 hash 由平台写后自算，引用锁以 hash 比对"当时内容 vs 当前内容"。
- **`basis`（评审/决策依据）必填**——无依据的修改：ADR 类直接拒绝，PRD 类降级为草稿态。**这是追溯的核心**。
- **ADR 只增不改**：生效后写工具拒绝 `revise`，只允许追加新 ADR（`supersedes`）或置旧 ADR `superseded`（附新号+原因）。决策链即链表，正查演进史、反查影响面；changelog 序列 + 内容 hash 双保险防篡改。
- **引用锁版本**：需求/任务关联文档时记录 `docId@contentHash`（当时生效的内容 hash），可比对"当时内容 vs 当前内容"；需求结束时 PM 校验引用文档是否仍生效。
- **变更联动（P1）**：PRD 修订时经事件总线通知关联需求的责任角色会话，注入"已修订，依据 X，请核对"摘要。
- **与 git 分工**：git 管内容 diff/blame/回滚（平台绝不重做）；平台管 git 不知道的三件事——业务依据 basis、生效状态机、跨实体联动。

### 3.6.5 文档 MVP 切片（P0 回收，评审收敛）

- **P0（仅唯一性底座三件套）**：文档注册表 + `(type, subjectKey)` 唯一键强校验 + `resolve→create/update` 先查后写协议。**就这么三件**——守住"不碎片化"底线即可。
- **P1**：命名规范强制、生效确认制（frontmatter 状态 + 双签）、changelog（basis 必填）、ADR 只增不改与 supersedes 链、引用锁 contentHash、任务领取时关联文档注入、项目记忆注入、草稿区入库扫描。
- **明确不做**：评审会/评审单实体、多级审批流、在线协同编辑、文档全文检索、双轨版本存储。

> **为什么 P0 只留三件套（评审收敛）**：v0.4 把完整文档治理塞进 P0 导致范围膨胀。实际上"一条需求走全程"的主线只强依赖"文档不重复"这一件事；评审追溯、引用锁、记忆注入都是增强，主线跑通后再上。项目记忆 P0 可先以"普通工作区文件 + Agent 自行读取"过渡，不进注册表。

---

## 4. 角色与角色管理（权责修正版 · 用户拍板）

> **核心权责模型（用户定调）**：计划是团队定的，**PM 负责盯里程碑、把控节奏、裁决跨角色的关键状态流转**（任务完成 / 需求结束 / 阶段推进 / 项目关闭），是这类关键状态的**唯一写入者与唯一问责者**。而**各角色是自己边界内业务数据的生产者**，对其拥有完整 CRUD 写权限——数据由生产者直写，关键状态归 PM 裁决。

### 4.1 角色清单与生产边界

| 角色 | 一句话职责 | 生产（边界内直写） |
|---|---|---|
| **项目经理 PM**（Agent） | 盯里程碑、把控节奏、裁决关键状态、协调与上报 | 不生产业务实体；可评论/标阻塞/建 Issue/提交版本 |
| **产品 PD**（Agent） | 定计划、定 PRD 交付计划、提交需求、排需求优先级 | 计划 Plan、需求 Requirement、PRD 文档 |
| **技术经理 TL**（Agent） | 技术方案、据计划拆开发计划并关联需求、**指派任务**、评审 | 开发计划 / 任务 Task（与 Dev 共建）、技术方案文档 |
| **研发 Dev**（Agent） | 写码、提交版本、处理 BUG | 任务执行、版本 Release、BUG 处理（fixed/rejected/转交） |
| **测试 QA**（Agent） | 据需求测试、下载版本、上报/创建 BUG、验收 BUG | 测试用例 TestCase(P1)、缺陷 BUG、BUG 验收关闭 |
| **人 / 用户 Human** | 需求来源与最终裁决者，最高权限 | 一切；验收/关闭终审权永远留给人 |

### 4.2 权限矩阵（按实体 × 动作）

图例：**直写** = 边界内可直接落库 / **裁决** = 归 PM 统一生效 / **申请** = 提交请求待裁决 / **读** = 只读 / **—** = 无权限

| 实体 · 动作 | PD | TL | Dev | QA | PM |
|---|---|---|---|---|---|
| Plan 创建/编辑/阶段定义 | **直写** | 读 | 读 | 读 | 读 + 推进 |
| PlanStage 阶段推进 | — | — | — | — | **裁决** |
| Requirement 创建/编辑/排优先级 | **直写** | 读 | 读 | 读 | 读 |
| Requirement 变更/废弃(in_dev 后) | 申请(升人确认) | — | — | — | **裁决** |
| Requirement → finished | — | — | — | — | **裁决**（系统核验 §3.5） |
| Task 创建/拆细/关联需求 | — | **直写** | **直写** | 读 | 读 |
| **Task 指派/改派(assignee)** | — | **直写** | 申请 | — | **直写(改派)** |
| Task → dev_done | — | — | **直写** | — | — |
| Task → completed | — | — | 申请 | — | **裁决** |
| Release 提交版本 | — | — | **直写** | 读 | **直写** |
| TestCase 创建/编辑/执行回写(P1) | — | 读 | 读 | **直写** | 读 |
| BUG 创建/编辑 | — | 读 | 评论 | **直写** | 读 + 标阻塞 |
| BUG → processing / fixed / rejected | — | — | **直写** | — | — |
| BUG 转交（留痕） | — | — | **直写**（免确认） | — | — |
| BUG → pending_verify 验收 | — | — | — | **直写** | — |
| **BUG → closed** | — | — | — | **直写（验收/接受驳回后）** | —（不可绕过 QA） |
| 全实体 评论 / 标阻塞 / 建 Issue | 直写 | 直写 | 直写 | 直写 | **直写** |

**三条铁律**：
1. **各角色是自己实体的生产者**，边界内 CRUD 直写，无需审批——数据生产不下放审批成本。
2. **跨角色关键状态归 PM 裁决**：任务完成、需求结束、阶段推进、需求变更(in_dev 后)、项目关闭。PM 是这类状态的唯一写入者与唯一问责者（避免状态撕裂、保证单一事实源、审计可归责）。
3. **BUG 关闭权归 QA**（用户明确"BUG 只有测试验收后才能关闭"）：PM/Dev 均不可绕过 QA 关闭 BUG；Dev 只能 `fixed/rejected/转交`，永远不能 `closed`。**任何 Agent 不得自干自验。**

> **需求变更管控（与信任模型一致）**：需求进入 in_dev 后，PD 的编辑/废弃不再是自由直写——走 TransitionRequest 且**强制升级人确认**（砍需求/改需求永远由人拍板），变更经事件总线联动通知关联任务/BUG 的责任角色。

### 4.3 主线流程（端到端）

```
① PD 创建计划 + 定义 PRD 交付计划（阶段划分）→ 提交需求 Requirement(submitted)
   【P0 门禁：需求进 in_dev 前须挂生效 PRD 文档】
② TL 据计划拆更细开发计划 → 关联对应需求 → 拆为任务 Task 并指派(assignee)
③ QA 访问计划内需求【P0 降级：无用例库，探索式测试】
④ Dev 执行任务（todo→doing→dev_done）→ 提交版本 Release
⑤ QA 下载 Release 测试 → 发现缺陷创建 BUG(open)
⑥ Dev 查看 BUG → 处理：fixed（附 fixReleaseId）/ rejected（填理由）/ 转交责任人（前端转后端，留痕）
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
| **P0（MVP）** | **一条需求走完全程的最小闭环**：Plan（单阶段）→ Requirement → Task → BUG（含转交链、QA 关闭门禁）+ 角色/权限网关 + TransitionRequest 归口 + Readiness 聚合。**文档底座**：注册表 + 唯一键 + 先查后写 + changelog（basis 必填）+ ADR 只增不改 + 项目记忆注入。**看板底座**：`statusHistory` 全量埋点 + 顶部 4 卡片 + 4 条机制趋势线。任务-会话绑定、左侧栏真实数据。存储放工作区 `.corum/project` 随 git。 |
| **P1** | TestCase 用例库（失败一键转 BUG）、多阶段推进、完整评审流与变更通知、版本对比 UI、里程碑+简单时间线、Agent 日报、任务关联 commit/分支、任务指派子智能体、看板效能对比表与分布图、离线按天快照、软删回收站、自动 schema 迁移 |
| **P2** | 多项目管理、看板/甘特视图、燃起图/关键路径/分派建议、数据导出、多人协同与权限（开启商业化） |

**明确不做（守住轻量）**：复杂甘特图、资源负载/工时填报、多级审批流、自定义工作流引擎、多项目组合管理、权限矩阵（仅 owner/成员两级）、EVM 挣值。任何"录入成本 > 管理收益"的字段都砍。

---

## 6.5 项目看板（为优化机制沉淀数据 · 用户指定新增）

> **核心定位（用户定调）**：看板的首要目的不是"给人看进度"，而是**沉淀数据、作为未来优化这套 Agent 驱动项目管理机制的核心依据**——用数据回答"这套机制运转得好不好、哪里要优化"。因此指标设计以"机制运转"为核心，兼顾"项目健康"与"Agent 效能"。

### 6.5.1 三层数据视角

**a. 项目健康视角（给人看，了解项目状态）**

| 指标 | 定义 | 机制优化价值 |
|---|---|---|
| 里程碑进度 | 当前阶段任务完成数/总数 + 距截止 | 判断 PM 排期与 Agent 产能是否匹配 |
| 需求完成度 | 各状态需求数堆叠（submitted→in_dev→dev_done→verifying→finished） | 定位流程瓶颈环节 |
| 任务四象限 | todo/doing/dev_done/completed 分布 | dev_done 堆积 = 裁决瓶颈信号 |
| BUG 分布 | 严重度 × 状态矩阵 | 阻断/严重 BUG 是否按"需求结束门槛"收敛 |

**b. 机制运转视角（核心！用于优化 Agent 机制）**

| 指标 | 定义 | 价值 |
|---|---|---|
| **需求周期时长** | submitted→finished 耗时分布（P50/P90） | 衡量整体流转效率，对比人工基线 |
| **裁决等待时长** | dev_done→PM 裁决 completed 耗时 | **最直接暴露"人等 Agent / Agent 等裁决"的堵点** |
| **BUG 修复周期** | open→closed 时长（按严重度分层） | 验证"阻断严重清零"门槛可行性 |
| **BUG 重开率** | reopened 次数 / closed 总数 | 修复质量差的量化证据 → 优化 Dev Agent 提示词/测试覆盖 |
| **转交次数分布** | 每任务平均 handoff 次数 + 长尾 TOP10 | 转交过多 = 权责切分或上下文传递有问题 |
| **Agent 驳回/越权拦截率** | 被拒写操作 / 总写请求（按角色×操作分桶） | **权限模型过紧/过松的直接依据** |
| **裁决平均时长** | TransitionRequest submit→approve/reject 耗时 | 评估是否需自动裁决/降级策略 |
| **需求一次通过率** | 无返工直接 finished 的需求占比 | 机制端到端质量综合分 |

**c. Agent 效能视角（评估各角色 Agent 表现）**

| 指标 | 定义 | 价值 |
|---|---|---|
| Dev 一次验收通过率 | fixed 后 QA 首次 pass 占比 | Dev Agent 产出质量 → 优化编码/自测策略 |
| QA BUG 有效率 | 有效 BUG / 总上报（误报率 = 1−有效率） | QA Agent 误报噪音 → 校准报 BUG 阈值 |
| PM 裁决及时率 | 24h 内完成裁决占比 | 裁决环节是否成瓶颈 |
| 准确返工率 | 裁决 reject 后确实产生有效返工的比例 | 防 PM Agent 误判造成空转 |
| 各角色产出量 | 按周期统计任务完成数/BUG 关闭数 | 产能基线，用于排期校准 |

### 6.5.2 展示形态（轻量）

- **项目健康**：顶部状态卡片（里程碑倒计时 / 需求完成率 / dev_done 待裁决数+最长等待 / 阻断严重 BUG 数）+ 需求燃起图 + BUG 严重度×状态热力矩阵。**P0**。
- **机制运转**：核心指标趋势线图（需求周期 / 裁决等待 / 重开率 / 驳回率，按周）+ 时长分布直方图（标 P50/P90）。趋势线 **P0**，分布图 **P1**。
- **Agent 效能**：角色 × 指标对比表（可排序）+ 单角色下钻。**P1**（P0 只放"一次通过率"总榜）。

### 6.5.3 数据采集（不另起炉灶）

- 指标全部由**已有的审计日志 + 实体状态流转时间戳**派生。
- 实体加 `statusHistory: [{ status, at, by }]`（或独立流转表），每次状态变更追加——所有周期/等待/转交/重开指标由此计算。
- 审计日志字段（actor/action/target/result: approved/rejected/blocked）直接支撑驳回率/越权拦截率/裁决时长。
- **P0 实时/近实时派生**：读模型按实体增量维护聚合（流转事件触发更新），无需离线数仓；**P1+ 离线按天快照**支撑优化前后 A/B 对比。

### 6.5.4 看板 MVP 切片（P0 只落埋点，评审收敛）

**P0 只做一件事：全量落 `statusHistory` 埋点，不出任何图表。** 界面可后加，数据从第一天开始沉淀——冷启动阶段样本量撑不起趋势线与 P50/重开率，过早出图是空图反损质感。

- **P0**：`statusHistory`（或独立流转表）全量埋点 + 审计日志（actor/action/target/result）。指标读取接口预留，但无 UI。
- **P1**：顶部 4 卡片（当前阶段+里程碑倒计时、需求完成率、dev_done 待裁决数+最长等待、阻断严重 BUG 数）、需求燃起图 + BUG 矩阵、机制运转 4 条趋势线（需求周期/裁决等待/重开率/驳回率）。
- **P2**：Agent 效能对比表、时长分布直方图（P50/P90）、离线按天快照 A/B 对比。

**原则**：P0 把数据埋点做扎实（这是后续一切优化的地基），图表等数据攒够了再上。

---

## 7. 数据模型与技术架构（研发定稿）

### 7.1 实体 Schema（以需求为核心，含角色与归口）

```ts
// 时间统一 epoch ms；ID 用 nanoid
type RoleKey = 'pm' | 'pd' | 'techLead' | 'dev' | 'qa' | 'human'
type Severity = 'blocker' | 'critical' | 'major' | 'minor'  // 阻断/严重/一般/轻微

// ── 项目（隔离单元，一个工作区可多个）──
interface Project {
  id: string
  name: string
  schemaVersion: number        // §7.2 迁移钩子
  releaseStore: {              // Release 内容存储位置（用户可配，为 CI/CD 预留）
    kind: 'local' | 'remote'   // 本地目录 / 线上（P1+ 接 CI/CD 产物仓）
    uri: string                // local: 工作区内路径；remote: URL
  }
  createdAt: number
}

// ── 计划（PD 生产）──
interface Plan {
  id: string
  projectId: string
  name: string
  goal?: string
  stages: PlanStage[]          // 阶段（里程碑）划分，由 PD 在 PRD 交付计划中定义
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
  dueAt?: number               // 阶段截止（看板里程碑倒计时用）
  status: 'pending' | 'in_progress' | 'done'  // 全部 PM 裁决（走 TransitionRequest，entityType=planStage）
}

// ── 版本（Dev 提交、QA 下载测试；存储位置随 Project.releaseStore 可配）──
interface Release {
  id: string
  projectId: string
  name: string                 // 如 v0.3.0 / build-128
  ref: string                  // 对应 git commit/tag（服务端校验真实存在）
  storeUri: string             // 产物实际位置（本地路径或线上 URL，由 releaseStore 解析）
  note?: string
  createdBy: string            // Dev/PM
  createdAt: number
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
  requirementId: string        // ★ 必须关联需求（删除需求时若有下游引用则拒绝，防悬挂）
  parentTaskId?: string        // 子任务限两级
  title: string
  desc?: string
  isFeature: boolean           // 是否功能单元（参与需求完成度聚合）
  status: 'todo' | 'doing' | 'dev_done' | 'completed'  // completed 仅 PM 裁决
  priority: 0 | 1 | 2 | 3      // TL 排任务优先级；需求优先级由 PD 排
  assigneeId: string           // TL 指派 / PM 改派
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
  // fixed 须附 fixReleaseId（指向真实 Release）；closed 仅 QA 验收/接受驳回后（PM/Dev 不可绕过）
  fixReleaseId?: string
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

// ── 文档注册表（§3.6，SSOT 唯一性 + 评审追溯）──
type DocType = 'prd' | 'design' | 'adr' | 'memory'
type DocStatus = 'draft' | 'reviewing' | 'effective' | 'deprecated' | 'superseded'
interface DocEntry {
  docId: string
  type: DocType
  subjectKey: string           // 主题键；(projectId,type,subjectKey,status=effective) 唯一
  status: DocStatus
  path: string                 // 工作区内规范路径（命名即唯一键物化）
  semver?: string              // 语义号 v1.3（区别于乐观锁 version）
  contentHash?: string         // 当前内容 hash（引用锁用，见 §3.6.4）
  linkedEntities?: string[]    // 关联需求/任务/BUG 的 id
  ownerRole: RoleKey
  supersedes?: string          // ADR 链：指向被取代的旧 docId
  updatedBy: string
  updatedAt: number
}
// 文档变更日志（append-only，basis 必填；内容 hash 锚点，因平台不管 git commit）
interface DocChange {
  docId: string
  seq: number                  // 写入序号
  contentHash: string          // 写入后内容 hash（引用锁以此比对，见 §3.6.4）
  op: 'create' | 'revise' | 'deprecate' | 'confirm'
  actor: string
  role: RoleKey
  at: number
  basis: string                // 评审/决策依据（必填，追溯核心）
  summary?: string
  sessionId?: string
}

// ── 状态流转历史（§6.5 看板度量埋点，实体均带）──
interface StatusTransition {
  status: string
  at: number
  by: string                   // actor（user/agent sessionId）
}

// P1 预留：TimeEvent；Doc 内容即工作区 .md 文件（git 版本化），注册表只存索引
```

> **P0 切片（研发+测试对焦）**：P0 最小闭环 = Plan（单阶段即可）→ Requirement → Task → BUG（含转交链、QA 关闭门禁）+ TransitionRequest/RoleBinding + 权限网关 + Readiness 聚合。**TestCase 降级 P1**（P0 阶段 BUG 可不关联用例直接上报，QA 核心价值"上报+验收"不依赖用例库）。这样 P0 即可验证「角色写自己实体、PM 裁决关键状态、BUG 仅 QA 关闭」的核心权责模型。

### 7.2 存储

- **位置**：`<workspaceRoot>/.corum/project/<projectId>/`，**每实体一文件**：
  `plan.json / requirements.json / tasks.json / bugs.json / releases.json / documents.json / role-bindings.json`，加 append-only `audit.jsonl`（审计）、`doc-changelog.jsonl`（P1）、`transitions.jsonl`（P1 或并入 audit）。文档内容在工作区 `docs/` 下（.md，随 git）。
- **每实体一文件的理由**：六实体挤一两个文件必在高频写下打架；每实体一文件 + 独立乐观锁，写冲突域最小。
- **随 git 版本化**：项目数据与代码同源，可 diff、可 code review、可回滚；允许用户 `.gitignore`（见下"多分支与降级"）。这是"留痕可回滚"信任模型的地基。
- **写策略**：内存 store 为唯一事实源 → 写操作「先 zod 校验 → 内存改 → debounce 300ms 原子写盘（tmp + rename）」。**写顺序：先写 audit.jsonl 后写实体文件**；启动时对账（实体领先于审计则告警并补录），避免 kill -9 落在两写之间导致"实体已改、审计未落"。
- **启动**：加载 + zod 全量校验 + **引用完整性校验**（Task.requirementId / Bug.requirementId 指向的实体须存在，悬挂引用报错或标记）；schemaVersion 不匹配**显式失败拒绝加载**（P0 不做自动迁移，P1 补迁移脚本）；坏文件备份 `.bak-<ts>`。
- **fs watcher**：监听 git HEAD / 外部改动；需 **echo 抑制**（平台自身写盘触发的 watcher 事件不重载）。

#### 多分支与降级语义（用户拍板：参考 Gerrit）

**协作模型（Gerrit 式）**：不同开发者/Agent 在各自**本地分支**工作；项目数据随工作区分支走；最终**基于线上基准分支 commit 后进入审核**（review）。项目平台不在多分支间做实时合并，而是：

- **单分支正确性**：平台只承诺在**当前检出的单一分支**上数据一致。分支切换（git HEAD 变化）时：平台**冻结写入**（只读 + 明确提示"已切换分支，项目数据已随分支切换"），重新加载该分支的 `.corum/project/` 快照后恢复可写。Agent 正在跑任务时遇分支切换 → 挂起该任务的写操作并提示，不强行落盘。
- **merge 冲突收敛**：审核合并到基准分支时，若两分支各自创建了同 `(type, subjectKey)` 的生效文档或同 id 实体，按"**先到先得（基准分支优先）+ 后到的自动 `deprecated`/`superseded`**"收敛，并在 changelog 记录合并裁决。JSONL（audit/changelog）按行合并（append-only 天然可并，重复行按 seq+contentHash 去重）。
- **降级（`.gitignore` 或无 git）**：用户把 `.corum/` 加入 `.gitignore` 或工作区非 git 仓时，项目数据退化为"本地唯一副本"——平台照常工作，但**失去随 git 的 diff/review/跨机同步**，UI 明确提示"项目数据未版本化，仅存于本机"。

### 7.3 架构（单插件 · 两半端分包 —— 方案 B，用户拍板）

> **架构决策（方案 B）**：项目管理平台是**逻辑上的一个插件功能**，物理上拆为 **`@corum/project-core`（host 半端）+ `@corum/ui-project`（client 半端）两个包**。这不是"多个插件"，而是 corum/cordis 的标准插件形态（一个完整插件 = host 半端 + client 半端），与现有插件（模型选择器、会话栏、插件中心）同构。
>
> **为什么拆 core / ui 两个包（而非合一）**：`project-core` 的 `ctx.project` 数据服务与 Agent 工具是**平台级能力**——不只 UI 用，PM Agent、其他插件（如未来的会话联动、状态栏统计）都要读写项目数据，独立成包便于复用与单独演进；`ui-project` 只负责渲染，可独立迭代。在插件中心它们作为一个功能整体呈现与管理。

- **`@corum/project-core`（host 半端，平台级数据服务）**：`ctx.project` 数据服务（对齐 `ctx.sessions` 形态），CRUD + zod 校验 + 状态机 + 权限网关 + Readiness 聚合 + 事件总线 + 审计日志；向 Agent 注册工具；remotes 面 `project`（`list/create/update/remove` + `subscribe`）。**不依赖 UI，可被任意插件/Agent 调用。**
- **`@corum/ui-project`（client 半端，纯渲染）**：左侧栏管理段菜单（6 项）+ 区域切换（开发态/管理态）+ 6 个看板视图 + 详情抽屉 + 空态引导。`useSyncExternalStore` 订阅 `ctx.project` 快照，与 ModelSelect/sidebar 同模式。**只读数据 + 调 remotes，不持有业务逻辑。**
- **并发**：Host 单进程串行写 + 乐观锁 `version`；同 version 双写，后者收明确冲突错误。

### 7.4 Agent 工具（内置 tool，不走 MCP）

> 权限模型对应 §4.2：**各角色对自己实体 CRUD 直写；关键状态流转归 PM 裁决；BUG 关闭归 QA。**

- 读：`list_plans / list_requirements / list_tasks(filter) / get_task / list_bugs / list_releases / get_readiness(requirementId)`
- 写（PD）：`create_plan / update_plan / create_requirement / update_requirement`（in_dev 后变更走裁决 + 升人确认）
- 写（TL/Dev）：`create_task / update_task / assign_task(assigneeId)` / `submit_task_done`（→dev_done）/ `create_release(name,ref,note)` / `fix_bug(releaseId)` / `reject_bug(reason)` / `transfer_bug(toUserId,reason)`
- 写（QA）：`create_bug / verify_bug(pass)`（验收→closed / 失败→reopened）
- 写（PM，裁决）：`complete_task / finish_requirement / advance_stage`（经 TransitionRequest 裁决后生效；PM 自身的推进/改派/评论/标阻塞为直写）
- （P1）`create_testcase / run_testcase / log_issue / add_time_event / write_doc / assign_task_to_agent`
- **权限网关**：每个写工具调用按 §4.2 校验——边界内直写，越权（如 Dev 调 `verify_bug`/`complete_task`/`finish_requirement`）直接拦截并记审计。
- **⚠ 调用者身份（role）判定 · 暂缓（用户拍板，开发阶段讨论）**：权限网关要真正成立，role **必须由服务端从 sessionId 反查 RoleBinding 得出，严禁作为工具参数由模型自报**（否则兼任 Agent 声明 `role:'pm'` 即可自裁决，网关形同虚设）；且"验收人≠修复人"的职责分离须绑定到**不同 session**。这要求 DSH 核心在 Agent 工具调用管线（`ToolExecution`）可信注入调用者身份——属于对 DSH 核心 Agent 能力的改造，**P0 先在网关接口预留 `resolveCaller(sessionId)` 注入点、默认按声明放行并全量审计，改造方案在开发阶段与 DSH 核心一并讨论定**。
- **防脏数据**：所有写工具参数过 zod（枚举状态/严重度、必填 title、fixed 必填 releaseId、长度上限）；状态机在服务层强制校验（非法流转如 Dev 关 BUG、跳态必拒）；写工具返回"实际落库结果"让模型自检；证据引用须指向系统内真实对象（`releaseId` 须在 releases 表、`ref` 须在 git 仓库真实存在且晚于 BUG 创建时间）；验收人与修复人不得同一身份（待身份注入落地后强制）；破坏性操作软删。
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
10. **文档唯一性测试（P0 必测）**：同 `(type, subjectKey)` 重复创建生效文档必拒并返回既有 ID；Agent 未走 `resolve` 直造路径必拒。
11. **ADR 不可篡改测试（P0 必测）**：生效 ADR 的 `revise` 必拒；`supersedes` 链正确建立且旧 ADR 置 `superseded`。
12. **文档追溯测试（P0 必测）**：缺 `basis` 的 ADR 修改必拒、PRD 降级草稿；changelog 每条含 actor/role/at/basis/rev。
13. 契约测试框架接入 CI，含最少 4 条样本（合法/缺字段/多字段/错枚举）；对抗样本库规模化放 P1。

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

**主线 E2E（可脚本化，过则算"跑通主线"）**：一句话立项 → PD 建计划+提交需求 → TL 拆任务并指派 → Dev 执行+提交 Release → QA 下载 Release 建 BUG → Dev fixed（附 releaseId）→ QA 验收 closed → PM 裁决任务 completed → Readiness 达标 → PM 判需求 finished。全程断言：各状态正确、审计记录齐备、权限拦截生效。

**单项**：

1. Agent 把计划拆成任务后，任务列表实时刷新且字段完整（标题/状态/所属需求/指派人）。
2. 用户在 UI 手动改任务状态走同一状态机，非法跳转被拒并给可读中文提示。
3. Agent 输出含幻觉字段时写入被拒、用户可见告警、数据未污染。
4. `fix_bug` 不带真实 `releaseId`（或 ref 在 git 不存在）时被拒。
5. 写入中途强杀进程，重启后数据回退到最近一致点、无半条记录、引用完整（无悬挂）。
6. 误删任务可从审计日志查 diff 并一键恢复；删除有下游引用的需求被拒。
7. 空需求（无功能任务）或存在未关闭阻断/严重 BUG 时，`finish_requirement` 服务端必拒。

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
| schema + 存储层（七实体+Release / 每实体一文件 / 原子写 / 写序对账 / 引用完整性 / 审计） | 3 人日 |
| `ctx.project` 服务 + remotes + 状态机 + 乐观锁 + **权限网关**（role 注入点预留） | 3 人日 |
| **角色模型 + Readiness 聚合 + 需求派生规则与结束判定** | 2 人日 |
| **文档唯一性底座**（注册表 + 唯一键 + 先查后写） | 1 人日 |
| Agent 工具（按角色 CRUD + 裁决类 + Release）+ 校验 | 2 人日 |
| **看板埋点**（statusHistory 全量，无 UI） | 0.5 人日 |
| 左侧栏真实计数 + 需求/任务/BUG/Release 列表 UI + 成员角色表 | 2.5 人日 |
| 联调 + 契约测试 + 权限网关/BUG 生命周期/需求误判/引用完整性测试 + 崩溃恢复 | 2 人日 |
| **合计** | **约 16 人日** |

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
| **文档唯一性**（用户指定） | **注册表 + (type,subjectKey) 唯一键 + 先查后写协议** | SSOT 文档（PRD/技术方案/ADR/项目记忆）同主题全项目唯一一份，就地更新；碎片化在写入入口拦截而非事后清理 |
| **文档评审追溯**（用户指定） | **git 管 diff，changelog 管"谁/为何/依据"，生效确认制** | `basis` 必填是追溯核心；ADR 只增不改 + supersedes 链；不做重型评审工作流/评审单实体 |
| **看板定位**（用户指定） | **以为优化机制沉淀数据为核心，三层视角** | 项目健康/机制运转/Agent 效能；机制运转视角（裁决等待/重开率/驳回率/周期时长）是优化 Agent 机制的直接依据；P0 先落 statusHistory 埋点 |

---

## 13. v0.5 评审收敛记录（五方内部评审 + 用户拍板）

五方（产品/项管/PDT/研发/测试）对 v0.4 做了一轮内部评审，识别出 10 处硬伤，经用户拍板后收敛为 v0.5：

| 评审硬伤 | 裁决（用户拍板 / 主 PM 收敛） |
|---|---|
| **P0 范围膨胀**（文档治理+看板塞入，估算冻结） | **大幅回收 P0 只留主线**：文档砍到「注册表+唯一键+先查后写」三件套；看板只落 statusHistory 埋点不出图；其余全 P1 |
| **"版本"实体缺失** | **P0 建最小 Release 实体**，且 `releaseStore` 存储位置用户可配（本地/线上），为后续 CI/CD 预留 |
| **role 由模型自报 = 权限网关伪命题** | **暂缓**：role 须服务端从 sessionId 反查、职责分离绑定不同 session，涉及 DSH 核心工具管线改造，P0 预留 `resolveCaller` 注入点、默认放行+全量审计，开发阶段与 DSH 核心一并讨论 |
| **git 多分支撕裂** | **参考 Gerrit**：本地分支工作、基于线上基准 commit 后审核；平台承诺单分支正确性（切分支冻结写入+重载），merge 冲突按"先到先得+后到 deprecate"收敛，JSONL 按行合并去重，`.gitignore` 降级为本地副本并提示 |
| **需求派生规则全缺** | 补派生规则表（in_dev/dev_done/verifying 触发条件），派生态不落库、不进 statusHistory，仅 finished 落审计 |
| **需求结束漏洞** | 补前置约束 `featureTotal>0`（防空需求秒关）；rejected BUG 仍计入 openBlockers（除非 QA 接受驳回 closed） |
| **任务指派权真空** | 补 Task 指派权：TL 直写指派、PM 直写改派 |
| **PM 只读无手段** | PM 开放全实体评论/标阻塞/建 Issue/提交 Release 直写权 |
| **git rev 锚点空话** | 改用"写入序号 + 内容 hash"锚定（平台不管 git commit） |
| **状态机边未定义 / 悬挂引用 / 双写一致性** | 补状态转移边（rejected→reopened/closed、reopened→processing）；删除有下游引用实体必拒 + 启动引用完整性校验；写序"先审计后实体"+启动对账 |
| **需求变更与信任模型矛盾** | in_dev 后需求变更/废弃走 TransitionRequest + 强制升人确认 |

---

*本 PRD 为 v0.5 定稿（五方内部评审收敛：P0 大幅回收主线 + Release 实体 + 需求派生规则 + 权限矩阵补全 + git Gerrit 语义 + 身份注入暂缓标注），待用户评审确认后进入 P0 开发。*
