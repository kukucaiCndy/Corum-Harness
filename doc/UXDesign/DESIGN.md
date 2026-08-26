# 矩道 Corum Harness — 设计交付（单一权威文档）

> 本文档是 corum 桌面端设计的**唯一事实源**，整合了设计规范（token/字体/组件/布局）、动效规范、设计稿读取方法（HANDOFF）与设置中心设计。
> 配套设计稿：`doc/UXDesign/design.pen`（正式稿）/ `demo.pen`（样图试稿）。图片资产在 `doc/UXDesign/images/`。
> 历史过程稿 `corum-harness-design-execution-plan.md` 已删除（基于早期 Modern Dark 风格，与现行液态玻璃架构脱节）。

> **⚠️ 关键变更记录**：
> - **2026-08-21**：⑦ 状态栏整体移除；L1 顶部新增 40px「窗口标题栏」（macOS 红绿灯让位 84 + 右侧设置齿轮）。设置入口 = 标题栏齿轮，设置面板由 ide-shell 自建 SettingsShell 提供（portal 到 body），官方 `ui-settings-general` 已禁用。
> - **2026-08-23**：新增「设置中心」44 页设计（22 设置页 × 深浅双版），见 §8。
> - **2026-08-25**：侧栏改造为「双模式」——① 项目导航 内置 任务模式（默认：新建会话 + 会话列表）/ 项目模式（空态 → 打开/新建项目 → 项目详情 · 可关闭）切换（brand 右侧 `mode-switch`，内容区反转动画）；侧边栏**不可关闭**（移除 region-actions）；L2 页重写为 4 态交互流程。见 §4.2 / §5 / §6 / §7.10。
> - **2026-08-25**：标题栏新增两个快捷键按钮——`⌘⇧E` 显示/隐藏 编辑器区+资源管理器、`⌘J` 显示/隐藏 终端面板（浮动终端）；按钮置于 titlebar-actions 最左，带键位提示（icon + 7px 键位文字）。见 §5。
> - **2026-08-25**：「打开项目」对**空目录**进入「项目创建向导」（L2 新增「项目创建向导」两页，深浅双版：主流程 ①②③ + 触发与补充 ⓪②′④）：⓪ 目录选择（已有项目自动加载 / 空目录进入向导）→ ① 基本信息·项目命名 → ② 团队与成员（整队/部分成员勾选）→ ②′ 添加成员浮层 → ③ 创建完成 → ④ 创建中加载 → 项目详情。见 §4.2 / §5 / §7.3。

---

## 0. 设计风格

- **风格类型**：液态玻璃 Liquid Glass（环境光斑 + 半透明模糊卡片 + 光边描边）
- **核心关键词**：圆润、玻璃质感、环境光、霓虹点缀、现代梦幻
- **品牌气质**：「立矩成道」—— 方中带圆，框架（矩）与流动（道）结合
- **品牌**：矩道 Corum Harness / 立矩成道，Agent 成团开发 / Corum Harness: Agent Dev Team, Harnessed.
- **主题**：三态 `light / dark / system`（深色 = 蒸汽波配色，浅色 = 高反差白配色）

---

## 1. 色彩系统（语义化 token，深浅双主题）

> **所有颜色必须用 CSS 变量 / 主题 token，禁止写死 hex。** 切主题只换 token 值，不换结构。实现沿 DSH 官方 `--dsw-alias-*` 体系，或 `[data-theme="dark"]` 切换。

### 1.1 背景层（含环境光斑）

| Token | 浅色（高反差白） | 深色（蒸汽波） | 用途 |
|---|---|---|---|
| `bg-base` | `#E9E9F2` | `#0D0817` | 窗口底色（光斑载体） |
| `bg-deep` | `#DDDCE8` | `#0A0612` | 最深层底色 |
| `glow-1` | `#B8C6FF` @70% | `#FF71CE` @25% | 环境光斑 1（左上） |
| `glow-2` | `#FFC2E0` @65% | `#01CDFE` @22% | 环境光斑 2（右侧） |
| `glow-3` | `#C0F2E8` @60% | `#FF9E6B` @18% | 环境光斑 3（底部） |

> 光斑为大尺寸柔边圆（ellipse + opacity），叠在 `bg-base` 上，玻璃卡片再叠其上透出光。深色下光斑不透明度压低至 18-25%，避免压过卡片层次。

### 1.2 玻璃卡片层

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `glass-1` | `#FFFFFFE6` | `#1D112BD9` | 主卡片（消息/列表） |
| `glass-2` | `#FFFFFFCC` | `#2A1840D9` | 抬升卡（选中/输入框/工具条） |
| `glass-3` | `#FFFFFFB3` | `#372050CC` | 更高抬升（hover/浮层） |
| `glass-border` | `#FFFFFF` | `#B98CFF2E` | 玻璃描边（光边） |
| `glass-border-active` | `#5B21F5` | `#01CDFE` | 激活描边 |

### 1.3 文字层级

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `label-primary` | `#0E0E1C` | `#F3ECFF` | 正文/标题 |
| `label-secondary` | `#5C5C77` | `#B3A6D9` | 次要/时间戳 |
| `label-tertiary` | `#8B8BA3` | `#7E719E` | 辅助说明 |
| `label-dimmed` | `#B9B9C9` | `#55486F` | 禁用/最弱 |
| `label-on-brand` | `#FFFFFF` | `#0A0612` | 品牌色上的文字 |

### 1.4 品牌色

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `brand-primary` | `#5B21F5` 电紫 | `#01CDFE` 霓虹青 | 主按钮/激活/链接 |
| `brand-accent` | `#F5276C` 品红 | `#FF71CE` 霓虹粉 | slogan/强调/状态点 |
| `brand-text` | `#5B21F5` | `#4DE3FF` | 品牌文字（深色提亮） |

> slogan 与品牌副标统一用 `brand-accent`。

### 1.5 状态色

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `state-error` | `#E0245E` | `#FF5C8A` | 错误/删除/diff 删除 |
| `state-success` | `#0BA57C` | `#3EE6B0` | 成功/完成/diff 新增 |
| `state-warn` | `#E07A00` | `#FFB45C` | 等待/警告/dirty |
| `state-running` | `#5B21F5` | `#01CDFE` | 运行中（= brand-primary） |
| `state-idle` | `#9AA0B5` | `#6E6392` | 空闲 |

### 1.6 会话状态点

| 状态 | 颜色 |
|---|---|
| 运行中 | `brand-primary` |
| 等待用户 | `state-warn` |
| 完成未读 | `state-success` |
| 空闲 | `state-idle` |

> **对比度**：浅色玻璃卡片上用 `#0E0E1C` 文字 ≥ 12:1；深色玻璃卡片用 `#F3ECFF` ≥ 10:1。品牌按钮文字用 `label-on-brand`。

### 1.7 液态玻璃实现

```css
.glass-card {
  background: var(--glass-1);
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
}
```

玻璃质感规则：
1. 光斑在最底层：`glow-*` ellipse + opacity，铺在 `bg-base` 上
2. 卡片半透明：`glass-1`/`glass-2`，让光斑透出
3. 光边描边：1px `glass-border`（深色用霓虹半透明边）
4. 可选模糊：实现层用 `backdrop-filter: blur(12-20px) saturate(140%)`
5. 少用硬阴影：靠光斑和描边分层，几乎不用投影

### 1.8 环境光斑背景

- 背景是**图片**，文件为 `images/generated-1786893762526.png`（深色）、`images/generated-1786893760104.png`（浅色）
- 铺在 `ambient` 最底层，`object-fit: cover`
- 背景之上叠 60% `bg-base` 蒙版保证可读性
- **CG 视频版**（后续）：替换为 `<video>` 循环静音播放，主题切换交叉淡入淡出 600ms（见 §7.1）

---

## 2. 字体系统

| 场景 | 字体 | 字重 |
|---|---|---|
| 中文/英文 UI | Inter（中文回退 PingFang SC） | 400 / 600 / 700 |
| 代码/路径/数字 | JetBrains Mono | 400 / 600 |
| 品牌 wordmark | Inter | 700 |
| slogan（立矩成道） | Inter（可加字间距） | 500 |

### 字号层级

| 层级 | 字号 | 用途 |
|---|---|---|
| H1 | 20px/700 | 页面大标题 |
| H2 | 15px/700 | 面板标题/品牌名 |
| Body | 13px/400 | 对话正文 |
| UI | 12px/400-600 | 列表/tab/按钮 |
| Caption | 11px/400-600 | 时间戳/标签 |
| Code | 11-12px/400 | 代码/终端 |
| Micro | 9-10px/400 | 辅助标记 |

---

## 3. 组件规范（液态玻璃）

### 3.1 圆角（方中带圆）

| 组件 | 圆角 |
|---|---|
| 主卡片（消息/列表/输入框） | 18px |
| 抬升卡（工具条/选中项） | 11-12px |
| 按钮 | 13px（大）/ 9px（小） |
| 面板/窗口容器 | 20px |
| 状态点 | 圆形 |

### 3.2 按钮

| 类型 | 规范 |
|---|---|
| Primary | `brand-primary` 底 + `label-on-brand` 字，圆角 13px |
| Secondary | `glass-2` 底 + `label-primary`，圆角 13px，1px `glass-border` |
| Ghost | 透明 + `label-secondary`，hover 显 `glass-2` |
| Danger | `state-error` 底 + 白字 |

### 3.3 卡片/消息

- 用户消息：`glass-1` + 18px 圆角 + 光边
- Agent 消息：`glass-1` + 18px 圆角 + 光边 + 头部品牌 avatar + `brand-text` 名 + 任务耗时
- 工具调用条：`glass-2` + 12px 圆角 + 状态点 + Mono 路径 + 耗时
- 文件更改审查卡：`glass-1` + 折叠（默认）+ 全部撤销/全部保留

### 3.4 会话列表行

- 状态点 + 标题 + 时间；选中 `glass-2` + 光边；hover `glass-2`

### 3.5 底部面板

- 底部面板：`glass-1` 底，仅「终端」单一 tab（原待办/队列已移除，见 §5）
- ~~状态栏~~：**已移除**（2026-08-21）。会话级统计（轮次/时长/token/费用）放对话区 Convo Header 的 status 浮层；连接/项目/模型等全局信息暂无展示位，后续若需要以其他形式（如标题栏/设置页）呈现

### 3.6 图标规范

- **风格**：Lucide 线性，1.5-2px 描边，圆角线帽
- **颜色**：深色 `#F3ECFF` 线 / 浅色 `#0E0E1C` 线；激活/品牌 `brand-primary`
- **尺寸**：活动/工具 16-20px，列表 13-14px
- **来源**：Lucide 库（`lucide-react`），禁止 emoji、禁止自绘 SVG

---

## 4. 设计稿读取方法（HANDOFF）

> 指导开发者如何正确读取 `design.pen`、还原设计。

### 4.1 打开方式

- 用 **Pencil 桌面端** 打开 `doc/UXDesign/design.pen`
- 或在 IDE 里通过 Pencil MCP 工具程序化读取（见 §9）

### 4.2 设计稿结构（顶层 frame）

设计稿采用**深浅两套独立页面**（同一画布，frame 名字带 `· 浅色` / `· 深色` 后缀）：

**主界面（IDE）页面**：

| 页面 | 浅色 frame | 深色 frame |
|---|---|---|
| Design System（组件库） | `Design System · 浅色`（KTdc9 / UTpkg 两页） | —（无独立深色 DS 页，看深色页面内实例） |
| L1 主界面 | `L1 主界面 · 浅色`（N1HbA） | `L1 主界面 · 深色`（ZhjRX） |
| └ 侧栏（双模式） | ① 项目导航 · 浅色（C8YKJS） | ① 项目导航 · 深色（V2O1D） |
| └ Agent 对话区（区域稿） | 对话区 · 浅色（CvGoK） | 对话区 · 深色（GNcz1） |
| └ 编辑器区（区域稿） | 编辑器 · 浅色（sswc6） | 编辑器 · 深色（KTXnd） |
| └ 资源管理器（区域稿） | 资源管理器 · 浅色（PmMu1） | 资源管理器 · 深色（N0uIY） |
| L1 空态 | `L1 空态 · 浅色` | `L1 空态 · 深色` |
| 浮动窗 · 会话 | `浮动窗 会话 · 浅色` | `浮动窗 会话 · 深色` |
| 浮动窗 · 代码 | `浮动窗 代码 · 浅色` | `浮动窗 代码 · 深色` |
| L2 侧栏双模式（交互态） | `L2 侧栏双模式 · 浅色`（M7Awm） | `L2 侧栏双模式 · 深色`（N0R09） |
| L2 项目创建向导（交互态） | `L2 项目创建向导 · 浅色`（GweRq） | `L2 项目创建向导 · 深色`（o4fBad） |
| L2 项目创建向导 · 触发与补充（交互态） | `L2 项目创建向导 · 触发与补充 · 浅色`（SnHPn） | `L2 项目创建向导 · 触发与补充 · 深色`（l6ZuE8） |
| L3 会话视图（状态+轨迹） | `L3 会话视图 · 浅色`（l9tkkH） | `L3 会话视图 · 深色`（A8wqo） |
| L4 弹窗浮层（全交互） | `L4 弹窗浮层 · 浅色`（RhgJf） | `L4 弹窗浮层 · 深色`（J5jBKp） |

**设置中心页面**：见大分区容器 `设置中心 · Corum Settings`（hhKwk），含 22 设置页 × 深浅双版，完整清单见 §8。

> **变更提示**：原「L2 会话列表 / L2 项目导航（交互态）」页已重写为「L2 侧栏双模式（交互态）」（2026-08-25）；原「L2 编辑器tab+底部面板」页已随底部面板改造（终端/待办/队列 → 浮动终端面板，仅「终端」tab）失效。

> **注意**：Design System 只有浅色两页（KTdc9、UTpkg），**没有独立的深色 DS 页**。深色组件的实际呈现，直接看任意深色页面（如 `L1 主界面 · 深色`）里的组件实例即可。

> **读取要点**：深色页面 frame 设了 `theme: {mode:"dark"}`，浅色设 `mode:"light"`。**实现时以 token 为准**（见 §1），不要直接抄某个页面里的字面 hex —— 同一元素在深/浅页可能不同色，token 才是单一事实源。

### 4.3 图片资产说明

| 文件 | 用途 | 规格 |
|---|---|---|
| `logo.png` | 应用图标 | 2048×2048 |
| `brand_logo_light/dark_crop.png` | 品牌区横幅（左上） | 2230×470（4.74:1） |
| `big_brand_light/dark.png` | 空态页 hero 品牌图 | 2368×1824 |
| 背景图（generated-*.png） | 蒸汽波鲸鱼背景 | 16:9 |

> 带 `_crop` 的是已裁掉留白、内容居中的版本，直接用。原图保留备用。

**品牌区图片（深/浅实现方式不同）**：

| 元素 | 浅色页 | 深色页 |
|---|---|---|
| **品牌区横幅**（左上） | `brand-logo` 组件（`NwUQL`），内含 `bl-light` 图层引用 `brand_logo_light_crop.png` | **未用组件**，是普通 frame `brand-img` 直接引用 `brand_logo_dark_crop.png`（组件 ref 被禁用） |
| **空态 hero**（big-logo） | `big-light` 图层引用 `big_brand_light.png` | `big-dark` 图层引用 `big_brand_dark.png`（`fill` 模式铺满） |

> **实现建议**：统一抽象为一个 `BrandLogo` 组件，根据当前主题切换 `src`；空态 hero 同理。不必照搬设计稿里「深色页用普通 frame」的临时写法。

---

## 5. 布局结构（窗口标题栏 + 四列 + 浮动终端）

```
┌──────────────────────────────────────────────────────────────┐
│⓪ 窗口标题栏（40px）：← 84px 红绿灯让位 · 整行拖拽 · 右侧设置齿轮   │
├─────────┬───────────────────────────┬──────────┬─────────┤
│① 侧栏(双模式)│② Agent 对话区              │③ 编辑器区  │④ 资源管理器│
│brand+模式切换│Convo Header(对话/轨迹选项卡 │Editor Tabs│tree-header│
│任务模式(默认)│ +git-branch/chart-column/×)│+crumb    │+文件树    │
│ 新建会话     │Chat Flow(含 subagent-card) │Monaco    │          │
│ 会话列表     │Review Card                │Editor    │          │
│项目模式:     │Chat Input(上行输入+sparkle/ │Status    │          │
│ 空态/详情    │ 下行工具条＋/🛡/@/gauge/模型│          │          │
│ 管理段/团队  │ /🎤/⬆)                    │          │          │
├─────────┴───────────────────────────┴──────────┴─────────┤
│⑥ 浮动终端面板：absolute 742×150（仅「终端」tab + × + 终端输出）│
└──────────────────────────────────────────────────────────────┘
（⑦ 状态栏已删除，2026-08-21）
```

| 区 | 宽度 | 说明 |
|---|---|---|
| ⓪ 窗口标题栏 | 40px 高 | traffic-light-inset 84（macOS 红绿灯让位）+ 整行拖拽移动窗口 + titlebar-actions（no-drag）：最左两个快捷键按钮 `⌘⇧E` 显示/隐藏 编辑器区+资源管理器、`⌘J` 显示/隐藏 终端（icon + 7px 键位提示，28×28 无底图标钮），右侧 插件中心 / 主题切换 / 设置齿轮 icon-settings 20×20 `$label-secondary`） |
| ① 侧栏（双模式） | 280px 固定 | brand 横幅 + mode-switch（项目/任务分段，默认任务）+ 任务模式：新建会话 + 会话列表（状态点+标题+时间，首条选中）；项目模式：空态（顶部「打开项目」主按钮，空目录即新建项目）→ 项目详情（项目头 + 关闭项目 × + 管理段 + 团队段）。**不可关闭**（无 region-actions） |
| ② Agent 对话区 | flex:1 | Convo Header（对话/轨迹选项卡并入头部左侧 + spacer + git-branch / chart-column / × 三个 30×30 hbtn）+ Chat Flow（含 subagent-card）+ Review Card + Chat Input（双行：上行多行输入区 + sparkle，下行工具条 ＋/🛡/@Agent︾/gauge/模型︾/🎤/⬆发送） |
| ③ 编辑器区 | 520px 固定 | Editor Tabs（文件 tab）+ crumb + Code（Monaco）+ Editor Status |
| ④ 资源管理器 | 210px 固定 | VS Code 风格。根标题栏 + 树体（目录 chevron + folder/folder-open；文件按类型着色图标） |
| ⑥ 浮动终端面板 | 742×150，absolute 定位 | 仅「终端」一个 tab + × 关闭 + 终端输出；**待办/队列 tab 已移除** |
| ~~⑦ 状态栏~~ | — | **已删除**（2026-08-21） |

**区域卡片与关闭/拖出**（统一规则）：
- 所有区域容器为 `region-card`（玻璃卡 r18 + body 槽 + 右上角操作区）
- 有头部工具组的区域（② 对话区、④ 资源管理器）：关闭 × 并入工具组最右、同规格，不悬浮
- 无头部的区域（③ 编辑器区）：用 `region-actions` 悬浮于右上角；① 侧栏为固定常驻区，**不使用** `region-actions`（不可关闭，2026-08-25）
- **拖出独立窗口**：已删除拖出按钮，改为在区域内非交互处**长按鼠标左键拖拽出窗口**（多屏浮动窗形态见 `浮动窗 *` 页面）

**对话区关键交互**（L2/L3/L4 已同步）：
- **轨迹**：「对话/轨迹」选项卡并入 Convo Header 左侧
- **会话级统计**：点击统计 hbtn（chart-column）弹出 `popup-status` 浮层；**不在全局状态栏**
- **上下文用量**：点击工具条 tbtn-context（gauge + %）弹出 `popup-context-usage`
- **Chat Input 弹窗**：＋ → `popup-context`；🛡 → `popup-permission`；@Agent︾ → `popup-agent`
- **子 Agent 进度**：主 Agent 召唤子 Agent 时在 Chat Flow 插入 `subagent-card`
- **文件更改审查**：Review Card 固定对话区最下方

**L2 侧栏双模式交互态**（四列，2026-08-25）：① 任务模式 · 会话列表（默认）/ ② 任务模式 · 空态（无会话）/ ③ 项目模式 · 空态（未打开项目）/ ④ 项目模式 · 项目详情（已打开 · 可关闭）。

---

## 6. 组件清单（reusable，开发应抽象为代码组件）

所有通用元素是 **Pencil 组件**（`reusable: true`），页面里用 `ref` 实例化。

### 6.1 UI 组件

| 组件 | 用途 |
|---|---|
| `btn-primary` / `btn-secondary` / `btn-danger` | 主/次/危险按钮 |
| `input-field` | 输入框 |
| `session-row` | 会话列表行（状态点+标题+时间） |
| `msg-agent` | Agent 消息卡 |
| `msg-awaiting` | 等待审批卡（允许一次/拒绝） |
| `tool-call-row` | 工具调用条 |
| `tab-file` | 编辑器文件 tab |
| `menu-item` / `menu-item-danger` | 菜单项 / 危险菜单项 |
| `tree-node` | 文件树节点 |
| `run-chip` | 运行状态 chip（Running·Step n/m） |
| `brand-logo` | 品牌区（图片） |
| `mode-switch` | 侧栏模式切换器（项目/任务 分段，复用 scope-switch 样式：激活段 $brand-primary + $label-on-brand，idle 透明 + $label-secondary；内嵌于 brand 右侧） |
| `region-card`（xQylw） | 区域卡片：玻璃卡 r18 + body 槽 + 右上角操作区，L1 各区域统一容器 |
| `region-actions`（knD1D） | 区域操作条：现仅含关闭按钮 ×（30×30 r9 glass-2）。拖出按钮已删除（改为区域内长按拖拽出窗口） |
| `subagent-card`（bSZm5，展开态 O0J3e） | 子 Agent 任务进度卡片 |

> **region-actions 使用规则**：有头部工具组的区域（对话区、资源管理器）关闭按钮并入工具组最右、不悬浮；无头部的区域（编辑器区）用 region-actions 悬浮右上角；**① 侧栏（双模式）为固定常驻区，不可关闭，不使用 region-actions**（2026-08-25）；底部面板自带 ×，不用 region-actions。

### 6.2 对话区弹层（L4 页可查全部实例）

| 浮层/元素 | 说明 |
|---|---|
| `popup-status` | 会话统计浮层（点 Convo Header 统计 hbtn chart-column 弹出） |
| `popup-context-usage` | 上下文用量浮层（点 Chat Input tbtn-context gauge 弹出） |
| `popup-context` | Chat Input ＋ 上下文菜单 |
| `popup-permission` | 授权弹窗（手动/自动/完全访问·选中/自定义） |
| `popup-agent` | @Agent 选择弹窗 |

### 6.3 图标组件（Lucide 矢量，`type:"icon"`）

设计稿里的图标组件名（`icon-xxx`）是**语义化名**，其内部 `icon` 属性才是**真实的 Lucide 图标名**：

| 组件名 | Lucide 图标名 | 组件名 | Lucide 图标名 |
|---|---|---|---|
| `icon-files` | `files` | `icon-chevright` | `chevron-right` |
| `icon-message` | `message-square` | `icon-chevdown` | `chevron-down` |
| `icon-terminal` | `terminal` | `icon-xclose` | `x` |
| `icon-check` | `square-check-big` | `icon-branch` | `git-branch` |
| `icon-layers` | `layers` | `icon-archive` | `archive` |
| `icon-settings` | `settings` | `icon-save` | `save` |
| `icon-plus` | `plus` | `icon-trash` | `trash-2` |
| `icon-search` | `search` | `icon-pencil` | `pencil` |
| `icon-folder` | `folder` | `icon-sun` | `sun` |
| `icon-folderopen` | `folder-open` | `icon-moon` | `moon` |
| `icon-filecode` | `file-code` | `icon-monitor` | `monitor` |

**终态新增/修正的 Lucide 图标**（直接用 Lucide 名）：

| 场景 | Lucide 图标名 |
|---|---|
| 管理段五项 | 计划 `calendar-check` / 任务 `square-check-big` / 事件 `activity` / 文档 `file-text` / 问题 `circle-alert`（列表入口 `layout-list`） |
| 统计 hbtn | `chart-column`（`git-branch` 保留用于分叉对话） |
| 项目选择器 | `folder-open` + `chevrons-up-down` |
| 会话组头 | `message-square` + `search` + `chevron-down/right` |
| subagent-card | `bot`（avatar）、`arrow-right`（act-goto）、`check`/`loader`/`circle`（步骤）、`chevron-down`（act-expand） |
| Chat Input 工具条 | `plus`、`shield`、`gauge`、`mic`、`arrow-up`、`sparkle` |
| 资源管理器文件图标 | `.ts` `file-code`（紫）/ `.md` `file-text`（绿）/ `.json` `braces`（黄）/ `.yml` `file-cog`（粉）/ `.env` `lock`（灰） |

> **图标名修正**：`check-square`→`square-check-big`，`kanban-square`→`layout-list`，`bar-chart-3`→`chart-column`。实现用 [Lucide](https://lucide.dev) 库 + `currentColor` 跟随文字 token。

---

## 7. 动效规范

> 目标：开发可直接照参数实现。所有动画遵循「液态玻璃」质感 —— 柔、弹、有呼吸感，流体能动（fluid motion），缓动以 ease-out / spring 为主，避免线性。单位：时长 ms。

### 7.1 全局动效基线

| 项 | 值 | 说明 |
|---|---|---|
| 基础缓动 | `cubic-bezier(0.22, 1, 0.36, 1)`（easeOutExpo 系） | 大多数进入/展开 |
| 退场缓动 | `cubic-bezier(0.4, 0, 1, 1)`（easeIn） | 消失/收起，略快 |
| 弹性缓动 | `spring(mass 1, stiffness 260, damping 24)` | 弹窗/浮层/拖拽落点 |
| 微交互 | `cubic-bezier(0.34, 1.56, 0.64, 1)`（easeOutBack） | 按钮/小元素，带回弹 |
| 时长 · 微 | 120ms | hover、icon、checkbox |
| 时长 · 短 | 200ms | 按钮、tab、卡片 hover |
| 时长 · 中 | 280ms | 面板展开、列表项、消息进入 |
| 时长 · 长 | 400ms | 弹窗、抽屉、页面切换 |
| 时长 · 背景 | 600ms+ | 背景、主题切换渐变 |
| 交错 | 每项 30ms | 列表/菜单逐项进入 |
| 降级 | `@media (prefers-reduced-motion: reduce)` 时全部动画 → 0ms / 仅透明度 | 无障碍强制 |

**背景（CG 视频挂载点）**：背景是 CG 视频（虎鲸蒸汽波，由你方提供），挂载 `ambient` 层 `object-fit: cover` 铺满；深/浅两视频随主题切换，交叉淡入淡出 600ms；循环、静音、`playsinline`；视频之上叠 `bg-base` 60% 蒙版保证可读性；`prefers-reduced-motion` 降级为静态封面帧。

### 7.2 页面/视图切换

- **三视图切换**（会话/文件/代码）：旧视图 `opacity 1→0 + translateX(-12px)`，新视图 `opacity 0→1 + translateX(12px→0)`，280ms 基础缓动交叉（旧先出 120ms，新进入 200ms，重叠 80ms）；活动栏激活指示条 `scaleX 0→1` 200ms 微回弹
- **拖出为独立窗口**：拖拽中被拖元素 `scale 0.96 + opacity 0.85`，目标区域 2px `brand-primary` 落点线；松手成窗 `scale 0.9→1 + opacity 0→1` 400ms spring；dock 回主窗反向 280ms（吸附判定已改 Input HAL「松手且中心在主窗内」，动效参数不变）

### 7.3 Agent 对话区

- **消息进入**：用户消息 `opacity 0→1 + translateY(8px→0)` 200ms；Agent 消息同但延迟 80ms；多条交错 30ms
- **流式输出（打字机）**：逐字出现，光标 `opacity 1↔0` 530ms 循环；停止按钮 hover `scale 1.05` 120ms；结束时光标淡出 200ms
- **工具调用条**：进入 `opacity 0→1 + scaleY(0.9→1)` 200ms；运行状态点 `pulse`（`scale 1→1.3→1 + opacity 1→0.5→1`，1.2s 循环）；完成变 `state-success` 并 `scale 1→1.4→1` 300ms 弹性；展开/收起高度 auto 280ms + chevron 旋转 200ms
- **等待审批**：卡片 `opacity 0→1 + translateY(10px→0)` 300ms spring；「等待审批」标签 `state-warn` pulse（opacity 1↔0.6，1s 循环）；按钮 hover `translateY(-1px)` 150ms
- **文件更改审查卡**：折叠→展开高度 auto 300ms + chevron 200ms，文件列表逐项 `opacity 0→1 + translateX(-6px→0)` 交错 40ms；新更改时卡片顶部 `brand-primary` 描边 pulse 2 次 600ms
- **代码块复制**：hover 显现 `opacity 0→1` 120ms，点击变「✓ 已复制」`scale 1→1.15→1` 回弹 250ms，1.5s 后恢复

### 7.4 会话列表

- **hover/选中**：hover 背景 `transparent→glass-2` 150ms、标题色 `secondary→primary`；选中 `glass-2` + 左侧 2px `brand-primary` 指示条 `scaleY 0→1` 180ms 微回弹；状态点颜色过渡 200ms
- **右键菜单**：`opacity 0→1 + scale 0.92→1`（点击点为原点）180ms spring；菜单项逐项 `opacity 0→1 + translateY(-4px→0)` 交错 25ms；危险项 hover 背景 `state-error/10%`；关闭 `opacity→0 + scale→0.95` 120ms easeIn
- **拖拽排序**：抓起 `scale 1.03 + opacity 0.9` 150ms；目标插入位置 2px `brand-primary` 横线跟随（50ms 平滑）；放下 spring 落入 300ms，其他项 `translateY` 让位 250ms
- **搜索过滤**：不匹配项 `opacity 1→0 + height→0` 200ms，匹配项 `translateY` 重排 250ms
- **骨架屏**：`shimmer` 高光 `translateX -100%→100%` 1.4s 循环；加载完成骨架 `opacity→0` 150ms、真实内容交错进入

### 7.5 编辑器区

- **tab 切换**：激活 tab 底部 `brand-primary` 指示条 `translateX` 滑动 250ms（共享布局动画 layoutId）；新建 `opacity 0→1 + translateX(8px→0)` 200ms；关闭 `opacity→0 + width→0` 200ms 后续左移补位；hover 显 × `opacity 0→1` 120ms
- **dirty 点**：`scale 0→1` 弹性 250ms
- **编辑器状态栏**：值变化数字 `opacity 1→0.3→1` 闪烁 200ms

### 7.6 弹窗/浮层（L4）

- **通用弹窗**：遮罩 `opacity 0→1`（`bg-base/60%` + backdrop blur）250ms；弹窗体 `opacity 0→1 + scale 0.94→1 + translateY(8px→0)` 320ms spring（质量1/刚度300/阻尼26）；关闭反向 200ms easeIn；危险确认图标容器 `scale 0.8→1` 回弹 300ms + 删除按钮默认**不**聚焦（焦点在「取消」）
- **主题切换**（设置·外观）：选中项 `brand-primary` 描边 + check 点 `scale 0→1` 弹性 250ms；全局换肤所有 token 600ms 平滑过渡（背景视频交叉淡入淡出）

### 7.7 底部面板

- **展开/收起**：高度 `0↔200px` 过渡 300ms 基础缓动；tab 切换内容 `opacity` 交叉 200ms

### 7.8 光标/焦点/可访问性

| 项 | 规范 |
|---|---|
| 焦点环 | 2px `brand-primary` + 2px 偏移，`opacity 0→1` 120ms（键盘 Tab 触发，鼠标点击不显） |
| 输入框聚焦 | 描边 `glass-border→brand-primary` 200ms + 轻微 `scale 1.005` |
| 减少动效 | `prefers-reduced-motion`：所有 transform/位移动画移除，仅保留 150ms 透明度过渡；视频背景换静态帧 |

### 7.9 缓动曲线速查

```
基础进入   cubic-bezier(0.22, 1, 0.36, 1)   /* easeOutExpo 系 */
退场       cubic-bezier(0.4, 0, 1, 1)       /* easeIn */
微回弹     cubic-bezier(0.34, 1.56, 0.64, 1)/* easeOutBack */
弹性弹簧   spring(mass=1, stiffness=260, damping=24)
强弹簧     spring(mass=1, stiffness=300, damping=26)  /* 弹窗 */
```

> **实现栈建议**：CSS transition + `framer-motion`（spring 参数直接对应）；桌面 Electron 同。所有时长可在 `theme.motion` 统一配置，支持全局减速/关闭。

### 7.10 侧栏模式切换（项目模式 ⇄ 任务模式，2026-08-25）

> 交互：点击 brand 右侧 `mode-switch` 分段（项目/任务）；侧栏内容区（brand 以下整体）做**反转动画**切换，交互定义见 `docs/interaction-design.md` §4.1。L2「侧栏双模式」页四列即动画起止帧（① 任务模式·会话列表 ⇄ ② 任务模式·空态 ⇄ ③ 项目模式·空态 → ④ 项目模式·项目详情）。

- **内容区反转（核心）**：brand 以下内容整体 **rotateY 翻转**（以侧栏中线为轴）——旧内容 `rotateY(0→90°) + opacity 1→0` 120ms（easeIn），新内容 `rotateY(-90°→0) + opacity 0→1` 200ms（easeOutExpo），90° 处切换内容（重叠 80ms）。降级方案：`scaleX(1→0→1) + opacity` 280ms 基础缓动。
- **mode-switch 激活段**：激活段品牌色底随切换**滑动补位**（`translateX` 250ms 共享布局动画 layoutId，与 §7.5 tab 指示条同法）；激活态 `scale 1→1.02→1` 微回弹 200ms。
- **列表进入**：新模式内容（会话行 / 管理项 / 团队组）逐项 `opacity 0→1 + translateY(8px→0)`，交错 30ms（对齐 §7.1 交错基线）。
- **空态进入**：模式内容为空时，空态插画/文案 `opacity 0→1 + translateY(10px→0)` 300ms spring（对齐 §7.3 等待审批卡参数）。
- **无障碍**：`prefers-reduced-motion` 下取消翻转，仅 150ms 透明度过渡；切换需同步 `aria-pressed` / 焦点管理。

---

## 8. 设置中心设计（2026-08-23 新增）

设置中心是 corum **发行版级、跨 combo 共享**的统一配置入口（详见 `docs/prd/settings-prd.md`）。设计稿位于大分区容器 `设置中心 · Corum Settings`（id `hhKwk`），与主界面页面分开排布，共 **22 个设置页 × 深浅双版 = 44 页**，全部复用 §1 token（深色版仅切 `theme:{mode:'dark'}`，零硬编码）。

### 8.1 设置壳结构（所有设置页统一）

```
页面 frame(1600×1120, theme light/dark, clip)
└ ambient：$bg-base + 3 个 glow 椭圆（g1/g2/g3 环境光斑）
  └ FloatingLayer：#00000059 遮罩，居中
    └ SettingsShell：1040×820，$glass-1，cornerRadius 24，stroke $glass-border，
       background_blur(16) + 外阴影，horizontal 布局
      ├ nav（左导航，200 宽，vertical）：搜索框 + 5 分区标题 + 18 个设置项
      │   active 项：$glass-2 底 + $glass-border-active 描边 + $label-primary 加粗
      │   idle 项：透明 + $label-secondary
      └ content（右内容区，fill_container）
          ├ header（56 高）：左 title(15/700) + 右 [scope-switch 全局/本项目 + close]
          ├ 1px $glass-border 分隔线
          └ body（padding [20,24,24,24]，gap 14）：若干分组卡片
```

### 8.2 设置中心专用组件（新增 reusable）

| 组件 | 用途 |
|---|---|
| `setting-row` | 设置行（label 13/600 + desc 11 + 右侧控件），space_between 布局 |
| `switch-on` / `switch-off` | 开关（on：$brand-primary 底；off：$glass-3 底 + $glass-border） |
| `select-field` | 下拉选择（$glass-2 底 + $glass-border + chevron-down） |
| `modified-badge` | 「已修改」徽标（$glass-2 + $glass-border-active 描边 + $brand-text） |
| `restart-badge` | 「重启后生效」徽标（$state-warn 描边 + 文字） |
| `group-card` | 分组卡片（$glass-1 + cornerRadius 16 + $glass-border，padding [6,16,10,16]） |
| `scope-switch` | 全局/本项目 切换器（segmented，active 段 $brand-primary） |

分组卡片内部结构：组标题（12/600 `$label-secondary`）+ 若干 `setting-row` + 行间 1px `$glass-border` 分隔线（opacity 0.5）。

### 8.3 设置页清单（22 页，按 PRD 五分区）

| 分区 | 设置页 | 浅色 frame | 深色 frame |
|---|---|---|---|
| 通用 | 通用 General | `设置 · 通用 General · 浅色`（MEGzM） | （mFRNT） |
| 通用 | 外观 Appearance | （VbyBX） | （LwXVn） |
| 通用 | 通知 Notifications | （tiO92） | （Wb2us） |
| 通用 | 快捷键 Shortcuts | （ovfhk） | （KBuaG） |
| Agent | 模型 Models | （Z3rxM） | （hDuii） |
| Agent | Agent 预设 Presets | （lwXco） | （hpUu5） |
| Agent | 权限 Permissions | （o6BbF） | （Z6uvw） |
| Agent | 规则与指令 Rules | （c1ESD） | （d6JPp） |
| Agent | 记忆 Memory | （vQxqi） | （DWvcf） |
| Agent | 终端 Terminal | （wnCc9） | （JfQpB） |
| Agent | Hooks 与自动化 | （N7g9Oq） | （LpeVM） |
| Agent | Agent Loop 高级 | （vc9eV） | （dCKN1） |
| 数据与隐私 | 账户与用量 Account | （ydIGT） | （ToRVH） |
| 数据与隐私 | 隐私 Privacy | （oJn5s） | （Nt7iG） |
| 数据与隐私 | 数据管理 Data | （o4Z4L9） | （FVQMa） |
| 扩展 | 扩展面板-已装插件 | （f6Xuj1） | （WfmSd） |
| 扩展 | 扩展面板-插件市场 | （YU1gr） | （WoB4l） |
| 扩展 | 扩展面板-插件设置 | （akAq1） | （cHP22） |
| 扩展 | MCP 与集成 | （SQLDR） | （TYaj2） |
| 扩展 | 技能 Skills | （gf55b） | （jycG8） |
| 高级 | 高级 Advanced | （pdVrZ） | （JvCNX） |
| 高级 | 配置档案 Profiles | （v9VNr9） | （BwUAg） |

> 浅色区在容器内 y≈1080~9200（3 列网格），深色区 y≈12000~20120。完整 id→坐标映射可用 `Get('hhKwk',{depth:1}).children` 读取。

### 8.4 设置中心要点

- **五分区导航**：通用（0-9）/ Agent（10-49）/ 数据与隐私（50-69）/ 扩展（70-99）/ 高级（90-99）+ 插件贡献区（100+），分区标题（10/700 `$label-dimmed`）间有 spacer。
- **scope 切换器**：header 右侧「全局 / 本项目」，对应 PRD 第 7 章项目级设置覆盖。
- **扩展面板三 tab**：已装插件 / 插件市场 / 插件设置（schema 自动表单示例），对应 PRD 第 4.3 节一体面板。
- **徽标语义**：「已修改」（用户已覆盖默认值）/「重启后生效」（applies:'restart'）/「基础能力」（CORE_PLUGIN 不可停用）。
- **主题适配**：全部消费 §1 token，深色版仅切 `theme`，符合 PRD 第 6 章主题硬性规范。

---

## 9. 附录：如何用 Pencil MCP 读取 design.pen

> 如果想在 IDE / Agent 里**程序化读取** design.pen（而不是手动在 Pencil 桌面端看），需配置 Pencil MCP。本机 Pencil MCP 暴露 `execute` / `get_app_state` / `get_guidelines` / `browser` 四个工具，详细 API 见 `.trae/skills/pencil-mcp/pencil-mcp-api/SKILL.md`（本机实测校准版）。

### 9.1 常用读取操作（execute 工具）

```js
// 读取某容器（如设置中心 hhKwk）的所有顶层子页
Print(Get("hhKwk", { depth: 1 }).children.map(c => [c.id, c.name]))

// 读取某个页面的完整结构（如 L1 主界面浅色）
Print(Get("N1HbA", { depth: 5 }))

// 读取主题 token 变量（色彩规范）
Print(GetVariables())

// 读取某个组件（如 btn-primary）
Print(Get("me4rN", { depth: 3 }))

// 导出某页面为 PNG 用于肉眼核对（导出后用 Read 读图）
Export(["N1HbA"], "png", "./images/_check")   // → images/_check/N1HbA.png
```

> ⚠️ 本机 `Get(谓词)` 全文档遍历会报错，请用「按 id + children 数组遍历」（见 pencil-mcp-api SKILL §3）。`Export` 第一参数必须是 id 数组、第二参数是格式、第三参数是目录（文件名=节点 id）。

### 9.2 读取时的注意

1. **文件路径**：MCP 工具的 `filePath` 参数指向 `doc/UXDesign/design.pen`
2. **theme**：深色页 frame 有 `theme:{mode:"dark"}`，token 按 frame 的 theme 解析出对应色值
3. **图片**：图片是 `fill: {type:"image", url:"images/xxx.png"}`，路径相对 .pen 文件，实际文件在 `doc/UXDesign/images/`
4. **组件实例**：`type:"ref"` 是组件引用，`ref` 属性指向组件 id；实例内不能再 Insert 子节点，用 `descendants` 覆盖文本

### 9.3 不需要 MCP 的情况

如果只是**还原设计**，不必须配置 Pencil MCP：直接用 Pencil 桌面端打开 design.pen 查看；本文档已把 token、布局、组件、动效、设置中心都文字化，**按文档实现即可**；需要精确量尺寸/取色时再用 MCP 读原稿。

---

## 10. 待办 / 后续

- [ ] 背景 CG 视频（虎鲸蒸汽波动态版）—— 由产品/设计提供 webm，替换 ambient 静态图
- [ ] Monaco 主题与全局主题联动（深色 `vs-dark` / 浅色 `vs`）
- [ ] `prefers-reduced-motion` 降级测试
- [ ] 设置中心实现（按 `docs/prd/settings-prd.md` 分期，M1 起）
