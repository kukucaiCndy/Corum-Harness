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

## 4. 风险 / 注意

- `doc/UXDesign/design.pen` 有无关改动，提交时继续排除，避免污染正式功能提交。
- 多 host 残留仍是红线：IDE 调试脚本落地前，重启仍按 `corum-cdp-verify` 技能清残留。
- LanePool 泳道占用投影仍是进程内存态；IDE 若要展示运行中状态，重启后需以事件日志/数据层为准重建。
- **HMR 槽位注册（2026-08-26 子 Agent 调查澄清）**：工作区规则「HMR 热交换不重挂槽位注册（ctx.slots.inject 是 fiber 级一次性副作用）」是**误诊**。真实机制——fiber 热交换（`packages/desktop/src/client/hmr.ts`，与官方 hmr 同算法）会**完整 teardown 旧 fiber 并重跑新 bundle 的 `apply()`**，槽位注册每次都重挂。真正需整页刷新的只有两类：① `RELOAD_VIA_PAGE` 集合（`corum-desktop` / `dsh-client-modules`，core provider 依赖级联不可靠，已正确分流）；② 根结构/壳层（AppFrame/GridView 等）旧 fiber **卸载不干净**导致新注册冲突（single 槽同 priority 撞车）。可优化点是「卸载彻底性 + 故障可观测性」（fiber 交换失败目前渲染端无感），而非补「重挂注册」机制；React 状态保留（Fast Refresh 式）是官方刻意取舍（lazy 纯注册模型），不宜攻关。改 inject 形状后建议仍重启验证（规避卸载不干净假象），但这不是架构限制。
