# UI 开发任务交接提示词（context 受限恢复用）

> 用途：当上一会话因上下文资源紧张中断时，新会话读本文件即可无缝接续 corum IDE 的
> UI 开发任务。本文件是「活文档」——每次推进后更新「当前状态 / 下一步」。
> 配合 `docs/ide-formal/PROGRESS.md`（进度日志）一起读。
> 最近更新：2026-08-28（第四轮）· 基线提交：`9d2326b2` · 分支：`feat/ide-s4-restore`
> 工作区：**已干净**（本轮改动已按功能拆 11 个提交 + 标题栏修复 1 + 布局铺满修复 1，见 §六）。

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

- **运行中**：IDE/coding 实例，CDP :9222 可达，leafs=5 渲染正常。
- **分支**：`feat/ide-s4-restore` · **最新提交**：`9d2326b2`（隐藏区域后兄弟格铺满）
- **工作区**：**已干净**——本轮 UI 整改已按功能拆 11 个提交（f5ff4029~1b6ef51b）
  + 标题栏修复（8ae5f0b5）+ 布局铺满修复（9d2326b2）；排除项（design.pen /
  project 配置 / 设计源图）照例未跟踪。
- **布局**：root row `[sidebar(300), conversation(509), right-col]`；right-col =
  `column [row(editor, explorer), panel]`。侧栏 pinned（固定），其余四区域自由组合。
  **新增**：侧栏可折叠为 56px 图标轨（collapsedWidth，见 §五.7）。

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
- **截图能看了**：本会话已配置图像输入，`read_image` 可直接读截图做 UI 走查。
- **CSS `:hover` 是浏览器原生状态**，合成 mouseenter 不触发——hover 交互验证靠
  规则注入检查 + 用户目检。
- **用户提到 chrome-devtools-mcp**（github.com/ChromeDevTools/chrome-devtools-mcp）
  作为替代——当前会话工具列表里没有它的工具，若用户后续配上可改用。

### 3. 构建（避开 pnpm run 的 verify-deps，直调 .bin）
```bash
CI=true pnpm --filter @corum/corum-ui-base run build     # ui-base（grid/GridView）
CI=true pnpm --filter @corum/corum-ide-ui run build      # ide-ui（壳 AppFrame 等）
CI=true pnpm --filter corum-desktop run build            # desktop（electron main+client）
CI=true pnpm --filter <pkg> run typecheck                # 单包类型检查
```
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
  - **过滤**：`isTaskSession(row)` = id 非 corum-proj/corum-dev- 前缀 **且
    `origin !== 'subagent'`**（子 Agent 路由会话不进列表，host 拒其 rename）。
  - **会话行**：单击打开、双击/右键「重命名」行内改名、右键菜单（重命名/归档
    archiveSession/分叉会话 fork/提炼经验占位禁用）、标题溢出 hover 跑马灯。
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

## 六、本轮改动（已按功能拆 11 提交 + 1 修复，工作区已干净）

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

**拆 commit 方法**（同文件多 hunk 交错时补丁手术不可靠）：备份全部改动 → 临时分支
逐组「恢复 HEAD → 拷回本组文件（必要时裁剪）→ commit」→ feat `reset --hard` 到栈顶。
校验：栈顶所有 tracked 文件与备份逐字节一致。详见 PROGRESS.md 本轮末条。

**排除项（未跟踪，不提交）**：`doc/UXDesign/design.pen`（设计稿事实来源，含用户多轮
改版+我代改的 Agent 标题栏 509/项目模式④字号/brand-row v7）、`project.config.json` /
`project.private.config.json`、`doc/UXDesign/images/`（设计源图——注意 `brand_card.png`
被代码引用已拷入 `packages/desktop/assets/` 并已提交，images 里的源图是否提交用户定）。

## 七、下一步候选（PROGRESS.md「## 2.5」+ 本轮遗留）

1. **对话区输入框接真实发送**（当前 Enter 只清空）——接 `ctx.sessions` 发送 RPC，
   形成第一条真实消息流。ConversationArea.tsx 假数据（消息流/统计/子 Agent 卡/工具调用/审批卡）。
2. **文件树选中 → 编辑器打开**（替换 EditorColumn 假数据 DEMO_FILE）——第一条
   「文件树→编辑器」真实联动。文件树已是真数据（corum.fs.list RPC）。
3. **底部面板终端接真实终端**（TERM_LINES 假数据；设计⑥ 规划终端/待办/队列 tabs）。
4. **左列「管理段」接 corumProjectData**（计划/任务/事件/文档/问题计数；任务/缺陷已真，
   计划/测试/文档/时间事件 pending）。
5. **提炼经验菜单项**：当前占位禁用——语义待用户定义后点亮（选项曾给：发指令给会话
   Agent / 后台 fork 提炼 / 保持占位）。
6. **「添加工作区」按钮实机验证**（原生目录选择器 → create；CDP 环境难触发原生 picker，
   需用户手测）。

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

## 九、交接检查清单（新会话开工前自检）

- [ ] `git log --oneline -1` = `9d2326b2`（或更新），分支 `feat/ide-s4-restore`
- [ ] `git status --short` 只剩排除项（design.pen / project 配置 / doc 设计源图）
- [ ] `./scripts/cdp.sh status` 显示实例存活 + CDP 可达（没有则 `./scripts/cdp.sh start`）
- [ ] `node ~/.agents/skills/corum-cdp-verify/scripts/cdp.mjs eval 'document.querySelectorAll("[class*=leaf]").length'` = 5
- [ ] 已读 PROGRESS.md 最近 3 条 + 本文件 §五架构认知
