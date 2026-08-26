# IDE 正式 combo 功能对接进度记录

> 目的：正式版本切到 IDE combo（仓库内 combo id = `coding`，`CORUM_DESKTOP_MODE=ide`）后，
> 按「从上到下、从交互界面元素适配开始」的节奏推进正式功能对接。
> 本文是跨 Agent / 跨 context 的交接锚点：每次推进都要更新「当前状态 / 已完成 / 进行中 / 下一步 / 风险」。
> 创建时间：2026-08-25 · 基线提交：`1319d6a2`

---

## 0. 协作规则（本轮起生效）

1. **按用户节奏推进**：不一次性铺开实现；每一步先明确当前交互元素/界面区域，再做适配，验证后记录。
2. **从上到下**：优先交互界面可见元素（壳/区域/槽位/面板/按钮/对话区/文件树/底部面板），再往下接 host 能力与数据。
3. **子 Agent 优先**：凡可并行调查、读码、验证、整理清单的工作，尽量交给子 Agent/独立任务执行；当前会话保留协调、决策与进度记录。
4. **进度即代码**：每完成一个小步就更新本文；重要节点提交 git，便于 context 受限时快速恢复。
5. **正式 combo 注意**：IDE combo 走 `packages/desktop/cordis.ide.patch.yml` overlay；不要改官方内核，仍只写插件 + overlay。

## 1. 当前基线

- 分支：`feat/ide-s4-restore`
- 最新提交：`c4fc1c57`（侧栏骨架化拆分——骨架+子槽组合，详见「## 3」末尾条目）
- 未提交文件：`doc/UXDesign/design.pen`（与本任务无关，保持未纳入）；`project.config.json` / `project.private.config.json`（本地配置，未跟踪勿提交）
- 当前运行：IDE/coding 实例运行中（PID 见 `.corum-dev-home/run/coding.pid`，CDP 端口 9222）
- 可用工具：
  - `scripts/dev-agent.sh`：dev-agent combo 一键维护（清残留 + 直编 .bin + PID 记录 + 启动）
  - `~/.agents/skills/corum-cdp-verify`：CDP 实机验证技能
- 已有工具：`scripts/dev-ide.sh`（IDE/coding 一键维护）

## 2. 正式目标（IDE combo）

- 启动形态：`packages/desktop/scripts/dev.sh --combo=coding`（或后续补 `scripts/dev-ide.sh`）
- UI 承载：`@corum/corum-ide-ui` 壳 + `corum-ide-*` 功能插件
- 对接原则：用户能看到的元素先适配真实能力；每接一个元素，明确其数据来源（RPC/事件/共享实体/会话）与降级态。

## 2.5 UI 元素盘点（2026-08-25，只读盘点，未改代码）

> 范围：IDE/coding combo 当前全部可见 UI 元素（壳 + 5 个 corum-ide-* 功能插件 + 壳内编辑器列）。
> 验证方式：源码逐文件阅读 + CDP DOM 断言（`/tmp/cdp-audit-*.js`）+ 运行态截图（`/tmp/corum-cdp/shots/ide-audit.png`）。
> 关键结论先行：
> - **编辑器区（corum.editor）是假数据**——`packages/desktop/src/client/editor/EditorColumn.tsx` 内置 `DEMO_FILE`（7 行 markdown 演示内容，写死 `docs/backend-requirements.md`）。
> - **对话区消息流/统计/子 Agent 卡/工具调用/审批卡全是假数据**——`ConversationArea.tsx` 内置设计稿文案。
> - **底部面板（corum.panel）的终端内容是假数据**——`BottomPanel.tsx` 内置 `TERM_LINES` 常量。
> - **左列「项目」「管理」「项目选择器下拉」是假数据**——`SessionSidebar.tsx` 内置 `PROJECTS` / `MANAGE_ITEMS` 常量；只有会话列表是真实数据（`ctx.sessions.list`）。
> - **文件树是真数据**——`corum-ide-explorer-ui` 通过 `corum.fs.list` RPC 读 host cwd（当前显示 packages/desktop 内容，根名写死 `dsh`）。
> - **壳（corum-ide-ui）只做区域系统 + 槽位声明，不持有业务内容**；`corum.tabStrip` / `corum.floating` 槽位已声明但无 occupant。

### 元素清单

| 元素 | 槽位 | 插件/文件 | 当前数据来源 | 缺口 |
| --- | --- | --- | --- | --- |
| 壳（区域系统 + 槽位声明 + 玻璃主题 + ctx.layout + 设置壳） | `root` + `corum.sidebar` / `conversation` / `corum.editor` / `corum.explorer` / `corum.panel` / `corum.tabStrip` / `corum.floating` / `details` / `shell.overlay` / `sidebar.settings` | `packages/plugins/ui/corum-ide-ui/src/client/{index.tsx,ide-layout.ts,AppFrame.tsx,SettingsShell.tsx}` | 真实（壳机制） | 无业务内容；`corum.tabStrip` / `corum.floating` 无 occupant |
| 品牌区 + 关闭区域按钮 | `corum.sidebar` 顶部 | `corum-ide-sidebar-ui/src/client/SessionSidebar.tsx` | 真实（brand logo 资源 + `corum:close-region` 事件） | — |
| 新建会话 / 打开项目 按钮 | 同上 | 同上 | 「新建会话」真（`ctx.workspaces.startSession`）；「打开项目」**占位**（无 handler） | 「打开项目」接真实工作区/项目切换 |
| 项目标题 + 项目选择器 | 同上 | 同上 | **假数据**：`PROJECTS` 常量（3 个写死项目）；`activeProject` 本地 state | 接 `corumProject/*`（项目 CRUD / 项目组成员 / 工作类型） |
| 管理段（计划/任务/事件/文档/问题） | 同上 | 同上 | **假数据**：`MANAGE_ITEMS` 常量（写死计数 12/3） | 接 `corumProjectData/*`（需求/任务/BUG 实体 + Readiness） |
| 会话段（搜索 + 分组会话列表 + 行内重命名） | 同上 | 同上 | **真实**：`ctx.sessions.list`（`useSyncExternalStore`），分组按 `agentPreset`；搜索 `ctx.sessions.search`；重命名 `binding.session.rename` | 分组目前按 agent preset 平铺；团队/泳道视角未接 |
| 对话区 Convo Header（对话/轨迹 tab + 分支/统计/关闭按钮） | `conversation` 顶部 | `corum-ide-conversation-ui/src/client/ConversationArea.tsx` | tab 本地 state；分支/统计按钮**占位**；关闭走 `corum:close-region` | 「轨迹」视图占位（写死「待接入」）；分支/统计按钮无 handler |
| Chat Flow（用户消息/Agent 消息/子 Agent 卡/工具调用行/等待审批卡） | `conversation` 主区 | 同上 | **全部假数据**：写死文案（「把矩道界面改成液态玻璃风格」「耗时 12s」「Running · Step 3/5」「等待审批」） | 接真实消息流（`ctx.sessions` 消息/事件）+ 审批 RPC |
| Review Card（变更文件计数 + diff 统计 + 全部撤销/保留） | `conversation` 底部 | 同上 | **假数据**：写死「3 个文件已更改」「+128 −40」 | 接真实 diff/变更源 |
| Chat Input（输入框 + 工具栏） | `conversation` 底部 | 同上 | 输入本地 state（**Enter 只清空，不发送**）；工具栏按钮**占位**；「上下文用量 1%」**假数据** | 接真实发送 RPC；@Agent 选择器；上下文用量接真实统计 |
| 模型选择器座位 | `conversation.input.model`（conversation 子槽） | 同上（renderSlot 渲染 `corum-ui-model-selection`） | **真实**（`corum-ui-model-selection` 插件提供 ModelSelect） | — |
| 底部面板（终端 tab + 终端内容 + 关闭） | `corum.panel` | `corum-ide-panel-bottom-ui/src/client/BottomPanel.tsx` | **假数据**：`TERM_LINES` 常量（写死 `$ pnpm dev` 等 4 行） | 接真实终端（设计注释提到终端/待办/队列 tabs，当前只有「终端」一个 tab 且内容写死） |
| 编辑器区（Editor Tabs + 面包屑 + Monaco + 状态行） | `corum.editor` | `packages/desktop/src/client/editor/EditorColumn.tsx`（桌面壳内置，非插件） | **假数据**：`DEMO_FILE` 常量（7 行 markdown，路径写死 `docs/backend-requirements.md`）；Monaco 实例真实 | 接真实文件打开（从文件树/会话 diff 打开文件 → Monaco model） |
| 文件树（树头 + VS Code 风格树 + 工具钮） | `corum.explorer` | `corum-ide-explorer-ui/src/client/FileExplorer.tsx` | **真实**：`corum.fs.list` RPC（host cwd 根目录，当前 = packages/desktop） | 根名写死 `dsh`；新建文件/文件夹按钮**占位**；选中文件未联动编辑器 |
| 设置壳（触发器 + Portal 设置面板 + General section + settings.* 子槽） | `sidebar.settings` + `settings.*` | `corum-ide-ui/src/client/SettingsShell.tsx` | 真实（壳自建设置面板，官方 ui-settings-general 禁用后由壳接管） | — |
| details 抽屉（官方会话详情抽屉） | `details` | 壳声明 + 官方 ui-conversation 占用（IDE 模式 ui-conversation 禁用） | **占位**：details 槽已声明且 AppFrame 渲染，但官方 occupant 被禁用，当前无内容 | 如需会话详情面板需新 occupant |

### 建议的第一个适配点（按「从上到下」顺序，供用户点名）

1. **文件树根名接真实工作区名**（最小改动：把写死的 `dsh` 换成 `ctx.connection.hostDescription.cwd` 的 basename，对齐侧栏 `workspaceName` 的既有取法）。
2. **对话区输入框接真实发送**（当前 Enter 只清空；接上 `ctx.sessions` 的发送 RPC，形成第一条真实消息流）。
3. **文件树选中文件 → 编辑器区打开**（替换 `EditorColumn` 的 `DEMO_FILE`，形成「文件树 → 编辑器」第一条真实联动）。
4. **底部面板终端接真实终端**（设计⑥ 本身规划了终端/待办/队列 tabs，当前只有写死内容）。
5. **左列「管理段」接 `corumProjectData/*`**（计划/任务/事件/文档/问题计数 + 跳转）。

---

## 3. 进度日志

### 2026-08-25 · 起步
- 状态：IDE/coding 维护脚本已补齐；正式 combo 已启动并验证可进入界面。
- 已完成：
  - agent-dev 侧地基提交（`1319d6a2`），可作为 IDE 正式功能的数据/调度后盾。
  - 新增 `scripts/dev-ide.sh`；`scripts/combo.sh coding` 改走该脚本。
  - 移除 IDE/coding 对 S0 布局调试插件的注入（`corum-ide-test-sidebar-ui` /
    `corum-ide-test-conversation-ui`），解决 `conversation` 槽重复注册启动报错。
  - CDP 验证：`corumapp://app/index.html?combo=coding` 打开，`bootCount=41`，
    无 conversation 冲突，正式 `corum-ide-sidebar-ui` / `corum-ide-conversation-ui` 在 boot entries。
- 当前运行：IDE/coding 实例保留运行（PID 记录见 `.corum-dev-home/run/coding.pid`）。
- 下一步候选（等用户点名节奏）：
  1. 盘点 IDE combo 当前可见 UI 元素与槽位占用（壳/侧栏/资源管理器/对话区/底部面板/状态区）。
  2. 选定第一个交互元素做真实能力适配（建议从对话区或文件树开始）。

### 2026-08-25 · UI 元素盘点完成（只读）
- 完成：对 IDE/coding combo 全部可见 UI 元素做只读盘点（源码逐文件 + CDP DOM 断言 + 运行态截图）。
- 关键事实（三层验证一致）：
  - 编辑器区 = 假数据（`EditorColumn.tsx` 内置 `DEMO_FILE`）。
  - 对话区消息流/Review/子 Agent 卡/工具调用/审批卡 = 假数据（`ConversationArea.tsx` 写死文案）。
  - 底部面板终端 = 假数据（`BottomPanel.tsx` 内置 `TERM_LINES`）。
  - 左列「项目」「管理」「项目选择器下拉」= 假数据（`SessionSidebar.tsx` 内置常量）；会话列表 = 真实（`ctx.sessions.list`）。
  - 文件树 = 真数据（`corum.fs.list` RPC），但根名写死 `dsh`。
  - 壳 `corum.tabStrip` / `corum.floating` 槽位已声明、无 occupant。
- 产出：盘点表已写入本文「## 2.5 UI 元素盘点」小节，含每个元素的槽位/文件/数据来源/缺口。
- 下一步（等用户点名第一个适配对象）：建议顺序见「## 2.5」末尾 1–5。

### 2026-08-26 · 第一个适配点：文件树根名接真实工作区名
- 用户点名「## 2.5」建议 1：把写死的 `dsh` 换成 host cwd basename（与侧栏 `workspaceName` 同源）。
- 已完成（`corum-ide-explorer-ui`）：
  - `FileExplorer.tsx`：根名改从壳的 `hostDescription` 源取（`useSyncExternalStore`，连接握手后发布），`rootNameFromDescription()` 取 cwd basename，取不到回退设计默认 `dsh`。
  - `index.ts`：inject 形状从静态 `rootName: string` 改为传 `hostDescription` 源（对齐 `corum-ide-statusbar-ui` 的既有模式）；删掉了与组件文件重复且不同步的本地 `FileExplorerInjected` 接口，改从 `FileExplorer.tsx` re-export（单源）。
- 顺带修复（`corum-ide-sidebar-ui`）：`workspaceName()` 是同一错误取值模式（读 `snapshot.value.cwd`，而真实 snapshot 是扁平 `{cwd,...}`）——只是回退值恰好等于真实值没暴露。改与 explorer 一致的「扁平 + .value 包装」双接取值。
- 根因记录：CDP fiber hooks 实测真实 snapshot = 扁平 `{version,cwd,provider,model,attachedSessions,home,canOpenPath}`，**没有 `.value` 包装层**；原代码一律读 `.value.cwd` → 永远回退。
- 三层验证通过（CDP）：
  - DOM 断言：文件树 tree-header 根名 = `desktop`（host cwd = `/Users/kukucai/work/kkc-desktop/packages/desktop`），文件树条目正常加载；侧栏同根因修复生效。
  - 截图：`/tmp/corum-cdp/shots/ide-explorer-rootname.png`（右列资源管理器根名 `de…` 截断显示，面板窄）。
  - RPC 驱动不适用（纯渲染取值，无 host 端点变更）。
- 验证过程踩坑（沉淀到技能/后续注意）：
  - UI 插件 HMR 热交换**不重挂槽位注册**（`ctx.slots.inject` 是 fiber 级一次性副作用）→ 改 inject 形状后必须整页刷新/重启验证。
  - tsc 增量缓存在「接口跨文件重定义」时可能报幽灵错 → `tsc -b --force` 或先 `--clean`。
  - DOM 选择器 `[class*=treeHeader]` 会命中 editor 面包屑的同名 class → 断言前先锚定 `[class*=explorer]` 容器再查子级。
- 未提交文件 `doc/UXDesign/design.pen` 等继续排除。

### 2026-08-26 · 侧栏双模式（任务 / 项目）

- 完成：`corum-ide-sidebar-ui` 按 8 月 25 日设计稿改为固定常驻的双模式侧栏，移除旧「项目选择器 / 管理段 / 按 Agent 分组」的静态脚手架。
- 任务模式（默认）：保留真实 `ctx.sessions.list`、搜索和行内重命名；改为扁平会话列表，补会话计数 badge 与无会话空态。
- 项目模式（第一段真实能力）：IDE/coding combo 注入 `@corum/corum-agent-dev`，侧栏通过 `corumProject` RPC 加载项目列表、打开项目、创建项目（名称必填；工作目录选择暂未接入）。打开后渲染项目名、成员数、工作目录与本地关闭入口；团队与管理详情仍是下一步。
- 实现：品牌右侧加入 `项目 / 任务` tabs，移除侧栏关闭入口；新 CSS 覆盖双模式、状态/空态、键盘焦点和 `prefers-reduced-motion` 降级。
- 验证：`corum-ide-sidebar-ui` 全量构建通过；重启 IDE 后 CDP 验证两种模式均能切换，`aria-selected` 正确更新，任务模式保留新建会话和真实行。RPC 实测读取项目 `project`/`fresh-check`，并由侧栏打开现有项目 `project`（端到端验证）；截图：`/tmp/corum-cdp/shots/ide-sidebar-project-rpc.png`。

### 2026-08-26 · 项目模式详情：团队段 + 管理段

- 完成：按 interaction-design §4.1 项目详情规格落地侧栏项目详情的后两段（项目卡之下、占位提示替换掉）。
- 管理段：计划/任务/事件/文档/问题 五维行。任务/问题接真实计数（`corumProjectData.listTasks` / `listBugs`，打开项目时拉取）；计划/事件/文档实体未建（`project-data-service.ts` 注明本期非目标），显示「—」+ `data-pending` 降级。
- 团队段：chevron 折叠段头（成员计数 badge），成员行 = 状态点 + 名称 + 角色标签 + 会话计数。显示名经 `corumAgent.listProfiles` 目录解析 nickname/title（缺失退回 profileId）；角色标签 profession 优先退回 pm/member；会话计数从 `ctx.sessions.list` 按泳道 sessionId 的 `-agent<profileId>-` 段匹配，有会话亮 brand 点 + 计数。
- 实现：新增 `callServiceRemote`（泛化 corumProject 之外的 RPC 桥）；成员行仅读展示，点击交互（挂会话列表/添加成员）留待下一步。
- CDP 三层验证通过：管理段 任务 4/问题 2（真实）、计划/事件/文档 pending；团队段 PM助理(PM,1)/研发(成员,6)/测试(成员,1)；「下一步接入」占位文案已消失。截图：`/tmp/corum-cdp/shots/ide-sidebar-project-detail.png`。
- 下一步候选：团队段成员行点击 → 展开该 Agent 泳道会话列表；「添加 Agent 」按钮（拉团队/独立 Agent 进项目组，RPC `addTeamToGroup`/`addMemberToGroup` 已就绪）。

### 2026-08-26 · 打开项目分流 + 项目创建向导（设计稿 ⓪①②③）

- 设计来源：design.pen L2「项目创建向导 · 深色/浅色」（`o4fBad`/`GweRq`）+ interaction-design §4.1 项目创建向导段（⓪目录选择 → ①基本信息 → ②团队与成员 → ③创建完成）。
- host（`corum-agent-dev`）：
  - `corumProject.openProjectByPath(cwd)`：按工作目录分流——已关联项目 → `existing` 直读（touch）；空目录 → `wizard`（携 basename 作建议名）；非空未关联 → 拒绝（防误收编既有代码目录）。
  - `corumProject.completeSetup(input)`：向导提交——createProject（自动带 PM 兜底）→ `teamIds` 整队 `addTeamToGroup` / `members[].fromTeam` 单个 `addMemberToGroup`，返回最终项目实体。
- UI（`corum-ide-sidebar-ui`）：
  - 项目模式空态按设计改：单「打开项目」主按钮（与任务模式「新建会话」同位同款 `$brand-primary`）+ 空态提示「打开项目开始协作 · 空目录即新建」+「最近项目」次级入口；删掉旧「新建项目」内联表单（空目录即新建，不再单独提供）。
  - 「打开项目」→ 原生目录选择器（`corumDesktop.pickDirectory`）→ `openProjectByPath` 分流：existing 直接进详情；wizard 弹创建向导。
  - 创建向导 `ProjectWizard`（portal 到 body，避开 backdrop-filter 包含块）：① 基本信息（项目名预填 basename + 目录卡带「空目录」徽标）→ ② 团队与成员（`corumTeam.listTeams` 下拉 + 整队/部分成员 radio + 部分成员勾选列表）→ ③ 创建完成（成功态 + 成员数 + 进入项目）。
- CDP 三层验证通过：
  - RPC 分流：已有 cwd 项目 → `existing`；空目录 → `wizard`（suggestedName=basename）；`/tmp` 非空未关联 → 拒绝文案正确。
  - completeSetup 整队（project-2：pm + dev/qa fromTeam=team）与部分成员（project-3：pm + 勾选子集 fromTeam=team）均正确落 group。
  - UI 空态按钮集 = [打开项目, 最近项目]（无「新建项目」）；向导创建的 project-2 经「最近项目」打开后详情正确（3 位成员 + cwd；团队段 PM助理/研发/测试）。截图：`/tmp/corum-cdp/shots/ide-sidebar-openproject-empty.png` / `ide-sidebar-wizard-project.png`。
- 未做（设计有、本步裁剪）：②′ 添加成员浮层（单独添加非团队成员）、④ 创建中加载进度步骤——成员勾选已覆盖主路径，进度步骤待创建变重时再补。

### 2026-08-26 · 侧栏项目模式 1:1 对齐设计稿（单项目承载）

- 设计来源：design.pen L2 侧栏 ③/③b/④（`HUqCa` 空态 / `wCq15` 空态有历史 / `HmXQH` 项目详情）。**关键修正认知**：侧栏同时只承载一个项目——详情态无「切换项目」，切项目只能 × 关闭回空态再开另一个。
- 空态（③/③b）：单「打开项目」主按钮；无历史 → 纯空态；有历史 → 「历史项目」段（history 图标段头 + 「双击快速打开」提示 + 项目行 = folder 图标（首个 brand 色/其余 tertiary）+ 名称 + `N 成员 · 相对时间` + 首个带「最近」badge），单击/双击均打开。删掉上一版的「最近项目」次级按钮 + 折叠 ProjectList。
- 详情（④）：删掉「切换项目」按钮与项目列表。项目卡按 project-header 稿（folder-open 16 + 名称/`N 成员 · 进行中` + × 24×24）。管理段改 7 项（计划/需求/任务/测试/缺陷/文档/时间事件，design sec-manage 全量 + chevron-right；需求/任务/缺陷真实计数，计划/测试/文档/时间事件 pending「—」）。团队段改成员组（gh 组头 chevron + dot + 名称 + 会话计数，可折叠）下挂该 Agent 的泳道会话行（sr：status-dot + title + time，点击切会话）——替代上一版扁平成员行 + 角色标签。
- CDP 三层验证通过：空态 ③b 历史段（badge/相对时间/无切换与最近项目按钮）；详情 ④（项目卡/管理 7 项/团队组挂会话行/无切换按钮）；关闭项目回空态。截图：`/tmp/corum-cdp/shots/ide-sidebar-redesign-detail2.png`（详情）/ `ide-sidebar-redesign-detail.png`（空态）。

### 2026-08-26 · 侧栏骨架化拆分（开源/付费版组合）

- 动机：侧栏拆成「骨架 + 两个子槽内容插件」，开源版只含骨架+任务模式，付费版加项目模式插件；集体脱出时整列（含项目段）随 `corum.sidebar` 一个 grid leaf 进浮动窗。
- 结构：
  - `corum-ide-sidebar-ui`（开源核心）：`SidebarSkeleton` 占 `corum.sidebar`，同一次 register 声明 `corum.sidebar.sessions` / `corum.sidebar.project` 两个子槽（declaration = 占坑），只做品牌区 + 「项目/任务」切换 + 子槽渲染；`SessionsPane`（新建会话 + 搜索 + 扁平会话列表）由同包注册进 sessions 子槽。
  - `corum-ide-project-ui`（新包，付费版组合）：`ProjectPane` 占 `corum.sidebar.project` 子槽——打开项目分流（existing/wizard）+ 创建向导 + 项目详情（管理段 7 项/团队段），从旧单体 `SessionSidebar.tsx`（931 行，已删）完整抽出；overlay `cordis.ide.patch.yml` 加 `ide-project` 行（移除该行即开源形态）。
  - 骨架经 `hooks.projectOccupied`（inject hooks 室源，slots 库绑定为 `useProjectOccupied` 选择器 Hook）探测 project 槽占用，无 occupant 时不显示「项目」tab。
- 关键实现决策：两个子槽**常驻挂载、仅按模式切 CSS 可见性**（`.pane[data-active]`，`display: contents/none`）——切模式不丢组件态（项目详情 activeProject 等），对齐旧单体的状态存活语义。
- 踩坑修复：slots 库 `InjectFace` 把 inject 的 `hooks.*` 源映射成组件 props 的 `use<Name>` 选择器 Hook（`SnapshotSelectorHook`，调用取值），不是原始 uSES 源；组件 props 类型要用 `InjectFace<T>` 视图（omit `hooks`）而非裸 inject 接口。
- CDP 验证通过：tabs 项目/任务（任务默认选中）；任务模式（新建会话 + 真实会话列表）；双 pane 常驻（data-active 正确翻转）；项目模式（打开项目 + 历史项目 4 行）；点历史行进详情（管理 7 项 / 团队组 / fresh-check）；任务⇄项目往返后详情保留。截图：`/tmp/corum-cdp/shots/ide-sidebar-split-detail.png` / `ide-sidebar-split-task.png`。
- 开源形态（无 ide-project 行 → 无「项目」tab）逻辑已就位，实机验证待需要时跑第二个 combo。
- 已知取舍：`ProjectPane.module.css` 是 `SessionSidebar.module.css` 全量副本（包自洽、hash 类名无冲突）；后续可抽共享样式到基座包。
- 下一步候选（等用户点名）：
  1. 开源形态实机验证（overlay 移除 `ide-project` 行 → 骨架不显示「项目」tab）。
  2. 模式切换反转动画落地（DESIGN §7.10 已定义交互参数）。
  3. 「## 2.5」建议 2–5：对话区输入框接真实发送 / 文件树选中→编辑器打开（替换 `EditorColumn` 假数据）/ 底部面板终端接真实终端 / 管理段计数接 `corumProjectData`。
  4. 共享 CSS 抽基座包（消除 sidebar/project 两包的样式副本）。

### 2026-08-26 · 侧栏共享样式抽基座（消除 948 行全量副本）

- 用户定节奏：① 技术债（共享 CSS）→ ② 模式切换反转动画 → ③ 开源形态实机验证。
- 完成：`SessionSidebar.module.css` 与 `ProjectPane.module.css`（两份 948 行 100% 全量副本）合并为单源 `@corum/corum-ide-ui/src/client/sidebar.module.css`。
  - 导出机制：`corum-ide-ui` package.json 加 `./sidebar.module.css` 子路径（指向源文件，沿用 `corum-ui-base` 的「源码导出、消费方打包」模式）；sidebar-ui（骨架 + SessionsPane）与 project-ui（ProjectPane）各自 import 后由 tsdown 编译进自己的 client bundle。
  - 壳自身**不** import 该文件：无侧栏插件的组合不携带侧栏样式；ide-ui 的 style.css 仍只含 theme.css（36.18 kB 不变）。
  - 删除两份副本文件；三个消费方 import 统一改为 `@corum/corum-ide-ui/sidebar.module.css`（TS 侧靠既有 `*.module.css` ambient 通配声明解析）。
- 构建级验证通过：
  - 三包 build 全绿（tsc -b + tsdown + inline-css）；sidebar-ui 与 project-ui 的 `lib/style.css` 均为 19.70 kB（同源等量），各自由 `inline-css.mjs` 以自己的 `data-plugin` 标签内联。
  - 两 bundle 的 CSS Modules 哈希前缀完全一致（`_9Q52kG_` 前缀实测相同）→ DOM 中两份规则等价、类名互通，行为与拆分前一致。
  - 残余形态：DOM 会有两份相同 `<style>`（各插件自包含 bundle 的既定形态，与拆分前相同）；未来如需去重需另行机制，非本步目标。
- 待办：随步骤 ②（动画）一起重启 IDE 实机做 CDP 三层验证（避免多次重启）。

### 2026-08-26 · 侧栏模式切换反转动画落地（DESIGN §7.10）

- 实现（`SidebarSkeleton.tsx` + 共享 `sidebar.module.css`，纯 CSS 无 framer-motion）：
  - **内容区反转**：mode（tab 态即时跟随点击）/restMode（当前静止面板）双态 + 240ms 定时器收尾。旧面板 `data-flipping="out"`（rotateY 0→90° + 淡出 120ms easeIn，`position:absolute` 覆盖于新内容之上），新面板 `data-flipping="in"`（rotateY −90°→0° + 淡入 200ms easeOutExpo，`animation-delay: 40ms` = 与退出重叠 80ms）；新增 `.sidebarBody` 包装层提供 `perspective: 1400px` 与定位上下文。静止态维持 `display: contents/none` 常驻挂载语义不变（组件态保留）。
  - **mode-switch 指示条**：激活段品牌色底改为 `.modeSwitch::before` 随 `data-mode` translateX 滑动 250ms easeOutExpo；激活段 scale 1→1.02→1 微回弹 200ms easeOutBack（`segBounce` keyframes）。
  - **列表逐项交错**：`.sr`/`.teamSr`/`.manageRow`/`.teamGroup`/`.historyRow` 统一 `rowEnter`（opacity + translateY 8px，easeOutExpo），四列表容器 nth-child 30ms 交错至第 8 项封顶；空态 `emptyEnter` 300ms spring 曲线（easeOutBack）。面板 display:none→可见时动画自然重启 = 每次切入重新交错。
  - **reduced-motion 降级**：反转替换为 150ms 纯透明度 fade，指示条滑动/交错/微回弹全部归零。
- CDP 三层验证通过（DOM 断言实测）：
  - 中段 100ms：旧面板 `paneFlipOut`（rotateY ≈58°、opacity 0.35、absolute 覆盖）；新面板 `paneFlipIn`（delay 40ms、rotateY ≈−20°、opacity 0.78）；指示条 translateX 滑动中（38.7px→50px）。
  - 落定 400ms：data-mode/aria-selected/面板可见性全部干净归位，无残留 transform/animation。
  - 快速往返（任务→项目→任务）：中途反向切换正常，最终落定正确；项目详情（activeProject）跨往返保留。
  - 会话行/管理行交错延迟实测 0/30/60/90/120/150ms。
  - 截图：`/tmp/corum-cdp/shots/ide-flip-paused-mid.png`（中段冻结帧）/ `ide-flip-settled.png`（落定项目详情）。
- 验证观察（非缺陷）：全局暂停动画 + 跨分钟人工间隙后出现过一次整页重载（疑 HMR 握手）；连续运行下状态机无任何异常，可复现性验证全部通过。

## 4. 风险 / 注意

- `doc/UXDesign/design.pen` 有无关改动，提交时继续排除，避免污染正式功能提交。
- 多 host 残留仍是红线：IDE 调试脚本落地前，重启仍按 `corum-cdp-verify` 技能清残留。
- LanePool 泳道占用投影仍是进程内存态；IDE 若要展示运行中状态，重启后需以事件日志/数据层为准重建。
