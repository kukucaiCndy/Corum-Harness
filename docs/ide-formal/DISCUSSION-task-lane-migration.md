# task 模式泳道迁移：现状评估与决策讨论稿

> **用途**：task 模式从官方 sessions 迁移到 corum 泳道 AgentLoop 的中途评估。
> 当前会话内容已多，切换到新会话专注讨论。本文档是讨论的完整事实基础。
> 最近更新：2026-08-28 · 分支 `feat/ide-s4-restore` · 基线提交 `6a876f34`（另有未提交改动，见 §五）
> 配合 `docs/ide-formal/PROGRESS.md`、`HANDOFF-ui-continuation.md` 一起读。

---

## 一、一句话现状

task 模式已完成「host 泳道 + 对话区真实消息流」并 CDP 验证通过；但**侧栏会话源**卡在
「官方 sessions 对象层不含 corum 泳道会话」这一事实，需要你定迁移方式后继续。

---

## 二、已完成并验证（已提交）

### 1. host 泳道（corum-agent-dev）— `dcb9f06d` + 未提交的 sessionId 改造

task 模式泳道 RPC（经 `window.corumDesktop.unary` IPC 桥）：

| RPC | 作用 | 状态 |
|---|---|---|
| `createTaskAgent(cwd, profileId='task')` | 创建 task 泳道会话，session id = `corum-task-<rand>` | ✅ 验证 |
| `runPromptForTask(sessionId, prompt)` | 发消息，等 Agent 跑完返回回复+事件投影 | ✅ 验证 |
| `getTaskSessionEvents(sessionId, fromSeq)` | 读历史事件（切会话回填） | ✅ 验证 |
| `listTaskAgents(cwd?)` | 列出 task 会话（标题/cwd/alive/lastActive） | ✅ 验证 |

- **一个工作区多会话**：同 cwd 可建多个 `corum-task-*`（已验证 3 个并存）。
- **寻址粒度**：已从「cwd 单例」改为「sessionId 多例」（未提交的改造）。
- **数据通路**：`agent.session.events` → `simplifyEventData()` 投影 → DTO → 自家 RPC。
  与 project 泳道（`getSessionEventsForType`）同一套机制，task/project 互相不可见（by design）。
- **simplifyEventData 两修复**：① user/message content 兼容 `data.content` 顶层（之前 user
  卡不渲染的根因）；② assistant 内联 tool-call 补 arguments（之前工具行无命令）。

### 2. 对话区（conversation-ui）— `89dd986e`（cwd 寻址版）

- 消息流：`getTaskSessionEvents` 拉 `SessionEventDto[]` → 按 type 映射卡片：
  - `user/message` → user 品牌气泡卡（真实文本+时间+复制）
  - `assistant/message` → ai 卡（text=MarkdownText / reasoning 折叠 / 内联 tool-call 行带参数）
  - `tool/call`(+`tool/result` 按 callId 配对) → tool 行（工具名·主参数 + 完成/错误/运行中点态）
- 发送：`runPromptForTask` → 重拉事件流；busy 占位卡；跟随滚动。
- **CDP 实机验证**：卡片序列 `user/user/ai/user/ai/toolRow/ai`；tool 参数
  `bash · echo hello-corum`、`cat package.json | grep '"name"'` 完整显示。截图 `convo-task-final.png`。
- **当前局限**：按 **cwd** 寻址（一个工作区固定一个泳道），不随侧栏选中的具体会话联动。
  需改成按「选中的 sessionId」寻址。

### 3. 会话栏 UI 与设计稿统一 — `fe58cdc0`

品牌气泡/拆分按钮+menu/task-line/gutter/删 gauge/on-brand-muted token，CDP 计算值全命中
设计 token。

---

## 三、卡住的决策点：侧栏会话源

### 已验证的关键事实

1. **官方 `ctx.sessions.list` 不含 corum-task-***。
   corum `ctx.agents.create` 创建的泳道会话**有官方 session 持久化**
   （`.corum-dev-home/sessions/.../corum-task-*/session.jsonl.zstd`），但**不注册进官方
   sessions 对象层的 list**——所以侧栏无法复用官方 list/open/binding 机制。
   （实证：isTaskSessionId 放行 corum-task- 前缀后侧栏仍 0 条。）

2. **官方 `ctx.sessions.open/binding` 对 corum-task-* 无效**——「当前会话」选中态不能用
   官方 current。

3. 你的定调：**官方 session-xxx 是测试会话，不要了；产品会话完全基于 corum 泳道。**

### 这意味着

侧栏 task 模式要**完全脱离官方 sessions 对象层**，自建一套泳道会话的
list / select / open / rename / archive。侧栏和对话区之间需要一个共享的
`currentTaskSessionId`（侧栏选中 ↔ 对话区联动）。

---

## 四、待做工作清单（方案一：侧栏脱离官方 sessions 自建泳道体系）

1. **共享当前会话态**：`currentTaskSessionId` 共享 store（候选载体 `@corum/corum-ide-ui`，
   sidebar-ui 与 conversation-ui 都依赖它）。
2. **host 补 RPC**：泳道会话的**重命名 / 归档**（listTaskAgents 目前只有
   list/create/prompt/events）。
3. **侧栏重写**（SessionsPane，当前 820 行深度绑官方 sessions）：task 列表读
   `listTaskAgents`（按 cwd 分组工作区）+ 新会话/选中/重命名/归档。
4. **对话区改造**：按选中的 `currentTaskSessionId` 寻址（当前固定 cwd 寻址）。
5. **移除官方 sessions 依赖**：侧栏的工作区分组/搜索/归档/重命名/fork 全绑官方，需用
   泳道语义重定义。

---

## 五、当前未提交的改动（工作区）

| 文件 | 改动 | 状态 |
|---|---|---|
| `corum-agent-dev/src/agent-service.ts` | task 泳道从 cwd 单例改 sessionId 多例（taskAgents keyed by sessionId + resolveTaskAgent resume + task-sessions.json 索引 + listTaskAgents 按 cwd 过滤） | 已构建通过，未提交 |
| `corum-ide-sidebar-ui/src/client/SessionsPane.tsx` | `isTaskSessionId` 放行 corum-task- 前缀（验证用，发现官方 list 不含后确认无效） | 可保留或回退 |

（其余已提交：dcb9f06d host 泳道 / 89dd986e 对话区 / 6a876f34 lockfile）

---

## 六、关键架构问题（需你评估）

### 1. 官方 sessions 的残留依赖盘查 ⭐ 最核心
「完全脱离官方」的真实工作量取决于还有哪些地方绑官方 session：
- **模型选择器座位** `conversation.input.model`：session 作用域子槽，绑官方 sessionId。
  泳道会话官方不认 → 这个座位（对话区工具栏的模型选择器）可能失效。
- **子 Agent 卡**：设计稿有子 Agent 卡，官方用 `origin='subagent'` 路由会话承载——泳道
  体系怎么表达子 Agent？
- **审批（awaiting 卡）**：官方 pending interaction 绑 session——泳道会话的工具审批
  怎么暴露/回应？（当前审批卡是假数据）
- **SessionProvider**：conversation 槽的 session 作用域提供者，绑官方 session。

### 2. 三套泳道的侧栏可见性映射
task（corum-task-*）/ project（corum-proj-*）/ dev（corum-dev-*）三套泳道，侧栏两个模式
（task/项目）各自读哪套？当前设计：task 模式读 task 泳道、项目模式读 project 泳道
（团队段）。dev 泳道（dev-agent combo 的 AgentTestPanel）在 IDE 里要不要可见？

### 3. 工作区概念
官方 sessions 的「工作区分组」语义（cwd 分组）在泳道体系里就是 cwd，可直接映射；但官方
的 workspace 管理（create/rename/delete/pickDirectory）要保留还是也用泳道语义重写？

### 4. task 模式 profile 是否可选
泳道会话绑 profile（task 默认内置 task profile，project 绑团队角色）。task 模式用户能
选 profile 吗？还是固定 task profile？（影响 createTaskAgent 的 profileId 参数暴露）

### 5. 持久化与多实例
泳道会话持久化在 `.corum-dev-home`，重启后 resume（resolveTaskAgent 已实现冷恢复）。
多窗口/多实例共享同一份吗？浮动窗脱出时会话归属？

---

## 七、我建议的讨论切入点

按影响面排序：

1. **#1 官方 sessions 残留依赖盘查**（最核心）——决定「完全脱离官方」的真实工作量与
   可行性。尤其模型选择器/审批/子 Agent 这三个 session 作用域能力。
2. **#4 task profile 是否可选**（最影响产品形态）。
3. **#1 之后才是 #2/#3/#5**（泳道可见性映射、工作区语义、多实例）。

或者你有自己的评估框架，按你的来。

---

## 八、相关文件索引

**host 泳道**
- `packages/plugins/agent/corum-agent-dev/src/agent-service.ts`（createAgentForTask/
  resolveTaskAgent/4 RPC/simplifyEventData/task-sessions.json 索引）
- `packages/plugins/agent/corum-agent-dev/src/index.ts`（导出 TaskAgentSummary/ensureTaskProfile）

**对话区**
- `packages/plugins/ui/corum-ide-conversation-ui/src/client/ConversationArea.tsx`
  （buildCards 事件→卡片映射 / send 走 runPromptForTask）
- `.../index.ts`（callAgent RPC 调用器注入）

**侧栏（待迁移）**
- `packages/plugins/ui/corum-ide-sidebar-ui/src/client/SessionsPane.tsx`（820 行，深度绑官方）
- `.../index.ts`（inject list/workspaces/open/startSession/search/rename/fork/archive——全官方）

**候选共享载体**
- `packages/plugins/ui/corum-ide-ui/src/client/`（两包公共依赖，可放 currentTaskSessionId store）

**参照（泳道渲染已验证）**
- `packages/plugins/ui/corum-agent-ui-dev/src/client/AgentTestPanel.tsx`
  （projectLaneHistory/projectLaneHistory/loadLaneHistory——泳道历史投影的既有模式）
