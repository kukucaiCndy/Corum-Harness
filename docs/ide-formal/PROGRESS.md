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

### 2026-08-30 · 会话区拖拽两回归修复（0.1.2 升级遗留）

- **用户报告两问题**：① 进入实际会话后拖会话区**无 ghost image**（拖拽体验不如升级前）；② 拖出窗口外期望单独脱出会话区，实际**全部组件脱出**（新窗口含导航/编辑/终端/资源管理器）。
- **问题 2 根因（先定位，是关键线索）**：0.1.2 transport 重构（`86de18f4`）把浮动窗加载从 `corumapp://app/index.html?floating=<key>` 换成 loopback HTTP——但**沿用了 `authenticatedUrl` 的 `?token` 参数**。官方 `authorizeIndex`（dsh-client-connection）的 token 交换应答 `303 location:'/'` **硬编码清掉整个 query**（不只 token——floating 参数随重定向丢失），浮动窗按主窗整壳挂载（含全部 5 个 grid leaf）。Electron `did-redirect-navigation` 诊断实证 `/?token=…&floating=corum.editor` → `303 → /`。
  - **修复（desktop ipc.ts）**：`loadURL` 前 `floatingUrl.searchParams.delete('token')`——主窗已完成 token→cookie 交换，session 共享的 `dsh-auth` cookie 仍有效；`GET /?floating=<key>`（无 token）命中 `isAuthenticated` 直返 index.html，无重定向、参数保留。**唯一不透 token 的带参直达**（带 token 且持 cookie 时官方也 303 清 query）。
- **问题 1 根因**：leaf 的 `will-change:transform` 独立合成层（`aff5ec6a` 引入防拖动带动相邻区域）在 0.1.2 会话区换肤引入 `backdrop-filter` 玻璃层（fork 三包 14 张 module.css）后，Chromium **整页 native ghost 快照不再显示**——该组合（合成层祖先 + backdrop-filter 后代）下整页快照失效。
  - **修复（ui-base GridView）**：`dragstart` 时给 leaf 加 `data-drag-source` 属性（CSS 把 `will-change` 降为 `auto`，leaf 回到整页合成层，整页 ghost 完整可见）；`dragend` 移除属性恢复独立合成层。仅拖拽期间生效，常态渲染隔离（防重绘联动）不受影响。
- **验证（CDP 实机三层）**：
  - dragstart 期间 `data-drag-source` 设置 + `will-change:auto`；dragend 恢复 `transform`。
  - 脱出 conversation → 浮动窗 URL 保留 `?floating=conversation`、`floatingRoot data-floating=conversation`、只挂 1 个槽（0 grid leaf）、主窗其余 4 区域正常渲染。
  - 关闭浮动窗 → conversation 回主窗原位（dock-back）；网格内 swap（convo ↔ explorer）正常；重置布局回基线。
  - 三包（ui-base / ide-ui / desktop）typecheck 全绿。
- **提交**：`913778f2`。

### 2026-08-30 · 会话区拖拽体验全面修复（ghost/脱出/让位/可选中）

> 大背景：0.1.2 升级后会话区拖拽体验全面回归（无 ghost / 全部件脱出 / 卡片不可选）。
> 本轮多轮迭代收敛，**关键认知都是实测实锤，非脑补**。最终态见各条。

- **拖拽 ghost（无浮层）最终方案**（`c22d2fd5` 回退最小形态 + `456690a5` 负 margin-top 移出视口）：
  - **根因**：leaf 的 `will-change:transform` 独立合成层 + 0.1.2 会话区换肤的 `backdrop-filter` 玻璃层组合下，Chromium「整页 native ghost 快照」行为分裂——空态拍出整页（带相邻区域）、非空态（消息流玻璃卡渲染后）放弃快照（无 ghost）。
  - **收敛的硬结论**：克隆 leaf 作显式 drag image 时，**不能加任何非平凡渲染样式**（transform/opacity/scrollTop/强制布局都会让含合成层+玻璃层的克隆快照拍空）。最终形态：克隆原样挂 body 末尾、负 `margin-top` 移出视口（纯布局位移不占屏幕像素、仍可被快照）、`setDragImage(clone, 鼠标在 leaf 内命中点)`。快照是克隆滚动容器 `scrollTop=0` 的顶部画面（**「稳定有 ghost」与「画面含 composer」二选一，保稳定**）。
- **拖出窗口外 = 全部件脱出**（`913778f2`）：见上一条（303 redirect 清 query，`delete('token')` 纯 cookie 直达）。
- **拖拽让位真正根因**（`8ba8ddf8`）：原生 HTML5 DnD 的 dragstart 由浏览器在「mousedown+移动」时向上找**最近的 draggable 祖先**（=整叶根）并在该祖先上派发——`onLeafDragStart` 的 `e.target` 是 **leaf 根本身**，不是 mousedown 命中的正文/按钮。用 `e.target.closest(CARD/INTERACTIVE)` 查卡片/交互**恒 null**（卡片是 leaf 后代非祖先），此前所有卡片/交互清单**形同虚设**（synthetic 测试错在把 target 设成命中元素骗过自己）。**修复：判定让位改用 mousedown 真实命中点元素**（`document.elementFromPoint(e.clientX, e.clientY)`，限定在 leaf 内）。
- **卡片容器清单**（`4bf2b072` + `730f79ab` + `d34e0dbe`）：CARD_SELECTOR（消息气泡/工具卡/审批卡/Review 卡/子 Agent 卡/**AI 消息体 qsr5ja_/_markdown_/_plain_/_plainRun_/_flowItem**/会话行/文件树行/项目行）+ INTERACTIVE_SELECTOR 补全（summary/label/audio/video/.monaco-editor/ARIA 交互角色/[data-interactive]）。**关键坑**：fork corum-ui-chat 的 AI 消息**不是 `_bubble/_card` 命名**，而是 `qsr5ja_/_markdown_/_plain_` 系——旧清单整条命中链无一命中，结论正文仍拖动（「秋日五绝结论可选中」根因）。CSS Modules 哈希前缀稳定（`_9Q52kG_sr`/`LRfKSG_bubble`/`qsr5ja_root`），用语义子串属性前缀选择器。
- **文本选不中的真正根因**（`c4606ff6`）：**Chromium 对 `draggable=true` 元素的默认行为——整棵子树 `user-select:none`**（实测：leaf draggable=true → 子树全 none；去掉 draggable 立即回 auto；遍历所有样式表查不到命中规则）。修复：`.leaf` 显式 `user-select:text` 覆盖默认 none——文本恢复可选中；卡片让位（preventDefault dragstart）保证「可选中 且 卡片不拖」并存。
- **会话区可拖策略收敛**：先做 `noDragSlots` 整叶禁拖（`43415326`）→「把手左右之外可拖」在 509 窄列无可拖区（widthHandle 是 absolute 相对 .root 的虚拟几何，509 列下两把手都在 leaf 外，`f8e9ea5e` 撤销几何判定）→ **恢复整叶可拖**（内容区留白拖起），卡片/输入框不可拖（CARD/INTERACTIVE 让位保住选中/点击）。
- **列宽把手（widthHandle）换品牌 token**（`f12c3b73`）：官方会话 UI 的列宽拖拽把手 `::after` 渐变从 `--dsw-alias-scrollbar-hover-l1`（滚动条灰）改 `--corum-glass-border-active`（品牌主色，深 #01CDFE / 浅 #5B21F5），与 GridView sash/dropHint/dockPreview 品牌色统一。

### 2026-08-30 · 空态大改版（设计稿 DjFev + 圆桌收敛 + 重设计）

> 本轮最大块。过程：设计稿 DjFev 落地 → 圆桌讨论收敛方向 → 应用级覆盖层做错（两空态叠加）→ **session 管理一个空态** → 圆桌四点定调 → 重设计（横排大按钮 + 最近合一列）。

- **空态落地（DjFev）**（`f58e1b3a`）：会话区空态（hero）从 fork 官方 HeroShell（品牌标语+工作区选择）改为「大 logo + 操作卡 + 最近工程提示」。EmptyStateHero（新组件）+ emptyActions（ConversationInjected，apply.ts 注入 RPC 通路）+ 侧栏模式共享源（corum-ui-base/sidebar-mode.ts，**关键坑：corum 包被各 bundle 各自内联 → 模块级状态互不通 → 挂 window.__corumSidebarMode 全局单例**）。
- **圆桌收敛：session 管理一个空态**（`fb2003e9`）：先做应用级 EmptyStatePage 覆盖层（盖 conversation+right-col 整片）与 hero 的 EmptyStateHero **两空态叠加**——用户纠偏「简单一点，session 管理一个空态即可」。撤销 AppFrame 覆盖层（删文件+回退），只保留会话区 hero 这一个空态。
- **空态四点定调 + 落地**：
  1. **侧栏不收起**、右侧完全展示空态（`184bc159` → `30c8eeef` → `91328fa0`）：右侧三区域（编辑器/资源管理器/终端）**默认隐藏**（不只空态，进入项目/会话也不显示），**只有点左上角快捷按钮才显示**（userShown state + detachedSlots 运行时隐藏不动树不持久化；onTogglePanels/onToggleTerminal 改 userShown 开关）。`0cb4658e` 修「全 detached 分支不占位」（nodeAllHidden/subtreeMinSize 只认 leaf.hidden 不认 detachedSlots → 改递归 allDetached + min 取 0），会话区铺满空缺；`91328fa0` 右侧全隐藏时侧栏固定 300（GridView 新增 lockedSlots prop 运行时锁定宽），会话区占满剩余（用户定调 A，不按 300:509 占比拉宽侧栏）。
  2. **空态 Agent 标题栏**（`56b73fb0` → `53431c30` → `4d31d630` → `31e76d24`）：空态隐藏标题**内容**（会话标题/状态胶囊/轨迹按钮——会话态信息），但**保留标题栏座位**（titlebarDrag 空白 drag 条方便拖窗口）；分隔线（seat border-bottom）**只在空态显示**（data-hero 属性，非空会话去掉）；`31e76d24` 裁 heroGlow（absolute 装饰光斑 449 高被算进 scrollHeight 撑出滚动条，composerHero overflow:hidden）+ emptyHero 收紧（gap/padding/bigLogo 缩小），空态元素全在视口内不滚动。
  3. **新建卡片对齐设计稿**（`f24ffeac`）：先在 Pencil UTLsE 定稿——加号 glyph 24→18（ic 36×36 内 icon 框 18，glyph 超出被放大偏移致不居中）、两卡统一高亮 `$glass-border-active` 描边（对等入口不分主次）；代码 Plus size 24→18、两卡统一高亮。最近任务去时间。
  4. **重设计**（`9b3dab14` + `82ff08b8` + `83172f6b`）：圆桌定调「更品牌保留大 logo + 大按钮横排 + 最近合一列」。Pencil DjFev 重排（卡片 layout 改 horizontal + tx 容器 + ic 44 + recents 合一列删 hint）。代码：**横排大按钮**（card 360×97、ic 44×44 r12 左 + tx 标题 20/600 + 副标题 15 右，替代竖排小卡）+ **最近合一列**（项目+任务混排按时间倒序前 6，icon+标题+kind+时间）。`82ff08b8` 图标换语义（项目 FolderGit2 / 任务 MessageSquarePlus，替代 + 号）；`83172f6b` 图标统一（两卡 brand 实底 + on-brand 白 icon 20）+ 最近行 **kind/time 固定列绝对对齐**（kind width:3em 右对齐、time width:5em 右对齐 tabular-nums，title flex:1 抢宽——不再随内容长度参差）。
- **空态视觉（当前态）**：大 logo（300×231）+ 两个横排大按钮（360×97，ic brand 实底 + FolderGit2/MessageSquarePlus + 标题+副标题）+ 最近合一列（icon brand + 标题 + kind 固定列 + 时间固定列，420 宽）。
- **提交栈**：`f58e1b3a`（落地）→ `fb2003e9`（收敛一个）→ `282e3c98`/`184bc159`/`30c8eeef`/`0cb4658e`/`91328fa0`（右侧隐藏+铺满+锁 300）→ `56b73fb0`/`53431c30`/`31e76d24`/`4d31d630`（标题栏+分隔线+不滚动）→ `4d7b4696`/`f24ffeac`/`9b3dab14`/`82ff08b8`/`83172f6b`（卡片+重设计+图标+对齐）。

### 2026-08-30 · 杂项修复

- **侧栏会话行溢出**（`64f08bc5`）：`.sr` `width:100%` 缺 `box-sizing`——padding（嵌套行 paddingLeft:32+paddingRight:10）加在 width 之外，行实际宽 = 容器 270+42=312，行右缘 330 溢出 list 容器（270）/侧栏（300）被裁。加 `box-sizing:border-box`（行宽=容器宽，时间「15 小时/1 天」完整显示）。
- **Agent 标题栏状态胶囊截断**（`a8051280`）：flex 收缩优先级反了——标题 flex:none 不缩、状态胶囊 flex:0 1 auto 允许收缩 → 509 窄列下标题占满后 stats 被压到 ellipsis（命中 61%→命中…）。对齐设计稿 b4p03B（stats 核心信息不可截断、标题可跑马灯）：agentTitle flex:0 1 auto（可压缩跑马灯）/agentStatusPill flex:none（不收缩）/agentStats overflow:visible（完整显示）。

### 2026-08-30 · 新建任务流程设计稿（含访问权限三档，待用户确认后开发）

> 用户选 §七.1「新建任务流程」，按约定**设计稿先做**。产出 frame `btAJh`
> （`L1 空态 · 新建任务表单 · 深色`，1428×974 实机尺寸）。**尚未写任何代码**。

- **版式**：沿用 `o4fBad`（项目创建向导）的 dialog 范式——`glass-1` + r20 +
  外阴影（0/10/32 #00000040）+ padding 18 + gap 12；结构 = header（标题+关闭）→
  分隔线 → body（字段组）→ footer（取消 / 开始 brand-primary）。**空态内嵌表单
  不跳页**（§七.1 定调）：大 logo 保留（300×231 实测），表单取代两按钮卡位置。
- **字段三件套**（顺序：Agent → 工作目录 → 访问权限）：
  1. **Agent 下拉**（`select-field` 范式 Bf3cS：`glass-2` + r10 + `glass-border`
     + padding 8/12 + chevron-down 18）。值取**真实 profile**：`task`(Task 助理) /
     `dev`(研发) / `pm`(PM 助理) / `qa`(测试)——读 `packages/desktop/.corum-dev-home/
     .agent-presets/*/agent.json` 实锤，非脑补。
  2. **工作目录**（folder 图标 + mono 路径 + 行内「选择」按钮）：复用 apply.ts
     已有的 `ctx.remote.directoryPicker.pick()`（`newProject` 同款）。
  3. **访问权限三档**（本轮新增，用户点名要）——**不是自创概念，官方领域模型
     逐字对齐**：

     | 档位 | sandbox | approval | 图标 |
     |---|---|---|---|
     | 只读 | `read-only` | `ask` | lock |
     | 工作区读写 | `workspace-write` | `ask` | folder |
     | 完全访问 | `danger-full-access` | `never` | shield-off |

     - **事实来源**：`SandboxMode = 'read-only' | 'workspace-write' |
       'danger-full-access'`（`@deepseek-ai/dsh-sandbox/lib/types/index.d.ts:19`）；
       `ApprovalPolicy = 'ask' | 'never'`（`dsh-user-approval/lib/types/index.d.ts:46`）。
     - **捆绑机制**：`@deepseek-ai/dsh-permission-presets` 把两个旋钮（沙箱模式 +
       审批策略）捆绑为具名预设，经 `permission/preset` 事件 + `dsh-sandbox-policy`
       的 `setSandboxMode` + `dsh-user-approval` 的 `setApprovalPolicy` 写入；
       `permissions` 会话投影向客户端暴露 `PermissionSelect{options,currentValue}`。
       官方默认表只有 `workspace-write`(workspace-write+ask) 与
       `danger-full-access`(danger-full-access+never)——**三档需在 corum 侧扩
       `presets` 配置加 `read-only`(read-only+ask)**。
     - **默认档位 = 工作区读写**（安全 + 可写，对齐官方 `defaultPreset`）：
       选中态沿用品牌描边（`glass-border-active` 边框 + `brand-primary` 实心
       radio 6px + 标题 `brand-text`）。
- **尺寸校验**：form 420×474（垂直布局自动增高，三档各 52 高）；hero 内
  logo bottom 323.5 → form 367.5–841.5，底部留 92.5，**无溢出无塌陷**
  （`Get(visit)` 全帧 `c.problems` 除 ambient 光斑（设计有意为之）外全空）。
- **设计稿已去 placeholder**，用户可在 Pencil 直接走查。
- **待确认后开发**：表单 UI + Agent/权限传参（`createTaskAgent(cwd, profileId?)`
  已支持 profileId，权限需新增参数走 `permissionPresets` 或 `sandbox/mode` 事件）。

### 2026-08-30 · 第十轮开工准备（交接核验 + 新建任务流程设计稿）

- **交接核验（§九 清单逐项过）**：分支 `feat/ide-s4-restore` 栈顶 `3c92ee7c`
  （文档记录 `83172f6b` 之后多一个文档提交）；工作区只剩排除项；实例存活（Electron
  PID 83265，CDP :9222 页面 `http://127.0.0.1:64477/`）；空态 EmptyStateHero 在位
  （大 logo 300×231 + 两卡 360×97 + 最近列 420）；右侧三区域默认隐藏、会话区 1428
  铺满、侧栏锁 300；玻璃 token 全注入；console 无 error；**11 个包 lib 均新于 src**。
- **踩坑（构建新鲜度误判）**：用 `find src -newer <lib 目录>` 判断 stale 会误报——
  目录 mtime 是「目录项最后变更时间」，不等于内部文件的新旧。正确做法：比对
  `lib` 内**文件**的最大 mtime 与 `src` 内文件的最大 mtime。据此排除
  corum-ide-project-ui / corum-agent-dev 的假 stale（两者 lib 内的 client.js、
  index.js 均新于全部 src）。
- **设计稿 `btAJh` 产出过程**（新建任务表单，含访问权限三档）：见下条。

### 2026-08-30 · 新建任务流程落地（Agent + 工作目录 + 访问权限三档）

> 设计稿 btAJh 用户确认后开发。**权限三档走官方领域模型，不是自创**。

- **关键发现（推翻上一轮的「未挂载」风险）**：base bundle 的 `cordis.patch.yml`
  **已挂 `dsh-permission-presets` 且三档配齐**（`read-only`+ask /
  `workspace-write`+ask / `danger-full-access`+never），只是**没配客户端呈现字段**
  （`name`/`description`）——所以 UI 直读会露出 preset key。实测三档事件
  （`permission/preset` + `sandbox/mode` + `approval/policy`）在真实会话持久化里
  全都在（zstd 解压 `session.jsonl.zstd` 可查）。教训：**判断服务是否可用别只看
  页面有没有对应 UI 控件**，去 bundle 的 cordis.yml + 持久化数据层查。
- **呈现层补中文**（`packages/desktop/cordis.ide.patch.yml`）：按行覆盖 `permission`
  行的 `presets`，加 `name`（只读/工作区读写/完全访问）+ `description`，**不动
  sandbox/approval 捆绑语义**，也不动 defaultPreset（沿用官方推断 = workspace-write）。
- **host（`corum-agent-dev`）**：
  - `createTaskAgentRemote(cwd, profileId?, permission?)` + `createAgentForTask`
    新增 permission 参数；新增 `listPermissionPresets` Remote（表单档位数据源，
    返回官方 preset 表的 name/description + defaultPreset）。
  - `applyTaskPermission()`：`agents.create` **之后**调 `permissionPresets.set()`。
    **时机是关键**——官方在 `session/created` 里已给会话钉了全局默认三件套，
    必须在 create 后用 set 覆盖（set 的 apply 只在档位变化时追加事件，后写的
    旋钮覆盖先写的）。服务未挂载 / 档位名不在表里时**静默沿用默认**，不阻断创建。
  - 加依赖 `@deepseek-ai/dsh-permission-presets`（含 `import type {}` 模块增强，
    同文件既有惯例）。
- **client（`corum-ui-conversation`）**：
  - 契约新增 `NewTaskOptions` / `AgentOption` / `PermissionOption`；`emptyActions`
    新增 `listAgents` / `listPermissions` / `pickDirectory`，`newTask(options?)` 可选
    传参（不传走旧的「当前工作区或选目录」路径，向后兼容）。
  - `NewTaskForm` 组件 + 表单 CSS（沿用 o4fBad 向导 dialog 范式）。空态点「新建
    任务」→ **两卡原位展开表单**（不跳页）。
  - **受控输入坑（PROGRESS §4 同类）**：选项列表异步到达，**缺省值在列表到达的
    边沿**用 `setX(cur => cur === '' ? first : cur)` 初始化一次——若 effect 依赖
    列表引用，store 更新换引用会在用户选择中途重置选择。
- **实机验证（CDP）**：
  - 表单渲染：Agent 下拉 4 项（研发/PM 助理/测试/Task 助理，读真实 profile）+ 权限
    三档中文名+说明 + 目录未选时「开始」禁用。
  - **RPC 直连（本次新探通的调用方式）**：`POST /api/<ns>/<method>` + body
    `{type:'client-request', rpcId, method:'<ns>/<method>', payload:{args}}`——
    **method 字段必须同时出现在 URL 和 body 里**（只写 body 走 /api 会 404），
    此前两版探错都是漏了它。
  - `listPermissionPresets` → 三档中文 + `defaultPreset: workspace-write` ✅
  - **权限落库逐档实锤**（解 zstd 读会话事件）：
    - `read-only` → seq3-4 追加 `permission/preset:read-only` + `sandbox/mode:read-only`（approval 仍是 ask，与默认相同故不重写，符合官方「只写变化的旋钮」）✅
    - `workspace-write` → 与默认一致，**不追加任何事件**（净变化为零）✅
    - `danger-full-access` → seq3-5 追加 preset + `sandbox/mode:danger-full-access` + `approval/policy:never` ✅
    - 未知档位 / 不传档位 → 静默落默认 `workspace-write`，创建不失败 ✅
  - console 无 error；两包 typecheck + build 全绿。测试泳道已清理（删会话目录 + 重启）。
- **未做**：目录选择器是 native macOS 对话框，CDP 内不可点——**「选择」按钮的
  真实点击链路未走通**（功能与侧栏「添加工作区」同源 `ctx.remote.directoryPicker
  .pick()`，代码路径一致），需用户手动过一遍。

### 2026-08-30 · 新建任务流程三处走查修复（用户实测反馈）

- **① 点「选择」目录无效（真 bug，已修）**：
  - **根因**：`ctx.remote.directoryPicker` 在**会话区插件的 fiber 里取不到**。
    dsh 的 Context 代理 getter 对未装配的命名空间**抛错**而非返回 undefined，
    于是点按钮静默无反应，只在 console 留一条 `Uncaught (in promise)
    at get (…) → apply.ts`。
  - **为什么侧栏同样的代码能用**：`corum-ide-sidebar-ui` 的 inject 声明了
    `connection`（`ctx.remote` 随 connection 服务装配到 fiber）；会话区插件的
    inject 没有 connection（按官方形状保留别的服务名），故 `ctx.remote` 不存在。
    **同一行代码在不同 fiber 可用性不同——取决于 inject**。
  - **修法**：不碰 `ctx.remote`，直接用官方 `connection.rpc.call('/api',
    'directoryPicker/pick', { args: {} })` 打同一个 Remote 端点——与
    `makeCorumRpcCall` 同通道同 `{args}` 契约，且不依赖 fiber 命名空间。
    实测弹窗正常（`osascript choose folder` 进程可见）。
  - **顺带补齐失败呈现**（PROGRESS §4「RPC 失败绝不静默吞」）：pick 失败在表单
    内显示红色原因，不再只留一条 unhandled rejection。
- **② 默认权限档位落在「工作区读写」**：原实现取 `list[0]`（官方 preset 表按
  **声明序**返回，首项恰是最严的 `read-only`）。改为取官方 `defaultPreset`
  （组合默认 = `workspace-write`）——`listPermissions` 的返回值从数组改为
  `PermissionSelect{presets, defaultPreset}` 以透出该字段。
- **③ 完全访问图标换 `ShieldAlert`**（盾牌内叹号，用户走查选）：比 `ShieldOff`
  更贴合「不受限制」而非「无保护」；与项目内既有用法（ConversationArea 授权
  按钮）一致。设计稿 btAJh 同步改。
- **验证（实机）**：默认档位 pressed=工作区读写 ✅；完全访问 svg class
  `lucide-shield-alert`（含盾+竖线+点三条路径）✅；点「选择」弹窗 ✅（osascript
  进程可见）；取消后表单内显示红色失败原因、无 unhandled rejection ✅。

### 2026-08-30 · 新建任务流程按用户实测语义重构（三问题一次收敛）

> 用户实测反馈：① 点确定后**定格在「创建中」**；② 会话落**未分组**（期望像
> kkc-desktop 一样归到工作区父节点下）；③ 期望**未发消息不保存会话**，且
> **工作区应从已有列表里选**（列表下方给「选择新目录」入口）。三点是同一个
> 交互语义的重构，不是三个独立 bug。

- **① 定格在「创建中」根因**：官方 hero 条件 = `sessionId === undefined ||
  (shellPhase === 'blank' && (openState === 'open' || summaryBlank))`（fork
  `ConversationRoot.tsx:299`）。泳道建好并 `sessions.open` 后仍是 **blank**，
  空态（含本表单）**继续挂载** → 表单不消失、停在「创建中…」。
  修：`newTask` resolve 后**主动 `onClose()`**（此时任务已就绪：侧栏有父节点
  + 新会话，用户发第一条消息才留存）。
- **② 落「未分组」根因**：侧栏分组按 `WorkspaceView.sessionIds`
  （`SessionsPane.tsx:194` 遍历 `ws.sessionIds`），**不是 cwd 匹配**。泳道是自己
  起的 `ctx.agents.create`，**绕过了官方 `session.create` 里的
  `workspace.attachSession()`**（`dsh-api-session-controller/lib/index.js:590`），
  所以永远不进任何 workspace 的 sessionIds。attatch 硬要求
  `realpath(session.cwd) === workspace.path`（`dsh-workspace/lib/index.js:87`）。
  修（host `createAgentForTask`）：
  - 入参 cwd 先 `realpathSync` 归一（macOS /tmp→/private/tmp 会直接拒接）；
  - 新建后 `workspaceRegistry.create(cwd)`（**幂等**：已注册返回既有实体，
    未注册则新建并 prepend 到侧栏列表 = 用户要的「目录父节点出现」）
    + `attachSession(sessionId)`；
  - 失败**不阻断**（会话可用，只归未分组）但打日志——静默失败会让问题无法定位。
- **③ blank 会话语义（官方查证，子 Agent 调查结论）**：
  - 官方判定：`blank = state.blank && event.type !== 'turn/start'`
    （`dsh-api-session-controller/lib/types/list.js:84`）——**第一条 turn/start
    翻转为非 blank**。`session/end-seed` 与 blank **无关**（是 replay/fork 种子
    边界，此前认知有误）。
  - **官方没有 blank 会话的 GC/prune**：不存在自动回收 API。所谓「不保存」是
    **渲染层过滤**——侧栏 `sessionVisible()` = `!session.blank || session.id ===
    current`（`dsh-client-ui-workspace/lib/client.js:315`）：blank 会话只有当前
    选中时可见，重启/切走后就从列表消失。日志仍在磁盘（可冷恢复），但用户
    感知上就是「没保存」。本项目侧栏已实现同款过滤（`SessionsPane.tsx:171`）。
  - 修（host）：**复用目标工作区里已有的 blank 泳道**（官方 `connectWorkspace`
    同款语义）——`findBlankTaskLane()` 按官方同源规则判定（cwd 相同 + 事件流
    无 `turn/start`；host 的 `sessions.list()` 返回 `Session` **没有 blank 字段**，
    blank 在客户端摘要层）。连点「新建任务」不再堆一串空会话。
- **表单重构（client）**：工作区字段 = **已有列表里选**（`listWorkspaces` 走官方
  `ctx.workspaces.list` 快照，与侧栏分组同源）+ 列表下方「选择新目录…」入口
  （走 `directoryPicker`，选完由 host 注册为新工作区）。字段顺序改
  **工作区 → Agent → 访问权限**（先定现场再定 Agent，符合用户描述的心智）。
  设计稿 btAJh 同步重排。
- **实机验证**：
  - 提交后侧栏 **kkc-desktop 组下**出现新会话（`storages/workspace.json` 的
    `sessionIds` 实锤含 `corum-task-e29c4e77`），**不在未分组** ✅
  - 新泳道事件流只有 `session`/`permission/preset`/`sandbox/mode`/
    `approval/policy`，**无 turn/start = blank** ✅
  - 连点两次「新建任务」→ 仍只有 **1 条** lane（复用生效）✅
  - 重启后侧栏 kkc-desktop 显示「（无会话）」= 未发消息的会话不留存 ✅
  - console 无 error；host + client typecheck/build 全绿。测试泳道已清理。

### 2026-08-30 · 已选中会话（含 blank）必须渲染输入框

- **现象**：新建任务后仍在空页（大 logo + 新建卡），**没有输入框**，无法向 AI 发指令。
- **根因**：官方 hero 条件 `sessionId === undefined || (blank 且已 open)` 把
  **blank 会话也算 hero**——因为 blank 没有历史可渲染，官方此时渲染的是
  HeroShell（工作区 chip + **composer 输入框**）。corus 空态 `EmptyStateHero`
  只有「大 logo + 新建卡」，**没有输入框**，沿用 hero 就把用户卡在空页。
  （这与上一轮「定格在创建中」是同一个条件的两个后果：表单不消失 + 无输入框。）
- **修法**：新增 `hasSession = sessionId !== undefined`，按「有没有选中会话」分流：
  - 没选中会话 → 空态页（无输入框）；
  - 已选中（含刚建好还没发消息的 blank 泳道）→ composer 输入框 + 工作区/Agent chip。
  - `inert` 去掉 `(hero && chipTitle === undefined)`：否则工作区列表未加载完时会把
    已选中会话的输入框禁用（又一个「刚建完就被卡住」的路径）。
  - `variant`/`placeholder`/`footer`/`phase`/`composerHero` 统一按 `hasSession` 判定。
- **状态**：代码已提交（`0f2e7e83`），typecheck + build 通过，**但未能实机验证**——
  环境故障（见下）。待环境恢复后验证：新建任务 → 输入框可聚焦 → 发消息 →
  会话从 blank 翻转并留存。

### 2026-08-30 · 环境故障：/plugins bundle 加载失败（已解决：HttpOnly cookie 撑爆请求头 → 431）

- **症状**：启动后页面报 `Failed to load plugins` /
  `failed to import loader entry … (@deepseek-ai/dsh-typert-registry): client-modules:
  bundle script /plugins/??…&rev=<hash> failed to load`。
- **真实状态码是 431 不是 404**：CDP 网络面板抓到 `/plugins/??…(40 插件)…&rev=…`
  返回 **431 Request Header Fields Too Large**，响应头仅 `connection: close`、body 空。
  此前误判为 404，是没抓到真实状态码——431 在 **header 解析阶段**就被 Node 拒掉，
  根本到不了路由层，所以「`/` 401、`/plugins` 取不到」的表象与 404 一致。
- **根因（铁证）**：`dsh-client-connection/src/browser-auth.ts` 的
  `cookieName(authority) = 'dsh-auth-' + sha256(host:port)`（:106），**每个端口一个
  cookie 名**。Electron 单 user-data-dir 复用同一 cookie 库，而 ephemeral port 每次
  重启都变 → `127.0.0.1` origin 上累积 **66 个 HttpOnly `dsh-auth-*` cookie**，
  仅 name+value 就 **14850 字节**（cookie 头 ~15KB）。加载 1811 字节的 combo URL 时，
  `请求行(1811) + cookie(15KB) + 浏览器默认头` 超过 Node `http` 的
  `maxHeaderSize`（8KB/16KB）→ **431**。
  - cookie 是 **HttpOnly**，`document.cookie` 读不到（所以 JS 探针显示 0），但浏览器
    每次请求自动带上——这解释了为何 JS 看不到、网络面板却有一大串。
  - **单资源小 URL**（bootstrap `dsh-client-modules/client.js`，几十字节）能 200，
    因为 `请求行` 小、总量未超限；只有 40 插件的**长 combo URL** 把请求行顶到阈值上。
- **验证**：停应用 → 清空 cookie 库（`…/T/corum-desktop-ud-*/Cookies` SQLite，
  `DELETE FROM cookies WHERE name LIKE 'dsh-auth-%'`）→ 重启 → **同一 1811 字节 URL
  从 431 变 200**，40 插件全部加载，UI 完整渲染，console 零错误。
- **与代码改动无关**的结论仍成立（这解释了 `git stash` 后仍失败、磁盘 `lib/client.js`
  齐全、`rev` hash 不变——因为根本没到读文件那步）。
- **恢复方法**（任选一）：
  1. 停应用后删 cookie 库 `…/corum-desktop-ud-*/Cookies*`（或按上 SQL 只删 `dsh-auth-`）；
  2. 注意：**应用运行中改 SQLite 不生效**——Chromium 把 cookie 缓在内存，须重启。
- **根治（已落地）**：`packages/desktop/src/electron/main.ts` 在 `app.whenReady()` 后、
  加载任何 URL 前，用 `session.defaultSession.cookies` 清掉 loopback 域
  （`127.0.0.1`/`localhost`）全部 `dsh-auth-*` cookie——当前实例的会在 `loadURL`
  认证时重新种，故只清旧的、不误伤。注意走 **cookies 内存 API**（Chromium 把 cookie
  缓在内存，SQLite 是异步落盘，运行中改库无效）。
  - **构建坑**：main 进程实际跑的是 `lib/main.js`（**tsdown bundle 产物**，把
    `lib/types/electron/*` 全内联）。改 `src/electron/main.ts` 后仅 `tsc -b
    tsconfig.host.json`（只更新 `lib/types/`）**不够**，必须再跑 `tsdown --config
    tsdown.config.ts` 重新打包，否则运行时还是旧逻辑。
  - **实机验证**：重启前库里有 1 个旧端口 cookie → 重启日志
    `[corum-desktop] purged 1 stale dsh-auth-* cookie(s)` → 库里清 0 → 新会话认证后
    combo 200、UI 完整、console 零错误。
  - **可选加固（未做）**：给 corum desktop 配固定调试端口（authority 稳定 → cookie 名
    稳定 → 不累积）；上游 DSH mint 新 cookie 时顺带 `Max-Age=0` 清同 host 其它端口的
    `dsh-auth-*`。当前启动清理已足够，累积问题不会复现。

### 2026-08-30 · 新会话「未发消息不落盘」+ 标题统一叫「新会话」

- **① 未发第一条消息不落盘**（用户要求）：
  - **官方机制**（查证）：`SessionPersistence.create(meta)` 只登记元数据
    （`materialized: false`），**首次 `append` 才真落盘**——契约原文「A backend
    MAY defer the physical write until the first append (lazy materialization)
    … abandoned sessions leave nothing behind」
    （`dsh-session-persistence/lib/types/index.d.ts:109-114`；实现见同包
    `lib/index.js:872` createCore / `:905` appendCore）。
  - **根因**：上一轮写的 `applyTaskPermission()` 在 `agents.create` **之后立刻**
    调 `permissionPresets.set()` → append `permission/preset` + `sandbox/mode` +
    `approval/policy` 三条事件 → **当场落盘**，于是从未对话的会话也在磁盘留下
    `session.jsonl.zstd`（此前实测那 4 条 seed 就是这么来的）。
  - **修法**：权限档位改为**待定（只存内存）**，等用户真的发消息时才写：
    - `rememberPendingPermission()` 建会话时只记 `pendingPermissions` Map；
    - 监听官方 `session/event`，命中 `user/message` 时 `flushPendingPermission()`
      兑现（判定条件与官方 `api-session/activity` 同源——
      `dsh-api-session-controller/lib/index.js:2692-2694`）。
    - **为什么用 session/event 而不是自家 RPC**：UI 走官方客户端
      `session.prompt()` → host session-controller 的 prompt，**不经过**本服务
      `runPromptForTask` RPC，挂自家 RPC 不会触发。
  - **侧栏仍能显示未落盘会话**（关键点）：`session/created` 由 **live session**
    的 `announce()` 广播（`dsh-session/lib/index.js:1800-1809`），与持久化无关；
    官方 `session/created` → `api-session/added` 同样不看磁盘。所以「内存里有、
    磁盘上没有」的会话侧栏照常可见。
- **② 新会话统一叫「新会话」，不叫工作区目录名**（用户要求）：
  - **根因**：官方 `displayTitleOf(title, cwd, id)` 在会话无持久标题时**回落到
    目录名** `workspaceTitleOf(cwd)`（路径末段）
    ——`dsh-api-session-controller/lib/client.js:2217-2224`。所以 blank 会话的
    `displayTitle` **不是空串、是「kkc-desktop」**，此前写的
    `displayTitle || (blank ? '新会话' : …)` 永远走不到「新会话」。
  - **修法**（三处，都改成**先判 blank**）：侧栏 `SessionsPane.rowTitle`、
    空态最近列表 `ConversationRoot.recentTasks`、标题栏
    `AppFrame.currentSessionTitle`。

### 2026-08-31 · 空态创建新任务全流程（设计稿落地：工作区下拉/模型联动/新会话界面/Agent 锁定）

- **设计稿**：`doc/UXDesign/design.pen` 的 `空态→新会话 流程 区域`（RLxQb）。五步流转：
  空态 → 新建任务表单（工作区下拉/Agent/模型联动/权限）→ 开始 → 工作区下建会话 →
  居中输入框新会话界面（标语 + 快捷指令卡 + Agent 锁定）。
- **host（corum-agent-dev）**：
  - `createTaskAgent` / `createAgentForTask` 新增第 4 参 `model?: ProfileModel`，
    覆盖 `profile.model`（默认仍用 Agent 默认模型）。`selection.current` 与
    `agentOptions` 改用 `effectiveModel`。已有 `@Remote('listModels')` 直接复用
    作模型目录数据源（provider→models）。
  - `@Remote('listProfiles')` 本就返回完整 `model`，UI 取各 Agent 默认模型。
- **UI 契约（corum-ui-conversation）**：
  - `slots.ts`：`AgentOption.defaultModel`、新增 `ModelProviderOption` +
    `emptyActions.listModels()`、`NewTaskOptions.model`。
  - `apply.ts`：`listAgents` 映射 defaultModel、新增 `listModels`、
    `startTaskLane`/`newTask` 透传 model 给 `createTaskAgent`。
- **新建任务表单（EmptyStateHero.NewTaskForm）**：
  - 工作区：平铺列表 → **`<select>` 下拉**（`__pick__` 置顶=选择新目录触发
    pickDirectory，下方已有工作区；选了列表外目录时追加一项保证可见）。
  - 模型：新增下拉（provider `optgroup` 分组）；`modelTouched` ref 控制——
    未手改时跟随 `agentDefault`（切 Agent 联动），手改后保持用户选择。
    Agent 默认不在目录时补 option。
- **新会话界面（ConversationRoot.NewSessionHero）**：`hasSession && summaryBlank`
  时在 composer 上方渲染标语「输入指令，开始新的任务」+ 三张快捷指令卡
  （继续未完成的任务/整理代码/帮我探索项目）。**点卡用 `inputActions.setDraft`
  填入 composer 待发送**（不直接发）——`ConversationRoot` 解构补 `inputActions`
  （session-maybe scope，`InputActions | undefined`）。
- **Agent 锁定（ConversationRoot）**：`isTaskLane = sessionId.startsWith('corum-task-')`
  时，heroWorkspaceRow 里**不渲染官方可选 `conversation.hero.agentPreset` slot**，
  改渲染只读 chip「🔒 Agent 已锁定」。官方 agent-preset 包只注册
  `conversation.hero.agentPreset` 一个 slot（lib/client.js 实证）。
- **样式**：全部走 `--dsw-alias-*`/`--corum-*` 变量，dark/light 自适应
  （ConversationRoot.module.css 末尾 NewSessionHero + agentLockChip）。
- **实机验证（CDP）全过**：表单四字段（工作区下拉置顶新目录/Agent/模型联动提示
  「已按 Agent 默认模型自动选择」/权限）→ 开始 → dsh_test 下建 blank 会话 →
  新会话界面（标语+快捷指令+Agent 已锁定）→ 点「帮我探索项目」填入 composer →
  发送 → blank 翻转、界面消失、进正式会话（Agent 真实跑探索）、标题落盘。
  console 零错误；浅/深主题均正常。
- **遗留/注意**：
  - 切 Agent 会重置 `modelTouched`（模型回到新 Agent 默认）——若希望「手改模型后
    切 Agent 保持所选」，把 Agent onChange 里的 `modelTouched.current = false` 去掉。
  - 设计稿组件化的 `Chat Input`（design.pen `ei62g`）是**设计层**抽象；代码层
    composer 仍走官方 `conversation.composer.bar` slot，二者不强求一致。
  - task 泳道锁定是**纯 UI**：绕过 UI 直接调 host RPC 仍可改模型（session 内模型
    选择本就该允许改；锁的只是 Agent profile）。

### 2026-08-31 · 构建红线：corum fork 样式必须 inline-css，只跑 tsdown = 界面没样式

- **症状**：新会话界面/新建任务表单的 JS 逻辑都渲染了，但**裸奔无样式**——大标题
  变成顶部一小行黑字、快捷指令卡缩成无样式胶囊、composer 贴顶不居中。
- **根因**：`corum-ui-conversation`（及所有 corum fork）的构建是**两步**：
  `tsdown`（产出 JS + 独立 `lib/style.css`）**+ `node scripts/inline-css.mjs`**
  （把 style.css 折进 `client.js` 并删除独立文件）。client bundle 是 CJS、经
  `window.__ModuleLoader__.load` 分发，**无法 import css 文件**，所以样式只能靠
  inline-css 注入成 `<style data-plugin="<id>">`。
  - 之前只跑了 `tsdown` → `client.js` 无 CSS 文本 → combo bundle 无本插件样式 →
    页面里 `style[data-plugin='@corum/corum-ui-conversation']` 标签根本不存在。
  - 排障路径（供复用）：`getComputedStyle` 全默认值 → 查 `document.styleSheets` 无
    规则 → 查 `style[data-plugin]` 列表无本插件 → 定位到 inline-css 漏跑。
- **修法 / 脚本加固**（`corum-ui-conversation/scripts/inline-css.mjs`）：
  1. **幂等判定改本插件专属标记** `s.setAttribute('data-plugin','<id>')`——原
     `client.includes('data-plugin')` 会被业务源码里的 `data-plugin` 字符串误判
     「已注入」而跳过（所有 fork 的同款脚本都有此隐患，本次只改了 conversation）。
  2. **新增 `--check` 模式**：只校验不写入，client.js 缺样式时非零退出
     （`node scripts/inline-css.mjs --check`）——可挂 CI/门禁，拦「只跑 tsdown」。
  3. 已验证：注入 → 幂等（重复跑不重复加）→ `--check` OK/FAIL 两态正确 →
     完整 `tsc + tsdown + inline-css` 链路通畅。
- **红线（务必遵守）**：改 corum fork 的样式/代码后**必须跑完整 `pnpm build`**
  （= `tsc -b && tsdown && node scripts/inline-css.mjs`），**不能只跑 `tsdown`**。
  **验证务必 `take_screenshot` 视觉确认**——DOM 结构对≠样式对（这次 DOM/a11y 全对、
  视觉全错）。
- **可选加固（未做）**：把 `node scripts/inline-css.mjs --check` 挂进仓库门禁/
  `cdp.sh restart`，或给全部 20 个 fork 的 inline-css 同步修幂等判定。

### 2026-08-31 · 新会话界面走查修正：移除多余工作区 chip + Agent 锁定挪进 composer

- **① task 泳道不渲染「选择工作区」**：`heroWorkspaceRow` 在 `isTaskLane` 时整体
  返回 `null`——工作区在建会话时已绑定，顶部不再出现「选择工作区」chip +
  workspace picker + 官方 agentPreset 选择器。普通官方会话（非 corum-task-*）
  不受影响，仍显示工作区 chip + agentPreset。
- **② Agent 锁定挪进 composer 工具栏**：锁定 chip 从 heroWorkspaceRow 移到
  `inputBar` 的 `leftItems` 最前（在官方 `conversation.input.left` slot 之前）——
  现在显示在输入框**内部工具栏**（🛡 权限盾旁），而非浮在输入框上方。
- **实机验证（截图确认）**：新会话界面顶部无工作区 chip；「Agent 已锁定」在
  composer 工具栏内（+ / 🛡 / Agent 已锁定 / 访问模式 / 模型 / 🎤 / 发送 一排）。

### 2026-08-31 · 访问模式可更改：修复 accessSelect 定义了却从未挂载的 fork 遗漏

- **症状**：会话内点「访问模式」无任何反应，**无法切换档位**。
- **根因**：`InputBar.tsx` 定义了 `accessSelect = <PermissionSelect …>`（line 329，
  真正的可切换菜单：trigger + Menu + RiskConfirmation），但**从未把它渲染进
  JSX**——工具栏里只有一个**静态盾图标按钮**（无 onClick，纯展示）。fork 时
  的遗漏，导致访问模式看似有个按钮、实则不能切换。
- **修法**：删掉静态盾图标按钮，改渲染 `{accessSelect}`。`PermissionSelect`
  本身支持随时切换（`command('/permission <id>')`），`locked` 仅在会话被移除/
  离线/被 block 时为 true（官方语义 `locked = removed || inert || !live ||
  blocked || parentOffline`），正常情况下可切。
- **实机验证**：点「访问模式」弹出菜单（只读/工作区读写/Full access）→ 切到
  「只读」→ trigger 即时更新为「只读 ▾」（description「只能读取文件」）。task
  泳道与普通会话均生效。

### 2026-08-31 · 走查 skill 1:1 复刻新会话界面（pencil-to-corum-ide 六步）

- **背景**：此前实现未走 skill 的「读稿→提取表→确认→写码→三遍走查」纪律，
  直接上手导致与设计稿偏差（快捷指令卡做成小胶囊、无副标语、工作区用原生
  select、表单/标语数值凭经验）。按 `.trae/skills/pencil-to-corum-ide` 重做。
- **三遍走查修正点**（设计稿节点 `nes6F`/`btAJh` 为唯一事实来源）：
  1. **新会话界面标语**：30px → **34px/700**（slogan）；副标语 14px → **15px**
     「已在 {工作区} 工作区 · 由 {Agent} 执行」（sub）。center-stage gap 28→**36**、
     pad → **40**；hero-text gap → **14**。
  2. **快捷指令卡**：横排小胶囊 → **220 宽竖排玻璃卡**（pad 18 / gap 10 / cr 16 /
     fill `$glass-2` / stroke `$glass-border`）：head 行（icon 16 brand-primary +
     title 14/600）+ **desc 行（12px tertiary, lineHeight 1.5）**。
  3. **工作区下拉**：原生 `<select>` → **自绘「trigger + 展开面板」**（trigger
     folder icon + 名称/路径 + chevron，border-active；panel 顶部「选择新目录…」+
     分隔线 + 带选中态 `#01CDFE1A`+✓ 的工作区列表，点击外部收起）。
  4. **副标语工作区名**：`chipTitle` 在 task blank 会话可能为 undefined → 回退
     `workspaceLabel(cwd)`；Agent 名经新增 `emptyActions.getTaskAgentName(sessionId)`
     （listTaskAgents 取 profileId → listProfiles 映射名）异步查询。
- **实机三遍对照**：dark/light 双主题截图均与设计稿一致（标语/副标语/竖排卡/
  自绘下拉/composer 工具栏）。副标语实测「已在 dsh_test 工作区 · 由 研发 执行」。
- **教训固化**：改 corum IDE 界面**必须先读 design.pen 建提取表（含文本/尺寸/
  颜色/字体/间距/效果/图标 7 类）、截图对照、深浅双主题各验**——DOM/a11y 结构对
  ≠ 视觉 1:1。

### 2026-08-31 · 新会话界面垂直水平居中（blank 会话按 hero 相位布局）

- **症状**：新会话界面（标语/卡片/输入框）顶在视口上方、不居中，且各元素未垂直
  对齐——用户实测「未居中 + 输入框和上方元素未垂直居中」。
- **根因**：blank 会话被 `hasSession` 判为 `phase='active'`，走 `composerSeat`
  的 `position:sticky; bottom:0` **底部停靠**布局，scrollBody 无
  `justify-content:center`；NewSessionHero 塞进 composerStack 后整组被压到顶部，
  且 hero 宽度（1052px）超出 seat 容器（972px）导致水平错位。
- **修法**（复用官方 hero 居中机制，不新造轮子）：
  - `isNewSessionHero = hasSession && summaryBlank === true`；
  - `phase`：blank 会话也归 `'hero'`（scrollBody `justify-content:center` 垂直居中）；
  - `composerStack` className：`!hasSession || isNewSessionHero` 时加 `composerHero`
    （`align-self:center` + composer 宽度 cap，卡片组与输入框同宽对齐）。
  - 注意 `isNewSessionHero` 必须在 composerBar 之前声明（const TDZ，曾在 475 行
    引用 503 行的声明报错，已上移）。
- **实机验证（截图确认）**：标语→副标语→快捷指令卡→输入框整组垂直水平居中，
  各项同宽对齐，与设计稿 center-stage 一致。发第一条消息 blank 翻转后回 active
  底部停靠。
- **居中参照系（用户确认）**：内容在**对话区**（sidebar 右侧区域）居中，**不是
  整个窗口**——实测中心偏移 -4px（滚动条 gutter 误差内）。截图若把 sidebar 算进
  画面会「看起来偏右」，是视觉错觉，布局本身正确。另：`.newSessionHero` 需
  `box-sizing:border-box` + `max-width: var(--dsh-composer-card-max-width)`，否则
  padding 溢出容器导致水平偏移（本次踩过）。

### 2026-08-31 · composer 锁定 chip 显示当前 Agent 昵称（不再是「Agent 已锁定」）

- **改动**：锁定 chip 文本 `{agentName ?? '已锁定'}`（保留 🔒 + tooltip「Agent 已
  锁定，会话内不可变更」）。`agentName` 查询从「仅 blank 会话」放宽到**所有
  task 泳道**（blank 与正式会话），发消息后昵称保持。
- **数据源**：`emptyActions.getTaskAgentName(sessionId)`（listTaskAgents 取
  profileId → listProfiles 映射 nickname/title/id），异步返回后 chip 从「已锁定」
  更新为昵称（实测显示「研发」）。
- **注意**：首次渲染因 RPC 未返回会短暂显示「已锁定」，随后更新——若要求避免
  闪烁，可在 host 建会话时把 agentName 写进 session meta，UI 同步读（未做）。

### 2026-08-31 · 修复侧栏折叠失效（lockedSlots 的 300 覆盖 collapsedWidth 的 56）

- **症状**：点「折叠侧栏」后图标轨出现，但**宽度仍 300px 未收起**（应有 56px）。
- **根因**：`AppFrame.lockedSlots` 在右侧三区域全隐藏（默认）时把 `corum.sidebar`
  运行时锁定为 300。而 `GridView` 里 **`lockedSlots` 优先于 `collapsedSlots`**
  （`locked` 命中即返回，`collapsedWidth=56` 轮不到）——折叠加的 collapsedSlots
  永远被 lockedSlots 的 300 压制。
- **修法**：`lockedSlots` 计算排除「用户主动折叠」——
  `rightAllHidden && !sidebarCollapsed` 时才锁 300；折叠时从 lockedSlots 移除
  sidebar，让 collapsedWidth=56 接管。
- **实机验证**：折叠 → rail 宽 56px；展开 → 恢复 300px、rail 消失。双向正常。
  （`corum-ide-ui`，与本轮 conversation 改动无关，是既有缺陷在走查中暴露。）

### 2026-08-31 · 修复「添加工作区」报 cannot get property "remote" without inject

- **症状**：侧栏「工作区」右上角 ＋（添加工作区）点击后弹 alert
  `cannot get property "remote" without inject`。
- **根因**：`corum-ide-sidebar-ui/src/client/index.ts` 的 `pickDirectory` 直接
  `ctx.remote.directoryPicker.pick()`——`ctx.remote` 命名空间代理由 connection
  服务随 fiber 装配，本 fiber 取不到（PROGRESS §4 / conversation apply.ts 同款坑）。
  本插件 inject 虽声明了 `connection`，但 `ctx.remote` 与它不是一回事。
- **修法**：不碰 `ctx.remote`，改走官方 `connection.rpc.call('/api',
  'directoryPicker/pick', { args: {} })`（与 conversation 的 `pickDir` 同通道、同
  `{args}` 契约）——`ctx.get('connection')` 在 apply 顶部本就可用。
- **实机验证**：点「添加工作区」无 alert、按钮转 disabled（host 已受理、在等
  native 目录选择器结果），console 零错误。
- **教训固化**：corum 插件要调 host Remote 端点，**一律用
  `connection.rpc.call('/api', '<ns>/<method>', { args })`，不要用 `ctx.remote`**——
  后者依赖 fiber 的 remote 命名空间装配，取不到时抛「cannot get property
  "remote" without inject」。

### 2026-08-31 · 侧栏「新会话」主按钮改为回空态 + 自动打开新建任务表单

- **需求**：侧栏顶部「新会话」主按钮点击后**回空态 + 打开新建任务表单**（选
  工作区/Agent/模型/权限 → 开始），与空态「新建任务」卡同一流程；不再直接
  建 blank 会话。
- **实现**：
  - `SessionsPaneInjected.openNewTaskForm`（顶部主按钮专用；group plus 的
    `startSession` 仍直接建会话，语义不同、不动）。
  - `index.ts openNewTaskForm`：`ctx.sessions.clear()`（官方公开 API，取消选中 →
    对话区回落空态视图）+ dispatch `corum:open-new-task-form` + 兜底
    `sessionStorage['corum:pending-new-task-form']`。
  - `EmptyStateHero`：监听 CustomEvent（已在空态时）+ 挂载时消费 sessionStorage
    标记（从会话视图切回空态时 EmptyStateHero 刚挂载、事件已落空——**时序坑，
    裸 CustomEvent 会丢**）。
- **实机验证**：选中正式会话 → 点「新会话」→ 回空态（大 logo + 新建卡 + 最近）
  → **自动展开新建任务表单**（工作区自绘下拉/Agent/模型/权限/开始），无 console
  错误。

### 2026-08-31 · 移除侧栏「未分组」桶

- **需求**：现在的交互里会话都挂在工作区下（新建任务表单必选工作区），不存在
  无归属会话，「未分组」节点直接去掉。
- **修法**：`SessionsPane` 分组推导里删掉未分组组的 push（`result.push({ key: '',
  workspace: null, sessions: ungrouped })`）——只保留工作区组。历史遗留的未分组
  行不再显示（不与当前交互模型冲突）。
- **实机验证**：侧栏只剩 dsh_test / kkc-desktop 两个工作区组，无「未分组」节点。

### 2026-08-31 · 对话区 Agent 头显示 Agent nickname（不再是通用「Corum Agent」）

- **需求**：对话区每条 assistant 消息的 Agent 头（avatar + who + dur）显示当前
  会话选中的 Agent **nickname**，不是写死的「Corum Agent」。
- **实现**（`corum-ui-chat`）：
  - 新增 `AgentNameContext`（React Context）：`AgentHeader` 用 `useAgentName()`
    显示昵称，非 corum Agent 会话/查询失败回退「Corum Agent」。
  - `ChatViewInjected.getAgentName()`：task 泳道（corum-task-*）经
    `connection.rpc.call('/api','corumAgent/listTaskAgents')` 定位 profileId，再
    `listProfiles` 映射 nickname/title/id；普通官方会话暂回退（SessionSummary 无
    agentPreset 快照字段）。
  - `ChatView` useEffect 查一次放进 `AgentNameContext.Provider` 包裹整个 ChatView。
- **依赖处理**：不引 `@corum/corum-rpc-client` 包（pnpm 严格隔离未 hoist）——
  直接 `ctx.get('connection').rpc.call` 内联同通道调用。
- **实机验证**：assistant 消息 Agent 头显示「研发」。

### 2026-08-31 · 装配 tool-ask-user：AI 可在 GUI 弹提问对话框

- **需求**：让 AI 能通过 `ask_user_question` 工具在 GUI 弹出模态提问框（而非在
  文本里直接发问）。
- **装配链排查**（三处缺一不可）：
  1. **host 能力服务** `user-questions`（`@deepseek-ai/dsh-user-questions`，提供
     `ctx.userQuestions.ask`）——base bundle 已含 ✓
  2. **前端** `ui-user-questions`（`@deepseek-ai/dsh-client-ui-user-questions`，渲染
     对话框，conversation.composer 槽）——web-app bundle 已含 + desktop 已依赖 ✓
  3. **host 工具** `tool-ask-user`（`@deepseek-ai/dsh-tool-ask-user`，注册
     `ask_user_question` 工具，inject `['tools','userQuestions']`）——**corum preset
     编译产物（compile.ts）缺失** ✗ ← 根因
- **修法**：`corum-agent-dev/src/compile.ts` 的 filesystem 组后补一行
  `{ id:'tool-ask-user', name:'@deepseek-ai/dsh-tool-ask-user' }`（官方 standard
  preset 同款，无 config）。preset 在 `writeAgentDir`（createAgentForTask/createAgent
  时）重编译落盘——**重启 + 新建会话才生效**。
- **实机验证（全链路）**：新建任务（研发 Agent，preset 已含 tool-ask-user）→
  发「用 ask_user_question 弹对话框」→ AI 调用工具 → 前端弹出「随便问问/你更喜欢
  哪个颜色？」模态框（蓝色/绿色选项 + 自定义输入 + 提交/跳过）→ 选「蓝色」提交 →
  状态翻转「提问 1/1 已回答」→ AI 收到答案继续执行。console 零错误。

### 2026-08-31 · 提问卡片 corum-ui-questions（输入框上方、不遮盖、答完才能发）

- **背景**：官方 `dsh-client-ui-user-questions` 挂 `conversation.composer`（chain），命中
  PendingQuestion 时**接管整个 composer**——遮盖对话历史与输入框，用户正在编辑的下一条
  指令（可能就是答案）被迫中断（用户实测痛点）。
- **方案**（pencil-to-corum-ide 六步法）：**数据通路完全复用**（同一
  `user-questions/request` Remote waterfall + `PendingQuestion`），**渲染层替换**为
  `conversation.composer.dock` 的提问卡片（输入框正上方、不遮盖）。
- **新插件** `packages/plugins/session/corum-ui-questions`：
  - `QuestionCard.tsx`：三题型（单选 radio / 多选 checkbox / 直接回答多行文本）+
    多问题翻页（左下角 `◀ x/n ▶`，与跳过/提交同行）。结构 = design.pen K2M4e9 提取表
    （头部 题型图标+组名+标题+收起/放弃 → 作答区 → 底部翻页+跳过+提交）。
  - `contract.ts`：**自实现 `PendingQuestion`**——官方 `./client` 只 `export type`
    （类型）不导出运行时类，corum 无法 `new`；数据用 `dsh-user-questions` 的
    `AskUserQuestionItem`，应答 `answer/cancel/delegate` 语义与官方一致。
  - `index.tsx`（apply）：注册 `corum-question` locale + `user-questions/request`
    监听（复用官方 answerQuestion 逻辑）+ `conversation.composer.dock` slot 渲染卡片
    （订阅 `ctx.uiSession.pendingInteractions` 取当前会话 PendingQuestion）+ **发送拦截**
    （提问挂起时 `ctx.conversation.blocks.set(sessionId, {reason:'请先回答上方的问题'})`，
    答完 clear——输入框可复制/剪切/编辑、模型可选，仅禁发送）。
  - `QuestionCard.module.css`：全 `--corum-*/--dsw-alias-*` 变量，dark/light 自适应，
    零硬编码。
- **patch（cordis.ide.patch.yml）**：禁用官方 `ui-user-questions`（遮盖式）+ insert
  `corum-questions`；desktop package.json 加 `@corum/corum-ui-questions` 依赖。
- **踩坑**：
  1. host `src/index.ts` 必须 `export function apply(){}`（cordis loader 要求 apply
     方法，`export {}` 会报「invalid plugin」）。
  2. docstring/CSS 注释里 `--corum-*/` 的 `*/` 会**提前闭合注释**导致编译错——
     变量列举一律写 `--corum-* 与 --dsw-alias-*`，不写 `--corum-*/`。
  3. `.ts` 不能含 JSX（index.ts → index.tsx，tsdown entry 同步改）。
- **实机验证（全链路）**：禁用官方 → 新建任务（Task 助理）→ AI 调 ask_user_question →
  卡片在**输入框正上方**（对话历史/系统提示词可见、不遮盖）→ 输入框显示「请先回答上方
  的问题」disabled（发送拦截）→ 选「蓝色」提交 → 卡片消失「提问 1/1 已回答」+ 输入框
  恢复 → AI 收到答案继续。多选题（checkbox）+ 浅色主题均验证通过，console 零错误。

## 4. 风险 / 注意

- **`displayTitle` 对 blank 会话不是空串，是工作区目录名**：任何「取会话标题」
  的地方都必须**先判 `blank`**，不能靠 `displayTitle` 是否为空兜底。
- **落盘时机 = 首次 append**：想让「未发消息的会话不留磁盘记录」，就要避免在
  建会话后立刻 append 任何事件（含 permission/preset 这类 seed）。官方无 GC，
  写了就留下了。
- **UI 发消息不经过 corum 自家 RPC**：官方客户端 `session.prompt()` 直达 host
  session-controller。要在「用户发第一条消息」时插逻辑，得挂官方
  `session/event`（`user/message`），挂自家 RPC 不会触发。
- **pnpm install 的连带破坏（红线）**：仓库根 `pnpm install` 会 prune 掉各 dev-home
  的 `profiles/web/node_modules`。改依赖后若发现 `/plugins` 404，先查
  `.modules.yaml` 的 `prunedAt`。**不要用 `--filter`**（会清空其它包链接）。
- **官方没有 blank 会话的自动回收**：「不保存」靠渲染层过滤
  （`!blank || current`）。磁盘日志仍在。别去找 GC API，也别指望删日志。
- **blank 判定在 host 与 client 不同形**：host `ctx.sessions.list()` 返回
  `Session`（无 blank 字段）；blank 在客户端摘要层。host 侧要判 blank 得按官方
  同源规则自己算（cwd + 事件流无 `turn/start`）。
- **泳道起会话 ≠ 官方 session.create**：官方 `sessions.create({workspaceId})`
  会自动 `workspace.attachSession()`；自起泳道（`agents.create`）必须补 attach，
  否则永远落「未分组」。attach 要求 `realpath(cwd) === workspace.path`。
- **`ctx.remote.<ns>` 的可用性取决于 fiber 的 inject**：不是全局单例。官方
  `ctx.remote` 由 connection 服务装配；插件 inject 里没有 `connection` 就没有
  `ctx.remote`（getter 抛错，不返回 undefined）。跨包复用「同一行 Remote 调用」
  时务必确认两边的 inject 一致；不确定的话直接用
  `connection.rpc.call('/api','<ns>/<method>',{args})`，契约相同且不依赖命名空间。
- **官方 preset 表的顺序是声明序，不是「宽松度序」**：取默认档位要用官方
  `defaultPreset`，不要用 `list[0]`（本项目表首项是 read-only，最严档）。
- **构建新鲜度判断**：一律比对 lib **文件**（非目录）与 src 文件的最大 mtime。
- **corum RPC 调用方式（实机探针用）**：`POST /api/<ns>/<method>`，body
  `{type:'client-request', rpcId, method:'<ns>/<method>', payload:{args}}`。
  **method 必须 URL + body 双写**。插件内仍用 `makeCorumRpcCall(connection)`。
- **「服务没挂」的误判**：页面没有对应 UI 控件 ≠ 服务没挂。查 bundle 的
  cordis.yml（base 的 `node_modules/.pnpm/@deepseek-ai+dsh-base*/…/cordis.patch.yml`）
  与持久化事件层。
- **访问权限三档不是 UI 装饰**：三档直连官方沙箱/审批执行链（`dsh-permission-presets`
  + `dsh-sandbox-policy` + `dsh-user-approval`）。当前 corum 组合里
  `permission-presets` **未挂载**（插件清单 plugin-meta.ts 有条目但运行时无
  permissions 控件，页面 innerText 搜不到「权限/只读」字样），开发前须先确认
  是否挂该包；不挂则三档选了也不生效（旋钮事件无人消费）。
- **档位变更只影响新建会话**：官方语义是 `permission` 设置命名空间的
  `defaultPreset` 只在**之后创建**会话时生效，已存在会话不变——新建任务表单
  里选档位正好落在「创建时」，语义吻合。
- `doc/UXDesign/design.pen` 有无关改动，提交时继续排除，避免污染正式功能提交。
- 多 host 残留仍是红线：IDE 调试脚本落地前，重启仍按 `corum-cdp-verify` 技能清残留。
- LanePool 泳道占用投影仍是进程内存态；IDE 若要展示运行中状态，重启后需以事件日志/数据层为准重建。
- **HMR 槽位注册（2026-08-26 子 Agent 调查澄清）**：工作区规则「HMR 热交换不重挂槽位注册（ctx.slots.inject 是 fiber 级一次性副作用）」是**误诊**。真实机制——fiber 热交换（`packages/desktop/src/client/hmr.ts`，与官方 hmr 同算法）会**完整 teardown 旧 fiber 并重跑新 bundle 的 `apply()`**，槽位注册每次都重挂。真正需整页刷新的只有两类：① `RELOAD_VIA_PAGE` 集合（`corum-desktop` / `dsh-client-modules`，core provider 依赖级联不可靠，已正确分流）；② 根结构/壳层（AppFrame/GridView 等）旧 fiber **卸载不干净**导致新注册冲突（single 槽同 priority 撞车）。可优化点是「卸载彻底性 + 故障可观测性」（fiber 交换失败目前渲染端无感），而非补「重挂注册」机制；React 状态保留（Fast Refresh 式）是官方刻意取舍（lazy 纯注册模型），不宜攻关。改 inject 形状后建议仍重启验证（规避卸载不干净假象），但这不是架构限制。
