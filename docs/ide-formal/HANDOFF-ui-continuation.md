# UI 开发任务交接提示词（context 受限恢复用）

> 用途：当上一会话因上下文资源紧张中断时，新会话读本文件即可无缝接续 corum IDE 的
> UI 开发任务。本文件是「活文档」——每次推进后更新「当前状态 / 下一步」。
> 配合 `docs/ide-formal/PROGRESS.md`（进度日志）一起读。
> 最近更新：2026-08-29（第八轮）· 基线提交：`cd021f26` · 分支：`feat/ide-s4-restore`
> 工作区：**已干净**。两件大事落地：① **dsh 基座 0.1.1-rc.2 → 0.1.2-alpha.1 全量升级**
> （私服发布 + transport 重构为官方 loopback webserver）；② **会话区全面重设计 B 方案**
> （fork 官方会话 UI 三包 + 全局液态玻璃换肤 + 全部卡片按新设计重构，含 corum 特有
> Review 卡）。自研数据通路已退役，官方会话 UI 在 IDE 完整跑通泳道（见 §五.8/§六）。

---

## 一、给接续 Agent 的开场指令（直接复制使用）

```
你在 /Users/kukucai/work/kkc-desktop 仓库继续 corum Agent OS 的 IDE(coding) UI 开发。
这是一个 Electron + React + Cordis 插件的桌面壳，基于 DeepSeek Harness 底座（不改内核，
只做用户空间：写插件 + overlay）。

开工前必读（按序）：
1. docs/ide-formal/HANDOFF-ui-continuation.md（本文件）——任务全貌与当前状态
2. docs/ide-formal/PROGRESS.md —— 进度日志（每条含根因/实现/验证/踩坑）
3. doc/UXDesign/DESIGN.md —— 设计 token / 布局 / 组件总说明

⚠️ 2026-08-29 重大架构变更（覆盖旧认知，开工前务必先读）：
- **dsh 基座已升 0.1.2-alpha.1**（私服 localhost:4873 发布，项目 `.npmrc` @deepseek-ai 指私服）。
  desktop transport 已从「自定义 IPC」**重构为官方 loopback webserver**（`loadURL(authenticatedUrl)`，
  renderer 直连 /api）。**`corumDesktop.unary` IPC 桥已退役**——corum 自有 RPC 全走
  `ctx.get('connection').rpc.call('/api','<ns>/<method>',{args})`（共享包 @corum/corum-rpc-client）。
- **会话区已全面重设计（B 方案）**：对话区不再用自研 corum-ide-conversation-ui（已退役），
  改用 **fork 官方会话 UI**——`@corum/corum-ui-conversation` + `@corum/corum-ui-chat` +
  `@corum/corum-ui-approval`（packages/plugins/session/ 下），官方数据流 + corum 新设计渲染层。
- 必读：`docs/ide-formal/PLAN-conversation-ui-redesign.md`（B 方案全貌）+
  `docs/ide-formal/DESIGN-conversation-information-architecture.md`（信息架构：一轮=过程瀑布+统一收尾）+
  `docs/ide-formal/PROGRESS.md` 最近 2 条（0.1.2 升级 + B 方案落地，含全部踩坑）。

协作规则（沿用 PROGRESS.md §0）：
- 按用户节奏推进，不一次性铺开；从上到下（先界面可见元素，再接 host 数据）。
- 子 Agent 优先做并行调查/读码/验证；当前会话保留协调/决策/进度记录。
- 进度即代码：每完成一小步更新 PROGRESS.md，重要节点提交 git。
- 不改官方内核（@deepseek-ai/dsh-* 一律 registry 引用），只写插件 + overlay。
- 工作区保持干净的排除项绝不提交：doc/UXDesign/design.pen（设计稿事实来源）、
  project.config.json / project.private.config.json（本地配置，未跟踪）。
  doc/UXDesign/images/ 的设计源图默认也不提交（除代码显式引用的资源）。

启动/验证实例（安全第一，绝不误杀微信开发者工具）：
- 用 ./scripts/cdp.sh start|status|stop|pid|restart（详见本文件 §四）。
- 绝不用 `grep -iE "electron|node|lib/main.js"` 宽 pattern 杀进程（会误杀微信开发者工具）。
- CDP 端口 9222，验证技能 ~/.agents/skills/corum-cdp-verify。
```

---

## 二、项目一句话

corum Agent OS = DeepSeek Harness（内核：Cordis + agent-loop + capability seam）之上的
**插件发行版 + Electron 桌面壳**。GUI 是自由组合的插件式工作台（区域=插件=能力）。
本任务聚焦 **IDE(coding) combo 的正式 UI 对接**——把设计稿（doc/UXDesign/design.pen）
落地为可运行的界面，并逐步接真实数据。

## 三、当前实例状态（交接时）

- **运行中**：IDE/coding 实例，CDP :9222 可达，leafs=5 渲染正常（液态玻璃对话区 + 泳道
  消息流 + 玻璃 composer + 文件树 + 终端）。
- **分支**：`feat/ide-s4-restore` · **最新提交**：`cd021f26`（B 方案文档收尾）
- **工作区**：**已干净**——0.1.2 升级 + B 方案全部落地（提交栈见 §六）；排除项照例未跟踪。
- **关键架构（2026-08-29 第八轮定稿）**：
  - **基座**：dsh 0.1.2-alpha.1（私服发布）。desktop transport = **官方 loopback webserver**
    （webserver 127.0.0.1:0 + loadURL authenticatedUrl，renderer 直连 /api；corumDesktop.unary
    已退役，corum RPC 走 `ctx.get('connection').rpc.call('/api',...)`）。
  - **会话区 = B 方案**：**官方数据流**（session 事件 → fork 的 ui-conversation 投影 → 槽渲染）
    + **corum 自研渲染层**（fork 的 ui-chat 卡片，液态玻璃新设计）。泳道（corum-task-*）已在
    官方对象层，官方会话 UI 零适配渲染泳道。
  - **task 泳道数据通路（§五.8）**：管理面官方对象层 / 创建面泳道 RPC（createTaskAgent）/
    数据面官方 ui-conversation 投影（**不再是自研 getTaskSessionEvents+buildCards**）/
    发送面官方 session.prompt / 审批面 fork ui-approval（pendingInteractions + answer）。
- **下一步（§七）**：子Agent卡精确进度（接子会话事件窗）/ 审批卡真实 escalation 验证 /
  弹层（统计/上下文用量/＋/权限/@Agent）/ project 模式对话区。
- **布局**：root row `[sidebar(300), conversation(509), right-col]`；right-col =
  `column [row(editor, explorer), panel]`。侧栏 pinned（固定），其余四区域自由组合。
  侧栏可折叠为 56px 图标轨（collapsedWidth，见 §五.7）。

## 四、工具链（关键，全部已验证可用）

### 1. 实例启停 `./scripts/cdp.sh`（2026-08-28 修复 sandbox 兼容性）

```bash
./scripts/cdp.sh start     # 清理旧实例 + 后台启动（秒回，不等 CDP）
./scripts/cdp.sh status    # 探测存活 + CDP 可达；Electron 就绪后自动补记 PID
./scripts/cdp.sh stop      # 精确清理本实例（PID + 子进程树），不动微信
./scripts/cdp.sh restart   # = start
```
三条红线（踩过的坑，见 PROGRESS 常见坑表）：
- start **必须秒回**：脚本被 Agent 工具带超时调用，内部等 CDP/PID 会被外层 SIGTERM
  连坐杀 Electron（GPU exit_code=15）。故 start 只 spawn + 立即 exit，PID 由 status 补记。
- spawn **必须切断 fd 血缘**：后台 Electron 继承脚本 stdout/stderr fd 会让脚本 hang。
  用独立子 shell + `nohup ... >log 2>&1 </dev/null & disown` 三重 fd 全断。
- **绝不依赖 ps**（2026-08-28 四实例事故根因）：Agent sandbox 禁 `/bin/ps`，
  `is_self` 改用 `pgrep -f "$SELF_MARK"` 集合判定（cmdline 含本仓库绝对路径即 self，
  微信路径绝不含此子串）。stop 后必须验证 `pgrep -f <repo>/packages/desktop/lib/` 归零。

### 2. CDP 驱动 `~/.agents/skills/corum-cdp-verify/scripts/cdp.mjs`
```bash
node <skill>/scripts/cdp.mjs eval '<js>'        # 页面内执行 JS
node <skill>/scripts/cdp.mjs evalfile /tmp/x.js # 从文件执行（推荐，免转义）
node <skill>/scripts/cdp.mjs shot <名>          # 截图到 /tmp/corum-cdp/shots/
```
- **页面匹配已兼容 loopback**：0.1.2 起 renderer 是 `loadURL(authenticatedUrl)`（官方 loopback
  webserver），页面 URL 是 `http://127.0.0.1:<ephemeral>/`（不再是 corumapp://）——cdp.mjs 的
  waitPage 已改成同时匹配 `corumapp://` 和 `http://127.0.0.1:`（2026-08-29 修）。
- **截图能看了**：本会话已配置图像输入，`read_image` 可直接读截图做 UI 走查。
- **CSS `:hover` 是浏览器原生状态**，合成 mouseenter 不触发——hover 交互验证靠
  规则注入检查 + 用户目检。
- **console 错误抓取**：cdp.mjs 的 eval 拿不到 React 错误边界的错误——用 CDP Runtime
  console API（参考本仓库 /tmp/get-console.mjs 模式：Runtime.enable + Runtime.consoleAPICalled +
  Runtime.exceptionThrown，能拿到 slot entry crashed 的完整堆栈）。

### 3. 构建（避开 pnpm run 的 verify-deps，直调 .bin）
```bash
CI=true pnpm --filter @corum/corum-ui-base run build          # ui-base（grid/GridView）
CI=true pnpm --filter @corum/corum-ide-ui run build           # ide-ui（壳 AppFrame 等）
CI=true pnpm --filter @corum/corum-ui-conversation run build  # fork 会话骨架
CI=true pnpm --filter @corum/corum-ui-chat run build          # fork 消息渲染层
CI=true pnpm --filter @corum/corum-ui-approval run build      # fork 审批
CI=true pnpm --filter corum-desktop run build                 # desktop（electron main+client）
CI=true pnpm --filter <pkg> run typecheck                     # 单包类型检查
```
**host 插件改动必须重启实例**（corum-agent-dev / desktop host corum-fs.ts 等）；renderer
业务组件 HMR 可热更，但壳层/fork 包结构改动建议重启验证。
**关键**：`corum-ide-ui/lib/client.js` **内联打包** ui-base 的 grid/GridView 逻辑——
改 ui-base 后必须**单独重建 corum-ide-ui** 才生效。`sidebar.module.css` 由
corum-ide-ui 源码子路径导出，被 sidebar-ui / project-ui **各自编译进 bundle**
（CSS Modules 哈希同源）——改它需**重建两个消费包**。
**`pnpm install` 勿用 `--filter <pkg>`**——会清空其它包 node_modules 链接（曾致
SlotMap 合并失效）；用全量 `CI=true pnpm install --no-frozen-lockfile`。

### 4. Pencil MCP（设计稿读取/编辑，唯一 MCP）
- 工具：`mcp__pen__execute`（Get/Print/TakeScreenshot/Update/Export）、
  `mcp__pen__get_app_state`、`mcp__pen__read_skill`、`mcp__pen__browser`、`mcp__pen__get_style`。
- 读设计稿：`execute({filePath:'doc/UXDesign/design.pen', input:'Print(JSON.stringify(Get("节点ID",{depth:N})))'})`。
  ref 组件需 `{resolveInstances:true}` 展开；变量用 `GetVariables()`。
- **脑补禁令**：设计稿是唯一事实来源，任何数值/颜色/文本/图标都必须能在设计稿找到
  来源；`Get` 返回含 `"..."` 截断必须加深 depth 重读。
- **设计稿可编辑**：`Update(id,{props})` 改节点、`Export([id],"png","/tmp/dir")` 导出
  高清图。**推荐工作流（用户定调）**：设计稿先调到实机尺寸定稿 → 再改代码
  （比代码试错高效，尺寸冲突就用这招——见 §五.5 Agent 标题栏、§五.9 项目模式）。
- **图像分析**：Python（struct/zlib 纯标准库）解 PNG 像素测内容净边界/颜色；
  `sips -c <h> <w> --cropOffset <y> <x>` 裁图；`iconutil -c icns` 打包 macOS 图标。

## 五、关键架构认知（改动前必懂）

### 1. GridView（`corum-ui-base/grid.ts` + `GridView.tsx`）
像素绝对定位二维分割树。leaf=槽位窗格，branch=row/column split（weights=像素份额）。
持久化 localStorage `corum.ide.grid.v3`。
- `registerSlot(key, {label, defaultWeight, minWidth, minHeight, pinned, collapsedWidth})`。
- `subtreeMinSize()`：同轴求和、正交取最大；sash 拖拽 `resizeBranch`（含传导推动）、
  窗口自适应 `rescaleGrid`、渲染夹取 `computeCellSizes` 三处统一消费。**hidden leaf /
  全隐藏 branch 返回 0**（不计入兄弟格填满的 min 阻碍）。
- **整支隐藏判定必须递归（`nodeAllHidden`）**：BranchView 的 detached 对 branch 子用
  它（判所有后代 leaf 全 hidden），不能只看直接子 `c.hidden`——否则嵌套 branch
  （right-col 里的 row(editor,explorer)）内部全隐藏也判不出，该支仍占位、兄弟格
  （终端/对话区）不铺满（2026-08-28 走查两问题根因）。
- `leafTopOffset?: number[]`（AppFrame 传 `[40,40,0]`）：root row 各格内容格顶部下移
  （sidebar/convo 让位标题栏，right-col 0 顶到窗口顶）。
- **新增 collapsedWidth 折叠机制（§五.7）**。

### 2. AppFrame（`corum-ide-ui/AppFrame.tsx`）
`.frame`(padding:0) → mainRow(GridView 顶到窗口顶) + titlebarRow(absolute 浮层只压左列，
width=convoBox.x+width，`-webkit-app-region:none` + `pointer-events:none`，两段
`.titlebarDrag`=窗口标题栏+Agent 标题栏座位 drag，按钮 no-drag)。

### 3. 侧栏双模式（`corum-ide-sidebar-ui`）
- **骨架 SidebarSkeleton**：brand-row（矩道品牌卡 134×54 + mode-switch 110×36）+
  「项目/任务」切换（反转动画）+ 两个子槽常驻挂载（corum.sidebar.sessions /
  corum.sidebar.project，切可见性不丢态）。
- **任务模式 SessionsPane**：**工作区分组会话列表**（对齐官方 WorkspaceBrowser）。
  结构：新会话主按钮 → 区头「工作区」（搜索胶囊/视图选项/添加工作区）→ 工作区分组行
  （chevron + folder + 名称 + hover 行尾操作：ellipsis 菜单 重命名/删除 + plus 新建）→
  组内会话行（dot + 标题跑马灯 + 中文相对时间 + 右键菜单）。「未分组」桶收尾。
  - 数据：ctx.sessions.list + ctx.workspaces.list（IWorkspaces 全量服务）。
  - **过滤（2026-08-28 第七轮改）**：`isTaskSessionId(id)` = **`id.startsWith('corum-task-')`**
    ——task 模式只显示 task 泳道；官方 session-* 测试残留、corum-proj/corum-dev 均不进。
    blank 过滤恢复官方语义（空会话不进列表，除 current；测试残留空泳道自然被滤）。
  - **新会话**：`startSession` 走泳道 `createTaskAgent` RPC（起 corum-task-*，cwd 取工作区
    路径）+ `ctx.sessions.open` 选中（不再走官方 workspaces.startSession 起 session-*）。
  - **fork 禁用**：泳道 fork 第一版禁用（决策 C，语义待定）。
  - **会话行**：单击打开、双击/右键「重命名」行内改名（官方 session.rename 对泳道可用）、
    右键菜单（重命名/归档 archiveSession/提炼经验占位禁用）、标题溢出 hover 跑马灯。
  - **已知未接**：泳道 cwd 未 attach 官方 workspace（泳道行全在「未分组」，非 cwd 对应
    工作区组）——见 §七.9。
  - **折叠**：AppFrame 折叠按钮 → GridView 收 56px + SidebarRail 9 图标竖排轨。
- **项目模式 ProjectPane**（`corum-ide-project-ui`）：空态/历史项目/项目详情
  （管理段七维计数 + 团队段成员泳道会话）。字号图标已按任务模式比例放大。

### 4. 窗口（`electron/main.ts`）
- minWidth 1219 / minHeight 427。
- `titleBarStyle: 'hiddenInset'`（macOS 保留红绿灯）。
- `trafficLightPosition: {x:12, y:13}`（与标题栏图标中线 y=20 对齐，实测定标）。
- 窗口 title 动态：`app.getLocale().startsWith('zh') ? '矩道' : 'Corum'`。
- dev 态 `app.dock.setIcon(assets/icon.png)`（鲸鱼图标）；打包态 `mac.icon: assets/icon.icns`。

### 5. HMR（`corum-desktop/src/client/hmr.ts`）
- fiber 热交换（与官方同算法）+ `RELOAD_VIA_PAGE` 集合（corum-desktop/dsh-client-modules
  整页重载）。
- **样式竞态已修**：`removeOwnedStyles(id)` 在 `prefetch` **之前**执行——否则 inline-css
  IIFE「已存在则跳过」守卫撞上旧标签、teardown 又删掉它，插件样式永久丢失。
- **壳层改动（AppFrame/GridView 根结构）HMR 不可靠**（root 槽竞态），改后重启验证；
  renderer 业务组件 HMR 可热更（样式修复后可靠）。

### 6. Electron `-webkit-app-region`（2026-08-28 第三轮修正认知）
非继承、初始 none；「子元素覆盖父级」**仅对显式声明了 app-region 的后代生效**——
未声明的后代落入父级命中区。因此 drag 容器**不要**用 `.x * { drag }` 通配（通配
特异性与按钮 no-drag 打平、后写胜出，按钮被改回 drag 不可点——问题1 根因）。正确
做法：**容器 drag + 可点控件各自显式 no-drag**（Agent 标题栏根 drag、内部文字/按钮
no-drag，空白/未声明后代随根可拖）。

### 7. 侧栏折叠机制（2026-08-28 新增，design J0PbdL）
- `SlotMeta.collapsedWidth`（sidebar 注册 56）+ grid.ts 折叠态注册表
  （`setSlotCollapsed/isSlotCollapsed/slotCollapsedWidth`）。
- `leafMinSize` 折叠态取 collapsedWidth——**窗口 rescaleGrid/sash 传导不会拉回 300**。
- GridView `collapsedSlots` prop → `computeCellSizes` locked 格（宽度锁定、两侧 sash 隐藏）。
- AppFrame：折叠时 leaf 渲染 SidebarRail（9 图标：展开/新会话/添加工作区/搜索/面板/
  终端/插件/主题/设置；前三个点击=展开侧栏），NavTitleBar 图标全隐藏（循设计稿）。

### 8. 会话区架构（2026-08-29 第八轮定稿，**核心架构 · B 方案**）

**总体**：会话区 = **官方数据流 + corum 自研渲染层**（B 方案）。自研 corum-ide-conversation-ui
已退役（组合层不挂载）。fork 三包在 `packages/plugins/session/`：
- **`@corum/corum-ui-conversation`**（fork dsh-client-ui-conversation）：官方数据流骨架——
  session 事件 → ui-conversation 投影（BoundConversation/ConversationNodeAssembler）→
  槽渲染。inject 移除 uiWorkspace（kkc 禁官方 ui-workspace）+ ConversationRoot useWorkspaces 降级。
- **`@corum/corum-ui-chat`**（fork dsh-client-ui-chat）：消息节点渲染层（conversation.chat.node
  keyed 槽，user/assistant-step/turn-process/turn-tail/turn-error/command/context/compaction 等）。
  corum 在此做了：全局液态玻璃换肤（14 张 module.css + corum-reskin.css）、user 品牌气泡、
  错误卡、Review 卡、子Agent卡。
- **`@corum/corum-ui-approval`**（fork dsh-client-ui-approval）：审批 answerer +
  pendingInteractions 数据通路（与官方逐字节一致）+ ApprovalPanel 重构为 corum 审批卡
  （warn 描边 + 拆分按钮「允许一次+▾浮层」+ 拒绝）。

**四层分工**：
- **管理面 = 官方对象层**：泳道 corum-task-* 已在 ctx.sessions.list（官方会话 UI 零适配渲染）。
- **创建面 = 泳道 RPC**：`createTaskAgent(cwd)`（corum-agent-dev，经 connection.rpc 调）。
- **数据面 = 官方 ui-conversation 投影**（**不是自研 getTaskSessionEvents+buildCards**）：
  fork 的 ui-chat 经官方投影消费泳道事件流（流式 chunk/turn 聚合/compaction 全官方）。
- **发送面 = 官方 composer**（conversation.composer，官方提交管线 session.prompt）。

**corum 特有/重构的卡片**：
- **Review 卡**（文件更改审查，官方无）：`corum-ui-chat/chat/review-changes.ts`（识别
  edit/write/str_replace_editor + diff 聚合）+ `review-source.ts`（per-session 数据源订阅
  binding.eventSource + confirmedSeq 确认水位 dismiss）+ `review-revert.ts`（edit 精确反向/
  create 删除/write·insert 跳过）+ `ReviewCard.tsx` + host `corumFs/revertWrites` RPC
  （desktop host corum-fs.ts，read→唯一匹配 splice→write）。挂 ChatView chat-flow 底部。
  **撤销根**：root 参数 = 泳道 cwd（apply.ts 从 sessions list byId[sid].cwd 传入），
  根与文件都 realpath 同基准（macOS /tmp→/private/tmp symlink 坑）。
- **子Agent卡**（delegation 召唤瀑布流卡片）：`contract/subagent.ts`（SubagentInvocation
  delegation→origin=subagent 子会话匹配 + SubagentProgress 模型）+ `conversation-nodes/
  subagent.ts`（节点定义 subagent-progress + registerSubagentConversationNode）+ `SubagentCard.tsx`
  （avatar bot + 任务描述 + run-chip Running/Done + prompt 摘要）。**降级版**：卡片框架 +
  delegation 信息 + 运行态；**精确 step 进度条未接**（需从子会话事件窗算 SubagentProgress）。

**关键机制坑**：
- **cordis inject 按服务名解析**（fiber.inject 查 ctx.get(name)），不是包名。fork 包的
  inject 保留官方服务名（uiConversation/layout 等），kkc 壳已提供同形 ctx.layout。
- **fork 的 dsh.client.external 必须显式声明**（corum 简化 tsdown 无官方 purity 推导）；
  util 包（dsh-util-crypto/util-workspace-path/token-meter 无 dsh.client、不在模块表）**改内联
  不列 external**，否则「missed the module table」。
- **官方 store 的类实例方法裸引用传 uSES 丢 this**（0.1.2 ctx.workspaces.list.getSnapshot
  是 ClientWorkspaceModel 类方法，内部 this.refreshSnapshot）——inject 处必须绑定箭头闭包。
  其它 store（sessions/uiSession/connection）的 getSnapshot 是箭头闭包，不受影响。
- **RPC payload 必须 `{args:{...}}`**（gateway 硬契约「exactly one plain-object args field」）。

**换肤体系**：corum 玻璃 token（--corum-glass-1/2/3/border(-active)，theme.css 注入 body）+
GLASS_TOKENS（--dsw-alias-* 已全局 override 为 corum 值）。对话区背景 transparent 透 ambient
光斑；卡片玻璃化（glass-1/2 + 光边 + backdrop-blur 20px saturate140%）；正文裸流减框。

## 六、提交记录（工作区已干净）

| 提交 | 功能 |
|---|---|
| `f5ff4029` | cdp.sh sandbox 兼容（pgrep 判定 self / 断 fd 血缘 / start 秒回） |
| `3ebd5140` | HMR 样式竞态修复（removeOwnedStyles 移到 prefetch 前） |
| `0a61ed43` | 红绿灯定位 trafficLightPosition (12,13) |
| `7bbcd808` | 程序图标替换（鲸鱼 icon.icns/png + dock.setIcon + mac.icon） |
| `9e5bb6b8` | App 改名「矩道/Corum」（productName/CFBundleDisplayName/title/prompt） |
| `02e3d875` | ui-base GridView 折叠机制（collapsedWidth + locked 格） |
| `81065028` | ide-ui 壳层整改（侧栏折叠接入 + 字号放大 + 走查修复） |
| `2adfb87f` | sidebar-ui 任务模式重写（工作区分组）+ brand-row + 跑马灯/右键菜单 |
| `59087379` | 对话区/文件树/底部面板字号图标放大 |
| `ebffb256` | project-ui 项目模式字号图标放大 |
| `1b6ef51b` | 文档（PROGRESS + HANDOFF）+ pnpm-lock |
| `8ae5f0b5` | 标题栏拖拽/点击命中两修复（删 .titlebarDrag * 通配 + agentTitleBar 根改 drag） |
| `9d2326b2` | 隐藏区域后兄弟格铺满（nodeAllHidden 递归判 branch 子全隐藏 + subtreeMinSize 隐藏取 0） |
| `fe58cdc0` | 会话栏 UI 与设计稿完全统一（user 品牌气泡/ai actions/awaiting 拆分按钮+menu/task-line/删 gauge/on-brand-muted token） |
| `934604e6` | 会话栏渲染层（消息类型→卡片映射 + useSession 修正，wip） |
| `dcb9f06d` | corum-agent-dev task 模式泳道（createAgentForTask + 4 RPC + simplifyEventData 两修复） |
| `89dd986e` | 对话区走泳道数据通路（getTaskSessionEvents → SessionEventDto 映射卡片，真实消息流） |
| `69e2ba18` | corum-agent-dev task 历史读持久化 + resolveTaskAgent 复用官方 activated + inject 补 sessionPersistence |
| `91ff1c34` | 侧栏回归官方对象层（isTaskSession 筛 corum-task + startSession 走泳道 RPC + fork 禁用） |
| `db81d6fd` | 对话区寻址 list.current + 发送切官方 session.prompt（A2） |
| `be3a2a02` | dsh 基座 0.1.1-rc.2 → 0.1.2-alpha.1 全量升级（私服 241 tarball + 187 依赖 bump + lockfile 重建） |
| `86de18f4` | desktop transport 重构为官方 loopback webserver（退役自研 IPC，loadURL authenticatedUrl） |
| `983042b2` | client-runtime 移除迁移（32 文件类型 import）+ 0.1.2 API 适配 |
| `86e71fc8` | corum 自有 RPC 迁移 corumDesktop.unary → connection.rpc（新建共享包 corum-rpc-client） |
| `292fcbae` | settings-models/model-selection 对齐 0.1.2 remote API |
| `af95c832` | corum-agent-dev simplifyEventData 投影 turn/step + turn/end reason 可读化 |
| `df7afc19` | ide-project client-runtime 迁移 + pendingInteraction 接 uiSession + RPC 迁 connection.rpc |
| `50b06cca` | 泳道列表 this 修复（workspaces.list 裸 getSnapshot 丢 this） |
| `454a82e9` | PROGRESS 记录 0.1.2 升级 |
| `754889a8` | fork 官方 ui-conversation/ui-chat 进 corum（B 方案基座） |
| `e76f5a77` | 会话区全局液态玻璃换肤（14 张 module.css + reskin 层） |
| `b83eddba` | fork 官方 ui-approval 进 corum（审批卡重构基座） |
| `e945bd80` | 审批卡重构为 corum 设计（warn 描边玻璃卡 + 拆分按钮） |
| `60e6c0c8` | 错误卡玻璃化（turn-error 裸行 → error 描边卡） |
| `db9d4ec6` | Review 卡（文件更改审查）端到端落地 |
| `fc750f00` | 子 Agent 进度卡（delegation 召唤瀑布流卡片） |
| `2b4f2797` | Review 卡撤销的泳道工作区根 + realpath 同基准修复 |
| `cd021f26` | B 方案文档收尾（PROGRESS/PLAN/DESIGN） |

**拆 commit 方法**（同文件多 hunk 交错时补丁手术不可靠）：备份全部改动 → 临时分支
逐组「恢复 HEAD → 拷回本组文件（必要时裁剪）→ commit」→ feat `reset --hard` 到栈顶。
校验：栈顶所有 tracked 文件与备份逐字节一致。详见 PROGRESS.md 本轮末条。

**排除项（未跟踪，不提交）**：`doc/UXDesign/design.pen`（设计稿事实来源，含用户多轮
改版+我代改的 Agent 标题栏 509/项目模式④字号/brand-row v7）、`project.config.json` /
`project.private.config.json`、`doc/UXDesign/images/`（设计源图——注意 `brand_card.png`
被代码引用已拷入 `packages/desktop/assets/` 并已提交，images 里的源图是否提交用户定）。

## 七、下一步候选（B 方案已落地，以下为深化/扩展项，用户逐项定）

**已完成（本轮）**：dsh 0.1.2 全量升级 + 会话区全面重设计 B 方案——fork 三包
（ui-conversation/ui-chat/ui-approval）+ 全局液态玻璃换肤 + 全部卡片按新设计重构
（user 品牌气泡/工具聚合/审批拆分按钮/错误卡/Review 卡/子Agent 卡）+ Review 卡撤销
实操端到端。自研数据通路已退役。实机验证全过（截图 b-plan-final.png）。

**待做（按优先级，用户逐项定）**：

1. **子Agent卡精确进度**：当前降级版（卡片框架 + delegation 信息 + 运行态）。接子会话
   事件窗算 `SubagentProgress`（running/turn/step/currentAction/进度条）——数据模型已在
   `contract/subagent.ts`（SubagentProgress），渲染层 SubagentCard 已就位，差进度计算。
2. **审批卡真实 escalation 验证**：机制全就绪（fork ui-approval answerer + pendingInteractions
   + answer）。真实审批卡渲染需模型在沙箱拒绝后主动申请 escalation——手动跑一次会触发
   escalation 的任务（如让模型写一个会被沙箱拒的路径）验证审批卡渲染 + 拆分按钮应答 +
   「始终允许」（当前占位禁用，需写回 approval/policy）。
3. **弹层**（画稿已有）：统计 popup-status（点 Convo Header 统计 hbtn）/ 上下文用量
   popup-context-usage（gauge）/ ＋上下文 popup-context / 🛡权限 popup-permission /
   @Agent popup-agent——按画稿接 corum 样式（官方已有对应弹层机制，换肤+调整）。
4. **工具聚合卡默认态确认**：用户定的是「默认收起一行摘要（运行了 N 个工具 ▸）」——
   官方 TurnProcess 已是可展开卡且已玻璃化，但「默认收起摘要」的具体文案/默认态如需
   调整（当前官方默认折叠态已接近）。
5. **project 模式对话区**：复用 B 方案（fork 会话 UI 渲染项目泳道 corum-proj-*，泳道已在
   官方对象层，零适配）——team 段成员泳道会话接对话区。
6. **泳道 fork 语义设计**：当前禁用（决策 C）——泳道 fork 涉及 preset/归属，单独设计。
7. **侧栏工作区归属**：泳道 cwd 未 attach 官方 workspace（泳道行全在「未分组」）——
   host 把泳道 sessionId attach 到 workspace.sessionIds。
8. **历史快速定位 + lazy load**：首屏「用户消息条目 + 最近记录」，点历史条目动态 loadOlder
   （官方 loadOlder 已有，接交互）。
9. **ai 卡统计/耗时细化**：统一收尾行已有用量（tok/缓存命中率/耗时）；dur-time 精确到
   turn/step 耗时（官方 turn-metrics 投影已投影，可按需细化展示）。
10. **提炼经验菜单项 / 文件树选中→编辑器打开 / 底部面板终端 / 左列管理段**：原计划项，独立推进。

## 八、风险 / 注意（PROGRESS.md「## 4」+ 本轮新踩坑）

- **多 host 残留是红线**：重启前按 cdp.sh stop 清理（双实例共享事件日志会双重派发）。
- **RPC 失败绝不静默吞**（重命名教训）：catch 必须打 console + UI 反馈，否则用户把
  「失败」当「没生效」。
- **受控 input + 边沿初始化**：会话行重命名 draft 只在 `renaming` false→true 边沿
  初始化——effect 若依赖 `row` 对象，store 更新换引用会在用户输入中途重置 draft
  （「改不了名」根因）。同类「输入态」都按边沿初始化，不依赖内容引用。
- **IME composition**：中文输入 `keydown Enter` 前必须判 `e.nativeEvent.isComposing`，
  否则确认候选误提交半成品。
- **小尺寸按钮类必须显式 `padding:0`**（UA button 默认 padding 1px 6px 会挤压 20px
  按钮内的 16px 图标成 8px）。
- **子 Agent 会话（origin='subagent'）不进任务模式列表**（host 拒 rename，官方同规则）。
- **shell 脚本**：变量后禁跟全角字符（`$VAR（` 报 unbound），写 `${VAR}（`；macOS 无 setsid。
- **CDP「Cannot start http server for devtools」**= 端口被旧实例残留占用，`./scripts/cdp.sh stop`
  或 `lsof -ti:9222 | xargs kill -9`（只针对 9222，不影响微信）。
- **JSDoc/注释里写通配路径禁含 `*/` 序列**（`corum-proj-*/corum-dev-*` 的 `*/` 提前闭合
  JSDoc → 全文解析漂移报几十条语法错，行号全是误导）。用「corum-proj 系」或转义。
- **泳道已在官方对象层（2026-08-28 第七轮实证）**：corum `ctx.agents.create` 的会话进
  官方 ctx.sessions list（含 corum-task/proj/dev）。**验证「在不在对象层」读对象层 ids，
  别看侧栏渲染行数**（blank 过滤等渲染逻辑会误导）。冷泳道历史在持久化
  （ctx.sessionPersistence.readFrom），不在 agent.session.events 窗口（冷 resume 只含
  会话种子）。cordis Service 注入以**插件 index.ts 的 inject 数组**为准（service 类
  static inject 不生效）。
- **0.1.2 升级 + B 方案新踩坑（2026-08-29 第八轮，详见 PROGRESS 最近两条）**：
  - **RPC 通道**：`corumDesktop.unary` IPC 桥已退役（transport 换官方 loopback webserver）——
    corum 自有 RPC 全走 `ctx.get('connection').rpc.call('/api','<ns>/<method>',{args})`，
    **payload 必须 `{args:{...}}`**（gateway 硬契约）。共享包 @corum/corum-rpc-client 的
    `makeCorumRpcCall` 可复用。ConnectionHandle 从 `@deepseek-ai/dsh-client-connection/client`
    或 `@deepseek-ai/dsh-api-remotes/client` import，`ctx.get('connection') as ConnectionHandle`。
  - **cordis inject 按服务名解析**（fiber.inject 查 ctx.get(name)，非包名）——fork 包 inject
    保留官方服务名即可；kkc 壳已提供同形 ctx.layout（LayoutController implements ILayout）。
  - **fork 的 dsh.client.external 必须显式声明**；util 包（无 dsh.client）改内联不列 external。
  - **官方 store 类实例方法裸引用传 uSES 丢 this**（见 §五.8 换肤体系前的机制坑）。
  - **Review 卡撤销根**：revertWrites 必须接泳道 cwd 作根（不是 process.cwd()），且根与文件
    都 realpath（macOS /tmp→/private/tmp symlink 误判逃逸）。
  - **pnpm install 用全量 `CI=true pnpm install --no-frozen-lockfile`**（勿 --filter，会清空
    其它包链接）；新增 workspace 包（fork 包）后必须 install 才能被 cordis loader 解析
    （profiles/node_modules 的 heal 链接 boot 时重建）。

## 九、交接检查清单（新会话开工前自检）

- [ ] `git log --oneline -1` = `cd021f26`（或更新），分支 `feat/ide-s4-restore`
- [ ] `git status --short` 只剩排除项（design.pen / project 配置 / doc 设计源图）
- [ ] `./scripts/cdp.sh status` 显示实例存活 + CDP 可达（没有则 `./scripts/cdp.sh start`）
- [ ] `node ~/.agents/skills/corum-cdp-verify/scripts/cdp.mjs eval 'document.querySelectorAll("[class*=leaf]").length'` = 5
- [ ] 对话区是 **fork 官方会话 UI**（液态玻璃 + 泳道消息流 + 玻璃 composer），不是自研
- [ ] 已读 `PLAN-conversation-ui-redesign.md`（B 方案全貌）+ `DESIGN-conversation-information-architecture.md`（信息架构）+ PROGRESS.md 最近 2 条（0.1.2 升级 + B 方案落地）+ 本文件 §五.8 架构
