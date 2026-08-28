# UI 开发任务交接提示词（context 受限恢复用）

> 用途：当上一会话因上下文资源紧张中断时，新会话读本文件即可无缝接续 corum IDE 的
> UI 开发任务。本文件是「活文档」——每次推进后更新「当前状态 / 下一步」。
> 配合 `docs/ide-formal/PROGRESS.md`（进度日志）一起读。
> 最近更新：2026-08-28 · 基线提交：`c8e106d0` · 分支：`feat/ide-s4-restore`

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
- 工作区保持干净的三个排除项绝不提交：doc/UXDesign/design.pen（无关改动）、
  project.config.json / project.private.config.json（本地配置，未跟踪）。

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
- **分支**：`feat/ide-s4-restore` · **最新提交**：`c8e106d0`（scripts/cdp.sh）
- **工作区**：干净（仅三个排除项未跟踪，勿提交）。
- **布局**：root row `[sidebar(300), conversation(509), right-col]`；right-col =
  `column [row(editor, explorer), panel]`。侧栏 pinned（固定），其余四区域自由组合。

## 四、工具链（关键，全部已验证可用）

### 1. 实例启停 `./scripts/cdp.sh`（2026-08-28 新建，提交 c8e106d0）
```bash
./scripts/cdp.sh start     # 清理旧实例 + 后台启动（秒回，不等 CDP）
./scripts/cdp.sh status    # 探测存活 + CDP 可达；Electron 就绪后自动补记 PID
./scripts/cdp.sh stop      # 精确清理本实例（PID + 子进程树），不动微信
./scripts/cdp.sh restart   # = start
```
三条红线（踩过的坑，见 SKILL.md 常见坑表）：
- start **必须秒回**：脚本被 Agent 工具带超时调用，内部等 CDP/PID 会被外层 SIGTERM
  连坐杀 Electron（GPU exit_code=15）。故 start 只 spawn + 立即 exit，PID 由 status 补记。
- spawn **必须切断 fd 血缘**：后台 Electron 继承脚本 stdout/stderr fd 会让脚本 hang。
  用独立子 shell + `nohup ... >log 2>&1 </dev/null & disown` 三重 fd 全断。
- 清理 **必须精确**：只按「PID 文件 + is_self 校验 cmdline 含本仓库 packages/desktop
  绝对路径」。微信路径绝不含此子串，物理上不可能被误杀。

### 2. CDP 驱动 `~/.agents/skills/corum-cdp-verify/scripts/cdp.mjs`
```bash
node <skill>/scripts/cdp.mjs eval '<js>'        # 页面内执行 JS
node <skill>/scripts/cdp.mjs evalfile /tmp/x.js # 从文件执行（推荐，免转义）
node <skill>/scripts/cdp.mjs shot <名>          # 截图到 /tmp/corum-cdp/shots/
```
浏览器级窗口控制（setWindowBounds/Emulation）用 `Target.attachToBrowserTarget` +
sessionId 模式自写 .cjs（参考会话中 /tmp 脚本模式）。`Browser.getWindowForTarget` 不可用。

### 3. 构建（避开 pnpm run 的 verify-deps，直调 .bin）
```bash
CI=true pnpm --filter @corum/corum-ui-base run build     # ui-base（grid/GridView）
CI=true pnpm --filter @corum/corum-ide-ui run build      # ide-ui（壳 AppFrame 等）
CI=true pnpm --filter corum-desktop run build            # desktop（electron main+client）
CI=true pnpm --filter <pkg> exec tsc -b --force          # 单包类型检查
```
**关键**：`corum-ide-ui/lib/client.js` **内联打包** ui-base 的 grid/GridView 逻辑——
改 ui-base 后必须**单独重建 corum-ide-ui** 才生效（只重建 ui-base/desktop 不够）。

### 4. Pencil MCP（设计稿读取，唯一 MCP）
- 工具：`mcp__pen__execute`（Get/Print/TakeScreenshot）、`mcp__pen__get_app_state`、
  `mcp__pen__read_skill`、`mcp__pen__browser`、`mcp__pen__get_style`。
- 读设计稿：`execute({filePath:'doc/UXDesign/design.pen', input:'Print(JSON.stringify(Get("节点ID",{depth:N})))'})`。
  ref 组件需 `{resolveInstances:true}` 展开；变量用 `GetVariables()`。
- **脑补禁令**：设计稿是唯一事实来源，任何数值/颜色/文本/图标都必须能在设计稿找到
  来源；`Get` 返回含 `"..."` 截断必须加深 depth 重读（详见 .trae/skills/pencil-to-corum-ide）。
- 当前选中：`bn8E9`(row-主界面) → L1 深色 `ZhjRX`（1600×1000）。

## 五、已完成的关键工作（最近 8 提交，详见 PROGRESS.md）

| 提交 | 内容 |
|---|---|
| `d8b2724e` | minTotal≥span 兜底改按 min 比例分配（修导航栏突变宽+锁死） |
| `581134c3` | 槽位 pinned 机制 + 侧栏钉住、其余四区域自由组合（修拖 convo 边 nav 跟着变） |
| `151f2499` | sash 拖拽传导推动（邻格到 min 后沿方向推仍有余量区域） |
| `b9baf85a` | 区域最小尺寸兜底高 160→200 + 窗口最小尺寸初版 |
| `a88b6113` | **标题栏行只覆盖左列**，right-col 顶到窗口顶（GridView 新增 leafTopOffset 机制） |
| `19b713aa` | 标题栏间距 30→16 + **修复窗口无法拖拽**（app-region 非继承覆盖） |
| `fac26b98` | **主窗口边距改 0** + 标题栏间距改 0 + 标题栏图标对齐设计稿（Pencil MCP 走查） |
| `89b41387` | col-nav minWidth 283→300 + 重算窗口最小尺寸 **1219×427** |
| `c8e106d0` | scripts/cdp.sh 安全启停 |

### 关键架构认知（改动前必懂）
- **GridView**（`corum-ui-base/grid.ts` + `GridView.tsx`）：像素绝对定位二维分割树。
  leaf=槽位窗格，branch=row/column split（weights=像素份额）。持久化 localStorage
  `corum.ide.grid.v3`。
  - `registerSlot(key, {label, defaultWeight, minWidth, minHeight, pinned})`。
  - `subtreeMinSize()`：同轴求和、正交取最大；sash 拖拽 `resizeBranch`（含传导推动）、
    窗口自适应 `rescaleGrid`、渲染夹取 `computeCellSizes` 三处统一消费。
  - `minTotal>=span` 时按各格 min 比例分配（不是等比平分）。
  - `leafTopOffset?: number[]`（AppFrame 传 `[40,40,0]`）：root row 各格内层 `.branchInner`
    内容格顶部下移（sidebar/convo 让位标题栏，right-col 0 顶到窗口顶）；列格仍占满全高。
- **AppFrame**（`corum-ide-ui/AppFrame.tsx`）：`.frame`(padding:0) → mainRow(GridView 顶到
  窗口顶) + titlebarRow(absolute 浮层只压左列，width=convoBox.x+width，`-webkit-app-region:none`
  + `pointer-events:none`，两段 `.titlebarDrag`=窗口标题栏+Agent 标题栏座位 drag，按钮 no-drag)。
- **窗口最小尺寸**（`electron/main.ts`）：minWidth 1219 / minHeight 427（主进程自检日志
  `[corum-shell] window min size effective` 权威确认）。
- **Electron `-webkit-app-region`**：**非继承属性、初始 none、子元素覆盖父级**。drag 区
  若子元素占满容器必须 `.titlebarDrag * { drag }`，按钮显式 no-drag，否则拖不动变选文字。

## 六、当前布局精确值（交接基线，全屏 1728×1004）

- 主窗口边距 = 0（卡片贴四边）；titlebar-row 与 col-nav 间距 = 0。
- 侧栏 300（minWidth 300，pinned）/ 对话区 509（minWidth 509）/ 编辑器 700 / 资源管理器 205 /
  终端 minHeight 227。各区域 minWidth/minHeight 即当前值，可拉宽拉高不可更窄更低。
- 标题栏行：窗口标题栏（红绿灯让位 84 + 图标：panel-left-close/columns2/terminal/moon/
  settings/blocks 全 lucide 16）宽=sidebarRight + Agent 标题栏（覆盖对话区正上方）。
- 窗口最小尺寸 1219×427。

## 七、下一步候选（PROGRESS.md「## 2.5」建议清单 + 缺口）

> 当前布局/壳层已对齐设计稿。剩余主要是「接真实数据」（对话区/编辑器/终端仍是假数据）。

1. **对话区输入框接真实发送**（当前 Enter 只清空）——接 `ctx.sessions` 发送 RPC，形成
   第一条真实消息流。ConversationArea.tsx 假数据（消息流/统计/子 Agent 卡/工具调用/审批卡）。
2. **文件树选中 → 编辑器打开**（替换 EditorColumn 假数据 DEMO_FILE）——第一条
   「文件树→编辑器」真实联动。文件树已是真数据（corum.fs.list RPC）。
3. **底部面板终端接真实终端**（TERM_LINES 假数据；设计⑥ 规划终端/待办/队列 tabs）。
4. **左列「管理段」接 corumProjectData**（计划/任务/事件/文档/问题计数；任务/缺陷已真，
   计划/测试/文档/时间事件 pending）。
5. **终端高度复核**：你实机值 227 vs 设计稿 130（基准内可接受，若要更贴设计可降）。
6. **对话区 Convo Header**：已被 Agent 标题栏取代（已删），轨迹视图/分支/统计按钮仍占位。

## 八、风险 / 注意（PROGRESS.md「## 4」+ 新踩坑）

- **多 host 残留是红线**：重启前按 cdp.sh stop 清理（双实例共享事件日志会双重派发）。
- **HMR 壳层改动需整页重启**：AppFrame/GridView 等根结构改动 HMR 不可靠（root 槽竞态
  `renderSlot('root') before registration`），改后重启应用验证；renderer 业务组件 HMR 可热更。
- **LanePool 泳道占用投影是进程内存态**，重启不 fold 恢复。
- **shell 脚本**：变量后禁跟全角字符（`$VAR（` 会报 unbound），写 `${VAR}（`；macOS 无 setsid。
- **CDP「Cannot start http server for devtools」**= 端口被旧实例残留占用，`./scripts/cdp.sh stop`
  或 `lsof -ti:9222 | xargs kill -9`（注意此命令只针对 9222 端口，不影响微信）。

## 九、交接检查清单（新会话开工前自检）

- [ ] `git log --oneline -1` = `c8e106d0`（或更新），分支 `feat/ide-s4-restore`
- [ ] `git status --short` 除三排除项外干净
- [ ] `./scripts/cdp.sh status` 显示实例存活 + CDP 可达（没有则 `./scripts/cdp.sh start`）
- [ ] `node ~/.agents/skills/corum-cdp-verify/scripts/cdp.mjs eval 'document.querySelectorAll("[class*=leaf]").length'` = 5
- [ ] 已读 PROGRESS.md 最近 3 条 + 本文件 §五架构认知
