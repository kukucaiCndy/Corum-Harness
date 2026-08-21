# IDE 界面开发交接文档（S3 真实功能插件 + design.pen 严格还原）

> 交接对象：接手 IDE 界面开发的 Agent。
> 核心要求：**严格按 `doc/UXDesign/design.pen` 还原**——完整读稿、建还原清单、逐块对照截图验证，禁止凭想象发挥。
> 交接时间：2026-08-19。作者：上一阶段 Agent（本交接 = S3 骨架阶段后的状态快照；各区域已有结构但视觉/数据未达标，见 §3.3）。

> ## ⚠️ 最新变更（2026-08-21，覆盖本文相关旧描述）
>
> 1. **底部状态栏（⑦）已移除**：`corum.statusBar` 槽已删（ide-shell `index.tsx`/`AppFrame.tsx`/`ide-layout.ts`），`@corum/ide-statusbar` 与 `ide-test-statusbar` 已从 `cordis.ide.patch.yml` 摘掉（代码保留备查）；「添加区域/已关闭区域/重置布局」入口与连接/项目/模型展示一并移除。design.pen 中「⑦ 状态栏」节点（浅 ICUAO/深 wicT3）已删除。下文所有 ⑦/状态栏/ide-statusbar 相关内容仅作历史记录。
> 2. **新增顶部自定义标题栏**：Electron `titleBarStyle:'hiddenInset'`（`packages/shell/src/electron/main.ts`）；渲染层顶部 40px `.titleBar`（AppFrame.tsx），整行 `-webkit-app-region:drag`，左 padding 84px 给 macOS 红绿灯，右侧 `.titleBarActions`（no-drag）放设置齿轮。design.pen 两个 L1 主界面（浅 N1HbA/深 e9dE1）顶部已加「窗口标题栏」节点（traffic-light-inset 84 + titlebar-actions + icon-settings ref S87vwb 20×20 `$label-secondary`）。
> 3. **设置面板自建仓**：官方 `ui-settings-general` 已禁用；ide-shell 自建 SettingsShell（`ide-shell/src/client/SettingsShell.tsx`）接管 `sidebar.settings` 槽，声明 `settings.*` 子槽（trigger/header/close/action/section/onboarding/general.item）并补注册 chrome + general section + settings 字典；`createPortal` 到 `document.body`。触发器 = 顶部标题栏右上角齿轮。
> 4. **通用悬浮层 FloatingLayer**：shell-base 新增（`shell-base/src/client/FloatingLayer.tsx`），portal 到 body，注册式 `openFloating`/`closeFloating`（modal 遮罩 + Escape + 多实例堆叠），与 `shell.overlay`（帧内浮层）职责分明。
> 5. **浮动窗吸附改 Input HAL**：`packages/shell/src/electron/input-hal.ts`（`isPrimaryButtonDown()`；macOS koffi→CoreGraphics `CGEventSourceButtonState`，Windows `GetAsyncKeyState`，Linux 降级）；浮动窗中心进主窗区域时起 60ms 轮询，「按下→松开」且中心在主窗内才吸附；HAL 不可用永不吸附（保守）。替代旧的「停稳 350ms 吸附」。

---

## 0. 交接目标

当前 coding combo 进入 IDE 模式后，工作台大部分区域仍是 **S0 测试占位**（ide-test-* 插件 / 壳内测试卡片）。本阶段要：

1. **严格按 design.pen 还原 IDE 工作台**（液态玻璃 + 蒸汽波背景 + 深浅双主题 + 完整 L1 布局）
2. 用真实功能插件替换占位：会话列表 ✅（已做）、文件树 ✅（已做）、**底部面板、编辑器 tab+Monaco、对话区**（已做骨架，视觉未达标，见 §3.3）。（原含状态栏，已于 2026-08-21 移除，见文首变更说明）
3. 每个区域以设计稿为唯一视觉基准，深浅两版都要还原

---

## 1. 项目架构速览（接手者必读）

### 1.1 进程模型（combo = 启动器 + 独立应用）

```
cli.ts（净化环境：纯壳不携带 DSH_HOME/dsh 内容）
  └─▶ Electron main（纯壳 = combo 管理页 corumapp://combo/index.html）
        │  选 combo → 注入 env/cwd/覆盖规则 → spawn 独立 host 子进程
        └─▶ host 子进程（SYSTEM Node 跑 lib/bridge.js，boot.ts 按 combo 构建 composition）
              └─▶ 窗口切到 corumapp://app/index.html?combo=coding
```

- 纯壳不参与 dsh；IDE（coding）只是 combo 之一。详见 `docs/PLAN-combo.md`（v2）。

### 1.2 开发/运行/验证命令

```bash
# 构建（改包后必须 build）
pnpm --filter @corum/ide-shell run build      # 壳
pnpm --filter @corum/ide-sidebar run build    # 会话列表
pnpm --filter @corum/ide-explorer run build   # 文件树
pnpm --filter corum-shell run build           # host/壳层

# 启动（唯一启动脚本；--combo=coding 直接进 IDE 工作台）
CORUM_DEBUG_PORT=9240 bash scripts/dev.sh --combo=coding   # 注意换端口，避免残留占用

# 停实例（项目惯例，勿 pkill -f corumapp）
pkill -f "node lib/cli.js"; pkill -f "lib/bridge.js"; lsof -ti:<端口> | xargs kill -9

# smoke 握手验证
bash scripts/dev.sh --smoke
```

> 工作目录：`packages/shell`。dev home：`.corum-dev-home`（会话/设置持久）。

### 1.3 关键文件

| 路径 | 职责 |
|---|---|
| `packages/shell/cordis.ide.patch.yml` | IDE overlay：禁用官方 presentation 行 + insert corum 插件行 |
| `packages/shell/src/host/boot.ts` | composition 构建（mode overlay + combo 覆盖规则） |
| `packages/shell/src/host/connection.ts` | host 连接层（含 corum.fs.list 自定义 RPC） |
| `packages/shell/src/electron/main.ts` | 壳：combo 启动器 + spawn host + assets 目录解析 |
| `packages/shell/src/electron/protocol.ts` | `corumapp://`/`corump://` 协议（含 `/assets/` 图片路由、`/monaco/` worker 路由） |
| `packages/shell/src/client/index.ts` | corum-shell client：ctx.connection + 注册 corum.editor（EditorColumn） |
| `packages/shell/src/client/editor/` | MonacoEditor / EditorColumn（③编辑器区，因 Monaco 基础设施在 shell） |
| `packages/shell/assets/` | 静态图片（brand_logo_*.png / generated-*.png 背景图） |
| `packages/plugins/ui/ide-shell/` | IDE 壳：区域系统 + GridView + 槽位声明 + 液态玻璃主题 |
| `packages/plugins/ui/ide-sidebar/` | S3-1 会话列表（品牌图 + Lucide） |
| `packages/plugins/ui/ide-explorer/` | S3-2 文件树（VS Code 式交互） |
| `packages/plugins/ui/ide-conversation/` | S3-3 对话区（②，静态默认内容） |
| `packages/plugins/ui/ide-panel-bottom/` | S3-4 底部面板（⑥，tabs + 静态终端） |
| `packages/plugins/ui/ide-statusbar/` | ~~S3-5 状态栏（⑦，连接/项目/模型）~~ **已移除挂载**（2026-08-21，代码保留备查） |

---

## 2. 设计稿（唯一视觉基准）

### 2.1 文件与配套文档

| 文件 | 说明 |
|---|---|
| `doc/UXDesign/design.pen` | **正式设计稿**（Pencil 文件，深浅两套页面 + 组件库） |
| `doc/UXDesign/HANDOFF-design.md` | 设计稿交接说明（token 映射、布局、组件、图片、动效） |
| `doc/UXDesign/corum-harness-design-style.md` | 设计规范（完整 token 表） |
| `doc/UXDesign/corum-harness-motion-spec.md` | 动效规范（时长/缓动） |
| `doc/UXDesign/images/` | 图片资产（品牌图/背景图） |

### 2.2 如何读取 design.pen（Pencil MCP，强制）

MCP server：`mcp_Pencli_MCP`（工具 `execute`，filePath 指到 .pen，input 是 JS 片段）。

```js
// 顶层 frame 列表（已知：N1HbA=L1主界面浅色，+8 深色页）
Get((n, c) => c.depth === 0 ? [n.id, n.name] : undefined)
// 读某页面结构（depth 控制层级）
Print(JSON.stringify(Get('N1HbA', { depth: 3 })))
// 读组件（可复用 reusable）
Print(JSON.stringify(Get('r1lskG', { depth: 3 })))   // session-row
// 设计变量
Print(JSON.stringify(GetVariables()))
// 截图对照（肉眼核对）
// 用 mcp__pencil__get_screenshot 或 Page.captureScreenshot（Electron 实例 CDP）
```

> 完整 API 参考：`/Users/kukucai/skills/ai-skills/front/pencil-mcp/pencil-mcp-api/SKILL.md`。
> 规则：先读后写、每页对照截图、禁止 emoji、颜色用 token。

### 2.2.1 关键节点索引（已确认的 id，直接 Get 即可）

> ⚠️ 本表为 S3 旧索引。**S4 已大幅改版（项目导航/对话区/资源管理器/区域卡片）**，最新节点 id 见 §10「S4 设计稿定稿交接」。

| 节点 | id | 说明 |
|---|---|---|
| L1 主界面·浅 | `N1HbA` | 1600×1000，theme light |
| L1 空态·浅 | `qmncW` | |
| L2 项目导航·浅 | `M7Awm` | 项目导航全交互（正常/选择器展开/分组右键/空态骨架） |
| L3 会话视图·浅 | `l9tkkH` | 对话+轨迹状态 |
| L4 弹窗浮层·浅 | `RhgJf` | 5 个对话区浮层 + 既有弹窗 |
| 浮动窗·会话/代码 | `WUI1o` / `E6BRj` | |
| Design System·浅 | `KTdc9` / `UTpkg` | 组件库（含 Row5 新组件陈列） |
| ① 项目导航 | `C8YKJS` 浅 / `a3RJ4n` 深 | 280px |
| ② 对话区 | `CvGoK` 浅 / `GNcz1` 深 | flex |
| ③ 编辑器区 | `sswc6` 浅 / `KTXnd` 深 | 430px |
| ④ 资源管理器 | `PmMu1` 浅 / `N0uIY` 深 | 210px |
| ⑥ 终端 | `hvh`（浅 `xGd58` / 深 `mOtXy`） | 网格普通叶子，仅终端 tab |
| ~~⑦ 状态栏~~ | ~~`ICUAO` 浅 / `wicT3` 深~~ | **已从 design.pen 删除**（2026-08-21）；L1 顶部新增「窗口标题栏」节点（traffic-light-inset 84 + titlebar-actions + icon-settings ref S87vwb 20×20） |

组件（S4 新增）：`region-card(xQylw)` `region-actions(knD1D)` `subagent-card(bSZm5)` / 展开态 `O0J3e`；既有：`session-row(r1lskG)` `msg-agent(KFBiE)` `tool-call-row(b5eYVw)` `msg-awaiting(NrFh6)` `tab-file(s9GKh5)` `run-chip(SSf3S)` `brand-logo(NwUQL)` `btn-primary(me4rN)` `menu-item(nf8rX)` `menu-item-danger(ocG70)` + 图标组件（见 get_app_state）

### 2.3 设计变量（已从 design.pen 读取，浅/深双值）

| 变量 | 浅 | 深 | 用途 |
|---|---|---|---|
| `bg-base` | #E9E9F2 | #0D0817 | 窗口底色 |
| `bg-deep` | #DDDCE8 | #0A0612 | 最深层 |
| `glass-1` | #FFFFFFE6 | #1D112BD9 | 主卡片 |
| `glass-2` | #FFFFFFCC | #2A1840D9 | 抬升卡（选中/输入） |
| `glass-3` | #FFFFFFB3 | #372050CC | 更高抬升（hover） |
| `glass-border` | #FFFFFF | #B98CFF2E | 玻璃描边 |
| `glass-border-active` | #5B21F5 | #01CDFE | 激活描边 |
| `label-primary` | #0E0E1C | #F3ECFF | 正文/标题 |
| `label-secondary` | #5C5C77 | #B3A6D9 | 次要 |
| `label-tertiary` | #8B8BA3 | #7E719E | 辅助 |
| `label-dimmed` | #B9B9C9 | #55486F | 禁用 |
| `label-on-brand` | #FFFFFF | #0A0612 | 品牌色上文字 |
| `brand-primary` | #5B21F5 | #01CDFE | 主品牌色 |
| `brand-text` | #5B21F5 | #4DE3FF | 品牌文字 |
| `brand-accent` | #F5276C | #FF71CE | 点缀 |
| `state-error` | #E0245E | #FF5C8A | 错误 |
| `state-success` | #0BA57C | #3EE6B0 | 成功 |
| `state-warn` | #E07A00 | #FFB45C | 等待 |
| `state-idle` | #9AA0B5 | #6E6392 | 空闲 |
| `glow-1/2/3` | 见 pen | 见 pen | 环境光斑 |

**实现约束**：所有颜色用 CSS 变量（浅/深随 `body[data-ds-dark-theme]` 翻转），禁止硬编码 hex。
ide-shell 的 `theme.css` 已定义 `--corum-glass-*`、`--corum-brand-accent`、`--corum-state-*` 等；
官方 `--dsw-alias-label-*` 由 overrideTokens 映射。新插件样式只引用这两类变量。

### 2.4 L1 主界面布局（已读取，精确值）

```
Main Row（gap 14 · padding 16）
├─ ① 会话列表 280px：glass-1 · r18 · gap 8 · padding 14
│    brand-logo → 分隔线(1px) → 「会话」标题 + 新会话(品牌色按钮 r9 pad[4,8] 11/600)
│    → search(glass-2 r11 pad[7,11] 12px) → session-row 列表
├─ ② 对话区 flex：glass-1 各卡 r16/r14 · gap 10
│    Convo Header(r16 pad[11,16]：dot 8px + 标题14/600 + crumb 11 + 3×hbtn 30×30)
│    Session Stats(r14 pad[8,14]：run-chip + JetBrains Mono 10px 统计 7轮/时长/token/费用)
│    View Tabs（vt-对话 active：glass-2+active-border r11 pad[7,14] / vt-轨迹）
│    Chat Flow（user 卡 r16 pad12 + msg-agent + tool-call-row + awaiting）
│    Review Card(r14：N 文件已更改 12/600 + diff + reject/accept 按钮)
│    Chat Input(glass-2 r16 pad[12,8,12,16] 13px placeholder + Send)
├─ ③ 编辑器区 430px：Editor Tabs → crumb → Code(Monaco) → Editor Status
├─ ④ 资源管理器 210px：h + tree-node 列表（r9 pad[5,8] gap7）
⑥ 终端（网格普通叶子，默认对话区下方 150px）：tabs(pt-终端 active r10 pad[6,12] + ×关闭)
   + term（JetBrains Mono 11px 终端输出）
（⑦ 状态栏 34px 已从 design.pen 删除，2026-08-21；L1 顶部另新增 40px「窗口标题栏」：左侧 84px 红绿灯让位 + 右侧 titlebar-actions 设置齿轮 20×20 $label-secondary）
```

### 2.5 可复用组件（设计稿组件库，已确认 id）

`btn-primary(me4rN)` `btn-secondary` `btn-danger` `input-field` `session-row(r1lskG)` `msg-agent(KFBiE)` `tool-call-row(b5eYVw)` `tab-file(s9GKh5)` `menu-item` `menu-item-danger` `tree-node(vGAtx)` `msg-awaiting(NrFh6)` `brand-logo(NwUQL)` `run-chip(SSf3S)` + 图标组件（icon-files/message/terminal/check/layers/settings/plus/search/folder/folderopen/filecode/chevright/chevdown/xclose/branch/archive/save/trash/pencil/sun/moon/monitor）

### 2.6 图片资产（doc/UXDesign/images/）

- `brand_logo_light_crop.png` / `brand_logo_dark_crop.png`：品牌区横幅（左上，4.74:1）→ 按主题切换
- `big_brand_light/dark.png`：空态 hero
- `generated-1786893762526.png`（深）/ `generated-1786893760104.png`（浅）：**环境光斑背景图**（ambient 最底层，object-fit cover + 60% bg-base 蒙版）
- 这些图在 shell 客户端怎么加载：需把图片资产引入 client bundle（见踩坑 9）

---

## 3. 当前实现状态

### 3.1 已完成

| 插件 | 状态 | 说明 |
|---|---|---|
| `@corum/ide-shell`（壳） | ✅ | 区域系统 + GridView + 槽位声明 + 玻璃主题（theme.css/overrideTokens） |
| `@corum/ide-sidebar`（会话列表） | ✅ 可用 | ①会话列表 280px；数据源 `ctx.sessions`；品牌区已接入 `brand_logo_*.png` 图片（浅/深随主题切换），Lucide 图标（Plus/Search） |
| `@corum/ide-explorer`（文件树） | ✅ 可用 | ④资源管理器 210px；数据源 host fs RPC；懒加载展开 + VS Code 式树交互（chevron + folder/file 图标 + 缩进 + 选中/hover 态） |
| `@corum/ide-conversation`（对话区） | ✅ 骨架可用 | ②对话区 flex；Convo Header/Stats/Tabs/Chat Flow/Review/Input 全结构；**内容为设计稿静态默认值**，消息流/统计未接真实数据（见 §3.3） |
| `@corum/ide-panel-bottom`（终端） | ✅ 可用 | ⑥终端（网格普通叶子，默认对话区下方 150px，可调宽/调高/自由组合）；仅「终端」tab + 终端静态输出 + ×关闭（corum:close-region） |
| ~~`@corum/ide-statusbar`（状态栏）~~ | **已移除挂载** | 2026-08-21 状态栏整体移除（见文首变更说明），代码保留备查 |
| 编辑器区 | ✅ 骨架可用 | ③编辑器 430px 由 corum-shell client 的 `EditorColumn` 注册（Editor Tabs + crumb + Monaco + Editor Status）；**demo 文件静态内容**（见 §3.3） |
| host fs RPC | ✅ | `corum.fs.list`：根=host cwd，realpath 防逃逸，过滤 .git/node_modules/点文件 |
| 图片资产服务 | ✅ | `corumapp://app/assets/*.png` 静态服务（dev: `packages/shell/assets/`；packaged: `Resources/assets`），brand logo + 蒸汽波背景图已复制 |
| 环境光斑背景 | ✅ | body 蒸汽波背景图（浅/深各一）+ 60% bg-base 蒙版 + 3 光斑渐变（theme.css） |

### 3.2 差距清单（对照 design.pen，未还原项）

1. **对话区（②）内容为静态默认值**：Convo Header 标题/Stats 数字/Chat Flow 消息/Review diff/Input 均为 design.pen 静态文本，**未接真实会话消息流**（`ctx.sessions` 只读了 current 标题，消息/统计/待审批无数据源）
2. **编辑器（③）内容为 demo 文件**：Editor Tabs 两个静态 tab（requirements.md/columns.ts）、Monaco 只渲染设计稿 demo 行，**未接文件树选中文件**（explorer → editor 联动未做）；Monaco 主题硬编码 `vs-dark`，**未随深浅主题联动**
3. **底部面板（⑥）终端为静态输出**：tabs 可切换但内容固定（终端 3 行 / 待办 / 队列占位），**未接 dsh-terminal / session.queue / jobs**
4. **资源管理器（④）**：无上下文菜单（右键新建/删除/重命名），无文件图标按类型区分（当前全用 FileCode）；VS Code 交互（键盘导航/多选/拖拽）未做
5. ~~**状态栏（⑦）**~~：**已移除**（2026-08-21）；连接/项目/模型展示后续若需要将以其他形式呈现
6. **深浅双主题视觉**：token 值已随 `body[data-ds-dark-theme]` 正确翻转（CDP 验证过），但 **Monaco 主题、各区域截图对照**未完成
7. **组件库还原**：msg-agent/tool-call-row/tab-file/run-chip 等以 CSS 内联实现，未抽成可复用组件（后续可优化）
8. **GridView 布局**：默认四列 weights=[280,800,430,210] 与 design.pen 一致；但 localStorage 有旧布局残留（`corum.ide.grid.v1`），新窗口可能载入旧布局，需 `resetGridStorage()` 或清 localStorage 才能看到默认四列
9. **对话区空态**：无会话时的空态视图（L1 空态页 `qmncW`）未实现
10. **浮动窗**：`corum.floating` / 拖出独立窗口可用壳级，但对话区/编辑器内部"拖出"按钮未真正调用

### 3.3 本阶段验收结论（2026-08-19）

- 五个区域（①会话列表/②对话区/③编辑器/④资源管理器/⑦状态栏）均已替换占位并挂载，CDP walkthrough（`scripts/walkthrough-s3.mjs`）断言全 PASS（含 brand 图加载、ambient 背景、浅/深 token）。（注：⑦状态栏已于 2026-08-21 移除。）
- **但与 design.pen 视觉对照相差甚大**：各区域是"结构正确、内容静态、数据未接"，且**未逐块截图与设计稿逐像素对照**。接手者应以 §2.2.1 节点索引重读 design.pen，按 §4 优先级逐块还原 + 截图验证。

### 3.4 待办占位（S0，已替换/清理）

- `ide-test-conversation`（②对话区）→ 已由 `@corum/ide-conversation` 替换
- `ide-test-panel`（⑥底部面板）→ 已由 `@corum/ide-panel-bottom` 替换
- `ide-test-statusbar`（⑦状态栏）→ 已由 `@corum/ide-statusbar` 替换；2026-08-21 两者均随状态栏移除摘掉挂载（代码保留备查）
- ide-shell 壳内：`corum.editor` 测试卡片 → 已由 corum-shell `EditorColumn` 替换；`details` 测试卡片保留（官方 DetailsPanel 未接管）
- `ide-test-sidebar` 已在 overlay 移除但仍留在 shell package.json dependencies（可清理）

---

## 4. 剩余任务（按优先级）

| # | 任务 | 设计依据 | 数据源 |
|---|---|---|---|
| S4-1 | 对话区（②）接真实消息流：Stats 数字/消息列表/待审批/Review 都来自会话数据，替换静态文本 | L3 会话视图 `l9tkkH` + 组件 msg-agent/tool-call-row/msg-awaiting | ctx.sessions binding / conversation 消息流 |
| S4-2 | 编辑器（③）联动文件树：explorer 选中文件 → Editor Tabs 增 tab + Monaco 换内容；Monaco 主题随深浅翻转 | ③ 430px + L2 tab面板 `Dv8st` | explorer 选中态 + host fs read |
| S4-3 | 底部面板（⑥）接 dsh-terminal 真实输出 + 待办/队列 tab 数据 | ⑥ 150px | dsh-terminal / session.queue / jobs |
| S4-4 | 资源管理器（④）补 VS Code 交互：右键菜单(新建/重命名/删除)、文件类型图标、键盘导航 | ④ 210px + menu-item 组件 | corum.fs RPC 扩展 |
| ~~S4-5~~ | ~~状态栏（⑦）接真实模型名/项目名~~ **已取消**（状态栏 2026-08-21 移除） | — | — |
| S4-6 | 逐块截图对照：每区域深浅两版 CDP 截图 vs design.pen，修正视觉偏差 | §2.2.1 全部节点 | Page.captureScreenshot |
| 收尾 | 对话区空态（`qmncW`）+ 组件抽成可复用 + localStorage 旧布局清理 | §2.6 + §2.5 | 图片资产 |

**执行纪律**（上阶段教训）：
1. 每个区域**先完整读设计稿**（结构 + 组件 + 变量 + 截图），再动手
2. 每块完成后**截图对照设计稿**，深浅两版都核对
3. 只还原，不发明；拿不准就回读 design.pen

---

## 5. 插件开发模式（新增一个 client 插件）

以 `@corum/ide-sidebar` 为模板（结构完全一致）：

```
packages/plugins/ui/ide-xxx/
├── package.json          # name @corum/ide-xxx; dsh.client.platform=web; deps: ide-shell(slots 类型), client-runtime, client-ui-slots, react
├── tsconfig.json         # 复用 ide-sidebar 同款
├── tsdown.config.ts      # 复用（CLIENT_EXTERNALS 同款）
├── scripts/inline-css.mjs
├── src/index.ts          # host no-op
├── src/client/index.ts   # apply(): ctx.slots.inject('corum.xxx', () => ctx.slots.register({name, inject}, Component))
├── src/client/Component.tsx / .module.css
└── src/css-modules.d.ts
```

接线三步：
1. `packages/shell/package.json` 加 `"@corum/ide-xxx": "workspace:*"`
2. `packages/shell/cordis.ide.patch.yml` insert 一行（`- id: ide-xxx / name: '@corum/ide-xxx'`），并删掉对应占位
3. `pnpm install` + build 该包 + build corum-shell + 启动验证

槽位清单（ide-shell 声明）：`corum.sidebar` / `corum.editor` / `corum.explorer` / `corum.tabStrip` / `corum.panel` / `corum.floating`（`corum.statusBar` 已于 2026-08-21 删除）+ 继承官方 `conversation` / `details` / `shell.overlay` / `sidebar.settings`。`sidebar.settings` 由壳内 SettingsShell 接管并声明 `settings.*` 子槽（见文首变更说明 3）。

---

## 6. 数据源清单

| 数据 | 获取方式 |
|---|---|
| 会话列表 | `ctx.sessions.list`（useSyncExternalStore 订阅）+ `open/startSession/search/rename` |
| 工作区 | `ctx.workspaces`（startSession 等） |
| 文件树 | `corum.fs.list`（host RPC，`connection.rpc.call('corum.fs', 'list', { path })`） |
| 模型/连接 | `ctx.connection.hostDescription`（host.describe 值）+ 连接状态（原状态栏展示已移除，此数据供后续其他呈现位置使用） |
| 终端 | host 端 terminal 服务（dsh-terminal，待接） |
| 待办/队列 | `session.queue` / `jobs`（mux 流帧） |

> 官方数据层：`ctx.sessions`/`ctx.workspaces`（dsh-client-runtime 对象层，消费 corum 的 connection）。组件里用 `useSyncExternalStore(store.subscribe, store.getSnapshot)` 读快照，动作通过 slot inject 传入（参考 ide-sidebar 的实现）。

---

## 7. 验证方法

1. **构建**：改的包逐个 `pnpm --filter @corum/ide-xxx run typecheck && run build`，再 `pnpm --filter corum-shell run build`
2. **启动**：`CORUM_DEBUG_PORT=9240 bash scripts/dev.sh --combo=coding`
3. **CDP 走查**：`node scripts/walkthrough-s3.mjs --port 9240`（区域挂载断言 + 浅/深截图，输出到 `build/walkthrough-s3/`）
4. **截图对照**：`Page.captureScreenshot` 存 png，肉眼对照 design.pen 对应页面（深浅各一）

---

## 8. 踩坑记录

1. **残留进程**：多轮启动会残留 Electron/bridge 进程、占 CDP 端口（`bind() failed`）。停实例：`pkill -f "node lib/cli.js"; pkill -f "lib/bridge.js"; lsof -ti:<port> | xargs kill -9`。
2. **`--combo=coding` 参数**：Electron 的 `process.argv` 可能把 `--combo=coding` 作为单元素，`comboArg()` 已兼容两种写法（`--combo=x` 与 `--combo x`）。
3. **smoke 时序**：`settleSmoke` 必须先挂载再 `loadURL`（渲染端 JS 在 did-finish-load 前执行握手，否则握手被吞）。
4. **`resolve(root, '/')` 逃逸**：绝对路径会覆盖 root。fs RPC 已修正（剥前导斜杠，'/'→'.'）。
5. **类型坑**：官方类型 `SessionId`/`ConnectionHandle` 从 `@deepseek-ai/dsh-api-remotes/client` 导入；`ctx.connection` 类型上不存在，用 `ctx.get('connection') as ConnectionHandle`；组件读会话用 `SessionSummary.displayTitle`。
6. **CSS 只用 token**：浅/深双值变量（`--corum-*` / `--dsw-alias-label-*`），禁止硬编码 hex（设计规范红线）。
7. **图标**：设计稿图标是 Lucide（icon-folder 等语义名 → lucide 真实名），用 lucide 图标库，禁止 emoji（设计稿组件里出现的 ▸▾›⌕ 是占位符，正式实现用 Lucide/字体图标）。
8. **overlay 纪律**：cordis.ide.patch.yml 只 disable 官方行 + insert corum 行，不改官方包。
9. **图片进 bundle（已解决）**：brand_logo/背景图是独立 PNG，走 **corumapp:// 静态服务**方案：图片复制到 `packages/shell/assets/`，protocol.ts 的 `corumapp` handler 增加 `/assets/` 图片路由（`registerProtocols` 新增 `assetsDir` 参数），main.ts 的 `shellAssetsPath()` 解析 dev=包目录/assets、packaged=Resources/assets。CSS/TSX 用 `corumapp://app/assets/<name>.png` 引用。
10. **⚠️ assets 路由劫持 dist（本阶段白屏根因）**：dist 前端资源也在 `/assets/` 前缀下（`index-*.js/css`）。若 assets 路由匹配整个 `/assets/*` 会 404 掉所有前端 JS → **整页白屏**。修复：assets 分支必须只匹配图片扩展名（`IMAGE_EXTENSIONS` set），非图片回落 distRoot。
11. **⚠️ dev assets 目录解析**：dev 下 electron main 产物在 `packages/shell/lib/main.js`（不是 `lib/electron/`），`shellAssetsPath()` 用 `join(dirname(import.meta.url), '..', 'assets')` 才正确指到 `packages/shell/assets`（写两层 `..` 会跑到 packages 根，404）。
12. **CDP 主题断言**：旧的 `window.__corumTestSetTheme` 全局挂在 `ide-test-panel` 占位上，占位删除后不再可用。深浅主题断言直接操作 `body[data-ds-dark-theme]` 属性（它是 token 翻转的实际驱动，与 ThemePresenter 写的一致）。
13. **GridView 布局残留**：布局持久化在 `localStorage['corum.ide.grid.v1']`，旧会话/旧布局会覆盖默认四列。验证布局前先 `localStorage.removeItem('corum.ide.grid.v1')` 或调 `resetGridStorage()`。
14. **placeholder 不在 innerText**：CDP 断言输入框占位文本要用 `querySelectorAll('input').map(i => i.placeholder)`，`document.body.innerText` 不含 placeholder。
15. **Monaco 主题硬编码**：`EditorColumn` 目前固定 `vs-dark`，深浅主题切换时 Monaco 不变（`MonacoEditor` 的 theme prop 未接全局主题），需在 S4-2 联动。
16. **corum-shell client 注册 corum.editor**：编辑器区因 Monaco worker/protocol 基础设施在 corum-shell bundle 内，直接在 corum-shell client 用 `ctx.inject(['slots'], ...)` 注册 EditorColumn 到 `corum.editor`（新插件再 bundle 一份 Monaco 会巨大且重复）。

---

## 9. 上阶段遗留（与本任务相关）

- `ide-test-sidebar` 已从 overlay 移除但仍留在 shell package.json dependencies（可清理）
- HANDOFF.md / PLAN-combo.md / PLAN-ide-roadmap.md 已更新到 2026-08-19 状态；本次 IDE 界面进展需在完成后同步
- `.sidebar-shot.png` / `.explorer-shot.png`（packages/shell/ 下）是上阶段验证截图，可参考后删除
- `scripts/walkthrough-s3.mjs` 是本阶段验证脚本，保留复用
- `build/walkthrough-s3/s3-light.png` / `s3-dark.png` 是本阶段最终截图（当前视觉状态，对照设计稿参考）
- **打包配置缺 assets**：`packages/shell/package.json` 的 `build.extraResources` 未加 `assets`（dev 正常，packaged 图片会 404）。需加 `{ "from": "assets", "to": "assets" }`
- **遗留的 lucide 依赖**：`lucide-react@^0.460.0` 已加到 ide-sidebar/ide-explorer/ide-conversation/ide-panel-bottom/corum-shell 的 package.json；确认 pnpm 已装（本阶段 install 过）

---

## 10. S4 设计稿定稿交接（2026-08-19 末）

> 本阶段**先定设计稿、后改代码**。设计稿已定稿（深 `e9dE1` / 浅 `N1HbA` 为主基准），代码侧只完成了 RegionCard 基座与部分区域，其余区域待按定稿实现。

### 10.1 代码侧已完成

| 项 | 状态 | 说明 |
|---|---|---|
| **RegionCard 基座** | ✅ | [ide-shell/.../RegionCard.tsx](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/ide-shell/src/client/RegionCard.tsx)：统一区域玻璃卡片。拖出=区域内非交互处长按左键拖出窗口（交互元素/选中文字/Monaco 自动让位）；关闭=右上角按钮。GridView 的 LeafView 已改用它（卡片外观/操作全委托基座，LeafView 只留 grid 拖放高亮） |
| **会话列表视觉还原** | ✅ | [ide-sidebar](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/ide-sidebar/src/client/SessionSidebar.tsx)：工作区分组头/行色分级/状态点语义/搜索激活描边/brand 190×40/分隔线/行 gap6。修复了 `[data-wide]` 误隐藏内容的 bug（改 `:not([data-wide])` + 子选择器） |
| **区域标题栏移除** | ✅ | GridView 删除 leafTitle（区域名/拖拽拆分交互），四列回归纯净卡片 |

### 10.2 设计稿已定稿（待代码实现）

> 详细交互规格见 [SPEC-conversation-header.md](file:///Users/kukucai/work/kkc-desktop/docs/SPEC-conversation-header.md)；产品交互见 [interaction-design.md](file:///Users/kukucai/work/kkc-desktop/docs/interaction-design.md)；设计读取见 [HANDOFF-design.md](file:///Users/kukucai/work/kkc-desktop/doc/UXDesign/HANDOFF-design.md)。

1. **项目导航**（左列 280px）：品牌 → 新建/打开项目 → 「项目」标题+项目选择器 → 管理段（计划/任务/事件/文档/问题）→ **团队段（团队+会话合并）**：成员行即组头（chevron+状态点+名+角色+计数），成员下挂会话；段组头含添加 Agent + 搜索框
2. **对话区**：Convo Header（对话/轨迹 tab 并入头部 + git-branch/chart-column/× 三钮；删了 dot/title/crumb/save/monitor）+ Chat Flow（含 subagent-card 子 Agent 进度卡）+ Review Card + Chat Input 双行（多行输入区 + 工具条 ＋/🛡/@Agent/上下文统计/模型/语音/发送）
3. **资源管理器**：VS Code 风格树（根标题栏 5 个 20×20 工具钮 + 类型着色图标 + 缩进 + 选中态）
4. **终端**：网格普通叶子（与其他区域同构，默认对话区下方 150px，可调宽/调高/自由组合），仅终端 tab + ×，移除待办/队列
5. **弹出浮层**：上下文菜单 / 授权审批 / Agent 选择 / status（统计）/ 上下文用量（5 个）
6. **区域卡片**：region-card + region-actions（仅 × 关闭；拖出走长按）。有头区域（对话区/资源管理器）关闭并入工具组同规格，无头区域（项目导航/编辑器）右上角悬浮

### 10.3 待开发（按定稿，优先级从高到低）

| # | 任务 | 插件 | 设计依据 |
|---|---|---|---|
| 1 | ide-explorer 重构为 VS Code 树（类型图标/缩进/选中/工具栏/懒加载） | `@corum/ide-explorer` | L1 资源管理器 `N0uIY`/`PmMu1` |
| 2 | ide-conversation 全套：Convo Header 重构 + status 浮层 + Chat Input 双行 + 5 弹窗 + subagent-card | `@corum/ide-conversation` | SPEC-conversation-header.md |
| 3 | ide-sidebar 重构为项目导航（选择器/新建打开/管理段/团队段合并） | `@corum/ide-sidebar` | L1 项目导航 `a3RJ4n`/`C8YKJS` + L2 交互态 |
| 4 | 清理各区域根部重复玻璃卡片样式（EditorColumn inline 等），统一 RegionCard 基座 | corum-shell 等 | §10.1 RegionCard |
| 5 | 接创造模式 Agent 数据源：团队成员/会话归属/管理段从静态示例改真实数据 | — | 待 Agent 数据源定义 |
| 6 | 各区域接真实数据（会话消息流/编辑器联动文件树/终端输出/模型名）——见 §4 剩余任务 | 各插件 | §6 数据源清单 |

### 10.4 关键节点 id 速查（S4 定稿）

- 项目导航：浅 `C8YKJS` / 深 `a3RJ4n`；团队段 `btOIK`/`u0Vd9t`（组头 `FFahL`/`f5VuY`）
- 对话区：浅 `CvGoK` / 深 `GNcz1`；Convo Header `nkAAA`/`eKfU9`；Chat Input `q3HcU`/`EzxpK`（工具条 `r8hKej`/`ZIqUW`）
- 资源管理器：浅 `PmMu1` / 深 `N0uIY`（tree-header `N3NoP`/`ZUgfV`，tree-body `EaWC3`/`pmEpL`）
- 终端：`hvh`（L1 内浅 `xGd58` / 深 `mOtXy`；网格普通叶子，与其他区域同构）
- 组件：region-card `xQylw` / region-actions `knD1D` / subagent-card `bSZm5`（展开 `O0J3e`）
- 弹窗（L4 浅 `Kt6JF` / 深 colC `R3tjUy`）：popup-context / popup-permission / popup-agent / popup-status / popup-context-usage

### 10.5 本阶段踩坑（新增）

17. **设计稿 absolute 无右锚**：Pencil absolute 子项只有左上 x/y，卡片宽度变化时右上角按钮不会跟随。设计稿里 region-actions 的 x 是按当前卡宽算死的数值；实现侧用 CSS `right:8px` 正确吸附。对话区是 fill 宽，x 用 Main Row 计算像素（606）。
18. **lucide 图标名有效性**：设计稿 `icon` 属性必须是合法 lucide 名。踩过的无效名修正：`check-square→square-check-big`、`kanban-square→layout-list`、`bar-chart-3→chart-column`。
19. **execute 作用域独立**：Pencil MCP `execute` 每次调用是独立作用域，定义的 helper/变量不跨调用保留；且一次失败会回滚该次全部修改（可能连带丢同批建的节点）。每个 insert 批次宜小、即时 Print 验证。
20. **嵌套 sidebar 误伤**：自定义组件用后代选择器（`.sidebar[data-wide] .x`）会命中 slot 内嵌套的同名官方结构，导致内容被 `display:none`。折叠态用 `:not([data-wide])` + 子选择器 `>` 限定直接子元素。
