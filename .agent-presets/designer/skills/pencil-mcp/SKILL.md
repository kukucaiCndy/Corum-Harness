---
name: "pencil-mcp"
description: "Pencil MCP 视觉设计技能合集 — 从设计灵感到像素级还原再到小程序代码生成的端到端工作流。包含设计 SOP、MCP API 参考、UI/UX 智能引擎、设计执行方案、设计稿转代码五个子技能。"
---

# Pencil MCP 技能合集 — 总目录

> 本目录为 Pencil MCP 视觉设计体系的**总入口**，由 5 个分工明确的子技能组成，覆盖从「设计灵感获取 → 视觉设计 → 代码落地」的完整链路。

## 子技能一览

| 子技能 | 定位 | 触发场景 | 文档 |
|--------|------|---------|------|
| **ui-ux-pro-max** | 设计灵感引擎 | 需要风格/配色/字体/UX 准则推荐，或在生成样图前获取 5 种设计模式 | [SKILL.md](./ui-ux-pro-max/SKILL.md) |
| **pencil-design** | 设计 SOP 总入口 | 需要在 Pencil MCP 中创建 .pen 设计稿、走 8 步标准设计流程 | [SKILL.md](./pencil-design/SKILL.md) |
| **design-execution-plan** | 设计执行方案生成 | 第 6 步调用：归纳复用组件、规划背景填充策略、标准化生图提示词 | [SKILL.md](./design-execution-plan/SKILL.md) |
| **pencil-mcp-api** | MCP 工具 API 参考 | 需要查询 batch_design / batch_get 等 MCP 工具的用法、设计模式、图标规范、常见陷阱 | [SKILL.md](./pencil-mcp-api/SKILL.md) |
| **pencil-to-miniprogram** | 设计稿转代码 | 需要将 .pen 设计稿 1:1 还原为微信小程序 WXML+WXSS+JS 代码 | [SKILL.md](./pencil-to-miniprogram/SKILL.md) |

## 能力地图

### 1. ui-ux-pro-max — 设计灵感引擎

**核心能力**：基于 50+ 风格、161 套配色、57 套字体搭配、161 种产品类型、99 条 UX 准则、25 种图表类型，提供带推理规则的设计系统推荐。

- 输入产品类型 + 关键词 → 输出完整设计系统（风格、配色、字体、效果、反模式）
- 支持按 domain 检索：`style` / `color` / `typography` / `product` / `landing` / `chart` / `ux` / `google-fonts` / `react` / `web` / `prompt`
- 支持 `--design-system` 一键生成完整设计系统，支持 `--persist` 落地为 MASTER.md + 页面级覆盖
- 含 10 大优先级规则类目（无障碍/触控/性能/风格选择/布局/排版配色/动画/表单/导航/图表）

### 2. pencil-design — 设计 SOP 总入口

**核心能力**：8 步标准设计 SOP，在 Pencil MCP 中产出可交付的 .pen 设计稿。

```
① 检查 MCP + 创建文件 + 确认打开 demo.pen  →  ② 询问风格偏好  →  ③ 拉取灵感 + 生成 5 套样图
→  ④ 用户确认风格  →  ⑤ 生成设计风格文档  →  ⑥ 生成设计执行方案
→  ⑦ 正式设计（系统页/素材页/L1-L4 页面/去背景）  →  ⑧ 调优交付
```

关键约束：
- 样图写入 `demo.pen`，正式稿写入 `design.pen`，二者不可混用
- 从 `template.pen` 模板拷贝创建，不可从零新建
- 禁止 emoji，所有图标/素材走「AI 生图 → 导出 → 去背景 → 重新导入」流程
- 素材页生成后强制用户确认，未确认前不得进入页面设计

### 3. design-execution-plan — 设计执行方案生成

**核心能力**：在正式设计前预规划所有复用资产和背景填充策略，标准化生图提示词。

- 输入 第 5 步设计风格文档 + 交互设计稿 → 输出 5 张表（页面总览 / 复用组件 / 背景资产 / 配色资产 / 优先级）+ 决策规则
- 核心决策：根据设计风格（手绘/插画/极简等）决定每个元素的填充方式（纯色/渐变/背景图片）
- 手绘风/插画风的大面积背景强制使用背景图片，纯色仅用于小面积功能元素
- 每个资产生图提示词分离「可变部分」（风格/色彩/尺寸）和「固定部分」（白底/无阴影/无边框/全铺满/不花哨）
- 语义化命名（`bg-l1-main` / `icon-home` / `ill-empty`），AI 可直接理解

### 4. pencil-mcp-api — MCP 工具 API 参考

**核心能力**：Pencil MCP 9 个工具的完整 API 参考，由 `pencil-design` 按需引用。

- **工具列表**：`get_editor_state` / `get_guidelines` / `batch_get` / `batch_design` / `snapshot_layout` / `get_screenshot` / `get_variables` / `set_variables` / `export_nodes`
- **batch_design 函数**：`Insert` / `Copy` / `Update` / `Replace` / `Move` / `Delete` / `Generate` / `FindEmptySpace`
- **核心设计模式**：布局转换（absolute→flexbox）、批量属性替换、组件实例（ref）、Copy+Replace 页面创建、模态框/弹窗
- **图标规范**：Lucide 图标库已验证可用列表 + 图标容器最佳实践
- **素材生图提示词公式**：图标 / 背景装饰 / 场景插画三类固定公式，含分辨率动态计算规范
- **去背景工具链**：`remove_bg.py`（白/绿背景去除）+ `crop_pad.py`（边缘伪影裁剪补偿）
- **11 条常见陷阱表** + **layout 检查清单** + **效率建议**

### 5. pencil-to-miniprogram — 设计稿转小程序代码

**核心能力**：将 .pen 设计稿 1:1 像素级还原为微信小程序代码。

```
① 读取设计稿 → ② 提取关键信息 → ③ 编写 WXML → ④ 编写 WXSS → ⑤ 对接 JS → ⑥ 走查验证
```

关键规范：
- px → rpx 换算：`1px = 2rpx`（基于 375px 设计宽度）
- 阴影换算：offset×2, blur×2，颜色透明度按 hex alpha→rgba 对照表
- `<image>` 标签替代 WXSS background-image（小程序限制）
- 必须生成「间距交叉计算表」用 snapshot_layout 精确计算 gap，禁止目测估算
- 图标决策树：lucide 矢量图标必须 `export_nodes` 导出 PNG，禁止用 emoji 或通用装饰图替代
- scroll-view 高度不可用 `flex:1` 或 `calc(vh-rpx)`，改用绝对定位方案

## 全新设计标准 SOP（8 步摘要）

> 本 SOP 是 `pencil-design` 子技能的**权威执行流程**。此处仅提供每步摘要，**详细命令、代码示例、模板和注意事项请查阅 [`pencil-design/SKILL.md`](./pencil-design/SKILL.md)**。

| 步骤 | 目标 | 关键输出 | 强制检查点 |
|------|------|---------|-----------|
| [① 检查 MCP + 创建文件 + 确认打开 demo.pen](./pencil-design/SKILL.md#第-1-步检查-pencil-mcp-就绪状态--创建设计文件--确认打开-demopen) | 确认 MCP 可用，从 template.pen 拷贝创建 demo.pen 和 design.pen | demo.pen（已确认打开）+ design.pen + images/ 目录 | MCP 不可用则中止；拷贝后必须停止等待用户确认打开 demo.pen |
| [② 询问设计风格偏好](./pencil-design/SKILL.md#第-2-步询问设计风格偏好) | 从 7 个维度（色彩/风格/字体/圆角/间距/灵感/品牌）对齐设计方向 | 结构化风格摘要 | 未收集到明确风格偏好前不得进入第 3 步 |
| [③ 拉取灵感 + 生成 5 套样图](./pencil-design/SKILL.md#第-3-步拉取最新-ui-ux-pro-max--生成样图) | 拉取 ui-ux-pro-max 获取 5 种设计模式，在 demo.pen 生成 5 套样图 | demo.pen 中 5 套样图 + 5 张截图 | ui-ux-pro-max 必须从官方仓库拉取；filePath 必须指向 demo.pen；FindEmptySpace 分批防重叠 |
| [④ 用户确认风格](./pencil-design/SKILL.md#第-4-步用户确认风格) | 通过样图反馈循环锁定最终设计方向 | 最终选定的设计方向 | 用户未明确确认前不得进入第 5 步 |
| [⑤ 生成设计风格文档](./pencil-design/SKILL.md#第-5-步生成本项目设计风格文档) | 将选定风格固化为项目级设计风格文档 | `doc/UXDesign/{project-name}-design-style.md` | 必须含具体 hex 值和 px 值，不可只写描述 |
| [⑥ 生成设计执行方案](./pencil-design/SKILL.md#第-6-步生成设计执行方案) | 结合设计风格文档和交互稿，预规划复用资产和背景填充策略 | `doc/UXDesign/{project-name}-design-execution-plan.md`（5 张表 + 提示词模板） | 严格按照 [design-execution-plan SKILL](./design-execution-plan/SKILL.md) 执行；手绘/插画风大面积背景必须用背景图片 |
| [⑦ 正式设计](./pencil-design/SKILL.md#第-7-步开始设计) | 在 design.pen 中完成设计系统页 + 素材页 + L1-L4 页面 + 去背景 | design.pen 完整设计稿 | 7.0 用户确认打开 design.pen；7.3 素材页强制确认后才进入 7.4 |
| [⑧ 调优与交付](./pencil-design/SKILL.md#第-8-步调优与交付) | 与用户协作调优到终稿 | 终稿 design.pen | 用户未确认终稿前不得交付或转入代码生成 |

### SOP 全局红线

| # | 红线 | 说明 |
|---|------|------|
| 1 | MCP 依赖 | 所有设计操作依赖 Pencil MCP，不可用则中止 |
| 2 | ui-ux-pro-max 强制拉取 | 生成样图前必须从官方仓库拉取最新版，不可跳过 |
| 3 | template.pen 拷贝创建 | `demo.pen` / `design.pen` 必须从模板拷贝，不可从零新建 |
| 4 | demo / design 不可混用 | 样图操作指向 `demo.pen`，正式设计指向 `design.pen` |
| 5 | design.pen 确认流程 | 第 7 步前必须用户确认打开 + `get_editor_state` 验证 |
| 6 | FindEmptySpace 防重叠 | 新建 frame 必须分批找空位 + Update，`snapshot_layout` 验证 |
| 7 | emoji 禁令 | 任何场景不得使用 emoji 作为设计元素 |
| 8 | 生图必去背景 | 所有 AI 生图走「导出 → 去背景 → 裁剪补偿 → 重新导入」 |
| 9 | 素材页强制确认 | 第 7.3 步素材页未获确认前不得进入页面设计 |
| 10 | 渐进交付 | 分阶段逐步确认，不一次性完成所有设计再给用户看 |
| 11 | 每页强制核对 | 第 7.4 步每页走设计→核对→修复循环，11 项清单全通过才进下一页，禁止批量核对 |

---

## 协作关系

```
用户需求
   │
   ▼
[ui-ux-pro-max] ──提供设计系统──┐
   │                            │
   ▼                            ▼
[pencil-design] ── 第6步调用 ──► [design-execution-plan]
   │                            （资产预规划 + 提示词模板）
   │
   ▼ 调用 MCP 工具
[pencil-mcp-api]
   │（API 参考/陷阱速查）
   ▼ 产出 .pen 设计稿
[pencil-to-miniprogram] ──1:1 还原──► 微信小程序代码
```

## 何时使用哪个子技能

| 用户意图 | 调用子技能 |
|---------|-----------|
| "帮我设计一个 App 的风格" / "推荐配色方案" | ui-ux-pro-max |
| "帮我画设计稿" / "在 Pencil 里设计页面" | pencil-design（内部会拉取 ui-ux-pro-max，第 6 步调用 design-execution-plan） |
| "规划设计资产" / "哪些背景需要生图" / "背景图用纯色还是图片" | design-execution-plan |
| "batch_design 怎么用" / "图标生图提示词怎么写" | pencil-mcp-api |
| "把这个设计稿转成小程序代码" | pencil-to-miniprogram |
| "设计稿里图标怎么处理" | pencil-mcp-api §5 + pencil-to-miniprogram 图标决策树 |

## 目录结构

```
pencil-mcp/
├── SKILL.md                          # 本文件（总目录）
├── ui-ux-pro-max/                    # 设计灵感引擎
│   ├── SKILL.md
│   ├── data/                         # CSV 数据库（风格/配色/字体/产品/UX/chart）
│   ├── scripts/                      # search.py 检索脚本
│   └── templates/                    # 设计系统模板
├── pencil-design/                    # 设计 SOP 总入口
│   ├── SKILL.md
│   └── template.pen                  # .pen 模板文件（拷贝创建 demo/design.pen）
├── design-execution-plan/            # 设计执行方案生成（第 6 步调用）
│   └── SKILL.md
├── pencil-mcp-api/                   # MCP API 参考
│   ├── SKILL.md
│   ├── remove_bg.py                  # 通用去背景脚本
│   └── crop_pad.py                   # 边缘伪影裁剪补偿脚本
└── pencil-to-miniprogram/            # 设计稿转小程序代码
    └── SKILL.md
```
