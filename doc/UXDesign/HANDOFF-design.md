# 矩道 Corum Harness — 设计稿交接（给开发者）

> 本文档指导开发者**如何正确读取 `design.pen` 设计稿**、还原设计、实现动效。
> 配套：`corum-harness-design-style.md`（设计规范/token）、`corum-harness-motion-spec.md`（动效规范）。

---

## 1. 交付物清单

| 文件 | 说明 |
|---|---|
| `doc/UXDesign/design.pen` | **正式设计稿**（Pencil 文件，含深浅两套页面 + 组件库） |
| `doc/UXDesign/corum-harness-design-style.md` | 设计规范：色彩 token、字体、圆角、组件、布局 |
| `doc/UXDesign/corum-harness-motion-spec.md` | 动效规范：时长/缓动/spring 参数 |
| `doc/UXDesign/images/` | 图片资产（logo / 品牌图 / 背景图） |

---

## 2. 如何打开与读取 design.pen

### 2.1 打开方式

- 用 **Pencil 桌面端** 打开 `doc/UXDesign/design.pen`
- 或在 IDE 里通过 Pencil MCP 工具读取（`mcp__pencil__*`）

### 2.2 设计稿结构（顶层 frame）

设计稿采用**深浅两套独立页面**（同一画布，frame 名字带 `· 浅色` / `· 深色` 后缀）：

| 页面 | 浅色 frame | 深色 frame |
|---|---|---|
| Design System（组件库） | `Design System · 浅色`（KTdc9 / UTpkg 两页） | —（无独立深色 DS 页，深色组件直接看深色页面内的实例） |
| L1 主界面 | `L1 主界面 · 浅色`（N1HbA） | `L1 主界面 · 深色`（e9dE1） |
| └ 项目导航（区域稿） | 项目导航 · 浅色（C8YKJS） | 项目导航 · 深色（a3RJ4n） |
| └ Agent 对话区（区域稿） | 对话区 · 浅色（CvGoK） | 对话区 · 深色（GNcz1） |
| └ 编辑器区（区域稿） | 编辑器 · 浅色（sswc6） | 编辑器 · 深色（KTXnd） |
| └ 资源管理器（区域稿） | 资源管理器 · 浅色（PmMu1） | 资源管理器 · 深色（N0uIY） |
| L1 空态 | `L1 空态 · 浅色` | `L1 空态 · 深色` |
| 浮动窗 · 会话 | `浮动窗 会话 · 浅色` | `浮动窗 会话 · 深色` |
| 浮动窗 · 代码 | `浮动窗 代码 · 浅色` | `浮动窗 代码 · 深色` |
| L2 项目导航（交互态，原 L2 会话列表页已重写） | `L2 项目导航 · 浅色`（M7Awm） | `L2 项目导航 · 深色`（YlwuT） |
| L3 会话视图（状态+轨迹） | `L3 会话视图 · 浅色`（l9tkkH） | `L3 会话视图 · 深色`（A8wqo） |
| L4 弹窗浮层（全交互） | `L4 弹窗浮层 · 浅色`（RhgJf） | `L4 弹窗浮层 · 深色`（J5jBKp） |

> **变更提示**：原「L2 会话列表」页已重写为「L2 项目导航（交互态）」；原「L2 编辑器tab+底部面板」页已随底部面板改造（终端/待办/队列 → 浮动终端面板，仅「终端」tab）失效，底部面板最新形态见 L1 主界面与 §4。

> **注意**：Design System 只有浅色两页（KTdc9、UTpkg），**没有独立的深色 DS 页**。深色组件的实际呈现，直接看任意深色页面（如 `L1 主界面 · 深色`）里的组件实例即可。

> **读取要点**：深色页面 frame 设了 `theme: {mode:"dark"}`，浅色设 `mode:"light"`。**实现时以 token 为准**（见 §3），不要直接抄某个页面里的字面 hex —— 同一元素在深/浅页可能不同色，token 才是单一事实源。

### 2.3 组件（reusable）

所有通用元素是 **Pencil 组件**（`reusable: true`），页面里用 `ref` 实例化。开发时应抽象为对应的代码组件：

**UI 组件**：
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
| `tree-node` | 文件树节点（目录 chevron+folder/folder-open；文件按类型着色图标，见 §4） |
| `run-chip` | 运行状态 chip（Running·Step n/m） |
| `brand-logo` | 品牌区（图片） |
| `region-card`（xQylw） | 区域卡片：玻璃卡 r18 + body 槽 + 右上角操作区，L1 各区域统一容器 |
| `region-actions`（knD1D） | 区域操作条：现仅含关闭按钮 ×（30×30 r9 glass-2）。**拖出按钮已删除**——拖出改为「在区域内非交互处长按鼠标左键拖拽出窗口」 |
| `subagent-card`（bSZm5，展开态 O0J3e） | 子 Agent 任务进度卡片：主 Agent 召唤子 Agent 时插入 Chat Flow。结构 = avatar(bot) + 名称/任务 + run-chip 状态 + act-expand（chevron 展开/收起子任务步骤）+ act-goto（arrow-right 切换到子 Agent 会话）+ 进度条 + 当前步骤；展开详情 = 子任务步骤列表（check 完成 / loader 进行 / circle 待办） |

> **region-actions 的使用规则**：
> - **有头部工具组的区域**（对话区 Convo Header、资源管理器 tree-header）：关闭按钮并入其工具组最右、与该组按钮同规格（对话区 30×30 / 资源管理器 20×20），**不悬浮**，不用 region-actions。
> - **无头部的区域**（① 项目导航、③ 编辑器区）：才用 region-actions 悬浮（absolute 右上角）。
> - **底部面板**：自带 ×（tabs 行内），不用 region-actions。

**对话区（Convo Header / Chat Input）相关弹层**（L4 页可查全部实例）：
| 浮层/元素 | 说明 |
|---|---|
| `popup-status` | 会话统计浮层：原「Session Stats 常显卡片」已删除，改为点击 Convo Header 统计 hbtn（chart-column）弹出（run-chip + 轮次/时长/工具/token/费用） |
| `popup-context-usage` | 上下文用量浮层：点击 Chat Input 工具条 tbtn-context（gauge + %）弹出（已用% ~7.3K/1M + 进度条 + 系统提示词 ~1.5K / 工具 ~6.4K / 对话消息 ~220 三分项） |
| `popup-context` | Chat Input ＋ 上下文菜单（添加上下文 / 斜杠命令 / 上传图片） |
| `popup-permission` | 🛡 授权弹窗（手动 / 自动 / 完全访问·选中 / 自定义） |
| `popup-agent` | @Agent 选择弹窗（Built-In Agent ✓ + Custom Agents：高级原理图绘制 / UI Designer / 软件产品经理） |

> **Convo Header 终态**：左侧并入「对话 / 轨迹」选项卡（原独立 View Tabs 行已删除）+ spacer + git-branch / chart-column / × 三个 30×30 hbtn。原 dot / title / crumb 及 save / monitor 冗余按钮已删除。

**图标组件（Lucide 矢量，`type:"icon"`）**：

设计稿里的图标组件名（`icon-xxx`）是**语义化名**，其内部 `icon` 属性才是**真实的 Lucide 图标名**。映射如下：

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

**终态新增/修正的 Lucide 图标**（不再单独包 `icon-xxx` 组件，直接用 Lucide 名）：

| 场景 | Lucide 图标名 |
|---|---|
| 管理段五项 | 计划 `calendar-check` / 任务 `square-check-big` / 事件 `activity` / 文档 `file-text` / 问题 `circle-alert`（另有列表入口 `layout-list`） |
| 统计 hbtn（会话统计 popup 入口） | `chart-column`（`git-branch` 保留用于分叉对话） |
| 项目选择器 | `folder-open` + `chevrons-up-down` |
| 会话组头 | `message-square` + `search` + `chevron-down/right`（分组折叠） |
| subagent-card | `bot`（avatar）、`arrow-right`（act-goto）、`check` / `loader` / `circle`（步骤状态）、`chevron-down`（act-expand） |
| Chat Input 工具条 | `plus`、`shield`、`gauge`（上下文统计）、`mic`、`arrow-up`（发送）、`sparkle` |
| 资源管理器文件图标 | `.ts` `file-code`（紫）/ `.md` `file-text`（绿）/ `.json` `braces`（黄）/ `.yml` `file-cog`（粉）/ `.env` `lock`（灰） |
| 资源管理器根标题栏工具钮 | 新建文件 / 新建文件夹 / 刷新 / 折叠全部 / 关闭（×） |

> **图标名修正**：均为修正后的 Lucide 有效名 —— `check-square` → `square-check-big`，`kanban-square` → `layout-list`，`bar-chart-3` → `chart-column`。实现时务必用修正后的名字。

> **图标实现**：直接用 [Lucide](https://lucide.dev) 图标库（`lucide-react` / `lucide-vue`），用**右列真实图标名**（不是组件名）。颜色用 `currentColor` 跟随文字 token。

---

## 3. 色彩与设计 Token（单一事实源）

> 完整 token 表见 `corum-harness-design-style.md`。以下是核心映射。**所有颜色必须用 CSS 变量 / 主题 token，禁止写死 hex。**

### 3.1 主题机制

- 三态：`light / dark / system`（跟随系统）
- 实现：CSS 变量 + `[data-theme="dark"]` 切换，或沿 DSH 官方 `--dsw-alias-*` 体系
- **切主题只换 token 值，不换结构**

### 3.2 核心 token（浅 / 深）

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `bg-base` | `#E9E9F2` | `#0D0817` | 窗口底色 |
| `bg-deep` | `#DDDCE8` | `#0A0612` | 最深层底色 |
| `glass-1` | `#FFFFFFE6` | `#1D112BD9` | 主卡片（消息/列表） |
| `glass-2` | `#FFFFFFCC` | `#2A1840D9` | 抬升卡（选中/输入/工具条） |
| `glass-3` | `#FFFFFFB3` | `#372050CC` | 更高抬升（hover/浮层） |
| `glass-border` | `#FFFFFF` | `#B98CFF2E` | 玻璃描边 |
| `glass-border-active` | `#5B21F5` | `#01CDFE` | 激活描边 |
| `label-primary` | `#0E0E1C` | `#F3ECFF` | 正文/标题 |
| `label-secondary` | `#5C5C77` | `#B3A6D9` | 次要文字 |
| `label-tertiary` | `#8B8BA3` | `#7E719E` | 辅助文字 |
| `label-dimmed` | `#B9B9C9` | `#55486F` | 禁用 |
| `label-on-brand` | `#FFFFFF` | `#0A0612` | 品牌色上的文字 |
| `brand-primary` | `#5B21F5` | `#01CDFE` | 主品牌色（电紫/霓虹青） |
| `brand-accent` | `#F5276C` | `#FF71CE` | 点缀（品红/霓虹粉） |
| `brand-text` | `#5B21F5` | `#4DE3FF` | 品牌文字 |
| `state-error` | `#E0245E` | `#FF5C8A` | 错误/删除 |
| `state-success` | `#0BA57C` | `#3EE6B0` | 成功/完成 |
| `state-warn` | `#E07A00` | `#FFB45C` | 等待/警告 |
| `state-idle` | `#9AA0B5` | `#6E6392` | 空闲 |

### 3.3 液态玻璃实现

玻璃卡片效果（让背景透出）：

```css
.glass-card {
  background: var(--glass-1);
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
}
```

> 圆角规范：主卡片 18px，抬升卡/工具条 11-12px，按钮 13px（大）/9px（小），面板容器 20px。

### 3.4 环境光斑背景

- 背景是**图片**，文件为 `images/generated-1786893762526.png`（深色）、`images/generated-1786893760104.png`（浅色）
- 铺在 `ambient` 最底层，`object-fit: cover`
- 背景之上叠 60% `bg-base` 蒙版保证可读性
- **CG 视频版**（后续）：替换为 `<video>` 循环静音播放，主题切换交叉淡入淡出 600ms（见动效规范 §1）

---

### 3.5 品牌区图片（深/浅实现方式不同，注意）

品牌相关图片在浅色/深色页的实现方式**不一致**，实现时请注意：

| 元素 | 浅色页 | 深色页 |
|---|---|---|
| **品牌区横幅**（左上） | `brand-logo` 组件（`NwUQL`），内含 `bl-light` 图层引用 `brand_logo_light_crop.png` | **未用组件**，是普通 frame `brand-img` 直接引用 `brand_logo_dark_crop.png`（组件 ref 被禁用） |
| **空态 hero**（big-logo） | `big-light` 图层引用 `big_brand_light.png` | `big-dark` 图层引用 `big_brand_dark.png`（`fill` 模式铺满） |

> **实现建议**：开发时统一抽象为一个 `BrandLogo` 组件，根据当前主题切换 `src` 为 `brand_logo_light_crop.png` 或 `brand_logo_dark_crop.png`；空态 hero 同理切换 `big_brand_light/dark.png`。不必照搬设计稿里「深色页用普通 frame」的临时写法。

---

## 4. 布局结构（四列 + 浮动终端 + 状态栏）

```
┌─────────┬───────────────────────────┬──────────┬─────────┐
│① 项目导航 │② Agent 对话区              │③ 编辑器区  │④ 资源管理器│
│brand 横幅 │Convo Header(对话/轨迹选项卡 │Editor Tabs│tree-header│
│「项目」   │ +git-branch/chart-column/×)│+crumb    │+文件树    │
│新会话    │Chat Flow(含 subagent-card) │Monaco    │          │
│项目选择器 │Review Card                │Editor    │          │
│新建/打开 │Chat Input(上行输入+sparkle/  │Status    │          │
│团队段    │ 下行工具条＋/🛡/@/gauge/模型 │          │          │
│管理段    │ /🎤/⬆)                     │          │          │
│会话段    │                           │          │          │
├─────────┴───────────────────────────┴──────────┴─────────┤
│⑥ 浮动终端面板：absolute 742×150（仅「终端」tab + × + 终端输出）│
├──────────────────────────────────────────────────────┤
│⑦ 状态栏（34px）：conn-dot + Connected · 项目 · 模型        │
└──────────────────────────────────────────────────────┘
```

| 区 | 宽度 | 说明 |
|---|---|---|
| ① 项目导航 | 280px 固定 | 原「会话列表」改为项目导航。自上而下：brand 横幅 + 「项目」标题 + 新会话 + 项目选择器（当前项目卡：folder-open 图标 + 项目名 + 副标题成员/任务数 + chevrons-up-down）+ 新建项目/打开项目两按钮 + 团队段（Agent 成员行：状态点+名+角色标签，可添加）+ 管理段（计划 calendar-check / 任务 square-check-big / 事件 activity / 文档 file-text / 问题 circle-alert 五项带计数）+ 会话段（组头单行：message-square +「会话」+「按成员」+ 弹性间距 + 搜索框；按 Agent 分组的会话列表，chevron 可折叠） |
| ② Agent 对话区 | flex:1 | Convo Header（对话/轨迹选项卡并入头部左侧 + spacer + git-branch / chart-column / × 三个 30×30 hbtn）+ Chat Flow（含子 Agent 任务进度卡片 subagent-card）+ Review Card + Chat Input（双行：上行多行输入区 + sparkle，下行工具条 ＋ / 🛡 / @Agent︾ / 上下文统计 gauge / 模型︾ / 🎤 / ⬆发送） |
| ③ 编辑器区 | 430px 固定 | Editor Tabs（文件 tab）+ crumb + Code（Monaco）+ Editor Status |
| ④ 资源管理器 | 210px 固定 | VS Code 风格。根标题栏（chevron + 根名 dsh 加粗 + 新建文件/新建文件夹/刷新/折叠全部/关闭 五个 20×20 工具钮）+ 树体（目录 chevron-right/down + folder/folder-open；文件按类型着色图标：.ts file-code 紫 / .md file-text 绿 / .json braces 黄 / .yml file-cog 粉 / .env lock 灰；缩进每级 14px；选中态 glass-2 + 加粗） |
| ⑥ 浮动终端面板 | 742×150，absolute 定位（hvh） | 已改为浮动终端面板：仅「终端」一个 tab + × 关闭 + 终端输出；**待办/队列 tab 已移除**。× 在 tabs 行内，不用 region-actions |
| ⑦ 状态栏 | 34px | conn-dot + Connected + 项目 + 模型（仅全局） |

**区域卡片与关闭/拖出**（统一规则，详见 §2.3）：
- 所有区域容器为 `region-card`（玻璃卡 r18 + body 槽 + 右上角操作区）
- 有头部工具组的区域（② 对话区、④ 资源管理器）：关闭 × 并入工具组最右、同规格，不悬浮
- 无头部的区域（① 项目导航、③ 编辑器区）：用 `region-actions` 悬浮于右上角
- **拖出独立窗口**：已删除拖出按钮，改为在区域内非交互处**长按鼠标左键拖拽出窗口**（多屏浮动窗形态见 `浮动窗 *` 页面）

**对话区关键交互**（L2/L3/L4 已同步）：
- **轨迹**：「对话/轨迹」选项卡并入 Convo Header 左侧（原独立 View Tabs 行已删除，见 L3）
- **会话级统计**（轮次/时长/工具/token/费用）：常显卡片已删除，改为点击统计 hbtn（chart-column）弹出 `popup-status` 浮层；**不在全局状态栏**
- **上下文用量**：点击工具条 tbtn-context（gauge + %）弹出 `popup-context-usage`（已用% ~7.3K/1M + 进度条 + 系统提示词 ~1.5K / 工具 ~6.4K / 对话消息 ~220）
- **Chat Input 弹窗**（L4）：＋ → `popup-context`（添加上下文/斜杠命令/上传图片）；🛡 → `popup-permission`（手动/自动/完全访问·选中/自定义）；@Agent︾ → `popup-agent`（Built-In Agent ✓ + Custom Agents：高级原理图绘制/UI Designer/软件产品经理）
- **子 Agent 进度**：主 Agent 召唤子 Agent 时在 Chat Flow 插入 `subagent-card`（展开态可查看子任务步骤列表）
- **文件更改审查**：Review Card 固定对话区最下方（见 L1 主界面）

**L2 项目导航交互态**（原 L2 会话列表页已重写，四列）：
1. 项目导航正常态
2. 项目选择器展开（下拉项目列表 + 新建项目）
3. 会话分组折叠 + 会话行右键菜单（重命名 / 归档 / 删除）
4. 空态（还没有项目 + 新建项目 CTA）+ 骨架屏

---

## 5. 动效实现

> 完整参数见 `corum-harness-motion-spec.md`。核心要点：

- **基础缓动**：`cubic-bezier(0.22, 1, 0.36, 1)`（easeOutExpo 系）
- **弹性**：`spring(mass 1, stiffness 260, damping 24)`（弹窗用 stiffness 300）
- **时长**：微 120ms / 短 200ms / 中 280ms / 长 400ms / 背景 600ms+
- **交错**：列表/菜单逐项 30ms
- **实现建议**：CSS transition + `framer-motion`（spring 参数直接对应）
- **无障碍**：`prefers-reduced-motion` 时移除位移动画，仅保留 150ms 透明度

**重点动效**：
- 流式输出：打字机 + 光标 `opacity 1↔0` 530ms 闪烁
- 工具条状态点：运行中 `pulse`（scale 1→1.3→1 + opacity 1→0.5→1，1.2s 循环）
- 右键菜单：`opacity+scale 0.92→1`，180ms spring，菜单项交错 25ms
- 弹窗：`scale 0.94→1 + translateY(8px→0)`，320ms spring

---

## 6. 图片资产说明

| 文件 | 用途 | 规格 |
|---|---|---|
| `logo.png` | 应用图标 | 2048×2048 |
| `brand_logo_light/dark_crop.png` | 品牌区横幅（左上） | 2230×470（4.74:1） |
| `big_brand_light/dark.png` | 空态页 hero 品牌图 | 2368×1824 |
| 背景图（generated-*.png） | 蒸汽波鲸鱼背景 | 16:9 |

> 带 `_crop` 的是已裁掉留白、内容居中的版本，直接用。原图保留备用。

---

## 7. 读取设计稿的注意事项（重要）

1. **以 token 为准**：同一元素在深/浅页字面 hex 不同，不要抄字面值，映射到 token（§3）
2. **组件复用**：页面里的重复元素是组件实例，开发抽象为代码组件，不要每页重写
3. **图标用 Lucide**：设计稿图标是 Lucide 矢量，直接用 lucide 库，不要用 emoji 或自绘
4. **深浅对照**：每个页面都有浅/深两版，开发时两版都要还原
5. **状态覆盖**：L2/L3/L4 页面覆盖了所有交互态（右键菜单/拖拽/流式/审批/骨架屏/空态/弹窗），按图实现
6. **brand-logo / big-logo 是图片**：品牌区和空态 hero 是整张 AI 生成图，直接 `<img>` 引入即可（注意深/浅用对应版本）

---

## 8. 待办 / 后续

- [ ] 背景 CG 视频（虎鲸蒸汽波动态版）—— 由产品/设计提供 webm，替换 ambient 静态图
- [ ] Monaco 主题与全局主题联动（深色 `vs-dark` / 浅色 `vs`）
- [ ] `prefers-reduced-motion` 降级测试

---

## 9. 附录：如何用 Pencil MCP 读取 design.pen

> 如果开发者想在 IDE / Agent（如 DeepSeek Harness、Cursor、Claude Code）里**程序化读取** design.pen（而不是手动在 Pencil 桌面端看），需要配置 Pencil MCP。

### 9.1 Pencil MCP 是什么

Pencil MCP 是一个 MCP（Model Context Protocol）服务，让 AI Agent 能读取/操作 `.pen` 设计稿文件。工具名为 `mcp__pencil__*`。

### 9.2 配置方法

**前提**：已安装 Pencil 桌面端（Pen.app），且它能启动 MCP 服务。

在 Agent 的 MCP 配置中加入（以 DSH / Claude Code 的 `mcp.json` 为例）：

```json
{
  "mcpServers": {
    "pencil": {
      "command": "pencil-mcp",
      "args": ["--file", "doc/UXDesign/design.pen"],
      "env": {}
    }
  }
}
```

> 具体 command/args 以 Pencil 官方文档为准。配置后 Agent 会暴露 `mcp__pencil__*` 工具。

### 9.3 常用读取操作（读取设计稿）

通过 MCP 的 `execute` 工具运行 JS 读取：

```js
// 列出所有顶层页面（frame）
Get((n, c) => c.depth === 0 ? [n.id, n.name] : undefined)

// 读取某个页面的完整结构（如 L1 主界面浅色）
Get("N1HbA", { depth: 5 })

// 读取主题 token 变量（色彩规范）
Print(GetVariables())

// 读取某个组件（如 btn-primary）
Get("me4rN", { depth: 3 })

// 截图某个页面（用于肉眼核对）
// 用工具 mcp__pencil__get_screenshot(nodeId)
```

### 9.4 读取时的注意

1. **文件路径**：MCP 工具一般需要 `filePath` 参数指向 `doc/UXDesign/design.pen`
2. **theme**：深色页 frame 有 `theme:{mode:"dark"}`，读取变量时 `resolveVariables: true` 会按 frame 的 theme 解析出对应色值
3. **图片**：图片是 `fill: {type:"image", url:"images/xxx.png"}`，路径相对 .pen 文件，实际文件在 `doc/UXDesign/images/`
4. **组件实例**：`type:"ref"` 是组件引用，`ref` 属性指向组件 id；用 `resolveInstances: true` 可展开看内部结构

### 9.5 不需要 MCP 的情况

如果只是**还原设计**，其实**不必须**配置 Pencil MCP：
- 直接用 Pencil 桌面端打开 design.pen 查看
- 本系列文档（HANDOFF-design / design-style / motion-spec）已把 token、布局、组件、动效都文字化，**按文档实现即可**
- 需要精确量尺寸/取色时，才建议用 MCP 读取原稿
