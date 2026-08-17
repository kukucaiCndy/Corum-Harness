---
name: "pencil-design"
description: "Pencil MCP visual design tool for creating UI pages, components, and design systems in .pen files. Invoke when user needs to create visual designs, UI mockups, page layouts, or design systems."
---

# Pencil MCP Design Skill — SOP 总入口

## 引用 Skill

本 Skill 为设计流程的**总入口**，按需引用以下子 Skill：

| 子 Skill | 说明 |
|----------|------|
| [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | **设计灵感引擎** — 包含 67 种风格、96 套配色、57 套字体搭配、99 条 UX 准则。在生成样图前**必须**从官方仓库拉取最新版本获取设计模式推荐 |
| [design-execution-plan](../design-execution-plan/SKILL.md) | **设计执行方案生成** — 第 6 步调用，归纳复用组件、规划背景填充策略、标准化生图提示词 |
| [pencil-mcp-api](../pencil-mcp-api/SKILL.md) | MCP 工具 API 参考、设计模式、图标规范、颜色变量、常见陷阱、layout 检查清单 |
| [pencil-to-miniprogram](../pencil-to-miniprogram/SKILL.md) | 设计稿转微信小程序代码 |

在执行过程中：
- **生成样图前**：**必须**先从官方仓库拉取最新 `ui-ux-pro-max` 获取 5 种设计模式，再基于模式生成样图
- **第 6 步**：**必须**调用 `design-execution-plan` SKILL 生成设计执行方案（资产预规划 + 背景填充决策 + 提示词模板）
- **MCP 操作**（batch_design / batch_get / Generate 等）：参考 `pencil-mcp-api`
- **设计稿转小程序代码**：参考 `pencil-to-miniprogram`

---

## 标准设计 SOP（8 步）

### 第 1 步：检查 Pencil MCP 就绪状态 + 创建设计文件 + 确认打开 demo.pen

#### 1.1 检查 Pencil MCP 可用性

调用 `get_editor_state` 确认 Pencil MCP 可用：

```js
get_editor_state(include_schema: true)
```

- **成功** → 进入 1.2
- **失败** → 告知用户：**"Pencil MCP 尚未配置，请先完成 Pencil MCP 的安装和配置后再开始设计流程。"** 并中止流程

#### 1.2 确认标准目录结构

确认以下目录结构是否已创建：

```
doc/
├── UXDesign/              # .pen 设计文件目录
│   ├── demo.pen            # 设计样图/试稿
│   ├── design.pen          # 主设计稿（最终定稿后创建）
│   └── images/             # 图片素材目录
│       ├── icon-xxx.png
│       ├── icon-xxx-transparent.png
│       ├── bg-xxx.png
│       └── deco-xxx.png
└── interaction-design.md   # 交互设计文稿
```

如目录缺失，先创建。

#### 1.3 创建 demo.pen 和 design.pen

> **关键**：必须从本 skill 目录下的 `template.pen` 模板文件拷贝创建，不要从零新建空文件。

**模板文件位置**：

```
.codebuddy/skills/pencil-mcp/pencil-design/template.pen
```

**操作步骤**（以项目根目录为工作目录）：

1. 创建 `doc/UXDesign/` 目录
2. 从 skill 目录拷贝 `template.pen` 为 `demo.pen` 和 `design.pen`：

```bash
# 创建目录
mkdir -p doc/UXDesign

# 拷贝模板文件
cp .codebuddy/skills/pencil-mcp/pencil-design/template.pen doc/UXDesign/demo.pen
cp .codebuddy/skills/pencil-mcp/pencil-design/template.pen doc/UXDesign/design.pen
```

**Windows 环境命令**：

```cmd
mkdir "doc\UXDesign"
copy ".codebuddy\skills\pencil-mcp\pencil-design\template.pen" "doc\UXDesign\demo.pen"
copy ".codebuddy\skills\pencil-mcp\pencil-design\template.pen" "doc\UXDesign\design.pen"
```

**文件用途区分**：

| 文件 | 用途 | 使用阶段 | filePath 参数 |
|------|------|---------|--------------|
| `demo.pen` | 设计样图/风格探索试稿 | 第 3-4 步（风格探索） | `doc/UXDesign/demo.pen` |
| `design.pen` | 主设计稿（最终定稿） | 第 7-8 步（正式设计） | `doc/UXDesign/design.pen` |

> **重要**：
> - 风格探索阶段（第 3-4 步）的所有 `batch_design` / `set_variables` 等 MCP 操作，`filePath` 必须指向 `demo.pen`
> - 正式设计阶段（第 7-8 步）的所有 MCP 操作，`filePath` 必须指向 `design.pen`
> - **绝不可**在 `demo.pen` 和 `design.pen` 之间混用操作

#### 1.4 使用 demo.pen 前的确认流程

> **关键**：`demo.pen` 是样图试稿文件，第 3 步生成样图前使用。由于 Pencil MCP 操作的是**当前在 Pencil 编辑器中打开的文件**，因此必须确保用户已在 Pencil 中打开 `demo.pen` 文件。

**拷贝完成后立即执行以下确认流程**：

1. **告知用户**需要打开 demo.pen 文件：

   > "文件已创建完成，请按以下步骤操作：
   > 1. 在 Pencil 编辑器中打开文件：`doc/UXDesign/demo.pen`
   >    （完整绝对路径：`<项目根目录>/doc/UXDesign/demo.pen`）
   > 2. 打开后请回复「已打开」确认
   >
   > 后续第 3 步的样图生成将写入此文件，必须先在编辑器中打开它。"

2. **等待用户确认**：用户回复"已打开"或类似确认信息后，才继续后续操作。

3. **验证文件已打开**：调用 `get_editor_state` 确认当前编辑器打开的文件是 `demo.pen`：

   ```js
   get_editor_state()
   ```

   - 如果返回的当前编辑器文件是 `demo.pen`（或路径包含 `demo.pen`）→ 进入第 2 步
   - 如果返回的是其他文件 → 提示用户："当前 Pencil 编辑器中打开的不是 `demo.pen`，请先打开 `doc/UXDesign/demo.pen` 后再继续。" 并重复等待

> **注意**：`design.pen` 的确认流程在第 7.0 步执行，此处不涉及。

---

### 第 2 步：询问设计风格偏好

从以下维度与用户沟通，明确设计方向：

| 维度 | 问题示例 |
|------|----------|
| **色彩偏好** | 喜欢什么主色调？冷色/暖色？明亮/沉稳？有参考色值吗？ |
| **设计风格** | 极简/扁平/毛玻璃/新拟态/手绘风/插画风/Bento/Brutalism？ |
| **字体偏好** | 衬线/无衬线？字号层级偏好？ |
| **圆角风格** | 大圆角（可爱/亲和）/ 小圆角（专业/干练）/ 直角（硬朗）？ |
| **间距偏好** | 宽松留白 / 紧凑密集？ |
| **参考灵感** | 有参考 App 或设计稿链接吗？ |
| **品牌元素** | 有 Logo、品牌色、品牌字体吗？ |

将用户的偏好**整理为结构化摘要**，供后续设计使用。

---

### 第 3 步：拉取最新 UI UX PRO MAX + 生成样图

> **关键流程**：确认风格 → 拉取最新 UI UX PRO MAX → 获取 5 种设计模式 → 在 demo.pen 中生成 5 套样图

#### 3.1 拉取最新版 UI UX PRO MAX 获取 5 种设计模式

**在用户确认风格偏好后，必须从官方仓库拉取最新版 `ui-ux-pro-max` 获取设计灵感**。不可跳过此步骤。

> **仓库地址**：https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git

首先确保拉取最新代码：

```bash
UIUX_DIR=".trae/skills/ui-ux-pro-max"
if [ -d "$UIUX_DIR" ]; then
  cd "$UIUX_DIR" && git pull origin main
else
  git clone https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git "$UIUX_DIR"
fi
```

**步骤 A：搜索 5 种风格模式**

使用 `--domain style` 搜索不同风格关键词，获取 5 种不同的设计方式：

```bash
python3 .trae/skills/ui-ux-pro-max/scripts/search.py "<项目描述>" --domain style -n 5
```

**步骤 B：为每种风格获取完整设计系统**

对于筛选出的 5 种风格，分别调用 `--design-system` 获取该风格下的完整设计规范（色彩、字体、布局建议等）：

```bash
python3 .trae/skills/ui-ux-pro-max/scripts/search.py "<产品类型> <风格关键词1>" --design-system
python3 .trae/skills/ui-ux-pro-max/scripts/search.py "<产品类型> <风格关键词2>" --design-system
# ... 共 5 次
```

**步骤 C：补充 UX 最佳实践**

```bash
python3 .trae/skills/ui-ux-pro-max/scripts/search.py "mobile form accessibility" --domain ux
```

#### 3.2 新建 demo.pen 并生成样图

> **关键**：样图必须创建在 **`doc/UXDesign/demo.pen`** 文件中，**绝不可**写入 `doc/UXDesign/design.pen`。

1. 在已创建的 `doc/UXDesign/demo.pen` 中调用 `set_variables` 设置用户确认的配色变量
2. 基于 UI UX PRO MAX 返回的 **5 种不同设计模式**，在 demo.pen 中生成 5 套设计样图
3. **使用 `FindEmptySpace` 分散放置每套样图**（见下方详细说明）
4. 每套样图完成后，使用 `get_screenshot` 截取关键页面截图

#### 3.3 使用 FindEmptySpace 避免样图重叠

> **关键**：新建的 frame 默认坐标均为 `(0, 0)`，若不手动设置位置，所有样图会堆叠在一起。**必须**使用 `FindEmptySpace` 为每套样图找到独立位置。

**正确做法**（分批执行）：

```js
// 每批处理一个 frame：先找空位，再移动
// 批次 1
pos = FindEmptySpace({width: 375, height: 812, padding: 60})
Update("frame1Id", {x: pos.x, y: pos.y})

// 批次 2
pos = FindEmptySpace({width: 375, height: 812, padding: 60})
Update("frame2Id", {x: pos.x, y: pos.y})

// ... 共 5 批
```

**原因**：`FindEmptySpace` 会考虑当前画布上已放置的节点，因此每批之间画布状态会更新，确保后续批次找到的位置不会与已放置的 frame 重叠。

**错误做法**：在同一批次中多次调用 `FindEmptySpace` 而不立即使用结果 — 因为同一批次内画布状态不变，所有 `FindEmptySpace` 可能返回相同位置。

**验证**：放置完成后，使用 `snapshot_layout({maxDepth: 0})` 检查顶层 frame 的 x/y 坐标，确认无重叠。

**样图设计要点**：
- 覆盖 UI UX PRO MAX 推荐的主要颜色方案和布局风格
- 使用 Generate 生成占位图片，背景统一为 `#FFFFFF` 白色
- 不使用 emoji，所有素材图片用 AI 生成
- 每套样图完成后截图保存
- **确保 filePath 指向 `doc/UXDesign/demo.pen`**，不要写入当前打开的 `design.pen`

---

### 第 4 步：用户确认风格

将 5 套样图的截图展示给用户，进行详细确认：

- 询问用户对每套样图的评价（喜欢/不喜欢什么）
- 收集反馈点：颜色、布局、圆角、字体、图标风格等
- 根据反馈调整样图
- **循环直到用户明确满意**，确认最终选择的设计方向

---

### 第 5 步：生成本项目设计风格文档

基于最终敲定的设计风格，生成项目级设计风格文档：

```markdown
doc/UXDesign/{project-name}-design-style.md
```

**该文档必须包含以下内容**：

```
# {项目名} UX 设计规范

## 设计风格
- 风格类型：xxx
- 核心关键词：xxx

## 色彩系统
- 主色：`#xxxxxx`
- 辅色：`#xxxxxx`
- 背景色：`#xxxxxx`
- 文字色：`#xxxxxx`
- 其他：xxx

## 字体系统
- 中文字体：xxx
- 英文字体：xxx
- 字号层级：xxx

## 组件规范
- 圆角规范：xxx px
- 间距规范：xxx px
- 按钮规范：xxx
- 卡片规范：xxx
- TabBar 规范：xxx
- 导航栏规范：xxx

## 图标规范
- 图标风格：xxx
- 通用图标列表：xxx
```

文档输出路径：`doc/UXDesign/{project-name}-design-style.md`

---

### 第 6 步：生成设计执行方案

> **关键**：正式设计前，必须结合第 5 步的设计风格文档和交互设计稿，生成一份设计执行方案。该方案归纳所有复用组件、规划背景填充策略、标准化生图提示词模板。

**前置动作（强制）**：

1. **向用户索要交互设计文稿**：
   > "下一步需要根据交互设计稿生成设计执行方案。请提供项目的交互设计文稿，通常为 `doc/interaction-design.md`。
   > 如果没有，我可以先根据项目需求草拟一份简要的页面清单，您确认后再继续。"
2. **等待用户提供**交互设计文稿或确认草拟方案
3. **确认交互稿存在**后，进入执行流程

> **严格按照 [`design-execution-plan`](../design-execution-plan/SKILL.md) SKILL 的 SOP 执行**，不得跳过任何步骤。

**执行流程**（详见 design-execution-plan SKILL）：

1. **页面总览汇总** — 从交互稿提取所有页面，标注层级/功能/复用组件/专属元素
2. **复用组件归纳** — 识别跨页面复用组件，给出语义化 ID（如 `tab-bar-nav`、`card-info`）
3. **背景资产规划（核心）** — 决定每个元素的填充方式（纯色/渐变/背景图片），手绘/插画风大面积背景强制用背景图片；每个资产写好生图提示词模板（可变部分+固定部分）
4. **配色资产标准化** — 将颜色按用途拆分为可引用的配色资产
5. **资产生成优先级排序** — P0→P4 排序，第 7 步按此顺序生成

**输出**：`doc/UXDesign/{project-name}-design-execution-plan.md`（含 5 张表 + 决策规则 + 生图提示词模板）

**⛔ 强制检查点**：
- 交互稿缺失 → 要求用户提供后继续
- 背景资产表必须穷举所有出现背景的元素
- 手绘/插画风格的大面积背景填充方式必须标记为「背景图片」
- 资产生图提示词必须分离可变/固定部分

---

### 第 7 步：开始设计

#### 7.0 打开并确认 design.pen 文件

> **关键**：正式设计阶段使用 `design.pen` 文件。由于 MCP 操作的是 Pencil 编辑器中当前打开的文件，必须先确保用户已在 Pencil 中打开 `design.pen`。

**确认流程**（参见第 1.4 节详细说明）：

1. 告知用户在 Pencil 编辑器中打开 `doc/UXDesign/design.pen`
2. **等待用户确认**已打开该文件
3. 调用 `get_editor_state` 验证当前编辑器打开的确实是 `design.pen`
4. 确认通过后，所有 MCP 操作的 `filePath` 参数统一使用 `doc/UXDesign/design.pen`

> **注意**：如果用户未确认就继续，可能导致设计内容写入错误的文件，造成数据丢失或混乱。

#### 7.1 对照设计执行方案确认

> **注意**：第 6 步已产出设计执行方案，包含页面总览表、复用组件清单、背景资产表、配色资产表、优先级排序。本步**不是重新规划**，而是**对照方案确认和补充**。

1. 打开第 6 步产出的 `doc/UXDesign/{project-name}-design-execution-plan.md`
2. 逐表确认：
   - **页面总览表**：页面数量（L1-L4）和层级划分是否与交互稿一致
   - **复用组件清单**：组件列表和引用关系是否完整
   - **背景资产表**：资产清单、填充方式决策是否正确（手绘/插画风大面积背景确认为背景图片）
   - **配色资产表**：色值是否与设计风格文档一致
   - **优先级排序表**：P0→P4 顺序是否合理
3. 补充状态清单：每个页面需考虑的状态（加载态、空态、错误态、正常态、边缘态）

#### 7.2 创建设计系统页面

先创建设计系统页面，包含：
- 色板（主色、辅色、背景、文字等 swatch）
- 字体层级展示
- 通用组件库（按钮、输入框、卡片、TabBar、导航栏等）

设计系统页面使用 `reusable` 属性标记组件，方便后续实例化。

#### 7.3 生成素材页面

> **素材页的目的**：将第 6 步设计执行方案中规划的**所有需 AI 生图的资产**统一生成在这个页面，方便批量导出、去背景和用户确认。纯色资产不需要放入素材页。

##### 7.3.0 素材页布局规范

> **关键**：素材页的截图将用于 AI 视觉判断和用户确认。布局混乱（文字与图片重叠、元素拥挤）会严重干扰截图效果。

**布局规则**：

1. **创建独立的素材页 frame**：使用 `FindEmptySpace` 在画布空白区域创建一个大尺寸 frame（如 1200×900），背景纯白 `#FFFFFF`
2. **网格排列**：每个素材单元（图片 + 标签）按从左到右、从上到下的网格排列，单元之间间距至少 **40px**
3. **每个素材单元结构**：
   ```
   ┌─────────────────────┐
   │                     │
   │   图片 frame        │  ← 图片区域，name 设为资产 ID
   │   (cornerRadius:0)  │
   │                     │
   ├─────────────────────┤
   │ 资产ID + 用途说明     │  ← 标签 frame，高度固定 40px
   └─────────────────────┘
   ```
4. **标签与图片必须垂直排列，不得重叠**。标签放在图片**下方 8px 处**，不可放在图片内部
5. **标签样式**：字体 12px，颜色 `#6B7280`（灰色），背景透明。内容格式：`{资产ID} — {用途}`
6. **图片 frame 必须设置 `cornerRadius: 0`**，不可有圆角

**示例（4 列网格，含 9 个素材）**：
```
[icon-home]   [icon-search]  [icon-star]   [icon-plus]
 — 首页图标     — 搜索图标      — 收藏图标      — 新增图标

[bg-card-info] [bg-l1-main]  [ill-empty]   [deco-corner-tl]
 — 卡片背景      — 页面通用背景  — 空状态插画     — 左上装饰
```

##### 7.3.1 节点命名规则（强制）

> **关键**：素材页中每个图片 frame 的 `name` 属性**必须与设计执行方案中的资产 ID 完全一致**，不得使用其他名称。

**原因**：
- 第 7.4 步页面设计时，通过 `batch_get` 按 name 查找资产节点来 `Copy` 实例化，name 不一致会导致找不到
- 第 7.6 步统一去背景时，导出文件名与 name 对应，不一致会导致文件匹配失败

**命名规范**：

| 资产 ID（来自第 6 步） | 素材页节点 name | 正确 ✅ | 错误 ❌ |
|----------------------|----------------|---------|---------|
| bg-l1-main | `bg-l1-main` | `name: "bg-l1-main"` | `name: "背景图"` / `name: "L1背景"` |
| icon-home | `icon-home` | `name: "icon-home"` | `name: "首页图标"` / `name: "icon_Home"` |
| ill-empty | `ill-empty` | `name: "ill-empty"` | `name: "空状态"` / `name: "emptyIllustration"` |

**JS 操作示例**：
```js
// 创建素材单元：图片 frame + 标签 frame
// 图片 frame 的 name 必须匹配资产 ID
img = Insert(materialPageFrame, {
  type: "frame", name: "bg-l1-main",    // ← name 与资产 ID 一致
  width: 375, height: 812,
  cornerRadius: 0,
  fill: { type: "image", ... }
})
// 标签放在图片下方 8px 处，内容为 "bg-l1-main — L1页面通用背景"
label = Insert(materialPageFrame, {
  type: "text", name: "label-bg-l1-main",
  x: img.x, y: img.y + img.height + 8,  // ← 紧贴图片下方，不重叠
  width: img.width, height: 40,
  fontSize: 12, fill: "#6B7280",
  content: "bg-l1-main — L1页面通用背景"
})
```

##### 7.3.2 生图流程

1. 根据第 6 步产出的优先级排序表，**只对填充方式为「背景图片」的资产**执行以下流程
2. 使用 frame + `Generate` 生成占位图片，提示词从设计执行方案 3.4 模板填充
3. 图片背景统一为 `#FFFFFF`（白色），父容器 `cornerRadius: 0`
4. 每个素材按 7.3.1 命名规则设置 `name`
5. 每个素材按 7.3.0 布局规则添加下方标签
6. 纯色资产（如 `bg-nav-top`）**不放入素材页**，直接用色值，无需 AI 生图

> **提示词规范**：AI 生图提示词必须严格遵循 `pencil-mcp-api` §5.3.1 的模板，明确禁止圆角矩形容器、圆角边缘、阴影、投影、发光、渐变等效果，否则抠图后图标四周会残留边框/灰边。

#### 7.3.3 素材页用户确认流程（强制）

> **关键**：素材页生成完成后，**必须**与用户确认所有素材符合要求后才能继续后续页面设计。这是防止批量返工的关键卡点。

**确认流程**：

1. **截图展示**：使用 `get_screenshot` 截取整个素材页，展示给用户查看
2. **告知用户**：

   > "素材页已生成完成，包含 [N] 个图标 + [M] 张插画。请检查以下要点：
   > - 图标是否有圆角矩形背景框（应为无）
   > - 图标边缘是否有阴影/投影（应为无）
   > - 图标是否为扁平 2D 矢量风格
   > - 背景是否为纯白色
   > - 图标内容是否准确表达含义
   > - **节点 name 是否与资产 ID 一致**
   > - **标签文字是否与图片分离、无重叠**
   >
   > 请确认是否符合要求。如需调整，请指出具体问题；确认无误后我将开始设计页面。"

3. **等待用户确认**：用户回复"确认"或"符合要求"等肯定答复后，才可进入 7.4 步骤
4. **若用户反馈问题**：
   - 根据反馈重新生成有问题的素材（调整提示词或重新 Generate）
   - 重新截图展示，再次确认
   - **循环直到用户明确确认所有素材符合要求**
5. **未获确认前不得继续**：在用户确认素材页之前，**禁止**开始设计任何 L1-L4 页面

#### 7.4 按 L1→L4 层级生成页面

> **⛔ 核心铁律**：每页必须走完「设计 → 核对 → 修复 → 再核对」循环，**确认通过后才进入下一页**。不得连续设计多页后批量核对。

**页面生成顺序**：

```
L1 首页 → [核对✓] → L1 其他页 → [核对✓] → L2 列表页 → [核对✓] → L3 详情页 → [核对✓] → L4 弹窗/抽屉
```

##### 7.4.1 单页设计流程

每页执行以下循环，**依次完成两类核对**：

```
① batch_design 设计页面
       ↓
② batch_get + snapshot_layout 读取结构
       ↓
③ 第一轮：对照交互稿核对设计一致性（§A 类，6 项）
       ↓
④ 一致性通过？── 否 → 修复问题 → 回到②
       ↓ 是
⑤ 第二轮：检查布局质量（§B 类，5 项）
       ↓
⑥ 布局通过？── 否 → 修复问题 → 回到②
       ↓ 是
⑦ get_screenshot 保存截图
       ↓
⑧ 进入下一页
```

> **先做 A 类核对（内容对不对），再做 B 类核对（布局好不好）。** A 类不过，B 类免谈——内容错了，布局再精致也没意义。

##### 7.4.2 单页核对清单（每页必检，不可跳过）

###### A 类：设计一致性核对 — 对照交互稿确认内容是否正确

> 打开交互设计稿（`doc/interaction-design.md`），逐项对照生成的页面。

| # | 检查项 | 检查方法 | 错误的典型表现 |
|---|--------|---------|-------------|
| A1 | **页面结构** | 逐区域对比交互稿：页面有几个区域？每个区域包含哪些子元素？层级嵌套是否正确？ | 缺了某个区域 / 多了不该有的区域 / 区域顺序与交互稿不一致 |
| A2 | **文本内容** | 逐行对比交互稿中的文本内容（标题、按钮文字、标签、描述等） | 文字与交互稿不同 / 遗漏某段文字 / 多出不该有的文字 |
| A3 | **组件是否正确复用** | 检查 tab-bar-nav、card-info 等是否通过 `Copy` 从第 6 步组件清单实例化，非重新创建 | 每个页面都新建了相同组件，而非复用 |
| A4 | **颜色值与设计风格文档一致** | `batch_get({resolveVariables: true})` 验证 hex 值，与第 5 步设计风格文档对比 | 颜色偏差 / 用了默认色而非设计系统色 |
| A5 | **素材引用正确** | 检查背景图/图标是否通过 `Copy` 从素材页实例化（引用已生成的资产 ID），非硬编码或重新生成 | 页面中的 bg-l1-main 与素材页中的是不同节点 / 直接用色值而非引用素材 |
| A6 | **弹窗位置** | L4 弹窗/叠层必须是 document 直接子节点，不得嵌套在页面 frame 内 | 弹窗被嵌套在页面里，层级不对 |

###### B 类：布局质量核对 — 检查页面是否有重叠、错乱、歪斜

> 使用 `snapshot_layout` 和 `batch_get` 检查技术层面的布局正确性。

| # | 检查项 | 检查方法 | 错误的典型表现 |
|---|--------|---------|-------------|
| B1 | **布局未坍塌** | `snapshot_layout` 检查所有节点 width/height > 0，`batch_get` 确认无元素尺寸为 0 | 某个区域消失 / 元素高度为 0 / 整块空白 |
| B2 | **内容未被裁剪** | `snapshot_layout` 检查无 `"problems": "clipped"` 标记 | 文字被切断 / 图片只显示一部分 |
| B3 | **无重叠** | `snapshot_layout({maxDepth: 0})` 检查同级 frame 坐标不冲突 | 两个 frame 叠在一起 / 按钮盖住了文字 |
| B4 | **间距正确** | 对比 `gap`/`padding` 值与设计执行方案中的尺寸规范 | 元素贴得太紧(应为 16px 实际 0px) / 间距过大 |
| B5 | **无 emoji** | 逐节点检查无 emoji 字符作为设计元素 | 某个 icon 用了 emoji 而非 AI 生图 |

> **两类核对必须分别执行，A 类全部通过后再执行 B 类。** 参考 `pencil-mcp-api` §八（layout 检查清单）和 §七（常见陷阱表）获取更多细节。

##### 7.4.3 核对不通过的处理

1. 标明未通过的检查项类别和编号（如 "A2: 文本内容不一致"，"B3: 按钮与文字重叠"）
2. 针对问题类型修复：
   - **A 类问题**：重新对照交互稿修改内容、颜色、组件引用
   - **B 类问题**：调整 `Update` 布局属性（坐标/尺寸/间距）、修复裁剪、消除重叠
3. 再次执行「读取 → 核对」循环，从 A 类重新开始
4. **直到 A 类 + B 类全部通过**，才截图保存并进入下一页

##### 7.4.4 每个页面需考虑的状态

- 正常态展示
- 加载态（骨架屏/loading 指示器）
- 空态（无数据时的展示）
- 错误态（错误提示）
- 边缘态（长文本/长列表滚动效果）

**设计约束**（贯穿全程）：
- 不得使用 emoji — 所有图标/素材只能用 AI 生图 + 去背景
- 不得自行绘制 SVG — 全部通过 AI 文生图
- 所有图片统一白色背景（`#FFFFFF`），方便后续抠图
- 图片统一放在 `doc/UXDesign/images/` 目录

#### 7.5 过程中补充素材

在页面生成过程中，如果发现需要新的通用素材或图标：

1. 立即在素材页面中增加对应的占位符
2. 记录该素材的用途和所属页面
3. 暂不处理去背景，等全部页面完成后再统一处理

#### 7.6 统一处理 ICON 背景

所有页面生成完毕后，进入批量去背景流程：

1. **导出**：使用 `export_nodes` 将所有素材页面中的图片节点导出到 `doc/UXDesign/images/` 目录
2. **去背景**：使用 Python Pillow 脚本批量去除白色/绿色背景，生成透明 PNG
   - 白色背景：`target_color=(255, 255, 255)`, threshold=10-30
   - 绿色背景：`target_color=(127, 183, 126)`, threshold=40-60
3. **导入**：将所有透明 PNG 通过 `Update` 更新到对应的节点 fill 引用
4. **确认**：截图确认所有 icon 显示正常

> 具体操作参考 `pencil-mcp-api` 的「5.3 素材图片/ICON 生成流程」

---

### 第 8 步：调优与交付

与用户协作调优，直到用户满意：

1. 展示完整设计稿给用户
2. 根据反馈逐项调整（布局、颜色、间距、字体、图标等）
3. 每次调整后截图确认效果
4. 循环直到用户确认**终稿**
5. 输出标准设计稿，标记 `design.pen` 为最终版本
6. 确认后可交由 `pencil-to-miniprogram` skill 进行代码生成

---

## 注意事项（总纲）

1. **MCP 依赖**：所有设计操作依赖 Pencil MCP，确保 MCP 服务正常运行
2. **UI UX PRO MAX 强制拉取**：生成样图前**必须**先从官方仓库拉取最新版 `ui-ux-pro-max` 获取设计模式，不可跳过
3. **技能引用**：设计灵感参考 `ui-ux-pro-max`（从官方仓库拉取最新版），第 6 步调用 `design-execution-plan` 生成设计执行方案，MCP 操作参考 `pencil-mcp-api`，代码生成参考 `pencil-to-miniprogram`
4. **模板文件创建**：`demo.pen` 和 `design.pen` 必须从 skill 目录下的 `template.pen` 拷贝创建，不可从零新建空文件
5. **demo.pen 独立文件**：样图必须放在 `doc/UXDesign/demo.pen`，**绝不可**写入 `doc/UXDesign/design.pen`。在 `batch_design` 时务必检查 `filePath` 参数
6. **design.pen 确认流程**：第 7 步正式设计前，**必须**告知用户在 Pencil 编辑器中打开 `design.pen`，**等待用户确认**后通过 `get_editor_state` 验证，才可开始设计操作
7. **FindEmptySpace 防重叠**：新建 frame 默认坐标均为 `(0,0)`，多个 frame 会堆叠。**必须**分批调用 `FindEmptySpace` + `Update` 为每个 frame 设置独立位置，完成后用 `snapshot_layout` 验证
8. **emoji 禁令**：任何场景下都不得使用 emoji 作为设计元素
9. **生图必去背景**：所有 AI 生成的图片，最终都必须经过「导出 → 去背景 → 重新导入」流程。生图提示词必须遵循 `pencil-mcp-api` §5.3.1 模板，禁止圆角容器/阴影/渐变
10. **素材页强制确认**：第 7.3 步素材页生成后，**必须**截图展示给用户并等待确认，未获确认前不得进入 7.4 页面设计
11. **先规划后动手**：每个阶段开始前先规划，避免返工
12. **每轮验证**：每步修改后用 `snapshot_layout` + `batch_get` + 截图验证效果
13. **渐进交付**：不要一次性完成所有设计再给用户看，分阶段逐步确认
14. **每页必须核对**：第 7.4 步每页走完设计→核对→修复→再核对循环，11 项清单全通过才进入下一页，禁止连续多页后批量核对