# PLAN — task 模式 UI 适配（回归官方 sessions 对象层）

> **用途**：task 模式侧栏/对话区从「以为要自建泳道对象层」转为「回归官方对象层 + UI 适配」
> 的执行方案。基于 `DISCUSSION-task-lane-migration.md` 文首「重大事实更正」（2026-08-28
> CDP 实机验证：泳道已在官方对象层，作用域全解锁）。
> 最近更新：2026-08-28 · 分支 `feat/ide-s4-restore`
> 前置阅读：DISCUSSION-task-lane-migration.md（事实更正）→ 本文 → HANDOFF-ui-continuation.md

---

## 〇、事实地基（动手前必读，已实机验证）

**泳道会话现在就已经在官方 `ctx.sessions` 对象层里，作用域能力全部可用，无需 fork、无需自建。**

- `session.list` RPC 返回泳道（corum-task/proj/dev），带完整 header（`cwd`/`agentPreset`）。
- `session.models` / `session.rename` 对泳道实测可用 → 模型选择器、重命名、对象层 binding 全活。
- 官方对 session-id 零格式约束；header 唯一约束是 `cwd` 必须给（泳道已给）。
- 机制：泳道经 `ctx.agents.create` 的 `agent.ctx.sessions.enter/announce` 注册进 root
  `SessionStore` 单例 → 进 `sessionQuery.listSessions()` → 进官方对象层 list。

**因此**：会话**管理**（list/select/rename/archive/fork/模型选择器/审批作用域）全面回归官方；
**消息流渲染**保留泳道自研投影（`getTaskSessionEvents` + `buildCards`）。

---

## 一、总体原则

| 面 | 用什么 | 说明 |
|---|---|---|
| 会话 list / 选中 / rename / archive / fork / 工作区分组 | **官方对象层**（`ctx.sessions` / `ctx.workspaces`） | 泳道已在其中，按 id 前缀筛选即可 |
| 模型选择器作用域 | **官方**（`corum-ui-model-selection` 的 `conversation.input.model` 座位） | 泳道 scope 已活，能点亮 |
| 审批 / 子Agent 卡 | **官方对象层**（pending interaction / `origin='subagent'`） | 作用域已活，接 UI 即可（后续阶段） |
| **消息流渲染**（user/ai/tool 卡片） | **泳道自研投影**（`getTaskSessionEvents` + `buildCards`） | 已验证，自己掌控字段裁剪 |
| **创建会话** | **泳道 RPC** `createTaskAgent` | 起 `corum-task-*` 泳道（复用 preset 编译/MCP/skill 装配） |

**一句话**：管理面回家（官方），数据面自控（泳道投影），创建面走泳道 RPC。

---

## 二、待改清单（按依赖序）

### 1. 侧栏 `SessionsPane.tsx`（最大改动点，但从"重写"变"筛选适配"）

**当前**：820 行，inject 全官方（`list/workspaces/open/startSession/search/rename/fork/archive/
create/pickDirectory/renameWorkspace/delete`），`isTaskSessionId` 已放行 corum-task 前缀。

**改法**：
- **数据源**：继续读官方 `ctx.sessions.list`（**不用换**——泳道已在里面）。
- **行过滤**：`isTaskSession(row)` 现状是「id 非 corum-proj/corum-dev 且 origin!=='subagent'」，
  会把官方 `session-*` 测试会话也放进来。task 模式应**只显示泳道**：
  `isTaskSession(row) = row.id.startsWith('corum-task-') && row.origin !== 'subagent'`。
  （官方 `session-*` 测试会话按定调不进 task 列表。）
- **新会话按钮**：`startSession(workspaceId)` 官方会起 `session-*` 官方会话——**要改成调泳道
  `createTaskAgent(cwd)`**（cwd 取该工作区路径），起 `corum-task-*` 泳道。这是 inject 面
  唯一要换的（`startSession` 从官方 `workspaces.startSession` 换成泳道 RPC 封装）。
- **rename / archive / fork / 工作区分组**：全复用官方现有 inject（实测 rename 可用；
  archive/fork 待 CDP 复核，机制上同源应可用）。

### 2. 对话区 `ConversationArea.tsx`（寻址方式改，渲染不动）

**当前**：按 cwd 寻址（`refresh(cwd)` 每次 `createTaskAgent` 新建会话——**这是 bug**，导致
同 cwd 起 13+ 个泳道），`sessionId` 存了没用。

**改法**：
- **寻址**：从「cwd 寻址」改成「官方 `list.current` 寻址」。`current` 已是官方选中会话
  （`listSnap.current` + `byId`）。取其 `sessionId`，调 `getTaskSessionEvents({sessionId, fromSeq:0})`
  拉事件流 → `buildCards` 渲染（**渲染层零改动**）。
- **选中联动**：`open(sessionId)`（官方 inject）驱动 `list.current` 变化 → `useEffect` 重拉。
  **删掉** `refresh` 里的 `createTaskAgent` 调用（不再每次新建，改为按 current 读已有泳道）。
- **发送**：见「三、待拍板」。

### 3. 发送消息（待拍板，见下）

---

## 三、待拍板决策（执行前需用户定）

### 决策 A：发送走哪条路？

| 选项 | 机制 | 取舍 |
|---|---|---|
| **A1 保留泳道 `runPromptForTask`** | host 同步等 idle，返回整段事件投影 | 简单、已验证；但无流式、无审批拦截、busy 是假占位 |
| **A2 切官方 `session.prompt`** | 走官方提交管线（队列/审批/streaming） | 有真实流式/审批 UX；但要接官方 conversation 装配，改动大 |

**建议**：第一版 **A1**（保留 `runPromptForTask`，消息流已通），流式/审批作为后续阶段接 A2。

### 决策 B：官方 `session-*` 测试会话怎么处理？

- 现状 dev home 有 17 条官方 `session-*`（测试残留）。task 模式按 `corum-task-` 前缀筛选后
  它们自然不显示，**无需删除**；但 fork/搜索可能仍列出——按「只显示泳道」原则过滤即可。

### 决策 C：`fork` 语义

官方 fork 从源会话切子会话。泳道 fork 是否开放？（建议：第一版**禁用**泳道 fork 菜单项，
语义待定——泳道 fork 涉及 preset/泳道归属，需单独设计。）

---

## 四、CDP 实机验证清单（每步必验）

1. **侧栏**：task 模式列表只显示 `corum-task-*` 行，按 cwd 分组正确；新会话按钮起新
   `corum-task-*`（`session.list` 复核新增一条）。
2. **选中联动**：点侧栏泳道行 → `list.current` 变为该 sessionId → 对话区 `getTaskSessionEvents`
   拉到对应事件流，卡片正确渲染。
3. **rename**：侧栏重命名泳道 → `session.rename` 成功 → list 标题更新。
4. **模型选择器**：对话区工具栏模型选择器（`conversation.input.model` 座位）点亮，显示
   泳道当前模型（实测 `session.models` 返回 localhost/deepseek-v4-flash）。
5. **不再重复建会话**：连续切换/刷新，`corum-task-*` 数量不因读取而增长（验证删掉了
   `refresh` 里的 `createTaskAgent`）。

---

## 五、关键文件

| 文件 | 改动 |
|---|---|
| `packages/plugins/ui/corum-ide-sidebar-ui/src/client/SessionsPane.tsx` | `isTaskSession` 改筛 `corum-task-` 前缀；`startSession` 换泳道 RPC |
| `packages/plugins/ui/corum-ide-sidebar-ui/src/client/index.ts` | inject 加泳道 `createTaskAgent` RPC 封装（其余官方 inject 保留） |
| `packages/plugins/ui/corum-ide-conversation-ui/src/client/ConversationArea.tsx` | 寻址从 cwd → `list.current`；删 `refresh` 里 `createTaskAgent` |
| （复用，不改）`corum-agent-dev` `getTaskSessionEvents` | 按 sessionId 拉事件流（已存在） |
| （复用，不改）`corum-ui-model-selection` | 模型选择器作用域（泳道 scope 已活） |

---

## 六、红线

- **不改官方 `@deepseek-ai/dsh-*`**——本方案全部在 corum 插件层 + 官方对象层消费，零内核改动。
- **RPC 失败不静默吞**——catch 打 console + UI 反馈（既往教训）。
- **React controlled input 用 native setter + input 事件**（CDP 填值）；边沿初始化输入态。
- **host 改动重启生效**；renderer HMR 热更（壳层改动仍重启）。
- 验证用 `./scripts/cdp.sh`，绝不宽 pattern 杀进程（误杀微信开发者工具）。

---

## 七、与 fork（PLAN-corum-agent-loop-fork.md）的关系

**正交**。本 UI 适配**不依赖 fork**——泳道已在对象层。fork 解决的是「省实例 + 保隔离」
（泳道从多实例改单实例切 session），落地后 `agent.session` 指向会变——届时**消息流读取**
要从「读 `agent.session.events`」改为「按 sessionId 读 `ctx.sessions.get(id)`」（见 fork PLAN
§六适配点）。本方案的会话管理与对象层消费**不受 fork 影响**。
