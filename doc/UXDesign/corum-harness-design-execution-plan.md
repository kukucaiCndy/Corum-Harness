# corum Agent OS 桌面端 — 设计执行方案

> 输入：`doc/UXDesign/corum-agent-os-design-style.md`（S2 Modern Dark）+ `docs/interaction-design.md`（IDE 六区交互稿）
> 本方案供 SOP 第 7 步正式设计使用，所有资产 ID / 组件 ID 语义化命名，设计时按此引用。

---

## 1. 页面总览表

> **架构调整（2026-08 用户确认）**：废弃「编辑器区内会话+代码左右分屏」。改为**活动栏切换三个独立主区视图**——会话（默认）/ 文件 / 代码。次侧栏（轨迹）、底部面板（终端/待办/队列）、状态栏为全局常驻，不随视图切换。代码视图 + 会话视图支持**拖离主窗口**为独立浮动窗口（多屏场景）。

| 层级 | 页面名 | 核心功能 | 复用组件 | 专属元素 |
|---|---|---|---|---|
| L1 | 会话视图（默认主页） | 左侧会话列表（DSH 现状风）+ 右侧对话流 + 输入框 | activity-bar / session-list / msg-* / chat-input / status-bar-enhanced | 视图切换 |
| L1 | 文件视图 | 左侧文件树 + 右侧文件预览（只读），双击跳代码视图 | activity-bar / tree-node / breadcrumb / file-preview | 跳转代码 |
| L1 | 代码视图 | 顶部文件 tab 栏 + Monaco 编辑器，可拖离 | activity-bar / tab-file / monaco / status-bar | 拖离按钮 |
| L1 | 空态（首启/无工程） | 品牌 Logo 背景 + 创建工程/打开工程引导 | brand-logo / ill-empty / btn-primary | 引导卡 |
| L1F | 浮动窗口 — 会话 | 拖离后的独立会话窗口 | msg-* / chat-input / status-bar-mini | 窗口 chrome |
| L1F | 浮动窗口 — 代码 | 拖离后的独立代码窗口 | tab-file / monaco | 窗口 chrome |
| L2 | 会话列表（分组视图） | workspace 分组 + 状态点 + 右键菜单 | session-row / workspace-group / search-bar | — |
| L2 | 会话列表（扁平/搜索态） | 扁平 + 搜索过滤 | session-row / search-bar | — |
| L2 | 文件树 | 目录树 + 面包屑 | tree-node / breadcrumb | 文件图标 |
| L2 | 代码 tab 栏 | 文件 tab + dirty 点 + 关闭/新建 | tab-file / tab-close | — |
| L2 | 底部面板 | 终端 / 待办 / 队列 | panel-tab / terminal-row / todo-row / queue-row | — |
| L2 | 轨迹时间线（次侧栏默认） | Turn 分组 + 步骤 + 耗时 + 详情 | trace-timeline / tool-call-row | — |
| L3 | 会话视图状态组 | 正常 / 流式中（停止）/ 等待确认 / 骨架屏 / 空态 | msg-user / msg-agent / msg-streaming / msg-awaiting / skeleton-row | — |
| L3 | 会话右键菜单（展开态） | 5 动词 + 分隔线 + 危险项 | context-menu / menu-item / menu-item-danger | — |
| L3 | 状态栏 hover 详情卡 | 轮次/步骤/工作时长/工具耗时/token in-out/缓存/费用 | statusbar-hover-card | — |
| L4 | 删除确认对话框 | 不可逆警示 + 取消默认 | confirm-dialog / btn-danger | — |
| L4 | 保存日志结果弹窗 | 成功（路径）/ 失败（错误+重试） | result-modal / btn-primary | — |
| L4 | 重命名输入弹窗 | 输入 + 确认/取消 | rename-input | — |
| L4 | 设置 — 外观（主题切换） | 深/浅/跟随系统 三选 + 预览 | theme-option / settings-row | — |
| L4 | 未保存关闭确认 | 文件 dirty 关闭时确认 | confirm-dialog | — |
| L4 | 拖离窗口提示 | 拖离为独立窗口的操作反馈 | toast / 边缘高亮 | — |

> 共 21 个设计单元（L1×4 / L1F×2 / L2×6 / L3×3 / L4×6），核心页面深浅双主题各一版。

---

## 2. 复用组件清单

| 组件ID | 组件名 | 类型 | 出现页面 | 设计规范引用 |
|---|---|---|---|---|
| activity-bar | 活动栏（56px，含顶部 logo 占位） | 导航 | 所有 L1 | §组件规范.活动栏 |
| status-bar-enhanced | 增强状态栏（28px，连接+项目｜运行 chip+轮次+时长+token+费用+模型） | 导航 | 所有 L1 | §组件规范.状态栏（已改为 bg-layer-1 底，非品牌底） |
| statusbar-hover-card | 状态栏 hover 详情卡（轮次/步骤/工作时长/工具耗时/token in/out/缓存/费用） | 浮层 | 所有 L1 | §组件规范.卡片 |
| trace-timeline | 轨迹时间线（Turn 分组 + 工具步骤 + 耗时 + 状态点） | 容器 | 次侧栏默认内容 | §组件规范 |
| brand-logo-placeholder | 品牌 Logo 占位（左上固定，后续替换正式素材） | 标识 | 所有 L1 / 空态 | — |
| msg-streaming | 流式输出中消息（含停止生成按钮） | 容器 | 会话视图 | §组件规范.卡片/消息 |
| msg-awaiting | 等待确认消息（允许/拒绝/始终允许） | 容器 | 会话视图 | §组件规范.卡片/消息 |
| context-menu | 会话右键菜单（5 动词+分隔线+危险项） | 浮层 | Explorer / L3 | §组件规范 |
| explorer-panel | 主侧栏容器 | 容器 | 主界面 / L2×3 | §布局规范 |
| secondary-panel | 次侧栏容器（详情/轨迹） | 容器 | 主界面 | §布局规范 |
| bottom-panel | 底部面板容器 | 容器 | 主界面 | §组件规范.底部面板 |
| editor-group | 编辑器区容器 | 容器 | 主界面 | §布局规范 |
| segmented-control | 会话/文件分段开关 | 控件 | Explorer×3 | §组件规范 |
| search-bar | 搜索框 | 控件 | Explorer×3 | §组件规范.输入框 |
| workspace-group | workspace 分组头 | 行 | 会话列表（分组） | §组件规范 |
| session-row | 会话列表行（状态点+标题+时间） | 行 | 会话列表×2 | §组件规范.会话列表行 |
| tree-node | 文件树节点 | 行 | 文件树 | §组件规范 |
| breadcrumb | 文件路径面包屑 | 行 | 文件树 / 代码视图 | §组件规范 |
| tab-session | 会话 tab（状态点+标题+关闭） | 控件 | tab 栏 | §组件规范.编辑器 Tab 栏 |
| tab-file | 文件 tab（dirty 点+文件名+关闭） | 控件 | tab 栏 | §组件规范.编辑器 Tab 栏 |
| panel-tab | 底部面板 tab（带计数） | 控件 | 底部面板 | §组件规范.底部面板 |
| terminal-row | 终端行 | 行 | 底部面板 | §字体系统.Code |
| msg-user | 用户消息 | 容器 | 会话视图 | §组件规范.卡片/消息 |
| msg-agent | Agent 消息卡片 | 容器 | 会话视图 | §组件规范.卡片/消息 |
| tool-call-row | 工具调用条 | 行 | 会话视图 / 次侧栏 | §组件规范.卡片/消息 |
| code-block | 代码块 | 容器 | 会话视图 | §色彩系统.代码 |
| chat-input | 聊天输入框 + Send | 控件 | 会话视图 | §组件规范.按钮 |
| file-header | 代码视图文件头 | 行 | 代码编辑器视图 | §组件规范 |
| menu-item | 右键菜单项 | 行 | 右键菜单 / L4 | §组件规范 |
| menu-separator | 菜单分隔线 | 行 | 右键菜单 | — |
| confirm-dialog | 确认对话框 | 弹窗 | 删除确认 | §组件规范.卡片 |
| result-modal | 结果弹窗 | 弹窗 | 保存日志结果 | §组件规范.卡片 |
| rename-input | 重命名输入弹窗 | 弹窗 | 重命名 | §组件规范 |
| theme-option | 主题选项（预览+单选） | 行 | 设置-外观 | §主题切换 |
| btn-primary | 主按钮（品牌底白字 6px） | 按钮 | 全部 | §组件规范.按钮 |
| btn-secondary | 次按钮 | 按钮 | L4 弹窗 | §组件规范.按钮 |
| btn-danger | 危险按钮（红底白字） | 按钮 | 删除确认 | §组件规范.按钮 |

> 共 32 个复用组件，正式设计时先在「设计系统页」建成 `reusable: true` 组件，页面中通过 `ref` 实例化。

---

## 3. 背景资产清单

### 3.2 风格判断（强制步骤）

- 设计风格文档「风格类型」= **Modern Dark（Linear 风）**，属 3.1 决策表中的 **极简/扁平** 行
- 决策结果：全局页面背景 = 纯色，容器/卡片背景 = 纯色，导航栏/TabBar = 纯色，装饰元素 = 纯色/无
- **结论：本项目无大面积 AI 生图背景资产**。唯一需要 AI 生图的是「空态插画」和「图标」

### 3.3 背景资产清单表

| 资产ID | 资产名 | 所属组件 | 填充方式 | 色值（深/浅） | 尺寸(px) | 复用页面 | 优先级 |
|---|---|---|---|---|---|---|---|
| bg-app | 应用主背景 | editor-group / 对话区 | 纯色 | `#0A0A0C` / `#FAFAFA` | 弹性 | 全部 | P0 |
| bg-panel | 面板背景 | explorer / secondary / bottom | 纯色 | `#131316` / `#F0F0F1` | 弹性 | 全部 | P0 |
| bg-elevated | 抬升背景 | 选中态 / 工具条 / hover | 纯色 | `#1C1C21` / `#E6E6E8` | 弹性 | 全部 | P0 |
| bg-overlay | 浮层背景 | 弹窗 / 右键菜单 | 纯色 | `#1A1A1F` / `#FFFFFF` | 弹性 | L4 / 菜单 | P1 |
| bg-code-editor | Monaco 编辑器底 | monaco 容器 | 纯色 | `#0D0D10` / `#FAFAFA` | 弹性 | 代码视图 | P1 |
| bg-code-block | Markdown 代码块底 | code-block | 纯色 | `#131316` / `#F0F0F1` | 弹性 | 会话视图 | P1 |
| ill-empty | 空态插画 | 空态页 | **背景图片（AI 生图）** | — | 240×180 | 空态 L1 | P4 |
| icon-*（20 个） | 功能图标 | 活动栏/列表/tab | **AI 生图（深浅两套）** | 深 `#D4D4D4` 线 / 浅 `#3B4252` 线 | 20/16/14 | 全部 | P2 |

### 3.4 生图提示词模板（仅「背景图片」资产）

**ill-empty（空态插画，240×180）**：

```
a flat minimal illustration of an empty chat window outline next to a small folder outline with a plus badge, sparse geometric line-art style, single muted indigo #5E6AD2 accent lines on dark-friendly neutral strokes, aspect ratio 4:3, resolution 240x180 pixels, solid #FFFFFF pure white background filling entire canvas, centered, generous margin, NO drop shadow, NO rounded frame, NO border, NO 3D effects, NO gradient, clean crisp edges for background removal
```

**icon-{name}（图标，尺寸 64 生成后缩放至 20/16/14）**：

深色主题用（浅线深底）：
```
flat vector line icon of {ICON_DESCRIPTION}, single consistent 2px light gray #D4D4D4 stroke, lucide feather icon style, solid dark #1E1E1E background edge to edge, no container box, no rounded rectangle behind, no shadow, no gradient, centered, minimal, crisp edges
```

浅色主题用（深线白底）：
```
flat vector line icon of {ICON_DESCRIPTION}, single consistent 2px dark slate gray #3B4252 stroke, lucide feather icon style, pure white #FFFFFF background, no container box, no rounded rectangle behind, no shadow, no gradient, centered, minimal, crisp edges
```

> **图标清单**（已生成 10 个，待补 10 个）：
> 已有：files / message / terminal / check / layers / settings / plus / search / dot / logo
> 待补：folder / folder-open / file-code / chevron-right / chevron-down / x-close / branch / archive / save / trash / pencil-rename / refresh / sun / moon / monitor

---

## 4. 配色资产清单

| 资产ID | 用途 | 深色 | 浅色 | 来源 |
|---|---|---|---|---|
| color-brand | 主品牌色 | `#5E6AD2` | `#5E6AD2` | 风格文档 §品牌色 |
| color-brand-text | 品牌文字（深色提亮） | `#8B93E8` | `#5E6AD2` | §品牌色 |
| color-bg-base | 主背景 | `#0A0A0C` | `#FAFAFA` | §背景层 |
| color-bg-l1 | 面板背景 | `#131316` | `#F0F0F1` | §背景层 |
| color-bg-l2 | 抬升背景 | `#1C1C21` | `#E6E6E8` | §背景层 |
| color-bg-overlay | 浮层背景 | `#1A1A1F` | `#FFFFFF` | §背景层 |
| color-bg-skeleton | 骨架屏 | `#232329` | `#E0E0E2` | §背景层 |
| color-text-primary | 主文字 | `#E4E4E7` | `#1A1A1E` | §文字层级 |
| color-text-secondary | 次文字 | `#8A8A93` | `#71717A` | §文字层级 |
| color-text-tertiary | 三级文字 | `#5C5C64` | `#A1A1AA` | §文字层级 |
| color-text-dimmed | 禁用文字 | `#3F3F46` | `#C6C6CC` | §文字层级 |
| color-border-l1 | 面板分隔 | `#26262C` | `#E4E4E7` | §边框 |
| color-border-l2 | 输入框边 | `#333339` | `#D4D4D8` | §边框 |
| color-border-l3 | 强调边 | `#44444A` | `#C6C6CC` | §边框 |
| color-success | 成功 | `#22C55E` | `#16A34A` | §状态色 |
| color-warn | 警告 | `#F59E0B` | `#D97706` | §状态色 |
| color-error | 错误/删除 | `#EF4444` | `#DC2626` | §状态色 |
| color-idle | 空闲点 | `#6B6B72` | `#9CA3AF` | §状态点 |
| color-code-bg | Monaco 底 | `#0D0D10` | `#FAFAFA` | §代码 |
| color-code-block | 代码块底 | `#131316` | `#F0F0F1` | §代码 |

---

## 5. 资产生成优先级排序

| 优先级 | 资产类别 | 资产列表 | 生成方式 | 说明 |
|---|---|---|---|---|
| P0 | 全局背景色 | bg-app / bg-panel / bg-elevated | 色值赋值（token） | 已定义，直接引用 |
| P1 | 浮层/代码背景色 | bg-overlay / bg-code-editor / bg-code-block | 色值赋值（token） | 已定义 |
| P2 | 功能图标（补 15 个） | folder / file-code / chevron / x-close / branch / archive / save / trash / pencil / refresh / sun / moon / monitor 等 | AI 生图 → 去背景，**同一批次**，深浅两套 | 补齐交互稿全部图标 |
| P3 | 组件库（32 个 reusable） | §2 全部组件 | 设计系统页构建 | 页面实例化前必须就绪 |
| P4 | 空态插画 | ill-empty | AI 生图 → 去背景 | 仅空态页使用 |

> P0/P1 为纯色 token，无需生成；实际生图工作仅 P2（15 个图标 ×2 套）+ P4（1 张插画）。

---

## 6. 页面状态与交互清单（全交互覆盖，开发直接参考）

### 6.1 页面状态矩阵

| 状态 | 主界面 | 会话列表 | 文件树 | 会话视图 | 代码视图 | L4 弹窗 |
|---|---|---|---|---|---|---|
| 正常 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 加载（骨架屏 `bg-skeleton`） | — | ✓ | ✓ | ✓ | ✓ | — |
| 空态 | ✓（品牌 Logo 背景 + 创建工程引导） | ✓ | ✓ | — | — | — |
| 错误（连接失败/操作失败） | ✓ 状态栏 | — | — | — | — | ✓ 保存失败 |
| 运行态（流式/运行 chip） | ✓ | ✓ | — | ✓ | — | — |
| 等待确认（允许/拒绝） | — | ✓ 琥珀点 | — | ✓ | — | — |
| 边缘（长标题截断/长列表） | ✓ | ✓ | ✓ | ✓ | ✓ | — |

### 6.2 交互行为清单（每组出独立设计稿）

| 分组 | 交互点 |
|---|---|
| Explorer | 右键菜单（5 动词）/ 拖拽排序 / 分组⇄扁平切换 / 搜索过滤 / 四状态点 / 骨架屏 / 空态 |
| 编辑器 tab | 切换 / 关闭（不删会话）/ 新建「+」/ 会话+文件混排 / dirty 未保存关闭确认 |
| 会话视图 | 流式输出中（停止按钮）/ 等待确认（允许/拒绝/始终允许）/ 工具调用展开收起 / 代码块复制 / 重新生成 |
| 轨迹（次侧栏） | Turn 时间线 / 步骤状态点 / 点击步骤展开详情+diff / 耗时汇总 |
| 底部面板 | 终端/待办/队列 tab 切换 / 终端运行输出 / 待办勾选 / 队列暂停清空 |
| 状态栏 | Connected/Reconnecting/Disconnected / Running/Waiting/Idle chip / hover 详情卡（轮次/步骤/时长/工具耗时/token in/out/缓存/费用） |
| 弹窗浮层 | 删除确认（不可逆警示）/ 保存日志成功（路径）+失败 / 重命名输入 / 主题三选 / 右键菜单展开态 / hover 详情卡 |
| 空态/首启 | 品牌 Logo 背景 + 「新建会话 / 打开工程」引导卡 |

---

## 7. 设计执行顺序（第 7 步）

1. **7.2 设计系统页**：色板（§4 全部 token 深浅双色 swatch）+ 字体层级 + 32 个 reusable 组件
2. **7.3 素材页**：补齐 15 个图标（深浅两套）+ ill-empty 插画 → **截图给用户确认后才继续**
3. **7.4 页面**：L1 主界面 → L1 空态 → L2×5 → L3×3 → L4×4，每页走「设计 → A 类核对 → B 类核对 → 截图」循环，深浅各一版
4. **7.6 统一去背景**：导出素材 → remove_bg → 回导
