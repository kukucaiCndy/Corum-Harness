---
name: "pencil-mcp-api"
description: "Pencil MCP API reference（本机实测校准版）— 实际工具 execute/get_app_state/get_guidelines/browser、execute JS 函数集（Get/Print/Insert/Update/...）、设计模式、图标规范、颜色变量、常见陷阱。Referenced by pencil-design skill."
---

# Pencil MCP API Reference

> 本 Skill 为 `pencil-design` 的技术参考子模块，包含 MCP 工具列表、API 详解、设计模式、图标规范、颜色变量、常见陷阱等。**不需要直接调用**，由 `pencil-design` 按需引用。

> **✅ 实测校准（2026-08-21）**：本文全部关键论断已逐条在本机 Pencil MCP（Pen.app，server 暴露 `browser/execute/get_app_state/get_guidelines`）上验证修正。与旧版/网传文档的差异（工具名、`$` 变量、transparent 行为、脚本路径）均已按实测改正。可放心作为事实依据。

---

## 一、MCP 工具列表（本机实际暴露，已验证）

> ⚠️ 经实测（2026-08-21）：本机 Pencil MCP server 只暴露 **4 个工具**。网上/旧版文档里的 `mcp__pencil__batch_design` / `batch_get` / `get_screenshot` / `snapshot_layout` / `get_variables` / `export_nodes` 等**均不存在**，调用会报 "MCP server is not found"。功能等价物见下方映射。

| 实际工具名 | 用途 |
|------------|------|
| `get_app_state` | 获取画布编辑状态、用户选择、.pen schema（含 include_schema/canvas_design/scripts_and_shaders 三个 flag） |
| `get_guidelines` | 加载设计指南 (guide) 和样式规范 (style) |
| `execute` | **核心工具**：执行 JS 片段读/改文档（读用 `Get()`，写用 `Insert/Update/...`） |
| `browser` | 操作内置真实浏览器：参考/复刻网页为可编辑图层、截图、读 DOM |

**旧文档工具名 → 本机等价物**：

| 旧/网传名 | 本机等价 |
|-----------|----------|
| `batch_design`（写操作） | `execute`（JS 片段里调 `Insert/Copy/Update/Replace/Move/Delete/Generate/FindEmptySpace`） |
| `batch_get`（读节点） | `execute`（JS 片段里调 `Get(idOrFn, {depth})` + `Print(...)` 输出） |
| `get_editor_state` | `get_app_state` |
| `get_screenshot` / `snapshot_layout` / `get_variables` / `set_variables` / `export_nodes` | **无独立工具**：读取/校验用 `execute` 的 `Get`；截图/导出目前无对应工具（勿调用，会报错） |

> **关键参数**：所有工具都需要 `filePath` 参数指定 .pen 文件路径（绝对路径）。`execute` 用 `input`（JS 片段）或 `editId`+`edits`（失败修补，见一·五 §2）。

---

## 一·五、Pencil MCP 内部使用规范（从 Pen.app 实现提取）

> 来源：`/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64`（Pencil MCP server 的 Go 实现）内置的 agent 指引。这些是官方 server 对其内部 agent 的硬性要求，优先级高于一般经验。

### 1. schema 获取（建议，非硬性前置）

当你**还没有当前 .pen schema 时**，先获取它再操作（官方 server 对内部 agent 的指引）：

```js
get_app_state({ include_schema: true, include_canvas_design: true, include_scripts_and_shaders: false })
```

> 实测注：这**不是**工具的硬性前置——`execute` 不先调 `get_app_state` 也能直接读写节点。它的作用是给你 schema / 画布结构 / 当前选择等上下文，避免盲操作。三 flag 全填才能拿到完整 schema。

### 2. execute / batch_design 失败重试（强制）

`execute` 调用失败时，**必须**用返回的 `editId` + `edits` 修补，**绝不重发整段 `input`**：

- 每个 edit 把 `find` 替换为 `replace`，patched snippet 从头重跑；edits 按顺序应用，后一个 `find` 必须匹配「已被前面 edit 改过」的文本。
- `editId` 只与 `edits` 一起发；不要与 `input` 同发。
- patched 后再次失败 → 继续在**同一个 editId** 下用新的 `edits` 修（`find` 匹配已修补过的片段）。

### 3. 子代理并行设计模式（大设计任务）

大型设计任务**必须**拆给多个 designer agents 并行（最多 8-10 个），更快更一致：

- **先为每个子代理建占位容器节点**，把容器 node ID 经 config 传给对应 agent（每个 agent 至少指定一个可工作的 node ID）。
- **子代理的提示词绝不包含布局、尺寸、颜色、变量名**——它们能自己读文档变量与 guideline。只给**简短的任务描述**，让 agent 自己设计布局；所有子代理的提示词风格描述保持一致，产出才会统一。
- 子代理**不继承**父 agent 的 guidelines；若已选定 guide/style，把其 name 与 params 写进每个子代理的提示词，让它自己去取。
- spawn 数量 = 需要的份数 **- 1**（当前 agent 自己完成最后一份）。

### 4. 集成浏览器工具（参考真实网站复刻）

`browser` 工具操作 app 内置真实浏览器，用于参考/复刻网页为可编辑图层：

- 动作：`load-page` / `import-to-canvas` / `screenshot-to-canvas` / `return-element` / `return-screenshot`。
- `return-screenshot` 用于自查视觉；`screenshot-to-canvas`、`import-to-canvas` 把结果放进用户文档（之后可当普通设计用 execute 编辑）。
- `return-element` 查 DOM：别对 `body`/`html` 或宽泛选择器用（DOM 过大溢出上下文），查具体区块（如 `header`、`.pricing`、`#hero`）；整页概览用 `return-screenshot` 更省。
- 忠实复刻某组件：`return-element` 读其 DOM/样式 → `return-screenshot` 比对自己的渲染。
- localhost dev server 通常 live-reload：页面已加载时跳过 `load-page` 直接 `return-screenshot`；只有变更不可见时才 reload。

### 5. 本地页面验证闭环

改本地页面后：`load-page` 指向本地服务（如 `http://localhost:3000`）→ `return-screenshot`（target: `full-page`）核对 → 变更已可见则不必 reload。

---

## 二、execute API 详解（原 batch_design）

`execute` 是核心操作工具，接收一段 JS 代码片段（`input`）在文档上执行读/改。下文函数全部在 `execute` 的 JS 作用域内可用（读用 `Get`/`Print`，写用下列函数）。

### 2.1 可用函数（execute JS 作用域内）

```js
// 预定义变量
const document: string;  // 根节点 ID

// 读取节点（返回节点数据；配 Print 输出查看）
Get(path: string, opts?: { depth?: number }): any;
Get(fn: (node, ctx) => any): any;  // 按谓词收集，ctx.depth 为层级

// 打印输出（结果回显在工具响应里）
Print(value: any): void;

// 插入节点（返回新节点 ID）
Insert(parent: string, nodeData: Schema.Child): string;

// 复制节点（返回新节点 ID），复制 reusable 节点会创建 ref 实例
Copy(path: string, parent: string, copyNodeData: Schema.Child): string;

// 更新节点属性（不可改变 id/type/ref）
Update(path: string, updateData: Schema.Child): void;

// 替换节点（返回新节点 ID）
Replace(path: string, nodeData: Schema.Child): string;

// 移动节点
Move(path: string, parent: string | undefined, index?: number): void;

// 删除节点
Delete(path: string): void;

// 生成图片并应用到节点 fill
Generate(nodeId: string, type: "ai" | "stock", prompt: string): void;

// 查找画布空白区域
FindEmptySpace(input: {
  width: number; height: number;
  direction?: "top" | "right" | "bottom" | "left";
  padding?: number;
  nodeId?: string;
}): { x: number; y: number; parentId?: string };
```

### 2.2 path 参数

`Copy`、`Update`、`Replace`、`Move`、`Delete` 的 `path` 参数：
- **普通节点**：直接使用节点 ID，如 `"abc123"`
- **组件实例内子节点**：使用斜杠路径，如 `"instanceId/childId"`
- **斜杠仅用于组件实例嵌套**，普通层级关系不可用斜杠

### 2.3 关键约束

- 每个 `execute` 调用在独立作用域执行，**local 变量不跨批次共享**
- 同一批次内用 `bindingName = Insert(...)` 创建的 binding 可在后续同批次操作中使用
- 批次返回后 binding 失效，后续批次须使用返回结果中的实际 node ID
- **绝对不可**在创建节点时手动设置 `id` 属性 — Pencil 自动生成唯一 ID
- 每个节点必须设置 `name` 属性（可读名称），返回结果会包含 name→id 映射
- 建议每批次不超过 **25 个操作**
- `padding` 属性只在 `type: "frame"` 上有效，不能给 text、rectangle 等设置 padding
- 当父容器使用 `layout: "vertical"` 或 `"horizontal"` 时，子节点的 x/y 属性完全被忽略

---

## 三、读取节点（execute 的 Get，原 batch_get）

本机无独立 `batch_get` 工具；读取在 `execute` 的 JS 片段里用 `Get` + `Print` 完成。是理解现有设计结构的核心手段。

### 3.1 Get 用法

```js
// 按 id 读单个节点（depth 控制展开层级，默认只读自身）
Get("abc123")
Get("abc123", { depth: 2 })        // 含 2 层子节点

// 按谓词收集（node=节点，ctx.depth=当前层级；返回非 undefined 即被收集）
Get((node, ctx) => ctx.depth === 0 ? [node.id, node.name] : undefined)
Get((node, ctx) => node.type === "frame" && node.name === "Button" ? node.id : undefined)
```

读到的值默认只在 JS 作用域内；要查看必须用 `Print(...)` 输出（结果回显在工具响应里）。

### 3.2 常用模式（execute input）

```js
// 读取特定节点及其直接子节点
Print(Get("abc123", { depth: 2 }))

// 列出所有顶层页面（depth 0）
Print(Get((n, c) => c.depth === 0 ? [n.id, n.name] : undefined))

// 搜索特定类型 + 名字的节点
Print(Get((n, c) => n.type === "frame" && n.name === "Button" ? [n.id, n.name] : undefined))

// 读取全部设计变量
Print(GetVariables())
```

---

## 四、核心设计模式

### 4.1 布局转换模式（absolute → flexbox）

将旧式 `layout: "none"` + 绝对定位的布局改为现代 flexbox 布局：

```js
// 1. 先读取当前结构（execute 的 Get）
Print(Get("parentId", { depth: 3 }))

// 2. 更新父容器为 flexbox 布局
Update("parentId", {layout: "vertical", alignItems: "center", gap: 6, width: "fit_content", height: "fit_content"})

// 3. Replace 旧子节点 + Insert 新子节点（嵌套结构）
newBg = Replace("oldChildId", {type: "frame", name: "NewBg", width: 48, height: 48, cornerRadius: 14, fill: "#E8EDF5", justifyContent: "center", alignItems: "center"})
Insert(newBg, {type: "icon", name: "Icon", library: "lucide", icon: "star", width: 24, height: 24, fill: "#2D3E5F"})

// 4. Update 保留的旧节点（如文本标签）
Update("oldTextId", {fill: "#777777", textGrowth: "auto"})
```

**关键点**：
- 父容器从 `layout: "none"` 改为 `layout: "vertical"` 后，子节点的 x/y 自动被忽略
- 原来 `textGrowth: "fixed-width-height"` 的文本需改为 `textGrowth: "auto"` 以适应 flexbox
- 使用 `Replace` + `Insert` 两连击来创建嵌套结构（如带背景的图标）

### 4.2 批量属性替换模式

适用场景：统一修改多个同级节点的颜色、字体等属性：

```js
// 批量修改图标颜色
Update("icon1Id", {fill: "#2D3E5F"})
Update("icon2Id", {fill: "#2D3E5F"})
Update("icon3Id", {fill: "#2D3E5F"})
Update("icon4Id", {fill: "#2D3E5F"})
```

### 4.3 组件实例模式（ref）

创建可复用组件并用 ref 实例化：

```js
// 批次1：创建组件
card = Insert(document, {type: "frame", name: "Card", reusable: true, layout: "vertical", gap: 8, ...})
cardTitle = Insert(card, {type: "text", name: "Title", ...})
cardDesc = Insert(card, {type: "text", name: "Desc", ...})

// 批次2：实例化（使用返回的实际 ID）
Insert(row, {type: "ref", ref: "returnedCardId", name: "Card Instance", width: "fill_container",
  descendants: {
    "returnedTitleId": {content: "自定义标题"},
    "returnedDescId": {content: "自定义描述"}
  }
})
```

### 4.4 Copy+Replace 页面创建模式

快速基于已有页面创建新页面：

```js
pos = FindEmptySpace({width: 375, height: 812, padding: 80})
newPage = Copy("sourcePageId", document, {name: "新页面", x: pos.x, y: pos.y, placeholder: true,
  descendants: {
    "oldTitleId": {content: "新标题"},
    "oldIconId": {fill: "#2D3E5F"}
  }
})
Update(newPage, {placeholder: false})
```

### 4.5 模态框/弹窗模式

弹窗必须创建为 document 的直接子节点，不可嵌套在页面 frame 内：

```js
overlay = Insert(document, {type: "rectangle", name: "Overlay", x: pageX, y: 0, width: 375, height: 812, fill: "#000000", opacity: 0.5})
dialog = Insert(document, {type: "frame", name: "Dialog", layout: "vertical", gap: 16, width: 320, fill: "#FFFFFF", cornerRadius: 16, padding: 24, x: pageX + 27, y: 200})
```

---

## 五、图标使用规范

### 5.1 Lucide 图标

Pencil 支持 `lucide` 图标库。使用前须确认图标名在 lucide 中存在。

**已验证可用的图标**：
`trophy`, `rotate-ccw`, `star`, `house`, `book-open`, `user`, `chart-column`, `settings`, `search`, `plus`, `check`, `x`, `chevron-right`, `chevron-left`, `arrow-right`, `bell`, `calendar`, `clock`, `edit`, `trash`, `share`, `download`, `upload`, `heart`, `bookmark`, `flag`, `map-pin`, `phone`, `mail`, `lock`, `unlock`

**已验证不可用的图标**：
`bar-chart` → 改用 `chart-column`

**图标节点格式**：
```js
{type: "icon", name: "IconName", library: "lucide", icon: "trophy", width: 24, height: 24, fill: "#2D3E5F"}
```

### 5.2 图标最佳实践

- 图标应放在带背景色的圆角容器中（现代设计规范）
- 容器典型尺寸：44-48px，cornerRadius: 12-14
- 图标典型尺寸：22-24px（在容器中居中）
- 容器使用 flexbox：`justifyContent: "center", alignItems: "center"`

### 5.3 素材图片/ICON 生成流程（强制）

> **强制规则**：所有素材图片和 ICON **不得使用 emoji**，必须由 AI 生成后经去背景处理。emoji 在不同设备/系统上表现不一致，不可用于设计稿。

**完整流程**（三步）：

#### 步骤 1：AI 生图

使用 `Generate` 函数在 Pencil 中生成图片。背景色统一使用白色（`#FFFFFF`），色值固定。

> **关键**：提示词必须严格遵循下方**固定公式**，按素材类型选择对应公式。公式中的"硬性要求"部分不可删改，是保证抠图质量的关键约束。

---

##### 1.1 提示词固定公式总览

| 公式 | 适用场景 | 公式结构 |
|------|---------|---------|
| **公式一：图标** | 功能性小图标（icon-xxx，64x64 等） | 风格 + 色彩 + **分辨率（动态）** + 硬性要求 |
| **公式二：背景装饰** | 页面背景、边框装饰、角落点缀 | 风格 + 色彩 + **分辨率（动态）** + 硬性要求 |
| **公式三：场景插画** | 空状态插画、引导页大图 | 风格 + 色彩 + **分辨率（动态）** + 硬性要求 |

> **关键原则**：
> 1. 公式中的"风格"和"色彩"**不是固定值**，必须从当前项目的设计系统中提取，与 App 整体风格保持一致
> 2. 公式中的"分辨率"**必须动态计算**，根据目标控件的宽高比生成对应分辨率的图片，避免 AI 默认生成 16:9 矩形图

---

##### 1.2 分辨率动态计算规范

> **关键**：AI 生图引擎默认生成 16:9 矩形图（如 1408×768）。**必须**在提示词中明确指定分辨率，否则图标会变成矩形而非正方形。

**计算方法**：
1. 获取目标控件的宽 W 和高 H（单位 px）
2. 计算 W:H 的最简整数比（如 64:64 → 1:1，1080:1920 → 9:16）
3. 拼接为：`aspect ratio {最简比宽}:{最简比高}, resolution {W}x{H} pixels, square canvas`（正方形时加 `square canvas` 强调）

**示例**：
| 目标控件尺寸 | 分辨率参数 |
|------------|-----------|
| 64×64 图标 | `aspect ratio 1:1, resolution 64x64 pixels, square canvas` |
| 200×200 装饰 | `aspect ratio 1:1, resolution 200x200 pixels, square canvas` |
| 1080×1920 页面背景 | `aspect ratio 9:16, resolution 1080x1920 pixels` |
| 343×120 卡片背景 | `aspect ratio 343:120, resolution 343x120 pixels` |
| 240×200 插画 | `aspect ratio 6:5, resolution 240x200 pixels` |

---

##### 1.3 公式一：图标（Icon）

**公式**：`风格 + 色彩 + 分辨率（动态） + 硬性要求`

**模板**：
```
a single flat icon of {图标描述}, {风格}, {色彩}, {分辨率}, {硬性要求}
```

| 要素 | 取值说明 |
|------|---------|
| 风格 | **从设计系统提取**，填入与当前 App 风格匹配的描述。例如 S5 Soft Neumorphism → `soft rounded flat 2D vector icon style, gentle and warm`；极简扁平 → `clean flat 2D vector icon style, minimalist` |
| 色彩 | **从设计系统提取主色**，填入具体色值。例如 S5 → `single solid #EA580C warm orange color`；蓝色系 → `single solid #2563EB blue color` |
| 分辨率 | **动态计算**，图标通常为正方形：`aspect ratio 1:1, resolution 64x64 pixels, square canvas` |
| 硬性要求 | `no background container, no border box, solid #FFFFFF pure white background filling entire canvas, centered with minimal padding, NO shadow, NO drop shadow, NO glow, NO gradient, clean crisp edges for background removal` |

> **注意**：
> - 图标本身的圆角是**允许的**（柔和风格的图标自然有圆角），硬性要求中**不包含**任何禁止圆角的指令
> - 硬性要求只禁止：圆角矩形容器框、边框、阴影、渐变 — 这些会影响抠图质量
> - **必须指定分辨率**，否则 AI 默认生成 16:9 矩形图，导致图标变形

**示例**（S5 Soft Neumorphism 风格，64×64 图标）：
```
a single flat icon of a baby bottle, soft rounded flat 2D vector icon style, gentle and warm, single solid #EA580C warm orange color, aspect ratio 1:1, resolution 64x64 pixels, square canvas, no background container, no border box, solid #FFFFFF pure white background filling entire canvas, centered with minimal padding, NO shadow, NO drop shadow, NO glow, NO gradient, clean crisp edges for background removal
```

---

##### 1.4 公式二：背景装饰（Background/Decoration）

**公式**：`风格 + 色彩 + 分辨率（动态） + 硬性要求`

**模板**：
```
a flat decorative background of {装饰描述}, {风格}, {色彩}, {分辨率}, {硬性要求}
```

| 要素 | 取值说明 |
|------|---------|
| 风格 | **从设计系统提取**，填入与当前 App 风格匹配的背景装饰描述。例如手绘风 → `hand-drawn sketch style with crayon texture, warm and playful`；极简扁平 → `flat 2D vector illustration style`；插画风 → `soft watercolor illustration style` |
| 色彩 | **从设计系统提取**，使用设计系统的配色方案。例如暖色调 → `soft warm pastel colors, low saturation, warm beige and cream tones`；冷色调 → `cool pastel colors, soft blue and mint tones` |
| 分辨率 | **动态计算**，见 §1.2 规范 |
| 硬性要求 | `decorative elements filling all four borders and edges of the entire canvas, center area left empty, background not too busy, solid #FFFFFF pure white background filling entire canvas, NO drop shadow, NO rounded frame, NO border, NO 3D effects, clean crisp edges for background removal` |

**完整示例**（手绘风格，1080×1920 页面背景）：
```
a flat decorative background of cute baby items and stars, hand-drawn sketch style with crayon texture, warm and playful, soft warm pastel colors, low saturation, warm beige and cream tones, aspect ratio 9:16, resolution 1080x1920 pixels, decorative elements filling all four borders and edges of the entire canvas, center area left empty, background not too busy, solid #FFFFFF pure white background filling entire canvas, NO drop shadow, NO rounded frame, NO border, NO 3D effects, clean crisp edges for background removal
```

---

##### 1.5 公式三：场景插画（Illustration）

**公式**：`风格 + 色彩 + 分辨率（动态） + 硬性要求`

**模板**：
```
a flat illustration of {场景描述}, {风格}, {色彩}, {分辨率}, {硬性要求}
```

| 要素 | 取值说明 |
|------|---------|
| 风格 | **从设计系统提取**，与当前 App 风格匹配。例如 S5 → `soft rounded flat 2D vector illustration style, gentle and warm` |
| 色彩 | **从设计系统提取**，使用设计系统的配色方案。例如 S5 → `warm orange and soft pastel colors, matching #EA580C primary tone` |
| 分辨率 | **动态计算**，见 §1.2 规范。插画尺寸根据目标控件计算，如 240×200 → `aspect ratio 6:5, resolution 240x200 pixels` |
| 硬性要求 | `solid #FFFFFF pure white background filling entire canvas, NO drop shadow, NO rounded frame, NO border, centered, clean crisp edges for background removal` |

**示例**（S5 Soft Neumorphism 风格，240×200 插画）：
```
a flat illustration of a nanny holding a baby, soft rounded flat 2D vector illustration style, gentle and warm, warm orange and soft pastel colors, matching #EA580C primary tone, aspect ratio 6:5, resolution 240x200 pixels, solid #FFFFFF pure white background filling entire canvas, NO drop shadow, NO rounded frame, NO border, centered, clean crisp edges for background removal
```

---

##### 1.6 JS 调用示例

```js
// 公式一：图标生成（S5 风格，64x64 正方形示例）
Generate("iconNodeId", "ai",
  "a single flat icon of a baby bottle, soft rounded flat 2D vector icon style, gentle and warm, single solid #EA580C warm orange color, aspect ratio 1:1, resolution 64x64 pixels, square canvas, no background container, no border box, solid #FFFFFF pure white background filling entire canvas, centered with minimal padding, NO shadow, NO drop shadow, NO glow, NO gradient, clean crisp edges for background removal"
)

// 公式二：背景装饰生成（手绘风格，1080x1920 页面背景）
Generate("bgNodeId", "ai",
  "a flat decorative background of cute baby items and stars, hand-drawn sketch style with crayon texture, warm and playful, soft warm pastel colors, low saturation, warm beige and cream tones, aspect ratio 9:16, resolution 1080x1920 pixels, decorative elements filling all four borders and edges of the entire canvas, center area left empty, background not too busy, solid #FFFFFF pure white background filling entire canvas, NO drop shadow, NO rounded frame, NO border, NO 3D effects, clean crisp edges for background removal"
)

// 公式三：场景插画生成（S5 风格，240x200 示例）
Generate("illNodeId", "ai",
  "a flat illustration of a nanny holding a baby, soft rounded flat 2D vector illustration style, gentle and warm, warm orange and soft pastel colors, matching #EA580C primary tone, aspect ratio 6:5, resolution 240x200 pixels, solid #FFFFFF pure white background filling entire canvas, NO drop shadow, NO rounded frame, NO border, centered, clean crisp edges for background removal"
)
```

---

##### 1.7 提示词禁止项说明

| 禁止项 | 提示词中的约束指令 | 适用公式 | 原因 |
|--------|-------------------|---------|------|
| 圆角矩形容器框 | `no background container, no border box` | 公式一 | AI 常把图标画在圆角矩形容器里，抠图后四周残留边框 |
| 阴影/投影 | `NO shadow, NO drop shadow, NO glow` | 全部 | 阴影会被当作主体保留，抠图后四周有灰边 |
| 渐变 | `NO gradient` | 公式一 | 渐变边缘颜色过渡，抠图阈值难以统一 |
| 3D 效果 | 风格描述中包含 `flat 2D vector` | 全部 | 3D 效果边缘有反光/高光，抠图不干净 |
| 背景花哨 | `background not too busy` | 公式二 | 背景元素过多影响抠图和可读性 |

> **注意**：图标本身的圆角是**允许的**，不需要在提示词中禁止。圆角问题应通过**去除父容器的 cornerRadius** 来解决，而非通过提示词约束 AI。

##### 1.8 父容器圆角设置规范

> **关键**：AI 生成的图片本身是方形的，圆角问题来源于**承载图片的父控件设置了 cornerRadius**。因此素材页中的图片父容器**必须设置 cornerRadius: 0**，不可设置圆角。

**素材页图片父容器规范**：
```js
// 正确：图标父容器无圆角、无边框
{type: "frame", name: "Img", width: 64, height: 64, cornerRadius: 0, fill: {type:"image",...}}

// 错误：父容器有圆角会导致图片显示为圆角
{type: "frame", name: "Img", width: 64, height: 64, cornerRadius: 12, fill: {type:"image",...}}
```

**通用约束**：
- 统一使用 `#FFFFFF`（白色）作为生图背景色，不可使用其他颜色
- 提示词中明确写死色值，不要写 "white" 这种模糊描述
- 不要尝试在 AI 生图阶段要求透明背景 — AI 生图工具不支持直接生成透明 PNG，棋盘格背景实质是白色填充
- **禁止修改公式模板中的硬性要求部分**，这些是保证抠图质量的关键约束
- 公式二的"比例"参数必须根据目标控件实际尺寸动态计算，不可写死固定值
- **公式中的"风格"和"色彩"必须从当前项目设计系统提取**，确保图标/插画与 App 整体风格一致

#### 步骤 2：导出 PNG 并去背景

> **前置检查**：导出前必须确认所有图片父容器的 `cornerRadius` 为 0。父容器有圆角会导致导出的 PNG 也带圆角白边。如步骤 1 中已设置 `cornerRadius: 0` 可跳过；否则先批量 Update。

1. 用 `execute` 作用域内的 `Export(...)` 函数（实测存在；旧名 `export_nodes` 不存在）将节点导出为 PNG 到 `doc/UXDesign/images/` 目录
2. 使用通用去背景脚本去除白色背景，生成带 alpha 通道的透明 PNG
3. 使用裁剪补偿脚本去除抠图残留的边缘伪影（黑灰边框）

**使用通用去背景脚本**（位于 `.trae/skills/pencil-mcp/pencil-mcp-api/remove_bg.py`）：

```bash
# 白色背景（默认，threshold 25）
python .trae/skills/pencil-mcp/pencil-mcp-api/remove_bg.py --dir ./doc/UXDesign/images

# 指定文件名模式
python .trae/skills/pencil-mcp/pencil-mcp-api/remove_bg.py --dir ./doc/UXDesign/images --pattern "icon-*.png"

# 自定义容差
python .trae/skills/pencil-mcp/pencil-mcp-api/remove_bg.py --dir ./doc/UXDesign/images --threshold 15
```

**参数说明**：

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--dir` | 是 | - | 图片目录路径 |
| `--pattern` | 否 | `*.png` | 文件名 glob 匹配模式 |
| `--color` | 否 | `white` | 要去除的背景色：`white` 或 `green` |
| `--threshold` | 否 | `25` | 颜色容差 0-255 |

**颜色对照表**：

| 目标背景色 | RGB 值 | threshold 建议 |
|-----------|--------|---------------|
| 白色 `#FFFFFF` | `(255, 255, 255)` | 10-30 |
| 绿色 `#7FB77E` | `(127, 183, 126)` | 40-60 |

**threshold 调优**：去背景后边缘有残留 → 降低 threshold；图标主体被误删 → 提高 threshold。

**裁剪补偿（去除抠图边缘伪影）**：

去背景后图标四周可能残留黑灰色边框伪影。使用裁剪补偿脚本从中心裁剪一定比例边缘后再补透明背景回原尺寸：

```bash
# 裁剪 6% 边缘并补回原尺寸（推荐）
python .trae/skills/pencil-mcp/pencil-mcp-api/crop_pad.py --dir ./doc/UXDesign/images --pattern "icon-*-transparent.png" --crop-percent 6 --suffix "-c"

# 裁剪 10%（边缘伪影较严重时）
python .trae/skills/pencil-mcp/pencil-mcp-api/crop_pad.py --dir ./doc/UXDesign/images --pattern "icon-*-transparent.png" --crop-percent 10 --suffix "-c"
```

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--dir` | 是 | - | 图片目录路径 |
| `--pattern` | 否 | `*.png` | 文件名 glob 匹配模式 |
| `--crop-percent` | 否 | `6` | 从每条边裁剪的百分比 |
| `--suffix` | 否 | `-c` | 输出文件名后缀 |

#### 步骤 3：重新应用到 .pen 文件

```js
Update("iconNodeId", {
  fill: { type: "image", enabled: true, url: "./images/icon-name-transparent-c.png", mode: "fill" }
})
```

**注意事项**：
- AI 生图是异步的，生成后需等待图片出现再导出
- 如果 AI 生图效果不理想，**应重新生成而非放弃**，调整提示词细化描述即可
- 同一组 icon 应在同一批次生成，确保风格一致
- 去背景后的透明 PNG 命名：`icon-{类型}-transparent.png`
- 裁剪补偿后的最终文件命名：`icon-{类型}-transparent-c.png`，**步骤 3 引用的是裁剪后的文件**
- **导出前确保父容器 `cornerRadius: 0`**，否则导出的 PNG 会带圆角白边

---

## 六、颜色与变量

### 6.1 设计变量

无独立 `get_variables` 工具，但 `execute` 作用域内有 `GetVariables()` 函数（实测存在）可读出全部变量。变量名带 `$` 前缀：

```json
{"$primary": {"type": "color", "value": "#2D3E5F"}, ...}
```

### 6.2 变量引用（本项目用 `$`，实测可靠）

在 `execute` 中可用 `"$primary"` 引用变量。

> 实测注（2026-08-21，本 design.pen）：`$brand-primary` 等 `$` 引用**正确解析并被保留**（读回仍是变量名），不是 `#000000`。本项目设计系统建立在变量上（深浅双主题靠 frame theme 解析 token），**必须用 `$` 引用**，不要硬编码 hex（硬编码会让深色页拿到浅色值）。
>
> 旧文档说"`$` 引用不稳定、推荐硬编码"——那是针对**无变量体系**的通用场景；本项目有完整双主题变量，恰好相反，应当用 `$`。

### 6.3 颜色约束

- 透明色用 `"#00000000"`（`"transparent"` / `"none"` 虽不报错，但内部会被归一化为 `#00000000`，建议直接写它，行为明确）。
- 颜色格式：`#RGB`, `#RRGGBB`, `#RRGGBBAA`

---

## 七、常见陷阱

| # | 现象 | 原因 | 解决 |
|---|------|------|------|
| 0 | **多个顶层 frame 堆叠重叠** | 新建 frame 默认坐标均为 `(0,0)`，未手动设置位置 | **分批**使用 `FindEmptySpace` → `Update`：每批只处理一个 frame，因为 `FindEmptySpace` 会考虑已放置的节点，分批执行才能确保每批找到不同位置。完成后用 `execute` 的 `Get` 复查各顶层 frame 坐标无重叠。 |
| 1 | `fill: "$primary"` 显示为 `"#000000"` | 变量引用无声失败（仅见于无变量体系的文档） | 本项目直接用 `$` 引用即可（见 §6.2）；无变量时才退回硬编码 hex |
| 2 | `fill: "transparent"` 被静默改写 | 内部归一化 | 直接写 `"#00000000"`，行为明确 |
| 3 | 图标显示为方块/缺失 | lucide 图标名不存在（server 会报 issue 提示） | 参考 §5.1 已验证列表 |
| 4 | 布局坍塌/元素消失 | `fit_content` + `fill_container` 循环依赖 | 父容器设置显式尺寸 |
| 5 | execute 返回空 / 报错 | 操作 >25 个 / 非法属性值 | 拆分为更小批次 |
| 6 | `Node 'xxx' not found!` | 多轮修改后节点 ID 变化 | 用 `execute` 的 `Get` 重新获取最新 ID |
| 7 | path/ellipse 元素不能应用图片 fill | 装饰元素类型不支持 | 用 Replace 改为 frame 类型 |
| 8 | 文本不换行 / 溢出 | textGrowth 设置不当 | 换行用 `"fixed-width"` |
| 9 | x/y 设置无效 | 父容器是 flexbox 布局 | 不要同时设置 flexbox + x/y |
| 10 | padding 设置无效 | 节点类型非 frame | padding 仅 frame 可用 |

---

## 八、layout 检查清单

每轮设计修改后，用 `execute` 的 `Get` 复查结构（本机无 `snapshot_layout` 工具）验证：

1. **布局未坍塌**：所有节点都有合理的 width/height（非 0）
2. **内容未被裁剪**：无 `"problems": "clipped"` 标记
3. **间距合理**：相邻区块间距一致（通常 8-16px）
4. **无重叠**：同级节点位置无冲突
5. **页面高度匹配**：内容不超过页面 frame 高度（clip: true 时会被裁掉）

---

## 九、效率建议

1. **先读后写**：每次修改前用 `execute` 的 `Get` 了解当前结构，避免盲操作
2. **批量操作**：每批 15-25 个操作，减少工具调用轮次
3. **先验证再继续**：每轮修改后用 `execute` 的 `Get` 确认属性（本机无 `get_screenshot`；视觉核对在 Pencil 桌面端看）
4. **设计 token 用 `$` 引用**：本项目直接用 `$token` 引用变量（见 §6.2），不要硬编码
5. **图标先验证**：不确定图标名是否存在时，先用单次 `Insert` 试错再批量操作（server 会报 issue 提示无效图标）
6. **布局转换一次性完成**：将 absolute → flexbox 的所有操作放在同一个 `execute` 调用中
7. **弹窗放 document 根**：弹窗/叠层必须是 document 直接子节点，不可嵌套在页面 frame 内
8. **素材复用**：同类卡片/背景共用同一张图片素材，避免风格不一致

---

## 十、文件存放规范

```
project/
├── doc/
│   ├── UXDesign/
│   │   ├── design.pen              # 主设计稿
│   │   ├── demo.pen                # 设计样图/试稿
│   │   └── images/                 # 图片素材目录
│   │       ├── icon-xxx.png
│   │       ├── icon-xxx-transparent.png
│   │       ├── bg-xxx.png
│   │       └── deco-xxx.png
│   └── interaction-design.md       # 交互设计文稿
```

图片引用使用相对于 .pen 文件的路径：`./images/icon-name-transparent.png`