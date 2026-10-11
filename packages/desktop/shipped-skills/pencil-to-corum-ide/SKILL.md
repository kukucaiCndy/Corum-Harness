---
name: "pencil-to-corum-ide"
description: "严格依据 design.pen 设计稿完成 corum IDE 界面的交互与视觉开发（React client 插件 + CSS module + 设计 token）。Invoke when implementing or restyling IDE workspace regions (会话列表/对话区/编辑器/文件树/底部面板/状态栏) from the Pencil design file. 设计稿是唯一事实来源。"
---

# Pencil → corum IDE 界面 标准工作流

> 适用：corum-desktop 仓库（`/Users/kukucai/work/kkc-desktop`）IDE 界面开发。
> 产物：React client 插件（TSX + CSS Module），注册进 ide-shell 槽位。
> 本技能从 `pencil-to-miniprogram` 借鉴六步纪律，但目标栈完全不同：**Electron 桌面（px 原值，无 rpx 换算）、CSS 变量 token（非 hex 硬编码）、Lucide 图标（非导出 PNG）、slot 注入（非小程序页面）**。

---

## ⛔ 脑补禁令（最高优先级）

> **设计稿是唯一事实来源。任何代码中的数值、颜色、文本、布局都必须能在设计稿数据中找到对应来源。如数据缺失或不完整，必须重新查询设计稿，禁止凭经验/习惯/审美补全。**

违反禁令的典型行为：
- 间距未读取到 → 自行估算一个值 ❌
- 图标颜色数据不完整 → 用默认色 ❌
- 看到 `"..."` 截断标记 → 忽略继续写代码 ❌
- 文本内容被截断 → 从截图猜测文字 ❌

**正确做法**：数据不完整 → 提高 `depth` 重新 `Get` → 仍不完整 → 提高 `searchDepth` → 确认获取完整数据后才写代码。

---

## 前置条件

- Pencil MCP（`mcp_Pencli_MCP`）已能访问 `doc/UXDesign/design.pen`
- 已知目标区域的 frame 节点 ID（**主界面/设置中心页面与组件的节点索引见 `doc/UXDesign/DESIGN.md` §4.2 与 §8**，直接 Get 即可）
- 已通读 `doc/UXDesign/DESIGN.md`（token/布局/组件/图片/动效总说明）

## 核心工具

| 工具 | 调用方式 | 输出 | 用途 |
|------|---------|------|------|
| `get_app_state` | `run_mcp(server_name='mcp_Pencli_MCP', tool_name='get_app_state', args={include_schema:true, ...})` | 顶层节点 + 组件 + schema | **首选**：确认文件加载、拿节点/组件 id |
| `execute` | `run_mcp(..., tool_name='execute', args={filePath:'doc/UXDesign/design.pen', input:'Print(JSON.stringify(Get("NODE_ID",{depth:N})))'})` | 节点属性树（Print 输出） | **核心**：读尺寸/颜色/文本/层级。`GetVariables()` 读设计变量 |
| Electron CDP | 起实例后 `Runtime.evaluate` / `Page.captureScreenshot` | DOM / 截图 | **验证**：实现截图对照 |

> 本项目 MCP 只有 4 个工具（browser/execute/get_app_state/get_guidelines），无独立 batch_get/get_screenshot。读取靠 `execute` 里的 `Get(...)`；设计稿截图若 MCP 不可得，用 Pencil 桌面端肉眼对照 + 实现侧 CDP 截图对比。

---

## 流程总览

> **⛔ 6 步必须按顺序执行，每步有明确的「进入条件」和「完成标志」。不得跳步、不得合并步骤、不得在数据未完整时进入下一步。**

```
① 读取设计稿数据
   进入条件：MCP 已访问 design.pen ✓
   完成标志：目标区域全部节点无 "..." 截断 ✓ + 完整性验证通过 ✓
       ↓
② 提取关键信息
   进入条件：① 完成标志全部满足
   完成标志：提取表完整 ✓（文本/尺寸/颜色/字体/间距/效果/图标 7 类全有值）+ 用户确认 ✓
       ↓
③ 编写 React 结构
   进入条件：② 完成标志全部满足
   完成标志：每个设计稿区域都有对应 TSX 结构 ✓
       ↓
④ 编写样式
   进入条件：③ 完成标志全部满足
   完成标志：每个样式值都映射到设计 token / 提取表 ✓（零硬编码 hex）
       ↓
⑤ 对接数据与交互
   进入条件：④ 完成标志全部满足
   完成标志：slot 注册 + 数据源 + 事件处理完成 ✓
       ↓
⑥ 走查验证
   进入条件：⑤ 完成标志全部满足
   完成标志：3 遍走查全部通过 ✓ + CDP 截图对照 ✓
```

---

## ① 读取设计稿数据（不可缩减）

### 1.0 锁定目标设计稿（先于一切读取）

> **同名区域常存在多版设计稿（旧版 / v2 / v3…）。动手前必须先锁定「以哪一版为准」，禁止拿第一搜到的版本就当事实来源。**

- 列出该区域的**全部候选 frame**（含版本后缀），有版本号以**最高版本**为准、无版本号以**用户指定**为准。
- 一个页面常拆成多个 frame（列表页 / 详情页 / 弹窗），**逐块确认各自的目标 frame**，不要用列表稿套详情、或用旧稿套新稿。
- 锁定后在提取表标题写明「区域 + FrameID + 版本」，后续所有数值只认这一版。

### 1.0.1 设计稿回流（用户会反复微调）

> **设计稿不是只读的。用户走查后常回头微调设计稿（改尺寸/删元素/加字段），要求「重新适配」。**

收到「我微调了设计稿，重新适配」类指令时：
1. **重新 `Get` 同一 FrameID**（不要沿用上次缓存的属性树），逐属性 diff 出**变化点**（尺寸/增删节点/文案/间距）。
2. 只针对**变化点**改代码，未变的部分不动。
3. 把变化点并入提取表（标注「v2 微调」），再走 ③→⑥。

### 1.1 调用清单

```text
1. get_app_state({ include_schema: true, include_canvas_design: false, include_scripts_and_shaders: false })
   → 确认文件加载 + 目标区域/组件 id

2. execute({ filePath, input: 'Print(JSON.stringify(Get("目标FrameID", { depth: 6 })))' })
   → 目标区域完整节点树。depth 强制 ≥ 6，穿透所有区域层；节点多时分批读子节点
   → 多个区域可一次读：Print(JSON.stringify([Get("A",{depth:2}), Get("B",{depth:2})]))

3. execute({ filePath, input: 'Print(JSON.stringify(GetVariables()))' })
   → 设计变量（颜色/布尔，浅/深双值）

4. 组件细节（目标区域用到可复用组件时）：execute({ filePath, input: 'Print(JSON.stringify(Get("组件ID", { depth: 3 })))' })
   → 组件库 id 见 get_app_state 返回的 reusable components 列表
```

### 1.2 截断检测（强制，调用返回后立即执行）

> `Get` 返回的属性里出现 `"..."` → depth 不够深，内部属性被截断。**必须立即重新查询，不得带着截断数据进入 ②。**

**检测点**：`children`、`fontSize`、`padding`、`gap`、`fill` 等任何值为 `"..."`。

**处理**：`depth` × 2 重新 Get → 再检测 → 仍有截断继续加深（不设上限）→ 无截断才进入 1.3。

### 1.3 完整性验证（截断检测通过后执行）

| 验证项 | 检查方法 | 不通过处理 |
|--------|---------|-----------|
| 所有 text 节点 `content` 可读 | 逐 text 检查无截断 | 提高 depth 重查 |
| 所有 frame 节点 `width`/`height` 为数值 | 逐 frame 检查 | 提高 depth 重查 |
| 所有颜色可解析（是 hex 或已知变量名） | 逐 fill/stroke 检查 | 对照 GetVariables 补映射 |
| 所有 icon 节点 `icon`+`library` 可读 | 逐 icon 检查 | 提高 depth 重查 |
| 所有 gap/padding/cornerRadius 为数值 | 逐节点检查 | 提高 depth 重查 |

> **⛔ 完整性不通过 → 回 1.2 重查。全部通过才能进 ②。**

---

## ② 提取关键信息（防止遗漏，禁止脑补）

### 2.0 先输出提取表，后写代码（顺序铁律）

> 在写 TSX 之前，必须先输出 7 张提取表。表中任何「—」空值 = 未提取完成，不得进入 ③。
> **⛔ 强制确认机制**：提取表输出后**必须暂停等待用户确认**（"请核对数值是否与设计稿一致，确认后回复「确认」"）。不得同轮输出提取表 + 代码。

### 2.1 必须提取的七类信息

| 类别 | 提取内容 | 用途 | 缺失处理 |
|------|---------|------|---------|
| **文本** | 所有 text 节点的 `content` | TSX 无遗漏 | 提高 depth 重查 |
| **尺寸** | `width`/`height`/`x`/`y` | 布局/间距（桌面 px 原值，**无换算**） | 提高 depth 重查 |
| **颜色** | `fill`/`stroke` | 映射设计变量 | 对照 GetVariables |
| **字体** | `fontFamily`/`fontSize`/`fontWeight` | CSS 字体 | 提高 depth 重查 |
| **间距** | `padding`/`gap`/`layout` | flex 布局参数 | 提高 depth 重查 |
| **效果** | `cornerRadius`/`effect` | 圆角/阴影 | 提高 depth 重查 |
| **图标** | `icon`/`library`/`fill` | Lucide 映射 | 提高 depth 重查 |

### 2.1.1 三类最易漏提取的信息（强制逐项确认）

> 这三类不在「显眼的容器/标题」里，走查时极易整片漏掉，必须在提取表里**单独成行**确认：

1. **控件的 label 小字**：每个输入框 / 下拉 / 开关上方或左侧的 `fontSize:10` `$label-tertiary` 标签（如「供应商」「模型」「预设 ID」）。**逐控件核对小字是否存在、文案、字号**——漏了就是「少了一排小字」。
2. **可变文本行（行数/有无随数据变化）**：描述行、副标题、徽标、经验/统计行等**可能为空或换行**的 text。必须标注「该行是否恒渲染」「最长几行」，供 ③④ 决定是否固定行高 / 恒渲染占位（否则网格/卡片会因内容有无而高度抖动）。
3. **网格/列表的空位与空态**：一排 N 个的网格，**不足 N 个时补什么**（占位框？留白？）；空列表显示什么。提取「占位节点的尺寸/描边/文案」。

### 2.2 提取表输出格式（模板）

每行标注数据来源（节点路径 + Get depth）。

```
=== 区域：[区域名] (FrameID: xxx) ===

## 文本提取表
| 节点路径 | 文本内容 | 用途 |
|---------|---------|------|
| Header/title | "矩道布局设计" | 对话区标题 |

## 尺寸提取表
| 节点路径 | W(px) | H(px) | X(px) | Y(px) | 数据来源 |
|---------|-------|-------|-------|-------|---------|
| Convo Header | fill | 30 | 11 | 16 | Get depth:6 |

## 颜色提取表（映射到设计变量）
| 节点路径 | 属性 | 设计变量 | 浅值 | 深值 |
|---------|------|---------|------|------|
| Convo Header | fill | $glass-1 | #FFFFFFE6 | #1D112BD9 |

## 字体提取表
| 节点路径 | fontFamily | fontSize(px) | fontWeight |
|---------|-----------|-------------|------------|
| Header/title | Inter | 14 | 600 |

## 间距提取表
| 父节点路径 | 属性 | 值(px) |
|-----------|------|--------|
| Convo Header | gap | 10 |

## 效果提取表
| 节点路径 | cornerRadius(px) | shadow |
|---------|-----------------|--------|
| Convo Header | 16 | — |

## 图标提取表
| 节点路径 | library | icon | 处理方案 |
|---------|---------|------|---------|
| hbtn1 | lucide | git-branch | lucide-react `GitBranch` |
```

### 2.3 本项目特有换算/映射规则（与小程序技能的关键差异）

| 项 | 小程序技能 | **本项目** |
|----|-----------|-----------|
| 单位 | px → rpx（×2） | **px 原值**（Electron 桌面，设计稿 px = CSS px） |
| 颜色 | 硬编码 hex/rgba | **映射设计变量 → CSS 变量**（`--corum-*` / `--dsw-alias-*`），禁止硬编码 hex |
| 图标 | lucide → 导出 PNG | **lucide-react 组件**（design.pen 语义名 → lucide 真实名，映射表见 HANDOFF-design.md §2.3） |
| 图片 | `<image>` 标签 | 按交接文档踩坑 9 的方案（图片进 client bundle） |
| 深浅双主题 | 两套值 | CSS 变量随 `body[data-ds-dark-theme]` 自动翻转，**实现一份、双主题生效** |

**设计变量 → CSS 变量映射**（浅/深双值已在 ide-shell theme.css / overrideTokens 落地）：

```
$bg-base / $bg-deep → 背景（壳已处理）
$glass-1/2/3        → --corum-glass-1/2/3
$glass-border       → --corum-glass-border
$glass-border-active → --corum-glass-border-active
$brand-primary      → --corum-state-running（或 --corum-brand-primary 兜底）
$brand-accent       → --corum-brand-accent
$label-on-brand     → --corum-label-on-brand
$label-primary/secondary/tertiary → --dsw-alias-label-primary/secondary/tertiary
$label-dimmed       → --dsw-alias-label-dimmed
$state-success/warn/error/idle    → --dsw-alias-* 或 --corum-state-*
```

> 规则：**CSS 里出现的每个色值必须是变量**（`var(--corum-*)` / `var(--dsw-alias-*)`）。出现字面 hex 即违规。

### 2.4 布局策略决策树（高频出错点）

```
设计稿父节点 layout 属性？
├── "vertical" / "horizontal"
│   → display:flex; flex-direction:column/row; gap:Npx
│   → 子元素间距由父 gap 控制，子不得自行加 margin（防叠加）
│
└── "none"（绝对定位，子节点带 x/y）
    ├── 整个区域都是 absolute
    │   → 父 position:relative；子逐个 position:absolute; top:y; left:x
    │   → ⛔ 禁止给父加 display:flex / align-items:center
    │   → ⛔ 禁止用 margin 模拟间距
    └── 仅装饰元素 absolute
        → 主体流式，装饰 absolute + pointer-events:none
```

---

## ③ 编写 React 结构

### 核心原则

1. **组件 = 一个 client 插件区域**：`apply(ctx)` → `ctx.slots.inject('corum.xxx', () => ctx.slots.register({ name, inject }, Component))`
2. **结构分层对应设计稿 children 顺序**：TSX 嵌套顺序必须与 Get 返回的 children 数组一致（装饰元素放最后）
3. **装饰元素**：`position:absolute` + `pointer-events:none`
4. **图片背景容器**：`position:relative; overflow:hidden` + 内层 `.bg-image`（absolute 铺满）+ `.content`（relative）
5. **可滚动区域**：滚动容器不直接设 padding，padding 放内层；用 `flex:1; min-height:0` 在 flex 布局内做滚动区（桌面端 flex 可靠，区别于小程序的绝对定位方案）
6. **类型纪律**：官方类型（`SessionId`/`ConnectionHandle`/`ISessions` 等）从 `@deepseek-ai/dsh-api-remotes/client` / `dsh-client-runtime/client` 导入；`ctx.get('connection') as ConnectionHandle`

插件骨架（模板：`packages/plugins/ui/ide-sidebar`）：
```
packages/plugins/ui/ide-xxx/
├── package.json          # dsh.client.platform=web；deps: ide-shell, client-runtime, client-ui-slots, react
├── tsconfig.json / tsdown.config.ts / scripts/inline-css.mjs / css-modules.d.ts（复用 ide-sidebar 同款）
├── src/index.ts          # host no-op
├── src/client/index.ts   # apply + slot 注册 + inject
└── src/client/Component.tsx / .module.css
```

---

## ④ 编写样式（CSS Module）

### 全局规则

```css
* { box-sizing: border-box; }   /* 有 border/padding 必须 border-box */
```

### 逐属性映射表

| 设计稿属性 | → CSS | 规则 |
|:----------|:------|:-----|
| `width/height` px | → px | **原值，无换算** |
| `font-size` px | → px | 原值 |
| `border-radius` px | → px | 原值（`cornerRadius`） |
| `padding/gap` px | → px | 原值 |
| `fill` | → `background` | 映射设计变量 → `var(--corum-*)` |
| `stroke` | → `border` | 映射设计变量 |
| 字体 | → `font-family` | Inter / JetBrains Mono（theme.css 已全局定义，组件可不写） |

### 字体栈

| 设计稿 | CSS |
|--------|-----|
| Inter | 全局默认（theme.css 已设） |
| JetBrains Mono | `data-corume-mono` 或 `font-family:'JetBrains Mono', monospace`（统计/终端/代码用） |

### 父 gap + 子 margin 防叠加（高频遗漏）

父容器有 `gap` → 子元素**不得**再设 margin-top/bottom，否则间距翻倍。走查时逐区检查。

### 网格/卡片行等高（高频遗漏）

一排 N 个卡片/项（flex 行或 grid）**必须整行等高**，否则内容长短不一会出现「第一排和第二排高矮不一」。通用做法：

- 行容器 `display:flex` 时，子项默认 `align-items:stretch` 即等高；**不要给子项写死 `height` 或内容驱动的 `min-height`**（写死值会和真实内容卡错位）。
- 卡片内**可变文本行**（可能为空/换行的描述、统计行）：要么 `min-height` 固定为设计行高（如 2 行 clamp 配 `min-height: 2×line-height×font-size`），要么**恒渲染占位**（无数据也渲染空行占位），二选一，消除内容有无导致的高度抖动。
- 占位/补位框用 `align-self:stretch` 与同行内容卡拉齐，**不写死高度**。
- 一行内 `justify-content` 要与设计稿一致（space-between / flex-start 混用会让同排卡片视觉错位）。

---

## ⑤ 对接数据与交互

### 本项目数据源

| 数据 | 获取方式 | 参考插件 |
|------|---------|---------|
| 会话列表 | `ctx.sessions.list`（useSyncExternalStore 订阅）+ `open/startSession/search/rename` | ide-sidebar |
| 工作区 | `ctx.workspaces` | ide-sidebar |
| 文件树 | `connection.rpc.call('corum.fs', 'list', { path })` | ide-explorer |
| 模型/连接 | `ctx.connection.hostDescription`（host.describe 值） | — |
| 终端/待办/队列 | host 服务 / `session.queue`、`jobs`（mux 帧） | — |

### 必须处理的三个问题

1. **默认数据**：设计稿有静态内容但 API 可能为空 → 组件提供空态/默认值
2. **事件绑定**：所有可点击元素（按钮/行/tab/树节点）绑 onClick；状态（展开/选中/搜索）用 useState 管理
3. **数据流**：只读数据用 `useSyncExternalStore(store.subscribe, store.getSnapshot)`；写操作经 slot inject 传入（`ctx.sessions.open` 等），组件不直接碰 ctx

### 设计稿需要但数据模型缺字段（扩展数据源）

> 设计稿某行/某标签要显示的文本（描述、副标题、版本说明），在当前数据模型里**没有对应字段**时的通用处理：

1. **先查现有数据源是否已返回该字段**——很多 RPC/接口返回的对象里已含 `description` 等字段，只是组件没取用。**优先复用，不改后端**。
2. 现有没有 → 评估能否**复用相邻接口**一次性拉取（如列表接口顺手带描述），在组件内建 `name → 描述` 的 map 供渲染。
3. 必须新增/扩展 RPC 时：**先与用户确认字段口径**，再改，且保留**缺省回退文案**（拉取失败/为空时显示兜底，不阻断界面）。
4. 把「该行文本 ← 哪个字段 ← 哪个接口」记进提取表，避免下次又当成脑补。

---

## ⑥ 走查验证（不可跳过）

> **⛔ 走查的每一项必须引用设计稿数据源。对照不是"看看像不像"，而是"逐行核对每个值是否与提取表一致"。**

### 三遍走查法

**第 1 遍：TSX vs 提取表 — 结构一致性**
| # | 检查项 | 数据源 |
|---|--------|--------|
| 1.1 | 每个文本提取表的「文本内容」在 TSX 有对应 | 文本提取表 |
| 1.2 | 容器嵌套与 children 顺序一致（装饰元素在最后） | Get 节点树 |
| 1.3 | 每个 icon 提取表节点已映射 lucide-react 组件 | 图标提取表 |
| 1.4 | 图片容器用 relative+overflow:hidden+.bg-image 结构 | 图片资产清单 |

**第 2 遍：CSS vs 提取表 — 数值一致性**
| # | 检查项 | 数据源 |
|---|--------|--------|
| 2.1 | 每个色值都是变量（`var(--corum-*)`/`var(--dsw-alias-*)`），**零字面 hex** | 颜色提取表 |
| 2.2 | width/height/font-size/border-radius/padding/gap 与提取表一致（px 原值） | 尺寸/字体/间距/效果表 |
| 2.3 | 父有 gap 时子无 margin（防叠加） | 间距提取表 |
| 2.4 | 深色主题同样正确（变量双值，浅/深各对照一次） | GetVariables 深值 |

**第 3 遍：CDP 截图对照 — 视觉效果一致性**
| # | 检查项 |
|---|--------|
| 3.1 | 启动验证实例 `./scripts/corum-instance.sh start --home=verify`（CDP `:9333`；**不要**驱动用户主实例 `:9222`），再 `Page.captureScreenshot` 存 PNG |
| 3.2 | 对照设计稿对应区域：背景/卡片/文字层级/图标/间距 |
| 3.3 | 深浅双主题各截一张 |

### 高频缺陷自查清单

| # | 缺陷 | 检查方法 |
|---|------|---------|
| 1 | 代码中出现字面 hex 色值 | 搜 CSS 中 `#` 开头值，必须全为 `var(...)` |
| 2 | 间距估算非提取表值 | 对照间距/尺寸提取表 |
| 3 | 父 gap + 子 margin 叠加 | 逐区检查 |
| 4 | 图标用 emoji/占位符（▸▾›⌕）替代 Lucide | 每个 icon 节点确认 lucide-react |
| 5 | depth 过浅漏读属性 | 确认无 `"..."` 截断 |
| 6 | 布局策略选错（absolute 区域误用 flex） | 对照 §2.4 决策树 |
| 7 | 深色主题未核对 | 深色模式截图 |
| 8 | **代码值在提取表找不到来源** | 逐个代码值回查提取表 |
| 9 | **截断数据未重查直接脑补** | 检查 1.2 截断检测日志 |
| 10 | slot 注册错误 / 占位未替换 | 验证 `document.querySelectorAll` 无测试占位 |
| 11 | **拿错设计稿版本**（同区多版，用了旧稿） | 提取表标题已标注 FrameID + 版本（§1.0） |
| 12 | **控件 label 小字整片漏实现**（下拉/输入框上方 10px 标签缺失） | 逐控件核对 §2.1.1-1 |
| 13 | **网格/卡片行不等高**（内容长短致第一排≠第二排） | §④ 网格等高规则；CDP 量两行高度 |
| 14 | **可变文本行高度抖动**（无数据行塌陷/换行撑高） | §2.1.1-2；确认固定行高或恒渲染占位 |
| 15 | **网格空位未补占位框**（一排 N 个缺项时塌位） | §2.1.1-3；单卡/缺项截图核对 |
| 16 | **设计稿被微调后沿用旧缓存属性** | §1.0.1；变化点是否重新 Get |

---

## 常见坑点速查

| 坑点 | 现象 | 解决方案 |
|------|------|---------|
| `--corum-brand-primary` 不存在 | 按钮背景变量无效 | 用已定义的 `--corum-state-running`，或用 `var(--corum-brand-primary, var(--corum-state-running))` 兜底 |
| 浅色验证过深色没验证 | 深色下文字/边框不可读 | 每块深浅双截图 |
| 图标用文本占位符 | 与设计稿不符 | 用 lucide-react（设计稿语义名 → lucide 真实名映射见 HANDOFF-design.md） |
| 背景图/品牌图未接入 | 无蒸汽波背景 | 按交接文档 §2.6 + 踩坑 9 设计图片加载方案 |
| 官方类型导入失败 | tsc 报 module 不存在 | 加依赖（`@deepseek-ai/dsh-api-remotes`），类型从 `/client` 导入 |
| 多轮构建残留实例 | CDP 端口占用 | `pkill -f "node lib/cli.js"; pkill -f "lib/bridge.js"; lsof -ti:<port> \| xargs kill -9` |

---

## 文件存放规范

```
packages/plugins/ui/ide-xxx/          # 一个区域一个插件包
├── package.json / tsconfig.json / tsdown.config.ts / scripts/inline-css.mjs
├── src/index.ts                      # host no-op
├── src/client/index.ts               # apply + slot 注册 + inject
├── src/client/Component.tsx          # 区域组件（对应一个 design.pen 区域）
├── src/client/Component.module.css   # 样式（只引用设计变量）
└── src/css-modules.d.ts
```

接线（每新增/替换一个区域）：
1. `packages/shell/package.json` 加 `"@corum/ide-xxx": "workspace:*"`
2. `packages/shell/cordis.ide.patch.yml` insert 一行（`- id: ide-xxx / name: '@corum/ide-xxx'`），删对应占位
3. `pnpm install` → 构建该包 + `pnpm --filter corum-shell run build` → 启动验证

---

## 复刻案例复盘（上阶段教训，必须遵守）

> 上阶段先做了会话列表/文件树再回读设计稿，发现「和设计稿完全不是一个东西」——因为**没有先完整读稿、建提取表、用户确认、截图对照**。本技能六步纪律就是为杜绝此事：

1. **先读后写**：任何区域动代码前，①读稿 ②提取表 必须完成且用户确认
2. **每块截图对照**：实现后必须 CDP 截图，对照设计稿对应区域，深浅双主题
3. **只还原不发明**：拿不准就回读 design.pen，禁止凭经验/审美补全
4. **一个区域一个提取表**：不跨区域合并，避免遗漏

> **设计稿数据是唯一事实来源。任何代码中的值都必须在提取表中有对应行。提取表有空值 → 重新查询设计稿 → 不得脑补。看到 `"..."` 截断 → 提高 depth → 不得猜测。这是像素级还原的基础，不可妥协。**
