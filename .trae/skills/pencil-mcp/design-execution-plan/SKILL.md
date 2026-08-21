---
name: "design-execution-plan"
description: "设计执行方案生成 — 在正式设计前，预规划所有复用资产和背景填充策略，标准化生图提示词模板。输入设计风格文档+交互设计稿，产出可复用的资产清单+填充决策表+优先级排序。由 pencil-design 第 6 步调用。"
---

# 设计执行方案生成 SKILL

> **定位**：在正式动手设计（SOP 第 7 步）之前，先通览所有页面，**归纳复用组件、规划背景填充策略、标准化生图提示词**，形成一份可执行的设计执行方案。确保设计阶段所有资产可复用、风格统一、不重复生成。

## 一、输入与输出

| 项 | 说明 |
|----|------|
| **输入** | ① 第 5 步产出的**设计风格文档**（含风格类型/色彩系统/字体系统/组件规范/图标规范）<br>② 项目**交互设计稿**（含所有页面交互逻辑和展示逻辑） |
| **输出** | 一份 **{项目名}设计执行方案.md**，写入 `doc/UXDesign/{project-name}-design-execution-plan.md`，含 5 张表 + 1 套决策规则 |

## 二、执行 SOP（5 步）

### 第 1 步：页面总览汇总

从交互设计稿中提取所有页面，标注层级、核心功能、可复用组件、专属元素。

**产出：页面总览表**

| 层级 | 页面名 | 核心功能 | 复用组件 | 专属元素 |
|------|--------|---------|---------|---------|
| L1 | 首页 | 推荐/入口 | tab-bar-nav / card-info | hero-banner |
| L2 | 学习列表 | 课程列表 | tab-bar-nav / list-item-course / nav-bar-top | filter-bar |
| L2 | 收藏列表 | 收藏管理 | tab-bar-nav / list-item-course / nav-bar-top | empty-icon |
| L1 | 我的 | 个人中心 | tab-bar-nav / card-user-profile / nav-bar-top | avatar |

> **命名规则**：语义化小写 + 连字符。如 `tab-bar-nav`、`card-info`、`list-item-course`。

**强制检查点**：
- 交互稿缺失 → 要求用户提供后继续
- 必须穷举交互稿中所有页面，不得遗漏
- 页面名保持与交互稿一致

---

### 第 2 步：复用组件归纳

从页面总览中识别跨页面复用的组件，给出语义化 ID 和出现位置。

**产出：复用组件清单表**

| 组件ID | 组件名 | 类型 | 出现页面 | 设计规范引用 |
|--------|--------|------|---------|-------------|
| tab-bar-nav | 底部导航栏 | 导航 | 所有L1页面 | §组件规范.TabBar |
| nav-bar-top | 顶部导航栏 | 导航 | 首页/学习/我的 | §组件规范.导航栏 |
| card-info | 信息卡片 | 容器 | 首页/学习/我的 | §组件规范.卡片 |
| list-item-course | 课程列表项 | 行 | 学习/收藏 | §组件规范.列表项 |
| card-user-profile | 用户信息卡片 | 容器 | 我的 | §组件规范.卡片 |
| btn-primary | 主按钮 | 按钮 | 所有页面 | §组件规范.按钮 |
| empty-state | 空状态组件 | 容器 | 收藏/搜索 | §组件规范.空状态 |

> **组件ID 命名规则**：语义化 `{类型}-{描述}`，小写+连字符。如 `card-` 前缀表示容器类，`list-item-` 前缀表示行类，`btn-` 前缀表示按钮类，`nav-` 前缀表示导航类。

**强制检查点**：
- 每个组件必须有唯一语义化 ID 和出现页面列表
- 每个组件必须关联到第 5 步设计风格文档中的组件规范

---

### 第 3 步：背景资产规划（核心）

> **这是本 SKILL 的灵魂步骤**。把交互稿中所有"有背景的元素"逐一列出，根据设计风格决定填充方式（纯色/渐变/背景图片），并提前写好每个资产的生图提示词模板。

#### 3.1 填充方式决策规则

| 风格类型 | 全局页面背景 | 容器/卡片背景 | 导航栏/TabBar | 选项卡/分组背景 | 装饰元素 |
|---------|-------------|--------------|--------------|---------------|---------|
| 极简/扁平 | 纯色 | 纯色 | 纯色 | 纯色 | 纯色/无 |
| 毛玻璃 | 纯色+局部模糊 | 半透明白 | 毛玻璃效果 | 半透明 | 纯色 |
| 新拟态 | 同色系纯色 | 凸/凹阴影纯色 | 纯色+阴影 | 纯色 | 阴影 |
| **手绘风** | **背景图片（手绘纹理）** | **背景图片（手绘）** | **背景图片/纯色** | **背景图片** | **手绘插画** |
| **插画风** | **背景图片（插画背景）** | **背景图片（装饰插画）** | **背景图片/纯色** | **背景图片** | **插画元素** |
| Bento | 纯色分块 | 纯色卡片 | 纯色 | 纯色 | 纯色 |
| Brutalism | 高对比纯色 | 纯色+边框 | 纯色 | 纯色 | 几何色块 |

> **核心原则**：
> - **手绘风、插画风**：凡是用户可见的大面积区域，**默认使用背景图片而非纯色**。纯色仅用于小面积功能元素（按钮、标签、分割线、图标底色）。
> - **极简/扁平/毛玻璃/新拟态/Bento/Brutalism**：背景以纯色为主，部分场景可用渐变或毛玻璃叠加。
> - 同一 L1 层级的所有页面**共用同一张背景图**（如首页/学习/我的用同一张 `bg-l1-main`）。
> - 同一类型的卡片/选项卡**共用同一张背景图**（如所有信息卡片用同一张 `bg-card-info`）。

#### 3.2 风格判断（强制步骤，不可跳过）

> **关键**：填写背景资产清单表之前，**必须先从第 5 步设计风格文档中读取用户选定的风格类型**，然后在 3.1 决策规则表中查找该风格对应的填充方式。**不得假设任何填充方式**。

**执行步骤**：

1. **读取第 5 步产出**：打开 `doc/UXDesign/{project-name}-design-style.md`，找到「设计风格」→「风格类型」字段
2. **匹配决策规则**：在 3.1 表中定位该风格对应的行
3. **对每个待规划的背景元素**，在决策表中找到对应列（全局页面背景 / 容器卡片背景 / 导航栏TabBar / 选项卡分组背景 / 装饰元素），交叉定位填充方式
4. **判断结果示例**：

| 如果风格类型是 | 全局页面背景填充 | 容器/卡片背景填充 | 装饰元素填充 |
|-------------|---------------|-----------------|------------|
| **手绘风** | 背景图片 | 背景图片 | 手绘插画（背景图片） |
| **插画风** | 背景图片 | 背景图片 | 插画元素（背景图片） |
| **极简/扁平** | 纯色 | 纯色 | 无或纯色 |
| **毛玻璃** | 纯色+局部模糊 | 半透明白 | 纯色 |
| **新拟态** | 同色系纯色 | 凸/凹阴影纯色 | 阴影 |
| **Bento** | 纯色分块 | 纯色卡片 | 纯色 |
| **Brutalism** | 高对比纯色 | 纯色+边框 | 几何色块 |

> **⛔ 强制检查点**：填充方式必须严格按 3.1 决策表逐行决策，不得在决策前预判任何行的填充方式。

#### 3.3 背景资产清单表

> **关键**：逐项遍历交互稿中所有出现背景的元素，不得遗漏。每个资产必须标注唯一的语义化 ID、尺寸、填充方式（由 3.2 步决策得出）、复用页面。生图提示词模板在 3.4 节统一提供。

> **以下为两种典型风格的填写示例，实际填写时根据 3.2 步的决策结果逐行确定**：

**示例 A — 手绘风格**（大面积需要 AI 生图）：

| 资产ID | 资产名 | 所属组件 | 填充方式 | 尺寸(px) | 复用页面 | 优先级 |
|--------|--------|---------|---------|---------|---------|--------|
| bg-l1-main | L1页面通用背景 | 所有L1页面框架 | 背景图片 | 375×812 | 首页/学习/我的 | P0 |
| bg-card-info | 信息卡片背景 | card-info | 背景图片 | 343×120 | 首页/学习/我的 | P1 |
| bg-option-tab | 选项卡背景 | option-tabs | 背景图片 | 343×48 | 学习 | P1 |
| bg-nav-top | 顶部导航栏背景 | nav-bar-top | 背景图片/纯色 | 375×96 | 所有页面 | P1 |
| bg-tab-bar | 底部TabBar背景 | tab-bar-nav | 背景图片/纯色+毛玻璃 | 375×84 | 所有L1 | P1 |
| deco-corner-tl | 左上角装饰 | L1页面装饰 | 背景图片 | 120×120 | 首页 | P4 |

**示例 B — 极简/扁平风格**（全部纯色，无需 AI 生图）：

| 资产ID | 资产名 | 所属组件 | 填充方式 | 色值 | 尺寸(px) | 复用页面 | 优先级 |
|--------|--------|---------|---------|------|---------|---------|--------|
| bg-l1-main | L1页面通用背景 | 所有L1页面框架 | 纯色 | #F8FAFC | 375×812 | 首页/学习/我的 | P0 |
| bg-card-info | 信息卡片背景 | card-info | 纯色 | #FFFFFF | 343×120 | 首页/学习/我的 | P1 |
| bg-option-tab | 选项卡背景 | option-tabs | 纯色 | #F1F5F9 | 343×48 | 学习 | P1 |
| bg-nav-top | 顶部导航栏背景 | nav-bar-top | 纯色 | #FFFFFF | 375×96 | 所有页面 | P1 |
| bg-tab-bar | 底部TabBar背景 | tab-bar-nav | 纯色 | #FFFFFF | 375×84 | 所有L1 | P1 |
| deco-corner-tl | 左上角装饰 | — | 无 | — | — | — | — |

> **关键区别**：极简/扁平风格下，填充方式均为「纯色」，表格增加「色值」列（从第 4 步配色资产表提取），**不产生任何 AI 生图提示词**。

> **资产ID 命名规则**：
> - `bg-{范围}-{描述}` — 背景图/背景色
> - `ill-{场景}` — 场景插画
> - `deco-{位置}` — 装饰元素（tl=左上, tr=右上, bl=左下, br=右下）
> - `icon-{功能}` — 功能图标（提示词模板见 3.4 模板 B）
> - 全部小写 + 连字符，语义清晰 AI 可以直接理解

#### 3.4 生图提示词模板

> **⛔ 守卫规则**：**仅填充方式为「背景图片」的资产才需要生图提示词**。填充方式为「纯色」的资产直接填入色值（从配色资产表提取），不走 AI 生图流程。在填写提示词前，先检查 3.3 表中的填充方式列，跳过所有标记为「纯色」「无」「渐变」的行。

> **关键**：每个需要 AI 生图的资产，必须提前写好提示词模板。模板分为 **可变部分**（从设计系统提取）和 **固定部分**（硬编码，不可修改）。
>
> **固定部分的核心要求**：
> - 背景图片：画面必须铺满全屏（filling entire canvas），四周不得留空，中间留白用于内容，装饰元素以点缀为主稀疏分布，视觉上清爽简洁不花哨
> - 图标/装饰图标：纯色背景、不带任何边框和阴影、不带圆角矩形容器、扁平2D矢量风格
> - 所有生图：白色背景 `#FFFFFF`、无阴影/投影/发光/渐变/边框、边缘干净利于抠图

##### 模板 A：背景图片（页面/卡片/选项卡背景）

```
{STYLE_DESCRIPTION}, {COLOR_SCHEME}, aspect ratio {W}:{H}, resolution {W}x{H} pixels, decorative elements filling all four borders and edges of the entire canvas, center area left empty for content placement, decorative elements sparse and light, visually clean and simple, NOT busy, solid #FFFFFF pure white background filling entire canvas, NO drop shadow, NO rounded frame, NO border, NO 3D effects, clean crisp edges for background removal
```

| 占位符 | 来源 | 示例 |
|--------|------|------|
| `{STYLE_DESCRIPTION}` | 设计风格文档 | `hand-drawn sketch style with crayon texture, warm and playful` |
| `{COLOR_SCHEME}` | 设计风格文档 §色彩系统 | `soft warm pastel colors, low saturation, warm beige and cream tones` |
| `{W}` | 背景资产清单表 §尺寸 | `375` |
| `{H}` | 背景资产清单表 §尺寸 | `812` |

##### 模板 B：功能图标（icon-*）

```
a single flat icon of {ICON_DESCRIPTION}, {ICON_STYLE}, single solid {PRIMARY_COLOR} color, aspect ratio 1:1, resolution {SIZE}x{SIZE} pixels, square canvas, no background container, no border box, solid #FFFFFF pure white background filling entire canvas, centered with minimal padding, NO shadow, NO drop shadow, NO glow, NO gradient, clean crisp edges for background removal
```

| 占位符 | 来源 | 示例 |
|--------|------|------|
| `{ICON_DESCRIPTION}` | 交互稿中的图标功能 | `a baby bottle` / `a search magnifying glass` |
| `{ICON_STYLE}` | 设计风格文档 §图标规范 | `soft rounded flat 2D vector icon style, gentle and warm` |
| `{PRIMARY_COLOR}` | 设计风格文档 §色彩系统.主色 | `#EA580C` |
| `{SIZE}` | 背景资产清单表 §尺寸(取宽) | `64` |

##### 模板 C：场景插画（ill-* / deco-*）

```
a flat illustration of {SCENE_DESCRIPTION}, {ILLUSTRATION_STYLE}, {ILLUSTRATION_COLORS}, aspect ratio {W}:{H}, resolution {W}x{H} pixels, solid #FFFFFF pure white background filling entire canvas, centered, NO drop shadow, NO rounded frame, NO border, NO 3D effects, clean crisp edges for background removal
```

| 占位符 | 来源 | 示例 |
|--------|------|------|
| `{SCENE_DESCRIPTION}` | 交互稿中的场景描述 | `a person reading a book on a cozy sofa` |
| `{ILLUSTRATION_STYLE}` | 设计风格文档 §设计风格 | `soft rounded flat 2D vector illustration style, gentle and warm` |
| `{ILLUSTRATION_COLORS}` | 设计风格文档 §色彩系统 | `warm orange and soft pastel colors, matching #EA580C primary tone` |
| `{W}` | 背景资产清单表 §尺寸(宽) | `200` |
| `{H}` | 背景资产清单表 §尺寸(高) | `200` |

##### 模板使用示例（填充后的完整提示词）

**bg-l1-main（手绘风格 L1 页面背景，375×812）**：
```
hand-drawn sketch style with crayon texture, warm and playful, soft warm pastel colors, low saturation, warm beige and cream tones, aspect ratio 375:812, resolution 375x812 pixels, decorative elements filling all four borders and edges of the entire canvas, center area left empty for content placement, decorative elements sparse and light, visually clean and simple, NOT busy, solid #FFFFFF pure white background filling entire canvas, NO drop shadow, NO rounded frame, NO border, NO 3D effects, clean crisp edges for background removal
```

**icon-home（手绘风格首页图标，64×64）**：
```
a single flat icon of a house home, hand-drawn sketch icon style, warm and playful, single solid #EA580C warm orange color, aspect ratio 1:1, resolution 64x64 pixels, square canvas, no background container, no border box, solid #FFFFFF pure white background filling entire canvas, centered with minimal padding, NO shadow, NO drop shadow, NO glow, NO gradient, clean crisp edges for background removal
```

**ill-empty（手绘风格空状态插画，200×200）**：
```
a flat illustration of a person looking at an empty shelf with a confused expression, soft rounded flat 2D vector illustration style, gentle and warm, warm orange and soft pastel colors, matching #EA580C primary tone, aspect ratio 1:1, resolution 200x200 pixels, solid #FFFFFF pure white background filling entire canvas, centered, NO drop shadow, NO rounded frame, NO border, NO 3D effects, clean crisp edges for background removal
```

**强制检查点**：
- 背景资产清单表必须穷举交互稿中所有出现背景的元素
- 每个背景资产必须有唯一语义化 ID + 精确尺寸(px) + 复用页面列表
- **手绘/插画风格**的背景资产，填充方式必须标记为「**背景图片**」，不可标记为「纯色」
- 每行背景资产的提示词模板必须按 3.4 模板 A/B/C 生成，固定部分不可修改
- 同类复用资产必须合并为单一资产（如所有 L1 页面共用 `bg-l1-main`），禁止每页单独生成
- 尺寸必须精确匹配 UI 元素的实际尺寸，不可估算或写死固定值

---

### 第 4 步：配色资产标准化

将设计风格文档中的颜色，按用途拆分为可引用的配色资产。

> **说明**：配色资产大部分是「纯色填充」而非 AI 生图。这些色值在第 7 步设计时直接引用，不需要走图片生成流程。

**产出：配色资产清单表**

| 资产ID | 用途 | 色值 | 来源 | 复用对象 |
|--------|------|------|------|---------|
| color-primary | 主色 | #EA580C | 设计风格文档 §色彩系统.主色 | 主按钮/选中态/强调文字 |
| color-secondary | 辅色 | #F59E0B | 设计风格文档 §色彩系统.辅色 | 辅按钮/标签/高亮 |
| color-bg-page | 页面背景色 | #FFF8F0 | 设计风格文档 §色彩系统.背景 | 所有纯色背景页面 |
| color-bg-card | 卡片底色 | #FFFFFF | 设计风格文档 §色彩系统.背景 | 白色卡片 |
| color-text-primary | 主文字色 | #1A1A2E | 设计风格文档 §色彩系统.文字 | 标题/正文 |
| color-text-secondary | 辅助文字色 | #6B7280 | 设计风格文档 §色彩系统.文字 | 说明/时间戳 |
| color-divider | 分割线 | #E5E7EB | 设计风格文档 §色彩系统.其他 | 列表分割/区块分割 |
| color-bg-nav | 导航栏背景 | #FFFFFF | 背景资产清单表 bg-nav-top | 顶部导航栏 |
| color-bg-tab-bar | TabBar背景 | #FFFFFFCC | 背景资产清单表 bg-tab-bar | 底部TabBar |

> **资产ID 命名规则**：`color-{用途描述}`，小写+连字符。色值含透明度时用 8 位 hex（如 `#FFFFFFCC`）。

**强制检查点**：
- 每个颜色资产必须有精确 hex 值，不可写「白色」「灰色」等模糊描述
- 色值来源必须可追溯（设计风格文档 或 背景资产清单表）

---

### 第 5 步：资产生成优先级排序

按影响范围从大到小排序，第 7 步正式设计时按此顺序逐一生成。

**产出：优先级排序表**

| 优先级 | 资产类别 | 资产列表 | 生成方式 | 说明 |
|--------|---------|---------|---------|------|
| P0 | 全局页面背景 | bg-l1-main | **取决于填充方式**：背景图片→AI 生图，纯色→色值赋值 | 影响所有 L1 页面，必须最先定稿 |
| P1 | 通用容器背景 | bg-card-info / bg-option-tab | **取决于填充方式**：背景图片→AI 生图，纯色→色值赋值 | 跨页面复用，定稿后所有页面共用 |
| P1 | 通用组件配色 | bg-nav-top / bg-tab-bar | 纯色赋值 | 全局导航/TabBar，最先确定 |
| P2 | 功能图标 | icon-* 全部 | AI 生图→去背景 | 统一批次生成，保证风格一致 |
| P2 | 通用组件色值 | color-* 全部 | 纯色赋值 | 按钮/文字/分割线颜色 |
| P3 | 页面专属背景 | bg-card-user / deco-* | **取决于填充方式**：背景图片→AI 生图，纯色/无→跳过 | 仅特定页面使用 |
| P4 | 场景插画 | ill-empty / ill-guide | AI 生图→去背景 | 仅填充方式为背景图片时生成 |

**强制检查点**：
- P0 必须最先执行，P0 不定稿不得进入 P1
- 所有 icon-* 图标必须在**同一批次**生成，保证风格一致
- 背景图片资产按 P0→P1→P3 顺序逐一生成，不可并行（AI 风格会波动）

---

## 三、输出产物

执行完成后，生成 `doc/UXDesign/{project-name}-design-execution-plan.md`，内容必须包含以上全部 5 张表 + 决策规则。

## 四、与第 7 步正式设计的衔接

第 7 步正式设计时，AI 严格执行以下原则：

| 阶段 | 规则 |
|------|------|
| 7.2 设计系统页 | 色板直接引用配色资产清单表，不另行定义 |
| 7.3 素材页 | 按资产生成优先级表逐一处理：**填充方式为「背景图片」的资产**用 3.4 模板生成提示词→AI 生图；**填充方式为「纯色」的资产**直接填色值，跳过 AI 生图 |
| 7.4 页面设计 | 背景引用已生成的资产 ID（如 `bg-l1-main`），**禁止**重新生成；纯色背景直接从配色资产表取色值 |
| 7.4 组件实例 | 复用组件从第 2 步组件清单直接 `Copy` 实例化 |

## 五、强制检查点（总汇）

| # | 检查点 | 说明 |
|---|--------|------|
| 1 | 交互稿必入 | 交互设计稿缺失 → 要求用户提供，中止等待 |
| 2 | 页面穷举 | 页面总览表必须包含交互稿中所有页面，不得遗漏 |
| 3 | 语义化命名 | 所有组件 ID / 资产 ID 使用语义化小写连字符命名，AI 可直观理解 |
| 4 | 风格判断不可跳过 | 填写 3.3 表前必须先执行 3.2 风格判断：读取第 5 步设计风格文档 → 匹配 3.1 决策表 → 逐行确定填充方式。禁止假设任何行的填充方式 |
| 5 | 纯色守卫 | **仅填充方式为「背景图片」的资产才生成 AI 提示词**；纯色资产直接填色值，不走 AI 生图 |
| 6 | 资产合并去重 | 同类复用资产（如同类卡片、同层级页面背景）必须合并为单一资产 |
| 7 | 尺寸精确 | 每个背景资产必须标注精确 px 尺寸，不可估算 |
| 8 | 提示词分可变/固定 | 每个生图提示词模板必须分离可变部分与固定部分，固定部分不可修改 |
| 9 | 优先级排序 | 资产生成优先级表必须 P0→P4 排列，P0 不定稿不得进入 P1 |
| 10 | 图标统一批次 | 所有功能图标必须标注为同一生成批次 |
| 11 | 输出完整 | 最终输出 .md 文件必须含全部 5 张表 + 决策规则 |
