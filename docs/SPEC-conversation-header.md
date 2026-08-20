# 对话区头部 · 交互与视觉开发指导

> 设计稿是唯一事实来源。本指导对应 design.pen 已确认的调整，供开发据此改代码。
> 涉及节点：Convo Header（浅 `nkAAA` / 深 `eKfU9`）、Session Stats（浅 `PMP9d` / 深 `HcV8K`）、Chat Input（浅 `q3HcU` / 深 `EzxpK`）、输入框弹窗（L4 浅 `Kt6JF` / 深 `colC R3tjUy`）。
> 实现插件：`@corum/ide-conversation`（[packages/plugins/ui/ide-conversation](file:///Users/kukucai/work/kkc-desktop/packages/plugins/ui/ide-conversation)）。

---

## 1. Convo Header 重构（选项卡并入头部）

### 结构（children 顺序）

```
Convo Header（glass-1 · r16 · pad[11,16] · gap10 · alignItems center）
├─ vt-对话      tab：active 态 glass-2 + glass-border-active 描边，r9，pad[5,12]，文字 12/600 label-primary
├─ vt-轨迹      tab：非 active 透明底，文字 12/normal label-secondary
├─ sp           弹性占位（fill_container），把右侧按钮组推到行尾
├─ hbtn         30×30 r9，icon=git-branch（分叉对话，保留）
├─ hbtn-stats   30×30 r9，icon=chart-column（统计开关 → 弹 status 浮层，见 §2）
└─ hbtn-close   30×30 r9（x）区域关闭（region-actions 规格，见 §4）
```

> 已删除原 save（保存，会话自动持久化无需手动保存）和 monitor（拖出，已改为非交互区长按拖拽）两个冗余按钮。

### 变更点
- **删除**原 dot / title / crumb（无用内容）
- **删除**独立的 View Tabs 行——`对话`/`轨迹` 两个选项卡**并入 Convo Header 左侧**
- **第一个 hbtn 保留分叉对话图标（git-branch）**；统计是独立的 `hbtn-stats`（chart-column）
- tab active 态：`glass-2` 底 + `glass-border-active` 描边；非 active：透明底
- 选项卡切换「对话 / 轨迹」两个视图（Chat Flow 区内容随之切换）

---

## 2. 统计 hbtn → status 浮层（替代原 Session Stats 卡片）

- **不再有常显的 Session Stats 卡片**（已删除浅 `PMP9d` / 深 `HcV8K`）
- 点击 `hbtn-stats`（chart-column）弹出 **status 浮层**（`popup-status`），内容为运行状态 + 统计：
  - 第 1 行：run-chip（运行状态）+ 「运行状态」标题
  - 第 2 行：7 轮 / 工作 12:34 / 工具 8:02（JetBrains Mono 10px）
  - 第 3 行：↑12.4k ↓3.1k / $0.042
- 浮层：glass-1 卡 r12 + glass-border，点击外部关闭；再次点击 hbtn 收起

---

## 2.5 上下文统计（toolbar）→ 上下文用量浮层

- Chat Input 工具条新增 **上下文统计按钮** `tbtn-context`（gauge 图标 + 百分比 Mono 10px，位于模型选择器前）
- 点击弹出 **上下文用量浮层**（`popup-context-usage`，参考图）：
  - 标题行：「上下文已用 1%」+ 右侧 `~7.3K / 1M`（Mono）
  - 进度条：4px 高 glass-2 底 + brand-primary 填充（按用量比例）
  - 分项（色点 + 名称 + 数值 Mono）：
    - 系统提示词 `~1.5K`（label-dimmed 灰点）
    - 工具 `~6.4K`（brand-primary 点）
    - 对话消息 `~220`（brand-accent 点）
- 数据源：会话 token 用量（系统提示词/工具/消息分项），接会话统计接口；本轮可先静态示例

---

## 3. Chat Input 双行重构 + 弹出面板

### Chat Input（glass-2 · r16 · pad[12,12,10,14] · vertical gap10）

```
上行 input-line（高约 100，多行输入区）
  ├─ placeholder「描述一个开发任务，用 @ 添加上下文，/ 使用命令」13px label-tertiary
  └─ ✨ sparkle 图标 15px label-tertiary（顶部右侧）
下行 toolbar（gap8 · alignItems center）
  左：＋(添加上下文) / 🛡(授权, state-warn) / @ Agent ︾(Agent 选择)
  ── 弹性占位 ──
  右：deepseek-v4-pro ︾(模型选择) / 🎤(语音) / ⬆(发送, state-success 绿底)
```

### 子 Agent 任务进度卡片（Chat Flow 内）

主 Agent 召唤子 Agent 时，在 Chat Flow 插入 **subagent-card**（组件 `bSZm5`，展开态示例 `O0J3e`）：

```
subagent-card（glass-1 · r14 · pad12 · gap8）
├─ head
│   ├─ avatar      18×18 r6 brand-accent 底 + bot 图标
│   ├─ meta        「子 Agent · UI Designer」12/600 + 任务名「设计系统 token 迁移」10 tertiary
│   ├─ chip        run-chip（运行状态 Running · Step 3/5）
│   ├─ act-expand  24×24 r7 glass-2，chevron-down/up（点击展开/收起详情）
│   └─ act-goto    24×24 r7 glass-2，arrow-right brand-text（点击切换到子 Agent 会话）
├─ prog            进度条 4px：glass-2 底 + brand-primary 填充（按进度比例）
└─ step            loader 图标 + 「Step 3/5 · 正在生成 theme.css」11px
```

**展开详情**（点 act-expand）：下方追加子任务步骤列表（check 完成 success / loader 进行 brand / circle 待办 dimmed）。

**两个交互**：
- `act-expand`（chevron）：展开/收起子任务步骤详情（就地展开，组件内 useState）
- `act-goto`（arrow-right）：把当前对话**切换到该子 Agent 的会话**（`ctx.sessions.open(子 Agent sessionId)`）

数据源：主 Agent 消息流里的子 Agent 召唤事件（task/spawn 帧）→ 子 Agent 的 sessionId + 任务名 + 进度。

---

### 三个弹出面板（点击工具条按钮弹出，点击外部关闭）

| 触发 | 面板 | 内容 | 设计稿 |
|---|---|---|---|
| ＋ | 上下文菜单 | 添加上下文(#) / 使用 / 调用命令和技能(slash) / 上传图片(image) | `popup-context` |
| 🛡 | Agent 操作审批 | 手动审批 / 自动审批 / **完全访问**(选中,橙) / 自定义 | `popup-permission` |
| @ Agent︾ | Agent 选择 | Built-In Agents(Agent ✓) + Custom Agents(高级原理图绘制/UI Designer/软件产品经理) | `popup-agent` |
| hbtn-stats（头部） | status 浮层 | run-chip + 轮次/时长/工具/token/费用 | `popup-status` |
| tbtn-context（工具条） | 上下文用量浮层 | 已用% + 进度条 + 系统提示词/工具/对话消息分项 | `popup-context-usage` |

- 面板样式：glass-1 卡 r12 + glass-border 描边；菜单项 menu-item 复用
- 授权方式选中项：文字 state-warn 橙 + 右侧 ✓ state-success
- Agent 选择选中项：glass-2 底 + 右侧 ✓ state-success
- 模型选择 / 语音输入：本轮可先占位（点击弹模型列表预留），数据接 `host.describe` 模型字段

---

## 4. 区域操作按钮（region-actions）规格

- 区域「关闭」按钮统一 **30×30 r9**（glass-2 底 + glass-border 描边 + icon 16），与 Convo Header 的 hbtn 同规格
- **拖出**无按钮：区域内**非交互处长按鼠标左键拖拽**出窗口即脱出（见 RegionCard 基座）
- 有关头部按钮组的区域（对话区）：关闭按钮并入头部 hbtn 组最右（`hbtn-close`），不单独悬浮
- 无头部的区域（① ③ ④ ⑥）：右上角 30×30 关闭按钮（RegionCard 右上角，占位留白）

---

## 5. 左侧栏项目导航（已确认，供对照）

结构（自上而下）：品牌横幅 → 新建/打开项目 → 「项目」标题 → 项目选择器 → **管理**段 → **团队**段。

- **团队与会话已合并为单个「团队」段**（`sec-team`，深 `u0Vd9t` / 浅 `btOIK`）：
  - 段组头单行：`[users] 团队  [+ 添加 Agent] ··· [🔍 搜索会话…]`（图标 users，无「按成员」hint）
  - 每个 Agent 是一组，**成员行即组头**：chevron(折叠) + 状态点 + 名称 + 角色标签(架构/前端/后端/评审) + 会话计数
  - 成员组下挂该 Agent 的会话列表（session-row），可折叠
  - 当前 4 个 Agent：Architect(架构/brand) / Frontend(前端/success) / Backend(后端/success) / Reviewer(评审/warn)
- **管理段**（占位）：计划 calendar-check / 任务 square-check-big / 事件 activity / 文档 file-text / 问题 circle-alert，各带计数
- 数据源现状：会话接 `ctx.sessions`；团队/管理/会话归属为静态示例，待创造模式 Agent 数据源

---

## 开发 checklist

- [ ] Convo Header：删 dot/title/crumb，并入 对话/轨迹 tab + spacer + hbtn 组（git-branch / chart-column / save / monitor / close）
- [ ] 删除独立 View Tabs 行；tab 切换驱动 Chat Flow 视图
- [ ] 删除 Session Stats 卡片；统计 hbtn 弹 status 浮层（run-chip + 统计）
- [ ] Chat Input 双行（多行输入区 + 工具条）
- [ ] 工具条加上下文统计按钮（gauge + %），弹上下文用量浮层
- [ ] 上下文 / 授权 / Agent 三个弹出面板（点击外部关闭）
- [ ] 子 Agent 任务进度卡片（subagent-card）：进度条 + 展开详情 + 切换到子 Agent 会话
- [ ] 区域关闭按钮统一 30×30 r9；拖出走非交互区长按
- [ ] 左侧栏：团队+会话合并为「团队」段（成员行即组头：chevron+状态点+名+角色+计数），搜索框在段组头右侧
- [ ] 全部色值用 `var(--corum-*)` / `var(--dsw-alias-*)`，零硬编码 hex
- [ ] 浅/深双主题截图对照设计稿
