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
- 最新提交：`db049980`（项目/任务会话记录互相独立，详见「## 3」末尾条目）
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

### 2026-08-26 · 开源形态实机验证（③ 三步节奏收尾）

- 方法：临时移除 `cordis.ide.patch.yml` 的 `ide-project` 两行（overlay 注释自带的开源形态切法），重启实例验证后 `git checkout` 还原，再重启付费形态复核。验证文件全程净态。
- 开源形态 CDP 断言全过：
  - `@corum/corum-ide-project-ui` 不在 boot entries（`ideProjectInBoot: false`）。
  - `modeSwitch` 不渲染、无任何 `[role=tab]`——骨架经 `hooks.projectOccupied` 探测到 project 槽空，「项目」tab 不显示。
  - 单 pane（任务）常驻 `data-active=true`；任务模式功能完整：新建会话按钮 + 会话段 + 48 条真实会话行；品牌区完好。
  - 截图：`/tmp/corum-cdp/shots/ide-sidebar-open-form.png`。
- 付费形态还原复核：`ide-project` 回 boot entries、modeSwitch 双 tab（任务选中）、双 pane 常驻 ✓。
- 踩坑沉淀：`CORUM_COMBO_PATCHES` 环境变量**不能**从 shell 环境透传——Electron main（`src/electron/main.ts:166`）构建 host 子进程 env 时空白起步、只取 combo 记录字段；想叠加 patch 层须走 combo 记录的 `patches` 字段（user combo）。本轮改用 overlay 临时删行的直接切法。
- 三步节奏全部闭环：① 共享 CSS 抽基座（`8f26fb58`）→ ② 反转动画（`fbf632fc`）→ ③ 开源形态验证（本步，无代码改动）。

### 2026-08-26 · 区域最小尺寸槽位化 + 品牌 logo 固定尺寸（指示条/公共 CSS 抽取收尾）

> 本步为「抽取公共 CSS 后侧边栏项目/任务指示条背景颜色不对」问题的收尾（用户确认已全部解决，交接文档补记）。提交 `2a14b2dc`。
- 区域最小尺寸槽位化：`grid.ts` 新增 `SlotMeta.minWidth/minHeight` + `subtreeMinSize`（同轴分支求和、正交分支取最大），替代 `GridView.tsx` 硬编码 `MIN_MAIN_SIZE=150`；sash 拖拽 / 窗口自适应 / 渲染夹取三处统一取各子树最小尺寸，未声明槽位走 `SLOT_FALLBACK_MIN_WIDTH=200 / MIN_HEIGHT=160` 兜底。
- `ide-layout.ts` 为四列声明 minWidth（sidebar 335 / conversation 495 / editor 205 / explorer 205）、terminal minHeight 160——以用户实机调好的区域位置为下限（略低 2-3px 防 Σmin 顶到窗口宽度触发等比压缩兜底）。
- `sidebar.module.css` 品牌 logo 固定 166×40、clip 圆角 6 不随侧栏宽度缩放（收窄由区域 minWidth 兜底）；mode-switch 指示条圆角 8px + grid 无 gap 时 `calc(50% - 2px)` 与分段精确对位。

### 2026-08-26 · 项目/任务会话记录互相独立（会话归属边界）

- 需求：项目/任务的**会话记录互相独立不可见**——任务模式只见普通会话，项目泳道会话只归其所属项目。
- 任务模式（`SessionsPane.tsx`）：新增 `isTaskSession` 过滤，sessionId 前缀 `corum-proj`（项目泳道）/ `corum-dev-`（dev 直聊）的会话在任务模式一律不可见；普通会话（`session-*`）正常展示。sessionId 前缀即归属边界（host 侧格式见 `corum-agent-dev agent-service.ts`）。
- 项目模式（`ProjectPane.tsx`）：团队段会话匹配从「只按 `-agent<profileId>-` 段」改为**项目前缀 `corum-proj<projectId>-` + profile 段双重匹配**——修复同一 profile 在多项目的泳道会话被错列到当前项目下的跨项目串台缺陷。
- 「Agent 设置互相独立」事实核查：AgentProfile 本就是**全局实体**（`$CORUM_HOME/.agent-presets/<id>/agent.json`，无 projectId 字段），IDE/coding combo 内**没有任何 AgentProfile 编辑 UI**（profile 编辑器 AgentTestPanel 仅在 dev-agent combo），故「设置互相不可见」在 IDE 无额外工作——项目↔profile 关联在 `project.json` 的 `group.members`，方向是项目引用全局 profile。
- CDP 三层验证通过：
  - 数据源（fiber 真实 feed）：全量 48 会话 = 20 普通 + 14 项目泳道 + 14 dev。
  - 任务模式 DOM：20 行 `button.sr` 全为普通会话，badge=20，0 条 corum-proj/corum-dev。
  - 项目模式 DOM：打开「端到端验证」（projectId=`project`，成员 pm/dev/qa），团队段 8 行会话 fiber key **全部**为 `corum-projproject-*` 自身泳道（PM 助理 1 / 研发 6 / 测试 1），无跨项目串台。
  - 截图：`/tmp/corum-cdp/shots/ide-isolation-task.png`（任务模式 20 普通会话）/ `ide-isolation-project.png`（项目模式团队段）。
- 踩坑沉淀：CDP `[class*=sr]` 会命中 `srTitle`/`srTime` 子 span（前缀匹配）→ 行断言用 `button[class*=sr]`；历史项目列表只显示 4 条且挂载时一次拉取，外部 RPC openProject 后需刷新页面才更新。
- 搜索同步隔离（补）：`SessionsPane` 抽出 `isTaskSessionId`（列表行与搜索结果共用），搜索结果经 `visibleResults = results?.filter(isTaskSessionId)` 过滤后渲染与计数——host 端全文检索会命中泳道/dev 会话内容，任务模式一律不展示。

### 2026-08-26 · 接入 session-query 内容搜索（端到端验证搜索隔离）

- 动机：任务模式搜索框此前搜不出任何内容（`sessions/search` 404）。子 Agent 调查结论：client 调用走 `/api/session.search`（官方 ApiProxy unary 路由，`sessionQuery` Cordis 服务支撑），corum host 的 `api-gateway` 与 `session-query-sqlite` 均在，但 base bundle 默认 `openAt: never`（搜索禁用）。
- 接入（[cordis.ide.patch.yml](file:///Users/kukucai/work/kkc-desktop/packages/desktop/cordis.ide.patch.yml)）：IDE overlay 加 `session-query-sqlite` 配置覆盖 `openAt: first-search`（惰性首次搜索打开 SQLite）+ `path: ':memory:'`（进程内存索引，启动零开销、重启重建）——正是官方 base patch 注释建议的「部署方在更后 patch 层覆盖 openAt」做法，零新依赖、零 insert 行。
- 端到端 CDP 三层验证通过（搜索隔离**真实**生效，不再只是逻辑投影）：
  - RPC 驱动：`POST /api/session.search`（query=`dsh_test`）返回 200，host 真实命中泳道会话 `corum-projproject-agentdev-…`（snippet 为真实消息内容）与 dev 会话 `corum-dev-test-agent-…`。
  - UI DOM 断言：任务模式搜索框输入同一词 → 0 行、`无匹配会话`、badge=0——泳道/dev 会话被 `visibleResults` 过滤，归属隔离在真实搜索链路下成立。
  - 截图：`/tmp/corum-cdp/shots/ide-search-isolated.png`。
- 踩坑沉淀：搜索端点是 `/api/session.search`（单数 session、点号分隔，payload 直接 `{query}` 不包 args），**不是** Typert 的 `/api/sessions/search`；之前误判「host 未接 session-query」实为调错路径 + openAt 默认禁用双重原因。

### 2026-08-26 · 框架级通知能力（design.pen「row-通知框」）+ HMR 失败提示

- 定位：**corum-desktop 框架级基础能力**，任何 combo 可用（用户明确：非 dev-only）——HMR 失败只是第一个消费方。
- 设计来源：design.pen「row-通知框」（YbfO9）toast——右下角纵向堆叠，`$glass-1` 底 + cornerRadius 16 + `$glass-border` 描边 + 外阴影 `0 10 28 #0000003D`；r1 行 icon-box（34×34 `$glass-2` + 16 lucide 图标按 tone 着色）+ title（12/600）/msg（11）+ 关闭 ×；r2 行 时间戳（JetBrains Mono 10）+ 主操作（`$brand-primary`）/次操作（`$label-tertiary`）。
- 实现（桌面壳 client，与 combo 槽位系统解耦）：
  - `notifications.ts`：无 React 依赖的 NotificationStore（`notify/dismiss/clear` + subscribe/getSnapshot），tone=success/warn/error/info，actions 主/次操作（最多 2 个）。
  - `NotificationHost.tsx` + `.module.css`：订阅 store，createPortal 到 body 右下角渲染 toast 栈（摆脱 .leaf 合成层裁剪，同 SettingsShell 模式）；全设计 token（深/浅主题随 `body[data-ds-dark-theme]`），lucide 图标（success=circle-check / warn=hourglass / error=alert-triangle / info=info）。
  - `mount-notifications.tsx`：createRoot 挂 body 专用容器 `.corum-notification-root`，幂等 + dispose 句柄。
  - `index.ts` apply：`ctx.provide('notifications', store)` + `declare module '@deepseek-ai/cordis'` Context merge（插件经 `ctx.notifications` 注入使用）+ `window.__corumNotify` 调试面（CDP/console 免 fiber 发通知）。
- 首个消费方 HMR 失败提示（hmr.ts `queue.catch`）：热替换硬失败（prefetch/refresh/fiber.await 抛错）→ 发 warn 通知「热更新失败 · {插件}」+「热替换未完成，界面可能不是最新版本」+「立即刷新」（`window.location.reload()`）/「忽略」。**手动点刷新**（用户定）：不自动刷新（硬失败刷新无意义且丢未保存 UI 状态），toast 常驻直到手动处理。「卸载不干净」类不抛错的软失败检测不到，只能靠可观测性兜底（本条）。
- CDP 三层验证通过：容器挂载 + `__corumNotify` 暴露；双 toast 堆叠（warn+success）+ 双 icon-box + 时间戳；「立即刷新」点击触发 onClick 且该 toast 关闭、另一条保留；× 清空。截图：`/tmp/corum-cdp/shots/corum-notifications.png`（深色主题双 toast）。
- 修复：`exactOptionalPropertyTypes` 下 NotificationStore 可选属性改条件展开（`...(x!==undefined?{x}:{})`）。

### 2026-08-26 · L1 布局对齐设计稿：窗口去通栏标题栏，标题栏收进左列 nav 顶部

- 设计变更：用户更新主窗口设计稿（L1 主界面 ZhjRX），**窗口不再有通栏标题栏**——「窗口标题栏」（d8STsd 组件，40px = 红绿灯让位 84px + 图标按钮）移进左列 `col-nav`（280）顶部，菜单文字（文件/编辑/视图/插件/帮助）全砍，右侧主内容顶到窗口顶。终端仍是 GridView 叶子卡（设计稿 hvh 的 absolute 只是画布摆拍，非运行时定位语义）。
- 实现（AppFrame 根结构整改）：
  - 删通栏 `titleBar`（菜单组 + 主题三态组 + 设置）及其 CSS/逻辑。
  - 新建 `NavTitleBar`：红绿灯让位 84px（`app-region:drag`，系统圆点由 hiddenInset 保留）+ 5 图标按钮（`PanelLeftClose/Open` 折叠侧栏 / `Columns2` 切换编辑器+资源管理器 / `Terminal` 切换终端 / `Blocks` 插件中心 / `Moon/Sun` 主题浅↔深）+ 设置触发器（`navSettingsSeat` 覆盖 trigger 为 28×28 图标）。
  - 标题栏放进 `renderGridSlot('corum.sidebar')` 分支的 `navCol` 容器顶部（卡片外、贴左列顶）；`corum.sidebar` leaf 加入 `IDE_TRANSPARENT_SLOTS`（外层不再整卡，侧栏玻璃卡由 `.sidebarPane` 自担背景/圆角/blur）。
  - 图标按钮接功能：`toggleSlotsHidden`（编辑器+资源管理器 / 终端复用网格 hidden 成组切换，「任一可见→全隐藏、全隐藏→全显示」）；主题两态切换（system 态按深处理）。
- **侧栏折叠语义修正**（踩坑）：最初用 `setLeafHidden('corum.sidebar')` 整列隐藏，结果标题栏随卡片一起消失、无法展开。改为 leaf 内部卡片显隐（leaf 保留，`.sidebarPane[data-collapsed]` display:none），标题栏常驻、可再展开。
- 用户澄清的关键认知：设计稿 L1 各区域的 `pos:absolute`（终端 hvh、drawer-tab 等）是**画布摆拍定位**，不是运行时浮动语义——终端仍是网格叶子卡。
- CDP 三层验证通过：通栏 titleBar 消失；NavTitleBar 在左列卡片上方贴顶（barY=17/h40/paneY=67）；5 图标按钮 + 设置座位；折叠后标题栏常驻、卡片隐藏、按钮翻「展开侧栏」，展开恢复；菜单文字已砍。截图：`/tmp/corum-cdp/shots/ide-navtitlebar-v2.png`。
- 左列背景修正（`4546d4c3`）：用户指出左列应是**贯通全高贴三边、直角无圆角**的玻璃面板（设计稿 col-nav = `fill:glass-1` 无 cornerRadius），而非悬空圆角卡片。改为 navCol 负 margin 抵消 frame 16px padding 贴齐上/左/下 + `calc(100%+32px)` 贯通 + 去圆角；放开 sidebar leaf/card 的 overflow:hidden（否则负 margin 被裁）；去 sidebar card 的 border-width（cardTransparent 只透明 border-color 仍留 1px 把内容推 1px）。CDP 实测 x=0/y=0/bottom=winH 三边贴齐。截图：`/tmp/corum-cdp/shots/ide-navcol-full.png`。

### 2026-08-26 · 顶部贯通标题栏行（窗口标题栏 + Agent 标题栏），解决窗口拖拽余量

- 设计变更（用户深夜改交互）：上一版「去通栏标题栏」导致可拖拽区只剩左列 40px，窗口难拖动。设计稿恢复 **40px 贯通标题栏行**（titlebar-row，整行 `app-region:drag`），拆两段：左段「窗口标题栏」296px（红绿灯让位 + 图标按钮）+ 右段「Agent 标题栏」（新组件 b4p03B：会话标题 + 分隔线 + 状态胶囊[轮次/耗时/token/命中率 + chevron] + spacer + 轨迹按钮）。col-nav 侧栏回到 left-body 内**圆角 18 玻璃卡片**（撤销上一版贯通全屏直角，以最新设计稿为准）。
- 实现（AppFrame 再次根结构整改）：
  - 主 JSX 加 `titlebarRow`（margin -16px 贴齐窗口上/左/右，整行 drag）：`NavTitleBar`（改 296px 定宽、去自身 drag 由父级统一）+ 新建 `AgentTitleBar`（假数据占位：标题「矩道布局设计」+ 状态胶囊 + 轨迹按钮，真实会话标题/统计待接）。
  - 侧栏从贯通全屏改回圆角卡片：`renderGridSlot('corum.sidebar')` 分支移除 NavTitleBar，`.sidebarPane` 自担圆角 18 玻璃卡样式；删掉 navCol 贯通/负 margin/overflow 放开等上一版样式。`corum.sidebar` 仍在 `IDE_TRANSPARENT_SLOTS`。
  - 新增 `.agentTitleBar` 系列 CSS（标题 13/600 + 分隔线 + 状态胶囊 10px + 轨迹按钮 28×28，no-drag）。
- 待确认（用户睡了，按最合理理解处理）：**对话区 Convo Header 暂保留**——Agent 标题栏已在顶部承载标题/状态/轨迹，Convo Header（对话/轨迹 tab + 分支/统计/关闭）是否删除待用户醒后确认（我倾向被 Agent 标题栏取代）。
- CDP 三层验证通过：titlebarRow 贯通顶部（x=0/y=0/w=winW，drag）；窗口标题栏 296px + 5 图标按钮；Agent 标题栏标题/状态胶囊/轨迹按钮齐全；侧栏回圆角 18 卡片（y=55 不贴顶）。截图：`/tmp/corum-cdp/shots/ide-titlebar-row.png`。
- 宽度核对修正（`1db4fe9e`，用户指出状态栏宽度与设计稿差距大）：**Agent 标题栏右缘应对齐对话区右缘**（设计稿 titlebar-row 只在 left-col 856 内，编辑器/资源管理器上方无标题栏），而非横贯窗口。动态测量 `conversation` leaf 右缘，Agent 标题栏宽度 = convoRight - 310（窗口标题栏 296 + 行内 gap 14）。同时：① GridView 默认布局对齐设计稿（根 row = left-body[侧栏280+对话区530] + right-col[row-top(编辑器504+资源管理器210) 上 + hvh 终端130 下横跨]，终端不再挂对话区列内）；② 删对话区 Convo Header（标题/状态/轨迹已上移 Agent 标题栏）。CDP 实测 agentRight=convoRight（±2px）、终端在编辑器+资源管理器下方横跨、Convo Header 已删。截图：`/tmp/corum-cdp/shots/ide-layout-aligned.png`。

### 2026-08-27 · 区域最小尺寸机制确认 + 兜底高度 160→200 + 窗口最小尺寸限制

- **机制确认**：区域最小宽/高「每区域自声明 + 省缺兜底」机制此前已落地（`2a14b2dc`）。`SlotMeta.minWidth/minHeight` 由各区域 `registerSlot()` 时声明；未声明走兜底。`subtreeMinSize()`（同轴求和、正交取最大）被 sash 拖拽 `resizeBranch` / 窗口自适应 `rescaleGrid` / 渲染夹取 `GridView` 三处统一消费，无硬编码残留。
- **兜底高度对齐（用户定调 200×200 正方形）**：`corum-ui-base/grid.ts` `SLOT_FALLBACK_MIN_HEIGHT` 由 `160` 改 `200`，与 `SLOT_FALLBACK_MIN_WIDTH=200` 成 200×200 省缺正方形。IDE 现有布局无感（四列在 row 分支只吃宽兜底；终端已显式声明 minHeight 227）。
- **窗口最小尺寸限制（用户定调，硬下限 1029×497）**：此前 Electron 主窗未设 `minWidth/minHeight`，可缩到很小、明显不符合实际。在 `electron/main.ts` `BrowserWindow` 加 `minWidth: 1029, minHeight: 497`，保证非全屏缩窗时左侧导航栏 / 中间对话区 / 顶部标题栏完整显示、右侧压缩区不被压垮。推导（与 `ide-layout.ts` registerSlot 声明同源）：
  - 宽 = left-body(侧栏283+对话509=792) + right-col(max(编辑器205,资源205,终端200兜底)=205) + frame 左右 padding 32 = **1029**
  - 高 = 标题栏行40 + frame gap14 + 内容区(row-top 200 + 终端227 = 427) + frame 下 padding 16 = **497**
  - 浮动窗（`ipc.ts` 单槽位脱出窗 560×640）不受主窗 IDE 布局约束，未设限。
- **验证**：`corum-ui-base` / `corum-desktop` 两包 `tsc -b --force` 全绿；`corum-desktop` 全量 build 通过。窗口约束是主进程行为，重启 IDE/coding 实例后由主进程自检日志（`if (DEV)` 守卫）权威确认：`[corum-shell] window min size effective: 1029x497`。CDP 断言当前 1280×860 窗口下 titlebarRow / sidebarPane / conversationSlot 三要素均渲染、无横向溢出。（注：本会话 AppleScript 辅助访问被系统拒绝、CDP 无 `Browser.getWindowForTarget`，无法外部驱动缩窗；以主进程 `getMinimumSize()` 自报为权威证据。）

### 2026-08-27 · 修复导航栏突变宽 + 无法缩到最小宽度（minTotal≥span 兜底改 min 比例分配）

- **用户报告 BUG**：全屏时把导航栏调到最小、再调对话栏宽度到某临界，导航栏**突变宽**（283→396），且之后**无法再把导航栏缩到最小宽度**。
- **根因**：`grid.ts rescaleGrid.scale()` 与 `GridView.tsx computeCellSizes()` 在 `minTotal >= span`（各列最小宽之和 ≥ 可用宽）时走**等比平分** `hard = span/visCount`。left-body 分支 span=792 恰 = 两列 min 之和（sidebar 283 + convo 509 = 792），边界一成立就把用户拖的 [283,509] **等比覆盖成 [396,396] 并持久化**；渲染层同逻辑持续 396，sidebar sash 拖拽时 convo 已顶 min 509 无富余、delta 无法传导 → 锁死拖不回。
- **修复（用户定调：按 min 比例分配）**：`minTotal >= span` 兜底从「等比平分」改为「按各格 min 比例分配」 `(mins[i]/minTotal)*span`——保住各区域声明的最小比，小窗不丢布局、大窗恢复后仍贴近用户比例，绝不溢出。改 3 处：`rescaleGrid.scale` 两个等比分支 + `computeCellSizes` 渲染夹取分支（三处保持一致）。
- **踩坑沉淀（关键）**：`corum-ide-ui/lib/client.js` 把 ui-base 的 grid 逻辑**内联打包**——只重建 `corum-ui-base` 不够，`pnpm --filter corum-desktop run build` 也不含它，必须**单独重建 `@corum/corum-ide-ui`** 才带新逻辑。之前两轮重启 app/restartHost 仍跑旧 bundle（grep 包内 `hard = span` 仍在），重建 ide-ui 后旧 `hard = span` 全消失、新 `m / minTotal` 出现。
- **CDP 三层验证通过**：
  - 逻辑探针：1100px 窄窗（left-body span<792 触发兜底）sidebar:convo = 0.558 ≈ 283/509=0.556（旧逻辑=1.000 等比）→ 新逻辑确认生效。
  - 干净默认布局：全屏 1728 重置后 = **[283,509,699,205,904]**（修复前卡死 396/396），完全对齐 `ide-layout.ts` 实机几何。
  - 用户路径复现：连续向左拖 convo sash ×5 跨临界，sidebar **始终稳定 283 无突变**、convo 稳定 509、editor 稳定 699——left-body 顶到 minTotal 后 sash 被正确夹取、delta 不传导，两个症状（突变 + 锁死）均消除。

### 2026-08-27 · 侧栏钉住（pinned）+ 其余四区域自由组合（修复「拖 convo 右边 nav 跟着变」）

- **用户报告 BUG**：拖对话区右侧边，导航栏宽度跟着改变。
- **根因（结构性）**：默认布局树 `root row [left-body(侧栏+对话区), right-col]`——对话区与编辑器被拆进两个分支，对话区右缘**只有 root 的 left-body│right-col 一条 sash**，拖它改变的是 left-body 整列宽度，侧栏与对话区按当前比例同消长 → 侧栏被带跑。这是 8-26「终端横跨 editor+explorer」结构（`1db4fe9e`）的副作用。
- **用户定调结构**：IDE combo 下**侧栏位置/宽度固定，其余四区域（对话/编辑器/资源管理器/终端）自由组合**（各保最小宽高）。
- **实现（两层）**：
  - **结构调整**（`ide-layout.ts` `ideDefaultGrid`）：根 row 改为 `[sidebar, conversation, right-col]` 三列同为 root 直接子节点；right-col 仍是 `column[row(editor, explorer), panel]`（终端只在编辑器+资源管理器下横跨，不跨侧栏/对话区）。侧栏独立成 root 列后，其宽度只由 sidebar│conversation 那条 root sash 决定，拖 convo/editor/终端任何其它边都碰不到它。
  - **pinned 机制**（`corum-ui-base`）：`SlotMeta` 新增 `pinned?: boolean` + `isPinnedSlot()`。`dropLeaf`（source 或 target 是 pinned → no-op）、`addSlotAt`（target pinned → no-op）、`removeLeaf`（pinned 不可摘除）三处入口拦截；`GridView` 的 LeafView 对 pinned leaf `draggable=false`、dragstart/dragover 拦截（不可作拖拽源/不显示 drop hint/不可拖出浮动窗）。`registerSlot('corum.sidebar', {..., pinned: true})`。
- **验证（CDP 三层 + 算法单测）**：
  - 结构：树 = `row [sidebar, convo, right-col(column[row(editor,explorer), panel])]`；sidebar `pinned=true`/`draggable=false`，其余四区域 `draggable=true`。
  - sash 拖拽：拖 convo 右边、editor│explorer sash，**sidebar 全程稳定 283 不动**；editor/explorer 正常消长。
  - 算法单测（tsc 编译 grid.ts 直测）：editor 拖到 sidebar 左/与 sidebar swap、sidebar 作 source 拖走、新槽落到 sidebar、摘除 sidebar **全部 no-op**；editor↔convo swap 正常工作且 sidebar 位置不变。
  - 截图：`/tmp/corum-cdp/shots/sidebar-pinned-final.png`。
- **包依赖注意**：本次改了 `corum-ui-base`（pinned 机制 + 上一轮的 min 比例修复都在 grid.ts/GridView.tsx），`corum-ide-ui` 内联打包它，**两包都需重建**才生效。

### 2026-08-27 · sash 拖拽传导推动（隔壁到 min 后推动该方向仍有余量的区域）

- **用户需求**：当前布局下若对话区已是最小宽度，拖侧栏 sash 拉宽侧栏时拉不动（邻格顶 min 把 delta 丢弃）。要「传导推动」：拖动方向隔壁组件宽度已到 min 时，继续推动该方向仍有余量的区域，直到没有任何余量。
- **根因**：旧 `resizeBranch` 只在紧贴 sash 的相邻两格间转移 delta，任一侧顶到自身 min 就把剩余 delta **丢弃不传导**（注释明写「多出的 delta 不传出去」）。侧栏 sash 右拖 → convo 顶 min 509 → delta 丢弃 → 侧栏拉不宽。
- **用户定调范围**：同分支内沿拖动方向传递，不跨嵌套下钻。
- **实现（`grid.ts` `resizeBranch` 重写）**：
  - delta>0（左/上侧变大）：左侧 `i` 增大的量从右侧 `i+1, i+2, …` 依次取富余（每格最多让到自身 min），直到 delta 耗尽或该方向无余量；`i` 实际增量 = 右侧凑到的量。
  - delta<0（右/下侧变大）：对称，从左侧 `i, i-1, …` 依次取富余补给 `i+1`。
  - 各格 min 仍取 `subtreeMinSize`（SlotMeta 声明 + 兜底）；总量守恒，只在被推动侧内部转移。
- **验证（算法单测 + CDP 端到端）**：
  - 单测：拖 sidebar|convo sash 右 300 → sidebar+300、convo 保持 509、right-col −300（传导）；超大拖到上限 → sidebar 778 / convo 509 / right-col 顶 min 410（「直到无余量」）。
  - CDP 端到端：拖 sidebar|convo sash 右 150 → **sidebar 283→329、convo 保持 509、editor 251→205（min）、panel 456→410**（right-col 被传导压缩）；继续猛拖 → right-col 全顶 min（editor 205/explorer 205）、sidebar 停 329 不再增长。
  - 截图：`/tmp/corum-cdp/shots/transmit-final.png`。
- **包依赖**：改动在 `corum-ui-base` grid.ts；`corum-ide-ui` 内联打包，两包均需重建（grep 包内 `传导/gained/slack` 确认新逻辑进 bundle 后硬重启生效）。

### 2026-08-27 · 标题栏行只覆盖左列，right-col（编辑器/资源管理器/终端）顶到窗口顶

- **用户指出（截图箭头）**：编辑器/资源管理器上方有一条 40px 留空，按设计稿应被它们向上占满。
- **根因（结构性）**：设计稿 `main-row = [left-col(含 titlebar-row(40) + left-body), right-col]`——titlebar-row **只在 left-col（侧栏+对话区）内部**，right-col（编辑器/资源管理器/终端）与 left-col 并列、**顶到窗口顶**（上方无标题栏）。而当前实现把 titlebarRow 做成整行贯通（`.frame` flex column 第一个子节点，height:40 margin:-16 贴顶），把 GridView 整体（含 right-col）压在标题栏行下方 40px → 编辑器/资源管理器上方留空。
- **用户确认两条约束**：① 右侧区域顶到窗口顶、为纯内容区（不保留 drag 覆盖）；② 窗口拖拽只留左侧标题栏行。
- **实现（子 Agent，不破坏 GridView 像素定位机制、未改官方内核）**：
  - `GridView.tsx` 新增通用能力 `leafTopOffset?: readonly number[]`（默认关闭）：BranchView 透传 depth，每个 branchCell 内层包 `.branchInner`；layoutRef 里 depth=0 的 row 分支按 child 下标取 offset，对 inner 写 `top=off/height=h-off`——列格仍占满全高（sash/drop 检测不受影响），内容卡片让位。
  - `AppFrame.tsx`：`TITLEBAR_CLEARANCE = [54, 54, 0]`（sidebar/conversation 下移 54=40标题栏+14间距，right-col 0 顶到窗口顶）；几何测量从量 leaf 改量其父格 branchCell（leaf 已被 offset 下移）；titlebarRow 两段套 `.titlebarDrag`。
  - `AppFrame.module.css`：`.titlebarRow` 改 `position:absolute; inset-x:0; top:0; z-index:30; pointer-events:none`（脱离文档流、整行穿透）；`.titlebarRow > *` 恢复 auto；`.titlebarDrag` 标记 drag 段；`.frame` 去 `gap:14`；各标题栏按钮补 `no-drag`（修复 drag 移到段级后按钮不可点的回归）。
- **CDP 实机验证通过**：编辑器/资源管理器 `top=16`（顶到窗口顶，原 54）✅；终端 panel 在编辑器下方（不跨左列）✅；侧栏/对话区 `top=70`（标题栏行下方，cell 仍全高）✅；NavTitleBar 0~299 / AgentTitleBar 299~808 ✅；titlebarRow 本体 `pointer-events:none`、两段 `drag`、按钮 `no-drag` ✅；编辑器顶部 elementFromPoint 命中编辑器内容（点击穿透）✅；折叠侧栏按钮正常 ✅。截图：`/tmp/corum-cdp/shots/layout-fixed-full.png` / `layout-titlebar-bounds.png` / `titlebar-left-only.png`。
- **踩坑沉淀**：renderer HMR 热更在壳层（AppFrame/GridView 根结构）改动下触发 root 槽竞态（`renderSlot('root') before registration`），需整页重启应用验证（与「## 4」HMR 条目一致）。

### 2026-08-27 · 修复标题栏间距过大 + 窗口无法拖拽（app-region 非继承覆盖）

- **用户反馈两问题**：① 左列卡片与标题栏间距变大（设计没预留这么大间距）；② 窗口无法拖动，拖动变成选中窗口文字。
- **间距过大（30→16）**：`TITLEBAR_CLEARANCE` 原 `[54,54,0]`（按「40标题栏+14间距」），卡片顶=16+54=70、间距=70-40=30px。设计稿 `left-body padding-top=16`（标题栏底到卡片间距=16）。改 `[40,40,0]`——卡片顶=40+16=56、间距恰 16px。
- **窗口无法拖拽（关键 bug）**：`-webkit-app-region` **非继承属性、初始值 none，且子元素覆盖父级**。`.titlebarDrag` 段级 `drag` 被其子元素 NavTitleBar（占满容器、初始 none）盖掉 → 窗口标题栏区域不可拖、拖动变选文字（Agent 标题栏座位自身 drag 未被子元素全覆盖故正常）。
- **修复**：`.titlebarDrag * { -webkit-app-region: drag }`（段内后代默认继承拖拽语义）+ 提高按钮 no-drag 特异性（`.titlebarDrag .navIconBtn/.navPluginBtn/.navSettingsSeat/.agentTrajBtn/button/[role=button]`）。
- **CDP 验证通过**：间距 `gapAboveSidebar=16`（titlebarBottom=40, sidebarTop=56）✅；NavTitleBar/AgentSeat `appRegion:drag` ✅；标题栏行 y=20 多点扫描——红绿灯让位区/窗口标题栏空白/Agent 标题=drag、折叠按钮=no-drag、右侧编辑器/资源管理器=none ✅；合成鼠标拖窗口标题栏后 `getSelection()` 长度=0（不再选文字）✅。
- **沉淀**：Electron `-webkit-app-region` 与 CSS 继承模型不同——drag 区若有占满容器的子元素，必须让子元素也 drag（或显式处理），否则父级 drag 失效。

### 2026-08-27 · 主窗口边距改 0 + 标题栏与侧栏间距改 0 + 标题栏图标对齐设计稿（Pencil MCP UI 走查）

- **走查方法**：Pencil MCP `execute`/`Get` 读 `bn8E9`(row-主界面)→`ZhjRX`(L1 深色) 完整节点树（无截断）+ `TakeScreenshot`，对照 CDP 实测几何。用户定调：宽高以实机调的值（283/509/700/205/227）为准，走查查结构/间距/图标。
- **三项修复**：
  1. **主窗口边距 16→0**：设计稿 L1 根 frame 无 padding、卡片贴窗口四边（col-nav x=0 贴左、资源管理器贴右、终端贴底）。`.frame` `padding:16px→0`。CDP 实测 framePadding=0、sidebar left=0/bottom=winH、explorer right=winW、panel bottom=winH ✅。
  2. **titlebar-row 与 col-nav 间距 16→0**：设计稿 left-col 无 gap、left-body 无 padding → 标题栏底到侧栏卡片顶=0。`TITLEBAR_CLEARANCE=[40,40,0]` 不变（frame padding=0 后卡片顶=0+40=40=标题栏底，间距自然=0）。CDP 实测 gap=0、sidebar top=40=titlebarBottom ✅。
  3. **标题栏图标对齐设计稿**：读 d8STsd（窗口标题栏组件）titlebar-actions 全部子节点（含 ref 经 resolveInstances 展开）——panel-left-close/columns-2/terminal/moon/settings/blocks 全 lucide 16×16。
     - **设置图标**：`settings-chrome.tsx` TriggerContent 从 dsh 官方 `IconSettingsOutline14/16` 改 lucide `Settings`（用户指出设置图标与设计稿明显不一样——根因是用了 dsh 官方图标组件而非 lucide）。
     - **主题切换图标语义**：从「显示目标主题」（isDark?Sun:Moon）改「显示当前主题」（isDark?Moon:Sun）——跟随设计稿深色态显示 moon（用户选定）。
- **CDP 验证**：NavTitleBar 六按钮 lucide 类名全部与设计稿一致（panel-left-close/columns2/terminal/moon/settings/blocks）✅；间距/边距实测为 0 ✅。截图：`/tmp/corum-cdp/shots/zero-margin-fix.png`。
- **踩坑沉淀**：CDP「Cannot start http server for devtools」= 端口被旧实例残留占用，需 `lsof -ti:9222 | xargs kill -9` + 强杀 electron 进程再起。
- **关联待办**：窗口最小尺寸推导（本文件「窗口最小尺寸限制」条目，minWidth 1029 / minHeight 497）基于旧 frame padding 32/16；主窗口边距改 0 后推导应相应减小（宽 −32、高 −16），待用户确认后调整 `electron/main.ts`。（已于下一条完成）

### 2026-08-27 · col-nav minWidth 283→300 + 重算窗口最小尺寸（1219×427）

- **用户调整**：col-nav（侧栏）最小宽度以当前界面为准调整为 **300**（原 283）。`ide-layout.ts` `registerSlot('corum.sidebar', {defaultWeight:300, minWidth:300})` + `ideDefaultGrid` 默认权重 283→300 同步。
- **重算窗口最小尺寸**（`electron/main.ts`，主窗口边距=0 后无 frame padding）：
  - **minWidth = 1219** = root row 三列最小宽之和 = sidebar 300 + convo 509 + right-col(max(editor 205 + explorer 205 = 410, panel 200 兜底) = 410)
  - **minHeight = 427** = max(left-col 需 标题栏40+内容200=240, right-col 需 row-top 200 + 终端227 = 427)（titlebar-row 在 left-col 全高内不额外占窗口高，右侧是瓶颈；用户确认 427 而非 467）
- **验证**：主进程自检日志 `window min size effective: 1219x427`（与重算一致）✅；sidebar minWidth=300 生效（拖 sidebar sash 收窄被夹在 300、不到 283）✅；干净默认布局 sidebar=300 ✅。
- **两包构建**：`corum-ide-ui`（minWidth 300 声明）+ `corum-desktop`（窗口 min 尺寸）均 tsc + build 通过，硬重启生效。

### 2026-08-28 · 侧栏任务模式重写：工作区分组会话列表（design ① 项目导航改版对齐官方 WorkspaceBrowser）

- **用户定调**：设计稿 ① 项目导航（`V2O1D`）的任务模式已改回与 dsh 官方一样；要求「布局按设计稿 + 交互按官方 WorkspaceBrowser（`@deepseek-ai/dsh-client-ui-workspace`）」重写侧栏任务模式。
- **重写（`corum-ide-sidebar-ui` SessionsPane + index.ts inject 扩展）**：
  - **数据面**：inject 新增 `workspaces`（`ctx.workspaces.list` 快照）、`startSession(workspaceId?)`、`addWorkspace(path)`、`pickDirectory()`、`renameWorkspace`、`deleteWorkspace`。`ctx.workspaces` 方法全部抛错形态（非结果联合），组件层 try/catch。
  - **结构（design V2O1D）**：新会话主按钮（folder-open 11 + 「新会话」）→ 区头「工作区」（folder 12 + 搜索/视图选项/添加工作区三按钮）→ 工作区分组行（chevron 旋转 + folder 14 + 名称 12/600 + 行尾操作）→ 组内会话行（dot + 标题 + 相对时间，缩进 32）。「未分组」桶收尾（无 folder 图标，行尾仅 plus）。
  - **交互（官方 WorkspaceBrowser 语义）**：区头搜索胶囊点击展开（展开时区头标签与操作组让位、Escape/清除收起）；视图选项菜单（分组方式 按工作区/单列表 + 排序方式 手动/最近更新，官方 `Menu` 原语）；组行 hover 显现行尾操作（ellipsis 菜单 重命名/删除 + plus 在该工作区新建会话）；当前会话所在组自动展开（仅未显式折叠过的组——**修复自动展开吞掉手动折叠的 bug**：explicitGroups ref 记录用户操作）；blank 会话仅当前选中可见；archived 会话隐藏；组内排序 manual=工作区账号顺序 / updated=updatedAt 倒序。
  - **工作区管理弹层**：重命名 / 删除确认复用 wizard 弹层样式（新增 `wizardBtnDanger` 危险态），portal 到 body。
  - **包依赖**：新增 `@deepseek-ai/dsh-client-ui-primitives`（`Menu` 原语；registry 引用，未改官方内核）。
- **CSS（`sidebar.module.css`）**：`.sr` 圆角 9→12（设计稿值）；新增 `.srNested`（组内缩进 32）、`.srResultBody/Title/Meta/Ctx/Snippet`（搜索结果两行结构：标题 + 工作区上下文·摘要）、`.headSearch/Open/Btn/Input/Clear`（搜索胶囊）、`.headActions/Hidden/.headBtn`、`.groupSection/Row/Chev/Open/Folder/Title/Actions/Btn/Sessions/Empty`、`.wizardBtnDanger`；删除已被胶囊替代的 `.searchBox/.searchIcon`（`.searchInput` 保留——PluginManagerPanel 复用）；`.secSessions` gap 5→4（设计稿）。
- **踩坑沉淀（两个真 bug）**：
  1. **HMR 热交换样式丢失竞态（corum-desktop `hmr.ts`）**：自研 inline-css IIFE 的守卫是「style 标签已存在则跳过注入」，而热交换顺序 `invalidate → prefetch → teardown → removeOwnedStyles → refresh` 会让 prefetch 执行的新 bundle IIFE 撞上**未删除的旧标签**（守卫跳过注入）、teardown 随后移除旧标签、refresh 仅 materialize factory 不再执行 IIFE——插件样式永久丢失直至整页重载。**修复**：`removeOwnedStyles(id)` 提前到 `prefetch` 之前（invalidate 之后），让新 bundle IIFE 注入时旧标签已不存在；teardown 不再触碰样式。CDP 验证 touch bundle 两次热交换后 style 标签与计算样式完整。**注意**：此修复只影响 dev 热交换路径（生产整页启动不触发）。
  2. **搜索竞态**：query 清空（<2 字）后 effect 的 `setResults(null)` 与已发出的 RPC 回调 `setResults(r)` 竞态——迟到的结果写回导致列表卡在搜索结果分支。**修复**：回调内 `if (!ac.signal.aborted)` 双重检查 + `searching` 判定增加 `query.trim().length >= 2` 前置条件（results 残留不再进搜索分支）。
- **验证（CDP 端到端，干净态）**：分组结构（kkc-desktop 组 folder+展开 / 未分组 no-folder）、区头三按钮 aria、嵌套行 paddingLeft=32px、圆角 12px、状态点渲染、新会话品牌按钮；折叠/展开（手动折叠不被自动展开吞掉）；搜索胶囊展开（区头标签+操作组隐藏）→ 检索 9 条结果（两行结构含工作区上下文）→ 清除/Escape 收起后分组回归；视图选项切单列表（组行消失、扁平行、区头变「会话」）/切回按工作区；工作区菜单（重命名/删除）+ 重命名对话框（预填当前名）；两包 tsc + build 通过。截图：`/tmp/corum-cdp/shots/sidebar-task-mode.png`。
- **包依赖注意**：本次改动跨三包——`corum-ide-sidebar-ui`（SessionsPane + inject）、`corum-ide-ui`（sidebar.module.css，被 sidebar-ui/project-ui 各自编译进 bundle——**两个消费包都需重建**）、`corum-desktop`（hmr.ts 修复，`RELOAD_VIA_PAGE` 集合 → 改动后整页重载生效）。`pnpm install` 注意：**勿用 `--filter <pkg>`**——会把其它包的 node_modules 链接清空（本次踩坑：corum-ide-ui 的 dsh-client-ui-slots 链接被 purge 导致 SlotMap 模块声明合并失效、类型检查报「"corum.sidebar" 不属于 "root"」）；用全量 `pnpm install --no-frozen-lockfile`。

### 2026-08-28 · cdp.sh 四实例残留事故：is_self 依赖被 sandbox 禁用的 ps（修复）

- **用户报告**：机器上累积 4 套 IDE 实例（4 个 Electron main + 各自 bridge/helper），`cdp.sh stop` 无法清理；并质疑「是否因此改 HMR 来保证修改生效」。
- **澄清**：HMR 修复（removeOwnedStyles 提前）与实例清理是**两个独立问题**——前者修 dev 热交换时 inline-css 样式被误删的真 bug（生产整页启动不触发），后者是本条的 sandbox 兼容性事故。HMR 修复不能替代实例清理（多 host 残留是红线：共享事件日志双重派发）。
- **根因**：`scripts/cdp.sh` 的 `is_self()` 用 `ps -p <pid> -o command=` 校验 cmdline 是否含本仓库绝对路径（防误杀微信的双保险）。**Agent 工具 sandbox 禁止 `/bin/ps`**（Operation not permitted）→ cmdline 取空 → is_self 永远 false → cleanup 的 PID 文件路径与 pgrep 兜底路径全部静默跳过 → stop 返回成功但一个都不杀 → 每次 start 新起一套、旧套占着不死 → 累积 4 套（9222 先到先得）。
- **修复**：is_self 改为 **pgrep 集合判定**——`pgrep -f "$SELF_MARK"` 列出所有 cmdline 含本仓库绝对路径的进程（macOS pgrep -f 匹配完整 cmdline，sandbox 可用；微信路径绝不含此子串，安全性不变），目标 pid 在集合内即 self。不依赖 ps。
- **验证**：start → status 补记 PID → stop 后 main/全部 desktop 进程/helper/9222 端口全部清零（修复前 stop 是静默空操作）；再 start 单实例正常、CDP 可达、UI 完整。
- **教训**：凡 Agent 工具会调用的 shell 脚本，**禁止依赖 ps**（sandbox 必禁）；进程筛选一律用 pgrep/pkill 的 pattern 匹配能力。今后验证 cdp.sh stop 后必须检查 `pgrep -f <repo>/packages/desktop/lib/` 计数归零，不能只看脚本输出。

### 2026-08-28 · 红绿灯定位对齐标题栏图标中线（trafficLightPosition）

- **用户需求**：macOS 红绿灯（hiddenInset 保留）与标题栏图标水平中线对齐；并问能否「重绘」。
- **结论**：原生红绿灯**样式不可定制**（系统绘制）；可 `trafficLightPosition` 调位置（本次方案），或 `frame:false` 完全自绘（需补齐 hover 图标/双击缩放等，不推荐）。
- **实现**（`electron/main.ts`）：标题栏行高 40 → 图标中线 y=20（CDP 实测）。`trafficLightPosition: {x:12, y:13}` 经三轮实测定标：y=14 偏低 2px → y=12 偏高 1px → **y=13 正好**（y 语义含灯组内上边距，非净灯组上缘）。x=12 保持系统标准 inset。
- **验证**：用户目检三轮收敛确认「非常完美」。

### 2026-08-28 · 全界面字号统一放大（设计稿 2026-08-28 放大版对齐）

- **用户定调**：设计稿已统一放大字号（约 +3~5px），当前界面字体太小，按设计稿适配。
- **新基准**（Pencil MCP 逐节点读取，无截断）：会话行标题/组名/树项 12→**16**、区头标签/新会话/AI who/Review 11→**15**、会话时间/消息 dur 10→**14**、消息正文（user/AI bubble）13→**17**、输入框 placeholder/终端 ×→**17**、tool cmd/终端行/Review diff mono→**15**、审批 body mono→**16**、标题栏图标 16→**18**、组行 chevron 12→**16**/folder 14→**18**、区头 icon 12→**16**、20×20 按钮内 icon 全部→**16**。
- **改动（5 包，~70 处）**：
  - `corum-ide-ui`（sidebar.module.css + AppFrame.tsx/module.css）：侧栏 btnNew/secHeadTitle/groupTitle/srTitle/srTime/srResult*/empty* 字号 + SessionsPane 图标尺寸；标题栏图标 18 +「插件」文本 15/400 + Agent 标题栏 title 15/stats mono 12 + 轨迹 icon 18/chev 12；**插件按钮防换行**（white-space:nowrap）+ **红绿灯让位 84→76**（修文本放大后右溢 6px 压对话区：让位 76 > 灯组右缘 67 安全，腾出 8px）。
  - `corum-ide-conversation-ui`：消息/子 Agent/tool/审批/Review/输入框/工具栏 26 处字号 + 12 处图标尺寸 + reviewChev。
  - `corum-ide-panel-bottom-ui`：tab 16、终端行 mono 15、× 17。
  - `corum-ide-explorer-ui`：树项/headerRoot 16、图标 16-18（caret 占位同步 12→16 防缩进错位）。
  - `corum-ide-sidebar-ui`/`corum-ide-project-ui`：消费同源 sidebar.module.css，随改重建。
- **验证（CDP + 截图走查）**：实测字号全部命中设计值（srTitle 16/srTime 14/groupTitle 16/headTitle 15/btnNew 15…）；插件按钮 right 290 ≤ 侧栏右缘 300 不溢出；截图 `/tmp/corum-cdp/shots/font-scaled-final.png` 全区域对照设计稿一致。六包 tsc 通过。
- **包依赖**：五包均经 HMR 热交换生效（样式竞态修复后可靠）；为 sidebar.module.css 消费方一致性，sidebar-ui/project-ui 一并重建。

### 2026-08-28 · UI 走查四项修复（字号放大后的细节对齐）

- **用户走查四问题 + 根因 + 修复**：
  1. **设置图标颜色过白**：SettingsShell 触发器（sidebar.settings 槽）默认 label-primary（rgb 243,236,255），设计稿标题栏图标全部 label-secondary。`AppFrame.module.css` `.navSettingsSeat [class*='_trigger']` 显式 `color: label-secondary`（hover 回 primary）。
  2. **Agent 标题栏轨迹按钮溢出对话区右缘 20px**：字号放大后 statusPill（stats mono 12「7 轮 · 12m 34s · In 12.4k / Out 3.1k · 命中 61%」）实测 366px，title 90 + divider 1 + pill 366 + trajBtn 28 + gap 32 = 517 > 内容区 485（对话区 509 − padding 24），spacer 被压 0、轨迹被挤出。修：`.agentStatusPill` `flex:none→0 1 auto; min-width:0; overflow:hidden` + `.agentStats` 加 ellipsis——stats 过长自动省略（「命…」），轨迹 right 829→797 ≤ 809。
  3. **工作区区头三图标被压成 8px**：`.headBtn/.headSearchBtn/.headSearchClear/.groupBtn` 四个 20×20 按钮类**忘了写 `padding:0`**——浏览器 UA button 默认 padding `1px 6px` 把内容区挤成 8px，16px svg 被 flex 压成 8×16 变形。补 `padding:0` 后图标恢复 16px。**教训**：自定义小尺寸按钮类必须显式 `padding:0` 覆盖 UA 默认。
  4. **品牌图与项目/任务按钮不符**：brand 是旧值 166×40 radius 6（设计 156×40 r10）、mode-seg 文本 11px（设计 15）。`.brand/.brandImg/.brandImgDark` 166→156、radius 6→10；`.modeSeg` fontSize 11→15。
- **Agent 标题栏设计定稿（用户节奏：先改设计稿再落码）**：组件 `b4p03B` 设计稿宽 900 → **改到与实机一致的 509**，在画板上直接调参看效果——stats mono 12→**10.5**（509 宽下不省略的最大字号）、status-pill gap 8→6、容器 gap 8→6、padding [0,12]→[0,10]；spacer 余 25px、轨迹按钮不再 partially clipped。用户确认后落码（`.agentStats` 10.5px、`.agentStatusPill` gap 6、`.agentTitleBar` gap 6 padding [0,10]），实机 trajRight 799 ≤ 809、stats 完整显示无省略（statsClipped=false）。**此工作流（设计稿先调到实机尺寸定稿 → 再改代码）比「代码试错」高效，后续尺寸冲突沿用。**
- **验证（CDP 实测 + 截图）**：settingsColor=navColor=rgb(179,166,217)；trajRight 797 ≤ convoRight 809；区头三 icon 全 16px；brand 156/radius 10；segFont 15px。截图 `/tmp/corum-cdp/shots/walkthrough-fixed.png`。两包 tsc 通过。

### 2026-08-28 · brand-row 重设计（横排鲸鱼图标）+ 程序图标替换 logo.png

- **背景**：用户给侧栏换了新浅色品牌图（带浅紫渐变背景、内容比例 4.83 ≠ 旧图 4.74），且拍板「深/浅主题都用这张」。试排后用户否决竖排/玻璃卡片方案（太丑），定调**必须横排**、「不行就用 Logo 文字自绘」，并提供 `doc/UXDesign/images/logo.png`（鲸鱼图标，白底圆角方块 1254×1254）作为新程序图标。
- **设计定稿（design W7RwT1，画板直调）**：logo.png 图标 **36×36 圆角 10**（fit，白底方块在深色侧栏是干净的亮点）+ mode-switch **110×36**（「项目/任务」），横排 space-between。弃用带浅紫背景的整图（任何底衬都会和它的自带渐变打架）。
- **落码**：
  - `SidebarSkeleton.tsx`：brand 区两张 brand_logo_*_crop 图 → 单张 `corumapp://app/assets/icon.png`（logo.png 拷入 assets）。
  - `sidebar.module.css`：`.brand` 166×40 r10 → **36×36 r10**、删 dark 变体规则（单图双主题）；`.modeSwitch` 加 `width:110px; height:36px`。
  - 顺手把 `doc/UXDesign/images/brand_logo_light_crop.png` 按内容净边界重裁（sips，去上下渐变留白，x[150,2090] y[125,527] = 1940×402 比例 4.83；备日后复用，当前设计稿已不用它）。
- **程序图标替换（logo.png → corum 鲸鱼）**：
  - `assets/icon.icns`：logo.png 经 iconutil 生成全尺寸 iconset → icns（1.7MB）。
  - `package.json` build：`mac.icon: "assets/icon.icns"`（打包态 CFBundleIconFile）；**extraResources 补 `{from:"assets", to:"assets"}`**——这是既有遗漏（assets 静态图从未进安装包，协议在打包态读 Resources/assets 会 404，品牌图/背景图一并修复）。
  - `main.ts`：dev 态 `app.dock.setIcon(nativeImage.createFromPath(assets/icon.png))`（macOS；打包态由 Info.plist 接管，文件缺失时 isEmpty 跳过无害）。
- **验证（CDP + 截图）**：brand 36×36 r10、img icon.png 加载成功、mode-switch 110×36；截图 `/tmp/corum-cdp/shots/brand-row-final.png` 与设计稿 v5 一致；dock 图标已换鲸鱼（用户目检）。

### 2026-08-28 · App 改名：中文「矩道」/ 英文「Corum」

- **用户定调**：App 名 中文「矩道」、英文「Corum」。
- **改动**：
  - `electron/main.ts` 窗口 title：'DeepSeek Harness' → `app.getLocale().startsWith('zh') ? '矩道' : 'Corum'`（hiddenInset 自绘标题栏下窗口 title 不上屏，影响 Mission Control/窗口菜单/活动监视器）。
  - `package.json` build：`productName: "corum Agent OS" → "Corum"`（.app 文件名 = Corum.app，electron-builder 单值不支持双语）；`extendInfo.CFBundleDisplayName: "矩道"`（macOS Finder 中文系统显示名，英文系统回退 Corum）。appId `com.corum.agentos` 保留（改名不动 bundle id，避免数据目录漂移）。
  - `src/index.ts` 两处 Agent 提示文本「DeepSeek Harness desktop application」→「Corum desktop application」；`package.json` description 同步。
- **logo.png 裁剪比例备查**：1254×1254（1:1），brand 框 36×36（1:1）→ **不裁剪**，fit 缩放 2.87% 完整显示；macOS icns 同 1:1。带文字品牌图（1940×402 比例 4.83）放 36 方框 fit→36×7.5 / fill→裁宽 92.6%，故不可用整图。

### 2026-08-28 · brand-row 终版：矩道品牌卡横排（brand_card.png）

- **迭代过程**：整图带文字方案试过三版——① 4.85:1 扁图（Corum Harness+立矩成道）横排 134×28 副标题 6px 糊、竖排整宽被否（竖排丑/浅紫底突兀）；② 用户裁的 4.85:1 白底图横排 134×36 主标题可读副标题仍糊；③ **用户给的矩道品牌卡**（1774×887，卡片净边界 1751×704 比例 **2.49:1**——鲸鱼+矩道+深度求索驾驭驱动+Corum Harness+Powered by DSH+彩色描边一体卡）→ 横排 **134×54** 文字全可读、卡片描边与 mode-switch 紫色玻璃底同色系协调，用户确认「很好」。
- **设计定稿（design W7RwT1 v7）**：brand_card.png 134×54 圆角 10（fit）+ mode-switch 110×36（行高 54 垂直居中），横排 space-between。
- **落码**：`SidebarSkeleton.tsx` brand 区 → `corumapp://app/assets/brand_card.png`；`sidebar.module.css` `.brand` → 134×54 r10 contain。品牌卡拷入 `packages/desktop/assets/brand_card.png`（extraResources 已含 assets，打包态可达）。
- **验证（CDP + 截图）**：brand 134×54、img 加载成功、mode-switch 110 宽且中心线 y=83=行中心线（垂直居中）；截图 `/tmp/corum-cdp/shots/brand-card-final.png` 与设计稿 v7 一致。
- **沉淀**：带文字品牌图的可用下限——横排时主内容（文字）必须 ≥12px，即图的内容比例 ≤ 框宽/（文字像素/12）；2.5:1 左右的「卡片式品牌图」比 4.8:1 的「扁横幅」更适合侧栏横排小空间。

### 2026-08-28 · 侧栏折叠收起：GridView 折叠机制 + 56px 图标轨（design L1 侧栏折叠态 J0PbdL）

- **用户选中**：设计稿 `J0PbdL`「L1 主界面 · 深色 · 侧栏折叠」整页变体，要求实现折叠交互。
- **设计稿折叠态**：col-nav 收 **56px 竖排图标栏**（9 个 24×24 按钮：panel-left-close 展开 / message-circle-plus 新会话 / 自定义 path 添加工作区 / search / columns-2 面板 / terminal 终端 / blocks 插件 / moon 主题 / settings 设置）；titlebar-row 窗口标题栏缩 66 只留红绿灯、**6 个图标全隐藏**（Agent 标题栏占满对话区上方）。
- **旧实现的不足**：`sidebarCollapsed` 仅 `display:none` 隐藏 sidebarPane 内容（leaf 仍占 300 宽留空）——不是设计稿的 56px 轨。
- **实现（三层）**：
  1. **grid.ts**：`SlotMeta.collapsedWidth?: number`（声明折叠宽）+ 模块级折叠态注册表（`setSlotCollapsed/isSlotCollapsed/slotCollapsedWidth`）；`leafMinSize` 折叠态取 collapsedWidth（替代 minWidth——**窗口自适应 rescaleGrid 不会把折叠侧栏拉回 300**，sash 传导同理）。
  2. **GridView.tsx**：props 加 `collapsedSlots?: ReadonlySet<string>`；`computeCellSizes` 加 `locked: (number|null)[]`——locked 格宽度锁定（从 span 先扣除，不参与 weight 分配）；locked 格相邻 sash 隐藏（宽度锁定不可拖）。
  3. **AppFrame.tsx**：`onToggleSidebar` 同步 `setSlotCollapsed('corum.sidebar', next)`；GridView 传 `collapsedSlots`（useMemo 稳引用）；`ide-layout.ts` sidebar 注册加 `collapsedWidth: 56`；`renderGridSlot` sidebar 分支折叠时渲染新 **SidebarRail** 组件（9 按钮竖排轨，替代 sidebarPane）；NavTitleBar 折叠时 `navTitleBarActions` 整体隐藏（循设计稿；toggle 图标简化——展开入口在轨上）。
  4. **SidebarRail 按钮语义**：前三个（新会话/添加工作区/搜索）是侧栏功能——折叠态点击 = 展开侧栏（对应功能在展开后的会话列表可用）；后五个（面板/终端/插件/主题/设置）直通 AppFrame 层动作。设置复用 `sidebar.settings` 槽触发器（railSettingsSeat 覆盖 24×24 形态）。
- **红绿灯几何验证**：折叠后侧栏 56、对话区 x=70（56+gap14）——窗口红绿灯（x[12,67]，hiddenInset 系统元素位置固定不随侧栏变）右缘 67 < 70 恰好不压对话区，无需调让位。
- **验证（CDP，重启后干净态）**：折叠 sidebarW 300→56、SidebarRail 9 按钮、navActions 全隐藏；展开 56→300、轨消失、标题栏/品牌卡回归；折叠后 sidebar 右缘 sash `visibility:hidden`（锁定不可拖，其余 sash 正常）；窗口 resize 后折叠态稳定（56 不被 rescaleGrid 拉回 300）。四包 tsc 通过。截图 `/tmp/corum-cdp/shots/sidebar-collapsed.png`。
- **包依赖**：GridView 是根结构（`corum-ide-ui` 内联打包 ui-base 的 grid/GridView）——改 ui-base 后 **corum-ide-ui 必须重建**（本次两包都重建；sidebar.module.css 未动，sidebar-ui/project-ui 为消费一致性一并重建）。

### 2026-08-28 · 会话行增强：标题跑马灯 + 右键菜单（重命名/归档/分叉/提炼经验占位）

- **用户需求**：会话栏标题跑马灯；右键菜单四项——重命名、归档、分叉会话、提炼经验（用户定调提炼经验本轮**占位禁用**，语义后定）。
- **跑马灯（`SessionsPane.tsx` SessionRow + `sidebar.module.css`）**：
  - 溢出检测：`titleRef` + ResizeObserver，`scrollWidth > clientWidth + 1` 时启用（字号放大后长标题才会溢出，短标题不触发）。
  - 结构：srTitle 作裁剪窗（`srTitleMarquee` 去 ellipsis），内层 `marqueeTrack` 双份文本（chunk + chunk aria-hidden，间隔 padding-right 32）无缝循环；`@keyframes sr-marquee` 平移 0→-50%（一份+间隔宽）10s linear infinite。
  - 触发：`.sr:hover / .srActive` 时滚动，移出停回卷首；`prefers-reduced-motion` 降级不滚。**注意**：CSS `:hover` 是浏览器原生状态，CDP 合成 mouseenter 不触发——验证靠规则注入检查 + 用户目检。
- **右键菜单（官方 `Menu` 原语 portal + `onContextMenu`）**：四项 + 分隔线 + 禁用态。
  - **重命名**：复用既有行内重命名（`onStartRename` → input 预填标题，Enter/Escape/blur 提交）——原双击触发保留，菜单是第二入口。
  - **归档**：`ctx.workspaces.archiveSession(sessionId)`（官方语义：archived 会话隐藏出分组列表、日志/账号槽保留；归档当前会话回新会话视图）。inject 面新增 `archive`。
  - **分叉会话**：`ctx.sessions.fork({sessionId})` → `ctx.sessions.open(childId)`（官方 fork：从最近完成轮次切子会话并打开）。inject 面新增 `fork`。
  - **提炼经验**：占位项 `disabled: true`（官方 Menu 对 disabled 行置灰 opacity 0.4 且不触发 onSelect），语义待定义。
  - 动作透传链：SessionsPane（inject 面）→ WorkspaceGroup（`onForkRow/onArchiveRow`）→ SessionRow（组内/扁平两处渲染统一 props）。
- **验证（CDP）**：右键出菜单四项（重命名/归档/分叉/提炼经验置灰 opacity 0.4）；点重命名出行内输入框（预填标题）；点归档 13→12 目标会话消失；点分叉 12→13 出现同名子会话（fork 成功并打开）；跑马灯溢出检测 hasMarquee/track 就位 + 动画规则注入。截图 `/tmp/corum-cdp/shots/session-row-menu.png`。sidebar-ui tsc 通过。
- **测试回归两修复**：
  1. **菜单无图标**：四项补 lucide 图标（重命名 Pencil / 归档 Archive / 分叉会话 GitFork / 提炼经验 Sparkles）——官方 Menu `MenuItem.icon` 直接承载。
  2. **改名后标题「重复两遍」过渡 bug**：根因是跑马灯——改名后 row 更新、render 期 `overflowing` 仍是旧值 true（useEffect 未跑），先渲染一帧 marquee 双份文本再被 effect 纠正，用户看到「测试改名ABC测试改名ABC」以为改名没生效。**修复**：溢出检测改 `useLayoutEffect`（paint 前同步测量）+ 依赖从 `row` 收窄为 `rowTitle(row)` 结果——改名后 title 变 → layout effect 在浏览器绘制前完成重测，不再闪过双份。功能本身（rename RPC + 持久化）验证无误（刷新后新标题保留）。


### 2026-08-28 · 走查三项：重命名根因（subagent 漏滤）+ 中文时间 + 项目模式字号放大

- **问题 3（重命名无法成功）根因与修复**：
  - **现象**：用户实测双击/右键重命名都「没生效」（kkc-desktop 组正常、未分组失败）。
  - **根因**：未分组桶混入了**子 Agent 路由会话**（`origin: 'subagent'`、UUID 形态 id）——它们的标题由 subagent routing 管理，host 拒绝 rename（`session "..." is owned by subagent routing`），而 `submitRename` 的 `.catch(() => {})` **静默吞错**，用户看不到失败原因。旧过滤 `isTaskSessionId` 只按 id 前缀（corum-proj/corum-dev-），漏了 UUID 形态的 subagent 会话。
  - **修复（对齐官方 WorkspaceBrowser `origin !== "subagent"` 规则）**：新增 `isTaskSession(row)` = id 前缀 + `origin !== 'subagent'`——子 Agent 会话不进任务模式列表（由对话区子 Agent 卡承载，与官方一致）。列表 12→7 行，所有可见行重命名均成功。
  - **副产**：`submitRename` catch 不再静默——打 console + 区头下方 `projectError` 显示「重命名失败：<原因>」（排错窗口，避免后续同类静默失败）。
  - **教训**：RPC 失败**绝不静默吞**——用户会把「失败」当「没生效」；错误必须可见（console + UI 反馈）。
- **问题 2（中文时间）**：`timeLabel` 改中文「刚刚 / N 分钟 / N 小时 / N 天 / M/D」（原 2m/1h/1d 英文缩写）。
- **问题 1（项目模式字号图标放大 + 设计稿同步）**：
  - 设计稿 L2 ④ 项目详情页**本身没放大**（只有任务模式放了），用户定调「按任务模式比例放大**并同步设计稿**」。
  - **设计稿**：`HmXQH` ④ 文本批量 12→16/11→15/10→14/9→13（Pencil MCP Update；页标题标注 sL5dh 不动），导出确认布局未崩。
  - **代码**：`sidebar.module.css` 项目段（596 行后）26 处字号同步放大；`ProjectPane.tsx` 图标放大（secHead icon 12→16、history folder 14→18、project header folder-open 16→18、管理段 icon 13→16/chevron 11→14、团队段 users 12→16/teamChevron 10→14、打开项目 folder-open 11→15/History 12→16）。
  - 验证：项目模式打开项目/详情页（管理段/团队段/泳道会话）字号图标与任务模式一致，切模式不跳变。截图 `/tmp/corum-cdp/shots/project-mode-scaled.png` / `project-detail-scaled.png`。
- **验证**：三包 tsc 通过；中文时间「37 分钟」✓；未分组重命名成功无报错 ✓。

### 2026-08-28 · 提交拆分 + 标题栏拖拽/点击命中两修复

- **本轮改动按功能拆 commit**：工作区 26 个改动文件 + 3 个新资产按功能拆成 11 个提交
  （f5ff4029 cdp.sh → 1b6ef51b 文档）。方法：补丁手术（git apply --cached 按 hunk 拆）
  对同文件多 hunk 交错不可靠（`title:`/`titleBarStyle` 上下文误匹配、index 行过期），
  改用**临时分支全量恢复法**——备份全部改动到 /tmp/wip-backup → tmp 分支逐组
  「恢复 HEAD → 拷回本组文件（必要时 edit_fn 裁剪）→ commit」→ 最后 feat 分支
  `reset --hard` 到 tmp 栈顶。校验：tmp 栈顶所有 tracked 文件与 /tmp/wip-backup 逐字节
  一致（diff -q 全过），排除项（design.pen/project 配置/设计源图）保持未跟踪。
- **走查问题 1（展开态左上角按钮 hover 无法点击，变成拖窗口）**：
  - **根因**：`.titlebarDrag * { -webkit-app-region: drag }` 通配把段内所有后代强设为
    drag；其特异性 (0,1,1) 与按钮 no-drag 规则（`.titlebarDrag .navIconBtn` 等）相同，
    但通配写在**后**——同特异性后写胜出，按钮被改回 drag 不可点。
  - **修复**：删整条 `.titlebarDrag *` 通配。app-region「子元素覆盖父级」只对**显式
    声明**了 app-region 的后代生效，未声明的后代落入父级 drag 命中区（可拖）；段内可点
    控件（navIconBtn/navPluginBtn/navSettingsSeat）本就显式 no-drag，无需通配。
- **走查问题 2（Agent 标题栏空白处无法拖动，文字/按钮反而可拖）**：
  - **根因**：`.agentTitleBar` 根显式 `no-drag`（旧注释「no-drag（按钮可点）」）——
    整根不可拖（含空白）；而内部文字/按钮落在 `.titlebarDrag *` 的 drag 命中里反可拖。
  - **修复**：`.agentTitleBar` 根改 `drag`（空白落入命中区可拖），内部 `agentTitle` /
    `agentStatusPill` / `agentTrajBtn` 各自补 `no-drag`（文字可选、按钮可点），
    `agentSpacer` 无声明随根可拖。
- **关键认知（app-region 命中模型）**：`-webkit-app-region` 非继承、初始 none；
  「子覆盖父」**仅对显式声明的后代**生效——未声明的后代继承父级命中区。所以
  drag 容器里**不要**用 `* { drag }` 通配（会覆盖按钮的 no-drag 且特异性打平后写者胜）；
  正确做法是「容器 drag + 可点控件各自显式 no-drag」。
- **验证（CDP 计算值）**：navIconBtn×4/navPluginBtn/navSettingsSeat=`no-drag`（按钮
  可点）；agentTitleBar=`drag`（空白可拖），agentTitle/agentStatusPill/agentTrajBtn=
  `no-drag`（文字可选、按钮可点），agentSpacer=`none`→随父 drag 命中（可拖）。
  重建 corum-ide-ui（AppFrame.module.css 仅其消费）+ 重启实例（壳层改动 HMR 不可靠），
  leafs=5 渲染正常。截图 `/tmp/corum-cdp/shots/titlebar-fix.png`。提交 8ae5f0b5。

### 2026-08-28 · 隐藏区域后兄弟格不铺满——branch 子整体隐藏判定

- **走查两问题（同根因）**：
  1. 隐藏编辑器+资源管理器 → **终端不向上铺满**（仍停 y=633）。
  2. 隐藏终端/编辑器/资源管理器（right-col 全隐藏）→ **对话区不向右铺满**（仍 509）。
- **根因（GridView BranchView 的 detached 误判）**：`detached = branch.children.map(c =>
  c.type === 'leaf' && (... || c.hidden === true))` 只看**直接子 leaf** 的 hidden。外层
  分支的直接子是**嵌套 branch**（right-col 里的 `row(editor,explorer)`、root row 里的
  `right-col=column(...)`）时，`c.type==='leaf'` 对 branch 恒 false → 该支永判不出隐藏，
  `computeCellSizes` 仍按 weights 分配占位，兄弟格填不满。复现：外层 column 的 top-row
  （branch）仍 633、panel 仍 227；root row 的 right-col（branch）仍 471。
- **修复（ui-base，两处）**：
  1. **新增 `nodeAllHidden(node)`**（grid.ts）：leaf 看自身 hidden；branch 递归判「所有
     后代 leaf 全 hidden」。BranchView 的 detached 对 **branch 子**改用它（`detachedSlots`
     运行时脱出只作用 leaf，branch 不判——脱出是临时态）。→ 全隐藏支 size=0，兄弟按
     weight 瓜分 freeSpan 填满。
  2. **`subtreeMinSize` 对 hidden leaf / 全隐藏 branch 返回 0**：原「隐藏/脱出的叶子也
     计入 min」会把全隐藏支的 min（top-row 633）算进 minTotal，兄弟格被「隐形 min」顶住
     无法填满。leaf hidden→0 后，branch 求和/取 max 自然传导为 0（无需 branch 短路）。
- **未动 `rescaleGrid`**：窗口自适应仍按 weight 比例分配（全隐藏支 weight 保留），但
  computeCellSizes 里 detached 格 size=0、weight 不进 total，渲染不受 weight 影响——
  恢复显示时 weight 原样生效（期望的「记住拖拽比例」），故不阻塞。
- **验证（CDP 实机，重启后）**：① 隐藏 editor+explorer → 终端铺满整列（y=0,h=860）；
  ② 隐藏终端 → editor/explorer 向下铺满（h 633→860）；③ right-col 全隐藏 → 对话区
  向右铺满（sidebar 475+convo 805=1280）；④ 全部恢复 → 几何**精确回基线**（sidebar 300/
  convo 509/editor 266/explorer 205/panel 471×227，weight 持久化无漂移）。截图
  `fill-terminal.png`。重建 ui-base + ide-ui（内联打包）。提交 9d2326b2。
- **认知沉淀**：分割树的「整支隐藏」判定必须是**递归**的——外层分支的直接子可能是
  嵌套 branch，只看直接子 leaf.hidden 会漏判「branch 内部全隐藏」。任何「按可见性子
  树分配空间」的算法（detached / minSize / 将来的 drop 命中）都要用 nodeAllHidden 而
  非浅层 c.hidden。

### 2026-08-28 · 会话栏 UI 与设计稿完全统一（design yoxDi ② Agent 对话区）

- **任务**：会话栏开发第一阶段——交互界面与设计稿**完全统一**，之后逐功能接真实数据。
  本阶段只做视觉/结构对齐（数据仍为设计稿假数据，接真在下一阶段）。
- **设计稿事实源读取**（Pencil MCP，脑补禁令）：对话区画板 `yoxDi`（L1 主界面·深色
  ZhjRX → main-row → left-col → left-body → ② Agent 对话区）。结构 = Chat Flow(lrEmq:
  gutter vESwF + messages wJLY6) → Review Card(nzgrI) → task-line(sKrdG) → Chat Input
  (htxWi)。token 经 GetVariables 取 dark 值。
- **与旧实现的差异（逐项按设计稿重写 ConversationArea.tsx/.css）**：
  1. **user 卡**：旧是 glass-1 普通卡；设计是**品牌气泡**（brand-primary 实底 #01CDFE、
     r[14,14,4,14] 右下小角=说话方）`alignItems:end` 靠右 + user-actions（修改 pencil /
     复制 copy / 回退 rotate-ccw，26×26 glass-2 钮）。气泡头 You/time 用 on-brand-muted
     （#0A0612B3），正文 label-on-brand（#0A0612）。
  2. **ai 卡**：补 ai-actions 行（左 dur-time「耗时 12s」label-tertiary + 右 分叉
     git-branch / 复制 copy，jc:end）。head 的 dur 是时间 14:32（label-secondary）。
  3. **subagent 卡**：字号放大（name 16/task 14/chip 14/step 15）。
  4. **tool 行**：meta 拆 +48（state-success #3EE6B0）/ −12（state-error #FF5C8A）。
  5. **awaiting 审批卡**：actions 改**拆分按钮** allow-split（brand-primary r10：
     btn-main「允许一次」+ divider #FFFFFF40 + btn-chev ▾）+ 拒绝（glass-2 r10），
     jc:end 靠右；新增允许方式 menu（item-允许一次 check 选中 / 始终允许，**默认收起**，
     点 ▾ 展开——设计稿里 absolute 浮层是展开态示意）。
  6. **新增 task-line**（sKrdG，旧完全没有）：h40 glass-1 r14，7 步点（done success×3 /
     active warn halo 16+dot 10 / todo dimmed×3）+ 虚线连接（linear-gradient 3px dash+5px 空，
     done 段 success 色）+ 展开钮 chevron-down。
  7. **Chat Flow 加 gutter**（8px 竖排步点轨，label-tertiary，当前步 brand-primary）。
  8. **Chat Input**：删设计稿没有的 **gauge 上下文用量钮**（旧多加的）；发送钮底色
     success→**brand-primary**（修正旧误色）；Enter 发送补 `isComposing` 判断（沿用
     会话行中文输入教训）。
- **新增 token**：`--corum-on-brand-muted`（深 #0A0612B3 / 浅 #FFFFFFB3，气泡次级文字），
  写入 ide-ui theme.css 双值。
- **验证（CDP 计算值，全命中设计 token dark）**：气泡底 #01CDFE/圆角 14,14,4/flex-end、
  on-brand #0A0612、muted rgba(10,6,18,0.7)、brand-text #4DE3FF、await 边框 #FFB45C、
  允许一次 #01CDFE/#0A0612、task done #3EE6B0/active+halo #FFB45C、tool #3EE6B0/#FF5C8A、
  gauge 不存在、发送 #01CDFE。conversation-ui + ide-ui 重建、tsc 通过、重启实例。
  截图 `/tmp/corum-cdp/shots/convo-redesign.png`。提交 fe58cdc0。
- **下一步**：逐功能接真实数据（消息流/统计/子 Agent 卡/工具调用/审批/task-line/输入
  发送），按用户逐项指定推进。

### 2026-08-28 · task 模式迁移泳道 AgentLoop + 对话区真实消息流（方案 C）

- **背景决策（用户多轮定调）**：task 模式从官方 session-xxx 迁移到 corum 泳道
  AgentLoop——与 project 泳道**统一自家数据通路**（agent.session.events →
  simplifyEventData → 自家 RPC），task/project 会话互相不可见（by design）；session id
  用 corum 组合形态（corum-task-*），不复用官方 session-xxx 结构。
- **关键调查结论**：
  1. AgentTestPanel 链路（corum-agent-dev 读 agent.session.events 自研投影）服务的是
     dev-agent **泳道 Agent**（corum-proj-*/corum-dev-*），与 IDE 侧栏 task 会话
     （官方 session-xxx，ctx.sessions.list）是**两套会话体系**。
  2. IDE 侧栏 task 会话 = 官方 ctx.sessions.create 创建的 session-xxx（session-controller
     RPC）；发送走官方 ctx.sessions binding 的 prompt（agent.followup）。
  3. 对话区官方投影（ui-conversation 的 conversationEvents/Views）在 cordis.ide.patch.yml
     被禁用 → useSession 快照 nodes 恒空（曾误诊为渲染 bug，CDP data-convo-debug 实证
     openState:open 但 nodesLen:0）。
  4. **adopt 可行性实证**：corum ctx.agents.create 创建的泳道会话有官方
     session.jsonl.zstd 持久化、经 ctx.sessions.flush 同步——**完全进入官方 session
     体系**（id 只是 corum 自定义形态，官方接受）。
- **host（corum-agent-dev，提交 dcb9f06d）**：
  - `createAgentForTask(cwd, profileId='task')`：task 专用通道——不强绑 projectId/项目
    组成员、lane 无 requirementId；session id=corum-task-<rand>；cwd=用户工作区；持久化
    索引落伪项目目录 task/，resume 走官方 session-persistence。
  - 内置 task profile（ensureTaskProfile，单任务语义）+ taskAgents 存活表。
  - RPC：createTaskAgent / runPromptForTask / getTaskSessionEvents / listTaskAgents。
  - **simplifyEventData 两修复**：① user/message content 兼容 data.content（官方顶层，
    原只读 data.message.content → user 消息投影空、user 卡不渲染）；② assistant/message
    内联 tool-call 补 arguments（原只留 name → 工具行无命令）。
  - **踩坑**：JSDoc 注释里写 `corum-proj-*/corum-dev-*`，其中 `*/` 序列提前闭合 JSDoc
    → 全文解析漂移报几十条语法错（行号全是误导，首个报错点 855 与真实源头 663 差 192 行）。
    **教训**：JSDoc/注释里写通配路径时避免 `*/` 序列（用「corum-proj 系」或转义）。
- **对话区（conversation-ui，提交 89dd986e）**：从官方 useSession 迁移到泳道 RPC——
  callAgent（corumAgent RPC 经 IPC 桥）；cwd=当前会话工作目录寻址；消息流
  getTaskSessionEvents 拉 DTO 按 type 映射卡片（user 气泡/ai 卡 text+reasoning 折叠+内联
  tool-call / tool 行 callId 配对）；发送 runPromptForTask 后重拉；busy 占位 + 跟随滚动。
- **验证（CDP 实机）**：卡片序列 user/user/ai/user/ai/toolRow/ai；tool 参数
  `bash · echo hello-corum`、`cat package.json | grep '"name"'` 完整显示；发送后
  user 气泡 + tool 行 + ai 回复全链路。截图 convo-task-final.png。
- **下一步**：侧栏 task 列表改读 listTaskAgents + startSession 走 createTaskAgent（会话
  体系迁移收尾）；然后逐功能接（审批/统计/子 Agent 卡/Review/task-line）；project 模式
  对话区复用同一泳道通路（getSessionEventsForType 已存在）。

### 2026-08-28 · task 模式 UI 适配：回归官方对象层（PLAN-task-lane-ui-adaptation 全落地）

- **重大事实更正**（DISCUSSION 文首 + CDP 复核）：**泳道会话已在官方 ctx.sessions 对象层**
  （`ctx.agents.create` 的 `agent.ctx.sessions.enter/announce` 注册进 root SessionStore 单例
  → sessionQuery.listSessions → 官方对象层 list）。此前「官方 list 不含泳道需自建」的判断
  **错误**——实为侧栏 blank 过滤把 `blank:true` 的泳道滤掉所致（对象层 corumTask=20+，
  渲染 0）。方案从「脱离官方自建」翻转为「**管理面回归官方对象层，数据面保留泳道投影，
  创建面走泳道 RPC**」。
- **3 决策（用户拍板）**：A 发送=A2 官方 session.prompt；B session-* 测试残留只筛不删；
  C 泳道 fork 第一版禁用。
- **侧栏（91ff1c34）**：isTaskSessionId 筛 corum-task- 前缀；blank 过滤恢复官方语义（测试
  残留空泳道自然被滤）；startSession 换泳道 createTaskAgent RPC（起 corum-task-*）+ open
  选中；fork 对泳道禁用。
- **对话区（db81d6fd）**：寻址 cwd→list.current（sessionId，删 refresh 重复建会话 bug——
  同 cwd 曾起 13+ 泳道）；发送切官方 session.prompt（泳道在对象层有 binding；prompt 异步
  入队，pollUntilIdle 轮询泳道投影直到新 assistant 落地再重拉）；注入恢复 sessionOf。
- **host（69e2ba18）三修复**：
  ① `getTaskSessionEvents`/`listTaskAgents` 改读 `ctx.sessionPersistence.readFrom`（全历史）
  ——`agent.session.events` 窗口在冷 resume 后只含 4 条会话种子，历史在持久化；
  ② `resolveTaskAgent` 复用官方 activated agent（泳道经对象层激活后 ctx.agents.get 命中
  直接用，不再 resume——官方 agents.resume 拒 live 会话报「cannot prepare while live」）；
  ③ `index.ts` inject 补 sessionPersistence（**插件 fiber 注入声明在 index.ts，service 类
  static inject 不生效**——报「cannot get property without inject」）。
- **CDP 实机验证（PLAN 清单 5 项全过）**：侧栏只显示泳道按时间排序、新会话起 corum-task-*、
  选中联动对话区拉事件渲染（user/user/ai）、官方 prompt 发送新增 user/ai/toolRow（tool
  参数 bash · echo A2-test 完整）、模型选择器点亮（DeepSeek-V4-Flash High，泳道
  session.models 作用域生效）、不再重复建会话。截图 plan-e2e.png。
- **踩坑沉淀**：① 官方对象层 list 与侧栏渲染可能不一致（blank 过滤等渲染逻辑）——验证
  「在不在对象层」要读对象层 ids，别看渲染行数；② 冷泳道历史在持久化不在 agent.session
  .events 窗口；③ cordis Service 注入以**插件 index.ts 的 inject 数组**为准。
- **下一步**：审批（awaiting 卡接真实 pending interaction）/统计/子 Agent 卡/Review/
  task-line 逐项接；project 模式对话区复用同一泳道通路；泳道 fork 语义设计。

### 2026-08-29 · dsh 基座 0.1.1-rc.2 → 0.1.2-alpha.1 全量升级（重大）

- **动因**：审批卡要接官方 pending interaction，但 rc.2 把审批 waterfall 封在 host 内（`ctx.uiSession`/`dsh-client-ui-session` 未发布、`remote.$on('approval/request')` 的 remote-waterfall 转发未进 rc.2）。0.1.2 补齐这两点，故升级。
- **升级路径（registry 引用不破）**：dsh 单仓库 `release:pack` 打 241 tarball → 发布私服 localhost:4873（项目 `.npmrc` 把 `@deepseek-ai` 指私服，uplink 透传 npmmirror 取 rc.2/cordis 等）→ 187 个依赖 → `^0.1.2-alpha.1` → 重建 lockfile（3202 处 0.1.2）→ `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 全量补齐 0.1.2（**修 boot 失败根因**：dsh-attachment/brand 曾被 minimumReleaseAge 钉回 rc.2）。
- **三大 breaking 与修法**：
  1. **dsh-client-runtime 删除**（32 文件类型 import 迁移）：会话对象层→dsh-api-session-controller/client；store 类→dsh-client-store（根路径，无 /client）；SessionId→dsh-session/types；ClientContext→cordis `Context as ClientContext`；SettingsScope→dsh-client-ui-settings/client；Workspace*→dsh-api-workspace-controller/client；SessionRuntime→ISessions。0.1.2 适配：ctx.slots merge 需 +ui-renderer/client type import、useSessions 需 +ui-session/client、MarkdownText labels 必填、SessionSummary.pendingInteraction 移除（→ uiSession.pendingInteractions）、IWorkspaces.pickDirectory 移除（→ ctx.remote.directoryPicker.pick()）、settings.* 槽 owner 对齐官方（TS2717）。
  2. **dsh-host-apiproxy 删除**（desktop transport 重构）：apiProxy/AbstractApiClient/toFetchHandler/事件 schema 全没。desktop 从「自定义 IPC transport」换轨「官方 loopback webserver + loadURL(authenticatedUrl)」——webserver pin 127.0.0.1:0（ephemeral），renderer 直连 /api（launch token→cookie 鉴权），不再走 corumDesktop.unary/stream IPC relay。删 host/connection.ts、host/modules.ts、client/hmr.ts、ipc-bridge.ts、connection-controller.ts、electron-api-client.ts。
  3. **corum 自有 RPC 迁移**：corumDesktop.unary → `connection.rpc.call('/api','<ns>/<method>',{args})`（新共享包 @corum/corum-rpc-client 的 makeCorumRpcCall；agent-ui-dev/skill/team/pluginManager/sidebar/project 全迁）。**payload 必须 `{args:{...}}`**（gateway 硬契约）。
- **文件树重供**：corum.fs.list host 面随 connection.ts 删除 → 新建 desktop host `corum-fs.ts`（CorumFsService TypertRemoteService `@Remote('list')`，boot 注册根 ctx，gateway SRC 自动认领 /api/corumFs/list）；explorer 迁 connection.rpc + hostDescription→generation（0.1.2 ConnectionHostInfo 只有 home，无 cwd）。
- **审批通路打通（升级目的）**：① 0.1.2 registry `API_REMOTE_FORWARDED_EVENTS` 含 `{event:'approval/request',mode:'waterfall'}`；② ide/dev-agent patch 的 `ui-approval` **撤销禁用**——其 remote.$on('approval/request') answerer 把泳道审批 publish 进 ctx.uiSession.pendingInteractions（UI 层 conversation.composer 因 ui-conversation 禁用自然空转，无害）；③ conversation-ui 重接自研审批卡（读 pendingInteractions 渲染设计稿 N1EDZ 卡 + PendingApproval.answer 应答）。
- **组合一致性**：0.1.2 新增插件依赖 uiConversation/uiWorkspace 服务（kkc 禁用）会 pending 阻塞 web boot——ide patch 禁 ui-chat/ui-workflow-run/ui-deliverables/ui-goal/ui-trajectory/corum-directory-picker-surface（surface 缺 uiWorkspace；kkc 目录选择已改 directoryPicker Remote）。
- **重大踩坑（泳道列表渲染崩溃根因）**：0.1.2 的 `ctx.workspaces.list` 是 ClientWorkspaceModel **类实例**，其 `getSnapshot()` 内部 `this.refreshSnapshot()` 依赖实例 this——**作为裸引用传给 useSyncExternalStore 会丢 this** → `TypeError: Cannot read properties of undefined (refreshSnapshot)`，被槽错误边界吞掉 → 泳道列表整列不渲染（data-slot-error）。**修法**：inject 处把 getSnapshot/subscribe 绑定为箭头闭包再下发。其它 store（sessions.list/uiSession.pendingInteractions/connection.generation）的 getSnapshot 本就是箭头闭包（this 绑定），不受影响——本坑是 workspace-controller 独有的类实例方法形态。**教训**：0.1.2 起，把官方 store 的方法当裸引用传给 uSES 前，必须确认它是闭包还是类实例方法。
- **验证**：全量 typecheck 0 error（21 包）+ 全量 build 46 绿；实例起来了（leafs=5、插件全加载）；泳道列表恢复 + 选中联动对话区加载真实消息流（9 ai 卡片）；/api/corumAgent/listTaskAgents 直返 29 泳道（loopback transport 端到端）；文件树渲染 dsh 项目根（corumFs 通路）。
- **审批实证状态**：机制全就绪（ui-approval/ui-session 加载、answerer 注册、pendingInteractions 订阅正常、remote-waterfall 转发确认）。真实审批卡渲染需模型在沙箱拒绝后**主动**申请 escalation——当前模型出于安全判断不主动触发（合理），留待真实场景验证。
- **提交栈**：be3a2a02 基座 → 86de18f4 transport → 983042b2 client-runtime 迁移 → 86e71fc8 RPC 迁移 → 292fcbae session-ui 对齐 → af95c832 agent-dev → df7afc19 ide-project → 50b06cca 泳道列表 this 修复。

### 2026-08-29 · 会话区全面重设计 B 方案落地（官方数据流 + 自研渲染层）

- **背景决策**：评估「复用官方会话 UI vs 自研」后用户拍板 B 方案——复用官方数据流（session 事件 → ui-conversation 投影 → 槽渲染），渲染层全部换 corum 新设计。设计稿现有卡片效果差，全部重新设计（信息架构：一轮 = 过程瀑布 + 统一收尾，见 `DESIGN-conversation-information-architecture.md`；PLAN 见 `PLAN-conversation-ui-redesign.md`）。
- **fork 三包（官方数据流基座）**：全量拷贝官方源码 fork 进 workspace，让官方会话 UI 在 IDE 壳跑通泳道：
  - `@corum/corum-ui-conversation`（fork dsh-client-ui-conversation，65 文件）+ `@corum/corum-ui-chat`（fork dsh-client-ui-chat，85 文件）——官方数据流骨架 + 消息节点渲染层。提交 `754889a8`。
  - `@corum/corum-ui-approval`（fork dsh-client-ui-approval，8 文件）——审批 answerer + pendingInteractions 数据通路逐字节保留。提交 `b83eddba`。
  - fork 适配：inject 服务名解析（ui-chat→corum-ui-conversation 闭环）、dsh.client.external 显式声明（util 包 util-crypto/workspace-path/token-meter 无 dsh.client 改内联，修「missed the module table」）、inject 移除 uiWorkspace（kkc 禁官方 ui-workspace）+ ConversationRoot useWorkspaces 降级、kkc 壳 details 槽 S0 测试占位退役、组合禁官方三行 + insert fork 三行 + 自研 corum-ide-conversation-ui 退役（组合层不挂载）。
- **全局液态玻璃换肤**（提交 `e76f5a77`，14 张 module.css + corum-reskin.css）：对话区背景 transparent 透 ambient 光斑；composer 玻璃卡 glass-2 + 光边 + blur + r16 + 发送钮品牌实底；工具/命令/上下文/用量卡玻璃化；user 气泡品牌实底（brand-primary + on-brand + 右下小角）；正文裸流减框。实机确认透光斑 + 玻璃 composer + 减框。
- **全部卡片**：
  - **user 气泡**：品牌实底（MessageItem.module.css）。
  - **工具聚合卡**：官方 TurnProcess 已有聚合形态 + 玻璃化（glass-2 卡 r12，可展开）。
  - **审批卡**（提交 `e945bd80`）：ApprovalPanel 重构为 warn 描边玻璃卡 + 轮头（avatar+名+●等待审批）+ mono body + 拆分按钮「允许一次+▾浮层 menu」+ 拒绝（数据流 pending.answer 不变）。
  - **错误卡**（提交 `60e6c0c8`）：turn-error 裸行 → glass-1 + error 描边卡。
  - **Review 卡**（提交 `db9d4ec6`，**corum 特有，官方无**）：追踪会话文件写操作（edit/write/str_replace_editor）聚合 diff → 玻璃卡（折叠态「N 文件已更改 +N −M」+ 全部撤销/全部保留 + 展开每文件 diff）。review-changes（识别写工具+diff 聚合）/ review-source（per-session 数据源订阅 binding.eventSource + 确认水位 dismiss）/ review-revert（edit 精确反向/create 删除/write·insert 跳过）/ host corumFs/revertWrites RPC（read→唯一匹配 splice→write）。
  - **子Agent卡**（提交 `fc750f00`）：基于半成品数据流（contract/subagent.ts delegation→origin=subagent 子会话匹配 + conversation-nodes/subagent.ts 节点定义）完成渲染层——SubagentCard 玻璃卡（avatar bot + 任务描述 + run-chip Running/Done + prompt 摘要）+ 注册（renderer key=subagent-call + registerSubagentConversationNode）。降级版（卡片框架 + delegation 信息 + 运行态；精确 step 进度条后续接子会话事件窗）。
- **撤销根修复**（提交 `2b4f2797`）：「全部撤销」对泳道文件报 path escapes 两层根因——revertWrites 用 process.cwd() 作根改接 root 参数（泳道 cwd，apply.ts 从 sessions list byId[sid].cwd 传入）；macOS /tmp→/private/tmp symlink 误判逃逸改根与文件都 realpath 同基准。实测全部撤销 3 泳道文件成功 + 卡片 dismiss。
- **设计画稿**（Pencil，8 张定稿）：一轮瀑布(iV2D5)/审批卡(J1wTo3)/输入区(qVHA8)/子Agent卡(BetQ9)/Review卡(BUWxN)/错误卡(OcW3B)/统计弹层(kIlNH)/Convo Header(lMEUw)。
- **端到端验证**：泳道消息流 + user 品牌气泡 + 工具聚合卡（str_replace_editor create 展开）+ Review 卡（3 文件 +3 −0 展开列出每文件 diff + 全部撤销/保留交互）+ 统一收尾（用量行）+ 玻璃 composer + 减框裸流——实机截图 b-plan-final.png 确认全部落地。
- **下一步**：子Agent卡精确进度（接子会话事件窗算 step/进度条）；审批卡真实 escalation 触发验证（机制就绪）；弹层（统计/上下文用量/＋/权限/@Agent）按画稿接；`contract/subagent.ts`/`conversation-nodes/subagent.ts` 半成品数据流与 SubagentCard 的进度数据接通。

## 4. 风险 / 注意

- `doc/UXDesign/design.pen` 有无关改动，提交时继续排除，避免污染正式功能提交。
- 多 host 残留仍是红线：IDE 调试脚本落地前，重启仍按 `corum-cdp-verify` 技能清残留。
- LanePool 泳道占用投影仍是进程内存态；IDE 若要展示运行中状态，重启后需以事件日志/数据层为准重建。
- **HMR 槽位注册（2026-08-26 子 Agent 调查澄清）**：工作区规则「HMR 热交换不重挂槽位注册（ctx.slots.inject 是 fiber 级一次性副作用）」是**误诊**。真实机制——fiber 热交换（`packages/desktop/src/client/hmr.ts`，与官方 hmr 同算法）会**完整 teardown 旧 fiber 并重跑新 bundle 的 `apply()`**，槽位注册每次都重挂。真正需整页刷新的只有两类：① `RELOAD_VIA_PAGE` 集合（`corum-desktop` / `dsh-client-modules`，core provider 依赖级联不可靠，已正确分流）；② 根结构/壳层（AppFrame/GridView 等）旧 fiber **卸载不干净**导致新注册冲突（single 槽同 priority 撞车）。可优化点是「卸载彻底性 + 故障可观测性」（fiber 交换失败目前渲染端无感），而非补「重挂注册」机制；React 状态保留（Fast Refresh 式）是官方刻意取舍（lazy 纯注册模型），不宜攻关。改 inject 形状后建议仍重启验证（规避卸载不干净假象），但这不是架构限制。
