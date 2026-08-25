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
- 最新提交：`2f73e69b`（移除 coding combo 的 S0 测试插件注入 + 补 `scripts/dev-ide.sh`）
- 未提交文件：`doc/UXDesign/design.pen`（与本任务无关，保持未纳入）
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

## 4. 风险 / 注意

- `doc/UXDesign/design.pen` 有无关改动，提交时继续排除，避免污染正式功能提交。
- 多 host 残留仍是红线：IDE 调试脚本落地前，重启仍按 `corum-cdp-verify` 技能清残留。
- LanePool 泳道占用投影仍是进程内存态；IDE 若要展示运行中状态，重启后需以事件日志/数据层为准重建。
