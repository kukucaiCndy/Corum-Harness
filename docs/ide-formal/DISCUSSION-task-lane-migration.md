# task 模式泳道迁移：现状评估与决策讨论稿

> **用途**：task 模式从官方 sessions 迁移到 corum 泳道 AgentLoop 的中途评估。
> 当前会话内容已多，切换到新会话专注讨论。本文档是讨论的完整事实基础。
> 最近更新：2026-08-28 · 分支 `feat/ide-s4-restore` · 基线提交 `6a876f34`（另有未提交改动，见 §五）
> 配合 `docs/ide-formal/PROGRESS.md`、`HANDOFF-ui-continuation.md` 一起读。

---

## ⚠️ 重大事实更正（2026-08-28 实机验证，推翻本文旧结论）

**本文 §三「卡住的事实」两条核心断言经 CDP 实机验证为【不成立】。** 旧结论基于「多实例
旧地基 + 从未查过 `session.list` RPC」的错误假设。真实事实（已 CDP 验证 + 源码钉死）：

**泳道会话现在就已经完整活在官方 `ctx.sessions` 对象层里，不需要 fork、不需要自建对象层。**

实机验证（未 fork 的当前实例，CDP 经 `corumDesktop.unary` 调官方端点）：

| 验证项 | 官方端点 | 实测结果 |
|---|---|---|
| 泳道进对象层 list | `session.list` | ✅ 68 条里 **46 条是泳道**：corum-task×18 / corum-proj×14 / corum-dev×14（官方 session-×17、other×5） |
| 泳道 header 完整 | `session.list` 样本 | ✅ `corum-task-2966ad6f` 带 `cwd`/`agentPreset:"task"`/`blank`/`running` |
| 模型选择器数据源 | `session.models` | ✅ 返回 `{current:{provider,model}, routable:true, groups:[...]}` |
| 对象层重命名 | `session.rename` | ✅ 返回 `{title, seq}` |

**为什么没 fork 就已经在对象层**：`ctx.agents.create` 的官方 `AgentLoop.setupAndPublish`
里 `agent.ctx.sessions.enter/announce`（`agent-loop/index.ts:559-561`）注册的就是 root 那个
`SessionStore` 单例（Cordis 服务解析沿 scope 链共享同一实例）→ 进 `sessionQuery.listSessions()`
（数据源 = 持久化 ∪ `ctx.sessions.list()`，见 `session-query/corpus.ts:58-77`）→ 进官方
`ApiSessionList.list()`（`session-controller/list.ts:138-163`，**活会话无条件放行**，`cwd`
过滤只针对冷会话）→ renderer 官方 `ctx.sessions.list` 对象层可见。

**官方对 session-id 零格式约束**（`session/types.ts:29` `SessionId()` 是纯 cast 无校验；
持久化 `encodeSegment` 对任意字符安全转义）——`corum-task-*` 等前缀完全合法。header 唯一
事实约束是 `cwd` 必须给（冷会话放行条件），泳道已满足。

**结论翻转**：最初「侧栏要不要完全脱离官方自建泳道体系」的答案是**不用**。会话管理
（list/select/rename/archive/fork/模型选择器/审批作用域）**全面回归官方对象层**；唯一保留的
泳道自研部分是**消息流渲染**（`getTaskSessionEvents` + `buildCards` 事件→卡片投影），那是
自己掌控的投影。

> 「isTaskSessionId 放行后侧栏仍 0 条」的既往观察，是侧栏**渲染逻辑**另有原因没显示，
> 不是 `session.list` 里没有——RPC 直接返回 18 条 corum-task 即铁证。

后续方案见 `PLAN-task-lane-ui-adaptation.md`（UI 适配方案）与
`PLAN-corum-agent-loop-fork.md`（fork 解决省实例+保隔离，与对象层复用正交）。

---


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

## 三、卡住的决策点：侧栏会话源 —— 【已推翻，见文首更正】

> **以下旧断言经 2026-08-28 实机验证为不成立，保留仅为存档对照。正确事实见文首「重大事实更正」。**

### 已验证的关键事实（旧，已推翻）

1. ~~**官方 `ctx.sessions.list` 不含 corum-task-***~~ → **错**。`session.list` RPC 实测返回
   18 条 corum-task（含 corum-proj×14 / corum-dev×14）。泳道经 `ctx.agents.create` 的
   `agent.ctx.sessions.enter/announce` 注册进 root `SessionStore` 单例，天然进对象层。

2. ~~**官方 `ctx.sessions.open/binding` 对 corum-task-* 无效**~~ → **错**。`session.models`
   （模型选择器作用域）与 `session.rename` 对泳道均实测可用。`eligible` 判活（host-listed
   或被寻址）泳道已满足。

3. 你的定调：官方 session-xxx 是测试会话，不要了；产品会话完全基于 corum 泳道。
   → **仍成立**，但实现方式变了：不是脱离官方自建，而是「读官方对象层 + 按 id 前缀筛
   `corum-task-*`」。

### 这意味着（新结论）

侧栏 task 模式**回归官方 sessions 对象层**：list/select/rename/archive/fork/模型选择器/审批
作用域全复用官方；侧栏只需「读官方 `ctx.sessions.list` + 按前缀筛泳道」。对话区选中态用
官方 `list.current` + `open()`。不需要共享 `currentTaskSessionId` store（官方 `list.current`
就是共享选中态）。**消息流渲染**仍走泳道自研投影（`getTaskSessionEvents`+`buildCards`）。

---

## 四、待做工作清单 —— 【已按新地基改写，见 PLAN-task-lane-ui-adaptation.md】

> **旧「方案一：侧栏脱离官方 sessions 自建泳道体系」作废**（基于已推翻的旧事实）。
> 新方案 = **UI 适配（回归官方对象层）**，详见 `PLAN-task-lane-ui-adaptation.md`。要点对照：

| 旧待办（自建体系） | 新地基下的状态 |
|---|---|
| 1. 共享 `currentTaskSessionId` store | ❌ 不需要——官方 `list.current` 即共享选中态 |
| 2. host 补 rename/archive RPC | ❌ 不需要——官方 `session.rename`/`workspaces.archiveSession` 实测可用 |
| 3. 侧栏重写读 `listTaskAgents` | 🔁 改为读官方 `ctx.sessions.list` + 筛 `corum-task-` 前缀 |
| 4. 对话区按 `currentTaskSessionId` 寻址 | 🔁 改为按官方 `list.current` 寻址 |
| 5. 移除官方 sessions 依赖 | 🔁 反转——**回归**官方 sessions 依赖（工作区分组/rename/fork 全复用） |

---

## 五、当前未提交的改动（工作区）

| 文件 | 改动 | 状态 |
|---|---|---|
| `corum-agent-dev/src/agent-service.ts` | task 泳道从 cwd 单例改 sessionId 多例（taskAgents keyed by sessionId + resolveTaskAgent resume + task-sessions.json 索引 + listTaskAgents 按 cwd 过滤） | 已构建通过，未提交 |
| `corum-ide-sidebar-ui/src/client/SessionsPane.tsx` | `isTaskSessionId` 放行 corum-task- 前缀（验证用，发现官方 list 不含后确认无效） | 可保留或回退 |

（其余已提交：dcb9f06d host 泳道 / 89dd986e 对话区 / 6a876f34 lockfile）

---

## 六、关键架构问题（需你评估）

### 1. 官方 sessions 的残留依赖盘查 ⭐ —— 【已实机验证：泳道作用域全解锁】
经 2026-08-28 CDP 验证，泳道会话在官方对象层的作用域能力**全部可用**（`eligible` 满足），
不再是"硬骨头"：
- **模型选择器座位** `conversation.input.model`：✅ `session.models` 实测返回泳道模型目录
  （`{current, routable:true, groups}`）。`corum-ui-model-selection.directoryFor(sessionId)`
  之前 throw 是因泳道无 scope——现在有了，能点亮。
- **审批（awaiting 卡）**：✅ 作用域已活，接 UI 即可（官方 pending interaction 绑 session，
  泳道已是对象层 session）。当前审批卡是假数据，待接真实。
- **子 Agent 卡**：✅ 泳道可带 `origin='subagent'`（header 字段官方支持），对象层谱系承载。
- **SessionProvider**：✅ 泳道在对象层有 binding，`SessionProvider` 可正常提供 session 作用域。

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
