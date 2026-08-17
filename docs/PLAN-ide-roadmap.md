# PLAN：corum IDE 实施路线图（壳 + 功能插件）

> 技术方案：`docs/PLAN-ide-architecture.md`（壳 + 槽位 + 功能插件 + 浮动窗）。
> 本文只列实施阶段与验收标准。设计事实源：`doc/UXDesign/design.pen`。

---

## 阶段总览

| 阶段 | 目标 | 交付物 |
|---|---|---|
| **S0** | 验证「壳 + 槽位 + 插件组合」可行性 + 基本功能 | `@corum/ide-shell` 壳 + 2 个测试插件，跑通组合链路 |
| **S1** | 四栏骨架 + 品牌区/状态栏/底部面板/资源管理器占位，截图走查整体观感 | ide-sidebar / ide-explorer / ide-panel-bottom / ide-statusbar |
| **S2** | 对话区消息流全量重写（最大独立工程，单独排期） | ide-conversation |
| **S3** | 浮动窗（脱出独立窗口） | `corum.floating` 槽实现 + Electron 开窗桥 |
| **S4** | 动效 + 打磨 | motion-spec 全量落地 |

---

## S0 · 可行性验证（先做，不着急开发业务）

**目的**：在大规模开发前，先证明「壳声明槽位 + 独立插件注册组件 + overlay 组合」这条链路跑得通，且壳的几何求解/主题/让步链正确。**用测试组件，不碰真实业务。**

### 任务

1. **建壳 `@corum/ide-shell`**（最小可用）：
   - 区域系统：声明 `corum.sidebar`/`corum.editor`/`corum.explorer`/`corum.statusBar`/`corum.panel`/`corum.tabStrip` + 官方 `sidebar`/`conversation`/`details`/`shell.overlay`/`sidebar.settings` 槽。
   - 几何求解：design.pen 四栏（会话列表 280 / 对话区 flex / 编辑器 430 / 资源管理器 210 / 底部 150 / 状态栏 34）+ 让位链 + 拖拽把手 + 窄屏侧栏自动收起。
   - 主题：`overrideTokens('corum-glass', …)` + 玻璃 CSS + ambient 光斑 + 字体 + reduced-motion 降级。
   - `ctx.layout` 面板动作面（官方三方法保语义 + editor/explorer/panel 扩展）。
   - ThemePresenter（fork ui-layout：body 调色板投影）。

2. **建两个测试插件**（最小内容，验证组合）：
   - `@corum/ide-test-sidebar`：往 `corum.sidebar` 注册一个占位卡（玻璃卡 + 一段文字「会话列表槽」），证明内容插件能注册进壳的列槽。
   - `@corum/ide-test-statusbar`：往 `corum.statusBar` 注册一个占位条（「连接 · 项目 · 模型」占位文字），证明条槽组合。
   - （可选）`@corum/ide-test-panel`：往 `corum.panel` 注册占位（终端 tab 占位），证明 bar 槽组合 + `togglePanel`。

3. **接线**：`cordis.ide.patch.yml` 改为 disable `ui-layout`/`ui-sidebar`/`ui-workspace` + insert `@corum/ide-shell` + 测试插件行。`@corum/ide-shell` + 测试插件加进 shell `workspace:*` 依赖 + desktop-host 闭包。

4. **验证方式**：
   - `CI=true pnpm --filter ... build` + `typecheck` 全过。
   - `--smoke`：极简 graph 与现状逐行一致；IDE graph 含 shell + 测试插件，官方三行 disable。
   - **CDP 截图走查**（`--remote-debugging-port=9222`）：四栏几何数值断言（280/430/210/150/34 + 让步链在 1280 窗口的收缩值）、玻璃 token 解析值、占位组件渲染、深浅双主题截图各一张。
   - 极简模式观感零变化。

### 验收标准

- [ ] 壳 + 2 个测试插件独立 build/typecheck 通过。
- [ ] IDE 模式启动，四栏几何 = design.pen（1280 窗口下让位链收缩正确；1600 窗口四栏全尺寸）。
- [ ] 测试插件内容渲染在对应槽位（侧栏/状态栏/底部面板）。
- [ ] 玻璃主题生效（深/浅 token 解析正确），ambient 光斑透出。
- [ ] 拖拽把手可拖，窄屏侧栏自动收起。
- [ ] 极简模式 graph 与现状一致、观感零变化。
- [ ] 走查脚本可一键产出对照表 + 双主题截图。

### 明确不做（S0 边界）

- 不做真实会话列表/文件树/编辑器/底部面板/状态栏内容（那是 S1）。
- 不动 ui-conversation（对话区消息流是 S2）。
- 不做浮动窗（S3）。
- 不动效（S4）。

---

## S1 · 骨架内容（可截图走查整体观感）

**目的**：把 design.pen L1 主界面的四栏骨架填上真实内容，整体观感对齐设计稿。对话区仍复用官方（压玻璃主题）。

- `@corum/ide-sidebar`：品牌区（矩道横幅，深浅双版）+ 新会话主按钮 + 搜索框 + workspace 分组 + 会话行（状态点+标题+时间）+ 右键菜单（重命名/分支/归档/保存/删除，走 sessionArchive 原生桥）。
- `@corum/ide-explorer`：文件树（`host.listDirectory`/`ctx.workspaces`），双击进编辑器 tab。
- `@corum/ide-editor`：Monaco（复用 shell 的 EditorColumn）+ 编辑器 tab 栏 + 面包屑 + 编辑器状态行（行/列/编码/dirty）。
- `@corum/ide-panel-bottom`：终端/待办/队列 tab；终端复用 `dsh-terminal`，待办/队列占位（诚实标注）。
- `@corum/ide-statusbar`：连接态 + 当前项目 + 当前模型 + 会话运行态。
- 对话区（复用官方）：补 Convo Header（标题+分支/保存/拖出）+ Session Stats + 文件更改审查卡（折叠）——这三块设计稿特有、官方没有的卡片。

**验收**：L1 主界面逐区与设计稿对照通过；深/浅双主题截图走查通过；极简模式观感零变化。

---

## S2 · 对话区消息流全量重写（独立大工程）

按 design.pen L3 把官方 ui-conversation 的 ChatView/MessageItem/AssistantMarkdown/composer/审批/轨迹 全量重写进 `@corum/ide-conversation`，禁 `ui-conversation`。**量级诚实评估：官方 ui-conversation ~4500 行（不含样式），单独立项、独立走查，不和 S1 混。**

---

## S3 · 浮动窗

实现 `corum.floating` 槽 + Electron 开窗桥 + Window Chrome 包裹（design.pen `浮动窗 *`）。**前提：S0–S1 的组合链路稳定。**

---

## S4 · 动效 + 打磨

按 `corum-harness-motion-spec.md` 全量落地：基础缓动 easeOutExpo、弹窗 spring(1,300,26)、列表交错 30ms、流式光标 530ms、工具点 pulse、reduced-motion 降级；会话 tab 栏（打开过的会话集合 UI 态 + localStorage）。

---

## 回滚

每个功能插件独立成包 + overlay 一行 insert：disable 该行即回退单功能；`CORUM_DESKTOP_MODE`/mode 文件切回 `minimal` 整体回退。壳只在 IDE 模式 insert，极简模式零改动。
