# PLAN：corum IDE 实施路线图（v4 · 自由插件式 GUI + Combo）

> 技术方案：`docs/PLAN-ide-architecture.md`（壳 + 槽位 + 功能插件 + 浮动窗）。
> Combo 设计规范：`docs/PLAN-combo.md`（Combo 数据模型 + 启动器 + 切换逻辑）。
> 设计哲学：`README.md`「设计哲学：区域组合 = 工作流 = Agent 团队」。
> 本文取代旧版 S0-S4 线性路线图。设计事实源：`doc/UXDesign/design.pen`。

> **2026-08-19 更新**：combo 定位已从「进程内工作流切换」改为「壳层启动器 + 独立应用」。
> 原 S1/S2（渲染端 `combos.ts`/`ComboLauncher`、localStorage、`?combo=` 路由、进程内
> `loader.create/remove` 动态插件切换）**已废弃并删除**。combo 数据迁到壳层
> `packages/shell/src/electron/combos.ts`，点击 combo = 注入 env/cwd/覆盖规则 + spawn 独立
> host 进程。IDE 壳（S0 交付的 `@corum/ide-shell` + GridView）本身不受影响，继续作为
> `coding` 等 IDE 类 combo 的工作台。详见 `docs/PLAN-combo.md`（v2）。

> **2026-08-21 更新**：① **状态栏已移除**（`corum.statusBar` 槽删除、ide-statusbar/ide-test-statusbar 摘掉挂载），「添加区域」面板、「已关闭区域」恢复菜单、「重置布局」与连接/项目/模型展示一并移除——下文涉及这些入口的描述均为历史记录，「添加新区域」的替代形态待设计；② 新增顶部自定义标题栏（40px，hiddenInset，右上设置齿轮）；③ 设置改由壳自建 SettingsShell（portal 到 body）接管 `sidebar.settings`，官方 `ui-settings-general` 禁用；④ shell-base 新增 FloatingLayer 通用悬浮层；⑤ 浮动窗吸附改 Input HAL（input-hal.ts，60ms 轮询按下→松开判定）。

---

## 阶段总览

| 阶段 | 目标 | 交付物 |
|---|---|---|
| **S0** ✅ | 壳可行性验证 + GridView 自由网格 + 拖放/脱出/关闭 | `@corum/ide-shell` 壳 + 测试插件 + grid.ts 分割树（「添加区域」面板与「已关闭区域」恢复菜单曾交付，后随状态栏移除） |
| **S1** ✅（2026-08-19 已改道） | ~~Combo 数据模型 + Shell 启动器~~ → **壳层 combo 启动器** | `src/electron/combos.ts` + `combo-page.ts`（独立 host 进程启动） |
| **S2** | ~~Combo 切换 + 加载 + 持久化~~ → 后续可做：combo 编辑器/导入导出（壳层） | 状态栏切换器不再需要（combo 切换 = 壳层换进程；状态栏本身也已移除） |
| **S3** | 首批功能插件（真实内容填充） | 会话列表 / 文件树 / 底部面板 / 编辑器 tab 栏（原含状态栏，已取消） |
| **S4** | 对话区重写（独立大工程） | `@corum/ide-conversation` 全量重写 ~4500 行 |
| **S5** | 动效 + 打磨 | motion-spec 全量落地 |

---

## S0 · 可行性验证 + GridView（已完成 ✅）

**已完成**：
- 壳 `@corum/ide-shell`：区域系统 + GridView 自由二维网格 + 液态玻璃主题 + ctx.layout
- grid.ts：分割树模型（dropLeaf/resize/rescale/setLeafHidden/addSlot/addSlotAt）
- 拖放：标题栏四边 split / 中心 swap / sash 拖拽
- 脱出浮动窗：拖出窗口外 → 独立 BrowserWindow + dock back 实时预览（吸附判定 2026-08-21 改为 Input HAL）
- 关闭区域：hidden 标记（原恢复入口在状态栏「已关闭区域」菜单，已随状态栏移除）
- ~~添加区域：`registerSlot()` 动态注册 + 「添加区域」面板 + 拖入网格~~（`registerSlot()` 能力仍在，面板入口已随状态栏移除，替代形态待设计）
- 槽位改为 string 类型（非硬编码联合类型）
- 4 个测试插件验证组合链路

---

## S1 · Combo 数据模型 + Shell 启动器 + 插件 UI 扫描

**目的**：Shell 变成 Combo 启动器（图标网格），双击进入工作台。同时自动扫描有 UI 的插件。详见 `docs/PLAN-combo.md`。

### 任务

1. **Combo 数据模型**（`combos.ts`）：
   - `Combo` 接口（id/name/description/agentPreset/grid/icon/builtin）
   - `ComboIcon` 接口（lucide/emoji/image/text 四种图标类型）
   - 内置 5 个 Combo（编码/设计/调试/极简/前端）
   - 序列化/反序列化 + localStorage 持久化

2. **Shell 启动器**（`ComboLauncher.tsx`）：
   - Combo 图标网格界面（液态玻璃 ambient 背景）
   - 双击 Combo → 跳转 `?combo=<id>` → 加载工作台
   - 「新建 Combo」入口（保存当前布局为 Combo）
   - URL 路由：无 `?combo=` 参数 = 启动器；有 = 工作台

3. **插件 UI 扫描**：
   - 壳的 client 半读取 `window.__DSH_BOOT__` 的 graph entries
   - 每个 entry 的 `id`（包名）= 潜在的可添加 UI 区域
   - 自动 `registerSlot(entry.id, { label, defaultWeight })`——label 从包名推导
   - 固定位置槽位（statusBar/panel/shell.overlay）排除

4. **区域渲染通用化**：
   - `renderGridSlot` 从硬编码改为通用：`renderSlot(slotKey, {})`
   - 未知 slot 显示空态卡片（"此区域暂无内容"）

### 验收

- [ ] App 启动 → 显示 Combo 启动器（图标网格）
- [ ] 双击「编码」Combo → 进入 IDE 工作台，布局 = 四列
- [ ] 「添加区域」面板自动列出所有有 UI 的插件
- [ ] 拖入任意插件到网格 → UI 正确渲染
- [ ] 返回启动器（关闭工作台或点 Combo 切换器）
- [ ] 极简模式仍可用（`?combo=minimal`）

---

## S2 · Combo 切换 + 加载 + 持久化

**目的**：在工作台内切换 Combo = 切换整个工作上下文（布局 + Agent + MCP）。

### 任务

1. **Combo 加载流程**：
   - 读 combo → `setGrid(combo.grid)` + `session.create(agentPreset: combo.agentPreset)`
   - 底部面板/详情抽屉按 combo 配置初始化
   - 加载中状态（骨架屏或 spinner）

2. ~~**状态栏 Combo 切换器**~~（已随状态栏移除废弃；combo 切换 = 壳层换进程，不需要工作台内切换器）：
   - 下拉列表显示当前 Combo + 所有可切换 Combo
   - 当前 Combo 名 + 图标
   - 切换确认（agentPreset 不同时提示）

3. **Combo 编辑器**：
   - 「保存当前布局为 Combo」→ 弹出编辑器（名称/图标/agentPreset/description）
   - 编辑现有 Combo（builtin 只改布局不改元数据）
   - 删除用户 Combo

4. **导入/导出**：
   - 导出 Combo → `.combo.json`（原生对话框）
   - 导入 `.combo.json` → localStorage

### 验收

- ~~[ ] 状态栏 Combo 切换器列出所有 Combo~~（状态栏已移除）
- [ ] 切换 Combo = 布局正确切换 + agentPreset 正确提示
- [ ] 用户可保存自定义 Combo
- [ ] Combo 可导入/导出 JSON
- ~~[ ] 切换 Combo 后「添加区域」面板更新~~（面板已随状态栏移除）

---

## S3 · 首批功能插件（真实内容填充）

**目的**：为 Combo 提供真实内容。每个插件是独立包，注册自己的槽位，用户可自由添加/移除。

### 插件清单

| 插件包 | 槽位 | 内容 | 依赖 |
|---|---|---|---|
| `@corum/ide-sidebar` | `corum.sidebar` | 品牌区 + 新会话 + 搜索 + 会话列表 + 右键菜单 | useSessions, sessionArchive |
| `@corum/ide-explorer` | `corum.explorer` | 文件树 + 面包屑 | ctx.workspaces, host.listDirectory |
| ~~`@corum/ide-statusbar`~~ | ~~`corum.statusBar`~~ | ~~连接态 + 项目 + 模型 + 运行态~~ **已取消**（状态栏 2026-08-21 移除） | — |
| `@corum/ide-panel-bottom` | `corum.panel` | 终端/待办/队列 tab | dsh-terminal |
| `@corum/ide-editor-tabs` | `corum.tabStrip` | 编辑器 tab 栏 + 面包屑 + 状态行 | Monaco (shell 内建) |

**关键原则**：每个插件都是"可添加区域"——用户不想要文件树就不添加，不想要底部面板就不添加。Combo 只是预设的组合，用户随时可以微调。

### 验收

- [ ] 每个插件独立 build/typecheck 通过
- ~~[ ] 从「添加区域」拖入 → 真实内容渲染~~（面板已移除，当前为 overlay 挂载）
- [ ] 关闭/恢复 → 内容正确销毁/重建
- [ ] 深浅双主题正确

---

## S4 · 对话区重写（独立大工程）

按 design.pen L3 把官方 ui-conversation 的 ChatView/MessageItem/AssistantMarkdown/composer/审批/轨迹 全量重写进 `@corum/ide-conversation`，禁 `ui-conversation`。

**量级诚实评估：官方 ui-conversation ~4500 行（不含样式），单独立项、独立走查。**

**与 Combo 的关系**：ide-conversation 也是一个"可添加区域"——用户可以选择不添加对话区（纯代码编辑模式），或添加多个对话区（多会话并行视图）。

---

## S5 · 动效 + 打磨

按 `corum-harness-motion-spec.md` 全量落地：基础缓动 easeOutExpo、弹窗 spring(1,300,26)、列表交错 30ms、流式光标 530ms、工具点 pulse、reduced-motion 降级。

---

## 与旧版的差异

| 维度 | 旧版（v3） | 新版（v4） |
|---|---|---|
| 槽位 | 壳硬编码 6 个固定槽位 | 运行时动态注册，任意插件可注册 |
| 区域添加 | 无（S1 硬编码 insert 5 个插件） | 扫描 `dsh.client` entries 自动发现 + 用户拖入 |
| 布局 | 四栏固定让位链 | GridView 自由二维网格（已完成） |
| 工作流 | 无概念 | Combo 系统 = 布局预设 + Agent 团队绑定 |
| S1 内容 | 填充 5 个固定位置 | 插件 UI 扫描 + 区域渲染通用化 |
| 功能插件 | overlay 硬编码 insert | 作为可添加区域，用户自由组合 |

## 回滚

每个功能插件独立成包 + overlay 一行 insert：disable 该行即回退单功能。`CORUM_DESKTOP_MODE`/mode 文件切回 `minimal` 整体回退。壳只在 IDE 模式 insert，极简模式零改动。Combo 数据在 localStorage，清除即恢复默认。
