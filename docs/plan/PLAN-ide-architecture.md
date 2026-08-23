# corum IDE 技术方案（v3 · 壳 + 槽位 + 功能插件）

> 状态：方案定稿。取代已删除的 `PLAN-ide-shell.md` / `PLAN-ide-mode.md`。
> **2026-08-21 变更（覆盖本文相关旧描述）**：① 状态栏已移除（`corum.statusBar` 槽删除、ide-statusbar 摘掉挂载，「添加区域/已关闭区域/重置布局」入口与连接/项目/模型展示一并移除，design.pen ⑦ 节点已删）；② 新增顶部自定义标题栏（Electron `titleBarStyle:'hiddenInset'` + 渲染层 40px `.titleBar`，左侧 84px 红绿灯让位、右侧设置齿轮，design.pen 两个 L1 已加「窗口标题栏」节点）；③ 设置改由壳自建 SettingsShell（`SettingsShell.tsx` 接管 `sidebar.settings` + `settings.*` 子槽 + portal 到 body），官方 `ui-settings-general` 已禁用；④ corum-ui-base 新增通用悬浮层 FloatingLayer（portal + modal + Escape + 多实例，区别于帧内 `shell.overlay`）；⑤ 浮动窗吸附改 Input HAL（`packages/desktop/src/electron/input-hal.ts`，60ms 轮询「按下→松开」判定，HAL 不可用永不吸附）。
> 设计事实源：`doc/UXDesign/design.pen`（几何/颜色/组件的单一事实源）、`doc/UXDesign/DESIGN.md`（token / 组件 / 布局 / 动效 / 设置中心，唯一权威文档）。
> 项目规则（架构事实 / 调试 / 打包）：`.trae/rules/project.md`。Monaco 集成：`docs/plan/PLAN-code-editor.md`。

---

## 0. 一句话

**IDE 是一个「壳」+ 一组「功能插件」。壳只定义区域几何、槽位与最小约束；所有功能（会话列表、资源管理器、编辑器、底部面板、对话区…）都是独立插件包，往壳声明的槽位注册自己的组件。槽位是运行时动态注册的（非硬编码），任何有 `dsh.client` 声明的插件都可以注册自己的槽位（原「添加区域」面板入口已随状态栏移除，形态待重新设计）。理论上壳可加无限槽位，组件可在壳内任意位置组合，也可脱出壳成独立浮动窗口。**

铁律不变：不改 `/Users/kukucai/dsh` 内核，不碰 `dsh-client-runtime`，slot 接管不 monkey-patch，官方升级走 fork + `// CORUM-PATCH:` 围块 + `diff -ru` 同步。

---

## 1. 为什么是这个架构（被否决的方案）

| 方案 | 问题 | 结论 |
|---|---|---|
| 保留官方组件 + 玻璃皮（旧 PLAN-ide-mode） | 对话区/会话列表被官方 ui-conversation/ui-sidebar 整块占着，和设计稿完全不一致（品牌区是 deepseek HARNESS、无 Session Stats/审查卡/文件树/状态栏内容） | ❌ 走查否决 |
| 单一 `corum-ide` 大包全量重写 | 加功能要动整个包，维护/回滚成本高，违背 slot 哲学 | ❌ 用户否决 |
| **壳 + 槽位 + 功能插件组合** | 加功能 = 加插件包 + 一行 insert；回滚单功能 = disable 一行；每个插件独立 build/typecheck | ✅ 采用 |

---

## 2. 技术事实（已核实，方案的硬约束）

这些事实来自对 dsh checkout 的直接核实，方案的每个决策都建立在其上：

1. **slot 系统**（`dsh-client-ui-slots` + `runtime/slots.ts`）：
   - 槽位靠 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 声明；`register({name, children, store, inject}, Component)` 一次性贡献组件 + 声明子槽。
   - `kind`: `single`（单占位，priority 覆盖）/ `list`（多占位，order 排序）/ `keyed` / `chain`（selector 路由）。
   - `scope`: `root`（全局）/ `session-maybe`（可有当前会话）/ `session`（严格会话）。
   - `ctx.slots.inject(key, cb)`：等某槽被声明后跑 cb——跨插件注册的延迟解，声明即授权。
   - 声明一个槽 = 独占其渲染权；注册进未声明槽会 throw。

2. **官方 presentation 组件的挂载关系**（决定哪些能留、哪些必须重写）：
   - `ui-layout` 的 AppFrame 占 `root`，声明 `sidebar`/`conversation`/`details`/`shell.overlay`。
   - `ui-sidebar` 占 `sidebar`，声明 `sidebar.workspaces`/`sidebar.settings`/`sidebar.footer.action`，品牌区用 `BrandWordmark`（deepseek HARNESS）。
   - `ui-workspace` 占 `sidebar.workspaces`（会话列表/搜索/分组/右键菜单）。
   - `ui-settings-general` 占 `sidebar.settings`（设置面板 chrome）。**禁 ui-sidebar 会连带 `sidebar.settings` 无人声明，设置打不开——壳必须重声明此槽。**（2026-08-21 落地：壳自建 SettingsShell 接管 `sidebar.settings` 并声明 `settings.*` 子槽，官方 `ui-settings-general` 已在 overlay 禁用。）
   - `ui-conversation` 占 `conversation`（ConversationRoot，~4500 行：消息流/markdown/代码块/diff/图片/composer/审批/轨迹/队列 dock/详情面板）。
   - `ui-theme` 提供 `ctx.theme` 服务（`overrideTokens`/`setTheme`）+ `body[data-ds-dark-theme]` 调色板投影。

3. **runtime 数据面**（功能插件消费，只读 hooks + 服务，不直连 RPC）：
   - `useSessions` → `SessionListState { ids, byId, current, phase, … }`；`SessionSummary { id, displayTitle, cwd, running, pendingInteraction, completed, blank, updatedAt, origin, parentId, … }`。
   - `useWorkspaces` → `WorkspaceListState { items, archivedSessionIds, recentWorkspaceId, … }`；`ctx.workspaces { listDirectory, openPath, startSession, archiveSession, … }`。
   - `ctx.sessions { open, clear, fork, … }`；`ctx.layout { toggleSidebar/openDetails/closeDetails }`（壳提供的超集再加 editor/explorer/panel 等）。
   - `ctx.connection`（host RPC）、`ctx.theme`、`ctx.slots`、`ctx.locale`。

4. **Monaco**：集成在 `corum-desktop` 客户端（`EditorColumn.tsx`），通过 `corum.editor` 槽门控（槽只被 IDE 壳声明，极简模式无入口、无跨包 value import）。

5. **浮动窗**：官方无现成多窗格/浮动窗基础设施（`dsh-client-runtime` 注释明示「多窗格预留未实现」；官方 desktop 单窗口）。需自建：Electron 开新 `BrowserWindow` 加载 `corumapp://` 带 `?floating=<slotKey>`，渲染端检测该参数只 mount 对应槽 + Window Chrome。

6. **模式**：`minimal`（默认，官方三栏聊天壳零改动）/ `ide`。`resolveDesktopMode()` = `CORUM_DESKTOP_MODE` > `$CORUM_HOME/mode.json` > `minimal`；`bootDesktop()` 按模式叠 IDE overlay。

---

## 3. 架构

### 3.1 分层

```
极简模式（默认）
  └ 官方 web 组合原样（ui-layout/ui-sidebar/ui-workspace/ui-conversation…）零改动

IDE 模式（coding 等 combo 的 env 注入 `CORUM_DESKTOP_MODE=ide`）
  └ 禁 ui-layout / ui-sidebar / ui-workspace（官方 presentation 层）
  └ insert:
      @corum/corum-ide-ui          ← 壳：区域系统 + 槽位 + 主题 + ambient + ctx.layout
      @corum/corum-ide-sidebar-ui        ← 品牌区 + 会话列表
      @corum/corum-ide-explorer-ui       ← 资源管理器文件树
      @corum/corum-ide-editor-ui         ← Monaco 编辑器（tab/面包屑/状态行）
      @corum/corum-ide-panel-bottom-ui   ← 底部面板（终端/待办/队列）
      @corum/corum-ide-conversation-ui   ← 对话区（第二步全量重写消息流）
      …新功能 = 新插件包 + 壳上加槽 + overlay insert 一行
  （@corum/corum-ide-statusbar-ui 原计划提供状态栏，2026-08-21 已随状态栏移除摘掉挂载，代码保留备查）
  └ 保留：ui-theme（ctx.theme 服务）、ui-conversation（第一步对话区复用）
  （ui-settings-general 已于 2026-08-21 禁用，设置改由壳自建 SettingsShell 接管 sidebar.settings）
```

### 3.2 壳（`@corum/corum-ide-ui`）的职责

壳是唯一常驻的 IDE 插件，只做四件事，**不含任何业务内容**：

1. **区域系统（region system）**：声明一组具名槽位，每个槽位绑定一个几何归属 + 最小约束。槽位几何归属分五类：
   - **column**（列，参与宽度让位）：会话列表 / 编辑器 / 资源管理器 / …
   - **bar**（条，固定高度）：底部面板（原状态栏已于 2026-08-21 移除；顶部标题栏是 frame 级元素，不走槽位）
   - **drawer**（抽屉，按需右侧覆盖）：details（详情/轨迹）
   - **overlay**（浮层，框架级）：`shell.overlay`
   - **floating**（浮动窗，脱出）：`?floating=<slotKey>` 挂载点
2. **几何求解**：让位链（会话列表不让位 → 资源管理器先缩 → 编辑器次缩 → 对话区兜底），拖拽把手，窄屏自动收起侧栏。
3. **主题**：`ctx.theme.overrideTokens('corum-glass', …)` 映射 `--dsw-alias-*`（深浅双值）+ 注入 `--corum-glass-*`/`--corum-brand-*`/`--corum-glow-*` 变量 + `.glass-card` + ambient 光斑背景 + 字体栈 + `prefers-reduced-motion` 降级。模式（minimal/IDE）与主题（light/dark/system）正交。
4. **`ctx.layout` 面板动作面**：官方三方法（toggleSidebar/openDetails/closeDetails）保语义 + IDE 扩展（editor/explorer/panel/…）。

### 3.3 功能插件的职责

每个功能插件**只提供内容，不决定位置**：
- 声明自己注册到哪个槽位（壳声明的 `corum.*` 槽）。
- 消费 runtime hooks（`useSessions`/`useWorkspaces`/`useSession`）+ 服务（`ctx.sessions`/`ctx.workspaces`/`ctx.connection`/`sessionArchive`）。
- 样式只引用 token（`var(--corum-glass-*)` / `var(--dsw-alias-*)`），不写死 hex。

**「任意位置组合」**：插件声明内容 → 壳的区域配置决定它落在哪一列/条/抽屉/浮层。改组合 = 改壳的区域配置或加槽，不动插件。

**「脱出浮动窗」**：插件内容本身不变；壳的 floating 挂载点在新 `BrowserWindow` 里只 mount 该槽内容 + Window Chrome（design.pen `浮动窗 *` 页面）。

### 3.4 槽位清单（壳声明，第一版）

| 槽位 | kind/scope | 几何归属 | 默认尺寸 | 内容（插件） |
|---|---|---|---|---|
| `sidebar`（官方名，重声明） | single/root | — | — | 不进官方 ui-sidebar；壳内 `corum.sidebar` 承载会话列表 |
| `conversation`（官方名，重声明） | single/session-maybe | column(flex) | flex | 官方 ui-conversation（第一步）→ ide-conversation（第二步） |
| `details`（官方名，重声明） | single/session | drawer 右 | 360 | 官方 ui-conversation DetailsPanel |
| `shell.overlay`（官方名，重声明） | list/root | overlay | — | badge/toast（帧内浮层；应用级对话框/通知用 corum-ui-base 的 FloatingLayer，portal 到 body） |
| `sidebar.settings`（官方名，重声明） | single/root | drawer 全屏 | — | 壳自建 SettingsShell（portal 到 body，声明 settings.* 子槽；官方 ui-settings-general 已禁用） |
| `corum.sidebar` | single/root | column 左 | 280 (min 240 / max 400) | ide-sidebar 会话列表 |
| `corum.editor` | single/root | column 右 | 430 (min 340 / max 720) | ide-editor Monaco |
| `corum.explorer` | single/root | column 最右 | 210 (min 180 / max 320) | ide-explorer 文件树 |
| `corum.tabStrip` | list/root | bar 顶部 | 0（无内容即塌） | 编辑器 tab 栏 |
| `corum.panel` | single/root | bar 底部 | 150（0 = 收起） | ide-panel-bottom 终端/待办/队列 |
| ~~`corum.statusBar`~~ | — | — | — | **已删除**（2026-08-21 状态栏移除，ide-statusbar 摘掉挂载） |
| `corum.floating` | single/root | floating 挂载点 | — | 脱出窗口内容 |

> 后续新功能：壳上加槽（一行 SlotMap 声明 + 区域配置）+ overlay insert 一行插件名。

---

## 4. 主题 token 映射（浅 / 深）

实现以 design.pen token 为单一事实源，禁止写死 hex。完整表见 `doc/UXDesign/DESIGN.md`；核心映射（`--dsw-alias-*` 经 `overrideTokens` 覆盖，`--corum-*` 为新 CSS 变量注入）：

| 设计 token | 目标变量 | 浅色 | 深色 |
|---|---|---|---|
| `bg-base` | `--dsw-alias-bg-base` | `#E9E9F2` | `#0D0817` |
| `glass-1` | `--dsw-alias-bg-layer-1` / `--corum-glass-1` | `#FFFFFFE6` | `#1D112BD9` |
| `glass-2` | `--dsw-alias-bg-layer-2` / `--corum-glass-2` | `#FFFFFFCC` | `#2A1840D9` |
| `glass-3` | `--dsw-alias-bg-layer-3` / `bg-overlay` / `--corum-glass-3` | `#FFFFFFB3` | `#372050CC` |
| `glass-border` | `--dsw-alias-border-l1` / `--corum-glass-border` | `#FFFFFF` | `#B98CFF2E` |
| `glass-border-active` | `--corum-glass-border-active` | `#5B21F5` | `#01CDFE` |
| `label-primary` | `--dsw-alias-label-primary` | `#0E0E1C` | `#F3ECFF` |
| `label-secondary` | `--dsw-alias-label-secondary` | `#5C5C77` | `#B3A6D9` |
| `label-tertiary` | `--dsw-alias-label-tertiary` | `#8B8BA3` | `#7E719E` |
| `label-dimmed` | `--dsw-alias-label-dimmed` | `#B9B9C9` | `#55486F` |
| `label-on-brand` | `--corum-label-on-brand` | `#FFFFFF` | `#0A0612` |
| `brand-primary` | `--dsw-alias-brand-primary` | `#5B21F5` | `#01CDFE` |
| `brand-accent` | `--corum-brand-accent` | `#F5276C` | `#FF71CE` |
| `brand-text` | `--dsw-alias-brand-text` | `#5B21F5` | `#4DE3FF` |
| `state-error` | `--dsw-alias-state-error-primary` | `#E0245E` | `#FF5C8A` |
| `state-success` | `--dsw-alias-state-success-primary` | `#0BA57C` | `#3EE6B0` |
| `state-warn` | `--dsw-alias-state-warn-primary` | `#E07A00` | `#FFB45C` |
| `state-idle` | `--corum-state-idle` | `#9AA0B5` | `#6E6392` |
| `state-running` | `--corum-state-running` | `#5B21F5` | `#01CDFE` |
| `glow-1/2/3` | `--corum-glow-1/2/3` | 见 style §背景层 | 见 style §背景层 |
| 侧栏填充 | `--dsw-specific-sidebar-fill` | `glass-1` | `glass-1` |
| 主按钮 | `--dsw-alias-button-primary-fill` | `brand-primary` | `brand-primary` |

CSS 变量切换机制：沿官方 `body[data-ds-dark-theme]`（壳的 ThemePresenter 切换），不另立 `data-theme`。

---

## 5. 资产与打包

| 资产 | 用途 | 落点 |
|---|---|---|
| `brand_logo_{dark,light}_crop.png` | 品牌区横幅 | `build/dist/assets/corum/`，`corumapp://app/assets/corum/...` |
| `big_brand_{dark,light}.png` | 空态 hero | 同上 |
| 蒸汽波鲸鱼背景图 | ambient 背景 | 同上，`object-fit:cover` + 60% `bg-base` 蒙版 |
| `logo.png` | 应用图标（可选） | electron-builder `mac.icon` |

- 打包：`pack-macos.mjs` 复制资产到 `build/dist/assets/corum/`；dev 态锚定 shell staging（同 Monaco worker 模式）。
- CG 视频背景（`vaporwave-{dark,light}.webm`）后续提供，留 `ambient` 挂载层 + 交叉淡入淡出 600ms 接口。
- 浮动窗 Window Chrome 资产：用设计稿 `浮动窗 *` 的圆点 + 标题 + dock-back 按钮（Lucide 图标）。

---

## 6. 浮动窗机制（已实现，2026-08-21 吸附判定更新为 Input HAL）

- **挂载**：壳声明 `corum.floating` 槽。Electron main 收到 `openFloating(slotKey)`（走 `window.corumDesktop` 原生桥模式）→ 开新 `BrowserWindow`（`titleBarStyle:'hidden'`）加载 `corumapp://app/index.html?floating=<slotKey>`。
- **渲染**：渲染端 boot 时检测 `floating` 参数 → 只 mount 该槽对应插件 + Window Chrome 包裹；不 mount 壳的网格。
- **同步**：会话状态靠 runtime 的 `sessions.current` 单例——浮动窗和主窗共享同一 host 连接与 runtime（多窗格并行渲染是官方预留未实现，浮动窗只是「同一内容换个窗口渲染」，不是多会话并行）。
- **拖回吸附（Input HAL）**：macOS 系统拖拽下 `moved`/`move` 事件无法区分「拖动中」与「已松手」，旧的「停稳定时吸附」不可靠。新方案：`packages/desktop/src/electron/input-hal.ts` 跨平台输入 HAL 统一 `isPrimaryButtonDown()` 查全局左键（macOS koffi 调 CoreGraphics `CGEventSourceButtonState`，Windows `GetAsyncKeyState`，Linux 暂降级）；浮动窗被拖动且中心进入主窗区域时启动 60ms 轮询，检测到「按下→松开」且中心在主窗内才吸附；移出/吸附/关闭即停。HAL 不可用时永不吸附（保守）。

---

## 7. 风险与回滚

1. **壳的区域系统是新写的**（无官方参考）——这是首版验证目标（见计划第一阶段）。
2. **设置入口**：禁 ui-sidebar 连带 `sidebar.settings` 无人声明 → 壳必须重声明同名槽（已在 §3.4 覆盖；2026-08-21 已落地为壳自建 SettingsShell + portal，官方 ui-settings-general 禁用）。
3. **对话区**：第一步复用官方 ui-conversation（压玻璃主题），第二步才全量重写消息流——降低一次性重写风险。
4. **模式切换丢态**：会话历史落盘 `$CORUM_HOME/sessions/`，切换只 restartHost + reload。
5. **IDE 包进 profile 闭包**：`workspace:*` + realpath heal；改名/改目录立即 `CI=true pnpm install --no-frozen-lockfile` 并查旧 scope symlink（HANDOFF §教训 6）。
6. **回滚**：`CORUM_DESKTOP_MODE`/mode 文件切回 `minimal`；overlay 只 disable 官方行 + insert 插件行，disable 即回退。

---

## 8. 与既有文档的关系

- 取代 `PLAN-ide-shell.md` / `PLAN-ide-mode.md`（已删）。
- `PLAN-code-editor.md` 的 Monaco 集成（worker/内联/协议）不变；注册位在 `corum.editor` 槽（壳声明）。
- 实施顺序见 `docs/plan/PLAN-ide-roadmap.md`（下一阶段计划）。
